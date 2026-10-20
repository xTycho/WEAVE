import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, rmSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ContextStore, scanProject, listenWithFallback, attach, detach, isLive, getPreset, findNode, nodeForPath,
  windowNote, spinUp, handleHook, suggestions, recentEvents, heat, warmth, HALF_LIFE, saveKey,
  overdue, OVERDUE_DAYS, sleep, presetFromHeat, tagFor, threadName, readKey, removeKey, tokenMode, startDashboard,
  frozen, frozenLine, FREEZE_AFTER, FROZEN_CHARS, contextLevel, thresholds, normalizeMap, appendEvent, readThreads,
} from "../dist/index.js";
import { createTools } from "../dist/mcp/tools.js";

function write(root, rel, text) {
  mkdirSync(join(root, rel, ".."), { recursive: true });
  writeFileSync(join(root, rel), text);
}

/** A small real-looking project: two features under src/, a shared util, a test and a tsconfig alias. */
function project() {
  const root = mkdtempSync(join(tmpdir(), "weave-test-"));
  write(root, "CLAUDE.md", "# rules\n");
  write(root, "package.json", JSON.stringify({ name: "demo", scripts: { test: "node --test test/", "build:ui": "vite build src/ui" } }));
  write(root, "tsconfig.json", '{ "compilerOptions": { "baseUrl": ".", "paths": { "@lib/*": ["src/lib/*"] } } // comment\n}');
  write(root, "src/ui/App.tsx", 'import { fmt } from "@lib/format";\nimport "./theme.css";\nexport const App = () => fmt(1);\n');
  write(root, "src/ui/theme.css", "body{}\n");
  write(root, "src/api/server.ts", 'import { fmt } from "../lib/format.js";\nexport const serve = () => fmt(2);\n');
  write(root, "src/lib/format.ts", "export const fmt = (n: number) => String(n);\n");
  write(root, "test/format.test.ts", 'import { fmt } from "../src/lib/format";\n');
  write(root, "docs/guide.md", "# guide\n");
  return root;
}

test("scanner builds three layers from real files, with shared elements and links", () => {
  const root = project();
  const { nodes, links } = scanProject(root);
  const by = Object.fromEntries(nodes.map((n) => [n.id, n]));
  assert.deepEqual(by.core.paths.sort(), ["CLAUDE.md", "package.json"]);
  assert.ok(["src/ui", "src/api", "src/lib", "test", "docs", "(root)"].every((f) => by[f]?.tier === "feature"));
  assert.deepEqual(by["src/lib/format.ts"].of.sort(), ["src/api", "src/lib", "src/ui"], "alias and relative imports both share the util");
  assert.equal(by["src/ui/theme.css"].kind, "design");
  assert.equal(by["test/format.test.ts"].kind, "test");
  assert.ok(by["test/format.test.ts"].of.includes("src/lib"), "a test joins the feature it tests");
  assert.ok(links.some((l) => l.from === "test/format.test.ts" && l.to === "src/lib/format.ts" && l.why === "tests"));
  assert.deepEqual(by["tool:build:ui"].of, ["src/ui"]);
  assert.equal(nodes.some((n) => n.label.toLowerCase().includes("mock")), false);
  write(root, ".gitignore", "CLAUDE.md\n");
  assert.ok(scanProject(root).nodes[0].paths.includes("CLAUDE.md"), "an ignored CLAUDE.md stays in the core");
  rmSync(root, { recursive: true, force: true });
});

test("big features fold sub-folders into one node each", () => {
  const root = mkdtempSync(join(tmpdir(), "weave-test-"));
  for (let i = 0; i < 30; i++) write(root, `engine/part${i % 3}/f${i}.js`, "x\n");
  const { nodes } = scanProject(root);
  const els = nodes.filter((n) => n.tier === "element" && n.kind !== "tool");
  assert.deepEqual(els.map((n) => n.id).sort(), ["engine/part0/", "engine/part1/", "engine/part2/"]);
  rmSync(root, { recursive: true, force: true });
});

test("missing or corrupt map rebuilds from a scan without throwing", () => {
  const root = project();
  const store = new ContextStore(root);
  assert.equal(store.load().source, "scan");
  mkdirSync(join(root, ".claude"), { recursive: true });
  writeFileSync(store.mapPath, "{nope");
  const loaded = store.load();
  assert.equal(loaded.source, "scan");
  assert.match(loaded.warning, /unreadable/);
  assert.equal(new ContextStore(root).load(false).map.nodes.length, 0, "hooks never scan");
  rmSync(root, { recursive: true, force: true });
});

