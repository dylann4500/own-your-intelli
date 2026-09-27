import type {
  EdgeAnnouncedResource,
  EdgeCommittedOperation,
  EdgeEffect,
  EdgeJson,
  EdgeResourceState,
} from "./protocol.ts";

export interface EdgeLocalChange {
  resourceType: string;
  resourceId: string;
  action: string;
  effect: EdgeEffect;
  payload: Record<string, EdgeJson>;
  label?: string;
}

export interface EdgeAdapterCapabilities {
  adapterId: string;
  resourceTypes: string[];
  actions: string[];
  properties: string[];
}

export interface EdgeAdapter {
  readonly adapterId: string;
  describeCapabilities(): EdgeAdapterCapabilities;
  observeLocalChanges(emit: (change: EdgeLocalChange) => void): () => void;
  applyRemoteOperation(operation: EdgeCommittedOperation): void;
  describeResources(): EdgeAnnouncedResource[];
}

export function snapshotOperations(
  resources: readonly EdgeResourceState[],
  adapterId: string,
  template: Pick<EdgeCommittedOperation, "projectId" | "committedAt">,
): EdgeCommittedOperation[] {
  const operations: EdgeCommittedOperation[] = [];
  for (const resource of resources) {
    if (resource.adapter !== adapterId || resource.lastSequence === 0) continue;
    const payload = Object.fromEntries(
      Object.entries(resource.properties).filter(([key]) => (resource.versions[key] ?? 0) > 0),
    );
    let effect: EdgeEffect = "update";
    if (!resource.exists) effect = "delete";
    else if (resource.createdSequence !== null) effect = "create";
    operations.push({
      id: `snapshot:${resource.resourceType}:${resource.resourceId}`,
      protocolVersion: 1,
      projectId: template.projectId,
      actorId: resource.lastActorId ?? "system",
      adapter: resource.adapter,
      resourceType: resource.resourceType,
      resourceId: resource.resourceId,
      action: "snapshot",
      effect,
      payload: effect === "delete" ? {} : payload,
      sequence: resource.lastSequence,
      committedAt: template.committedAt,
      actor: { id: "system", displayName: "QM Edge", type: "system" },
    });
  }
  return operations.sort((a, b) => a.sequence - b.sequence);
}
