import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { UsageTracker, usageEntry, dedupe, sum, blocks, currentBlock, total, BLOCK_MS, WEEK_MS, startDashboard } from "../dist/index.js";

const H = 3600_000;
const T0 = Date.parse("2026-10-20T09:00:00.000Z");
const line = (t, id, req, u = {}) => JSON.stringify({ type: "assistant", timestamp: new Date(t).toISOString(), requestId: req, message: { id, usage: { input_tokens: 1, output_tokens: 10, cache_creation_input_tokens: 100, cache_read_input_tokens: 1000, ...u } } }) + "\n";
const ent = (t, key = String(t)) => ({ key, t, input: 1, output: 0, cacheCreate: 0, cacheRead: 0 });

test("usageEntry reads usage and skips other lines", () => {
  const e = usageEntry(line(T0, "m1", "r1").trim());
  assert.deepEqual(e, { key: "m1:r1", t: T0, input: 1, output: 10, cacheCreate: 100, cacheRead: 1000 });
  assert.equal(usageEntry('{"type":"user","message":{"content":"hi"}}'), undefined);
  assert.equal(usageEntry('{"usage": broken'), undefined);
});

test("streaming repeats of one message count once, with the last line's numbers", () => {
  const lines = [line(T0, "m1", "r1", { output_tokens: 5 }), line(T0 + 1, "m1", "r1", { output_tokens: 50 }), line(T0 + 2, "m2", "r2")];
  const map = dedupe(lines.map((l) => usageEntry(l.trim())));
  assert.equal(map.size, 2);
  assert.equal(map.get("m1:r1").output, 50);
  assert.equal(total(sum(map.values())), 1 + 50 + 100 + 1000 + 1111);
});

test("5-hour blocks start at the first message floored to the hour and last 5 hours", () => {
  const first = T0 + 37 * 60_000; // 09:37 -> block 09:00-14:00
  const b = blocks([ent(first), ent(first + 2 * H), ent(T0 + 5 * H + 1), ent(T0 + 20 * H)]);
  assert.equal(b.length, 3);
  assert.equal(b[0].start, T0);
  assert.equal(b[0].end, T0 + BLOCK_MS);
  assert.equal(b[0].tokens.input, 2);
  assert.equal(b[1].start, T0 + 5 * H, "a message at 14:00:00.001 opens a new block at 14:00");
  assert.equal(b[2].start, T0 + 20 * H);
});

test("the current block is zero once it has run out", () => {
  const es = [ent(T0 + 10 * 60_000)];
  const live = currentBlock(es, T0 + 4 * H);
  assert.equal(live.active, true);
  assert.equal(live.resets, T0 + 5 * H);
  assert.equal(live.tokens.input, 1);
  const done = currentBlock(es, T0 + 5 * H);
  assert.equal(done.active, false);
  assert.equal(total(done.tokens), 0);
  assert.equal(currentBlock([], T0).active, false);
});

test("tracker sums all projects and subagents, windows by timestamp, and reads appended lines only", async () => {
  const dir = mkdtempSync(join(tmpdir(), "weave-usage-"));
  const now = T0 + 3 * H;
  let clock = now;
  const sid = "aaaaaaaa-0000-4000-8000-000000000001";
  mkdirSync(join(dir, "proj-a", sid, "subagents"), { recursive: true });
  mkdirSync(join(dir, "proj-b"), { recursive: true });
  const main = join(dir, "proj-a", `${sid}.jsonl`);
  writeFileSync(main, line(now - H, "m1", "r1") + line(now - H, "m1", "r1") + '{"type":"user"}\n');
  writeFileSync(join(dir, "proj-a", sid, "subagents", "agent-1.jsonl"), line(now - 30 * 60_000, "s1", "rs1"));
  // Another project: one message 2 days ago (week only), one 8 days ago (neither).
  writeFileSync(join(dir, "proj-b", "other.jsonl"), line(now - 2 * 864e5, "o1", "ro1") + line(now - WEEK_MS - H, "o2", "ro2"));
  const tr = new UsageTracker({ dir, now: () => clock, minGapMs: 0 });
  await tr.refresh();
  let s = tr.snapshot(sid);
  assert.equal(total(s.session), 2 * 1111, "chat = its transcript (deduped) + its subagent");
  assert.equal(s.block.active, true);
  assert.equal(s.block.start, T0 + 2 * H);
  assert.equal(total(s.block.tokens), 2 * 1111);
  assert.equal(total(s.week), 3 * 1111, "the 8-day-old message is outside the rolling week");
  assert.equal(tr.snapshot().session, undefined);

  // A partial line is left for later; once complete it counts.
  const next = line(now - 10 * 60_000, "m2", "r2");
  appendFileSync(main, next.slice(0, 20));
  clock += 6000; await tr.refresh();
  assert.equal(total(tr.snapshot(sid).session), 2 * 1111);
  appendFileSync(main, next.slice(20));
  clock += 6000; await tr.refresh();
  assert.equal(total(tr.snapshot(sid).session), 3 * 1111);

  // Six hours on, the block has ended: zero, no reset time.
  clock = now + 6 * H;
  const later = tr.snapshot(sid);
  assert.equal(later.block.active, false);
  assert.equal(total(later.block.tokens), 0);
  rmSync(dir, { recursive: true, force: true });
});

test("GET /api/usage returns totals for a session", async () => {
  const dir = mkdtempSync(join(tmpdir(), "weave-usage-"));
  const root = mkdtempSync(join(tmpdir(), "weave-usage-root-"));
  writeFileSync(join(root, "a.ts"), "export const a = 1;\n");
  mkdirSync(join(dir, "p"));
  writeFileSync(join(dir, "p", "s1.jsonl"), line(Date.now() - 60_000, "m1", "r1"));
  const d = await startDashboard({ root, port: 3870, watch: false, usageDir: dir });
  const u = await (await fetch(`${d.url}/api/usage?session=s1`)).json();
  assert.equal(total(u.session), 1111);
  assert.equal(total(u.week), 1111);
  assert.equal(u.block.active, true);
  const state = await (await fetch(`${d.url}/api/state`)).json();
  assert.equal(total(state.usage.week), 1111);
  await d.close();
  rmSync(dir, { recursive: true, force: true });
  rmSync(root, { recursive: true, force: true });
});
