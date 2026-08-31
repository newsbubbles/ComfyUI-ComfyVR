# Run On: provider-agnostic remote execution (noted 2026-08-31)

The idea: QUEUE grows a destination. Local is one row; RUNPOD, FAL,
VAST, "Nate's other box over tailscale" are more rows. Pick one, and
the workflow runs there while the space behaves identically, because
a remote ComfyUI is just another websocket. People without chonky
GPUs run whatever workflow they can see.

## Why this is natural for us

- comfy.js already abstracts the backend (API base + /ws + /prompt +
  /view + /object_info), and standalone server.py already PROXIES to
  an arbitrary ComfyUI. Pointing the proxy at a remote instance is
  configuration, not architecture.
- Everything the space shows (pulses, progress, previews, gallery
  arrivals) rides ws events and /view fetches. None of it cares
  where the GPU is. The demo line writes itself: same room, same
  pinch, the beacon just says where the heat is.

## The load-bearing discovery: the workflow file IS the manifest

Found while building subgraph flattening: modern workflow JSON
embeds, per node, `properties.cnr_id` (the registry id of the pack
that provides it) and `properties.ver`, and model-loader nodes carry
`properties.models` = [{name, url, directory}] (exact HuggingFace
URLs; this is how we fetched the TripoSplat files). So a saved
workflow already contains:

1. which node packs to install, at which versions (cnr registry)
2. which model files to download, from where, into which folder
3. via widget values, everything else worth checking

Provisioning a pod is therefore mostly a matter of READING THE FILE,
which is exactly what ComfyUI-Manager's "install missing" does
locally and nobody appears to do for remote bootstrap. VRAM sizing
falls out of summed model file sizes plus headroom, which picks the
GPU tier automatically.

## Provisioning sketch (RunPod first)

- Prebuilt docker base: pinned ComfyUI + Manager + our custom node,
  so cold start is pull + node packs + models, not a from-scratch
  install. Mind [[runpod-base-image-gotchas]]: torch in their
  pytorch images can lag; upgrade torch+torchvision together.
- RunPod NETWORK VOLUMES persist models between sessions: second
  run of the same workflow skips the downloads entirely. This is
  the difference between 10 minutes and 60 seconds of cold start.
- rp.py lineage already scattered across D:\ (face, riggs, undertow)
  covers pod lifecycle scripting.
- Transport: RunPod's proxy gives https/wss at
  <pod-id>-8188.proxy.runpod.net. Comfy has no auth; bake a token
  check into the image (thin reverse proxy) so the pod is not an
  open GPU for strangers.
- Inputs must upload (LoadImage files); outputs stream back through
  /view like always.
- Cold-start theater: show provisioning phases as the hub
  assembling itself in space (pulling image, installing packs,
  downloading models with progress). Real progress beats a spinner.

## Occupied / vacant

OCCUPIED, heavily: hosted comfy execution. RunComfy, ComfyDeploy,
Comfy.ICU, ViewComfy, BizyAir (cloud nodes), fal-Connector (runs a
whole workflow on fal GPUs, by a fal engineer), RunPod community
comfy templates, ComfyUI-Distributed (multi-GPU), and Comfy Org's
own ComfyCloud. Do not become a host; hosts are a crowded, margin-
compressed business, and [[ren-project]] already concluded owning
cloud GPU infra is the value trap.

VACANT, as far as searched: a provider-AGNOSTIC destination picker
driven by the workflow's own embedded manifest, surfaced as one
pinch, where "provider" includes a friend's PC on tailscale. We
route, we never resell compute; the user holds their own provider
account and pays the provider directly. ComfyCloud becomes one row
in the list, never the list.

## Adversarial pass on the vacancy claim (2026-09-01)

Searched to kill it before building, as the avatar claim taught.

