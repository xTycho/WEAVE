import "@xterm/xterm/css/xterm.css";
import "./styles.css";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { MODE_FRAMES, paintFrame, resolvePreset } from "thinking-orbs/engine";
import { curve, hull, layout, type Placed } from "./layout";

// ---------- Types shared with the server ----------
type Tier = "core" | "feature" | "element";
type Kind = "core" | "feature" | "code" | "design" | "doc" | "test" | "tool";
type Verb = "Read" | "Edit" | "Run" | "PR";
type Level = "ok" | "delegate" | "compact" | "clear";
interface WNode { id: string; label: string; tier: Tier; kind: Kind; paths: string[]; of: string[]; bytes: number; tokens: number; command?: string }
interface Area { id: string; name: string; agent: string; features: string[]; folders: string[]; files: string[]; tokens: number; threads: number; from: "usage" | "folders"; hasAgent: boolean }
interface Meter { level: Level; tokens?: number; window: number; share: number; stale: number; text?: string; agent?: string }
interface Thread { id: string; name: string; startedAt: number; lastSeen: number; contextTokens?: number; meter: Meter }
interface Settings { window: number; compactAt: number; meter: boolean; fresh: "command" | "thread"; autoCompact: boolean }
interface State {
  project: string;
  map: { nodes: WNode[]; settings: Settings };
  areas: Area[];
  threads: Thread[];
  chat: { id: string; name: string; exited?: number } | null;
}
interface Activity { t: number; s: string; ph?: "start" | "end"; verb: Verb; node: string; path?: string; sub?: boolean }
type Node = WNode & Placed;

const KIND: Record<Kind, { tag: string; c: string }> = {
  core: { tag: "Core", c: "var(--foil)" },
  feature: { tag: "Folder", c: "var(--p-violet)" },
  code: { tag: "Code", c: "var(--p-blue)" },
  design: { tag: "Design", c: "var(--p-pink)" },
  doc: { tag: "Doc", c: "var(--p-lime)" },
  test: { tag: "Test", c: "var(--p-peach)" },
  tool: { tag: "Tool", c: "var(--p-rose)" },
};
const COLOR: Record<string, string> = { Read: "#A3A9E6", Edit: "#E9A6D2", Run: "#F6BE8A", PR: "#CFE19C" };
const VERB_ING: Record<Verb, string> = { Read: "Reading", Edit: "Editing", Run: "Running", PR: "Opening PR" };
const ORB: Record<Verb, string> = { Read: "searching", Edit: "composing", Run: "working", PR: "weaving" };
const PALETTE = ["#A3A9E6", "#E9A6D2", "#CFE19C", "#F6BE8A", "#C3A5DD", "#F1A9B0", "#8FC3E6", "#B4D8B0"];
const LEVEL: Record<Level, string> = { ok: "", delegate: "Hand off", compact: "/compact", clear: "/clear" };

// ---------- Small helpers ----------
const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const NS = "http://www.w3.org/2000/svg";
const esc = (s: unknown) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const fmt = (v: number) => (v >= 1000 ? (v / 1000).toFixed(v >= 100_000 ? 0 : 1) + "k" : String(v));
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
/** The area the map highlights; empty shows every area. */
let A = store.get("weave.area") ?? "";
let selected: string | null = null;
let hits = new Set<string>();
const els: Record<string, HTMLDivElement> = {};
const cords: Record<string, SVGPathElement> = {};
const world = $("world"), stage = $("stage");
const gC = $("cords") as unknown as SVGGElement, gH = $("hulls") as unknown as SVGGElement, gPulse = $("pulses") as unknown as SVGGElement;
const posKey = () => `weave.pos.${S?.project ?? ""}`;
let pinned: Record<string, [number, number]> = {};

const area = (): Area | undefined => S?.areas.find((a) => a.id === A);
const colorOf = (a: Area | undefined) => (a && S ? PALETTE[S.areas.indexOf(a) % PALETTE.length] : "var(--line-2)");
const featureOf = (n: WNode) => (n.tier === "feature" ? n.id : n.of[0]);
const areaOfNode = (n: WNode) => { const f = featureOf(n); return f ? S?.areas.find((a) => a.features.includes(f)) : undefined; };
const inArea = (n: WNode, a = area()) => !a || n.tier === "core" || a.features.includes(featureOf(n) ?? "");

