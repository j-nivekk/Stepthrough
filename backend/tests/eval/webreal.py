"""A recording of the web tester that something else made (a phone, a Mac, the iPhone simulator), with the log the tester
saved: finds the log's moments in the video by the flash at both ends, so that ``webscore.py`` can score it as well.

Usage (from backend/)::

    python -m http.server --directory tests/eval/web 8400     # then open it on the device, and record the screen
    python -m tests.eval.webreal recording.mov larder_a__phone__log.json
    python -m tests.eval.webscore --set real --steps
"""

from __future__ import annotations

import argparse
import json
import shutil
import subprocess
from pathlib import Path
from typing import Any

import numpy as np

from app.services.ingest import build_working_copy
from app.services.video import probe_video

from .webrec import OUT

LOOK_FPS = 30


def flashes(video: Path) -> list[float]:
    """When the screen turns from magenta to green (ms)."""
    size = 24
    command = ["ffmpeg", "-v", "error", "-i", str(video), "-an", "-vf", f"fps={LOOK_FPS},scale={size}:{size}:flags=area,format=rgb24",
               "-f", "rawvideo", "pipe:1"]
    frames = np.frombuffer(subprocess.run(command, check=True, capture_output=True).stdout, np.uint8).reshape(-1, size, size, 3).astype(int)
    red, green, blue = frames[..., 0], frames[..., 1], frames[..., 2]
    magenta = ((red > 150) & (green < 120) & (blue > 150)).mean(axis=(1, 2)) > 0.6
    lime = ((green > 150) & (red < 140) & (blue < 140)).mean(axis=(1, 2)) > 0.6
    return [1000 * k / LOOK_FPS for k in range(1, len(frames)) if lime[k] and magenta[max(0, k - 3) : k].any() and not lime[k - 1]]


def align(data: dict[str, Any], seen: list[float]) -> dict[str, Any]:
    """The log with its times as in the video, from the first flash to the last."""
    told = [event["t"] for entry in data["log"] for event in entry.get("events", []) if event["kind"] == "flash"]
    if len(told) < 2 or len(seen) < 2:
        raise ValueError(f"The flash at both ends is needed: {len(told)} in the log, {len(seen)} in the video.")
    rate = (seen[-1] - seen[0]) / (told[-1] - told[0])
    if not 0.97 < rate < 1.03:
        raise ValueError(f"The log and the video do not belong together: {told[-1] - told[0]:.0f} ms and {seen[-1] - seen[0]:.0f} ms between the flashes.")

    def at(t: float) -> int:
        return round(seen[0] + (t - told[0]) * rate)

    log = []
    for entry in data["log"]:
        snapshot = entry["snapshot"]
        if not told[0] <= snapshot["t"] <= told[-1] - 450:  # the second flash began half a second before it turned green
            continue
        moved = {"snapshot": {**snapshot, "t": at(snapshot["t"])}}
        if entry.get("events"):
            moved["events"] = [{**event, "t": at(event["t"])} for event in entry["events"]]
        log.append(moved)
    end = at(told[-1]) - 520
    return {**{key: value for key, value in data.items() if key != "log"}, "group": "real", "seed": data.get("seed", 0),
            "from_ms": at(told[0]) + 480, "duration_ms": end, "rate": round(rate, 5), "log": log}


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("video", type=Path)
    parser.add_argument("log", type=Path)
    parser.add_argument("--name", help="what to call it (the scenario and the device, by default)")
    parser.add_argument("--out", type=Path, default=OUT)
    args = parser.parse_args()
    data = json.loads(args.log.read_text())
    folder = args.out / "real" / (args.name or f"{data['scenario']}__{data['device']}")
    folder.mkdir(parents=True, exist_ok=True)
    video = folder / "video.mp4"
    shutil.copyfile(args.video, video)
    working = folder / "working.mp4"
    build_working_copy(video, working)
    aligned = align(data, flashes(working))
    (folder / "log.json").write_text(json.dumps(aligned, separators=(",", ":")))
    info = probe_video(working)
    print(f"{folder.name}: {info.width} x {info.height}, {aligned['from_ms'] / 1000:.2f} to {aligned['duration_ms'] / 1000:.2f} s, "
          f"the video runs {100 * (aligned['rate'] - 1):+.2f} % against the log")


if __name__ == "__main__":
    main()
