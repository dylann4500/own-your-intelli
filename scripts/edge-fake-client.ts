import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { createInterface } from "node:readline";
import { parseArgs } from "node:util";
import { MemorySceneAdapter } from "../src/edge/adapters/memory-scene.ts";
import { normalizePrimitive, type Vec3 } from "../src/edge/adapters/unity.ts";
import { EdgeNodeSession } from "../src/edge/client.ts";
import type { EdgeCommittedOperation, EdgeJson, EdgePresenceEntry } from "../src/edge/protocol.ts";

const HELP = `commands:
  scene                          print this node's local scene
  move <object> <x> <y> <z>      move an object (by name)
  drag <object>                  simulate a 2s mouse drag (throttled 15Hz stream)
  intensity <object> <value>     set Light.intensity
  create <Primitive> <name> [x y z]
  delete <object>
  peers | events | help | quit`;

const { values } = parseArgs({
  options: {
    url: { type: "string", default: process.env.QM_EDGE_WS_URL ?? "ws://127.0.0.1:8787/edge/ws" },
    token: { type: "string", default: process.env.QM_EDGE_TOKEN ?? "" },
    project: { type: "string", default: process.env.QM_EDGE_PROJECT ?? "unity-demo" },
    name: { type: "string", default: process.env.USER ?? "Fake Node" },
  },
});

