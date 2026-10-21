import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, extname, join, normalize, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer, WebSocket } from "ws";
import { ActivityTail, readThreads, recentEvents, removeThreads, transcriptTokens, writeThread } from "../engine/activity.js";
import { projectName, writeAgents } from "../engine/agents.js";
import { agentAreas, areas } from "../engine/areas.js";
import { WeaveError } from "../engine/map.js";
import { meter, threadFiles } from "../engine/meter.js";
import { chatLaunch, contextNote, ChatSession, shouldAutoCompact, COMMANDS, defaultPty, type ChatCommand, type PtySpawner } from "../engine/chat.js";
import { isRemoteSession, REMOTE_MESSAGE } from "../engine/remote.js";
import { openTerminal, terminalLaunch, type Spawner } from "../engine/terminal.js";
import { ContextStore, settingsFrom } from "../store.js";
import type { ActivityEvent, Area, ContextMap, Meter, ThreadInfo } from "../types.js";
import { watchFiles, watchProject, type Watcher } from "../watch.js";

const UI_DIST = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "src", "ui", "dist");
const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon", ".json": "application/json", ".woff2": "font/woff2",
};

export interface DashboardOptions { root?: string; port?: number; host?: string; maxPortAttempts?: number; watch?: boolean; spawn?: Spawner; pty?: PtySpawner }
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
  let urlPath: string;
  try { urlPath = decodeURIComponent((req.url ?? "/").split("?")[0]); } catch { return send(res, 400, { error: "bad path" }); }
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
    req.on("data", (c) => { data += c; if (data.length > 64 * 1024) { fail(new WeaveError("Body too large.")); req.destroy(); } });
    req.on("end", () => { try { done(data ? JSON.parse(data) : {}); } catch { fail(new WeaveError("Body is not JSON.")); } });
    req.on("error", fail);
  });
}

/** Largest file the chat accepts from a drop or paste. */
export const UPLOAD_MAX = 15 * 1024 * 1024;
/** A safe file name for the chat's temp folder: no folders, no spaces, no odd characters, a bounded length. */
export function uploadName(raw: string | undefined, now = Date.now()): string {
  const base = (raw ?? "").split(/[\\/]/).pop() ?? "";
  const clean = base.normalize("NFKD").replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^[._]+/, "").replace(/_{2,}/g, "_").slice(-60);
  return `${now}-${clean || "file"}`;
}

const s = (v: unknown) => (typeof v === "string" ? v : undefined);

export interface StatePayload {
  type: "state";
  project: string;
  map: ContextMap;
  /** Areas by fixed rules, busiest first; `hasAgent` marks the ones that get a subagent file. */
  areas: (Area & { hasAgent: boolean })[];
  /** Each thread with its meter reading. */
  threads: (ThreadInfo & { meter: Meter; remote: boolean })[];
  /** The embedded chat, when one is open; its id is the thread it runs as. */
  chat: { id: string; name: string; exited?: number } | null;
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
  let port = 0;
  // The embedded chat gives whoever reaches it a Claude Code session, so it is only offered when the server is bound to this machine.
  const local = ["127.0.0.1", "localhost", "::1"].includes(host);
  let chat: ChatSession | undefined;
  const endChat = (c: ChatSession) => {
    c.kill();
    if (chat === c) chat = undefined;
    removeThreads(store.paths, [c.id]);
    pushState();
  };
  const liveChat = () => (chat && chat.exited === undefined ? chat : undefined);

  const broadcast = (msg: unknown) => {
    const payload = JSON.stringify(msg);
    for (const ws of clients) if (ws.readyState === WebSocket.OPEN) ws.send(payload);
  };

