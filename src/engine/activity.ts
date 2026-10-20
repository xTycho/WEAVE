import { appendFileSync, closeSync, mkdirSync, openSync, readFileSync, readSync, statSync, writeFileSync } from "node:fs";
import { replaceFile, type ProjectPaths } from "../paths.js";
import type { ActivityEvent, ThreadInfo } from "../types.js";

const MAX_LOG = 512 * 1024;
const KEEP_LINES = 2000;

export function appendEvent(paths: ProjectPaths, event: ActivityEvent): void {
  mkdirSync(paths.weaveDir, { recursive: true });
  appendFileSync(paths.activity, JSON.stringify(event) + "\n");
  try {
    if (statSync(paths.activity).size > MAX_LOG) {
      const keep = readFileSync(paths.activity, "utf8").trimEnd().split("\n").slice(-KEEP_LINES).join("\n") + "\n";
      const tmp = `${paths.activity}.${process.pid}.tmp`;
      writeFileSync(tmp, keep);
      replaceFile(tmp, paths.activity);
    }
  } catch { /* another writer rotated first */ }
}

function parse(lines: string[]): ActivityEvent[] {
  const out: ActivityEvent[] = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const e = JSON.parse(line);
      if (typeof e.t === "number" && typeof e.s === "string" && typeof e.node === "string") out.push(e);
    } catch { /* partial line */ }
  }
  return out;
}

/** Last `bytes` of a file, starting at a full line. */
export function readTail(file: string, bytes = 256 * 1024): string {
  let fd: number | undefined;
  try {
    const size = statSync(file).size;
    const start = Math.max(0, size - bytes);
    const buf = Buffer.alloc(size - start);
    fd = openSync(file, "r");
    readSync(fd, buf, 0, buf.length, start);
    const text = buf.toString("utf8");
    return start > 0 ? text.slice(text.indexOf("\n") + 1) : text;
  } catch {
    return "";
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

export function recentEvents(paths: ProjectPaths, bytes?: number): ActivityEvent[] {
  return parse(readTail(paths.activity, bytes).split("\n"));
}

/** Follows the activity log from a byte offset; handles rotation by starting over. */
export class ActivityTail {
  private offset = 0;
  constructor(private file: string) {
    try { this.offset = statSync(file).size; } catch { this.offset = 0; }
  }
  read(): ActivityEvent[] {
    let size = 0;
    try { size = statSync(this.file).size; } catch { return []; }
    if (size < this.offset) this.offset = 0;
    if (size === this.offset) return [];
    const fd = openSync(this.file, "r");
    try {
      const buf = Buffer.alloc(size - this.offset);
      readSync(fd, buf, 0, buf.length, this.offset);
      const text = buf.toString("utf8");
      const end = text.lastIndexOf("\n") + 1;
      this.offset += Buffer.byteLength(text.slice(0, end));
      return parse(text.slice(0, end).split("\n"));
    } finally {
      closeSync(fd);
    }
  }
}

export function readThreads(paths: ProjectPaths): Record<string, ThreadInfo> {
  try { return JSON.parse(readFileSync(paths.threads, "utf8")); } catch { return {}; }
}

export function writeThread(paths: ProjectPaths, id: string, patch: Partial<ThreadInfo>): ThreadInfo {
  const all = readThreads(paths);
  const now = Date.now();
  const t: ThreadInfo = { ...({ id, name: `Thread ${id.slice(0, 6)}`, startedAt: now } as ThreadInfo), ...all[id], ...patch, lastSeen: now };
  all[id] = t;
  // Keep the 50 most recent threads.
  const kept = Object.fromEntries(Object.entries(all).sort((a, b) => b[1].lastSeen - a[1].lastSeen).slice(0, 50));
  mkdirSync(paths.weaveDir, { recursive: true });
  const tmp = `${paths.threads}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(kept, null, 2));
  replaceFile(tmp, paths.threads);
  return t;
}

/**
 * Tokens currently in a thread's context window, from the usage numbers Claude
 * Code already writes to the session transcript. Reads only the file's tail.
 */
export function transcriptTokens(transcript: string | undefined): number | undefined {
  if (!transcript) return undefined;
  const lines = readTail(transcript, 128 * 1024).trimEnd().split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!lines[i].includes('"usage"')) continue;
    try {
      const u = JSON.parse(lines[i])?.message?.usage;
      if (u && typeof u.input_tokens === "number") {
        return u.input_tokens + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.output_tokens ?? 0);
      }
    } catch { /* skip */ }
  }
  return undefined;
}
