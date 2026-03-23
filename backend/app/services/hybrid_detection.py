from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Protocol
from uuid import uuid4

import cv2
import numpy as np

from ..models import AnalysisPreset, RunSettings
from ..utils import timecode_from_ms, utc_now
from .detection import CancellationRequested, CancellationCallback, ProgressCallback
from .similarity import fingerprint_image, hash_to_hex, histogram_to_string, text_distance
from .video import extract_frame


SCAN_RANGE = (0.1, 0.46)
EXTRACT_RANGE = (0.48, 0.92)


@dataclass(frozen=True)
class HybridDetectorConfig:
    sample_fps: float
    min_dwell_ms: int
    settle_window_ms: int
    enable_ocr: bool
    ocr_backend: str | None
    max_frame_edge: int
    proposal_threshold: float
    settle_threshold: float
    ocr_trigger_threshold: float


@dataclass
class SampleFrame:
    timestamp_ms: int
    bgr: np.ndarray
    gray: np.ndarray
    edges: np.ndarray
    ocr_text: str | None = None


@dataclass(frozen=True)
class CandidateSignal:
    timestamp_ms: int
    visual: float
    text: float
    motion: float
    combined: float
    changed_regions: list[dict[str, float]]
    ocr_text: str | None = None


@dataclass
class EventWindow:
    active_samples: list[CandidateSignal] = field(default_factory=list)
    settle_samples: list[CandidateSignal] = field(default_factory=list)

    @property
    def started_at_ms(self) -> int:
        return self.active_samples[0].timestamp_ms

    @property
    def last_active_ms(self) -> int:
        return self.active_samples[-1].timestamp_ms


class OcrEngine(Protocol):
    def extract_text(self, image: np.ndarray) -> str | None:
        ...


PRESET_DEFAULTS: dict[AnalysisPreset, dict[str, float | int]] = {
    "subtle_ui": {
        "sample_fps": 8,
        "min_dwell_ms": 250,
        "settle_window_ms": 250,
        "proposal_threshold": 0.19,
        "settle_threshold": 0.09,
        "ocr_trigger_threshold": 0.13,
    },
    "balanced": {
        "sample_fps": 6,
        "min_dwell_ms": 400,
        "settle_window_ms": 400,
        "proposal_threshold": 0.24,
        "settle_threshold": 0.12,
        "ocr_trigger_threshold": 0.17,
    },
    "noise_resistant": {
        "sample_fps": 4,
        "min_dwell_ms": 700,
        "settle_window_ms": 700,
        "proposal_threshold": 0.31,
        "settle_threshold": 0.16,
        "ocr_trigger_threshold": 0.22,
    },
}


class PaddleOcrEngine:
    def __init__(self) -> None:
        from paddleocr import PaddleOCR  # type: ignore[import-not-found]

        self._ocr = PaddleOCR(use_angle_cls=False, lang="en", show_log=False)

    def extract_text(self, image: np.ndarray) -> str | None:
        rgb = cv2.cvtColor(image, cv2.COLOR_BGR2RGB)
        results = self._ocr.ocr(rgb, cls=False)
        if not results:
            return None
        tokens: list[str] = []
        for line in results[0]:
            if not line or len(line) < 2:
                continue
            text_part = line[1][0] if line[1] else ""
            cleaned = " ".join(part for part in str(text_part).split() if part)
            if cleaned:
                tokens.append(cleaned)
        return " ".join(tokens) or None


def resolve_hybrid_config(settings: RunSettings, fps: float) -> HybridDetectorConfig:
    preset_defaults = PRESET_DEFAULTS[settings.analysis_preset]
    advanced = settings.advanced
    sample_fps = float(advanced.sample_fps_override) if advanced and advanced.sample_fps_override else float(preset_defaults["sample_fps"])
    sample_fps = max(1.0, min(max(fps, 1.0), sample_fps))
    min_dwell_ms = int(advanced.min_dwell_ms) if advanced and advanced.min_dwell_ms is not None else int(preset_defaults["min_dwell_ms"])
    settle_window_ms = (
        int(advanced.settle_window_ms)
        if advanced and advanced.settle_window_ms is not None
        else int(preset_defaults["settle_window_ms"])
    )
    enable_ocr = bool(advanced.enable_ocr) if advanced is not None else True
    ocr_backend = advanced.ocr_backend if advanced is not None else "paddleocr"
    return HybridDetectorConfig(
        sample_fps=sample_fps,
        min_dwell_ms=min_dwell_ms,
        settle_window_ms=settle_window_ms,
        enable_ocr=enable_ocr,
        ocr_backend=ocr_backend,
        max_frame_edge=960,
        proposal_threshold=float(preset_defaults["proposal_threshold"]),
        settle_threshold=float(preset_defaults["settle_threshold"]),
        ocr_trigger_threshold=float(preset_defaults["ocr_trigger_threshold"]),
    )


