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

## Field feedback worth keeping (r/StableDiffusion, 2026-08-30)

"Play Half-Life: Alyx, try Gravity Sketch, avoid transparent tabs."
Taken seriously:

- **Alyx** is the benchmark for direct manipulation with WEIGHT: things
  respond to grabs with presence, two-handed actions feel physical.
  Our grabs are ray-pinches; worth studying where closeness should
  switch to direct touch (a panel within arm's reach could be pressed,
  not rayed).
- **Gravity Sketch** is the benchmark for creation UX in VR: the
  non-dominant hand carries the tool palette, radial menus bloom from
  the wrist, two hands scale and rotate the world. We are already
  drifting toward its wrist-as-toolbelt (watch, keyboard, push-to-
  talk); lean in deliberately rather than by accident.
- **Transparent tabs**: additive glass panels lose legibility against
  busy backgrounds. Candidate fixes, in order of cheapness: raise
  glass opacity while a panel is docked for reading; a "solid" reading
  mode per panel; dim the world behind a docked panel (vignette).
  Legibility is a comfort feature, not a style choice.

The "additional dimension and complexity" comment reads as intended:
complexity is the material here, the job is making it legible.

## Hand rendering options (noted 2026-08-30)

Shipped: joints as glowing spheres, the simple base. The knob to add
later is a hand STYLE option, all driven by the same 25 joints:

- **Skeleton**: bones as thin additive lines between joints, sci-fi
  wireframe hands.
- **Particles**: joints emit slow sparks; motion leaves faint trails.
  Expensive-looking, cheap to do (we own a particle idiom in beams).
- **Pinch feedback everywhere**: the thumb-to-index gap rendered as a
  brightening arc as a pinch closes, so the select gesture telegraphs
  itself before it fires. Probably the highest-value one; it is
  feedback, not decoration.
- **Workflow hands** (the house-special idea): each hand IS a little
  workflow. The hand skeleton is already a DAG, wrist as the root,
  five branches, tips as leaves: render joints as mini node panels
  and bones as beams, and run a pulse from wrist to fingertip when a
  pinch fires, so the select gesture reads as an execution. The user
  wearing the product's own data model as their body.
- **Plain grey hands**: a quiet, neutral option for people who want
  normal-looking hands, and for videos where the audience should read
  "hands" instantly with zero explanation.
- **Spaghetti hands** (user request 2026-08-31): bones as wobbly
  noodles, verlet-ish lag so fingers overshoot and settle. Pure joy
  feature, and a good stress test of the style layer since it needs
  per-frame physics on the same 25 joints.
- **Mesh hands** last: real skinned hands fight the holographic
  aesthetic and cost the most. UPDATE 2026-08-31: mesh hands stop
  being a style and become the WEARABLE layer once generated hands
  exist; see notes/space-packs.md. Hand styles are the first
  consumers of that layer, current joints rendering is the default
  style.

## Image pickers on every image widget (noted 2026-08-31)

Anywhere a panel shows an image preview for a widget flagged
imageInput (LoadImage and friends), pinching the image should offer
a source browse. Sources, easiest first:

1. **Server-side browse**: page through the input dir (and outputs)
   as thumbnails in a picker panel; pure comfy API, works in VR
   today, no platform tricks. Ship this first.
2. **USE AS INPUT from the gallery**: pinch any gallery output and
   point it at an image widget. This is the workflow-chaining
   bridge (t2i output feeding img2img or make-vr-asset input) and
   costs one upload call; img2img-remix plus a screenshot already
   demos the loop.
3. **Headset gallery / file picker**: WebXR has NO native file
   picker inside an immersive session. Reality: an <input
   type=file> click works in the Quest browser 2D page (picker
   reaches headset storage and camera roll), so the flow is either
   (a) session pauses to the 2D page for the pick and re-enters, or
   (b) dom-overlay, which Quest browser supports for immersive-ar
   and only inconsistently for vr; needs a field test before we
   promise it. Design for (a) with a polite "stepping out to pick"
   flash, treat (b) as an upgrade if it tests well.

## World layout modes (noted 2026-08-30)

The horizon (current) is one answer to "where do workflows live."
Others worth imagining:

- **Orrery**: the operator stays put; the constellation lives on a
  great sphere around or before them that ROTATES and BREATHES to
  bring the wanted thing into reach. Referential motion instead of
  locomotion: you never travel, the world serves you. This pairs
  naturally with the voice agent ("bring me the portrait workflow"
  rotates it in) and with the ergonomics notes: the golden zone stays
  fixed and the world flows through it, which is exactly a lean line
  moving past a stationary station. COMFORT WARNING: a world rotating
  around a stationary user is textbook vection; mitigations are snap
  rotation, brief fades, and continuous motion along radials only
  (expand and contract reads far safer than yaw).
