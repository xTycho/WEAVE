import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Area, ContextMap } from "../types.js";
import { agentAreas } from "./areas.js";
import { k } from "./map.js";

/**
 * One Claude Code subagent per area, in `.claude/agents/weave-<area>.md`.
 * A subagent works in its own context window and hands back a summary, so
 * the thread that delegates stays small. Files WEAVE writes carry MARK;
 * WEAVE never touches an agent file without it.
 */
export const MARK = "<!-- written by weave: regenerated from the map, edits are replaced -->";

const list = (items: string[], max: number) => (items.length > max ? `${items.slice(0, max).join(", ")} and ${items.length - max} more` : items.join(", "));

export function agentText(project: string, area: Area): string {
  const where = area.folders.length ? list(area.folders, 6) : "the project root files";
  return [
    "---",
    `name: ${area.agent}`,
    `description: Use for tasks inside ${where} in ${project} (~${k(area.tokens)} tokens). Delegate work that stays in this area so the main thread's context stays small.`,
    "---",
    MARK,
    "",
    `You handle the ${area.name} area of ${project}.`,
    "",
    `Your area: ${where}.`,
    ...(area.files.length ? [`Start with the files used most here: ${area.files.join(", ")}.`] : []),
    "",
    "Stay inside your area. If the task needs a file outside it, read only that file and name it in your reply.",
    "When you are done, reply with a short summary: what you changed (paths only), what you found, and anything left open. Do not paste file contents back.",
    "",
  ].join("\n");
}

export function agentsDir(root: string): string {
  return join(root, ".claude", "agents");
}

/** Writes the agent files that changed and removes WEAVE's own files for areas that are gone. */
export function writeAgents(root: string, project: string, all: Area[]): { written: string[]; removed: string[] } {
  const dir = agentsDir(root);
  const want = new Map(agentAreas(all).map((a) => [`${a.agent}.md`, agentText(project, a)]));
  const written: string[] = [], removed: string[] = [];
  mkdirSync(dir, { recursive: true });
  for (const [name, text] of want) {
    const file = join(dir, name);
    let old: string | undefined;
    try { old = readFileSync(file, "utf8"); } catch { /* new */ }
    if (old === text) continue;
    if (old !== undefined && !old.includes(MARK)) continue;
    writeFileSync(file, text);
    written.push(name);
  }
  for (const name of existsSync(dir) ? readdirSync(dir) : []) {
    if (!name.startsWith("weave-") || !name.endsWith(".md") || want.has(name)) continue;
    const file = join(dir, name);
    try { if (readFileSync(file, "utf8").includes(MARK)) { rmSync(file); removed.push(name); } } catch { /* gone */ }
  }
  return { written, removed };
}

export function projectName(map: ContextMap): string {
  return map.nodes.find((n) => n.tier === "core")?.label ?? "this project";
}

/**
 * The note a thread gets when it starts: the areas and their subagents, by
 * folder only, so it stays around 100 to 200 tokens however large the project is.
 */
export function mapNote(map: ContextMap, all: Area[]): string | undefined {
  const agents = agentAreas(all);
  if (!agents.length) return undefined;
  const total = map.nodes.reduce((s, n) => s + n.tokens, 0);
  return [
    `WEAVE map of ${projectName(map)} (~${k(total)} tokens). Areas and their subagents:`,
    ...agents.map((a) => `- ${a.agent}: ${list(a.folders, 3) || "root files"} (~${k(a.tokens)})`),
    "Hand a task that stays inside one area to its subagent: it works in its own context and returns a summary, so this thread stays small. Do quick lookups and cross-area edits here.",
  ].join("\n");
}
