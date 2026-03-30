from __future__ import annotations

from pathlib import Path

from fastapi.testclient import TestClient
from pydantic import ValidationError

from app.analysis_metadata import (
    HYBRID_PRESET_METADATA,
    MANUAL_HYBRID_PRESETS_END,
    MANUAL_HYBRID_PRESETS_START,
    render_manual_hybrid_v2_presets_section,
)
from app.models import HybridAdvancedSettings, RunSettings
from app.services.hybrid_detection import resolve_hybrid_config


def test_hybrid_metadata_registry_matches_resolved_defaults() -> None:
    for preset, metadata in HYBRID_PRESET_METADATA.items():
        config = resolve_hybrid_config(
            RunSettings(analysis_engine="hybrid_v2", analysis_preset=preset),
            fps=30,
        )

        assert config.sample_fps == metadata.sample_fps
        assert config.min_dwell_ms == metadata.min_dwell_ms
        assert config.settle_window_ms == metadata.settle_window_ms
        assert config.proposal_threshold == metadata.proposal_threshold
        assert config.settle_threshold == metadata.settle_threshold
        assert config.ocr_trigger_threshold == metadata.ocr_trigger_threshold


def test_analysis_metadata_endpoint_returns_backend_registry(client: TestClient) -> None:
    response = client.get("/analysis/metadata")

    assert response.status_code == 200
    payload = response.json()

    assert payload["hybrid_presets"]["balanced"]["min_dwell_ms"] == 350
    assert payload["hybrid_presets"]["balanced"]["settle_window_ms"] == 350
    assert payload["controls_by_engine"]["hybrid_v2"]["advanced.proposal_threshold"]["supported"] is True
    assert payload["controls_by_engine"]["hybrid_v2"]["advanced.settle_threshold"]["supported"] is True
    assert payload["controls_by_engine"]["hybrid_v2"]["advanced.ocr_trigger_threshold"]["supported"] is True
    assert payload["controls_by_engine"]["scene_v1"]["advanced.proposal_threshold"]["reason"] == "hybrid_v2_only"
    assert payload["controls_by_engine"]["hybrid_v2"]["extract_offset_ms"]["supported"] is False
    assert payload["controls_by_engine"]["hybrid_v2"]["extract_offset_ms"]["reason"] == "no_effect_in_hybrid_v2"


def test_hybrid_advanced_thresholds_validate_range() -> None:
    settings = HybridAdvancedSettings(
        proposal_threshold=0.2,
        settle_threshold=0.1,
        ocr_trigger_threshold=0.15,
    )

    assert settings.proposal_threshold == 0.2
    assert settings.settle_threshold == 0.1
    assert settings.ocr_trigger_threshold == 0.15

    try:
        HybridAdvancedSettings(proposal_threshold=1.2)
    except ValidationError:
        pass
    else:
        raise AssertionError("proposal_threshold above 1.0 should fail validation")

    try:
        HybridAdvancedSettings(settle_threshold=-0.01)
    except ValidationError:
        pass
    else:
        raise AssertionError("settle_threshold below 0.0 should fail validation")

    try:
        HybridAdvancedSettings(ocr_trigger_threshold=float("inf"))
    except ValidationError:
        pass
    else:
        raise AssertionError("ocr_trigger_threshold must reject non-finite values")


def test_manual_hybrid_preset_section_matches_generated_metadata() -> None:
    repo_root = Path(__file__).resolve().parents[2]
    manual_text = (repo_root / "manual.md").read_text()

    start_index = manual_text.index(MANUAL_HYBRID_PRESETS_START) + len(MANUAL_HYBRID_PRESETS_START)
    end_index = manual_text.index(MANUAL_HYBRID_PRESETS_END)
    rendered_section = render_manual_hybrid_v2_presets_section()
    current_section = manual_text[start_index:end_index].strip()

    assert current_section == rendered_section
