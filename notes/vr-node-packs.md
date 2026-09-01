# ComfyVR-native node packs (user direction, 2026-09-01)

The path from "VR version of comfy" (proven clickbait) to "platform
people build on." The load-bearing analogy: in ComfyUI, node authors
control the visual and realtime side of their nodes through the
JAVASCRIPT half of node development. ComfyVR's equivalent is a node
pack whose 3D interactive form IS the point: the node is the center
point of a base object its interface represents.

## The shape of a VR-native node

A node that projects a 3D object around itself and manipulates it:

- The node's widgets change the object's shape, parameters of its
  parts, materials, pose, in realtime, not per-queue.
- Information flows BACK: the object's state (a grabbed handle's
  position, a measured angle, a selection) can be the node's OUTPUT.
  The interface is bidirectional; the object is both display and
  input device.
- The object hierarchy, code, and interactivity ship WITH the pack,
  the way js ships with a ComfyUI pack today. Premade 3D tools with
  their own behavior, docked into the graph as nodes.
- Core-pack precedent to lean on: ComfyUI already has Load3D and
  friends; a "Load 3D object" that materializes the mesh around the
  node in our space is the gentlest first rung, and the showcase
  gallery already materializes meshes and splats, so the rendering
  path exists.

## Where it plugs into what exists

- notes/space-packs.md owns the layering doctrine (packs are additive
  layers) and the cvr_world_* / cvr_hands_* filename conventions;
  this note is the GENERALIZATION: not just worlds and wearables but
  arbitrary interactive objects, declared by nodes.
- Partitioned workspaces (notes/space-packs.md vision block) is the
  container: a workflow partitions off a subspace and the objects its
  nodes project ARE the interface inside that partition. A VRChat
  pack (sister repo comfyvr-vrc-avatar is the seed) would be exactly
  this: avatar-prep workflows whose partition is a fitting room.
- The agent bridge and the realtime channel matter here: realtime
  manipulation means these run OUTSIDE the queue, over the same
  websocket idiom the space already speaks (queue for heavy compute,
  live channel for interaction, exactly the two-truth model in
  design.md).

## The community adoption play

Demo first, platform second: show potential ComfyVR devs something
cool in VR, then hand them the way to build that UI side themselves.
What they get is a VISUAL API that is VR native, with the full stack
people actually need in VR: meshes, code, rigs, animations, sound.
They bring their own models and whatever code their nodes want.

Why this is the credibility path: the audience splits into "love it"
and "this overcomplicates comfy." The skeptics are not scared of
complexity (many are programmers); the gross-out is the perceived
BUGGINESS underneath. So the conversion story is not more spectacle,
it is visible merit: packs that do something in 3D that flat comfy
cannot express at all, built on an API stable enough that third
parties trust it. VR has to read as an upgrade, not a gimmick with
a workflow attached.

## Nearest concrete rungs (in rough order)

1. Load-3D-object node whose mesh materializes at the node (showcase
   machinery, minimal new surface).
2. A pack manifest field declaring "this node projects an object"
   plus the js-side hook that owns its lifecycle (create, update on
   widget change, dispose), the seed of the visual API.
3. One bidirectional demo: a handle on the object that writes a
   widget value back (object state as node input), because that is
   the moment the interface stops being a viewer.
4. The hands/rigging workflow (already drafted by the user) recast
   as the flagship pack: generate, rig, WEAR, in one partition.
5. Author docs: "build a ComfyVR pack" page, written against rungs
   1-3, before any community push.
