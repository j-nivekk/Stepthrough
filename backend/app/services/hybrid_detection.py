from __future__ import annotations

from collections import OrderedDict
from dataclasses import dataclass, field
from functools import lru_cache
from contextlib import contextmanager, redirect_stderr
import json
import logging
import os
from io import StringIO
from importlib.metadata import PackageNotFoundError, version
from pathlib import Path
from typing import Any, Protocol
from uuid import uuid4
import warnings

import cv2
import numpy as np

from ..config import OcrRuntimeConfig, build_ocr_runtime_config, validate_ocr_runtime_config
from ..models import AnalysisPreset, RunSettings
from ..utils import timecode_from_ms, utc_now
from .detection import CancellationRequested, CancellationCallback, ProgressCallback
from .similarity import (
    fingerprint_image,
    hamming_distance,
    hash_to_hex,
    histogram_to_string,
    perceptual_hash_array,
    text_distance,
)
from .video import extract_frame


SCAN_RANGE = (0.1, 0.46)
EXTRACT_RANGE = (0.48, 0.92)


@dataclass(frozen=True)
class HybridDetectorConfig:
    sample_fps: float
    source_fps: float
    min_dwell_ms: int
    min_scene_gap_ms: int
    settle_window_ms: int
    enable_ocr: bool
    ocr_backend: str | None
    max_frame_edge: int
    proposal_threshold: float
    settle_threshold: float
    ocr_trigger_threshold: float
    tile_grid_size: int
    contour_threshold_floor: int
    contour_threshold_ceiling: int


@dataclass
class SampleFrame:
    timestamp_ms: int
    bgr: np.ndarray
    gray: np.ndarray
    edges: np.ndarray
    ocr_text: str | None = None
    ocr_text_checked: bool = False


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


@dataclass
class _OcrUsageStats:
    model_invocations: int = 0
    cache_hits: int = 0


@dataclass
class _OcrCache:
    capacity: int = 64
    max_hamming_distance: int = 2
    entries: OrderedDict[int, str | None] = field(default_factory=OrderedDict)

    def get(self, image: np.ndarray) -> tuple[bool, str | None]:
        image_hash = perceptual_hash_array(image)
        for cached_hash, cached_text in list(self.entries.items()):
            if hamming_distance(image_hash, cached_hash) <= self.max_hamming_distance:
                self.entries.move_to_end(cached_hash)
                return True, cached_text
        return False, None

    def put(self, image: np.ndarray, text: str | None) -> str | None:
        image_hash = perceptual_hash_array(image)
        self.entries[image_hash] = text
        self.entries.move_to_end(image_hash)
        while len(self.entries) > self.capacity:
            self.entries.popitem(last=False)
        return text


@dataclass
class _SequentialReader:
    capture: cv2.VideoCapture
    source_fps: float
    total_frames: int | None = None
    seek_gap_frames: int = 5
    last_frame_index: int | None = None

    def __post_init__(self) -> None:
        if self.total_frames is None:
            raw_total_frames = int(self.capture.get(cv2.CAP_PROP_FRAME_COUNT))
            self.total_frames = raw_total_frames if raw_total_frames > 0 else None

    def _frame_index_for_timestamp(self, timestamp_ms: int) -> int:
        target_index = max(0, int(round((timestamp_ms / 1000.0) * self.source_fps)))
        if self.total_frames is not None:
            return min(target_index, max(0, self.total_frames - 1))
        return target_index

    def _seek_to_frame(self, frame_index: int) -> np.ndarray | None:
        self.capture.set(cv2.CAP_PROP_POS_FRAMES, float(frame_index))
        success, frame = self.capture.read()
        if not success:
            return None
        self.last_frame_index = frame_index
        return frame

    def next(self, timestamp_ms: int) -> np.ndarray | None:
        if self.source_fps <= 0:
            return _seek_frame(self.capture, timestamp_ms)

        target_frame_index = self._frame_index_for_timestamp(timestamp_ms)
        if self.last_frame_index is None:
            return self._seek_to_frame(target_frame_index)

        if target_frame_index <= self.last_frame_index:
            return self._seek_to_frame(target_frame_index)

        frame_gap = target_frame_index - self.last_frame_index
        if frame_gap > self.seek_gap_frames:
            return self._seek_to_frame(target_frame_index)

        for _ in range(max(0, frame_gap - 1)):
            if not self.capture.grab():
                return self._seek_to_frame(target_frame_index)

        success, frame = self.capture.read()
        if not success:
            return self._seek_to_frame(target_frame_index)

        self.last_frame_index = target_frame_index
        return frame


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


