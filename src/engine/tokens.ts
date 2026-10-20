import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { request } from "node:https";
import { join, resolve } from "node:path";
import { projectPaths, userConfigDir } from "../paths.js";
import type { FileEntry } from "../scanner/files.js";
import type { TokenLookup } from "../scanner/project-scanner.js";

/**
 * Token counts. Without a key every count is an estimate (bytes / 4) and nothing
 * leaves the machine. With a key, file text is sent to Anthropic's free
 * count_tokens endpoint, and the result is cached per file until it changes.
 */

const KEY_FILE = "anthropic-key";
const COUNT_HOST = "api.anthropic.com";
const COUNT_PATH = "/v1/messages/count_tokens";

interface CacheEntry { bytes: number; mtimeMs: number; hash: string; tokens: number }
type Cache = Record<string, CacheEntry>;

function keyPath(): string {
  return resolve(userConfigDir(), KEY_FILE);
}

/** The key from the user's private config file, else from ANTHROPIC_API_KEY. Never logged, never sent to the browser. */
export function readKey(): string | undefined {
  try {
    const key = readFileSync(keyPath(), "utf8").trim();
    if (key) return key;
  } catch { /* no saved key */ }
  return process.env.ANTHROPIC_API_KEY?.trim() || undefined;
}

export function tokenMode(): { mode: "exact" | "estimate"; source?: "saved" | "environment" } {
  if (existsSync(keyPath())) return { mode: "exact", source: "saved" };
  if (process.env.ANTHROPIC_API_KEY?.trim()) return { mode: "exact", source: "environment" };
  return { mode: "estimate" };
}

/** Saves the key outside every project, readable only by the current user. */
export function saveKey(key: string): void {
  const clean = key.trim();
  if (!/^[\w-]{20,300}$/.test(clean)) throw new Error("That does not look like an API key.");
  const dir = userConfigDir();
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = keyPath();
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, clean + "\n", { mode: 0o600 });
  renameSync(tmp, file);
  try { chmodSync(file, 0o600); } catch { /* Windows keeps ACLs on the user profile */ }
}

export function removeKey(): void {
  rmSync(keyPath(), { force: true });
}

function loadCache(root: string): Cache {
  try { return JSON.parse(readFileSync(projectPaths(root).tokenCache, "utf8")) as Cache; } catch { return {}; }
}

function saveCache(root: string, cache: Cache): void {
  const file = projectPaths(root).tokenCache;
  mkdirSync(projectPaths(root).weaveDir, { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(cache));
  renameSync(tmp, file);
}

/** Lookup for the scanner: the cached exact count while the file is unchanged, else the estimate. */
export function tokenLookup(root: string): TokenLookup {
  const cache = loadCache(root);
  const exact = tokenMode().mode === "exact";
  return (f: FileEntry) => {
    const hit = exact ? cache[f.path] : undefined;
    if (hit && hit.bytes === f.bytes && hit.mtimeMs === f.mtimeMs) return { tokens: hit.tokens, exact: true };
    return { tokens: Math.round(f.bytes / 4), exact: false };
  };
}

function countRemote(key: string, model: string, text: string): Promise<number> {
  const body = JSON.stringify({ model, messages: [{ role: "user", content: text || " " }] });
  return new Promise((done, fail) => {
    const req = request({
      host: COUNT_HOST, path: COUNT_PATH, method: "POST", timeout: 20_000,
      headers: { "content-type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01", "content-length": Buffer.byteLength(body) },
    }, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => {
        try {
          const json = JSON.parse(data);
          if (res.statusCode === 200 && typeof json.input_tokens === "number") done(json.input_tokens);
          else fail(new Error(json?.error?.message ?? `count failed (${res.statusCode})`));
        } catch { fail(new Error(`count failed (${res.statusCode})`)); }
      });
    });
    req.on("timeout", () => req.destroy(new Error("count timed out")));
    req.on("error", fail);
    req.end(body);
  });
}

let running = false;

/**
 * Counts every changed file exactly. Files whose content hash is already known
 * are not sent again. Returns how many files were counted, or 0 without a key.
 */
export async function countExact(root: string, files: FileEntry[], onProgress?: (done: number, total: number) => void): Promise<number> {
  const key = readKey();
  if (!key || running) return 0;
  running = true;
  try {
    const model = process.env.WEAVE_TOKEN_MODEL ?? "claude-haiku-5-5";
    const cache = loadCache(root);
    const byHash = new Map(Object.values(cache).map((e) => [e.hash, e.tokens]));
    const todo = files.filter((f) => { const c = cache[f.path]; return !c || c.bytes !== f.bytes || c.mtimeMs !== f.mtimeMs; });
    if (!todo.length) return 0;
    // The request wrapper itself costs a few tokens; measure it once and subtract it.
    const overhead = Math.max(0, (await countRemote(key, model, " ")) - 1);
    let done = 0;
    for (const f of todo) {
      let text: string;
      try { text = readFileSync(join(root, f.path), "utf8"); } catch { continue; }
      const hash = createHash("sha1").update(text).digest("hex");
      const tokens = byHash.get(hash) ?? Math.max(0, (await countRemote(key, model, text)) - overhead);
      cache[f.path] = { bytes: f.bytes, mtimeMs: f.mtimeMs, hash, tokens };
      byHash.set(hash, tokens);
      onProgress?.(++done, todo.length);
      if (done % 25 === 0) saveCache(root, cache);
    }
    saveCache(root, cache);
    return done;
  } finally {
    running = false;
  }
}
