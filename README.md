# ComfyVR

Fly through your ComfyUI workflows.

Every workflow you have becomes a glowing hub floating in a dark
constellation. Fly into one and it unfolds into an amphitheater: one ring
of holographic panels per layer of the graph, wires as arcs of light.
Queue a generation and real pulses climb the real wires while the image
forms at the center. Finished outputs hang in a gallery orbiting the
workflow that made them. If the output is a 3D model, you can pull the
actual mesh out of its thumbnail and walk around it. If it is a
gaussian splat, it becomes a place you can walk into.

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

One thing this address cannot do is VR on a headset: it is plain http,
and WebXR only starts on a secure page, so the ENTER VR button will
not appear there over the network. For that, run `python vr.py` and
use the https address it prints. See the VR section.

There is also a standalone mode (`python server.py`, needs `aiohttp`)
that proxies to any ComfyUI backend, and a demo mode that works with no
backend at all so you can explore the space cold.

## What it does

- **Constellation view**: your workflows as sigils in space, with
  threads connecting workflows that share a checkpoint. A library at
  the center of the constellation browses everything you have saved:
  open any workflow onto the horizon, close ones you are done with,
  type to filter on desktop or page through with pinches in VR.
- **Layout memory**: arrange a workflow's nodes and the arrangement
  comes back next session, stored in a small sidecar so your actual
  workflow files are never touched.
- **Amphitheater view**: the workflow as concentric rings ordered by
  graph depth. Panel colors follow link types: MODEL purple at the core
  out to IMAGE blue at the rim.
- **Real editing**: sliders, combos, seed reroll, prompt text. Drag a
  panel's title bar to move it. Grab a port dot to rewire or unplug a
  link. Drop a wire into empty space and an add-node palette offers
  every compatible type in your install: pull forward from an output
  to grow a consumer, or pull backward from an empty input to grow the
  thing that feeds it. Type to fuzzy-filter on desktop, or browse by
  category and page through with pinches in VR. The ✕ in a node's
  header deletes it, with a confirm tap.
- **Workflows from nothing**: ✚ NEW on the wrist watch, the library,
  or the workflow list starts an empty workflow. Name it with the
  keyboard, and it appears on the horizon as a bare hub. ✚ ADD NODE
  on its core opens the palette across every type in your install;
  after the first node, grow the rest by pulling wires. Saving keeps
  it a normal ComfyUI workflow file, loadable anywhere.
- **Sane controls**: sliders travel useful ranges (steps sweeps 1 to
  150, not 1 to 10000), mouse wheel fine-nudges one step at a time,
  seeds with randomize actually randomize between queues, and stored
  checkpoint names you do not have snap to ones you do, marked in
  amber. Notes render in full, and LoadImage shows the image it points
  at.
- **Text entry without leaving the headset**: pinching a text field in
  VR opens a floating keyboard with a real cursor: pinch anywhere in
  the text to put the caret there, arrow keys to nudge it, and typing,
  backspace, and dictation all happen at the caret. A SYM layer covers
  prompt syntax (parentheses, brackets, pipes, weights), and the mic
  key records your voice and types the transcription. Dictation
  uses a local whisper sidecar on your PC (anything speaking the
  OpenAI audio API on 127.0.0.1:8765), so audio never leaves your
  machine. The first tap asks for mic permission once. On desktop,
  text fields open a regular editor overlay.
- **Real execution**: queue from inside the space. Websocket events
  drive panel glow, progress bars, live preview at the hub core, and
  finished images flying up to the gallery. The HUD shows queue depth.
- **Errors you can see**: a rejected or failed run lights the exact
  node that caused it red, with the message readable at the hub core.
  Editing that node clears it. Works with custom node packs, including
  V3 style nodes with dynamic input groups.
- **Video and audio outputs**: video results play as living gallery
  planes (click to unmute), and audio results get a placard that plays
  as positional sound from its spot on the rim. mp4, webm, mp3, wav,
  flac, ogg.
- **Provenance cards**: click a gallery image and a card shows what
  made it: model, seed, steps, cfg, size, and the prompt. Works for
  live generations and ones recalled from history.
- **3D outputs**: GLB, OBJ, and PLY results get a placard. Click it and
  the real asset materializes at human scale, lit and slowly turning.
- **Real gaussian splats**: .splat, .ksplat, .spz, and splat PLYs render
  as actual gaussian splats, at native scale, so a captured room stays
  a room you can walk into. Scan a space with a phone app that exports
  splats, drop the file in your ComfyUI output folder as
  `cvr_demo_<name>.splat`, and it appears in the space.
