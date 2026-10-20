import "./styles.css";
import { MODE_DRAWS, resolvePreset } from "thinking-orbs/engine";
import { curve, hull, layout, type Placed } from "./layout";

// ---------- Types shared with the server ----------
type Tier = "core" | "feature" | "element";
type Kind = "core" | "feature" | "code" | "design" | "doc" | "test" | "tool";
type Verb = "Read" | "Edit" | "Run" | "PR";
interface WNode { id: string; label: string; tier: Tier; kind: Kind; paths: string[]; of: string[]; bytes: number; tokens: number; exact?: boolean; custom?: boolean; command?: string }
interface Preset { id: string; name: string; color: string; features: string[]; detached: string[] }
interface Thread { id: string; name: string; preset: string; lastSeen: number; contextTokens?: number }
interface Suggestion { rule: string; node: string; attach: boolean; text: string; key: string }
interface Settings { autoApply: boolean; gate: "flag" | "block"; idleAfter: number; defaultPreset: string }
interface State {
  project: string;
  map: { nodes: WNode[]; presets: Preset[]; assign: Record<string, string>; settings: Settings };
  threads: Thread[];
  suggestions: Record<string, Suggestion[]>;
  tokens: { mode: "exact" | "estimate"; source?: string; counting?: { done: number; total: number }; error?: string };
}
interface Activity { t: number; s: string; ph: "start" | "end"; verb: Verb; node: string; path?: string; outside?: boolean; blocked?: boolean; id?: string }
type Node = WNode & Placed;

const KIND: Record<Kind, { tag: string; c: string }> = {
  core: { tag: "Core", c: "var(--foil)" },
  feature: { tag: "Feature", c: "var(--p-violet)" },
  code: { tag: "Code", c: "var(--p-blue)" },
  design: { tag: "Design", c: "var(--p-pink)" },
  doc: { tag: "Doc", c: "var(--p-lime)" },
  test: { tag: "Test", c: "var(--p-peach)" },
  tool: { tag: "Tool", c: "var(--p-rose)" },
};
const COLOR: Record<string, string> = { Read: "#A3A9E6", Edit: "#E9A6D2", Run: "#F6BE8A", PR: "#CFE19C", Attach: "#8E95DB", Detach: "#B4B6BA", Blocked: "#F1A9B0" };
const VERB_ING: Record<Verb, string> = { Read: "Reading", Edit: "Editing", Run: "Running", PR: "Opening PR" };
const ORB: Record<Verb, string> = { Read: "searching", Edit: "composing", Run: "working", PR: "weaving" };
const NOTES: Record<string, string> = {
  calm: "One small dot per action, no labels. The quietest option.",
  pulse: "Reads flow in, sized by their tokens; edits flow out; runs go out and back; a PR gathers every edited file. The tag on a node expands in the colour of the preset doing the work and shows what Claude is doing and for how long.",
  neural: "Same meaning as Pulse, plus a long trail, cords that stay lit, a double ripple and faint signals to neighbouring files.",
};

// ---------- Small helpers ----------
const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const NS = "http://www.w3.org/2000/svg";
const esc = (s: unknown) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const fmt = (v: number) => (v >= 1000 ? (v / 1000).toFixed(1) + "k" : String(v));
const store = {
  get(k: string) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k: string, v: string) { try { localStorage.setItem(k, v); } catch { /* private mode */ } },
};
async function api(path: string, body: unknown = {}) {
  const res = await fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json.ok === false) throw new Error(json.error ?? `Request failed (${res.status})`);
  return json.result;
}
function toast(msg: string) { log("Blocked", null, msg); }

// ---------- State ----------
let S: State | undefined;
let N: Node[] = [];
let byId = new Map<string, Node>();
let shape = "";
let P = store.get("weave.preset") ?? "";
let selected: string | null = null;
let hits = new Set<string>();
const els: Record<string, HTMLDivElement> = {};
const cords: Record<string, SVGPathElement> = {};
const world = $("world"), stage = $("stage");
const gC = $("cords") as unknown as SVGGElement, gH = $("hulls") as unknown as SVGGElement, gPulse = $("pulses") as unknown as SVGGElement;
const posKey = () => `weave.pos.${S?.project ?? ""}`;
let pinned: Record<string, [number, number]> = {};

const preset = (): Preset => S!.map.presets.find((p) => p.id === P) ?? S!.map.presets.find((p) => p.id === S!.map.settings.defaultPreset) ?? S!.map.presets[0];
const liveIn = (pr: Preset, n: WNode) => n.tier === "core" || (n.tier === "feature" ? pr.features.includes(n.id) : !pr.detached.includes(n.id) && (n.of.length === 0 || n.of.some((f) => pr.features.includes(f))));
const isLive = (n: WNode) => liveIn(preset(), n);
const featTokens = (f: WNode) => N.filter((e) => e.tier === "element" && e.of[0] === f.id).reduce((s, e) => s + e.tokens, 0);
const threadPreset = (session: string) => {
  const id = S?.map.assign[session] ?? S?.map.settings.defaultPreset;
  return S?.map.presets.find((p) => p.id === id) ?? S?.map.presets[0];
};

// ---------- Build and draw ----------
const ACT = '<span class="act" aria-live="polite"><canvas width="32" height="32" aria-hidden="true"></canvas><span class="lbl"></span><span class="sec"></span></span>';

