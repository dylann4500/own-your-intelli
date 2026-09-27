import { chmodSync } from "node:fs";
import { build } from "esbuild";

const outfile = process.argv[2] ?? "fly/tools/qm-edge";

await build({
  entryPoints: ["src/edge/cli.ts"],
  outfile,
  bundle: true,
  platform: "node",
  target: "node22",
  format: "cjs",
  define: { "import.meta.main": "true" },
  legalComments: "none",
  logLevel: "warning",
});
chmodSync(outfile, 0o755);
console.log(`built ${outfile}`);
