import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EdgeHub } from "../src/edge/hub.ts";
import { createEdgeJournal } from "../src/edge/journal.ts";
import { EdgeProtocolError, parseClientMessage, parseOperation } from "../src/edge/protocol.ts";
import { EDGE_TEST_TOKEN, joinedClient, operation, rawClient, settle, startHub } from "./support/edge-harness.ts";

test("protocol: accepts legal messages", () => {
  const hello = parseClientMessage(
    JSON.stringify({
      type: "hello",
      protocolVersion: 1,
      actor: { id: "dylan", displayName: "Dylan", type: "human" },
      node: { id: "dylan-mac", adapter: "unity", deviceName: "Dylan's Mac" },
    }),
  );
  assert.equal(hello.type, "hello");
  assert.equal(parseClientMessage({ type: "ping", nonce: "n1" }).type, "ping");
  assert.equal(parseClientMessage({ type: "joinProject", projectId: "unity-demo", token: "t" }).type, "joinProject");
  const op = parseOperation(operation("Dylan", { label: "moved Cube" }));
  assert.equal(op.effect, "update");
  assert.deepEqual(op.payload, { position: [1, 2, 3] });
});

test("protocol: rejects malformed operations", () => {
  const bad = [
    operation("Dylan", { id: "not-a-uuid" }),
    operation("Dylan", { effect: "explode" }),
    operation("Dylan", { action: "Set Transform!" }),
    operation("Dylan", { payload: { big: "x".repeat(20_000) } }),
    operation("Dylan", { extra: true }),
    { ...operation("Dylan"), resourceId: undefined },
    "not json",
  ];
  for (const raw of bad) {
    assert.throws(
      () => parseOperation(raw),
      (e: unknown) => e instanceof EdgeProtocolError && e.code === "invalid_operation",
    );
  }
  assert.throws(
    () => parseClientMessage("{not json"),
    (e: unknown) => e instanceof EdgeProtocolError && e.code === "invalid_message",
  );
  assert.throws(
    () => parseClientMessage({ type: "teleport" }),
    (e: unknown) => e instanceof EdgeProtocolError && e.code === "invalid_message",
  );
});

test("protocol: rejects unsupported protocol versions", async () => {
  assert.throws(
    () =>
      parseClientMessage({ type: "hello", protocolVersion: 2, actor: { id: "a", displayName: "A", type: "human" } }),
    (e: unknown) => e instanceof EdgeProtocolError && e.code === "unsupported_protocol_version",
  );
  assert.throws(
    () => parseOperation(operation("Dylan", { protocolVersion: 9 })),
    (e: unknown) => e instanceof EdgeProtocolError && e.code === "unsupported_protocol_version",
  );
  const running = await startHub();
  try {
    const client = await rawClient(running.wsUrl);
    client.send({ type: "hello", protocolVersion: 99, actor: { id: "a", displayName: "A", type: "human" } });
    const error = await client.waitFor("error");
    assert.equal(error.code, "unsupported_protocol_version");
    assert.equal((await client.closed).code, 4400);
  } finally {
    await running.close();
  }
});

test("membership: join requires hello and the join token; presence is broadcast; disconnect goes offline", async () => {
  const running = await startHub();
  try {
    const stranger = await rawClient(running.wsUrl);
    stranger.send({ type: "joinProject", projectId: "unity-demo", token: EDGE_TEST_TOKEN });
    assert.equal((await stranger.waitFor("error")).code, "hello_required");
    stranger.send({ type: "hello", protocolVersion: 1, actor: { id: "x", displayName: "X", type: "human" } });
    stranger.send({ type: "joinProject", projectId: "unity-demo", token: "wrong" });
    assert.equal(
      (await stranger.waitFor("error", (e) => e.requestType === "joinProject" && e.code === "unauthorized")).code,
      "unauthorized",
    );
    stranger.close();

    const dylan = await joinedClient(running.wsUrl, "Dylan");
    const aiden = await joinedClient(running.wsUrl, "Aiden");
    const seen = await dylan.waitFor("presence", (p) => p.members.some((m) => m.displayName === "Aiden"));
    const aidenEntry = seen.members.find((m) => m.displayName === "Aiden");
    assert.equal(aidenEntry?.status, "online");
    assert.equal(aidenEntry?.actorType, "human");
    assert.equal(aidenEntry?.adapter, "unity");
    assert.equal(aidenEntry?.deviceName, "Aiden's Mac");

    aiden.close();
    const after = await dylan.waitFor("presence", (p) =>
      p.members.some((m) => m.displayName === "Aiden" && m.status === "offline"),
    );
    assert.equal(after.members.find((m) => m.displayName === "Dylan")?.status, "online");
    dylan.close();
  } finally {
    await running.close();
  }
});