/** Threads are "Thread <n>" until renamed; old names may still hold wrapper blocks and tags, which are not a name. */
const WRAPPERS = /<(system-reminder|relay|wake|note|project_claude_message|task-notification|agent-message|command-[\w-]+|local-command-[\w-]+)\b[^>]*>[\s\S]*?<\/\1\b[^>]*>/gi;
function threadLabel(t: Thread): string {
  const clean = t.name.replace(WRAPPERS, " ").replace(/<(system-reminder|relay|wake|note|project_claude_message|task-notification|agent-message|command-[\w-]+|local-command-[\w-]+)\b[\s\S]*$/i, " ")
    .replace(/<\/?[a-z][\w-]*\b[^>]*>?/gi, " ").replace(/\s+/g, " ").trim();
  return clean || "Thread";
}
const featTokens = (f: WNode) => N.filter((e) => e.tier === "element" && e.of[0] === f.id).reduce((s, e) => s + e.tokens, 0);

// ---------- Build and draw ----------
const ACT = '<span class="act" aria-live="polite"><canvas width="32" height="32" aria-hidden="true"></canvas><span class="lbl"></span><span class="sec"></span></span>';

function metaPath(n: WNode) {
  if (n.kind === "tool") return n.command ?? "";
  if (n.tier === "feature") return n.paths[0] ?? "project root";
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
    const path = document.createElementNS(NS, "path");
    path.setAttribute("d", curve(a, b));
    path.setAttribute("class", "cord " + (inArea(a) && inArea(b) ? "live" : "off"));
    gC.append(path);
    cords[p + ">" + c] = path;
  }
  for (const n of N) {
    const d = els[n.id];
    if (!d) continue;
    const on = inArea(n);
    d.style.left = n.x + "px";
    d.style.top = n.y + "px";
    d.classList.toggle("live", on);
    d.classList.toggle("off", !on);
    d.classList.toggle("sel", selected === n.id);
    d.classList.toggle("match", hits.has(n.id));
    const box = d.querySelector<HTMLElement>(".sets")!, a = n.tier === "core" ? undefined : areaOfNode(n);
    const html = a ? `<i class="${a.id === A ? "cur" : ""}" style="--c:${colorOf(a)}"></i>` : "";
    if (box.dataset.h !== html) { box.innerHTML = html; box.dataset.h = html; box.title = a?.name ?? ""; }
  }
  drawHull();
  header();
}

function drawHull() {
  gH.innerHTML = "";
  const a = area();
  if (!a) return;
  const pts: [number, number][] = [];
  for (const n of N) {
    if (n.tier === "core" || !inArea(n, a)) continue;
    const w = n.tier === "feature" ? 104 : 94;
    pts.push([n.x - w, n.y - 36], [n.x + w, n.y - 36], [n.x - w, n.y + 36], [n.x + w, n.y + 36]);
  }
  const h = hull(pts);
  if (h.length < 3) return;
  const p = document.createElementNS(NS, "path");
  p.setAttribute("d", "M" + h.map((x) => x.join(",")).join("L") + "Z");
  p.setAttribute("class", "hull");
  gH.append(p);
}

/** One bar for the project: each area's share of the mapped tokens, in its colour. */
function header() {
  const all = N.reduce((s, n) => s + n.tokens, 0) || 1, a = area();
  $("mview").textContent = a ? a.name : "All areas";
  $("tok").textContent = a ? ` · ~${fmt(a.tokens)} of ~${fmt(all)}` : ` · ~${fmt(all)} mapped`;
  $("mbar").innerHTML = S!.areas.map((x) => `<i class="seg" style="width:${(x.tokens / all) * 100}%;background:${colorOf(x)};opacity:${!a || x.id === a.id ? 1 : 0.25}"></i>`).join("");
  $("meter").title = "Each area's share of the project's estimated tokens (file size ÷ 4).";
}

