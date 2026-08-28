# Road to public v0.1

The verdict on stack: the web app IS the final form. WebXR is the only
zero-install path onto headsets, the audience lives in browsers, and the
content is cheap enough that Quest 2 fill rate — not engine choice — is
the ceiling. No native rewrite. Hardening happens inside this codebase
(text atlases if headset legibility demands, instancing if hub counts
explode). No build step, on purpose: this community patches what it can
read.

## Gate (in order — release when all six are true)

1. **Quest 2 in-headset pass.** The claim is VR; it ships tested. Fix the
   top findings (suspects: text size, port-dot hit zones, pull-locomotion
   gain, big-hub frame rate).
2. **Subgraph / group-node grace.** Wild workflows contain them. They must
   parse into an honest "subgraphs not yet supported" panel + a hub that
   still renders, and queue must refuse readably — never a broken bowl.
3. **3D outputs materialize.** Gallery placard (thumbnail) for any output
   with a mesh extension (.glb/.gltf/.obj/.ply); pinch → the asset loads
   in place, bbox-normalized to ~1.5m, slow idle spin; pinch again →
   placard. Gaussian splat .ply = point-cloud preview in v0.1, proper
   splat renderer is a fast-follow. This is the headline: the thing no 2D
   frontend can do.
4. **Custom-node install path.** `ComfyUI-ComfyVR` registers GET /comfyvr
   on ComfyUI's own server (one click in Manager, no separate server).
   Same-origin mode: client detects it and talks to ComfyUI endpoints
   directly — the proxy is only for standalone use.
5. **Hosted demo.** Demo mode with embedded sample workflows as static
   fallback → GitHub Pages / peakdev subdomain, linked from the README,
   so the thread can fly before installing.
6. **Hygiene.** LICENSE (MIT proposed), demo GIF in README, repo pushed
   to github/newsbubbles.

## Explicitly deferred past v0.1

Phone-as-keyboard text entry, voice ("Jarvis, load my workflow" — titus
thesis), multi-client presence, proper gaussian splat rendering, node
delete UX, object_info-wide palette search, beam-crossing reduction on
dense graphs.
