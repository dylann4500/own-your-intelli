#!/usr/bin/env -S node --
import { randomUUID } from "node:crypto";
import { parseArgs } from "node:util";
import type { EdgeLocalChange } from "./adapter.ts";
import {
  UNITY_ADAPTER,
  createObjectChange,
  deleteObjectChange,
  propertyChange,
  summarizeUnityResource,
  transformChange,
  type UnityObjectSummary,
  type Vec3,
} from "./adapters/unity.ts";
import type { EdgeCommittedOperation, EdgeEffect, EdgeJson, EdgePresenceEntry, EdgeResourceState } from "./protocol.ts";

const USAGE = `qm-edge — act on a live QM Edge project as an agent

Usage: qm-edge <command> [options]

Read:
  status                         project summary, sequence, who is online
  peers                          presence: humans, agents, nodes
  events [--limit 20] [--raw]    recent semantic operations (coalesced unless --raw)
  objects [--all]                live resources an agent can act on (Unity GameObjects)

Write (each becomes one ordered Edge operation attributed to you):
  create --primitive Cube --name AgentCube --x 2 --y 1 --z 0
  move   --object Cube --x 5 [--y 0] [--z 2]        omitted axes keep their value
  rotate --object Cube --x 0 --y 45 --z 0
  scale  --object Cube --x 2 --y 2 --z 2
  set    --object "Main Light" --property intensity --value 2
  set    --object "Main Light" --property color --value "1,0.5,0.5"
  delete --object AgentCube
  op --resource-type T --resource-id ID --action A --effect create|update|delete|none --payload '{"k":1}' [--adapter unity]

Options:
  --project <id>   Edge project (default $QM_EDGE_PROJECT or unity-demo)
  --json           machine-readable output

Connection (first match wins):
  QM_EDGE_URL + QM_EDGE_TOKEN        talk to an Edge hub directly with its join token
  AGENT_API_URL + AGENT_API_TOKEN    inside a QM sandbox: go through QM core (/v1/edge)
  default                            http://127.0.0.1:8787 with QM_EDGE_TOKEN`;

class UsageError extends Error {}

interface Endpoint {
  base: string;
  headers: Record<string, string>;
  mode: "hub" | "qm-core";
  actor: { id: string; displayName: string; type: "human" | "agent" | "system" } | null;
}

type Env = Record<string, string | undefined>;

function endpointFrom(env: Env): Endpoint {
  const actorType = env.QM_EDGE_ACTOR_TYPE;
  const actor: NonNullable<Endpoint["actor"]> = {
    id: env.QM_EDGE_ACTOR_ID || "qm-agent",
    displayName: env.QM_EDGE_ACTOR_NAME || "QM Agent",
    type: actorType === "human" || actorType === "system" ? actorType : "agent",
  };
  if (env.QM_EDGE_URL) {
    return {
      base: `${env.QM_EDGE_URL.replace(/\/+$/, "")}/edge/v1`,
      headers: { authorization: `Bearer ${env.QM_EDGE_TOKEN ?? ""}` },
      mode: "hub",
      actor,
    };
  }
  if (env.AGENT_API_URL && env.AGENT_API_TOKEN) {
    return {
      base: `${env.AGENT_API_URL.replace(/\/+$/, "")}/v1/edge`,
      headers: { "x-agent-capability": env.AGENT_API_TOKEN },
      mode: "qm-core",
      actor: null,
    };
  }
  return {
    base: "http://127.0.0.1:8787/edge/v1",
    headers: { authorization: `Bearer ${env.QM_EDGE_TOKEN ?? ""}` },
    mode: "hub",
    actor,
  };
}

