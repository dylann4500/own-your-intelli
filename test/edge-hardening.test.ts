import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemorySceneAdapter, type ObserverTiming } from "../src/edge/adapters/memory-scene.ts";
import { EdgeNodeSession } from "../src/edge/client.ts";
import { EdgeHub } from "../src/edge/hub.ts";
import { createEdgeJournal } from "../src/edge/journal.ts";
import { EdgeProtocolError, parseOperation } from "../src/edge/protocol.ts";
import {
  EDGE_TEST_TOKEN,
  joinedClient,
  operation,
  rawClient,
  settle,
  startHub,
  type RunningHub,
} from "./support/edge-harness.ts";

const liveSessions: EdgeNodeSession[] = [];
afterEach(() => {
  for (const session of liveSessions.splice(0)) session.stop();
});

async function node(running: RunningHub, name: string, timing: ObserverTiming = "both") {
  const scene = new MemorySceneAdapter([{ id: "cube-1", properties: { name: "Cube", position: [0, 0, 0] } }], timing);
  const session = new EdgeNodeSession({
    url: running.wsUrl,
    projectId: "unity-demo",
    token: EDGE_TEST_TOKEN,
    actor: { id: name.toLowerCase(), displayName: name, type: "human" },
    node: { id: `${name.toLowerCase()}-mac`, adapter: "unity" },
    adapter: scene,
    reconnectDelaysMs: [50],
  });
  liveSessions.push(session);
  await session.start();
  return { session, scene };
}

const position = (n: { scene: MemorySceneAdapter }) => n.scene.get("cube-1")?.properties["position"];

test("leaveProject from an unjoined socket does not broadcast presence", async () => {
  const running = await startHub();
  try {
    const dylan = await joinedClient(running.wsUrl, "Dylan");
    const before = dylan.messages.filter((m) => m.type === "presence").length;
    const stranger = await rawClient(running.wsUrl);
    for (let i = 0; i < 50; i++) stranger.send({ type: "leaveProject", projectId: "unity-demo" });
    await stranger.waitFor("left");
    await settle(50);
    assert.equal(dylan.messages.filter((m) => m.type === "presence").length, before);
    dylan.close();
    stranger.close();
  } finally {
    await running.close();
  }
});

test("an invalid join token closes the socket", async () => {
  const running = await startHub();
  try {
    const client = await rawClient(running.wsUrl);
    client.send({ type: "hello", protocolVersion: 1, actor: { id: "x", displayName: "X", type: "human" } });
    client.send({ type: "joinProject", projectId: "unity-demo", token: "guess" });
    assert.equal((await client.closed).code, 4401);
  } finally {
    await running.close();
  }
});

test("payloads nested deeper than 16 levels are rejected before they reach any editor", () => {
  let deep: unknown = 1;
  for (let i = 0; i < 300; i++) deep = [deep];
  assert.throws(
    () => parseOperation(operation("Dylan", { payload: { d: deep } })),
    (e: unknown) => e instanceof EdgeProtocolError && e.code === "invalid_operation",
  );
});

