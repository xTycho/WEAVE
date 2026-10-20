import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { projectPaths, replaceFile, type ProjectPaths } from "./paths.js";
import { scanProject, type TokenLookup } from "./scanner/project-scanner.js";
import { tokenLookup } from "./engine/tokens.js";
import { PALETTE } from "./engine/window.js";
import type { ContextMap, Kind, Override, Preset, ScanResult, Settings, WeaveNode } from "./types.js";

export interface LoadedMap {
  map: ContextMap;
  source: "file" | "scan";
  warning?: string;
}

const KINDS: Kind[] = ["core", "feature", "code", "design", "doc", "test", "tool"];
const DEFAULT_SETTINGS: Settings = { autoApply: false, warmCold: true, freeze: true, autoCalibrate: true, heavyAt: 50_000, freshAt: 100_000, gate: "flag", idleAfter: 10, defaultPreset: "full" };

/** Context thresholds stay between 10k and 2M tokens, and fresh is never below heavy. */
export function thresholds(heavy: unknown, fresh: unknown): { heavyAt: number; freshAt: number } {
  const clamp = (v: unknown, d: number) => Math.min(2_000_000, Math.max(10_000, Math.round(Number(v)) || d));
  const heavyAt = clamp(heavy, DEFAULT_SETTINGS.heavyAt);
  return { heavyAt, freshAt: Math.max(heavyAt, clamp(fresh, DEFAULT_SETTINGS.freshAt)) };
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
    ...(n.exact ? { exact: true } : {}), ...(n.custom ? { custom: true } : {}), ...(typeof n.command === "string" ? { command: n.command } : {}),
  };
}

function preset(raw: unknown, i: number): Preset | undefined {
  const p = obj(raw);
  if (typeof p.id !== "string") return undefined;
  const changed = obj(p.changedAt);
  return {
    id: p.id, name: str(p.name, p.id), color: str(p.color, PALETTE[i % PALETTE.length]),
    features: strs(p.features), detached: strs(p.detached), asleep: strs(p.asleep), ...(p.auto === true ? { auto: true } : {}),
    changedAt: Object.fromEntries(Object.entries(changed).filter(([, v]) => typeof v === "number")) as Record<string, number>,
  };
}

/** Turns untrusted JSON into a valid map, dropping anything malformed. */
export function normalizeMap(raw: unknown): ContextMap {
  const m = obj(raw);
  const s = obj(m.settings);
  const nodes = (Array.isArray(m.nodes) ? m.nodes : []).map(node).filter((n): n is WeaveNode => !!n);
  const presets = (Array.isArray(m.presets) ? m.presets : []).map(preset).filter((p): p is Preset => !!p);
  const overrides: Record<string, Override> = {};
  for (const [id, o] of Object.entries(obj(m.overrides))) {
    const v = obj(o);
    overrides[id] = {
      ...(typeof v.label === "string" ? { label: v.label } : {}),
      ...(KINDS.includes(v.kind as Kind) ? { kind: v.kind as Kind } : {}),
      ...(Array.isArray(v.addOf) ? { addOf: strs(v.addOf) } : {}),
    };
  }
  return {
    version: 2,
    scannedAt: typeof m.scannedAt === "string" ? m.scannedAt : undefined,
    nodes,
    links: (Array.isArray(m.links) ? m.links : []).map(obj)
      .filter((l) => typeof l.from === "string" && typeof l.to === "string" && (l.why === "tests" || l.why === "is imported by"))
      .map((l) => ({ from: l.from as string, to: l.to as string, why: l.why as "tests" | "is imported by" })),
    presets,
    assign: Object.fromEntries(Object.entries(obj(m.assign)).filter(([, v]) => typeof v === "string")) as Record<string, string>,
    overrides,
    custom: (Array.isArray(m.custom) ? m.custom : []).map(node).filter((n): n is WeaveNode => !!n),
    dismissed: strs(m.dismissed),
    settings: {
      autoApply: s.autoApply === true,
      warmCold: s.warmCold !== false,
      freeze: s.freeze !== false,
      autoCalibrate: s.autoCalibrate !== false,
      // Maps saved with the old 150k / 300k defaults move to the new ones; any other choice is kept.
      ...(s.heavyAt === 150_000 && s.freshAt === 300_000 ? thresholds(undefined, undefined) : thresholds(s.heavyAt, s.freshAt)),
      gate: s.gate === "block" ? "block" : "flag",
      idleAfter: Math.min(500, Math.max(3, Number(s.idleAfter) || DEFAULT_SETTINGS.idleAfter)),
      defaultPreset: str(s.defaultPreset, presets[0]?.id ?? DEFAULT_SETTINGS.defaultPreset),
    },
    updatedAt: typeof m.updatedAt === "string" ? m.updatedAt : undefined,
  };
}

