from __future__ import annotations

from dataclasses import replace
from pathlib import Path
from types import SimpleNamespace
import warnings

import cv2
import numpy as np

from app.config import OcrRuntimeConfig
from app.models import HybridAdvancedSettings, RunSettings
from app.services.hybrid_detection import (
    CandidateSignal,
    _OcrCache,
    _SequentialReader,
    _TileStabilityMap,
    _annotate_dwell_durations,
    _build_signal,
    _classify_transition,
    _is_micro_change_candidate,
    _merge_or_append_event,
    _maybe_load_ocr_engine,
    _normalize_predict_result,
    _prepare_frame,
    _scroll_displacement,
    _seek_frame,
    _transition_signal,
    detect_candidates_hybrid,
    probe_paddleocr_availability,
    resolve_hybrid_config,
)
from app.services.similarity import hamming_distance, perceptual_hash_array


class FakeOcrEngine:
    def __init__(self, *, full_frame_only: bool = False) -> None:
        self.calls: list[tuple[int, int]] = []
        self.full_frame_only = full_frame_only

    def extract_text(self, image: np.ndarray) -> str | None:
        self.calls.append((image.shape[1], image.shape[0]))
        if self.full_frame_only and image.shape[0] < 300:
            return None
        tone_bucket = int(round(float(np.mean(image)) / 10.0))
        return f"tone-{tone_bucket}"


class FakePredictResult:
    def __init__(self, payload) -> None:
        self.json = payload


def make_signal(**overrides) -> CandidateSignal:
    values = {
        "timestamp_ms": 0,
        "visual": 0.2,
        "text": 0.0,
        "motion": 0.2,
        "combined": 0.2,
        "structural": 0.2,
        "changed_regions": [],
        "scroll_dx": 0.0,
        "scroll_dy": 0.0,
        "scroll_confidence": 0.0,
        "chrome_change": 0.0,
        "content_change": 0.0,
        "changed_tiles": np.zeros((8, 8), dtype=bool),
        "frame_width": 640,
        "frame_height": 360,
        "ocr_text": None,
    }
    values.update(overrides)
    return CandidateSignal(**values)


def test_resolve_hybrid_config_uses_preset_defaults() -> None:
    config = resolve_hybrid_config(RunSettings(analysis_engine="hybrid_v2", analysis_preset="subtle_ui"), fps=30)

    assert config.sample_fps == 8
    assert config.min_scene_gap_ms == 900
    assert config.min_dwell_ms == 250
    assert config.settle_window_ms == 250
    assert config.proposal_threshold == 0.19
    assert config.settle_threshold == 0.09
    assert config.ocr_trigger_threshold == 0.13
    assert config.enable_ocr is True
    assert config.ocr_backend == "paddleocr"


def test_resolve_hybrid_config_applies_overrides_and_clamps_to_source_fps() -> None:
    settings = RunSettings(
        analysis_engine="hybrid_v2",
        analysis_preset="balanced",
        advanced=HybridAdvancedSettings(
            sample_fps_override=120,
            min_dwell_ms=150,
            settle_window_ms=500,
            proposal_threshold=0.18,
            settle_threshold=0.08,
            ocr_trigger_threshold=0.11,
            enable_ocr=False,
        ),
    )

    config = resolve_hybrid_config(settings, fps=24)

    assert config.sample_fps == 24
    assert config.min_dwell_ms == 150
    assert config.settle_window_ms == 500
    assert config.proposal_threshold == 0.18
    assert config.settle_threshold == 0.08
    assert config.ocr_trigger_threshold == 0.11
    assert config.enable_ocr is False
    assert config.ocr_backend is None


def test_transition_signal_detects_local_interface_change() -> None:
    baseline = np.zeros((360, 640, 3), dtype=np.uint8)
    changed = baseline.copy()
    changed[60:180, 420:580] = 255

    previous = _prepare_frame(baseline, 0, 960)
    current = _prepare_frame(changed, 200, 960)

    features = _transition_signal(previous, current)

    assert features.visual > 0.1
    assert features.motion > 0.05
    assert features.changed_regions


def test_transition_signal_detects_dark_low_contrast_change() -> None:
    baseline = np.full((360, 640, 3), 0x33, dtype=np.uint8)
    changed = baseline.copy()
    changed[120:220, 240:340] = 0x33 + 15

    previous = _prepare_frame(baseline, 0, 960)
    current = _prepare_frame(changed, 200, 960)

    features = _transition_signal(previous, current)

    assert features.visual > 0.08
    assert features.changed_regions
    assert max(region["score"] for region in features.changed_regions) > 0.1


