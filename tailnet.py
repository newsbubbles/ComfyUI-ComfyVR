"""Tailscale glue: find the CLI, read serve rules, publish a port to the tailnet.

Everything here is best effort. If tailscale is missing, logged out, or the
serve API refuses, callers fall back to LAN only.
"""
import json
import shutil
import subprocess
from pathlib import Path

_CANDIDATES = [
    r"C:\Program Files\Tailscale\tailscale.exe",
    "/Applications/Tailscale.app/Contents/MacOS/Tailscale",
    "/usr/local/bin/tailscale",
    "/usr/bin/tailscale",
]


def cli():
    """Path to the tailscale binary, or None."""
    found = shutil.which("tailscale")
    if found:
        return found
    for c in _CANDIDATES:
        if Path(c).is_file():
            return c
    return None


def _run(exe, *args, timeout=30):
    try:
        p = subprocess.run([exe, *args], capture_output=True, text=True, timeout=timeout)
    except (OSError, subprocess.SubprocessError) as e:
        return None, str(e)
    if p.returncode != 0:
        return None, (p.stderr or p.stdout).strip()
    return p.stdout, ""


def dns_name(exe):
    """MagicDNS name of this machine, or None when tailscale is not running."""
    out, _ = _run(exe, "status", "--json")
    if not out:
        return None
    try:
        st = json.loads(out)
    except ValueError:
        return None
    if st.get("BackendState") != "Running":
        return None
    return ((st.get("Self") or {}).get("DNSName") or "").rstrip(".") or None


def rules(exe):
    """{port: proxy target} for web handlers already published."""
    out, _ = _run(exe, "serve", "status", "--json")
    if not out:
        return {}
    try:
        cfg = json.loads(out)
    except ValueError:
        return {}
    found = {}
    for hostport, entry in (cfg.get("Web") or {}).items():
        handler = (entry.get("Handlers") or {}).get("/") or {}
        if "Proxy" in handler:
            found[hostport.rsplit(":", 1)[-1]] = handler["Proxy"]
    return found


def funnelled(exe):
    """Ports exposed to the public internet, which comfyvr never asks for."""
    out, _ = _run(exe, "serve", "status", "--json")
    if not out:
        return set()
    try:
        cfg = json.loads(out)
    except ValueError:
        return set()
    return {hp.rsplit(":", 1)[-1] for hp, on in (cfg.get("AllowFunnel") or {}).items() if on}


def publish(exe, port, target):
    """Put target behind https://<name>:<port>, reachable by the tailnet only."""
    return _run(exe, "serve", "--bg", "--https", str(port), target)


def withdraw(exe, port):
    _run(exe, "serve", f"--https={port}", "off")
