"""comfyvr server: static frontend + transparent proxy to a ComfyUI backend.

Serving the frontend and the ComfyUI API from one origin means CORS never
exists. Run ComfyUI normally (default http://127.0.0.1:8188); point this at
it with COMFYVR_BACKEND if it lives elsewhere.

  python server.py [--port 8189] [--backend http://127.0.0.1:8188]

For headsets on the same network (no cable, no developer mode): WebXR needs
a secure context, so serve https and let the headset browser accept the
self-signed cert once.

  python make_cert.py
  python server.py --tls --port 8443
"""
import argparse
import asyncio
import json
import os
import re
import time
import uuid
from pathlib import Path

import aiohttp
from aiohttp import web
from yarl import URL

ROOT = Path(__file__).parent
PUBLIC = ROOT / "public"
WORKFLOWS = ROOT / "workflows"
LAYOUTS = ROOT / "layouts"

SAFE_NAME = re.compile(r"^[\w][\w .()\-]{0,120}$")


@web.middleware
async def nocache_mw(request, handler):
    # dev tool: never let the browser heuristically cache stale modules
    resp = await handler(request)
    resp.headers["Cache-Control"] = "no-cache"
    return resp


def app_factory(backend: str) -> web.Application:
    app = web.Application(client_max_size=64 * 1024 * 1024, middlewares=[nocache_mw])
    app["backend"] = backend.rstrip("/")
    app["agent_exec"] = None
    app["agent_pending"] = {}

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

    # Layout sidecar: 3D arrangements for workflows we must never write back
    # (userdata stays read-only). One small JSON per workflow, keyed
    # source__name.
    async def layouts_all(request):
        out = {}
        if LAYOUTS.is_dir():
            for p in LAYOUTS.glob("*.json"):
                try:
                    out[p.stem] = json.loads(p.read_text(encoding="utf-8"))
                except Exception:
                    pass
        return web.json_response(out)

    async def layout_save(request):
        key = request.match_info["key"]
        if not SAFE_NAME.match(key):
            raise web.HTTPBadRequest(text="bad key")
        body = await request.json()
        LAYOUTS.mkdir(exist_ok=True)
        (LAYOUTS / (key + ".json")).write_text(json.dumps(body), encoding="utf-8")
        return web.json_response({"saved": key})

    async def stt_proxy(request):
        """Forward dictated audio to a local whisper sidecar (speakwright).

        The sidecar binds to 127.0.0.1 only; routing through here means the
        headset never needs a second origin or a second certificate.
        """
        stt_backend = os.environ.get("COMFYVR_STT", "http://127.0.0.1:8765")
        data = await request.read()
        headers = {"Content-Type": request.headers.get("Content-Type", "")}
        try:
            async with request.app["http"].post(
                stt_backend + "/v1/audio/transcriptions",
                data=data,
                headers=headers,
                timeout=aiohttp.ClientTimeout(total=120),
            ) as r:
                body = await r.read()
                ct = r.headers.get("Content-Type", "application/json")
                return web.Response(status=r.status, body=body, headers={"Content-Type": ct})
        except (aiohttp.ClientError, asyncio.TimeoutError) as e:
            return web.json_response(
                {"error": "voice sidecar not running (start speakwright on 127.0.0.1:8765)", "detail": str(e)},
                status=502,
            )

    async def tts_proxy(request):
        """Forward text to the local voice sidecar's speech endpoint."""
        stt_backend = os.environ.get("COMFYVR_STT", "http://127.0.0.1:8765")
        body = await request.read()
        try:
            async with request.app["http"].post(
                stt_backend + "/v1/audio/speech",
                data=body,
                headers={"Content-Type": "application/json"},
                timeout=aiohttp.ClientTimeout(total=120),
            ) as r:
                out = await r.read()
                ct = r.headers.get("Content-Type", "audio/wav")
                return web.Response(status=r.status, body=out, headers={"Content-Type": ct})
        except (aiohttp.ClientError, asyncio.TimeoutError) as e:
            return web.json_response(
                {"error": "voice sidecar not running (start speakwright on 127.0.0.1:8765)", "detail": str(e)},
                status=502,
            )

    # Rigs and destinations, server-side: localStorage is per-origin, so
    # anything set up on the desktop origin was invisible in the headset
    # (8443) and vice versa. One json next to the server is the shared
    # truth; the page keeps localStorage only as a cache and demo fallback.
    REGISTRY = ROOT / "registry.json"

    async def registry_get(request):
        try:
            return web.json_response(json.loads(REGISTRY.read_text(encoding="utf-8")))
        except (OSError, ValueError):
            return web.json_response({"destinations": [], "rigs": []})

    async def registry_save(request):
        try:
            body = await request.json()
        except ValueError:
            raise web.HTTPBadRequest(text="body must be JSON")
        REGISTRY.write_text(json.dumps(body, indent=1), encoding="utf-8")
        return web.json_response({"saved": True})

    # ---- destination relay ------------------------------------------------
    # The https headset page cannot fetch plain-http destinations (LAN
    # peers, vast pods): mixed content. The page registers the destination
    # once, then talks to /local/relay/{id}/... on THIS origin and we
    # forward server-side, http and websocket both. Registration is
    # LAN-open like everything else here; the relay only forwards to
    # registered urls, never to arbitrary ones from the request line.
    app["relays"] = {}

    async def relay_register(request):
        try:
            body = await request.json()
        except ValueError:
            raise web.HTTPBadRequest(text="body must be JSON")
        rid = str(body.get("id", "")).strip()
        url = str(body.get("url", "")).rstrip("/")
        if not rid or not url.startswith(("http://", "https://")):
            raise web.HTTPBadRequest(text="need id and an http(s) url")
        request.app["relays"][rid] = url
        return web.json_response({"ok": True, "id": rid})

    async def relay_http(request):
        rid = request.match_info["rid"]
        base = request.app["relays"].get(rid)
        if not base:
            return web.json_response({"error": "unknown relay (register first)"}, status=404)
        # raw path keeps %2F-encoded segments intact (same as the /api proxy)
        raw_path = request.rel_url.raw_path[len(f"/local/relay/{rid}/api"):]
        qs = request.rel_url.raw_query_string
        url = URL(base + raw_path + (f"?{qs}" if qs else ""), encoded=True)
        data = await request.read() if request.can_read_body else None
        headers = {
            k: v
            for k, v in request.headers.items()
            if k.lower() not in ("host", "origin", "referer", "content-length")
        }
        try:
            async with request.app["http"].request(
                request.method, url, data=data, headers=headers,
                timeout=aiohttp.ClientTimeout(total=120),
            ) as r:
                body = await r.read()
                resp_headers = {}
                ct = r.headers.get("Content-Type")
                if ct:
                    resp_headers["Content-Type"] = ct
                return web.Response(status=r.status, body=body, headers=resp_headers)
        except (aiohttp.ClientError, asyncio.TimeoutError) as e:
            return web.json_response({"error": "destination unreachable", "detail": str(e)}, status=502)

    async def relay_ws(request):
        base = request.app["relays"].get(request.match_info["rid"])
        if not base:
            raise web.HTTPNotFound(text="unknown relay (register first)")
        ws_client = web.WebSocketResponse(max_msg_size=64 * 1024 * 1024)
        await ws_client.prepare(request)
        backend = base.replace("http", "ws", 1) + "/ws"
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
                await ws_client.close(code=1011, message=b"destination unreachable")
        return ws_client

    async def provider_call(request):
        """Cloud provider actions (pricing/start/status/stop/terminate).

        The page never holds provider keys; providers.py owns custody and
        talks to the provider API through our client session.
        """
        import providers
        body = {}
        if request.can_read_body:
            try:
                body = await request.json()
            except ValueError:
                raise web.HTTPBadRequest(text="body must be JSON")
        status, out = await providers.handle(
            request.match_info["name"], request.match_info["action"], body, request.app["http"]
        )
        return web.json_response(out, status=status)

    # ---- agent bridge: tools ride a websocket INTO the live page ----------
    # The space is the source of truth for spatial state, so tool calls are
    # answered by the page itself: an agent POSTs /local/agent/call, the
    # server relays over the executor websocket, the page runs the tool and
    # replies. One page per server instance; last connected wins.

    async def agent_ws(request):
        ws = web.WebSocketResponse(heartbeat=25)
        await ws.prepare(request)
        request.app["agent_exec"] = ws
        try:
            async for msg in ws:
                if msg.type != aiohttp.WSMsgType.TEXT:
                    continue
                try:
                    d = json.loads(msg.data)
                except ValueError:
                    continue
                fut = request.app["agent_pending"].pop(d.get("id"), None)
                if fut is not None and not fut.done():
                    fut.set_result(d)
        finally:
            if request.app.get("agent_exec") is ws:
                request.app["agent_exec"] = None
        return ws

    async def agent_call(request):
        # tool calls come only from this machine (the harness), never the LAN
        if request.remote not in ("127.0.0.1", "::1"):
            raise web.HTTPForbidden(text="agent calls are loopback-only")
        ws = request.app.get("agent_exec")
        if ws is None or ws.closed:
            return web.json_response({"ok": False, "error": "no space connected (open the page first)"}, status=503)
        body = await request.json()
        cid = uuid.uuid4().hex
        fut = asyncio.get_event_loop().create_future()
        request.app["agent_pending"][cid] = fut
        try:
            await ws.send_str(json.dumps({"id": cid, "tool": body.get("tool"), "args": body.get("args") or {}}))
            d = await asyncio.wait_for(fut, 30)
        except asyncio.TimeoutError:
            return web.json_response({"ok": False, "error": "space did not answer in 30s"}, status=504)
        except (aiohttp.ClientError, ConnectionResetError) as e:
            return web.json_response({"ok": False, "error": f"space link dropped: {e}"}, status=502)
        finally:
            request.app["agent_pending"].pop(cid, None)
        return web.json_response(d)

    async def proxy(request):
        """Forward /api/<path> to the backend as /<path>.

        Uses the RAW (still-encoded) path: ComfyUI routes like
        /userdata/{file} take %2F-encoded slashes inside one segment, which
        aiohttp's decoded match_info would corrupt into nested paths.
        """
        raw_path = request.rel_url.raw_path[len("/api"):]
        qs = request.rel_url.raw_query_string
        url = URL(
            f"{request.app['backend']}{raw_path}" + (f"?{qs}" if qs else ""),
            encoded=True,
        )
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
    app.router.add_get("/local/layouts", layouts_all)
    app.router.add_post("/local/layouts/{key}", layout_save)
    app.router.add_post("/local/stt", stt_proxy)
    app.router.add_post("/local/tts", tts_proxy)
    app.router.add_get("/local/registry", registry_get)
    app.router.add_post("/local/registry", registry_save)
    app.router.add_post("/local/provider/{name}/{action}", provider_call)
    app.router.add_post("/local/relay/register", relay_register)
    app.router.add_get("/local/relay/{rid}/ws", relay_ws)
    app.router.add_route("*", "/local/relay/{rid}/api/{path:.*}", relay_http)
    app.router.add_get("/local/agent", agent_ws)
    app.router.add_post("/local/agent/call", agent_call)
    app.router.add_get("/ws", ws_proxy)
    app.router.add_route("*", "/api/{path:.*}", proxy)
    (ROOT / "media").mkdir(exist_ok=True)
    app.router.add_static("/media", ROOT / "media")   # local test assets (gitignored)
    app.router.add_static("/", PUBLIC)
    return app


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=int(os.environ.get("COMFYVR_PORT", 8189)))
    ap.add_argument("--backend", default=os.environ.get("COMFYVR_BACKEND", "http://127.0.0.1:8188"))
    ap.add_argument("--host", default=os.environ.get("COMFYVR_HOST"))
    ap.add_argument("--tls", action="store_true",
                    help="serve https using certs/cert.pem + certs/key.pem and listen on the LAN")
    args = ap.parse_args()

    ssl_ctx = None
    if args.tls:
        import ssl
        cert, key = ROOT / "certs" / "cert.pem", ROOT / "certs" / "key.pem"
        if not (cert.is_file() and key.is_file()):
            raise SystemExit("no certs found: run `python make_cert.py` first")
        ssl_ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        ssl_ctx.load_cert_chain(cert, key)

    host = args.host or ("0.0.0.0" if args.tls else "127.0.0.1")
    scheme = "https" if ssl_ctx else "http"
    shown = host
    if host == "0.0.0.0":
        import socket
        try:
            s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
            s.connect(("8.8.8.8", 80))  # no traffic sent, just picks the outbound interface
            shown = s.getsockname()[0]
            s.close()
        except OSError:
            shown = "localhost"
    print(f"comfyvr on {scheme}://{shown}:{args.port}  (backend: {args.backend})")
    web.run_app(app_factory(args.backend), host=host, port=args.port, print=None, ssl_context=ssl_ctx)


if __name__ == "__main__":
    main()