def test_scroll_displacement_detects_vertical_scroll_and_ignores_static_frames() -> None:
    baseline = np.full((320, 240), 32, dtype=np.uint8)
    for index, y in enumerate(range(24, 280, 40), start=1):
        cv2.putText(baseline, f"Row {index}", (48, y), cv2.FONT_HERSHEY_SIMPLEX, 0.7, 220, 2, cv2.LINE_AA)

    transform = np.float32([[1, 0, 0], [0, 1, -28]])
    shifted = cv2.warpAffine(baseline, transform, (baseline.shape[1], baseline.shape[0]), borderMode=cv2.BORDER_REPLICATE)

    dx, dy, confidence = _scroll_displacement(baseline, shifted)
    static_dx, static_dy, static_confidence = _scroll_displacement(baseline, baseline.copy())

    assert abs(dx) < 4
    assert abs(dy) >= 10
    assert confidence >= 0.2
    assert abs(static_dx) < 1
    assert abs(static_dy) < 1
    assert static_confidence >= 0.0


def test_scroll_displacement_rejects_crossfade_like_global_change() -> None:
    baseline = np.full((320, 240), 24, dtype=np.uint8)
    cv2.rectangle(baseline, (24, 32), (216, 132), 160, -1)
    changed = np.full((320, 240), 24, dtype=np.uint8)
    cv2.circle(changed, (120, 180), 72, 220, -1)

    dx, dy, confidence = _scroll_displacement(baseline, changed)

    assert confidence < 0.2
    assert abs(dy) < 320


def test_tile_stability_map_marks_repeatedly_changing_tiles_as_unstable() -> None:
    stability_map = _TileStabilityMap(grid_size=4, window_size=5, stability_threshold=0.8)

    for _ in range(5):
        changed_tiles = np.zeros((4, 4), dtype=bool)
        changed_tiles[1, 2] = True
        stability_map.update(changed_tiles)

    stable_mask = stability_map.stable_mask()

    assert stable_mask.shape == (4, 4)
    assert bool(stable_mask[1, 2]) is False
    assert bool(stable_mask[0, 0]) is True


def test_classify_transition_distinguishes_action_types() -> None:
    nav_signal = make_signal(chrome_change=0.3, content_change=0.35)
    assert _classify_transition(nav_signal, nav_signal) == "navigation"

    scroll_signal = make_signal(chrome_change=0.02, content_change=0.25, scroll_confidence=0.55)
    assert _classify_transition(scroll_signal, scroll_signal, cumulative_scroll_dy=48) == "scroll"

    feed_signal = make_signal(chrome_change=0.02, content_change=0.6, scroll_confidence=0.6, frame_height=640)
    assert _classify_transition(feed_signal, feed_signal, cumulative_scroll_dy=420) == "feed_card_swap"

    modal_signal = make_signal(
        chrome_change=0.1,
        content_change=0.3,
        changed_regions=[{"x": 0, "y": 220, "width": 640, "height": 120, "score": 0.8}],
        frame_width=640,
        frame_height=360,
    )
    assert _classify_transition(modal_signal, modal_signal) == "modal"

    content_signal = make_signal(
        chrome_change=0.02,
        content_change=0.1,
        text=0.32,
        changed_regions=[{"x": 220, "y": 170, "width": 110, "height": 24, "score": 0.4}],
    )
    assert _classify_transition(content_signal, content_signal) == "content_update"

    small_ui_signal = make_signal(
        chrome_change=0.02,
        content_change=0.06,
        changed_regions=[{"x": 530, "y": 290, "width": 60, "height": 32, "score": 0.5}],
    )
    assert _classify_transition(small_ui_signal, small_ui_signal) == "small_ui_change"


def test_annotate_dwell_durations_uses_event_windows() -> None:
    events = [
        {
            "timestamp_ms": 1200,
            "event_start_ms": 1000,
            "event_end_ms": 1300,
            "score_breakdown": {},
        },
        {
            "timestamp_ms": 3300,
            "event_start_ms": 3000,
            "event_end_ms": 3450,
            "score_breakdown": {},
        },
    ]

    _annotate_dwell_durations(events, duration_ms=5000)

    assert events[0]["score_breakdown"]["dwell_before_ms"] == 1000
    assert events[0]["score_breakdown"]["dwell_after_ms"] == 1700
    assert events[1]["score_breakdown"]["dwell_before_ms"] == 1700
    assert events[1]["score_breakdown"]["dwell_after_ms"] == 1550


