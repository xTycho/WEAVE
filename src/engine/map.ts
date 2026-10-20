import type { ContextMap, WeaveNode } from "../types.js";

/** Lookups on the stored map. Nothing here edits project files. */

export class WeaveError extends Error {}

export function nodeIndex(map: ContextMap): Map<string, WeaveNode> {
  return new Map(map.nodes.map((n) => [n.id, n]));
}

/** Node that owns a project-relative path: exact file first, then the deepest folder. A folder path matches with or without its trailing slash. */
export function nodeForPath(map: ContextMap, rel: string): WeaveNode | undefined {
  const dir = rel.endsWith("/") ? rel : `${rel}/`;
  let best: WeaveNode | undefined, depth = -1;
  for (const n of map.nodes) {
    for (const p of n.paths) {
      if (p === rel || p === dir) { if (n.tier !== "feature") return n; }
      if (p.endsWith("/") && (rel.startsWith(p) || dir === p) && p.length > depth && n.tier !== "feature") { best = n; depth = p.length; }
    }
  }
  if (best) return best;
  for (const n of map.nodes) {
    if (n.tier !== "feature") continue;
    for (const p of n.paths) if ((rel.startsWith(p) || dir === p) && p.length > depth) { best = n; depth = p.length; }
  }
  return best;
}

/** The feature a node belongs to first, or the node itself when it is a feature. */
export function featureOf(node: WeaveNode): string | undefined {
  return node.tier === "feature" ? node.id : node.of[0];
}

export const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 40).replace(/^-+|-+$/g, "");

export const k = (v: number) => (v >= 1000 ? `${(v / 1000).toFixed(v >= 100_000 ? 0 : 1)}k` : String(v));
