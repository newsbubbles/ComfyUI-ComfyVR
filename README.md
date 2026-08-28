# ComfyVR

Fly through your ComfyUI workflows.

Every workflow you have becomes a glowing hub floating in a dark
constellation. Fly into one and it unfolds into an amphitheater: one ring
of holographic panels per layer of the graph, wires as arcs of light.
Queue a generation and real pulses climb the real wires while the image
forms at the center. Finished outputs hang in a gallery orbiting the
workflow that made them. If the output is a 3D model, you can pull the
actual mesh out of its thumbnail and walk around it.

Works flat on your monitor. Works in VR with controllers. Works in VR
with bare hands. Tested on a real Quest 2, over wifi, no cable and no
developer mode needed.

This is the project from [the "Comfy Workflow Universe" post on
r/comfyui](https://www.reddit.com/r/comfyui/comments/1w0bt1p/comfy_workflow_universe/).

![constellation](docs/constellation.png)
![amphitheater](docs/amphitheater.png)
![gallery](docs/gallery.png)

## Install

Clone into `custom_nodes` and restart ComfyUI:

```
cd ComfyUI/custom_nodes
git clone https://github.com/newsbubbles/ComfyUI-ComfyVR.git
```

Then open:

```
http://127.0.0.1:8188/comfyvr/
```

That's it. No separate server, no configuration, no CORS. It registers
zero nodes, just the frontend route. Your workflow files are never
modified: edits save local copies inside this folder, and everything
stays loadable in vanilla ComfyUI.

There is also a standalone mode (`python server.py`, needs `aiohttp`)
that proxies to any ComfyUI backend, and a demo mode that works with no
backend at all so you can explore the space cold.

## What it does

- **Constellation view**: all your saved workflows as sigils in space,
  with threads connecting workflows that share a checkpoint.
- **Amphitheater view**: the workflow as concentric rings ordered by
  graph depth. Panel colors follow link types: MODEL purple at the core
  out to IMAGE blue at the rim.
- **Real editing**: sliders, combos, seed reroll, prompt text. Drag a
  panel's title bar to move it. Grab a port dot to rewire or unplug a
  link. Drop a wire into empty space and a palette grows a new node
  there, already connected.
- **Sane controls**: sliders travel useful ranges (steps sweeps 1 to
  150, not 1 to 10000), mouse wheel fine-nudges one step at a time,
  seeds with randomize actually randomize between queues, and stored
  checkpoint names you do not have snap to ones you do, marked in
  amber. Notes render in full, and LoadImage shows the image it points
  at.
- **Real execution**: queue from inside the space. Websocket events
  drive panel glow, progress bars, live preview at the hub core, and
  finished images flying up to the gallery.
- **3D outputs**: GLB, OBJ, and PLY results get a placard. Click it and
  the real asset materializes at human scale, lit and slowly turning.
  Gaussian splat PLYs show as point clouds for now.
- **Provenance**: drop any ComfyUI PNG into the space and the workflow
  embedded in it unfolds as a new hub, with the image on its rim.
- **History recall**: recent generations find their workflows on load
  and hang in the right gallery.

## VR

An `ENTER VR` button appears when a headset runtime is reachable. WebXR
requires a secure context, and there are three ways to get one:

- **Wifi, any standalone headset** (this is how the Quest 2 testing is
  done: no cable, no developer mode). With ComfyUI running:

  ```
  pip install aiohttp cryptography
  python vr.py
  ```

  It prints an https address. Open that address in the headset browser
  (same wifi as the PC), accept the certificate warning once (Advanced,
  then proceed: self-signed is expected, and a warned https page still
  counts as a secure context), and press `ENTER VR`. If the page never
  loads, the script prints the exact firewall command to run.
- **USB** (Quest with developer mode): connect the cable, run
  `adb reverse tcp:8188 tcp:8188`, then open
  `http://localhost:8188/comfyvr/` in the Quest Browser. On Windows,
  `quest.ps1` does the waiting, the tunnel, and prints the steps.
- **PCVR** (Rift, Index, WMR on the same machine): open the URL in
  Chrome and click the button. localhost is exempt, nothing to set up.

### Controls

| | Desktop | VR controllers | VR hands |
|---|---|---|---|
| Look / aim | drag mouse | point | point |
| Move | WASD + QE, wheel | left stick fly, right stick turn | pinch empty space and pull |
| Click | left click | trigger | pinch |
| Move a node | drag its title bar | hold trigger on title bar | pinch and hold title bar |
| Rewire | drag a port dot | hold trigger on port dot | pinch and hold port dot |
| Back out | Esc | | |

Pinch works because Quest fires the same select events for hand tracking
as for triggers, so every interaction is hand-native for free. Text
entry stays on the desktop for now; a phone-as-keyboard companion is
planned, because typing prompts in VR is nobody's dream.

## Contributing

Early days and moving fast. The most valuable contribution right now is
**testing on headsets we don't have**. This has been built and verified
on desktop and a Quest 2. If you have a Quest 3 or
Pro, a Pico, an Index or any PCVR setup, a Vision Pro, anything that
speaks WebXR: please try it and open an issue with your headset model,
what worked, and what broke. Hand tracking reports are especially
wanted.

Bug reports, PRs, and wild ideas welcome. The design notes and roadmap
live in `notes/design.md` and `notes/RELEASE.md`. The codebase is
plain ES modules with no build step, on purpose: if you can read it,
you can patch it.

## Limitations, stated plainly

What does not work yet, so you know before you fly:

- **Text entry in VR opens on the monitor.** The prompt editor is a
  regular browser element and those cannot render inside an immersive
  session. A message tells you where it went. An in-space keyboard and
  a phone-as-keyboard companion are the planned fixes.
- **Subgraphs render but refuse to queue.** You get a readable message
  instead of a broken run. Flatten them in ComfyUI for now.
- **You cannot delete a node yet**, or create a workflow from nothing.
  Editing today means tweaking, rewiring, and growing nodes from
  dropped wires.
- **Only your first 12 saved workflows load** into the constellation.
  A workflow browser is coming.
- **Galleries forget on ComfyUI restart.** History lives in ComfyUI's
  memory; recall from the output folder on disk is planned.
- **Layouts persist only for workflows saved to the local folder.**
  Your original ComfyUI files are never modified, which also means
  arrangements of unsaved workflows reset with the tab.
- **Custom nodes render generically.** Standard widget types (sliders,
  combos, toggles, text) all work; bespoke frontend widgets from node
  packs show as plain values.
- **Gaussian splat PLYs show as point clouds**, not splats.
- **No back-out gesture in VR yet.** Leave a hub by flying away or
  pinching another sigil.
- **Errors are terse.** A failed run turns the hub red but does not yet
  point at the node that caused it. A full error overhaul is next.

## Roadmap

The goal: the most natural place to run, tend, and remix generative
workflows, on a screen or standing inside them. In rough order:

- Readable errors on the panel that caused them.
- Workflow browser: open and close any of your workflows from inside
  the space, no cap.
- Layout memory for every workflow, without touching your files.
- Creating workflows: start an empty one from a template, grow it node
  by node, save it. Node delete comes with this.
- Image upload from inside the headset. The browser file picker on
  Quest reaches headset storage, including your screenshots and
  downloads, so feeding a LoadImage node from the headset gallery is a
  real path.
- In-space keyboard for short fields, phone as keyboard for prompts.
- A hosted demo you can fly with zero install.
- Gallery recall across restarts, from the output folder itself.
- Real gaussian splat rendering.
- Voice: "load my portrait workflow."
- Presence: two people in the same constellation.

Built with three.js. Not affiliated with Comfy Org.