function metaPath(n: WNode) {
  if (n.kind === "tool") return n.command ?? "";
  if (n.tier === "feature") return n.custom ? "New feature" : n.paths[0] ?? "project root";
  return n.paths.join(" · ") || "no files";
}

function buildNodes() {
  world.querySelectorAll(".node,.empty-map").forEach((n) => n.remove());
  for (const k of Object.keys(els)) delete els[k];
  for (const n of N) {
    const d = document.createElement("div");
    d.className = "node " + n.tier;
    d.tabIndex = 0;
    d.dataset.id = n.id;
    const k = KIND[n.kind];
    d.style.setProperty("--dotc", n.tier === "core" ? "var(--fg)" : k.c);
    const tok = n.tier === "feature" ? featTokens(n) : n.tokens;
    d.innerHTML = n.tier === "core"
      ? `<div class="top"><span class="cap">Core context</span><span class="sets"></span></div><div class="name">${esc(n.label)}</div><div class="meta"><span>${esc(n.paths.join(" · ") || "No root files yet")}</span><span class="end">${tok ? "~" + fmt(tok) : ""}<span class="tag">Core</span></span></div>`
      : `<div class="top">${ACT}<span class="sets"></span></div><div class="name">${esc(n.label)}</div><div class="meta"><span title="${esc(metaPath(n))}">${esc(metaPath(n))}</span><span class="end">${tok ? "~" + fmt(tok) : ""}<span class="tag" style="background:${k.c}">${k.tag}</span></span></div>`;
    world.appendChild(d);
    els[n.id] = d;
    bindNode(d, n);
  }
}

function edges(): [string, string][] {
  const E: [string, string][] = [];
  for (const n of N) {
    if (n.tier === "feature") E.push(["core", n.id]);
    if (n.tier === "element") (n.of.length ? n.of.filter((p) => byId.has(p)) : ["core"]).forEach((p) => E.push([p, n.id]));
  }
  return E;
}

function draw() {
  if (!S) return;
  gC.innerHTML = "";
  for (const k of Object.keys(cords)) delete cords[k];
  for (const [p, c] of edges()) {
    const a = byId.get(p), b = byId.get(c);
    if (!a || !b) continue;
    const live = isLive(a) && isLive(b);
    const hit = document.createElementNS(NS, "path");
    hit.setAttribute("d", curve(a, b));
    hit.setAttribute("class", "hit");
    hit.addEventListener("click", (e) => { e.stopPropagation(); toggle(c); });
    const path = document.createElementNS(NS, "path");
    path.setAttribute("d", curve(a, b));
    path.setAttribute("class", "cord " + (live ? "live" : "off"));
    gC.append(hit, path);
    cords[p + ">" + c] = path;
  }
  for (const n of N) {
    const d = els[n.id];
    if (!d) continue;
    const live = isLive(n);
    d.style.left = n.x + "px";
    d.style.top = n.y + "px";
    d.classList.toggle("live", live);
    d.classList.toggle("off", !live);
    d.classList.toggle("sel", selected === n.id);
    d.classList.toggle("match", hits.has(n.id));
    setsFor(n, d);
  }
  drawHull();
  meter();
}

/** One small box per preset that uses this node; the selected preset's box is outlined. */
function setsFor(n: WNode, d: HTMLElement) {
  const using = S!.map.presets.filter((p) => liveIn(p, n));
  const html = using.map((p) => `<i class="${p.id === preset().id ? "cur" : ""}" style="--c:${esc(p.color)}"></i>`).join("");
  const box = d.querySelector<HTMLElement>(".sets")!;
  if (box.dataset.h !== html) { box.innerHTML = html; box.dataset.h = html; box.title = using.map((p) => p.name).join(", "); }
}

function drawHull() {
  gH.innerHTML = "";
  const pts: [number, number][] = [[-120, -50], [120, -50], [-120, 50], [120, 50]];
  for (const n of N) {
    if (n.tier === "core" || !isLive(n)) continue;
    const w = n.tier === "feature" ? 104 : 94;
    pts.push([n.x - w, n.y - 36], [n.x + w, n.y - 36], [n.x - w, n.y + 36], [n.x + w, n.y + 36]);
  }
  const h = hull(pts);
  if (h.length < 3) return;
  const a = document.createElementNS(NS, "path");
  a.setAttribute("d", "M" + h.map((p) => p.join(",")).join("L") + "Z");
  a.setAttribute("class", "hull");
  gH.append(a);
}

function meter() {
  const live = N.filter((n) => n.tier !== "feature" && isLive(n)).reduce((s, n) => s + n.tokens, 0);
  const all = N.reduce((s, n) => s + n.tokens, 0) || 1;
  const exact = S!.tokens.mode === "exact" && N.every((n) => n.tier === "feature" || n.kind === "tool" || n.exact);
  $("tok").textContent = `~${fmt(live)} of ${fmt(all)} tokens`;
  $("tokmode").textContent = exact ? "Exact" : "Estimated";
  $("fill").style.width = (live / all) * 100 + "%";
}

// ---------- Interaction ----------
async function toggle(id: string) {
  const n = byId.get(id);
  if (!n || n.tier === "core") return;
  const was = isLive(n);
  try {
    await api("/api/toggle", { preset: preset().id, node: id });
    log(was ? "Detach" : "Attach", id, "you");
  } catch (e) { toast((e as Error).message); }
}

