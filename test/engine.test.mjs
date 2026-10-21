import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { createServer, request } from "node:http";
import { WebSocket } from "ws";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ContextStore, scanProject, listenWithFallback, nodeForPath, handleHook, recentEvents, threadName, titleFrom, startDashboard,
  normalizeMap, appendEvent, readThreads, removeThreads, writeThread, areas, agentAreas, writeAgents, mapNote, MARK, meter, meterLine,
  staleTokens, createTools, isRemoteSession, remoteReason, CLEAR_LOOK, chatLaunch, contextNote, resolveClaude, shouldAutoCompact, AUTO_QUIET, AUTO_GAP,
} from "../dist/index.js";

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

const MIN = 60_000;
const ev = (t, s, node, verb = "Read", extra = {}) => ({ t, s, ph: "end", verb, node, path: node, tool: verb === "Edit" ? "Edit" : "Read", ...extra });
/** A transcript whose last usage line puts `tokens` in the thread's context. */
function transcript(root, name, tokens) {
  const file = join(root, `${name}.jsonl`);
  writeFileSync(file, JSON.stringify({ message: { usage: { input_tokens: 10, cache_read_input_tokens: tokens - 10, output_tokens: 0 } } }) + "\n");
  return file;
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
  assert.equal(by["src/ui/App.tsx"].tokens, Math.round(readFileSync(join(root, "src/ui/App.tsx")).length / 4), "estimates only, nothing leaves the machine");
  rmSync(root, { recursive: true, force: true });
});

test("big features fold sub-folders into one node each", () => {
  const root = mkdtempSync(join(tmpdir(), "weave-test-"));
  for (let i = 0; i < 30; i++) write(root, `engine/part${i % 3}/f${i}.js`, "x\n");
  const { nodes } = scanProject(root);
  const els = nodes.filter((n) => n.tier === "element" && n.kind !== "tool");
  assert.deepEqual(els.map((n) => n.id).sort(), ["engine/part0/", "engine/part1/", "engine/part2/"]);
  const map = { nodes };
  assert.equal(nodeForPath(map, "engine/part1")?.id, "engine/part1/", "a folder path matches without its trailing slash");
  rmSync(root, { recursive: true, force: true });
});

test("a broken map is kept as a backup before it is rebuilt, and old maps keep their nodes", () => {
  const root = project();
  const store = new ContextStore(root);
  assert.equal(store.load().source, "scan");
  mkdirSync(join(root, ".claude"), { recursive: true });
  writeFileSync(store.mapPath, "{nope");
  assert.equal(new ContextStore(root).load(false).map.nodes.length, 0, "hooks never scan");
  const loaded = store.load();
  assert.equal(loaded.source, "scan");
  assert.match(loaded.warning, /\.bak/);
  assert.equal(readFileSync(`${store.mapPath}.bak`, "utf8"), "{nope");
  const old = normalizeMap({ version: 2, nodes: [{ id: "core", tier: "core", label: "x" }], presets: [{ id: "full" }], settings: { heavyAt: 50_000, window: 5 } });
  assert.equal(old.version, 3);
  assert.equal(old.nodes.length, 1);
  assert.equal("presets" in old, false);
  assert.deepEqual(old.settings, { window: 50_000, compactAt: 0.6, meter: true }, "settings are clamped to safe values");
  rmSync(root, { recursive: true, force: true });
});