async function call(endpoint: Endpoint, method: "GET" | "POST", path: string, body?: unknown): Promise<unknown> {
  const url = `${endpoint.base}/${path}`;
  let response: Response;
  try {
    response = await fetch(url, {
      method,
      headers: { ...endpoint.headers, ...(body !== undefined ? { "content-type": "application/json" } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(10_000),
    });
  } catch (e) {
    throw new Error(`cannot reach QM Edge at ${endpoint.base} (${e instanceof Error ? e.message : String(e)})`, {
      cause: e,
    });
  }
  const text = await response.text();
  let parsed: unknown;
  try {
    parsed = text ? JSON.parse(text) : {};
  } catch {
    parsed = { message: text };
  }
  if (!response.ok) {
    const detail = parsed as { error?: string; message?: string };
    throw new Error(`${response.status} ${detail.error ?? "error"}: ${detail.message ?? text}`);
  }
  return parsed;
}

function num(values: Record<string, string | boolean | undefined>, key: string): number | undefined {
  const raw = values[key];
  if (raw === undefined || typeof raw === "boolean") return undefined;
  const value = Number(raw);
  if (!Number.isFinite(value)) throw new UsageError(`--${key} must be a number`);
  return value;
}

function str(values: Record<string, string | boolean | undefined>, key: string, required = false): string | undefined {
  const raw = values[key];
  if (typeof raw === "string" && raw.trim() !== "") return raw.trim();
  if (required) throw new UsageError(`--${key} is required`);
  return undefined;
}

function vec(values: Record<string, string | boolean | undefined>, base: Vec3): Vec3 {
  return [num(values, "x") ?? base[0], num(values, "y") ?? base[1], num(values, "z") ?? base[2]];
}

function asVec3(value: EdgeJson | undefined, fallback: Vec3): Vec3 {
  if (Array.isArray(value) && value.length >= 3 && value.slice(0, 3).every((v) => typeof v === "number")) {
    return [value[0] as number, value[1] as number, value[2] as number];
  }
  return fallback;
}

function parseValue(property: string, raw: string): EdgeJson {
  const trimmed = raw.trim();
  if (property === "color" || property === "light.color") {
    const hex = /^#?([0-9a-f]{6})$/i.exec(trimmed);
    if (hex?.[1]) {
      const n = Number.parseInt(hex[1], 16);
      return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255, 1];
    }
    const parts = trimmed
      .replace(/^\[|\]$/g, "")
      .split(/[\s,]+/)
      .filter(Boolean)
      .map(Number);
    if ((parts.length === 3 || parts.length === 4) && parts.every(Number.isFinite)) {
      return parts.length === 3 ? [...parts, 1] : parts;
    }
    throw new UsageError("color must be r,g,b[,a] in 0..1 or #rrggbb");
  }
  if (property === "name") return raw;
  try {
    return JSON.parse(trimmed) as EdgeJson;
  } catch {
    return raw;
  }
}

function compactName(name: string): string {
  return name.replace(/[\s_-]+/g, "").toLowerCase();
}

async function resolveObject(endpoint: Endpoint, project: string, ref: string): Promise<UnityObjectSummary> {
  const objects = await listObjects(endpoint, project, false);
  const exact = objects.filter((o) => o.id === ref || o.name === ref);
  const loose = exact.length ? exact : objects.filter((o) => compactName(o.name) === compactName(ref));
  if (loose.length === 1 && loose[0]) return loose[0];
  if (loose.length > 1) {
    throw new Error(`'${ref}' is ambiguous: ${loose.map((o) => `${o.name} (${o.id})`).join(", ")}; pass --object <id>`);
  }
  const names = objects.map((o) => o.name).slice(0, 30);
  throw new Error(
    `no live object named '${ref}' in ${project}. Known: ${names.length ? names.join(", ") : "(none yet)"}`,
  );
}

async function listObjects(endpoint: Endpoint, project: string, all: boolean): Promise<UnityObjectSummary[]> {
  const body = (await call(
    endpoint,
    "GET",
    `projects/${encodeURIComponent(project)}/resources?adapter=${UNITY_ADAPTER}${all ? "&includeDeleted=1" : ""}`,
  )) as { resources: EdgeResourceState[] };
  return body.resources.map(summarizeUnityResource);
}

async function submit(
  endpoint: Endpoint,
  project: string,
  change: EdgeLocalChange,
  adapter = UNITY_ADAPTER,
): Promise<{ operation: EdgeCommittedOperation; duplicate: boolean }> {
  return (await call(endpoint, "POST", `projects/${encodeURIComponent(project)}/operations`, {
    ...(endpoint.actor ? { actor: endpoint.actor } : {}),
    operation: {
      id: randomUUID(),
      adapter,
      resourceType: change.resourceType,
      resourceId: change.resourceId,
      action: change.action,
      effect: change.effect,
      payload: change.payload,
      ...(change.label ? { label: change.label } : {}),
      clientTimestamp: Date.now(),
    },
  })) as { operation: EdgeCommittedOperation; duplicate: boolean };
}

async function heartbeat(
  endpoint: Endpoint,
  project: string,
  workingOn?: { resourceId: string; label: string },
): Promise<void> {
  try {
    await call(endpoint, "POST", `projects/${encodeURIComponent(project)}/presence`, {
      ...(endpoint.actor ? { actor: endpoint.actor } : {}),
      ...(workingOn ? { workingOn: { resourceType: "GameObject", ...workingOn } } : {}),
    });
  } catch {
    return;
  }
}

function adapterLabel(adapter: string | null): string {
  if (!adapter) return "";
  return adapter === "unity" ? "Unity" : adapter;
}

function presenceLine(m: EdgePresenceEntry): string {
  const parts = [m.displayName, m.actorType];
  if (m.adapter) parts.push(adapterLabel(m.adapter));
  if (m.deviceName) parts.push(m.deviceName);
  parts.push(m.status);
  const working = m.workingOn?.label ?? m.workingOn?.resourceId;
  return `${parts.join(" — ")}${working && m.status === "online" ? ` — working on ${working}` : ""}`;
}

function describeOperation(op: EdgeCommittedOperation): string {
  const label =
    op.label ?? `${op.action} ${typeof op.payload["name"] === "string" ? op.payload["name"] : op.resourceId}`;
  return label;
}

function coalesce(operations: EdgeCommittedOperation[]): { op: EdgeCommittedOperation; count: number }[] {
  const out: { op: EdgeCommittedOperation; count: number }[] = [];
  for (const op of operations) {
    const last = out.at(-1);
    if (
      last &&
      last.op.actorId === op.actorId &&
      last.op.resourceId === op.resourceId &&
      last.op.action === op.action
    ) {
      last.op = op;
      last.count++;
      continue;
    }
    out.push({ op, count: 1 });
  }
  return out;
}

function fmtVec(value: EdgeJson | undefined): string {
  if (!Array.isArray(value)) return "-";
  return `(${value.map((v) => (typeof v === "number" ? Number(v.toFixed(2)) : String(v))).join(", ")})`;
}

function print(json: boolean, value: unknown, text: () => string): void {
  console.log(json ? JSON.stringify(value, null, 2) : text());
}

function committedLine(result: { operation: EdgeCommittedOperation; duplicate: boolean }): string {
  const op = result.operation;
  return `${result.duplicate ? "duplicate (already committed)" : "committed"} #${op.sequence} ${op.actor.displayName} (${op.actor.type}) ${describeOperation(op)} [${op.resourceId}]`;
}

export async function runCli(argv: string[], env: Env): Promise<number> {
  const [command, ...rest] = argv;
  if (!command || command === "help" || command === "--help" || command === "-h") {
    console.log(USAGE);
    return command ? 0 : 2;
  }
  const { values } = parseArgs({
    args: rest,
    allowPositionals: false,
    strict: true,
    options: {
      project: { type: "string" },
      json: { type: "boolean" },
      raw: { type: "boolean" },
      all: { type: "boolean" },
      limit: { type: "string" },
      primitive: { type: "string" },
      name: { type: "string" },
      id: { type: "string" },
      object: { type: "string" },
      property: { type: "string" },
      value: { type: "string" },
      x: { type: "string" },
      y: { type: "string" },
      z: { type: "string" },
      adapter: { type: "string" },
      "resource-type": { type: "string" },
      "resource-id": { type: "string" },
      action: { type: "string" },
      effect: { type: "string" },
      payload: { type: "string" },
      label: { type: "string" },
    },
  });
  const endpoint = endpointFrom(env);
  const project = str(values, "project") ?? env.QM_EDGE_PROJECT ?? "unity-demo";
  const json = values.json === true;
  const projectPath = `projects/${encodeURIComponent(project)}`;

  switch (command) {
    case "status": {
      await heartbeat(endpoint, project);
      const body = (await call(endpoint, "GET", projectPath)) as {
        latestSequence: number;
        members: EdgePresenceEntry[];
        resourceCount: number;
        exists: boolean;
      };
      print(json, { ...body, endpoint: endpoint.base, mode: endpoint.mode }, () =>
        [
          `QM Edge project ${project} via ${endpoint.mode === "qm-core" ? "QM core" : "hub"} ${endpoint.base}`,
          `sequence: ${body.latestSequence}   live resources: ${body.resourceCount}`,
          `online: ${
            body.members
              .filter((m) => m.status === "online")
              .map((m) => `${m.displayName} (${m.actorType})`)
              .join(", ") || "nobody"
          }`,
        ].join("\n"),
      );
      return 0;
    }
    case "peers": {
      await heartbeat(endpoint, project);
      const body = (await call(endpoint, "GET", `${projectPath}/presence`)) as { members: EdgePresenceEntry[] };
      print(json, body.members, () => body.members.map(presenceLine).join("\n") || "(no peers)");
      return 0;
    }
    case "events": {
      const limit = num(values, "limit") ?? 20;
      const body = (await call(
        endpoint,
        "GET",
        `${projectPath}/events?limit=${Math.max(1, Math.min(limit * 20, 2000))}`,
      )) as {
        operations: EdgeCommittedOperation[];
      };
      const rows = values.raw ? body.operations.map((op) => ({ op, count: 1 })) : coalesce(body.operations);
      const shown = rows.slice(-limit);
      print(json, shown, () =>
        shown.length
          ? shown
              .map(
                ({ op, count }) =>
                  `#${op.sequence}  ${op.actor.displayName.padEnd(12)} ${op.actor.type.padEnd(6)} ${describeOperation(op)}${count > 1 ? `  (x${count})` : ""}`,
              )
              .join("\n")
          : "(no events yet)",
      );
      return 0;
    }
    case "objects": {
      await heartbeat(endpoint, project);
      const objects = await listObjects(endpoint, project, values.all === true);
      print(json, objects, () =>
        objects.length
          ? objects
              .map((o) =>
                [
                  o.name.padEnd(18),
                  o.type.padEnd(10),
                  `pos ${fmtVec(o.position)}`,
                  o.light?.intensity !== undefined ? `intensity ${String(o.light.intensity)}` : "",
                  `id ${o.id}`,
                ]
                  .filter(Boolean)
                  .join("  "),
              )
              .join("\n")
          : "(no resources announced yet — is a Unity node connected?)",
      );
      return 0;
    }
    case "create": {
      const name = str(values, "name") ?? `Agent${str(values, "primitive", true) ?? "Object"}`;
      const change = createObjectChange({
        resourceId: str(values, "id") ?? randomUUID(),
        name,
        primitive: str(values, "primitive", true) ?? "Cube",
        position: vec(values, [0, 0, 0]),
      });
      const result = await submit(endpoint, project, change);
      print(json, result, () => committedLine(result));
      return 0;
    }
    case "move":
    case "rotate":
    case "scale": {
      const target = await resolveObject(endpoint, project, str(values, "object", true) ?? "");
      const property = ({ move: "position", rotate: "rotation", scale: "scale" } as const)[command];
      const current = asVec3(target[property], property === "scale" ? [1, 1, 1] : [0, 0, 0]);
      const next = vec(values, current);
      const result = await submit(endpoint, project, transformChange(target.id, target.name, { [property]: next }));
      print(json, result, () => committedLine(result));
      return 0;
    }
    case "set": {
      const target = await resolveObject(endpoint, project, str(values, "object", true) ?? "");
      const property = str(values, "property", true) ?? "";
      const raw = values.value;
      if (typeof raw !== "string") throw new UsageError("--value is required");
      const result = await submit(
        endpoint,
        project,
        propertyChange(target.id, target.name, property, parseValue(property, raw)),
      );
      print(json, result, () => committedLine(result));
      return 0;
    }
    case "delete": {
      const target = await resolveObject(endpoint, project, str(values, "object", true) ?? "");
      const result = await submit(endpoint, project, deleteObjectChange(target.id, target.name));
      print(json, result, () => committedLine(result));
      return 0;
    }
    case "op": {
      const effect = str(values, "effect", true) as EdgeEffect;
      let payload: Record<string, EdgeJson> = {};
      const rawPayload = str(values, "payload");
      if (rawPayload) {
        try {
          payload = JSON.parse(rawPayload) as Record<string, EdgeJson>;
        } catch {
          throw new UsageError("--payload must be a JSON object");
        }
      }
      const label = str(values, "label");
      const result = await submit(
        endpoint,
        project,
        {
          resourceType: str(values, "resource-type", true) ?? "",
          resourceId: str(values, "resource-id", true) ?? "",
          action: str(values, "action", true) ?? "",
          effect,
          payload,
          ...(label ? { label } : {}),
        },
        str(values, "adapter") ?? UNITY_ADAPTER,
      );
      print(json, result, () => committedLine(result));
      return 0;
    }
    default:
      throw new UsageError(`unknown command '${command}'`);
  }
}

if (import.meta.main) {
  runCli(process.argv.slice(2), process.env).then(
    (code) => {
      process.exitCode = code;
    },
    (e: unknown) => {
      if (
        e instanceof UsageError ||
        (e instanceof TypeError && "code" in e && String(e.code).startsWith("ERR_PARSE_ARGS"))
      ) {
        console.error(`qm-edge: ${e.message}\n\nRun 'qm-edge help' for usage.`);
        process.exitCode = 2;
        return;
      }
      console.error(`qm-edge: ${e instanceof Error ? e.message : String(e)}`);
      process.exitCode = 1;
    },
  );
}
