# QM Edge for Unity

Joins the Unity Editor to a QM Edge hub as an Edge Node. Everyone connected to the same project sees GameObjects created, deleted, moved, rotated, scaled, renamed and relit in realtime, plus who is online, what they have selected, and a feed of recent events. Unity is adapter `unity`; the hub itself knows nothing about Unity.

Supports Unity 2021.3 LTS through Unity 6. No third-party dependencies.

## Install

- **From disk:** Window > Package Manager > + > Add package from disk… and pick `adapters/unity/com.qm.edge/package.json` from a checkout of this repo.
- **From git:** Window > Package Manager > + > Add package from git URL… and enter `https://github.com/<owner>/<repo>.git?path=adapters/unity/com.qm.edge`.

## Connect

1. Start a hub (standalone default: `ws://127.0.0.1:8787/edge/ws`) and note its join token.
2. Open **Window > QM Edge**.
3. Fill in Hub URL, Project ID (default `unity-demo`), Display name, and Join token. Actor ID is generated once per machine.
4. Press **Connect**. The window shows CONNECTED, the peers list, and recent events such as `#31 Dylan moved Cube (x12)`.

The editor reconnects automatically after script reloads, restarts and network drops until you press Disconnect. Settings, including the token, live in EditorPrefs on this machine.

## What syncs

| Property | Payload key | Notes |
| --- | --- | --- |
| Name | `name` | |
| Primitive | `primitive` | Cube, Sphere, Capsule, Cylinder, Plane or Quad, used when creating |
| World position | `position` | `[x, y, z]` |
| World rotation | `rotation` | Euler degrees `[x, y, z]` |
| Local scale | `scale` | `[x, y, z]` |
| Light intensity | `light.intensity` | Only applied when the object has a Light |
| Light color | `light.color` | `[r, g, b, a]` |

Actions: `create_object`, `set_transform`, `set_property`, `rename`, `delete_object`. Conflicts resolve per property by the hub's sequence order (last writer wins).

## Identity

Objects created while connected get a **QM Edge Identity** component holding a GUID, which is how every machine refers to them. Objects that were already saved in a shared scene are identified by their `GlobalObjectId`, so machines that open the same saved scene agree without any setup. Objects with neither (for example in an untitled scene) are not synced. Save the scene after collaborating so identities persist.

## Limitations

- Parenting and arbitrary components are not synced. When a hierarchy is created, its root and any children that already carry a QM Edge Identity are sent as separate objects, so they appear unparented on other machines. Deleting a parent deletes every synced object beneath it.
- A newly created or pasted object always gets a fresh identity unless it is the undo of a delete made on this machine since the last script reload, so prefabs and copies never hijack another object's id.
- Positions and rotations are world space. When a node catches up from scratch (first join, after a script reload, or after opening a scene) it replays the hub's stored values in sequence order, which is exact for machines starting from the same saved scene. A child moved before its parent can still land slightly differently on a machine whose scene had already diverged.
- Changes made while disconnected are not pushed on reconnect; the hub's state wins. Edits rejected for rate limiting are re-sent automatically, and edits the hub never received because the connection died are re-sent after reconnecting. Edits rejected as invalid are not retried.
- Play mode changes are never sent. Remote changes that arrive during play mode are applied when you return to edit mode.
- Children inside a prefab instance cannot be deleted remotely until the prefab is unpacked.
- The join token is stored in plain text in EditorPrefs.