test("areas join features that the same threads use together, up to a size cap", () => {
  const root = project();
  write(root, "docs/big.md", "x".repeat(4000));
  const map = new ContextStore(root).rescan();
  const now = Date.now();
  assert.ok(areas(map, []).every((a) => a.from === "folders" && a.features.length === 1), "with no activity, every area is one folder");
  const events = [
    ev(now, "t1", "src/ui/App.tsx"), ev(now, "t1", "src/lib/format.ts", "Edit"),
    ev(now, "t2", "src/ui/theme.css"), ev(now, "t2", "src/lib/format.ts"),
    ev(now, "t3", "src/api/server.ts"), ev(now, "t3", "src/api/server.ts", "Run"),
  ];
  const all = areas(map, events);
  const ui = all.find((a) => a.features.includes("src/ui"));
  assert.deepEqual(ui.features, ["src/lib", "src/ui"]);
  assert.equal(ui.agent, "weave-src-ui-and-1", "named after its biggest folder");
  assert.equal(ui.name, "src/ui + 1 more");
  assert.equal(ui.threads, 2);
  assert.deepEqual(ui.files, ["src/lib/format.ts", "src/ui/App.tsx", "src/ui/theme.css"], "most used first");
  assert.deepEqual(all.find((a) => a.features.includes("src/api")).features, ["src/api"], "one thread is not enough to join");
  assert.equal(all[0].id, ui.id, "busiest area first");
  rmSync(join(root, "docs/big.md"));
  const small = areas(new ContextStore(root).rescan(), events);
  assert.deepEqual(small.find((a) => a.features.includes("src/ui")).features, ["src/ui"], "a join that would hold over 35% of the project is skipped");
  rmSync(root, { recursive: true, force: true });
});

test("each area gets a subagent file, and WEAVE only ever touches its own files", () => {
  const root = project();
  const map = new ContextStore(root).rescan();
  const all = areas(map, []);
  const dir = join(root, ".claude", "agents");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "weave-src-ui.md"), "my own agent\n");
  writeFileSync(join(dir, "weave-gone.md"), `---\nname: weave-gone\n---\n${MARK}\n`);
  const r = writeAgents(root, "demo", all);
  assert.equal(readFileSync(join(dir, "weave-src-ui.md"), "utf8"), "my own agent\n", "a file without the mark is never overwritten");
  assert.deepEqual(r.removed, ["weave-gone.md"]);
  const api = readFileSync(join(dir, "weave-src-api.md"), "utf8");
  assert.match(api, /^---\nname: weave-src-api\ndescription: Use for tasks inside src\/api\/ in demo/);
  assert.ok(api.includes(MARK));
  assert.deepEqual(writeAgents(root, "demo", all).written, [], "unchanged files are not rewritten");
  assert.equal(agentAreas(all).length, all.length);
  const note = mapNote(map, all);
  assert.match(note, /^WEAVE map of demo/);
  assert.match(note, /- weave-src-api: src\/api\//);
  assert.ok(note.length < 1200, "the note stays short");
  rmSync(root, { recursive: true, force: true });
});

test("the meter says /compact when the thread is nearly full or mostly stale", () => {
  const root = project();
  write(root, "src/api/big.ts", "x".repeat(160_000));
  const map = new ContextStore(root).rescan();
  const now = Date.now();
  const base = { map, areas: [], agents: [], at: "prompt" };
  const thread = { id: "t1", name: "x", startedAt: now, lastSeen: now, prompts: [now - 30 * MIN, now - 20 * MIN, now] };
  assert.equal(meter({ ...base, events: [], thread, tokens: 100_000 }).level, "ok");
  const full = meter({ ...base, events: [], thread, tokens: 170_000 });
  assert.equal(full.level, "compact");
  assert.match(meterLine(full), /getting too hot.*nearly full.*Only the user can do this/);
  const events = [ev(now - 40 * MIN, "t1", "src/api/big.ts"), ev(now - MIN, "t1", "src/ui/App.tsx")];
  assert.equal(staleTokens(map, events, "t1", thread.prompts), 40_000);
  assert.equal(meter({ ...base, events, thread, tokens: 130_000 }).level, "compact", "past compactAt with a quarter stale");
  assert.equal(meter({ ...base, events, thread, tokens: 130_000, map: { ...map, settings: { ...map.settings, window: 1_000_000 } } }).level, "ok", "the window size matters");
  assert.equal(meter({ ...base, events: [ev(now - 40 * MIN, "t1", "src/api/big.ts", "Read", { sub: true })], thread, tokens: 130_000 }).level, "ok", "a subagent's reads never reached the thread");
  rmSync(root, { recursive: true, force: true });
});

