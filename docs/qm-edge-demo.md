# QM Edge: four-Mac demo

This guide runs one Edge hub and four Edge Nodes (Macs A–D) on the same Wi-Fi, then walks through six tests: humans in Unity, and a QM agent through the `qm-edge` CLI. If Unity is not ready, the [fallback demo](#no-unity-fallback-demo) runs every test with fake nodes and the dashboard.

For how it works, see [qm-edge-architecture.md](qm-edge-architecture.md). For the spoken script, see [qm-edge-pitch.md](qm-edge-pitch.md).

## Prerequisites

On every Mac:

- **Node ≥ 24** (`package.json` requires `>=24.15.0`) and a checkout of this repo. Run `npm ci` once.
- **The same network.** Every Mac joins the same Wi-Fi. Guest networks often block device-to-device traffic, so avoid them.
- **The same Unity project and the same saved scene.** That scene must contain a GameObject named **`Cube`** and a Light named **`Main Light`**. Also add a GameObject named **`Player`** (for example a Capsule), so the agent line "Create three cubes around the player" resolves to a real object. Copy the project the same way to every Mac, open the scene, and **save** it before connecting. Baseline objects are matched by `GlobalObjectId`, so every Mac has to start from identical scene files. QM Edge does not copy projects or assets.
- Only the hub Mac needs Docker, and only for Option B (the hub inside QM core, which the in-QM agent in Test 5 needs). Docker Desktop, OrbStack or colima all work.

## 1. Start the hub (one Mac)

Choose one of the two setups.

### Option A: standalone hub (simplest)

```bash
EDGE_JOIN_TOKEN=demo-2468 EDGE_PORT=8787 npm run edge:dev
```

- Pin `EDGE_JOIN_TOKEN`. Without it a new random token is generated at each start and every node has to re-enter it.
- Set `EDGE_PORT` explicitly. `edge:dev` loads `.env`, and if `.env` sets `PORT` for QM core, the hub would otherwise listen there.
- Add `EDGE_JOURNAL_DIR=data/edge-journal` to keep state across hub restarts (`data/` is git-ignored). The banner then adds `Journal:    data/edge-journal (restored sequence N)`.

The banner looks like this:

```
QM Edge running

HTTP:      http://localhost:8787/edge/health
Dashboard: http://localhost:8787/edge#token=demo-2468
WebSocket: ws://localhost:8787/edge/ws
LAN:       ws://192.168.1.23:8787/edge/ws

Project:    unity-demo
Join token: demo-2468

Agent CLI:  QM_EDGE_URL=http://localhost:8787 QM_EDGE_TOKEN=demo-2468 npm run qm-edge -- status
```

Write down the **LAN** line (`ws://<hub-ip>:8787/edge/ws`) and the join token. Every node uses them.

### Option B: hub inside QM core (needed for Test 5 through QM)

One command starts QM core with Edge enabled and a local Docker sandbox that already has the `qm-edge` CLI:

```bash
EDGE_JOIN_TOKEN=demo-2468 npm run edge:qm
```

`npm run edge:qm` (`scripts/edge-demo-core.sh`) does this:

- Checks that Docker is running. If it is not, it starts colima when that is installed, and otherwise exits.
- Builds the sandbox image once with `npm run edge:sandbox:build` if `qm-sandbox-local:latest` does not exist yet.
- Creates `CORE_SIGNING_SECRET` in `data/edge-demo-secret` (git-ignored) unless you set one.
- Sets `EDGE_ENABLED=1`, `EDGE_JOIN_TOKEN` (default `edge-demo`), `EDGE_PROJECT` (default `unity-demo`), `PORT` (default `8080`), `HARNESS` (default `codex`), `SANDBOX_BACKEND=local`, and `PUBLIC_API_URL=http://host.docker.internal:<PORT>` so the sandbox can reach core.
- Prints the port, project, join token and dashboard link (`==> dashboard http://localhost:8080/edge#token=…`), then runs `node --env-file-if-exists=.env src/index.ts`. Values from the command line and the script win over `.env`, so a `PORT` or `HARNESS` in `.env` is ignored. Pass them on the command line instead, for example `PORT=9090 HARNESS=pi npm run edge:qm`.

The natural-language agent uses the `HARNESS` login on the hub Mac, for example `~/.codex/auth.json` for the default `codex`. Set `HARNESS=…` to use another harness you have set up.

Core then prints its usual `[qm] listening on :8080 …` line and the Edge banner under the heading `QM Edge enabled in QM core`. With a pinned token, core's banner shows `<EDGE_JOIN_TOKEN>` in place of the token (use the script's `==>` lines for the real link), and warns if the token is shorter than 16 characters. The warning is harmless on a LAN demo. The node URL is `ws://<hub-ip>:8080/edge/ws`.

