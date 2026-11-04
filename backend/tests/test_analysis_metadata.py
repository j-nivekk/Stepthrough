from __future__ import annotations

from fastapi.testclient import TestClient

from app.analysis_metadata import STABLE_RECORDING_TYPES
from app.models import RunSettings, StableSettings
from app.services.stable_detection import ENGINE_VERSION, resolve_stable_config


def test_recording_type_registry_matches_resolved_defaults() -> None:
    for kind, metadata in STABLE_RECORDING_TYPES.items():
        config = resolve_stable_config(
            RunSettings(stable=StableSettings(recording_type=kind)), fps=30, width=1179, height=2556
        )

        assert config.min_dwell_ms == metadata.min_dwell_ms
        assert config.min_change_percent == metadata.min_change_percent
        assert config.ignore_status_bar == metadata.ignore_status_bar


def test_analysis_metadata_endpoint_describes_only_the_stable_engine(client: TestClient) -> None:
    response = client.get("/analysis/metadata")

    assert response.status_code == 200
    payload = response.json()

    assert payload["stable_engine_version"] == ENGINE_VERSION
    assert payload["stable_recording_types"]["phone"]["min_dwell_ms"] == 450
    assert payload["stable_recording_types"]["desktop"]["min_change_percent"] == 0.25
    assert list(payload["controls_by_engine"]) == ["stable_v3"]
    assert "hybrid_presets" not in payload
    assert "exports" in payload["controls_by_engine"]["stable_v3"]["stable.enable_ocr"]["note"]