def test_build_signal_uses_anchor_frame_for_gradual_changes() -> None:
    baseline = np.full((360, 640, 3), 0x33, dtype=np.uint8)
    mid = baseline.copy()
    current = baseline.copy()
    mid[120:220, 240:340] = 0x33 + 10
    current[120:220, 240:340] = 0x33 + 20

    config = resolve_hybrid_config(
        RunSettings(
            analysis_engine="hybrid_v2",
            analysis_preset="balanced",
            advanced=HybridAdvancedSettings(enable_ocr=False),
        ),
        fps=30,
    )

    anchor_sample = _prepare_frame(baseline, 0, 960)
    previous_sample = _prepare_frame(mid, 200, 960)
    current_sample = _prepare_frame(current, 400, 960)

    direct_signal = _build_signal(previous_sample, current_sample, None, config, None)
    anchored_signal = _build_signal(previous_sample, current_sample, anchor_sample, config, None)

    assert anchored_signal.combined > direct_signal.combined
    assert anchored_signal.visual > direct_signal.visual


def test_build_signal_region_probe_runs_below_full_frame_trigger() -> None:
    baseline = np.full((360, 640, 3), 0x33, dtype=np.uint8)
    changed = baseline.copy()
    changed[120:220, 240:340] = 0x33 + 15

    config = replace(
        resolve_hybrid_config(
            RunSettings(
                analysis_engine="hybrid_v2",
                analysis_preset="balanced",
                advanced=HybridAdvancedSettings(enable_ocr=True),
            ),
            fps=30,
        ),
        ocr_trigger_threshold=0.4,
        settle_threshold=0.1,
    )
    engine = FakeOcrEngine()
    ocr_cache = _OcrCache()

    signal = _build_signal(
        _prepare_frame(baseline, 0, 960),
        _prepare_frame(changed, 200, 960),
        None,
        config,
        engine,
        ocr_cache,
    )

    assert signal.visual < config.ocr_trigger_threshold
    assert signal.text > 0
    assert engine.calls
    assert all(width < 640 and height < 360 for width, height in engine.calls)


def test_build_signal_marks_typing_like_micro_changes_for_secondary_proposal_path() -> None:
    baseline = np.full((360, 640, 3), 0xF2, dtype=np.uint8)
    cv2.rectangle(baseline, (100, 120), (540, 240), (255, 255, 255), -1)
    cv2.putText(baseline, "Message", (120, 155), cv2.FONT_HERSHEY_SIMPLEX, 0.6, (80, 80, 80), 2, cv2.LINE_AA)
    changed = baseline.copy()
    cv2.putText(changed, "H", (140, 205), cv2.FONT_HERSHEY_SIMPLEX, 0.9, (40, 40, 40), 2, cv2.LINE_AA)

    config = replace(
        resolve_hybrid_config(
            RunSettings(
                analysis_engine="hybrid_v2",
                analysis_preset="balanced",
                advanced=HybridAdvancedSettings(enable_ocr=True),
            ),
            fps=30,
        ),
        ocr_trigger_threshold=0.4,
        settle_threshold=0.1,
    )

    signal = _build_signal(
        _prepare_frame(baseline, 0, 960),
        _prepare_frame(changed, 200, 960),
        None,
        config,
        FakeOcrEngine(),
        _OcrCache(),
    )

    assert signal.text > 0
    assert signal.chrome_change < 0.05
    assert _is_micro_change_candidate(signal, config) is True


def test_multi_region_navigation_change_is_not_treated_as_micro_change_candidate() -> None:
    signal = make_signal(
        motion=0.03,
        structural=0.2,
        changed_regions=[
            {"x": 12, "y": 24, "width": 48, "height": 36, "score": 0.4},
            {"x": 88, "y": 96, "width": 52, "height": 38, "score": 0.4},
            {"x": 160, "y": 140, "width": 64, "height": 40, "score": 0.4},
        ],
    )
    config = resolve_hybrid_config(
        RunSettings(
            analysis_engine="hybrid_v2",
            analysis_preset="balanced",
            advanced=HybridAdvancedSettings(enable_ocr=False),
        ),
        fps=30,
    )

    assert _is_micro_change_candidate(signal, config) is False


