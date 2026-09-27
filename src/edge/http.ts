import { randomUUID } from "node:crypto";
import {
  EDGE_PROTOCOL_VERSION,
  EdgeProtocolError,
  edgeActor,
  edgeProjectId,
  formatIssues,
  type EdgeActor,
  type EdgeErrorCode,
  type EdgeWorkingOn,
} from "./protocol.ts";
import type { EdgeHub } from "./hub.ts";

export interface EdgeApiRequest {
  method: string;
  path: string;
  query: URLSearchParams;
  body: unknown;
  actor: EdgeActor | null;
}

export interface EdgeApiResponse {
  status: number;
  body: unknown;
}

const STATUS_BY_CODE: Record<EdgeErrorCode, number> = {
  invalid_message: 400,
  invalid_operation: 400,
  unsupported_protocol_version: 400,
  hello_required: 400,
  unauthorized: 401,
  actor_mismatch: 403,
  not_joined: 409,
  unknown_project: 404,
  rate_limited: 429,
};

const RESERVED_ACTOR_PREFIXES = ["qm-agent:", "qm-user:"];

export function isReservedActorId(id: string): boolean {
  return RESERVED_ACTOR_PREFIXES.some((prefix) => id.startsWith(prefix));
}

function fail(status: number, error: string, message: string): EdgeApiResponse {
  return { status, body: { error, message } };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function intParam(query: URLSearchParams, name: string): number | undefined {
  const raw = query.get(name);
  if (raw === null || raw === "") return undefined;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0)
    throw new EdgeProtocolError("invalid_message", `${name} must be a non-negative integer`);
  return value;
}

function resolveActor(req: EdgeApiRequest): EdgeActor {
  if (req.actor) return req.actor;
  const raw = isRecord(req.body) ? req.body.actor : undefined;
  const parsed = edgeActor.safeParse(raw);
  if (!parsed.success) throw new EdgeProtocolError("invalid_message", `actor: ${formatIssues(parsed.error)}`);
  if (isReservedActorId(parsed.data.id))
    throw new EdgeProtocolError(
      "actor_mismatch",
      `actor id ${parsed.data.id} is reserved for identities QM core assigns`,
    );
  return parsed.data;
}

function workingOnFrom(body: unknown): EdgeWorkingOn {
  if (!isRecord(body) || !isRecord(body.workingOn)) return null;
  const { resourceType, resourceId, label } = body.workingOn;
  return {
    ...(typeof resourceType === "string" ? { resourceType: resourceType.slice(0, 64) } : {}),
    ...(typeof resourceId === "string" ? { resourceId: resourceId.slice(0, 256) } : {}),
    ...(typeof label === "string" ? { label: label.slice(0, 120) } : {}),
  };
}

export function handleEdgeApi(hub: EdgeHub, req: EdgeApiRequest): EdgeApiResponse {
  try {
    return route(hub, req);
  } catch (e) {
    if (e instanceof EdgeProtocolError) return fail(STATUS_BY_CODE[e.code], e.code, e.message);
    throw e;
  }
}

function route(hub: EdgeHub, req: EdgeApiRequest): EdgeApiResponse {
  const segments = req.path.split("/").filter(Boolean);
  if (segments[0] !== "projects") return fail(404, "not_found", `no edge route ${req.method} ${req.path}`);
  if (segments.length === 1) {
    if (req.method !== "GET") return fail(405, "method_not_allowed", "use GET");
    return {
      status: 200,
      body: {
        projects: hub.projectIds().map((projectId) => ({
          projectId,
          latestSequence: hub.latestSequence(projectId),
          online: hub.presence(projectId).filter((m) => m.status === "online").length,
        })),
      },
    };
  }
  const projectId = segments[1] ?? "";
  if (!edgeProjectId.safeParse(projectId).success) return fail(400, "invalid_message", "invalid project id");
  const resource = segments.slice(2).join("/");
  const exists = hub.hasProject(projectId);
  const latestSequence = hub.latestSequence(projectId);

  if (req.method === "GET" && resource === "") {
    return {
      status: 200,
      body: {
        projectId,
        exists,
        latestSequence,
        members: hub.presence(projectId),
        resourceCount: hub.resources(projectId).length,
      },
    };
  }
  if (req.method === "GET" && resource === "presence") {
    return { status: 200, body: { projectId, exists, members: hub.presence(projectId) } };
  }
  if (req.method === "GET" && resource === "events") {
    const afterSequence = intParam(req.query, "after");
    const limit = intParam(req.query, "limit");
    const { operations, truncated } = hub.history(projectId, {
      ...(afterSequence !== undefined ? { afterSequence } : {}),
      ...(limit !== undefined ? { limit } : {}),
    });
    return { status: 200, body: { projectId, exists, latestSequence, operations, truncated } };
  }
  if (req.method === "GET" && resource === "resources") {
    const adapter = req.query.get("adapter") || undefined;
    const resourceType = req.query.get("type") || undefined;
    const includeDeleted = ["1", "true"].includes(req.query.get("includeDeleted") ?? "");
    return {
      status: 200,
      body: {
        projectId,
        exists,
        latestSequence,
        resources: hub.resources(projectId, {
          ...(adapter ? { adapter } : {}),
          ...(resourceType ? { resourceType } : {}),
          includeDeleted,
        }),
      },
    };
  }
  if (req.method === "POST" && resource === "operations") {
    const actor = resolveActor(req);
    const operation = isRecord(req.body) ? req.body.operation : undefined;
    if (!isRecord(operation)) return fail(400, "invalid_operation", "body.operation must be an object");
    const filled = {
      id: randomUUID(),
      protocolVersion: EDGE_PROTOCOL_VERSION,
      projectId,
      actorId: actor.id,
      clientTimestamp: Date.now(),
      ...operation,
    };
    const result = hub.submit(projectId, actor, null, filled);
    return { status: result.duplicate ? 200 : 201, body: result };
  }
  if (req.method === "POST" && resource === "presence") {
    const actor = resolveActor(req);
    hub.touchActor(projectId, actor, workingOnFrom(req.body));
    return { status: 200, body: { projectId, members: hub.presence(projectId) } };
  }
  return fail(404, "not_found", `no edge route ${req.method} ${req.path}`);
}
