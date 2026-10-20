# WEAVE

**A map of your project that keeps Claude's threads small.** WEAVE runs on your computer and does two things:

1. **It hands work to small subagents.** It splits the project into areas and writes one Claude Code subagent per area. A subagent works in its own context window and returns a short summary, so the thread that delegated stays small.
2. **It tells you when to /compact or /clear.** A meter watches each thread's real token count and says so, in one line, when compacting or starting fresh would help.

All of it is plain, fixed-rule code. No model builds the map, picks the areas or runs the meter, so it costs no tokens and the same activity always gives the same result. The map server only listens on `127.0.0.1`, and nothing leaves your machine.

---

## Why subagents

A file Claude reads stays in that thread's context until you /compact or /clear. Nothing can take it back out. So the real lever is where the reading happens: when a subagent reads ten files to fix the UI, only its summary lands in your thread.

## Areas

The scanner turns each top-level folder, and each sub-folder of `src/`, `lib/`, `packages/` or `apps/`, into a feature. Root files such as `CLAUDE.md`, `README` and `package.json` are the core that every thread sees.

Areas grow from what your threads actually do:

- With no history yet, every feature is its own area.
- Two features join into one area when at least 2 threads worked in both, and those threads are at least half of the threads that worked in either.
- Joins chain, so features that are always used together end up as one area.
- An area lists its 8 most used files, so its subagent knows where to start.

## Subagents

WEAVE writes one file per area (the 8 busiest areas) to `.claude/agents/weave-<area>.md`. Each one has the area's folders, its most used files, and two rules: stay inside the area, and reply with a short summary of paths, findings and anything left open.

Claude Code picks up changed agent files within seconds. WEAVE rewrites them when a thread starts, on `weave agents`, and from the map. It never touches an agent file it did not write.

A new thread's first note lists the areas and their subagents, in about 100 to 200 tokens:

```
WEAVE map of your-project (~75.1k tokens). Areas and their subagents:
- weave-src-ui: src/ui/ (~22.4k)
- weave-src-engine-src-hooks: src/engine/, src/hooks/ (~11.8k)
Hand a task that stays inside one area to its subagent: it works in its own context and returns a summary, so this thread stays small. Do quick lookups and cross-area edits here.
```

## The meter

The meter reads each thread's context size from the usage numbers Claude Code writes to its transcript. It measures against your window size (200k by default, or 1M), which you set once in the map. A thread hears at most one line per message:

| Line | When |
|---|---|
| **Hand off** to `weave-<area>` | From 40% of the window, when this message's files all sit in one area with a subagent. Claude can act on this one itself. |
| **/compact** | From 80% of the window. Earlier, from 60%, when at least a quarter of the thread is files it has moved on from (files it last used before its last 3 messages). |
| **/clear** | A message's first few file actions touch at least two files, all in folders the thread never used before, and the thread already holds 20% of the window. The line carries over the earlier task, the files it edited and how many files are uncommitted. |

Only you can run /compact and /clear, so the line asks Claude to tell you. A subagent's own reads are left out, since they never reached the thread. The 60% threshold and the window size are in the gear menu, and the meter can be switched off there.

---

## Install

Requires Node.js 18.17 or newer.

```bash
npm install -g github:xTycho/WEAVE      # gives you the `weave` command
cd /path/to/your-project
weave init                              # scan, write the map and subagents, register MCP and hooks
weave ui                                # open http://127.0.0.1:3000
```

`weave init` does five things, and you can run it again at any time (it also upgrades a WEAVE 1 install):

1. It adds a short WEAVE section to `CLAUDE.md`, or replaces an older WEAVE section. The rest of the file is never touched.
2. It scans the project into `.claude/context-map.json` and writes the subagents.
3. It registers the `weave` MCP server in `.mcp.json`, using absolute paths.
4. It adds hooks to `.claude/settings.local.json` (local, uncommitted) for SessionStart, UserPromptSubmit, and PostToolUse on file, shell and title tools only. Skip this with `--no-hooks`.
5. It adds WEAVE's local state to `.gitignore`.

Restart Claude Code afterwards so it loads the tools and hooks.

## The map

`weave ui` opens a live map of the project: the core in the middle, folders around it, files on the outside. Reads flow in to the core, edits flow out, commands go out and back, and a PR gathers the edited files. The side panel lists:

- **Areas and subagents.** Click an area to highlight it on the map. **Rewrite subagents** and **Rescan** are below the list.
- **Threads**, each with a bar for how full its window is and the meter's advice. Double-click a name to rename it. The cross ends a thread on the map; its activity stays, so the areas keep what it taught them.
- **Live** and **History**, with what threads are touching right now and lately.

## MCP tools

Every tool returns paths and names, never file contents.

| Tool | What it does |
|---|---|
| `weave_map` | Lists the areas: folders, most used files, tokens and subagent |
| `weave_area_for` | Says which area a path is in, and its subagent |
| `weave_name_thread` | Names this thread on the map; the hook reads the name from the call |

## Claude Desktop

`weave desktop` prints the MCP entry for Claude Desktop's global config, and `weave desktop --write` merges it in. It uses absolute paths, so the location Desktop starts from does not matter. Restart Desktop afterwards.

## Commands

```
weave init [--no-hooks]     scan, write the map and subagents, register MCP and hooks
weave ui [--port 3000]      open the map (walks to the next port if 3000 is taken)
weave mcp                   MCP server over stdio (Claude Code and Claude Desktop)
weave desktop [--write]     Claude Desktop config with absolute paths
weave scan                  rescan now (the map also rescans when files change)
weave agents                rewrite the subagents from the current areas
weave status                print the note a new thread receives
```

Every command takes `--dir <path>` to point at a project other than the current folder.

## Files WEAVE writes

| Path | What it holds | In git? |
|---|---|---|
| `.claude/context-map.json` | Scanned nodes and links, and the meter settings. A broken file is kept as `.bak` before it is rebuilt. | No |
| `.claude/agents/weave-*.md` | One subagent per area | No |
| `.claude/weave/activity.jsonl` | Which files threads touched, and when; rotates at 512 KB | No |
| `.claude/weave/threads.json` | Thread names, transcript paths and recent message times | No |
| `.claude/settings.local.json` | The hooks | No |

Token counts are estimates (file size ÷ 4), made offline.

## Project layout

```
bin/weave.js            CLI
src/scanner/            file listing, import parsing, the three-layer scan
src/engine/             areas, subagent files, the meter, the activity log
src/store.ts            reads and writes the map file (atomic, never throws on read)
src/server/             local HTTP + WebSocket server for the map
src/mcp/                MCP server and tools
src/hooks/              Claude Code hook handler
src/ui/                 the map (Vite); src/ui/dist is committed so it works without a build
```

## Development

```bash
npm install
npm run build      # server (tsc) and map (vite)
npm test
npm run dev:ui     # map with hot reload; run `weave ui` alongside it for the API
```

WEAVE 1, with presets, warm and cold heat, freezing and start lines, is kept at the `v1-legacy` tag.

## License

MIT. Third-party notices are in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
