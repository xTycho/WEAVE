import { execFileSync } from "node:child_process";
import type { ActivityEvent, Area, ContextMap, Meter, ThreadInfo } from "../types.js";
import { areaOf, fileEvents } from "./areas.js";
import { featureOf, k, nodeIndex } from "./map.js";

/**
 * The meter. Fixed rules over a thread's token count (from its transcript)
 * and the activity log, no model involved. A thread hears at most one line
 * per user message, and only the user can run /compact or /clear. With
 * `fresh` set to "thread" (for the app, where they cannot be typed), both
 * become "start a new thread" with a carry-over line.
 *
 *  - Compact: from COMPACT_NOW of the window, or from `compactAt` when at least
 *    STALE_SHARE of the thread is files it has moved on from. A file has been
 *    moved on from when the thread last used it before its last KEEP prompts.
 *  - Clear: the first CLEAR_LOOK file actions of the current message touch at
 *    least two files, all in features the thread never used before; the thread
 *    already holds CLEAR_MIN of the window and touched two files earlier. A new
 *    task shows itself in its first reads, and gains nothing from the old
 *    context. Later in a message the rule stays quiet, since a long task often
 *    wanders into new folders.
 *  - Delegate: from DELEGATE_AT of the window, when this message's files all
 *    sit in one area that has a subagent, Claude is told to hand it over.
 */
export const COMPACT_NOW = 0.8;
export const STALE_SHARE = 0.25;
export const CLEAR_MIN = 0.2;
export const DELEGATE_AT = 0.4;
export const CLEAR_LOOK = 5;
/** Prompts after which an unused file counts as moved on from. */
export const KEEP = 3;

/** This thread's own file events: subagent calls stay out, since their reads never reached the thread. */
function own(events: ActivityEvent[], session: string): ActivityEvent[] {
  return fileEvents(events).filter((e) => e.s === session && !e.sub);
}

/** Tokens of files the thread read or edited but has not used since its last KEEP prompts. */
export function staleTokens(map: ContextMap, events: ActivityEvent[], session: string, prompts: number[] = []): number {
  if (prompts.length < KEEP) return 0;
  const since = prompts[prompts.length - KEEP];
  const last = new Map<string, number>();
  for (const e of own(events, session)) last.set(e.node, Math.max(e.t, last.get(e.node) ?? 0));
  const nodes = nodeIndex(map);
  let sum = 0;
  for (const [id, t] of last) if (t < since) sum += nodes.get(id)?.tokens ?? 0;
  return sum;
}

/** The files a thread held in its context, hottest first: what it read or edited, with the tokens each adds. Hot means used within its last KEEP prompts. */
export function threadFiles(map: ContextMap, events: ActivityEvent[], session: string, prompts: number[] = []): { path: string; tokens: number; hot: boolean }[] {
  const since = prompts.length >= KEEP ? prompts[prompts.length - KEEP] : 0;
  const nodes = nodeIndex(map), last = new Map<string, { t: number; path?: string }>();
  for (const e of own(events, session)) if (e.t >= (last.get(e.node)?.t ?? 0)) last.set(e.node, { t: e.t, path: e.path });
  const out = new Map<string, { path: string; tokens: number; hot: boolean; t: number }>();
  for (const [id, v] of last) {
    const n = nodes.get(id), path = v.path ?? n?.paths[0];
    if (!n || n.tier !== "element" || n.kind === "tool" || !path) continue;
    out.set(path, { path, tokens: n.tokens, hot: v.t >= since, t: v.t });
  }
  return [...out.values()].sort((a, b) => Number(b.hot) - Number(a.hot) || b.t - a.t).map(({ path, tokens, hot }) => ({ path, tokens, hot }));
}

/** Files and features this thread used before and since its current message. */
function split(map: ContextMap, events: ActivityEvent[], session: string, start: number) {
  const nodes = nodeIndex(map);
  const before = new Set<string>(), now = new Set<string>(), featBefore = new Set<string>(), featNow = new Set<string>();
  let actions = 0;
  for (const e of own(events, session)) {
    const n = nodes.get(e.node);
    const f = n && featureOf(n);
    if (!n || !f) continue;
    if (e.t < start) { before.add(n.id); featBefore.add(f); } else { now.add(n.id); featNow.add(f); actions++; }
  }
  return { before, now, featBefore, featNow, nodes, actions };
}

