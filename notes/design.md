# comfyvr — design

Substrate's liminal node-space (D:\liminal\scenes\substrate) turned into a real
frontend for ComfyUI. Panels are holographic machine-faces; beams are the
actual workflow links; pulses are the actual execution. Desktop first, but
every architectural choice keeps the WebXR door open (three.js scene graph,
no DOM-dependent UI in-world, interactions expressed as ray + point).

## The two views

**Space (outer workflow view).** Every workflow is a hub in a constellation.
Folded, a hub is a *sigil*: one small billboard panel (glyph, name, node
count, status) plus a beacon glow. Faint threads connect hubs that share a
checkpoint — workflows that drink from the same model. You drift between
them like substrate's beacons.

**Hub (workflow view).** Fly close (or click a sigil) and the hub unfolds:
an amphitheater of concentric rings, one ring per topological depth of the
DAG. Loaders at the bottom center, each successive layer a wider, higher,
ring — sampler mid-bowl, decode/save on the rim. The gallery of generations
crowns the top ring. Panels are curved onto the ring cylinder itself, facing
the core. Beams arc outward tier to tier; during a run, real pulses climb
the bowl. Accent color per panel = its primary output type (litegraph link
colors, neonized): MODEL purple at the core rising through CONDITIONING
orange and LATENT pink to IMAGE blue at the rim. The DAG is the rainbow.

## Truth model

The workflow JSON (litegraph format) is the single source of truth. Panels
render from it; edits mutate it; QUEUE converts it to API format (widget
name matching via /object_info, control_after_generate skipped) and POSTs
/prompt. 3D layout is derived (topo depth), never stored in the file, so
files stay vanilla-ComfyUI-compatible. SAVE writes back to workflows/.

## Modes

- **LIVE**: server.py proxies /api/* and /ws to ComfyUI (default
  127.0.0.1:8188 — no CORS games). object_info drives widget schemas; ws
  `executing`/`progress`/`executed` events (routed by prompt_id) drive panel
  glow, progress rows, pulses; binary preview frames land on the core
  panel; outputs are fetched via /view and accrete onto the gallery ring.
- **DEMO**: no backend. Builtin schema for the standard nodes, simulated
  topological execution with the same event interface, procedural
  placeholder "generations". The space is fully explorable cold.

## Interaction (desktop)

Drag look, WASD/QE drift, Shift hurry, wheel nudge. Click sigil → fly in +
unfold. Click panel → dock (glide to reading distance, parallax sway).
Within reach, elements are live: numeric widgets drag as sliders, combos
cycle, seeds reroll on click, text opens a DOM overlay editor (desktop
affordance — in VR this becomes the paired phone keyboard). ESC steps back
panel → hub → space. Idle 20s → gentle orbit around the current focus.
All interactions make synthesized movie-computer noises; 'm' mutes.

## VR path (later, kept cheap by design)

renderer.xr.enable + controller rays replacing the mouse ray; dock becomes
"pull panel to you"; phone joins the session as the text-entry surface via
the same server (websocket room). Canvas textures may need a resolution
bump / MSDF for headset legibility. Mobile: touch look + tap dock; a docked
panel degrades toward a 2D card.

## Graph surgery (M1, shipped)

- **Move**: the panel HEADER is the grab handle (title bar = window manager
  instinct). Dragging maps the pointer ray onto the node's ring cylinder —
  theta and height change, the panel keeps facing the centroid axis by
  construction. Mouse wheel *while holding* pulls the node radially between
  rings (geometry re-curves to the new radius). Positions persist in
  raw.extra.comfyvr.layout — vanilla ComfyUI carries the key untouched.
- **Rewire**: port dots are grabbable within reach. Drag from an OUTPUT dot
  → a new link seeking an input (an input holds one link, so landing on an
  occupied input displaces it). Drag a connected INPUT dot → grab that
  link's end: drop on a compatible input to retarget, drop in space to
  detach. While dragging, every compatible port in the hub halos.
- **Accrete**: drop an output-drag into empty space → a palette panel blooms
  at the drop point listing node types that accept that link type; picking
  one grows the node there, wired. (Candidates come from the loaded schema
  for now; full object_info search waits for the phone-keyboard companion.)

## Milestones

- **M0 (done)**: server + proxy, constellation + sigils + threads,
  amphitheater hubs from real workflow JSON, widget editing, queue, pulses
  (live + demo), gallery ring, sound, LIVE/DEMO status.
- **M1 (done)**: node move / rewire / detach / accrete palette, full
  wiring serialization, layout persistence in extra.comfyvr.
- **M1.5**: node delete, drag-drop of workflow JSON / PNG-with-embedded-
  workflow into the space (provenance accretion), ComfyUI userdata workflow
  listing, history back-fill of galleries, object_info-wide palette search.
- **M2 (foundation in)**: WebXR. ENTER VR button appears when a headset is
  reachable; the fly/dock logic moves a rig while the headset drives the
  camera. Controller rays reuse the exact desktop interaction layer (dock,
  widgets, header-move, port-drag rewiring, palette) via select events —
  which Quest also emits for hand-tracked pinch, so hands work wherever
  controllers do. Left stick flies along gaze, right stick snap-turns 30°
  and moves vertically; flyTo teleports instead of gliding for comfort.
  Text entry stays on desktop until the phone-keyboard companion.
  **Connecting a Quest**: WebXR needs a secure context. Either
  `adb reverse tcp:8189 tcp:8189` and open http://localhost:8189 in the
  Quest browser (localhost is exempt), or tunnel https (cloudflared).
  Still ahead in M2: phone keyboard, multi-client presence, hand meshes.

## Non-goals (for now)

Group nodes/subgraphs, node bypass modes, custom-node widget exotica
(IMAGEUPLOAD is faked as a combo), text legibility at distance (vibe first),
persistence of camera/space state.

## Interface primitives (open design thread, 2026-08-28)

Everything selectable in the space today is a list of buttons on a panel.
That was the right first primitive, and it is starting to strain: the
add-node palette wants hundreds of items, the coming workflow browser wants
dozens of rich ones, and nodes themselves sometimes want more surface than
a stack of rows. Candidate primitives, roughly from cheap to wild:

- **Paged list** (have it): buttons + a pager row. Pinch-native, low
  information density.
- **Category tree** (have it): drill-down with counts. Good when the
  taxonomy is real, useless when it is not.
- **Groups / sections inside a panel**: collapsible row groups, or
  swipeable pages within one node panel (basic | advanced | help), so a
  40-widget node does not become a tower.
- **Miniature previews**: instead of a name, show the thing. The workflow
  browser could render each workflow as a tiny frozen constellation (its
  sigil glyph plus a thumbnail of its ring structure), clustered and
  organized in a small volume. Recognition beats reading, especially in a
  headset. Same idea scales down: a node type in the palette could show a
  micro-panel of its ports instead of just its name.
- **Spatial pickers**: a collection laid onto a surface primitive chosen
  for its shape: ring for peers (the constellation horizon already does
  this), column for ordered depth, sphere shell for large unordered sets.
  Which primitive a collection wants is a design decision per collection,
  not a default.

Rule of thumb worth testing: text is for search, shape is for recognition,
place is for memory. A browser you visit twice should let you find the
thing by remembering WHERE it was.
