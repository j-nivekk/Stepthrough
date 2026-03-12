from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from threading import Event, Thread
from typing import Callable, Literal
from uuid import uuid4

from scenedetect import SceneManager, open_video
from scenedetect.detectors import AdaptiveDetector, ContentDetector

from ..models import RunSettings
from ..utils import clamp, timecode_from_ms, utc_now
from .similarity import annotate_candidate_similarity, fingerprint_image, hash_to_hex, histogram_to_string
from .video import extract_frame


class CancellationRequested(RuntimeError):
    pass


@dataclass(frozen=True)
class DetectorConfiguration:
    content_threshold: float
    adaptive_threshold: float
    min_scene_len_frames: int
    frame_skip: int


ProgressCallback = Callable[[str, str, float, str], None]
CancellationCallback = Callable[[], bool]
DetectionStage = Literal["primary", "fallback"]


PRIMARY_SCAN_RANGE = (0.1, 0.46)
PRIMARY_EXTRACT_RANGE = (0.48, 0.66)
FALLBACK_SCAN_RANGE = (0.72, 0.9)
FALLBACK_EXTRACT_RANGE = (0.91, 0.97)


def map_run_settings(settings: RunSettings, fps: float) -> DetectorConfiguration:
    normalized = settings.tolerance / 100.0
    content_threshold = 18.0 + (normalized * 24.0)
    adaptive_threshold = 2.0 + (normalized * 4.0)
    min_scene_len_frames = max(1, round((settings.min_scene_gap_ms / 1000) * max(fps, 1.0)))
    frame_skip = 0
    if settings.sample_fps:
        frame_skip = max(0, round(max(fps, settings.sample_fps) / settings.sample_fps) - 1)
    return DetectorConfiguration(
        content_threshold=round(content_threshold, 2),
        adaptive_threshold=round(adaptive_threshold, 2),
        min_scene_len_frames=min_scene_len_frames,
        frame_skip=frame_skip,
    )


def should_request_fallback(candidate_count: int) -> bool:
    return candidate_count <= 1


def build_sensitive_fallback_settings(settings: RunSettings) -> RunSettings:
    return RunSettings(
        detector_mode="adaptive",
        tolerance=20,
        min_scene_gap_ms=300,
        sample_fps=8,
        extract_offset_ms=settings.extract_offset_ms,
    )


def _pick_timestamp(start_ms: int, end_ms: int, duration_ms: int, extract_offset_ms: int) -> int:
    latest_safe = max(start_ms, min(end_ms - 80, duration_ms - 1))
    return clamp(start_ms + extract_offset_ms, start_ms, latest_safe)


def _stage_phase(stage: DetectionStage, activity: Literal["scan", "extract"]) -> str:
    return f"{stage}_{activity}"


def _stage_progress(stage: DetectionStage) -> tuple[tuple[float, float], tuple[float, float]]:
    if stage == "fallback":
        return FALLBACK_SCAN_RANGE, FALLBACK_EXTRACT_RANGE
    return PRIMARY_SCAN_RANGE, PRIMARY_EXTRACT_RANGE