- **Drop a PNG**: any ComfyUI image dropped into the space unfolds the
  workflow embedded in it as a new hub, with the image on its rim.
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

  This is also the everyday start: after any reboot, start ComfyUI,
  run `python vr.py` again, and open the same address. The certificate
  is reused, so the warning only happens the first time. The voice
  sidecar for dictation and the agent is optional and separate; start
  it too if you use those.
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
| Add a node | drop a wire from any port into space, or ✚ ADD NODE on the core | same, by ray | same, by pinch |
| New workflow | ✚ NEW in the library or workflow list | ✚ NEW on the wrist | same |
| Delete a node | ✕ on its header, twice | same, by ray | same, by pinch |
| Edit text | click the field | in-space keyboard, or dictate | same |
| Browse workflows | library at the center | same | same |
| Back out | Esc | wrist watch | wrist watch |

To leave VR with bare hands, look at your left wrist: a small watch
panel carries BACK OUT (return to the constellation) and EXIT VR,
plus live queue status. The face turns to meet your eyes at any wrist
angle. The system gesture also always works: palm up facing you, then
pinch and hold the floating logo.

To record your session in HD, run `record.ps1` with the headset
connected once: it switches the built-in capture from the default
low-bitrate square video to 1920x1080 at 60fps and sets up wireless
adb so later runs need no cable. Turn the microphone on in the Camera
app to narrate. Recordings land in `/sdcard/Oculus/VideoShots`.

Pinch works because Quest fires the same select events for hand tracking
as for triggers, so every interaction is hand-native for free,
including the keyboard: pinch a text field and it appears in front of
you. For anything longer than a few words, tap the mic key and talk.
Your hands render as constellations of glowing joints, so they are
visible to you and in recordings.

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

- **Dictation needs a helper on the PC.** The in-space keyboard always
  works, but the mic keys need a local transcription server
  speaking the OpenAI audio API on 127.0.0.1:8765 (any faster-whisper
  wrapper does). Without one it says so, and the keys keep working.
  Point COMFYVR_STT elsewhere if your sidecar lives on another port.
- **Subgraph interiors are not editable yet.** Subgraph workflows
  queue correctly (comfyvr flattens them the same way the stock
  frontend does, nesting included), but the inner nodes render as one
  sealed node. Opening a subgraph into its own room is on the
  roadmap.
- **No undo.** Deletes are confirmed and unsaved changes revert on
  reload, but there is no step-by-step undo yet.
- **Galleries forget on ComfyUI restart.** History lives in ComfyUI's
  memory; recall from the output folder on disk is planned.
- **Custom nodes render generically.** Standard widget types (sliders,
  combos, toggles, text) all work; bespoke frontend widgets from node
  packs show as plain values.
- **Splat quality drops in VR on purpose.** In a headset, .splat files
  are decimated at load to a budget the mobile GPU can sort, keeping
  the splats that carry the visual mass; desktop always renders full
  resolution. Reports on how big scenes feel on your headset are
  welcome.

## Roadmap

The goal: the most natural place to run, tend, and remix generative
workflows, on a screen or standing inside them. In rough order:

- The agent: an in-space voice you talk to over push-to-talk that
  reads, edits, and queues workflows for you. The bridge and tools
  are in; the wrist mic is in; harnesses plug in over the bridge.
- Generating VR assets in VR: the loop works today with the bundled
  `make-vr-asset` workflow (the stock TripoSplat template: image in,
  gaussian splat out, subgraphs and all; needs ComfyUI v0.23+ and its
  five TripoSplat model files). Queue it, pinch the placard,
  walk around the result. Next: dictating the prompt end to end and
  more blessed workflows.
- Groups rendered as amphitheater wedges, so a workflow's own
  organization survives into space.
- Image upload from inside the headset. The browser file picker on
  Quest reaches headset storage, so feeding a LoadImage node from the
  headset gallery is a real path.
- A hosted demo you can fly with zero install.
- Gallery recall across restarts, from the output folder itself.
- Presence: friends in your constellation over a private network,
  watching the same pulses climb the same wires.
- The far pile, in no order: node packs that act inside the 3D
  environment itself, 4D (animated) splats, physics for the things
  you generate, semantic node search.

Built with three.js. Not affiliated with Comfy Org.
