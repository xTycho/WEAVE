export type Tier = "core" | "feature" | "context";

export interface WeaveNode {
  id: string;
  label: string;
  tier: Tier;
  /** Project-relative paths (files, or directories ending in "/"). */
  paths: string[];
  /** Ids of inner-ring nodes this node hangs off (context -> feature -> core). */
  links: string[];
  active: boolean;
  severed: boolean;
}

export interface ContextMap {
  version: 1;
  nodes: WeaveNode[];
  updatedAt?: string;
}

export type MapSource = "file" | "scan" | "default" | "empty";

export interface LoadedMap {
  map: ContextMap;
  source: MapSource;
  warning?: string;
}

export type WeaveEvent =
  | { type: "graph"; map: ContextMap; source: MapSource }
  | { type: "glow"; id: string; reason: "activated" | "severed" | "restored" | "changed" };