PADDLEOCR_SUPPORTED_VERSION = "3.3.0"
PADDLEPADDLE_SUPPORTED_VERSION = "3.3.0"


@dataclass(frozen=True)
class PaddleOcrProbeResult:
    available: bool
    message: str
    warnings: tuple[str, ...] = ()


class _ProbeLogCaptureHandler(logging.Handler):
    def __init__(self, messages: list[str]) -> None:
        super().__init__(level=logging.WARNING)
        self._messages = messages

    def emit(self, record: logging.LogRecord) -> None:
        message = _clean_ocr_token(record.getMessage())
        if message:
            self._messages.append(message)


def _installed_package_version(name: str) -> str | None:
    try:
        return version(name)
    except PackageNotFoundError:
        return None


def _import_paddleocr_symbols() -> tuple[type[Any], Any]:
    import paddle  # type: ignore[import-not-found]
    from paddleocr import PaddleOCR  # type: ignore[import-not-found]

    return PaddleOCR, paddle


def _load_paddleocr_symbols(runtime_config: OcrRuntimeConfig) -> tuple[type[Any], Any]:
    _apply_paddle_model_source(runtime_config)
    return _import_paddleocr_symbols()


def _validate_paddle_stack_versions() -> str | None:
    paddle_version = _installed_package_version("paddlepaddle")
    paddleocr_version = _installed_package_version("paddleocr")
    if paddle_version == PADDLEPADDLE_SUPPORTED_VERSION and paddleocr_version == PADDLEOCR_SUPPORTED_VERSION:
        return None
    found_paddle = paddle_version or "missing"
    found_ocr = paddleocr_version or "missing"
    return (
        "Unsupported Paddle OCR stack in the backend Python environment. "
        f"Install paddlepaddle=={PADDLEPADDLE_SUPPORTED_VERSION} and paddleocr=={PADDLEOCR_SUPPORTED_VERSION} "
        f"(found paddlepaddle=={found_paddle}, paddleocr=={found_ocr})."
    )


def _clean_ocr_token(value: Any) -> str | None:
    cleaned = " ".join(part for part in str(value).split() if part)
    return cleaned or None


def _append_ocr_tokens(tokens: list[str], values: Any) -> None:
    if values is None:
        return
    if isinstance(values, np.ndarray):
        _append_ocr_tokens(tokens, values.tolist())
        return
    if isinstance(values, (list, tuple, set)):
        for item in values:
            _append_ocr_tokens(tokens, item)
        return
    cleaned = _clean_ocr_token(values)
    if cleaned:
        tokens.append(cleaned)


def _normalize_predict_result(result: Any) -> str | None:
    tokens: list[str] = []

    def walk(node: Any) -> None:
        if node is None:
            return
        if isinstance(node, dict):
            if "rec_texts" in node:
                _append_ocr_tokens(tokens, node["rec_texts"])
            if "text" in node:
                _append_ocr_tokens(tokens, node["text"])
            for key in ("res", "result", "results", "data"):
                nested = node.get(key)
                if nested is not None:
                    walk(nested)
            return
        if isinstance(node, np.ndarray):
            if node.dtype.kind in {"U", "S", "O"}:
                _append_ocr_tokens(tokens, node.tolist())
            return
        if isinstance(node, (list, tuple, set)):
            for item in node:
                walk(item)
            return
        json_payload = getattr(node, "json", None)
        if json_payload is not None:
            try:
                payload = json_payload() if callable(json_payload) else json_payload
            except Exception:
                payload = None
            if isinstance(payload, str):
                try:
                    payload = json.loads(payload)
                except json.JSONDecodeError:
                    payload = None
            if payload is not None:
                walk(payload)
                return
        for attribute in ("res", "result", "results", "data"):
            nested = getattr(node, attribute, None)
            if nested is not None:
                walk(nested)
                return
        rec_texts = getattr(node, "rec_texts", None)
        if rec_texts is not None:
            _append_ocr_tokens(tokens, rec_texts)
        text = getattr(node, "text", None)
        if text is not None and not callable(text):
            _append_ocr_tokens(tokens, text)

    walk(result)
    normalized = " ".join(token for token in tokens if token)
    return normalized or None