test("the meter says /clear when a message starts on files the thread never touched", () => {
  const root = project();
  const map = new ContextStore(root).rescan();
  const now = Date.now();
  const thread = { id: "t1", name: "x", startedAt: now, lastSeen: now, prompts: [now - 30 * MIN, now - MIN], asks: ["Fix the api", "Restyle the ui"] };
  const before = [ev(now - 20 * MIN, "t1", "src/api/server.ts", "Edit"), ev(now - 19 * MIN, "t1", "src/lib/format.ts")];
  const args = { map, areas: [], agents: [], at: "tool", thread, tokens: 60_000 };
  assert.equal(meter({ ...args, events: [...before, ev(now, "t1", "src/ui/App.tsx")] }).level, "ok", "one read is not enough");
  const m = meter({ ...args, events: [...before, ev(now, "t1", "src/ui/App.tsx"), ev(now, "t1", "src/ui/theme.css")] });
  assert.equal(m.level, "clear");
  assert.match(m.text, /works in src\/ui\/.*Run \/clear.*Carry-over: earlier task "Fix the api"; edited src\/api\/server\.ts\./);
  assert.equal(meter({ ...args, events: [...before, ev(now, "t1", "src/ui/App.tsx"), ev(now, "t1", "src/lib/format.ts")] }).level, "ok", "same folders as before");
  const late = [...before, ...Array.from({ length: CLEAR_LOOK + 1 }, () => ev(now, "t1", "src/ui/App.tsx")), ev(now, "t1", "src/ui/theme.css")];
  assert.equal(meter({ ...args, events: late }).level, "ok", "late in a message, a long task wandering is not a new task");
  assert.equal(meter({ ...args, tokens: 20_000, events: [...before, ev(now, "t1", "src/ui/App.tsx"), ev(now, "t1", "src/ui/theme.css")] }).level, "ok", "a small thread gains little from /clear");
  rmSync(root, { recursive: true, force: true });
});

test("from 40% the meter tells Claude to hand the work to the area's subagent", () => {
  const root = project();
  const map = new ContextStore(root).rescan();
  const now = Date.now();
  const all = areas(map, []);
  const thread = { id: "t1", name: "x", startedAt: now, lastSeen: now, prompts: [now - 30 * MIN, now - MIN] };
  const events = [ev(now - 20 * MIN, "t1", "src/ui/App.tsx"), ev(now, "t1", "src/ui/theme.css")];
  const args = { map, areas: all, agents: agentAreas(all), at: "tool", thread, events };
  assert.equal(meter({ ...args, tokens: 60_000 }).level, "ok");
  const m = meter({ ...args, tokens: 90_000 });
  assert.equal(m.level, "delegate");
  assert.equal(m.agent, "weave-src-ui");
  assert.equal(meterLine(m), "WEAVE: This thread holds ~90.0k of 200k tokens. Hand the rest of this task to the weave-src-ui subagent (src/ui/) so its reads stay out of this thread.");
  rmSync(root, { recursive: true, force: true });
});

