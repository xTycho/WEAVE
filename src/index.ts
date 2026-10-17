import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { existsSync, mkdirSync, readFileSync, statSync, unwatchFile, watch, watchFile, type FSWatcher } from "node:fs";
import { dirname, extname, join, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer, WebSocket } from "ws";
import { activate, GraphError, restore, sever, syncActive } from "./graph.js";
import { ContextStore } from "./store.js";
import type { ContextMap, WeaveEvent } from "./types.js";

export { ContextStore } from "./store.js";
export { scanFeatures } from "./scanner/context-scanner.js";
export { startMcpServer } from "./mcp/server.js";
export * from "./graph.js";
export type * from "./types.js";

const UI_DIST = resolve(dirname(fileURLToPath(import.meta.url)), "..", "src", "ui", "dist");
const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".json": "application/json",
  ".woff2": "font/woff2",
};

export interface DashboardOptions {
  root?: string;
  port?: number;
  host?: string;
  maxPortAttempts?: number;
}

export interface Dashboard {
  url: string;
  port: number;
  close(): Promise<void>;
}

/** Listens on `port`, walking upward (3000 -> 3001 -> ...) while ports are taken. */
export function listenWithFallback(server: Server, port: number, host: string, attempts: number): Promise<number> {
  return new Promise((resolvePort, reject) => {
    let current = port;
    const tryListen = () => {
      const onError = (err: NodeJS.ErrnoException) => {
        server.off("listening", onListening);
        if ((err.code === "EADDRINUSE" || err.code === "EACCES") && current < port + attempts - 1) {
          current += 1;
          tryListen();
        } else reject(err);
      };
      const onListening = () => {
        server.off("error", onError);
        resolvePort(current);
      };
      server.once("error", onError);
      server.once("listening", onListening);
      server.listen(current, host);
    };
    tryListen();
  });
}

function send(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}

function serveStatic(req: IncomingMessage, res: ServerResponse) {
  const urlPath = decodeURIComponent((req.url ?? "/").split("?")[0]);
  let file = normalize(join(UI_DIST, urlPath));
  if (!file.startsWith(UI_DIST + sep) && file !== UI_DIST) return send(res, 403, { error: "forbidden" });
  if (!existsSync(file) || statSync(file).isDirectory()) file = join(UI_DIST, "index.html");
  if (!existsSync(file)) {
    res.writeHead(503, { "content-type": "text/html; charset=utf-8" });
    return res.end("<h1>WEAVE</h1><p>Dashboard assets not found. Run <code>npm run build</code>.</p>");
  }
  const immutable = file.includes(`${sep}assets${sep}`);
  res.writeHead(200, {
    "content-type": MIME[extname(file)] ?? "application/octet-stream",
    "cache-control": immutable ? "public, max-age=31536000, immutable" : "no-cache",
  });
  res.end(readFileSync(file));
}

/** Emits glow events for nodes whose state changed between two map snapshots. */
function diff(prev: ContextMap | undefined, next: ContextMap): WeaveEvent[] {
  if (!prev) return [];
  const old = new Map(prev.nodes.map((n) => [n.id, n]));
  const events: WeaveEvent[] = [];
  for (const n of next.nodes) {
    const o = old.get(n.id);
    if (!o) events.push({ type: "glow", id: n.id, reason: "changed" });
    else if (!o.severed && n.severed) events.push({ type: "glow", id: n.id, reason: "severed" });
    else if (o.severed && !n.severed) events.push({ type: "glow", id: n.id, reason: n.active ? "activated" : "restored" });
    else if (!o.active && n.active) events.push({ type: "glow", id: n.id, reason: "activated" });
  }
  return events;
}

export async function startDashboard(opts: DashboardOptions = {}): Promise<Dashboard> {
  const store = new ContextStore(opts.root);
  const host = opts.host ?? "127.0.0.1";
  const clients = new Set<WebSocket>();
  let last = syncActive(store.load().map);

  const broadcast = (event: WeaveEvent) => {
    const payload = JSON.stringify(event);
    for (const ws of clients) if (ws.readyState === WebSocket.OPEN) ws.send(payload);
  };

  const refresh = () => {
    const loaded = store.load();
    const next = syncActive(loaded.map);
    const events = diff(last, next);
    last = next;
    broadcast({ type: "graph", map: next, source: loaded.source });
    events.forEach(broadcast);
  };

  const server = createServer((req, res) => {
    const url = (req.url ?? "/").split("?")[0];
    if (url === "/api/graph" && req.method === "GET") {
      const loaded = store.load();
      return send(res, 200, { ...loaded, map: syncActive(loaded.map) });
    }
    const action = url.match(/^\/api\/nodes\/([^/]+)\/(activate|sever|restore)$/);
    if (action && req.method === "POST") {
      const [, rawId, verb] = action;
      try {
        const id = decodeURIComponent(rawId);
        const op = verb === "activate" ? activate : verb === "sever" ? sever : restore;
        let touched: string[] = [];
        store.update((m) => { touched = op(m, id); });
        refresh();
        return send(res, 200, { ok: true, touched });
      } catch (err) {
        return send(res, err instanceof GraphError ? 400 : 500, { ok: false, error: (err as Error).message });
      }
    }
    if (url.startsWith("/api/")) return send(res, 404, { error: "not found" });
    serveStatic(req, res);
  });

  const wss = new WebSocketServer({ noServer: true });
  server.on("upgrade", (req, socket, head) => {
    if ((req.url ?? "").split("?")[0] !== "/ws") return socket.destroy();
    wss.handleUpgrade(req, socket, head, (ws) => {
      clients.add(ws);
      const loaded = store.load();
      ws.send(JSON.stringify({ type: "graph", map: syncActive(loaded.map), source: loaded.source } satisfies WeaveEvent));
      ws.on("close", () => clients.delete(ws));
      ws.on("error", () => clients.delete(ws));
    });
  });

  // Watch .claude/ so MCP tool calls (a separate process) light up the graph live.
  // Non-recursive watchers plus a stat poll on the map: atomic renames and
  // recursive inotify watches are unreliable across platforms, polling is not.
  const claudeDir = join(store.root, ".claude");
  const watchers: FSWatcher[] = [];
  let timer: NodeJS.Timeout | undefined;
  const schedule = () => { clearTimeout(timer); timer = setTimeout(refresh, 80); };
  mkdirSync(join(claudeDir, "features"), { recursive: true });
  for (const dir of [claudeDir, join(claudeDir, "features")]) {
    try { watchers.push(watch(dir, schedule)); } catch { /* polling below still covers the map */ }
  }
  watchFile(store.mapPath, { interval: 750 }, (cur, prev) => { if (cur.mtimeMs !== prev.mtimeMs) schedule(); });

  const startPort = opts.port ?? (Number(process.env.WEAVE_PORT ?? process.env.PORT) || 3000);
  const port = await listenWithFallback(server, startPort, host, opts.maxPortAttempts ?? 50);
  const url = `http://${host === "0.0.0.0" ? "localhost" : host}:${port}`;

  return {
    url,
    port,
    close: () =>
      new Promise<void>((done) => {
        watchers.forEach((w) => w.close());
        unwatchFile(store.mapPath);
        clearTimeout(timer);
        for (const ws of clients) ws.terminate();
        wss.close();
        server.close(() => done());
      }),
  };
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  startDashboard()
    .then((d) => console.log(`[weave] dashboard running at ${d.url}`))
    .catch((err) => {
      console.error(`[weave] failed to start: ${err.message}`);
      process.exit(1);
    });
}
