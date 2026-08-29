# Handoff

Orientation for the next work session or contributor. State as of
2026-08-28, just after the public push.

## Quest 2 field report (2026-08-28, first in-headset session)

Release gate 1 passed: the space, navigation, pinch interaction, and
pull locomotion all work and feel right on a real Quest 2 over the LAN
https path (`make_cert.py` + `server.py --tls`, port 8443). Three
findings, each with the mechanism located:

1. **Text [edit] does nothing in VR.** It works, invisibly: the editor
   is a DOM overlay (`#editor` in index.html, `openEditor` in main.js)
   and the DOM cannot render inside an immersive WebXR session, so the
   textarea opens on the monitor while the user is in the headset.
   Stopgap: when in XR, flash an in-space hint and put the panel into a
   waiting state. Real fix: an in-space pinch keyboard for short
   fields, phone-as-keyboard for prompts.
2. **Note and MarkdownNote bodies are cut off.** Text rows clamp at 3
   wrapped lines (`maxLines` in panels.js). Notes deserve a dedicated
   tall panel style: full wrapped text, height derived from line count,
   sensible cap with paging.
3. **Sliders are unusably coarse on wide ranges.** `applySliderFrac`
   maps a 202 px bar linearly across the schema range, and KSampler
   steps has max 10000, so one px is about 50 steps. Fix, in order:
   curated soft ranges for common widgets (steps, width/height, cfg),
   log-space mapping when max/min exceeds about 1000, and a fine-nudge
   affordance (wheel on desktop, stick flick in XR) worth one step per
   click. Ray jitter at distance makes absolute-position mapping worse
   in VR, so a relative-drag gain mode is worth trying there.

Traction note: the reddit post is near 30 upvotes and the project is
now posted in the Banodoco and Stable Diffusion discords. Strangers
are installing it, which raises the priority of everything a stranger
hits in the first five minutes.

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

## Next up: Spike 1, "the first five minutes"

Goal: a stranger with a headset gets from git clone to flying and
generating without reading anything, and the things they touch first
all behave. Concrete items, roughly in build order:

1. **`vr.py` one-command start**: makes the cert if missing, starts
   the https server, prints the exact `https://<lan-ip>:<port>`
   address plus the three headset steps, and prints the firewall
   command to run if the port looks closed. README quickstart gains a
   "VR in one command" block. This is the productized version of what
   getting the Quest 2 online actually took.
2. **Seed controls act.** `control_after_generate` is parsed and
   displayed but nothing applies it at queue time, so re-queueing an
   untouched workflow sends a byte-identical prompt and ComfyUI's
   output cache executes nothing. That is the "queue does nothing"
   report. On queue: use the current seed, then apply randomize /
   increment / decrement to the widget and repaint the panel.
3. **LoadImage panels show their image.** Nodes with an input-file
   combo fetch `/view?filename=...&type=input` on parse and on every
   combo change into the panel image slot. Verify the selected name
   actually lands in the API prompt. Upload button deferred.
4. **Slider ranges**: curated soft ranges (steps, width, height, cfg,
   denoise), log mapping when max/min exceeds about 1000, fine nudge
   (wheel on desktop, stick flick in XR).
5. **Note and MarkdownNote full-text panels** (kill the 3-line clamp).
6. **Snap stale combo values** to the first available option, marked
   visually as substituted (the sample workflows reference checkpoints
   strangers do not have; queueing fails validation until they cycle
   the combo).
7. **In-XR hint when the text editor opens** (it opens on the monitor;
   say so in-space instead of appearing dead).

Tests for the next headset session, in order: queue twice without
touching anything and expect two different images in the gallery;
cycle LoadImage through three files and expect the panel preview to
follow and the generation to use the third; drag the steps slider and
expect single-step control; open a long markdown note and read all of
it; fresh-clone first run without the sample checkpoints and expect a
marked substitution instead of a validation error.

Status 2026-08-28: spike 1 SHIPPED (commit 980e09e) and verified live,
including a real double-queue with distinct seeds. The error handling
overhaul below also SHIPPED early (commit 8c12382) because the neurodes
queue failures forced it: rejections and execution errors now land on
the offending panels in red, the core panel carries the message, and
the HUD shows queue depth. Root causes fixed the same day: V3 "COMBO"
specs, AUTOGROW dynamic input groups, and by-name widget matching for
workflows saved against older node definitions. Every neurodes
workflow now validates. The vision track (voice + agent harness) lives
in `JARVIS.md`.

## Spike 2 (in progress)

