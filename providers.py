"""providers.py — cloud provider adapters, python side.

API keys live HERE, never in the page: environment variables first
(RUNPOD_API_KEY, VAST_API_KEY), else providers.local.json next to this
file (gitignored). Browsers could not call provider APIs anyway (CORS),
and a key in page storage would leak with any export of the space.

The whole surface is five actions, dispatched from one route
(/local/provider/{name}/{action} standalone, /comfyvr/local/provider/...
hosted). Keeping it this small is what makes a provider one file:

  pricing            -> {gpus: [{id, name, vram_gb, usd_hr}]}
  start  {rig}       -> {podId, status}
  status {podId}     -> {status, url, usd_hr}   url only when serving
  stop   {podId}     -> {status}                gpu billing stops
  terminate {podId}  -> {status}                everything gone

Note: on a --listen/--tls server anyone on the LAN can hit these, same
as they can queue prompts. The key never leaves this process; the risk
is a housemate starting a pod, not a stranger reading your key.
"""
import json
import os

ROOT = os.path.dirname(os.path.abspath(__file__))
KEYFILE = os.path.join(ROOT, "providers.local.json")

ENV_KEYS = {"runpod": "RUNPOD_API_KEY", "vast": "VAST_API_KEY"}


def api_key(name):
    k = os.environ.get(ENV_KEYS.get(name, ""), "")
    if k:
        return k
    try:
        with open(KEYFILE, "r", encoding="utf-8") as fh:
            return (json.load(fh).get(name) or {}).get("apiKey", "")
    except (OSError, ValueError):
        return ""


async def _runpod(action, body, http, key):
    raise NotImplementedError("runpod adapter lands with the verified API shapes")


async def _vast(action, body, http, key):
    raise NotImplementedError("vast adapter lands with the verified API shapes")


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
    try:
        if http is None:
            import aiohttp
            async with aiohttp.ClientSession() as s:
                return 200, await fn(action, body, s, key)
        return 200, await fn(action, body, http, key)
    except NotImplementedError as e:
        return 501, {"error": str(e)}
    except Exception as e:
        return 502, {"error": f"{name} {action} failed", "detail": str(e)}
