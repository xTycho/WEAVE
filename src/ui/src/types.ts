export type Tier = "core" | "feature" | "context";

export interface WeaveNode {
  id: string;
  label: string;
  tier: Tier;
  paths: string[];
  links: string[];
  active: boolean;
  severed: boolean;
}

export interface ContextMap {
  version: 1;
  nodes: WeaveNode[];
  updatedAt?: string;
}

export type WeaveEvent =
  | { type: "graph"; map: ContextMap; source: string }
  | { type: "glow"; id: string; reason: "activated" | "severed" | "restored" | "changed" };
