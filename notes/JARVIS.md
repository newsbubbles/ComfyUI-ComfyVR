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

## Tool surface, first draft

Space: `space_state` (where the user is, open hub, queue, last errors),
`list_workflows`, `open_workflow`, `fly_to`, `describe_workflow`
(compact graph summary, not raw JSON).

Graph: `set_widget`, `rewire`, `add_node`, `read_errors` (the panel
error surface, already structured per node).

Run: `queue`, `interrupt`, `queue_status`, `gallery`, `materialize`.

Knowledge: `node_docs` (object_info tooltips are already documentation,
neurodes especially), `search_nodes`, `find_workflow` (rank the user's
own workflows against an intent, ComfyCloud has this shape working).

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
- **J3, voice in the headset.** Mic capture in the Quest browser,
  streamed to the server for STT. Push-to-talk gesture to be chosen in
  the field (candidate: both hands pinched at once opens the mic,
  release sends). Replies as positional TTS from the agent avatar.
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
