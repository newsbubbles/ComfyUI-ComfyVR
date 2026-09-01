# Licensing and terms research (verified 2026-09-01)

Researched against the actual repos, the FSF GPL FAQ, and both cloud
providers' published terms. Facts first, practical reads at the end.

## Dependency licenses

| Surface | License | Obligation on us |
|---|---|---|
| ComfyUI | GPL-3.0 | copyleft on derivative works; no obligation on mere use, including on rented servers (GPLv3 has no network trigger) |
| ComfyUI-Manager | GPL-3.0 | same |
| comfy-cli | GPL-3.0 | none via subprocess use (separate programs) |
| ComfyUI_frontend | GPL-3.0 | matters only if we copy its code (we do not) |
| three.js | MIT | keep the copyright + license notice |

This repo is MIT.

## The GPL boundary, per the FSF FAQ

- The custom-node half (our __init__.py imports ComfyUI's server and
  registers routes in-process) is the FAQ's combined-program case, so
  it must carry a GPL-COMPATIBLE license. MIT is GPL-compatible, so
  we are fine even under the strictest reading. Ecosystem practice
  agrees: of the top node packs, Manager/Impact/KJNodes are GPL-3.0
  while rgthree/essentials/was-suite are MIT and controlnet_aux /
  AnimateDiff-Evolved are Apache-2.0. There is no official Comfy Org
  ruling (issue 3362 is the canonical unresolved thread).
- The standalone proxy talks to ComfyUI only over its public HTTP and
  websocket API: the FAQ's arms-length, separate-programs case. Not
  a derivative work. Driving comfy-cli by fork/exec on a pod is the
  same case.
- The browser frontend is served BY a GPL process but executes as a
  separate program and copies no ComfyUI_frontend code; serving is
  mere aggregation. Stays MIT.

## Comfy Org

- "Comfy" and "ComfyUI" are Comfy Org trademarks (comfy.org/brand).
  Referencing them in content that accurately describes work with
  the platform is welcomed (integrations named explicitly).
- Registry (registry.comfy.org): node ids must NOT contain "ComfyUI";
  pyproject must declare a license; no eval/exec, no runtime pip
  installs by subprocess, no obfuscation; nodes are scanned. Whether
  registry signup adds a click-through publisher agreement is the
  one unverified gap; check at account creation.
- The Comfy CLA only affects upstream contributions, not use.
- Comfy-Org/workflow_templates is MIT: bundling official template
  workflows is fine with attribution.

## Providers

- RunPod ToS bans automated access to the SITE and credit resale;
  the pod API with the user's own bearer token is the intended use
  (they ship SDKs and an MCP server). Referrals: 3% pods + 5%
  serverless for 6 months in credits; affiliate tier at 25 referrals
  pays 10% cash. Only conduct rule: no self-referrals. Migrate
  create calls to API v2 before v1 retires 2026-11-15 (we already
  use v2 for everything but create; see run-on.md for why).
- Vast.ai affirmatively invites referral links "on your site, in
  videos, blogs, or wherever your audience is" including repos, and
  ships its own MIT api client. 3% lifetime; no self-referrals;
  cash payout wants a dedicated account that never rented instances.
- HuggingFace: programmatic model downloads are the supported path
  with per-tier rate limits. GATED models require the user to accept
  conditions in a browser; pods must use the user's own HF token and
  never automate gate acceptance.

## Practical reads

- Architecture: clean on every axis. MIT node inside GPL ComfyUI is
  compatible; the proxy is outside GPL scope; both providers support
  third-party orchestration on the user's own key.
- Hygiene: keep the three.js MIT notice; disclose referral links in
  the README when they land; never self-refer; per-user API and HF
  tokens only.
- Naming: the registry id must not contain "ComfyUI", and Comfy Org's
  brand page restricts using the Comfy name inside product names;
  handled separately.
