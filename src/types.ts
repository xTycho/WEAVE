/** Three layers: the core context, the folders (features) it routes to, and the elements each folder holds. */
export type Tier = "core" | "feature" | "element";
export type Kind = "core" | "feature" | "code" | "design" | "doc" | "test" | "tool";

export interface WeaveNode {
  id: string;
  label: string;
  tier: Tier;
  kind: Kind;
  /** Project-relative POSIX paths. A trailing slash marks a folder. */
  paths: string[];
  /** Features this node belongs to. More than one makes it a shared element. */
  of: string[];
  bytes: number;
  /** Estimated tokens (bytes / 4). */
  tokens: number;
  /** Tool nodes: the command this node stands for. */
  command?: string;
}

/** "When `to` is edited, `from` is probably needed too." */
export interface Link {
  from: string;
  to: string;
  why: "tests" | "is imported by";
}

export interface Settings {
  /** The model's context window in tokens; every meter rule is a share of it. */
  window: number;
  /** Share of the window from which /compact is suggested when much of the thread is stale. */
  compactAt: number;
  /** Tell threads when to /compact, /clear or hand work to an area's subagent. */
  meter: boolean;
  /** "command" suggests /compact and /clear; "thread" suggests a new thread instead, for where slash commands cannot be typed. */
  fresh: "command" | "thread";
}

export interface ContextMap {
  version: 3;
  scannedAt?: string;
  nodes: WeaveNode[];
  links: Link[];
  settings: Settings;
  updatedAt?: string;
}

export interface ScanResult {
  nodes: WeaveNode[];
  links: Link[];
  /** Project-relative file -> node id, for every file the scan saw. */
  files: Record<string, string>;
}

/**
 * A group of features that threads use together, worked out from the
 * activity log by fixed rules. Each area gets its own subagent.
 */
export interface Area {
  id: string;
  name: string;
  /** The subagent's name, `weave-<id>`. */
  agent: string;
  features: string[];
  folders: string[];
  /** The area's most used files, busiest first. */
  files: string[];
  tokens: number;
  /** Threads that worked in this area. */
  threads: number;
  /** "usage" once threads have worked in it, else "folders" from the scan alone. */
  from: "usage" | "folders";
}

export type Verb = "Read" | "Edit" | "Run" | "PR";

/** One line of `.claude/weave/activity.jsonl`, written by the Claude Code hook after each tool call. */
export interface ActivityEvent {
  t: number;
  /** Session id of the thread that acted. */
  s: string;
  /** Older logs also hold "start" lines; only "end" lines count. */
  ph?: "start" | "end";
  verb: Verb;
  node: string;
  path?: string;
  tool: string;
  /** The call ran inside a subagent, so its reads stayed out of the thread's own context. */
  sub?: boolean;
}

export interface ThreadInfo {
  id: string;
  /** "Thread <n>" until a title tool or the map renames it. */
  name: string;
  /** Numbered in the order threads first appear. */
  n?: number;
  /** Named by a title tool or by the user in the map. */
  named?: boolean;
  startedAt: number;
  lastSeen: number;
  transcript?: string;
  /** Times of the thread's last few user messages, oldest first. */
  prompts?: number[];
  /** First line of the thread's last few user messages, oldest first. */
  asks?: string[];
  /** Prompt time of the last meter line, so a thread hears at most one per message. */
  nudged?: number;
  /** Tokens in the thread's context window, read from its transcript. */
  contextTokens?: number;
}

export type MeterLevel = "ok" | "delegate" | "compact" | "clear";

export interface Meter {
  level: MeterLevel;
  tokens?: number;
  window: number;
  /** tokens / window, 0 to 1. */
  share: number;
  /** Tokens of files the thread read or edited but has moved on from. */
  stale: number;
  /** The line for the user, when level is not ok. */
  text?: string;
  /** For "delegate": the subagent to hand the work to. */
  agent?: string;
}
