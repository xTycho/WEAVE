import { z } from "zod";
import { recentEvents } from "../engine/activity.js";
import { warmth } from "../engine/heat.js";
import { attach, createPreset, detach, getPreset, isLive, summarize, WeaveError } from "../engine/window.js";
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

const presetArg = z.string().optional().describe("Preset id. Defaults to the default preset.");

/** Every tool returns paths and ids only, never file contents, so replies stay small. */
export function createTools(store: ContextStore) {
  const context = (presetId?: string) => {
    const { map } = store.load();
    const w = summarize(map, getPreset(map, presetId));
    const hot = warmth(map, w.preset, recentEvents(store.paths));
    return {
      preset: w.preset.id, tokens: w.tokens, core: w.core,
      attached: w.attached.map((f) => ({ id: f.id, paths: f.paths })),
      ...(hot.warm.length ? { warm: hot.warm.flatMap((n) => n.paths), warmTokens: hot.warmTokens } : {}),
      detached: w.detached.flatMap((n) => n.paths),
    };
  };
  return {
    weave_get_context: {
      description: "Show a context window: the core files, the attached feature folders, the warm files to start with and the detached files to skip. Paths only.",
      inputSchema: { preset: presetArg },
      handler: guarded(({ preset }: { preset?: string }) => ({ ok: true, ...context(preset) })),
    },
    weave_map: {
      description: "List the project's features and presets with their estimated token cost, to choose what to attach.",
      inputSchema: {},
      handler: guarded(() => {
        const { map } = store.load();
        const features = map.nodes.filter((n) => n.tier === "feature").map((f) => ({
          id: f.id, label: f.label,
          tokens: map.nodes.filter((e) => e.tier === "element" && e.of[0] === f.id).reduce((s, e) => s + e.tokens, 0),
        }));
        const presets = map.presets.map((p) => ({ id: p.id, name: p.name, features: p.features, default: p.id === map.settings.defaultPreset }));
        return { ok: true, features, presets };
      }),
    },
    weave_attach: {
      description: "Attach a feature or file (id, path or label) to a preset's context window.",
      inputSchema: { node: z.string().min(1).describe("Node id, path or label, e.g. 'src/ui' or 'src/store.ts'"), preset: presetArg },
      handler: guarded(({ node, preset }: { node: string; preset?: string }) => {
        const { result } = store.update((m) => attach(m, preset, node));
        return { ok: true, changed: result, window: context(preset) };
      }),
    },
    weave_detach: {
      description: "Detach a feature or file from a preset's context window so threads skip it.",
      inputSchema: { node: z.string().min(1).describe("Node id, path or label"), preset: presetArg },
      handler: guarded(({ node, preset }: { node: string; preset?: string }) => {
        const { result } = store.update((m) => detach(m, preset, node));
        return { ok: true, changed: result, window: context(preset) };
      }),
    },
    weave_create_preset: {
      description: "Save a new context window (preset) holding the given features. Optionally make it the default for new threads.",
      inputSchema: {
        name: z.string().min(1),
        features: z.array(z.string()).describe("Feature ids, paths or labels"),
        makeDefault: z.boolean().optional(),
      },
      handler: guarded(({ name, features, makeDefault }: { name: string; features: string[]; makeDefault?: boolean }) => {
        const { result } = store.update((m) => {
          const p = createPreset(m, name, features);
          if (makeDefault) m.settings.defaultPreset = p.id;
          return p;
        });
        return { ok: true, window: context(result.id) };
      }),
    },
    weave_name_thread: {
      description: "Name this thread on the WEAVE map, for example after its title in the app. The WEAVE hook reads the name from this call, so nothing else is needed.",
      inputSchema: { name: z.string().min(1).max(80) },
      handler: guarded(({ name }: { name: string }) => ({ ok: true, name: name.trim().slice(0, 80) })),
    },
    weave_is_attached: {
      description: "Check whether one path is inside a preset's context window.",
      inputSchema: { node: z.string().min(1), preset: presetArg },
      handler: guarded(({ node, preset }: { node: string; preset?: string }) => {
        const { map } = store.load();
        const n = map.nodes.find((x) => x.id === node || x.paths.includes(node));
        if (!n) throw new WeaveError(`"${node}" is not on the map.`);
        return { ok: true, node: n.id, attached: isLive(n, getPreset(map, preset)) };
      }),
    },
  } as const;
}
