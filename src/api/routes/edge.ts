import type { CapabilityClaims } from "../../auth/capability-token.ts";
import type { PortalIdentity } from "../../auth/portal-identity.ts";
import { handleEdgeApi } from "../../edge/http.ts";
import { edgeProjectId, type EdgeActor } from "../../edge/protocol.ts";
import { handleEdgeHttpRequest } from "../../edge/server.ts";
import { sendJson } from "../http.ts";
import type { ApiCtx, BaseCtx, Route } from "./route.ts";

const EDGE_DISABLED = {
  error: "edge_disabled",
  message: "QM Edge is not enabled on this deployment (set EDGE_ENABLED=1)",
};

const CONTROL_CHARS = /[\u0000-\u001f\u007f]/g;

function clean(value: string, max: number): string {
  return value.replace(CONTROL_CHARS, "").trim().slice(0, max);
}

function agentActor(capability: CapabilityClaims): EdgeActor {
  return { id: clean(`qm-agent:${capability.actorId}`, 256), displayName: "QM Agent", type: "agent" };
}

function humanActor(identity: PortalIdentity): EdgeActor {
  const principal = clean(identity.p, 240);
  return {
    id: clean(`qm-user:${principal}`, 256),
    displayName: clean(identity.n ?? "", 80) || clean(principal, 80) || "QM User",
    type: "human",
  };
}

function actorFor(ctx: ApiCtx): EdgeActor | null {
  if (ctx.capability) {
    const actor = agentActor(ctx.capability);
    return { ...actor, displayName: ctx.deps.edgeHub?.displayNameFor(actor.id) ?? actor.displayName };
  }
  if (ctx.actor?.p && clean(ctx.actor.p, 240)) return humanActor(ctx.actor);
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function withoutClientNodeId(body: unknown): unknown {
  if (!isRecord(body) || !isRecord(body.operation)) return body;
  const operation = Object.fromEntries(Object.entries(body.operation).filter(([key]) => key !== "nodeId"));
  return { ...body, operation };
}

function edgeApi(method: "GET" | "POST", resource: string | null): (ctx: ApiCtx) => void {
  return (ctx) => {
    const hub = ctx.deps.edgeHub;
    if (!hub) return sendJson(ctx.res, 404, EDGE_DISABLED);
    let path = "projects";
    if (resource !== null) {
      const projectId = ctx.params.projectId ?? "";
      if (!edgeProjectId.safeParse(projectId).success)
        return sendJson(ctx.res, 400, { error: "invalid_message", message: "invalid project id" });
      path = resource ? `projects/${projectId}/${resource}` : `projects/${projectId}`;
    }
    const actor = actorFor(ctx);
    if (method === "POST") {
      if (!actor)
        return sendJson(ctx.res, 401, {
          error: "unauthorized",
          message: "QM Edge writes need an agent capability token or a signed portal identity",
        });
      if (!ctx.capability && ctx.actor?.imp)
        return sendJson(ctx.res, 403, {
          error: "forbidden",
          message: "QM Edge writes are not allowed while impersonating another user",
        });
      const projectId = ctx.params.projectId ?? "";
      if (!hub.hasProject(projectId))
        return sendJson(ctx.res, 404, {
          error: "unknown_project",
          message: `QM Edge project ${projectId} does not exist; a connected editor must join it first`,
        });
    }
    const body = method === "POST" ? withoutClientNodeId(ctx.body) : ctx.body;
    const result = handleEdgeApi(hub, { method, path, query: ctx.url.searchParams, body, actor });
    return sendJson(ctx.res, result.status, result.body);
  };
}

export const edgeRoutes: ReadonlyArray<Route<ApiCtx>> = [
  { method: "GET", path: "/v1/edge/projects", auth: "either", handle: edgeApi("GET", null) },
  { method: "GET", path: "/v1/edge/projects/:projectId", auth: "either", handle: edgeApi("GET", "") },
  { method: "GET", path: "/v1/edge/projects/:projectId/presence", auth: "either", handle: edgeApi("GET", "presence") },
  { method: "GET", path: "/v1/edge/projects/:projectId/events", auth: "either", handle: edgeApi("GET", "events") },
  {
    method: "GET",
    path: "/v1/edge/projects/:projectId/resources",
    auth: "either",
    handle: edgeApi("GET", "resources"),
  },
  {
    method: "POST",
    path: "/v1/edge/projects/:projectId/operations",
    auth: "either",
    handle: edgeApi("POST", "operations"),
  },
  {
    method: "POST",
    path: "/v1/edge/projects/:projectId/presence",
    auth: "either",
    handle: edgeApi("POST", "presence"),
  },
];

export const edgeRawRoutes: ReadonlyArray<Route<BaseCtx>> = [
  {
    match: (method, pathname) =>
      pathname === "/edge/health" ||
      pathname.startsWith("/edge/v1/") ||
      (method === "GET" && (pathname === "/edge" || pathname === "/edge/" || pathname === "/edge/room")),
    auth: "public",
    handle: async ({ req, res, deps }) => {
      if (!deps.edgeHub) return sendJson(res, 404, EDGE_DISABLED);
      await handleEdgeHttpRequest(deps.edgeHub, req, res, deps.edgeAgents ? { agents: deps.edgeAgents } : {});
    },
  },
];
