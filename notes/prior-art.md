# Prior art: node programming in VR (spike 2026-08-31)

Thread commenters said "this exists" in various forms. It does, and
it is worth knowing exactly where, because the differences are the
position. Cataloged with the same occupied/vacant lens as ever.

## The occupants

- **Resonite ProtoFlux** (lineage: NeosVR LogiX): the closest thing
  alive. Full node-based programming manipulated in 3D with wires in
  space, changes take effect while the world RUNS, real-time
  collaborative editing. This is in-world visual programming done
  seriously for years, and its community is proof the interaction
  model works at scale. The deep difference: ProtoFlux programs
  Resonite. It is a closed social platform with its own engine and
  its own language; the nodes control the world but do not GENERATE
  media, and joining means moving your life there.
- **PatchWorld (PatchXR)**: modular-synth patching in VR, wires and
  boxes as playable instruments, multiplayer. Joyful and polished;
  proof that spatial patching can feel like play rather than work.
  Domain is music and audiovisual performance, not general graphs
  and not an external ecosystem.
- **Meta Horizon Worlds**: started with in-VR Scratch-style code
  blocks, then moved scripting to TypeScript in a DESKTOP editor.
  A retreat worth studying: in-headset programming ergonomics beat
  them, and they had infinite money. Their failure mode (typing,
  abstraction, density) is the exact thing our keyboard, dictation,
  agent, and fold system exist to answer.
- **Unreal Engine VR editor mode** (2016 era): scene editing in VR,
  deprecated after low adoption. Same cautionary tale.
- **Academic prototypes**: FlowMatic (UIST 2020) authored reactive
  VR scenes with graph programming from inside VR and named the
  expressiveness ceiling problem; Ivy (Ens et al.) did spatially
  situated dataflow wiring real sensors to actuators, nodes placed
  AT the things they control (their insight = our "place is for
  memory," independently derived). Both are studies, not products,
  and both report that spatial wires helped comprehension.
- **Nearest neighbors in our own yard**: ComfyStereo (stereo VIEWING
  of comfy outputs, no spatial interface), the 3D node packs in
  notes/3d-ecosystem.md (generate 3D content, flat interface).

## The vacant position (why comfyvr is not any of these)

Every occupant asks you to MOVE: new platform, new language, new
world, content made elsewhere. comfyvr is an additive layer on an
ecosystem that already exists at massive scale: same files, same
server, same custom nodes, walk in and out freely, nothing to
migrate. And it closes a loop none of them have: the graphs it
renders GENERATE the matter that populates the space (images,
video, splats, soon wearables and environments). Resonite's nodes
control a world; ours make one. That loop, plus ecosystem gravity,
is the position claim, and it survived this search.

The "why did nobody go here" answer is now sharper: everyone who
tried in-world programming built a WORLD and asked programmers to
come; nobody took an existing programming community and built the
world around what they already do. Dismissal without meaningful
play, as suspected.

## What to steal on study

- Resonite: wire-grab ergonomics, collab semantics (two hands on
  one graph), live-edit-while-running expectations.
- PatchWorld: nodes as instruments; interaction sounds; the sense
  that touching the graph is playing it. Our audio idiom is already
  pointed this way.
- FlowMatic: their abstraction mechanisms for graph density; they
  hit the legibility wall we call fold/unfold.
- Horizon: read their retreat as a checklist of what breaks first.

Sources: wiki.resonite.com/ProtoFlux, resonite scripting FAQ,
patchxr.com and wiki.patchxr.io, Meta Horizon per-platform
scripting docs, FlowMatic (UIST 2020, dl.acm.org), Ivy (Ens et
al., researchgate), plus thread comments.
