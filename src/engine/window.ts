import type { ContextMap, Preset, WeaveNode } from "../types.js";

/**
 * The routing layer. It decides what is in a context window from the stored
 * map alone; it never edits project files or CLAUDE.md.
 */

export class WeaveError extends Error {}

export const PALETTE = ["#A3A9E6", "#E9A6D2", "#CFE19C", "#F6BE8A", "#C3A5DD", "#F1A9B0"];

export function nodeIndex(map: ContextMap): Map<string, WeaveNode> {
  return new Map(map.nodes.map((n) => [n.id, n]));
}

export function isLive(node: WeaveNode, preset: Preset): boolean {
  if (node.tier === "core") return true;
  if (node.tier === "feature") return preset.features.includes(node.id);
  if (preset.detached.includes(node.id)) return false;
  return node.of.length === 0 || node.of.some((f) => preset.features.includes(f));
}

export function getPreset(map: ContextMap, id?: string): Preset {
  const p = map.presets.find((x) => x.id === (id ?? map.settings.defaultPreset)) ?? map.presets[0];
  if (!p) throw new WeaveError("No presets in the map. Run `weave init`.");
  return p;
}

export function presetFor(map: ContextMap, session?: string): Preset {
  return getPreset(map, session ? map.assign[session] : undefined);
}