function emptyMap(): ContextMap {
  return { version: 2, nodes: [], links: [], presets: [], assign: {}, overrides: {}, custom: [], dismissed: [], settings: { ...DEFAULT_SETTINGS } };
}

/**
 * Lays a fresh scan over the stored map. The user's presets, overrides and
 * custom nodes survive; scanned nodes and links are replaced.
 */
export function mergeScan(map: ContextMap, scan: ScanResult): ContextMap {
  const prevFeatures = new Set(map.nodes.filter((n) => n.tier === "feature" && !n.custom).map((n) => n.id));
  const nodes = [...scan.nodes.map((n) => ({ ...n, of: [...n.of] })), ...map.custom.map((n) => ({ ...n }))];
  for (const n of nodes) {
    const o = map.overrides[n.id];
    if (!o) continue;
    if (o.label) n.label = o.label;
    if (o.kind) n.kind = o.kind;
    for (const f of o.addOf ?? []) if (!n.of.includes(f)) n.of.push(f);
  }
  const features = nodes.filter((n) => n.tier === "feature").map((n) => n.id);
  const fresh = features.filter((f) => !prevFeatures.has(f));
  const presets = map.presets.length ? map.presets : [{ id: "full", name: "Full project", color: PALETTE[0], features: [], detached: [], changedAt: {} }];
  for (const p of presets) {
    // A preset that held every feature keeps holding every feature as the project grows.
    const hadAll = prevFeatures.size === 0 || [...prevFeatures].every((f) => p.features.includes(f));
    if (hadAll) p.features.push(...fresh.filter((f) => !p.features.includes(f)));
  }
  return { ...map, nodes, links: scan.links, presets, scannedAt: new Date().toISOString() };
}

/**
 * File-backed store for `.claude/context-map.json`. Reads never throw: a
 * missing or broken map falls back to a fresh scan of the project.
 */
export class ContextStore {
  readonly paths: ProjectPaths;

  constructor(root: string = process.cwd()) {
    this.paths = projectPaths(root);
  }

  get root(): string { return this.paths.root; }
  get mapPath(): string { return this.paths.map; }

  scan(tokens: TokenLookup = tokenLookup(this.root)): ScanResult {
    return scanProject(this.root, tokens);
  }

  /** Reads the stored map. With `scanIfMissing` false (hooks), a missing map stays empty instead of scanning. */
  load(scanIfMissing = true): LoadedMap {
    let text: string | undefined;
    try { text = readFileSync(this.paths.map, "utf8"); } catch { /* missing */ }
    if (text !== undefined) {
      try {
        const map = normalizeMap(JSON.parse(text));
        if (map.nodes.length && map.presets.length) return { map, source: "file" };
      } catch (err) {
        const warning = `context-map.json unreadable (${(err as Error).message}); rebuilt from a scan`;
        return { map: scanIfMissing ? mergeScan(emptyMap(), this.scan()) : emptyMap(), source: "scan", warning };
      }
    }
    return { map: scanIfMissing ? mergeScan(emptyMap(), this.scan()) : emptyMap(), source: "scan", ...(text === undefined ? { warning: "context-map.json missing; built from a scan" } : {}) };
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