def test_build_signal_region_probe_uses_cache_for_repeated_crops() -> None:
    baseline = np.full((360, 640, 3), 0x33, dtype=np.uint8)
    changed = baseline.copy()
    changed[120:220, 240:340] = 0x33 + 15

    config = replace(
        resolve_hybrid_config(
            RunSettings(
                analysis_engine="hybrid_v2",
                analysis_preset="balanced",
                advanced=HybridAdvancedSettings(enable_ocr=True),
            ),
            fps=30,
        ),
        ocr_trigger_threshold=0.4,
        settle_threshold=0.1,
    )
    engine = FakeOcrEngine()
    ocr_cache = _OcrCache()
    previous_sample = _prepare_frame(baseline, 0, 960)
    current_sample = _prepare_frame(changed, 200, 960)

    _build_signal(previous_sample, current_sample, None, config, engine, ocr_cache)
    first_call_count = len(engine.calls)
    _build_signal(previous_sample, current_sample, None, config, engine, ocr_cache)

    assert first_call_count > 0
    assert len(engine.calls) == first_call_count


def test_build_signal_falls_back_to_full_frame_ocr_when_region_probe_is_empty() -> None:
    baseline = np.zeros((360, 640, 3), dtype=np.uint8)
    changed = baseline.copy()
    changed[60:180, 420:580] = 255

    config = resolve_hybrid_config(
        RunSettings(
            analysis_engine="hybrid_v2",
            analysis_preset="balanced",
            advanced=HybridAdvancedSettings(enable_ocr=True),
        ),
        fps=30,
    )
    engine = FakeOcrEngine(full_frame_only=True)
    signal = _build_signal(
        _prepare_frame(baseline, 0, 960),
        _prepare_frame(changed, 200, 960),
        None,
        config,
        engine,
        _OcrCache(),
    )

    assert signal.text > 0
    assert any(width == 640 and height == 360 for width, height in engine.calls)
    assert any(width < 640 and height < 360 for width, height in engine.calls)


def test_emit_gap_keeps_stronger_later_candidate_within_gap() -> None:
    detected_events = [
        {"timestamp_ms": 100, "scene_score": 0.4, "score_breakdown": {}, "ocr_text": None},
    ]
    next_event = {"timestamp_ms": 350, "scene_score": 0.7, "score_breakdown": {}, "ocr_text": None}

    _merge_or_append_event(detected_events, next_event, 500)

    assert len(detected_events) == 1
    assert detected_events[0]["timestamp_ms"] == 350
    assert detected_events[0]["scene_score"] == 0.7


def test_emit_gap_keeps_both_candidates_outside_gap() -> None:
    detected_events = [
        {"timestamp_ms": 100, "scene_score": 0.7, "score_breakdown": {}, "ocr_text": None},
    ]
    next_event = {"timestamp_ms": 700, "scene_score": 0.6, "score_breakdown": {}, "ocr_text": None}

    _merge_or_append_event(detected_events, next_event, 500)

    assert len(detected_events) == 2


def test_emit_gap_keeps_later_timestamp_when_scores_tie() -> None:
    detected_events = [
        {"timestamp_ms": 100, "scene_score": 0.7, "score_breakdown": {}, "ocr_text": None},
    ]
    next_event = {"timestamp_ms": 450, "scene_score": 0.7, "score_breakdown": {}, "ocr_text": None}

    _merge_or_append_event(detected_events, next_event, 500)

    assert len(detected_events) == 1
    assert detected_events[0]["timestamp_ms"] == 450


def test_perceptual_hash_array_is_stable_for_identical_arrays() -> None:
    baseline = np.full((120, 180, 3), 90, dtype=np.uint8)

    baseline_hash = perceptual_hash_array(baseline)
    copied_hash = perceptual_hash_array(baseline.copy())

    assert hamming_distance(baseline_hash, baseline_hash) == 0
    assert hamming_distance(baseline_hash, copied_hash) == 0