/** A fixed-rule carry-over line for a /clear: the earlier task, the files it edited, and uncommitted changes. */
export function carryOver(map: ContextMap, events: ActivityEvent[], thread: ThreadInfo, root?: string, all = false): string {
  // For /clear the carry-over is the work before this message; for a new thread it is everything so far.
  const start = all ? Infinity : thread.prompts?.at(-1) ?? Date.now();
  const edited = [...new Set(own(events, thread.id).filter((e) => e.verb === "Edit" && e.t < start).map((e) => e.path ?? e.node))];
  const ask = all ? thread.asks?.at(-1) : thread.asks && thread.asks.length > 1 ? thread.asks[thread.asks.length - 2] : undefined;
  const parts = [ask ? `${all ? "task" : "earlier task"} "${ask}"` : undefined, edited.length ? `edited ${edited.slice(0, 5).join(", ")}${edited.length > 5 ? ` and ${edited.length - 5} more` : ""}` : undefined];
  const dirty = root ? uncommitted(root) : undefined;
  if (dirty) parts.push(`${dirty} uncommitted file${dirty === 1 ? "" : "s"}`);
  const text = parts.filter(Boolean).join("; ");
  return text ? `Carry-over: ${text}.` : "";
}

function uncommitted(root: string): number | undefined {
  try {
    const out = execFileSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 2000 });
    return out.split("\n").filter(Boolean).length || undefined;
  } catch { return undefined; }
}

export interface MeterInput {
  map: ContextMap;
  events: ActivityEvent[];
  thread: ThreadInfo;
  tokens: number | undefined;
  areas: Area[];
  /** Areas that have a subagent. */
  agents: Area[];
  /** "prompt" checks /compact as a message arrives; "tool" checks /clear and delegation once the work shows where it is; "view" checks all, for the map. */
  at: "prompt" | "tool" | "view";
  root?: string;
}

/** The meter for one thread right now. */
export function meter({ map, events, thread, tokens, agents, at, root }: MeterInput): Meter {
  const { window, compactAt, fresh } = map.settings;
  // Where /compact and /clear cannot be typed (the app, a project thread), the advice is a new thread with a carry-over line.
  const thread_ = fresh === "thread";
  const share = tokens ? tokens / window : 0;
  const stale = staleTokens(map, events, thread.id, thread.prompts);
  const base: Meter = { level: "ok", tokens, window, share, stale };
  if (!tokens) return base;
  const full = `~${k(tokens)} of ${k(window)} tokens`;

  const compact = share >= COMPACT_NOW || (share >= compactAt && stale >= STALE_SHARE * tokens);
  if (compact && at !== "tool") {
    const why = share >= COMPACT_NOW ? "nearly full" : `~${k(stale)} of it is files it has moved on from`;
    if (!thread_) return { ...base, level: "compact", text: `This thread holds ${full} and ${why}. Run /compact.` };
    const carry = carryOver(map, events, thread, root, true);
    return { ...base, level: "compact", text: `This thread holds ${full} and ${why}. Start a new thread for the next task.${carry ? ` ${carry}` : ""}` };
  }
  if (at === "prompt") return base;

  const start = thread.prompts?.at(-1) ?? 0;
  const { before, now, featBefore, featNow, nodes, actions } = split(map, events, thread.id, start);
  if (share >= CLEAR_MIN && before.size >= 2 && now.size >= 2 && actions <= CLEAR_LOOK && [...featNow].every((f) => !featBefore.has(f))) {
    const where = [...featNow].map((f) => nodes.get(f)?.paths[0] ?? f).join(", ");
    const carry = carryOver(map, events, thread, root);
    return { ...base, level: "clear", text: `This message works in ${where}, which nothing earlier in this thread touched, and the thread holds ${full}. ${thread_ ? "Start a new thread for this request." : "Run /clear and send the request again."}${carry ? ` ${carry}` : ""}` };
  }
  if (share >= DELEGATE_AT && now.size) {
    const hit = new Set([...now].map((id) => areaOf(agents, nodes.get(id))));
    const [area] = hit;
    if (hit.size === 1 && area) return { ...base, level: "delegate", agent: area.agent, text: `This thread holds ${full}. Hand the rest of this task to the ${area.agent} subagent (${area.folders.join(", ") || "root files"}) so its reads stay out of this thread.` };
  }
  return base;
}

/** The hook line for a meter reading: who acts on it, said once. */
export function meterLine(m: Meter): string | undefined {
  if (m.level === "ok" || !m.text) return undefined;
  if (m.level === "delegate") return `WEAVE: ${m.text}`;
  return `WEAVE: ${m.text} Only the user can do this, so tell them in one line.`;
}
