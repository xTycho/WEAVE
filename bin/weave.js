#!/usr/bin/env node
// WEAVE CLI: init | ui | mcp | hook | scan | agents | status | desktop | help
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const PKG_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const BIN = resolve(PKG_ROOT, "bin", "weave.js");
const MARKER = "# WEAVE context router";

const args = process.argv.slice(2);
const command = args[0] ?? "help";
const flag = (name) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? undefined : args[i + 1] && !args[i + 1].startsWith("--") ? args[i + 1] : true;
};
const root = resolve(typeof flag("dir") === "string" ? flag("dir") : process.cwd());
const log = (msg) => console.log(`  ${msg}`);

async function engine(module = "index.js") {
  const entry = resolve(PKG_ROOT, "dist", module);
  if (!existsSync(entry)) {
    console.error("[weave] Compiled engine not found. Run `npm run build` inside the WEAVE package.");
    process.exit(1);
  }
  return import(pathToFileURL(entry).href);
}

function readJson(file, fallback) {
  if (!existsSync(file)) return fallback;
  try { return JSON.parse(readFileSync(file, "utf8")); } catch { return undefined; }
}

function writeJson(file, value) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(value, null, 2) + "\n");
}

/** The MCP server entry with absolute paths, so it works from any working directory. */
const mcpEntry = (dir) => ({ command: process.execPath, args: [BIN, "mcp", "--dir", dir] });
/** Only the tools the hook acts on, so other calls never start a node process. */
const TOOL_MATCHER = "^(Read|NotebookRead|Grep|Glob|LS|Edit|MultiEdit|Write|NotebookEdit|Bash)$|pull_request|(^|__)(set_thread_label|set_session_title|weave_name_thread)$";
const hookCommand = (dir) => `"${process.execPath}" "${BIN}" hook --dir "${dir}"`;

function desktopConfigPath() {
  if (process.platform === "darwin") return resolve(homedir(), "Library", "Application Support", "Claude", "claude_desktop_config.json");
  if (process.platform === "win32") return resolve(process.env.APPDATA ?? resolve(homedir(), "AppData", "Roaming"), "Claude", "claude_desktop_config.json");
  return resolve(process.env.XDG_CONFIG_HOME ?? resolve(homedir(), ".config"), "Claude", "claude_desktop_config.json");
}

