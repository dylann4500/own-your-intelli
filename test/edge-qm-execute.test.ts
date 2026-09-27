import "./support/auto-fake-sprites.ts";

import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer as createNetServer, type AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import { MemorySceneAdapter } from "../src/edge/adapters/memory-scene.ts";
import { EdgeNodeSession } from "../src/edge/client.ts";
import type { EdgeCommittedOperation } from "../src/edge/protocol.ts";
import { buildApp } from "../src/wiring.ts";
import { testConfig } from "./support/test-config.ts";
import { settle } from "./support/edge-harness.ts";

const SECRET = "edge-execute-test-secret".repeat(2);
const JOIN_TOKEN = "edge-e2e-token";
const CLI = fileURLToPath(new URL("../src/edge/cli.ts", import.meta.url));

async function freePort(): Promise<number> {
  const probe = createNetServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const { port } = probe.address() as AddressInfo;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return port;
}

async function startCoreWorker(port: number): Promise<Worker> {
  const worker = new Worker(new URL("./support/edge-core-worker.ts", import.meta.url), {
    workerData: { port, secret: SECRET, joinToken: JOIN_TOKEN },
  });
  await new Promise<void>((resolve, reject) => {
    worker.once("message", () => resolve());
    worker.once("error", reject);
  });
  return worker;
}

async function events(port: number): Promise<EdgeCommittedOperation[]> {
  const response = await fetch(`http://127.0.0.1:${port}/edge/v1/projects/unity-demo/events`, {
    headers: { authorization: `Bearer ${JOIN_TOKEN}` },
  });
  return ((await response.json()) as { operations: EdgeCommittedOperation[] }).operations;
}

test("a QM agent turn drives Edge through execute, the sandbox capability token and QM core", async () => {
  const port = await freePort();
  const core = await startCoreWorker(port);
  const built = buildApp(
    testConfig({
      signingSecret: SECRET,
      capabilitySecret: SECRET,
      apiBaseUrl: `http://127.0.0.1:${port}`,
    }),
  );
  const scene = new MemorySceneAdapter([
    { id: "cube-1", properties: { name: "Cube", position: [0, 0.5, 0] } },
    { id: "light-1", properties: { name: "Main Light", "light.intensity": 1 } },
  ]);
  const unity = new EdgeNodeSession({
    url: `ws://127.0.0.1:${port}/edge/ws`,
    projectId: "unity-demo",
    token: JOIN_TOKEN,
    actor: { id: "dylan", displayName: "Dylan", type: "human" },
    node: { id: "dylan-mac", adapter: "unity", deviceName: "Dylan's Mac" },
    adapter: scene,
  });
  const agentTurn = (command: string, threadRef: string) =>
    built.app.turn({
      surface: "test",
      actor: { externalId: "U1" },
      conversation: { kind: "dm", threadRef },
      text: `!run node "${CLI}" ${command}`,
    });
  try {
    await unity.start();
    await settle(50);

    const listed = await agentTurn("objects", "edge-e2e-1");
    assert.equal(listed.status, "ok");
    assert.match(listed.reply ?? "", /Main Light/);

    const created = await agentTurn("create --primitive Cube --name AgentCube --x 2 --y 1 --z 0", "edge-e2e-2");
    assert.equal(created.status, "ok");
    assert.match(created.reply ?? "", /committed #1 QM Agent \(agent\) created Cube AgentCube/);
    const moved = await agentTurn("move --object Cube --x 5", "edge-e2e-3");
    assert.match(moved.reply ?? "", /committed #2 QM Agent \(agent\) moved Cube/);
    await settle(150);

    assert.deepEqual(scene.findByName("AgentCube")?.properties["position"], [2, 1, 0]);
    assert.deepEqual(scene.get("cube-1")?.properties["position"], [5, 0.5, 0]);
    for (const op of await events(port)) {
      assert.equal(op.actor.type, "agent");
      assert.equal(op.actor.id, "qm-agent:U1");
    }
    scene.move("cube-1", [6, 0.5, 0]);
    await settle(150);
    assert.deepEqual(
      (await events(port)).map((op) => `${op.actor.type}:${op.action}`),
      ["agent:create_object", "agent:set_transform", "human:set_transform"],
    );
  } finally {
    unity.stop();
    core.postMessage("close");
    await new Promise((resolve) => core.once("message", resolve));
    await core.terminate();
  }
});