def test_ocr_cache_hits_for_entries_within_hamming_threshold() -> None:
    baseline = np.full((120, 180, 3), 90, dtype=np.uint8)
    cache = _OcrCache()
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
    import app.services.hybrid_detection as hybrid_detection

    probe_paddleocr_availability.cache_clear()
    monkeypatch.delenv("STEPTHROUGH_OCR_MODEL_SOURCE", raising=False)
    monkeypatch.delenv("STEPTHROUGH_OCR_DET_MODEL_DIR", raising=False)
    monkeypatch.delenv("STEPTHROUGH_OCR_REC_MODEL_DIR", raising=False)
    monkeypatch.delenv("STEPTHROUGH_OCR_CACHE_DIR", raising=False)

    def fail_import(_runtime_config):
        raise ModuleNotFoundError("No module named 'paddleocr'")

    monkeypatch.setattr(hybrid_detection, "_load_paddleocr_symbols", fail_import)

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
    import app.services.hybrid_detection as hybrid_detection

    probe_paddleocr_availability.cache_clear()
    monkeypatch.setenv("STEPTHROUGH_OCR_MODEL_SOURCE", "bos")
    monkeypatch.delenv("STEPTHROUGH_OCR_DET_MODEL_DIR", raising=False)
    monkeypatch.delenv("STEPTHROUGH_OCR_REC_MODEL_DIR", raising=False)
    monkeypatch.setenv("STEPTHROUGH_OCR_CACHE_DIR", str(tmp_path / "ocr-cache"))
    monkeypatch.setattr(hybrid_detection, "_load_paddleocr_symbols", lambda _runtime_config: (object, object()))
    monkeypatch.setattr(
        hybrid_detection,
        "_installed_package_version",
        lambda name: "3.3.0" if name in {"paddleocr", "paddlepaddle"} else None,
    )

    result = probe_paddleocr_availability()

    assert result.available is True
    assert "First use may initialize or download models" in result.message
    assert "ocr-cache" in result.message


def test_probe_paddleocr_availability_sets_probe_env_before_import(monkeypatch, tmp_path: Path) -> None:
    import app.services.hybrid_detection as hybrid_detection

    probe_paddleocr_availability.cache_clear()
    monkeypatch.setenv("STEPTHROUGH_OCR_MODEL_SOURCE", "bos")
    monkeypatch.delenv("STEPTHROUGH_OCR_DET_MODEL_DIR", raising=False)
    monkeypatch.delenv("STEPTHROUGH_OCR_REC_MODEL_DIR", raising=False)
    monkeypatch.setenv("STEPTHROUGH_OCR_CACHE_DIR", str(tmp_path / "ocr-cache"))
    monkeypatch.delenv("PADDLE_PDX_DISABLE_MODEL_SOURCE_CHECK", raising=False)
    monkeypatch.delenv("PADDLE_PDX_MODEL_SOURCE", raising=False)
    monkeypatch.delenv("PADDLE_PDX_CACHE_HOME", raising=False)

    def fake_import():
        assert hybrid_detection.os.environ["PADDLE_PDX_DISABLE_MODEL_SOURCE_CHECK"] == "True"
        assert hybrid_detection.os.environ["PADDLE_PDX_MODEL_SOURCE"] == "BOS"
        assert hybrid_detection.os.environ["PADDLE_PDX_CACHE_HOME"] == str(tmp_path / "ocr-cache")
        return object, object()

    monkeypatch.setattr(hybrid_detection, "_import_paddleocr_symbols", fake_import)
    monkeypatch.setattr(
        hybrid_detection,
        "_installed_package_version",
        lambda name: "3.3.0" if name in {"paddleocr", "paddlepaddle"} else None,
    )

    result = probe_paddleocr_availability()

    assert result.available is True


def test_probe_paddleocr_availability_captures_and_dedupes_warning_messages(monkeypatch, tmp_path: Path) -> None:
    import app.services.hybrid_detection as hybrid_detection

    probe_paddleocr_availability.cache_clear()
    monkeypatch.setenv("STEPTHROUGH_OCR_MODEL_SOURCE", "bos")
    monkeypatch.delenv("STEPTHROUGH_OCR_DET_MODEL_DIR", raising=False)
    monkeypatch.delenv("STEPTHROUGH_OCR_REC_MODEL_DIR", raising=False)
    monkeypatch.setenv("STEPTHROUGH_OCR_CACHE_DIR", str(tmp_path / "ocr-cache"))

    def fake_import():
        hybrid_detection.logging.getLogger("paddlex").warning("Connectivity check skipped.")
        warnings.warn("No ccache found.")
        warnings.warn("No ccache found.")
        return object, object()

    monkeypatch.setattr(hybrid_detection, "_import_paddleocr_symbols", fake_import)
    monkeypatch.setattr(
        hybrid_detection,
        "_installed_package_version",
        lambda name: "3.3.0" if name in {"paddleocr", "paddlepaddle"} else None,
    )

    result = probe_paddleocr_availability()

    assert result.available is True
    assert result.warnings == ("Connectivity check skipped.", "No ccache found.")