def detect_candidates(
    *,
    video_path: Path,
    frames_dir: Path,
    duration_ms: int,
    fps: float,
    settings: RunSettings,
    stage: DetectionStage,
    progress_callback: ProgressCallback | None = None,
    cancellation_callback: CancellationCallback | None = None,
) -> list[dict]:
    progress_callback = progress_callback or (lambda phase, message, progress, level: None)
    cancellation_callback = cancellation_callback or (lambda: False)

    detector_config = map_run_settings(settings, fps)
    scan_range, extract_range = _stage_progress(stage)
    scan_phase = _stage_phase(stage, "scan")
    extract_phase = _stage_phase(stage, "extract")

    video = open_video(str(video_path))
    scene_manager = SceneManager()
    if settings.detector_mode == "adaptive":
        scene_manager.add_detector(
            AdaptiveDetector(
                adaptive_threshold=detector_config.adaptive_threshold,
                min_scene_len=detector_config.min_scene_len_frames,
            )
        )
    else:
        scene_manager.add_detector(
            ContentDetector(
                threshold=detector_config.content_threshold,
                min_scene_len=detector_config.min_scene_len_frames,
            )
        )

    if cancellation_callback():
        raise CancellationRequested("Run cancelled before detection started.")

    total_frames = max(1, video.duration.get_frames())
    last_bucket = -1
    stop_polling = Event()
    cancelled_during_scan = Event()
    progress_callback(scan_phase, "Scanning video for interaction changes", scan_range[0], "info")

    def publish_scan_progress(frame_num: int) -> None:
        nonlocal last_bucket
        ratio = min(1.0, max(0.0, frame_num / total_frames))
        bucket = min(20, int(ratio * 20))
        if bucket == last_bucket:
            return
        last_bucket = bucket
        progress = scan_range[0] + ((scan_range[1] - scan_range[0]) * ratio)
        progress_callback(
            scan_phase,
            f"Scanning video for interaction changes ({round(ratio * 100)}%)",
            min(progress, scan_range[1]),
            "info",
        )

    def poll_scan_progress() -> None:
        while not stop_polling.wait(0.2):
            if cancellation_callback():
                cancelled_during_scan.set()
                scene_manager.stop()
                return
            publish_scan_progress(video.position.get_frames())

    polling_thread = Thread(target=poll_scan_progress, name=f"stepthrough-scan-progress-{stage}", daemon=True)
    polling_thread.start()
    try:
        scene_manager.detect_scenes(video, frame_skip=detector_config.frame_skip, show_progress=False)
    finally:
        stop_polling.set()
        polling_thread.join(timeout=1.0)

    if cancelled_during_scan.is_set():
        raise CancellationRequested("Run cancelled while scanning the video.")
    publish_scan_progress(total_frames)
    scenes = scene_manager.get_scene_list(start_in_scene=True)
    if not scenes:
        scenes = [(video.base_timecode, video.duration)]

    progress_callback(extract_phase, f"Extracting {len(scenes)} candidate screenshots", extract_range[0], "info")
    candidates: list[dict] = []
    total = max(1, len(scenes))

    for index, (start_time, end_time) in enumerate(scenes, start=1):
        if cancellation_callback():
            raise CancellationRequested("Run cancelled while extracting screenshots.")

        start_ms = int(start_time.get_seconds() * 1000)
        end_ms = int(end_time.get_seconds() * 1000)
        timestamp_ms = _pick_timestamp(start_ms, end_ms, duration_ms, settings.extract_offset_ms)
        image_path = frames_dir / f"candidate-{index:03d}__{timecode_from_ms(timestamp_ms, slug_style=True)}.png"
        extract_frame(video_path, image_path, timestamp_ms)
        fingerprint = fingerprint_image(image_path)
        candidates.append(
            {
                "id": uuid4().hex,
                "detector_index": index,
                "timestamp_ms": timestamp_ms,
                "timestamp_tc": timecode_from_ms(timestamp_ms),
                "image_path": image_path.as_posix(),
                "scene_score": 0.0,
                "status": "pending",
                "title": None,
                "notes": None,
                "image_hash": hash_to_hex(fingerprint.ahash),
                "histogram_signature": histogram_to_string(fingerprint.histogram),
                "revisit_group_id": None,
                "similar_to_candidate_id": None,
                "similarity_distance": None,
                "created_at": utc_now(),
                "updated_at": utc_now(),
            }
        )
        progress = extract_range[0] + ((index / total) * (extract_range[1] - extract_range[0]))
        progress_callback(
            extract_phase,
            f"Processed screenshot {index} of {total}",
            min(progress, extract_range[1]),
            "info",
        )

    return annotate_candidate_similarity(candidates)
