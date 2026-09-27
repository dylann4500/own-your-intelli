import { isDeepStrictEqual } from "node:util";
import type { EdgeAdapter, EdgeAdapterCapabilities, EdgeLocalChange } from "../adapter.ts";
import type { EdgeAnnouncedResource, EdgeCommittedOperation, EdgeJson } from "../protocol.ts";
import {
  UNITY_ACTIONS,
  UNITY_ADAPTER,
  UNITY_GAME_OBJECT,
  UNITY_PROPERTIES,
  createObjectChange,
  deleteObjectChange,
  propertyChange,
  transformChange,
  type Vec3,
} from "./unity.ts";

export interface SceneObject {
  id: string;
  properties: Record<string, EdgeJson>;
}

export type ObserverTiming = "sync" | "async" | "both";

export class MemorySceneAdapter implements EdgeAdapter {
  readonly adapterId = UNITY_ADAPTER;
  readonly objects = new Map<string, SceneObject>();
  readonly applied: EdgeCommittedOperation[] = [];
  private readonly observers = new Set<(change: EdgeLocalChange) => void>();
  private readonly timing: ObserverTiming;

  constructor(baseline: SceneObject[] = [], timing: ObserverTiming = "both") {
    for (const object of baseline) this.objects.set(object.id, structuredClone(object));
    this.timing = timing;
  }

  describeCapabilities(): EdgeAdapterCapabilities {
    return {
      adapterId: this.adapterId,
      resourceTypes: [UNITY_GAME_OBJECT],
      actions: UNITY_ACTIONS,
      properties: UNITY_PROPERTIES,
    };
  }

  observeLocalChanges(emit: (change: EdgeLocalChange) => void): () => void {
    this.observers.add(emit);
    return () => this.observers.delete(emit);
  }

  describeResources(): EdgeAnnouncedResource[] {
    return [...this.objects.values()].map((object) => ({
      resourceType: UNITY_GAME_OBJECT,
      resourceId: object.id,
      properties: structuredClone(object.properties),
    }));
  }

  get(id: string): SceneObject | undefined {
    return this.objects.get(id);
  }

  findByName(name: string): SceneObject | undefined {
    return [...this.objects.values()].find((o) => o.properties["name"] === name);
  }

  applyRemoteOperation(operation: EdgeCommittedOperation): void {
    this.applied.push(operation);
    if (operation.effect === "delete") {
      const existing = this.objects.get(operation.resourceId);
      this.objects.delete(operation.resourceId);
      if (existing) this.notify(deleteObjectChange(operation.resourceId, String(existing.properties["name"] ?? "")));
      return;
    }
    if (operation.effect === "none") return;
    let object = this.objects.get(operation.resourceId);
    if (!object) {
      if (operation.effect !== "create") return;
      object = { id: operation.resourceId, properties: {} };
      this.objects.set(operation.resourceId, object);
    }
    Object.assign(object.properties, operation.payload);
    if (operation.effect === "create") {
      this.notify({ ...this.creationChange(object) });
      return;
    }
    this.notify({
      resourceType: UNITY_GAME_OBJECT,
      resourceId: object.id,
      action: "set_transform",
      effect: "update",
      payload: { ...operation.payload },
    });
  }

  move(id: string, position: Vec3): void {
    const object = this.require(id);
    if (isDeepStrictEqual(object.properties["position"], position)) return;
    object.properties["position"] = position;
    this.notify(transformChange(id, String(object.properties["name"] ?? id), { position }));
  }

  setProperty(id: string, property: string, value: EdgeJson): void {
    const object = this.require(id);
    const change = propertyChange(id, String(object.properties["name"] ?? id), property, value);
    Object.assign(object.properties, change.payload);
    this.notify(change);
  }

  create(id: string, name: string, primitive: string, position: Vec3): void {
    const change = createObjectChange({ resourceId: id, name, primitive, position });
    this.objects.set(id, { id, properties: { ...change.payload } });
    this.notify(change);
  }

  remove(id: string): void {
    const object = this.require(id);
    this.objects.delete(id);
    this.notify(deleteObjectChange(id, String(object.properties["name"] ?? id)));
  }

  private creationChange(object: SceneObject): EdgeLocalChange {
    return {
      resourceType: UNITY_GAME_OBJECT,
      resourceId: object.id,
      action: "create_object",
      effect: "create",
      payload: { ...object.properties },
    };
  }

  private currentChange(change: EdgeLocalChange): EdgeLocalChange | null {
    if (change.effect === "delete") return this.objects.has(change.resourceId) ? null : change;
    const object = this.objects.get(change.resourceId);
    if (!object) return null;
    const keys = change.effect === "create" ? Object.keys(object.properties) : Object.keys(change.payload);
    const payload = Object.fromEntries(
      keys.filter((k) => Object.hasOwn(object.properties, k)).map((k) => [k, object.properties[k] ?? null]),
    );
    return { ...change, payload };
  }

  private require(id: string): SceneObject {
    const object = this.objects.get(id);
    if (!object) throw new Error(`no object ${id}`);
    return object;
  }

  private notify(change: EdgeLocalChange): void {
    if (this.timing !== "async") for (const observer of this.observers) observer(structuredClone(change));
    if (this.timing !== "sync") {
      setImmediate(() => {
        const current = this.currentChange(change);
        if (!current) return;
        for (const observer of this.observers) observer(structuredClone(current));
      });
    }
  }
}
