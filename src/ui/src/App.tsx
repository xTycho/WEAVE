import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Background,
  Controls,
  ReactFlow,
  type Edge,
  type Node,
  type EdgeMouseHandler,
  type NodeChange,
  type NodeMouseHandler,
} from "@xyflow/react";
import { concentricLayout, RING_RADIUS } from "./layout";
import { WeaveNodeView, type WeaveFlowNode } from "./WeaveNodeView";
import type { ContextMap, WeaveEvent, WeaveNode } from "./types";

const nodeTypes = { weave: WeaveNodeView, ring: RingView };

function RingView({ data }: { data: { r: number } }) {
  return <div className="weave-ring" style={{ width: data.r * 2, height: data.r * 2 }} />;
}

const RINGS = [RING_RADIUS.feature, RING_RADIUS.context].map((r) => ({
  id: `__ring-${r}`,
  type: "ring",
  position: { x: 0, y: 0 },
  origin: [0.5, 0.5] as [number, number],
  data: { r },
  draggable: false,
  selectable: false,
  focusable: false,
  zIndex: -1,
}));
const GLOW_MS = 1600;

type Conn = "connecting" | "live" | "offline";

function liveSet(map: ContextMap): Set<string> {
  const byId = new Map(map.nodes.map((n) => [n.id, n]));
  const live = new Set<string>();
  const visit = (n: WeaveNode, seen: Set<string>): boolean => {
    if (live.has(n.id)) return true;
    if (n.severed || seen.has(n.id)) return false;
    seen.add(n.id);
    const ok =
      n.tier === "core" ||
      (n.tier === "feature" && n.active) ||
      (n.tier === "context" && n.links.some((l) => { const p = byId.get(l); return !!p && visit(p, seen); }));
    if (ok) live.add(n.id);
    return ok;
  };
  map.nodes.forEach((n) => visit(n, new Set()));
  return live;
}

async function post(id: string, verb: "activate" | "sever" | "restore"): Promise<string | undefined> {
  const res = await fetch(`./api/nodes/${encodeURIComponent(id)}/${verb}`, { method: "POST" });
  if (res.ok) return undefined;
  const body = await res.json().catch(() => ({}));
  return body.error ?? `Request failed (${res.status})`;
}

