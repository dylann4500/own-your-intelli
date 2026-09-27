import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { signedRequestHeaders } from "../src/auth/source-auth-sign.ts";

const core = (process.env.QM_CORE_URL ?? "http://127.0.0.1:8080").replace(/\/+$/, "");
const secretFile = "data/edge-demo-secret";
const secret =
  process.env.CORE_SIGNING_SECRET ?? (existsSync(secretFile) ? readFileSync(secretFile, "utf8").trim() : undefined);
const project = process.env.EDGE_PROJECT ?? "unity-demo";
const user = process.env.QM_DEMO_USER ?? "edge-demo-user";
const thread = `edge-demo-${randomUUID().slice(0, 8)}`;
const preamble =
  `You are working in the live QM Edge project "${project}". Connected Unity Editors on several machines share its ` +
  "scene in realtime. Use the `qm-edge` CLI in your sandbox via execute: run `qm-edge objects` to see the scene, then " +
  "`qm-edge create|move|rotate|scale|set|delete ...` (see `qm-edge help`). Every command you run is broadcast to every " +
  "connected editor and attributed to you as an agent. Keep replies short. I explicitly skip onboarding and setup for " +
  "now: record it as dismissed and go straight to the request.\n\nRequest: ";

if (!secret) {
  console.error("Start QM core with `npm run edge:qm` first, or set CORE_SIGNING_SECRET to the value core uses.");
  process.exit(1);
}

let first = true;

async function turn(text: string): Promise<string> {
  const path = `/v1/turns?_sourceAuthNonce=${randomUUID()}`;
  const body = JSON.stringify({
    surface: "edge-demo",
    actor: { externalId: user },
    conversation: { kind: "dm", threadRef: thread },
    text: first && !text.startsWith("!") ? preamble + text : text,
  });
  if (!text.startsWith("!")) first = false;
  const response = await fetch(`${core}${path}`, {
    method: "POST",
    headers: signedRequestHeaders(secret, "POST", path, body, { "content-type": "application/json" }),
    body,
  });
  const json = (await response.json()) as { reply?: string; status?: string; error?: string; message?: string };
  if (!response.ok) return `[${response.status}] ${json.error ?? ""} ${json.message ?? ""}`;
  return json.reply ?? `[${json.status ?? "no reply"}]`;
}

console.log(`QM agent console -> ${core} (project ${project}). Try: Create three cubes around the player.`);
const rl = createInterface({ input: process.stdin, output: process.stdout, prompt: "you> " });
rl.prompt();
rl.on("line", (line) => {
  if (!line.trim()) {
    rl.prompt();
    return;
  }
  rl.pause();
  turn(line.trim())
    .then((reply) => console.log(`\nQM Agent> ${reply}\n`))
    .catch((e: unknown) => console.log(`!! ${e instanceof Error ? e.message : String(e)}`))
    .finally(() => {
      rl.resume();
      rl.prompt();
    });
});
