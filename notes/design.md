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

## Milestones

- **M0 (this build)**: server + proxy, constellation + sigils + threads,
  amphitheater hubs from real workflow JSON, widget editing, queue, pulses
  (live + demo), gallery ring, sound, LIVE/DEMO status.
- **M1**: rewiring (drag beam endpoints), node add/delete (object_info
  search palette), drag-drop of workflow JSON / PNG-with-embedded-workflow
  into the space (provenance accretion), ComfyUI userdata workflow listing,
  history back-fill of galleries.
- **M2**: WebXR + phone keyboard companion; multi-client presence.

## Non-goals (for now)

Group nodes/subgraphs, node bypass modes, custom-node widget exotica
(IMAGEUPLOAD is faked as a combo), text legibility at distance (vibe first),
persistence of camera/space state.
