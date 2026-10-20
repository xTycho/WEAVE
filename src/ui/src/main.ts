import "./styles.css";
import { MODE_DRAWS, resolvePreset } from "thinking-orbs/engine";
import { curve, hull, layout, type Placed } from "./layout";

// ---------- Types shared with the server ----------
type Tier = "core" | "feature" | "element";
type Kind = "core" | "feature" | "code" | "design" | "doc" | "test" | "tool";
type Verb = "Read" | "Edit" | "Run" | "PR";
interface WNode { id: string; label: string; tier: Tier; kind: Kind; paths: string[]; of: string[]; bytes: number; tokens: number; exact?: boolean; custom?: boolean; command?: string }
interface Preset { id: string; name: string; color: string; features: string[]; detached: string[]; asleep?: string[] }
interface Thread { id: string; name: string; preset: string; startedAt: number; lastSeen: number; contextTokens?: number }
interface Suggestion { rule: string; node: string; attach: boolean; text: string; key: string }
interface Settings { autoApply: boolean; warmCold: boolean; gate: "flag" | "block"; idleAfter: number; defaultPreset: string }
interface State {
  project: string;
  map: { nodes: WNode[]; presets: Preset[]; assign: Record<string, string>; settings: Settings };
  threads: Thread[];
  suggestions: Record<string, Suggestion[]>;
  warm: Record<string, { warm: string[]; hot: string[]; overdue: string[] }>;
  heat: Record<string, number>;
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
const COLOR: Record<string, string> = { Read: "#A3A9E6", Edit: "#E9A6D2", Run: "#F6BE8A", PR: "#CFE19C", Attach: "#8E95DB", Detach: "#B4B6BA", Sleep: "#9AA0A6", Blocked: "#F1A9B0" };
const VERB_ING: Record<Verb, string> = { Read: "Reading", Edit: "Editing", Run: "Running", PR: "Opening PR" };
const ORB: Record<Verb, string> = { Read: "searching", Edit: "composing", Run: "working", PR: "weaving" };

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
let toastTimer = 0;
function toast(msg: string) {
  const el = $("toast");
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => (el.hidden = true), 4500);
}

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
const liveIn = (pr: Preset, n: WNode) => n.tier === "core" || (n.tier === "feature" ? pr.features.includes(n.id) : !pr.detached.includes(n.id) && !pr.asleep?.includes(n.id) && (n.of.length === 0 || n.of.some((f) => pr.features.includes(f))));
const isLive = (n: WNode) => liveIn(preset(), n);
/** The default preset is Claude's default view: every file attached. It is shown, not edited. */
const isBase = (p: Preset) => p.id === S!.map.settings.defaultPreset;
const BASE_NOTE = "Full project is Claude's default view and keeps every file attached. Save a preset to work with fewer files.";
/** Thread names come from the first prompt; wrapper blocks and tags are not a name. Unnamed threads are numbered by start. */
const WRAPPERS = /<(system-reminder|relay|wake|note|command-[\w-]+|local-command-[\w-]+)\b[^>]*>[\s\S]*?<\/\1>/gi;
function threadLabel(t: Thread): string {
  // Old names were cut at 48 characters, so a wrapper can be left open: drop everything from an unclosed one.
  const clean = t.name.replace(WRAPPERS, " ").replace(/<(system-reminder|relay|wake|note|command-[\w-]+|local-command-[\w-]+)\b[\s\S]*$/i, " ")
    .replace(/<\/?[a-z][\w-]*\b[^>]*>?/gi, " ").replace(/\s+/g, " ").trim();
  if (clean && !/^Thread [0-9a-z-]{6}$/i.test(clean)) return clean;
  const order = [...S!.threads].sort((a, b) => a.startedAt - b.startedAt);
  return `Thread ${order.findIndex((x) => x.id === t.id) + 1}`;
}
/** Warm files of the selected preset. Empty means no warm/cold split, so nothing is shown as cold. */
const warmIds = () => new Set(S?.warm?.[preset().id]?.warm ?? []);
const hotIds = () => new Set(S?.warm?.[preset().id]?.hot ?? []);
const dueIds = () => new Set(S?.warm?.[preset().id]?.overdue ?? []);
const asleep = (n: WNode) => !!preset().asleep?.includes(n.id);
/** Highlights the overdue files on the map, like a search. */
let showDue = false;
/** Embers rising off a hot node. Fixed offsets, so a redraw never makes them jump. */
const EMBERS = '<span class="embers" aria-hidden="true">' + [[12, 0, 2.6], [30, 1.1, 2.2], [48, .5, 3], [64, 1.7, 2.4], [80, .2, 2.8], [92, 1.4, 2.1]]
  .map(([x, d, t]) => `<i style="--x:${x}%;--d:${d}s;--t:${t}s"></i>`).join("") + "</span>";
