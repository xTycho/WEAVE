import { open, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";

/**
 * Token usage from this PC's Claude Code transcripts. Fixed rules, no model:
 * every assistant line's `message.usage` is counted once (streaming writes the
 * same message several times, so lines are deduped by message id + request id),
 * then summed for one chat, for the current 5-hour block and for the last 7 days.
 * Claude Code exposes no plan limits on disk, so only token totals are shown.
 */
export interface Tokens { input: number; output: number; cacheCreate: number; cacheRead: number }
export interface UsageEntry extends Tokens { key: string; t: number }
export interface Block { start: number; end: number; last: number; tokens: Tokens }
export interface UsageSnapshot {
  at: number;
  /** The asked-for chat's own transcript (plus its subagents), all time. */
  session?: Tokens;
  /** The 5-hour block `now` sits in; zero tokens and `active: false` once it has run out. */
  block: { active: boolean; start?: number; resets?: number; tokens: Tokens };
  /** The rolling last 7 days. */
  week: Tokens;
  files: number;
}

export const BLOCK_MS = 5 * 3600_000;
export const WEEK_MS = 7 * 864e5;
const HOUR = 3600_000;

export const zero = (): Tokens => ({ input: 0, output: 0, cacheCreate: 0, cacheRead: 0 });
export const total = (t: Tokens) => t.input + t.output + t.cacheCreate + t.cacheRead;
const add = (a: Tokens, b: Tokens) => { a.input += b.input; a.output += b.output; a.cacheCreate += b.cacheCreate; a.cacheRead += b.cacheRead; return a; };
const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);

/** One transcript line as a usage entry, or undefined when it carries none. */
export function usageEntry(line: string): UsageEntry | undefined {
  if (!line.includes('"usage"')) return undefined;
  let j: any;
  try { j = JSON.parse(line); } catch { return undefined; }
  const u = j?.message?.usage, t = Date.parse(j?.timestamp);
  if (!u || typeof u !== "object" || !Number.isFinite(t)) return undefined;
  const id = j.message.id, req = j.requestId;
  // A line with neither id cannot be matched with its repeats, so it counts on its own.
  const key = id || req ? `${id ?? ""}:${req ?? ""}` : `${t}:${j.uuid ?? Math.random()}`;
  return { key, t, input: n(u.input_tokens), output: n(u.output_tokens), cacheCreate: n(u.cache_creation_input_tokens), cacheRead: n(u.cache_read_input_tokens) };
}

/** Entries keyed by message: a later line for the same message replaces the earlier one (it holds the final count). */
export function dedupe(entries: Iterable<UsageEntry>, into = new Map<string, UsageEntry>()): Map<string, UsageEntry> {
  for (const e of entries) into.set(e.key, e);
  return into;
}

export function sum(entries: Iterable<UsageEntry>, from = -Infinity, to = Infinity): Tokens {
  const out = zero();
  for (const e of entries) if (e.t >= from && e.t < to) add(out, e);
  return out;
}

/**
 * Claude's 5-hour blocks: a block starts at its first message's time floored
 * to the hour and lasts 5 hours; the next message after it ends (or after a
 * gap of 5 hours) starts a new one.
 */
export function blocks(entries: UsageEntry[]): Block[] {
  const sorted = [...entries].sort((a, b) => a.t - b.t), out: Block[] = [];
  let cur: Block | undefined;
  for (const e of sorted) {
    if (!cur || e.t >= cur.end || e.t - cur.last >= BLOCK_MS) {
      const start = Math.floor(e.t / HOUR) * HOUR;
      cur = { start, end: start + BLOCK_MS, last: e.t, tokens: zero() };
      out.push(cur);
    }
    cur.last = e.t;
    add(cur.tokens, e);
  }
  return out;
}

/** The block `now` sits in. When the last one has ended, nothing runs: the next block starts with the next message. */
export function currentBlock(entries: UsageEntry[], now = Date.now()): UsageSnapshot["block"] {
  const last = blocks(entries).at(-1);
  if (!last || now >= last.end) return { active: false, tokens: zero() };
  return { active: true, start: last.start, resets: last.end, tokens: last.tokens };
}

interface FileCache { mtime: number; size: number; offset: number; entries: Map<string, UsageEntry> }

/** Reads `file` from `from`, handing back complete lines and the offset after the last one. Large files go in chunks. */
async function readLines(file: string, from: number, size: number, onLine: (l: string) => void): Promise<number> {
  const fh = await open(file, "r");
  try {
    const CHUNK = 1 << 20;
    let pos = from, rest = Buffer.alloc(0), done = from;
    while (pos < size) {
      const buf = Buffer.alloc(Math.min(CHUNK, size - pos));
      const { bytesRead } = await fh.read(buf, 0, buf.length, pos);
      if (!bytesRead) break;
      pos += bytesRead;
      let data = Buffer.concat([rest, buf.subarray(0, bytesRead)]), start = 0, nl: number;
      while ((nl = data.indexOf(10, start)) !== -1) { onLine(data.toString("utf8", start, nl)); start = nl + 1; }
      done += start;
      rest = data.subarray(start);
      // Yield between chunks so a first scan of a large folder never holds up the server.
      await new Promise((r) => setImmediate(r));
    }
    return done;
  } finally {
    await fh.close();
  }
}

