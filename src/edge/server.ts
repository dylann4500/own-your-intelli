import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer, type WebSocket } from "ws";
import { errMessage } from "../util/errors.ts";
import { EDGE_WS_PATH } from "./config.ts";
import { EDGE_DASHBOARD_HTML } from "./dashboard.ts";
import { EDGE_ROOM_HTML } from "./room.ts";
import { handleEdgeApi, isReservedActorId } from "./http.ts";
import type { EdgeHub } from "./hub.ts";
import { EDGE_PROTOCOL_VERSION, EdgeProtocolError, edgeProjectId } from "./protocol.ts";

const MAX_FRAME_BYTES = 512 * 1024;
const MAX_BODY_BYTES = 64 * 1024;
const MAX_BUFFERED_BYTES = 8 * 1024 * 1024;

export interface EdgeWebSocketHandle {
  close(): void;
}

export interface EdgeWebSocketOptions {
  path?: string;
  heartbeatMs?: number;
}

function pathnameOf(url: string | undefined): string {
  try {
    return new URL(url ?? "/", "http://edge.local").pathname;
  } catch {
    return "";
  }
}

function sameOrigin(req: IncomingMessage): boolean {
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    return new URL(origin).host === req.headers.host;
  } catch {
    return false;
  }
}

export function attachEdgeWebSocket(
  server: Server,
  hub: EdgeHub,
  options: EdgeWebSocketOptions = {},
): EdgeWebSocketHandle {
  const path = options.path ?? EDGE_WS_PATH;
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME_BYTES });
  const alive = new WeakMap<WebSocket, boolean>();

  wss.on("connection", (socket: WebSocket) => {
    alive.set(socket, true);
    const connection = hub.connect({
      send(message) {
        if (socket.readyState !== socket.OPEN) return;
        if (socket.bufferedAmount > MAX_BUFFERED_BYTES) {
          socket.terminate();
          return;
        }
        socket.send(JSON.stringify(message));
      },
      close(code, reason) {
        socket.close(code, reason);
      },
    });
    socket.on("pong", () => alive.set(socket, true));
    let rejected = false;
    socket.on("message", (data, isBinary) => {
      if (rejected) return;
      alive.set(socket, true);
      if (isBinary) {
        connection.handle(null);
        return;
      }
      connection.handle(data.toString());
      if (connection.actor && isReservedActorId(connection.actor.id)) {
        connection.send({
          type: "error",
          code: "actor_mismatch",
          message: `actor id ${connection.actor.id} is reserved for identities QM core assigns`,
          requestType: "hello",
        });
        rejected = true;
        socket.close(1008, "reserved actor id");
        connection.close();
      }
    });
    socket.on("close", () => connection.close());
    socket.on("error", () => connection.close());
  });

  const onUpgrade = (req: IncomingMessage, socket: Duplex, head: Buffer): void => {
    if (pathnameOf(req.url) !== path) {
      if (server.listenerCount("upgrade") === 1) {
        socket.end("HTTP/1.1 404 Not Found\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
      }
      return;
    }
    if (!sameOrigin(req)) {
      socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
  };
  server.on("upgrade", onUpgrade);

  const heartbeat = setInterval(() => {
    for (const socket of wss.clients) {
      if (alive.get(socket) === false) {
        socket.terminate();
        continue;
      }
      alive.set(socket, false);
      socket.ping();
    }
    hub.sweep();
  }, options.heartbeatMs ?? 15_000);
  heartbeat.unref();

  return {
    close() {
      clearInterval(heartbeat);
      server.off("upgrade", onUpgrade);
      for (const socket of wss.clients) socket.close(1001, "edge hub shutting down");
      wss.close();
    },
  };
}

function edgeTokenFrom(req: IncomingMessage): string | null {
  const header = req.headers.authorization;
  if (typeof header === "string" && header.toLowerCase().startsWith("bearer ")) return header.slice(7).trim();
  const edgeHeader = req.headers["x-edge-token"];
  if (typeof edgeHeader === "string") return edgeHeader.trim();
  return null;
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(text);
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = chunk as Buffer;
    size += buffer.length;
    if (size > MAX_BODY_BYTES) throw new Error("request body too large");
    chunks.push(buffer);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  return text.trim() === "" ? {} : JSON.parse(text);
}

export interface EdgeAgentRequest {
  projectId: string;
  name: string;
  text: string;
}

export interface EdgeAgentBridge {
  ask(request: EdgeAgentRequest): { agent: string };
}

export interface EdgeHttpOptions {
  agents?: EdgeAgentBridge;
}

const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;

function askAgent(
  hub: EdgeHub,
  agents: EdgeAgentBridge | undefined,
  projectId: string,
  body: unknown,
): { status: number; body: unknown } {
  const input = typeof body === "object" && body !== null ? (body as Record<string, unknown>) : {};
  const name = typeof input.name === "string" ? input.name.trim() : "";
  const text = typeof input.text === "string" ? input.text.trim() : "";
  if (!name || name.length > 40 || CONTROL_CHARACTERS.test(name)) {
    return { status: 400, body: { error: "invalid_message", message: "name must be 1-40 printable characters" } };
  }
  if (!text || text.length > 2000) {
    return { status: 400, body: { error: "invalid_message", message: "text must be 1-2000 characters" } };
  }
  if (!edgeProjectId.safeParse(projectId).success || !hub.hasProject(projectId)) {
    return { status: 404, body: { error: "unknown_project", message: `no Edge project ${projectId}` } };
  }
  if (!agents) {
    return {
      status: 501,
      body: {
        error: "agents_unavailable",
        message: "This hub runs without QM agents; start it with npm run edge:qm to prompt agents",
      },
    };
  }
  try {
    return { status: 202, body: { accepted: true, ...agents.ask({ projectId, name, text }) } };
  } catch (e) {
    if (e instanceof EdgeProtocolError && e.code === "rate_limited") {
      return { status: 429, body: { error: e.code, message: e.message } };
    }
    throw e;
  }
}

export async function handleEdgeHttpRequest(
  hub: EdgeHub,
  req: IncomingMessage,
  res: ServerResponse,
  options: EdgeHttpOptions = {},
): Promise<boolean> {
  const url = new URL(req.url ?? "/", "http://edge.local");
  const method = req.method ?? "GET";
  if (url.pathname === "/edge/room" && method === "GET") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
    res.end(EDGE_ROOM_HTML);
    return true;
  }
  if ((url.pathname === "/edge" || url.pathname === "/edge/") && method === "GET") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
    res.end(EDGE_DASHBOARD_HTML);
    return true;
  }
  if (url.pathname === "/edge/health") {
    sendJson(res, 200, {
      ok: true,
      service: "qm-edge",
      hubName: hub.hubName,
      protocolVersion: EDGE_PROTOCOL_VERSION,
      webSocketPath: EDGE_WS_PATH,
      connections: hub.connectionCount,
    });
    return true;
  }
  if (!url.pathname.startsWith("/edge/v1/")) return false;
  if (!hub.verifyToken(edgeTokenFrom(req))) {
    sendJson(res, 401, { error: "unauthorized", message: "send the join token as 'Authorization: Bearer <token>'" });
    return true;
  }
  let body: unknown = {};
  if (method === "POST") {
    try {
      body = await readJsonBody(req);
    } catch (e) {
      sendJson(res, 400, { error: "invalid_message", message: errMessage(e) });
      return true;
    }
  }
  const subpath = url.pathname.slice("/edge/v1/".length);
  const agentRoute = /^projects\/([^/]+)\/agent$/.exec(subpath);
  if (agentRoute && method === "POST") {
    const asked = askAgent(hub, options.agents, decodeURIComponent(agentRoute[1] ?? ""), body);
    sendJson(res, asked.status, asked.body);
    return true;
  }
  const result = handleEdgeApi(hub, {
    method,
    path: subpath,
    query: url.searchParams,
    body,
    actor: null,
  });
  sendJson(res, result.status, result.body);
  return true;
}

export function createEdgeServer(
  hub: EdgeHub,
  options: EdgeHttpOptions = {},
): { server: Server; websocket: EdgeWebSocketHandle } {
  const server = createServer((req, res) => {
    handleEdgeHttpRequest(hub, req, res, options)
      .then((handled) => {
        if (!handled)
          sendJson(res, 404, {
            error: "not_found",
            message: "QM Edge serves /edge/health, /edge/v1/* and the /edge/ws WebSocket",
          });
      })
      .catch((e: unknown) => {
        if (!res.headersSent) sendJson(res, 500, { error: "internal", message: errMessage(e) });
        else res.destroy();
      });
  });
  const websocket = attachEdgeWebSocket(server, hub);
  return { server, websocket };
}