def _clamp_score(value: float) -> float:
    return float(max(0.0, min(1.0, value)))


def _sample_timestamps(duration_ms: int, sample_fps: float) -> list[int]:
    frame_interval_ms = max(1, round(1000 / max(1.0, sample_fps)))
    timestamps = list(range(0, max(duration_ms, 1), frame_interval_ms))
    if not timestamps:
        return [0]
    last_timestamp = max(0, duration_ms - 1)
    if timestamps[-1] != last_timestamp:
        timestamps.append(last_timestamp)
    return timestamps


def _read_frame(capture: cv2.VideoCapture, timestamp_ms: int) -> np.ndarray | None:
    capture.set(cv2.CAP_PROP_POS_MSEC, float(timestamp_ms))
    success, frame = capture.read()
    if not success:
        return None
    return frame


def _resize_for_analysis(frame: np.ndarray, max_frame_edge: int) -> np.ndarray:
    height, width = frame.shape[:2]
    longest_edge = max(height, width)
    if longest_edge <= max_frame_edge:
        return frame
    scale = max_frame_edge / longest_edge
    return cv2.resize(frame, (max(1, round(width * scale)), max(1, round(height * scale))), interpolation=cv2.INTER_AREA)


def _prepare_frame(frame: np.ndarray, timestamp_ms: int, max_frame_edge: int) -> SampleFrame:
    working_frame = _resize_for_analysis(frame, max_frame_edge)
    gray = cv2.cvtColor(working_frame, cv2.COLOR_BGR2GRAY)
    edges = cv2.Canny(gray, 80, 180)
    return SampleFrame(timestamp_ms=timestamp_ms, bgr=working_frame, gray=gray, edges=edges)


def _structural_loss(previous_gray: np.ndarray, current_gray: np.ndarray) -> float:
    left = previous_gray.astype(np.float32) / 255.0
    right = current_gray.astype(np.float32) / 255.0
    mean_left = float(np.mean(left))
    mean_right = float(np.mean(right))
    var_left = float(np.var(left))
    var_right = float(np.var(right))
    covariance = float(np.mean((left - mean_left) * (right - mean_right)))
    c1 = 0.01**2
    c2 = 0.03**2
    numerator = (2 * mean_left * mean_right + c1) * (2 * covariance + c2)
    denominator = (mean_left**2 + mean_right**2 + c1) * (var_left + var_right + c2)
    if denominator <= 0:
        return 0.0
    ssim = numerator / denominator
    return _clamp_score(1.0 - ssim)


def _tile_change_ratio(previous_gray: np.ndarray, current_gray: np.ndarray, tile_size: int = 4) -> float:
    diff = cv2.absdiff(previous_gray, current_gray).astype(np.float32) / 255.0
    height, width = diff.shape
    changed_tiles = 0
    total_tiles = tile_size * tile_size
    for row in range(tile_size):
        for col in range(tile_size):
            top = round((row / tile_size) * height)
            bottom = round(((row + 1) / tile_size) * height)
            left = round((col / tile_size) * width)
            right = round(((col + 1) / tile_size) * width)
            tile = diff[top:bottom, left:right]
            if tile.size and float(np.mean(tile)) >= 0.08:
                changed_tiles += 1
    return changed_tiles / max(1, total_tiles)


