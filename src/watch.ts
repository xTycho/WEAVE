import { existsSync, mkdirSync, unwatchFile, watch, watchFile, type FSWatcher } from "node:fs";
import { relative, resolve, sep } from "node:path";

export interface Watcher { close(): void }

/** Calls `fn` once things settle: every call within `ms` of the last one restarts the timer. */
export function debounce(fn: () => void, ms: number): (() => void) & { cancel(): void } {
  let timer: NodeJS.Timeout | undefined;
  const run = () => { clearTimeout(timer); timer = setTimeout(fn, ms); };
  return Object.assign(run, { cancel: () => clearTimeout(timer) });
}

/**
 * Watches single files through their folder (atomic renames replace the inode,
 * which breaks a watch on the file itself) plus a slow stat poll as a backstop,
 * since fs.watch is unreliable on some network drives and containers.
 */
export function watchFiles(files: string[], onChange: (file: string) => void, ms = 120): Watcher {
  const abs = files.map((f) => resolve(f));
  const dirs = [...new Set(abs.map((f) => resolve(f, "..")))];
  const pending = new Set<string>();
  const flush = debounce(() => { const list = [...pending]; pending.clear(); list.forEach(onChange); }, ms);
  const watchers: FSWatcher[] = [];
  for (const dir of dirs) {
    try {
      mkdirSync(dir, { recursive: true });
      watchers.push(watch(dir, (_e, name) => {
        if (!name) return;
        const hit = abs.find((f) => f === resolve(dir, name.toString()));
        if (hit) { pending.add(hit); flush(); }
      }));
    } catch { /* polling below still covers it */ }
  }
  for (const f of abs) watchFile(f, { interval: 1000 }, (cur, prev) => { if (cur.mtimeMs !== prev.mtimeMs || cur.size !== prev.size) { pending.add(f); flush(); } });
  return {
    close() {
      flush.cancel();
      watchers.forEach((w) => w.close());
      abs.forEach((f) => unwatchFile(f));
    },
  };
}

const IGNORED = /(^|[\\/])(\.git|node_modules|\.claude|dist|build|out|coverage|\.next|\.turbo|\.cache|\.venv|venv|__pycache__|target)([\\/]|$)/;

/**
 * Watches the whole project for file changes and calls `onChange` once per burst.
 * Uses recursive fs.watch where the platform supports it, else a periodic tick.
 */
export function watchProject(root: string, onChange: () => void, ms = 600): Watcher {
  const fire = debounce(onChange, ms);
  if (!existsSync(root)) return { close() {} };
  try {
    const w = watch(root, { recursive: true }, (_e, name) => {
      if (!name) return fire();
      const rel = relative(root, resolve(root, name.toString()));
      if (!IGNORED.test(rel.split(sep).join("/"))) fire();
    });
    return { close() { fire.cancel(); w.close(); } };
  } catch {
    const timer = setInterval(fire, 15_000);
    return { close() { fire.cancel(); clearInterval(timer); } };
  }
}
