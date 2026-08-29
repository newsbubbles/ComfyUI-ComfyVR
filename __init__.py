"""ComfyUI-ComfyVR: serve the comfyvr frontend from ComfyUI itself.

Drop this repo into custom_nodes/ and ComfyUI grows a /comfyvr route —
no separate server, no proxy, one origin. The frontend detects it is
hosted and talks to ComfyUI's /api and /ws directly.

Registers no nodes; it is pure routes.
"""
import json
import os
import re
import time

NODE_CLASS_MAPPINGS = {}
NODE_DISPLAY_NAME_MAPPINGS = {}
WEB_DIRECTORY = None

try:
    from aiohttp import web
    from server import PromptServer

    ROOT = os.path.dirname(os.path.abspath(__file__))
    PUBLIC = os.path.join(ROOT, "public")
    WORKFLOWS = os.path.join(ROOT, "workflows")
    LAYOUTS = os.path.join(ROOT, "layouts")
    SAFE_NAME = re.compile(r"^[\w][\w .()\-]{0,120}$")
    NOCACHE = {"Cache-Control": "no-cache"}

    routes = PromptServer.instance.routes

    @routes.get("/comfyvr")
    async def cvr_root(request):
        # trailing slash so the page's relative asset paths resolve
        raise web.HTTPFound("/comfyvr/")

    @routes.get("/comfyvr/")
    async def cvr_index(request):
        return web.FileResponse(os.path.join(PUBLIC, "index.html"), headers=NOCACHE)

    @routes.get("/comfyvr/local/workflows")
    async def cvr_list(request):
        os.makedirs(WORKFLOWS, exist_ok=True)
        items = [
            {"name": f[:-5], "mtime": int(os.path.getmtime(os.path.join(WORKFLOWS, f)))}
            for f in sorted(os.listdir(WORKFLOWS))
            if f.endswith(".json")
        ]
        return web.json_response(items)

    @routes.get("/comfyvr/local/workflows/{name}")
    async def cvr_get(request):
        name = request.match_info["name"]
        if not SAFE_NAME.match(name):
            raise web.HTTPBadRequest(text="bad name")
        p = os.path.join(WORKFLOWS, name + ".json")
        if not os.path.isfile(p):
            raise web.HTTPNotFound()
        with open(p, "r", encoding="utf-8") as fh:
            return web.json_response(json.load(fh))

    @routes.post("/comfyvr/local/workflows/{name}")
    async def cvr_save(request):
        name = request.match_info["name"]
        if not SAFE_NAME.match(name):
            raise web.HTTPBadRequest(text="bad name")
        body = await request.json()
        os.makedirs(WORKFLOWS, exist_ok=True)
        with open(os.path.join(WORKFLOWS, name + ".json"), "w", encoding="utf-8") as fh:
            json.dump(body, fh, indent=1)
        return web.json_response({"saved": name, "mtime": int(time.time())})

    # Layout sidecar: 3D arrangements for workflows we must never write
    # back (userdata stays read-only). Keyed source__name.
    @routes.get("/comfyvr/local/layouts")
    async def cvr_layouts(request):
        out = {}
        if os.path.isdir(LAYOUTS):
            for f in os.listdir(LAYOUTS):
                if not f.endswith(".json"):
                    continue
                try:
                    with open(os.path.join(LAYOUTS, f), "r", encoding="utf-8") as fh:
                        out[f[:-5]] = json.load(fh)
                except Exception:
                    pass
        return web.json_response(out)

    @routes.post("/comfyvr/local/layouts/{key}")
    async def cvr_layout_save(request):
        key = request.match_info["key"]
        if not SAFE_NAME.match(key):
            raise web.HTTPBadRequest(text="bad key")
        body = await request.json()
        os.makedirs(LAYOUTS, exist_ok=True)
        with open(os.path.join(LAYOUTS, key + ".json"), "w", encoding="utf-8") as fh:
            json.dump(body, fh)
        return web.json_response({"saved": key})

    # Dictation: forward audio to a local whisper sidecar (speakwright),
    # so the headset only ever talks to this origin.
    @routes.post("/comfyvr/local/stt")
    async def cvr_stt(request):
        import aiohttp
        stt_backend = os.environ.get("COMFYVR_STT", "http://127.0.0.1:8765")
        data = await request.read()
        headers = {"Content-Type": request.headers.get("Content-Type", "")}
        try:
            async with aiohttp.ClientSession() as s:
                async with s.post(
                    stt_backend + "/v1/audio/transcriptions",
                    data=data,
                    headers=headers,
                    timeout=aiohttp.ClientTimeout(total=120),
                ) as r:
                    body = await r.read()
                    ct = r.headers.get("Content-Type", "application/json")
                    return web.Response(status=r.status, body=body, headers={"Content-Type": ct})
        except Exception as e:
            return web.json_response(
                {"error": "voice sidecar not running (start speakwright on 127.0.0.1:8765)", "detail": str(e)},
                status=502,
            )

    @routes.get("/comfyvr/{tail:.+}")
    async def cvr_static(request):
        tail = request.match_info["tail"]
        p = os.path.normpath(os.path.join(PUBLIC, tail))
        if not p.startswith(os.path.normpath(PUBLIC) + os.sep) or not os.path.isfile(p):
            raise web.HTTPNotFound()
        return web.FileResponse(p, headers=NOCACHE)

    print("[comfyvr] frontend mounted at /comfyvr/")
except Exception as e:  # never take ComfyUI down with us
    print(f"[comfyvr] route registration failed: {e}")
