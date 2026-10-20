import type { ActivityEvent, ContextMap, Preset, WeaveNode } from "../types.js";
import { createPreset, isLive, nodeIndex, WeaveError } from "./window.js";

/**
 * Warm and cold context. Nothing is detached or blocked: every attached file
 * stays open to Claude. Use only decides which files a thread is pointed at
 * first, so it spends its reads where the work actually happens.
 *
 * A file's heat is its reads plus twice its edits, each halved for every
 * HALF_LIFE that has passed. Warm files have at least WARM_AT heat (one read
 * in the last day or so); the WARM_MAX hottest are listed. Every other
 * attached file is cold. The HOT_MAX hottest with at least HOT_AT heat are
 * hot, which the map shows with embers.
 *
 * Plain arithmetic over the activity log: no model is involved, so the same
 * activity always gives the same result.
 */
export const HALF_LIFE = 3 * 864e5;
export const WARM_AT = 0.75;
export const WARM_MAX = 12;
export const HOT_AT = 10;
export const HOT_MAX = 3;

export function heat(events: ActivityEvent[], now = Date.now()): Map<string, number> {
  const out = new Map<string, number>();
  for (const e of events) {
    if (e.ph !== "end" || e.blocked || (e.verb !== "Read" && e.verb !== "Edit")) continue;
    const w = (e.verb === "Edit" ? 2 : 1) * 0.5 ** (Math.max(0, now - e.t) / HALF_LIFE);
    out.set(e.node, (out.get(e.node) ?? 0) + w);
  }
  return out;
}

export interface Warmth {
  /** Hottest first. */
  warm: WeaveNode[];
  /** The top of `warm` that is used far more than the rest. */
  hot: WeaveNode[];
  cold: WeaveNode[];
  warmTokens: number;
}

/** Splits a preset's attached files into warm and cold. Empty when the switch is off. */
export function warmth(map: ContextMap, preset: Preset, events: ActivityEvent[], now = Date.now()): Warmth {
  return map.settings.warmCold ? rank(map, preset, events, now) : { warm: [], hot: [], cold: [], warmTokens: 0 };
}

function rank(map: ContextMap, preset: Preset, events: ActivityEvent[], now: number): Warmth {
  const none: Warmth = { warm: [], hot: [], cold: [], warmTokens: 0 };
  const h = heat(events, now);
  const files = map.nodes.filter((n) => n.tier === "element" && n.kind !== "tool" && isLive(n, preset));
  const warm = files.filter((n) => (h.get(n.id) ?? 0) >= WARM_AT).sort((a, b) => h.get(b.id)! - h.get(a.id)! || a.id.localeCompare(b.id)).slice(0, WARM_MAX);
  if (!warm.length) return none;
  const ids = new Set(warm.map((n) => n.id));
  return {
    warm,
    hot: warm.slice(0, HOT_MAX).filter((n) => h.get(n.id)! >= HOT_AT),
    cold: files.filter((n) => !ids.has(n.id)),
    warmTokens: warm.reduce((s, n) => s + n.tokens, 0),
  };
}

export const OVERDUE_DAYS = 14;

/**
 * Overdue: attached files nobody has read or edited in OVERDUE_DAYS, and that
 * were not attached in that time either. Empty until the activity log reaches
 * back that far, so a fresh install or a short log never flags anything.
 */
export function overdue(map: ContextMap, preset: Preset, events: ActivityEvent[], now = Date.now()): WeaveNode[] {
  const cutoff = now - OVERDUE_DAYS * 864e5;
  if (!events.length || events[0].t > cutoff) return [];
  const last = new Map<string, number>();
  for (const e of events) if (e.ph === "end" && !e.blocked && (e.verb === "Read" || e.verb === "Edit")) last.set(e.node, Math.max(e.t, last.get(e.node) ?? 0));
  return map.nodes.filter((n) => n.tier === "element" && n.kind !== "tool" && n.tokens > 0 && isLive(n, preset)
    && (last.get(n.id) ?? 0) < cutoff && (preset.changedAt[n.id] ?? 0) < cutoff);
}

const UI_PATH = /(^|\/)(ui|components?|styles?|css|views?|pages?|layouts?|themes?)\//i;

/**
 * A name for a set of files, by fixed rules: more than half design or UI
 * files is "UI", docs "Docs", tests "Tests"; otherwise the feature most of
 * them belong to.
 */
export function tagFor(map: ContextMap, files: WeaveNode[]): string {
  if (!files.length) return "Preset";
  const most = (test: (n: WeaveNode) => boolean) => files.filter(test).length * 2 > files.length;
  if (most((n) => n.kind === "design" || n.paths.some((p) => UI_PATH.test(p)))) return "UI";
  if (most((n) => n.kind === "doc")) return "Docs";
  if (most((n) => n.kind === "test")) return "Tests";
  const counts = new Map<string, number>();
  for (const n of files) { const f = n.of[0]; if (f) counts.set(f, (counts.get(f) ?? 0) + 1); }
  const top = [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0];
  const label = (top && nodeIndex(map).get(top)?.label) || "Preset";
  return label.charAt(0).toUpperCase() + label.slice(1);
}

/** Names for saved presets, handed out in this order: the first one no preset uses yet. */
export const CRYSTALS = [
  "Amethyst", "Quartz", "Obsidian", "Opal", "Onyx", "Jade", "Topaz", "Garnet", "Citrine", "Sapphire",
  "Emerald", "Ruby", "Moonstone", "Labradorite", "Malachite", "Lapis", "Peridot", "Aquamarine", "Tourmaline", "Fluorite",
  "Selenite", "Celestite", "Azurite", "Morganite", "Tanzanite",
];

/** The first crystal name no preset has taken; past all 25, the list starts again with a number. */
export function crystalName(map: ContextMap): string {
  const taken = new Set(map.presets.map((p) => p.name.split(" · ")[0]));
  for (let round = 1; ; round++) {
    const hit = CRYSTALS.map((c) => (round === 1 ? c : `${c} ${round}`)).find((c) => !taken.has(c));
    if (hit) return hit;
  }
}

/**
 * Saves files as a preset: the features that hold them, with every other file
 * in those features detached. Named "<crystal> · <tag>", with the tag from
 * `tagFor`, so the name is memorable and still says what is inside.
 */
export function presetFromFiles(map: ContextMap, files: WeaveNode[], auto = false): Preset {
  const keep = new Set(files.map((n) => n.id));
  const features = [...new Set(files.map((n) => n.of[0]).filter((f): f is string => !!f))];
  const tag = tagFor(map, files);
  // An auto save refreshes its own earlier preset with the same tag, so presets do not pile up.
  const old = auto ? map.presets.find((p) => p.auto && p.tag === tag) : undefined;
  const preset = old ? Object.assign(old, { features, detached: [], changedAt: {} }) : createPreset(map, `${crystalName(map)} · ${tag}`, features);
  preset.tag = tag;
  if (auto) preset.auto = true;
  preset.detached = map.nodes.filter((n) => n.tier === "element" && n.kind !== "tool" && !keep.has(n.id) && isLive(n, preset)).map((n) => n.id);
  return preset;
}

/** Saves the current heat as a preset of the warm files. Works whether or not the warm and cold switch is on. */
export function presetFromHeat(map: ContextMap, base: Preset, events: ActivityEvent[], now = Date.now()): Preset {
  const { warm } = rank(map, base, events, now);
  if (!warm.length) throw new WeaveError("Nothing is warm yet. Work in the project for a while, then save its heat as a preset.");
  return presetFromFiles(map, warm);
}
