"""Text recognition helpers shared by the stable-screen engine: probe, engine loading, cache, parsing."""

from __future__ import annotations

from pathlib import Path
from types import SimpleNamespace
import warnings

import numpy as np

from app.config import OcrRuntimeConfig
from app.services.ocr import OcrCache, _normalize_predict_result, load_ocr_engine, probe_paddleocr_availability
from app.services.similarity import hamming_distance, perceptual_hash_array


class FakePredictResult:
    def __init__(self, payload) -> None:
        self.json = payload


def test_perceptual_hash_array_is_stable_for_identical_arrays() -> None:
    baseline = np.full((120, 180, 3), 90, dtype=np.uint8)

    baseline_hash = perceptual_hash_array(baseline)
    copied_hash = perceptual_hash_array(baseline.copy())

    assert hamming_distance(baseline_hash, baseline_hash) == 0
    assert hamming_distance(baseline_hash, copied_hash) == 0


def test_ocr_cache_hits_for_entries_within_hamming_threshold() -> None:
    baseline = np.full((120, 180, 3), 90, dtype=np.uint8)
    cache = OcrCache()
    baseline_hash = perceptual_hash_array(baseline)
    cache.entries[baseline_hash ^ 0b11] = "tone-9"

    cached, cached_text = cache.get(baseline)

    assert cached is True
    assert cached_text == "tone-9"


def test_normalize_predict_result_returns_none_when_no_text_is_present() -> None:
    result = [FakePredictResult({"res": {"rec_texts": []}})]

    assert _normalize_predict_result(result) is None


def test_normalize_predict_result_handles_single_result_object() -> None:
    result = [FakePredictResult({"res": {"rec_texts": ["  hello   world  "]}})]

    assert _normalize_predict_result(result) == "hello world"


def test_normalize_predict_result_handles_multiple_blocks_and_lines() -> None:
    result = [
        FakePredictResult({"res": {"rec_texts": ["First line", "Second line"]}}),
        FakePredictResult({"result": {"rec_texts": np.array(["Third block"], dtype=object)}}),
        SimpleNamespace(res={"rec_texts": ["Fourth block"]}),
    ]

    assert _normalize_predict_result(result) == "First line Second line Third block Fourth block"


def test_probe_paddleocr_availability_returns_false_when_package_is_missing(monkeypatch) -> None:
    import app.services.ocr as ocr_module

    probe_paddleocr_availability.cache_clear()
    monkeypatch.delenv("STEPTHROUGH_OCR_MODEL_SOURCE", raising=False)
    monkeypatch.delenv("STEPTHROUGH_OCR_DET_MODEL_DIR", raising=False)
    monkeypatch.delenv("STEPTHROUGH_OCR_REC_MODEL_DIR", raising=False)
    monkeypatch.delenv("STEPTHROUGH_OCR_CACHE_DIR", raising=False)

    def fail_import(_runtime_config):
        raise ModuleNotFoundError("No module named 'paddleocr'")

    monkeypatch.setattr(ocr_module, "_load_paddleocr_symbols", fail_import)

    result = probe_paddleocr_availability()

    assert result.available is False
    assert "missing `paddleocr`" in result.message
    assert result.warnings == ()


def test_probe_paddleocr_availability_rejects_local_mode_without_model_dirs(monkeypatch) -> None:
    probe_paddleocr_availability.cache_clear()
    monkeypatch.setenv("STEPTHROUGH_OCR_MODEL_SOURCE", "local")
    monkeypatch.delenv("STEPTHROUGH_OCR_DET_MODEL_DIR", raising=False)
    monkeypatch.delenv("STEPTHROUGH_OCR_REC_MODEL_DIR", raising=False)
    monkeypatch.delenv("STEPTHROUGH_OCR_CACHE_DIR", raising=False)

    result = probe_paddleocr_availability()

    assert result.available is False
    assert "Local OCR mode requires both" in result.message


def test_probe_paddleocr_availability_accepts_remote_mode_without_cached_models(monkeypatch, tmp_path: Path) -> None:
    import app.services.ocr as ocr_module

    probe_paddleocr_availability.cache_clear()
    monkeypatch.setenv("STEPTHROUGH_OCR_MODEL_SOURCE", "bos")
    monkeypatch.delenv("STEPTHROUGH_OCR_DET_MODEL_DIR", raising=False)
    monkeypatch.delenv("STEPTHROUGH_OCR_REC_MODEL_DIR", raising=False)
    monkeypatch.setenv("STEPTHROUGH_OCR_CACHE_DIR", str(tmp_path / "ocr-cache"))
    monkeypatch.setattr(ocr_module, "_load_paddleocr_symbols", lambda _runtime_config: (object, object()))
    monkeypatch.setattr(
        ocr_module,
        "_installed_package_version",
        lambda name: "3.3.0" if name in {"paddleocr", "paddlepaddle"} else None,
    )

    result = probe_paddleocr_availability()

    assert result.available is True
    assert "First use may initialize or download models" in result.message
    assert "ocr-cache" in result.message


