/** Three layers: the core context, the features it routes to, and the elements each feature holds. */
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
  tokens: number;
  /** True when every file behind `tokens` was counted exactly. */
  exact?: boolean;
  /** Created in the map rather than found by the scanner. */
  custom?: boolean;
  /** Tool nodes: the command this node stands for. */
  command?: string;
}

/** "When `to` is edited, `from` is probably needed too." */
export interface Link {
  from: string;
  to: string;
  why: "tests" | "is imported by";
}

/** A saved context window. Threads run on one preset; several can share it. */
export interface Preset {
  id: string;
  name: string;
  color: string;
  features: string[];
  detached: string[];
  /**
   * Files the user put to sleep because they were overdue. Asleep files are
   * detached and left out of the thread note, and wake (reattach) the moment
   * a thread on this preset reads or edits them.
   */
  asleep?: string[];
  /** Saved by auto-calibrate. A later auto save with the same name replaces it instead of adding another preset. */
  auto?: boolean;
  /** What a saved preset holds, by `tagFor`: UI, Docs, Tests or a feature name. */
  tag?: string;
  /** Last attach or detach time per node, so old rule evidence does not re-fire. */
  changedAt: Record<string, number>;
}

export interface Override {
  label?: string;
  kind?: Kind;
  /** Extra features this node belongs to. */
  addOf?: string[];
}

export type Gate = "flag" | "block";

export interface Settings {
  autoApply: boolean;
  /** Rank attached files warm or cold by recent use and tell threads to start with the warm ones. */
  warmCold: boolean;
  /** Tell each thread which files it has moved on from, per message. Per thread only; never written into presets. */
  freeze: boolean;
  /** Past each warning, tell the thread once to suggest a new thread with a start line, saving a preset from its warm files when none fits. */
  autoCalibrate: boolean;
  /** Context tokens from which a thread turns amber. */
  heavyAt: number;
  /** Context tokens from which a thread turns red. */
  freshAt: number;
  gate: Gate;
  idleAfter: number;
  defaultPreset: string;
}

export interface ContextMap {
  version: 2;
  scannedAt?: string;
  nodes: WeaveNode[];
  links: Link[];
  presets: Preset[];
  /** Thread (session id) -> preset id. Threads without an entry use the default preset. */
  assign: Record<string, string>;
  overrides: Record<string, Override>;
  custom: WeaveNode[];
  dismissed: string[];
  settings: Settings;
  updatedAt?: string;
}

export interface ScanResult {
  nodes: WeaveNode[];
  links: Link[];
  /** Project-relative file -> node id, for every file the scan saw. */
  files: Record<string, string>;
}

export type Verb = "Read" | "Edit" | "Run" | "PR";

/** One line of `.claude/weave/activity.jsonl`, written by the Claude Code hook. */
export interface ActivityEvent {
  t: number;
  /** Session id of the thread that acted. */
  s: string;
  ph: "start" | "end";
  verb: Verb;
  node: string;
  path?: string;
  tool: string;
  outside?: boolean;
  /** The file was asleep and woke (reattached) for this action. */
  woke?: boolean;
  blocked?: boolean;
  /** Pairs a start with its end. */
  id?: string;
}

export interface ThreadInfo {
  id: string;
  name: string;
  /** Named from the thread's first prompt. */
  named?: boolean;
  startedAt: number;
  lastSeen: number;
  transcript?: string;
  /** Times of the thread's last few user messages, oldest first. */
  prompts?: number[];
  /** Tokens in the thread's context window, read from its transcript. */
  contextTokens?: number;
  /** The highest warning auto-calibrate has already told this thread about. */
  warned?: "heavy" | "full";
}

export interface Suggestion {
  rule: "Asked while detached" | "Linked file" | "Unused";
  node: string;
  attach: boolean;
  text: string;
  key: string;
}
