#!/usr/bin/env node
// WEAVE CLI: init | ui | mcp | hook | scan | status | desktop | key | help
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
const hookCommand = (dir) => `"${process.execPath}" "${BIN}" hook --dir "${dir}"`;

function desktopConfigPath() {
  if (process.platform === "darwin") return resolve(homedir(), "Library", "Application Support", "Claude", "claude_desktop_config.json");
  if (process.platform === "win32") return resolve(process.env.APPDATA ?? resolve(homedir(), "AppData", "Roaming"), "Claude", "claude_desktop_config.json");
  return resolve(process.env.XDG_CONFIG_HOME ?? resolve(homedir(), ".config"), "Claude", "claude_desktop_config.json");
}

async function init() {
  const { ContextStore } = await engine();
  console.log(`\nWEAVE init -> ${root}\n`);

  // 1. CLAUDE.md router (append once, never clobber)
  const claudeMd = resolve(root, "CLAUDE.md");
  const router = readFileSync(resolve(PKG_ROOT, "templates", "CLAUDE.md"), "utf8");
  if (!existsSync(claudeMd)) { writeFileSync(claudeMd, router); log("create CLAUDE.md"); }
  else if (!readFileSync(claudeMd, "utf8").includes(MARKER)) { appendFileSync(claudeMd, `\n${router}`); log("update CLAUDE.md (router appended)"); }
  else log("skip   CLAUDE.md (router present)");

  // 2. Map from the project's real files
  const map = new ContextStore(root).rescan();
  const features = map.nodes.filter((n) => n.tier === "feature").length;
  const elements = map.nodes.filter((n) => n.tier === "element").length;
  log(`scan   .claude/context-map.json (${features} features, ${elements} elements)`);

  // 3. MCP server for Claude Code
  const mcpFile = resolve(root, ".mcp.json");
  const mcp = readJson(mcpFile, { mcpServers: {} });
  if (!mcp) log("warn   .mcp.json unreadable, left untouched");
  else { mcp.mcpServers ??= {}; mcp.mcpServers.weave = mcpEntry(root); writeJson(mcpFile, mcp); log("update .mcp.json (weave server, absolute paths)"); }

  // 4. Hooks for live activity, gating and the per-thread window note (local settings, not committed)
  if (flag("no-hooks") !== true) {
    const settingsFile = resolve(root, ".claude", "settings.local.json");
    const settings = readJson(settingsFile, {});
    if (!settings) log("warn   .claude/settings.local.json unreadable, hooks not added");
    else {
      settings.hooks ??= {};
      const entry = { type: "command", command: hookCommand(root) };
      for (const event of ["SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse"]) {
        const list = (settings.hooks[event] ??= []).filter((g) => !(g.hooks ?? []).some((h) => String(h.command ?? "").includes(" hook --dir ") && String(h.command).includes("weave")));
        list.push(event.endsWith("ToolUse") ? { matcher: "*", hooks: [entry] } : { hooks: [entry] });
        settings.hooks[event] = list;
      }
      writeJson(settingsFile, settings);
      log("update .claude/settings.local.json (activity hooks)");
    }
  }

  // 5. Keep local state out of git
  const gitignore = resolve(root, ".gitignore");
  const current = existsSync(gitignore) ? readFileSync(gitignore, "utf8") : "";
  const rules = [".claude/context-map.json", ".claude/weave/", ".claude/settings.local.json"].filter((r) => !current.split(/\r?\n/).includes(r));
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

/** Reads a secret from the terminal without echoing it. */
function askHidden(question) {
  return new Promise((done) => {
    if (!process.stdin.isTTY) return readStdin().then((d) => done(d.trim()));
    process.stdout.write(question);
    process.stdin.setRawMode(true);
    process.stdin.resume();
    let value = "";
    const onData = (buf) => {
      for (const ch of buf.toString("utf8")) {
        if (ch === "\r" || ch === "\n") { process.stdin.setRawMode(false); process.stdin.pause(); process.stdin.off("data", onData); process.stdout.write("\n"); return done(value.trim()); }
        if (ch === "\u0003") process.exit(130);
        if (ch === "\u007f") value = value.slice(0, -1); else value += ch;
      }
    };
    process.stdin.on("data", onData);
  });
}

async function key() {
  const { saveKey, removeKey, tokenMode } = await engine();
  const sub = args[1] ?? "status";
  if (sub === "set") { saveKey(await askHidden("Anthropic API key (input hidden): ")); console.log("Saved. Exact token counting is on."); }
  else if (sub === "remove") { removeKey(); console.log("Removed. Token counts are estimates again."); }
  const m = tokenMode();
  console.log(m.mode === "exact" ? `Token counts: exact (key from ${m.source === "saved" ? "your private WEAVE config" : "ANTHROPIC_API_KEY"})` : "Token counts: estimated (bytes / 4), fully offline");
}

async function status() {
  const { ContextStore, getPreset, windowNote } = await engine();
  const { map, warning } = new ContextStore(root).load();
  if (warning) console.log(`note: ${warning}`);
  const preset = getPreset(map, typeof flag("preset") === "string" ? flag("preset") : undefined);
  console.log(windowNote(map, preset));
}

const HELP = `WEAVE: a local network map of your project's context.

Usage: weave <command> [--dir <path>]

  init [--no-hooks]     Scan the project, write .claude/context-map.json, register MCP and hooks
  ui [--port <n>]       Open the map (default port 3000, walks up if taken)
  mcp                   Run the MCP server over stdio (Claude Code and Claude Desktop)
  desktop [--write]     Print, or write, the Claude Desktop config with absolute paths
  scan                  Rescan the project now
  status [--preset id]  Print the context window note a thread gets
  key set|remove        Optional: an Anthropic API key for exact token counts
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
  case "key": await key(); break;
  case "help": case "--help": case "-h": console.log(HELP); break;
  default:
    console.error(`Unknown command "${command}".\n`);
    console.log(HELP);
    process.exit(1);
}
