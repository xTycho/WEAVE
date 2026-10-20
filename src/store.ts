import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { projectPaths, replaceFile, type ProjectPaths } from "./paths.js";
import { scanProject } from "./scanner/project-scanner.js";
import type { ContextMap, Kind, ScanResult, Settings, WeaveNode } from "./types.js";

export interface LoadedMap {
  map: ContextMap;
  source: "file" | "scan";
  warning?: string;
}

const KINDS: Kind[] = ["core", "feature", "code", "design", "doc", "test", "tool"];
export const DEFAULT_SETTINGS: Settings = { window: 200_000, compactAt: 0.6, meter: true };

/** The window stays between 50k and 2M tokens; compact sits between 30% and 95% of it. */
export function settingsFrom(raw: Record<string, unknown>): Settings {
  const window = Math.min(2_000_000, Math.max(50_000, Math.round(Number(raw.window)) || DEFAULT_SETTINGS.window));
  const at = Number(raw.compactAt);
  return { window, compactAt: Number.isFinite(at) && at > 0 ? Math.min(0.95, Math.max(0.3, at)) : DEFAULT_SETTINGS.compactAt, meter: raw.meter !== false };
}

const str = (v: unknown, d = "") => (typeof v === "string" ? v : d);
const strs = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

function node(raw: unknown): WeaveNode | undefined {
  const n = obj(raw);
  const tier = n.tier;
  if (typeof n.id !== "string" || (tier !== "core" && tier !== "feature" && tier !== "element")) return undefined;
  return {
    id: n.id, label: str(n.label, n.id), tier, kind: KINDS.includes(n.kind as Kind) ? (n.kind as Kind) : tier === "feature" ? "feature" : "code",
    paths: strs(n.paths), of: strs(n.of), bytes: Number(n.bytes) || 0, tokens: Number(n.tokens) || 0,
    ...(typeof n.command === "string" ? { command: n.command } : {}),
  };
}

/** Turns untrusted JSON into a valid map, dropping anything malformed. Maps from WEAVE 1 keep their nodes; presets and the rest are left behind. */
export function normalizeMap(raw: unknown): ContextMap {
  const m = obj(raw);
  return {
    version: 3,
    scannedAt: typeof m.scannedAt === "string" ? m.scannedAt : undefined,
    nodes: (Array.isArray(m.nodes) ? m.nodes : []).map(node).filter((n): n is WeaveNode => !!n),
    links: (Array.isArray(m.links) ? m.links : []).map(obj)
      .filter((l) => typeof l.from === "string" && typeof l.to === "string" && (l.why === "tests" || l.why === "is imported by"))
      .map((l) => ({ from: l.from as string, to: l.to as string, why: l.why as "tests" | "is imported by" })),
    settings: settingsFrom(obj(m.settings)),
    updatedAt: typeof m.updatedAt === "string" ? m.updatedAt : undefined,
  };
}

function emptyMap(): ContextMap {
  return { version: 3, nodes: [], links: [], settings: { ...DEFAULT_SETTINGS } };
}

/** Lays a fresh scan over the stored map: nodes and links are replaced, settings stay. */
export function mergeScan(map: ContextMap, scan: ScanResult): ContextMap {
  return { ...map, nodes: scan.nodes, links: scan.links, scannedAt: new Date().toISOString() };
}

/**
 * File-backed store for `.claude/context-map.json`. Reads never throw: a
 * missing or broken map falls back to a fresh scan of the project, and a
 * broken one is copied to `context-map.json.bak` first so nothing is lost.
 */
export class ContextStore {
  readonly paths: ProjectPaths;

  constructor(root: string = process.cwd()) {
    this.paths = projectPaths(root);
  }

  get root(): string { return this.paths.root; }
  get mapPath(): string { return this.paths.map; }

  scan(): ScanResult {
    return scanProject(this.root);
  }

  /** Reads the stored map. With `scanIfMissing` false (hooks), a missing map stays empty instead of scanning. */
  load(scanIfMissing = true): LoadedMap {
    let text: string | undefined;
    try { text = readFileSync(this.paths.map, "utf8"); } catch { /* missing */ }
    const fresh = () => (scanIfMissing ? mergeScan(emptyMap(), this.scan()) : emptyMap());
    if (text === undefined) return { map: fresh(), source: "scan", warning: "context-map.json missing; built from a scan" };
    try {
      const map = normalizeMap(JSON.parse(text));
      if (map.nodes.length) return { map, source: "file" };
      return { map: scanIfMissing ? mergeScan(map, this.scan()) : map, source: "scan" };
    } catch (err) {
      if (scanIfMissing) try { copyFileSync(this.paths.map, `${this.paths.map}.bak`); } catch { /* keep going */ }
      return { map: fresh(), source: "scan", warning: `context-map.json unreadable (${(err as Error).message}); rebuilt from a scan, old file kept as context-map.json.bak` };
    }
  }

  /** Atomic write (tmp file + rename) so watchers never see half a file. */
  save(map: ContextMap): void {
    mkdirSync(dirname(this.paths.map), { recursive: true });
    const tmp = `${this.paths.map}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify({ ...map, updatedAt: new Date().toISOString() }, null, 2) + "\n", "utf8");
    replaceFile(tmp, this.paths.map);
  }

  /** Load, mutate, save, return. Reads right before writing so concurrent writers lose as little as possible. */
  update<T = void>(mutate: (map: ContextMap) => T): { map: ContextMap; result: T } {
    const { map } = this.load();
    const result = mutate(map);
    this.save(map);
    return { map, result };
  }

  /** Rescans the project and saves the merged map. */
  rescan(): ContextMap {
    const scan = this.scan();
    return this.update((m) => { Object.assign(m, mergeScan(m, scan)); }).map;
  }
}
