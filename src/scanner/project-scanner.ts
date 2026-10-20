import { existsSync, readFileSync, statSync } from "node:fs";
import { basename, join, posix } from "node:path";
import type { Kind, Link, ScanResult, WeaveNode } from "../types.js";
import { listFiles, type FileEntry } from "./files.js";
import { looseJson, scanImports } from "./imports.js";

/** Root files every thread should see. */
const CORE_FILES = /^(CLAUDE\.md|AGENTS\.md|README(\.\w+)?|package\.json|pyproject\.toml|go\.mod|Cargo\.toml|composer\.json|Gemfile|deno\.jsonc?)$/i;
/** Folders that hold several features rather than being one. */
const CONTAINERS = new Set(["src", "lib", "app", "packages", "apps", "services", "modules", "pkg", "internal", "cmd", "crates", "libs", "components", "features"]);
/** Above this many elements a feature folds its sub-folders into one node each. */
export const MAX_ELEMENTS = 24;
const MAX_SCRIPTS = 10;
export const ROOT_FEATURE = "(root)";

const TEST = /(^|\/)(tests?|__tests__|spec|e2e)\/|\.(test|spec)\.[^/]+$|_test\.(go|py)$|(^|\/)test_[^/]+\.py$/;
const DESIGN = /\.(css|scss|sass|less|styl|pcss|svg|fig|sketch)$|(^|\/)tailwind\.config\.[^/]+$|(^|\/)(theme|tokens|design-tokens)\.(json|ya?ml)$/i;
const CODE = /\.(m|c)?(j|t)sx?$|\.(py|go|rs|java|kt|kts|swift|rb|php|cs|fs|c|h|cc|cpp|hpp|m|mm|scala|clj|ex|exs|erl|hs|lua|dart|r|jl|sh|bash|zsh|ps1|sql|vue|svelte|astro|html?|graphql|gql|proto|tf|zig|nim|sol)$/i;
const DOC = /\.(md|mdx|txt|rst|adoc)$/i;

export type TokenLookup = (file: FileEntry) => { tokens: number; exact: boolean };
export const estimate: TokenLookup = ({ bytes }) => ({ tokens: Math.round(bytes / 4), exact: false });

export function kindOf(path: string): Kind {
  if (TEST.test(path)) return "test";
  if (DESIGN.test(path)) return "design";
  if (DOC.test(path)) return "doc";
  return CODE.test(path) ? "code" : "doc";
}

/** Which feature folder a file belongs to. */
function featureDirs(files: FileEntry[]): (path: string) => string {
  const subdirs = new Map<string, Set<string>>();
  for (const { path } of files) {
    const parts = path.split("/");
    if (parts.length > 2 && CONTAINERS.has(parts[0])) {
      if (!subdirs.has(parts[0])) subdirs.set(parts[0], new Set());
      subdirs.get(parts[0])!.add(parts[1]);
    }
  }
  const split = new Set([...subdirs].filter(([, s]) => s.size >= 2).map(([top]) => top));
  return (path) => {
    const parts = path.split("/");
    if (parts.length === 1) return ROOT_FEATURE;
    if (split.has(parts[0]) && parts.length > 2) return `${parts[0]}/${parts[1]}`;
    return parts[0];
  };
}

function majority(kinds: Kind[]): Kind {
  const count = new Map<Kind, number>();
  for (const k of kinds) count.set(k, (count.get(k) ?? 0) + 1);
  return [...count].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "code";
}

/** Turns one feature's files into at most MAX_ELEMENTS element nodes. */
function elementsFor(feature: string, files: FileEntry[], tokens: TokenLookup): { nodes: WeaveNode[]; owner: Map<string, string> } {
  const owner = new Map<string, string>();
  const fileNode = (f: FileEntry): WeaveNode => {
    const t = tokens(f);
    owner.set(f.path, f.path);
    return { id: f.path, label: basename(f.path), tier: "element", kind: kindOf(f.path), paths: [f.path], of: [feature], bytes: f.bytes, tokens: t.tokens, exact: t.exact };
  };
  const group = (id: string, label: string, paths: string[], members: FileEntry[]): WeaveNode => {
    let tok = 0, exact = true;
    for (const f of members) { const t = tokens(f); tok += t.tokens; exact &&= t.exact; owner.set(f.path, id); }
    return { id, label, tier: "element", kind: majority(members.map((f) => kindOf(f.path))), paths, of: [feature], bytes: members.reduce((s, f) => s + f.bytes, 0), tokens: tok, exact };
  };
  if (files.length <= MAX_ELEMENTS) return { nodes: files.map(fileNode), owner };

  const base = feature === ROOT_FEATURE ? "" : `${feature}/`;
  const direct: FileEntry[] = [];
  const folders = new Map<string, FileEntry[]>();
  for (const f of files) {
    const rest = f.path.slice(base.length).split("/");
    if (rest.length === 1) direct.push(f);
    else {
      const dir = `${base}${rest[0]}/`;
      if (!folders.has(dir)) folders.set(dir, []);
      folders.get(dir)!.push(f);
    }
  }
  let nodes: WeaveNode[] = [
    ...direct.map(fileNode),
    ...[...folders].map(([dir, members]) => (members.length === 1 ? fileNode(members[0]) : group(dir, `${posix.basename(dir)}/`, [dir], members))),
  ];
  if (nodes.length > MAX_ELEMENTS) {
    nodes.sort((a, b) => b.bytes - a.bytes);
    const rest = nodes.slice(MAX_ELEMENTS - 1);
    const restFiles = files.filter((f) => rest.some((n) => n.paths.some((p) => (p.endsWith("/") ? f.path.startsWith(p) : f.path === p))));
    nodes = [...nodes.slice(0, MAX_ELEMENTS - 1), group(`${base || "/"}…`, `${rest.length} more`, rest.flatMap((n) => n.paths), restFiles)];
  }
  return { nodes, owner };
}

