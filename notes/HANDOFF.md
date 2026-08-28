# Handoff

Orientation for the next work session or contributor. State as of
2026-08-28, just after the public push.

## How workflow discovery works

Two sources, merged at boot in `main.js`:

1. **Repo-local `workflows/` folder.** Ships with three hand-written
   samples that use only core vanilla nodes (CheckpointLoaderSimple,
   CLIPTextEncode, KSampler, LoraLoader, LatentUpscale, VAEDecode,
   VAEEncode, LoadImage, SaveImage, EmptyLatentImage). This is what a
   stranger sees on first boot, and it is also what demo mode uses.
   Nothing personal ships here. Edits and saves land in this folder
   only.
2. **The user's own ComfyUI userdata.** In live mode we list
   `/api/userdata?dir=workflows&recurse=true` (the workflows saved
   through the ComfyUI frontend), load the first 12 that parse, and
   label them by source. These exist only on the user's machine and are
   never written back (saves go to the local folder, always).

Known gaps, in priority order:

- The 12-workflow cap is arbitrary and there is no picker. Someone with
  80 saved workflows gets an arbitrary dozen. Wants a constellation
  paging scheme or a workflow browser panel.
- Sample workflows reference checkpoint filenames the user probably
  does not have (`sd_xl_base_1.0.safetensors` etc). The combo shows
  their real options from object_info, but the stored value is stale
  until they cycle it, and queueing before that fails validation. Fix:
  on parse in live mode, snap stored combo values that are not in the
  option list to the first available option, and mark the widget
  visually as auto-substituted.

## Next up (agreed priorities)

### 1. Error handling overhaul (do this first)

Now public, and error surfacing is ad hoc: some paths `fail()` into the
error box, some `flashHint()`, some `console.warn`, and two real
failure payloads are dropped on the floor:

- `/prompt` 400 responses carry `error.message` plus a `node_errors`
  object keyed by node id with per-input validation errors. We
  currently `console.warn` and set hub status to error. The panels that
  caused the failure should glow red and the first message should reach
  the user.
- ws `execution_error` events carry `node_id`, `exception_type`,
  `exception_message`, and a traceback. We currently just set status.
  The offending panel should light up and the message should be
  readable at the hub core.

Plan:

- New module `js/report.js`: one choke point with
  `report.info / report.warn / report.error(msg, {hub, nodeId, detail})`.
  Routes to the hint line (transient), the error box (persistent,
  should become dismissable), hub status, panel highlight, and console.
  Everything else calls this instead of touching the DOM.
- Fetch wrapper in `comfy.js` (`cfetch`) that throws typed errors
  (network vs HTTP status vs parsed ComfyUI error body) so callers stop
  guessing what a failure looks like.
- Panel error state: accent flips to the red family while errored,
  cleared on next successful run or edit of that node.
- Core panel gains a last-error readout row (truncated, full text in
  console).
- Keep the rule from day one: a failure in one hub must never break the
  space, and a failure in route registration must never break ComfyUI.

### 2. Quest 2 field report fixes

First in-headset session is happening now. Expected suspects, roughly:
panel text legibility at arm's length, port-dot hit targets too small
for rays, pull-locomotion gain (currently 4x), snap-turn feel, frame
rate inside the largest hubs, ENTER VR button not appearing (the status
chip tooltip explains why when the runtime is missing). Fold findings
into an issue list and fix the top ones before promoting the repo
further.

### 3. Hosted demo page (release gate 5)

Demo mode needs a static fallback for the sample workflows (they are
currently fetched from the server; embed them or fetch-with-fallback)
and then the `public/` folder minus proxy runs on GitHub Pages. Link it
from the README so people can fly before installing.

### 4. Deeper gallery recall

ComfyUI `/history` is in-memory and dies with the server. Scan the
output directory PNGs for embedded workflow metadata instead (we
already parse those chunks client-side for drag-drop) and back-fill
galleries across restarts. Needs a server-side endpoint in both
deployment modes.

## Architecture map

All plain ES modules, no build step, three.js r160 vendored.

| File | Role |
|---|---|
| `__init__.py` | ComfyUI custom node: registers /comfyvr routes, zero nodes |
| `server.py` | Standalone: static + raw-path proxy to ComfyUI + local workflows |
| `public/js/main.js` | Boot, camera rig, input state machine (mouse + XR), palette, drag-drop, backfill |
| `public/js/graph.js` | litegraph JSON truth: parse, topo layers, mutate, serialize, API-format convert |
| `public/js/hubs.js` | Hub = one workflow: sigil, amphitheater, gallery, execution event surface |
| `public/js/panels.js` | Canvas-textured holographic panels, curved geometry, rows, hit testing |
| `public/js/beams.js` | Links as arcs, pulse particles |
| `public/js/comfy.js` | Client for both deployments (HOSTED const), ws events, demo simulator |
| `public/js/assets.js` | 3D output placards and materialization (GLB/OBJ/PLY) |
| `public/js/audio.js` | Synthesized UI sound |
| `quest.ps1` | Windows helper: adb reverse + in-headset steps |

Key invariants to preserve:

- The litegraph workflow JSON is the single source of truth. 3D layout
  lives only in `extra.comfyvr.layout`. Files stay vanilla-loadable.
- Never write to ComfyUI userdata. Saves go to the local folder.
- Hubs receive execution through one event surface (onExecuting,
  onProgress, onExecuted, onStatus, onPreview) fed identically by the
  live websocket and the demo simulator.
- Desktop pointer and XR controllers share the interaction layer via
  ray + select; hands ride the same select events.
- Holograms are additive MeshBasic and ignore scene lights; lights
  exist only for materialized 3D assets.

## Dev notes

- Modules are cached aggressively by the browser. Both servers send
  `Cache-Control: no-cache` now, but when in doubt:
  `for f of [...] fetch(f, {cache:'reload'})` then reload.
- `window.CVR` debug handle: `CVR.tick(dt, n)` drives the loop manually
  (needed when the tab is hidden), `CVR.snap()` returns a PNG data URL
  even when the window is collapsed, `CVR.fly(i)`, `CVR.look(...)`.
- Demo mode is the no-backend test bed; the simulator emits the same
  events as the websocket.
- `cvr_test_cube.obj` and `cvr_test_splat.ply` in the ComfyUI output
  dir exercise the 3D materialization path.
- Longer-term roadmap and deferrals live in `RELEASE.md` and
  `design.md`.