test("connectionless callers cannot claim another node's id", async () => {
  const running = await startHub();
  try {
    const response = await fetch(`${running.httpBase}/edge/v1/projects/unity-demo/operations`, {
      method: "POST",
      headers: { authorization: `Bearer ${EDGE_TEST_TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({
        actor: { id: "qm-agent-direct", displayName: "QM Agent", type: "agent" },
        operation: {
          adapter: "unity",
          resourceType: "GameObject",
          resourceId: "cube-1",
          action: "set_transform",
          effect: "update",
          payload: { position: [3, 3, 3] },
          nodeId: "dylan-mac",
        },
      }),
    });
    assert.equal(response.status, 403);
    assert.equal(running.hub.latestSequence("unity-demo"), 0);
  } finally {
    await running.close();
  }
});

test("edits made while offline or during a drop are delivered after reconnect and every node converges", async () => {
  const running = await startHub();
  try {
    const a = await node(running, "Dylan");
    const b = await node(running, "Aiden");
    a.session.dropConnection();
    a.scene.move("cube-1", [7, 7, 7]);
    await settle(10);
    b.scene.move("cube-1", [2, 2, 2]);
    a.scene.move("cube-1", [1, 1, 1]);
    await settle(400);
    assert.equal(a.session.connected, true);
    const hub = running.hub.resources("unity-demo").find((r) => r.resourceId === "cube-1")?.properties["position"];
    assert.deepEqual(hub, [1, 1, 1]);
    assert.deepEqual(position(a), hub);
    assert.deepEqual(position(b), hub);
    a.session.stop();
    b.session.stop();
  } finally {
    await running.close();
  }
});

test("rate-limited operations are retried instead of leaving the sender diverged", async () => {
  const running = await startHub({ maxOpsPerSecond: 1 });
  try {
    const a = await node(running, "Dylan");
    const b = await node(running, "Aiden");
    a.scene.move("cube-1", [1, 1, 1]);
    a.scene.move("cube-1", [9, 9, 9]);
    await settle(1600);
    assert.deepEqual(position(b), [9, 9, 9]);
    assert.deepEqual(position(a), [9, 9, 9]);
    a.session.stop();
    b.session.stop();
  } finally {
    await running.close();
  }
});

test("nodes keep syncing after the hub restarts without a journal", async () => {
  const first = await startHub();
  const port = Number(new URL(first.httpBase).port);
  const a = await node(first, "Dylan");
  for (const x of [1, 2, 3, 4]) a.scene.move("cube-1", [x, 0, 0]);
  await settle(100);
  await first.close();
  const second = await startHub({}, port);
  try {
    await settle(300);
    const b = await node(second, "Aiden");
    b.scene.move("cube-1", [42, 0, 0]);
    await settle(200);
    assert.deepEqual(position(a), [42, 0, 0]);
    b.session.stop();
  } finally {
    a.session.stop();
    await second.close();
  }
});

test("asynchronous observers do not start an echo storm when remote ops land in one tick", async () => {
  const running = await startHub();
  try {
    const a = await node(running, "Dylan", "async");
    const b = await node(running, "Aiden", "async");
    b.scene.move("cube-1", [1, 0, 0]);
    b.scene.move("cube-1", [2, 0, 0]);
    await settle(500);
    assert.ok(running.hub.latestSequence("unity-demo") <= 3, `committed ${running.hub.latestSequence("unity-demo")}`);
    assert.deepEqual(position(a), [2, 0, 0]);
    assert.equal(a.session.stats.sent, 0);
    a.session.stop();
    b.session.stop();
  } finally {
    await running.close();
  }
});

test("a torn journal line is skipped and later appends stay readable", () => {
  const dir = mkdtempSync(join(tmpdir(), "edge-torn-"));
  const actor = { id: "dylan", displayName: "Dylan", type: "human" as const };
  const journal = createEdgeJournal(dir);
  const hub = new EdgeHub({ joinToken: EDGE_TEST_TOKEN, onCommit: (op) => journal.append(op) });
  hub.submit("unity-demo", actor, null, operation("Dylan", { nodeId: undefined }));
  appendFileSync(join(dir, "unity-demo.jsonl"), '{"torn":');
  const reopened = createEdgeJournal(dir);
  const second = new EdgeHub({ joinToken: EDGE_TEST_TOKEN, onCommit: (op) => reopened.append(op) });
  second.restore(reopened.load());
  second.submit("unity-demo", actor, null, operation("Dylan", { nodeId: undefined }));
  const third = new EdgeHub({ joinToken: EDGE_TEST_TOKEN });
  third.restore(createEdgeJournal(dir).load());
  assert.equal(third.latestSequence("unity-demo"), 2);
  assert.equal(readFileSync(join(dir, "unity-demo.jsonl"), "utf8").split("\n").filter(Boolean).length, 3);
});

test("re-creating a deleted resource starts from a clean property set", () => {
  const hub = new EdgeHub({ joinToken: EDGE_TEST_TOKEN });
  const actor = { id: "dylan", displayName: "Dylan", type: "human" as const };
  const create = (payload: Record<string, unknown>) =>
    hub.submit(
      "unity-demo",
      actor,
      null,
      operation("Dylan", { nodeId: undefined, action: "create_object", effect: "create", payload }),
    );
  create({ name: "Ball", "light.intensity": 3 });
  hub.submit(
    "unity-demo",
    actor,
    null,
    operation("Dylan", { nodeId: undefined, action: "delete_object", effect: "delete", payload: {} }),
  );
  create({ name: "Ball" });
  const [ball] = hub.resources("unity-demo");
  assert.deepEqual(ball?.properties, { name: "Ball" });
});