export function App() {
  const [map, setMap] = useState<ContextMap>({ version: 1, nodes: [] });
  const [source, setSource] = useState("");
  const [conn, setConn] = useState<Conn>("connecting");
  const [glowing, setGlowing] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string>();
  const [dragged, setDragged] = useState<Record<string, { x: number; y: number }>>({});
  const timers = useRef(new Map<string, number>());

  const glow = useCallback((id: string) => {
    setGlowing((g) => new Set(g).add(id));
    window.clearTimeout(timers.current.get(id));
    timers.current.set(
      id,
      window.setTimeout(() => setGlowing((g) => { const n = new Set(g); n.delete(id); return n; }), GLOW_MS),
    );
  }, []);

  // WebSocket with exponential-backoff reconnect; REST snapshot as a fallback.
  useEffect(() => {
    let ws: WebSocket | undefined;
    let retry = 0;
    let closed = false;
    let reconnect: number | undefined;
    fetch("./api/graph").then((r) => r.json()).then((d) => { setMap(d.map); setSource(d.source); }).catch(() => {});
    const open = () => {
      const proto = location.protocol === "https:" ? "wss" : "ws";
      ws = new WebSocket(`${proto}://${location.host}/ws`);
      ws.onopen = () => { retry = 0; setConn("live"); };
      ws.onmessage = (msg) => {
        const event = JSON.parse(msg.data) as WeaveEvent;
        if (event.type === "graph") { setMap(event.map); setSource(event.source); }
        else if (event.type === "glow") glow(event.id);
      };
      ws.onclose = () => {
        if (closed) return;
        setConn("offline");
        reconnect = window.setTimeout(open, Math.min(500 * 2 ** retry++, 8000));
      };
    };
    open();
    return () => { closed = true; window.clearTimeout(reconnect); ws?.close(); };
  }, [glow]);

  const live = useMemo(() => liveSet(map), [map]);
  const layout = useMemo(() => concentricLayout(map.nodes), [map.nodes]);

  const nodes = useMemo<Node[]>(
    () => [
      ...RINGS,
      ...map.nodes.map((n): WeaveFlowNode => ({
        id: n.id,
        type: "weave",
        position: dragged[n.id] ?? layout.get(n.id) ?? { x: 0, y: 0 },
        origin: [0.5, 0.5] as [number, number],
        data: { node: n, live: live.has(n.id), glow: glowing.has(n.id) },
      })),
    ],
    [map.nodes, layout, dragged, live, glowing],
  );

  const edges: Edge[] = useMemo(() => {
    const ids = new Set(map.nodes.map((n) => n.id));
    return map.nodes.flatMap((n) =>
      n.links.filter((l) => ids.has(l)).map((parent) => {
        const on = live.has(n.id) && live.has(parent);
        return {
          id: `${parent}->${n.id}`,
          source: parent,
          target: n.id,
          type: "straight",
          animated: on,
          className: ["weave-cord", on ? "cord-live" : "cord-idle", n.severed ? "cord-severed" : "", glowing.has(n.id) ? "cord-glow" : ""].join(" "),
          data: { child: n.id },
          interactionWidth: 24,
        } satisfies Edge;
      }),
    );
  }, [map.nodes, live, glowing]);

  const run = useCallback(async (id: string, verb: "activate" | "sever" | "restore") => {
    setError(await post(id, verb));
  }, []);

  const onNodeClick: NodeMouseHandler = useCallback(
    (_e, flowNode) => {
      const n = (flowNode as WeaveFlowNode).data?.node as WeaveNode | undefined;
      if (!n || n.tier === "core") return;
      run(n.id, live.has(n.id) ? "sever" : "activate");
    },
    [live, run],
  );

  const onEdgeClick: EdgeMouseHandler = useCallback(
    (_e, edge) => {
      const child = map.nodes.find((n) => n.id === edge.target);
      if (!child) return;
      run(child.id, child.severed ? "restore" : "sever");
    },
    [map.nodes, run],
  );

  const onNodesChange = useCallback((changes: NodeChange[]) => {
    const moves = changes.filter((c) => c.type === "position" && c.position);
    if (!moves.length) return;
    setDragged((d) => {
      const next = { ...d };
      for (const c of moves) if (c.type === "position" && c.position) next[c.id] = c.position;
      return next;
    });
  }, []);

  const activePaths = useMemo(() => {
    const seen = new Set<string>();
    return map.nodes.filter((n) => live.has(n.id)).flatMap((n) => n.paths).filter((p) => !seen.has(p) && !!seen.add(p));
  }, [map.nodes, live]);
  const featureCount = map.nodes.filter((n) => n.tier === "feature").length;
  const liveFeatures = map.nodes.filter((n) => n.tier === "feature" && live.has(n.id)).length;

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark" aria-hidden />
          WEAVE
        </div>
        <div className="stats">
          <span>{liveFeatures}/{featureCount} features live</span>
          <span>{activePaths.length} paths in context</span>
          {source && <span className="muted">map: {source}</span>}
          <span className={`conn conn-${conn}`}>{conn}</span>
        </div>
      </header>
      <main className="stage">
        <ReactFlow
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          onNodeClick={onNodeClick}
          onEdgeClick={onEdgeClick}
          onNodesChange={onNodesChange}
          nodesConnectable={false}
          fitView
          fitViewOptions={{ padding: 0.2 }}
          minZoom={0.2}
          proOptions={{ hideAttribution: true }}
        >
          <Background gap={28} size={1} />
          <Controls showInteractive={false} />
        </ReactFlow>
        <aside className="panel">
          <h2>Active context</h2>
          {activePaths.length ? (
            <ul>{activePaths.map((p) => <li key={p}><code>{p}</code></li>)}</ul>
          ) : (
            <p className="muted">Only the core router is loaded.</p>
          )}
          <h2>Controls</h2>
          <p className="muted">Click a node to activate or sever it. Click a cord to sever or restore the node it feeds.</p>
          {error && <p className="error" role="alert">{error}</p>}
        </aside>
      </main>
    </div>
  );
}
