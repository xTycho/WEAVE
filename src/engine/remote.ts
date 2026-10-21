import { closeSync, openSync, readSync, statSync } from "node:fs";

/** The words the server and the page show for a session WEAVE may only watch. */
export const REMOTE_MESSAGE = "Started by Remote Control, so WEAVE only tracks it. Resuming it here would make a second live copy of the thread.";

/** How much of a transcript's start is read. Every marker below sits in the first few entries. */
const HEAD = 256 * 1024;

/**
 * A fixed rule for sessions started by the Claude desktop app's Remote Control,
 * worked out from the transcript's first lines. Any one of these marks one:
 *  - `entrypoint` is "claude-desktop" (a terminal session says "cli", an SDK one "sdk-cli");
 *  - a user entry carries `projectsUserTurn` or `verifiedSlackHumanTurn`, which only relayed turns have;
 *  - a user entry's `origin.subkind` is "projects-relay";
 *  - the first user message opens with a `<relay` or `<wake` tag, or names `project_claude_message`.
 */
export function remoteReason(lines: string[]): string | undefined {
  let firstUser = true;
  for (const line of lines) {
    if (!line.trim()) continue;
    let o: Record<string, any>;
    try { o = JSON.parse(line); } catch { continue; }
    if (o.entrypoint === "claude-desktop") return 'entrypoint "claude-desktop"';
    if (o.type !== "user" || o.isMeta) continue;
    if (o.projectsUserTurn || o.verifiedSlackHumanTurn) return "a relayed user turn";
    if (o.origin?.subkind === "projects-relay") return "a projects-relay turn";
    if (firstUser) {
      firstUser = false;
      const c = o.message?.content, text = typeof c === "string" ? c : JSON.stringify(c ?? "");
      if (/^\s*<(relay|wake)\b/.test(text) || text.includes("project_claude_message")) return "a relay or wake message";
    }
  }
  return undefined;
}

const cache = new Map<string, { remote: boolean; at: number }>();
/** A "no" is looked at again after this long, since a transcript can still be young; a "yes" never changes. */
const RECHECK = 60_000;

/** True when the transcript at `file` belongs to a Remote Control session. A missing or unreadable file is not. */
export function isRemoteSession(file: string | undefined, now = Date.now()): boolean {
  if (!file) return false;
  const hit = cache.get(file);
  if (hit && (hit.remote || now - hit.at < RECHECK)) return hit.remote;
  let remote = false;
  let fd: number | undefined;
  try {
    const len = Math.min(statSync(file).size, HEAD), buf = Buffer.alloc(len);
    fd = openSync(file, "r");
    readSync(fd, buf, 0, len, 0);
    const text = buf.toString("utf8");
    remote = remoteReason(text.slice(0, text.lastIndexOf("\n") + 1 || text.length).split("\n")) !== undefined;
  } catch { /* unreadable: treat as a normal session */ } finally { if (fd !== undefined) closeSync(fd); }
  cache.set(file, { remote, at: now });
  return remote;
}
