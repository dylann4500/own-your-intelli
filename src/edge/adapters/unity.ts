import type { EdgeLocalChange } from "../adapter.ts";
import type { EdgeJson, EdgeResourceState } from "../protocol.ts";

export const UNITY_ADAPTER = "unity";
export const UNITY_GAME_OBJECT = "GameObject";
export const UNITY_PRIMITIVES = ["Cube", "Sphere", "Capsule", "Cylinder", "Plane", "Quad"] as const;
export const UNITY_PROPERTIES = [
  "name",
  "primitive",
  "position",
  "rotation",
  "scale",
  "light.intensity",
  "light.color",
];
export const UNITY_ACTIONS = ["create_object", "set_transform", "set_property", "rename", "delete_object"];

export type Vec3 = [number, number, number];

export const PROPERTY_ALIASES: Record<string, string> = {
  intensity: "light.intensity",
  "light.intensity": "light.intensity",
  color: "light.color",
  "light.color": "light.color",
  position: "position",
  rotation: "rotation",
  scale: "scale",
  name: "name",
};

export interface UnityObjectSummary {
  id: string;
  name: string;
  type: string;
  primitive?: string;
  position?: EdgeJson;
  rotation?: EdgeJson;
  scale?: EdgeJson;
  light?: { intensity?: EdgeJson; color?: EdgeJson };
  lastSequence: number;
  lastActorId: string | null;
}

export function normalizePrimitive(raw: string): (typeof UNITY_PRIMITIVES)[number] {
  const match = UNITY_PRIMITIVES.find((p) => p.toLowerCase() === raw.trim().toLowerCase());
  if (!match) throw new Error(`unsupported primitive '${raw}'; use one of ${UNITY_PRIMITIVES.join(", ")}`);
  return match;
}

export function summarizeUnityResource(resource: EdgeResourceState): UnityObjectSummary {
  const p = resource.properties;
  const name = typeof p["name"] === "string" ? p["name"] : resource.resourceId;
  const hasLight = p["light.intensity"] !== undefined || p["light.color"] !== undefined;
  return {
    id: resource.resourceId,
    name,
    type: hasLight ? "Light" : resource.resourceType,
    ...(typeof p["primitive"] === "string" ? { primitive: p["primitive"] } : {}),
    ...(p["position"] !== undefined ? { position: p["position"] } : {}),
    ...(p["rotation"] !== undefined ? { rotation: p["rotation"] } : {}),
    ...(p["scale"] !== undefined ? { scale: p["scale"] } : {}),
    ...(hasLight
      ? {
          light: {
            ...(p["light.intensity"] !== undefined ? { intensity: p["light.intensity"] } : {}),
            ...(p["light.color"] !== undefined ? { color: p["light.color"] } : {}),
          },
        }
      : {}),
    lastSequence: resource.lastSequence,
    lastActorId: resource.lastActorId,
  };
}

export function createObjectChange(input: {
  resourceId: string;
  name: string;
  primitive: string;
  position: Vec3;
  rotation?: Vec3;
  scale?: Vec3;
}): EdgeLocalChange {
  const primitive = normalizePrimitive(input.primitive);
  return {
    resourceType: UNITY_GAME_OBJECT,
    resourceId: input.resourceId,
    action: "create_object",
    effect: "create",
    payload: {
      name: input.name,
      primitive,
      position: input.position,
      rotation: input.rotation ?? [0, 0, 0],
      scale: input.scale ?? [1, 1, 1],
    },
    label: `created ${primitive} ${input.name}`,
  };
}

export function transformChange(
  resourceId: string,
  name: string,
  values: { position?: Vec3; rotation?: Vec3; scale?: Vec3 },
): EdgeLocalChange {
  const payload: Record<string, EdgeJson> = {};
  if (values.position) payload["position"] = values.position;
  if (values.rotation) payload["rotation"] = values.rotation;
  if (values.scale) payload["scale"] = values.scale;
  let verb = "moved";
  if (!values.position && values.rotation) verb = "rotated";
  else if (!values.position && values.scale) verb = "scaled";
  return {
    resourceType: UNITY_GAME_OBJECT,
    resourceId,
    action: "set_transform",
    effect: "update",
    payload,
    label: `${verb} ${name}`,
  };
}

export function propertyChange(resourceId: string, name: string, property: string, value: EdgeJson): EdgeLocalChange {
  const key = PROPERTY_ALIASES[property] ?? property;
  if (!UNITY_PROPERTIES.includes(key) || key === "primitive") {
    throw new Error(`unsupported property '${property}'; use one of intensity, color, name, position, rotation, scale`);
  }
  if (key === "name") {
    return {
      resourceType: UNITY_GAME_OBJECT,
      resourceId,
      action: "rename",
      effect: "update",
      payload: { name: value },
      label: `renamed ${name} to ${String(value)}`,
    };
  }
  const shortName = key.startsWith("light.") ? key.slice("light.".length) : key;
  return {
    resourceType: UNITY_GAME_OBJECT,
    resourceId,
    action: key === "position" || key === "rotation" || key === "scale" ? "set_transform" : "set_property",
    effect: "update",
    payload: { [key]: value },
    label: `changed ${name} ${shortName} to ${JSON.stringify(value)}`,
  };
}

export function deleteObjectChange(resourceId: string, name: string): EdgeLocalChange {
  return {
    resourceType: UNITY_GAME_OBJECT,
    resourceId,
    action: "delete_object",
    effect: "delete",
    payload: {},
    label: `deleted ${name}`,
  };
}
