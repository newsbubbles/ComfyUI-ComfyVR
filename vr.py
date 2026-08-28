"""One command to fly: cert, https server, and the address for your headset.

  python vr.py [--port 8443] [--backend http://127.0.0.1:8188]

WebXR needs a secure context. This serves comfyvr over https with a
self-signed certificate (generated on first run), prints the exact URL to
open in the headset browser, and proxies to your running ComfyUI. Accept
the certificate warning once in the headset and press ENTER VR.
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


def backend_alive(backend):
    try:
        with urllib.request.urlopen(backend.rstrip("/") + "/system_stats", timeout=2):
            return True
    except Exception:
        return False


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=int(os.environ.get("COMFYVR_PORT", 8443)))
    ap.add_argument("--backend", default=os.environ.get("COMFYVR_BACKEND", "http://127.0.0.1:8188"))
    args = ap.parse_args()

    cert, key = ROOT / "certs" / "cert.pem", ROOT / "certs" / "key.pem"
    if not (cert.is_file() and key.is_file()):
        print("no certificate yet, generating one...")
        subprocess.run([sys.executable, str(ROOT / "make_cert.py")], check=True)

    ips = [ip for ip in make_cert.lan_ips() if ip != "127.0.0.1"]
    ip = ips[0] if ips else "127.0.0.1"
    url = f"https://{ip}:{args.port}"

    bar = "=" * 62
    print(bar)
    print(f"  ComfyVR for headsets:  {url}")
    print(bar)
    print("  In the headset browser (same wifi as this PC):")
    print(f"    1. open {url}")
    print("    2. certificate warning appears: Advanced, then proceed.")
    print("       (self-signed, expected, one time)")
    print("    3. press ENTER VR, bottom right")
    print()
    if not backend_alive(args.backend):
        print(f"  WARNING: no ComfyUI answering at {args.backend}")
        print("  Start ComfyUI first, or pass --backend <url>. Demo mode")
        print("  still works without it.")
        print()
    print("  If the page never loads, allow the port through the firewall")
    print("  (run in an elevated prompt on Windows):")
    print(f"    netsh advfirewall firewall add rule name=ComfyVR-{args.port} "
          f"dir=in action=allow protocol=TCP localport={args.port}")
    print(bar)

    sys.argv = [sys.argv[0], "--tls", "--port", str(args.port), "--backend", args.backend]
    server.main()


if __name__ == "__main__":
    main()
