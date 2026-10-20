import type { ActivityEvent, ContextMap, WeaveNode } from "../types.js";

/**
 * Freezing, per thread. A file this thread read or edited earlier, but not in
 * its last FREEZE_AFTER or its last two user messages, is frozen for that
 * thread only. Frozen files are never blocked or detached: the thread is just
 * told to skip them unless needed, and a file unfreezes the moment the thread
 * reads or edits it again. Nothing is written into presets.
 *
 * Plain arithmetic over the activity log and the thread's prompt times: no
 * model is involved, so the same activity always gives the same result.
 */
export const FREEZE_AFTER = 10 * 60_000;
/** Prompt times kept per thread; only the last two matter. */
export const KEEP_PROMPTS = 3;
/** About 50 tokens for the frozen list. */
export const FROZEN_CHARS = 200;

/**
 * Files frozen for one thread, by path. `prompts` are the thread's user
 * message times, oldest first, the current one last. With fewer than two the
 * whole thread is within its last two messages, so nothing is frozen.
 */
export function frozen(map: ContextMap, events: ActivityEvent[], session: string, prompts: number[] = [], now = Date.now()): WeaveNode[] {
  if (prompts.length < 2) return [];
  const since = Math.min(now - FREEZE_AFTER, prompts[prompts.length - 2]);
  const last = new Map<string, number>();
  for (const e of events) {
    if (e.s !== session || e.ph !== "end" || e.blocked || (e.verb !== "Read" && e.verb !== "Edit")) continue;
    last.set(e.node, Math.max(e.t, last.get(e.node) ?? 0));
  }
  return map.nodes.filter((n) => n.tier === "element" && n.kind !== "tool" && last.has(n.id) && last.get(n.id)! < since)
    .sort((a, b) => (a.paths[0] ?? a.id).localeCompare(b.paths[0] ?? b.id));
}

/**
 * The one line a thread gets per message: paths grouped by folder, cut to
 * about `max` characters. Undefined when nothing is frozen.
 */
export function frozenLine(paths: string[], max = FROZEN_CHARS): string | undefined {
  if (!paths.length) return undefined;
  const folders = new Map<string, string[]>();
  for (const p of paths) {
    const cut = p.replace(/\/$/, "").lastIndexOf("/");
    const dir = cut < 0 ? "" : p.slice(0, cut + 1);
    folders.set(dir, [...(folders.get(dir) ?? []), p.slice(dir.length)]);
  }
  const groups = [...folders].map(([dir, names]) => names.length === 1 ? dir + names[0]
    : names.length <= 3 ? `${dir}{${names.join(", ")}}` : `${dir || "./"} (${names.length} files)`);
  const head = "Frozen, skip unless needed: ";
  let out = head;
  for (let i = 0; i < groups.length; i++) {
    const next = (i ? ", " : "") + groups[i];
    const rest = groups.length - i - 1;
    // Leave room for the "and N more" tail whenever something would still follow.
    if ((out + next).length > max - (rest ? 12 : 0) && i > 0) return `${out} and ${groups.length - i} more.`;
    out += next;
  }
  return out + ".";
}
