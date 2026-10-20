import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, rmSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ContextStore, scanProject, listenWithFallback, attach, detach, isLive, getPreset, findNode, nodeForPath,
  windowNote, spinUp, handleHook, suggestions, recentEvents, saveKey, readKey, removeKey, tokenMode, startDashboard,
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
