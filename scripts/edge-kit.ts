import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { networkInterfaces } from "node:os";
import { join, resolve } from "node:path";
import { build } from "esbuild";

function lanAddress(): string {
  for (const [name, entries] of Object.entries(networkInterfaces())) {
    if (name.startsWith("utun") || name.startsWith("bridge") || name.startsWith("docker")) continue;
    for (const entry of entries ?? []) if (entry.family === "IPv4" && !entry.internal) return entry.address;
  }
  return "127.0.0.1";
}

const host = process.env.EDGE_PUBLIC_HOST || lanAddress();
const port = process.env.EDGE_PORT || process.env.PORT || "8080";
const token = process.env.EDGE_JOIN_TOKEN;
const project = process.env.EDGE_PROJECT || "unity-demo";
const kitPort = process.env.EDGE_KIT_PORT || "8000";
const out = resolve(process.env.EDGE_KIT_DIR || "data/edge-kit");

if (!token) {
  console.error("Set EDGE_JOIN_TOKEN to the hub's join token.");
  process.exit(1);
}

const wsUrl = `ws://${host}:${port}/edge/ws`;
const httpUrl = `http://${host}:${port}`;
const dashboard = `${httpUrl}/edge#token=${token}`;

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

await build({
  entryPoints: ["scripts/edge-fake-client.ts"],
  outfile: join(out, "qm-edge-node.mjs"),
  bundle: true,
  platform: "node",
  target: "node22",
  format: "esm",
  legalComments: "none",
  logLevel: "warning",
});
await build({
  entryPoints: ["src/edge/cli.ts"],
  outfile: join(out, "qm-edge.cjs"),
  bundle: true,
  platform: "node",
  target: "node22",
  format: "cjs",
  define: { "import.meta.main": "true" },
  legalComments: "none",
  logLevel: "warning",
});
execFileSync("zip", ["-qr", join(out, "com.qm.edge.zip"), "com.qm.edge", "-x", "*.DS_Store"], {
  cwd: resolve("adapters/unity"),
});

const esc = (value: string): string =>
  value.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c);

const code = (text: string): string =>
  `<div class="code"><pre>${esc(text)}</pre><button onclick="copy(this)">Copy</button></div>`;

const nodeCommand = `node ~/Downloads/qm-edge-node.mjs --url ${wsUrl} --token ${token} --project ${project} --empty --name "YOUR NAME"`;
const cliCommand = `QM_EDGE_URL=${httpUrl} QM_EDGE_TOKEN=${token} QM_EDGE_ACTOR_ID=my-agent QM_EDGE_ACTOR_NAME="YOUR NAME's agent" node ~/Downloads/qm-edge.cjs objects`;

