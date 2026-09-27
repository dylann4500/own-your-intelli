# QM Edge architecture

> QM makes intelligence multiplayer. QM Edge makes the environments that intelligence works in multiplayer.

QM Edge is a generic, realtime **semantic state and event layer**. It connects QM, humans, agents and local applications (Edge Nodes) so they can all see and change the same live application state, with ordering, attribution, presence and history.

It is **not** Dropbox, filesystem sync, a Git replacement, remote desktop, collaborative text editing, or Unity-specific infrastructure. Unity is adapter #1. Edge Core only understands generic concepts: project, actor, node, adapter, resource, operation, presence, event, sequence number and snapshot/catch-up.

## Layers

```
┌─────────────────────────────────────────────────────────────┐
│ QM            agents, scopes, sandboxes, `execute` tool      │
├─────────────────────────────────────────────────────────────┤
│ Edge Core     protocol, validation, auth, ordering, dedupe   │
├─────────────────────────────────────────────────────────────┤
│ Edge Project  per-project sequence, resource state, members  │
├─────────────────────────────────────────────────────────────┤
│ Event Stream  committed operations, history, catch-up        │
├─────────────────────────────────────────────────────────────┤
│ Edge Nodes    local processes joined to a project (WebSocket)│
├─────────────────────────────────────────────────────────────┤
│ Application   Unity today; CAD, Blender, Unreal, IDE,        │
│ Adapters      robotics, scientific software later            │
└─────────────────────────────────────────────────────────────┘
```

## Components

```
                         ┌──────────────────────────────┐
                         │ QM core                      │
   QM agent ──execute──▶ │  /v1/edge/* (capability auth)│
   (sandbox, qm-edge CLI)│             │                │
                         └─────────────┼────────────────┘
                                       ▼
                         ┌──────────────────────────────┐
                         │ Edge Hub (authoritative)     │
                         │  validate → dedupe → sequence│
                         │  → history → reduce → fan out│
                         └───────┬──────────────┬───────┘
                   ws /edge/ws   │              │   ws /edge/ws
                ┌────────────────┘              └────────────────┐
                ▼                                                ▼
   ┌──────────────────────────┐                  ┌──────────────────────────┐
   │ Edge Node: Dylan's Mac   │                  │ Edge Node: Aiden's Mac   │
   │  Unity Editor            │                  │  Unity Editor            │
   │  + Unity Adapter         │                  │  + Unity Adapter         │
   └──────────────────────────┘                  └──────────────────────────┘
```

