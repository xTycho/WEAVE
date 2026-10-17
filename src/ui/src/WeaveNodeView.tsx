import { Handle, Position, type NodeProps, type Node } from "@xyflow/react";
import type { WeaveNode } from "./types";

export type WeaveFlowNode = Node<{ node: WeaveNode; live: boolean; glow: boolean }, "weave">;

export function WeaveNodeView({ data }: NodeProps<WeaveFlowNode>) {
  const { node, live, glow } = data;
  const cls = ["weave-node", `tier-${node.tier}`, live ? "is-live" : "is-idle", node.severed ? "is-severed" : "", glow ? "is-glowing" : ""]
    .filter(Boolean)
    .join(" ");
  return (
    <div className={cls} title={node.paths.join("\n")}>
      <Handle type="target" position={Position.Top} className="weave-handle" />
      <div className="weave-node-label">{node.label}</div>
      <div className="weave-node-meta">{node.tier === "core" ? "router" : `${node.paths.length} path${node.paths.length === 1 ? "" : "s"}`}</div>
      <Handle type="source" position={Position.Bottom} className="weave-handle" />
    </div>
  );
}