def _changed_regions(previous_gray: np.ndarray, current_gray: np.ndarray) -> list[dict[str, float]]:
    diff = cv2.absdiff(previous_gray, current_gray)
    _, threshold = cv2.threshold(diff, 18, 255, cv2.THRESH_BINARY)
    threshold = cv2.dilate(threshold, np.ones((5, 5), dtype=np.uint8), iterations=2)
    contours, _hierarchy = cv2.findContours(threshold, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    frame_area = float(previous_gray.shape[0] * previous_gray.shape[1]) or 1.0
    regions: list[dict[str, float]] = []
    for contour in contours:
        x, y, width, height = cv2.boundingRect(contour)
        area_ratio = (width * height) / frame_area
        if area_ratio < 0.002:
            continue
        region_diff = diff[y : y + height, x : x + width]
        score = _clamp_score(float(np.mean(region_diff)) / 72.0)
        regions.append(
            {
                "x": int(x),
                "y": int(y),
                "width": int(width),
                "height": int(height),
                "score": round(score, 4),
            }
        )
    regions.sort(key=lambda region: (-region["score"], region["y"], region["x"]))
    return regions[:6]


def _transition_signal(previous: SampleFrame, current: SampleFrame) -> tuple[float, float, list[dict[str, float]]]:
    ssim_loss = _structural_loss(previous.gray, current.gray)
    tile_ratio = _tile_change_ratio(previous.gray, current.gray)
    edge_ratio = float(np.count_nonzero(cv2.absdiff(previous.edges, current.edges))) / max(1, previous.edges.size)
    changed_regions = _changed_regions(previous.gray, current.gray)
    region_strength = max((region["score"] for region in changed_regions), default=0.0)
    visual = _clamp_score((ssim_loss * 0.45) + (tile_ratio * 0.25) + (region_strength * 0.20) + (edge_ratio * 0.10))
    motion = _clamp_score((edge_ratio * 0.55) + (tile_ratio * 0.25) + (region_strength * 0.20))
    return visual, motion, changed_regions


def _maybe_load_ocr_engine(config: HybridDetectorConfig) -> tuple[OcrEngine | None, str | None]:
    if not config.enable_ocr or config.ocr_backend != "paddleocr":
        return None, None
    try:
        return PaddleOcrEngine(), None
    except Exception as exc:  # pragma: no cover - depends on local install/runtime assets
        return None, str(exc)


def _extract_ocr_text(sample: SampleFrame, engine: OcrEngine | None) -> str | None:
    if engine is None:
        return None
    if sample.ocr_text is not None:
        return sample.ocr_text
    sample.ocr_text = engine.extract_text(sample.bgr)
    return sample.ocr_text


def _build_signal(
    previous: SampleFrame,
    current: SampleFrame,
    config: HybridDetectorConfig,
    engine: OcrEngine | None,
) -> CandidateSignal:
    visual, motion, changed_regions = _transition_signal(previous, current)
    text_score = 0.0
    current_text = None
    if max(visual, motion) >= config.ocr_trigger_threshold:
        current_text = _extract_ocr_text(current, engine)
        previous_text = _extract_ocr_text(previous, engine)
        if current_text or previous_text:
            text_score = _clamp_score(text_distance(current_text, previous_text))
    combined = _clamp_score((visual * 0.60) + (motion * 0.25) + (text_score * 0.15))
    return CandidateSignal(
        timestamp_ms=current.timestamp_ms,
        visual=round(visual, 4),
        text=round(text_score, 4),
        motion=round(motion, 4),
        combined=round(combined, 4),
        changed_regions=changed_regions,
        ocr_text=current_text,
    )


def _should_keep_event(event: EventWindow, config: HybridDetectorConfig) -> bool:
    active_duration_ms = max(1, event.last_active_ms - event.started_at_ms)
    peak_score = max(sample.combined for sample in event.active_samples)
    peak_text = max(sample.text for sample in event.active_samples)
    return active_duration_ms >= config.min_dwell_ms or peak_score >= (config.proposal_threshold * 1.25) or peak_text >= 0.3


def _finalize_event(event: EventWindow, config: HybridDetectorConfig) -> dict[str, Any] | None:
    if not event.active_samples or not _should_keep_event(event, config):
        return None
    representative = min(
        event.settle_samples or [event.active_samples[-1]],
        key=lambda sample: (sample.motion, sample.combined, sample.timestamp_ms),
    )
    strongest = max(event.active_samples, key=lambda sample: (sample.combined, sample.text, sample.visual))
    return {
        "timestamp_ms": representative.timestamp_ms,
        "scene_score": round(strongest.combined, 4),
        "score_breakdown": {
            "visual": strongest.visual,
            "text": strongest.text,
            "motion": strongest.motion,
            "changed_regions": strongest.changed_regions,
        },
        "ocr_text": strongest.ocr_text,
    }


def detect_candidates_hybrid(
    *,
    video_path: Path,
    frames_dir: Path,
    duration_ms: int,
    fps: float,
    settings: RunSettings,
    progress_callback: ProgressCallback | None = None,
    cancellation_callback: CancellationCallback | None = None,
) -> list[dict[str, Any]]:
    progress_callback = progress_callback or (lambda phase, message, progress, level: None)
    cancellation_callback = cancellation_callback or (lambda: False)
    config = resolve_hybrid_config(settings, fps)
    progress_callback("primary_scan", "Scanning video for interface changes", SCAN_RANGE[0], "info")

    capture = cv2.VideoCapture(str(video_path))
    if not capture.isOpened():
        raise RuntimeError("Could not open the recording for hybrid analysis.")

    ocr_engine, ocr_warning = _maybe_load_ocr_engine(config)
    if ocr_warning:
        progress_callback("primary_scan", "PaddleOCR is unavailable locally. Continuing without OCR.", SCAN_RANGE[0], "warning")

    timestamps = _sample_timestamps(duration_ms, config.sample_fps)
    previous_sample: SampleFrame | None = None
    active_event: EventWindow | None = None
    detected_events: list[dict[str, Any]] = []

    try:
        for index, timestamp_ms in enumerate(timestamps, start=1):
            if cancellation_callback():
                raise CancellationRequested("Run cancelled while scanning the video.")
            frame = _read_frame(capture, timestamp_ms)
            if frame is None:
                continue
            current_sample = _prepare_frame(frame, timestamp_ms, config.max_frame_edge)
            if previous_sample is not None:
                signal = _build_signal(previous_sample, current_sample, config, ocr_engine)
                if active_event is None:
                    if signal.combined >= config.proposal_threshold or signal.text >= 0.3:
                        active_event = EventWindow(active_samples=[signal])
                else:
                    if signal.combined >= config.settle_threshold or signal.text >= 0.22:
                        active_event.active_samples.append(signal)
                        active_event.settle_samples.clear()
                    else:
                        active_event.settle_samples.append(signal)
                        if signal.timestamp_ms - active_event.last_active_ms >= config.settle_window_ms:
                            finalized = _finalize_event(active_event, config)
                            if finalized is not None:
                                detected_events.append(finalized)
                            active_event = None
            previous_sample = current_sample
            ratio = index / max(1, len(timestamps))
            progress = SCAN_RANGE[0] + ((SCAN_RANGE[1] - SCAN_RANGE[0]) * ratio)
            progress_callback(
                "primary_scan",
                f"Scanning video for interface changes ({round(ratio * 100)}%)",
                min(progress, SCAN_RANGE[1]),
                "info",
            )
    finally:
        capture.release()

    if active_event is not None:
        finalized = _finalize_event(active_event, config)
        if finalized is not None:
            detected_events.append(finalized)

    if not detected_events:
        detected_events.append(
            {
                "timestamp_ms": 0,
                "scene_score": 1.0,
                "score_breakdown": {"visual": 1.0, "text": 0.0, "motion": 0.0, "changed_regions": []},
                "ocr_text": None,
            }
        )

    progress_callback("primary_extract", f"Extracting {len(detected_events)} candidate screenshots", EXTRACT_RANGE[0], "info")
    candidates: list[dict[str, Any]] = []
    total = max(1, len(detected_events))
    for index, event in enumerate(detected_events, start=1):
        if cancellation_callback():
            raise CancellationRequested("Run cancelled while extracting screenshots.")

        timestamp_ms = min(max(0, int(event["timestamp_ms"])), max(0, duration_ms - 1))
        image_path = frames_dir / f"candidate-{index:03d}__{timecode_from_ms(timestamp_ms, slug_style=True)}.png"
        extract_frame(video_path, image_path, timestamp_ms)
        fingerprint = fingerprint_image(image_path)
        extracted_ocr_text = event.get("ocr_text")
        if ocr_engine is not None and extracted_ocr_text is None:
            screenshot = cv2.imread(str(image_path))
            if screenshot is not None:
                extracted_ocr_text = ocr_engine.extract_text(screenshot)
        candidates.append(
            {
                "id": uuid4().hex,
                "detector_index": index,
                "candidate_origin": "detected",
                "timestamp_ms": timestamp_ms,
                "timestamp_tc": timecode_from_ms(timestamp_ms),
                "image_path": image_path.as_posix(),
                "scene_score": float(event["scene_score"]),
                "status": "pending",
                "title": None,
                "notes": None,
                "image_hash": hash_to_hex(fingerprint.average_hash),
                "perceptual_hash": hash_to_hex(fingerprint.perceptual_hash),
                "histogram_signature": histogram_to_string(fingerprint.histogram),
                "ocr_text": extracted_ocr_text,
                "score_breakdown": event.get("score_breakdown"),
                "revisit_group_id": None,
                "similar_to_candidate_id": None,
                "similarity_distance": None,
                "created_at": utc_now(),
                "updated_at": utc_now(),
            }
        )
        progress = EXTRACT_RANGE[0] + ((index / total) * (EXTRACT_RANGE[1] - EXTRACT_RANGE[0]))
        progress_callback(
            "primary_extract",
            f"Processed screenshot {index} of {total}",
            min(progress, EXTRACT_RANGE[1]),
            "info",
        )

    from .similarity import annotate_candidate_similarity

    return annotate_candidate_similarity(candidates)
