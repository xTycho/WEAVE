# WEAVE setup guide (for Claude)

When the user says **"follow the WEAVE setup guide"**, work through these steps in order inside their project. Every step is plain tooling, so there is no model-driven mapping and you never invent nodes. Report what changed when you finish.

## 1. Check the environment

```bash
node --version          # needs 18.17 or newer
command -v weave || npm install -g github:xTycho/WEAVE
```

If a global install is not allowed, clone WEAVE somewhere outside the project, run `npm install`, and use `node /abs/path/to/WEAVE/bin/weave.js` wherever these steps say `weave`.

## 2. Scan the real workspace

From the project root:

```bash
weave init
```

This step:

- scans the files git would track (or walks the folder, honouring `.gitignore`);
- writes `.claude/context-map.json` from what it finds;
- writes one subagent per area to `.claude/agents/weave-<area>.md`;
- registers the MCP server and the hooks with absolute paths.

Do not hand-write nodes or copy a sample map. If the user asked you not to touch hooks, run `weave init --no-hooks` instead.

Check the result:

```bash
weave status            # the areas and subagents a new thread will see
```

If the note lists folders that should not be areas, such as generated output, add them to `.gitignore` and run `weave scan` again.

## 3. Wire up the clients

- **Claude Code:** `weave init` already added `.mcp.json` and the hooks in `.claude/settings.local.json`. Tell the user to restart Claude Code.
- **Claude Desktop:** run `weave desktop --write`. It merges a `weave` entry into the global `claude_desktop_config.json`, using `path.resolve` absolute paths for node, the CLI and the project. Tell the user to restart Claude Desktop.

## 4. Open the map

```bash
weave ui                # http://127.0.0.1:3000, or the next free port
```

- The map uses the light theme by default. The user can switch between Light and Dark with the slider in the top bar.
- Signals always use the Pulse style. **Follow system motion** pauses them when the device asks apps to reduce motion.

## 5. Work with the areas

At the start of each thread you receive a short WEAVE note that lists the project's areas and their subagents. Follow it:

1. Hand a task that stays inside one area to that area's subagent (`weave-<area>`). It works in its own context and returns a summary, so your thread stays small.
2. Do quick lookups and edits that cross areas yourself.
3. `weave_map` lists the areas, and `weave_area_for` says which area a path is in.
4. When a WEAVE line says to run /compact or /clear, tell the user in one line. Only the user can run them.

Guidance to give the developer:

- Keep `CLAUDE.md` short. Area notes belong in that area's folder.
- One concern per folder gives clean areas.
- If they use a 1M context window, set it in the map's gear menu so the meter measures against the right size.