function packageManager(root: string): string {
  if (existsSync(join(root, "pnpm-lock.yaml"))) return "pnpm";
  if (existsSync(join(root, "yarn.lock"))) return "yarn";
  if (existsSync(join(root, "bun.lockb")) || existsSync(join(root, "bun.lock"))) return "bun run";
  return "npm run";
}

function toolNodes(root: string, features: string[], hasGit: boolean): WeaveNode[] {
  const tool = (id: string, label: string, command: string, of: string[] = []): WeaveNode =>
    ({ id, label, tier: "element", kind: "tool", paths: [], of, bytes: 0, tokens: 0, command });
  const out: WeaveNode[] = [tool("tool:shell", "Shell", "any other command")];
  if (hasGit) out.push(tool("tool:git", "Git and PRs", "git · gh pr"));
  let scripts: Record<string, string> = {};
  try { scripts = looseJson(readFileSync(join(root, "package.json"), "utf8"))?.scripts ?? {}; } catch { /* no package.json */ }
  const pm = packageManager(root);
  for (const [name, cmd] of Object.entries(scripts).slice(0, MAX_SCRIPTS)) {
    if (typeof cmd !== "string") continue;
    const of = features.filter((f) => f !== ROOT_FEATURE && cmd.includes(f));
    out.push(tool(`tool:${name}`, `${pm} ${name}`, cmd, of));
  }
  return out;
}

function projectName(root: string): string {
  try {
    const name = looseJson(readFileSync(join(root, "package.json"), "utf8"))?.name;
    if (typeof name === "string" && name) return name.replace(/^@[^/]+\//, "");
  } catch { /* fall through */ }
  return basename(root);
}

/**
 * Builds the three-layer map from the project's real files. Deterministic:
 * the same files always give the same map, and no model is involved.
 */
export function scanProject(root: string, tokens: TokenLookup = estimate): ScanResult {
  const files = listFiles(root);
  // Instruction files belong in the core even when a project keeps them out of git.
  for (const name of ["CLAUDE.md", "AGENTS.md"]) {
    if (files.some((f) => f.path === name)) continue;
    try { const st = statSync(join(root, name)); if (st.isFile()) files.push({ path: name, bytes: st.size, mtimeMs: st.mtimeMs }); } catch { /* none */ }
  }
  const core = files.filter((f) => !f.path.includes("/") && CORE_FILES.test(f.path));
  const coreSet = new Set(core.map((f) => f.path));
  const rest = files.filter((f) => !coreSet.has(f.path));
  const featureOf = featureDirs(rest);

  const byFeature = new Map<string, FileEntry[]>();
  for (const f of rest) {
    const id = featureOf(f.path);
    if (!byFeature.has(id)) byFeature.set(id, []);
    byFeature.get(id)!.push(f);
  }
  const featureIds = [...byFeature.keys()].sort((a, b) => (a === ROOT_FEATURE ? 1 : b === ROOT_FEATURE ? -1 : a.localeCompare(b)));

  let coreTokens = 0, coreExact = true;
  for (const f of core) { const t = tokens(f); coreTokens += t.tokens; coreExact &&= t.exact; }
  const nodes: WeaveNode[] = [{
    id: "core", label: projectName(root), tier: "core", kind: "core", paths: core.map((f) => f.path), of: [],
    bytes: core.reduce((s, f) => s + f.bytes, 0), tokens: coreTokens, exact: coreExact,
  }];
  const owner = new Map<string, string>(core.map((f) => [f.path, "core"]));
  const elements: WeaveNode[] = [];
  for (const id of featureIds) {
    const members = byFeature.get(id)!;
    nodes.push({
      id, label: id === ROOT_FEATURE ? "Project root" : posix.basename(id), tier: "feature", kind: "feature",
      paths: id === ROOT_FEATURE ? [] : [`${id}/`], of: [], bytes: 0, tokens: 0,
    });
    const built = elementsFor(id, members, tokens);
    elements.push(...built.nodes);
    for (const [file, node] of built.owner) owner.set(file, node);
  }

  // Shared elements and rule links come from imports.
  const elementById = new Map(elements.map((e) => [e.id, e]));
  const featureOfNode = (id: string) => elementById.get(id)?.of[0];
  const links = new Map<string, Link>();
  for (const [from, targets] of scanImports(root, files.map((f) => f.path))) {
    const a = owner.get(from);
    const A = a ? elementById.get(a) : undefined;
    if (!A) continue;
    for (const to of targets) {
      const b = owner.get(to);
      const B = b ? elementById.get(b) : undefined;
      if (!B || A === B) continue;
      if (A.kind === "test") {
        const f = featureOfNode(B.id);
        if (f && !A.of.includes(f)) A.of.push(f);
        links.set(`${A.id}>${B.id}`, { from: A.id, to: B.id, why: "tests" });
      } else {
        const f = featureOfNode(A.id);
        if (f && !B.of.includes(f)) B.of.push(f);
        links.set(`${B.id}>${A.id}`, { from: B.id, to: A.id, why: "is imported by" });
      }
    }
  }

  nodes.push(...elements, ...toolNodes(root, featureIds, existsSync(join(root, ".git"))));
  return { nodes, links: [...links.values()].slice(0, 4000), files: Object.fromEntries(owner) };
}