test("hooks give the map note, log only finished calls, and speak at most once per message", () => {
  const root = project();
  const store = new ContextStore(root);
  store.rescan();
  const start = handleHook({ hook_event_name: "SessionStart", session_id: "t1", cwd: root });
  assert.match(JSON.parse(start.stdout).hookSpecificOutput.additionalContext, /^WEAVE map of demo/);
  assert.ok(existsSync(join(root, ".claude/agents/weave-src-ui.md")), "the session start writes the subagents");
  const tx = transcript(root, "t1", 170_000);
  const prompt = handleHook({ hook_event_name: "UserPromptSubmit", session_id: "t1", cwd: root, transcript_path: tx, prompt: "<wake>x</wake> Fix the header" });
  assert.match(JSON.parse(prompt.stdout).hookSpecificOutput.additionalContext, /getting too hot/);
  assert.equal(readThreads(store.paths).t1.name, "Thread 1", "threads are numbered, not named after a prompt");
  assert.equal(readThreads(store.paths).t1.asks.at(-1), "Fix the header", "the prompt's first line is kept for the carry-over");
  const read = { hook_event_name: "PostToolUse", session_id: "t1", cwd: root, tool_name: "Read", tool_input: { file_path: join(root, "src/lib/format.ts") } };
  assert.equal(handleHook(read).stdout, undefined, "one line per message, already said");
  handleHook({ ...read, agent_id: "a1" });
  handleHook({ hook_event_name: "PreToolUse", session_id: "t1", cwd: root, tool_name: "Read", tool_input: { file_path: join(root, "src/ui/App.tsx") } });
  handleHook({ hook_event_name: "PostToolUse", session_id: "t1", cwd: root, tool_name: "Bash", tool_input: { command: "npm run test" } });
  assert.deepEqual(recentEvents(store.paths).map((e) => [e.verb, e.node, !!e.sub]), [["Read", "src/lib/format.ts", false], ["Read", "src/lib/format.ts", true], ["Run", "tool:test", false]]);
  handleHook({ hook_event_name: "PostToolUse", session_id: "t1", cwd: root, tool_name: "mcp__weave__weave_name_thread", tool_input: { name: "Header fixes" } });
  assert.equal(readThreads(store.paths).t1.name, "Header fixes");
  store.update((m) => { m.settings.meter = false; });
  assert.equal(handleHook({ hook_event_name: "UserPromptSubmit", session_id: "t1", cwd: root, transcript_path: tx, prompt: "Again" }).stdout, undefined, "the meter can be switched off");
  rmSync(root, { recursive: true, force: true });
});

test("thread names drop wrapper blocks and tags, and title tools name threads", () => {
  assert.equal(threadName('<relay from="x"><note>do the thing</note></relay> Fix the header'), "Fix the header");
  assert.equal(threadName("<wake reason=\"mention\">hi</wake>"), "");
  assert.equal(threadName("Make the <b>map</b> faster"), "Make the map faster");
  assert.equal(threadName('Hello <relay from="coordinator" session="s'), "Hello", "an unclosed wrapper is dropped too");
  assert.equal(threadName('<system-reminder id="a1">[Subagent hand-back] report</system-reminder id="a1"> Fix it'), "Fix it", "a closing tag can carry attributes");
  assert.equal(threadName("<project_claude_message session=\"s\">note</project_claude_message>"), "", "relays from other sessions are not a name");
  assert.equal(titleFrom("mcp__hearthbot__set_thread_label", { label: " WEAVE thread hand-off " }), "WEAVE thread hand-off");
  assert.equal(titleFrom("Read", { label: "x" }), undefined);
});

test("an ended thread leaves the list while its activity stays", () => {
  const root = project();
  const store = new ContextStore(root);
  store.rescan();
  handleHook({ hook_event_name: "UserPromptSubmit", session_id: "a1", cwd: root, prompt: "Work" });
  handleHook({ hook_event_name: "UserPromptSubmit", session_id: "b2", cwd: root, prompt: "Other" });
  handleHook({ hook_event_name: "PostToolUse", session_id: "a1", cwd: root, tool_name: "Read", tool_input: { file_path: join(root, "src/ui/App.tsx") } });
  const events = recentEvents(store.paths).length;
  assert.equal(removeThreads(store.paths, ["a1", "nope"]), 1, "only a known thread is counted");
  assert.deepEqual(Object.keys(readThreads(store.paths)), ["b2"]);
  assert.equal(recentEvents(store.paths).length, events, "activity is kept, so areas keep what the thread taught them");
  rmSync(root, { recursive: true, force: true });
});

test("MCP tools return areas and paths only", () => {
  const root = project();
  const tools = createTools(new ContextStore(root));
  const map = JSON.parse(tools.weave_map.handler({}).content[0].text);
  assert.ok(map.areas.some((a) => a.agent === "weave-src-ui" && a.folders[0] === "src/ui/"));
  assert.ok(!JSON.stringify(map).includes("String(n)"), "never file contents");
  const hit = JSON.parse(tools.weave_area_for.handler({ path: "./src/ui/App.tsx" }).content[0].text);
  assert.equal(hit.agent, "weave-src-ui");
  assert.equal(tools.weave_area_for.handler({ path: "nope/x.ts" }).isError, true);
  rmSync(root, { recursive: true, force: true });
});