// ---------- Interaction ----------
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
  box.hidden = !n || !S;
  if (!n || !S) return;
  const parents = n.of.map((p) => byId.get(p)?.label ?? p).join(", ");
  const kids = n.tier === "feature" ? N.filter((e) => e.of.includes(n.id)).length : 0;
  const tok = n.tier === "feature" ? featTokens(n) : n.tokens;
  const a = n.tier === "core" ? undefined : areaOfNode(n);
  box.innerHTML = `<div class="ihead"><h2 class="cap">${KIND[n.kind].tag} node</h2><button class="x" id="ix" aria-label="Close">×</button></div>
    <b class="iname">${esc(n.label)}</b>
    <dl><dt>Path</dt><dd>${esc(metaPath(n))}</dd>
    ${tok ? `<dt>Tokens</dt><dd>~${fmt(tok)} (estimate)</dd>` : ""}
    ${parents ? `<dt>Used by</dt><dd>${esc(parents)}</dd>` : ""}${kids ? `<dt>Elements</dt><dd>${kids}</dd>` : ""}
    ${n.tier === "core" ? "<dt>Area</dt><dd>Every thread sees the core</dd>" : a ? `<dt>Area</dt><dd>${esc(a.name)}</dd><dt>Subagent</dt><dd>${a.hasAgent ? `<code>${esc(a.agent)}</code>` : "None (small area)"}</dd>` : ""}</dl>`;
  box.querySelector("#ix")!.addEventListener("click", () => { selected = null; draw(); inspect(); });
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
  view.s = Math.min(r.width / w, r.height / h, 1.1);
  view.x = r.width / 2 - ((Math.max(...xs) + Math.min(...xs)) / 2) * view.s;
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
  if (t.closest("button,input,select,.zoom")) return;
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

// ---------- Areas and threads ----------
const working = (session: string) => [...active.values()].some((a) => a.session === session) || Date.now() - (S?.threads.find((t) => t.id === session)?.lastSeen ?? 0) < 60_000;
/** What a thread is doing right now, for its orb. */
const threadVerb = (session: string): Verb | undefined => [...active.values()].filter((a) => a.session === session).sort((a, b) => b.start - a.start)[0]?.verb;

function renderAreas() {
  if (!S) return;
  const box = $("alist");
  box.innerHTML = "";
  for (const a of S.areas) {
    const li = document.createElement("li"), b = document.createElement("button");
    li.className = a.id === A ? "cur" : "";
    b.className = "pick";
    b.setAttribute("aria-pressed", String(a.id === A));
    b.title = [`Folders: ${a.folders.join(", ") || "root files"}`, a.files.length ? `Most used: ${a.files.join(", ")}` : "",
      a.from === "usage" ? `${a.threads} thread${a.threads === 1 ? "" : "s"} worked here.` : "No thread has worked here yet, so this is just a folder.",
      a.hasAgent ? `Subagent: ${a.agent}` : "Too small for its own subagent."].filter(Boolean).join("\n");
    b.innerHTML = `<span class="dot" style="background:${colorOf(a)}"></span><b>${esc(a.name)}</b>${a.hasAgent ? `<span class="def">${esc(a.agent)}</span>` : ""}<em>${fmt(a.tokens)}</em>`;
    b.onclick = () => { A = A === a.id ? "" : a.id; store.set("weave.area", A); selected = null; renderAll(); };
    li.appendChild(b);
    box.appendChild(li);
  }
  if (!S.areas.length) box.innerHTML = '<li class="empty">No areas yet. Run `weave scan` in the project folder.</li>';
}

const ICON_TERM = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="m3.5 5 3 3-3 3M8 11.5h4.5"/></svg>';
const ICON_END = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="m4.5 4.5 7 7M11.5 4.5l-7 7"/></svg>';
/** Threads seen in the last day get a row; older ones fold under "older". */
const RECENT = 864e5;
/** A thread used in the last ACTIVE ms gets an Active tag and sorts to the top. */
const MIN = 60_000, ACTIVE = 10 * MIN;
const isActive = (t: Thread) => working(t.id) || Date.now() - t.lastSeen < ACTIVE;
let showOld = false;
/** The thread whose name is being typed; a live update must not wipe it. */
let naming: string | null = null;