const coldIn = (n: WNode, warm: Set<string>) => warm.size > 0 && n.tier === "element" && n.kind !== "tool" && !warm.has(n.id) && isLive(n);
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
  const warm = warmIds(), hot = hotIds(), due = dueIds();
  if (showDue && !due.size) showDue = false;
  world.classList.toggle("show-due", showDue);
  for (const n of N) {
    const d = els[n.id];
    if (!d) continue;
    const live = isLive(n);
    d.style.left = n.x + "px";
    d.style.top = n.y + "px";
    d.classList.toggle("live", live);
    d.classList.toggle("off", !live);
    d.classList.toggle("warm", warm.has(n.id));
    d.classList.toggle("cold", coldIn(n, warm));
    d.classList.toggle("due", due.has(n.id));
    d.classList.toggle("asleep", asleep(n));
    const burning = hot.has(n.id), embers = d.querySelector(".embers");
    d.classList.toggle("hot", burning);
    if (burning && !embers) d.insertAdjacentHTML("beforeend", EMBERS);
    else if (!burning) embers?.remove();
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

/** One bar for the whole project: warm, cold (attached, rarely used) and detached, left to right. */
function meter() {
  const live = N.filter((n) => n.tier !== "feature" && isLive(n)).reduce((s, n) => s + n.tokens, 0);
  const all = N.reduce((s, n) => s + n.tokens, 0) || 1;
  const exact = S!.tokens.mode === "exact" && N.every((n) => n.tier === "feature" || n.kind === "tool" || n.exact);
  const warm = warmIds(), due = dueIds();
  const sum = (ids: Set<string>) => N.filter((n) => ids.has(n.id)).reduce((s, n) => s + n.tokens, 0);
  const hot = sum(warm), late = sum(due), cold = Math.max(0, live - hot - late);
  const sleeping = N.filter((n) => asleep(n)).length;
  const t = (v: number) => (exact ? "" : "~") + fmt(v);
  $("mview").textContent = preset().name;
  $("tok").textContent = warm.size ? ` · ${t(hot)} warm / ${fmt(live)} attached` : ` · ${t(live)} attached`;
  $("sWarm").style.width = (hot / all) * 100 + "%";
  $("sCold").style.width = (cold / all) * 100 + "%";
  $("sDue").style.width = (late / all) * 100 + "%";
  $("sDet").style.width = ((all - live) / all) * 100 + "%";
  $("meter").title = [
    warm.size ? `Warm: ${t(hot)} tokens in ${warm.size} files. Threads start here.` : "Warm: nothing yet. Files warm up as Claude reads and edits them.",
    `Cold: ${t(cold)} tokens. Attached, opened only when needed.`,
    `Overdue: ${due.size ? `${t(late)} tokens in ${due.size} files with no read or edit in 14 days.` : "none. Files become overdue after 14 days without a read or edit."}`,
    `Detached: ${t(all - live)} tokens${sleeping ? `, ${sleeping} of them asleep` : ""}.`,
    exact ? "Exact counts." : "Estimated counts (file size ÷ 4).",
  ].join("\n");
  const btn = $("dueBtn");
  btn.hidden = !due.size;
  btn.textContent = `${due.size} overdue`;
  btn.title = showDue ? "Stop highlighting overdue files" : "Highlight overdue files on the map";
  btn.setAttribute("aria-pressed", String(showDue));
}
$("dueBtn").onclick = () => { showDue = !showDue; draw(); };

// ---------- Interaction ----------
async function toggle(id: string) {
  const n = byId.get(id);
  if (!n || n.tier === "core") return;
  const was = isLive(n);
  if (was && isBase(preset())) return toast(BASE_NOTE);
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

/** Warm, cold or hot for an attached file, with its score, by the same fixed rules as the server. */
function heatState(n: WNode): string {
  if (n.tier !== "element" || n.kind === "tool") return "";
  const score = S!.heat[n.id] ?? 0, at = score ? ` · score ${score}` : "";
  if (!isLive(n)) return "Detached";
  if (hotIds().has(n.id)) return `Hot${at}`;
  if (warmIds().has(n.id)) return `Warm${at}`;
  return S!.map.settings.warmCold ? `Cold${at || " · not used yet"}` : `Off${at}`;
}

let renaming = false;
function inspect() {
  const box = $("insp");
  const n = selected ? byId.get(selected) : undefined;
  // A live update must not wipe a name being typed.
  if (renaming && document.activeElement?.id === "rnName") return;
  box.hidden = !n || !S;
  if (!n || !S) { renaming = false; return; }
  const live = isLive(n);
  const parents = n.of.map((p) => byId.get(p)?.label ?? p).join(", ");
  const kids = n.tier === "feature" ? N.filter((e) => e.of.includes(n.id)).length : 0;
  const tok = n.tier === "feature" ? featTokens(n) : n.tokens;
  const others = S.map.presets.filter((p) => p.id !== preset().id && !isBase(p));
  const heatTxt = heatState(n);
  const canToggle = n.tier !== "core" && !(live && isBase(preset()));
  box.innerHTML = `<div class="ihead"><h2 class="cap">${KIND[n.kind].tag} node</h2><button class="x" id="ix" aria-label="Close">×</button></div>
    ${renaming ? `<div class="prow"><input id="rnName" value="${esc(n.label)}" aria-label="Node name"><button class="btn fill" id="rnSave">Save</button><button class="btn" id="rnCancel">Cancel</button></div>` : `<b class="iname">${esc(n.label)}</b>`}
    <dl><dt>Path</dt><dd>${esc(metaPath(n))}</dd>
    ${tok ? `<dt>Tokens</dt><dd>~${fmt(tok)}${n.exact ? " (exact)" : " (estimate)"}</dd>` : ""}
    ${parents ? `<dt>Used by</dt><dd>${esc(parents)}</dd>` : ""}${kids ? `<dt>Elements</dt><dd>${kids}</dd>` : ""}
    <dt>State</dt><dd>${live ? `Attached in ${esc(preset().name)}` : "Detached"}</dd>
    ${heatTxt ? `<dt>Heat</dt><dd><span class="heat ${heatTxt.split(" ")[0].toLowerCase()}">${esc(heatTxt)}</span></dd>` : ""}</dl>
    <div class="actions">${canToggle ? `<button class="btn" id="tg">${live ? "Detach" : "Reattach"}</button>` : ""}${renaming ? "" : '<button class="btn" id="rn">Rename</button>'}</div>
    ${n.kind === "design" ? `<span class="cap">New feature from this design</span>
      <input id="spinName" placeholder="Feature name" aria-label="Feature name">
      <label class="cap" for="bring">Bring a saved preset</label>
      <select id="bring"><option value="">None</option>${others.map((p) => `<option value="${esc(p.id)}">${esc(p.name)}</option>`).join("")}</select>
      <div class="actions"><button class="btn fill" id="spin">New feature from this</button></div>` : ""}`;
  box.querySelector("#ix")!.addEventListener("click", () => { selected = null; renaming = false; draw(); inspect(); });
  box.querySelector("#tg")?.addEventListener("click", () => toggle(n.id));
  box.querySelector("#rn")?.addEventListener("click", () => { renaming = true; inspect(); box.querySelector<HTMLInputElement>("#rnName")?.select(); });
  const rnInput = box.querySelector<HTMLInputElement>("#rnName");
  const rnSave = async () => {
    const label = rnInput!.value.trim();
    renaming = false;
    if (label && label !== n.label) await api("/api/rename", { node: n.id, label }).catch((e) => toast(e.message));
    inspect();
  };
  box.querySelector("#rnSave")?.addEventListener("click", rnSave);
  box.querySelector("#rnCancel")?.addEventListener("click", () => { renaming = false; inspect(); });
  rnInput?.addEventListener("keydown", (e) => { if (e.key === "Enter") rnSave(); if (e.key === "Escape") { renaming = false; inspect(); } });
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
  const left = 0, W = r.width;
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
  if (t.closest("button,input,select,.editing,.zoom") || t.classList.contains("hit")) return;
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

// ---------- Context: the default view, saved presets and the threads on each ----------
const working = (session: string) => [...active.values()].some((a) => a.session === session) || Date.now() - (S?.threads.find((t) => t.id === session)?.lastSeen ?? 0) < 60_000;
const tokOf = (p: Preset) => N.filter((n) => n.tier !== "feature" && liveIn(p, n)).reduce((s, n) => s + n.tokens, 0);
/** What a thread is doing right now, for its orb. */
const threadVerb = (session: string): Verb | undefined => [...active.values()].filter((a) => a.session === session).sort((a, b) => b.start - a.start)[0]?.verb;
let editing: "copy" | "rename" | null = null;

function threadRow(t: Thread, p: Preset): HTMLLIElement {
  const li = document.createElement("li");
  const verb = threadVerb(t.id), name = threadLabel(t);
  li.className = "thread" + (verb ? " busy" : working(t.id) ? " live" : "");
  li.style.setProperty("--c", p.color);
  li.innerHTML = `<span class="ticon"><canvas class="orb" width="32" height="32" data-session="${esc(t.id)}" aria-hidden="true"></canvas><i></i></span>`
    + `<span class="tmain"><b title="${esc(name)}">${esc(name)}</b><small>${verb ? VERB_ING[verb] : working(t.id) ? "Working" : "Idle"}${t.contextTokens ? ` · ${fmt(t.contextTokens)} in context` : ""}</small></span>`
    + `<select aria-label="Preset for ${esc(name)}" title="Move this thread to another preset">${S!.map.presets.map((x) => `<option value="${esc(x.id)}" ${x.id === t.preset ? "selected" : ""}>${esc(x.name)}</option>`).join("")}</select>`;
  li.querySelector("select")!.addEventListener("change", (e) => api("/api/assign", { thread: t.id, preset: (e.target as HTMLSelectElement).value }).catch((err) => toast(err.message)));
  return li;
}

function renderPresets() {
  if (!S) return;
  // A live update must not close a dropdown someone is using.
  if ((document.activeElement as HTMLElement | null)?.closest?.("#plist select")) return;
  const box = $("plist");
  box.innerHTML = "";
  const ordered = [...S.map.presets].sort((a, b) => Number(isBase(b)) - Number(isBase(a)));
  for (const p of ordered) {
    const base = isBase(p), li = document.createElement("li"), b = document.createElement("button");
    li.className = "preset" + (p.id === preset().id ? " cur" : "");
    b.className = "pick";
    b.setAttribute("aria-pressed", String(p.id === preset().id));
    const feats = p.features.map((f) => byId.get(f)?.label ?? f);
    const sub = base ? "Every file attached. Threads without a preset use this." : feats.slice(0, 4).join(" · ") + (feats.length > 4 ? ` · +${feats.length - 4}` : "");
    const sleeping = p.asleep?.length ? ` · ${p.asleep.length} asleep` : "";
    b.innerHTML = `<span class="dot" style="background:${esc(p.color)}"></span><span class="pmain"><b>${esc(p.name)}${base ? '<span class="def">Default view</span>' : ""}</b><small>${esc(sub + sleeping)}</small></span><em>~${fmt(tokOf(p))}</em>`;
    b.onclick = () => { P = p.id; store.set("weave.preset", P); selected = null; editing = null; renderAll(); };
    li.appendChild(b);
    const users = S.threads.filter((t) => t.preset === p.id);
    if (users.length) {
      const ul = document.createElement("ul");
      ul.className = "tlist";
      ul.setAttribute("aria-label", `Threads on ${p.name}`);
      users.forEach((t) => ul.appendChild(threadRow(t, p)));
      li.appendChild(ul);
    }
    box.appendChild(li);
  }
  if (!S.threads.length) box.insertAdjacentHTML("beforeend", '<li class="empty">No threads yet. They appear here once Claude Code runs in this project with the WEAVE hooks.</li>');
  renderPresetActions();
}

function renderPresetActions() {
  const row = $("pactions"), p = preset();
  // A live update must not wipe a name being typed.
  if (editing && document.activeElement?.id === "pname") return;
  if (editing) {
    row.innerHTML = `<input id="pname" value="${editing === "rename" ? esc(p.name) : ""}" placeholder="${editing === "copy" ? `Name for a copy of ${esc(p.name)}` : "Preset name"}" aria-label="Preset name"><button class="btn fill" id="psave">Save</button><button class="btn" id="pcancel">Cancel</button>`;
    const input = row.querySelector<HTMLInputElement>("#pname")!;
    input.focus();
    const save = async () => {
      const name = input.value.trim();
      if (!name) return;
      try {
        if (editing === "copy") { const np = await api("/api/presets/create", { name, copyFrom: p.id }); P = np.id; store.set("weave.preset", P); }
        else await api("/api/presets/rename", { id: p.id, name });
        editing = null;
        renderPresetActions();
      } catch (e) { toast((e as Error).message); }
    };
    row.querySelector("#psave")!.addEventListener("click", save);
    input.addEventListener("keydown", (e) => { if (e.key === "Enter") save(); if (e.key === "Escape") { editing = null; renderPresetActions(); } });
    row.querySelector("#pcancel")!.addEventListener("click", () => { editing = null; renderPresetActions(); });
    return;
  }
  const custom = !isBase(p);
  row.innerHTML = `<button class="btn fill" id="pheat" title="Make a preset from the files that are warm right now. It is named by fixed rules from those files.">Save warm files as preset</button>`
    + (custom ? '<button class="btn" id="pren">Rename</button><button class="btn" id="pcopy">Duplicate</button><button class="btn" id="pdel">Delete</button>' : "");
  row.querySelector("#pheat")!.addEventListener("click", async () => {
    try {
      const np = await api("/api/presets/fromHeat");
      P = np.id;
      store.set("weave.preset", P);
      selected = null;
      renderAll();
      toast(`Saved "${np.name}": its warm files are attached, everything else in those folders is detached.`);
    } catch (e) { toast((e as Error).message); }
  });
  row.querySelector("#pren")?.addEventListener("click", () => { editing = "rename"; renderPresetActions(); });
  row.querySelector("#pcopy")?.addEventListener("click", () => { editing = "copy"; renderPresetActions(); });
  row.querySelector("#pdel")?.addEventListener("click", () => {
    if (confirm(`Delete the preset "${p.name}"? Threads on it go back to ${S!.map.presets.find(isBase)?.name ?? "the default view"}.`)) api("/api/presets/delete", { id: p.id }).catch((e) => toast(e.message));
  });
}

/** Shown on the map while a saved preset is selected, since clicking a cord edits it. */
function renderEditing() {
  const el = $("editing"), p = preset();
  el.hidden = isBase(p);
  if (el.hidden) return;
  el.style.setProperty("--c", p.color);
  el.innerHTML = `<i></i><span>Editing <b>${esc(p.name)}</b></span><button aria-label="Back to the default view" title="Back to the default view">×</button>`;
  el.querySelector("button")!.onclick = () => { P = S!.map.settings.defaultPreset; store.set("weave.preset", P); selected = null; editing = null; renderAll(); };
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
  // The default view keeps every file attached, so it is never offered a detach.
  const list = (S.suggestions[preset().id] ?? []).filter((r) => r.attach || !isBase(preset()));
  const due = N.filter((n) => dueIds().has(n.id)).sort((a, b) => b.tokens - a.tokens);
  const p = $("suggestPanel");
  p.hidden = !list.length && !due.length;
  p.innerHTML = `<h2 class="cap">Suggestions <span style="opacity:.7">· fixed rules, no AI</span></h2>`;
  if (due.length) {
    const card = document.createElement("div");
    card.className = "suggest due";
    const total = due.reduce((s, n) => s + n.tokens, 0);
    card.innerHTML = `<span class="cap">Rule · Overdue</span><p>${due.length === 1 ? "1 attached file has" : `${due.length} attached files have`} had no read or edit in 14 days (~${fmt(total)} tokens). Put ${due.length === 1 ? "it" : "them"} to sleep: detached and left out of the thread note, and woken the moment Claude reads or edits ${due.length === 1 ? "it" : "one"}.</p>`
      + `<ul class="duelist">${due.slice(0, 5).map((n) => `<li><code title="${esc(n.paths[0] ?? n.label)}">${esc(n.paths[0] ?? n.label)}</code><span>~${fmt(n.tokens)}</span><button class="btn" data-id="${esc(n.id)}">Sleep</button></li>`).join("")}</ul>`
      + `${due.length > 5 ? `<p class="note">and ${due.length - 5} more</p>` : ""}<div class="row"><button class="btn fill" id="sleepAll">Put ${due.length === 1 ? "it" : `all ${due.length}`} to sleep</button><button class="btn" id="showDue">${showDue ? "Hide on map" : "Show on map"}</button></div>`;
    const put = (ids: string[]) => api("/api/sleep", { preset: preset().id, nodes: ids }).then(() => log("Sleep", ids.length === 1 ? ids[0] : null, ids.length === 1 ? "you" : `you · ${ids.length} files`)).catch((e) => toast(e.message));
    card.querySelectorAll<HTMLButtonElement>(".duelist button").forEach((b) => (b.onclick = () => put([b.dataset.id!])));
    card.querySelector<HTMLButtonElement>("#sleepAll")!.onclick = () => put(due.map((n) => n.id));
    card.querySelector<HTMLButtonElement>("#showDue")!.onclick = () => { showDue = !showDue; draw(); renderSuggestions(); };
    p.appendChild(card);
  }
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
  $("warmCold").setAttribute("aria-checked", String(st.warmCold));
  $("warmCold").onclick = () => api("/api/settings", { warmCold: !st.warmCold }).catch((e) => toast(e.message));
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

// Settings live in a menu behind the gear in the top bar.
const gear = $("gear"), menu = $("settings");
function openMenu(open: boolean) {
  menu.hidden = !open;
  gear.setAttribute("aria-expanded", String(open));
}
gear.onclick = (e) => { e.stopPropagation(); openMenu(!!menu.hidden); };
document.addEventListener("pointerdown", (e) => { if (!menu.hidden && !(e.target as Element).closest(".menu")) openMenu(false); });
document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !menu.hidden) { openMenu(false); gear.focus(); } });

let ANIM = store.get("weave.anim") ?? "always";
let reduce = false;
const sysReduce = matchMedia("(prefers-reduced-motion: reduce)");
function setReduce() {
  reduce = ANIM === "system" && sysReduce.matches;
  document.documentElement.classList.toggle("still", reduce);
  $("anim").setAttribute("aria-checked", String(ANIM === "system"));
  $("animNote").textContent = reduce
    ? "Your device asks apps to reduce motion, so signals and embers are paused."
    : "Pause signals and embers when your device asks apps to reduce motion.";
}
sysReduce.addEventListener?.("change", setReduce);
$("anim").onclick = () => { ANIM = ANIM === "system" ? "always" : "system"; store.set("weave.anim", ANIM); setReduce(); };
setReduce();

// DARK / LIGHT slider in the header. A saved "system" keeps following the device until clicked.
const sysDark = matchMedia("(prefers-color-scheme: dark)");
const isDark = () => { const t = document.documentElement.dataset.theme; return t === "dark" || (t === "system" && sysDark.matches); };
const paintTheme = () => $("theme").setAttribute("aria-checked", String(isDark()));
$("theme").onclick = () => {
  const t = isDark() ? "light" : "dark";
  document.documentElement.dataset.theme = t;
  store.set("weave.theme", t);
  paintTheme();
};
sysDark.addEventListener?.("change", paintTheme);
paintTheme();

// ---------- Live activity ----------
const feedEl = $("feed");
/** History: one compact row per action, newest first. The file, the time, and a dot in the colour of the thread's preset. */
function log(verb: string, id: string | null, who: string, path?: string, session?: string, t = Date.now()) {
  const n = id ? byId.get(id) : undefined;
  const li = document.createElement("li");
  const what = n ? (n.tier === "element" && n.kind !== "tool" ? path ?? n.paths[0] ?? n.label : n.label) : "";
  const file = what.split("/").pop() || what;
  const color = session ? threadPreset(session)?.color : undefined;
  const time = new Date(t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  li.innerHTML = `<span class="verb" style="--vc:${COLOR[verb] ?? "var(--line-2)"}">${esc(verb)}</span><code title="${esc(what || who)}">${esc(file || who)}</code><time>${time}</time><i class="who" style="--c:${color ?? "var(--line-2)"}" title="${esc(who)}"></i>`;
  if (verb === "Blocked") li.className = "blocked";
  feedEl.querySelector(".empty")?.remove();
  feedEl.prepend(li);
  while (feedEl.children.length > 8) feedEl.lastChild!.remove();
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
  renderLive();
}
setInterval(paintActs, 250);

/**
 * Live: what is running right now, as a folder tree that follows the same
 * route as the signals on the map, project → feature → file. Rebuilt only when
 * the set of running actions changes; the seconds tick in place.
 */
let liveSig = "";
function renderLive() {
  const box = $("live");
  const now = Date.now();
  const running = [...active.entries()].filter(([id, a]) => now <= a.until && byId.has(id)).sort((x, y) => x[1].start - y[1].start);
  const sig = running.map(([id, a]) => `${id}|${a.verb}|${a.session}`).join(";");
  if (sig !== liveSig || !S) {
    liveSig = sig;
    if (!running.length || !S) { box.innerHTML = '<p class="empty">Nothing running right now.</p>'; return; }
    // Build the tree from each action's route: core, then the feature it runs through, then the file.
    interface Branch { id: string; label: string; color: string; kids: Map<string, Branch>; leaf?: { verb: Verb; session: string; start: number } }
    const core = byId.get("core");
    const root: Branch = { id: "core", label: S.project, color: "", kids: new Map() };
    for (const [id, a] of running) {
      const n = byId.get(id)!, pr = threadPreset(a.session) ?? preset();
      const path = route(n, pr).map(([, to]) => to);
      let at = root;
      for (const step of path) {
        if (!at.kids.has(step)) { const s = byId.get(step); at.kids.set(step, { id: step, label: s?.tier === "feature" ? (s.paths[0] ?? s.label) : s?.label ?? step, color: "", kids: new Map() }); }
        at = at.kids.get(step)!;
        at.color ||= COLOR[a.verb];
      }
      at.leaf = { verb: a.verb, session: a.session, start: a.start };
      root.color ||= COLOR[a.verb];
    }
    const paint = (b: Branch): string => {
      const kids = [...b.kids.values()].map((k) => `<li style="--vc:${k.color}">${paint(k)}</li>`).join("");
      if (b.leaf) {
        const t = S!.threads.find((x) => x.id === b.leaf!.session), who = t ? threadLabel(t) : "claude";
        return `<span class="leaf"><canvas class="orb" width="32" height="32" data-verb="${b.leaf.verb}" data-node="${esc(b.id)}" aria-hidden="true"></canvas><b title="${esc(byId.get(b.id)?.paths[0] ?? b.label)}">${esc(b.label)}</b><small><span>${VERB_ING[b.leaf.verb]}</span> · <span data-start="${b.leaf.start}">0s</span></small><i class="who" style="--c:${threadPreset(b.leaf.session)?.color ?? "var(--line-2)"}" title="${esc(who)}"></i></span>${kids ? `<ul>${kids}</ul>` : ""}`;
      }
      return `<span class="fold"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M1.5 4.5a1 1 0 0 1 1-1h3.6l1.4 1.5h6a1 1 0 0 1 1 1v6.5a1 1 0 0 1-1 1h-11a1 1 0 0 1-1-1z"/></svg>${esc(b.label)}</span>${kids ? `<ul>${kids}</ul>` : ""}`;
    };
    box.innerHTML = `<ul class="tree"><li style="--vc:${root.color}">${core ? paint(root) : ""}</li></ul>`;
  }
  box.querySelectorAll<HTMLElement>("[data-start]").forEach((el) => (el.textContent = Math.max(0, Math.floor((now - Number(el.dataset.start)) / 1000)) + "s"));
}

function drawOrb(c: HTMLCanvasElement | null | undefined, verb: Verb, t: number | null) {
  const ctx = c?.getContext("2d");
  if (!ctx) return;
  const { mode, speed, opts } = resolvePreset(ORB[verb] as never, 20 as never);
  ctx.setTransform(1.6, 0, 0, 1.6, 0, 0);
  ctx.clearRect(0, 0, 20, 20);
  MODE_DRAWS[mode](ctx, 20, reduce || t === null ? 0.6 : (t / 1000) * speed, false, opts);
}
function orbLoop(now: number) {
  active.forEach((a, id) => drawOrb(els[id]?.querySelector<HTMLCanvasElement>(".act canvas"), a.verb, now));
  // Threads and the Live tree: the orb of what is running.
  document.querySelectorAll<HTMLCanvasElement>("canvas.orb").forEach((c) => {
    const v = c.dataset.session ? threadVerb(c.dataset.session) : (c.dataset.verb as Verb);
    if (v) drawOrb(c, v, now);
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
  const t = S.threads.find((x) => x.id === e.s), thread = t ? threadLabel(t) : undefined;
  const who = e.outside && !e.blocked ? `${thread ?? "claude"} · outside window` : thread ?? "claude";
  if (e.ph === "start" || e.blocked) log(e.blocked ? "Blocked" : e.verb, n.id, who, e.path, e.s, e.t);
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
  if (e.verb === "Read") signal(back(route(n, pr)), "Read", { label: n.tokens ? `+${fmt(n.tokens)} tokens` : "read", size: n.tokens }, () => { flash("core", "Read"); done(); });
  else if (e.verb === "Edit") {
    if (!edited.has(e.s)) edited.set(e.s, new Set());
    edited.get(e.s)!.add(n.id);
    signal(route(n, pr), "Edit", { label: "edit" }, () => { flash(n.id, "Edit"); done(); });
  } else if (e.verb === "Run") signal(back(route(n, pr)), "Run", { label: "output" }, done);
  else if (e.verb === "PR") {
    const changed = [...(edited.get(e.s) ?? [])].map((id) => byId.get(id)).filter((x): x is Node => !!x);
    let left = changed.length;
    const send = () => signal(route(n, pr), "PR", { label: `PR · ${changed.length} file${changed.length === 1 ? "" : "s"}`, size: 400 * Math.max(1, changed.length) }, () => { flash(n.id, "PR"); edited.delete(e.s); done(); });
    if (!left) send();
    else changed.forEach((c) => signal(back(route(c, pr)), "PR", { r: 4 }, () => { if (--left === 0) send(); }));
  }
}

function shake(id: string) { const d = els[id]; if (!d) return; d.classList.remove("ask"); void d.offsetWidth; d.classList.add("ask"); }
function mark(id: string) { const d = els[id]; if (!d) return; d.classList.add("outside"); setTimeout(() => d.classList.remove("outside"), 1400); }
function flash(id: string, verb: string) {
  const d = els[id];
  if (!d) return;
  d.style.setProperty("--ring", COLOR[verb]);
  d.classList.remove("fire");
  void d.offsetWidth;
  d.classList.add("fire");
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
  const style: TravelOpts = { r: opt.r ?? (opt.size ? Math.min(15, 5 + Math.sqrt(opt.size) / 6) : 6), trail: 3, dur: 640 };
  let i = 0;
  const next = () => {
    if (i >= segs.length) return done();
    const [a, b, rev] = segs[i++], path = cords[a + ">" + b];
    if (path) {
      path.classList.add("fired");
      path.style.stroke = COLOR[verb];
      setTimeout(() => { path.classList.remove("fired"); path.style.stroke = ""; }, 700);
    }
    travel(path, COLOR[verb], { ...style, rev, label: opt.label }, () => { if (i < segs.length) flash(rev ? a : b, verb); next(); });
  };
  next();
}

// ---------- State from the server ----------
function adopt(next: State) {
  const first = !S;
  S = next;
  // The WEAVE repo's own map would read "WEAVE WEAVE", so drop the chip when it repeats the mark.
  const self = next.project.toLowerCase() === "weave";
  $("project").textContent = next.project;
  $("project").hidden = self;
  document.title = self ? "WEAVE" : `${next.project} · WEAVE`;
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
  renderEditing();
  renderSuggestions();
  renderSettings();
}

let retry = 500;
function connect() {
  const ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`);
  const conn = $("conn");
  const status = (cls: string, text: string) => { conn.className = "conn " + cls; conn.title = text; conn.setAttribute("aria-label", text); };
  ws.onopen = () => { retry = 500; status("on", "Live: connected to the local WEAVE server"); };
  ws.onmessage = (m) => {
    const msg = JSON.parse(m.data);
    if (msg.type === "state") adopt(msg);
    else if (msg.type === "history") (msg.events as Activity[]).forEach((e) => onActivity(e, false));
    else if (msg.type === "activity") (msg.events as Activity[]).forEach((e) => onActivity(e, true));
  };
  ws.onclose = () => {
    status("off", "Offline: reconnecting to the local WEAVE server");
    setTimeout(connect, retry);
    retry = Math.min(retry * 2, 8000);
  };
}
addEventListener("resize", () => fit());
inspect();
connect();
