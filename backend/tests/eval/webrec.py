"""Records the web tester (``web/``): mock apps with scripted people, of which is known what happens in them.

The app's clock is turned by hand, one frame of the recording at a time, so a frame's time is exact however long Chrome
takes to draw it, and the same recording can be made again. Frames are only taken when something changed, and written
with their own times, as phones and computers record (a frame at least once a second). Beside each video lies the app's
log (``log.json``): what it showed at every moment. ``webtruth.py`` turns that into the steps a recording should give.

Usage (from backend/, with Google Chrome or Chromium installed)::

    python -m tests.eval.webrec                        # every script, on every device
    python -m tests.eval.webrec --set dev              # only the scripts to develop with (held: only those kept apart)
    python -m tests.eval.webrec --only console_a --scale 1

To watch a script, or to use an app yourself: open ``web/index.html`` in a browser.
"""

from __future__ import annotations

import argparse
import base64
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from pathlib import Path
from typing import Any
from urllib.parse import urlencode

from websockets.sync.client import connect

WEB = Path(__file__).parent / "web"
OUT = Path(__file__).parent / "results" / "videos" / "web"
FPS = 30
LONGEST_S = 180

# css width, css height, device scale: a Retina laptop and an iPhone
DEVICES = {"computer": (1440, 900, 2), "phone": (390, 844, 3)}
COMPUTER = ("console", "workshop", "inbox", "docs", "parley", "larder")
PHONE = ("settings", "reel", "feed", "parley", "larder")
SETS = {"dev": ("a", 1), "held": ("b", 7)}  # script and seed: the second set is kept apart, to check on

CHROMES = (
    os.environ.get("CHROME", ""),
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "google-chrome", "chromium", "chromium-browser",
)


@dataclass(frozen=True)
class Job:
    scenario: str
    device: str
    seed: int
    group: str

    @property
    def name(self) -> str:
        return f"{self.scenario}__{self.device}"


def jobs(groups: tuple[str, ...] = ("dev", "held"), devices: tuple[str, ...] = ("computer", "phone")) -> list[Job]:
    found = []
    for group in groups:
        script, seed = SETS[group]
        for device in devices:
            for app in COMPUTER if device == "computer" else PHONE:
                found.append(Job(f"{app}_{script}", device, seed, group))
    return found


def find_chrome() -> str | None:
    for candidate in CHROMES:
        path = shutil.which(candidate) if candidate else None
        if path:
            return path
    return None


class Chrome:
    """One headless Chrome with one page, spoken to over the DevTools protocol."""

    def __init__(self) -> None:
        binary = find_chrome()
        if not binary:
            raise RuntimeError("Google Chrome or Chromium is needed (set CHROME to where it is).")
        self.profile = tempfile.mkdtemp(prefix="webrec-")
        self.process = subprocess.Popen(
            [binary, "--headless=new", "--remote-debugging-port=0", f"--user-data-dir={self.profile}", "--no-first-run",
             "--no-default-browser-check", "--hide-scrollbars", "--force-color-profile=srgb", "--mute-audio",
             "--disable-background-networking", "--disable-extensions", "--allow-file-access-from-files",
             # animations only go where the clock says, also for the one frame in which they begin
             "--disable-threaded-animation", "--disable-threaded-scrolling", "about:blank"],
            stderr=subprocess.PIPE, text=True,
        )
        assert self.process.stderr is not None
        address = None
        for line in self.process.stderr:
            found = re.search(r"ws://\S+", line)
            if found:
                address = found.group(0)
                break
        if not address:
            raise RuntimeError("Chrome did not start.")
        self.socket = connect(address, max_size=None)
        self.count = 0
        target = self.call("Target.createTarget", {"url": "about:blank"}, page=False)["targetId"]
        self.session = self.call("Target.attachToTarget", {"targetId": target, "flatten": True}, page=False)["sessionId"]
        self.call("Page.enable")
        self.call("Runtime.enable")
        self.call("Emulation.setFocusEmulationEnabled", {"enabled": True})

    session: str = ""

    def call(self, method: str, params: dict[str, Any] | None = None, *, page: bool = True) -> dict[str, Any]:
        self.count += 1
        message: dict[str, Any] = {"id": self.count, "method": method, "params": params or {}}
        if page:
            message["sessionId"] = self.session
        self.socket.send(json.dumps(message))
        while True:
            answer = json.loads(self.socket.recv())
            if answer.get("id") == self.count:
                if "error" in answer:
                    raise RuntimeError(f"{method}: {answer['error']}")
                return answer["result"]

    def run(self, expression: str) -> Any:
        answer = self.call("Runtime.evaluate", {"expression": expression, "awaitPromise": True, "returnByValue": True})
        if "exceptionDetails" in answer:
            detail = answer["exceptionDetails"]
            raise RuntimeError(detail.get("exception", {}).get("description") or detail.get("text"))
        return answer["result"].get("value")

    def open(self, url: str, size: tuple[int, int, int], mobile: bool) -> None:
        width, height, scale = size
        self.call("Emulation.setDeviceMetricsOverride", {"width": width, "height": height, "deviceScaleFactor": scale, "mobile": mobile})
        self.call("Page.navigate", {"url": url})
        for _ in range(200):
            try:
                if self.run("document.readyState === 'complete' && typeof Kit !== 'undefined' && location.href !== 'about:blank'"):
                    return
            except RuntimeError:
                pass
            time.sleep(0.05)
        raise RuntimeError("The tester did not load.")

    def picture(self) -> bytes:
        return base64.b64decode(self.call("Page.captureScreenshot", {"format": "png", "optimizeForSpeed": True, "fromSurface": True})["data"])

    def close(self) -> None:
        self.process.kill()
        self.process.wait()
        shutil.rmtree(self.profile, ignore_errors=True)