The hub runs either **standalone** (`npm run edge:dev`, port 8787) or **inside QM core** (`EDGE_ENABLED=1`, on core's own port; `npm run edge:qm` sets this up for a local demo). In the core-hosted setup the agent's traffic goes QM agent → QM core → hub in-process. The sandbox never opens a connection to the LAN.

## Where things live

| Path                                                                                                               | What it is                                                                                                                                                                                                                                        |
| ------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/edge/protocol.ts`                                                                                             | Zod schemas for every client message and the operation envelope, server message types, error codes, limits (`EDGE_PROTOCOL_VERSION = 1`, 16 KiB payload, 5000 announced resources)                                                                |
| `src/edge/hub.ts`                                                                                                  | `EdgeHub` (projects, sequencing, dedupe, history, reducer, presence, sweep) and `EdgeConnection` (per-socket state machine, rate limit)                                                                                                           |
| `src/edge/server.ts`                                                                                               | WebSocket transport (`attachEdgeWebSocket`, heartbeat), join-token REST handler (`handleEdgeHttpRequest`), standalone `createEdgeServer`                                                                                                          |
| `src/edge/http.ts`                                                                                                 | Transport-agnostic REST router `handleEdgeApi`, shared by the standalone hub and QM core                                                                                                                                                          |
| `src/edge/config.ts`                                                                                               | `EDGE_*` env parsing, `EDGE_WS_PATH = /edge/ws`, `EDGE_DEFAULT_PORT = 8787`                                                                                                                                                                       |
| `src/edge/runtime.ts`                                                                                              | `createConfiguredEdgeHub`: hub + optional journal restore                                                                                                                                                                                         |
| `src/edge/journal.ts`                                                                                              | JSONL journal (`<EDGE_JOURNAL_DIR>/<projectId>.jsonl`)                                                                                                                                                                                            |
| `src/edge/main.ts`                                                                                                 | Standalone hub entry point (`npm run edge:dev`)                                                                                                                                                                                                   |
| `src/edge/banner.ts`                                                                                               | Startup banner with LAN WebSocket URLs, dashboard link and join token                                                                                                                                                                             |
| `src/edge/dashboard.ts`                                                                                            | Single-page live dashboard (presence, event stream, live resources)                                                                                                                                                                               |
| `src/edge/client.ts`                                                                                               | `EdgeNodeSession`: the TypeScript Edge Node client, including reconnect, outbox, snapshot apply and loop prevention                                                                                                                               |
| `src/edge/adapter.ts`                                                                                              | `EdgeAdapter` contract and `snapshotOperations`                                                                                                                                                                                                   |
| `src/edge/adapters/unity.ts`                                                                                       | Unity vocabulary as pure functions: resource type, actions, properties, primitives, change builders                                                                                                                                               |
| `src/edge/adapters/memory-scene.ts`                                                                                | `MemorySceneAdapter`: an in-memory scene that implements `EdgeAdapter`. Tests and the fake node use it                                                                                                                                            |
| `src/edge/cli.ts`                                                                                                  | `qm-edge` CLI that agents use                                                                                                                                                                                                                     |
| `scripts/edge-fake-client.ts`                                                                                      | Interactive fake Unity node (`npm run edge:fake-client`)                                                                                                                                                                                          |
| `scripts/edge-build-cli.ts`                                                                                        | Bundles the CLI to `fly/tools/qm-edge` (`npm run edge:build-cli`)                                                                                                                                                                                 |
| `scripts/edge-demo-core.sh`                                                                                        | `npm run edge:qm`: starts QM core with Edge enabled, a local Docker sandbox and `PUBLIC_API_URL` set, building the sandbox image the first time                                                                                                   |
| `scripts/edge-agent-chat.ts`                                                                                       | `npm run edge:agent`: a terminal chat with the QM agent through core's signed `/v1/turns`, with a QM Edge briefing on the first message                                                                                                           |
| `local/edge-demo.Dockerfile`                                                                                       | Light sandbox image with the `qm-edge` bundle, built as `qm-sandbox-local:latest` by `npm run edge:sandbox:build`                                                                                                                                 |
| `fly/Dockerfile`                                                                                                   | Copies `fly/tools/qm-edge` to `/usr/local/bin/qm-edge` in the sandbox image                                                                                                                                                                       |
| `src/api/routes/edge.ts`                                                                                           | Core integration: capability-authenticated `/v1/edge/*` routes, and raw `/edge/health`, the `/edge` dashboard and `/edge/v1/*`                                                                                                                    |
| `src/config.ts`, `src/index.ts`, `src/api/server.ts`                                                               | `config.edge` (other `EDGE_*` values are ignored unless `EDGE_ENABLED`); `index.ts` builds the hub, prints the banner and closes the WebSocket on shutdown; `server.ts` attaches the WebSocket to core's HTTP server and upgrades only `/edge/ws` |
| `src/api/agent-api-catalog.ts`                                                                                     | Agent API listing family for Edge (shown only when the hub is enabled)                                                                                                                                                                            |
| `adapters/unity/com.qm.edge/`                                                                                      | Unity Editor UPM package: `EdgeSession` (C# Edge Node), `UnityEdgeAdapter`, `Window > QM Edge` (`QmEdgeWindow`), transport, JSON, settings, `QmEdgeIdentity`                                                                                      |
| `test/edge-hub.test.ts`, `test/edge-node.test.ts`, `test/edge-core-routes.test.ts`, `test/edge-qm-execute.test.ts` | Protocol, hub, node convergence, CLI, core-route and agent-through-`execute` tests                                                                                                                                                                |

## Protocol

Transport is JSON text frames over WebSocket at `/edge/ws`. Binary frames are rejected. The maximum frame size is 512 KiB. Every client message is validated with a strict Zod schema, so unknown fields are rejected.

### Client → hub

| `type`              | Fields                                                                                                                      | Notes                                                                                                                                                                                                                                                                               |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `hello`             | `protocolVersion`, `actor {id, displayName, type: human\|agent\|system}`, `node? {id, adapter, deviceName?, capabilities?}` | Must come first. A wrong version returns `unsupported_protocol_version` and the socket is closed with 4400. A connection cannot change actors. Actor ids starting with `qm-agent:` or `qm-user:` are reserved for QM core: the socket gets `actor_mismatch` and is closed with 1008 |
| `joinProject`       | `projectId`, `token`, `lastSequence?`                                                                                       | Checks the join token (constant time). Replies with `joined`                                                                                                                                                                                                                        |
| `leaveProject`      | `projectId`                                                                                                                 | Replies with `left`                                                                                                                                                                                                                                                                 |
| `presence`          | `projectId`, `workingOn? {resourceType?, resourceId?, label?} \| null`                                                      | Updates what this actor is working on                                                                                                                                                                                                                                               |
| `submitOperation`   | `operation` (envelope below)                                                                                                | Rate limited per connection. Replies with `operationAck`                                                                                                                                                                                                                            |
| `announceResources` | `projectId`, `adapter`, `resources[] {resourceType, resourceId, properties}`                                                | Up to 5000 baseline resources. Replies with `resourcesAnnounced`                                                                                                                                                                                                                    |
| `catchupRequest`    | `projectId`, `afterSequence`, `limit?` (≤ 5000)                                                                             | Replies with `eventHistory`                                                                                                                                                                                                                                                         |
| `ping`              | `nonce?`                                                                                                                    | Replies with `pong`                                                                                                                                                                                                                                                                 |

### Hub → client

| `type`               | Fields                                                                                                                     |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `welcome`            | `protocolVersion`, `connectionId`, `serverTime`, `hubName`                                                                 |
| `joined`             | `projectId`, `latestSequence`, `members[]`, `resources[]` (full `EdgeResourceState`), `history[]` (last 100 committed ops) |
| `left`               | `projectId`                                                                                                                |
| `presence`           | `projectId`, `members[]`                                                                                                   |
| `committedOperation` | `operation` (committed envelope)                                                                                           |
| `operationAck`       | `operationId`, `sequence`, `duplicate`                                                                                     |
| `eventHistory`       | `projectId`, `operations[]`, `latestSequence`, `truncated`                                                                 |
| `resourcesAnnounced` | `projectId`, `adapter`, `count` (newly added resources)                                                                    |
| `error`              | `code`, `message`, `requestType?`, `operationId?`                                                                          |
| `pong`               | `nonce?`, `serverTime`                                                                                                     |

Error codes: `invalid_message`, `unsupported_protocol_version`, `hello_required`, `unauthorized`, `not_joined`, `invalid_operation`, `actor_mismatch`, `rate_limited`, `unknown_project`.

### Operation envelope

```jsonc
{
  "id": "5b0c…", // UUID chosen by the client; the dedupe key
  "protocolVersion": 1,
  "projectId": "unity-demo",
  "actorId": "…", // must equal the connection's hello actor
  "nodeId": "…", // optional; must equal the connection's node if both are set
  "adapter": "unity", // lowercase token
  "resourceType": "GameObject",
  "resourceId": "GlobalObjectId_V1-…",
  "action": "set_transform", // adapter-specific verb (lowercase token)
  "effect": "update", // create | update | delete | none (the only thing core interprets)
  "payload": { "position": [5, 0.5, 0] }, // property map, ≤ 256 keys, ≤ 16 KiB
  "label": "moved Cube", // optional human-readable text for timelines
  "clientTimestamp": 1767000000000,
}
```

The hub adds `sequence`, `committedAt` and `actor {id, displayName, type}` to produce an `EdgeCommittedOperation`. `action` is opaque to core. Only `effect` and `payload` drive the state reducer. Payloads are bounded data and are never executed.

## Consistency model

The hub is **server-authoritative** and runs **no CRDT**. For each `submitOperation` it does this:

1. **Validate** the envelope, check that the project matches, and check the actor and node against the connection (`actor_mismatch`).
2. **Dedupe** by operation `id`. If the id was already committed in this project, it returns the original committed op with `duplicate: true` and does not re-broadcast. The dedupe window keeps up to 100,000 ids per project.
3. **Sequence**: `sequence = ++project.sequence`, which increases monotonically per project.
4. **Append** to history, bounded by `EDGE_HISTORY_LIMIT` (default 2000).
5. **Reduce** into per-resource, per-property state. Every property records the sequence that last wrote it (`versions[key]`). A write lands only when its sequence is higher, so the result is **per-property last-writer-wins by server sequence**.
   - `create` sets `exists = true`, `createdSequence` and clears `deletedSequence`.
   - `delete` sets `exists = false`, `deletedSequence`. Its payload is ignored.
   - `update` on a resource the hub has never seen creates its state entry (`exists = true`, `createdSequence = null`). `update` on a deleted resource is recorded in history but does not change state.
   - `none` is recorded in history only. Use it for pure events.
6. **Broadcast** `committedOperation` to every subscriber of the project, including the sender, and acknowledge the sender with `operationAck`.

Two concurrent writes to `Cube.position` therefore converge everywhere to the one with the higher sequence. Writes to different properties of the same object both survive.

**Baseline resources.** `announceResources` registers what a node already has locally, such as objects in the saved scene, at property version `0`. Any committed operation outranks them, and a later announcement never overwrites a property the hub already knows. These resources are discoverable (for example `qm-edge objects` lists them), but they are never pushed back to nodes as authoritative state.

## Loop prevention (Edge Node side)

When an application applies a remote change, it usually fires its own "something changed" callbacks. Without guards, that change would be sent back to the hub and loop forever. `EdgeNodeSession` in `src/edge/client.ts` has five guards:

1. **Suppression while applying.** Local changes emitted while `applyRemoteOperation` runs are dropped (`applyingRemote`).
2. **Value-based echo suppression.** The node remembers the last synced value of each resource property and whether each resource exists. A local `update` whose values all equal the synced values is dropped. So is a `create` or `delete` that matches known existence. This catches callbacks that arrive asynchronously after the apply finished, which Unity does.
3. **Own-echo skipping.** A `committedOperation` whose `nodeId` is this node only advances `lastSequence` and clears pending state. It is never re-applied.
4. **Sequence dedupe.** Operations with `sequence <= lastSequence` are skipped.
5. **Pending-op last-writer-wins.** While this node's own op on a property is in flight, incoming remote values for that property are skipped. The node's op will commit with a higher sequence and win anyway, so skipping avoids a visible flicker. Pending entries clear on the own echo, on an `error` carrying that `operationId`, or on rejoin.

Operations produced while disconnected go to an **outbox** and are submitted after the next `joined`. Reconnects back off 0.5 s → 1 s → 2 s → 5 s.

The Unity package implements the same ideas in C#:

- **Sessions (`EdgeSession.cs`).**
  - Own ops are recognised by `nodeId` and by recently sent ids.
  - Ops at or below `lastAppliedSequence` are skipped.
  - Pending properties (`pendingByKey`) and pending creates are filtered out of remote applies. They clear on the `operationAck`, the own echo or an `error` for that op.
  - Submits are capped at 60 per second on the client, under the hub's 120.
- **Adapter (`UnityEdgeAdapter.cs`).**
  - It compares each object against the last synced snapshot (`synced`) and only sends properties that changed.
  - It suppresses change events on an object for 2 editor ticks / 0.25 s after applying a remote change to it.
  - It polls the selected and recently changed objects at about 15 Hz, with at most one send per object every 60 ms.

The Unity node differs from the TypeScript client in these ways:

- It has **no outbox**. Edits made while disconnected are not pushed, and the hub's state wins on rejoin. It does track in-flight ops: ones lost with the connection that the hub never committed, and ones rejected as `rate_limited`, are handed back to the adapter (`OnOperationRejected`) and sent again.
- On every `joined` it adopts the hub's `latestSequence`. It replays the snapshot in sequence order, one create or update per stored property version. When it rejoins the same hub and project without local changes while detached, it skips versions at or below its previous sequence.
- It reconnects after 1 s, 2 s, 5 s, then 10 s. Any error on `hello` or `joinProject` (such as `unauthorized`) and `unsupported_protocol_version` stop the retries until someone presses **Connect** again. A `not_joined` error makes it re-join.
- It announces at most 2000 baseline resources, in chunks of 250.

## Presence

A member is keyed by `(actorId, nodeId)`, so the same person on two machines shows up twice. Each entry carries `displayName`, `actorType`, `adapter`, `deviceName`, `status` and `workingOn`.

- WebSocket members are `online` while they have a connection. A disconnect or `leaveProject` marks them `offline`.
- Connectionless actors, such as agents and humans using REST or the CLI with no node, count as `online` for 5 minutes after their last call.
- Offline members are dropped after 30 minutes.
- Every committed operation sets the author's `workingOn` to the resource it touched, labelled with the resource's `name` property when present.
- The WebSocket heartbeat (15 s ping; sockets that stop answering are terminated) also runs the presence sweep.

## History and catch-up

- **Join snapshot.** `joined` carries the full reduced resource state and the last 100 committed ops. The node turns the state into synthetic `snapshot` operations with `snapshotOperations` (`src/edge/adapter.ts`). It keeps only properties with `version > 0`, so baseline values are never replayed, and it skips resources with `lastSequence === 0`. It filters to the node's adapter and applies only resources changed after the node's `lastSequence`. So late joiners and reconnecting nodes both converge to the authoritative state.
- **Replay.** `catchupRequest {afterSequence}` returns retained ops after that sequence. `truncated: true` means history was trimmed past that point, and the client should rely on the snapshot.
- `joinProject.lastSequence` is accepted but the hub currently always sends the full snapshot. The client does the filtering.
- **REST**: `GET …/events?after=&limit=`. Without `after` it returns the newest `limit` ops (default 200, max 5000). With `after` it returns the first `limit` ops after that sequence.

## Persistence

State is **in memory** by default, so a hub restart starts empty. Set `EDGE_JOURNAL_DIR` to append every committed op to `<dir>/<projectId>.jsonl`. On startup the hub replays the journal, which restores sequence, history, resource state and the dedupe ids. The banner prints `Journal: <dir> (restored sequence N)`.

## Auth and limits

| Surface                                  | Auth                                                                             | Actor                                                                                                                                                                                                                                                                                                                      |
| ---------------------------------------- | -------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ws://…/edge/ws`                         | `joinProject.token` must equal `EDGE_JOIN_TOKEN`                                 | Self-declared in `hello`. Every op must match it                                                                                                                                                                                                                                                                           |
| `/edge/v1/*` REST (hub or core)          | `Authorization: Bearer <join token>` or `x-edge-token`                           | Taken from `body.actor` on writes. Holding the join token means being trusted. Ids starting with `qm-agent:` or `qm-user:` are reserved for core (`403 actor_mismatch`)                                                                                                                                                    |
| `/edge/health`, `/edge` (dashboard page) | Public. The dashboard asks for the token and uses it for its REST calls          | –                                                                                                                                                                                                                                                                                                                          |
| `/v1/edge/*` on QM core                  | QM auth: agent capability token (`x-agent-capability`) or signed portal identity | Forced by core. Agents become `qm-agent:<capability actorId>` / "QM Agent" / `agent`, humans become `qm-user:<principal>` / `human`. Any actor or `nodeId` in the body is ignored. Writes need a project that already exists on the hub (`404 unknown_project`), and portal writes while impersonating are refused (`403`) |

- `EDGE_JOIN_TOKEN` is shared by everyone and must be at least 4 characters. If it is unset, a random 10-hex-char token is generated at each start. QM core prints `<EDGE_JOIN_TOKEN>` in its banner instead of a pinned token, and warns when the token is shorter than 16 characters.
- **This is for LAN demos only.** There is no TLS on the standalone hub and no per-user identity on the WebSocket.
- Under the **strict** security posture, QM core refuses agent writes (`POST /v1/edge/*`).
- Limits:
  - 120 ops/s per WebSocket connection (`rate_limited`)
  - 16 KiB payload and 256 properties per op
  - 512 KiB WebSocket frame
  - 64 KiB body on `/edge/v1/*`
  - 8 MiB outbound buffer per socket before the socket is terminated

### Env vars

| Var                                                                  | Used by                                                                                                                | Default                                                                          |
| -------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| `EDGE_ENABLED`                                                       | QM core (`1/true/yes/on`). While it is off, core ignores the other `EDGE_*` vars                                       | off in core, on for `edge:dev`                                                   |
| `EDGE_JOIN_TOKEN`                                                    | hub                                                                                                                    | generated per start                                                              |
| `EDGE_PROJECT`                                                       | hub (created at start, printed in the banner)                                                                          | `unity-demo`                                                                     |
| `EDGE_HISTORY_LIMIT`                                                 | hub (integer ≥ 100)                                                                                                    | `2000`                                                                           |
| `EDGE_JOURNAL_DIR`                                                   | hub                                                                                                                    | unset (in memory)                                                                |
| `EDGE_PORT`, then `PORT`                                             | standalone hub                                                                                                         | `8787`                                                                           |
| `EDGE_HOST`                                                          | standalone hub                                                                                                         | `0.0.0.0`                                                                        |
| `QM_EDGE_URL`, `QM_EDGE_TOKEN`                                       | `qm-edge` CLI, direct to a hub                                                                                         | `http://127.0.0.1:8787`                                                          |
| `AGENT_API_URL`, `AGENT_API_TOKEN`                                   | `qm-edge` CLI inside a QM sandbox (routes via core `/v1/edge`)                                                         | set by QM                                                                        |
| `QM_EDGE_PROJECT`                                                    | CLI and fake client                                                                                                    | `unity-demo`                                                                     |
| `QM_EDGE_ACTOR_ID`, `QM_EDGE_ACTOR_NAME`, `QM_EDGE_ACTOR_TYPE`       | CLI in direct-hub mode                                                                                                 | `qm-agent`, `QM Agent`, `agent`                                                  |
| `QM_EDGE_WS_URL`                                                     | fake client                                                                                                            | `ws://127.0.0.1:8787/edge/ws`                                                    |
| `PUBLIC_API_URL`                                                     | QM core: the core URL handed to sandboxes as `AGENT_API_URL`. Without it `qm-edge` in the sandbox has no route to core | unset (`npm run edge:qm`: `http://host.docker.internal:<PORT>`)                  |
| `QM_CORE_URL`, `CORE_SIGNING_SECRET`, `QM_DEMO_USER`, `EDGE_PROJECT` | `npm run edge:agent`                                                                                                   | `http://127.0.0.1:8080`, `data/edge-demo-secret`, `edge-demo-user`, `unity-demo` |

## Adapter contract

An application adapter translates between an application's native change events and the generic Edge envelope. The TypeScript contract is `src/edge/adapter.ts`:

```ts
interface EdgeLocalChange {
  resourceType: string;
  resourceId: string;
  action: string;
  effect: "create" | "update" | "delete" | "none";
  payload: Record<string, EdgeJson>;
  label?: string;
}

interface EdgeAdapter {
  readonly adapterId: string; // e.g. "unity"
  describeCapabilities(): { adapterId; resourceTypes; actions; properties };
  observeLocalChanges(emit: (change: EdgeLocalChange) => void): () => void; // returns unsubscribe
  applyRemoteOperation(operation: EdgeCommittedOperation): void;
  describeResources(): EdgeAnnouncedResource[]; // baseline for announceResources
}
```

`EdgeNodeSession` does everything that is not application-specific: the connection, hello/join, announcing, the outbox, snapshot apply, loop prevention and stats. An adapter only has to:

- **observe** local edits and emit them as semantic changes (`action` + `effect` + property `payload`)
- **apply** committed remote operations to the application
- **describe** the baseline resources it already has

The C# mirror in the Unity package is `IEdgeAdapter` (`AdapterId`, `ChangedWhileDetached`, `Attach(EdgeSession)`, `Detach()`, `BeginSync()`, `Tick()`, `ApplyRemote(EdgeOperation, bool fromSnapshot)`, `OnOperationRejected(resourceId, effect, keys)`, `DescribeResources()`).

## Today: Unity adapter

Vocabulary (`src/edge/adapters/unity.ts`):

- **Adapter id:** `unity`
- **Resource type:** `GameObject`
- **Actions:** `create_object`, `set_transform`, `set_property`, `rename`, `delete_object`
- **Properties:** `name`, `primitive`, `position`, `rotation`, `scale`, `light.intensity`, `light.color`
- **Primitives:** Cube, Sphere, Capsule, Cylinder, Plane, Quad

| Unity edit                      | Edge operation (the vocabulary the CLI, the fake node and the Unity adapter share)                       |
| ------------------------------- | -------------------------------------------------------------------------------------------------------- |
| Drag the Cube                   | `action: set_transform, effect: update, payload: {position: [x,y,z]}`                                    |
| Change Light intensity          | `action: set_property, effect: update, payload: {"light.intensity": 2}`                                  |
| GameObject > 3D Object > Sphere | `action: create_object, effect: create, payload: {name, primitive: "Sphere", position, rotation, scale}` |
| Delete the Sphere               | `action: delete_object, effect: delete, payload: {}`                                                     |

Identity:

- Objects from the saved scene are identified by Unity's `GlobalObjectId`.
- Objects created through Edge carry a `QmEdgeIdentity` component (`adapters/unity/com.qm.edge/Runtime/QmEdgeIdentity.cs`) that holds a UUID.

**Unity package** (`adapters/unity/com.qm.edge/`, Unity 2021.3+, no third-party dependencies):

| File                                                              | Role                                                                                                                                                                                                                                                                    |
| ----------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Editor/QmEdgeWindow.cs`                                          | **Window > QM Edge**. Holds the settings fields, the Connect/Disconnect button, the CONNECTED / CONNECTING / DISCONNECTED status, peers and recent events                                                                                                               |
| `Editor/EdgeSession.cs`                                           | Hello/join/announce, ordered snapshot replay, pending filters, in-flight tracking and re-send, presence from the current Selection (sent at most every 0.25 s), reconnect. Problems are logged as `[QM Edge] …`                                                         |
| `Editor/UnityEdgeAdapter.cs`                                      | Observes `ObjectChangeEvents`, polls the transforms and lights of selected and recently changed objects, applies remote ops, re-queues rejected edits, and handles play mode (nothing is sent in play mode; the node re-joins and catches up on returning to edit mode) |
| `Editor/EdgeConnection.cs`                                        | `ClientWebSocket` on a background task, 10 s keepalive, 30 s silence limit                                                                                                                                                                                              |
| `Editor/EdgeBootstrap.cs`                                         | `[InitializeOnLoad]` wiring and `EdgePrefs`. Settings, the per-project node id and auto-reconnect after script reloads live in `EditorPrefs`                                                                                                                            |
| `Editor/EdgeModel.cs`, `Editor/Json.cs`, `Editor/IEdgeAdapter.cs` | Wire model, JSON, adapter interface                                                                                                                                                                                                                                     |
| `Runtime/QmEdgeIdentity.cs`                                       | The identity component for Edge-created objects                                                                                                                                                                                                                         |

The package is not built by the Node test suite. The TypeScript fake node (`npm run edge:fake-client`) uses the same protocol and Unity vocabulary, and it is the fallback if the package misbehaves.

## Future adapters (not implemented)

**Future:** CAD, Blender, Unreal, IDE, Robotics, scientific software.

New adapters need no Edge Core changes, because core never interprets `action`, `resourceType` or payload keys. Here is a CAD sketch that uses only the existing contract:

```ts
class CadEdgeAdapter implements EdgeAdapter {
  readonly adapterId = "cad";

  describeCapabilities() {
    return {
      adapterId: "cad",
      resourceTypes: ["part", "assembly", "sketch", "feature", "dimension"],
      actions: ["set_dimension", "move_component", "create_feature", "suppress_feature"],
      properties: ["value", "unit", "transform", "featureType", "parameters", "suppressed", "name"],
    };
  }

  observeLocalChanges(emit) {
    return cad.onChange((e) => {
      if (e.kind === "dimensionEdited")
        emit({
          resourceType: "dimension",
          resourceId: e.dimensionId,
          action: "set_dimension",
          effect: "update",
          payload: { value: e.value, unit: "mm" },
          label: `set ${e.name} to ${e.value} mm`,
        });
      if (e.kind === "componentMoved")
        emit({
          resourceType: "part",
          resourceId: e.partId,
          action: "move_component",
          effect: "update",
          payload: { transform: e.matrix4x4 },
        });
      if (e.kind === "featureCreated")
        emit({
          resourceType: "feature",
          resourceId: e.featureId,
          action: "create_feature",
          effect: "create",
          payload: { featureType: "extrude", parameters: { depth: 10 }, name: e.name },
        });
      if (e.kind === "featureSuppressed")
        emit({
          resourceType: "feature",
          resourceId: e.featureId,
          action: "suppress_feature",
          effect: "update",
          payload: { suppressed: true },
        });
    });
  }

  applyRemoteOperation(op) {
    if (op.resourceType === "dimension" && "value" in op.payload) cad.setDimension(op.resourceId, op.payload.value);
    // …one small branch per action
  }

  describeResources() {
    return cad.listDimensionsAndFeatures().map(toAnnouncedResource);
  }
}
```

On the wire, `set_dimension` is just another envelope:

```json
{
  "adapter": "cad",
  "resourceType": "dimension",
  "resourceId": "sketch1/d3",
  "action": "set_dimension",
  "effect": "update",
  "payload": { "value": 42.5, "unit": "mm" }
}
```

The hub treats this envelope exactly like the Unity ones:

- it sequences, dedupes and records it
- it resolves it by per-property LWW on `value`
- it reports it in presence and the event stream
- it replays it on catch-up

An agent could drive it today with `qm-edge op --adapter cad --resource-type dimension --resource-id sketch1/d3 --action set_dimension --effect update --payload '{"value":42.5,"unit":"mm"}'`. Nodes ignore committed ops from other adapters, so one project can hold several adapter types at once.

## Relationship to Git

```
Git:     durable history, branching, code review, checkpoints
QM Edge: live application state, presence, human/agent coordination, semantic operations
```

Live multiplayer work → eventually checkpoint → Git.

Edge does not move files or assets. When a live session produces something worth keeping, someone saves it in the application and commits it the usual way.

## Non-goals

- File, asset or project sync. There is no project cloning (it is not Dropbox)
- Replacing Git history, branching or review
- Remote desktop or screen sharing
- Character-level collaborative text editing
- CRDT or offline-first merge semantics
- Executing anything carried in an operation
- Unity-specific logic in Edge Core

## Known limitations

- **Shared baseline required.** Every Unity machine must open the same saved scene before connecting. Baseline objects are matched by `GlobalObjectId`, which differs if a machine's scene differs or is unsaved.
- **Security.** One shared join token, a self-declared WebSocket actor, and no TLS on the standalone hub. LAN demos only.
- **In-memory by default.** A hub restart without `EDGE_JOURNAL_DIR` starts empty while nodes still hold their local edits. Reopen the saved scene and reconnect.
  - The TypeScript client (and so the fake node) keeps its old `lastSequence` across reconnects. After a journal-less restart it skips new ops until the sequence passes that point, so restart fake nodes.
- **Coarse conflicts.** Resolution is per property. For example, concurrent `position` writes keep the later whole vector, not a merge of axes.
- **Bounded history.** Replay only reaches as far back as `EDGE_HISTORY_LIMIT`. Earlier catch-up relies on the snapshot.
- **Single process.** One hub process holds all projects. There is no clustering or horizontal scale.
- **Unity scope.** The Unity adapter only syncs:
  - GameObject create and delete. A new hierarchy is sent as its root plus any children that already carry a `QmEdgeIdentity`, as separate unparented objects. Deleting a parent deletes every synced object beneath it
  - name
  - world position and rotation, local scale
  - Light intensity and color

  It does not sync:
  - parenting or other components
  - remote deletes of children inside prefab instances (unpack the prefab first)
  - objects without a `GlobalObjectId` or `QmEdgeIdentity`, such as those in an untitled scene

  The join token is stored in plain text in `EditorPrefs`.