test("ordering: sequences are monotonic and every client receives the same order", async () => {
  const running = await startHub();
  try {
    const clients = await Promise.all(["Dylan", "Aiden", "Maya"].map((n) => joinedClient(running.wsUrl, n)));
    for (let round = 0; round < 5; round++) {
      for (const [i, client] of clients.entries()) {
        const name = ["Dylan", "Aiden", "Maya"][i] ?? "Dylan";
        client.send({ type: "submitOperation", operation: operation(name, { payload: { position: [round, i, 0] } }) });
      }
    }
    for (const client of clients) await client.waitFor("committedOperation", (m) => m.operation.sequence === 15);
    const orders = clients.map((c) =>
      c.messages.flatMap((m) => (m.type === "committedOperation" ? [`${m.operation.sequence}:${m.operation.id}`] : [])),
    );
    assert.equal(orders[0]?.length, 15);
    assert.deepEqual(orders[1], orders[0]);
    assert.deepEqual(orders[2], orders[0]);
    const sequences = orders[0]?.map((s) => Number(s.split(":")[0]));
    assert.deepEqual(
      sequences,
      Array.from({ length: 15 }, (_, i) => i + 1),
    );
    for (const c of clients) c.close();
  } finally {
    await running.close();
  }
});

test("dedup: a duplicate operation id is committed once and acknowledged as duplicate", async () => {
  const running = await startHub();
  try {
    const dylan = await joinedClient(running.wsUrl, "Dylan");
    const aiden = await joinedClient(running.wsUrl, "Aiden");
    const op = operation("Dylan");
    dylan.send({ type: "submitOperation", operation: op });
    dylan.send({ type: "submitOperation", operation: op });
    const acks = [
      await dylan.waitFor("operationAck", (a) => !a.duplicate),
      await dylan.waitFor("operationAck", (a) => a.duplicate),
    ];
    assert.equal(acks[0].sequence, acks[1].sequence);
    await settle();
    assert.equal(aiden.messages.filter((m) => m.type === "committedOperation").length, 1);
    assert.equal(running.hub.latestSequence("unity-demo"), 1);
    assert.equal(running.hub.history("unity-demo").operations.length, 1);
    dylan.close();
    aiden.close();
  } finally {
    await running.close();
  }
});

test("conflict: two writes to one property resolve to the higher sequence", async () => {
  const running = await startHub();
  try {
    const dylan = await joinedClient(running.wsUrl, "Dylan");
    const aiden = await joinedClient(running.wsUrl, "Aiden");
    dylan.send({
      type: "submitOperation",
      operation: operation("Dylan", { payload: { "light.intensity": 1, name: "Main Light" }, resourceId: "light" }),
    });
    aiden.send({
      type: "submitOperation",
      operation: operation("Aiden", { payload: { "light.intensity": 5 }, resourceId: "light" }),
    });
    await dylan.waitFor("committedOperation", (m) => m.operation.sequence === 2);
    const [light] = running.hub.resources("unity-demo").filter((r) => r.resourceId === "light");
    const winner = running.hub.history("unity-demo").operations.at(-1);
    assert.equal(light?.properties["light.intensity"], winner?.payload["light.intensity"]);
    assert.equal(light?.versions["light.intensity"], 2);
    assert.equal(light?.properties["name"], "Main Light");
    assert.equal(light?.versions["name"], 1);
    dylan.close();
    aiden.close();
  } finally {
    await running.close();
  }
});

