import { z } from "zod";

export const EDGE_PROTOCOL_VERSION = 1;
export const EDGE_MAX_PAYLOAD_BYTES = 16 * 1024;
export const EDGE_MAX_ANNOUNCED_RESOURCES = 5000;

const printable = /^[^\u0000-\u001f\u007f]+$/;

export const edgeProjectId = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/, "project id must be 1-64 chars of letters, digits, '.', '_' or '-'");
const edgeId = z.string().min(1).max(256).regex(printable, "id must not contain control characters");
const edgeName = z.string().trim().min(1).max(80).regex(printable, "name must not contain control characters");
const edgeToken = z.string().regex(/^[a-z][a-z0-9_.-]{0,63}$/, "must be lowercase letters, digits, '_', '.' or '-'");
const edgeTypeName = z.string().regex(/^[A-Za-z][A-Za-z0-9_.-]{0,63}$/, "must start with a letter");

export type EdgeJson = z.core.util.JSONType;

export const edgeActorType = z.enum(["human", "agent", "system"]);
export type EdgeActorType = z.infer<typeof edgeActorType>;

export const edgeActor = z.strictObject({
  id: edgeId,
  displayName: edgeName,
  type: edgeActorType,
});
export type EdgeActor = z.infer<typeof edgeActor>;

export const edgeNode = z.strictObject({
  id: edgeId,
  adapter: edgeToken,
  deviceName: edgeName.optional(),
  capabilities: z.array(edgeToken).max(64).optional(),
});
export type EdgeNode = z.infer<typeof edgeNode>;

export const edgeEffect = z.enum(["create", "update", "delete", "none"]);
export type EdgeEffect = z.infer<typeof edgeEffect>;

const propertyKey = z.string().min(1).max(128).regex(printable, "property keys must not contain control characters");
export const edgeProperties = z
  .record(propertyKey, z.json())
  .refine((value) => Object.keys(value).length <= 256, "at most 256 properties per operation")
  .refine(
    (value) => byteLength(value) <= EDGE_MAX_PAYLOAD_BYTES,
    `payload must be at most ${EDGE_MAX_PAYLOAD_BYTES} bytes`,
  );
export type EdgeProperties = z.infer<typeof edgeProperties>;

export const edgeOperation = z.strictObject({
  id: z.uuid(),
  protocolVersion: z.literal(EDGE_PROTOCOL_VERSION),
  projectId: edgeProjectId,
  actorId: edgeId,
  nodeId: edgeId.optional(),
  adapter: edgeToken,
  resourceType: edgeTypeName,
  resourceId: edgeId,
  action: edgeToken,
  effect: edgeEffect,
  payload: edgeProperties.default({}),
  label: z.string().trim().max(160).regex(printable).optional(),
  clientTimestamp: z.number().finite().optional(),
});
export type EdgeOperation = z.infer<typeof edgeOperation>;

export interface EdgeCommittedOperation extends EdgeOperation {
  sequence: number;
  committedAt: number;
  actor: EdgeActor;
}

const workingOn = z
  .strictObject({
    resourceType: edgeTypeName.optional(),
    resourceId: edgeId.optional(),
    label: z.string().max(120).regex(printable).optional(),
  })
  .nullable();

const announcedResource = z.strictObject({
  resourceType: edgeTypeName,
  resourceId: edgeId,
  properties: edgeProperties,
});

const helloMessage = z.strictObject({
  type: z.literal("hello"),
  protocolVersion: z.number().int(),
  actor: edgeActor,
  node: edgeNode.optional(),
});

const joinProjectMessage = z.strictObject({
  type: z.literal("joinProject"),
  projectId: edgeProjectId,
  token: z.string().max(256),
  lastSequence: z.number().int().nonnegative().optional(),
});

const leaveProjectMessage = z.strictObject({
  type: z.literal("leaveProject"),
  projectId: edgeProjectId,
});

const presenceMessage = z.strictObject({
  type: z.literal("presence"),
  projectId: edgeProjectId,
  workingOn: workingOn.optional(),
});

const submitOperationMessage = z.strictObject({
  type: z.literal("submitOperation"),
  operation: z.unknown(),
});

const announceResourcesMessage = z.strictObject({
  type: z.literal("announceResources"),
  projectId: edgeProjectId,
  adapter: edgeToken,
  resources: z.array(announcedResource).max(EDGE_MAX_ANNOUNCED_RESOURCES),
});

const catchupRequestMessage = z.strictObject({
  type: z.literal("catchupRequest"),
  projectId: edgeProjectId,
  afterSequence: z.number().int().nonnegative(),
  limit: z.number().int().positive().max(5000).optional(),
});