test("presets attach and detach without touching project files", () => {
  const root = project();
  const store = new ContextStore(root);
  const map = store.rescan();
  const before = readFileSync(join(root, "CLAUDE.md"), "utf8");
  const p = getPreset(map);
  assert.ok(isLive(findNode(map, "src/lib/format.ts"), p));
  detach(map, p.id, "src/ui");
  detach(map, p.id, "src/api");
  detach(map, p.id, "src/lib");
  assert.equal(isLive(findNode(map, "src/lib/format.ts"), p), false);
  attach(map, p.id, "src/lib/format.ts");
  assert.ok(p.features.includes("src/lib"), "attaching an orphan element brings its first feature");
  assert.throws(() => detach(map, p.id, "core"));
  assert.equal(nodeForPath(map, "src/ui/App.tsx").id, "src/ui/App.tsx");
  assert.match(windowNote(map, p), /Attached: .*src\/lib\//);
  assert.equal(readFileSync(join(root, "CLAUDE.md"), "utf8"), before);
  rmSync(root, { recursive: true, force: true });
});

test("a new feature from a design node can bring a saved window", () => {
  const root = project();
  const store = new ContextStore(root);
  const { map } = store.update((m) => {
    const narrow = { id: "api-only", name: "API only", color: "#000", features: ["src/api"], detached: [], changedAt: {} };
    m.presets.push(narrow);
    spinUp(m, undefined, "src/ui/theme.css", "Dark mode", "api-only");
  });
  const reloaded = store.rescan();
  const f = reloaded.nodes.find((n) => n.label === "Dark mode");
  assert.ok(f?.custom);
  assert.ok(findNode(reloaded, "src/ui/theme.css").of.includes(f.id), "survives a rescan");
  assert.ok(findNode(reloaded, "src/api/server.ts").of.includes(f.id));
  assert.ok(getPreset(map).features.includes(f.id));
  rmSync(root, { recursive: true, force: true });
});

test("hooks log activity, gate detached files and feed the rules", () => {
  const root = project();
  const store = new ContextStore(root);
  store.update((m) => detach(m, undefined, "src/lib/format.ts"));
  const start = handleHook({ hook_event_name: "SessionStart", session_id: "t1" }, root);
  assert.match(JSON.parse(start.stdout).hookSpecificOutput.additionalContext, /WEAVE context window/);
  const read = { hook_event_name: "PreToolUse", session_id: "t1", tool_name: "Read", tool_input: { file_path: join(root, "src/lib/format.ts") } };
  assert.equal(handleHook(read, root).stdout, undefined, "allow and flag by default");
  handleHook({ ...read, hook_event_name: "PostToolUse" }, root);
  store.update((m) => { m.settings.gate = "block"; });
  const denied = JSON.parse(handleHook(read, root).stdout);
  assert.equal(denied.hookSpecificOutput.permissionDecision, "deny");
  handleHook({ hook_event_name: "PreToolUse", session_id: "t1", tool_name: "Bash", tool_input: { command: "npm run test" } }, root);
  const events = recentEvents(store.paths);
  assert.deepEqual(events.map((e) => [e.verb, e.node, !!e.outside, !!e.blocked]), [
    ["Read", "src/lib/format.ts", true, false], ["Read", "src/lib/format.ts", true, false], ["Read", "src/lib/format.ts", true, true], ["Run", "tool:test", false, false],
  ]);
  const { map } = store.load();
  const s = suggestions(map, getPreset(map), events);
  assert.equal(s[0].rule, "Asked while detached");
  assert.equal(s[0].attach, true);
  rmSync(root, { recursive: true, force: true });
});

test("auto-apply only reattaches", () => {
  const root = project();
  const store = new ContextStore(root);
  store.update((m) => { detach(m, undefined, "src/lib/format.ts"); m.settings.autoApply = true; });
  const read = { session_id: "t1", tool_name: "Read", tool_input: { file_path: join(root, "src/lib/format.ts") } };
  handleHook({ ...read, hook_event_name: "PreToolUse" }, root);
  handleHook({ ...read, hook_event_name: "PostToolUse" }, root);
  const { map } = store.load();
  assert.ok(isLive(findNode(map, "src/lib/format.ts"), getPreset(map)));
  rmSync(root, { recursive: true, force: true });
});

test("heat counts reads and edits and fades with time", () => {
  const now = Date.now();
  const ev = (verb, node, ago, extra = {}) => ({ t: now - ago, s: "t1", ph: "end", verb, node, tool: "x", ...extra });
  const h = heat([
    ev("Read", "a", 0), ev("Edit", "a", 0), ev("Read", "b", HALF_LIFE), ev("Run", "c", 0),
    ev("Read", "d", 0, { blocked: true }), { ...ev("Read", "e", 0), ph: "start" },
  ], now);
  assert.equal(h.get("a"), 3, "an edit counts twice");
  assert.equal(h.get("b"), 0.5, "halved after one half-life");
  assert.equal(h.has("c") || h.has("d") || h.has("e"), false, "runs, blocked calls and unfinished calls do not count");
});

test("warm and cold steer threads without detaching anything", () => {
  const root = project();
  const store = new ContextStore(root);
  store.save(store.load().map);
  const read = (f) => {
    const input = { session_id: "t1", tool_name: "Read", tool_input: { file_path: join(root, f) } };
    handleHook({ ...input, hook_event_name: "PreToolUse" }, root);
    handleHook({ ...input, hook_event_name: "PostToolUse" }, root);
  };
  const note = () => JSON.parse(handleHook({ hook_event_name: "SessionStart", session_id: "t2" }, root).stdout).hookSpecificOutput.additionalContext;
  assert.ok(!note().includes("Warm"), "no usage yet, so the note stays as before");

  read("src/lib/format.ts");
  read("src/lib/format.ts");
  read("src/ui/theme.css");
  const { map } = store.load();
  const preset = getPreset(map);
  const before = JSON.stringify(preset);
  const w = warmth(map, preset, recentEvents(store.paths));
  assert.deepEqual(w.warm.map((n) => n.id), ["src/lib/format.ts", "src/ui/theme.css"], "hottest first");
  assert.ok(w.cold.some((n) => n.id === "src/ui/App.tsx"));
  assert.deepEqual(w.hot, [], "two reads is warm, not hot");
  assert.ok(w.cold.every((n) => isLive(n, preset)), "cold files stay attached");
  assert.match(note(), /Warm, start here: src\/lib\/format\.ts, src\/ui\/theme\.css/);
  assert.match(note(), /Cold, open only when the task needs them/);
  assert.equal(JSON.stringify(getPreset(store.load().map)), before, "the preset is never edited");

  store.update((m) => { m.settings.idleAfter = 3; });
  for (let i = 0; i < 3; i++) read("src/api/server.ts");
  const unused = (m) => suggestions(m, getPreset(m), recentEvents(store.paths)).filter((s) => s.rule === "Unused");
  assert.equal(unused(store.load().map).length, 0, "with warm and cold on, rarely used files are cold, not detach suggestions");
  assert.equal(unused({ ...store.load().map, settings: { ...store.load().map.settings, warmCold: false } }).length, 1, "the Unused rule is back when it is off");

  for (let i = 0; i < 9; i++) read("src/lib/format.ts");
  assert.deepEqual(warmth(store.load().map, preset, recentEvents(store.paths)).hot.map((n) => n.id), ["src/lib/format.ts"], "a run of recent reads makes it hot");

  store.update((m) => { m.settings.warmCold = false; });
  assert.ok(!note().includes("Warm"), "the switch turns it off");
  rmSync(root, { recursive: true, force: true });
});

test("thread names drop wrapper blocks and tags", () => {
  assert.equal(threadName('<relay from="x"><note>do the thing</note></relay> Fix the header'), "Fix the header");
  assert.equal(threadName("<wake reason=\"mention\">hi</wake>"), "");
  assert.equal(threadName("Make the <b>map</b> faster"), "Make the map faster");
  assert.equal(threadName('Hello <relay from="coordinator" session="s'), "Hello", "an unclosed wrapper is dropped too");
});

test("a preset saved from heat keeps the warm files and is named by fixed rules", () => {
  const root = project();
  const store = new ContextStore(root);
  const now = Date.now();
  const ev = (node, verb = "Read") => ({ t: now, s: "t1", ph: "end", verb, node, tool: "x" });
  const { map } = store.load();
  assert.throws(() => presetFromHeat(map, getPreset(map), [], now), /Nothing is warm yet/);
  const p = presetFromHeat(map, getPreset(map), [ev("src/ui/App.tsx"), ev("src/ui/theme.css", "Edit")], now);
  assert.equal(p.name, "UI", "mostly UI files");
  assert.ok(isLive(findNode(map, "src/ui/App.tsx"), p) && isLive(findNode(map, "src/ui/theme.css"), p));
  assert.ok(!isLive(findNode(map, "src/api/server.ts"), p), "other features stay out");
  assert.equal(tagFor(map, [findNode(map, "docs/guide.md")]), "Docs");
  assert.equal(tagFor(map, [findNode(map, "test/format.test.ts")]), "Tests");
  assert.equal(tagFor(map, [findNode(map, "src/api/server.ts")]), "Api", "otherwise the main feature folder");
  rmSync(root, { recursive: true, force: true });
});

test("overdue files can be put to sleep and wake when Claude uses them", () => {
  const root = project();
  const store = new ContextStore(root);
  store.save(store.load().map);
  const now = Date.now(), old = now - (OVERDUE_DAYS + 1) * 864e5;
  const ev = (node, t) => ({ t, s: "t1", ph: "end", verb: "Read", node, tool: "x" });
  const { map } = store.load();
  assert.deepEqual(overdue(map, getPreset(map), [ev("src/ui/App.tsx", now)], now), [], "a log shorter than 14 days flags nothing");
  const due = overdue(map, getPreset(map), [ev("src/ui/App.tsx", old), ev("src/lib/format.ts", now)], now).map((n) => n.id);
  assert.ok(due.includes("src/ui/App.tsx") && !due.includes("src/lib/format.ts"));

  store.update((m) => { sleep(m, undefined, ["src/ui/App.tsx"]); m.settings.gate = "block"; });
  const slept = store.load().map;
  assert.ok(!isLive(findNode(slept, "src/ui/App.tsx"), getPreset(slept)));
  assert.ok(!windowNote(slept, getPreset(slept)).includes("App.tsx"), "asleep files are left out of the thread note");
  const input = { session_id: "t1", tool_name: "Read", tool_input: { file_path: join(root, "src/ui/App.tsx") } };
  const pre = handleHook({ ...input, hook_event_name: "PreToolUse" }, root);
  assert.ok(!pre.stdout, "a sleeping file is never blocked, even in Block mode");
  assert.ok(isLive(findNode(store.load().map, "src/ui/App.tsx"), getPreset(store.load().map)), "and it wakes the moment Claude reads it");
  rmSync(root, { recursive: true, force: true });
});

test("files a thread moved on from freeze for that thread only", () => {
  const root = project();
  const { map } = new ContextStore(root).load();
  const now = Date.now(), min = 60_000;
  const ev = (node, ago, s = "t1", verb = "Read") => ({ t: now - ago, s, ph: "end", verb, node, tool: "x" });
  const events = [ev("src/ui/App.tsx", 30 * min), ev("src/api/server.ts", 30 * min, "t2"), ev("src/lib/format.ts", 25 * min, "t1", "Edit"), ev("docs/guide.md", 5 * min), ev("tool:test", 40 * min, "t1", "Run")];
  const ids = (prompts) => frozen(map, events, "t1", prompts, now).map((n) => n.id);
  assert.deepEqual(ids([now]), [], "a thread on its first message has nothing frozen");
  assert.deepEqual(ids([now - 40 * min, now - 20 * min, now]), ["src/lib/format.ts", "src/ui/App.tsx"], "used before its last two messages and over 10 minutes ago");
  assert.deepEqual(ids([now - 40 * min, now - 35 * min, now]), [], "still within its last two messages");
  assert.deepEqual(ids([now - 4 * min, now - 2 * min, now]), ["src/lib/format.ts", "src/ui/App.tsx"]);
  assert.ok(!ids([now - 40 * min, now - 20 * min, now]).includes("docs/guide.md"), "used in the last 10 minutes");
  assert.ok(FREEZE_AFTER === 10 * min);
  assert.deepEqual(frozen(map, events, "t2", [now - 40 * min, now - 20 * min, now], now).map((n) => n.id), ["src/api/server.ts"], "per thread");
  rmSync(root, { recursive: true, force: true });
});

test("the frozen line groups by folder and stays short", () => {
  assert.equal(frozenLine([]), undefined);
  assert.equal(frozenLine(["src/a.ts", "src/b.ts", "README.md", "lib/x/"]), "Frozen, skip unless needed: src/{a.ts, b.ts}, README.md, lib/x/.");
  assert.equal(frozenLine(["src/a.ts", "src/b.ts", "src/c.ts", "src/d.ts"]), "Frozen, skip unless needed: src/ (4 files).");
  const many = Array.from({ length: 40 }, (_, i) => `folder${i}/some/deeper/path/file${i}.ts`);
  const line = frozenLine(many);
  assert.ok(line.length <= FROZEN_CHARS, `${line.length} characters`);
  assert.match(line, /and \d+ more\.$/);
});

test("each message tells the thread what is frozen, and a file unfreezes when used", () => {
  const root = project();
  const store = new ContextStore(root);
  store.save(store.load().map);
  const before = JSON.stringify(store.load().map.presets);
  const now = Date.now(), min = 60_000;
  appendEvent(store.paths, { t: now - 30 * min, s: "t1", ph: "end", verb: "Read", node: "src/ui/App.tsx", tool: "Read", path: "src/ui/App.tsx" });
  writeFileSync(store.paths.threads, JSON.stringify({ t1: { id: "t1", name: "x", startedAt: now - 40 * min, lastSeen: now, prompts: [now - 40 * min, now - 20 * min] } }));
  const prompt = () => handleHook({ hook_event_name: "UserPromptSubmit", session_id: "t1", prompt: "next" }, root).stdout;
  const first = JSON.parse(prompt()).hookSpecificOutput;
  assert.equal(first.hookEventName, "UserPromptSubmit");
  assert.equal(first.additionalContext, "Frozen, skip unless needed: src/ui/App.tsx.");
  assert.equal(readThreads(store.paths).t1.prompts.length, 3, "prompt times are kept per thread");
  assert.equal(handleHook({ hook_event_name: "UserPromptSubmit", session_id: "t9", prompt: "hi" }, root).stdout, undefined, "other threads are not touched");

  const read = { session_id: "t1", tool_name: "Read", tool_input: { file_path: join(root, "src/ui/App.tsx") } };
  assert.equal(handleHook({ ...read, hook_event_name: "PreToolUse" }, root).stdout, undefined, "a frozen file is never blocked");
  handleHook({ ...read, hook_event_name: "PostToolUse" }, root);
  assert.equal(prompt(), undefined, "reading it unfreezes it");
  assert.equal(JSON.stringify(store.load().map.presets), before, "presets are never edited");

  appendEvent(store.paths, { t: now - 30 * min, s: "t1", ph: "end", verb: "Edit", node: "src/lib/format.ts", tool: "Edit" });
  store.update((m) => { m.settings.freeze = false; });
  assert.equal(prompt(), undefined, "the switch turns it off");
  rmSync(root, { recursive: true, force: true });
});

test("context warnings follow fixed, adjustable thresholds", () => {
  const st = { heavyAt: 150_000, freshAt: 300_000 };
  assert.deepEqual(contextLevel(undefined, st), { level: "ok" });
  assert.deepEqual(contextLevel(149_999, st), { level: "ok" });
  assert.deepEqual(contextLevel(150_000, st), { level: "heavy", text: "This thread is getting heavy, run /compact" });
  assert.deepEqual(contextLevel(300_000, st), { level: "full", text: "Start a fresh thread for the next task" });
  assert.equal(contextLevel(90_000, { heavyAt: 80_000, freshAt: 100_000 }).level, "heavy");
  assert.deepEqual(thresholds(500_000, 200_000), { heavyAt: 500_000, freshAt: 500_000 }, "red never comes before amber");
  assert.deepEqual(thresholds(1, 9e9), { heavyAt: 10_000, freshAt: 2_000_000 });
  const { settings } = normalizeMap({});
  assert.deepEqual([settings.freeze, settings.heavyAt, settings.freshAt], [true, 150_000, 300_000], "freezing is on by default");
});

test("the map server reports each thread's context level and frozen files", async () => {
  const root = project();
  const store = new ContextStore(root);
  const now = Date.now(), min = 60_000;
  const transcript = join(root, "t1.jsonl");
  writeFileSync(transcript, JSON.stringify({ message: { usage: { input_tokens: 10, cache_read_input_tokens: 160_000, output_tokens: 5 } } }) + "\n");
  mkdirSync(store.paths.weaveDir, { recursive: true });
  appendEvent(store.paths, { t: now - 30 * min, s: "t1", ph: "end", verb: "Read", node: "src/ui/App.tsx", tool: "Read" });
  writeFileSync(store.paths.threads, JSON.stringify({ t1: { id: "t1", name: "x", startedAt: now - 40 * min, lastSeen: now, transcript, prompts: [now - 40 * min, now - 20 * min, now] } }));
  const d = await startDashboard({ root, port: 3700, watch: false });
  const state = () => fetch(`${d.url}/api/state`).then((r) => r.json());
  const post = (body) => fetch(`${d.url}/api/settings`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  let t = (await state()).threads[0];
  assert.equal(t.context.level, "heavy");
  assert.deepEqual(t.frozen, ["src/ui/App.tsx"]);
  await post({ freshAt: 150_000 });
  t = (await state()).threads[0];
  assert.equal(t.context.level, "full", "the thresholds are adjustable");
  await post({ freeze: false });
  assert.deepEqual((await state()).threads[0].frozen, []);
  await d.close();
  rmSync(root, { recursive: true, force: true });
});

test("MCP tools return paths only and persist changes", () => {
  const root = project();
  const tools = createTools(new ContextStore(root));
  const ctx = JSON.parse(tools.weave_get_context.handler({}).content[0].text);
  assert.ok(ctx.attached.some((a) => a.id === "src/ui"));
  assert.ok(!JSON.stringify(ctx).includes("String(n)"), "never file contents");
  const d = JSON.parse(tools.weave_detach.handler({ node: "src/ui" }).content[0].text);
  assert.equal(d.ok, true);
  assert.ok(!d.window.attached.some((a) => a.id === "src/ui"));
  assert.ok(existsSync(join(root, ".claude/context-map.json")));
  assert.equal(tools.weave_detach.handler({ node: "nope" }).isError, true);
  const created = JSON.parse(tools.weave_create_preset.handler({ name: "UI work", features: ["src/ui"], makeDefault: true }).content[0].text);
  assert.equal(created.window.preset, "ui-work");
  rmSync(root, { recursive: true, force: true });
});

test("the optional API key lives outside the project with private permissions", () => {
  const dir = mkdtempSync(join(tmpdir(), "weave-cfg-"));
  process.env.WEAVE_CONFIG_DIR = dir;
  const old = process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  assert.equal(tokenMode().mode, "estimate");
  assert.throws(() => saveKey("short"));
  saveKey("sk-ant-test-0123456789abcdefghij");
  assert.equal(readKey(), "sk-ant-test-0123456789abcdefghij");
  assert.deepEqual(tokenMode(), { mode: "exact", source: "saved" });
  if (process.platform !== "win32") assert.equal(statSync(join(dir, "anthropic-key")).mode & 0o777, 0o600);
  removeKey();
  assert.equal(tokenMode().mode, "estimate");
  if (old) process.env.ANTHROPIC_API_KEY = old;
  delete process.env.WEAVE_CONFIG_DIR;
  rmSync(dir, { recursive: true, force: true });
});

test("the map server refuses other hosts and never returns the key", async () => {
  const root = project();
  const d = await startDashboard({ root, port: 3600, watch: false });
  const ok = await fetch(`${d.url}/api/state`).then((r) => r.json());
  assert.equal(ok.type, "state");
  assert.ok(!JSON.stringify(ok).includes("sk-ant"));
  const evil = await fetch(`${d.url}/api/toggle`, { method: "POST", headers: { "content-type": "application/json", origin: "http://evil.example" }, body: '{"node":"src/ui"}' });
  assert.equal(evil.status, 403);
  const form = await fetch(`${d.url}/api/toggle`, { method: "POST", headers: { "content-type": "text/plain" }, body: '{"node":"src/ui"}' });
  assert.equal(form.status, 405);
  const toggled = await fetch(`${d.url}/api/toggle`, { method: "POST", headers: { "content-type": "application/json" }, body: '{"node":"src/ui"}' }).then((r) => r.json());
  assert.equal(toggled.result.attached, false);
  await d.close();
  rmSync(root, { recursive: true, force: true });
});

test("port allocation falls back to the next free port", async () => {
  const blocker = createServer();
  const base = await listenWithFallback(blocker, 3400, "127.0.0.1", 50);
  const next = createServer();
  const got = await listenWithFallback(next, base, "127.0.0.1", 50);
  assert.ok(got > base);
  await Promise.all([new Promise((r) => blocker.close(r)), new Promise((r) => next.close(r))]);
});
