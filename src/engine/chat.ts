import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { delimiter, join } from "node:path";
import * as nodePty from "@lydell/node-pty";
import { WeaveError } from "./map.js";
import { terminalName } from "./terminal.js";

/** The slice of a pseudo-terminal the chat uses; node-pty's IPty fits it. */
export interface Pty {
  onData(cb: (data: string) => void): unknown;
  onExit(cb: (e: { exitCode: number }) => void): unknown;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(): void;
}
export type PtySpawner = (file: string, args: string[], options: { cwd: string; cols: number; rows: number; env: Record<string, string> }) => Pty;

export const defaultPty: PtySpawner = (file, args, o) => nodePty.spawn(file, args, { name: "xterm-256color", ...o });

/** The only things WEAVE ever types into the chat on its own. */
export const COMMANDS = { compact: "/compact", clear: "/clear" } as const;
export type ChatCommand = keyof typeof COMMANDS;

/** Output kept so a page that reconnects sees the screen so far. */
const BUFFER = 256 * 1024;
/** Automatic /compact waits for this much quiet output (Claude Code is not streaming) and this long since the last one. */
export const AUTO_QUIET = 8000;
export const AUTO_GAP = 120_000;

export interface ChatLaunch { id: string; name: string; file: string; args: string[] }

/** Finds `claude` on PATH. A .cmd shim runs through cmd.exe; nothing else is ever spawned. */
export function resolveClaude(env: NodeJS.ProcessEnv = process.env, platform = process.platform, exists = existsSync): { file: string; prefix: string[] } {
  const dirs = (env.PATH ?? env.Path ?? "").split(delimiter).filter(Boolean);
  const names = platform === "win32" ? ["claude.exe", "claude.cmd"] : ["claude"];
  for (const dir of dirs) for (const name of names) {
    const file = join(dir, name);
    if (exists(file)) return name.endsWith(".cmd") ? { file: env.ComSpec ?? "cmd.exe", prefix: ["/d", "/c", file] } : { file, prefix: [] };
  }
  throw new WeaveError("Could not find `claude` on PATH. Install Claude Code first.");
}

/** Arguments for a new chat, or for resuming `resume`. Only a generated id and a cleaned name vary. */
/** Paths and names that may go into the first note: letters, digits and a few separators, so nothing can reach a shell. */
const SAFE = /^[\w@+. \-/]+$/;

/**
 * The first note for a chat started from a saved context window. It points Claude Code at the files; nothing is preloaded,
 * so Claude reads them like any file and they count toward the window once it does. Undefined when no file is usable.
 */
export function contextNote(name: string, files: string[]): string | undefined {
  const safe = files.filter((f) => SAFE.test(f) && !f.includes("..")).slice(0, 40);
  if (!safe.length) return undefined;
  const label = name.replace(/[^\w .-]/g, " ").replace(/\s+/g, " ").trim().slice(0, 60) || "saved window";
  let list = "";
  for (const f of safe) { if ((list + f).length > 1800) break; list += (list ? ", " : "") + f; }
  return `Context window ${label}. These are the files an earlier thread used for this kind of task, hottest first: ${list}. Nothing is preloaded. Read the ones this task needs before you start.`;
}

export function chatLaunch(opts: { name?: string; fallback: string; resume?: string; note?: string }, claude = resolveClaude()): ChatLaunch {
  const name = terminalName(opts.name, opts.fallback);
  const id = opts.resume ?? randomUUID();
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw new WeaveError("Not a session id.");
  const args = opts.resume ? ["--resume", id] : ["--session-id", id, "--name", name, ...(opts.note ? [opts.note] : [])];
  return { id, name, file: claude.file, args: [...claude.prefix, ...args] };
}

/** Whether WEAVE should type /compact into the chat now. Fixed rule: only when the setting is on, the meter says compact, the screen is quiet, and the last one was a while ago. */
export function shouldAutoCompact(i: { auto: boolean; level: string; quietMs: number; sinceLastMs: number }): boolean {
  return i.auto && i.level === "compact" && i.quietMs >= AUTO_QUIET && i.sinceLastMs >= AUTO_GAP;
}

/** One Claude Code session on a pseudo-terminal, shared by whichever pages are attached. */
export class ChatSession {
  readonly id: string;
  readonly name: string;
  exited?: number;
  lastOutput = Date.now();
  lastCommand = 0;
  private buffer = "";
  private readonly listeners = new Set<(msg: ChatMessage) => void>();
  private readonly pty: Pty;

  constructor(launch: ChatLaunch, cwd: string, spawn: PtySpawner = defaultPty) {
    this.id = launch.id;
    this.name = launch.name;
    try {
      this.pty = spawn(launch.file, launch.args, { cwd, cols: 100, rows: 30, env: { ...(process.env as Record<string, string>), TERM: "xterm-256color" } });
    } catch (err) {
      throw new WeaveError(`Could not start Claude Code: ${(err as Error).message}`);
    }
    this.pty.onData((data) => {
      this.lastOutput = Date.now();
      this.buffer = (this.buffer + data).slice(-BUFFER);
      this.emit({ type: "output", data });
    });
    this.pty.onExit((e) => { this.exited = e.exitCode; this.emit({ type: "exit", code: e.exitCode }); });
  }

  private emit(msg: ChatMessage) { for (const l of this.listeners) l(msg); }

  /** Sends the screen so far, then everything new. Returns a detach function. */
  attach(listener: (msg: ChatMessage) => void): () => void {
    if (this.buffer) listener({ type: "output", data: this.buffer });
    if (this.exited !== undefined) listener({ type: "exit", code: this.exited });
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  write(data: string) { if (this.exited === undefined) this.pty.write(data); }
  resize(cols: number, rows: number) {
    if (this.exited === undefined && Number.isInteger(cols) && Number.isInteger(rows)) this.pty.resize(Math.min(500, Math.max(10, cols)), Math.min(200, Math.max(3, rows)));
  }

  /** Types a whitelisted slash command and presses Enter a moment later, so Claude Code reads it as a command. */
  command(cmd: ChatCommand, delay = 150) {
    const text = COMMANDS[cmd];
    if (!text) throw new WeaveError("Unknown chat command.");
    if (this.exited !== undefined) throw new WeaveError("The chat has ended.");
    this.lastCommand = Date.now();
    this.write(text);
    setTimeout(() => this.write("\r"), delay).unref?.();
  }

  kill() { try { this.pty.kill(); } catch { /* already gone */ } this.listeners.clear(); }
}

export type ChatMessage = { type: "output"; data: string } | { type: "exit"; code: number };