def _apply_paddle_model_source(runtime_config: OcrRuntimeConfig) -> None:
    # Keep startup checks offline-friendly and let the real init decide whether
    # model downloads are needed. BOS is the only documented override; the
    # default source is HuggingFace.
    os.environ["PADDLE_PDX_DISABLE_MODEL_SOURCE_CHECK"] = "True"
    os.environ["PADDLE_PDX_CACHE_HOME"] = str(runtime_config.cache_dir)
    if runtime_config.model_source == "bos":
        os.environ["PADDLE_PDX_MODEL_SOURCE"] = "BOS"
    elif runtime_config.model_source in {"huggingface", "local"}:
        os.environ.pop("PADDLE_PDX_MODEL_SOURCE", None)


def _dedupe_probe_messages(*groups: list[str]) -> tuple[str, ...]:
    ordered: list[str] = []
    seen: set[str] = set()
    for group in groups:
        for message in group:
            cleaned = _clean_ocr_token(message)
            if not cleaned or cleaned in seen:
                continue
            seen.add(cleaned)
            ordered.append(cleaned)
    return tuple(ordered)


@contextmanager
def _capture_probe_output() -> tuple[list[str], list[warnings.WarningMessage]]:
    logged_messages: list[str] = []
    paddlex_logger = logging.getLogger("paddlex")
    original_handlers = list(paddlex_logger.handlers)
    original_level = paddlex_logger.level
    original_propagate = paddlex_logger.propagate
    capture_handler = _ProbeLogCaptureHandler(logged_messages)
    paddlex_logger.handlers = [capture_handler]
    paddlex_logger.setLevel(logging.WARNING)
    paddlex_logger.propagate = False

    with warnings.catch_warnings(record=True) as caught_warnings, redirect_stderr(StringIO()):
        warnings.simplefilter("always")
        try:
            yield logged_messages, caught_warnings
        finally:
            paddlex_logger.handlers = original_handlers
            paddlex_logger.setLevel(original_level)
            paddlex_logger.propagate = original_propagate


class PaddleOcrEngine:
    def __init__(self, runtime_config: OcrRuntimeConfig) -> None:
        PaddleOCR, _paddle = _load_paddleocr_symbols(runtime_config)
        init_kwargs: dict[str, Any] = {
            "lang": "en",
            "use_doc_orientation_classify": False,
            "use_doc_unwarping": False,
            "use_textline_orientation": False,
        }
        if runtime_config.model_source == "local" or (
            runtime_config.det_model_dir is not None and runtime_config.rec_model_dir is not None
        ):
            init_kwargs["text_detection_model_dir"] = str(runtime_config.resolved_det_model_dir)
            init_kwargs["text_recognition_model_dir"] = str(runtime_config.resolved_rec_model_dir)
        self._ocr = PaddleOCR(**init_kwargs)

    def extract_text(self, image: np.ndarray) -> str | None:
        rgb = cv2.cvtColor(image, cv2.COLOR_BGR2RGB)
        return _normalize_predict_result(self._ocr.predict(rgb))


