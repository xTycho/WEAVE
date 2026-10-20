import type { ActivityEvent, ContextMap, Preset, WeaveNode } from "../types.js";
import { heat, tagFor, WARM_AT, WARM_MAX } from "./heat.js";
import { isLive, summarize } from "./window.js";

/**
 * The new-thread suggestion. Once a thread passes its context warning, WEAVE
 * suggests carrying on in a new thread, with a start line to paste into it.
 * The start line names the saved preset that best covers what this thread
 * worked on, plus a short note of paths and counts.
 *
 * Fixed rules over the activity log, no model involved:
 *  - A thread's heat per file is its own reads plus twice its edits, halved
 *    every three days, as for warm and cold.
 *  - A preset fits when the files attached in it hold at least FIT_SHARE of
 *    that heat and its attached tokens stay under the amber warning.
 *  - The best fit has the highest share, then the fewest tokens.
 *  - With no fit, the thread's warm files can be saved as a preset, tagged
 *    UI, Docs, Tests or a feature name by `tagFor`.
 */
export const FIT_SHARE = 0.6;
const MARK = /\[weave:([a-z0-9-]+)\]/;
const START = /Continue with WEAVE preset "[^"\n]*" \[weave:[a-z0-9-]+\][^\n]*/g;

export interface Handoff {
  /** The best fitting preset, when one fits. */
  preset?: { id: string; name: string; share: number; tokens: number };
  /** With no fit: the tag a preset saved from this thread's warm files would get, and how many files it holds. */
  save?: { name: string; files: number };
  read: number;
  edited: number;
  /** Folders this thread worked in, busiest first, at most three. */
  folders: string[];
  /** The line to paste into a new thread. Only when a preset fits. */
  line?: string;
}

/** This thread's heat per file, and which files it read and edited. */
function threadUse(map: ContextMap, events: ActivityEvent[], session: string, now: number) {
  const mine = events.filter((e) => e.s === session);
  const h = heat(mine, now);
  const files = map.nodes.filter((n) => n.tier === "element" && n.kind !== "tool" && h.has(n.id));
  const edited = new Set(mine.filter((e) => e.ph === "end" && !e.blocked && e.verb === "Edit").map((e) => e.node));
  return { h, files, edited };
}

/** The thread's warm files: heat of at least WARM_AT, hottest first, at most WARM_MAX. */
export function threadWarm(map: ContextMap, events: ActivityEvent[], session: string, now = Date.now()): WeaveNode[] {
  const { h, files } = threadUse(map, events, session, now);
  return files.filter((n) => h.get(n.id)! >= WARM_AT).sort((a, b) => h.get(b.id)! - h.get(a.id)! || a.id.localeCompare(b.id)).slice(0, WARM_MAX);
}

/** The best fitting preset for a thread by the rules above, or undefined. */
export function bestPreset(map: ContextMap, events: ActivityEvent[], session: string, now = Date.now()): Handoff["preset"] {
  const { h, files } = threadUse(map, events, session, now);
  const total = files.reduce((s, n) => s + h.get(n.id)!, 0);
  if (!total) return undefined;
  const fits = map.presets.map((p) => ({
    p, share: files.filter((n) => isLive(n, p)).reduce((s, n) => s + h.get(n.id)!, 0) / total, tokens: summarize(map, p).tokens,
  })).filter((x) => x.share >= FIT_SHARE && x.tokens < map.settings.heavyAt)
    .sort((a, b) => b.share - a.share || a.tokens - b.tokens || a.p.id.localeCompare(b.p.id));
  const best = fits[0];
  return best && { id: best.p.id, name: best.p.name, share: Math.round(best.share * 100) / 100, tokens: best.tokens };
}

function folderOf(path: string): string {
  const cut = path.replace(/\/$/, "").lastIndexOf("/");
  return cut < 0 ? "./" : path.slice(0, cut + 1);
}

/** The start line for a new thread on `preset`, with paths and counts only. */
export function startLine(preset: Pick<Preset, "id" | "name">, h: Pick<Handoff, "read" | "edited" | "folders">): string {
  const counts = `${h.read} file${h.read === 1 ? "" : "s"} read, ${h.edited} edited`;
  return `Continue with WEAVE preset "${preset.name}" [weave:${preset.id}]. Last thread: ${counts}${h.folders.length ? ` in ${h.folders.join(", ")}` : ""}.`;
}

/** The new-thread suggestion for one thread. Undefined when it has not read or edited anything on the map. */
export function handoff(map: ContextMap, events: ActivityEvent[], session: string, now = Date.now()): Handoff | undefined {
  const { files, edited } = threadUse(map, events, session, now);
  if (!files.length) return undefined;
  const per = new Map<string, number>();
  for (const n of files) { const f = folderOf(n.paths[0] ?? n.id); per.set(f, (per.get(f) ?? 0) + 1); }
  const out: Handoff = {
    read: files.length, edited: files.filter((n) => edited.has(n.id)).length,
    folders: [...per].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 3).map(([f]) => f),
  };
  const best = bestPreset(map, events, session, now);
  if (best) return { ...out, preset: best, line: startLine(best, out) };
  const warm = threadWarm(map, events, session, now);
  return warm.length ? { ...out, save: { name: tagFor(map, warm), files: warm.length } } : out;
}

/** The preset id a start line names, if the prompt holds one. */
export function startPreset(prompt: string): string | undefined {
  return MARK.exec(prompt)?.[1];
}

/** The prompt without its start line, for naming the thread. */
export function withoutStart(prompt: string): string {
  return prompt.replace(START, " ");
}

const RANK = { ok: 0, heavy: 1, full: 2 } as const;

/**
 * Auto-calibrate: the one line a thread gets the first time it passes each
 * warning, telling Claude to suggest a new thread with the start line. When no
 * saved preset fits, `save` is called to make one from the thread's warm
 * files. Undefined when there is nothing new to say.
 */
export function calibrate(
  map: ContextMap, events: ActivityEvent[], session: string, tokens: number | undefined,
  level: keyof typeof RANK, warned: "heavy" | "full" | undefined, save: () => Preset | undefined, now = Date.now(),
): string | undefined {
  if (!map.settings.autoCalibrate || !tokens || RANK[level] <= RANK[warned ?? "ok"]) return undefined;
  const h = handoff(map, events, session, now);
  if (!h) return undefined;
  const preset = h.preset ?? (h.save ? save() : undefined);
  if (!preset) return undefined;
  const limit = level === "full" ? map.settings.freshAt : map.settings.heavyAt;
  const k = (v: number) => `${Math.round(v / 1000)}k`;
  return `WEAVE: ${k(tokens)} tokens, past ${level === "full" ? "red" : "amber"} (${k(limit)}). Tell the user in one line to start a new thread with: ${startLine(preset, h)}`;
}
