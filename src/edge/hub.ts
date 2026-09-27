import { randomUUID } from "node:crypto";
import { constantTimeEqual } from "../util/crypto.ts";
import { swallow } from "../util/errors.ts";
import {
  EDGE_PROTOCOL_VERSION,
  EdgeProtocolError,
  parseClientMessage,
  parseOperation,
  type EdgeActor,
  type EdgeAnnouncedResource,
  type EdgeClientMessage,
  type EdgeCommittedOperation,
  type EdgeNode,
  type EdgePresenceEntry,
  type EdgeResourceState,
  type EdgeServerMessage,
  type EdgeWorkingOn,
} from "./protocol.ts";

export interface EdgeSink {
  send(message: EdgeServerMessage): void;
  close(code: number, reason: string): void;
}

export interface EdgeHubOptions {
  joinToken: string;
  hubName?: string;
  historyLimit?: number;
  maxOpsPerSecond?: number;
  connectionlessPresenceTtlMs?: number;
  offlineRetentionMs?: number;
  now?: () => number;
  onCommit?: (operation: EdgeCommittedOperation) => void;
}

export interface EdgeSubmitResult {
  operation: EdgeCommittedOperation;
  duplicate: boolean;
}

export interface EdgeHistoryQuery {
  afterSequence?: number;
  limit?: number;
}

export interface EdgeResourceQuery {
  adapter?: string;
  resourceType?: string;
  includeDeleted?: boolean;
}

interface Member {
  entry: EdgePresenceEntry;
  connections: Set<EdgeConnection>;
}

const MAX_PROPERTIES_PER_RESOURCE = 512;

class EdgeProject {
  readonly id: string;
  sequence = 0;
  readonly history: EdgeCommittedOperation[] = [];
  readonly committedIds = new Map<string, EdgeCommittedOperation>();
  readonly resources = new Map<string, EdgeResourceState>();
  readonly members = new Map<string, Member>();
  readonly subscribers = new Set<EdgeConnection>();

  constructor(id: string) {
    this.id = id;
  }
}

function resourceKey(adapter: string, resourceType: string, resourceId: string): string {
  return `${adapter}\u0000${resourceType}\u0000${resourceId}`;
}

function memberKey(actorId: string, nodeId: string | null): string {
  return `${actorId}\u0000${nodeId ?? ""}`;
}

export class EdgeHub {
  readonly joinToken: string;
  readonly hubName: string;
  private readonly historyLimit: number;
  readonly maxOpsPerSecond: number;
  private readonly connectionlessTtlMs: number;
  private readonly offlineRetentionMs: number;
  private readonly now: () => number;
  private readonly onCommit: ((operation: EdgeCommittedOperation) => void) | undefined;
  private readonly projects = new Map<string, EdgeProject>();
  private readonly connections = new Set<EdgeConnection>();
  private readonly rateWindows = new Map<string, { start: number; count: number }>();
  private readonly actorNames = new Map<string, string>();

  constructor(options: EdgeHubOptions) {
    this.joinToken = options.joinToken;
    this.hubName = options.hubName ?? "qm-edge";
    this.historyLimit = options.historyLimit ?? 2000;
    this.maxOpsPerSecond = options.maxOpsPerSecond ?? 120;
    this.connectionlessTtlMs = options.connectionlessPresenceTtlMs ?? 5 * 60_000;
    this.offlineRetentionMs = options.offlineRetentionMs ?? 30 * 60_000;
    this.now = options.now ?? Date.now;
    this.onCommit = options.onCommit;
  }

  nameActor(actorId: string, displayName: string): void {
    this.actorNames.set(actorId, displayName.slice(0, 80));
  }

  displayNameFor(actorId: string): string | undefined {
    return this.actorNames.get(actorId);
  }

  verifyToken(token: string | undefined | null): boolean {
    return typeof token === "string" && constantTimeEqual(token, this.joinToken);
  }

  connect(sink: EdgeSink): EdgeConnection {
    const connection = new EdgeConnection(this, sink, this.now);
    this.connections.add(connection);
    return connection;
  }

  get connectionCount(): number {
    return this.connections.size;
  }

  projectIds(): string[] {
    return [...this.projects.keys()].sort();
  }

  hasProject(projectId: string): boolean {
    return this.projects.has(projectId);
  }

  ensureProject(projectId: string): EdgeProject {
    let project = this.projects.get(projectId);
    if (!project) {
      project = new EdgeProject(projectId);
      this.projects.set(projectId, project);
    }
    return project;
  }

