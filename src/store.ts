import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { scanFeatures } from "./scanner/context-scanner.js";
import type { ContextMap, LoadedMap, WeaveNode } from "./types.js";

export const MAP_RELATIVE_PATH = join(".claude", "context-map.json");
const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const TEMPLATE_DIR = join(PACKAGE_ROOT, "templates");

export function coreNode(): WeaveNode {
  return { id: "core", label: "Core", tier: "core", paths: ["CLAUDE.md"], links: [], active: true, severed: false };
}

function isNode(value: unknown): value is WeaveNode {
  const n = value as WeaveNode;
  return !!n && typeof n.id === "string" && ["core", "feature", "context"].includes(n.tier) && Array.isArray(n.paths);
}

/** Normalises untrusted JSON into a valid map, dropping malformed nodes. */
export function normalizeMap(raw: unknown): ContextMap {
  const input = (raw ?? {}) as Partial<ContextMap>;
  const nodes = (Array.isArray(input.nodes) ? input.nodes : []).filter(isNode).map((n) => ({
    id: n.id,
    label: typeof n.label === "string" ? n.label : n.id,
    tier: n.tier,
    paths: n.paths.filter((p): p is string => typeof p === "string"),
    links: Array.isArray(n.links) ? n.links.filter((l): l is string => typeof l === "string") : [],
    active: n.tier === "core" ? !n.severed : !!n.active,
    severed: !!n.severed,
  }));
  if (!nodes.some((n) => n.tier === "core")) nodes.unshift(coreNode());
  return { version: 1, nodes, updatedAt: input.updatedAt };
}

/** Adds scanned nodes that the stored map does not know about yet. */
function mergeScanned(map: ContextMap, scanned: WeaveNode[]): ContextMap {
  const known = new Set(map.nodes.map((n) => n.id));
  const fresh = scanned.filter((n) => !known.has(n.id));
  return fresh.length ? { ...map, nodes: [...map.nodes, ...fresh] } : map;
}

/**
 * File-backed store for `.claude/context-map.json`.
 * Never throws on read: a missing or corrupt map falls back to a scan of
 * `.claude/features/`, then to the bundled template, then to a core-only map.
 */
export class ContextStore {
  readonly root: string;
  readonly mapPath: string;

  constructor(root: string = process.cwd()) {
    this.root = resolve(root);
    this.mapPath = join(this.root, MAP_RELATIVE_PATH);
  }

  load(): LoadedMap {
    const scanned = scanFeatures(this.root);
    if (existsSync(this.mapPath)) {
      try {
        const map = normalizeMap(JSON.parse(readFileSync(this.mapPath, "utf8")));
        return { map: mergeScanned(map, scanned), source: "file" };
      } catch (err) {
        const warning = `context-map.json unreadable (${(err as Error).message}); using fallback`;
        return { ...this.fallback(scanned), warning };
      }
    }
    return { ...this.fallback(scanned), warning: "context-map.json missing; using fallback" };
  }

  private fallback(scanned: WeaveNode[]): LoadedMap {
    if (scanned.length) return { map: { version: 1, nodes: [coreNode(), ...scanned] }, source: "scan" };
    const template = join(TEMPLATE_DIR, "default-map.json");
    try {
      return { map: normalizeMap(JSON.parse(readFileSync(template, "utf8"))), source: "default" };
    } catch {
      return { map: { version: 1, nodes: [coreNode()] }, source: "empty" };
    }
  }

  /** Atomic write (tmp file + rename) so watchers never see half a file. */
  save(map: ContextMap): void {
    mkdirSync(dirname(this.mapPath), { recursive: true });
    const tmp = `${this.mapPath}.${process.pid}.tmp`;
    const out: ContextMap = { ...map, updatedAt: new Date().toISOString() };
    writeFileSync(tmp, JSON.stringify(out, null, 2) + "\n", "utf8");
    renameSync(tmp, this.mapPath);
  }

  /** Load, mutate, save. Returns the saved map. */
  update(mutate: (map: ContextMap) => void): ContextMap {
    const { map } = this.load();
    mutate(map);
    this.save(map);
    return map;
  }
}