function bindNode(d: HTMLDivElement, n: Node) {
  d.addEventListener("pointerdown", (e) => {
    if ((e.target as HTMLElement).closest("button,input,select")) return;
    e.stopPropagation();
    const sx = e.clientX, sy = e.clientY, ox = n.x, oy = n.y;
    let moved = false;
    d.setPointerCapture(e.pointerId);
    const mv = (ev: PointerEvent) => {
      const dx = (ev.clientX - sx) / view.s, dy = (ev.clientY - sy) / view.s;
      if (Math.abs(dx) + Math.abs(dy) > 3) moved = true;
      if (!moved) return;
      n.x = ox + dx; n.y = oy + dy;
      draw();
    };
    const up = () => {
      d.removeEventListener("pointermove", mv);
      d.removeEventListener("pointerup", up);
      if (moved) { pinned[n.id] = [n.x, n.y]; store.set(posKey(), JSON.stringify(pinned)); }
      else { selected = n.id; draw(); inspect(); }
    };
    d.addEventListener("pointermove", mv);
    d.addEventListener("pointerup", up);
  });
  d.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); selected = n.id; draw(); inspect(); } });
}

function inspect() {
  const box = $("insp");
  const n = selected ? byId.get(selected) : undefined;
  if (!n || !S) {
    box.innerHTML = `<h2 class="cap">Node</h2><p class="empty">Select a node to see what it holds and what it costs. Design nodes can start a new feature.</p>`;
    return;
  }
  const live = isLive(n);
  const parents = n.of.map((p) => byId.get(p)?.label ?? p).join(", ");
  const kids = n.tier === "feature" ? N.filter((e) => e.of.includes(n.id)).length : 0;
  const tok = n.tier === "feature" ? featTokens(n) : n.tokens;
  const others = S.map.presets.filter((p) => p.id !== preset().id);
  box.innerHTML = `<h2 class="cap">${KIND[n.kind].tag} node</h2>
    <dl><dt>Name</dt><dd>${esc(n.label)}</dd><dt>Path</dt><dd>${esc(metaPath(n))}</dd>
    ${tok ? `<dt>Tokens</dt><dd>~${fmt(tok)}${n.exact ? " (exact)" : " (estimate)"}</dd>` : ""}
    ${parents ? `<dt>Used by</dt><dd>${esc(parents)}</dd>` : ""}${kids ? `<dt>Elements</dt><dd>${kids}</dd>` : ""}
    <dt>State</dt><dd>${live ? "In this context window" : "Detached"}</dd></dl>
    <div class="actions">${n.tier !== "core" ? `<button class="btn" id="tg">${live ? "Detach" : "Reattach"}</button>` : ""}<button class="btn" id="rn">Rename</button></div>
    ${n.kind === "design" ? `<span class="cap">New feature from this design</span>
      <input id="spinName" placeholder="Feature name" aria-label="Feature name">
      <label class="cap" for="bring">Bring a saved context window</label>
      <select id="bring"><option value="">None</option>${others.map((p) => `<option value="${esc(p.id)}">${esc(p.name)}</option>`).join("")}</select>
      <div class="actions"><button class="btn fill" id="spin">New feature from this</button></div>` : ""}`;
  box.querySelector("#tg")?.addEventListener("click", () => toggle(n.id));
  box.querySelector("#rn")?.addEventListener("click", async () => {
    const label = prompt("New name for this node", n.label);
    if (label?.trim()) await api("/api/rename", { node: n.id, label }).catch((e) => toast(e.message));
  });
  box.querySelector("#spin")?.addEventListener("click", async () => {
    const name = (box.querySelector("#spinName") as HTMLInputElement).value.trim() || "New feature";
    const bring = (box.querySelector("#bring") as HTMLSelectElement).value;
    try {
      const f = await api("/api/spin", { preset: preset().id, design: n.id, name, bring });
      selected = f.id;
      log("Attach", null, `you · started ${name}`);
    } catch (e) { toast((e as Error).message); }
  });
}

// ---------- Pan and zoom ----------
const view = { x: 0, y: 0, s: 0.6 };
function applyView() {
  world.style.transform = `translate(${view.x}px,${view.y}px) scale(${view.s})`;
  world.classList.toggle("dots", view.s < 0.5);
  world.style.setProperty("--inv", String(Math.min(1.8, 1 / view.s)));
}
function fit() {
  if (!N.length) return;
  const xs = N.map((n) => n.x), ys = N.map((n) => n.y), r = stage.getBoundingClientRect();
  const w = Math.max(...xs) - Math.min(...xs) + 320, h = Math.max(...ys) - Math.min(...ys) + 240;
  const left = r.width > 900 && !$("presets").classList.contains("closed") ? 320 : 0, W = r.width - left;
  view.s = Math.min(W / w, r.height / h, 1.1);
  view.x = left + W / 2 - ((Math.max(...xs) + Math.min(...xs)) / 2) * view.s;
  view.y = r.height / 2 + 24 - ((Math.max(...ys) + Math.min(...ys)) / 2) * view.s;
  applyView();
}
function zoomAt(f: number, cx: number, cy: number) {
  const ns = Math.min(2, Math.max(0.08, view.s * f));
  view.x = cx - ((cx - view.x) * ns) / view.s;
  view.y = cy - ((cy - view.y) * ns) / view.s;
  view.s = ns;
  applyView();
}
stage.addEventListener("wheel", (e) => { e.preventDefault(); const r = stage.getBoundingClientRect(); zoomAt(Math.exp(-e.deltaY * 0.0015), e.clientX - r.left, e.clientY - r.top); }, { passive: false });
stage.addEventListener("pointerdown", (e) => {
  const t = e.target as Element;
  if (t.closest("button,input,select,.presets,.zoom") || t.classList.contains("hit")) return;
  const sx = e.clientX - view.x, sy = e.clientY - view.y;
  stage.classList.add("panning");
  stage.setPointerCapture(e.pointerId);
  const mv = (ev: PointerEvent) => { view.x = ev.clientX - sx; view.y = ev.clientY - sy; applyView(); };
  const up = () => { stage.classList.remove("panning"); stage.removeEventListener("pointermove", mv); stage.removeEventListener("pointerup", up); };
  stage.addEventListener("pointermove", mv);
  stage.addEventListener("pointerup", up);
});
const center = (): [number, number] => { const r = stage.getBoundingClientRect(); return [r.width / 2, r.height / 2]; };
$("zin").onclick = () => zoomAt(1.25, ...center());
$("zout").onclick = () => zoomAt(0.8, ...center());
$("zfit").onclick = fit;

