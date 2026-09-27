import { randomBytes } from "node:crypto";
import { edgeProjectId } from "./protocol.ts";

export interface EdgeConfig {
  enabled: boolean;
  joinToken: string;
  joinTokenGenerated: boolean;
  defaultProject: string;
  historyLimit: number;
  journalDir: string | null;
}

export const EDGE_WS_PATH = "/edge/ws";
export const EDGE_DEFAULT_PORT = 8787;

function generateJoinToken(): string {
  return randomBytes(5).toString("hex");
}

export function parseEdgeEnv(env: Record<string, string | undefined>, opts: { enabledByDefault: boolean }): EdgeConfig {
  const flag = env.EDGE_ENABLED?.trim().toLowerCase();
  const enabled = flag === undefined || flag === "" ? opts.enabledByDefault : ["1", "true", "yes", "on"].includes(flag);
  const configuredToken = env.EDGE_JOIN_TOKEN?.trim();
  if (configuredToken !== undefined && configuredToken !== "" && configuredToken.length < 4) {
    throw new Error("EDGE_JOIN_TOKEN must be at least 4 characters");
  }
  const project = env.EDGE_PROJECT?.trim() || "unity-demo";
  if (!edgeProjectId.safeParse(project).success) throw new Error(`EDGE_PROJECT is not a valid project id: ${project}`);
  const historyLimit = Number(env.EDGE_HISTORY_LIMIT?.trim() || 2000);
  if (!Number.isInteger(historyLimit) || historyLimit < 100)
    throw new Error("EDGE_HISTORY_LIMIT must be an integer >= 100");
  return {
    enabled,
    joinToken: configuredToken || generateJoinToken(),
    joinTokenGenerated: !configuredToken,
    defaultProject: project,
    historyLimit,
    journalDir: env.EDGE_JOURNAL_DIR?.trim() || null,
  };
}