const name = values.name ?? "Fake Node";
const scene = new MemorySceneAdapter(
  [
    {
      id: "baseline-cube",
      properties: { name: "Cube", primitive: "Cube", position: [0, 0.5, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
    },
    {
      id: "baseline-player",
      properties: { name: "Player", primitive: "Capsule", position: [0, 1, -3], rotation: [0, 0, 0], scale: [1, 1, 1] },
    },
    {
      id: "baseline-main-light",
      properties: { name: "Main Light", position: [0, 3, 0], rotation: [50, -30, 0], "light.intensity": 1 },
    },
  ],
  "async",
);

const session = new EdgeNodeSession({
  url: values.url ?? "",
  projectId: values.project ?? "unity-demo",
  token: values.token ?? "",
  actor: { id: `human:${name.toLowerCase().replace(/\s+/g, "-")}`, displayName: name, type: "human" },
  node: { id: `fake:${hostname()}:${name}`.slice(0, 200), adapter: "unity", deviceName: hostname().slice(0, 80) },
  adapter: scene,
});

function fmt(value: EdgeJson | undefined): string {
  if (Array.isArray(value))
    return `(${value.map((v) => (typeof v === "number" ? Number(v.toFixed(2)) : v)).join(", ")})`;
  return value === undefined ? "-" : JSON.stringify(value);
}

function printScene(): void {
  for (const object of scene.objects.values()) {
    const p = object.properties;
    const light = p["light.intensity"] !== undefined ? `  intensity ${fmt(p["light.intensity"])}` : "";
    console.log(`  ${String(p["name"] ?? object.id).padEnd(16)} pos ${fmt(p["position"])}${light}`);
  }
}

function printPeers(members: EdgePresenceEntry[]): void {
  for (const m of members) {
    const where = m.adapter === "unity" ? "Unity" : (m.adapter ?? "");
    console.log(`  ${[m.displayName, m.actorType, where, m.status].filter(Boolean).join(" — ")}`);
  }
}

function describe(op: EdgeCommittedOperation): string {
  return `#${op.sequence} ${op.actor.displayName} (${op.actor.type}) ${op.label ?? op.action} ${fmt(op.payload["position"] ?? op.payload["light.intensity"])}`;
}

function find(objectName: string): string {
  const compact = (value: string): string => value.toLowerCase().replace(/[\s_-]+/g, "");
  const wanted = compact(objectName);
  const objects = [...scene.objects.values()];
  const nameOf = (o: (typeof objects)[number]): string => compact(String(o.properties["name"] ?? ""));
  const exact = objects.filter((o) => o.id === objectName || nameOf(o) === wanted);
  const matches = exact.length ? exact : objects.filter((o) => wanted !== "" && nameOf(o).startsWith(wanted));
  if (matches.length === 1 && matches[0]) return matches[0].id;
  if (matches.length > 1) throw new Error(`'${objectName}' matches several objects; be more specific`);
  throw new Error(`no object '${objectName}' in the local scene`);
}

session.onMessage((message) => {
  if (message.type === "committedOperation" && message.operation.nodeId !== session.options.node.id) {
    console.log(`\n<- ${describe(message.operation)}`);
  }
  if (message.type === "presence") {
    console.log("\npeers:");
    printPeers(message.members);
  }
  if (message.type === "error") console.log(`\n!! ${message.code}: ${message.message}`);
});

async function drag(id: string): Promise<void> {
  const start = scene.get(id)?.properties["position"];
  const [x, y, z] = Array.isArray(start) ? (start as number[]) : [0, 0, 0];
  for (let i = 1; i <= 30; i++) {
    scene.move(id, [
      Number(((x ?? 0) + Math.sin(i / 5) * 2).toFixed(3)),
      y ?? 0,
      Number(((z ?? 0) + i * 0.1).toFixed(3)),
    ]);
    await new Promise((resolve) => setTimeout(resolve, 66));
  }
}

async function handle(line: string): Promise<void> {
  const [command, ...args] = line.trim().split(/\s+/);
  switch (command) {
    case undefined:
    case "":
      return;
    case "help":
      console.log(HELP);
      return;
    case "scene":
      printScene();
      return;
    case "peers":
      printPeers(session.members);
      return;
    case "events":
      for (const op of session.history.slice(-15)) console.log(`  ${describe(op)}`);
      return;
    case "move": {
      const position = args.slice(-3).map(Number);
      const target = args.slice(0, -3).join(" ");
      if (!target || position.length !== 3 || position.some((n) => !Number.isFinite(n)))
        throw new Error("move <object> x y z");
      scene.move(find(target), position as Vec3);
      return;
    }
    case "drag":
      await drag(find(args.join(" ") || "Cube"));
      return;
    case "intensity": {
      const value = Number(args.at(-1));
      const target = args.slice(0, -1).join(" ");
      if (!target || !Number.isFinite(value)) throw new Error("intensity <object> <value>");
      scene.setProperty(find(target), "intensity", value);
      return;
    }
    case "create": {
      const [primitive, objectName, ...coords] = args;
      if (!primitive || !objectName) throw new Error("create <Primitive> <name> [x y z]");
      const position = coords.length === 3 ? (coords.map(Number) as Vec3) : ([0, 1, 0] as Vec3);
      scene.create(randomUUID(), objectName, normalizePrimitive(primitive), position);
      return;
    }
    case "delete":
      scene.remove(find(args.join(" ")));
      return;
    case "quit":
    case "exit":
      session.stop();
      process.exit(0);
      return;
    default:
      throw new Error(`unknown command '${command}'. ${HELP}`);
  }
}

console.log(`QM Edge fake node "${name}" connecting to ${values.url} (project ${values.project})`);
session.start().then(
  () => {
    console.log("CONNECTED. Local scene:");
    printScene();
    console.log(HELP);
    const rl = createInterface({ input: process.stdin, output: process.stdout, prompt: "edge> " });
    rl.prompt();
    rl.on("line", (line) => {
      handle(line)
        .catch((e: unknown) => console.log(`!! ${e instanceof Error ? e.message : String(e)}`))
        .finally(() => rl.prompt());
    });
    rl.on("close", () => {
      session.stop();
      process.exit(0);
    });
  },
  (e: unknown) => {
    console.error(`could not join: ${e instanceof Error ? e.message : String(e)} ${session.lastError ?? ""}`);
    process.exit(1);
  },
);
