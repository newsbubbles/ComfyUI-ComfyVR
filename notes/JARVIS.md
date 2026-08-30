# JARVIS: the voice and agent layer

The bet: if ComfyVR goes full sci-fi table stakes (a voice you talk to,
an agent you can watch working inside the space) people will love it,
make videos about it, and carry it further than any feature list would.
Aesthetic wins attention; functionality then has to keep the users it
wins. This document is the plan for the attention half, built so the
functionality half is real underneath.

The demo that travels, taken verbatim from the reddit thread: say
"Jarvis, load my furry workflow" while standing in the constellation.
The right hub glows and rushes toward you. The agent reads the graph
aloud. You say "300 steps and requeue". The slider moves in front of
you and pulses climb the wires.

## Parts we already have

Nearly everything exists as working local code:

- **ComfyVR's event surface** (this repo). Every graph mutation and
  execution event flows through one hub surface. Agent actions ride
  the same events, which means the user SEES the agent working: panels
  glow, sliders move, beams pulse. No extra rendering work.
- **FL-MCP** (installed custom node, `custom_nodes/ComfyUI_FL-MCP`).
  The architecture template: an MCP server plus a browser bridge (a
  backend that relays tool calls into the open tab over websocket),
  128 tools, and bring-your-own-harness including Claude Code and
  Codex subscriptions without copying credentials.
- **ComfyCloud** (`D:\comfycloud-mcp-local`). Our own MCP server and
  PydanticAI agent over OpenRouter. The tool-design template: a
  deterministic discover, validate, build, fix ladder; a compact
  recipe registry as ground truth; `comfy_find_workflow` ranking
  workflow files from natural language.
- **Speakwright** (`D:\speakwright`). A local voice sidecar speaking
  the OpenAI audio API on 127.0.0.1:8765: faster-whisper STT, Kokoro
  TTS, and an ear-readiness rewrite pass that makes assistant text
  sound natural read aloud. The voice half is close to done before we
  start.
- **The in-headset mic path (SHIPPED 2026-08-29).** The keyboard's
  DICTATE key already captures Quest mic audio with MediaRecorder,
  ships it through `/local/stt` in both servers, and types the
  transcription. J3's hardest line item is field-verified code; the
  agent path reuses it with a different destination.

## Architecture

Four boxes, three of them already written:

```
headset / desktop browser  (the space; source of truth for spatial state)
        | agent bridge websocket
comfyvr server  (serves MCP endpoint; relays tool calls into the page)
        | MCP (stdio or http)
harness  (embedded PydanticAI agent, OR the user's Claude Code / Codex)
        | OpenAI audio API
speakwright  (STT + TTS + ear-readiness, local)
```

Principles, learned the hard way elsewhere and applied from day one:

- **The space is the source of truth for spatial state.** Tools that
  ask "what is the user looking at" or "which hub is open" go through
  the bridge to the live page, never through a shadow copy.
- **Tool surface first.** Anything the agent must do reliably is a
  typed tool, never a prose instruction. The system prompt sets voice
  and manner; the tools carry the behavior.
- **The agent is visible.** A small avatar glyph flies to whatever the
  agent is touching. Its speech is positional audio from where it
  stands. Its edits fire the same glow and pulse events as yours.

## Tool surface, by domain (revised 2026-08-29)

Six domains, ordered by how dangerous they are. The rule carried over
from membrane: the agent does LABOR, the user keeps DECISIONS.

**Perceive** (read-only, free to call): `space_state` (where the user
is, open hubs, statuses, queue depth), `describe_workflow` (compact
graph summary, not raw JSON), `read_node` (widgets, values, errors),
`read_errors`, `gallery` (recent outputs with provenance),
`queue_status`, `node_docs` (object_info tooltips are already
documentation, neurodes especially), `search_nodes`, `find_workflow`
(rank the user's workflows against an intent; ComfyCloud has this
shape working).

**Speak and point** (the interaction domain the whole layer hangs on):
`say(text, near?)` performs a SHORT text-to-speech utterance as an
action, positional from the agent avatar, which stands near the thing
it is talking about; `highlight(target, ms)` pulses a node, link, or
gallery item, the agent's pointing finger; `ask(question, options)`
raises a small in-space choice panel the user answers by pinch or
voice, the confirmation primitive every dangerous tool routes
through. Spatial deixis is the point: the voice comes FROM what it
means, with the highlight agreeing.

**Edit the graph** (mutating; every tool is the same code path as a
pinch, so the user watches it happen): `set_widget`, `rewire`,
`add_node`, `reroll_seed`. `remove_node` only ARMS the red SURE? on
the header; the user's own tap confirms. Deletes stay human.

