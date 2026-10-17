import { z } from "zod";
import { activate, activeContext, GraphError, sever } from "../graph.js";
import { ContextStore } from "../store.js";

export interface ToolResult {
  [key: string]: unknown;
  content: { type: "text"; text: string }[];
  isError?: boolean;
}

const json = (value: unknown, isError = false): ToolResult => ({
  content: [{ type: "text", text: JSON.stringify(value) }],
  ...(isError ? { isError: true } : {}),
});

/** Wraps a handler so MCP clients always receive a structured reply, never a crash. */
function guarded<A>(fn: (args: A) => unknown): (args: A) => ToolResult {
  return (args) => {
    try {
      return json(fn(args));
    } catch (err) {
      const message = err instanceof GraphError ? err.message : `WEAVE error: ${(err as Error).message}`;
      return json({ ok: false, error: message }, true);
    }
  };
}

export function createTools(store: ContextStore) {
  return {
    weave_activate_node: {
      description: "Activate a WEAVE feature or context node. Returns only the filtered list of paths now in active context.",
      inputSchema: { id: z.string().min(1).describe("Node id, e.g. 'auth' or 'api.schema'") },
      handler: guarded(({ id }: { id: string }) => {
        let touched: string[] = [];
        const map = store.update((m) => { touched = activate(m, id); });
        const ctx = activeContext(map, store.root);
        return { ok: true, activated: touched, paths: ctx.paths };
      }),
    },
    weave_sever_node: {
      description: "Sever a node's context cord so its paths leave active context. Severing a feature drops its outer context too.",
      inputSchema: { id: z.string().min(1).describe("Node id to sever") },
      handler: guarded(({ id }: { id: string }) => {
        let dropped: string[] = [];
        const map = store.update((m) => { dropped = sever(m, id); });
        return { ok: true, severed: dropped, remaining: activeContext(map, store.root).paths.length };
      }),
    },
    weave_get_active_context: {
      description: "List the project paths Claude should read for the current task. Paths only, never file contents.",
      inputSchema: {},
      handler: guarded(() => {
        const { map, source, warning } = store.load();
        const ctx = activeContext(map, store.root);
        const available = map.nodes.filter((n) => n.tier === "feature" && !ctx.active.includes(n.id)).map((n) => n.id);
        return { ok: true, source, ...(warning ? { warning } : {}), active: ctx.active, paths: ctx.paths, missing: ctx.missing.length, available };
      }),
    },
  } as const;
}
