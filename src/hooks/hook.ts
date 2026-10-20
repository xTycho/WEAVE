import { appendEvent, readThreads, recentEvents, writeThread } from "../engine/activity.js";
import { frozen, frozenLine, KEEP_PROMPTS } from "../engine/freeze.js";
import { warmth } from "../engine/heat.js";
import { suggestions } from "../engine/rules.js";
import { attach, isLive, nodeForPath, presetFor, wake, windowNote } from "../engine/window.js";
import { toRelative } from "../paths.js";
import { ContextStore } from "../store.js";
import type { ActivityEvent, ContextMap, Verb, WeaveNode } from "../types.js";

/**
 * Claude Code hook handler: `weave hook` reads one hook payload on stdin.
 * Plain code, no model: it logs what a thread does so the map can show it,
 * gates detached files when the user chose Block, tells a new thread which
 * context window it runs on, and tells it per message which files are frozen.
 */

export interface HookInput {
  hook_event_name?: string;
  session_id?: string;
  transcript_path?: string;
  cwd?: string;
  prompt?: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  tool_use_id?: string;
}

interface Classified { verb: Verb; node: WeaveNode; path?: string }

const READ_TOOLS = new Set(["Read", "NotebookRead", "Grep", "Glob", "LS"]);
const EDIT_TOOLS = new Set(["Edit", "MultiEdit", "Write", "NotebookEdit"]);

function byId(map: ContextMap, id: string): WeaveNode | undefined {
  return map.nodes.find((n) => n.id === id);
}

/** Maps a tool call to a verb and the node it touches. Undefined when it touches nothing on the map. */
export function classify(map: ContextMap, root: string, tool: string, input: Record<string, unknown> = {}): Classified | undefined {
  const pathArg = [input.file_path, input.notebook_path, input.path].find((v): v is string => typeof v === "string");
  if (READ_TOOLS.has(tool) || EDIT_TOOLS.has(tool)) {
    const rel = pathArg ? toRelative(root, pathArg) : undefined;
    const node = rel ? nodeForPath(map, rel) : undefined;
    return node ? { verb: EDIT_TOOLS.has(tool) ? "Edit" : "Read", node, path: rel } : undefined;
  }
  if (/pull_request/i.test(tool) && /create/i.test(tool)) {
    const git = byId(map, "tool:git");
    return git ? { verb: "PR", node: git } : undefined;
  }
  if (tool === "Bash" && typeof input.command === "string") {
    const cmd = input.command;
    if (/\bgh\s+pr\s+create\b/.test(cmd)) { const git = byId(map, "tool:git"); if (git) return { verb: "PR", node: git }; }
    if (/(^|[;&|\s])git\s/.test(cmd)) { const git = byId(map, "tool:git"); if (git) return { verb: "Run", node: git }; }
    const script = map.nodes.find((n) => n.kind === "tool" && n.id.startsWith("tool:") && n.label.includes(" ") &&
      new RegExp(`\\b(npm run|pnpm( run)?|yarn( run)?|bun run)\\s+${n.id.slice(5).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(\\s|$)`).test(cmd));
    const shell = script ?? byId(map, "tool:shell");
    return shell ? { verb: "Run", node: shell } : undefined;
  }
  return undefined;
}

export interface HookOutput {
  stdout?: string;
  exitCode: number;
}

const json = (v: unknown): HookOutput => ({ stdout: JSON.stringify(v), exitCode: 0 });

/** Wrappers that tools and other sessions put around a prompt. They say nothing about the thread. */
const WRAPPERS = /<(system-reminder|relay|wake|note|command-[\w-]+|local-command-[\w-]+)\b[^>]*>[\s\S]*?<\/\1>/gi;
const UNCLOSED = /<(system-reminder|relay|wake|note|command-[\w-]+|local-command-[\w-]+)\b[\s\S]*$/i;

/** A short thread name from its first prompt: wrapper blocks and tags removed. Empty when nothing readable is left. */
export function threadName(prompt: string): string {
  return prompt.replace(WRAPPERS, " ").replace(UNCLOSED, " ").replace(/<\/?[a-z][\w-]*\b[^>]*>?/gi, " ").replace(/\s+/g, " ").trim().slice(0, 48);
}

export function handleHook(input: HookInput, root = input.cwd ?? process.cwd()): HookOutput {
  const store = new ContextStore(root);
  const { map } = store.load(false);
  if (!map.nodes.length || !map.presets.length) return { exitCode: 0 };
  const session = input.session_id ?? "unknown";
  const event = input.hook_event_name;
  const preset = presetFor(map, session);

  if (event === "SessionStart") {
    writeThread(store.paths, session, { transcript: input.transcript_path });
    return json({ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: windowNote(map, preset, warmth(map, preset, recentEvents(store.paths)).warm) } });
  }
  if (event === "UserPromptSubmit") {
    const name = threadName(input.prompt ?? "");
    const prev = readThreads(store.paths)[session];
    const prompts = [...(prev?.prompts ?? []), Date.now()].slice(-KEEP_PROMPTS);
    writeThread(store.paths, session, { transcript: input.transcript_path, prompts, ...(name && !prev?.named ? { name, named: true } : {}) });
    const line = map.settings.freeze ? frozenLine(frozen(map, recentEvents(store.paths), session, prompts).map((n) => n.paths[0] ?? n.id)) : undefined;
    return line ? json({ hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: line } }) : { exitCode: 0 };
  }
  if (event !== "PreToolUse" && event !== "PostToolUse") return { exitCode: 0 };

  const hit = classify(map, store.root, input.tool_name ?? "", input.tool_input);
  if (!hit) return { exitCode: 0 };
  let outside = !isLive(hit.node, preset);
  // An asleep file wakes the moment Claude reads or edits it, whatever the other settings say.
  if (outside && preset.asleep?.includes(hit.node.id)) {
    store.update((m) => { wake(m, preset.id, hit.node.id); });
    outside = false;
  }
  const base: ActivityEvent = { t: Date.now(), s: session, ph: event === "PreToolUse" ? "start" : "end", verb: hit.verb, node: hit.node.id, tool: input.tool_name ?? "", id: input.tool_use_id, ...(hit.path ? { path: hit.path } : {}), ...(outside ? { outside: true } : {}) };

  if (event === "PreToolUse" && outside && map.settings.gate === "block" && hit.node.kind !== "tool") {
    appendEvent(store.paths, { ...base, blocked: true });
    return json({
      hookSpecificOutput: {
        hookEventName: "PreToolUse", permissionDecision: "deny",
        permissionDecisionReason: `WEAVE: ${hit.path ?? hit.node.label} is detached from this thread's context window "${preset.name}". Ask the user to reattach it in the WEAVE map, or work without it.`,
      },
    });
  }
  appendEvent(store.paths, base);
  if (event === "PostToolUse") {
    writeThread(store.paths, session, {});
    if (map.settings.autoApply) {
      // Only reattaching is automatic; detaching always waits for the user.
      const attachable = suggestions(map, preset, recentEvents(store.paths)).filter((s) => s.attach);
      if (attachable.length) store.update((m) => { for (const s of attachable) attach(m, preset.id, s.node); });
    }
  }
  return { exitCode: 0 };
}