/** One line per thread: what it is doing, its name, how full its window is, and the meter's advice. */
function threadRow(t: Thread): HTMLLIElement {
  const li = document.createElement("li");
  const verb = threadVerb(t.id), name = threadLabel(t), live = working(t.id), m = t.meter, tok = m.tokens ?? 0;
  const level = m.level === "clear" || m.level === "compact" ? "ctx-full" : m.level === "delegate" ? "ctx-heavy" : "ctx-ok";
  li.className = "thread" + (verb ? " busy" : live ? " live" : "") + ` ${level}`;
  li.style.setProperty("--c", "var(--p-violet)");
  li.style.setProperty("--fill", String(Math.min(1, m.share)));
  const state = verb ? VERB_ING[verb] : live ? "Working" : `Idle since ${new Date(t.lastSeen).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
  const size = tok ? `${fmt(tok)} of ${fmt(m.window)} tokens (${Math.round(m.share * 100)}%).${m.stale ? ` ~${fmt(m.stale)} of it is files it moved on from.` : ""}` : "Context size not read yet.";
  const tip = `${name}\n${state}. ${size}${m.text ? `\n${m.text}` : ""}\nDouble-click to rename.`;
  li.innerHTML = `<span class="ticon"><canvas class="orb" width="32" height="32" data-session="${esc(t.id)}" aria-hidden="true"></canvas><i></i></span>`
    + `<button class="tmain" title="${esc(tip)}">${esc(name)}</button>`
    + `<span class="tbar" title="${esc(size)}"><i></i><small>${tok ? fmt(tok).replace(/\.\dk$/, "k") : ""}</small></span>`
    + (LEVEL[m.level] ? `<span class="advice" title="${esc(m.text ?? "")}">${esc(LEVEL[m.level])}</span>` : "<span hidden></span>")
    + (isActive(t) ? `<span class="active" title="Used in the last ${ACTIVE / MIN} minutes">Active</span>` : "<span hidden></span>")
    + `<button class="ibtn term" title="Reopen this thread in a terminal window" aria-label="Open ${esc(name)} in a terminal">${ICON_TERM}</button>`
    + `<button class="ibtn end" title="End thread: clear it from the map. Areas keep what it taught them." aria-label="End thread ${esc(name)}">${ICON_END}</button>`;
  const main = li.querySelector<HTMLButtonElement>(".tmain")!;
  main.addEventListener("dblclick", () => {
    naming = t.id;
    const input = Object.assign(document.createElement("input"), { className: "tname", value: name, maxLength: 80 });
    input.setAttribute("aria-label", "Thread name");
    main.replaceWith(input);
    input.focus();
    input.select();
    const end = (save: boolean) => {
      if (naming !== t.id) return;
      naming = null;
      const v = input.value.trim();
      if (save && v && v !== name) api("/api/threads/rename", { thread: t.id, name: v }).catch((err) => toast(err.message));
      else renderThreads();
    };
    input.addEventListener("keydown", (e) => { if (e.key === "Enter") end(true); if (e.key === "Escape") end(false); });
    input.addEventListener("blur", () => end(true));
  });
  li.querySelector(".ibtn.term")!.addEventListener("click", () => {
    api("/api/terminal", { resume: t.id }).then(() => toast("Terminal opened.")).catch((e) => toast(e.message));
  });
  li.querySelector(".ibtn.end")!.addEventListener("click", () => {
    api("/api/threads/end", { thread: t.id }).then(() => toast("Thread cleared. Areas keep what it taught them.")).catch((e) => toast(e.message));
  });
  return li;
}

function renderThreads() {
  if (!S) return;
  const fresh = S.map.settings.fresh === "thread";
  LEVEL.compact = fresh ? "New thread" : "/compact";
  LEVEL.clear = fresh ? "New thread" : "/clear";
  if (naming && document.activeElement?.closest?.("#tlist .tname")) return;
  const box = $("tlist");
  box.innerHTML = "";
  const recent = (t: Thread) => working(t.id) || Date.now() - t.lastSeen < RECENT;
  const list = S.threads.filter((t) => showOld || recent(t)).sort((x, y) => Number(isActive(y)) - Number(isActive(x)) || y.lastSeen - x.lastSeen);
  list.forEach((t) => box.appendChild(threadRow(t)));
  const old = S.threads.filter((t) => !recent(t)).length;
  if (old) {
    const more = document.createElement("li");
    more.className = "older";
    more.innerHTML = `<button class="fold">${showOld ? "Hide" : "Show"} ${old} older thread${old === 1 ? "" : "s"}</button><button class="clear" title="Clear every thread idle for over a day.">Clear</button>`;
    more.querySelector<HTMLButtonElement>(".fold")!.onclick = () => { showOld = !showOld; renderThreads(); };
    more.querySelector<HTMLButtonElement>(".clear")!.onclick = () => api("/api/threads/end", { older: true }).then((n) => toast(`Cleared ${n} older thread${n === 1 ? "" : "s"}.`)).catch((e) => toast(e.message));
    box.appendChild(more);
  }
  if (!S.threads.length) box.innerHTML = '<li class="empty">No threads yet. They appear here once Claude Code runs in this project with the WEAVE hooks.</li>';
}

$("agents").onclick = () => api("/api/agents").then((r) => toast(`Subagents: ${r.written.length} written, ${r.removed.length} removed.`)).catch((e) => toast(e.message));
$("newterm").onclick = () => api("/api/terminal", {}).then((name) => toast(`Opened a terminal for ${name}.`)).catch((e) => toast(e.message));
$("rescan").onclick = () => api("/api/rescan").then(() => toast("Rescanned the project.")).catch((e) => toast(e.message));

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

// ---------- Settings ----------
function renderSettings() {
  if (!S) return;
  const st = S.map.settings;
  $("meterOn").setAttribute("aria-checked", String(st.meter));
  $("meterOn").onclick = () => api("/api/settings", { meter: !st.meter }).catch((e) => toast(e.message));
  document.querySelectorAll<HTMLButtonElement>("#window button").forEach((b) => {
    b.setAttribute("aria-pressed", String(Number(b.dataset.v) === st.window));
    b.onclick = () => api("/api/settings", { window: Number(b.dataset.v) }).catch((e) => toast(e.message));
  });
  document.querySelectorAll<HTMLButtonElement>("#fresh button").forEach((b) => {
    b.setAttribute("aria-pressed", String(b.dataset.v === st.fresh));
    b.onclick = () => api("/api/settings", { fresh: b.dataset.v }).catch((e) => toast(e.message));
  });
  $("autoCompact").setAttribute("aria-checked", String(st.autoCompact));
  $("autoCompact").onclick = () => api("/api/settings", { autoCompact: !st.autoCompact }).catch((e) => toast(e.message));
  const input = $<HTMLInputElement>("compactAt");
  // A live update must not overwrite a number being typed.
  if (document.activeElement !== input) input.value = String(Math.round(st.compactAt * 100));
  input.onchange = () => api("/api/settings", { compactAt: Number(input.value) / 100 }).catch((e) => toast(e.message));
}

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
    ? "Your device asks apps to reduce motion, so signals are paused."
    : "Pause signals when your device asks apps to reduce motion.";
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
/** History: one compact row per action, newest first. The file, the time, and a dot in the colour of its area. */
function log(e: Activity) {
  const n = byId.get(e.node);
  if (!n) return;
  const t = S?.threads.find((x) => x.id === e.s), who = (t ? threadLabel(t) : "claude") + (e.sub ? " · subagent" : "");
  const what = n.tier === "element" && n.kind !== "tool" ? e.path ?? n.paths[0] ?? n.label : n.label;
  const file = what.split("/").pop() || what;
  const time = new Date(e.t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  const li = document.createElement("li");
  li.innerHTML = `<button class="hrow" disabled><span class="verb" style="--vc:${COLOR[e.verb] ?? "var(--line-2)"}">${esc(e.verb)}</span><code title="${esc(what)}">${esc(file)}</code><time>${time}</time><i class="who" style="--c:${colorOf(areaOfNode(n))}" title="${esc(who)}"></i></button>`;
  feedEl.querySelector(".empty")?.remove();
  feedEl.prepend(li);
  while (feedEl.children.length > 12) feedEl.lastChild!.remove();
}

interface Act { verb: Verb; start: number; until: number; session: string }
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
      d.style.setProperty("--ac", COLOR[a.verb]);
      tab.querySelector(".lbl")!.textContent = VERB_ING[a.verb];
      tab.querySelector(".sec")!.textContent = "";
    }
  }
  renderLive();
}
setInterval(paintActs, 250);

/** Live: what threads touched in the last few seconds, as a folder tree that follows the route of the signals on the map. */
let liveSig = "";
function renderLive() {
  const box = $("live");
  const now = Date.now();
  const running = [...active.entries()].filter(([id, a]) => now <= a.until && byId.has(id)).sort((x, y) => x[1].start - y[1].start);
  const sig = running.map(([id, a]) => `${id}|${a.verb}|${a.session}`).join(";");
  if (sig === liveSig && S) return;
  liveSig = sig;
  if (!running.length || !S) { box.innerHTML = '<p class="empty">Nothing running right now.</p>'; return; }
  box.innerHTML = tree(running.map(([id, a]) => ({ id, verb: a.verb, session: a.session })));
}

function tree(items: { id: string; verb: Verb; session: string }[]): string {
  if (!S || !byId.get("core")) return "";
  interface Branch { id: string; label: string; color: string; kids: Map<string, Branch>; leaf?: { verb: Verb; session: string } }
  const root: Branch = { id: "core", label: S.project, color: "", kids: new Map() };
  for (const a of items) {
    const n = byId.get(a.id);
    if (!n) continue;
    let at = root;
    for (const step of route(n).map(([, to]) => to)) {
      if (!at.kids.has(step)) { const s = byId.get(step); at.kids.set(step, { id: step, label: s?.tier === "feature" ? (s.paths[0] ?? s.label) : s?.label ?? step, color: "", kids: new Map() }); }
      at = at.kids.get(step)!;
      at.color ||= COLOR[a.verb];
    }
    at.leaf = { verb: a.verb, session: a.session };
    root.color ||= COLOR[a.verb];
  }
  const paint = (b: Branch): string => {
    const kids = [...b.kids.values()].map((k) => `<li style="--vc:${k.color}">${paint(k)}</li>`).join("");
    const sub = kids ? `<ul>${kids}</ul>` : "";
    if (b.leaf) {
      const t = S!.threads.find((x) => x.id === b.leaf!.session), who = t ? threadLabel(t) : "claude";
      return `<span class="leaf"><canvas class="orb" width="32" height="32" data-verb="${esc(b.leaf.verb)}" aria-hidden="true"></canvas><b title="${esc(byId.get(b.id)?.paths[0] ?? b.label)}">${esc(b.label)}</b><small><span>${esc(VERB_ING[b.leaf.verb])}</span></small><i class="who" style="--c:var(--line-2)" title="${esc(who)}"></i></span>${sub}`;
    }
    return `<span class="fold"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M1.5 4.5a1 1 0 0 1 1-1h3.6l1.4 1.5h6a1 1 0 0 1 1 1v6.5a1 1 0 0 1-1 1h-11a1 1 0 0 1-1-1z"/></svg>${esc(b.label)}</span>${sub}`;
  };
  return `<ul class="tree"><li style="--vc:${root.color}">${paint(root)}</li></ul>`;
}

