"""providers.py — cloud provider adapters, python side.

API keys live HERE, never in the page: environment variables first
(RUNPOD_API_KEY, VAST_API_KEY), else providers.local.json next to this
file (gitignored). Browsers could not call provider APIs anyway (CORS),
and a key in page storage would leak with any export of the space.

The whole surface is five actions, dispatched from one route
(/local/provider/{name}/{action} standalone, /comfyvr/local/provider/...
hosted). Keeping it this small is what makes a provider one function:

  pricing            -> {gpus: [{id, name, vram_gb, usd_hr}]}
  start  {rig}       -> {podId, status}
  status {podId}     -> {status, url, usd_hr}   url only when serving
  stop   {podId}     -> {status}                gpu billing stops
  terminate {podId}  -> {status}                everything gone

API facts verified 2026-09-01 against docs.runpod.io / docs.vast.ai:
- RunPod REST v1 retires 2026-11-15 and GraphQL early 2027; this
  adapter targets v2 (api.runpod.io/v2). v2 create has NO
  dockerStartCmd, only `args` passed to the container entrypoint, so
  the bootstrap script rides base64 in an env var and args unpacks it.
- RunPod http ingress: https://{podId}-8188.proxy.runpod.net (100s
  request cap; ws and polling are fine, long POSTs are not).
- Vast: two-step rent (search /bundles/, PUT /asks/{offer_id}/), the
  instance id comes back as new_contract. Ingress is raw ip:port with
  NO https, so a page served over https cannot reach it directly
  (mixed content); the relay route is future work, Vast works from
  http pages today. Vast stop can lose the GPU to another renter
  (restart hangs in scheduling); terminate is the safe end state.

Note: on a --listen/--tls server anyone on the LAN can hit these, same
as they can queue prompts. The key never leaves this process; the risk
is a housemate starting a pod, not a stranger reading your key.
"""
import base64
import json
import os

ROOT = os.path.dirname(os.path.abspath(__file__))
KEYFILE = os.path.join(ROOT, "providers.local.json")

ENV_KEYS = {"runpod": "RUNPOD_API_KEY", "vast": "VAST_API_KEY"}

RUNPOD = "https://api.runpod.io/v2"
VAST = "https://console.vast.ai/api/v0"

STATEFILE = os.path.join(ROOT, "providers.state.json")


def _load_state():
    try:
        with open(STATEFILE, "r", encoding="utf-8") as fh:
            return json.load(fh)
    except (OSError, ValueError):
        return {}


def _save_state():
    try:
        with open(STATEFILE, "w", encoding="utf-8") as fh:
            json.dump(WATCH, fh, indent=1)
    except OSError:
        pass


# ---- spend watchdog ------------------------------------------------------
# The user's rule: 100% deterministic cooldown. Every pod started through
# here is tracked and STOPPED after cooldown_min with no activity, where
# activity = client touches (status calls) OR a non-empty queue on the pod
# itself (a long render with the browser closed is not idle). A spend cap
# (cap_usd, optional) TERMINATES when est. spend crosses it. Runs in this
# process and persists to providers.state.json, so it survives browser
# death and server restarts; the residual risk is this process dying and
# never coming back, which the wrist cost meter exists to catch.
WATCH = _load_state()
_watchdog_started = False


def touch(pod_id):
    w = WATCH.get(pod_id)
    if w:
        import time
        w["last_used"] = time.time()
        _save_state()


async def _pod_busy(http, url):
    """True if the pod's ComfyUI has work queued or running."""
    import aiohttp
    try:
        async with http.get(url + "/prompt", timeout=aiohttp.ClientTimeout(total=6)) as r:
            if r.status != 200:
                return False
            d = await r.json()
            return (d.get("exec_info") or {}).get("queue_remaining", 0) > 0
    except Exception:
        return False


async def _watchdog():
    import asyncio
    import time
    import aiohttp
    while True:
        await asyncio.sleep(60)
        if not WATCH:
            continue
        async with aiohttp.ClientSession() as http:
            for pod_id, w in list(WATCH.items()):
                try:
                    prov, key = w.get("provider"), api_key(w.get("provider", ""))
                    if not key:
                        continue
                    fn = PROVIDERS[prov]
                    st = await fn("status", {"podId": pod_id}, http, key)
                    if st.get("status") in ("terminated", "exited", "stopped"):
                        WATCH.pop(pod_id, None)
                        _save_state()
                        continue
                    now = time.time()
                    spend = (now - w["started"]) / 3600.0 * (w.get("usd_hr") or 0)
                    if w.get("cap_usd") and spend >= w["cap_usd"]:
                        await fn("terminate", {"podId": pod_id}, http, key)
                        WATCH.pop(pod_id, None)
                        _save_state()
                        print(f"[comfyvr] watchdog: terminated {pod_id} at spend cap (${spend:.2f})")
                        continue
                    if st.get("url") and await _pod_busy(http, st["url"]):
                        w["last_used"] = now
                        _save_state()
                        continue
                    if now - w.get("last_used", w["started"]) >= w.get("cooldown_s", 1800):
                        await fn("stop", {"podId": pod_id}, http, key)
                        WATCH.pop(pod_id, None)
                        _save_state()
                        print(f"[comfyvr] watchdog: stopped idle pod {pod_id} after cooldown")
                except Exception as e:
                    print(f"[comfyvr] watchdog error on {pod_id}: {e}")


