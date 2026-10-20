import type { ActivityEvent, Area, ContextMap, WeaveNode } from "../types.js";
import { featureOf, nodeIndex, slug } from "./map.js";

/**
 * Areas: features that threads use together. Fixed rules over the activity
 * log, no model involved, so the same log always gives the same areas.
 *
 *  - Each feature (scanned folder) starts as its own area.
 *  - Two features join when at least JOIN_THREADS threads worked in both, and
 *    those threads are at least JOIN_SHARE of the threads that worked in either.
 *  - The strongest pairs join first, and joins chain: if A joins B and B joins
 *    C, all three are one area. A join that would put more than MAX_SHARE of
 *    the project's tokens in one area is skipped, so an area stays small
 *    enough to be worth a subagent.
 *  - An area's key files are its most read and edited files, at most KEY_FILES.
 *  - An area is named after its biggest folder, plus how many others it holds.
 *
 * With no activity yet, every area is just a folder from the scan.
 */
export const JOIN_THREADS = 2;
export const JOIN_SHARE = 0.5;
export const KEY_FILES = 8;
export const MAX_SHARE = 0.35;
/** Subagents are written for the biggest areas only, so the list stays readable. */
export const MAX_AGENTS = 8;

/** Read and edit events that count: finished calls on files, not shell runs. */
export function fileEvents(events: ActivityEvent[]): ActivityEvent[] {
  return events.filter((e) => e.ph !== "start" && (e.verb === "Read" || e.verb === "Edit"));
}

export function areas(map: ContextMap, events: ActivityEvent[]): Area[] {
  const nodes = nodeIndex(map);
  const features = map.nodes.filter((n) => n.tier === "feature");
  const tokens = new Map<string, number>();
  for (const n of map.nodes) {
    if (n.tier !== "element" || n.kind === "tool") continue;
    const f = n.of[0];
    if (f) tokens.set(f, (tokens.get(f) ?? 0) + n.tokens);
  }

  // Which threads worked in each feature, and how often each file was used.
  const threadsOf = new Map<string, Set<string>>();
  const uses = new Map<string, number>();
  for (const e of fileEvents(events)) {
    const n = nodes.get(e.node);
    const f = n && featureOf(n);
    if (!n || !f) continue;
    if (!threadsOf.has(f)) threadsOf.set(f, new Set());
    threadsOf.get(f)!.add(e.s);
    if (n.tier === "element") uses.set(n.id, (uses.get(n.id) ?? 0) + 1);
  }

  // Union-find over features, strongest pairs first, with each group's tokens kept at its root.
  const parent = new Map(features.map((f) => [f.id, f.id]));
  const size = new Map(features.map((f) => [f.id, tokens.get(f.id) ?? 0]));
  const find = (id: string): string => { let r = id; while (parent.get(r) !== r) r = parent.get(r)!; parent.set(id, r); return r; };
  const cap = MAX_SHARE * [...tokens.values()].reduce((s, v) => s + v, 0);
  const used = features.filter((f) => (threadsOf.get(f.id)?.size ?? 0) >= JOIN_THREADS);
  const pairs: { a: string; b: string; score: number }[] = [];
  for (let i = 0; i < used.length; i++) {
    for (let j = i + 1; j < used.length; j++) {
      const a = threadsOf.get(used[i].id)!, b = threadsOf.get(used[j].id)!;
      const both = [...a].filter((s) => b.has(s)).length, score = both / (a.size + b.size - both);
      if (both >= JOIN_THREADS && score >= JOIN_SHARE) pairs.push({ a: used[i].id, b: used[j].id, score });
    }
  }
  pairs.sort((x, y) => y.score - x.score || x.a.localeCompare(y.a) || x.b.localeCompare(y.b));
  for (const { a, b } of pairs) {
    const ra = find(a), rb = find(b);
    if (ra === rb || size.get(ra)! + size.get(rb)! > cap) continue;
    const [keep, join] = ra < rb ? [ra, rb] : [rb, ra];
    parent.set(join, keep);
    size.set(keep, size.get(keep)! + size.get(join)!);
  }

  const groups = new Map<string, WeaveNode[]>();
  for (const f of features) {
    const r = find(f.id);
    if (!groups.has(r)) groups.set(r, []);
    groups.get(r)!.push(f);
  }

  const out: Area[] = [];
  for (const members of groups.values()) {
    members.sort((a, b) => a.id.localeCompare(b.id));
    const ids = new Set(members.map((f) => f.id));
    const total = members.reduce((s, f) => s + (tokens.get(f.id) ?? 0), 0);
    if (!total) continue;
    const threads = new Set(members.flatMap((f) => [...(threadsOf.get(f.id) ?? [])]));
    const files = map.nodes
      .filter((n) => n.tier === "element" && n.kind !== "tool" && ids.has(n.of[0]) && uses.has(n.id))
      .sort((a, b) => uses.get(b.id)! - uses.get(a.id)! || a.id.localeCompare(b.id))
      .slice(0, KEY_FILES).flatMap((n) => n.paths);
    const lead = [...members].sort((a, b) => (tokens.get(b.id) ?? 0) - (tokens.get(a.id) ?? 0) || a.id.localeCompare(b.id))[0];
    const base = (lead.paths[0] ?? "root").replace(/\/$/, "");
    const more = members.length - 1;
    const name = more ? `${base} + ${more} more` : base;
    const id = (slug(base) || "root") + (more ? `-and-${more}` : "");
    out.push({
      id, name, agent: `weave-${id}`, features: members.map((f) => f.id), folders: members.flatMap((f) => f.paths),
      files, tokens: total, threads: threads.size, from: threads.size ? "usage" : "folders",
    });
  }
  return out.sort((a, b) => b.threads - a.threads || b.tokens - a.tokens || a.id.localeCompare(b.id));
}

/** The areas that get a subagent: the MAX_AGENTS first by use, then size. */
export function agentAreas(list: Area[]): Area[] {
  return list.slice(0, MAX_AGENTS);
}

/** The area a node falls in, if any. */
export function areaOf(list: Area[], node: WeaveNode | undefined): Area | undefined {
  const f = node && featureOf(node);
  return f ? list.find((a) => a.features.includes(f)) : undefined;
}
