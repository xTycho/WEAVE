import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ContextStore, activate, sever, activeContext, scanFeatures, listenWithFallback } from "../dist/index.js";
import { createTools } from "../dist/mcp/tools.js";

function project() {
  const root = mkdtempSync(join(tmpdir(), "weave-test-"));
  mkdirSync(join(root, ".claude/features/auth/context"), { recursive: true });
  writeFileSync(join(root, "CLAUDE.md"), "# router\n");
  writeFileSync(join(root, ".claude/features/auth/overview.md"), "auth\n");
  writeFileSync(join(root, ".claude/features/auth/context/tokens.md"), "tokens\n");
  return root;
}

test("scanner discovers features and outer context", () => {
  const root = project();
  const ids = scanFeatures(root).map((n) => n.id);
  assert.deepEqual(ids, ["auth", "auth.tokens"]);
  rmSync(root, { recursive: true, force: true });
});

test("missing map falls back to scan without throwing", () => {
  const root = project();
  const { source, map } = new ContextStore(root).load();
  assert.equal(source, "scan");
  assert.ok(map.nodes.some((n) => n.tier === "core"));
  rmSync(root, { recursive: true, force: true });
});

test("corrupt map falls back gracefully", () => {
  const root = project();
  writeFileSync(join(root, ".claude/context-map.json"), "{not json");
  const loaded = new ContextStore(root).load();
  assert.equal(loaded.source, "scan");
  assert.match(loaded.warning, /unreadable/);
  rmSync(root, { recursive: true, force: true });
});

test("activate and sever route only filtered paths", () => {
  const root = project();
  const store = new ContextStore(root);
  const map = store.load().map;
  assert.deepEqual(activeContext(map, root).paths, ["CLAUDE.md"]);
  activate(map, "auth");
  assert.deepEqual(activeContext(map, root).paths, ["CLAUDE.md", ".claude/features/auth/overview.md", ".claude/features/auth/context/tokens.md"]);
  sever(map, "auth.tokens");
  assert.deepEqual(activeContext(map, root).paths, ["CLAUDE.md", ".claude/features/auth/overview.md"]);
  assert.deepEqual(sever(map, "auth"), ["auth"]);
  assert.throws(() => sever(map, "core"));
  rmSync(root, { recursive: true, force: true });
});

test("MCP tools persist state and never dump file contents", () => {
  const root = project();
  const tools = createTools(new ContextStore(root));
  const a = JSON.parse(tools.weave_activate_node.handler({ id: "auth" }).content[0].text);
  assert.equal(a.ok, true);
  assert.ok(existsSync(join(root, ".claude/context-map.json")));
  const ctx = tools.weave_get_active_context.handler({});
  assert.ok(!ctx.content[0].text.includes("tokens\\n"));
  assert.equal(JSON.parse(ctx.content[0].text).paths.length, 3);
  const bad = tools.weave_sever_node.handler({ id: "nope" });
  assert.equal(bad.isError, true);
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