const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Join QM Edge</title>
<style>
  :root { --bg:#0e1116; --panel:#161b22; --line:#2a313c; --text:#e6edf3; --muted:#8b949e; --accent:#58a6ff; --agent:#d2a8ff; }
  * { box-sizing:border-box; }
  body { margin:0; background:var(--bg); color:var(--text); font:16px/1.55 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
  main { max-width:860px; margin:0 auto; padding:28px 16px 64px; }
  h1 { font-size:28px; margin:0 0 4px; }
  h2 { font-size:19px; margin:34px 0 10px; }
  p, li { color:var(--text); }
  .muted { color:var(--muted); }
  .facts { display:grid; grid-template-columns:max-content 1fr; gap:6px 16px; background:var(--panel); border:1px solid var(--line); border-radius:10px; padding:14px 16px; margin:18px 0; }
  .facts b { color:var(--muted); font-weight:500; }
  code, pre { font:13.5px ui-monospace, SFMono-Regular, Menlo, monospace; }
  .code { position:relative; background:#0b0d11; border:1px solid var(--line); border-radius:8px; margin:10px 0; }
  .code pre { margin:0; padding:12px 70px 12px 12px; white-space:pre-wrap; word-break:break-all; }
  .code button { position:absolute; top:8px; right:8px; }
  button, .btn { background:var(--panel); color:var(--text); border:1px solid var(--line); border-radius:6px; padding:5px 10px; font:inherit; font-size:13px; cursor:pointer; text-decoration:none; display:inline-block; }
  .btn.primary { border-color:var(--accent); color:var(--accent); }
  ol li { margin:8px 0; }
  .card { background:var(--panel); border:1px solid var(--line); border-radius:10px; padding:4px 18px 12px; margin:14px 0; }
  a { color:var(--accent); }
</style>
</head>
<body>
<main>
  <h1>Join QM Edge</h1>
  <p class="muted">Live, shared scene state between Macs and QM agents. Your Mac must be on the same Wi-Fi as the hub.</p>
  <div class="facts">
    <b>Hub</b><code>${esc(wsUrl)}</code>
    <b>Project</b><code>${esc(project)}</code>
    <b>Join token</b><code>${esc(token)}</code>
    <b>Live dashboard</b><a href="${esc(dashboard)}">${esc(`${httpUrl}/edge`)}</a>
  </div>

  <h2>Option A: with Unity</h2>
  <div class="card">
  <ol>
    <li>You need the Unity Editor (2021.3 LTS or newer, including Unity 6) via Unity Hub. Any 3D project works; you do <b>not</b> need a copy of anyone else's project.</li>
    <li>Download the package: <a class="btn primary" href="com.qm.edge.zip" download>com.qm.edge.zip</a><br>
      Unzip it and move the <code>com.qm.edge</code> folder somewhere permanent, e.g. <code>~/qm-edge/com.qm.edge</code>. Safari may unzip it for you in Downloads.</li>
    <li>In Unity: <b>File &rarr; New Scene</b> (Basic or Empty; no need to save).</li>
    <li><b>Window &rarr; Package Manager</b> &rarr; <b>+</b> &rarr; <b>Add package from disk&hellip;</b> &rarr; select <code>com.qm.edge/package.json</code>.</li>
    <li><b>Window &rarr; QM Edge</b>. Fill in:
      <ul>
        <li>Hub URL: <code>${esc(wsUrl)}</code></li>
        <li>Project ID: <code>${esc(project)}</code></li>
        <li>Display name: your name</li>
        <li>Join token: <code>${esc(token)}</code></li>
      </ul>
      Press <b>Connect</b>. The window shows <b>CONNECTED</b>, the other people, and recent events. <b>Ground</b>, <b>Cube</b>, <b>Player</b> and <b>Main Light</b> appear in your Hierarchy.</li>
    <li>Try it: drag the Cube, change Main Light &rarr; Light &rarr; Intensity, add <b>GameObject &rarr; 3D Object &rarr; Sphere</b>, delete it. Everyone sees it live.</li>
  </ol>
  </div>

  <h2>Option B: no Unity (terminal node)</h2>
  <div class="card">
  <ol>
    <li>You need Node.js 22 or newer. Check with <code>node -v</code> in Terminal; if missing, install the LTS from <a href="https://nodejs.org">nodejs.org</a> or run <code>brew install node</code>.</li>
    <li>Download <a class="btn primary" href="qm-edge-node.mjs" download>qm-edge-node.mjs</a> (one file, no install).</li>
    <li>In Terminal (replace YOUR NAME):
      ${code(nodeCommand)}</li>
    <li>Type commands at the <code>edge&gt;</code> prompt:
      ${code("scene\nmove Cube 3 0.5 1\ndrag Cube\nintensity Main Light 3\ncreate Sphere Ball 0 1 0\ndelete Ball\npeers\nevents")}</li>
  </ol>
  </div>

  <h2>Optional: act as an agent from your Mac</h2>
  <div class="card">
  <p>Download <a class="btn" href="qm-edge.cjs" download>qm-edge.cjs</a>, the same CLI QM agents use, then:</p>
  ${code(cliCommand)}
  <p class="muted">Swap <code>objects</code> for <code>create --primitive Cube --name MyCube --x 2 --y 1 --z 0</code>, <code>move --object Cube --x 5</code>, <code>set --object "Main Light" --property intensity --value 2</code>, <code>peers</code> or <code>events</code>.</p>
  </div>

  <h2>If something is off</h2>
  <ul>
    <li><b>Can't connect / this page won't load:</b> make sure you are on the same Wi-Fi as the hub (guest networks often block device-to-device traffic; a phone hotspot works).</li>
    <li><b>"invalid join token":</b> re-type the token above exactly, then press Connect again.</li>
    <li><b>Unity shows errors prefixed [QM Edge]:</b> open Window &rarr; QM Edge to see the last error; Disconnect then Connect.</li>
    <li>The URL starts with <code>ws://</code>, not <code>http://</code>, and ends with <code>/edge/ws</code>.</li>
    <li><b>The hub was restarted and you see duplicate objects:</b> Unity: Disconnect, <b>File &rarr; New Scene</b>, Connect. Terminal node: quit and run the command again.</li>
  </ul>
</main>
<script>
function copy(button) {
  var text = button.previousElementSibling.textContent;
  var done = function () { button.textContent = "Copied"; setTimeout(function () { button.textContent = "Copy"; }, 1200); };
  if (navigator.clipboard && window.isSecureContext) navigator.clipboard.writeText(text).then(done);
  else { var t = document.createElement("textarea"); t.value = text; document.body.appendChild(t); t.select(); document.execCommand("copy"); t.remove(); done(); }
}
</script>
</body>
</html>
`;

writeFileSync(join(out, "index.html"), html);
console.log(`QM Edge kit written to ${out}`);
console.log(`Share this link with people on the same Wi-Fi: http://${host}:${kitPort}/`);
