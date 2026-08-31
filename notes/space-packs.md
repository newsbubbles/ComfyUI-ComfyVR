# Space packs: node packs FOR ComfyVR (noted 2026-08-31)

The user's framing: node packs that have control over some SUBSPACE
of the global workspace that is the current experience. Not features
baked into comfyvr core; packs that extend what the space can do,
the same way exploring a room splat already feels like the space
grew a room. Core stays a substrate. Packs are experiences.

## The layering doctrine (stated by the user, adopt as law)

Everything on its own layer. comfyvr core renders workflows, ships
the interaction grammar (pinch, pull, palette, gallery, placards)
and the materialization pipeline (image, video, audio, mesh, splat).
A SPACE PACK is a ComfyUI custom node pack that ALSO ships a
comfyvr-side extension: new output types with their own
materialization behavior, and optionally an interaction claim over
a region (a subspace) of the world. Precedent already exists in
comfy itself: custom nodes ship frontend extensions via their web/
dir; we define the equivalent contract for the 3D frontend.

## What a space pack can claim

- A TYPE: "when a workflow outputs RIG / HANDS / AVATAR / WORLD,
  materialize it like THIS" (beyond the built-in placard types).
- A SUBSPACE: an anchored region where the pack's interactions are
  live (a rigging bay, a fitting room, a mirror). The pack does not
  get the whole world; it gets a place in it.
- WEARABLES: outputs that attach to the user's tracked body instead
  of standing in the world. Hands first.

## The standardized rig: XRHand joints ARE the spec

WebXR already gives us 25 named joints per hand (wrist, thumb x4,
four fingers x5). A generated hand model is WEARABLE if it is a glb
whose skeleton bones map to the XRHand joint names (or a declared
subset). Driving it is direct: joint pose -> bone pose per frame,
no IK, no retargeting. This makes "make yourself new hands" the
EASIEST possible try-on: full-body avatars need solving for a body
we do not track; hands are 1:1 with what the headset hands us.
Define the mapping once (bone naming convention + rest pose in
comfyvr docs) and any rigging workflow that emits it produces
wearable output.

## The flagship demo: make yourself new hands

1. Text-to-image workflow generates the look (a hand concept sheet).
2. Image-to-3D workflow makes the mesh (make-vr-asset lane, local
   Hunyuan3D or Run On to a pod for the heavy models).
3. Rig workflow fits a skeleton (ComfyUI-UniRig exists and outputs
   rigged FBX; a small node maps/renames bones to the XRHand
   convention; this bone-map node may be our first space-pack node).
4. Pinch the placard: instead of standing in the world, the hands
   REPLACE your hand rendering. You wear the thing the graph made,
   in the space where you made it.

Spaghetti hands (the user's ask, and correct) is the same mechanism
with a procedural model instead of a generated one: hand styles
become the first consumers of the wearable layer, so the layer
ships with content on day one. Current handViz (25 glowing joints)
becomes just the default style.

Chaining note: steps 1-3 chain through images and meshes that today
must round-trip through the output folder. Two bridging affordances
make it fluid: USE AS INPUT on any gallery image (pinch an output,
point it at another workflow's LoadImage) and the image picker (see
design.md). Both are core affordances, not pack features.

## The WORLD claim: packs that change the environment (2026-08-31)

The user's ask: a node pack that changes the actual environment of
comfyvr itself. Ladder, cheapest first:

1. NO PACK AT ALL: an output-name convention, like the showcase
   already uses. A workflow whose output lands as `cvr_world_*.spz`
   (or .splat/.ply) gets a placard whose pinch promotes it to the
   ENVIRONMENT instead of a standing asset: the space's backdrop
   becomes that splat, hubs float inside it. HYWorld2 (panorama to
   scene splat) plus this convention = generate a place, work in it,
   zero new node code. This is the make-vr-world sample.
2. A SetEnvironment NODE: outputs a small ENV spec (skybox or splat
   ref, fog color and density, mote density, light tint) that
   comfyvr applies when the run completes. The workflow does not
   just produce things anymore; finishing a run can change the
   weather. Doubles as run-state theater done by the graph itself.
3. Full scene subspace claims come later with the pack contract.

Tie-in decided with the user (2026-08-31): the ENV spec targets the
SCENE INTERFACE from the workspace refactor (design.md, "Scene as a
class"), so an environment is never only a splat. A spec can name a
scene class plus parameters (stellar with amber motes), a skybox
image, a splat, or any future scene module a space pack registers.
One interface serves the mode system, the env node, and the world
claim. Heavy environment generation (HYWorld2-class models) is a
Run On workload for the 1080-bound; the env pack should assume
remote execution is normal, not exceptional.

## Partitioned workspaces: the programmable-matter layout (2026-08-31)

The user's long-form vision, recorded for when it is time. Imagine a
workspace where every workflow outputs world-stuff (splats, assets,
motion, physics params) and the workflows are ARRANGED so that they
partition the actual 3D space: each workflow owns a region, its
outputs materialize INTO that region, and the region is the scene
it generates and runs. Live nodes act as dynamics controls for
their partition (wind, spawn rate, gravity, palette), so editing
the graph is editing the place while you stand in it. At that
point layouts stop being furniture arrangement and become SPACE
LAYOUTS: the arrangement of the workflows is the composition of
the world.

Mechanics to work out when we get there:

- Partition assignment: implicit (a Voronoi cell around each hub's
  anchor) versus explicit (user-drawn bounds, like groups but
  volumetric). Probably implicit first with manual override, the
  same philosophy as layout overrides today.
- Materialization targeting: a workflow's outputs land in its own
  partition by default; cvr_world_ scales down from "the whole
  environment" to "my region's environment."
- Live nodes: a space-pack node type whose widget edits act
  CONTINUOUSLY on the partition rather than through a queue cycle.
  This is where the run-loop question gets real (re-run on change,
  streaming nodes, or an agent tending it).
- The whole thing leans on Run On for anyone GPU-poor, since a
  workspace of generating regions is many workflows warm at once.

Why we believe the audience exists: ComfyUI itself proved people
adopt visual programming far past the comfort point when the output
is worth it, and the prior-art spike (notes/prior-art.md) shows
everyone who built in-world programming built a new world and asked
programmers to move in; nobody built the world around an existing
programming community's own graphs. This is the game you program
while it runs, arrived at from the tool side instead of the game
side.

## Why this is the right direction

- It answers "why VR" with things FLAT COMFY CANNOT DO: wearing
  output, walking into output, fitting a rig around your own hand.
- It gives node pack authors a reason to target comfyvr
  specifically, which is a moat no host or wrapper has.
- It scales the roadmap far pile (rigging and animation in VR,
  physics, 4D splats) into pack-sized bites instead of core bloat.
- Rigs-on-models in a fitting bay is the avatar project's try-on
  (P3) at hand scale first; the full avatar mirror is the same
  contract grown up.

## Open questions

- Extension loading: how does a pack's space extension reach the
  page? (comfy already serves custom node web/ dirs; likely the
  same route, with a comfyvr.json manifest declaring types claimed.)
- Sandboxing: a pack's js runs in our page; start with a curated
  allowlist (our own packs) before any open contract.
- The bone-map node and the wearable loader are the MVP; the
  subspace claim (rigging bay) can come much later.
