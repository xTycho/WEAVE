export interface Placed {
  id: string;
  tier: "core" | "feature" | "element";
  of: string[];
  x: number;
  y: number;
  a?: number;
}

const GAP = 230;

/**
 * Features sit on an inner ring. Shared elements (more than one feature) and
 * tools sit on a middle ring between the features they serve; the rest fan out
 * on an outer ring, staggered so neighbours never overlap. Rings grow with the
 * number of nodes they hold.
 */
export function layout(nodes: Placed[]): void {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const feats = nodes.filter((n) => n.tier === "feature");
  const R2 = Math.max(290, (feats.length * GAP) / (2 * Math.PI));
  feats.forEach((f, i) => {
    f.a = -Math.PI / 2 + (i * 2 * Math.PI) / Math.max(feats.length, 1);
    f.x = Math.cos(f.a) * R2;
    f.y = Math.sin(f.a) * R2;
  });
  for (const c of nodes) if (c.tier === "core") { c.x = 0; c.y = 0; }

  const els = nodes.filter((n) => n.tier === "element");
  els.forEach((e, i) => {
    let sx = 0, sy = 0;
    for (const p of e.of) { const f = byId.get(p); if (f?.a !== undefined) { sx += Math.cos(f.a); sy += Math.sin(f.a); } }
    e.a = sx || sy ? Math.atan2(sy, sx) : (i / Math.max(els.length, 1)) * 2 * Math.PI;
  });
  const rings = [els.filter((e) => e.of.length !== 1), els.filter((e) => e.of.length === 1)];
  const r0 = Math.max(R2 + 230, (rings[0].length * GAP) / (2 * Math.PI));
  const r1 = Math.max(r0 + 260, (rings[1].length * GAP) / (2 * Math.PI) / 1.6);
  const R = [r0, r1];
  rings.forEach((ring, k) => {
    ring.sort((a, b) => a.a! - b.a!);
    // With a stagger the outer ring fits two rows, so neighbours may sit closer in angle.
    const gap = Math.min((GAP / R[k]) * (k === 1 ? 0.62 : 1), (2 * Math.PI) / Math.max(ring.length, 1));
    for (let it = 0; it < 400; it++) {
      let moved = false;
      for (let i = 0; i < ring.length; i++) {
        const a = ring[i], b = ring[(i + 1) % ring.length];
        if (a === b) break;
        let d = b.a! - a.a!;
        if (i === ring.length - 1) d += 2 * Math.PI;
        if (d < gap - 1e-6) { const m = (gap - d) / 2; a.a! -= m; b.a! += m; moved = true; }
      }
      if (!moved) break;
    }
    ring.forEach((e, i) => {
      const r = R[k] + (k === 1 && i % 2 ? 110 : 0);
      e.x = Math.cos(e.a!) * r;
      e.y = Math.sin(e.a!) * r;
    });
  });
}

/** Convex hull (monotone chain), used for the soft area behind attached nodes. */
export function hull(points: [number, number][]): [number, number][] {
  const P = points.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cr = (o: number[], a: number[], b: number[]) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lo: [number, number][] = [], up: [number, number][] = [];
  for (const p of P) { while (lo.length > 1 && cr(lo[lo.length - 2], lo[lo.length - 1], p) <= 0) lo.pop(); lo.push(p); }
  for (const p of P.slice().reverse()) { while (up.length > 1 && cr(up[up.length - 2], up[up.length - 1], p) <= 0) up.pop(); up.push(p); }
  return lo.slice(0, -1).concat(up.slice(0, -1));
}

export function curve(a: Placed, b: Placed): string {
  const dx = b.x - a.x, dy = b.y - a.y, dist = Math.hypot(dx, dy);
  const ra = a.tier === "core" ? Math.atan2(dy, dx) : Math.atan2(a.y, a.x), rb = Math.atan2(b.y, b.x);
  const k = dist * 0.38;
  return `M${a.x},${a.y} C${a.x + Math.cos(ra) * k},${a.y + Math.sin(ra) * k} ${b.x - Math.cos(rb) * k},${b.y - Math.sin(rb) * k} ${b.x},${b.y}`;
}