  latestSequence(projectId: string): number {
    return this.projects.get(projectId)?.sequence ?? 0;
  }

  submit(projectId: string, actor: EdgeActor, node: EdgeNode | null, raw: unknown): EdgeSubmitResult {
    const operation = parseOperation(raw);
    if (operation.projectId !== projectId) {
      throw new EdgeProtocolError(
        "invalid_operation",
        `operation targets project ${operation.projectId}, not ${projectId}`,
      );
    }
    if (operation.actorId !== actor.id) {
      throw new EdgeProtocolError("actor_mismatch", `operation actor ${operation.actorId} does not match ${actor.id}`);
    }
    if (operation.nodeId !== undefined && operation.nodeId !== node?.id) {
      throw new EdgeProtocolError(
        "actor_mismatch",
        `operation node ${operation.nodeId} does not match ${node?.id ?? "this connectionless actor"}`,
      );
    }
    const project = this.ensureProject(projectId);
    const existing = project.committedIds.get(operation.id);
    if (existing) return { operation: existing, duplicate: true };
    this.rateLimit(actor.id);

    const { nodeId: _claimedNode, ...rest } = operation;
    const committed: EdgeCommittedOperation = {
      ...rest,
      ...(node ? { nodeId: node.id } : {}),
      sequence: ++project.sequence,
      committedAt: this.now(),
      actor: { ...actor },
    };
    this.record(project, committed);
    try {
      this.onCommit?.(committed);
    } catch (e) {
      swallow("edge: journal append failed", e);
    }
    this.touchPresence(project, actor, node, workingOnFor(project, committed));
    this.broadcast(project, { type: "committedOperation", operation: committed });
    return { operation: committed, duplicate: false };
  }

  restore(operations: readonly EdgeCommittedOperation[]): void {
    for (const operation of [...operations].sort((a, b) => a.sequence - b.sequence)) {
      const project = this.ensureProject(operation.projectId);
      if (operation.sequence <= project.sequence || project.committedIds.has(operation.id)) continue;
      project.sequence = operation.sequence;
      this.record(project, operation);
    }
  }

  private rateLimit(actorId: string): void {
    const now = this.now();
    let window = this.rateWindows.get(actorId);
    if (!window || now - window.start >= 1000) {
      window = { start: now, count: 0 };
      this.rateWindows.set(actorId, window);
    }
    window.count++;
    if (window.count > this.maxOpsPerSecond) {
      throw new EdgeProtocolError("rate_limited", "too many operations per second; throttle updates");
    }
  }

  announce(projectId: string, adapter: string, resources: readonly EdgeAnnouncedResource[]): number {
    const project = this.ensureProject(projectId);
    let added = 0;
    for (const resource of resources) {
      const key = resourceKey(adapter, resource.resourceType, resource.resourceId);
      const current = project.resources.get(key);
      if (!current) {
        project.resources.set(key, {
          adapter,
          resourceType: resource.resourceType,
          resourceId: resource.resourceId,
          exists: true,
          properties: { ...resource.properties },
          versions: Object.fromEntries(Object.keys(resource.properties).map((k) => [k, 0])),
          createdSequence: null,
          deletedSequence: null,
          lastSequence: 0,
          lastActorId: null,
        });
        added++;
        continue;
      }
      for (const [k, value] of Object.entries(resource.properties)) {
        if (Object.hasOwn(current.versions, k)) continue;
        if (Object.keys(current.versions).length >= MAX_PROPERTIES_PER_RESOURCE) break;
        current.properties[k] = value;
        current.versions[k] = 0;
      }
    }
    return added;
  }

  history(
    projectId: string,
    query: EdgeHistoryQuery = {},
  ): { operations: EdgeCommittedOperation[]; truncated: boolean } {
    const project = this.projects.get(projectId);
    if (!project) return { operations: [], truncated: false };
    const after = query.afterSequence ?? 0;
    const limit = Math.max(1, Math.min(query.limit ?? 200, 5000));
    const oldest = project.history[0]?.sequence ?? project.sequence + 1;
    const truncated = after + 1 < oldest && after < project.sequence;
    const matching = project.history.filter((op) => op.sequence > after);
    return {
      operations: query.afterSequence === undefined ? matching.slice(-limit) : matching.slice(0, limit),
      truncated,
    };
  }

  resources(projectId: string, query: EdgeResourceQuery = {}): EdgeResourceState[] {
    const project = this.projects.get(projectId);
    if (!project) return [];
    return [...project.resources.values()]
      .filter((r) => (query.adapter ? r.adapter === query.adapter : true))
      .filter((r) => (query.resourceType ? r.resourceType === query.resourceType : true))
      .filter((r) => query.includeDeleted || r.exists)
      .map(cloneResource);
  }

