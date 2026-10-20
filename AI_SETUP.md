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
- registers the MCP server and the activity hooks with absolute paths.

Do not hand-write nodes or copy a sample map. If the user asked you not to touch hooks, run `weave init --no-hooks` instead.

Check the result:

```bash
weave status            # the note a new thread will receive
```

If the note lists folders that should not be features, such as generated output, add them to `.gitignore` and run `weave scan` again.

## 3. Wire up the clients

- **Claude Code:** `weave init` already added `.mcp.json` and the hooks in `.claude/settings.local.json`. Tell the user to restart Claude Code.
- **Claude Desktop:** run `weave desktop --write`. It merges a `weave` entry into the global `claude_desktop_config.json`, using `path.resolve` absolute paths for node, the CLI and the project. Tell the user to restart Claude Desktop. After that, the MCP server's debounced file watch keeps Desktop in sync with the map without restarts.

## 4. Open the map

```bash
weave ui                # http://127.0.0.1:3000, or the next free port
```

- The map uses the light theme by default. The user can switch between Light and Dark with the slider in the top bar.
- Signals always use the Pulse style. **Follow system motion** pauses them when the device asks apps to reduce motion.

## 5. Shape the context windows with the user

Ask what kinds of task they run and make a preset for each. You can do this with MCP tools or in the map.

- `weave_map` lists the features with their token costs.
- `weave_create_preset` saves a window, for example `{ "name": "UI work", "features": ["src/ui", "src/lib"] }`.
- `weave_detach` and `weave_attach` adjust a window by id, path or label.

Guidance to give the developer:

- Keep `CLAUDE.md` short. Area notes belong in that area's folder.
- One concern per folder gives clean features.
- A file shared by many features is loaded by all of them. Splitting it often saves more than detaching a feature.
- Detach generated, vendored and fixture-heavy folders.

## 6. Work by the window

At the start of each thread you receive a short WEAVE note. Follow it:

1. Start with the warm files, then the attached folders. Open cold files only when the task needs them.
2. Skip detached files. If you need one, call `weave_attach`, or ask the user. In Block mode, reading it is refused until it is attached.
3. Call `weave_detach` on areas you are done with, so the next thread on this preset starts lighter.

## 7. Token counts (optional)

Counts are estimates (bytes / 4) by default and stay on the machine. If the user wants exact counts, ask them to add their own key in the map under Settings, **Exact token counts**, or with `weave key set`. Never ask them to paste the key into the chat. Never write a key to any file yourself, and never read it.