function drawOrb(c: HTMLCanvasElement | null | undefined, verb: Verb, t: number | null) {
  const ctx = c?.getContext("2d");
  if (!ctx) return;
  const { mode, speed, opts } = resolvePreset(ORB[verb] as never, 20 as never);
  ctx.setTransform(1.6, 0, 0, 1.6, 0, 0);
  ctx.clearRect(0, 0, 20, 20);
  // Each orb takes the pastel of what it is doing; on a dark page its near dots turn light instead of dark.
  const hex = COLOR[verb], tint = { r: parseInt(hex.slice(1, 3), 16), g: parseInt(hex.slice(3, 5), 16), b: parseInt(hex.slice(5, 7), 16) };
  paintFrame(ctx, MODE_FRAMES[mode](20, reduce || t === null ? 0.6 : (t / 1000) * speed, opts), isDark(), tint);
}
function orbLoop(now: number) {
  active.forEach((a, id) => drawOrb(els[id]?.querySelector<HTMLCanvasElement>(".act canvas"), a.verb, now));
  document.querySelectorAll<HTMLCanvasElement>("canvas.orb").forEach((c) => {
    const v = c.dataset.session ? threadVerb(c.dataset.session) : (c.dataset.verb as Verb);
    if (v) drawOrb(c, v, now);
  });
  requestAnimationFrame(orbLoop);
}
requestAnimationFrame(orbLoop);