Done 2026-08-28: node delete (✕ in every node panel header, tap to
arm, second tap within 2.6s deletes and unwires; works by ray in VR
and desktop alike; `removeNodeFromGraph` keeps live graph and raw JSON
consistent, verified). The palette lost the "accrete" nomenclature: it
is titled "add node", sorts types already used in the workflow first,
and typing filters it with the same fuzzy keys the stock frontend
searches (name, display_name, search_aliases; schema now carries
aliases and category). Also done 2026-08-28: the WORKFLOW BROWSER and the LAYOUT SIDECAR.
A library sigil sits at the constellation origin (distance-scaled like
hub sigils); its BROWSE button opens a paged, filterable panel over
the full index (repo-local + all userdata, underscore-prefixed scratch
files excluded). Open workflows sort first with a filled dot; clicking
one flies to it, its right edge closes it (Hub.dispose folds beams,
panels, gallery, group). New hubs stand in the widest angular gap on
the horizon ring; constellation threads rebuild on every open/close.
Layouts write to `layouts/<source>__<name>.json` (endpoints in BOTH
server modes; localStorage fallback in demo), debounced 1.2s after any
move/add/delete, merged over the embedded layout at every load.
Verified: open beyond the old 12-cap, move, close, reopen, placement
identical. The VR back-out gesture shipped as the wrist watch (BACK
OUT / EXIT VR / queue status on the left wrist). Remaining: the J0
agent bridge (JARVIS.md). The hosted demo page (design below) rides
whenever a gap opens. Widget coverage research (below) still open.

### Node search (research done 2026-08-28)

How the stock ComfyUI frontend searches nodes, from the installed
frontend bundle and server source:

- There is NO backend search endpoint. `/object_info` is the full dump
  and the frontend searches it client-side.
- The search is Fuse.js fuzzy matching over exactly three keys:
  `name`, `display_name`, `search_aliases` (node classes may declare
  `SEARCH_ALIASES`, shipped through object_info). No regex, no
  embeddings. Category and description are used for grouping and
  filter chips, not fuzzy matching.

Implications for comfyvr: we already cache full object_info in live
mode, so matching stock behavior is a small client-side scorer over
the same three keys (vendor fuse.js for exact parity, or a
dependency-free subsequence scorer). The VR answer is threefold:
fuzzy text where a keyboard exists; a pinch-only category drill-down
from the `category` paths (`sampling/custom` etc); and voice via the
JARVIS layer, where STT + fuzzy is a natural pair because fuzzy
absorbs transcription errors. Semantic search over node descriptions
and tooltips (embeddings) is an upgrade nobody ships today; roadmap.

## Editing scope (position, not backlog)

How much of the ComfyUI interface is this trying to be? Position: all
of the RUN loop and most of the REMIX loop, not a clone of the 2D
authoring canvas. Inhabiting, running, tweaking, rewiring, growing
nodes from dropped wires, and remixing PNGs into hubs are the product.
Building a dense 40-node workflow from a blank floor is what the 2D
editor is for, and every file stays round-trippable so people can hop
between the two freely. The authoring ladder we do climb, in order:
node delete, palette open anywhere (search all node types, not just
link-compatible ones), then a new-empty-workflow hub seeded from a
template. Anything past that has to earn its place in VR terms.

### Spike 3: real gaussian splats (SHIPPED 2026-08-28, desktop verified)

Shipped same day: vendored `gaussian-splats-3d` 0.4.7 (dynamic import,
nobody pays the 600KB until a splat materializes), DropInViewer with
`sharedMemoryForWorkers: false` (no cross-origin-isolation headers on
our servers) and explicit `format` (extension sniffing fails on /view
query URLs). Gaussian PLYs detected by `f_dc_0` in the header via a
Range request; mesh PLYs keep the old path. Splats materialize at
NATIVE scale (a room stays walkable), rotated 180 about x (splat
scenes are y-down), and do not idle-spin. Showcase recall: boot scans
ComfyUI's `/internal/files/output` (bare path in hosted mode, the /api
alias does NOT cover the internal sub-app; /api-prefixed through the
standalone proxy) and hangs `cvr_demo_*` 3D files on the first hub.
`cvr_demo_plush.splat` (9MB) and `cvr_demo_room.splat` (49MB, a real
captured room) live in the output dir. Plush loads in ~3.6s desktop.
UNTESTED: Quest framerate; decimation deferred until the field report.
Original plan follows:

### Spike 3 original plan (defined 2026-08-28)

