import type { ActivityEvent, ContextMap, Preset, Settings, Suggestion } from "../types.js";
import { isLive, nodeIndex } from "./window.js";

/**
 * Suggestions from fixed rules over what threads actually did. No model is
 * involved, so the same activity always gives the same suggestions.
 *
 *  - Asked while detached: a thread read or edited a node that is detached.
 *  - Linked file: a node that tests or is imported by an edited node is detached.
 *  - Unused: an attached node nobody touched in the last `idleAfter` actions.
 *    Only while warm and cold is off; with it on, such files are simply cold.
 */
export function suggestions(map: ContextMap, preset: Preset, events: ActivityEvent[]): Suggestion[] {
  const nodes = nodeIndex(map);
  const sessions = new Set(Object.entries(map.assign).filter(([, p]) => p === preset.id).map(([s]) => s));
  const isDefault = map.settings.defaultPreset === preset.id;
  const mine = events.filter((e) => e.ph === "end" || e.blocked).filter((e) => sessions.has(e.s) || (isDefault && !map.assign[e.s]));
  const since = (id: string) => preset.changedAt[id] ?? 0;
  const out: Suggestion[] = [];
  const seen = new Set<string>();
  const add = (s: Omit<Suggestion, "key">) => {
    const key = `${preset.id}:${s.rule}:${s.node}`;
    if (seen.has(s.node) || map.dismissed.includes(key)) return;
    seen.add(s.node);
    out.push({ ...s, key });
  };

  const asked = new Map<string, number>();
  for (const e of mine) if (e.outside && e.t >= since(e.node)) asked.set(e.node, (asked.get(e.node) ?? 0) + 1);
  for (const [id, count] of asked) {
    const n = nodes.get(id);
    if (n && !isLive(n, preset)) add({ rule: "Asked while detached", node: id, attach: true, text: `Claude asked for ${n.label} ${count === 1 ? "once" : `${count} times`} while it was detached.` });
  }

  const edited = new Map<string, number>();
  for (const e of mine) if (e.verb === "Edit" && !e.blocked) edited.set(e.node, e.t);
  for (const l of map.links) {
    const t = edited.get(l.to);
    const a = nodes.get(l.from), b = nodes.get(l.to);
    if (t && a && b && t >= since(a.id) && !isLive(a, preset)) add({ rule: "Linked file", node: a.id, attach: true, text: `${a.label} ${l.why} ${b.label}, which was edited.` });
  }

  const actions = mine.filter((e) => !e.blocked);
  // With warm and cold on, rarely used files are already cold: they cost nothing until opened, so there is nothing to detach.
  if (!map.settings.warmCold && actions.length >= map.settings.idleAfter) {
    const recent = new Set(actions.slice(-map.settings.idleAfter).map((e) => e.node));
    const firstSeen = actions[actions.length - map.settings.idleAfter].t;
    const idle = map.nodes
      .filter((n) => n.tier === "element" && n.kind !== "tool" && n.tokens > 0 && isLive(n, preset) && !recent.has(n.id) && since(n.id) < firstSeen)
      .sort((x, y) => y.tokens - x.tokens)[0];
    if (idle) add({ rule: "Unused", node: idle.id, attach: false, text: `${idle.label} was not read or edited in the last ${map.settings.idleAfter} actions.` });
  }
  return out;
}

export type ContextLevel = "ok" | "heavy" | "full";

/** A fixed-rule word on a thread's context size: heavy from `heavyAt` tokens, full from `freshAt`. */
export function contextLevel(tokens: number | undefined, settings: Pick<Settings, "heavyAt" | "freshAt">): { level: ContextLevel; text?: string } {
  if (!tokens || tokens < settings.heavyAt) return { level: "ok" };
  if (tokens >= settings.freshAt) return { level: "full", text: "Start a new thread now" };
  return { level: "heavy", text: "This thread is getting heavy, start a new thread for the next task" };
}
