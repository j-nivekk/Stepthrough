"""The wider evaluation: generated scenarios at real device sizes and in real upload formats, plus test cards.

Everything here is generated, so it has exact ground truth and anyone can rerun it; no real recordings are
involved. Sections:

    devices  the interface scenarios at the sizes devices record at (iPhone, Android phone, tablet, Retina
             laptop, 1080p desktop, full-screen video), as phone-style uploads, with a moving pointer on the
             computers
    formats  the same scenarios on one phone size, in every upload format the app meets: H.264 and HEVC with
             variable frame rate, 60 and 120 fps sources, WebM, rotated, BT.709-tagged, full range, HDR PQ, HDR HLG
    cards    test cards (see ``cards.py``): countdowns, a colour-only change, a size sweep, colour accuracy of
             the working copy per format, and a recording longer than the analysis keeps in memory

Usage (from backend/)::

    python -m tests.eval.wide                       # everything (about ten minutes)
    python -m tests.eval.wide --section cards       # one section
    python -m tests.eval.wide --json results.json   # also write the numbers
    python -m tests.eval.wide --save-videos tests/eval/results/videos   # keep every generated video

With ``--save-videos`` each upload the app was given is copied into that folder, one subfolder per section, next
to a ``.json`` file listing the changes it should find (the ground truth) and what the engine found. The folder
also gets ``index.csv`` (one row per video) and a short ``README.txt``. The full run keeps about 130 videos.
"""

from __future__ import annotations

import argparse
import csv
import json
import re
import shutil
import sys
import tempfile
import time
from pathlib import Path

from app.models import StableSettings
from app.services.stable_detection import ENGINE_VERSION
from app.services.video import probe_video

from . import cards
from .scenarios import device_scenario
from .stress import (
    VariantResult,
    echo_result,
    load_reference,
    parse_variant,
    print_summary,
    run_variant,
    summarise,
    upload_suffix,
)
from .types import GroundTruthEvent, ScenarioResult

PHONE_SCENARIOS = ("nav_with_fade", "scroll_list", "overlay_bottom_sheet", "overlay_modal", "content_typing",
                   "composite_browse_session")
COMPUTER_SCENARIOS = ("nav_with_fade", "scroll_list", "overlay_modal", "content_typing", "composite_browse_session")

# profile, size, recording type, scenarios, upload variants
DEVICES = (
    ("iphone", "1180x2556", "phone", PHONE_SCENARIOS, ("h264_vfr", "hevc_vfr")),
    ("android_phone", "1080x2400", "phone", PHONE_SCENARIOS, ("h264_vfr",)),
    ("tablet_portrait", "1640x2360", "phone", PHONE_SCENARIOS, ("h264_vfr",)),
    ("laptop_landscape", "2560x1600", "desktop", COMPUTER_SCENARIOS, ("h264_vfr", "h264_vfr+pointer")),
    ("desktop_1080p", "1920x1080", "desktop", COMPUTER_SCENARIOS, ("h264_vfr", "h264_vfr+pointer")),
    ("fullscreen_vertical", "1080x1920", "phone", ("feed_fullscreen_swipe",), ("h264_vfr",)),
    ("fullscreen_horizontal", "1920x1080", "phone", ("feed_fullscreen_swipe",), ("h264_vfr",)),
)

FORMAT_PROFILE = ("phone_portrait", "780x1688")
FORMATS = ("h264_cfr", "h264_vfr", "hevc_vfr", "webm", "rotated", "h264_bt709", "h264_full_range", "hdr_pq", "hdr_hlg")
HIGH_FRAME_RATES = (60, 120)  # phone-style H.264 uploads recorded at these rates

CARD_PROFILES = (("phone_portrait", "390x844"), ("iphone", "1180x2556"), ("laptop_landscape", "1280x800"))
COLOUR_FORMATS = ("h264_cfr", "h264_bt709", "h264_full_range", "hevc_vfr", "webm", "rotated", "hdr_pq", "hdr_hlg")


# --- Keeping the generated videos ------------------------------------------------------------------

