import { randomUUID } from "node:crypto";
import type { EdgeLocalChange } from "../src/edge/adapter.ts";
import { UNITY_ADAPTER, UNITY_GAME_OBJECT, createObjectChange } from "../src/edge/adapters/unity.ts";
import type { EdgeResourceState } from "../src/edge/protocol.ts";

const base = (process.env.QM_EDGE_URL ?? "http://127.0.0.1:8080").replace(/\/+$/, "");
const token = process.env.QM_EDGE_TOKEN ?? process.env.EDGE_JOIN_TOKEN ?? "";
const project = process.env.EDGE_PROJECT ?? "unity-demo";
const actor = { id: "scene-setup", displayName: "Scene setup", type: "system" };
const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };

const seed: EdgeLocalChange[] = [
  createObjectChange({
    resourceId: randomUUID(),
    name: "Ground",
    primitive: "Plane",
    position: [0, 0, 0],
    scale: [2, 1, 2],
  }),
  createObjectChange({ resourceId: randomUUID(), name: "Cube", primitive: "Cube", position: [0, 0.5, 0] }),
  createObjectChange({ resourceId: randomUUID(), name: "Player", primitive: "Capsule", position: [0, 1, -3] }),
  {
    resourceType: UNITY_GAME_OBJECT,
    resourceId: randomUUID(),
    action: "create_object",
    effect: "create",
    payload: {
      name: "Main Light",
      position: [0, 4, 0],
      rotation: [50, -30, 0],
      scale: [1, 1, 1],
      "light.intensity": 1.5,
      "light.color": [1, 0.95, 0.85, 1],
    },
    label: "created Main Light",
  },
];

const listed = await fetch(`${base}/edge/v1/projects/${project}/resources?adapter=${UNITY_ADAPTER}`, { headers });
if (!listed.ok) {
  console.error(`cannot read ${base} (${listed.status}); is the hub running and is QM_EDGE_TOKEN right?`);
  process.exit(1);
}
const existing = new Set(
  ((await listed.json()) as { resources: EdgeResourceState[] }).resources.map((r) => String(r.properties["name"])),
);

for (const change of seed) {
  const name = String(change.payload["name"]);
  if (existing.has(name)) {
    console.log(`= ${name} already in ${project}`);
    continue;
  }
  const response = await fetch(`${base}/edge/v1/projects/${project}/operations`, {
    method: "POST",
    headers,
    body: JSON.stringify({ actor, operation: { adapter: UNITY_ADAPTER, ...change } }),
  });
  const body = (await response.json()) as { operation?: { sequence: number }; message?: string };
  if (!response.ok) {
    console.error(`! ${name}: ${response.status} ${body.message ?? ""}`);
    process.exit(1);
  }
  console.log(`+ #${body.operation?.sequence} created ${name}`);
}