  presence(projectId: string): EdgePresenceEntry[] {
    const project = this.projects.get(projectId);
    if (!project) return [];
    return this.presenceEntries(project);
  }

  touchActor(projectId: string, actor: EdgeActor, workingOn: EdgeWorkingOn = null): void {
    const project = this.ensureProject(projectId);
    this.touchPresence(project, actor, null, workingOn);
  }

  sweep(): void {
    const now = this.now();
    for (const [actorId, window] of this.rateWindows) if (now - window.start > 10_000) this.rateWindows.delete(actorId);
    for (const project of this.projects.values()) {
      let changed = false;
      for (const [key, member] of project.members) {
        const status = this.statusOf(member, now);
        if (status !== member.entry.status) {
          member.entry.status = status;
          changed = true;
        }
        if (status === "offline" && now - member.entry.lastSeenAt > this.offlineRetentionMs) {
          project.members.delete(key);
          changed = true;
        }
      }
      if (changed) this.broadcastPresence(project);
    }
  }

  handleJoin(connection: EdgeConnection, projectId: string, token: string): void {
    if (!this.verifyToken(token)) throw new EdgeProtocolError("unauthorized", "join token is invalid");
    const actor = connection.actor;
    if (!actor) throw new EdgeProtocolError("hello_required", "send hello before joinProject");
    const project = this.ensureProject(projectId);
    project.subscribers.add(connection);
    connection.joined.add(projectId);
    const node = connection.node;
    const key = memberKey(actor.id, node?.id ?? null);
    const now = this.now();
    let member = project.members.get(key);
    if (!member) {
      member = {
        entry: presenceEntry(actor, node, now),
        connections: new Set(),
      };
      project.members.set(key, member);
    }
    member.entry.displayName = actor.displayName;
    member.entry.actorType = actor.type;
    member.entry.status = "online";
    member.entry.lastSeenAt = now;
    member.entry.deviceName = node?.deviceName ?? member.entry.deviceName;
    if (member.connections.size === 0) member.entry.connectedAt = now;
    member.connections.add(connection);
    connection.send({
      type: "joined",
      projectId,
      latestSequence: project.sequence,
      members: this.presenceEntries(project),
      resources: [...project.resources.values()].map(cloneResource),
      history: project.history.slice(-100),
    });
    this.broadcastPresence(project);
  }

  handleLeave(connection: EdgeConnection, projectId: string): void {
    if (!connection.joined.delete(projectId)) return;
    const project = this.projects.get(projectId);
    if (!project) return;
    project.subscribers.delete(connection);
    for (const member of project.members.values()) {
      if (!member.connections.delete(connection)) continue;
      if (member.connections.size === 0) {
        member.entry.status = "offline";
        member.entry.lastSeenAt = this.now();
      }
    }
    this.broadcastPresence(project);
  }

  handlePresence(connection: EdgeConnection, projectId: string, workingOn: EdgeWorkingOn | undefined): void {
    const project = this.joinedProject(connection, projectId);
    const actor = connection.actor;
    if (!actor) throw new EdgeProtocolError("hello_required", "send hello before presence");
    this.touchPresence(project, actor, connection.node, workingOn ?? null);
  }

  joinedProject(connection: EdgeConnection, projectId: string): EdgeProject {
    const project = this.projects.get(projectId);
    if (!project || !connection.joined.has(projectId)) {
      throw new EdgeProtocolError("not_joined", `join project ${projectId} first`);
    }
    return project;
  }

  disconnect(connection: EdgeConnection): void {
    if (!this.connections.delete(connection)) return;
    for (const projectId of connection.joined) this.handleLeave(connection, projectId);
  }

  private record(project: EdgeProject, committed: EdgeCommittedOperation): void {
    project.history.push(committed);
    project.committedIds.set(committed.id, committed);
    const excess = project.history.length - this.historyLimit;
    if (excess > 0) for (const old of project.history.splice(0, excess)) project.committedIds.delete(old.id);
    reduce(project, committed);
  }

