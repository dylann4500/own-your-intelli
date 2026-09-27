import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { snapshotOperations, type EdgeAdapter, type EdgeLocalChange } from "./adapter.ts";
import {
  EDGE_PROTOCOL_VERSION,
  type EdgeActor,
  type EdgeCommittedOperation,
  type EdgeJson,
  type EdgeNode,
  type EdgeOperation,
  type EdgePresenceEntry,
  type EdgeServerMessage,
} from "./protocol.ts";

export interface EdgeNodeSessionOptions {
  url: string;
  projectId: string;
  token: string;
  actor: EdgeActor;
  node: EdgeNode;
  adapter: EdgeAdapter;
  reconnect?: boolean;
  reconnectDelaysMs?: number[];
}

export interface EdgeNodeStats {
  sent: number;
  suppressed: number;
  applied: number;
  skippedStale: number;
  skippedPending: number;
  ownEchoes: number;
}

type Listener = (message: EdgeServerMessage) => void;

function resourceKey(resourceType: string, resourceId: string): string {
  return `${resourceType}\u0000${resourceId}`;
}

export class EdgeNodeSession {
  readonly options: EdgeNodeSessionOptions;
  readonly stats: EdgeNodeStats = {
    sent: 0,
    suppressed: 0,
    applied: 0,
    skippedStale: 0,
    skippedPending: 0,
    ownEchoes: 0,
  };
  members: EdgePresenceEntry[] = [];
  history: EdgeCommittedOperation[] = [];
  lastSequence = 0;
  lastError: string | null = null;
  private socket: WebSocket | null = null;
  private joined = false;
  private wanted = false;
  private attempt = 0;
  private applyingRemote = false;
  private fullResync = false;
  private readonly synced = new Map<string, Map<string, EdgeJson>>();
  private readonly existence = new Map<string, boolean>();
  private readonly pending = new Map<string, string>();
  private readonly listeners = new Set<Listener>();
  private readonly inflight = new Map<string, EdgeOperation>();
  private stopObserving: (() => void) | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(options: EdgeNodeSessionOptions) {
    this.options = options;
  }

  get connected(): boolean {
    return this.joined;
  }

