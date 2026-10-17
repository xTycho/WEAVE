# WEAVE

**Route active features. Sever idle context cords.**

WEAVE is an ultra-lightweight, open-source extension for [Claude Code](https://claude.com/claude-code). It keeps prompts lean by turning your project knowledge into a small graph: a core router, the features you are working on, and the deep reference material around them. Claude asks WEAVE which paths matter *right now* and reads only those, instead of hauling every note into context.

It ships three pieces in one package:

- **CLI** (`bin/weave.js`): scaffolds `.claude/` in any project with one command.
- **MCP server** (`src/mcp/`): three tools that return filtered path lists, never raw file contents.
- **Visual dashboard** (`src/ui/`): a React Flow concentric network map with live glow and click-to-sever cords.

---

## The 3-tier concentric map

```
                 . - - - - - - - - - - - - - - - - - - - .
               /            RING 2 : OUTER CONTEXT         \
              /   [sessions]                    [schema]     \
             |        :                            |          |
             |    . - : - - - - - - - - - - - - -  | - .      |
             |   /    :      RING 1 : FEATURES     |    \     |
             |  |  ( auth )                     (  api  )-[errors]
             |  |       :                       //      |     |
             |  |        :      +--------+     //       |     |
             |  |         :.....|  CORE  |=====         |     |
             |  |               +--------+              |     |
             |  |                   ||                  |     |
             |  |                (  ui  )               |     |
             |   \                  ||                  /     |
             |    ' - - - - - - - - || - - - - - - - - '      |
              \                  [tokens]                    /
               \                                            /
                 ' - - - - - - - - - - - - - - - - - - - - '

  ==== / ||   live cord     paths are in context (api, ui active)
  .... / :     severed cord  nothing loaded (auth severed)
  ----         idle cord     dormant until its feature is activated
  ring 0  CORE           CLAUDE.md router, always loaded (< 15 lines)
  ring 1  FEATURES       .claude/features/<id>/          loaded when activated
  ring 2  OUTER CONTEXT  .claude/features/<id>/context/* loaded with a live parent
```

A node's paths are in context only if its cord reaches the core unbroken. Sever a feature and everything hanging off it drops out with it.

---

## Quick start

Run inside the project you want Claude to work on:

```bash
npx github:xTycho/WEAVE init
```

This creates (and never overwrites existing files without `--force`):

| Path | Purpose |
| --- | --- |
| `CLAUDE.md` | A 7-line router telling Claude to ask WEAVE for context. Appended if the file exists. |
| `.claude/context-map.json` | Local graph state. Added to your `.gitignore`. |
| `.claude/features/<id>/…` | Short starter notes for the example features. Rename or replace them. |
| `.mcp.json` | Registers the `weave` MCP server for Claude Code. |

Restart Claude Code so it picks up the MCP server, then open the dashboard:

```bash
npx github:xTycho/WEAVE ui            # http://127.0.0.1:3000 (or the next free port)
```

### CLI reference

```
weave init [--force]      Scaffold .claude/, CLAUDE.md router and .mcp.json
weave ui [--port <n>]     Start the dashboard (default 3000, falls back to 3001, 3002, ...)
weave mcp                 Run the MCP server over stdio (Claude Code launches this)
weave status              Print the active context paths
weave help                Show help
```

All commands accept `--dir <path>` to target another project. `WEAVE_PORT` or `PORT` sets the starting port.

---

## MCP tools

| Tool | Input | Returns |
| --- | --- | --- |
| `weave_get_active_context` | none | `{ active, paths, missing, available, source }` |
| `weave_activate_node` | `{ id }` | `{ activated, paths }`. Activating outer context also wakes its parent feature. |
| `weave_sever_node` | `{ id }` | `{ severed, remaining }`. Severing a feature drops its outer context. The core cannot be severed. |

Every response is compact JSON containing project-relative **paths only**. Paths that do not exist on disk are filtered out and only counted in `missing`. Unknown ids return a structured error with suggestions instead of failing the session.

**Graceful failover.** If `.claude/context-map.json` is missing or corrupt, WEAVE never crashes: it rebuilds the graph from a scan of `.claude/features/`, then falls back to the bundled starter map, then to a core-only map. The response's `source` field tells you which one was used (`file`, `scan`, `default`, `empty`).

---

## Organising features

```
.claude/features/
  billing/
    feature.json          optional: { "label": "Billing", "paths": [...], "context": [...] }
    overview.md           feature-tier notes (loaded when billing is active)
    context/
      invoices.md         outer-context node "billing.invoices"
      tax-rules.md        outer-context node "billing.tax-rules"
```

New folders are discovered automatically and merged into the map, so you can add a feature by creating a directory. The scanner only lists paths; it never reads note contents.

`feature.json` lets a feature point at real source files instead of notes:

```json
{
  "label": "Billing",
  "paths": ["src/billing/README.md"],
  "context": [{ "id": "stripe", "label": "Stripe webhooks", "paths": ["docs/stripe-webhooks.md"] }]
}
```

---

## Dashboard

- **Concentric layout**: core in the centre, features on the inner ring, outer context fanned around its parent.
- **Real-time glow**: the dashboard watches `.claude/`, so when Claude calls an MCP tool in another process the affected nodes pulse within a second over WebSocket.
- **Interactive cords**: click a node to activate or sever it, click a cord to sever or restore the node it feeds, drag nodes to rearrange.
- **Active context panel**: the exact path list Claude will receive.

The UI is pre-built into `src/ui/dist` and committed, so `npx` users get it instantly with no frontend toolchain. The server binds to `127.0.0.1` by default.

---

## Development

```bash
git clone https://github.com/xTycho/WEAVE.git && cd WEAVE
npm install          # also compiles the server via the prepare script
npm run build        # compiles src/ to dist/ and rebuilds src/ui/dist
npm test             # engine, failover, MCP tool and port-fallback tests
npm run dev:ui       # Vite dev server, proxies to a running `weave ui` on :3000
```

Layout:

```
bin/weave.js                   CLI (init, ui, mcp, status)
src/index.ts                   dashboard server, WebSocket hub, file watcher, port fallback
src/store.ts                   context-map.json persistence with failover chain
src/graph.ts                   activate / sever / restore and active-path resolution
src/scanner/context-scanner.ts .claude/features/ discovery
src/mcp/server.ts, tools.ts    MCP server and tool definitions
src/ui/                        React + React Flow dashboard (pre-built to src/ui/dist)
templates/                     CLAUDE.md router and anonymised starter map
```

## License

[MIT](LICENSE)
