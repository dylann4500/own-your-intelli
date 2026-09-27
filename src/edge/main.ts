import { errMessage } from "../util/errors.ts";
import { edgeBanner } from "./banner.ts";
import { EDGE_DEFAULT_PORT, parseEdgeEnv } from "./config.ts";
import { createConfiguredEdgeHub } from "./runtime.ts";
import { createEdgeServer } from "./server.ts";

function main(): void {
  const config = parseEdgeEnv(process.env, { enabledByDefault: true });
  const port = Number(process.env.EDGE_PORT ?? process.env.PORT ?? EDGE_DEFAULT_PORT);
  const host = process.env.EDGE_HOST ?? "0.0.0.0";
  const hub = createConfiguredEdgeHub(config);
  const { server, websocket } = createEdgeServer(hub);
  server.on("error", (e) => {
    console.error(`QM Edge failed to listen on ${host}:${port}: ${errMessage(e)}`);
    process.exit(1);
  });
  server.listen(port, host, () => {
    console.log(
      edgeBanner({
        port,
        project: config.defaultProject,
        joinToken: config.joinToken,
        generated: config.joinTokenGenerated,
      }),
    );
    if (config.journalDir)
      console.log(`Journal:    ${config.journalDir} (restored sequence ${hub.latestSequence(config.defaultProject)})`);
  });
  const shutdown = (): void => {
    websocket.close();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2000).unref();
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main();
