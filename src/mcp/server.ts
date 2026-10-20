import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { summarize, getPreset, windowNote } from "../engine/window.js";
import { ContextStore } from "../store.js";
import { watchFiles } from "../watch.js";
import { createTools } from "./tools.js";

export const VERSION = "0.2.0";
const CONTEXT_URI = "weave://context";

export function createMcpServer(store: ContextStore): McpServer {
  const server = new McpServer({ name: "weave", version: VERSION });
  for (const [name, tool] of Object.entries(createTools(store))) {
    server.registerTool(name, { description: tool.description, inputSchema: tool.inputSchema }, tool.handler as never);
  }
  server.registerResource("context", CONTEXT_URI, { description: "The default context window as a short note", mimeType: "text/plain" }, () => {
    const { map } = store.load();
    return { contents: [{ uri: CONTEXT_URI, text: windowNote(map, getPreset(map)) }] };
  });
  return server;
}

/**
 * Runs the MCP server over stdio. Logs go to stderr; stdout is the protocol.
 * A debounced watch on the map tells the client when the map changes, so a
 * toggle in the map reaches Claude Desktop without a restart.
 */
export async function startMcpServer(root: string = process.cwd()): Promise<void> {
  const store = new ContextStore(root);
  const loaded = store.load();
  if (loaded.source === "scan") store.save(loaded.map);
  if (loaded.warning) console.error(`[weave] ${loaded.warning}`);
  const server = createMcpServer(store);
  await server.connect(new StdioServerTransport());
  let last = "";
  const watcher = watchFiles([store.mapPath], () => {
    const { map } = store.load(false);
    if (!map.presets.length) return;
    const sig = JSON.stringify(summarize(map, getPreset(map)).attached.map((n) => n.id)) + map.updatedAt;
    if (sig === last) return;
    last = sig;
    void server.server.sendResourceUpdated({ uri: CONTEXT_URI }).catch(() => {});
  }, 150);
  const stop = () => { watcher.close(); process.exit(0); };
  process.stdin.on("close", stop);
  console.error(`[weave] MCP server ready (root: ${store.root})`);
}