  private touchPresence(project: EdgeProject, actor: EdgeActor, node: EdgeNode | null, workingOn: EdgeWorkingOn): void {
    const key = memberKey(actor.id, node?.id ?? null);
    const now = this.now();
    let member = project.members.get(key);
    let changed = false;
    if (!member) {
      member = { entry: presenceEntry(actor, node, now), connections: new Set() };
      project.members.set(key, member);
      changed = true;
    }
    const before = member.entry.status;
    member.entry.lastSeenAt = now;
    member.entry.displayName = actor.displayName;
    member.entry.status = this.statusOf(member, now);
    if (before !== member.entry.status) changed = true;
    if (JSON.stringify(member.entry.workingOn) !== JSON.stringify(workingOn)) {
      member.entry.workingOn = workingOn;
      changed = true;
    }
    if (changed) this.broadcastPresence(project);
  }

  private statusOf(member: Member, now: number): "online" | "offline" {
    if (member.connections.size > 0) return "online";
    if (member.entry.nodeId === null && now - member.entry.lastSeenAt <= this.connectionlessTtlMs) return "online";
    return "offline";
  }

  private presenceEntries(project: EdgeProject): EdgePresenceEntry[] {
    const now = this.now();
    return [...project.members.values()]
      .map((member) => ({ ...member.entry, status: this.statusOf(member, now) }))
      .sort((a, b) => a.connectedAt - b.connectedAt || a.displayName.localeCompare(b.displayName));
  }

  private broadcastPresence(project: EdgeProject): void {
    this.broadcast(project, { type: "presence", projectId: project.id, members: this.presenceEntries(project) });
  }

  private broadcast(project: EdgeProject, message: EdgeServerMessage): void {
    for (const connection of project.subscribers) connection.send(message);
  }
}

export class EdgeConnection {
  readonly id = randomUUID();
  readonly joined = new Set<string>();
  actor: EdgeActor | null = null;
  node: EdgeNode | null = null;
  private readonly hub: EdgeHub;
  private readonly sink: EdgeSink;
  private readonly now: () => number;
  private closed = false;

  constructor(hub: EdgeHub, sink: EdgeSink, now: () => number) {
    this.hub = hub;
    this.sink = sink;
    this.now = now;
  }