  const state = (): StatePayload => {
    const { map } = store.load();
    const all = areas(map, events), agents = agentAreas(all), withAgent = new Set(agents.map((a) => a.id));
    const week = Date.now() - 7 * 864e5;
    const threads = Object.values(readThreads(store.paths)).filter((t) => t.lastSeen > week).sort((a, b) => b.lastSeen - a.lastSeen).slice(0, 20)
      .map((t) => {
        const contextTokens = transcriptTokens(t.transcript);
        return { ...t, contextTokens, remote: isRemoteSession(t.transcript), meter: meter({ map, events, thread: t, tokens: contextTokens, areas: all, agents, at: "view" }) };
      });
    return { type: "state", project: projectName(map), map, areas: all.map((a) => ({ ...a, hasAgent: withAgent.has(a.id) })), threads, chat: chat ? { id: chat.id, name: chat.name, ...(chat.exited !== undefined ? { exited: chat.exited } : {}) } : null };
  };
  const pushState = () => broadcast(state());
  const agentsNow = () => { const { map } = store.load(); return writeAgents(store.root, projectName(map), areas(map, events)); };

  const routes: Record<string, (b: Record<string, unknown>) => unknown | Promise<unknown>> = {
    "/api/settings": (b) => { store.update((m) => { m.settings = settingsFrom({ ...m.settings, ...b }); }); pushState(); return true; },
    "/api/agents": () => { const r = agentsNow(); pushState(); return r; },
    "/api/threads/rename": (b) => {
      const id = s(b.thread), name = (s(b.name) ?? "").replace(/\s+/g, " ").trim().slice(0, 80);
      if (!id || !readThreads(store.paths)[id]) throw new WeaveError("Unknown thread.");
      if (name) writeThread(store.paths, id, { name, named: true });
      pushState();
      return true;
    },
    "/api/threads/end": (b) => {
      const id = s(b.thread), all = readThreads(store.paths);
      // "older" clears every thread idle for over a day; a single id ends just that thread.
      const ids = b.older === true ? Object.values(all).filter((t) => Date.now() - t.lastSeen >= 864e5).map((t) => t.id) : id ? [id] : [];
      if (!ids.length) throw new WeaveError(b.older === true ? "No older threads to clear." : "Unknown thread.");
      const n = removeThreads(store.paths, ids);
      pushState();
      return n;
    },
    // Opens a console window running Claude Code. The thread is made first, under the id the window will use, so the map names it by how it was launched.
    "/api/terminal": async (b) => {
      const resume = s(b.resume), old = resume ? readThreads(store.paths)[resume] : undefined;
      if (resume && !old) throw new WeaveError("Unknown thread.");
      if (old && isRemoteSession(old.transcript)) throw new WeaveError(REMOTE_MESSAGE);
      const n = Math.max(0, ...Object.values(readThreads(store.paths)).map((x) => x.n ?? 0)) + 1;
      const launch = terminalLaunch({ name: s(b.name) ?? old?.name, fallback: `Thread ${n}`, resume });
      await openTerminal(launch, store.root, opts.spawn);
      if (!old) writeThread(store.paths, launch.id, { name: launch.name, named: s(b.name) !== undefined, launched: true });
      pushState();
      return launch.name;
    },
    // Opens Claude Code inside the page. Same thread bookkeeping as the terminal window: the id is chosen here, so hooks report back to it.
    "/api/chat/open": (b) => {
      if (!local) throw new WeaveError("The embedded chat is only available when WEAVE listens on this machine.");
      const open = liveChat();
      if (open) return { id: open.id, name: open.name };
      const resume = s(b.resume), old = resume ? readThreads(store.paths)[resume] : undefined;
      if (resume && !old) throw new WeaveError("Unknown thread.");
      if (old && isRemoteSession(old.transcript)) throw new WeaveError(REMOTE_MESSAGE);
      const n = Math.max(0, ...Object.values(readThreads(store.paths)).map((x) => x.n ?? 0)) + 1;
      const win = !resume && s(b.window) ? (store.load().map.windows ?? []).find((w) => w.id === s(b.window)) : undefined;
      if (s(b.window) && !resume && !win) throw new WeaveError("Unknown context window.");
      const note = win ? contextNote(win.name, win.files) : undefined;
      const launch = chatLaunch({ name: s(b.name) ?? old?.name, fallback: `Thread ${n}`, resume, note });
      const mine = chat = new ChatSession(launch, store.root, opts.pty ?? defaultPty);
      // A chat that ends, by Close chat or by Claude Code exiting, takes its thread off the map with it.
      mine.attach((m) => { if (m.type === "exit") endChat(mine); });
      if (!old) writeThread(store.paths, launch.id, { name: launch.name, named: s(b.name) !== undefined, launched: true });
      pushState();
      return { id: launch.id, name: launch.name };
    },
    // Saves what a thread holds as a named window, from the activity log. Names are kept per project, newest last.
    "/api/windows/save": (b) => {
      const tid = s(b.thread), name = (s(b.name) ?? "").replace(/\s+/g, " ").trim().slice(0, 60);
      const t = tid ? readThreads(store.paths)[tid] : undefined;
      if (!t) throw new WeaveError("Unknown thread.");
      if (!name) throw new WeaveError("Give the window a name.");
      const { map } = store.load(), files = threadFiles(map, events, t.id, t.prompts);
      if (!files.length) throw new WeaveError("This thread has not read or edited any file yet.");
      const win = { id: randomUUID(), name, files: files.map((f) => f.path), tokens: files.reduce((a, f) => a + f.tokens, 0), savedAt: new Date().toISOString() };
      store.update((m) => { m.windows = [...(m.windows ?? []).filter((w) => w.name !== name), win].slice(-30); });
      pushState();
      return { id: win.id, files: win.files.length };
    },
    "/api/windows/delete": (b) => { store.update((m) => { m.windows = (m.windows ?? []).filter((w) => w.id !== s(b.id)); }); pushState(); return true; },
    "/api/chat/close": () => { if (chat) endChat(chat); return true; },
    // Only the two whitelisted commands can be typed for the user.
    "/api/chat/command": (b) => {
      const cmd = s(b.command) as ChatCommand | undefined, open = liveChat();
      if (!cmd || !Object.hasOwn(COMMANDS, cmd)) throw new WeaveError("Unknown chat command.");
      if (!open) throw new WeaveError("No chat is open.");
      open.command(cmd);
      return true;
    },
    "/api/rescan": () => { store.rescan(); agentsNow(); pushState(); return true; },
  };