def ensure_watchdog():
    global _watchdog_started
    if _watchdog_started:
        return
    import asyncio
    try:
        asyncio.get_running_loop().create_task(_watchdog())
        _watchdog_started = True
    except RuntimeError:
        pass  # no loop yet; next call from a request context will succeed

# RunPod's own pytorch image: pre-cached on their hosts (docker hub pulls
# of third-party images stalled a community pod for 17 minutes at first
# light), torch preinstalled, and its /start.sh lives in CMD, so a v1
# dockerStartCmd REPLACES it cleanly (no jupyter/ssh, just our bootstrap).
DEFAULT_IMAGE = "runpod/pytorch:1.0.2-cu1281-torch280-ubuntu2404"


def api_key(name):
    k = os.environ.get(ENV_KEYS.get(name, ""), "")
    if k:
        return k
    try:
        with open(KEYFILE, "r", encoding="utf-8") as fh:
            return (json.load(fh).get(name) or {}).get("apiKey", "")
    except (OSError, ValueError):
        return ""


def bootstrap_script(rig):
    """Install ComfyUI via comfy-cli and serve it on 8188 with CORS open.

    Resolution is DELEGATED to comfy-cli (writing a resolver is
    reinventing a commodity, notes/run-on.md). First light installs the
    core app only; workflow deps (install-deps) and model downloads join
    once the workflow file transfer lands. Model files persist on the
    network volume at /workspace between runs of the same rig.

    While installing, a stdlib http.server on 8188 serves /workspace so
    boot.log is readable through the provider's own ingress: live eyes
    on cold start from outside, no ssh, and later the raw feed for
    cold-start theater in the space. It dies right before ComfyUI takes
    the port; the readiness probe only trusts /system_stats, which the
    log server 404s, so warming can never read as serving.
    """
    lines = [
        "set -x",
        "mkdir -p /workspace",
        "exec > /workspace/boot.log 2>&1",
        "cd /workspace && (python3 -m http.server 8188 --bind 0.0.0.0 >/dev/null 2>&1 &)",
        "export DEBIAN_FRONTEND=noninteractive",
        "apt-get update && apt-get install -y --no-install-recommends git curl ca-certificates || true",
        "pip install --no-cache-dir comfy-cli",
        "comfy --skip-prompt --workspace=/workspace/ComfyUI install --nvidia --fast-deps --skip-torch-or-directml",
        "pkill -f 'http.server 8188' || true",
        "comfy --skip-prompt --workspace=/workspace/ComfyUI launch -- --listen 0.0.0.0 --port 8188 --enable-cors-header '*'",
    ]
    for extra in rig.get("bootExtra") or []:
        lines.insert(-1, extra)
    return "\n".join(lines) + "\n"


def _boot_b64(rig):
    return base64.b64encode(bootstrap_script(rig).encode()).decode()


async def _jget(http, url, key, method="GET", body=None, bearer=True):
    # cloudflare fronts both providers and 403s anonymous-looking UAs
    headers = {"Authorization": ("Bearer " + key) if bearer else key, "User-Agent": "comfyvr/0.1"}
    if body is not None:
        headers["Content-Type"] = "application/json"
    async with http.request(method, url, headers=headers, json=body) as r:
        text = await r.text()
        try:
            data = json.loads(text) if text else {}
        except ValueError:
            data = {"raw": text[:400]}
        if r.status >= 400:
            raise RuntimeError(f"HTTP {r.status} from {url}: {json.dumps(data)[:400]}")
        return data


async def _serves(http, url):
    """True once a ComfyUI actually answers at url."""
    import aiohttp
    try:
        async with http.get(url + "/system_stats", timeout=aiohttp.ClientTimeout(total=6)) as r:
            return r.status == 200
    except Exception:
        return False