const pingMessage = z.strictObject({
  type: z.literal("ping"),
  nonce: z.string().max(64).optional(),
});

export const edgeClientMessage = z.discriminatedUnion("type", [
  helloMessage,
  joinProjectMessage,
  leaveProjectMessage,
  presenceMessage,
  submitOperationMessage,
  announceResourcesMessage,
  catchupRequestMessage,
  pingMessage,
]);
export type EdgeClientMessage = z.infer<typeof edgeClientMessage>;
export type EdgeAnnouncedResource = z.infer<typeof announcedResource>;
export type EdgeWorkingOn = z.infer<typeof workingOn>;

export interface EdgePresenceEntry {
  actorId: string;
  displayName: string;
  actorType: EdgeActorType;
  nodeId: string | null;
  adapter: string | null;
  deviceName: string | null;
  status: "online" | "offline";
  workingOn: EdgeWorkingOn;
  connectedAt: number;
  lastSeenAt: number;
}

export interface EdgeResourceState {
  adapter: string;
  resourceType: string;
  resourceId: string;
  exists: boolean;
  properties: Record<string, EdgeJson>;
  versions: Record<string, number>;
  createdSequence: number | null;
  deletedSequence: number | null;
  lastSequence: number;
  lastActorId: string | null;
}

export type EdgeErrorCode =
  | "invalid_message"
  | "unsupported_protocol_version"
  | "hello_required"
  | "unauthorized"
  | "not_joined"
  | "invalid_operation"
  | "actor_mismatch"
  | "rate_limited"
  | "unknown_project";

export type EdgeServerMessage =
  | { type: "welcome"; protocolVersion: number; connectionId: string; serverTime: number; hubName: string }
  | {
      type: "joined";
      projectId: string;
      latestSequence: number;
      members: EdgePresenceEntry[];
      resources: EdgeResourceState[];
      history: EdgeCommittedOperation[];
    }
  | { type: "left"; projectId: string }
  | { type: "presence"; projectId: string; members: EdgePresenceEntry[] }
  | { type: "committedOperation"; operation: EdgeCommittedOperation }
  | { type: "operationAck"; operationId: string; sequence: number; duplicate: boolean }
  | {
      type: "eventHistory";
      projectId: string;
      operations: EdgeCommittedOperation[];
      latestSequence: number;
      truncated: boolean;
    }
  | { type: "resourcesAnnounced"; projectId: string; adapter: string; count: number }
  | {
      type: "error";
      code: EdgeErrorCode;
      message: string;
      requestType?: string;
      operationId?: string;
    }
  | { type: "pong"; nonce?: string; serverTime: number };

export class EdgeProtocolError extends Error {
  readonly code: EdgeErrorCode;
  constructor(code: EdgeErrorCode, message: string) {
    super(message);
    this.name = "EdgeProtocolError";
    this.code = code;
  }
}

function byteLength(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

export function formatIssues(error: z.ZodError): string {
  return error.issues
    .slice(0, 5)
    .map((issue) => (issue.path.length ? `${issue.path.join(".")}: ${issue.message}` : issue.message))
    .join("; ");
}

export function parseClientMessage(raw: unknown): EdgeClientMessage {
  let value = raw;
  if (typeof raw === "string") {
    try {
      value = JSON.parse(raw);
    } catch {
      throw new EdgeProtocolError("invalid_message", "message is not valid JSON");
    }
  }
  const parsed = edgeClientMessage.safeParse(value);
  if (!parsed.success) throw new EdgeProtocolError("invalid_message", formatIssues(parsed.error));
  if (parsed.data.type === "hello" && parsed.data.protocolVersion !== EDGE_PROTOCOL_VERSION) {
    throw new EdgeProtocolError(
      "unsupported_protocol_version",
      `protocol version ${parsed.data.protocolVersion} is not supported; this hub speaks version ${EDGE_PROTOCOL_VERSION}`,
    );
  }
  return parsed.data;
}

export function parseOperation(raw: unknown): EdgeOperation {
  if (raw && typeof raw === "object" && "protocolVersion" in raw && raw.protocolVersion !== EDGE_PROTOCOL_VERSION) {
    throw new EdgeProtocolError(
      "unsupported_protocol_version",
      `operation protocol version ${String(raw.protocolVersion)} is not supported; this hub speaks version ${EDGE_PROTOCOL_VERSION}`,
    );
  }
  const parsed = edgeOperation.safeParse(raw);
  if (!parsed.success) throw new EdgeProtocolError("invalid_operation", formatIssues(parsed.error));
  return parsed.data;
}
