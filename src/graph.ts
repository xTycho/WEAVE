import { existsSync } from "node:fs";
import { join } from "node:path";
import type { ContextMap, WeaveNode } from "./types.js";

export class GraphError extends Error {}

function byId(map: ContextMap): Map<string, WeaveNode> {
  return new Map(map.nodes.map((n) => [n.id, n]));
}

function find(map: ContextMap, id: string): WeaveNode {
  const node = map.nodes.find((n) => n.id === id);
  if (!node) {
    const near = map.nodes.map((n) => n.id).filter((n) => n.includes(id) || id.includes(n)).slice(0, 5);
    throw new GraphError(`Unknown node "${id}".${near.length ? ` Did you mean: ${near.join(", ")}?` : ""}`);
  }
  return node;
}

/** Ids of nodes whose context cord currently reaches the core. */
export function liveIds(map: ContextMap): Set<string> {
  const nodes = byId(map);
  const live = new Set<string>();
  const isLive = (node: WeaveNode, seen: Set<string>): boolean => {
    if (live.has(node.id)) return true;
    if (node.severed || seen.has(node.id)) return false;
    seen.add(node.id);
    let ok: boolean;
    if (node.tier === "core") ok = true;
    else if (node.tier === "feature") ok = node.active;
    else ok = node.links.some((l) => { const p = nodes.get(l); return !!p && isLive(p, seen); });
    if (ok) live.add(node.id);
    return ok;
  };
  for (const n of map.nodes) isLive(n, new Set());
  return live;
}

/** Keeps the denormalised `active` flag of context nodes in sync for the UI. */
export function syncActive(map: ContextMap): ContextMap {
  const live = liveIds(map);
  for (const n of map.nodes) if (n.tier === "context") n.active = live.has(n.id);
  return map;
}

/** Activates a node; activating outer context also wakes its parent feature. */
export function activate(map: ContextMap, id: string): string[] {
  const node = find(map, id);
  const touched = [node.id];
  node.severed = false;
  node.active = true;
  if (node.tier === "context") {
    for (const parentId of node.links) {
      const parent = map.nodes.find((n) => n.id === parentId);
      if (parent && parent.tier === "feature" && (!parent.active || parent.severed)) {
        parent.active = true;
        parent.severed = false;
        touched.push(parent.id);
      }
    }
  }
  syncActive(map);
  return touched;
}

/** Severs a node's cord; a severed feature also drops all its outer context. */
export function sever(map: ContextMap, id: string): string[] {
  const node = find(map, id);
  if (node.tier === "core") throw new GraphError("The core router cannot be severed.");
  const before = liveIds(map);
  node.severed = true;
  node.active = false;
  syncActive(map);
  const after = liveIds(map);
  return [...before].filter((n) => !after.has(n));
}

/** Clears a severed flag without activating the node. */
export function restore(map: ContextMap, id: string): string[] {
  const node = find(map, id);
  node.severed = false;
  syncActive(map);
  return [node.id];
}

export interface ActiveContext {
  active: string[];
  paths: string[];
  missing: string[];
}

/** Resolves live nodes to a deduplicated list of project paths that exist. */
export function activeContext(map: ContextMap, root: string): ActiveContext {
  const live = liveIds(map);
  const order: Record<string, number> = { core: 0, feature: 1, context: 2 };
  const nodes = map.nodes.filter((n) => live.has(n.id)).sort((a, b) => order[a.tier] - order[b.tier]);
  const paths: string[] = [];
  const missing: string[] = [];
  const seen = new Set<string>();
  for (const n of nodes) {
    for (const p of n.paths) {
      if (seen.has(p)) continue;
      seen.add(p);
      (existsSync(join(root, p)) ? paths : missing).push(p);
    }
  }
  return { active: nodes.map((n) => n.id), paths, missing };
}