# ---------------------------------------------------------------- runpod --
async def _runpod(action, body, http, key):
    if action == "pricing":
        d = await _jget(http, RUNPOD + "/catalog/gpus", key)
        gpus = []
        for g in d.get("gpus", d if isinstance(d, list) else []):
            price = g.get("price") or {}
            usd = price.get("secure") or price.get("community")
            if not usd:
                continue   # not rentable in either cloud right now
            gpus.append({
                "id": g.get("id"),
                "name": g.get("name") or g.get("id"),
                "vram_gb": g.get("memory"),
                "usd_hr": usd,
                "cloud": "SECURE" if price.get("secure") else "COMMUNITY",
            })
        gpus.sort(key=lambda g: g["usd_hr"])
        return {"gpus": gpus}

    if action == "start":
        rig = body.get("rig") or {}
        # FIRST LIGHT FINDING (2026-09-01): v2 create accepts an `args`
        # string but does NOT shell-split it; the container execs the
        # whole string as one binary name and crash-loops (status RUNNING,
        # cpu 0, uptime negative). v1 still has dockerStartCmd as a real
        # argv, so CREATE rides v1 until v2 grows an equivalent; v1
        # retires 2026-11-15, revisit before then (template or baked
        # image are the v2-native outs). Status/stop/terminate stay v2
        # and work on v1-created pods (same pod store).
        req = {
            "name": "comfyvr-" + (rig.get("id") or rig.get("name") or "rig"),
            "imageName": rig.get("image") or DEFAULT_IMAGE,
            # ordered preference list; a single gpuType is the one-item case
            "gpuTypeIds": rig.get("gpuTypes") or [rig.get("gpuType") or "NVIDIA GeForce RTX 4090"],
            "gpuCount": 1,
            "containerDiskInGb": int(rig.get("disk") or 50),
            "ports": ["8188/http"],
            "cloudType": rig.get("cloud") or "SECURE",
            "env": {"CVR_BOOT": _boot_b64(rig)},
            "dockerStartCmd": ["bash", "-c", "echo $CVR_BOOT | base64 -d | bash"],
        }
        if rig.get("volumeId"):
            req["networkVolumeId"] = rig["volumeId"]
        if rig.get("dataCenter"):
            req["dataCenterIds"] = [rig["dataCenter"]]
        try:
            d = await _jget(http, "https://rest.runpod.io/v1/pods", key, "POST", req)
        except RuntimeError as e:
            # SECURE stock for cheap SKUs runs dry routinely (first light hit
            # this across five types); COMMUNITY usually has them. Fall back
            # once unless the rig pinned a cloud explicitly.
            if "no instances currently available" in str(e).lower() and not rig.get("cloud"):
                req["cloudType"] = "COMMUNITY"
                d = await _jget(http, "https://rest.runpod.io/v1/pods", key, "POST", req)
            else:
                raise
        return {"podId": d.get("id"), "status": (d.get("desiredStatus") or d.get("status") or "PROVISIONING").lower(), "usd_hr": d.get("costPerHr") or d.get("cost")}

    pod_id = body.get("podId")
    if not pod_id:
        raise RuntimeError("podId required")

    if action == "status":
        d = await _jget(http, RUNPOD + f"/pods/{pod_id}", key)
        st = (d.get("status") or "").lower()
        url = f"https://{pod_id}-8188.proxy.runpod.net"
        serving = st == "running" and await _serves(http, url)
        return {"status": "serving" if serving else st, "url": url if serving else None, "usd_hr": d.get("cost")}

    if action == "stop":
        await _jget(http, RUNPOD + f"/pods/{pod_id}/action", key, "POST", {"action": "stop"})
        return {"status": "stopped"}

    if action == "terminate":
        await _jget(http, RUNPOD + f"/pods/{pod_id}/action", key, "POST", {"action": "terminate"})
        return {"status": "terminated"}