// ---------- Presets box ----------
const MINUS = '<svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round"><path d="M2 6h8"/></svg>';
const PLUS = '<svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round"><path d="M2 6h8M6 2v8"/></svg>';
$("pmin").innerHTML = MINUS;
$("pmin").onclick = (e) => {
  const closed = $("presets").classList.toggle("closed");
  const b = e.currentTarget as HTMLElement;
  b.setAttribute("aria-expanded", String(!closed));
  b.innerHTML = closed ? PLUS : MINUS;
};
$("pq").addEventListener("input", renderPresets);
const working = (session: string) => [...active.values()].some((a) => a.session === session) || Date.now() - (S?.threads.find((t) => t.id === session)?.lastSeen ?? 0) < 60_000;
const tokOf = (p: Preset) => N.filter((n) => n.tier !== "feature" && liveIn(p, n)).reduce((s, n) => s + n.tokens, 0);
let editing: "new" | "rename" | null = null;

function renderPresets() {
  if (!S) return;
  const q = ($("pq") as HTMLInputElement).value.trim().toLowerCase();
  const box = $("plist");
  box.innerHTML = "";
  const list = S.map.presets.filter((p) => !q || p.name.toLowerCase().includes(q) || S!.threads.some((t) => t.preset === p.id && t.name.toLowerCase().includes(q)) || p.features.some((f) => byId.get(f)?.label.toLowerCase().includes(q)));
  if (!list.length) box.innerHTML = '<li class="note" style="padding:8px">No preset matches.</li>';
  for (const p of list) {
    const li = document.createElement("li"), b = document.createElement("button");
    b.setAttribute("aria-pressed", String(p.id === preset().id));
    const users = S.threads.filter((t) => t.preset === p.id);
    const chips = users.length
      ? users.slice(0, 6).map((t) => `<span class="${working(t.id) ? "live" : ""}" style="--c:${esc(p.color)}" title="${working(t.id) ? "Working now" : "Idle"}"><i></i>${esc(t.name)}</span>`).join("")
      : '<span class="none">No threads</span>';
    const feats = p.features.map((f) => byId.get(f)?.label ?? f);
    b.innerHTML = `<span class="dot" style="background:${esc(p.color)}"></span><span><b>${esc(p.name)}${p.id === S.map.settings.defaultPreset ? '<span class="def">Default</span>' : ""}</b><small>${esc(feats.slice(0, 6).join(" · "))}${feats.length > 6 ? ` · +${feats.length - 6}` : ""}</small><span class="threads" aria-label="Threads using this preset">${chips}</span></span><em>~${fmt(tokOf(p))}</em>`;
    b.onclick = () => { P = p.id; store.set("weave.preset", P); selected = null; editing = null; renderAll(); };
    li.appendChild(b);
    box.appendChild(li);
  }
  renderPresetActions();
}

function renderPresetActions() {
  const row = $("pactions"), p = preset();
  if (editing) {
    row.innerHTML = `<input id="pname" value="${editing === "rename" ? esc(p.name) : ""}" placeholder="${editing === "new" ? "Name for a copy of this preset" : "Preset name"}" aria-label="Preset name"><button class="btn fill" id="psave">Save</button><button class="btn" id="pcancel">Cancel</button>`;
    const input = row.querySelector<HTMLInputElement>("#pname")!;
    input.focus();
    const save = async () => {
      const name = input.value.trim();
      if (!name) return;
      try {
        if (editing === "new") { const np = await api("/api/presets/create", { name, copyFrom: p.id }); P = np.id; store.set("weave.preset", P); }
        else await api("/api/presets/rename", { id: p.id, name });
        editing = null;
      } catch (e) { toast((e as Error).message); }
    };
    row.querySelector("#psave")!.addEventListener("click", save);
    input.addEventListener("keydown", (e) => { if (e.key === "Enter") save(); if (e.key === "Escape") { editing = null; renderPresetActions(); } });
    row.querySelector("#pcancel")!.addEventListener("click", () => { editing = null; renderPresetActions(); });
    return;
  }
  const isDefault = p.id === S!.map.settings.defaultPreset;
  row.innerHTML = `<button class="btn" id="pnew">New</button><button class="btn" id="pren">Rename</button>${isDefault ? "" : '<button class="btn" id="pdef">Make default</button>'}${S!.map.presets.length > 1 ? '<button class="btn" id="pdel">Delete</button>' : ""}`;
  row.querySelector("#pnew")!.addEventListener("click", () => { editing = "new"; renderPresetActions(); });
  row.querySelector("#pren")!.addEventListener("click", () => { editing = "rename"; renderPresetActions(); });
  row.querySelector("#pdef")?.addEventListener("click", () => api("/api/presets/default", { id: p.id }).catch((e) => toast(e.message)));
  row.querySelector("#pdel")?.addEventListener("click", () => {
    if (confirm(`Delete the preset "${p.name}"? Threads on it move to the default preset.`)) api("/api/presets/delete", { id: p.id }).catch((e) => toast(e.message));
  });
}

