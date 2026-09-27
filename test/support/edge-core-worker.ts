import { parentPort, workerData } from "node:worker_threads";
import { createServer } from "../../src/api/server.ts";
import { createConfiguredEdgeHub } from "../../src/edge/runtime.ts";
import { buildApp } from "../../src/wiring.ts";
import { testConfig } from "./test-config.ts";

const { port, secret, joinToken } = workerData as { port: number; secret: string; joinToken: string };
const config = testConfig({
  signingSecret: secret,
  capabilitySecret: secret,
  apiBaseUrl: `http://127.0.0.1:${port}`,
  edge: {
    enabled: true,
    joinToken,
    joinTokenGenerated: false,
    defaultProject: "unity-demo",
    historyLimit: 2000,
    journalDir: null,
  },
});
const built = buildApp(config);
const edgeHub = createConfiguredEdgeHub(config.edge);
const server = createServer(built.app, { signingSecret: secret, capabilitySecret: secret, edgeHub });
server.listen(port, "127.0.0.1", () => parentPort?.postMessage("ready"));
parentPort?.on("message", (message) => {
  if (message !== "close") return;
  server.closeAllConnections();
  server.close(() => parentPort?.postMessage("closed"));
});
