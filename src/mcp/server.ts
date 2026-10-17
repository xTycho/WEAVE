import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ContextStore } from "../store.js";
import { createTools } from "./tools.js";

export const VERSION = "0.1.0";

export function createMcpServer(store: ContextStore): McpServer {
  const server = new McpServer({ name: "weave", version: VERSION });
  for (const [name, tool] of Object.entries(createTools(store))) {
    server.registerTool(name, { description: tool.description, inputSchema: tool.inputSchema }, tool.handler as never);
  }
  return server;
}

/** Runs the MCP server over stdio. Logs go to stderr; stdout is the protocol channel. */
export async function startMcpServer(root: string = process.cwd()): Promise<void> {
  const store = new ContextStore(root);
  const { warning } = store.load();
  if (warning) console.error(`[weave] ${warning}`);
  const server = createMcpServer(store);
  await server.connect(new StdioServerTransport());
  console.error(`[weave] MCP server ready (root: ${store.root})`);
}