/** Finds a node by id, path or label, so tools can take whatever the user typed. */
export function findNode(map: ContextMap, ref: string): WeaveNode {
  const q = ref.trim().replace(/^\.\//, "");
  const hit = map.nodes.find((n) => n.id === q) ?? map.nodes.find((n) => n.paths.includes(q) || n.paths.includes(q + "/"))
    ?? map.nodes.find((n) => n.label.toLowerCase() === q.toLowerCase());
  if (hit) return hit;
  const near = map.nodes.filter((n) => n.id.includes(q) || n.label.toLowerCase().includes(q.toLowerCase())).slice(0, 5).map((n) => n.id);
  throw new WeaveError(`Unknown node "${ref}".${near.length ? ` Did you mean: ${near.join(", ")}?` : ""}`);
}

/** Node that owns a project-relative file path: exact file first, then the deepest folder. */
export function nodeForPath(map: ContextMap, rel: string): WeaveNode | undefined {
  let best: WeaveNode | undefined, depth = -1;
  for (const n of map.nodes) {
    for (const p of n.paths) {
      if (p === rel) return n;
      if (p.endsWith("/") && rel.startsWith(p) && p.length > depth && n.tier !== "feature") { best = n; depth = p.length; }
    }
  }
  if (best) return best;
  for (const n of map.nodes) {
    if (n.tier !== "feature") continue;
    for (const p of n.paths) if (rel.startsWith(p) && p.length > depth) { best = n; depth = p.length; }
  }
  return best;
}

function touch(preset: Preset, id: string) {
  preset.changedAt[id] = Date.now();
}

/** Attaches a node to a preset. An element whose features are all off brings its first feature along. */
export function attach(map: ContextMap, presetId: string | undefined, ref: string): string[] {
  const preset = getPreset(map, presetId);
  const node = findNode(map, ref);
  const touched: string[] = [];
  if (node.tier === "core") return touched;
  if (node.tier === "feature") {
    if (!preset.features.includes(node.id)) { preset.features.push(node.id); touched.push(node.id); }
  } else {
    preset.detached = preset.detached.filter((d) => d !== node.id);
    if (node.of.length && !node.of.some((f) => preset.features.includes(f))) { preset.features.push(node.of[0]); touched.push(node.of[0]); }
    touched.push(node.id);
  }
  touched.forEach((id) => touch(preset, id));
  return touched;
}

export function detach(map: ContextMap, presetId: string | undefined, ref: string): string[] {
  const preset = getPreset(map, presetId);
  const node = findNode(map, ref);
  if (node.tier === "core") throw new WeaveError("The core context cannot be detached.");
  if (node.tier === "feature") preset.features = preset.features.filter((f) => f !== node.id);
  else if (!preset.detached.includes(node.id)) preset.detached.push(node.id);
  touch(preset, node.id);
  return [node.id];
}

export function toggle(map: ContextMap, presetId: string | undefined, ref: string): { attached: boolean; touched: string[] } {
  const preset = getPreset(map, presetId);
  const node = findNode(map, ref);
  return isLive(node, preset) ? { attached: false, touched: detach(map, preset.id, ref) } : { attached: true, touched: attach(map, preset.id, ref) };
}

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "preset";

export function createPreset(map: ContextMap, name: string, features?: string[], copyFrom?: string): Preset {
  const base = copyFrom ? getPreset(map, copyFrom) : undefined;
  let id = slug(name);
  for (let i = 2; map.presets.some((p) => p.id === id); i++) id = `${slug(name)}-${i}`;
  const known = new Set(map.nodes.filter((n) => n.tier === "feature").map((n) => n.id));
  const preset: Preset = {
    id, name: name.trim() || id, color: PALETTE[map.presets.length % PALETTE.length],
    features: (features ?? base?.features ?? []).map((f) => (known.has(f) ? f : findNode(map, f).id)),
    detached: [...(base?.detached ?? [])], changedAt: {},
  };
  map.presets.push(preset);
  return preset;
}

export function deletePreset(map: ContextMap, id: string): void {
  if (map.presets.length < 2) throw new WeaveError("Keep at least one preset.");
  map.presets = map.presets.filter((p) => p.id !== id);
  if (map.settings.defaultPreset === id) map.settings.defaultPreset = map.presets[0].id;
  for (const [s, p] of Object.entries(map.assign)) if (p === id) delete map.assign[s];
}

/**
 * Starts a new feature from a design node. With `bring`, everything live in that
 * saved preset joins the new feature too, so its context window comes along.
 */
export function spinUp(map: ContextMap, presetId: string | undefined, designRef: string, name: string, bring?: string): WeaveNode {
  const design = findNode(map, designRef);
  const label = name.trim() || "New feature";
  let id = `custom:${slug(label)}`;
  for (let i = 2; map.nodes.some((n) => n.id === id); i++) id = `custom:${slug(label)}-${i}`;
  const node: WeaveNode = { id, label, tier: "feature", kind: "feature", paths: [], of: [], bytes: 0, tokens: 0, custom: true };
  map.custom.push(node);
  map.nodes.push(node);
  const join = (n: WeaveNode) => {
    if (n.tier !== "element" || n.of.includes(id)) return;
    n.of.push(id);
    const o = (map.overrides[n.id] ??= {});
    o.addOf = [...new Set([...(o.addOf ?? []), id])];
  };
  join(design);
  if (bring) {
    const src = getPreset(map, bring);
    map.nodes.filter((n) => n.tier === "element" && isLive(n, src)).forEach(join);
  }
  attach(map, presetId, id);
  return node;
}

export interface WindowSummary {
  preset: Preset;
  core: string[];
  attached: WeaveNode[];
  detached: WeaveNode[];
  tokens: number;
  total: number;
}

export function summarize(map: ContextMap, preset: Preset): WindowSummary {
  const live = map.nodes.filter((n) => n.tier !== "feature" && isLive(n, preset));
  return {
    preset,
    core: map.nodes.find((n) => n.tier === "core")?.paths ?? [],
    attached: map.nodes.filter((n) => n.tier === "feature" && isLive(n, preset)),
    detached: map.nodes.filter((n) => n.tier === "element" && n.kind !== "tool" && !isLive(n, preset) && n.of.some((f) => preset.features.includes(f))),
    tokens: live.reduce((s, n) => s + n.tokens, 0),
    total: map.nodes.reduce((s, n) => s + n.tokens, 0),
  };
}

const k = (v: number) => (v >= 1000 ? `${(v / 1000).toFixed(1)}k` : String(v));
const list = (items: string[], max: number) => (items.length > max ? `${items.slice(0, max).join(", ")} and ${items.length - max} more` : items.join(", "));

/**
 * The short note a thread gets when it starts: folder-level paths only, so it
 * stays around 100 to 200 tokens however large the project is.
 */
export function windowNote(map: ContextMap, preset: Preset): string {
  const w = summarize(map, preset);
  const folders = w.attached.map((f) => (f.paths[0] ?? f.label));
  const lines = [
    `WEAVE context window "${preset.name}" (~${k(w.tokens)} of ${k(w.total)} mapped tokens).`,
    `Core: ${list(w.core, 6) || "none"}.`,
    `Attached: ${list(folders, 12) || "nothing beyond the core"}.`,
  ];
  if (w.detached.length) lines.push(`Detached, skip unless asked: ${list(w.detached.flatMap((n) => n.paths), 10)}.`);
  lines.push("Work inside the attached folders first. The weave MCP tools can attach or detach nodes.");
  return lines.join("\n");
}
