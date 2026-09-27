import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { request as httpRequest, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { closeEdgeWebSocket, createServer } from "../src/api/server.ts";
import type { App } from "../src/api/app.ts";
import { CAPABILITY_TTL_MS, CONTROL_PLANE_AUD, mintCapabilityToken } from "../src/auth/capability-token.ts";
import { mintPortalIdentity } from "../src/auth/portal-identity.ts";
import { signedRequestHeaders } from "../src/auth/source-auth-sign.ts";
import { loadConfig } from "../src/config.ts";
import { EdgeHub } from "../src/edge/hub.ts";
import type { EdgeCommittedOperation, EdgeServerMessage } from "../src/edge/protocol.ts";
import { scopeId } from "../src/types.ts";

const SECRET = "edge-core-routes-secret".repeat(2);
const JOIN_TOKEN = "join-token-1234";
const PROJECT = "unity-demo";

const stubApp = { authorizesCapabilityScope: async () => true } as unknown as App;

const capFor = (actorId: string) =>
  mintCapabilityToken(
    { actorId, scopeId: scopeId("personal", actorId), aud: CONTROL_PLANE_AUD, exp: Date.now() + CAPABILITY_TTL_MS },
    SECRET,
  );

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, resolve));
  return (server.address() as AddressInfo).port;
}

function stop(server: Server): Promise<void> {
  closeEdgeWebSocket(server);
  server.closeAllConnections();
  return new Promise<void>((resolve) => server.close(() => resolve()));
}

function openClient(port: number): {
  socket: WebSocket;
  next: (predicate: (message: EdgeServerMessage) => boolean) => Promise<EdgeServerMessage>;
} {
  const socket = new WebSocket(`ws://127.0.0.1:${port}/edge/ws`);
  const seen: EdgeServerMessage[] = [];
  const waiters: Array<{ predicate: (m: EdgeServerMessage) => boolean; resolve: (m: EdgeServerMessage) => void }> = [];
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(String(event.data)) as EdgeServerMessage;
    seen.push(message);
    const matched = waiters.filter((waiter) => waiter.predicate(message));
    for (const waiter of matched) {
      waiters.splice(waiters.indexOf(waiter), 1);
      waiter.resolve(message);
    }
  });
  const next = (predicate: (message: EdgeServerMessage) => boolean): Promise<EdgeServerMessage> => {
    const already = seen.find(predicate);
    if (already) return Promise.resolve(already);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("timed out waiting for edge message")), 5000);
      waiters.push({
        predicate,
        resolve: (m) => {
          clearTimeout(timer);
          resolve(m);
        },
      });
    });
  };
  return { socket, next };
}

const createCube = {
  adapter: "unity",
  resourceType: "GameObject",
  resourceId: "x1",
  action: "create_object",
  effect: "create",
  payload: { name: "AgentCube", primitive: "Cube", position: [2, 1, 0] },
};

