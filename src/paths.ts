import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

/** Every file WEAVE touches in a project, as absolute paths built with path.resolve. */
export interface ProjectPaths {
  root: string;
  claudeDir: string;
  map: string;
  weaveDir: string;
  activity: string;
  threads: string;
  tokenCache: string;
}

export function projectPaths(root: string = process.cwd()): ProjectPaths {
  const abs = resolve(root);
  const claudeDir = resolve(abs, ".claude");
  const weaveDir = resolve(claudeDir, "weave");
  return {
    root: abs,
    claudeDir,
    map: resolve(claudeDir, "context-map.json"),
    weaveDir,
    activity: resolve(weaveDir, "activity.jsonl"),
    threads: resolve(weaveDir, "threads.json"),
    tokenCache: resolve(weaveDir, "token-cache.json"),
  };
}

/** Per-user folder outside every project. Only the optional API key lives here. */
export function userConfigDir(): string {
  if (process.env.WEAVE_CONFIG_DIR) return resolve(process.env.WEAVE_CONFIG_DIR);
  if (process.platform === "win32") return resolve(process.env.APPDATA ?? join(homedir(), "AppData", "Roaming"), "weave");
  return resolve(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "weave");
}

/** Project-relative POSIX path, or undefined when `file` lies outside the project. */
export function toRelative(root: string, file: string): string | undefined {
  const abs = isAbsolute(file) ? resolve(file) : resolve(root, file);
  const rel = relative(root, abs);
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) return undefined;
  return rel.split(sep).join("/");
}