function route(n: WNode): [string, string][] {
  if (n.tier === "core") return [];
  if (n.tier === "feature") return [["core", n.id]];
  const v = n.of.find((f) => byId.has(f));
  return v ? [["core", v], [v, n.id]] : [["core", n.id]];
}
const back = (segs: [string, string][]) => segs.slice().reverse().map(([a, b]) => [a, b, true] as [string, string, boolean]);

function onActivity(e: Activity, animate: boolean) {
  // Logs from WEAVE 1 also hold "start" lines; every action has an end line.
  if (e.ph === "start") return;
  const n = byId.get(e.node);
  if (!n || !S) return;
  log(e);
  if (e.verb === "Edit") { if (!edited.has(e.s)) edited.set(e.s, new Set()); edited.get(e.s)!.add(n.id); }
  if (!animate) return;
  if (n.tier !== "core") active.set(n.id, { verb: e.verb, start: e.t, until: Date.now() + 2500, session: e.s });
  paintActs();
  if (e.verb === "Read") signal(back(route(n)), "Read", { label: n.tokens ? `+${fmt(n.tokens)} tokens${e.sub ? " · subagent" : ""}` : "read", size: n.tokens }, () => flash("core", "Read"));
  else if (e.verb === "Edit") signal(route(n), "Edit", { label: "edit" }, () => flash(n.id, "Edit"));
  else if (e.verb === "Run") signal(back(route(n)), "Run", { label: "output" }, () => flash(n.id, "Run"));
  else if (e.verb === "PR") {
    const changed = [...(edited.get(e.s) ?? [])].map((id) => byId.get(id)).filter((x): x is Node => !!x);
    let left = changed.length;
    const send = () => signal(route(n), "PR", { label: `PR · ${changed.length} file${changed.length === 1 ? "" : "s"}`, size: 400 * Math.max(1, changed.length) }, () => { flash(n.id, "PR"); edited.delete(e.s); });
    if (!left) send();
    else changed.forEach((c) => signal(back(route(c)), "PR", { r: 4 }, () => { if (--left === 0) send(); }));
  }
}