- **Assembly line**: workflows or stations in a walkable row, the
  operator strolls the line. The most literal lean translation; maybe
  the right mode for a single huge workflow rather than for the
  constellation.
- **Orbital station (subgraph workstation, noted 2026-08-30)**: the
  DAG as the workstation itself. A spine carries the top-level
  workflow; each subgraph instance is a docked MODULE hanging off it.
  Approach a module and it opens into its own small amphitheater.
  This moved from imagination to buildable today: parseWorkflow now
  parses every subgraph definition into `graph.defs`, so the interior
  of a subgraph exists as a first-class graph object the renderer
  could stand up with the exact machinery hubs already use. Swapping
  stations falls out of the boundary model: the -10/-20 io boundary
  IS the docking collar, and two definitions with the same input and
  output signature are interchangeable modules, so "swap this stage
  out" is a palette filtered by boundary signature. It also settles
  the groups-versus-subgraphs rendering question: groups are wedges
  of one amphitheater, subgraphs are separate rooms.
- **Higher-dimensional views (noted 2026-08-30)**, three readings in
  increasing wildness:
  1. Projection rotation: the layout is already one projection of a
     higher-dimensional description of each workflow (graph depth,
     category, checkpoint family, touch frequency, recency). Make
     several arrangements meaningful and let the view ROTATE between
     them, a rotation in layout space rather than world space. The
     transition itself is information: hubs that stay neighbors
     across many projections are deeply related, and you see that as
     they travel together.
  2. Hyperbolic space: the classic host for big DAGs and libraries
     (Munzner's H3 lineage). Exponential volume means every workflow
     can sit one step from the center; things swell as you approach
     in a pleasantly dreamlike way. Doable as a Poincare-ball
     projection in a shader; comfort untested; likely a LIBRARY view
     rather than the working space.
  3. Time as the fourth axis: a completed run is a trajectory
     (execution order, pulses, outputs being born). Scrubbing a run
     is travel along that axis and the gallery is a slice of it.
     Pairs naturally with disk-based gallery recall, since the
     output folder is already a time series.
- Modes are a per-user preference, not a redesign: all of these are
  placements of the same hubs, and the layout sidecar already knows
  how to remember arrangements per mode key.

## Scenes (noted 2026-08-30)

The environment dressing is a separate axis from layout. One rule
first: the motes earn their place because they are a state display
(self-motion made visible) disguised as decoration. Every scene
element should pass the same test: encode something (motion, system
state, provenance), or stay out.

- **Space** (current): darkness buys panel legibility for free, and
  the motes carry vection. The baseline to beat.
- **Deep ocean**: marine snow beats motes for vection (denser, slow,
  omnidirectional), bioluminescence justifies the glow aesthetic
  outright, and the darkness win carries over. Hubs at whale-fall
  distances; a queue pulse reads as jellyfish propulsion.
- **Weather as andon**: scene-scale state display. Queue busy makes
  auroras ripple, an error puts a distant storm cell over that hub's
  bearing, all-idle is still air. The system's health reaches you
  peripherally before any panel is read.
- **The splat IS the scene**: the loader already materializes walk-in
  rooms, so any splat can be promoted to WORLD, your scanned living
  room as the environment with workflows floating in it. With
  make-vr-asset the loop closes: generate a place, then work inside
  the place you generated. Scene generation becomes just another
  workflow output class.
- **Holodeck baseline**: a deliberately empty gridded room that
  materializes only what is summoned. Cheapest to render, best
  framerate, and the crowd already reached for the word unprompted.

## Groups (design 2026-08-30)

ComfyUI groups are named colored boxes in the 2D canvas: the workflow
JSON carries `groups: [{title, bounding, color}]` and membership is
GEOMETRIC, a node belongs to whichever box contains its 2D position.
The 2D positions survive in the raw JSON even though the amphitheater
derives its own layout, so membership is computable at parse time.

Representation: a group becomes an angular WEDGE of the amphitheater.
Members cluster within a contiguous arc across their depth rings, the
wedge gets a faint colored band arcing along the rim in the group's
own color, and the title floats at the band's crown as a small glyph
panel. This is "place is for memory" applied: the group gives its
nodes a shared place, exactly what boxes do in 2D, without stealing
the panel accent (which stays link-type, the DAG rainbow).

Mechanics, when built: parse computes group membership from bounding
boxes; layout adds a group term so members attract into a shared
angular sector (overrides still win); the band and title render per
group; and the agent's `arrange(hub, 'groups')` uses the same term.
Groups are also the natural unit for the agent to talk about: "the
upscale group is erroring" beats naming four nodes.