SHELF_README = """Generated test videos for Stepthrough, made by tests/eval/wide.py --save-videos.

Nothing here is a real recording: every screen was drawn by the test code.

devices/   interface scenarios at the sizes phones, tablets and computers record at
formats/   the same scenarios in every upload format (H.264, HEVC, WebM, rotated, HDR, 60 and 120 fps)
cards/     test cards: countdowns, a colour-only change, a size sweep, still colour cards, a long recording

Each video has a .json file with the same name:
  steps     the changes the app should find, with the time each starts and ends (in seconds); the opening
            screen is not counted, because the app always keeps it as the first step
  engine    what the engine found when the video was made: how many steps it found, missed and added, and
            the time of each step it made
index.csv lists every video with its numbers, for opening in a spreadsheet.

To try one in the app, upload it to a project and pick the recording type given under engine (the size
sweeps also have typing grouping turned off). The other settings are the defaults.
"""

FILE_NAME_UNSAFE = re.compile(r"[^A-Za-z0-9._-]+")
INDEX_COLUMNS = ("file", "section", "scenario", "device", "size", "frame_rate", "upload_format", "duration_s",
                 "steps", "found", "extra", "description")


class VideoShelf:
    """Copies each generated upload out of the temporary work folder, with its ground truth beside it."""

    def __init__(self, root: Path) -> None:
        self.root = root
        root.mkdir(parents=True, exist_ok=True)
        (root / "README.txt").write_text(SHELF_README)
        self.kept = 0

    def keep(self, section: str, name: str, variant: str, upload: Path | None, info: dict[str, object]) -> None:
        if upload is None or not upload.exists():
            return
        stem = FILE_NAME_UNSAFE.sub("_", f"{name.removesuffix('__sampledefault')}__{variant}").strip("_")
        folder = self.root / section
        folder.mkdir(parents=True, exist_ok=True)
        target = folder / f"{stem}{upload.suffix}"
        shutil.copy2(upload, target)
        info = {"file": target.name, "section": section, **info}
        target.with_suffix(".json").write_text(json.dumps(info, indent=2, default=str) + "\n")
        self.kept += 1

    def write_index(self) -> Path:
        """Index every video in the folder, including ones kept by earlier runs."""
        rows = []
        for path in sorted(self.root.glob("*/*.json")):
            info = json.loads(path.read_text())
            engine = info.get("engine") or {}
            rows.append({
                "file": f"{path.parent.name}/{info.get('file', '')}",
                **{column: info.get(column, "") for column in INDEX_COLUMNS[1:8]},
                "steps": len(info.get("steps") or []),
                "found": engine.get("found", ""),
                "extra": engine.get("extra", ""),
                "description": info.get("description", ""),
            })
        index = self.root / "index.csv"
        with index.open("w", newline="") as handle:
            writer = csv.DictWriter(handle, fieldnames=INDEX_COLUMNS)
            writer.writeheader()
            writer.writerows(rows)
        return index


def _steps(events: list[GroundTruthEvent]) -> list[dict[str, object]]:
    steps = []
    for event in events:
        step: dict[str, object] = {"type": event.event_type, "start_s": event.start_ms / 1000,
                                   "end_s": event.end_ms / 1000, "difficulty": event.difficulty}
        if event.metadata:
            step["details"] = event.metadata
        steps.append(step)
    return steps


def _engine(result: VariantResult, recording_type: str) -> dict[str, object]:
    m = result.metrics
    return {
        "version": ENGINE_VERSION,
        "recording_type": recording_type,
        "found": m.total_ground_truth - m.missed_events,
        "missed": m.missed_events,
        "extra": m.false_positives,
        "steps_at_s": [round(int(c["timestamp_ms"]) / 1000, 3) for c in result.candidates],
    }


def _clip_info(scenario: ScenarioResult, result: VariantResult, recording_type: str) -> dict[str, object]:
    return {
        "scenario": result.scenario.removesuffix("__sampledefault"),
        "description": scenario.description,
        "device": scenario.profile_id,
        "size": f"{scenario.encoded_width}x{scenario.encoded_height}",
        "frame_rate": scenario.source_fps,
        "upload_format": result.variant,
        "duration_s": scenario.duration_ms / 1000,
        "steps": _steps(scenario.ground_truth),
        "engine": _engine(result, recording_type),
    }


def _file_info(path: Path) -> dict[str, object]:
    """Size, frame rate and length of a video made without a scenario (the still colour card, the long recording)."""
    metadata = probe_video(path)
    return {"size": f"{metadata.width}x{metadata.height}", "frame_rate": round(metadata.fps, 3),
            "duration_s": metadata.duration_ms / 1000}


# --- Sections ----------------------------------------------------------------------------------------