describe("QM Edge inside QM core", () => {
  let server: Server;
  let port: number;
  let base: string;
  let hub: EdgeHub;

  before(async () => {
    hub = new EdgeHub({ joinToken: JOIN_TOKEN });
    hub.ensureProject(PROJECT);
    server = createServer(stubApp, { signingSecret: SECRET, edgeHub: hub });
    port = await listen(server);
    base = `http://127.0.0.1:${port}`;
  });

  after(() => stop(server));

  it("rejects agent API reads without auth", async () => {
    const res = await fetch(`${base}/v1/edge/projects/${PROJECT}/presence`);
    assert.equal(res.status, 401);
  });

  it("serves agent API reads to a capability holder", async () => {
    const res = await fetch(`${base}/v1/edge/projects/${PROJECT}/presence`, {
      headers: { "x-agent-capability": await capFor("U1") },
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { projectId: string; exists: boolean };
    assert.equal(body.projectId, PROJECT);
    assert.equal(body.exists, true);
  });

  it("streams an agent operation to a joined WebSocket client with agent attribution", async () => {
    const client = openClient(port);
    await new Promise<void>((resolve, reject) => {
      client.socket.addEventListener("open", () => resolve(), { once: true });
      client.socket.addEventListener("error", () => reject(new Error("websocket failed to open")), { once: true });
    });
    try {
      client.socket.send(
        JSON.stringify({
          type: "hello",
          protocolVersion: 1,
          actor: { id: "unity-dylan", displayName: "Dylan", type: "human" },
          node: { id: "editor-1", adapter: "unity" },
        }),
      );
      await client.next((m) => m.type === "welcome");
      client.socket.send(JSON.stringify({ type: "joinProject", projectId: PROJECT, token: JOIN_TOKEN }));
      await client.next((m) => m.type === "joined");

      const res = await fetch(`${base}/v1/edge/projects/${PROJECT}/operations`, {
        method: "POST",
        headers: { "x-agent-capability": await capFor("U1"), "content-type": "application/json" },
        body: JSON.stringify({
          actor: { id: "unity-dylan", displayName: "Dylan", type: "human" },
          operation: createCube,
        }),
      });
      assert.equal(res.status, 201);
      const result = (await res.json()) as { operation: EdgeCommittedOperation; duplicate: boolean };
      assert.equal(result.duplicate, false);
      assert.equal(result.operation.actor.type, "agent");
      assert.equal(result.operation.actor.id, "qm-agent:U1");
      assert.equal(result.operation.actorId, "qm-agent:U1");

      const streamed = await client.next(
        (m) => m.type === "committedOperation" && m.operation.id === result.operation.id,
      );
      assert.equal(streamed.type, "committedOperation");
      if (streamed.type !== "committedOperation") return;
      assert.equal(streamed.operation.sequence, result.operation.sequence);
      assert.deepEqual(streamed.operation.actor, { id: "qm-agent:U1", displayName: "QM Agent", type: "agent" });
      assert.deepEqual(streamed.operation.payload, createCube.payload);
    } finally {
      client.socket.close();
    }
  });

  it("rejects an agent operation that forges another actor id", async () => {
    const res = await fetch(`${base}/v1/edge/projects/${PROJECT}/operations`, {
      method: "POST",
      headers: { "x-agent-capability": await capFor("U1"), "content-type": "application/json" },
      body: JSON.stringify({ operation: { ...createCube, resourceId: "x2", actorId: "unity-dylan" } }),
    });
    assert.equal(res.status, 403);
    assert.equal(((await res.json()) as { error: string }).error, "actor_mismatch");
  });

  it("attributes a signed portal write to the human and refuses one with no identity", async () => {
    const path = `/v1/edge/projects/${PROJECT}/operations`;
    const body = JSON.stringify({ operation: { ...createCube, resourceId: "x3" } });
    const portal = await mintPortalIdentity({ p: "alice", n: "Alice", exp: Date.now() + 60_000 }, SECRET);
    const human = await fetch(`${base}${path}`, {
      method: "POST",
      headers: signedRequestHeaders(SECRET, "POST", path, body, {
        "x-portal-identity": portal,
        "content-type": "application/json",
      }),
      body,
    });
    assert.equal(human.status, 201);
    const committed = ((await human.json()) as { operation: EdgeCommittedOperation }).operation;
    assert.deepEqual(committed.actor, { id: "qm-user:alice", displayName: "Alice", type: "human" });

    const anonymousBody = JSON.stringify({
      actor: { id: "someone", displayName: "Someone", type: "human" },
      operation: { ...createCube, resourceId: "x4" },
    });
    const anonymous = await fetch(`${base}${path}`, {
      method: "POST",
      headers: signedRequestHeaders(SECRET, "POST", path, anonymousBody, { "content-type": "application/json" }),
      body: anonymousBody,
    });
    assert.equal(anonymous.status, 401);
  });

  it("lists resources committed through core", async () => {
    const res = await fetch(`${base}/v1/edge/projects/${PROJECT}/resources?adapter=unity`, {
      headers: { "x-agent-capability": await capFor("U1") },
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { resources: Array<{ resourceId: string; lastActorId: string | null }> };
    const cube = body.resources.find((r) => r.resourceId === "x1");
    assert.equal(cube?.lastActorId, "qm-agent:U1");
  });

  it("serves the join-token REST API before core auth", async () => {
    const health = await fetch(`${base}/edge/health`);
    assert.equal(health.status, 200);
    const healthBody = (await health.json()) as { ok: boolean; service: string; webSocketPath: string };
    assert.equal(healthBody.ok, true);
    assert.equal(healthBody.service, "qm-edge");
    assert.equal(healthBody.webSocketPath, "/edge/ws");

    assert.equal((await fetch(`${base}/edge/v1/projects`)).status, 401);
    assert.equal(
      (await fetch(`${base}/edge/v1/projects`, { headers: { authorization: "Bearer wrong-token" } })).status,
      401,
    );
    const listed = await fetch(`${base}/edge/v1/projects`, { headers: { authorization: `Bearer ${JOIN_TOKEN}` } });
    assert.equal(listed.status, 200);
    const projects = ((await listed.json()) as { projects: Array<{ projectId: string; latestSequence: number }> })
      .projects;
    assert.ok(projects.some((p) => p.projectId === PROJECT && p.latestSequence >= 2));
  });

  it("serves the dashboard page", async () => {
    const res = await fetch(`${base}/edge`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") ?? "", /text\/html/);
  });

  it("keeps non-Edge requests with an Upgrade header on the normal request path", async () => {
    const status = await new Promise<number>((resolve, reject) => {
      const req = httpRequest(
        {
          host: "127.0.0.1",
          port,
          path: "/healthz",
          headers: { connection: "Upgrade, HTTP2-Settings", upgrade: "h2c", "http2-settings": "" },
        },
        (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        },
      );
      req.on("upgrade", () => reject(new Error("unexpected upgrade")));
      req.on("error", reject);
      req.end();
    });
    assert.equal(status, 200);
  });

  it("drops a client-supplied nodeId from agent operations", async () => {
    const res = await fetch(`${base}/v1/edge/projects/${PROJECT}/operations`, {
      method: "POST",
      headers: { "x-agent-capability": await capFor("U1"), "content-type": "application/json" },
      body: JSON.stringify({ operation: { ...createCube, resourceId: "x5", nodeId: "editor-1" } }),
    });
    assert.equal(res.status, 201);
    const committed = ((await res.json()) as { operation: EdgeCommittedOperation }).operation;
    assert.equal(committed.nodeId, undefined);
  });

  it("refuses agent writes to a project no editor has joined", async () => {
    const res = await fetch(`${base}/v1/edge/projects/brand-new-project/operations`, {
      method: "POST",
      headers: { "x-agent-capability": await capFor("U1"), "content-type": "application/json" },
      body: JSON.stringify({ operation: { ...createCube, resourceId: "x6" } }),
    });
    assert.equal(res.status, 404);
    assert.equal(((await res.json()) as { error: string }).error, "unknown_project");
    assert.equal(hub.hasProject("brand-new-project"), false);
  });

  it("refuses portal writes made while impersonating", async () => {
    const path = `/v1/edge/projects/${PROJECT}/operations`;
    const body = JSON.stringify({ operation: { ...createCube, resourceId: "x7" } });
    const portal = await mintPortalIdentity({ p: "alice", imp: "alice", exp: Date.now() + 60_000 }, SECRET);
    const res = await fetch(`${base}${path}`, {
      method: "POST",
      headers: signedRequestHeaders(SECRET, "POST", path, body, {
        "x-portal-identity": portal,
        "content-type": "application/json",
      }),
      body,
    });
    assert.equal(res.status, 403);
  });

  it("reserves core-assigned actor ids on the join-token API and WebSocket", async () => {
    const res = await fetch(`${base}/edge/v1/projects/${PROJECT}/operations`, {
      method: "POST",
      headers: { authorization: `Bearer ${JOIN_TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({
        actor: { id: "qm-agent:U1", displayName: "QM Agent", type: "agent" },
        operation: { ...createCube, resourceId: "x8" },
      }),
    });
    assert.equal(res.status, 403);
    assert.equal(((await res.json()) as { error: string }).error, "actor_mismatch");

    const client = openClient(port);
    await new Promise<void>((resolve, reject) => {
      client.socket.addEventListener("open", () => resolve(), { once: true });
      client.socket.addEventListener("error", () => reject(new Error("websocket failed to open")), { once: true });
    });
    const closed = new Promise<number>((resolve) =>
      client.socket.addEventListener("close", (event) => resolve(event.code), { once: true }),
    );
    client.socket.send(
      JSON.stringify({
        type: "hello",
        protocolVersion: 1,
        actor: { id: "qm-user:alice", displayName: "Alice", type: "human" },
      }),
    );
    const error = await client.next((m) => m.type === "error");
    assert.equal(error.type === "error" ? error.code : null, "actor_mismatch");
    assert.equal(await closed, 1008);
  });
});

describe("QM Edge disabled in QM core", () => {
  let server: Server;
  let base: string;

  before(async () => {
    server = createServer(stubApp, { signingSecret: SECRET });
    base = `http://127.0.0.1:${await listen(server)}`;
  });

  after(() => stop(server));

  it("answers agent API calls with edge_disabled", async () => {
    const res = await fetch(`${base}/v1/edge/projects/${PROJECT}/presence`, {
      headers: { "x-agent-capability": await capFor("U1") },
    });
    assert.equal(res.status, 404);
    const body = (await res.json()) as { error: string; message: string };
    assert.equal(body.error, "edge_disabled");
    assert.match(body.message, /EDGE_ENABLED=1/);
  });

  it("answers the join-token REST API with edge_disabled", async () => {
    const res = await fetch(`${base}/edge/health`);
    assert.equal(res.status, 404);
    assert.equal(((await res.json()) as { error: string }).error, "edge_disabled");
  });
});

describe("QM Edge config inside QM core", () => {
  it("ignores other EDGE_* values while Edge is disabled", () => {
    const edge = loadConfig({ EDGE_HISTORY_LIMIT: "", EDGE_JOIN_TOKEN: "abc", EDGE_PROJECT: "bad id" }).edge;
    assert.equal(edge.enabled, false);
    assert.equal(edge.joinToken, "");
  });

  it("treats a blank history limit as the default when enabled", () => {
    const edge = loadConfig({ EDGE_ENABLED: "1", EDGE_HISTORY_LIMIT: "", EDGE_JOIN_TOKEN: JOIN_TOKEN }).edge;
    assert.equal(edge.enabled, true);
    assert.equal(edge.historyLimit, 2000);
  });
});