def test_probe_paddleocr_availability_sets_probe_env_before_import(monkeypatch, tmp_path: Path) -> None:
    import app.services.ocr as ocr_module

    probe_paddleocr_availability.cache_clear()
    monkeypatch.setenv("STEPTHROUGH_OCR_MODEL_SOURCE", "bos")
    monkeypatch.delenv("STEPTHROUGH_OCR_DET_MODEL_DIR", raising=False)
    monkeypatch.delenv("STEPTHROUGH_OCR_REC_MODEL_DIR", raising=False)
    monkeypatch.setenv("STEPTHROUGH_OCR_CACHE_DIR", str(tmp_path / "ocr-cache"))
    monkeypatch.delenv("PADDLE_PDX_DISABLE_MODEL_SOURCE_CHECK", raising=False)
    monkeypatch.delenv("PADDLE_PDX_MODEL_SOURCE", raising=False)
    monkeypatch.delenv("PADDLE_PDX_CACHE_HOME", raising=False)

    def fake_import():
        assert ocr_module.os.environ["PADDLE_PDX_DISABLE_MODEL_SOURCE_CHECK"] == "True"
        assert ocr_module.os.environ["PADDLE_PDX_MODEL_SOURCE"] == "BOS"
        assert ocr_module.os.environ["PADDLE_PDX_CACHE_HOME"] == str(tmp_path / "ocr-cache")
        return object, object()

    monkeypatch.setattr(ocr_module, "_import_paddleocr_symbols", fake_import)
    monkeypatch.setattr(
        ocr_module,
        "_installed_package_version",
        lambda name: "3.3.0" if name in {"paddleocr", "paddlepaddle"} else None,
    )

    result = probe_paddleocr_availability()

    assert result.available is True


def test_probe_paddleocr_availability_captures_and_dedupes_warning_messages(monkeypatch, tmp_path: Path) -> None:
    import app.services.ocr as ocr_module

    probe_paddleocr_availability.cache_clear()
    monkeypatch.setenv("STEPTHROUGH_OCR_MODEL_SOURCE", "bos")
    monkeypatch.delenv("STEPTHROUGH_OCR_DET_MODEL_DIR", raising=False)
    monkeypatch.delenv("STEPTHROUGH_OCR_REC_MODEL_DIR", raising=False)
    monkeypatch.setenv("STEPTHROUGH_OCR_CACHE_DIR", str(tmp_path / "ocr-cache"))

    def fake_import():
        ocr_module.logging.getLogger("paddlex").warning("Connectivity check skipped.")
        warnings.warn("No ccache found.")
        warnings.warn("No ccache found.")
        return object, object()

    monkeypatch.setattr(ocr_module, "_import_paddleocr_symbols", fake_import)
    monkeypatch.setattr(
        ocr_module,
        "_installed_package_version",
        lambda name: "3.3.0" if name in {"paddleocr", "paddlepaddle"} else None,
    )

    result = probe_paddleocr_availability()

    assert result.available is True
    assert result.warnings == ("Connectivity check skipped.", "No ccache found.")


def test_paddle_ocr_engine_uses_cache_home_for_remote_mode_without_forcing_model_dirs(monkeypatch, tmp_path: Path) -> None:
    import app.services.ocr as ocr_module

    captured_kwargs: dict[str, object] = {}

    class FakePaddleOCR:
        def __init__(self, **kwargs) -> None:
            captured_kwargs.update(kwargs)

        def predict(self, _image):
            return []

    runtime_config = OcrRuntimeConfig(
        model_source="bos",
        det_model_dir=None,
        rec_model_dir=None,
        cache_dir=tmp_path / "ocr-cache",
    )
    monkeypatch.delenv("PADDLE_PDX_MODEL_SOURCE", raising=False)
    monkeypatch.delenv("PADDLE_PDX_CACHE_HOME", raising=False)
    monkeypatch.setattr(ocr_module, "_import_paddleocr_symbols", lambda: (FakePaddleOCR, object()))

    ocr_module.PaddleOcrEngine(runtime_config)

    assert captured_kwargs["lang"] == "en"
    assert "text_detection_model_dir" not in captured_kwargs
    assert "text_recognition_model_dir" not in captured_kwargs
    assert ocr_module.os.environ["PADDLE_PDX_MODEL_SOURCE"] == "BOS"
    assert ocr_module.os.environ["PADDLE_PDX_CACHE_HOME"] == str(runtime_config.cache_dir)


def test_ocr_engine_warning_is_emitted_when_backend_is_missing(monkeypatch) -> None:
    import app.services.ocr as ocr_module

    monkeypatch.setattr(ocr_module, "_load_paddleocr_symbols", lambda _runtime_config: (object, object()))
    monkeypatch.setattr(
        ocr_module,
        "_installed_package_version",
        lambda name: "3.3.0" if name in {"paddleocr", "paddlepaddle"} else None,
    )

    def fail_constructor(_runtime_config):
        raise RuntimeError("missing paddleocr")

    monkeypatch.setattr(ocr_module, "PaddleOcrEngine", fail_constructor)

    engine, warning = load_ocr_engine()

    assert engine is None
    assert warning == "missing paddleocr"
