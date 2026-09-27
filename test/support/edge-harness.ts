import type { AddressInfo } from "node:net";
import { EdgeHub, type EdgeHubOptions } from "../../src/edge/hub.ts";
import type { EdgeServerMessage } from "../../src/edge/protocol.ts";
import { createEdgeServer } from "../../src/edge/server.ts";

export const EDGE_TEST_TOKEN = "test-join-token";

export interface RunningHub {
  hub: EdgeHub;
  wsUrl: string;
  httpBase: string;
  close(): Promise<void>;
}

export async function startHub(options: Partial<EdgeHubOptions> = {}): Promise<RunningHub> {
  const hub = new EdgeHub({ joinToken: EDGE_TEST_TOKEN, ...options });
  const { server, websocket } = createEdgeServer(hub);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    hub,
    wsUrl: `ws://127.0.0.1:${port}/edge/ws`,
    httpBase: `http://127.0.0.1:${port}`,
    async close() {
      websocket.close();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

export interface RawClient {
  messages: EdgeServerMessage[];
  send(message: unknown): void;
  sendText(text: string): void;
  waitFor<T extends EdgeServerMessage["type"]>(
    type: T,
    predicate?: (message: Extract<EdgeServerMessage, { type: T }>) => boolean,
  ): Promise<Extract<EdgeServerMessage, { type: T }>>;
  closed: Promise<{ code: number }>;
  close(): void;
}

export async function rawClient(url: string): Promise<RawClient> {
  const socket = new WebSocket(url);
  const messages: EdgeServerMessage[] = [];
  const waiters = new Set<() => void>();
  socket.addEventListener("message", (event) => {
    messages.push(JSON.parse(String(event.data)) as EdgeServerMessage);
    for (const waiter of [...waiters]) waiter();
  });
  const closed = new Promise<{ code: number }>((resolve) =>
    socket.addEventListener("close", (e) => resolve({ code: e.code })),
  );
  await new Promise<void>((resolve, reject) => {
    socket.addEventListener("open", () => resolve());
    socket.addEventListener("error", () => reject(new Error("websocket failed to open")));
  });
  return {
    messages,
    send: (message) => socket.send(JSON.stringify(message)),
    sendText: (text) => socket.send(text),
    closed,
    close: () => socket.close(),
    waitFor(type, predicate) {
      return new Promise((resolve, reject) => {
        let seen = 0;
        const check = (): void => {
          for (; seen < messages.length; seen++) {
            const message = messages[seen];
            if (message?.type !== type) continue;
            const typed = message as Extract<EdgeServerMessage, { type: typeof type }>;
            if (predicate && !predicate(typed)) continue;
            waiters.delete(check);
            clearTimeout(timer);
            resolve(typed);
            return;
          }
        };
        const timer = setTimeout(() => {
          waiters.delete(check);
          reject(new Error(`timed out waiting for ${type}; got ${messages.map((m) => m.type).join(",")}`));
        }, 3000);
        waiters.add(check);
        check();
      });
    },
  };
}

export async function joinedClient(url: string, name: string, type: "human" | "agent" = "human"): Promise<RawClient> {
  const client = await rawClient(url);
  client.send({
    type: "hello",
    protocolVersion: 1,
    actor: { id: name.toLowerCase(), displayName: name, type },
    node: { id: `${name.toLowerCase()}-node`, adapter: "unity", deviceName: `${name}'s Mac` },
  });
  client.send({ type: "joinProject", projectId: "unity-demo", token: EDGE_TEST_TOKEN });
  await client.waitFor("joined");
  return client;
}

export function operation(name: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: crypto.randomUUID(),
    protocolVersion: 1,
    projectId: "unity-demo",
    actorId: name.toLowerCase(),
    nodeId: `${name.toLowerCase()}-node`,
    adapter: "unity",
    resourceType: "GameObject",
    resourceId: "cube-1",
    action: "set_transform",
    effect: "update",
    payload: { position: [1, 2, 3] },
    ...overrides,
  };
}

export function settle(ms = 60): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