test("agent attribution: an agent operation lands in the same stream as human operations", async () => {
  const running = await startHub();
  try {
    const dylan = await joinedClient(running.wsUrl, "Dylan");
    dylan.send({ type: "submitOperation", operation: operation("Dylan", { label: "moved Cube" }) });
    await dylan.waitFor("committedOperation");
    const response = await fetch(`${running.httpBase}/edge/v1/projects/unity-demo/operations`, {
      method: "POST",
      headers: { authorization: `Bearer ${EDGE_TEST_TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({
        actor: { id: "qm-agent", displayName: "QM Agent", type: "agent" },
        operation: {
          adapter: "unity",
          resourceType: "GameObject",
          resourceId: "sphere-1",
          action: "create_object",
          effect: "create",
          payload: { name: "Sphere", primitive: "Sphere", position: [2, 1, 0] },
          label: "created Sphere",
        },
      }),
    });
    assert.equal(response.status, 201);
    const pushed = await dylan.waitFor("committedOperation", (m) => m.operation.actor.type === "agent");
    assert.equal(pushed.operation.sequence, 2);
    assert.equal(pushed.operation.actor.displayName, "QM Agent");
    const events = (await (
      await fetch(`${running.httpBase}/edge/v1/projects/unity-demo/events`, {
        headers: { authorization: `Bearer ${EDGE_TEST_TOKEN}` },
      })
    ).json()) as { operations: { actor: { type: string } }[] };
    assert.deepEqual(
      events.operations.map((o) => o.actor.type),
      ["human", "agent"],
    );
    const presence = running.hub.presence("unity-demo");
    assert.equal(presence.find((m) => m.actorId === "qm-agent")?.status, "online");
    assert.equal(presence.find((m) => m.actorId === "qm-agent")?.actorType, "agent");
    const unauthorized = await fetch(`${running.httpBase}/edge/v1/projects/unity-demo/events`);
    assert.equal(unauthorized.status, 401);
    dylan.close();
  } finally {
    await running.close();
  }
});

test("actors cannot submit operations as someone else", async () => {
  const running = await startHub();
  try {
    const dylan = await joinedClient(running.wsUrl, "Dylan");
    dylan.send({ type: "submitOperation", operation: operation("Aiden") });
    assert.equal((await dylan.waitFor("error")).code, "actor_mismatch");
    dylan.close();
  } finally {
    await running.close();
  }
});

test("history: recent events query supports after/limit and reports truncation", () => {
  const hub = new EdgeHub({ joinToken: EDGE_TEST_TOKEN, historyLimit: 100 });
  const actor = { id: "dylan", displayName: "Dylan", type: "human" as const };
  for (let i = 0; i < 150; i++)
    hub.submit("unity-demo", actor, null, operation("Dylan", { nodeId: undefined, payload: { position: [i, 0, 0] } }));
  const recent = hub.history("unity-demo", { limit: 10 });
  assert.deepEqual(
    recent.operations.map((o) => o.sequence),
    Array.from({ length: 10 }, (_, i) => 141 + i),
  );
  const after = hub.history("unity-demo", { afterSequence: 145 });
  assert.deepEqual(
    after.operations.map((o) => o.sequence),
    [146, 147, 148, 149, 150],
  );
  assert.equal(after.truncated, false);
  assert.equal(hub.history("unity-demo", { afterSequence: 10 }).truncated, true);
  assert.deepEqual(hub.resources("unity-demo")[0]?.properties["position"], [149, 0, 0]);
});

test("reconnection: abrupt disconnects do not crash the hub and catch-up replays missed operations", async () => {
  const running = await startHub();
  try {
    const dylan = await joinedClient(running.wsUrl, "Dylan");
    let aiden = await joinedClient(running.wsUrl, "Aiden");
    dylan.send({ type: "submitOperation", operation: operation("Dylan", { payload: { position: [1, 0, 0] } }) });
    await aiden.waitFor("committedOperation");
    aiden.sendText("\u0000garbage");
    assert.equal((await aiden.waitFor("error")).code, "invalid_message");
    aiden.close();
    await dylan.waitFor("presence", (p) => p.members.some((m) => m.displayName === "Aiden" && m.status === "offline"));

    dylan.send({ type: "submitOperation", operation: operation("Dylan", { payload: { position: [2, 0, 0] } }) });
    dylan.send({
      type: "submitOperation",
      operation: operation("Dylan", {
        resourceId: "sphere-9",
        action: "create_object",
        effect: "create",
        payload: { name: "Sphere", primitive: "Sphere" },
      }),
    });
    await dylan.waitFor("committedOperation", (m) => m.operation.sequence === 3);

    aiden = await joinedClient(running.wsUrl, "Aiden");
    const joined = await aiden.waitFor("joined");
    assert.equal(joined.latestSequence, 3);
    const cube = joined.resources.find((r) => r.resourceId === "cube-1");
    assert.deepEqual(cube?.properties["position"], [2, 0, 0]);
    assert.equal(joined.resources.find((r) => r.resourceId === "sphere-9")?.createdSequence, 3);
    aiden.send({ type: "catchupRequest", projectId: "unity-demo", afterSequence: 1 });
    const replay = await aiden.waitFor("eventHistory");
    assert.deepEqual(
      replay.operations.map((o) => o.sequence),
      [2, 3],
    );
    assert.equal(replay.truncated, false);
    assert.equal(joined.members.find((m) => m.displayName === "Aiden")?.status, "online");
    dylan.close();
    aiden.close();
  } finally {
    await running.close();
  }
});

test("announced baseline resources are discoverable but never outrank committed operations", () => {
  const hub = new EdgeHub({ joinToken: EDGE_TEST_TOKEN });
  hub.announce("unity-demo", "unity", [
    { resourceType: "GameObject", resourceId: "cube-1", properties: { name: "Cube", position: [0, 0, 0] } },
  ]);
  hub.submit(
    "unity-demo",
    { id: "dylan", displayName: "Dylan", type: "human" },
    null,
    operation("Dylan", { nodeId: undefined, payload: { position: [5, 0, 0] } }),
  );
  hub.announce("unity-demo", "unity", [
    { resourceType: "GameObject", resourceId: "cube-1", properties: { name: "Cube", position: [9, 9, 9] } },
  ]);
  const [cube] = hub.resources("unity-demo");
  assert.deepEqual(cube?.properties["position"], [5, 0, 0]);
  assert.equal(cube?.versions["name"], 0);
  assert.equal(cube?.versions["position"], 1);
});

test("rate limiting rejects floods from one connection without committing them", async () => {
  const running = await startHub({ maxOpsPerSecond: 5 });
  try {
    const dylan = await joinedClient(running.wsUrl, "Dylan");
    for (let i = 0; i < 8; i++) dylan.send({ type: "submitOperation", operation: operation("Dylan") });
    await dylan.waitFor("error", (e) => e.code === "rate_limited");
    await settle();
    assert.equal(running.hub.latestSequence("unity-demo"), 5);
    dylan.close();
  } finally {
    await running.close();
  }
});

test("journal restores sequence, history and state after a hub restart", () => {
  const dir = mkdtempSync(join(tmpdir(), "edge-journal-"));
  const journal = createEdgeJournal(dir);
  const first = new EdgeHub({ joinToken: EDGE_TEST_TOKEN, onCommit: (op) => journal.append(op) });
  const actor = { id: "dylan", displayName: "Dylan", type: "human" as const };
  const op = operation("Dylan", { nodeId: undefined, payload: { position: [7, 0, 0] } });
  first.submit("unity-demo", actor, null, op);
  first.submit("unity-demo", actor, null, operation("Dylan", { nodeId: undefined, resourceId: "cube-2" }));
  const second = new EdgeHub({ joinToken: EDGE_TEST_TOKEN });
  second.restore(createEdgeJournal(dir).load());
  assert.equal(second.latestSequence("unity-demo"), 2);
  assert.deepEqual(
    second.resources("unity-demo").find((r) => r.resourceId === "cube-1")?.properties["position"],
    [7, 0, 0],
  );
  assert.equal(second.submit("unity-demo", actor, null, op).duplicate, true);
  assert.equal(
    second.submit("unity-demo", actor, null, operation("Dylan", { nodeId: undefined })).operation.sequence,
    3,
  );
});