On that port, core serves:

- the node WebSocket `/edge/ws`
- `/edge/health`
- the `/edge` dashboard page
- the join-token REST API `/edge/v1/*`
- the capability-authenticated agent routes `/v1/edge/*`

To start core by hand instead, put `EDGE_ENABLED=1`, `EDGE_JOIN_TOKEN`, a `CORE_SIGNING_SECRET` of at least 32 characters and `PUBLIC_API_URL=http://host.docker.internal:8080` in `.env`, build the sandbox image (see Test 5), and run `npm run dev`. Without `PUBLIC_API_URL`, the sandbox gets no `AGENT_API_URL`, and `qm-edge` inside QM fails with `cannot reach QM Edge at http://127.0.0.1:8787/edge/v1`. When `EDGE_ENABLED` is off, core ignores every other `EDGE_*` variable.

> A QM agent reaches the hub _inside the core process_. If you want an agent in Test 5, Unity nodes must connect to **core's** port, not a separate standalone hub.

Check the hub from another Mac: `curl http://<hub-ip>:8787/edge/health` (port 8080 for Option B) should return `{"ok":true,"service":"qm-edge",...}`.

## 2. Connect each Unity Editor (Macs A–D)

> The Unity package is not covered by the Node test suite. Do a dry run on two Macs before the real demo, and keep the [fallback demo](#no-unity-fallback-demo) ready.

1. In Unity: **Window > Package Manager > + > Add package from disk…** and select `adapters/unity/com.qm.edge/package.json` from this repo.
2. Open **Window > QM Edge**.
3. Fill in the fields:
   - **Hub URL:** `ws://<hub-ip>:8787/edge/ws` (Option A) or `ws://<hub-ip>:8080/edge/ws` (Option B)
   - **Project ID:** `unity-demo`
   - **Display name:** `Dylan`, `Aiden`, … (this is what the timeline shows)
   - **Actor ID:** leave the generated value. It must be unique per person.
   - **Join token:** `demo-2468`
4. Click **Connect**. The window shows **CONNECTED**, the peers list, and recent events such as `#31 Dylan moved Cube (x12)`.

These settings, including the join token in plain text, are stored in `EditorPrefs`, and each Mac keeps its own stable node id per project. Unity reconnects by itself after script reloads, restarts and network drops (after 1, 2, 5, then 10 s) until you press **Disconnect**. A hub error on `hello` or `joinProject`, such as a wrong join token, or a protocol version mismatch stops the retries. Fix the field and press **Connect** again.

Presence follows your Selection: selecting `Cube` shows you as "working on Cube" to everyone.

Edits made while disconnected are not pushed on reconnect; the hub's state wins. Edits that were in flight when the connection dropped, or that the hub rejected as `rate_limited`, are sent again.

## 3. Open the dashboard

In a browser on any Mac, open `http://<hub-ip>:8787/edge#token=demo-2468` (`:8080` for Option B). For another project, add `&project=<id>` and reload the page, or type it into the Project field. The page reads the URL fragment only when it loads.

The dashboard polls about every 0.7 s and shows three panels:

- **Presence:** humans in blue, agents in purple, online/offline, device, "working on …"
- **Event stream:** repeated drags of the same object by the same actor are merged into one row with a count
- **Live resources**

## Tests

Run these in order. "Everywhere" means the other three Macs and the dashboard.

### Test 1: Mac A moves the Cube → B, C and D update

Drag `Cube` in the Scene view on Mac A. It moves on B, C and D while you drag. The event stream shows `Dylan moved Cube`.

### Test 2: Mac B changes Main Light intensity → A, C and D update

Select `Main Light` on Mac B and change **Intensity** in the Inspector. The light changes on A, C and D. The event stream shows `Aiden changed Main Light intensity to …`.

### Test 3: Mac C creates a Sphere → it appears everywhere

On Mac C: **GameObject > 3D Object > Sphere**. The Sphere appears on A, B and D with the same name and transform. It gets a `QmEdgeIdentity` component that holds its Edge UUID.

### Test 4: Mac D deletes the Sphere → it disappears everywhere

Select the Sphere on Mac D and press Delete. It disappears on A, B and C.

### Test 5: the QM agent creates an object → it appears in every Unity Editor

**Direct CLI.** This works with either hub option, from any Mac on the network:

```bash
export QM_EDGE_URL=http://<hub-ip>:8787 QM_EDGE_TOKEN=demo-2468   # Option B: port 8080
npm run qm-edge -- status
npm run qm-edge -- objects
npm run qm-edge -- create --primitive Cube --name AgentCube --x 2 --y 1 --z 0
npm run qm-edge -- move --object AgentCube --x -2          # omitted axes keep their value
npm run qm-edge -- set --object "Main Light" --property intensity --value 2
npm run qm-edge -- delete --object AgentCube
```

Every write prints `committed #<seq> QM Agent (agent) …` and shows up in every connected editor. In direct mode the actor defaults to `qm-agent` / `QM Agent` / `agent`. Override it with `QM_EDGE_ACTOR_ID`, `QM_EDGE_ACTOR_NAME` and `QM_EDGE_ACTOR_TYPE`. Ids starting with `qm-agent:` or `qm-user:` are reserved for QM core and are refused (`403 actor_mismatch`).

**Inside QM through `execute`** (Option B only):

1. The sandbox image needs the CLI. `npm run edge:qm` builds it the first time. To build it yourself, pick one:
   ```bash
   npm run edge:sandbox:build      # quick: bundles the CLI, then builds a light qm-sandbox-local:latest from local/edge-demo.Dockerfile
   # or the full sandbox image:
   npm run edge:build-cli          # writes fly/tools/qm-edge
   npm run sandbox:local:build     # rebuilds qm-sandbox-local:latest from fly/Dockerfile + local/Dockerfile
   ```
   Both images install the bundle as `/usr/local/bin/qm-edge`. For non-local sandbox providers, rebuild that provider's image instead.
2. Open the agent console in a second terminal on the hub Mac:
   ```bash
   npm run edge:agent
   ```
   It talks to `QM_CORE_URL` (default `http://127.0.0.1:8080`), signs with `CORE_SIGNING_SECRET` or `data/edge-demo-secret`, and adds a short QM Edge briefing to your first message (project from `EDGE_PROJECT`, default `unity-demo`).
   - The first turn from a new user can get a one-time "how should I sound?" question instead of an answer. Send `skip setup` (or pick a style) before the demo.
   - A line starting with `!` goes to QM as-is. For example `!run qm-edge objects` runs the command through `execute` without the model.
3. Ask: _"Create three cubes around the player."_ The agent runs `qm-edge objects`, then three `qm-edge create …` commands through `execute`, and the cubes appear in every editor.
4. Inside the sandbox the CLI finds `AGENT_API_URL` + `AGENT_API_TOKEN` and calls QM core `/v1/edge/*` with its capability token. Core records the edit as `QM Agent` (`agent`, actor id `qm-agent:<user>`), ignores any actor or `nodeId` the agent sends, and refuses writes to a project that no editor has joined yet (`404 unknown_project`; the `EDGE_PROJECT` project always exists). The traffic path is agent → QM core → hub, never sandbox → LAN. That matters because QM's default `auto` posture blocks private-network egress from cloud sandboxes, except to the core host. (The local Docker sandbox enforces no egress rules.)
5. Under the `strict` security posture, core refuses agent writes.

### Test 6: presence and activity, with humans and the agent attributed separately

```bash
npm run qm-edge -- peers     # e.g.  Dylan — human — Unity — Dylan's MacBook — online — working on Cube
npm run qm-edge -- events    # e.g.  #12  Dylan  human  moved Cube  (x40)
                             #       #13  QM Agent  agent  created Cube AgentCube
npm run qm-edge -- events --raw --limit 50   # every operation, not merged
```

The dashboard shows the same data. Each Mac appears once per `(actor, node)` pair. The agent appears as a separate `agent` member, and stays online for 5 minutes after its last call.

## No Unity? Fallback demo

`npm run edge:fake-client` is an interactive Edge Node. It uses the same client (`EdgeNodeSession`) and the same `unity` vocabulary as the real adapter, on an in-memory scene that starts with `Cube` at (0, 0.5, 0), `Player` (a Capsule) at (0, 1, -3) and `Main Light` at intensity 1. Run one on each Mac (use port 8080 for Option B):

```bash
npm run edge:fake-client -- --url ws://<hub-ip>:8787/edge/ws --token demo-2468 --name Aiden
# options: --project <id> (default unity-demo); env fallbacks QM_EDGE_WS_URL, QM_EDGE_TOKEN, QM_EDGE_PROJECT
```

Commands at the `edge>` prompt:

| Command                             | Effect                                                             |
| ----------------------------------- | ------------------------------------------------------------------ |
| `scene`                             | Print this node's local scene                                      |
| `move <object> x y z`               | Move an object by name, e.g. `move Cube 3 0.5 0`                   |
| `drag <object>`                     | Simulate a 2 s drag: 30 moves at about 15 Hz                       |
| `intensity <object> <value>`        | Set light intensity, e.g. `intensity Main Light 2.5`               |
| `create <Primitive> <name> [x y z]` | e.g. `create Sphere Ball 1 1 1`. The default position is (0, 1, 0) |
| `delete <object>`                   | Delete by name                                                     |
| `peers` / `events`                  | Presence, and the last 15 events                                   |
| `help` / `quit`                     |                                                                    |

The fallback versions of Tests 1–6:

1. Mac A: `drag Cube`
2. Mac B: `intensity Main Light 2.5`
3. Mac C: `create Sphere Sphere 1 1 1`
4. Mac D: `delete Sphere`
5. Run the `qm-edge create …` commands from above, or ask the QM agent (Option B).
6. Run `peers` and `events`, and open the dashboard.

Other nodes print `<- #N Name (human) …` as each operation arrives.

**Project ids.**

- A fake-only demo can use the default `unity-demo`.
- If fake nodes join a hub where Unity nodes are also connected, give the fakes their own project (`--project fake-demo`). Also pass `--project fake-demo` to `qm-edge`, or set `QM_EDGE_PROJECT`, and set the dashboard's project field. Fake baseline ids (`baseline-cube`, `baseline-player`, `baseline-main-light`) never match Unity `GlobalObjectId`s, so the two kinds of node would not share a Cube.
- The QM agent console briefs the agent on `EDGE_PROJECT` (default `unity-demo`). For another project, start it with `EDGE_PROJECT=fake-demo npm run edge:agent`.

## Troubleshooting (macOS)

| Symptom                                                                         | Fix                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Nodes cannot connect, but `localhost` works on the hub Mac                      | The macOS firewall is blocking it. Go to **System Settings > Network > Firewall > Options** and allow incoming connections for `node`, or turn the firewall off for the demo. Test with `curl http://<hub-ip>:8787/edge/health` from another Mac                                                                                                                                                                      |
| Which IP?                                                                       | On the hub Mac, run `ipconfig getifaddr en0` (Wi-Fi on most Macs) or `ipconfig getifaddr en1`. The banner's `LAN:` line lists the addresses it detected                                                                                                                                                                                                                                                               |
| Health check times out from other Macs                                          | The Macs must be on the same network. Guest or corporate Wi-Fi often has client isolation, so use a phone hotspot or a normal home or office network. VPNs can also get in the way                                                                                                                                                                                                                                    |
| Objects do not line up / edits to `Cube` do not arrive                          | The scene baselines differ. Every Mac must open the same **saved** scene (same `GlobalObjectId`s). Save the scene before connecting. Unsaved or re-created objects get different ids                                                                                                                                                                                                                                  |
| "Invalid URL" or no connection                                                  | The URL must be `ws://` (not `http://`), include the path `/edge/ws`, and use the right port: 8787 standalone, core's `PORT` (default 8080) in Option B                                                                                                                                                                                                                                                               |
| Unity shows nothing                                                             | Check the Unity Console for warnings starting with `[QM Edge]`, such as `hub rejected joinProject (unauthorized): …` or `… reconnecting in Ns`. After `unauthorized` Unity stops retrying: fix the token and press **Connect**                                                                                                                                                                                        |
| `unauthorized: join token is invalid`, or the dashboard says "wrong join token" | The token does not match `EDGE_JOIN_TOKEN`. If you did not pin it, the hub made a new one at restart, so check the banner                                                                                                                                                                                                                                                                                             |
| Everything vanished after the hub restarted                                     | State is in memory unless `EDGE_JOURNAL_DIR` is set. Without a journal, the sequence restarts at 0 and reconnecting nodes skip operations at or below the last sequence they saw. Reopen the saved scene in Unity and reconnect. Unity adopts the new hub sequence when it joins. **Quit and rerun fake clients**, because they keep the old sequence: they still print `<- #N …` for new edits but do not apply them |
| `rate_limited: too many operations per second`                                  | Each connection may commit 120 ops/s. Throttle drags, which the fake client does at about 15 Hz                                                                                                                                                                                                                                                                                                                       |
| Hub fails to start with `EADDRINUSE`                                            | Something else is using the port. Set `EDGE_PORT` (Option A) or `PORT` (Option B) to a free port and update the node URLs                                                                                                                                                                                                                                                                                             |
| `qm-edge: cannot reach QM Edge at …`                                            | Check `QM_EDGE_URL`. It is `http://<hub-ip>:<port>` with no `/edge` suffix. If the agent inside QM reports `cannot reach QM Edge at http://127.0.0.1:8787/edge/v1`, core was started without `PUBLIC_API_URL`, so the sandbox got no `AGENT_API_URL`. Use `npm run edge:qm`, or set `PUBLIC_API_URL=http://host.docker.internal:<PORT>`                                                                               |
| `npm run edge:qm` says Docker is not running                                    | Start Docker Desktop or OrbStack, or `brew install colima docker && colima start`                                                                                                                                                                                                                                                                                                                                     |
| The agent console answers with a "how should I sound?" question                 | It is a one-time setup question for a new user. Reply `skip setup` (or pick a style), then send the real prompt                                                                                                                                                                                                                                                                                                       |
| `no live object named 'X'`                                                      | Run `qm-edge objects` to see the exact names. Baseline objects only appear after a node has connected and announced them                                                                                                                                                                                                                                                                                              |

## Automated tests

```bash
node --experimental-test-module-mocks --test test/edge-hub.test.ts test/edge-node.test.ts test/edge-core-routes.test.ts test/edge-qm-execute.test.ts
```

37 tests, about 6 s, no Docker or Postgres needed.

What they cover:

- **`edge-hub.test.ts`**
  - protocol validation and version checks
  - join and token checks, presence
  - ordering, dedupe, per-property LWW
  - agent attribution and actor forgery
  - history and truncation
  - reconnection catch-up
  - baseline precedence
  - rate limiting
  - journal restore
- **`edge-node.test.ts`**
  - remote loop prevention
  - four-node convergence
  - concurrent writes
  - late joiners and reconnects
  - the `qm-edge` CLI
- **`edge-core-routes.test.ts`**
  - capability auth on `/v1/edge/*`
  - streaming agent operations to WebSocket clients
  - rejecting forged actors
  - portal-identity attribution
  - join-token REST, the `/edge` dashboard and `edge_disabled` behaviour inside QM core
  - dropping a client-sent `nodeId`, refusing writes to unjoined projects and while impersonating
  - reserved `qm-agent:` / `qm-user:` actor ids on the join-token API and the WebSocket
  - `EDGE_*` parsing inside core
- **`edge-qm-execute.test.ts`**
  - a QM agent turn runs `qm-edge` through `execute` with its capability token, and a connected node sees the agent's edits
