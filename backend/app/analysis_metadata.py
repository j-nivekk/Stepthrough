from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from .models import AnalysisEngine, RecordingType


@dataclass(frozen=True)
class StableRecordingTypeMetadata:
    label: str
    description: str
    min_dwell_ms: int
    min_change_percent: float
    ignore_status_bar: bool


# Defaults of the stable-screen engine per kind of recording. Users can override each value.
STABLE_RECORDING_TYPES: dict[RecordingType, StableRecordingTypeMetadata] = {
    "phone": StableRecordingTypeMetadata(
        label="phone or tablet",
        description="Touch-screen recordings. The status bar (clock, battery, recording indicator) is ignored.",
        min_dwell_ms=450,
        min_change_percent=0.1,
        ignore_status_bar=True,
    ),
    "desktop": StableRecordingTypeMetadata(
        label="computer",
        description=(
            "Desktop or browser recordings with a visible mouse pointer. Small changes such as the moving "
            "pointer are ignored, so tiny controls may need a lower smallest change."
        ),
        min_dwell_ms=600,
        min_change_percent=0.25,
        ignore_status_bar=False,
    ),
}


@dataclass(frozen=True)
class AnalysisControlMetadata:
    supported: bool
    reason: str | None = None
    note: str | None = None


# Only the stable-screen engine starts new runs; runs made with scene_v1 or hybrid_v2 are read-only.
ANALYSIS_CONTROLS_BY_ENGINE: dict[AnalysisEngine, dict[str, AnalysisControlMetadata]] = {
    "stable_v3": {
        "stable.recording_type": AnalysisControlMetadata(supported=True),
        "stable.min_dwell_ms": AnalysisControlMetadata(
            supported=True,
            note="How long a screen must stay still to count as a step.",
        ),
        "stable.min_change_percent": AnalysisControlMetadata(
            supported=True,
            note="Smallest connected change, as a percentage of the screen, that ends a stable screen.",
        ),
        "stable.ignore_regions": AnalysisControlMetadata(supported=True),
        "stable.ignore_status_bar": AnalysisControlMetadata(supported=True),
        "stable.scroll_mode": AnalysisControlMetadata(supported=True),
        "stable.group_typing": AnalysisControlMetadata(supported=True),
        "stable.include_opening_screen": AnalysisControlMetadata(supported=True),
        "stable.enable_ocr": AnalysisControlMetadata(
            supported=True,
            note="Reads the text in each screenshot and adds it to exports (ocr_text). Not needed to detect steps.",
        ),
        "stable.sensitivity": AnalysisControlMetadata(
            supported=True,
            note="Pixel threshold in multiples of the noise measured on the recording (minimum 10 grey levels).",
        ),
        "stable.sample_fps": AnalysisControlMetadata(supported=True),
    },
}


def serialize_analysis_metadata() -> dict[str, Any]:
    from .services.stable_detection import ENGINE_VERSION

    return {
        "stable_engine_version": ENGINE_VERSION,
        "stable_recording_types": {
            kind: {
                "label": metadata.label,
                "description": metadata.description,
                "min_dwell_ms": metadata.min_dwell_ms,
                "min_change_percent": metadata.min_change_percent,
                "ignore_status_bar": metadata.ignore_status_bar,
            }
            for kind, metadata in STABLE_RECORDING_TYPES.items()
        },
        "controls_by_engine": {
            engine: {
                control_name: {
                    "supported": control.supported,
                    "reason": control.reason,
                    "note": control.note,
                }
                for control_name, control in controls.items()
            }
            for engine, controls in ANALYSIS_CONTROLS_BY_ENGINE.items()
        },
    }
