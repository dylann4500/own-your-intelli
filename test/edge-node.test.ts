import { test } from "node:test";
import assert from "node:assert/strict";
import { MemorySceneAdapter, type SceneObject } from "../src/edge/adapters/memory-scene.ts";
import { runCli } from "../src/edge/cli.ts";
import { EdgeNodeSession } from "../src/edge/client.ts";
import { EDGE_TEST_TOKEN, settle, startHub, type RunningHub } from "./support/edge-harness.ts";

function baseline(): SceneObject[] {
  return [
    { id: "cube-1", properties: { name: "Cube", position: [0, 0.5, 0], rotation: [0, 0, 0], scale: [1, 1, 1] } },
    { id: "light-1", properties: { name: "Main Light", "light.intensity": 1, position: [0, 3, 0] } },
  ];
}

async function node(
  running: RunningHub,
  name: string,
): Promise<{ session: EdgeNodeSession; scene: MemorySceneAdapter }> {
  const scene = new MemorySceneAdapter(baseline(), "both");
  const session = new EdgeNodeSession({
    url: running.wsUrl,
    projectId: "unity-demo",
    token: EDGE_TEST_TOKEN,
    actor: { id: name.toLowerCase(), displayName: name, type: "human" },
    node: { id: `${name.toLowerCase()}-mac`, adapter: "unity", deviceName: `${name}'s Mac` },
    adapter: scene,
    reconnectDelaysMs: [50],
  });
  await session.start();
  return { session, scene };
}

test("remote loop prevention: a remote edit observed by the receiving app is never sent back", async () => {
  const running = await startHub();
  try {
    const dylan = await node(running, "Dylan");
    const aiden = await node(running, "Aiden");
    dylan.scene.move("cube-1", [5, 0.5, 0]);
    await settle(150);
    assert.deepEqual(aiden.scene.get("cube-1")?.properties["position"], [5, 0.5, 0]);
    assert.equal(running.hub.latestSequence("unity-demo"), 1, "exactly one operation committed");
    assert.equal(aiden.session.stats.sent, 0, "receiver sent nothing back");
    assert.ok(
      aiden.session.stats.suppressed >= 2,
      "receiver observed the remote change (sync+async) and suppressed it",
    );
    assert.equal(dylan.session.stats.ownEchoes, 1);
    assert.equal(dylan.scene.applied.length, 0, "sender never re-applies its own echo");

    aiden.scene.create("sphere-1", "Sphere", "Sphere", [2, 1, 0]);
    await settle(150);
    assert.ok(dylan.scene.get("sphere-1"));
    dylan.scene.remove("sphere-1");
    await settle(150);
    assert.equal(aiden.scene.get("sphere-1"), undefined);
    assert.equal(running.hub.latestSequence("unity-demo"), 3, "create and delete each committed once, no echoes");
    assert.equal(dylan.session.stats.sent + aiden.session.stats.sent, 3);
    dylan.session.stop();
    aiden.session.stop();
  } finally {
    await running.close();
  }
});

test("four nodes converge on the same scene without feedback loops", async () => {
  const running = await startHub();
  try {
    const nodes = await Promise.all(["Dylan", "Aiden", "Maya", "Sam"].map((n) => node(running, n)));
    const [a, b, c, d] = nodes;
    assert.ok(a && b && c && d);
    a.scene.move("cube-1", [1, 1, 1]);
    b.scene.setProperty("light-1", "intensity", 2.5);
    c.scene.create("sphere-7", "Sphere", "Sphere", [0, 2, 0]);
    await settle(200);
    d.scene.remove("sphere-7");
    await settle(200);
    for (const n of nodes) {
      assert.deepEqual(n.scene.get("cube-1")?.properties["position"], [1, 1, 1]);
      assert.equal(n.scene.get("light-1")?.properties["light.intensity"], 2.5);
      assert.equal(n.scene.get("sphere-7"), undefined);
    }
    assert.equal(running.hub.latestSequence("unity-demo"), 4);
    for (const n of nodes) n.session.stop();
  } finally {
    await running.close();
  }
});

test("concurrent writes to the same property converge to the higher sequence on every node", async () => {
  const running = await startHub();
  try {
    const dylan = await node(running, "Dylan");
    const aiden = await node(running, "Aiden");
    dylan.scene.move("cube-1", [10, 0, 0]);
    aiden.scene.move("cube-1", [-10, 0, 0]);
    await settle(200);
    const winner = running.hub.history("unity-demo").operations.at(-1);
    assert.equal(running.hub.latestSequence("unity-demo"), 2);
    assert.deepEqual(dylan.scene.get("cube-1")?.properties["position"], winner?.payload["position"]);
    assert.deepEqual(aiden.scene.get("cube-1")?.properties["position"], winner?.payload["position"]);
    dylan.session.stop();
    aiden.session.stop();
  } finally {
    await running.close();
  }
});

