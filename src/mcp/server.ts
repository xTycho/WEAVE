import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { recentEvents } from "../engine/activity.js";
import { mapNote } from "../engine/agents.js";
import { agentAreas, areaOf, areas } from "../engine/areas.js";
import { nodeForPath, WeaveError } from "../engine/map.js";
import { ContextStore } from "../store.js";

export const VERSION = "0.3.0";
const MAP_URI = "weave://map";

export interface ToolResult {
  [key: string]: unknown;
  content: { type: "text"; text: string }[];
  isError?: boolean;
}

const json = (value: unknown, isError = false): ToolResult => ({
  content: [{ type: "text", text: JSON.stringify(value) }],
  ...(isError ? { isError: true } : {}),
});

/** Wraps a handler so MCP clients always get a structured reply, never a crash. */
function guarded<A>(fn: (args: A) => unknown): (args: A) => ToolResult {
  return (args) => {
    try {
      return json(fn(args));
    } catch (err) {
      return json({ ok: false, error: err instanceof WeaveError ? err.message : `WEAVE error: ${(err as Error).message}` }, true);
    }
  };
}

/** Every tool returns paths and names only, never file contents, so replies stay small. */
export function createTools(store: ContextStore) {
  const now = () => {
    const { map } = store.load();
    const all = areas(map, recentEvents(store.paths));
    return { map, all, agents: new Set(agentAreas(all).map((a) => a.agent)) };
  };
  return {
    weave_map: {
      description: "List the project's areas: their folders, most used files, estimated tokens and the subagent to hand work in that area to. Paths only.",
      inputSchema: {},
      handler: guarded(() => {
        const { all, agents } = now();
        return { ok: true, areas: all.map((a) => ({ name: a.name, folders: a.folders, files: a.files, tokens: a.tokens, ...(agents.has(a.agent) ? { agent: a.agent } : {}) })) };
      }),
    },
    weave_area_for: {
      description: "Which area a path is in, and the subagent to hand work there to.",
      inputSchema: { path: z.string().min(1).describe("Project-relative path, e.g. 'src/ui/main.ts' or 'src/ui'") },
      handler: guarded(({ path }: { path: string }) => {
        const { map, all, agents } = now();
        const area = areaOf(all, nodeForPath(map, path.trim().replace(/^\.\//, "")));
        if (!area) throw new WeaveError(`"${path}" is not in any area.`);
        return { ok: true, area: area.name, folders: area.folders, ...(agents.has(area.agent) ? { agent: area.agent } : {}) };
      }),
    },
    weave_name_thread: {
      description: "Name this thread on the WEAVE map, for example after its title in the app. The WEAVE hook reads the name from this call, so nothing else is needed.",
      inputSchema: { name: z.string().min(1).max(80) },
      handler: guarded(({ name }: { name: string }) => ({ ok: true, name: name.trim().slice(0, 80) })),
    },
  } as const;
}

export function createMcpServer(store: ContextStore): McpServer {
  const server = new McpServer({ name: "weave", version: VERSION });
  for (const [name, tool] of Object.entries(createTools(store))) {
    server.registerTool(name, { description: tool.description, inputSchema: tool.inputSchema }, tool.handler as never);
  }
  server.registerResource("map", MAP_URI, { description: "The project's areas and their subagents as a short note", mimeType: "text/plain" }, () => {
    const { map } = store.load();
    return { contents: [{ uri: MAP_URI, text: mapNote(map, areas(map, recentEvents(store.paths))) ?? "No areas yet. Run `weave scan`." }] };
  });
  return server;
}

/** Runs the MCP server over stdio. Logs go to stderr; stdout is the protocol. */
export async function startMcpServer(root: string = process.cwd()): Promise<void> {
  const store = new ContextStore(root);
  const loaded = store.load();
  if (loaded.source === "scan") store.save(loaded.map);
  if (loaded.warning) console.error(`[weave] ${loaded.warning}`);
  const server = createMcpServer(store);
  await server.connect(new StdioServerTransport());
  process.stdin.on("close", () => process.exit(0));
  console.error(`[weave] MCP server ready (root: ${store.root})`);
}