  send(message: EdgeServerMessage): void {
    if (this.closed) return;
    try {
      this.sink.send(message);
    } catch {
      this.close();
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.hub.disconnect(this);
  }

  handle(raw: unknown): void {
    if (this.closed) return;
    let message: EdgeClientMessage;
    try {
      message = parseClientMessage(raw);
    } catch (e) {
      this.fail(e, requestTypeOf(raw));
      if (e instanceof EdgeProtocolError && e.code === "unsupported_protocol_version") {
        this.sink.close(4400, "unsupported protocol version");
        this.close();
      }
      return;
    }
    try {
      this.dispatch(message);
    } catch (e) {
      this.fail(e, message.type, message.type === "submitOperation" ? operationIdOf(message.operation) : undefined);
      if (e instanceof EdgeProtocolError && e.code === "unauthorized") {
        this.sink.close(4401, "invalid join token");
        this.close();
      }
    }
  }

  private dispatch(message: EdgeClientMessage): void {
    switch (message.type) {
      case "hello":
        if (this.actor && this.actor.id !== message.actor.id) {
          throw new EdgeProtocolError("actor_mismatch", "a connection cannot change actors; reconnect instead");
        }
        if (this.actor && (this.node?.id ?? null) !== (message.node?.id ?? null)) {
          throw new EdgeProtocolError("actor_mismatch", "a connection cannot change nodes; reconnect instead");
        }
        this.actor = message.actor;
        this.node = message.node ?? null;
        this.send({
          type: "welcome",
          protocolVersion: EDGE_PROTOCOL_VERSION,
          connectionId: this.id,
          serverTime: this.now(),
          hubName: this.hub.hubName,
        });
        return;
      case "ping":
        this.send({ type: "pong", ...(message.nonce ? { nonce: message.nonce } : {}), serverTime: this.now() });
        return;
      case "joinProject":
        this.hub.handleJoin(this, message.projectId, message.token);
        return;
      case "leaveProject":
        this.hub.handleLeave(this, message.projectId);
        this.send({ type: "left", projectId: message.projectId });
        return;
      case "presence":
        this.hub.handlePresence(this, message.projectId, message.workingOn);
        return;
      case "announceResources": {
        this.hub.joinedProject(this, message.projectId);
        const count = this.hub.announce(message.projectId, message.adapter, message.resources);
        this.send({ type: "resourcesAnnounced", projectId: message.projectId, adapter: message.adapter, count });
        return;
      }
      case "catchupRequest": {
        this.hub.joinedProject(this, message.projectId);
        const { operations, truncated } = this.hub.history(message.projectId, {
          afterSequence: message.afterSequence,
          limit: message.limit ?? 5000,
        });
        this.send({
          type: "eventHistory",
          projectId: message.projectId,
          operations,
          latestSequence: this.hub.latestSequence(message.projectId),
          truncated,
        });
        return;
      }
      case "submitOperation": {
        const actor = this.actor;
        if (!actor) throw new EdgeProtocolError("hello_required", "send hello before submitOperation");
        const projectId = projectIdOf(message.operation);
        this.hub.joinedProject(this, projectId);
        const result = this.hub.submit(projectId, actor, this.node, message.operation);
        this.send({
          type: "operationAck",
          operationId: result.operation.id,
          sequence: result.operation.sequence,
          duplicate: result.duplicate,
        });
        return;
      }
    }
  }

  private fail(e: unknown, requestType: string | undefined, operationId?: string): void {
    const error =
      e instanceof EdgeProtocolError
        ? e
        : new EdgeProtocolError("invalid_message", e instanceof Error ? e.message : String(e));
    this.send({
      type: "error",
      code: error.code,
      message: error.message,
      ...(requestType ? { requestType } : {}),
      ...(operationId ? { operationId } : {}),
    });
  }
}

function presenceEntry(actor: EdgeActor, node: EdgeNode | null, now: number): EdgePresenceEntry {
  return {
    actorId: actor.id,
    displayName: actor.displayName,
    actorType: actor.type,
    nodeId: node?.id ?? null,
    adapter: node?.adapter ?? null,
    deviceName: node?.deviceName ?? null,
    status: "online",
    workingOn: null,
    connectedAt: now,
    lastSeenAt: now,
  };
}

function cloneResource(resource: EdgeResourceState): EdgeResourceState {
  return structuredClone(resource);
}

function reduce(project: EdgeProject, op: EdgeCommittedOperation): void {
  if (op.effect === "none") return;
  const key = resourceKey(op.adapter, op.resourceType, op.resourceId);
  let resource = project.resources.get(key);
  if (!resource) {
    resource = {
      adapter: op.adapter,
      resourceType: op.resourceType,
      resourceId: op.resourceId,
      exists: true,
      properties: {},
      versions: {},
      createdSequence: null,
      deletedSequence: null,
      lastSequence: 0,
      lastActorId: null,
    };
    project.resources.set(key, resource);
  }
  if (op.effect === "delete") {
    resource.exists = false;
    resource.deletedSequence = op.sequence;
  } else if (op.effect === "create") {
    if (!resource.exists) {
      resource.properties = {};
      resource.versions = {};
    }
    resource.exists = true;
    resource.createdSequence = op.sequence;
    resource.deletedSequence = null;
  } else if (!resource.exists) {
    return;
  }
  if (op.effect !== "delete") {
    for (const [k, value] of Object.entries(op.payload)) {
      if ((resource.versions[k] ?? -1) >= op.sequence) continue;
      if (!Object.hasOwn(resource.versions, k) && Object.keys(resource.versions).length >= MAX_PROPERTIES_PER_RESOURCE)
        continue;
      resource.properties[k] = value;
      resource.versions[k] = op.sequence;
    }
  }
  resource.lastSequence = op.sequence;
  resource.lastActorId = op.actorId;
}

function workingOnFor(project: EdgeProject, op: EdgeCommittedOperation): EdgeWorkingOn {
  const resource = project.resources.get(resourceKey(op.adapter, op.resourceType, op.resourceId));
  const name = resource?.properties["name"];
  return {
    resourceType: op.resourceType,
    resourceId: op.resourceId,
    ...(typeof name === "string" ? { label: name.slice(0, 120) } : {}),
  };
}

function requestTypeOf(raw: unknown): string | undefined {
  let value = raw;
  if (typeof raw === "string") {
    try {
      value = JSON.parse(raw);
    } catch {
      return undefined;
    }
  }
  if (value && typeof value === "object" && "type" in value && typeof value.type === "string")
    return value.type.slice(0, 64);
  return undefined;
}

function projectIdOf(operation: unknown): string {
  if (
    operation &&
    typeof operation === "object" &&
    "projectId" in operation &&
    typeof operation.projectId === "string"
  ) {
    return operation.projectId;
  }
  throw new EdgeProtocolError("invalid_operation", "operation.projectId is required");
}

function operationIdOf(operation: unknown): string | undefined {
  if (operation && typeof operation === "object" && "id" in operation && typeof operation.id === "string") {
    return operation.id.slice(0, 64);
  }
  return undefined;
}