test("the map server shows areas and meters, refuses other pages, and survives bad paths", async () => {
  const root = project();
  const store = new ContextStore(root);
  const now = Date.now();
  mkdirSync(store.paths.weaveDir, { recursive: true });
  appendEvent(store.paths, ev(now - 30 * MIN, "t1", "src/ui/App.tsx"));
  writeThread(store.paths, "t1", { name: "x", transcript: transcript(root, "t1", 170_000), prompts: [now - 40 * MIN, now] });
  const d = await startDashboard({ root, port: 3700, watch: false });
  const state = () => fetch(`${d.url}/api/state`).then((r) => r.json());
  const post = (path, body, headers = {}) => fetch(`${d.url}${path}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
  let s = await state();
  assert.ok(s.areas.some((a) => a.agent === "weave-src-ui" && a.hasAgent));
  assert.equal(s.threads[0].meter.level, "compact");
  await post("/api/settings", { window: 1_000_000 });
  s = await state();
  assert.equal(s.threads[0].meter.level, "ok", "the window is adjustable");
  assert.equal(s.map.settings.window, 1_000_000);
  assert.equal((await post("/api/settings", { meter: false }, { origin: "http://evil.example" })).status, 403);
  assert.equal((await fetch(`${d.url}/api/settings`, { method: "POST", headers: { "content-type": "text/plain" }, body: "{}" })).status, 405);
  assert.equal((await post("/api/agents", {}).then((r) => r.json())).ok, true);
  assert.ok(readdirSync(join(root, ".claude/agents")).includes("weave-src-ui.md"));
  // fetch() refuses a malformed path, so send the raw request.
  const status = await new Promise((done) => request({ host: "127.0.0.1", port: d.port, path: "/%E0%A4%A" }, (r) => done(r.statusCode)).end());
  assert.equal(status, 400, "a malformed path is a bad request, not a crash");
  assert.equal((await state()).type, "state", "still running");
  await d.close();
  rmSync(root, { recursive: true, force: true });
});

test("a page that connects gets the whole recent log, so hot and cold cover every file a thread touched", async () => {
  const root = project();
  const store = new ContextStore(root);
  mkdirSync(store.paths.weaveDir, { recursive: true });
  for (let i = 0; i < 60; i++) appendEvent(store.paths, ev(Date.now() - (100 - i) * 1000, "t1", i % 2 ? "src/ui/App.tsx" : "src/lib/format.ts"));
  const d = await startDashboard({ root, port: 3720, watch: false });
  const history = await new Promise((done, fail) => {
    const ws = new WebSocket(`ws://127.0.0.1:${d.port}/ws`);
    ws.on("message", (raw) => { const m = JSON.parse(raw.toString()); if (m.type === "history") { ws.close(); done(m); } });
    ws.on("error", fail);
  });
  assert.equal(history.events.length, 60, "not only the last 40");
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

test("the map opens a terminal running Claude Code and tracks it under the id it launched with", async () => {
  const root = project();
  const calls = [];
  const spawn = (command, args, options) => { calls.push({ command, args, options }); return { unref() {}, on() {} }; };
  const d = await startDashboard({ root, port: 3750, watch: false, spawn });
  const post = (body) => fetch(`${d.url}/api/terminal`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).then((r) => r.json());
  if (process.platform !== "win32") {
    assert.match((await post({})).error, /Windows only/);
  } else {
    const first = await post({});
    assert.equal(first.result, "Thread 1");
    const [id] = Object.keys(readThreads(new ContextStore(root).paths));
    const line = calls[0].args.join(" ");
    assert.ok(line.includes(`claude --session-id ${id} --name "Thread 1"`), "launched under the id the map tracks");
    assert.equal(calls[0].options.cwd, root);
    const named = await post({ name: 'Fix "login" & `more` | now' });
    assert.equal(named.result, "Fix login more now", "the name can't carry shell characters");
    assert.equal(readThreads(new ContextStore(root).paths)[id].launched, true);
    assert.equal((await post({ resume: "not-a-thread" })).ok, false);
    assert.equal((await post({ resume: id })).ok, true);
    assert.ok(calls.at(-1).args.join(" ").includes(`claude --resume ${id}`));
  }
  await d.close();
  rmSync(root, { recursive: true, force: true });
});

test("the chat launches only claude, with a generated or resumed id and a cleaned name", () => {
  const claude = { file: "C:\bin\claude.exe", prefix: [] };
  const a = chatLaunch({ name: 'x" & calc', fallback: "Thread 1" }, claude);
  assert.equal(a.file, claude.file);
  assert.deepEqual(a.args.slice(0, 1), ["--session-id"]);
  assert.match(a.id, /^[0-9a-f-]{36}$/);
  assert.equal(a.args.at(-1), "x calc");
  const r = chatLaunch({ resume: a.id, fallback: "Thread 1" }, claude);
  assert.deepEqual(r.args, ["--resume", a.id]);
  assert.throws(() => chatLaunch({ resume: "x; calc", fallback: "T" }, claude), /session id/);
  const shim = resolveClaude({ PATH: "C:\npm", ComSpec: "cmd.exe" }, "win32", (f) => f.endsWith("claude.cmd"));
  assert.deepEqual(shim.prefix.slice(0, 2), ["/d", "/c"]);
  assert.throws(() => resolveClaude({ PATH: "C:\npm" }, "win32", () => false), /PATH/);
});

test("automatic compact needs the setting, the compact level, a quiet screen and a gap", () => {
  const ok = { level: "compact", promptAt: 1000, stoppedAt: 2000, lastCommandAt: 0, quietMs: AUTO_QUIET, sinceLastMs: AUTO_GAP };
  assert.equal(shouldAutoCompact(ok), true);
  assert.equal(shouldAutoCompact({ ...ok, stoppedAt: undefined }), false, "no stop yet: Claude may be waiting on a permission answer");
  assert.equal(shouldAutoCompact({ ...ok, stoppedAt: 500 }), false, "the last stop is from before the latest message, so Claude is mid-task");
  assert.equal(shouldAutoCompact({ ...ok, lastCommandAt: 2500 }), false, "one /compact per finished task");
  assert.equal(shouldAutoCompact({ ...ok, level: "clear" }), false);
  assert.equal(shouldAutoCompact({ ...ok, quietMs: 1000 }), false);
  assert.equal(shouldAutoCompact({ ...ok, sinceLastMs: 1000 }), false);
});

test("the embedded chat is local only, whitelists its commands and streams the terminal", async () => {
  const root = project();
  const written = [];
  let emit, exit;
  const pty = () => ({ onData: (cb) => { emit = cb; }, onExit: (cb) => { exit = cb; }, write: (d) => written.push(d), resize() {}, kill() {} });
  const d = await startDashboard({ root, port: 3800, watch: false, pty });
  const post = (path, body) => fetch(`${d.url}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).then((r) => r.json());
  const origin = d.url;
  const connect = (headers) => new Promise((done) => {
    const ws = new WebSocket(`ws://127.0.0.1:${d.port}/pty`, { headers });
    ws.on("open", () => done(ws));
    ws.on("error", () => done(null));
    ws.on("unexpected-response", () => done(null));
  });
  try {
    assert.equal(await connect({ origin }), null, "no chat yet");
    assert.match((await post("/api/chat/command", { command: "compact" })).error, /No chat/);
    const open = await post("/api/chat/open", {});
    assert.equal(open.ok, true);
    assert.equal((await fetch(`${d.url}/api/state`).then((r) => r.json())).chat.id, open.result.id);
    assert.equal((await post("/api/chat/open", {})).result.id, open.result.id, "one chat at a time");
    assert.equal(await connect({}), null, "an Origin is required");
    assert.equal(await connect({ origin: "http://evil.example" }), null, "a foreign Origin is refused");
    assert.equal(await connect({ origin, host: "evil.example" }), null, "a foreign Host is refused");
    const ws = await connect({ origin });
    assert.ok(ws, "our own page connects");
    const got = new Promise((done) => ws.once("message", (m) => done(JSON.parse(m.toString()))));
    emit("hello");
    assert.deepEqual(await got, { type: "output", data: "hello" });
    ws.send(JSON.stringify({ type: "input", data: "hi\r" }));
    await new Promise((r) => setTimeout(r, 50));
    assert.deepEqual(written, ["hi\r"]);
    // Dropped files land only in the weave temp folder, with a cleaned name.
    const up = await fetch(`${d.url}/api/chat/upload?name=${encodeURIComponent("..\\..\\my shot (1).png")}`, { method: "POST", headers: { "content-type": "application/octet-stream" }, body: Buffer.from("png") }).then((r) => r.json());
    assert.equal(up.ok, true);
    assert.match(up.result.path, /^\.claude\/weave\/temp\/\d+-my_shot_1_\.png$/);
    assert.equal(readFileSync(join(root, up.result.path), "utf8"), "png");
    const big = await fetch(`${d.url}/api/chat/upload?name=x`, { method: "POST", headers: { "content-type": "application/octet-stream" }, body: Buffer.alloc(16 * 1024 * 1024) }).then((r) => r.status, () => 413);
    assert.equal(big, 413);
    assert.match((await post("/api/chat/command", { command: "rm -rf" })).error, /Unknown/);
    assert.equal((await post("/api/chat/command", { command: "compact" })).ok, true);
    await new Promise((r) => setTimeout(r, 250));
    assert.deepEqual(written.slice(1), ["/compact", "\r"]);
    ws.close();
    exit({ exitCode: 0 });
    const after = await fetch(`${d.url}/api/state`).then((r) => r.json());
    assert.equal(after.chat, null, "a chat that exits is gone");
    assert.ok(!after.threads.some((x) => x.id === open.result.id), "and so is its thread");
    assert.match((await post("/api/chat/command", { command: "clear" })).error, /No chat/);
  } finally { await d.close(); }
});

