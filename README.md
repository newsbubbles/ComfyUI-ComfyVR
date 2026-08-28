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
with bare hands.

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
requires a secure context, so:

- **PCVR** (Rift, Index, WMR on the same machine): open the URL in
  Chrome and click the button. localhost is exempt, nothing to set up.
- **Quest**: connect USB, run `adb reverse tcp:8188 tcp:8188`, then open
  `http://localhost:8188/comfyvr/` in the Quest Browser. On Windows,
  `quest.ps1` does the waiting, the tunnel, and prints these steps.
- **Any standalone headset over wifi** (no cable, no developer mode):
  run the standalone server with https and accept the certificate
  warning once in the headset browser.

  ```
  python make_cert.py
  python server.py --tls --port 8443
  ```

  Then open `https://<your-pc-ip>:8443` in the headset (the server
  prints the exact address). The warning screen is expected for a
  self-signed cert: hit Advanced and proceed. A warned https page still
  counts as a secure context, which is all WebXR asks for. If the page
  never loads at all, allow inbound TCP 8443 through your PC firewall.

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
on desktop and is being tested on Quest 2. If you have a Quest 3 or
Pro, a Pico, an Index or any PCVR setup, a Vision Pro, anything that
speaks WebXR: please try it and open an issue with your headset model,
what worked, and what broke. Hand tracking reports are especially
wanted.

Bug reports, PRs, and wild ideas welcome. The design notes and roadmap
live in `notes/design.md` and `notes/RELEASE.md`. The codebase is
plain ES modules with no build step, on purpose: if you can read it,
you can patch it.

## Status

Not yet done: node delete, subgraph execution (they render but refuse to
queue), proper gaussian splat rendering, voice control, and
multiplayer presence. The in-headset experience is young. Expect rough
edges and report them.

Built with three.js. Not affiliated with Comfy Org.
