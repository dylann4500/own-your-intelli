# QM Edge: 60–90 second demo script

Setup and troubleshooting are in [qm-edge-demo.md](qm-edge-demo.md). Architecture is in [qm-edge-architecture.md](qm-edge-architecture.md).

## Pre-flight checklist (T-15 min)

- [ ] Every Mac is on the same Wi-Fi (not a guest network). The hub IP comes from `ipconfig getifaddr en0`.
- [ ] The hub is running with a pinned token.
  - For the agent beat, run it inside QM core: `EDGE_JOIN_TOKEN=demo-2468 npm run edge:qm` (port 8080, needs Docker).
  - Otherwise run `EDGE_JOIN_TOKEN=demo-2468 EDGE_PORT=8787 npm run edge:dev`.
  - Add `EDGE_JOURNAL_DIR=data/edge-journal` if you want state to survive a restart.
- [ ] From every Mac, `curl http://<hub-ip>:<port>/edge/health` returns `"ok":true`. If it does not, allow `node` through the macOS firewall.
- [ ] Every Mac has the **same saved scene** open, with `Cube`, `Player` and `Main Light` in it. Nothing is dirty.
- [ ] Every Unity Editor shows **Window > QM Edge** connected, with display names set (Dylan, Aiden, …).
- [ ] `npm run qm-edge -- peers` lists every Mac as `<name> — human — Unity — <device> — online`.
- [ ] Dashboard is open on the presenter screen at `http://<hub-ip>:<port>/edge#token=demo-2468`. Both hub options serve it.
- [ ] The QM agent console (`npm run edge:agent`) is open on the hub Mac. Warm it up with one request (for example `How many objects are in the scene?`) and check that `!run qm-edge status` succeeds. `npm run edge:qm` builds the sandbox image with the CLI the first time.
- [ ] Clean up practice objects with `qm-edge delete --object …`, or restart the hub and reopen the saved scene everywhere.
- [ ] The fake-node terminals for the backup plan are pre-typed in a second terminal tab on each Mac.

## Script

| Time     | On screen                                                 | Say / do                                                                                                                                                                                                                                                                                                                                                                                             |
| -------- | --------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **0:00** | 3–4 MacBooks side by side, each with the same Unity scene | "These are independent local Unity Editors. Normally Git is how we move durable project state between them."                                                                                                                                                                                                                                                                                         |
| **0:10** | Mac A                                                     | Drag the **Cube**. It moves on every other Mac as you drag. "Dylan moves the Cube, and every editor follows live. We're not syncing files, we're syncing the edit."                                                                                                                                                                                                                                  |
| **0:22** | Mac B                                                     | Change **Main Light > Intensity**. Every scene brightens. "Aiden changes the light. Same thing, different person, different machine."                                                                                                                                                                                                                                                                |
| **0:32** | Dashboard, Presence panel (or `qm-edge peers`)            | "Everyone here is present in the project. We can see who's online, on which machine, and what they're touching."                                                                                                                                                                                                                                                                                     |
| **0:40** | QM agent console (`npm run edge:agent`)                   | Type the agent prompt below. The agent runs `qm-edge objects`, then three `qm-edge create` commands. Three cubes appear in every editor. "The agent works in the same live world as the people. It isn't a copy or a screenshot. It's the same state."                                                                                                                                               |
| **1:00** | Dashboard, Event stream (or `qm-edge events`)             | Point at the rows: **Dylan moved Cube** (with an `xN` count for the drag), **Aiden changed Main Light intensity to …**, and three **QM Agent created Cube …** rows. The agent picks the names unless the prompt sets them. The three creates show as three rows because they are different objects. "Every change is ordered, attributed, and replayable, whether it came from a human or an agent." |
| **1:10** | Wide shot                                                 | "QM made intelligence multiplayer. QM Edge makes the environments that intelligence works in multiplayer."                                                                                                                                                                                                                                                                                           |

If there is time left (up to 1:30), say: "Unity is just the first adapter. The same event model works for CAD, Blender, Unreal, IDEs and robotics. Git is still where finished work gets checkpointed."

## Agent prompt

Type the short line exactly as you say it:

```
Create three cubes around the player.
```

This works as-is in `npm run edge:agent`. The console attaches a QM Edge briefing (the project and how to use `qm-edge`) to the first message of its conversation, and "the player" resolves to the scene's `Player` object. In a rehearsal against fake nodes, the agent ran `qm-edge objects`, then created `PlayerCubeLeft` at (-2, 0.5, -3), `PlayerCubeRight` at (2, 0.5, -3) and `PlayerCubeFront` at (0, 0.5, -1) around `Player` at (0, 1, -3). Names and positions vary from run to run.

If you want fixed names on the timeline, or the scene has no `Player`, type the explicit version:

```
Create three cubes around the player. In QM Edge, the player is the object named "Player" (use "Cube" if there is no Player) in project unity-demo. Use the qm-edge CLI: run `qm-edge objects` first to find its position, then run three `qm-edge create --primitive Cube` commands, named AgentCube1, AgentCube2 and AgentCube3, placed about 2 units away on different sides.
```

If the model is not available, the same edits can still go through QM without it. In the console, `!` lines run as-is through `execute` and QM core, and the timeline shows them as **QM Agent (agent)**. Adjust the numbers to your `Player` position (these are for the fake scene):

```
!run qm-edge create --primitive Cube --name AgentCube1 --x 2 --y 0.5 --z -3
!run qm-edge create --primitive Cube --name AgentCube2 --x -2 --y 0.5 --z -3
!run qm-edge create --primitive Cube --name AgentCube3 --x 0 --y 0.5 --z -1
```

Without QM core at all, run the same `qm-edge create …` commands from a terminal on the hub Mac with `QM_EDGE_URL=http://localhost:<port> QM_EDGE_TOKEN=demo-2468 npm run qm-edge -- …`. The timeline still shows them as **QM Agent (agent)**, because that is the CLI's default actor.

## Backup plan: Unity misbehaves

Switch to fake nodes plus the dashboard. The narrative is the same and so is the protocol.

1. On each Mac, run:
   ```bash
   npm run edge:fake-client -- --url ws://<hub-ip>:8787/edge/ws --token demo-2468 --name Dylan
   ```
   Use port 8080 with `npm run edge:qm`, and `--name Aiden` and so on on the other Macs. If Unity nodes are also connected, add `--project fake-demo` and use the same `--project` for `qm-edge` and the dashboard (and `EDGE_PROJECT=fake-demo` for `npm run edge:agent`).
2. Put the **dashboard** on the big screen. It is the visual now.
3. Run the beats:
   - Mac A: `drag Cube`. The position streams live on the dashboard and the other terminals print `<- #N Dylan (human) moved Cube`.
   - Mac B: `intensity Main Light 2.5`.
   - Presence: the dashboard's Presence panel, or `peers`.
   - Agent: the QM prompt (the fake scene has a `Player`), or the `qm-edge create` commands above.
   - Timeline: the dashboard's Event stream, or `npm run qm-edge -- events`.
4. Close with the same line.

If the network itself fails, run the hub and every fake node on one Mac against `ws://127.0.0.1:8787/edge/ws` (`:8080` with `npm run edge:qm`), in four terminal tabs, and keep the dashboard on `localhost`.

Both hub options serve the dashboard at `/edge`. If no browser is handy, `npm run qm-edge -- peers` and `npm run qm-edge -- events` show the same data.