// ---------- Threads ----------
function renderThreads() {
  if (!S) return;
  const box = $("threads");
  if (!S.threads.length) { box.innerHTML = '<li class="empty" style="display:block">No threads yet. Threads appear here once Claude Code runs in this project with the WEAVE hooks.</li>'; return; }
  box.innerHTML = "";
  for (const t of S.threads) {
    const p = S.map.presets.find((x) => x.id === t.preset);
    const li = document.createElement("li");
    li.className = working(t.id) ? "live" : "";
    li.style.setProperty("--c", p?.color ?? "var(--line-2)");
    li.innerHTML = `<i></i><b title="${esc(t.name)}">${esc(t.name)}</b><span class="sub">${t.contextTokens ? `${fmt(t.contextTokens)} in context` : "No usage yet"}<select aria-label="Preset for ${esc(t.name)}">${S.map.presets.map((x) => `<option value="${esc(x.id)}" ${x.id === t.preset ? "selected" : ""}>${esc(x.name)}</option>`).join("")}</select></span>`;
    li.querySelector("select")!.addEventListener("change", (e) => api("/api/assign", { thread: t.id, preset: (e.target as HTMLSelectElement).value }).catch((err) => toast(err.message)));
    box.appendChild(li);
  }
}

// ---------- Search ----------
const qEl = $<HTMLInputElement>("q"), resEl = $("results");
let cursor = 0;
function search() {
  const q = qEl.value.trim().toLowerCase();
  hits = new Set();
  if (q) for (const n of N) {
    const hay = [n.label, n.paths.join(" "), n.command, KIND[n.kind].tag, ...n.of.map((f) => byId.get(f)?.label)].join(" ").toLowerCase();
    if (hay.includes(q)) hits.add(n.id);
  }
  world.classList.toggle("searching", !!q);
  const list = N.filter((n) => hits.has(n.id)).slice(0, 7);
  cursor = 0;
  resEl.hidden = !q;
  resEl.innerHTML = list.length ? "" : "<li>No node matches</li>";
  list.forEach((n, i) => {
    const li = document.createElement("li");
    li.setAttribute("role", "option");
    li.setAttribute("aria-selected", String(i === 0));
    li.dataset.id = n.id;
    li.innerHTML = `<span class="tag" style="background:${KIND[n.kind].c}">${KIND[n.kind].tag}</span><span>${esc(n.label)}</span><span>${esc(metaPath(n))}</span>`;
    li.onmousedown = (e) => { e.preventDefault(); focusNode(n.id); };
    resEl.appendChild(li);
  });
  draw();
}
function focusNode(id: string) {
  const n = byId.get(id);
  if (!n) return;
  const r = stage.getBoundingClientRect();
  view.s = Math.max(view.s, 0.8);
  view.x = r.width / 2 - n.x * view.s;
  view.y = r.height / 2 - n.y * view.s;
  applyView();
  selected = id;
  resEl.hidden = true;
  draw();
  inspect();
}
qEl.addEventListener("input", search);
qEl.addEventListener("keydown", (e) => {
  const items = [...resEl.querySelectorAll<HTMLElement>("li[data-id]")];
  if (e.key === "ArrowDown" || e.key === "ArrowUp") {
    e.preventDefault();
    cursor = (cursor + (e.key === "ArrowDown" ? 1 : -1) + items.length) % Math.max(items.length, 1);
    items.forEach((li, i) => li.setAttribute("aria-selected", String(i === cursor)));
  }
  if (e.key === "Enter" && items[cursor]) focusNode(items[cursor].dataset.id!);
  if (e.key === "Escape") { qEl.value = ""; search(); }
});
qEl.addEventListener("blur", () => setTimeout(() => (resEl.hidden = true), 100));
qEl.addEventListener("focus", () => { if (qEl.value) resEl.hidden = false; });

