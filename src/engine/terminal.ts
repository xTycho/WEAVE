import { spawn, type SpawnOptions } from "node:child_process";
import { randomUUID } from "node:crypto";
import { WeaveError } from "./map.js";

export interface TerminalLaunch {
  /** Session id the terminal's Claude Code runs under, so hooks report back to the thread WEAVE already made. */
  id: string;
  name: string;
  command: string;
  args: string[];
}

export type Spawner = (command: string, args: string[], options: SpawnOptions) => { unref(): void; on(event: "error", cb: (err: Error) => void): unknown };

/** Letters, digits, spaces and a few marks only, so the name can sit in a command line unquoted. */
export const terminalName = (name: string | undefined, fallback: string): string =>
  (name ?? "").replace(/[^\p{L}\p{N} _.-]+/gu, " ").replace(/\s+/g, " ").trim().slice(0, 60) || fallback;

/**
 * The command that opens a new console window running Claude Code. Fixed
 * text: only the generated id and the cleaned name vary. `resume` reopens an
 * earlier session under its own id instead of starting a new one.
 */
export function terminalLaunch(opts: { name?: string; fallback: string; resume?: string; id?: string }, platform = process.platform): TerminalLaunch {
  if (platform !== "win32") throw new WeaveError("Opening a terminal from the map works on Windows only for now.");
  const name = terminalName(opts.name, opts.fallback);
  const id = opts.resume ?? opts.id ?? randomUUID();
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw new WeaveError("Not a session id.");
  const claude = opts.resume ? `claude --resume ${id}` : `claude --session-id ${id} --name "${name}"`;
  // `start` gives the session its own window; /D sets the folder; cmd /k keeps the window open after Claude Code exits.
  return { id, name, command: "cmd.exe", args: ["/c", "start", `"${name}"`, "/D", "%CD%", "cmd", "/k", claude] };
}

/** Opens the window in `cwd`. Resolves once the window process has started. */
export function openTerminal(launch: TerminalLaunch, cwd: string, run: Spawner = spawn): Promise<void> {
  return new Promise((done, fail) => {
    // %CD% is expanded by cmd, from the cwd we pass, so the folder never goes through a quoting layer of ours.
    const child = run(launch.command, launch.args, { cwd, detached: true, stdio: "ignore", windowsVerbatimArguments: true, windowsHide: false });
    child.on("error", (err) => fail(new WeaveError(`Could not open a terminal: ${err.message}`)));
    child.unref();
    setTimeout(done, 50);
  });
}
