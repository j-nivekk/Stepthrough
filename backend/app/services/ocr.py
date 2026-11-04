"""Text recognition (PaddleOCR) for step screenshots: availability probe, engine loading and a small
cache that skips the model for near-identical images."""

from __future__ import annotations

from collections import OrderedDict
from contextlib import contextmanager, redirect_stderr
from dataclasses import dataclass, field
from functools import lru_cache
from importlib.metadata import PackageNotFoundError, version
from io import StringIO
import json
import logging
import os
from typing import Any, Protocol
import warnings

import cv2
import numpy as np

from ..config import OcrRuntimeConfig, build_ocr_runtime_config, validate_ocr_runtime_config
from .similarity import hamming_distance, perceptual_hash_array


class OcrEngine(Protocol):
    def extract_text(self, image: np.ndarray) -> str | None:
        ...


@dataclass
class OcrUsageStats:
    model_invocations: int = 0
    cache_hits: int = 0


@dataclass
class OcrCache:
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


def load_ocr_engine() -> tuple[OcrEngine | None, str | None]:
    """Load PaddleOCR, or return (None, reason) when it is not installed or configured."""
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


def extract_text_from_image(
    image: np.ndarray,
    engine: OcrEngine | None,
    ocr_cache: OcrCache | None,
    ocr_usage_stats: OcrUsageStats | None = None,
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
