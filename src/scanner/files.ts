import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

export interface FileEntry {
  path: string;
  bytes: number;
  mtimeMs: number;
}

const ALWAYS_SKIP = new Set([
  ".git", "node_modules", ".claude", "dist", "build", "out", "coverage", ".next", ".nuxt", ".svelte-kit",
  ".turbo", ".cache", ".venv", "venv", "__pycache__", ".pytest_cache", ".mypy_cache", "target", "vendor", ".idea", ".vscode",
]);
const BINARY = /\.(png|jpe?g|gif|webp|avif|ico|bmp|tiff?|psd|pdf|zip|gz|tgz|bz2|xz|7z|rar|jar|war|class|so|dylib|dll|exe|bin|o|a|wasm|woff2?|ttf|otf|eot|mp[34]|mov|avi|webm|wav|flac|ogg|sqlite|db|lock|map)$/i;
const LOCKFILES = new Set(["package-lock.json", "yarn.lock", "pnpm-lock.yaml", "bun.lockb", "Cargo.lock", "poetry.lock", "go.sum", "composer.lock", "Gemfile.lock"]);
const MAX_BYTES = 1_000_000;

function keep(path: string): boolean {
  const parts = path.split("/");
  const name = parts[parts.length - 1];
  return !parts.slice(0, -1).some((p) => ALWAYS_SKIP.has(p)) && !BINARY.test(name) && !LOCKFILES.has(name) && name !== ".DS_Store";
}

/** Files git would track (tracked + untracked, minus ignored). Undefined when git is unavailable. */
function fromGit(root: string): string[] | undefined {
  if (!existsSync(join(root, ".git"))) return undefined;
  try {
    const out = execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], {
      cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], maxBuffer: 64 * 1024 * 1024,
    });
    return out.split("\0").filter(Boolean);
  } catch {
    return undefined;
  }
}

/** Minimal .gitignore support for projects without git: plain names, `dir/` and `*.ext`. */
function ignoreRules(root: string): (path: string) => boolean {
  let lines: string[] = [];
  try { lines = readFileSync(join(root, ".gitignore"), "utf8").split(/\r?\n/); } catch { /* none */ }
  const rules = lines.map((l) => l.trim()).filter((l) => l && !l.startsWith("#") && !l.startsWith("!"));
  const tests = rules.map((rule) => {
    const anchored = rule.startsWith("/");
    const body = rule.replace(/^\//, "").replace(/\/$/, "");
    const rx = new RegExp(`${anchored ? "^" : "(^|/)"}${body.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*\*/g, "\u0000").replace(/\*/g, "[^/]*").replace(/\u0000/g, ".*").replace(/\?/g, "[^/]")}(/|$)`);
    return (p: string) => rx.test(p);
  });
  return (path) => tests.some((t) => t(path));
}

function walk(root: string): string[] {
  const ignored = ignoreRules(root);
  const out: string[] = [];
  const visit = (rel: string) => {
    let entries;
    try { entries = readdirSync(join(root, rel), { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = rel ? `${rel}/${e.name}` : e.name;
      if (ALWAYS_SKIP.has(e.name) || ignored(p)) continue;
      if (e.isDirectory()) visit(p);
      else if (e.isFile()) out.push(p);
      if (out.length > 20000) return;
    }
  };
  visit("");
  return out;
}

/** Every text file in the project that is worth mapping, with its size. */
export function listFiles(root: string): FileEntry[] {
  const paths = (fromGit(root) ?? walk(root)).filter(keep);
  const files: FileEntry[] = [];
  for (const path of paths) {
    try {
      const st = statSync(join(root, path));
      if (st.isFile() && st.size <= MAX_BYTES) files.push({ path, bytes: st.size, mtimeMs: st.mtimeMs });
    } catch { /* deleted while scanning */ }
  }
  return files.sort((a, b) => a.path.localeCompare(b.path));
}
