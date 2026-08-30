# Ergonomic layout: the workflow as a workstation

Field feedback (r/StableDiffusion, 2026-08-30): lay out subgraphs "like
a lean manufacturing station, ergonomically oriented toward the human
operator." Research and imagination notes; nothing here is scheduled.

## What lean already knows

A century of industrial engineering solved "arrange a process around a
human body." The vocabulary transfers almost verbatim:

- **Reach zones.** Zone 1 (primary): swept by the forearm with elbows
  at the sides; shoulders stay relaxed. Zone 2: full arm extension.
  Zone 3: requires leaning or stepping, and lean calls this the dead
  zone; every reach into it is motion waste. The **golden zone** is
  waist-to-shoulder height in zone 1: things touched all day live
  there, and only there.
- **Motion economy.** Movements away from neutral must be paid for
  twice (out and back). People move in arcs, not lines. Fixed,
  consistent locations for tools turn reaching into ballistic,
  eyes-free motion: the hand learns where the thing IS.
- **Point of use.** Parts and tools arrive where the work happens,
  when it happens, not in taxonomy order somewhere else.
- **Flow.** The U-shaped cell puts process order in a walkable arc;
  the operator turns, not treks.
- **Andon and poka-yoke.** State is visible at a glance from anywhere
  (lights); mistakes are made structurally hard (guards, keying).
- Measured payoff of doing this right, from an industrial assembly
  study: roughly 35% lower mental workload, 5% productivity, 8%
  shorter working time, 4 to 5% fewer defects, from layout alone.

## What VR research knows

- UI wants to sit at roughly arm's length to 1.5m, slightly BELOW eye
  level: people naturally gaze a few degrees down.
- Comfortable head yaw is about 30 degrees each side (55 max);
  comfortable pitch is about 20 up and 12 down. There is a roughly
  30x30 degree cone where content is visible without moving the head
  at all.
- Sustained interaction above shoulder height produces gorilla arm;
  above eye level adds neck strain. Frequent targets must not live up
  there.

The two literatures agree: there is a small, precious volume in front
of the lower chest, and everything a person touches often belongs in
it.

## The synthesis: touch frequency is the layout variable

Today the amphitheater assigns position by TOPOLOGY: depth picks the
ring, and every ring is at panel-reading height. Topology is the right
variable for reading flow, and the wrong one for working. A
CheckpointLoader is set once a week; the prompt is edited forty times
a session; both currently get the same ergonomic rank.

The lean layout inverts this: **flow stays legible as sequence, but
placement within the sequence is ranked by touch frequency.**

- **Primary zone** (the golden shell: forward arc within comfortable
  yaw, slightly below eye level, dockable to arm's length): the
  widgets actually edited in a session. Prompt, seed, steps, cfg,
  resolution, denoise, the LoRA strength being tuned.
- **Secondary**: occasionally touched. Sampler and scheduler combos,
  batch size, file pickers.
- **Peripheral**: set-once plumbing. Loaders, VAE, CLIP, save nodes.
  Visible (flow must read), but high, wide, or far is fine.

Where does frequency come from? Priors first: widget names rank
themselves (prompt > seed > steps > cfg > size > ... > vae_name). Then
measured: every edit already flows through one event surface, so the
space can LEARN each workflow's real touch pattern per user. The
workflow slowly rearranges toward how its operator actually works it.
Standard work still matters: the same control should land in the same
place across workflows, so reaching becomes ballistic. QUEUE lives on
the wrist for exactly this reason.

## The operator console (the sharpest version of the idea)

Lean would not walk the operator to forty stations. It would build ONE
fitted station: the few controls that matter within forearm reach,
everything else visible down the line. Translated: a per-workflow
**console panel**, auto-assembled from the top-N most-touched widgets
across all nodes, floating in the golden zone at dock distance. The
full amphitheater stays as the line behind it; touching a console row
highlights its source node so the mapping stays legible. This is
point-of-use storage for parameters, and it may matter more than any
whole-DAG rearrangement.

## Subgraphs as stations

Each subgraph is a workstation: internally laid out by the same zone
logic, externally one unit on the line. The operator moves station to
station (or the line brings stations to the operator; see world modes
in design.md). Station boundaries are also natural agent vocabulary:
"the upscale station is erroring."

## Scoring it (when this becomes an algorithm)

An ergonomic arrange scheme is a placement optimization:

    cost = sum_i  f_i * effort(p_i)  +  lambda * flow_illegibility

where f_i is touch frequency, effort(p) grows with angular deviation
from the forward-down comfort cone, height deviation from the golden
shell, and distance beyond dock range; the flow term charges for
sequence scrambling and beam crossings. Greedy works: rank by f_i,
fill the golden shell first, keep topo order along the arc within each
shell. This slots straight into the existing layout override system
and the agent's arrange(hub, 'ergonomic').

## What the space already gets right, in lean terms

- Wrist watch and keyboard: the tool belt; point-of-use controls.
- Beacon states: andon lights, shipped as andon without knowing it.
- Delete arming, combo validation, say() caps: poka-yoke.
- Rings as flow: lean endorses sequence-as-geometry.

And wrong: ring height follows depth, so tall workflows push hot
widgets into gorilla-arm territory; dock distance is uniform
regardless of how often a panel is touched; nothing yet distinguishes
an every-minute widget from a set-once one.

## Open questions

- Does rearranging by frequency fight "place is for memory"? Maybe:
  learned layouts must move SLOWLY, or only on explicit arrange.
- Seated versus standing operators shift the golden shell; calibrate
  from headset height at session start?
- Does the console reduce presence (why be in VR to use one panel)?
  Counter: the console is the cockpit, the amphitheater is the world;
  cockpits did not make flying less immersive.
