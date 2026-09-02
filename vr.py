"""One command to fly: cert, https server, and the address for your headset.

  python vr.py [--port 8443] [--backend http://127.0.0.1:8188]
               [--ts-port 8444] [--no-tailscale] [--ts-keep]

WebXR needs a secure context. This serves comfyvr over https with a
self-signed certificate (generated on first run), prints the exact URL to
open in the headset browser, and proxies to your running ComfyUI. Accept
the certificate warning once in the headset and press ENTER VR.

If tailscale is installed and logged in, the same server is also published
to your tailnet, which gets you a real certificate (no warning) and works
from any network, not just the one this machine is on. The tailnet address
is printed alongside the LAN one. Nothing is ever exposed to the public
internet: comfyvr can start pods and spend money, so it uses serve and
never funnel.
"""
import argparse
import os
import subprocess
import sys
import urllib.request
from pathlib import Path

ROOT = Path(__file__).parent
sys.path.insert(0, str(ROOT))

import make_cert
import server
import tailnet


def backend_alive(backend):
    try:
        with urllib.request.urlopen(backend.rstrip("/") + "/system_stats", timeout=2):
            return True
    except Exception:
        return False


def open_tailnet(port, ts_port):
    """Publish the local https server to the tailnet. Returns (url, reason)."""
    exe = tailnet.cli()
    if not exe:
        return None, "tailscale is not installed"
    name = tailnet.dns_name(exe)
    if not name:
        return None, "tailscale is installed but not logged in (run: tailscale up)"
    if str(ts_port) in tailnet.funnelled(exe):
        return None, f"port {ts_port} is on funnel (public internet), refusing to use it"

    target = f"https+insecure://127.0.0.1:{port}"
    existing = tailnet.rules(exe).get(str(ts_port))
    if existing and existing != target:
        return None, f"port {ts_port} already serves {existing}, left alone (try --ts-port)"

    out, err = tailnet.publish(exe, ts_port, target)
    if out is None:
        return None, (err.splitlines() or ["serve refused"])[0]
    return f"https://{name}:{ts_port}", ""


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=int(os.environ.get("COMFYVR_PORT", 8443)))
    ap.add_argument("--backend", default=os.environ.get("COMFYVR_BACKEND", "http://127.0.0.1:8188"))
    ap.add_argument("--ts-port", type=int, default=int(os.environ.get("COMFYVR_TS_PORT", 8444)),
                    help="tailnet port to publish on (default 8444)")
    ap.add_argument("--no-tailscale", action="store_true", help="skip the tailnet entirely")
    ap.add_argument("--ts-keep", action="store_true",
                    help="leave the tailnet address up after this server stops")
    args = ap.parse_args()

    cert, key = ROOT / "certs" / "cert.pem", ROOT / "certs" / "key.pem"
    if not (cert.is_file() and key.is_file()):
        print("no certificate yet, generating one...")
        subprocess.run([sys.executable, str(ROOT / "make_cert.py")], check=True)

    ips = [ip for ip in make_cert.lan_ips() if ip != "127.0.0.1"]
    ip = ips[0] if ips else "127.0.0.1"
    url = f"https://{ip}:{args.port}"

    ts_url, ts_why = (None, "disabled with --no-tailscale")
    if not args.no_tailscale:
        if args.ts_port == args.port:
            ts_why = f"--ts-port {args.ts_port} collides with the local port"
        else:
            ts_url, ts_why = open_tailnet(args.port, args.ts_port)

    bar = "=" * 62
    print(bar)
    print("  ComfyVR for headsets")
    print()
    print(f"  same wifi:  {url}")
    print("              certificate warning appears: Advanced, then")
    print("              proceed. Self-signed, expected, one time.")
    print()
    if ts_url:
        print(f"  anywhere:   {ts_url}")
        print("              real certificate, no warning. Needs tailscale")
        print("              running on the headset, on any network.")
    else:
        print(f"  anywhere:   not published ({ts_why})")
    print()
    print("  Then press ENTER VR, bottom right.")
    print(bar)
    if not backend_alive(args.backend):
        print(f"  WARNING: no ComfyUI answering at {args.backend}")
        print("  Start ComfyUI first, or pass --backend <url>. Demo mode")
        print("  still works without it.")
        print(bar)
    print("  If the same-wifi page never loads, allow the port through the")
    print("  firewall (run in an elevated prompt on Windows):")
    print(f"    netsh advfirewall firewall add rule name=ComfyVR-{args.port} "
          f"dir=in action=allow protocol=TCP localport={args.port}")
    print(bar)

    sys.argv = [sys.argv[0], "--tls", "--port", str(args.port), "--backend", args.backend]
    try:
        server.main()
    finally:
        if ts_url and not args.ts_keep:
            tailnet.withdraw(tailnet.cli(), args.ts_port)


if __name__ == "__main__":
    main()