Today splat PLYs materialize as point clouds (raw gaussian centers).
The real thing needs per-splat covariance, opacity, and depth-sorted
alpha blending. Plan:

- **Renderer**: vendor `@mkkellogg/gaussian-splats-3d` (three r160
  compatible) and try it first; if its worker setup fights our
  no-build vendoring, fall back to a minimal in-house renderer
  (instanced quads + a sort worker, the antimatter15 shape, a few
  hundred lines).
- **Detection** in assets.js: gaussian PLYs are recognizable from the
  header (`f_dc_0`, `scale_0`, `rot_0` properties); also accept
  `.splat`, `.ksplat`, `.spz`. Mesh PLYs keep the current path.
- **Quest budget**: decimate at load, ranked by opacity times volume.
  Around 250k splats in XR at 72Hz stereo is the realistic ceiling on
  the XR2; desktop gets the full set. The splat renders as a real
  object (normal blending, depth on) while holograms stay additive.
- **Content without a local GPU**: rendering is cheap, TRAINING is
  what the laptop cannot do, and phones solve it: Scaniverse trains
  splats on-device for free and exports PLY; Luma and Polycam process
  in the cloud. Generative single-image splats (LGM and friends via
  ComfyUI-3D-Pack) want more VRAM than a GTX 1080; RunPod when that
  matters.
- **The demo**: scan your own room with a phone, drop the PLY into the
  space, materialize it on the gallery rim, and step inside it in VR.
  A captured place hanging inside the workflow universe.

### Spike 4: text entry in VR (SHIPPED 2026-08-29, desktop verified)

Text rows no longer bounce to the monitor in XR. Pinching a text field
opens an in-space keyboard panel (new `keys` + `kbuf` row kinds in
panels.js, per-key hover highlight via `setHotFrac`): number row, three
letter rows, then shift / SYM / space / backspace / clear / cancel /
OK, and a DICTATE button. SYM swaps the letter rows for a symbol layer
built for prompt syntax: `()[]{}<>:;`, `,.|_-+=/\*`, `'"!?@#%&~^`
(weights, alternation, loras, wildcards all typeable). The keyboard is
the VR counterpart of the desktop editor modal, same contract: opens
preloaded with the field text, edits a buffer copy, OK commits, ✕
discards, the widget is untouched until OK. Buffer shows the last 6
wrapped lines (2 for oneline fields); caret is pinned to the end, so
editing is append/backspace/dictate. Mid-text caret placement (pinch a
spot in the buffer to put the caret there) is the natural next step if
tail-editing proves too limiting. Dictation records with MediaRecorder (webm/opus),
POSTs to `LOCAL + '/stt'`, and both servers proxy that to a local
whisper sidecar speaking the OpenAI audio API on 127.0.0.1:8765
(override with COMFYVR_STT). Speakwright is the sidecar it was built
against; both wav and webm/opus verified through the full TLS proxy
chain. The sidecar binds localhost only, so the headset never needs a
second origin or cert. Fail-soft: no sidecar means a readable flash
and the keys keep working; closing the keyboard mid-recording drops
the transcript; commit checks the target panel is not disposed. Mic
permission is requested lazily on the first DICTATE tap (Quest pauses
the immersive session for the dialog once). Desktop keeps the DOM
editor; the keyboard is testable flat via `CVR.openKbd` / `CVR.kbdKey`.
Same session: the wrist watch now billboards to the eyes per frame
(`lookAt(camWorld)` in the tick, like core panels) instead of the
fixed tilt, so it reads at any wrist angle. UNTESTED in-headset: key
reachability at 6m spawn distance, dictation round-trip latency on
Quest, watch readability while moving.

### Widget coverage research

Inventory `/object_info` widget and input types across popular node
packs (Impact, rgthree, WAS, common ComfyUI-Manager installs) and
bucket them: works generically now, needs text entry, needs a
file/image picker, needs a bespoke widget. Turns "will my nodes work"
into a table instead of a shrug.

### Error handling overhaul (design)

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

### Hosted demo page (gate 5, design)

Demo mode needs a static fallback for the sample workflows (they are
currently fetched from the server; embed them or fetch-with-fallback)
and then the `public/` folder minus proxy runs on GitHub Pages. Link it
from the README so people can fly before installing.

### Deeper gallery recall (design)

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
| `make_cert.py` | Self-signed cert for `server.py --tls` (LAN VR, no cable) |
| `quest.ps1` | Windows helper: adb reverse + in-headset steps (USB path) |

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
