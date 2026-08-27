"""comfyvr server: static frontend + transparent proxy to a ComfyUI backend.

Serving the frontend and the ComfyUI API from one origin means CORS never
exists. Run ComfyUI normally (default http://127.0.0.1:8188); point this at
it with COMFYVR_BACKEND if it lives elsewhere.

  python server.py [--port 8189] [--backend http://127.0.0.1:8188]
"""
import argparse
import asyncio
import json
import os
import re
import time
from pathlib import Path

import aiohttp
from aiohttp import web

ROOT = Path(__file__).parent
PUBLIC = ROOT / "public"
WORKFLOWS = ROOT / "workflows"

SAFE_NAME = re.compile(r"^[\w][\w .()\-]{0,80}$")


@web.middleware
async def nocache_mw(request, handler):
    # dev tool: never let the browser heuristically cache stale modules
    resp = await handler(request)
    resp.headers["Cache-Control"] = "no-cache"
    return resp


def app_factory(backend: str) -> web.Application:
    app = web.Application(client_max_size=64 * 1024 * 1024, middlewares=[nocache_mw])
    app["backend"] = backend.rstrip("/")

    async def on_startup(app):
        app["http"] = aiohttp.ClientSession()

    async def on_cleanup(app):
        await app["http"].close()

    app.on_startup.append(on_startup)
    app.on_cleanup.append(on_cleanup)

    async def health(request):
        ok = False
        try:
            async with request.app["http"].get(
                request.app["backend"] + "/system_stats",
                timeout=aiohttp.ClientTimeout(total=1.5),
            ) as r:
                ok = r.status == 200
        except Exception:
            ok = False
        return web.json_response({"ok": True, "backend": request.app["backend"], "live": ok})

    async def local_list(request):
        WORKFLOWS.mkdir(exist_ok=True)
        items = []
        for p in sorted(WORKFLOWS.glob("*.json")):
            items.append({"name": p.stem, "mtime": int(p.stat().st_mtime)})
        return web.json_response(items)

    async def local_get(request):
        name = request.match_info["name"]
        if not SAFE_NAME.match(name):
            raise web.HTTPBadRequest(text="bad name")
        p = WORKFLOWS / (name + ".json")
        if not p.is_file():
            raise web.HTTPNotFound()
        return web.json_response(json.loads(p.read_text(encoding="utf-8")))

    async def local_save(request):
        name = request.match_info["name"]
        if not SAFE_NAME.match(name):
            raise web.HTTPBadRequest(text="bad name")
        body = await request.json()  # must be valid JSON
        WORKFLOWS.mkdir(exist_ok=True)
        p = WORKFLOWS / (name + ".json")
        p.write_text(json.dumps(body, indent=1), encoding="utf-8")
        return web.json_response({"saved": name, "mtime": int(time.time())})

    async def proxy(request):
        """Forward /api/<path> to the backend as /<path>."""
        path = request.match_info["path"]
        url = f"{request.app['backend']}/{path}"
        data = await request.read() if request.can_read_body else None
        headers = {
            k: v
            for k, v in request.headers.items()
            if k.lower() not in ("host", "origin", "referer", "content-length")
        }
        try:
            async with request.app["http"].request(
                request.method,
                url,
                params=request.query,
                data=data,
                headers=headers,
                timeout=aiohttp.ClientTimeout(total=120),
            ) as r:
                body = await r.read()
                resp_headers = {}
                ct = r.headers.get("Content-Type")
                if ct:
                    resp_headers["Content-Type"] = ct
                return web.Response(status=r.status, body=body, headers=resp_headers)
        except (aiohttp.ClientError, asyncio.TimeoutError) as e:
            return web.json_response({"error": "backend unreachable", "detail": str(e)}, status=502)

    async def ws_proxy(request):
        """Bidirectional websocket pump between browser and ComfyUI /ws."""
        ws_client = web.WebSocketResponse(max_msg_size=64 * 1024 * 1024)
        await ws_client.prepare(request)
        backend = request.app["backend"].replace("http", "ws", 1) + "/ws"
        if request.query_string:
            backend += "?" + request.query_string
        try:
            async with request.app["http"].ws_connect(backend, max_msg_size=64 * 1024 * 1024) as ws_backend:

                async def pump(src, dst):
                    async for msg in src:
                        if msg.type == aiohttp.WSMsgType.TEXT:
                            await dst.send_str(msg.data)
                        elif msg.type == aiohttp.WSMsgType.BINARY:
                            await dst.send_bytes(msg.data)
                        else:
                            break
                    if not dst.closed:
                        await dst.close()

                await asyncio.gather(pump(ws_client, ws_backend), pump(ws_backend, ws_client))
        except (aiohttp.ClientError, asyncio.TimeoutError):
            if not ws_client.closed:
                await ws_client.close(code=1011, message=b"backend unreachable")
        return ws_client

    async def index(request):
        return web.FileResponse(PUBLIC / "index.html")

    app.router.add_get("/", index)
    app.router.add_get("/health", health)
    app.router.add_get("/local/workflows", local_list)
    app.router.add_get("/local/workflows/{name}", local_get)
    app.router.add_post("/local/workflows/{name}", local_save)
    app.router.add_get("/ws", ws_proxy)
    app.router.add_route("*", "/api/{path:.*}", proxy)
    app.router.add_static("/", PUBLIC)
    return app


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=int(os.environ.get("COMFYVR_PORT", 8189)))
    ap.add_argument("--backend", default=os.environ.get("COMFYVR_BACKEND", "http://127.0.0.1:8188"))
    args = ap.parse_args()
    print(f"comfyvr on http://127.0.0.1:{args.port}  (backend: {args.backend})")
    web.run_app(app_factory(args.backend), host="127.0.0.1", port=args.port, print=None)


if __name__ == "__main__":
    main()