async function jsonlFiles(dir: string, out: string[] = [], depth = 0): Promise<string[]> {
  if (depth > 6) return out;
  let items;
  try { items = await readdir(dir, { withFileTypes: true }); } catch { return out; }
  for (const d of items) {
    const p = join(dir, d.name);
    if (d.isDirectory()) await jsonlFiles(p, out, depth + 1);
    else if (d.isFile() && d.name.endsWith(".jsonl")) out.push(p);
  }
  return out;
}

export interface UsageOptions { dir?: string; minGapMs?: number; now?: () => number }

/**
 * Keeps per-file sums keyed by mtime + size and reads only what a file gained
 * since last time. Files untouched for over 7 days are skipped (nothing in
 * them can fall inside the windows), unless a chat asks for its own file.
 */
export class UsageTracker {
  readonly dir: string;
  private files = new Map<string, FileCache>();
  private running?: Promise<void>;
  private lastRun = 0;
  private now: () => number;
  private minGap: number;
  private version = 0;
  private memo?: { key: string; at: number; snap: UsageSnapshot };
  constructor(opts: UsageOptions = {}) {
    this.dir = opts.dir ?? join(homedir(), ".claude", "projects");
    this.now = opts.now ?? Date.now;
    this.minGap = opts.minGapMs ?? 15_000;
  }

  /** Rescans when the last scan is older than `gap`; concurrent calls share one scan. */
  refresh(gap = this.minGap): Promise<void> {
    if (this.running) return this.running;
    if (this.lastRun && this.now() - this.lastRun < gap) return Promise.resolve();
    this.running = this.scan().catch(() => {}).finally(() => { this.lastRun = this.now(); this.running = undefined; });
    return this.running;
  }

  private async scan(): Promise<void> {
    const seen = new Set<string>(), cutoff = this.now() - WEEK_MS - BLOCK_MS;
    for (const file of await jsonlFiles(this.dir)) {
      seen.add(file);
      let st;
      try { st = await stat(file); } catch { continue; }
      if (st.mtimeMs < cutoff && !this.files.has(file)) continue;
      await this.update(file, st.mtimeMs, st.size);
    }
    for (const f of this.files.keys()) if (!seen.has(f)) { this.files.delete(f); this.version++; }
  }

  private async update(file: string, mtime: number, size: number): Promise<void> {
    let c = this.files.get(file);
    if (c && c.mtime === mtime && c.size === size) return;
    // A file that shrank was rewritten: start over.
    if (!c || size < c.offset) c = { mtime, size, offset: 0, entries: new Map() };
    const entries = c.entries;
    try {
      c.offset = await readLines(file, c.offset, size, (l) => { const e = usageEntry(l); if (e) entries.set(e.key, e); });
    } catch { return; }
    c.mtime = mtime; c.size = size;
    this.version++;
    this.files.set(file, c);
  }

  /** A chat's transcript files: `<id>.jsonl` and its `<id>/subagents/*.jsonl`. */
  private sessionFiles(session: string, transcript?: string): string[] {
    const out: string[] = [];
    for (const f of this.files.keys()) {
      if (transcript && f.toLowerCase() === transcript.toLowerCase()) out.push(f);
      else if (basename(f) === `${session}.jsonl`) out.push(f);
      else if (basename(dirname(dirname(f))) === session && basename(dirname(f)) === "subagents") out.push(f);
    }
    return [...new Set(out)];
  }

  /** Totals now; reused for a few seconds while no file changed, since state is built often. */
  snapshot(session?: string, transcript?: string): UsageSnapshot {
    const now = this.now(), key = `${session}|${transcript}|${this.version}`;
    if (this.memo && this.memo.key === key && now - this.memo.at < 5000) return this.memo.snap;
    const all = new Map<string, UsageEntry>();
    for (const c of this.files.values()) dedupe(c.entries.values(), all);
    const recent = [...all.values()].filter((e) => e.t >= now - WEEK_MS - BLOCK_MS);
    const snap: UsageSnapshot = { at: now, block: currentBlock(recent, now), week: sum(recent, now - WEEK_MS, Infinity), files: this.files.size };
    if (session) {
      const mine = new Map<string, UsageEntry>();
      for (const f of this.sessionFiles(session, transcript)) dedupe(this.files.get(f)!.entries.values(), mine);
      snap.session = sum(mine.values());
    }
    this.memo = { key, at: now, snap };
    return snap;
  }
}