DEAD: "manifest-driven environment bootstrap" as novel tech. It is
occupied at least four times over: ComfyUI-Launcher (ComfyWorkflows,
"run any workflow with ZERO setup," auto-installs nodes and models
from the workflow json, isolated per-workflow envs), comfy_runner
(piyushK52), comfy-cli's OFFICIAL `node install-deps --workflow`,
and RunPod's own ComfyUI-to-API (an agent analyzes the workflow,
finds nodes and model URLs, and emits a Dockerfile). RunComfy's
hosted auto-setup does it as a service. We must NOT write our own
resolver; the pod bootstrap should shell out to comfy-cli and the
Manager registry machinery, with the embedded cnr_id/ver and
properties.models as first-choice inputs. ComfyUI-Launcher's
per-workflow isolation is prior art for the volume layout.

SURVIVED, sharper than before:
1. THE INTERACTIVE SESSION. Every remote occupant terminates in API
   endpoints (ComfyUI-to-API is api-only by design) or a session on
   THEIR cloud (RunComfy). Nobody gives your own frontend a
   per-queue destination where the live experience is identical
   because it is the same client pointed elsewhere.
2. PROVIDER-AGNOSTIC + PEERS. All occupants are single-provider or
   own-cloud. "Any websocket is a place," tailscale friend's PC
   included, stands unclaimed.
3. END-TO-END PROVISIONING. Even RunPod's own tool stops at "here
   is a Dockerfile, deploy it yourself." One-pinch pod lifecycle
   (spin up, token, warm volume, auto-stop, cost on the wrist)
   remains open.
4. The VR seat, obviously.
(ComfyUI-Distributed checked too: master-worker PARALLELISM across
your own machines for batch speed; manual worker setup; not a
destination picker, not provisioning. Different job; good neighbor.)

Phase revision: R1 shrinks to "extract the manifest for display and
VRAM sizing, DELEGATE resolution to comfy-cli on the pod." R2's
provisioner is a thin orchestrator: pod lifecycle + comfy-cli calls
+ token proxy + network volume. R0 unchanged.

## Money

Affiliate programs are real and disclosure goes in the README:

- RunPod: 3% pod / 5% serverless spend for 6 months standard;
  after 25 paying referrals, AFFILIATE TIER = 10% of ALL referred
  spend with cash payout. A feature that creates RunPod customers
  is exactly what that tier is for.
- Vast.ai: 3% of referred spend for account lifetime, 75% cashable
  (Stripe/PayPal/Wise). GOTCHA: payout account must be a fresh one
  that has never rented instances.
- fal: connector exists; affiliate program unverified, check when
  the fal row lands.

This monetizes without charging anyone: the user pays the provider
what they would pay anyway; the ref code is in the link we open.

## Risks

- Cold start is the product killer if naive (5-15 min). Docker base
  + network volumes + manifest-driven prefetch is the whole game.
- Custom nodes that assume a display or fail headless.
- Version skew between manifest cnr versions and what installs;
  pin and report, never silently substitute.
- Private images/workflows leave the machine: destination rows are
  an explicit choice, label the egress plainly.
- Idle pod burn: $/hr on the wrist while a pod is alive (andon for
  money), auto-stop after N idle minutes, and the pod-hub visibly
  cools when stopped. Never let a pod outlive the session silently.

## Phases

- R0: point standalone server.py at an existing remote ComfyUI
  (hand-started pod) with a token; prove the space is identical.
- R1: manifest extractor: workflow json -> {packs+vers, models+urls,
  VRAM estimate}. Test against make-vr-asset. Useful standalone
  (doubles as a local "what does this workflow need" card).
- R2: RunPod provisioner: docker base + network volume + rp.py
  lifecycle; cold and warm start timed.
- R3: destination row on QUEUE + cost meter + auto-stop.
- R4: more providers (vast, fal via connector, tailscale peers),
  affiliate links with disclosure.

## The two-camps read (reddit, 80+ likes)

The thread has split into "genuinely would use this" and "why would
you ever." That split is the signal: indifference is the only fatal
response, and a strong "why" camp means the position claim landed.
Run On is aimed squarely at the sympathetic camp's biggest real
objection, "my GPU can't run any of this," and converts spectators
into users without asking the skeptics for anything.
