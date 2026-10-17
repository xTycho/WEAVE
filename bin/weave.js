#!/usr/bin/env node
// WEAVE CLI: `weave init | ui | mcp | status | help`
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync, copyFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const PKG_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const TEMPLATES = join(PKG_ROOT, "templates");
const MARKER = "# WEAVE Context Router";

const args = process.argv.slice(2);
const command = args[0] ?? "help";
const flag = (name) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? undefined : args[i + 1] && !args[i + 1].startsWith("--") ? args[i + 1] : true;
};
const root = resolve(typeof flag("dir") === "string" ? flag("dir") : process.cwd());
const log = (msg) => console.log(`  ${msg}`);

async function loadEngine() {
  const entry = join(PKG_ROOT, "dist", "index.js");
  if (!existsSync(entry)) {
    console.error("[weave] Compiled engine not found. Run `npm run build` inside the WEAVE package.");
    process.exit(1);
  }
  return import(pathToFileURL(entry).href);
}

function writeIfMissing(file, content, label) {
  if (existsSync(file)) return log(`skip   ${label} (exists)`);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, content);
  log(`create ${label}`);
}

function init() {
  const force = flag("force") === true;
  console.log(`\nWEAVE init -> ${root}\n`);

  // 1. .claude/ scaffold: one short placeholder note per path in the starter map
  const claude = join(root, ".claude");
  mkdirSync(join(claude, "features"), { recursive: true });
  const starter = JSON.parse(readFileSync(join(TEMPLATES, "default-map.json"), "utf8"));
  for (const node of starter.nodes) {
    if (node.tier === "core") continue;
    for (const p of node.paths) {
      const rel = p.endsWith("/") ? `${p}overview.md` : p;
      const kind = node.tier === "feature" ? "Feature" : "Outer context";
      writeIfMissing(join(root, rel), `# ${node.label}\n${kind} notes for \`${node.id}\`. Keep this short; replace with real details.\n`, rel);
    }
  }

  // 2. Context map from the anonymised template
  const mapFile = join(claude, "context-map.json");
  if (existsSync(mapFile) && !force) log("skip   .claude/context-map.json (exists, use --force to reset)");
  else {
    copyFileSync(join(TEMPLATES, "default-map.json"), mapFile);
    log("create .claude/context-map.json");
  }

  // 3. CLAUDE.md router (append once, never clobber)
  const claudeMd = join(root, "CLAUDE.md");
  const router = readFileSync(join(TEMPLATES, "CLAUDE.md"), "utf8");
  if (!existsSync(claudeMd)) {
    writeFileSync(claudeMd, router);
    log("create CLAUDE.md");
  } else if (!readFileSync(claudeMd, "utf8").includes(MARKER)) {
    appendFileSync(claudeMd, `\n${router}`);
    log("update CLAUDE.md (router appended)");
  } else log("skip   CLAUDE.md (router present)");

  // 4. Register the MCP server for Claude Code
  const mcpFile = join(root, ".mcp.json");
  let mcp = { mcpServers: {} };
  if (existsSync(mcpFile)) {
    try { mcp = JSON.parse(readFileSync(mcpFile, "utf8")); } catch { log("warn   .mcp.json unreadable, leaving it untouched"); mcp = null; }
  }
  if (mcp) {
    mcp.mcpServers ??= {};
    if (mcp.mcpServers.weave && !force) log("skip   .mcp.json (weave already registered)");
    else {
      mcp.mcpServers.weave = { command: "npx", args: ["-y", "github:xTycho/WEAVE", "mcp"] };
      writeFileSync(mcpFile, JSON.stringify(mcp, null, 2) + "\n");
      log("update .mcp.json (weave MCP server registered)");
    }
  }

  // 5. Keep local state out of git
  const gitignore = join(root, ".gitignore");
  const rule = ".claude/context-map.json";
  const current = existsSync(gitignore) ? readFileSync(gitignore, "utf8") : "";
  if (!current.split(/\r?\n/).includes(rule)) {
    appendFileSync(gitignore, `${current && !current.endsWith("\n") ? "\n" : ""}${rule}\n`);
    log("update .gitignore");
  }

  console.log("\nDone. Next:\n  npx github:xTycho/WEAVE ui    # open the dashboard\n  Restart Claude Code to load the weave MCP tools.\n");
}

async function status() {
  const { ContextStore, activeContext } = await loadEngine();
  const store = new ContextStore(root);
  const { map, source, warning } = store.load();
  const ctx = activeContext(map, store.root);
  if (warning) console.log(`warning: ${warning}`);
  console.log(`source: ${source}\nactive: ${ctx.active.join(", ") || "(none)"}`);
  for (const p of ctx.paths) console.log(`  ${p}`);
}

const HELP = `WEAVE - route active features, sever idle context cords.

Usage: weave <command> [--dir <path>]

  init [--force]      Scaffold .claude/, CLAUDE.md router and .mcp.json in a project
  ui [--port <n>]     Start the visual dashboard (default port 3000, auto-fallback)
  mcp                 Run the MCP server over stdio (used by Claude Code)
  status              Print the currently active context paths
  help                Show this message
`;

switch (command) {
  case "init":
    init();
    break;
  case "ui":
  case "dashboard": {
    const { startDashboard } = await loadEngine();
    const port = Number(flag("port")) || undefined;
    const d = await startDashboard({ root, port, host: typeof flag("host") === "string" ? flag("host") : undefined });
    console.log(`[weave] dashboard running at ${d.url}  (Ctrl+C to stop)`);
    const stop = () => d.close().then(() => process.exit(0));
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
    break;
  }
  case "mcp": {
    const { startMcpServer } = await loadEngine();
    await startMcpServer(root);
    break;
  }
  case "status":
    await status();
    break;
  case "help":
  case "--help":
  case "-h":
    console.log(HELP);
    break;
  default:
    console.error(`Unknown command "${command}".\n`);
    console.log(HELP);
    process.exit(1);
}
