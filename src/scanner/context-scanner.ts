import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, posix } from "node:path";
import type { WeaveNode } from "../types.js";

const FEATURES_DIR = posix.join(".claude", "features");
const MAX_FILES_PER_DIR = 200;

interface FeatureManifest {
  label?: string;
  paths?: string[];
  context?: { id: string; label?: string; paths: string[] }[];
}

export function slug(input: string): string {
  return input.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "node";
}

function titleCase(id: string): string {
  return id.replace(/[-_.]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

function listEntries(dir: string): { name: string; isDir: boolean }[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((e) => !e.name.startsWith("."))
      .slice(0, MAX_FILES_PER_DIR)
      .map((e) => ({ name: e.name, isDir: e.isDirectory() }))
      .sort((a, b) => a.name.localeCompare(b.name));
  } catch {
    return [];
  }
}

function readManifest(file: string): FeatureManifest | undefined {
  if (!existsSync(file)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8"));
    return parsed && typeof parsed === "object" ? (parsed as FeatureManifest) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Scans `<root>/.claude/features/*` and returns feature + outer-context nodes.
 *
 * Layout per feature directory:
 *   feature.json        optional manifest ({ label, paths, context: [...] })
 *   *.md                feature-tier notes
 *   context/*           outer-context nodes, one per file
 *
 * Only paths are collected; file contents are never read (except feature.json).
 */
export function scanFeatures(root: string): WeaveNode[] {
  const featuresAbs = join(root, FEATURES_DIR);
  if (!existsSync(featuresAbs) || !statSync(featuresAbs).isDirectory()) return [];

  const nodes: WeaveNode[] = [];
  for (const entry of listEntries(featuresAbs)) {
    if (!entry.isDir) continue;
    const id = slug(entry.name);
    const relDir = posix.join(FEATURES_DIR, entry.name);
    const absDir = join(featuresAbs, entry.name);
    const manifest = readManifest(join(absDir, "feature.json"));

    const ownFiles = listEntries(absDir)
      .filter((e) => !e.isDir && e.name !== "feature.json")
      .map((e) => posix.join(relDir, e.name));

    nodes.push({
      id,
      label: manifest?.label ?? titleCase(entry.name),
      tier: "feature",
      paths: manifest?.paths?.length ? manifest.paths : ownFiles.length ? ownFiles : [`${relDir}/`],
      links: ["core"],
      active: false,
      severed: false,
    });

    const seen = new Set<string>();
    for (const ctx of manifest?.context ?? []) {
      if (!ctx?.id || !Array.isArray(ctx.paths)) continue;
      const ctxId = `${id}.${slug(ctx.id)}`;
      seen.add(ctxId);
      nodes.push({ id: ctxId, label: ctx.label ?? titleCase(ctx.id), tier: "context", paths: ctx.paths, links: [id], active: false, severed: false });
    }
    for (const file of listEntries(join(absDir, "context"))) {
      if (file.isDir) continue;
      const ctxId = `${id}.${slug(file.name.replace(/\.[^.]+$/, ""))}`;
      if (seen.has(ctxId)) continue;
      seen.add(ctxId);
      nodes.push({
        id: ctxId,
        label: titleCase(file.name.replace(/\.[^.]+$/, "")),
        tier: "context",
        paths: [posix.join(relDir, "context", file.name)],
        links: [id],
        active: false,
        severed: false,
      });
    }
  }
  return nodes;
}