@lru_cache(maxsize=1)
def probe_paddleocr_availability() -> PaddleOcrProbeResult:
    runtime_config = build_ocr_runtime_config()
    config_valid, config_error = validate_ocr_runtime_config(runtime_config)
    if not config_valid:
        return PaddleOcrProbeResult(
            available=False,
            message=config_error or "PaddleOCR is not configured for this backend environment.",
        )

    with _capture_probe_output() as (logged_messages, caught_warnings):
        try:
            _load_paddleocr_symbols(runtime_config)
        except ModuleNotFoundError as exc:  # pragma: no cover - depends on local install/runtime assets
            warning_messages = _dedupe_probe_messages(
                logged_messages,
                [_clean_ocr_token(str(warning.message)) or "" for warning in caught_warnings],
            )
            missing_module = getattr(exc, "name", None) or "paddleocr"
            return PaddleOcrProbeResult(
                available=False,
                message=f"PaddleOCR 3.x is not installed in the backend Python environment: missing `{missing_module}`.",
                warnings=warning_messages,
            )
        except Exception as exc:  # pragma: no cover - depends on local install/runtime assets
            warning_messages = _dedupe_probe_messages(
                logged_messages,
                [_clean_ocr_token(str(warning.message)) or "" for warning in caught_warnings],
            )
            details = " ".join(str(exc).split()) or exc.__class__.__name__
            return PaddleOcrProbeResult(
                available=False,
                message=f"PaddleOCR 3.x could not be imported in the backend Python environment: {details}",
                warnings=warning_messages,
            )

    warning_messages = _dedupe_probe_messages(
        logged_messages,
        [_clean_ocr_token(str(warning.message)) or "" for warning in caught_warnings],
    )
    version_error = _validate_paddle_stack_versions()
    if version_error is not None:
        return PaddleOcrProbeResult(available=False, message=version_error, warnings=warning_messages)
    if runtime_config.model_source == "local":
        return PaddleOcrProbeResult(
            available=True,
            message="PaddleOCR 3.3.0 is configured for local model directories provided by the backend environment.",
            warnings=warning_messages,
        )
    return PaddleOcrProbeResult(
        available=True,
        message=(
            "PaddleOCR 3.3.0 is configured through the backend environment. "
            f"First use may initialize or download models into `{runtime_config.cache_dir}`."
        ),
        warnings=warning_messages,
    )


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
        source_fps=max(fps, 0.0),
        min_dwell_ms=min_dwell_ms,
        min_scene_gap_ms=settings.min_scene_gap_ms,
        settle_window_ms=settle_window_ms,
        enable_ocr=enable_ocr,
        ocr_backend=ocr_backend,
        max_frame_edge=960,
        proposal_threshold=float(preset_defaults["proposal_threshold"]),
        settle_threshold=float(preset_defaults["settle_threshold"]),
        ocr_trigger_threshold=float(preset_defaults["ocr_trigger_threshold"]),
        tile_grid_size=8,
        contour_threshold_floor=8,
        contour_threshold_ceiling=30,
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


def _seek_frame(capture: cv2.VideoCapture, timestamp_ms: int) -> np.ndarray | None:
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


def _tile_change_ratio(previous_gray: np.ndarray, current_gray: np.ndarray, tile_size: int = 8) -> float:
    diff = cv2.absdiff(previous_gray, current_gray).astype(np.float32) / 255.0
    change_threshold = max(0.04, float(np.std(diff)) * 2.5)
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
            if tile.size and float(np.mean(tile)) >= change_threshold:
                changed_tiles += 1
    return changed_tiles / max(1, total_tiles)