# ------------------------------------------------------------------ vast --
async def _vast(action, body, http, key):
    if action == "pricing":
        q = {
            "verified": {"eq": True}, "rentable": {"eq": True},
            "num_gpus": {"eq": 1}, "direct_port_count": {"gte": 1},
            "order": [["dph_total", "asc"]], "type": "on-demand", "limit": 64,
        }
        d = await _jget(http, VAST + "/bundles/", key, "POST", q)
        best = {}
        for o in d.get("offers", []):
            name = o.get("gpu_name")
            if name and (name not in best or o["dph_total"] < best[name]["usd_hr"]):
                best[name] = {
                    "id": name,
                    "name": name,
                    "vram_gb": round((o.get("gpu_ram") or 0) / 1024),
                    "usd_hr": o.get("dph_total"),
                }
        return {"gpus": sorted(best.values(), key=lambda g: g["usd_hr"] or 9e9)}

    if action == "start":
        rig = body.get("rig") or {}
        want = rig.get("gpuType") or "RTX 4090"
        q = {
            "verified": {"eq": True}, "rentable": {"eq": True},
            "num_gpus": {"eq": 1}, "direct_port_count": {"gte": 1},
            "gpu_name": {"in": [want, want.replace(" ", "_")]},
            "order": [["dph_total", "asc"]], "type": "on-demand", "limit": 3,
        }
        d = await _jget(http, VAST + "/bundles/", key, "POST", q)
        offers = d.get("offers") or []
        if not offers:
            raise RuntimeError(f"no rentable {want} offers right now")
        offer = offers[0]
        req = {
            "image": rig.get("image") or DEFAULT_IMAGE,
            "disk": int(rig.get("disk") or 50),
            "env": {"-p 8188:8188": "1"},
            "onstart": "echo " + _boot_b64(rig) + " | base64 -d | bash",
            "runtype": "ssh",
            "label": "comfyvr-" + (rig.get("id") or "rig"),
        }
        d = await _jget(http, VAST + f"/asks/{offer['id']}/", key, "PUT", req)
        if not d.get("success", True):
            raise RuntimeError("vast refused the ask: " + json.dumps(d)[:300])
        return {"podId": str(d.get("new_contract")), "status": "provisioning", "usd_hr": offer.get("dph_total")}

    pod_id = body.get("podId")
    if not pod_id:
        raise RuntimeError("podId required")

    if action == "status":
        d = await _jget(http, VAST + f"/instances/{pod_id}/", key)
        inst = d.get("instances") or d   # single-instance responses wrap inconsistently
        st = (inst.get("actual_status") or "provisioning").lower()
        url = None
        ports = inst.get("ports") or {}
        mapped = (ports.get("8188/tcp") or [{}])[0].get("HostPort")
        ip = inst.get("public_ipaddr")
        if st == "running" and ip and mapped:
            candidate = f"http://{ip}:{mapped}"
            if await _serves(http, candidate):
                url = candidate
        return {"status": "serving" if url else st, "url": url, "usd_hr": inst.get("dph_total")}

    if action == "stop":
        # a stopped vast instance can lose its GPU to another renter and
        # hang in scheduling on restart; terminate is the safe end state
        await _jget(http, VAST + f"/instances/{pod_id}/", key, "PUT", {"state": "stopped"})
        return {"status": "stopped", "note": "vast may reassign the gpu; restart can hang, terminate is safer"}

    if action == "terminate":
        await _jget(http, VAST + f"/instances/{pod_id}/", key, "DELETE")
        return {"status": "terminated"}


PROVIDERS = {"runpod": _runpod, "vast": _vast}


async def handle(name, action, body, http=None):
    """Dispatch one provider action; returns (status, dict) for the route.

    http: an aiohttp.ClientSession to reuse; None makes one per call
    (the hosted route has no session of its own to lend).
    """
    fn = PROVIDERS.get(name)
    if fn is None:
        return 404, {"error": f"unknown provider '{name}'", "known": sorted(PROVIDERS)}
    if action not in ("pricing", "start", "status", "stop", "terminate"):
        return 400, {"error": f"unknown action '{action}'"}
    key = api_key(name)
    if not key:
        return 401, {
            "error": f"no API key for {name}",
            "fix": f"set {ENV_KEYS.get(name, name.upper() + '_API_KEY')} or add it to providers.local.json",
        }
    ensure_watchdog()
    try:
        if http is None:
            import aiohttp
            async with aiohttp.ClientSession() as s:
                out = await fn(action, body, s, key)
        else:
            out = await fn(action, body, http, key)
    except RuntimeError as e:
        return 502, {"error": str(e)}
    except Exception as e:
        return 502, {"error": f"{name} {action} failed", "detail": str(e)}
    # every started pod enters the watchdog; every status call is a touch
    if action == "start" and out.get("podId"):
        import time
        rig = body.get("rig") or {}
        WATCH[out["podId"]] = {
            "provider": name,
            "started": time.time(),
            "last_used": time.time(),
            "usd_hr": out.get("usd_hr") or 0,
            "cooldown_s": int(float(rig.get("cooldownMin") or 30) * 60),
            "cap_usd": float(rig.get("capUsd") or 0) or None,
        }
        _save_state()
    elif action == "status":
        touch(body.get("podId"))
    elif action in ("stop", "terminate"):
        WATCH.pop(body.get("podId"), None)
        _save_state()
    return 200, out