// ---------- Suggestions (fixed rules, computed by the server) ----------
function renderSuggestions() {
  if (!S) return;
  const list = S.suggestions[preset().id] ?? [];
  const p = $("suggestPanel");
  p.innerHTML = `<h2 class="cap">Suggestions <span style="opacity:.7">· fixed rules, no AI</span></h2>` + (list.length ? "" : `<p class="empty">Nothing to change yet. Rules watch for files Claude asks for while they are detached, files linked to what was edited, and files nobody has used for ${S.map.settings.idleAfter} actions.</p>`);
  for (const r of list) {
    const n = byId.get(r.node);
    if (!n) continue;
    const card = document.createElement("div");
    card.className = "suggest";
    card.innerHTML = `<span class="cap">Rule · ${esc(r.rule)}</span><p>${esc(r.text)}</p><p class="cap" style="letter-spacing:.08em">${n.tokens ? `${r.attach ? "Attach" : "Detach"} it: ${r.attach ? "adds" : "saves"} about ${fmt(n.tokens)} tokens.` : "Tools cost almost no tokens."}</p><div class="row"><button class="btn fill">${r.attach ? "Attach" : "Detach"}</button><button class="btn">Dismiss</button></div>`;
    const [ok, no] = card.querySelectorAll("button");
    ok.onclick = () => api("/api/suggestion", { preset: preset().id, key: r.key, node: r.node, attach: r.attach, action: "apply" }).then(() => log(r.attach ? "Attach" : "Detach", r.node, "rule")).catch((e) => toast(e.message));
    no.onclick = () => api("/api/suggestion", { preset: preset().id, key: r.key, action: "dismiss" }).catch((e) => toast(e.message));
    p.appendChild(card);
  }
}

// ---------- Settings ----------
function seg(id: string, value: string, onPick: (v: string) => void) {
  document.querySelectorAll<HTMLButtonElement>(`#${id} button`).forEach((b) => {
    b.setAttribute("aria-pressed", String(b.dataset.v === value));
    b.onclick = () => onPick(b.dataset.v!);
  });
}
function renderSettings() {
  if (!S) return;
  const st = S.map.settings;
  $("auto").setAttribute("aria-checked", String(st.autoApply));
  $("auto").onclick = () => api("/api/settings", { autoApply: !st.autoApply }).catch((e) => toast(e.message));
  seg("gate", st.gate, (v) => api("/api/settings", { gate: v }).catch((e) => toast(e.message)));
  const t = S.tokens;
  $("tokNote").textContent = t.mode === "exact"
    ? `Exact counts${t.source === "environment" ? " (key from the ANTHROPIC_API_KEY variable)" : ""}.${t.counting ? ` Counting ${t.counting.done} of ${t.counting.total} files.` : ""}${t.error ? ` Last error: ${t.error}` : ""}`
    : "Estimated counts (file size ÷ 4). Add a key for exact counts.";
  $("keyRemove").hidden = t.source !== "saved";
}
$<HTMLFormElement>("keyForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const input = $<HTMLInputElement>("key");
  const key = input.value.trim();
  input.value = "";
  if (!key) return;
  try { await api("/api/key", { key }); } catch (err) { toast((err as Error).message); }
});
$("keyRemove").onclick = () => api("/api/key/delete").catch((e) => toast(e.message));

let MOTION = store.get("weave.motion") ?? "pulse";
let ANIM = store.get("weave.anim") ?? "always";
let reduce = false;
const sysReduce = matchMedia("(prefers-reduced-motion: reduce)");
function setReduce() {
  reduce = ANIM === "system" && sysReduce.matches;
  document.documentElement.classList.toggle("still", reduce);
  $("animNote").hidden = !reduce;
}
sysReduce.addEventListener?.("change", setReduce);
function renderLook() {
  seg("motion", MOTION, (v) => { MOTION = v; store.set("weave.motion", v); renderLook(); });
  $("motionNote").textContent = NOTES[MOTION];
  seg("anim", ANIM, (v) => { ANIM = v; store.set("weave.anim", v); setReduce(); renderLook(); });
  const theme = document.documentElement.dataset.theme ?? "light";
  seg("theme", theme, (v) => { document.documentElement.dataset.theme = v; store.set("weave.theme", v); renderLook(); });
}
setReduce();
renderLook();

// ---------- Live activity ----------
const feedEl = $("feed");
function log(verb: string, id: string | null, who: string, path?: string) {
  const n = id ? byId.get(id) : undefined;
  const li = document.createElement("li");
  const what = n ? (n.tier === "element" && n.kind !== "tool" ? path ?? n.paths[0] ?? n.label : n.label) : "";
  li.innerHTML = `<span class="tag" style="background:${COLOR[verb] ?? "var(--surface)"}">${esc(verb)}</span><code title="${esc(what)}">${esc(who ? who + (what ? " · " : "") : "")}${esc(what)}</code>`;
  if (verb === "Blocked") li.className = "blocked";
  feedEl.prepend(li);
  while (feedEl.children.length > 9) feedEl.lastChild!.remove();
}

interface Act { verb: Verb; color: string; start: number; until: number; session: string }
const active = new Map<string, Act>();
const edited = new Map<string, Set<string>>();

function paintActs() {
  const now = Date.now();
  for (const n of N) {
    if (n.tier === "core") continue;
    const d = els[n.id], a = active.get(n.id);
    if (!d) continue;
    if (a && now > a.until) active.delete(n.id);
    const on = active.has(n.id);
    d.classList.toggle("working", on);
    if (on && a) {
      const tab = d.querySelector(".act")!;
      d.style.setProperty("--ac", a.color);
      tab.querySelector(".lbl")!.textContent = VERB_ING[a.verb];
      tab.querySelector(".sec")!.textContent = Math.max(0, Math.floor((now - a.start) / 1000)) + "s";
    }
  }
}
setInterval(paintActs, 250);