def _run(name: str, factory, work: Path, variants: tuple[str, ...], recording_type: str,
         stable: StableSettings | None = None, label: str | None = None,
         shelf: VideoShelf | None = None) -> list[VariantResult]:
    """Run ``variants`` of one scenario; with a shelf, keep each upload in the subfolder named like ``work``."""
    scenario_dir = work / name
    scenario_dir.mkdir(parents=True, exist_ok=True)
    scenario = factory(scenario_dir)
    reference = load_reference(scenario.video_path)
    results = []
    for variant in variants:
        encoding, overlay = parse_variant(variant)
        result = run_variant(name, scenario_dir, reference, scenario.ground_truth, encoding, overlay,
                             stable=stable, recording_type=recording_type)
        if label:
            result.variant = label
        results.append(result)
        echo_result(name[:28], result)
        if shelf:
            used = stable.recording_type if stable else recording_type
            shelf.keep(work.name, name, result.variant, result.upload, _clip_info(scenario, result, used))
    return results


def run_devices(work: Path, shelf: VideoShelf | None = None) -> dict[str, dict]:
    results: list[tuple[str, VariantResult]] = []
    for profile, size, recording_type, names, variants in DEVICES:
        for base in names:
            name, factory = device_scenario(base, profile, size)
            for result in _run(name, factory, work / "devices", variants, recording_type, shelf=shelf):
                results.append((f"{profile} {size}", result))
    rows: dict[str, dict] = {}
    for device, result in results:
        rows.setdefault(f"{device} {result.variant}", []).append(result)
    summary = {key: summarise(group, key=lambda _: key)[key] for key, group in rows.items()}
    print_summary(summary, "stable_v3, working copy", title="device / upload")
    return summary


def run_formats(work: Path, shelf: VideoShelf | None = None) -> dict[str, dict]:
    profile, size = FORMAT_PROFILE
    results: list[VariantResult] = []
    for base in PHONE_SCENARIOS:
        name, factory = device_scenario(base, profile, size)
        results += _run(name, factory, work / "formats", FORMATS, "phone", shelf=shelf)
        for rate in HIGH_FRAME_RATES:
            name, factory = device_scenario(base, profile, size, source_fps=rate)
            results += _run(name, factory, work / "formats", ("h264_vfr",), "phone", label=f"h264_vfr {rate} fps",
                            shelf=shelf)
    summary = summarise(results)
    print_summary(summary, f"stable_v3, {profile} {size}", title="upload format")
    return summary