function flash(id: string, verb: string) {
  const d = els[id];
  if (!d) return;
  d.style.setProperty("--ring", COLOR[verb]);
  d.classList.remove("fire");
  void d.offsetWidth;
  d.classList.add("fire");
}
interface TravelOpts { r: number; trail?: number; dur: number; opacity?: number; rev?: boolean; label?: string | null }
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
    const t = Math.min(1, (now - t0) / o.dur), e = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
    dots.forEach((c, k) => { const p = at(Math.max(0, e - k * 0.035)); c.setAttribute("cx", String(p.x)); c.setAttribute("cy", String(p.y)); });
    if (lab) { const p = at(e); lab.setAttribute("x", String(p.x + o.r + 6)); lab.setAttribute("y", String(p.y - o.r - 4)); }
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
  // A `weave ui` started before an update still sends the old state; say so instead of drawing a broken map.
  if (!Array.isArray(next.areas) || !next.map?.settings || !("window" in next.map.settings)) {
    world.querySelectorAll(".node,.empty-map").forEach((n) => n.remove());
    world.insertAdjacentHTML("beforeend", '<div class="empty-map">The running WEAVE server is older than this page. Stop it (Ctrl+C) and run `weave ui` again.</div>');
    return;
  }
  const first = !S;
  S = next;
  // The WEAVE repo's own map would read "WEAVE WEAVE", so drop the chip when it repeats the mark.
  const self = next.project.toLowerCase() === "weave";
  $("project").textContent = next.project;
  $("project").hidden = self;
  document.title = self ? "WEAVE" : `${next.project} · WEAVE`;
  if (A && !next.areas.some((a) => a.id === A)) A = "";
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
  renderAreas();
  renderThreads();
  renderSettings();
  renderChat();
}

