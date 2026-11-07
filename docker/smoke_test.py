"""End-to-end check of a running Stepthrough server, using only the Python standard library and ffmpeg.

Run it inside the container, so it needs nothing on the host:

    docker compose exec -T stepthrough python - < docker/smoke_test.py

or against any address: python docker/smoke_test.py https://stepthrough.example.org

It makes a throwaway project, uploads a two-screen recording, runs the analysis, opens a screenshot, checks the live
progress socket, exports the run, and deletes the project again. It exits non-zero at the first thing that fails.

With --ocr (for the `-ocr` image) the two screens carry words, the run reads them, and the test checks the text that
comes back. Drawing the words needs Pillow, which the image has.
"""

from __future__ import annotations

import csv
import io
import json
import socket
import ssl
import subprocess
import sys
import tempfile
import time
import uuid
import zipfile
from pathlib import Path
from urllib.parse import urljoin, urlsplit
from urllib.request import Request, urlopen

ARGS = [arg for arg in sys.argv[1:] if not arg.startswith("--")]
OCR = "--ocr" in sys.argv[1:]
BASE = (ARGS[0] if ARGS else "http://127.0.0.1:8000").rstrip("/") + "/"
OCR_WORDS = ("Inbox", "Settings")


def call(method: str, path: str, body: bytes | None = None, content_type: str | None = None) -> tuple[int, dict, bytes]:
    request = Request(urljoin(BASE, path.lstrip("/")), data=body, method=method)
    if content_type:
        request.add_header("Content-Type", content_type)
    with urlopen(request, timeout=60) as response:
        return response.status, dict(response.headers), response.read()


def call_json(method: str, path: str, payload: object | None = None) -> object:
    body = None if payload is None else json.dumps(payload).encode()
    _, _, data = call(method, path, body, "application/json" if body is not None else None)
    return json.loads(data) if data else None


def check(condition: bool, what: str) -> None:
    print(("ok    " if condition else "FAIL  ") + what)
    if not condition:
        raise SystemExit(1)


def multipart(fields: dict[str, str], file_field: str, file_path: Path) -> tuple[bytes, str]:
    boundary = uuid.uuid4().hex
    parts = []
    for name, value in fields.items():
        parts.append(f'--{boundary}\r\nContent-Disposition: form-data; name="{name}"\r\n\r\n{value}\r\n'.encode())
    parts.append(
        f'--{boundary}\r\nContent-Disposition: form-data; name="{file_field}"; filename="{file_path.name}"\r\n'
        "Content-Type: video/mp4\r\n\r\n".encode()
    )
    parts.append(file_path.read_bytes())
    parts.append(f"\r\n--{boundary}--\r\n".encode())
    return b"".join(parts), f"multipart/form-data; boundary={boundary}"


def make_recording(video: Path) -> None:
    """Two still screens of 1.5 s each: plain colours, or (with --ocr) dark words on white."""
    if OCR:
        from PIL import Image, ImageDraw, ImageFont

        font = ImageFont.load_default(size=96)
        inputs = []
        for index, word in enumerate(OCR_WORDS):
            screen = Image.new("RGB", (720, 1280), "white")
            ImageDraw.Draw(screen).text((60, 220), word, fill="black", font=font)
            png = video.with_name(f"screen-{index}.png")
            screen.save(png)
            inputs += ["-loop", "1", "-t", "1.5", "-i", str(png)]
    else:
        inputs = ["-f", "lavfi", "-i", "color=c=0xF4F4F4:s=640x360:d=1.5", "-f", "lavfi", "-i", "color=c=0x2E7DCB:s=640x360:d=1.5"]
    subprocess.run(
        ["ffmpeg", "-v", "error", "-y", *inputs, "-filter_complex", "[0:v][1:v]concat=n=2:v=1:a=0,fps=30",
         "-c:v", "libx264", "-pix_fmt", "yuv420p", str(video)],
        check=True,
    )


def websocket_upgrades(path: str) -> bool:
    url = urlsplit(urljoin(BASE, path.lstrip("/")))
    secure = url.scheme == "https"
    port = url.port or (443 if secure else 80)
    with socket.create_connection((url.hostname, port), timeout=10) as raw:
        conn = ssl.create_default_context().wrap_socket(raw, server_hostname=url.hostname) if secure else raw
        conn.sendall(
            (
                f"GET {url.path} HTTP/1.1\r\nHost: {url.netloc}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n"
                "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n"
            ).encode()
        )
        return conn.recv(1024).split(b"\r\n", 1)[0].startswith(b"HTTP/1.1 101")


def main() -> None:
    print(f"Stepthrough smoke test against {BASE}")
    status, headers, page = call("GET", "/")
    check(status == 200 and b"<title>" in page and "text/html" in headers.get("content-type", ""), "the frontend loads")

    health = call_json("GET", "/health")
    check(health["ffmpeg_available"] and health["ffprobe_available"], "ffmpeg and ffprobe are available")

    project = call_json("POST", "/projects", {"name": f"smoke test {time.strftime('%Y-%m-%d %H:%M')}"})
    try:
        with tempfile.TemporaryDirectory() as tmp:
            video = Path(tmp) / "smoke.mp4"
            make_recording(video)
            body, content_type = multipart({"project_id": project["id"]}, "file", video)
            _, _, data = call("POST", "/recordings/import", body, content_type)
        recording = json.loads(data)
        check(bool(recording.get("id")), "a recording uploads")

        if OCR:
            check(health.get("ocr_available") is True, f"text recognition is available ({health.get('ocr_message')})")
        run = call_json("POST", f"/recordings/{recording['id']}/runs", {"stable": {"enable_ocr": True}} if OCR else {})
        check(websocket_upgrades(f"/runs/{run['id']}/events"), "the live progress socket connects")
        deadline = time.monotonic() + (900 if OCR else 180)  # the first OCR run downloads its models
        while True:
            detail = call_json("GET", f"/runs/{run['id']}")
            if detail["summary"]["status"] in {"completed", "failed", "cancelled"} or time.monotonic() > deadline:
                break
            time.sleep(0.5)
        summary = detail["summary"]
        check(summary["status"] == "completed", f"the analysis completes ({summary['status']}: {summary.get('message')})")
        candidates = detail["candidates"]
        check(len(candidates) >= 2, f"it finds both screens ({len(candidates)} steps)")

        status, headers, image = call("GET", urlsplit(candidates[-1]["image_url"]).path)
        check(status == 200 and image[:8] == b"\x89PNG\r\n\x1a\n", "a screenshot is served")

        bundle = call_json("POST", f"/runs/{run['id']}/export", {"mode": "all"})
        status, _, archive = call("GET", f"/exports/{bundle['id']}/download")
        check(status == 200 and archive[:2] == b"PK", "the export downloads as a zip")
        if OCR:
            # Recognised text is not part of the API's step list; exports carry it in steps.csv.
            with zipfile.ZipFile(io.BytesIO(archive)) as bundle:
                name = next(entry for entry in bundle.namelist() if entry.endswith("steps.csv"))
                rows = list(csv.DictReader(io.TextIOWrapper(bundle.open(name), encoding="utf-8")))
            text = " ".join(row.get("ocr_text") or "" for row in rows).lower()
            check(all(word.lower() in text for word in OCR_WORDS), f"text recognition reads both screens ({text!r})")
    finally:
        call("DELETE", f"/projects/{project['id']}")
    print("all checks passed")


if __name__ == "__main__":
    main()