def run_cards(work: Path, shelf: VideoShelf | None = None) -> dict[str, object]:
    report: dict[str, object] = {}

    countdowns = {}
    for profile, size in CARD_PROFILES:
        recording_type = "desktop" if profile.startswith("laptop") else "phone"
        for card in ("countdown", "countdown_sweep"):
            name, factory = device_scenario(cards.CARD_BUILDERS[card], profile, size, base_name=card)
            result = _run(name, factory, work / "cards", ("h264_vfr",), recording_type, shelf=shelf)[0]
            m = result.metrics
            countdowns[f"{card} {profile} {size}"] = {
                "changes": m.total_ground_truth, "found": m.total_ground_truth - m.missed_events,
                "extra": m.false_positives, "right_screenshot": result.screenshots_correct,
                "opening": result.opening_ok,
            }
    report["countdowns"] = countdowns

    luma = {}
    for profile, size in CARD_PROFILES[:1] + CARD_PROFILES[2:]:
        recording_type = "desktop" if profile.startswith("laptop") else "phone"
        name, factory = device_scenario(cards.equal_luma, profile, size, base_name="equal_luma")
        result = _run(name, factory, work / "cards", ("h264_bt709",), recording_type, shelf=shelf)[0]
        found = [event.matched_candidate_index is not None for event in result.metrics.per_event_results]
        luma[f"{profile} {size}"] = {"same_brightness_found": found[0], "darker_found": found[1]}
    report["equal_luma"] = luma

    sweeps = {}
    for profile, size in CARD_PROFILES:
        name, factory = device_scenario(cards.size_sweep, profile, size, base_name="size_sweep")
        scenario_dir = work / "cards" / name
        scenario_dir.mkdir(parents=True, exist_ok=True)
        scenario = factory(scenario_dir)
        context_shell = scenario.shell
        settings = StableSettings(recording_type="desktop" if context_shell == "desktop_browser" else "phone",
                                  group_typing=False)
        result = run_variant(name, scenario_dir, load_reference(scenario.video_path), scenario.ground_truth,
                             "h264_vfr", None, stable=settings)
        echo_result(name[:28], result)
        if shelf:
            info = _clip_info(scenario, result, settings.recording_type)
            info["engine"]["group_typing"] = False  # each patch is its own step, not one typing step
            shelf.keep("cards", name, result.variant, result.upload, info)
        found = cards.found_per_event(result.candidates, scenario.ground_truth)
        percents = [event.metadata["share_percent"] for event in scenario.ground_truth]
        sweeps[f"{profile} {size} ({settings.recording_type})"] = {
            "found": {f"{p:.2f}%": f for p, f in zip(percents, found)},
            "extra": result.metrics.false_positives,
        }
    report["size_sweep"] = sweeps

    colour = {}
    for encoding in COLOUR_FORMATS:
        colour_dir = work / "cards" / f"colour_{encoding}"
        colour[encoding] = cards.colour_accuracy(colour_dir, encoding)
        if shelf:
            upload = colour_dir / f"upload{upload_suffix(encoding)}"
            shelf.keep("cards", "colour_card", encoding, upload, {
                "scenario": "colour_card",
                "description": "Still test card (colour bars and patches) with no changes, to check that colours "
                               "survive the working copy",
                "upload_format": encoding, **_file_info(upload), "steps": [],
                "colour_error": {key: colour[encoding][key] for key in ("mean_error", "max_error", "worst_patch")},
            })
        print(f"  colour {encoding:16s} mean {colour[encoding]['mean_error']:.1f}  max {colour[encoding]['max_error']:.1f} "
              f"({colour[encoding]['worst_patch']})", flush=True)
    report["colour_accuracy"] = colour

    started = time.perf_counter()
    report["long_recording"] = cards.long_recording(work / "cards" / "long")
    report["long_recording"]["seconds"] = round(time.perf_counter() - started, 1)
    if shelf:
        upload = work / "cards" / "long" / "upload.mp4"
        long = report["long_recording"]
        shelf.keep("cards", "long_recording", "h264", upload, {
            "scenario": "long_recording",
            "description": f"{len(cards.LONG_COLOURS)} plain colour screens of {cards.LONG_SEGMENT_S} s each, longer "
                           "than the analysis keeps in memory at once",
            "upload_format": "h264", **_file_info(upload),
            "steps": [{"type": "navigation", "start_s": cards.LONG_SEGMENT_S * k, "end_s": cards.LONG_SEGMENT_S * k,
                       "difficulty": "easy"} for k in range(1, len(cards.LONG_COLOURS))],
            "engine": {"version": ENGINE_VERSION, "recording_type": "phone", "found": long["found"],
                       "missed": long["changes"] - long["found"], "extra": long["extra"]},
        })
    print(f"  long recording {report['long_recording']}", flush=True)

    print("\nCards")
    for key, row in countdowns.items():
        print(f"  {key:40s} found {row['found']}/{row['changes']}  extra {row['extra']}  "
              f"screenshots {row['right_screenshot']}  opening {row['opening']}")
    for key, row in luma.items():
        print(f"  equal_luma {key:29s} same brightness found: {row['same_brightness_found']}  darker found: {row['darker_found']}")
    for key, row in sweeps.items():
        marks = "  ".join(f"{p} {'yes' if f else 'no'}" for p, f in row["found"].items())
        print(f"  size_sweep {key:29s} {marks}  extra {row['extra']}")
    return report


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--section", choices=("devices", "formats", "cards"), action="append",
                        help="run only these sections (repeatable)")
    parser.add_argument("--json", default="", help="write all numbers to this file")
    parser.add_argument("--save-videos", metavar="DIR", default="",
                        help="keep every generated upload in DIR, each with its ground truth as JSON")
    args = parser.parse_args()
    sections = args.section or ["devices", "formats", "cards"]
    shelf = VideoShelf(Path(args.save_videos)) if args.save_videos else None
    report: dict[str, object] = {}
    started = time.perf_counter()
    with tempfile.TemporaryDirectory() as tmp:
        work = Path(tmp)
        if "devices" in sections:
            report["devices"] = run_devices(work, shelf)
        if "formats" in sections:
            report["formats"] = run_formats(work, shelf)
        if "cards" in sections:
            report["cards"] = run_cards(work, shelf)
    print(f"\ntotal {time.perf_counter() - started:.0f}s")
    if shelf:
        index = shelf.write_index()
        print(f"kept {shelf.kept} videos in {shelf.root} (index: {index})")
    if args.json:
        Path(args.json).write_text(json.dumps(report, indent=2))


if __name__ == "__main__":
    sys.exit(main())
