import type { WeaveNode } from "./types";

export const RING_RADIUS = { core: 0, feature: 240, context: 440 } as const;

/**
 * Concentric layout: core at the centre, features on the middle ring,
 * outer context fanned out around the angle of its parent feature.
 */
export function concentricLayout(nodes: WeaveNode[]): Map<string, { x: number; y: number }> {
  const pos = new Map<string, { x: number; y: number }>();
  const features = nodes.filter((n) => n.tier === "feature");
  const contexts = nodes.filter((n) => n.tier === "context");
  const angleOf = new Map<string, number>();

  nodes.filter((n) => n.tier === "core").forEach((n, i) => pos.set(n.id, { x: i * 40, y: 0 }));

  const step = (2 * Math.PI) / Math.max(features.length, 1);
  features.forEach((f, i) => {
    const a = -Math.PI / 2 + i * step;
    angleOf.set(f.id, a);
    pos.set(f.id, { x: Math.cos(a) * RING_RADIUS.feature, y: Math.sin(a) * RING_RADIUS.feature });
  });

  const groups = new Map<string, WeaveNode[]>();
  for (const c of contexts) {
    const parent = c.links.find((l) => angleOf.has(l)) ?? "__orphan";
    groups.set(parent, [...(groups.get(parent) ?? []), c]);
  }
  let orphanAngle = 0;
  for (const [parent, group] of groups) {
    const base = angleOf.get(parent) ?? (orphanAngle += 0.6);
    const spread = Math.min(step * 0.8, 0.35 * group.length);
    group.forEach((c, i) => {
      const a = group.length === 1 ? base : base - spread / 2 + (spread * i) / (group.length - 1);
      pos.set(c.id, { x: Math.cos(a) * RING_RADIUS.context, y: Math.sin(a) * RING_RADIUS.context });
    });
  }
  return pos;
}
