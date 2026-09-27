import { randomUUID } from "node:crypto";
import type { EdgeHub } from "../edge/hub.ts";
import { EDGE_PROTOCOL_VERSION, EdgeProtocolError, type EdgeActor } from "../edge/protocol.ts";
import type { EdgeAgentBridge } from "../edge/server.ts";
import { errMessage, swallow } from "../util/errors.ts";
import type { App } from "./app-types.ts";

const MAX_PENDING = 3;

function slugOf(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 32) || "guest"
  );
}

function flat(text: string, max: number): string {
  const cleaned = text.replace(/[\u0000-\u001f\u007f]+/g, " ").trim();
  return cleaned.length > max ? `${cleaned.slice(0, max - 1)}…` : cleaned;
}

function preamble(name: string, projectId: string): string {
  return (
    `You are ${name}'s agent in the live QM Edge project "${projectId}". Other people and other agents are editing ` +
    "the same Unity scene right now, and every change you make appears instantly in their Unity Editors and in the " +
    "shared room. Use the `qm-edge` CLI in your sandbox through execute: run `qm-edge objects` and `qm-edge events " +
    "--limit 20` first to see the scene and what others just did, then act with `qm-edge create|move|rotate|scale|" +
    `set|delete ... --project ${projectId}\` (see \`qm-edge help\`). Name what you create ${slugOf(name).replace(/-/g, "_")}_something ` +
    "and only change your own objects unless asked. Reply in one or two short sentences saying what you changed. " +
    `${name} explicitly skips onboarding and setup: record it as dismissed and go straight to the request.\n\nRequest: `
  );
}

export function createEdgeAgentBridge(app: Pick<App, "turn">, hub: EdgeHub): EdgeAgentBridge {
  const primed = new Set<string>();
  const pending = new Map<string, number>();
  const queues = new Map<string, Promise<void>>();

  const post = (projectId: string, actor: EdgeActor, action: string, text: string, label: string): void => {
    try {
      hub.submit(projectId, actor, null, {
        id: randomUUID(),
        protocolVersion: EDGE_PROTOCOL_VERSION,
        projectId,
        actorId: actor.id,
        adapter: "edge",
        resourceType: "Message",
        resourceId: randomUUID(),
        action,
        effect: "none",
        payload: { text: text.replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, " ").slice(0, 4000) },
        label: flat(label, 160),
        clientTimestamp: Date.now(),
      });
    } catch (e) {
      swallow("edge room: post message", e);
    }
  };

  return {
    ask({ projectId, name, text }) {
      const slug = slugOf(name);
      const displayName = flat(name, 40);
      const human: EdgeActor = { id: `web:${slug}`, displayName, type: "human" };
      const agent: EdgeActor = { id: `qm-agent:edge-${slug}`, displayName: `${displayName}'s agent`, type: "agent" };
      const waiting = pending.get(slug) ?? 0;
      if (waiting >= MAX_PENDING) {
        throw new EdgeProtocolError("rate_limited", `${agent.displayName} already has ${MAX_PENDING} requests queued`);
      }
      pending.set(slug, waiting + 1);
      hub.nameActor(agent.id, agent.displayName);
      post(projectId, human, "ask", text, `asked their agent: "${flat(text, 120)}"`);
      const run = async (): Promise<void> => {
        hub.touchActor(projectId, agent, { label: `working on: ${flat(text, 100)}` });
        let reply: string;
        try {
          const first = !primed.has(slug);
          const result = await app.turn({
            surface: "edge-room",
            actor: { externalId: `edge-${slug}` },
            conversation: { kind: "dm", threadRef: `edge-room-${slug}` },
            text: first ? preamble(displayName, projectId) + text : text,
          });
          primed.add(slug);
          reply = result.reply?.trim() || `(${result.status})`;
        } catch (e) {
          reply = `I couldn't finish that: ${errMessage(e)}`;
        }
        post(projectId, agent, "reply", reply, `replied: "${flat(reply, 130)}"`);
        hub.touchActor(projectId, agent, null);
        pending.set(slug, Math.max(0, (pending.get(slug) ?? 1) - 1));
      };
      const next = (queues.get(slug) ?? Promise.resolve()).then(run, run);
      queues.set(slug, next);
      return { agent: agent.displayName };
    },
  };
}