  // Only this page may call the API: the Host must be ours and any Origin must match it.
  const trusted = (req: IncomingMessage) => {
    const ok = new Set([`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`, `${host}:${port}`]);
    if (!ok.has(req.headers.host ?? "")) return false;
    const origin = req.headers.origin;
    return !origin || ok.has(origin.replace(/^https?:\/\//, ""));
  };

  const server = createServer(async (req, res) => {
    try {
      if (!trusted(req)) return send(res, 403, { error: "forbidden" });
      const url = (req.url ?? "/").split("?")[0];
      if (url === "/api/state" && req.method === "GET") return send(res, 200, state());
      if (url === "/api/chat/upload" && req.method === "POST") {
        // A dropped or pasted file: raw bytes in, saved only under <weave data>/temp, and the path is handed back to be typed as @path.
        if (!local || !liveChat()) return send(res, 400, { ok: false, error: "No chat is open." });
        const len = Number(req.headers["content-length"] ?? 0);
        if (!len || len > UPLOAD_MAX) return send(res, 413, { ok: false, error: `Files up to ${UPLOAD_MAX / 1024 / 1024} MB only.` });
        const chunks: Buffer[] = []; let size = 0;
        for await (const c of req) { size += (c as Buffer).length; if (size > UPLOAD_MAX) return send(res, 413, { ok: false, error: "File too large." }); chunks.push(c as Buffer); }
        const dir = join(store.paths.weaveDir, "temp");
        mkdirSync(dir, { recursive: true });
        // Whatever is a day old goes, so the folder does not grow without end.
        for (const f of readdirSync(dir)) { try { if (Date.now() - statSync(join(dir, f)).mtimeMs > 864e5) unlinkSync(join(dir, f)); } catch { /* gone already */ } }
        const file = join(dir, uploadName(new URL(req.url ?? "", "http://x").searchParams.get("name") ?? undefined));
        writeFileSync(file, Buffer.concat(chunks));
        return send(res, 200, { ok: true, result: { path: relative(store.root, file).split(sep).join("/"), bytes: size } });
      }
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
    } catch (err) {
      // One bad request never takes the map down.
      if (!res.headersSent) send(res, 500, { error: (err as Error).message });
      else res.end();
    }
  });

  const wss = new WebSocketServer({ noServer: true });
  const ptyWss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });
  server.on("upgrade", (req, socket, head) => {
    if ((req.url ?? "").split("?")[0] === "/pty") {
      // The chat socket is stricter than the rest: one of our own pages must be asking, so an Origin is required.
      const open = liveChat();
      if (!local || !open || !req.headers.origin || !trusted(req)) return socket.destroy();
      return ptyWss.handleUpgrade(req, socket, head, (ws) => {
        const detach = open.attach((m) => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(m)); });
        ws.on("message", (raw, binary) => {
          if (binary) return;
          let m: { type?: unknown; data?: unknown; cols?: unknown; rows?: unknown };
          try { m = JSON.parse(raw.toString()); } catch { return; }
          if (m.type === "input" && typeof m.data === "string") open.write(m.data);
          else if (m.type === "resize") open.resize(Number(m.cols), Number(m.rows));
        });
        ws.on("close", detach);
        ws.on("error", detach);
      });
    }
    if ((req.url ?? "").split("?")[0] !== "/ws" || !trusted(req)) return socket.destroy();
    wss.handleUpgrade(req, socket, head, (ws) => {
      clients.add(ws);
      ws.send(JSON.stringify(state()));
      ws.send(JSON.stringify({ type: "history", events }));
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
    // A failed rescan (say, the map is locked for longer than the retries) waits for the next change instead of stopping the server.
    watchers.push(watchProject(store.root, () => { try { store.rescan(); } catch (err) { console.error(`[weave] rescan failed: ${(err as Error).message}`); } }));
    // Token counts in transcripts change without any event, so refresh open maps every 20 seconds.
    const tick = setInterval(() => { if (clients.size) pushState(); }, 20_000);
    watchers.push({ close: () => clearInterval(tick) });
    // /compact is typed for the in-page chat once Claude Code finishes a task. /clear is never sent without a click.
    const manage = setInterval(() => {
      const open = liveChat();
      if (!open) return;
      const { map } = store.load();
      if (!map.settings.meter) return;
      const t = state().threads.find((x) => x.id === open.id);
      if (t && shouldAutoCompact({ level: t.meter.level, stoppedAt: t.stopped, promptAt: t.prompts?.at(-1), lastCommandAt: open.lastCommand, quietMs: Date.now() - open.lastOutput, sinceLastMs: Date.now() - open.lastCommand })) open.command("compact");
    }, 5000);
    watchers.push({ close: () => clearInterval(manage) });
  }

  const startPort = opts.port ?? (Number(process.env.WEAVE_PORT) || 3000);
  port = await listenWithFallback(server, startPort, host, opts.maxPortAttempts ?? 50);

  return {
    url: `http://${host === "0.0.0.0" ? "localhost" : host}:${port}`,
    port,
    close: () => new Promise<void>((done) => {
      watchers.forEach((w) => w.close());
      chat?.kill();
      ptyWss.close();
      for (const ws of clients) ws.terminate();
      wss.close();
      server.close(() => done());
    }),
  };
}