test("a saved window becomes a first note that only points at safe file paths", () => {
  const note = contextNote('Fix "login" & co', ["src/a.ts", "x & calc", "../secret", "src/b ts.ts"]);
  assert.match(note, /^Context window Fix login co\./);
  assert.match(note, /src\/a\.ts, src\/b ts\.ts\./);
  assert.doesNotMatch(note, /calc|secret|["&|<>^%]/);
  assert.match(note, /Nothing is preloaded/);
  assert.equal(contextNote("x", ["a && b"]), undefined);
  const claude = { file: "claude", prefix: [] };
  assert.equal(chatLaunch({ fallback: "T", note }, claude).args.at(-1), note);
  assert.ok(!chatLaunch({ fallback: "T", note, resume: "0123456789abcdef0123456789abcdef0123" }, claude).args.includes(note), "resume never gets a note");
});

test("the Stop hook records when Claude Code finished a turn", () => {
  const root = project();
  const store = new ContextStore(root);
  store.rescan();
  writeThread(store.paths, "s1", { transcript: undefined });
  assert.equal(readThreads(store.paths).s1.stopped, undefined);
  handleHook({ hook_event_name: "Stop", session_id: "s1", cwd: root }, root);
  assert.ok(readThreads(store.paths).s1.stopped > 0);
  rmSync(root, { recursive: true, force: true });
});

/** Writes a transcript of JSON lines and returns its path. */
function rcTranscript(dir, name, entries) {
  const file = join(dir, name);
  writeFileSync(file, entries.map((e) => JSON.stringify(e)).join("\n") + "\n");
  return file;
}

test("a Remote Control session is told from a terminal one by fixed markers in its transcript", () => {
  const dir = mkdtempSync(join(tmpdir(), "weave-rc-"));
  const user = (extra, content = "hello") => ({ type: "user", message: { role: "user", content }, ...extra });
  const rc = rcTranscript(dir, "rc.jsonl", [{ type: "queue-operation" }, { type: "attachment", entrypoint: "claude-desktop", userType: "external" }, user({ entrypoint: "claude-desktop" }, '<relay from="coordinator" reason="spawn">x</relay>')]);
  const relayed = rcTranscript(dir, "relayed.jsonl", [user({ projectsUserTurn: true, verifiedSlackHumanTurn: true })]);
  const sub = rcTranscript(dir, "sub.jsonl", [user({ origin: { kind: "task-notification", subkind: "projects-relay" } })]);
  const wake = rcTranscript(dir, "wake.jsonl", [user({ entrypoint: "cli" }, "<wake reason='x'>go</wake>")]);
  const msg = rcTranscript(dir, "msg.jsonl", [user({}, [{ type: "text", text: "via project_claude_message" }])]);
  const cli = rcTranscript(dir, "cli.jsonl", [{ type: "attachment", entrypoint: "cli", userType: "external" }, user({ entrypoint: "cli", turnOrigin: "human", origin: { kind: "human" } }, "fix the bug")]);
  const sdk = rcTranscript(dir, "sdk.jsonl", [user({ entrypoint: "sdk-cli", turnOrigin: "sdk" })]);
  for (const f of [rc, relayed, sub, wake, msg]) assert.equal(isRemoteSession(f), true, f);
  for (const f of [cli, sdk, join(dir, "missing.jsonl")]) assert.equal(isRemoteSession(f), false, f);
  assert.equal(isRemoteSession(undefined), false);
  assert.equal(remoteReason(['not json', JSON.stringify(user({ entrypoint: "cli" }))]), undefined);
  assert.equal(remoteReason([JSON.stringify(user({ isMeta: true, projectsUserTurn: true }))]), undefined, "meta entries are not the user's turns");
  rmSync(dir, { recursive: true, force: true });
});

test("a Remote Control thread is tracked only: no chat or terminal may resume it", async () => {
  const root = project();
  const dir = mkdtempSync(join(tmpdir(), "weave-rc-"));
  const rcFile = rcTranscript(dir, "rc.jsonl", [{ type: "user", entrypoint: "claude-desktop", projectsUserTurn: true, message: { content: "hi" } }]);
  const cliFile = rcTranscript(dir, "cli.jsonl", [{ type: "user", entrypoint: "cli", message: { content: "hi" } }]);
  const paths = new ContextStore(root).paths;
  writeThread(paths, "11111111-1111-4111-8111-111111111111", { name: "Remote", transcript: rcFile });
  writeThread(paths, "22222222-2222-4222-8222-222222222222", { name: "Local", transcript: cliFile });
  const calls = [];
  const spawn = (command, args) => { calls.push({ command, args }); return { unref() {}, on() {} }; };
  const spawned = [];
  const pty = (file, args) => { spawned.push({ file, args }); return { onData() {}, onExit() {}, write() {}, resize() {}, kill() {}, pid: 1 }; };
  const d = await startDashboard({ root, port: 3790, watch: false, spawn, pty });
  const post = (path, body) => fetch(`${d.url}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const rc = "11111111-1111-4111-8111-111111111111";
  for (const path of ["/api/chat/open", "/api/terminal"]) {
    const r = await post(path, { resume: rc });
    assert.equal(r.status, 400, path);
    assert.match((await r.json()).error, /Remote Control/);
  }
  assert.equal(calls.length, 0, "no terminal was started");
  assert.equal(spawned.length, 0, "no chat was started");
  const body = await (await fetch(`${d.url}/api/state`)).json(), state = body.result ?? body;
  assert.equal(state.threads.find((t) => t.id === rc).remote, true);
  assert.equal(state.threads.find((t) => t.name === "Local").remote, false);
  await d.close();
  rmSync(root, { recursive: true, force: true });
  rmSync(dir, { recursive: true, force: true });
});