def test_paddle_ocr_engine_uses_cache_home_for_remote_mode_without_forcing_model_dirs(monkeypatch, tmp_path: Path) -> None:
    import app.services.hybrid_detection as hybrid_detection

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
    monkeypatch.setattr(hybrid_detection, "_import_paddleocr_symbols", lambda: (FakePaddleOCR, object()))

    hybrid_detection.PaddleOcrEngine(runtime_config)

    assert captured_kwargs["lang"] == "en"
    assert "text_detection_model_dir" not in captured_kwargs
    assert "text_recognition_model_dir" not in captured_kwargs
    assert hybrid_detection.os.environ["PADDLE_PDX_MODEL_SOURCE"] == "BOS"
    assert hybrid_detection.os.environ["PADDLE_PDX_CACHE_HOME"] == str(runtime_config.cache_dir)


def test_ocr_engine_warning_is_emitted_when_backend_is_missing(monkeypatch) -> None:
    import app.services.hybrid_detection as hybrid_detection

    settings = RunSettings(analysis_engine="hybrid_v2", analysis_preset="balanced")
    config = resolve_hybrid_config(settings, fps=30)
    monkeypatch.setattr(hybrid_detection, "_load_paddleocr_symbols", lambda _runtime_config: (object, object()))
    monkeypatch.setattr(
        hybrid_detection,
        "_installed_package_version",
        lambda name: "3.3.0" if name in {"paddleocr", "paddlepaddle"} else None,
    )

    def fail_constructor(_runtime_config):
        raise RuntimeError("missing paddleocr")

    monkeypatch.setattr(hybrid_detection, "PaddleOcrEngine", fail_constructor)

    engine, warning = _maybe_load_ocr_engine(config)

    assert engine is None
    assert warning == "missing paddleocr"


def test_detect_candidates_hybrid_creates_score_breakdowns(
    tmp_path: Path,
    video_factory,
) -> None:
    video_path = video_factory("hybrid-two-state.mp4", ["black", "white"], segment_duration=1)
    frames_dir = tmp_path / "frames"
    frames_dir.mkdir(parents=True, exist_ok=True)

    candidates = detect_candidates_hybrid(
        video_path=video_path,
        frames_dir=frames_dir,
        duration_ms=2_000,
        fps=30,
        settings=RunSettings(
            analysis_engine="hybrid_v2",
            analysis_preset="balanced",
            advanced=HybridAdvancedSettings(enable_ocr=False),
        ),
    )

    assert candidates
    assert all(candidate["score_breakdown"] is not None for candidate in candidates)
    assert all("perceptual_hash" in candidate for candidate in candidates)
    assert all("transition_type" in candidate["score_breakdown"] for candidate in candidates)
    assert all("dwell_before_ms" in candidate["score_breakdown"] for candidate in candidates)


def test_sequential_reader_matches_seek_reader_for_monotonic_timestamps(tmp_path: Path, video_factory) -> None:
    import cv2

    video_path = video_factory("reader-compare.mp4", ["red", "green", "blue"], segment_duration=0.5)
    timestamps = [0, 100, 300, 600, 900, 1200]

    seek_capture = cv2.VideoCapture(str(video_path))
    sequential_capture = cv2.VideoCapture(str(video_path))
    reader = _SequentialReader(sequential_capture, source_fps=float(sequential_capture.get(cv2.CAP_PROP_FPS)) or 25.0)

    try:
        for timestamp_ms in timestamps:
            seek_frame = _seek_frame(seek_capture, timestamp_ms)
            sequential_frame = reader.next(timestamp_ms)
            assert seek_frame is not None
            assert sequential_frame is not None
            assert np.array_equal(seek_frame, sequential_frame)
    finally:
        seek_capture.release()
        sequential_capture.release()
