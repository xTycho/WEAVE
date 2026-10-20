import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { startDashboard } from "./server/dashboard.js";

export { ContextStore, mergeScan, normalizeMap, thresholds } from "./store.js";
export { scanProject, kindOf, MAX_ELEMENTS, ROOT_FEATURE } from "./scanner/project-scanner.js";
export { listFiles } from "./scanner/files.js";
export { scanImports } from "./scanner/imports.js";
export { startMcpServer } from "./mcp/server.js";
export { startDashboard, listenWithFallback } from "./server/dashboard.js";
export { handleHook, classify, threadName, titleFrom } from "./hooks/hook.js";
export { suggestions, contextLevel } from "./engine/rules.js";
export { frozen, frozenLine, FREEZE_AFTER, KEEP_PROMPTS, FROZEN_CHARS } from "./engine/freeze.js";
export { handoff, bestPreset, threadWarm, startLine, startPreset, calibrate, FIT_SHARE } from "./engine/handoff.js";
export { heat, warmth, overdue, tagFor, presetFromHeat, presetFromFiles, crystalName, CRYSTALS, OVERDUE_DAYS, HALF_LIFE, WARM_AT, WARM_MAX, HOT_AT, HOT_MAX } from "./engine/heat.js";
export { readKey, saveKey, removeKey, tokenMode, countExact } from "./engine/tokens.js";
export { appendEvent, recentEvents, readThreads, removeThreads, transcriptTokens } from "./engine/activity.js";
export * from "./engine/window.js";
export { projectPaths, userConfigDir, toRelative } from "./paths.js";
export { debounce, watchFiles, watchProject } from "./watch.js";
export type * from "./types.js";

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  startDashboard()
    .then((d) => console.log(`[weave] map running at ${d.url}`))
    .catch((err) => { console.error(`[weave] failed to start: ${err.message}`); process.exit(1); });
}
