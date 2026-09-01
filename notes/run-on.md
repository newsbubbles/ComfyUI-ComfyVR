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

## Architecture directives (user, 2026-09-01)

- PARALLELISM IN THE UI: destinations run SIMULTANEOUSLY. A workflow
  queued on a pod renders while another runs on the host GPU; each
  hub binds to a destination, every hub's events ride its own
  websocket into the same space. (And the same everything-over-
  websockets shape is what later lets PEERS stand in one shared
  workspace: presence rides the architecture for free.)
- DESTINATION KINDS differ on setup, not on experience:
  - local: the host backend, implicit, today's behavior.
  - peer: just an accessible address with the API exposed (a friend
    or second box, tailscale or LAN, started by its owner with
    --listen and CORS open). NO provisioning, NO lifecycle. Cheapest
    kind, ships first.
  - cloud: provider + config; needs warm-up (installs + everything
    the target workflow needs, delegated to comfy-cli) and
    lifecycle (start, token, auto-stop, cost).
- SAVED RIGS: known-working remote instance configs are first-class
  and startable BEFORE queueing (warm the rig, then work). A rig =
  provider + GPU tier + volume + the node packs and models it has
  proven. Rig save happens after a successful run.
- PROVIDER MODULARITY: cloud providers are pluggable adapters
  behind one interface (start, stop, status, endpoint, cost/hr,
  auth). Ship RunPod + Vast.ai first (the two names the comfy and
  SD communities actually rent from, and both carry referral
  programs), add others as requested.

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

- R0 DONE (2026-09-01): went further than the note planned. Instead of
  repointing the proxy, ComfyClient grew {base}: every destination is
  its own client with its own websocket, so runs happen IN PARALLEL
  and each hub's events ride home on the right socket. Proven against
  a second ComfyUI on 8199: a workflow built in-space ran there and
  its output landed in the gallery while the primary stayed free.
  Peer-side errors route home too (a CPU OOM landed on the hub panel).
- R0.5 DONE: ▸ RUN ON row on every hub core, right under QUEUE. Cycles
  local -> each destination; the label is the egress label. Gotcha
  found by test: fresh hubs have dest undefined, and indexOf(undefined)
  is -1, so the first cycle skipped the first destination; ?? null.
- R1 DONE (2026-09-01): manifest.js reads packs (cnr_id/ver, subgraph
  definitions included) + models (properties.models) straight from the
  workflow json; manifestSizes HEADs the model urls for bytes (HF
  answers CORS on resolve urls). make-vr-asset: 5 models, 3.78 GB,
  zero unknowns, zero packs (TripoSplat nodes are core since v0.34).
  CVR.manifest('name') is the card. Display and GPU sizing ONLY;
  resolution is DELEGATED to comfy-cli on the pod (adversarial pass).
- R2 WRITTEN, awaiting first light with real keys: providers.py now
  carries full runpod + vast adapters against the VERIFIED 2026 APIs.
  Load-bearing facts from the research pass:
  - RunPod REST v1 RETIRES 2026-11-15, GraphQL early 2027; adapter
    targets v2 (api.runpod.io/v2, Bearer auth). GPU catalog:
    GET /catalog/gpus (id string is what create wants). Create:
    POST /pods {image, gpu:{id,count}, disk, ports:["8188/http"],
    env, cloud, mounts.network, dataCenterIds}. Lifecycle:
    POST /pods/{id}/action {action: stop|terminate}. Ingress:
    https://{podId}-8188.proxy.runpod.net, auto-https, 100s request
    cap (ws + polling fine, long POSTs die).
  - v2 create has NO dockerStartCmd (v1 had it), only `args` to the
    container entrypoint. So: default image pytorch/pytorch (EMPTY
    entrypoint; runpod/pytorch's /start.sh would swallow args),
    bootstrap script base64 in env CVR_BOOT, args unpacks it. HOW v2
    splits the args string = first thing to confirm at first light.
  - Vast: two-step rent. POST /bundles/ search (operator objects,
    order dph_total asc) then PUT /asks/{offer_id}/ {image, disk,
    env {"-p 8188:8188":"1"}, onstart, runtype}; instance id is
    new_contract in the response. Status GET /instances/{id}/,
    actual_status, ports["8188/tcp"][0].HostPort on public_ipaddr.
  - Vast ingress is raw http ip:port, NO https option for arbitrary
    ports (Instance Portal cloudflare tunnels need their template
    stack). Mixed content: the https headset page cannot fetch it
    directly. Future: relay route through our python (server-side
    http is fine). Vast works from the http pages today.
  - Vast STOP can lose the GPU to another renter and restart hangs
    in scheduling; terminate is the safe end state. Stopped RunPod
    pods bill volume disk at $0.20/GB/mo; network volumes $0.07.
  - comfy-cli confirmed: global flags BEFORE subcommand, so
    `comfy --skip-prompt --workspace=... install --nvidia`; deps via
    `comfy node install-deps --workflow=<file>` (node packs only);
    models are NOT auto-downloaded, need `comfy model download
    --url --relative-path`. Bootstrap uses --skip-torch-or-directml
    on a torch image.
  - Workflow file transfer to the pod, two candidate paths, decide
    at first light: (a) b64 the workflow json into env, install-deps
    at boot; (b) after ComfyUI is up, drive ComfyUI-Manager's HTTP
    API from our python (no ssh needed ever). Models via `comfy
    model download` from the manifest urls either way.
- R2 scaffolding notes: providers.py
  (python owns key custody: env or gitignored providers.local.json;
  the page NEVER sees a key, and could not call provider APIs anyway
  because of CORS), one route /local/provider/{name}/{action} in both
  deployments, five actions total (pricing/start/status/stop/
  terminate). Python normalizes the shapes, so the js adapter is
  IDENTICAL for every provider and a new provider is one python
  function. status() probes the pod's ComfyUI from the server, so
  url appears only when the backend actually serves. Rigs also
  shipped: localStorage cvr-rigs, saveRig/startRig/stopDest;
  startRig polls status into cold-start phases (15 min ceiling).
- R3: cost meter on the wrist + auto-stop + rig save-after-success.
- R4: more providers (fal via connector, ComfyCloud as a row),
  affiliate links with disclosure.

LAN note: on a --listen/--tls server anyone on the LAN can hit the
provider route, same as they can already queue prompts. The key never
leaves the python process; the exposure is a housemate starting a pod,
not a stranger reading the key. Documented in providers.py.

## The two-camps read (reddit, 80+ likes)

The thread has split into "genuinely would use this" and "why would
you ever." That split is the signal: indifference is the only fatal
response, and a strong "why" camp means the position claim landed.
Run On is aimed squarely at the sympathetic camp's biggest real
objection, "my GPU can't run any of this," and converts spectators
into users without asking the skeptics for anything.
