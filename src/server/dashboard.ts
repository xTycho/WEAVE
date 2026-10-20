import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { existsSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, extname, join, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer, WebSocket } from "ws";
import { ActivityTail, readThreads, recentEvents, transcriptTokens } from "../engine/activity.js";
import { suggestions } from "../engine/rules.js";
import { countExact, removeKey, saveKey, tokenMode } from "../engine/tokens.js";
import { attach, createPreset, deletePreset, detach, findNode, getPreset, spinUp, toggle, WeaveError } from "../engine/window.js";
import { listFiles } from "../scanner/files.js";
import { ContextStore } from "../store.js";
import type { ActivityEvent, ContextMap, Suggestion, ThreadInfo } from "../types.js";
import { watchFiles, watchProject, type Watcher } from "../watch.js";

const UI_DIST = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "src", "ui", "dist");
const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon", ".json": "application/json", ".woff2": "font/woff2",
};

export interface DashboardOptions { root?: string; port?: number; host?: string; maxPortAttempts?: number; watch?: boolean }
export interface Dashboard { url: string; port: number; close(): Promise<void> }

/** Listens on `port`, walking upward (3000 -> 3001 -> ...) while ports are taken. */
export function listenWithFallback(server: Server, port: number, host: string, attempts: number): Promise<number> {
  return new Promise((done, fail) => {
    let current = port;
    const tryListen = () => {
      const onError = (err: NodeJS.ErrnoException) => {
        server.off("listening", onListening);
        if ((err.code === "EADDRINUSE" || err.code === "EACCES") && current < port + attempts - 1) { current += 1; tryListen(); } else fail(err);
      };
      const onListening = () => { server.off("error", onError); done(current); };
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
    return res.end("<h1>WEAVE</h1><p>Map assets not found. Run <code>npm run build</code>.</p>");
  }
  res.writeHead(200, {
    "content-type": MIME[extname(file)] ?? "application/octet-stream",
    "cache-control": file.includes(`${sep}assets${sep}`) ? "public, max-age=31536000, immutable" : "no-cache",
  });
  res.end(readFileSync(file));
}

function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((done, fail) => {
    let data = "";
    req.on("data", (c) => { data += c; if (data.length > 64 * 1024) req.destroy(); });
    req.on("end", () => { try { done(data ? JSON.parse(data) : {}); } catch { fail(new WeaveError("Body is not JSON.")); } });
    req.on("error", fail);
  });
}

const s = (v: unknown) => (typeof v === "string" ? v : undefined);

export interface StatePayload {
  type: "state";
  project: string;
  map: Omit<ContextMap, "links" | "overrides" | "custom" | "dismissed">;
  threads: (ThreadInfo & { preset: string })[];
  suggestions: Record<string, Suggestion[]>;
  tokens: { mode: "exact" | "estimate"; source?: string; counting?: { done: number; total: number }; error?: string };
}

/**
 * The local map server: HTTP for actions, a WebSocket for live state and
 * activity. It only listens on this machine and only accepts requests from
 * its own page.
 */
export async function startDashboard(opts: DashboardOptions = {}): Promise<Dashboard> {
  const store = new ContextStore(opts.root);
  const host = opts.host ?? "127.0.0.1";
  const clients = new Set<WebSocket>();
  const tail = new ActivityTail(store.paths.activity);
  let events: ActivityEvent[] = recentEvents(store.paths);
  let counting: { done: number; total: number } | undefined;
  let countError: string | undefined;
  let port = 0;

  const broadcast = (msg: unknown) => {
    const payload = JSON.stringify(msg);
    for (const ws of clients) if (ws.readyState === WebSocket.OPEN) ws.send(payload);
  };

  const state = (): StatePayload => {
    const { map } = store.load();
    const week = Date.now() - 7 * 864e5;
    const threads = Object.values(readThreads(store.paths)).filter((t) => t.lastSeen > week).sort((a, b) => b.lastSeen - a.lastSeen).slice(0, 20)
      .map((t) => ({ ...t, preset: map.assign[t.id] ?? map.settings.defaultPreset, contextTokens: transcriptTokens(t.transcript) }));
    const { links: _l, overrides: _o, custom: _c, dismissed: _d, ...rest } = map;
    return {
      type: "state", project: map.nodes.find((n) => n.tier === "core")?.label ?? basename(store.root), map: rest, threads,
      suggestions: Object.fromEntries(map.presets.map((p) => [p.id, suggestions(map, p, events).slice(0, 3)])),
      tokens: { ...tokenMode(), ...(counting ? { counting } : {}), ...(countError ? { error: countError } : {}) },
    };
  };
  const pushState = () => broadcast(state());

  const count = async () => {
    if (tokenMode().mode !== "exact") return;
    countError = undefined;
    try {
      const n = await countExact(store.root, listFiles(store.root), (done, total) => { counting = { done, total }; if (done % 10 === 0 || done === total) pushState(); });
      counting = undefined;
      if (n) store.rescan();
    } catch (err) {
      counting = undefined;
      countError = (err as Error).message;
    }
    pushState();
  };

  const act = (body: Record<string, unknown>, fn: (map: ContextMap) => unknown) => {
    const { result } = store.update(fn);
    pushState();
    return result;
  };

  const routes: Record<string, (b: Record<string, unknown>) => unknown | Promise<unknown>> = {
    "/api/toggle": (b) => act(b, (m) => toggle(m, s(b.preset), s(b.node) ?? "")),
    "/api/attach": (b) => act(b, (m) => attach(m, s(b.preset), s(b.node) ?? "")),
    "/api/detach": (b) => act(b, (m) => detach(m, s(b.preset), s(b.node) ?? "")),
    "/api/presets/create": (b) => act(b, (m) => createPreset(m, s(b.name) ?? "New preset", undefined, s(b.copyFrom))),
    "/api/presets/delete": (b) => act(b, (m) => deletePreset(m, s(b.id) ?? "")),
    "/api/presets/rename": (b) => act(b, (m) => { getPreset(m, s(b.id)).name = (s(b.name) ?? "").trim().slice(0, 60) || getPreset(m, s(b.id)).name; }),
    "/api/presets/default": (b) => act(b, (m) => { m.settings.defaultPreset = getPreset(m, s(b.id)).id; }),
    "/api/assign": (b) => act(b, (m) => { const t = s(b.thread); if (!t) throw new WeaveError("Missing thread."); m.assign[t] = getPreset(m, s(b.preset)).id; }),
    "/api/settings": (b) => act(b, (m) => {
      if (typeof b.autoApply === "boolean") m.settings.autoApply = b.autoApply;
      if (b.gate === "flag" || b.gate === "block") m.settings.gate = b.gate;
      if (typeof b.idleAfter === "number") m.settings.idleAfter = Math.min(500, Math.max(3, Math.round(b.idleAfter)));
    }),
    "/api/spin": (b) => act(b, (m) => spinUp(m, s(b.preset), s(b.design) ?? "", s(b.name) ?? "", s(b.bring) || undefined)),
    "/api/rename": (b) => act(b, (m) => {
      const n = findNode(m, s(b.node) ?? ""), label = (s(b.label) ?? "").trim().slice(0, 60);
      if (label) { n.label = label; (m.overrides[n.id] ??= {}).label = label; }
    }),
    "/api/suggestion": (b) => act(b, (m) => {
      const key = s(b.key) ?? "";
      if (b.action === "dismiss") { if (!m.dismissed.includes(key)) m.dismissed.push(key); m.dismissed = m.dismissed.slice(-500); return; }
      (b.attach ? attach : detach)(m, s(b.preset), s(b.node) ?? "");
    }),
    "/api/rescan": () => { store.rescan(); pushState(); void count(); return true; },
    "/api/key": (b) => { saveKey(s(b.key) ?? ""); pushState(); void count(); return tokenMode(); },
    "/api/key/delete": () => { removeKey(); store.rescan(); pushState(); return tokenMode(); },
  };

  // Only this page may call the API: the Host must be ours and any Origin must match it.
  const trusted = (req: IncomingMessage) => {
    const ok = new Set([`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`, `${host}:${port}`]);
    if (!ok.has(req.headers.host ?? "")) return false;
    const origin = req.headers.origin;
    return !origin || ok.has(origin.replace(/^https?:\/\//, ""));
  };

  const server = createServer(async (req, res) => {
    if (!trusted(req)) return send(res, 403, { error: "forbidden" });
    const url = (req.url ?? "/").split("?")[0];
    if (url === "/api/state" && req.method === "GET") return send(res, 200, state());
    const route = routes[url];
    if (route) {
      if (req.method !== "POST" || !(req.headers["content-type"] ?? "").includes("application/json")) return send(res, 405, { error: "POST JSON only" });
      try {
        return send(res, 200, { ok: true, result: await route(await readBody(req)) });
      } catch (err) {
        return send(res, err instanceof WeaveError ? 400 : 500, { ok: false, error: (err as Error).message });
      }
    }
    if (url.startsWith("/api/")) return send(res, 404, { error: "not found" });
    serveStatic(req, res);
  });

  const wss = new WebSocketServer({ noServer: true });
  server.on("upgrade", (req, socket, head) => {
    if ((req.url ?? "").split("?")[0] !== "/ws" || !trusted(req)) return socket.destroy();
    wss.handleUpgrade(req, socket, head, (ws) => {
      clients.add(ws);
      ws.send(JSON.stringify(state()));
      ws.send(JSON.stringify({ type: "history", events: events.slice(-40) }));
      ws.on("close", () => clients.delete(ws));
      ws.on("error", () => clients.delete(ws));
    });
  });

  // Make sure the map on disk matches the project before anyone looks at it.
  store.rescan();

  const watchers: Watcher[] = [];
  if (opts.watch !== false) {
    watchers.push(watchFiles([store.paths.map, store.paths.threads], () => pushState()));
    watchers.push(watchFiles([store.paths.activity], () => {
      const fresh = tail.read();
      if (!fresh.length) return;
      events = [...events, ...fresh].slice(-2000);
      broadcast({ type: "activity", events: fresh });
      pushState();
    }, 40));
    watchers.push(watchProject(store.root, () => { store.rescan(); void count(); }));
  }

  const startPort = opts.port ?? (Number(process.env.WEAVE_PORT) || 3000);
  port = await listenWithFallback(server, startPort, host, opts.maxPortAttempts ?? 50);
  void count();

  return {
    url: `http://${host === "0.0.0.0" ? "localhost" : host}:${port}`,
    port,
    close: () => new Promise<void>((done) => {
      watchers.forEach((w) => w.close());
      for (const ws of clients) ws.terminate();
      wss.close();
      server.close(() => done());
    }),
  };
}