def _changed_regions(
    previous_gray: np.ndarray,
    current_gray: np.ndarray,
    *,
    threshold_floor: int = 8,
    threshold_ceiling: int = 30,
) -> list[dict[str, float]]:
    diff = cv2.absdiff(previous_gray, current_gray)
    adaptive_threshold, _ = cv2.threshold(diff, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
    clamped_threshold = int(np.clip(adaptive_threshold, threshold_floor, threshold_ceiling))
    _, threshold = cv2.threshold(diff, clamped_threshold, 255, cv2.THRESH_BINARY)
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


def _merge_changed_regions(*groups: list[dict[str, float]]) -> list[dict[str, float]]:
    merged: dict[tuple[int, int, int, int], dict[str, float]] = {}
    for group in groups:
        for region in group:
            key = (int(region["x"]), int(region["y"]), int(region["width"]), int(region["height"]))
            existing = merged.get(key)
            if existing is None or float(region["score"]) > float(existing["score"]):
                merged[key] = {
                    "x": key[0],
                    "y": key[1],
                    "width": key[2],
                    "height": key[3],
                    "score": round(float(region["score"]), 4),
                }
    regions = list(merged.values())
    regions.sort(key=lambda region: (-region["score"], region["y"], region["x"]))
    return regions[:6]


def _transition_signal(
    previous: SampleFrame,
    current: SampleFrame,
    *,
    tile_size: int = 8,
    contour_threshold_floor: int = 8,
    contour_threshold_ceiling: int = 30,
) -> tuple[float, float, list[dict[str, float]]]:
    ssim_loss = _structural_loss(previous.gray, current.gray)
    tile_ratio = _tile_change_ratio(previous.gray, current.gray, tile_size=tile_size)
    edge_ratio = float(np.count_nonzero(cv2.absdiff(previous.edges, current.edges))) / max(1, previous.edges.size)
    changed_regions = _changed_regions(
        previous.gray,
        current.gray,
        threshold_floor=contour_threshold_floor,
        threshold_ceiling=contour_threshold_ceiling,
    )
    region_strength = max((region["score"] for region in changed_regions), default=0.0)
    visual = _clamp_score((ssim_loss * 0.45) + (tile_ratio * 0.25) + (region_strength * 0.20) + (edge_ratio * 0.10))
    motion = _clamp_score((edge_ratio * 0.55) + (tile_ratio * 0.25) + (region_strength * 0.20))
    return visual, motion, changed_regions


def _maybe_load_ocr_engine(config: HybridDetectorConfig) -> tuple[OcrEngine | None, str | None]:
    if not config.enable_ocr or config.ocr_backend != "paddleocr":
        return None, None
    runtime_config = build_ocr_runtime_config()
    config_valid, config_error = validate_ocr_runtime_config(runtime_config)
    if not config_valid:
        return None, config_error
    try:
        _load_paddleocr_symbols(runtime_config)
    except ModuleNotFoundError as exc:  # pragma: no cover - depends on local install/runtime assets
        missing_module = getattr(exc, "name", None) or "paddleocr"
        return None, f"PaddleOCR 3.x is not installed in the backend Python environment: missing `{missing_module}`."
    except Exception as exc:  # pragma: no cover - depends on local install/runtime assets
        details = " ".join(str(exc).split()) or exc.__class__.__name__
        return None, f"PaddleOCR 3.x could not be imported in the backend Python environment: {details}"
    version_error = _validate_paddle_stack_versions()
    if version_error is not None:
        return None, version_error
    try:
        return PaddleOcrEngine(runtime_config), None
    except Exception as exc:  # pragma: no cover - depends on local install/runtime assets
        details = " ".join(str(exc).split()) or exc.__class__.__name__
        return None, details


def _crop_changed_regions(
    frame: np.ndarray,
    changed_regions: list[dict[str, float]],
    *,
    padding: int = 16,
    max_regions: int = 4,
) -> list[np.ndarray]:
    if not changed_regions:
        return []
    frame_height, frame_width = frame.shape[:2]
    selected_regions = sorted(changed_regions[:max_regions], key=lambda region: (region["y"], region["x"]))
    crops: list[np.ndarray] = []
    for region in selected_regions:
        left = max(0, int(region["x"]) - padding)
        top = max(0, int(region["y"]) - padding)
        right = min(frame_width, int(region["x"]) + int(region["width"]) + padding)
        bottom = min(frame_height, int(region["y"]) + int(region["height"]) + int(padding))
        crop = frame[top:bottom, left:right]
        if crop.shape[0] < 24 or crop.shape[1] < 24:
            continue
        crops.append(crop)
    return crops


def _extract_text_from_image(
    image: np.ndarray,
    engine: OcrEngine | None,
    ocr_cache: _OcrCache | None,
    ocr_usage_stats: _OcrUsageStats | None = None,
) -> str | None:
    if engine is None:
        return None
    if ocr_cache is not None:
        cached, cached_text = ocr_cache.get(image)
        if cached:
            if ocr_usage_stats is not None:
                ocr_usage_stats.cache_hits += 1
            return cached_text
    if ocr_usage_stats is not None:
        ocr_usage_stats.model_invocations += 1
    extracted_text = engine.extract_text(image)
    if ocr_cache is not None:
        return ocr_cache.put(image, extracted_text)
    return extracted_text


def _extract_ocr_text(
    sample: SampleFrame,
    engine: OcrEngine | None,
    ocr_cache: _OcrCache | None,
    ocr_usage_stats: _OcrUsageStats | None = None,
    *,
    changed_regions: list[dict[str, float]] | None = None,
) -> str | None:
    if engine is None:
        return None
    if changed_regions:
        crops = _crop_changed_regions(sample.bgr, changed_regions)
        if not crops:
            return None
        tokens: list[str] = []
        for crop in crops:
            cropped_text = _extract_text_from_image(crop, engine, ocr_cache, ocr_usage_stats)
            if cropped_text:
                tokens.append(cropped_text)
        return " ".join(tokens) or None
    if sample.ocr_text_checked:
        return sample.ocr_text
    sample.ocr_text = _extract_text_from_image(sample.bgr, engine, ocr_cache, ocr_usage_stats)
    sample.ocr_text_checked = True
    return sample.ocr_text


def _should_region_probe(
    visual: float,
    motion: float,
    changed_regions: list[dict[str, float]],
    config: HybridDetectorConfig,
) -> bool:
    if not changed_regions:
        return False
    signal_strength = max(visual, motion)
    probe_threshold = min(config.settle_threshold, config.ocr_trigger_threshold * 0.6)
    return signal_strength >= probe_threshold


def _merge_or_append_event(
    detected_events: list[dict[str, Any]],
    event: dict[str, Any],
    min_scene_gap_ms: int,
) -> None:
    if not detected_events or min_scene_gap_ms <= 0:
        detected_events.append(event)
        return

    previous_event = detected_events[-1]
    event_gap_ms = int(event["timestamp_ms"]) - int(previous_event["timestamp_ms"])
    if event_gap_ms >= min_scene_gap_ms:
        detected_events.append(event)
        return

    previous_score = float(previous_event["scene_score"])
    next_score = float(event["scene_score"])
    if next_score > previous_score or (next_score == previous_score and int(event["timestamp_ms"]) >= int(previous_event["timestamp_ms"])):
        detected_events[-1] = event


def _build_signal(
    previous: SampleFrame,
    current: SampleFrame,
    anchor: SampleFrame | None,
    config: HybridDetectorConfig,
    engine: OcrEngine | None,
    ocr_cache: _OcrCache | None = None,
    ocr_usage_stats: _OcrUsageStats | None = None,
) -> CandidateSignal:
    visual, motion, changed_regions = _transition_signal(
        previous,
        current,
        tile_size=config.tile_grid_size,
        contour_threshold_floor=config.contour_threshold_floor,
        contour_threshold_ceiling=config.contour_threshold_ceiling,
    )
    if anchor is not None and anchor.timestamp_ms != previous.timestamp_ms:
        anchor_visual, anchor_motion, anchor_regions = _transition_signal(
            anchor,
            current,
            tile_size=config.tile_grid_size,
            contour_threshold_floor=config.contour_threshold_floor,
            contour_threshold_ceiling=config.contour_threshold_ceiling,
        )
        visual = max(visual, anchor_visual)
        motion = max(motion, anchor_motion)
        changed_regions = _merge_changed_regions(changed_regions, anchor_regions)
    text_score = 0.0
    current_text = None
    signal_strength = max(visual, motion)
    current_text = None
    previous_text = None
    used_region_probe = False
    if _should_region_probe(visual, motion, changed_regions, config):
        used_region_probe = True
        current_text = _extract_ocr_text(
            current,
            engine,
            ocr_cache,
            ocr_usage_stats,
            changed_regions=changed_regions,
        )
        previous_text = _extract_ocr_text(
            previous,
            engine,
            ocr_cache,
            ocr_usage_stats,
            changed_regions=changed_regions,
        )
    if signal_strength >= config.ocr_trigger_threshold and not (current_text or previous_text):
        current_text = _extract_ocr_text(current, engine, ocr_cache, ocr_usage_stats)
        previous_text = _extract_ocr_text(previous, engine, ocr_cache, ocr_usage_stats)
    elif signal_strength >= config.ocr_trigger_threshold and not used_region_probe:
        current_text = _extract_ocr_text(current, engine, ocr_cache, ocr_usage_stats)
        previous_text = _extract_ocr_text(previous, engine, ocr_cache, ocr_usage_stats)
    if current_text or previous_text:
        if signal_strength >= config.ocr_trigger_threshold or used_region_probe:
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
        progress_callback("primary_scan", f"OCR disabled: {ocr_warning}", SCAN_RANGE[0], "warning")
    elif ocr_engine is not None:
        progress_callback(
            "primary_scan",
            "OCR enabled with PaddleOCR. Text probes will run when change thresholds are met.",
            SCAN_RANGE[0],
            "info",
        )
    ocr_cache = _OcrCache() if ocr_engine is not None else None
    ocr_usage_stats = _OcrUsageStats() if ocr_engine is not None else None

    timestamps = _sample_timestamps(duration_ms, config.sample_fps)
    previous_sample: SampleFrame | None = None
    anchor_sample: SampleFrame | None = None
    active_event: EventWindow | None = None
    detected_events: list[dict[str, Any]] = []
    frame_reader = _SequentialReader(capture, config.source_fps) if config.source_fps > 0 else None

    try:
        for index, timestamp_ms in enumerate(timestamps, start=1):
            if cancellation_callback():
                raise CancellationRequested("Run cancelled while scanning the video.")
            if frame_reader is None:
                frame = _seek_frame(capture, timestamp_ms)
            else:
                frame = frame_reader.next(timestamp_ms)
            if frame is None:
                continue
            current_sample = _prepare_frame(frame, timestamp_ms, config.max_frame_edge)
            if previous_sample is None:
                previous_sample = current_sample
                anchor_sample = current_sample
                ratio = index / max(1, len(timestamps))
                progress = SCAN_RANGE[0] + ((SCAN_RANGE[1] - SCAN_RANGE[0]) * ratio)
                progress_callback(
                    "primary_scan",
                    f"Scanning video for interface changes ({round(ratio * 100)}%)",
                    min(progress, SCAN_RANGE[1]),
                    "info",
                )
                continue

            if previous_sample is not None:
                signal = _build_signal(
                    previous_sample,
                    current_sample,
                    anchor_sample if active_event is None else None,
                    config,
                    ocr_engine,
                    ocr_cache,
                    ocr_usage_stats,
                )
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
                                _merge_or_append_event(detected_events, finalized, config.min_scene_gap_ms)
                            anchor_sample = current_sample
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
            _merge_or_append_event(detected_events, finalized, config.min_scene_gap_ms)

    if ocr_engine is not None and ocr_usage_stats is not None:
        if ocr_usage_stats.model_invocations > 0:
            cache_note = f" with {ocr_usage_stats.cache_hits} cache hit(s)" if ocr_usage_stats.cache_hits else ""
            progress_callback(
                "primary_scan",
                f"OCR invoked {ocr_usage_stats.model_invocations} time(s) during the scan{cache_note}.",
                SCAN_RANGE[1],
                "info",
            )
        else:
            progress_callback(
                "primary_scan",
                "OCR stayed enabled, but no sampled frames crossed the OCR thresholds.",
                SCAN_RANGE[1],
                "info",
            )

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
                extracted_ocr_text = _extract_text_from_image(screenshot, ocr_engine, ocr_cache, ocr_usage_stats)
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
