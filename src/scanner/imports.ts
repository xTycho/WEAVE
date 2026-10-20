import { readFileSync } from "node:fs";
import { join, posix } from "node:path";

const JS = /\.(m|c)?(j|t)sx?$/;
const JS_EXT = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts", ".vue", ".svelte"];
const JS_RX = [
  /\bimport\s+(?:type\s+)?(?:[\w*{}\s,$]+\s+from\s+)?["']([^"'\n]+)["']/g,
  /\bexport\s+(?:type\s+)?[\w*{}\s,$]*\s+from\s+["']([^"'\n]+)["']/g,
  /\b(?:require|import)\s*\(\s*["']([^"'\n]+)["']\s*\)/g,
];
const PY_RX = [/^\s*from\s+([.\w]+)\s+import\s/gm, /^\s*import\s+([\w.]+(?:\s*,\s*[\w.]+)*)/gm];
const GO_RX = [/^\s*import\s+(?:\w+\s+)?"([^"]+)"/gm, /^\s*(?:\w+\s+)?"([^"]+)"\s*$/gm];

/** Reads JSON that may hold comments and trailing commas (tsconfig style). */
function looseJson(text: string): any {
  try {
    return JSON.parse(text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'])\/\/.*$/gm, "$1").replace(/,\s*([}\]])/g, "$1"));
  } catch {
    return undefined;
  }
}

function readJson(root: string, rel: string): any {
  try { return looseJson(readFileSync(join(root, rel), "utf8")); } catch { return undefined; }
}

interface Aliases {
  /** [prefix, targets] from tsconfig/jsconfig `paths`; a trailing * is a wildcard. */
  paths: [string, string[]][];
  /** Workspace package name -> folder. */
  packages: Map<string, string>;
  goModule?: string;
}

function workspaceDirs(root: string, files: Set<string>): string[] {
  const pkg = readJson(root, "package.json");
  const globs: string[] = Array.isArray(pkg?.workspaces) ? pkg.workspaces : Array.isArray(pkg?.workspaces?.packages) ? pkg.workspaces.packages : [];
  try {
    const pnpm = readFileSync(join(root, "pnpm-workspace.yaml"), "utf8");
    for (const m of pnpm.matchAll(/^\s*-\s*["']?([^"'\n]+)["']?\s*$/gm)) globs.push(m[1]);
  } catch { /* none */ }
  const dirs = new Set<string>();
  for (const glob of globs) {
    const base = glob.replace(/\/?\*.*$/, "");
    for (const f of files) {
      if (!f.endsWith("/package.json")) continue;
      const dir = posix.dirname(f);
      if (glob.includes("*") ? posix.dirname(dir) === base || dir.startsWith(base + "/") : dir === base) dirs.add(dir);
    }
  }
  return [...dirs];
}

function aliases(root: string, files: Set<string>): Aliases {
  const paths: [string, string[]][] = [];
  for (const cfg of ["tsconfig.json", "jsconfig.json", "tsconfig.base.json"]) {
    const opts = readJson(root, cfg)?.compilerOptions;
    if (!opts?.paths) continue;
    const base = posix.normalize(opts.baseUrl ?? ".");
    for (const [key, targets] of Object.entries(opts.paths as Record<string, string[]>)) {
      paths.push([key, targets.map((t) => posix.normalize(posix.join(base, t)))]);
    }
  }
  const packages = new Map<string, string>();
  for (const dir of workspaceDirs(root, files)) {
    const name = readJson(root, `${dir}/package.json`)?.name;
    if (typeof name === "string") packages.set(name, dir);
  }
  let goModule: string | undefined;
  try { goModule = readFileSync(join(root, "go.mod"), "utf8").match(/^module\s+(\S+)/m)?.[1]; } catch { /* none */ }
  return { paths, packages, goModule };
}

function tryFile(base: string, files: Set<string>): string | undefined {
  const clean = posix.normalize(base).replace(/^\.\//, "");
  if (files.has(clean)) return clean;
  const stripped = clean.replace(/\.(m|c)?js$/, "");
  for (const ext of JS_EXT) if (files.has(stripped + ext)) return stripped + ext;
  for (const ext of JS_EXT) if (files.has(`${clean}/index${ext}`)) return `${clean}/index${ext}`;
  return undefined;
}

function resolveJs(spec: string, from: string, files: Set<string>, al: Aliases): string | undefined {
  if (spec.startsWith(".")) return tryFile(posix.join(posix.dirname(from), spec), files);
  for (const [key, targets] of al.paths) {
    const wild = key.endsWith("*");
    const prefix = wild ? key.slice(0, -1) : key;
    if (wild ? !spec.startsWith(prefix) : spec !== key) continue;
    const rest = wild ? spec.slice(prefix.length) : "";
    for (const t of targets) {
      const hit = tryFile(t.replace("*", rest), files);
      if (hit) return hit;
    }
  }
  for (const [name, dir] of al.packages) {
    if (spec !== name && !spec.startsWith(name + "/")) continue;
    const sub = spec.slice(name.length).replace(/^\//, "");
    return tryFile(posix.join(dir, sub || "src/index"), files) ?? tryFile(posix.join(dir, sub || "index"), files) ?? (files.has(`${dir}/package.json`) ? `${dir}/package.json` : undefined);
  }
  return undefined;
}

function resolvePy(spec: string, from: string, files: Set<string>): string | undefined {
  let base: string;
  if (spec.startsWith(".")) {
    const dots = spec.match(/^\.+/)![0].length;
    let dir = posix.dirname(from);
    for (let i = 1; i < dots; i++) dir = posix.dirname(dir);
    base = posix.join(dir, spec.slice(dots).replace(/\./g, "/"));
  } else base = spec.replace(/\./g, "/");
  for (const root of ["", "src/", "lib/", "app/"]) {
    for (const c of [`${root}${base}.py`, `${root}${base}/__init__.py`]) if (files.has(posix.normalize(c))) return posix.normalize(c);
  }
  return undefined;
}

function resolveGo(spec: string, files: Set<string>, al: Aliases): string | undefined {
  if (!al.goModule || !spec.startsWith(al.goModule + "/")) return undefined;
  const dir = spec.slice(al.goModule.length + 1);
  for (const f of files) if (posix.dirname(f) === dir && f.endsWith(".go") && !f.endsWith("_test.go")) return f;
  return undefined;
}

/**
 * Project-internal imports for every source file: file -> files it imports.
 * Plain pattern matching, no type checker and no model.
 */
export function scanImports(root: string, paths: string[]): Map<string, Set<string>> {
  const files = new Set(paths);
  const al = aliases(root, files);
  const out = new Map<string, Set<string>>();
  for (const file of paths) {
    const isJs = JS.test(file) || /\.(vue|svelte)$/.test(file);
    const isPy = file.endsWith(".py");
    const isGo = file.endsWith(".go");
    if (!isJs && !isPy && !isGo) continue;
    let text: string;
    try { text = readFileSync(join(root, file), "utf8"); } catch { continue; }
    const found = new Set<string>();
    const add = (hit: string | undefined) => { if (hit && hit !== file) found.add(hit); };
    if (isJs) for (const rx of JS_RX) for (const m of text.matchAll(rx)) add(resolveJs(m[1], file, files, al));
    if (isPy) {
      for (const m of text.matchAll(PY_RX[0])) add(resolvePy(m[1], file, files));
      for (const m of text.matchAll(PY_RX[1])) for (const part of m[1].split(",")) add(resolvePy(part.trim(), file, files));
    }
    if (isGo) {
      const block = text.match(/^import\s*\(([\s\S]*?)\)/m)?.[1] ?? "";
      for (const m of text.matchAll(GO_RX[0])) add(resolveGo(m[1], files, al));
      for (const m of block.matchAll(GO_RX[1])) add(resolveGo(m[1], files, al));
    }
    if (found.size) out.set(file, found);
  }
  return out;
}

export { looseJson };