def encode(frames: list[tuple[int, Path]], end_ms: int, destination: Path, encoding: str = "h264") -> None:
    """The frames with their own times, as a recorder writes them."""
    lines = ["ffconcat version 1.0"]
    for position, (at, path) in enumerate(frames):
        following = frames[position + 1][0] if position + 1 < len(frames) else end_ms
        lines += [f"file '{path}'", "option framerate 1000", f"duration {max(1, following - at) / 1000:.6f}"]
    lines += [f"file '{frames[-1][1]}'", "option framerate 1000"]
    listing = destination.with_suffix(".ffconcat")
    listing.write_text("\n".join(lines) + "\n")
    codec = (
        ["-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p", "-bf", "0"]
        if encoding == "h264"
        else ["-c:v", "libx265", "-preset", "superfast", "-crf", "24", "-x265-params", "log-level=error:bframes=0", "-tag:v", "hvc1", "-pix_fmt", "yuv420p"]
    )
    subprocess.run(
        ["ffmpeg", "-v", "error", "-y", "-f", "concat", "-safe", "0", "-i", str(listing), "-fps_mode", "passthrough",
         "-vf", "scale=out_color_matrix=bt709:out_range=tv", "-colorspace", "bt709", "-color_primaries", "bt709", "-color_trc", "bt709",
         "-video_track_timescale", "90000", *codec, str(destination)],
        check=True,
    )
    listing.unlink()


def record(job: Job, out: Path, scale: float | None = None) -> dict[str, Any]:
    started = time.perf_counter()
    width, height, device_scale = DEVICES[job.device]
    size = (width, height, scale or device_scale)
    folder = out / job.group / job.name
    folder.mkdir(parents=True, exist_ok=True)
    query = urlencode({"scenario": job.scenario, "device": job.device, "seed": job.seed, "mode": "record"})
    chrome = Chrome()
    work = Path(tempfile.mkdtemp(prefix="webrec-frames-"))
    try:
        chrome.open(f"{(WEB / 'index.html').as_uri()}?{query}", size, job.device == "phone")
        chrome.run(f"Kit.begin({json.dumps(job.scenario)})")
        frames: list[tuple[int, Path]] = []
        log: list[dict[str, Any]] = []
        taken = -1000
        captures = 0
        step = 1000 / FPS
        index = 0
        while True:
            answer = json.loads(chrome.run(f"Kit.step({step if index else 0})"))
            if answer["error"]:
                raise RuntimeError(f"{job.name} at {index * step / 1000:.1f} s: {answer['error']}")
            at = round(index * step)
            snapshot = {**answer["snapshot"], "t": at}
            if answer["dirty"] or not frames:
                path = work / f"{index:06d}.png"
                path.write_bytes(chrome.picture())
                captures += 1
                frames.append((at, path))
                taken = at
            elif at - taken >= 1000:
                frames.append((at, frames[-1][1]))  # nothing changed: the same frame again
                taken = at
            entry: dict[str, Any] = {"snapshot": snapshot}
            if answer["events"]:
                entry["events"] = answer["events"]
            log.append(entry)
            index += 1
            if answer["done"]:
                break
            if index * step > LONGEST_S * 1000:
                raise RuntimeError(f"{job.name} goes on for more than {LONGEST_S} s")
        end = round(index * step)
        encode(frames, end, folder / "video.mp4")
        meta = {"scenario": job.scenario, "device": job.device, "seed": job.seed, "group": job.group, "fps": FPS,
                "css": [width, height], "scale": size[2], "duration_ms": end, "frames": len(frames), "captures": captures}
        (folder / "log.json").write_text(json.dumps({**meta, "log": compress(log)}, separators=(",", ":")))
        return {**meta, "seconds": round(time.perf_counter() - started, 1)}
    finally:
        chrome.close()
        shutil.rmtree(work, ignore_errors=True)


def compress(log: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Only the moments at which what is shown differs from the moment before (or something happened)."""
    kept: list[dict[str, Any]] = []
    previous: dict[str, Any] | None = None
    for entry in log:
        plain = {key: value for key, value in entry["snapshot"].items() if key != "t"}
        if entry.get("events") or plain != previous:
            kept.append(entry)
        previous = plain
    return kept


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--set", choices=("dev", "held", "all"), default="all")
    parser.add_argument("--device", choices=("computer", "phone", "all"), default="all")
    parser.add_argument("--only", help="scenarios to record, comma-separated (console_a,feed_b)")
    parser.add_argument("--scale", type=float, help="pixels per css pixel (the device's own by default)")
    parser.add_argument("--jobs", type=int, default=max(1, (os.cpu_count() or 4) // 2))
    parser.add_argument("--out", type=Path, default=OUT)
    args = parser.parse_args()
    wanted = jobs(("dev", "held") if args.set == "all" else (args.set,), ("computer", "phone") if args.device == "all" else (args.device,))
    if args.only:
        names = set(args.only.split(","))
        wanted = [job for job in wanted if job.scenario in names]
    failures = 0

    def one(job: Job) -> tuple[Job, dict[str, Any] | Exception]:
        try:
            return job, record(job, args.out, args.scale)
        except Exception as error:  # noqa: BLE001 - reported, and the others go on
            return job, error

    with ThreadPoolExecutor(max_workers=args.jobs) as pool:
        for job, result in pool.map(one, wanted):
            if isinstance(result, Exception):
                failures += 1
                print(f"{job.group:5} {job.name:24} FAILED: {result}", flush=True)
            else:
                print(f"{job.group:5} {job.name:24} {result['duration_ms'] / 1000:6.1f} s, {result['captures']:4} frames drawn, made in {result['seconds']} s", flush=True)
    sys.exit(1 if failures else 0)


if __name__ == "__main__":
    main()
