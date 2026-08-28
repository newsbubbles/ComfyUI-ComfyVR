"""Generate a self-signed cert for `server.py --tls` into certs/.

Headset browsers accept it after one warning screen; that is enough for a
secure context, which is what WebXR requires. Tries the `cryptography`
package first, then falls back to an openssl binary (Git for Windows
ships one).

  python make_cert.py [ip-or-hostname ...]
"""
import subprocess
import sys
from pathlib import Path

CERTS = Path(__file__).parent / "certs"
CERT, KEY = CERTS / "cert.pem", CERTS / "key.pem"
DAYS = 825


def lan_ips():
    import socket
    ips = {"127.0.0.1"}
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("8.8.8.8", 80))  # no traffic sent, just picks the outbound interface
        ips.add(s.getsockname()[0])
        s.close()
    except OSError:
        pass
    return sorted(ips)


def via_cryptography(names):
    import datetime
    import ipaddress
    from cryptography import x509
    from cryptography.hazmat.primitives import hashes, serialization
    from cryptography.hazmat.primitives.asymmetric import rsa
    from cryptography.x509.oid import NameOID

    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    subject = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "comfyvr")])
    alt = []
    for n in names:
        try:
            alt.append(x509.IPAddress(ipaddress.ip_address(n)))
        except ValueError:
            alt.append(x509.DNSName(n))
    now = datetime.datetime.now(datetime.timezone.utc)
    cert = (
        x509.CertificateBuilder()
        .subject_name(subject)
        .issuer_name(subject)
        .public_key(key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(now)
        .not_valid_after(now + datetime.timedelta(days=DAYS))
        .add_extension(x509.SubjectAlternativeName(alt), critical=False)
        .sign(key, hashes.SHA256())
    )
    KEY.write_bytes(key.private_bytes(
        serialization.Encoding.PEM,
        serialization.PrivateFormat.TraditionalOpenSSL,
        serialization.NoEncryption(),
    ))
    CERT.write_bytes(cert.public_bytes(serialization.Encoding.PEM))


def via_openssl(names):
    import ipaddress
    import shutil
    exe = shutil.which("openssl")
    if not exe:
        for c in (r"C:\Program Files\Git\usr\bin\openssl.exe",
                  r"C:\Program Files\Git\mingw64\bin\openssl.exe"):
            if Path(c).is_file():
                exe = c
                break
    if not exe:
        raise SystemExit("neither the `cryptography` package nor an openssl binary "
                         "was found; `pip install cryptography` and rerun")
    san = []
    for n in names:
        try:
            ipaddress.ip_address(n)
            san.append("IP:" + n)
        except ValueError:
            san.append("DNS:" + n)
    subprocess.run([exe, "req", "-x509", "-newkey", "rsa:2048", "-nodes",
                    "-keyout", str(KEY), "-out", str(CERT), "-days", str(DAYS),
                    "-subj", "/CN=comfyvr",
                    "-addext", "subjectAltName=" + ",".join(san)], check=True)


def main():
    names = sys.argv[1:] or lan_ips() + ["localhost"]
    CERTS.mkdir(exist_ok=True)
    try:
        via_cryptography(names)
        how = "cryptography"
    except ImportError:
        via_openssl(names)
        how = "openssl"
    print(f"wrote {CERT} and {KEY} ({how}) for: {', '.join(names)}")


if __name__ == "__main__":
    main()