test("late joiners and reconnecting nodes catch up from the authoritative snapshot", async () => {
  const running = await startHub();
  try {
    const dylan = await node(running, "Dylan");
    const aiden = await node(running, "Aiden");
    dylan.scene.create("capsule-1", "Pillar", "Capsule", [3, 0, 3]);
    dylan.scene.move("cube-1", [4, 0.5, 4]);
    await settle(150);

    aiden.session.dropConnection();
    await settle(20);
    dylan.scene.setProperty("light-1", "intensity", 4);
    dylan.scene.remove("capsule-1");
    await settle(250);
    assert.equal(aiden.session.connected, true, "reconnected automatically");
    assert.equal(aiden.scene.get("light-1")?.properties["light.intensity"], 4);
    assert.equal(aiden.scene.get("capsule-1"), undefined);

    const maya = await node(running, "Maya");
    await settle(100);
    assert.deepEqual(maya.scene.get("cube-1")?.properties["position"], [4, 0.5, 4]);
    assert.equal(maya.scene.get("light-1")?.properties["light.intensity"], 4);
    assert.equal(maya.scene.get("capsule-1"), undefined);
    assert.equal(maya.session.stats.sent, 0, "catch-up does not echo operations back");
    assert.equal(running.hub.latestSequence("unity-demo"), 4);
    for (const n of [dylan, aiden, maya]) n.session.stop();
  } finally {
    await running.close();
  }
});

async function cli(running: RunningHub, args: string[]): Promise<{ code: number; out: string }> {
  const lines: string[] = [];
  const original = console.log;
  console.log = (...values: unknown[]) => lines.push(values.map(String).join(" "));
  try {
    const code = await runCli([...args, "--project", "unity-demo"], {
      QM_EDGE_URL: running.httpBase,
      QM_EDGE_TOKEN: EDGE_TEST_TOKEN,
    });
    return { code, out: lines.join("\n") };
  } finally {
    console.log = original;
  }
}

test("qm-edge CLI: an agent inspects and modifies live state and is attributed as an agent", async () => {
  const running = await startHub();
  try {
    const dylan = await node(running, "Dylan");
    await settle(50);

    const objects = await cli(running, ["objects", "--json"]);
    const listed = JSON.parse(objects.out) as { name: string; type: string }[];
    assert.deepEqual(listed.map((o) => o.name).sort(), ["Cube", "Main Light"]);
    assert.equal(listed.find((o) => o.name === "Main Light")?.type, "Light");

    const created = await cli(running, [
      "create",
      "--primitive",
      "cube",
      "--name",
      "AgentCube",
      "--x",
      "2",
      "--y",
      "1",
      "--z",
      "0",
    ]);
    assert.equal(created.code, 0);
    assert.match(created.out, /committed #1 QM Agent \(agent\) created Cube AgentCube/);
    await cli(running, ["move", "--object", "Cube", "--x", "5"]);
    await cli(running, ["set", "--object", "MainLight", "--property", "intensity", "--value", "2"]);
    await settle(100);

    const agentCube = dylan.scene.findByName("AgentCube");
    assert.deepEqual(agentCube?.properties["position"], [2, 1, 0]);
    assert.equal(agentCube?.properties["primitive"], "Cube");
    assert.deepEqual(dylan.scene.get("cube-1")?.properties["position"], [5, 0.5, 0]);
    assert.equal(dylan.scene.get("light-1")?.properties["light.intensity"], 2);

    await cli(running, ["delete", "--object", "AgentCube"]);
    await settle(100);
    assert.equal(dylan.scene.findByName("AgentCube"), undefined);

    dylan.scene.move("cube-1", [6, 0.5, 0]);
    await settle(100);
    const events = await cli(running, ["events"]);
    assert.match(events.out, /#1\s+QM Agent\s+agent\s+created Cube AgentCube/);
    assert.match(events.out, /#5\s+Dylan\s+human\s+moved Cube/);
    const peers = await cli(running, ["peers"]);
    assert.match(peers.out, /Dylan — human — Unity — Dylan's Mac — online/);
    assert.match(peers.out, /QM Agent — agent — online/);
    assert.equal(dylan.session.stats.sent, 1, "the Unity-side node only sent the human edit");

    const missing = await runCli(["move", "--object", "Nope", "--x", "1"], {
      QM_EDGE_URL: running.httpBase,
      QM_EDGE_TOKEN: EDGE_TEST_TOKEN,
    }).catch((e: unknown) => (e instanceof Error ? e.message : String(e)));
    assert.match(String(missing), /no live object named 'Nope'/);
    dylan.session.stop();
  } finally {
    await running.close();
  }
});