  onMessage(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  waitFor(predicate: (message: EdgeServerMessage) => boolean, timeoutMs = 5000): Promise<EdgeServerMessage> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        off();
        reject(new Error(`timed out after ${timeoutMs}ms waiting for edge message`));
      }, timeoutMs);
      const off = this.onMessage((message) => {
        if (!predicate(message)) return;
        clearTimeout(timer);
        off();
        resolve(message);
      });
    });
  }

  start(): Promise<void> {
    this.wanted = true;
    this.stopObserving ??= this.options.adapter.observeLocalChanges((change) => this.handleLocalChange(change));
    const joined = this.waitFor((m) => m.type === "joined", 10_000).then(() => undefined);
    this.open();
    return joined;
  }

  stop(): void {
    this.wanted = false;
    this.stopObserving?.();
    this.stopObserving = null;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.socket?.close(1000, "client stopping");
    this.socket = null;
    this.joined = false;
  }

  dropConnection(): void {
    this.socket?.close(4000, "simulated drop");
  }

  private open(): void {
    const socket = new WebSocket(this.options.url);
    this.socket = socket;
    socket.addEventListener("open", () => {
      this.attempt = 0;
      this.sendRaw({
        type: "hello",
        protocolVersion: EDGE_PROTOCOL_VERSION,
        actor: this.options.actor,
        node: this.options.node,
      });
      this.sendRaw({
        type: "joinProject",
        projectId: this.options.projectId,
        token: this.options.token,
        lastSequence: this.lastSequence,
      });
    });
    socket.addEventListener("message", (event) => {
      if (typeof event.data !== "string") return;
      this.receive(JSON.parse(event.data) as EdgeServerMessage);
    });
    socket.addEventListener("close", () => {
      if (this.socket !== socket) return;
      this.joined = false;
      this.socket = null;
      if (!this.wanted || this.options.reconnect === false) return;
      const delays = this.options.reconnectDelaysMs ?? [500, 1000, 2000, 5000];
      const delay = delays[Math.min(this.attempt, delays.length - 1)] ?? 1000;
      this.attempt++;
      this.reconnectTimer = setTimeout(() => {
        this.reconnectTimer = null;
        if (this.wanted) this.open();
      }, delay);
    });
    socket.addEventListener("error", () => {
      this.lastError = `could not reach ${this.options.url}`;
    });
  }

  private sendRaw(message: unknown): void {
    const socket = this.socket;
    if (socket && socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
  }

  private submit(operation: EdgeOperation): void {
    this.inflight.set(operation.id, operation);
    if (this.joined) this.sendRaw({ type: "submitOperation", operation });
  }

  private settle(operationId: string): void {
    this.inflight.delete(operationId);
    this.clearPending(operationId);
  }

  private resync(): void {
    this.fullResync = true;
    this.sendRaw({ type: "joinProject", projectId: this.options.projectId, token: this.options.token });
  }

  private rejected(operationId: string, code: string): void {
    const operation = this.inflight.get(operationId);
    if (!operation) return;
    if (code === "rate_limited") {
      setTimeout(() => {
        if (this.inflight.has(operationId) && this.joined) this.sendRaw({ type: "submitOperation", operation });
      }, 1000).unref?.();
      return;
    }
    this.settle(operationId);
    this.resync();
  }

  private receive(message: EdgeServerMessage): void {
    switch (message.type) {
      case "joined":
        this.joined = true;
        this.members = message.members;
        this.history = message.history;
        if (message.latestSequence < this.lastSequence) this.fullResync = true;
        this.pending.clear();
        for (const operation of this.inflight.values()) this.markPending(operation);
        this.applySnapshot(message, this.fullResync);
        this.fullResync = false;
        this.lastSequence = message.latestSequence;
        this.sendRaw({
          type: "announceResources",
          projectId: this.options.projectId,
          adapter: this.options.adapter.adapterId,
          resources: this.options.adapter.describeResources(),
        });
        for (const operation of this.inflight.values()) this.sendRaw({ type: "submitOperation", operation });
        break;
      case "presence":
        this.members = message.members;
        break;
      case "committedOperation":
        this.handleCommitted(message.operation);
        break;
      case "operationAck":
        this.settle(message.operationId);
        break;
      case "error":
        this.lastError = `${message.code}: ${message.message}`;
        if (message.operationId) this.rejected(message.operationId, message.code);
        break;
      default:
        break;
    }
    for (const listener of this.listeners) listener(message);
  }

  private applySnapshot(message: Extract<EdgeServerMessage, { type: "joined" }>, full: boolean): void {
    const operations = snapshotOperations(message.resources, this.options.adapter.adapterId, {
      projectId: message.projectId,
      committedAt: Date.now(),
    });
    for (const operation of operations) {
      if (!full && operation.sequence <= this.lastSequence) continue;
      this.applyRemote(operation);
    }
  }

  private handleCommitted(operation: EdgeCommittedOperation): void {
    const own = operation.nodeId === this.options.node.id;
    if (own) this.settle(operation.id);
    if (operation.sequence <= this.lastSequence) {
      this.stats.skippedStale++;
      return;
    }
    this.lastSequence = operation.sequence;
    this.history.push(operation);
    if (this.history.length > 500) this.history.splice(0, this.history.length - 500);
    if (own) {
      this.stats.ownEchoes++;
      return;
    }
    if (operation.adapter !== this.options.adapter.adapterId) return;
    this.applyRemote(operation);
  }

  private applyRemote(operation: EdgeCommittedOperation): void {
    const key = resourceKey(operation.resourceType, operation.resourceId);
    const payload: Record<string, EdgeJson> = {};
    for (const [property, value] of Object.entries(operation.payload)) {
      if (this.pending.has(`${key}\u0000${property}`)) {
        this.stats.skippedPending++;
        continue;
      }
      payload[property] = value;
    }
    if (operation.effect === "update" && Object.keys(payload).length === 0) return;
    const values = this.synced.get(key) ?? new Map<string, EdgeJson>();
    this.synced.set(key, values);
    for (const [property, value] of Object.entries(payload)) values.set(property, value);
    if (operation.effect === "create") this.existence.set(key, true);
    if (operation.effect === "delete") this.existence.set(key, false);
    this.applyingRemote = true;
    try {
      this.options.adapter.applyRemoteOperation({ ...operation, payload });
      this.stats.applied++;
    } finally {
      this.applyingRemote = false;
    }
  }

  private handleLocalChange(change: EdgeLocalChange): void {
    if (this.applyingRemote) {
      this.stats.suppressed++;
      return;
    }
    const key = resourceKey(change.resourceType, change.resourceId);
    if (change.effect === "create" || change.effect === "delete") {
      const exists = change.effect === "create";
      if (this.existence.get(key) === exists) {
        this.stats.suppressed++;
        return;
      }
      this.existence.set(key, exists);
    }
    const values = this.synced.get(key) ?? new Map<string, EdgeJson>();
    this.synced.set(key, values);
    const payload: Record<string, EdgeJson> = {};
    for (const [property, value] of Object.entries(change.payload)) {
      if (change.effect === "update" && values.has(property) && isDeepStrictEqual(values.get(property), value))
        continue;
      payload[property] = value;
    }
    if (change.effect === "update" && Object.keys(payload).length === 0) {
      this.stats.suppressed++;
      return;
    }
    const operation: EdgeOperation = {
      id: randomUUID(),
      protocolVersion: EDGE_PROTOCOL_VERSION,
      projectId: this.options.projectId,
      actorId: this.options.actor.id,
      nodeId: this.options.node.id,
      adapter: this.options.adapter.adapterId,
      resourceType: change.resourceType,
      resourceId: change.resourceId,
      action: change.action,
      effect: change.effect,
      payload,
      ...(change.label ? { label: change.label } : {}),
      clientTimestamp: Date.now(),
    };
    for (const [property, value] of Object.entries(payload)) values.set(property, value);
    this.markPending(operation);
    this.stats.sent++;
    this.submit(operation);
  }

  private markPending(operation: EdgeOperation): void {
    const key = resourceKey(operation.resourceType, operation.resourceId);
    for (const property of Object.keys(operation.payload)) this.pending.set(`${key}\u0000${property}`, operation.id);
  }

  private clearPending(operationId: string): void {
    for (const [key, id] of this.pending) if (id === operationId) this.pending.delete(key);
  }
}