**Arrange the space**: `open_workflow`, `close_workflow`,
`arrange(hub, scheme)` writing the same layout overrides a drag
writes. THE CAMERA RULE: no tool ever moves the user's viewpoint
except in direct fulfillment of a spoken user command ("take me to
the sampler"); an agent that teleports you on its own initiative is
motion sickness with a voice.

**Run**: `queue` (allowed freely; queueing is cheap, visible, and
interruptible), `interrupt`.

**Generate** (see the assets section): `generate_asset(prompt,
kind)` runs a blessed asset workflow and lets the normal output path
land the placard in the gallery. Anything that bills an external API
routes through `ask()` first; local GPU runs do not.

## Voice and manner (the holodeck register)

The reddit read is consistent: people see JARVIS and the holodeck.
Both of those computers share one property that no chat assistant
has: they are LACONIC. The agent's interchanges are deliberately not
what a chat model gives you by default. The register:

- Answer first, never preamble. No "Sure!", no "Great question", no
  restating the ask, no "I have successfully". A typical utterance is
  under a dozen words: "Queued. Two ahead of it." "Steps is 30.
  Want higher?" "The upscaler failed: missing model. Pick another?"
- Numbers are rounded for the ear. "About twenty seconds", never
  "19.3 seconds".
- Silence is the default state. When the action is visible (a slider
  moving, a wire glowing) the agent does not narrate it. It speaks to
  answer, warn, or hand back a decision.
- Errors: name the node, one cause, one fix. Nothing else.
- Permission requests are yes/no sized, through ask().

Enforcement is TOOLS, not prompt hope (the prose-is-a-weak-control-
surface rule): `say()` hard-rejects text over ~220 characters with an
error telling the agent to put the detail on a note panel instead;
the TTS path already strips markdown (speakwright's ear-readiness);
the system prompt sets tone but the caps carry the behavior. The
model behind it stays cheap and open via OpenRouter; a laconic
register is exactly what small models do well.

## Voice contract

- Push-to-talk, never hot mic. Candidates: an AGENT key on the wrist
  watch, or both hands pinched at once. Chosen in the field.
- Replies are at most two spoken sentences, streamed to Kokoro
  sentence by sentence so first audio lands fast (budget: under ~3s
  from release-to-speak to first sound; STT base model is ~1s of
  that). Anything longer than two sentences becomes a note panel the
  agent highlights: ears get the summary, eyes get the detail.
- A pinch anywhere barges in and stops the current utterance.
- The agent narrates sparingly. Actions are already visible (its
  edits fire the same glow and pulse events as yours); it speaks to
  answer, warn, or hand back a decision, not to commentate.

## VR assets: objects now, areas later

"Make VR assets" splits into two different problems:

- **Objects** are ready. ComfyUI v0.23 ships native TripoSplat (image
  to gaussian splat, saved as .spz, which comfyvr now routes to the
  right parser) and Hunyuan3D-v2 mesh nodes are already in the local
  install. `generate_asset(kind=object)` is a blessed workflow away.
- **Areas** are not solved by anyone as walkable generative
  geometry. Today the real path for a walkable place is a phone-
  scanned splat. The tasteful middle step: a `generate_sky` tool
  running a 360 panorama workflow whose output becomes the void's
  backdrop, ambience for the whole constellation without pretending
  to be geometry. True generative walkable scenes stay on watch.

Three lanes for the heavy lifting, in preference order for a 1080:

1. **ComfyUI-fal-Connector** (by a fal engineer; effectively
   official): submits the WHOLE workflow to fal's GPUs. Kills the
   local VRAM ceiling without changing the graph.
2. **Official ComfyUI API Nodes** (Tripo, Rodin and friends, billed
   through Comfy credits) and **ComfyUI-fal-API** (community,
   1400+ fal endpoints wrapped as nodes with cost controls): single
   nodes that call the cloud, mixable into local graphs.
3. Local: TripoSplat / Hunyuan3D-v2 mini if the 1080 survives them;
   RunPod for batch work.

All three land files in the output directory, which means the
existing placard-materialize loop and the XR decimator handle
delivery with zero new rendering work.

## Harness and memory (decided 2026-08-30)

Where the agent LIVES: yes, the python side. The split:

- **The page is the executor, never the brain.** It answers tools and
  queues utterances; it holds no conversation state and runs no model.
- **The server owns persistence.** Agent conversations get a sqlite
  store (`agent.db`: sessions, turns, tool calls) written by the
  server, so any harness can resume a session with full history and
  the transcript survives page reloads and headset naps.
- **Harnesses are guests, not forks.** The Claude Agent SDK and the
  Codex SDK both allow building a full custom harness; we deliberately
  stop short of that. ComfyVR ships a skill
  (`.claude/skills/comfyvr/SKILL.md`: bridge protocol, tool table, the
  register, hard rules) so the user's OWN Claude Code or Codex drives
  the space with their existing subscription, credentials untouched,
  in their normal environment. What happens in comfyvr is still kept
  separate: the sqlite transcript is ours, keyed by comfyvr session,
  not theirs.
- **The embedded J1 agent is just the bundled default harness**: a
  small PydanticAI process over OpenRouter for people who do not run
  a CLI agent, reading the same skill text as its system prompt and
  writing the same sqlite store. One brain contract, N brains.

The listen() tool closes the voice loop for ANY harness today: wrist
push-to-talk queues the transcript, the harness polls listen between
actions, answers through say(). Talking to Claude Code from inside
the headset needs no new code, only a running session with the skill.

## Phases

- **J0, drive the space from outside.** Agent bridge websocket +
  MCP server + the eight core tools. Prove it by pointing Claude Code
  at the endpoint from the desktop and watching it fly the
  constellation and edit a workflow. No UI work at all.
- **J1, embedded agent.** PydanticAI over OpenRouter (cheap open
  models), a chat panel in the space, text in and out. The harness
  stays pluggable: point your own CLI at the same MCP endpoint and the
  embedded agent steps aside.
- **J2, voice on desktop.** Speakwright in the loop: push-to-talk on
  the keyboard, spoken replies through the scene's audio engine.
- **J3, voice in the headset.** The mic capture and STT relay already
  shipped inside the keyboard's DICTATE path; what remains is routing
  a transcript to the agent instead of a text field, the push-to-talk
  gesture (chosen in the field), and positional TTS from the avatar.
- **J4, knowledge and recipes.** The node_docs / find_workflow tools,
  plus a recipe registry so "make this into a video" resolves to a
  known chain.

## Why this is credible rather than a mood board

J0 is a weekend of work because the mutation API already exists (hubs
expose every operation the tools need), the server already proxies
websockets, and FL-MCP is a working reference for the bridge pattern.
J2 is small because speakwright already speaks the right API. The only
genuinely new engineering is the in-headset audio path and the agent
avatar, and both are additive: nothing else waits on them.