// ---------- Embedded chat ----------
// Claude Code runs on this PC behind the local server; this is only its screen and keyboard.
let term: Terminal | undefined, fitter: FitAddon | undefined, chatWs: WebSocket | undefined, chatId = "", chatShown = false;
const sendChat = (msg: unknown) => { if (chatWs?.readyState === WebSocket.OPEN) chatWs.send(JSON.stringify(msg)); };
function fitChat() {
  if (!term || !fitter || !chatShown) return;
  try { fitter.fit(); } catch { /* not laid out yet */ }
}
function attachChat(id: string) {
  if (chatId !== id || !term) {
    term?.dispose();
    $("cterm").innerHTML = "";
    const css = getComputedStyle(document.documentElement);
    term = new Terminal({ cursorBlink: true, fontSize: 13, fontFamily: "ui-monospace, Consolas, monospace", scrollback: 5000,
      theme: { background: css.getPropertyValue("--bg").trim() || "#0A0B0D", foreground: css.getPropertyValue("--fg").trim() || "#F0F0F1" } });
    fitter = new FitAddon();
    term.loadAddon(fitter);
    term.open($("cterm"));
    term.onData((data) => sendChat({ type: "input", data }));
    term.onResize(({ cols, rows }) => sendChat({ type: "resize", cols, rows }));
    chatId = id;
  }
  chatWs?.close();
  const ws = chatWs = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/pty`);
  ws.onopen = () => { term?.reset(); fitChat(); if (term) sendChat({ type: "resize", cols: term.cols, rows: term.rows }); };
  ws.onmessage = (m) => {
    const msg = JSON.parse(m.data);
    if (msg.type === "output") term?.write(msg.data);
    else if (msg.type === "exit") term?.write(`
[Claude Code exited with code ${msg.code}]
`);
  };
  ws.onclose = () => { if (chatWs === ws) chatWs = undefined; };
}
function renderChat() {
  const c = S?.chat, live = !!c && c.exited === undefined;
  $("chatbtn").textContent = live ? (chatShown ? "Hide chat" : "Show chat") : "Open chat";
  $("chat").hidden = !(chatShown && c);
  if (!c) { chatWs?.close(); chatWs = undefined; term?.dispose(); term = undefined; chatId = ""; chatShown = false; $("chatbtn").textContent = "Open chat"; return; }
  $("chatname").textContent = c.name;
  const t = S!.threads.find((x) => x.id === c.id), m = t?.meter;
  $("chatctx").textContent = m?.tokens ? `${Math.round(m.share * 100)}% of window (${fmt(m.tokens)})` : "";
  const level = live && S!.map.settings.meter ? m?.level : undefined;
  $("chatcompact").hidden = level !== "compact";
  $("chatclear").hidden = level !== "clear";
  if (live && chatShown && (chatId !== c.id || !chatWs)) attachChat(c.id);
  if (chatShown) requestAnimationFrame(fitChat);
}
$("chatbtn").onclick = async () => {
  try {
    if (!S?.chat) await api("/api/chat/open", {});
    chatShown = !(chatShown && S?.chat);
    renderChat();
  } catch (e) { toast((e as Error).message); }
};
$("chathide").onclick = () => { chatShown = false; renderChat(); };
$("chatclose").onclick = () => api("/api/chat/close").then(() => toast("Chat closed.")).catch((e) => toast(e.message));
$("chatcompact").onclick = () => api("/api/chat/command", { command: "compact" }).then(() => toast("Sent /compact.")).catch((e) => toast(e.message));
$("chatclear").onclick = () => api("/api/chat/command", { command: "clear" }).then(() => toast("Sent /clear.")).catch((e) => toast(e.message));
new ResizeObserver(() => fitChat()).observe($("cterm"));

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