async function init() {
  const { ContextStore, writeAgents, projectName, areas, recentEvents } = await engine();
  console.log(`\nWEAVE init -> ${root}\n`);

  // 1. CLAUDE.md router: appended once; an older WEAVE router is replaced, the rest of the file is never touched
  const claudeMd = resolve(root, "CLAUDE.md");
  const router = readFileSync(resolve(PKG_ROOT, "templates", "CLAUDE.md"), "utf8");
  if (!existsSync(claudeMd)) { writeFileSync(claudeMd, router); log("create CLAUDE.md"); }
  else {
    const text = readFileSync(claudeMd, "utf8");
    const at = text.indexOf(MARKER);
    if (at === -1) { appendFileSync(claudeMd, `\n${router}`); log("update CLAUDE.md (router appended)"); }
    else {
      // The router runs to the next heading or the end of the file.
      const next = text.slice(at + MARKER.length).search(/\n#{1,2} /);
      const end = next === -1 ? text.length : at + MARKER.length + next + 1;
      const updated = text.slice(0, at) + router + text.slice(end);
      if (updated !== text) { writeFileSync(claudeMd, updated); log("update CLAUDE.md (router replaced)"); } else log("skip   CLAUDE.md (router current)");
    }
  }

  // 2. Map from the project's real files, and a subagent per area
  const store = new ContextStore(root);
  const map = store.rescan();
  const features = map.nodes.filter((n) => n.tier === "feature").length;
  const elements = map.nodes.filter((n) => n.tier === "element").length;
  log(`scan   .claude/context-map.json (${features} features, ${elements} elements)`);
  const { written } = writeAgents(root, projectName(map), areas(map, recentEvents(store.paths)));
  log(`agents .claude/agents/ (${written.length} weave subagents written)`);

  // 3. MCP server for Claude Code
  const mcpFile = resolve(root, ".mcp.json");
  const mcp = readJson(mcpFile, { mcpServers: {} });
  if (!mcp) log("warn   .mcp.json unreadable, left untouched");
  else { mcp.mcpServers ??= {}; mcp.mcpServers.weave = mcpEntry(root); writeJson(mcpFile, mcp); log("update .mcp.json (weave server, absolute paths)"); }

  // 4. Hooks for the map note, activity and the meter (local settings, not committed)
  if (flag("no-hooks") !== true) {
    const settingsFile = resolve(root, ".claude", "settings.local.json");
    const settings = readJson(settingsFile, {});
    if (!settings) log("warn   .claude/settings.local.json unreadable, hooks not added");
    else {
      settings.hooks ??= {};
      const entry = { type: "command", command: hookCommand(root) };
      const ours = (g) => (g.hooks ?? []).some((h) => String(h.command ?? "").includes(" hook --dir ") && String(h.command).includes("weave"));
      // WEAVE 1 also hooked PreToolUse; that entry is removed and not added back.
      for (const event of ["SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse"]) {
        const list = (settings.hooks[event] ?? []).filter((g) => !ours(g));
        if (event === "PostToolUse") list.push({ matcher: TOOL_MATCHER, hooks: [entry] });
        else if (event !== "PreToolUse") list.push({ hooks: [entry] });
        if (list.length) settings.hooks[event] = list; else delete settings.hooks[event];
      }
      writeJson(settingsFile, settings);
      log("update .claude/settings.local.json (map, activity and meter hooks)");
    }
  }

  // 5. Keep local state out of git
  const gitignore = resolve(root, ".gitignore");
  const current = existsSync(gitignore) ? readFileSync(gitignore, "utf8") : "";
  const rules = [".claude/context-map.json", ".claude/weave/", ".claude/settings.local.json", ".claude/agents/weave-*.md"].filter((r) => !current.split(/\r?\n/).includes(r));
  if (rules.length) { appendFileSync(gitignore, `${current && !current.endsWith("\n") ? "\n" : ""}${rules.join("\n")}\n`); log("update .gitignore"); }

  console.log(`\nDone. Next:\n  weave ui        open the map\n  weave desktop   add WEAVE to Claude Desktop\n  Restart Claude Code to load the weave tools and hooks.\n`);
}

function desktop() {
  const file = desktopConfigPath();
  const entry = mcpEntry(root);
  if (flag("write") === true) {
    const cfg = readJson(file, {});
    if (!cfg) { console.error(`[weave] ${file} is not valid JSON; fix it first.`); process.exit(1); }
    cfg.mcpServers ??= {};
    cfg.mcpServers.weave = entry;
    writeJson(file, cfg);
    console.log(`Added "weave" to ${file}\nRestart Claude Desktop to load it.`);
    return;
  }
  console.log(`Claude Desktop config: ${file}\nAdd this under "mcpServers" (or run \`weave desktop --write\`):\n`);
  console.log(JSON.stringify({ weave: entry }, null, 2));
}

async function readStdin() {
  let data = "";
  for await (const chunk of process.stdin) data += chunk;
  return data;
}

async function status() {
  const { ContextStore, areas, mapNote, recentEvents } = await engine();
  const store = new ContextStore(root);
  const { map, warning } = store.load();
  if (warning) console.log(`note: ${warning}`);
  console.log(mapNote(map, areas(map, recentEvents(store.paths))) ?? "No areas yet.");
}

async function agents() {
  const { ContextStore, areas, writeAgents, projectName, recentEvents } = await engine();
  const store = new ContextStore(root);
  const { map } = store.load();
  const { written, removed } = writeAgents(root, projectName(map), areas(map, recentEvents(store.paths)));
  console.log(`Subagents in .claude/agents/: ${written.length} written, ${removed.length} removed.`);
}

const HELP = `WEAVE: a map of your project that hands work to small subagents and says when to /compact or /clear.

Usage: weave <command> [--dir <path>]

  init [--no-hooks]     Scan the project, write the map and subagents, register MCP and hooks
  ui [--port <n>]       Open the map (default port 3000, walks up if taken)
  mcp                   Run the MCP server over stdio (Claude Code and Claude Desktop)
  desktop [--write]     Print, or write, the Claude Desktop config with absolute paths
  scan                  Rescan the project now
  agents                Rewrite the weave subagents from the current areas
  status                Print the map note a thread gets
  hook                  Used by Claude Code hooks; reads one event on stdin
  help                  Show this message
`;

switch (command) {
  case "init": await init(); break;
  case "ui":
  case "dashboard": {
    const { startDashboard } = await engine();
    const d = await startDashboard({ root, port: Number(flag("port")) || undefined, host: typeof flag("host") === "string" ? flag("host") : undefined });
    console.log(`[weave] map running at ${d.url}  (Ctrl+C to stop)`);
    const stop = () => d.close().then(() => process.exit(0));
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
    break;
  }
  case "mcp": { const { startMcpServer } = await engine(); await startMcpServer(root); break; }
  case "hook": {
    // Never block Claude on a WEAVE problem: any failure exits 0 silently.
    try {
      const { handleHook } = await engine("hooks/hook.js");
      const input = JSON.parse((await readStdin()) || "{}");
      const out = handleHook(input, typeof flag("dir") === "string" ? root : input.cwd ?? root);
      if (out.stdout) process.stdout.write(out.stdout);
      process.exit(out.exitCode);
    } catch { process.exit(0); }
    break;
  }
  case "scan": {
    const { ContextStore } = await engine();
    const map = new ContextStore(root).rescan();
    console.log(`Scanned ${map.nodes.length} nodes into .claude/context-map.json`);
    break;
  }
  case "status": await status(); break;
  case "desktop": desktop(); break;
  case "agents": await agents(); break;
  case "help": case "--help": case "-h": console.log(HELP); break;
  default:
    console.error(`Unknown command "${command}".\n`);
    console.log(HELP);
    process.exit(1);
}
