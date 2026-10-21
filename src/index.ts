import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { startDashboard } from "./server/dashboard.js";

export { ContextStore, mergeScan, normalizeMap, settingsFrom, DEFAULT_SETTINGS } from "./store.js";
export { scanProject, kindOf, MAX_ELEMENTS, ROOT_FEATURE } from "./scanner/project-scanner.js";
export { listFiles } from "./scanner/files.js";
export { scanImports } from "./scanner/imports.js";
export { startMcpServer, createTools } from "./mcp/server.js";
export { startDashboard, listenWithFallback } from "./server/dashboard.js";
export { handleHook, classify, threadName, titleFrom, KEEP_PROMPTS } from "./hooks/hook.js";
export { areas, agentAreas, areaOf, fileEvents, JOIN_THREADS, JOIN_SHARE, KEY_FILES, MAX_AGENTS, MAX_SHARE } from "./engine/areas.js";
export { agentText, writeAgents, mapNote, projectName, agentsDir, MARK } from "./engine/agents.js";
export { meter, meterLine, threadFiles, staleTokens, carryOver, COMPACT_NOW, STALE_SHARE, CLEAR_MIN, CLEAR_LOOK, DELEGATE_AT, KEEP } from "./engine/meter.js";
export { WeaveError, nodeForPath, nodeIndex, featureOf } from "./engine/map.js";
export { appendEvent, recentEvents, readThreads, writeThread, removeThreads, transcriptTokens } from "./engine/activity.js";
export { terminalLaunch, openTerminal, terminalName } from "./engine/terminal.js";
export { chatLaunch, contextNote, resolveClaude, shouldAutoCompact, ChatSession, COMMANDS, AUTO_QUIET, AUTO_GAP } from "./engine/chat.js";
export { UsageTracker, usageEntry, dedupe, sum, blocks, currentBlock, total, zero, BLOCK_MS, WEEK_MS } from "./engine/usage.js";
export { isRemoteSession, remoteReason, REMOTE_MESSAGE } from "./engine/remote.js";
export { projectPaths, toRelative } from "./paths.js";
export { debounce, watchFiles, watchProject } from "./watch.js";
export type * from "./types.js";

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  startDashboard()
    .then((d) => console.log(`[weave] map running at ${d.url}`))
    .catch((err) => { console.error(`[weave] failed to start: ${err.message}`); process.exit(1); });
}