function orbLoop(now: number) {
  active.forEach((a, id) => {
    const c = els[id]?.querySelector<HTMLCanvasElement>(".act canvas");
    const ctx = c?.getContext("2d");
    if (!ctx) return;
    const { mode, speed, opts } = resolvePreset(ORB[a.verb] as never, 20 as never);
    ctx.setTransform(1.6, 0, 0, 1.6, 0, 0);
    ctx.clearRect(0, 0, 20, 20);
    MODE_DRAWS[mode](ctx, 20, reduce ? 0.6 : (now / 1000) * speed, false, opts);
  });
  requestAnimationFrame(orbLoop);
}
requestAnimationFrame(orbLoop);

function via(n: WNode, pr: Preset): string | undefined {
  return n.of.find((f) => pr.features.includes(f) && byId.has(f)) ?? n.of.find((f) => byId.has(f));
}
function route(n: WNode, pr: Preset): [string, string][] {
  if (n.tier === "core") return [];
  if (n.tier === "feature") return [["core", n.id]];
  const v = via(n, pr);
  return v ? [["core", v], [v, n.id]] : [["core", n.id]];
}
const back = (segs: [string, string][]) => segs.slice().reverse().map(([a, b]) => [a, b, true] as [string, string, boolean]);

function onActivity(e: Activity, animate: boolean) {
  const n = byId.get(e.node);
  if (!n || !S) return;
  const pr = threadPreset(e.s) ?? preset();
  const thread = S.threads.find((t) => t.id === e.s)?.name;
  const who = e.outside && !e.blocked ? `${thread ?? "claude"} · outside window` : thread ?? "claude";
  if (e.ph === "start" || e.blocked) log(e.blocked ? "Blocked" : e.verb, n.id, who, e.path);
  if (!animate) return;
  if (e.blocked) { const v = via(n, pr); signal(v ? [["core", v]] : [], "Blocked", { label: "blocked" }, () => shake(v ?? n.id)); return; }
  if (e.ph === "start") {
    if (n.tier !== "core") active.set(n.id, { verb: e.verb, color: pr.color, start: e.t, until: Date.now() + 60_000, session: e.s });
    if (e.verb === "Run") signal(route(n, pr), "Run", { label: "run" }, () => flash(n.id, "Run"));
    paintActs();
    renderPresets();
    return;
  }
  const a = active.get(n.id);
  if (a) a.until = Date.now() + 1200;
  const done = () => { if (e.outside) mark(n.id); };
  if (e.verb === "Read") signal(back(route(n, pr)), "Read", { label: n.tokens ? `+${fmt(n.tokens)} tokens` : "read", size: n.tokens }, () => { flash("core", "Read"); echoN(via(n, pr), n.id, "Read"); done(); });
  else if (e.verb === "Edit") {
    if (!edited.has(e.s)) edited.set(e.s, new Set());
    edited.get(e.s)!.add(n.id);
    signal(route(n, pr), "Edit", { label: "edit" }, () => { flash(n.id, "Edit"); echoN(via(n, pr), n.id, "Edit"); done(); });
  } else if (e.verb === "Run") signal(back(route(n, pr)), "Run", { label: "output" }, done);
  else if (e.verb === "PR") {
    const changed = [...(edited.get(e.s) ?? [])].map((id) => byId.get(id)).filter((x): x is Node => !!x);
    let left = changed.length;
    const send = () => signal(route(n, pr), "PR", { label: `PR · ${changed.length} file${changed.length === 1 ? "" : "s"}`, size: 400 * Math.max(1, changed.length) }, () => { flash(n.id, "PR"); edited.delete(e.s); done(); });
    if (!left || MOTION === "calm") send();
    else changed.forEach((c) => signal(back(route(c, pr)), "PR", { r: 4 }, () => { if (--left === 0) send(); }));
  }
}

