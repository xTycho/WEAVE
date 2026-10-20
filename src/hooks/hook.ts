import { appendEvent, readThreads, recentEvents, transcriptTokens, writeThread } from "../engine/activity.js";
import { mapNote, projectName, writeAgents } from "../engine/agents.js";
import { agentAreas, areas } from "../engine/areas.js";
import { nodeForPath } from "../engine/map.js";
import { meter, meterLine } from "../engine/meter.js";
import { toRelative } from "../paths.js";
import { ContextStore } from "../store.js";
import type { ContextMap, Verb, WeaveNode } from "../types.js";

/**
 * Claude Code hook handler: `weave hook` reads one hook payload on stdin.
 * Plain code, no model: it logs which files a thread touches, gives a new
 * thread the map of areas and their subagents, and adds at most one meter
 * line per user message.
 */

export interface HookInput {
  hook_event_name?: string;
  session_id?: string;
  transcript_path?: string;
  cwd?: string;
  prompt?: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  /** Set when the call runs inside a subagent. */
  agent_id?: string;
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

const context = (event: string, text: string): HookOutput =>
  ({ stdout: JSON.stringify({ hookSpecificOutput: { hookEventName: event, additionalContext: text } }), exitCode: 0 });

/** Wrappers that tools and other sessions put around a prompt. They say nothing about the thread. */
const WRAPPERS = /<(system-reminder|relay|wake|note|project_claude_message|task-notification|agent-message|command-[\w-]+|local-command-[\w-]+)\b[^>]*>[\s\S]*?<\/\1\b[^>]*>/gi;
const UNCLOSED = /<(system-reminder|relay|wake|note|project_claude_message|task-notification|agent-message|command-[\w-]+|local-command-[\w-]+)\b[\s\S]*$/i;

/** A short thread name from its first prompt: wrapper blocks and tags removed. Empty when nothing readable is left. */
export function threadName(prompt: string): string {
  return prompt.replace(WRAPPERS, " ").replace(UNCLOSED, " ").replace(/<\/?[a-z][\w-]*\b[^>]*>?/gi, " ").replace(/\s+/g, " ").trim().slice(0, 48);
}

/** Tools that set a thread's title in the app, and WEAVE's own naming tool. Their title names the thread on the map. */
const TITLE_TOOLS = /(^|__)(set_thread_label|set_session_title|weave_name_thread)$/;

/** The thread title a tool call sets, if it is one of TITLE_TOOLS. */
export function titleFrom(tool: string, input: Record<string, unknown> = {}): string | undefined {
  if (!TITLE_TOOLS.test(tool)) return undefined;
  const v = [input.label, input.title, input.name].find((x): x is string => typeof x === "string");
  return v?.replace(/\s+/g, " ").trim().slice(0, 80) || undefined;
}

/** Prompts and their first lines kept per thread; the meter needs the last few. */
export const KEEP_PROMPTS = 4;

export function handleHook(input: HookInput, root = input.cwd ?? process.cwd()): HookOutput {
  const store = new ContextStore(root);
  const { map } = store.load(false);
  if (!map.nodes.length) return { exitCode: 0 };
  const session = input.session_id ?? "unknown";
  const event = input.hook_event_name;

  if (event === "SessionStart") {
    writeThread(store.paths, session, { transcript: input.transcript_path });
    const all = areas(map, recentEvents(store.paths));
    // Claude Code picks up changed agent files within seconds, so the areas are fresh for this thread's first hand-off.
    try { writeAgents(store.root, projectName(map), all); } catch { /* read-only checkout: the note still lists the areas */ }
    const note = mapNote(map, all);
    return note ? context("SessionStart", note) : { exitCode: 0 };
  }

  if (event === "UserPromptSubmit") {
    const prev = readThreads(store.paths)[session];
    const name = threadName(input.prompt ?? "");
    const prompts = [...(prev?.prompts ?? []), Date.now()].slice(-KEEP_PROMPTS);
    const asks = [...(prev?.asks ?? []), name].slice(-KEEP_PROMPTS);
    const thread = writeThread(store.paths, session, { transcript: input.transcript_path ?? prev?.transcript, prompts, asks, ...(name && !prev?.named ? { name, named: true } : {}) });
    if (!map.settings.meter) return { exitCode: 0 };
    const events = recentEvents(store.paths);
    const all = areas(map, events);
    const m = meter({ map, events, thread, tokens: transcriptTokens(thread.transcript), areas: all, agents: agentAreas(all), at: "prompt" });
    const line = meterLine(m);
    if (!line) return { exitCode: 0 };
    writeThread(store.paths, session, { nudged: prompts.at(-1) });
    return context("UserPromptSubmit", line);
  }

  if (event !== "PostToolUse") return { exitCode: 0 };
  const title = titleFrom(input.tool_name ?? "", input.tool_input);
  if (title) { writeThread(store.paths, session, { name: title, named: true }); return { exitCode: 0 }; }

  const hit = classify(map, store.root, input.tool_name ?? "", input.tool_input);
  if (!hit) return { exitCode: 0 };
  const sub = !!input.agent_id;
  appendEvent(store.paths, { t: Date.now(), s: session, ph: "end", verb: hit.verb, node: hit.node.id, tool: input.tool_name ?? "", ...(hit.path ? { path: hit.path } : {}), ...(sub ? { sub: true } : {}) });

  // A subagent's work is the hand-off working; the meter only speaks to the thread itself.
  if (sub || !map.settings.meter) return { exitCode: 0 };
  const thread = readThreads(store.paths)[session];
  const start = thread?.prompts?.at(-1);
  if (!thread || !start || thread.nudged === start) return { exitCode: 0 };
  const events = recentEvents(store.paths);
  const all = areas(map, events);
  const m = meter({ map, events, thread, tokens: transcriptTokens(thread.transcript), areas: all, agents: agentAreas(all), at: "tool", root: store.root });
  const line = meterLine(m);
  if (!line) return { exitCode: 0 };
  writeThread(store.paths, session, { nudged: start });
  return context("PostToolUse", line);
}