function shake(id: string) { const d = els[id]; if (!d) return; d.classList.remove("ask"); void d.offsetWidth; d.classList.add("ask"); }
function mark(id: string) { const d = els[id]; if (!d) return; d.classList.add("outside"); setTimeout(() => d.classList.remove("outside"), 1400); }
function flash(id: string, verb: string) {
  if (MOTION === "calm") return;
  const d = els[id];
  if (!d) return;
  const cls = MOTION === "neural" ? "fire2" : "fire";
  d.style.setProperty("--ring", COLOR[verb]);
  d.classList.remove("fire", "fire2");
  void d.offsetWidth;
  d.classList.add(cls);
}
function echoN(v: string | undefined, id: string, verb: string) {
  if (MOTION !== "neural" || reduce || !v) return;
  N.filter((e) => e.tier === "element" && e.id !== id && e.of.includes(v) && isLive(e)).slice(0, 3).forEach((e, k) => {
    setTimeout(() => travel(cords[v + ">" + e.id], COLOR[verb], { r: 3, opacity: 0.55, dur: 700, to: 0.55 }), 80 * k);
  });
}
interface TravelOpts { r: number; trail?: number; dur: number; opacity?: number; to?: number; rev?: boolean; label?: string | null }
function travel(path: SVGPathElement | undefined, color: string, o: TravelOpts, done?: () => void) {
  if (!path) return done?.();
  const L = path.getTotalLength(), trail = o.trail ?? 0, dots: SVGCircleElement[] = [];
  for (let k = 0; k <= trail; k++) {
    const c = document.createElementNS(NS, "circle");
    c.setAttribute("r", String(Math.max(1.5, o.r - k * (o.r / (trail + 2)))));
    c.setAttribute("fill", color);
    c.setAttribute("opacity", String((o.opacity ?? 1) * (1 - k / (trail + 1))));
    gPulse.appendChild(c);
    dots.push(c);
  }
  let lab: SVGTextElement | null = null;
  if (o.label) { lab = document.createElementNS(NS, "text"); lab.setAttribute("class", "sig-label"); lab.textContent = o.label; gPulse.appendChild(lab); }
  let t0: number | null = null;
  const at = (f: number) => path.getPointAtLength(L * (o.rev ? 1 - f : f));
  const run = (now: number) => {
    t0 ??= now;
    const t = Math.min(1, (now - t0) / o.dur), e = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2, end = o.to ?? 1;
    dots.forEach((c, k) => { const p = at(end * Math.max(0, e - k * 0.035)); c.setAttribute("cx", String(p.x)); c.setAttribute("cy", String(p.y)); });
    if (lab) { const p = at(end * e); lab.setAttribute("x", String(p.x + o.r + 6)); lab.setAttribute("y", String(p.y - o.r - 4)); }
    if (o.to && t > 0.6) dots.forEach((c) => c.setAttribute("opacity", String((1 - t) * 1.2 * (o.opacity ?? 1))));
    if (t < 1) return requestAnimationFrame(run);
    dots.forEach((c) => c.remove());
    lab?.remove();
    done?.();
  };
  requestAnimationFrame(run);
}
/** segs: [from, to, reversed?]. Size grows with the tokens that move. */
function signal(segs: ([string, string] | [string, string, boolean])[], verb: string, opt: { label?: string; size?: number; r?: number }, done: () => void) {
  if (reduce || document.hidden) { segs.forEach(([a, b, rev]) => flash(rev ? a : b, verb)); return done(); }
  const sz = opt.r ?? (opt.size ? Math.min(15, 5 + Math.sqrt(opt.size) / 6) : 6);
  const style = ({ calm: { r: 4, trail: 0, dur: 700 }, pulse: { r: sz, trail: 3, dur: 640 }, neural: { r: sz, trail: 8, dur: 560 } } as Record<string, TravelOpts>)[MOTION];
  const label = MOTION === "calm" ? null : opt.label;
  let i = 0;
  const next = () => {
    if (i >= segs.length) return done();
    const [a, b, rev] = segs[i++], path = cords[a + ">" + b];
    if (path && MOTION !== "calm") {
      path.classList.add(MOTION === "neural" ? "lit" : "fired");
      path.style.stroke = COLOR[verb];
      setTimeout(() => { path.classList.remove("fired", "lit"); path.style.stroke = ""; }, MOTION === "neural" ? 1100 : 700);
    }
    travel(path, COLOR[verb], { ...style, rev, label }, () => { if (i < segs.length) flash(rev ? a : b, verb); next(); });
  };
  next();
}

// ---------- State from the server ----------
function adopt(next: State) {
  const first = !S;
  S = next;
  $("project").textContent = next.project;
  document.title = `${next.project} · WEAVE`;
  if (!next.map.presets.some((p) => p.id === P)) P = next.map.settings.defaultPreset;
  const sig = next.map.nodes.map((n) => `${n.id}|${n.label}|${n.of.join(",")}|${n.tokens}|${n.kind}`).join(";");
  if (sig !== shape) {
    const old = new Map(N.map((n) => [n.id, n]));
    N = next.map.nodes.map((n) => ({ ...n, x: 0, y: 0 }));
    byId = new Map(N.map((n) => [n.id, n]));
    const sameIds = N.length === old.size && N.every((n) => old.has(n.id));
    layout(N);
    if (first) { try { pinned = JSON.parse(store.get(posKey()) ?? "{}"); } catch { pinned = {}; } }
    for (const n of N) {
      const pin = pinned[n.id];
      if (pin) { n.x = pin[0]; n.y = pin[1]; }
      else if (sameIds) { const o = old.get(n.id)!; n.x = o.x; n.y = o.y; }
    }
    shape = sig;
    buildNodes();
    if (!N.length) world.insertAdjacentHTML("beforeend", '<div class="empty-map">No files found. Run `weave scan` in the project folder.</div>');
    if (first || !sameIds) requestAnimationFrame(fit);
  }
  renderAll();
}
function renderAll() {
  draw();
  paintActs();
  inspect();
  renderPresets();
  renderThreads();
  renderSuggestions();
  renderSettings();
}

let retry = 500;
function connect() {
  const ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`);
  const conn = $("conn");
  ws.onopen = () => { retry = 500; conn.textContent = "Live"; conn.className = "conn on"; };
  ws.onmessage = (m) => {
    const msg = JSON.parse(m.data);
    if (msg.type === "state") adopt(msg);
    else if (msg.type === "history") (msg.events as Activity[]).forEach((e) => onActivity(e, false));
    else if (msg.type === "activity") (msg.events as Activity[]).forEach((e) => onActivity(e, true));
  };
  ws.onclose = () => {
    conn.textContent = "Offline";
    conn.className = "conn off";
    setTimeout(connect, retry);
    retry = Math.min(retry * 2, 8000);
  };
}
if (innerWidth < 600) $("pmin").click();
addEventListener("resize", () => fit());
inspect();
connect();
