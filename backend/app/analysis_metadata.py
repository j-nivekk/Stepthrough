from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from .models import AnalysisEngine, AnalysisPreset


MANUAL_HYBRID_PRESETS_START = "<!-- START generated:hybrid_v2_presets -->"
MANUAL_HYBRID_PRESETS_END = "<!-- END generated:hybrid_v2_presets -->"


@dataclass(frozen=True)
class HybridPresetMetadata:
    heading: str
    label: str
    short_description: str
    intended_use: str
    good_for: tuple[str, ...]
    tradeoffs: tuple[str, ...]
    sample_fps: int
    min_dwell_ms: int
    settle_window_ms: int
    proposal_threshold: float
    settle_threshold: float
    ocr_trigger_threshold: float


@dataclass(frozen=True)
class AnalysisControlMetadata:
    supported: bool
    reason: str | None = None
    note: str | None = None


HYBRID_PRESET_METADATA: dict[AnalysisPreset, HybridPresetMetadata] = {
    "subtle_ui": HybridPresetMetadata(
        heading="Subtle UI",
        label="subtle ui",
        short_description="Most sensitive preset for small or brief interface changes.",
        intended_use="Use this when tiny, brief, or text-led UI states matter more than review volume.",
        good_for=(
            "tiny badges or state indicators",
            "hover-like changes in prototypes",
            "overlays and short menus",
            "subtle text changes",
        ),
        tradeoffs=(
            "more sensitive",
            "usually produces more candidates",
            "may require more review cleanup",
        ),
        sample_fps=8,
        min_dwell_ms=250,
        settle_window_ms=250,
        proposal_threshold=0.19,
        settle_threshold=0.09,
        ocr_trigger_threshold=0.13,
    ),
    "balanced": HybridPresetMetadata(
        heading="Balanced",
        label="balanced",
        short_description="Default compromise between sensitivity and noise resistance.",
        intended_use="Best starting point for most walkthrough recordings before any advanced tuning.",
        good_for=(
            "general app walkthroughs",
            "mobile task flows",
            "desktop product tours",
            "most prototype review sessions",
        ),
        tradeoffs=(
            "moderate sensitivity",
            "moderate noise resistance",
        ),
        sample_fps=6,
        min_dwell_ms=350,
        settle_window_ms=350,
        proposal_threshold=0.20,
        settle_threshold=0.10,
        ocr_trigger_threshold=0.15,
    ),
    "noise_resistant": HybridPresetMetadata(
        heading="Ignore Noise",
        label="ignore noise",
        short_description="Most conservative preset for noisy or motion-heavy recordings.",
        intended_use="Use this when motion, compression shimmer, or repeated micro-change is overwhelming the output.",
        good_for=(
            "noisy compression artifacts",
            "scrolling-heavy recordings",
            "recordings with frequent micro-motion",
            "dynamic content that should not become a step every few frames",
        ),
        tradeoffs=(
            "calmer output",
            "more likely to miss short, subtle steps",
        ),
        sample_fps=4,
        min_dwell_ms=700,
        settle_window_ms=700,
        proposal_threshold=0.31,
        settle_threshold=0.16,
        ocr_trigger_threshold=0.22,
    ),
}


ANALYSIS_CONTROLS_BY_ENGINE: dict[AnalysisEngine, dict[str, AnalysisControlMetadata]] = {
    "hybrid_v2": {
        "analysis_preset": AnalysisControlMetadata(supported=True),
        "advanced.sample_fps_override": AnalysisControlMetadata(supported=True),
        "advanced.min_dwell_ms": AnalysisControlMetadata(supported=True),
        "advanced.settle_window_ms": AnalysisControlMetadata(supported=True),
        "advanced.proposal_threshold": AnalysisControlMetadata(
            supported=True,
            note="Lower values propose more event windows. Higher values are stricter.",
        ),
        "advanced.settle_threshold": AnalysisControlMetadata(
            supported=True,
            note="Lower values keep active events alive longer. Higher values settle sooner.",
        ),
        "advanced.ocr_trigger_threshold": AnalysisControlMetadata(
            supported=True,
            note="Lower values probe OCR more readily. Higher values save OCR work but may miss text-led changes.",
        ),
        "advanced.enable_ocr": AnalysisControlMetadata(supported=True),
        "min_scene_gap_ms": AnalysisControlMetadata(
            supported=True,
            note="Applied after event windows finalize by merge-or-replace logic.",
        ),
        "extract_offset_ms": AnalysisControlMetadata(
            supported=False,
            reason="no_effect_in_hybrid_v2",
            note="Shared v1 timing control. The current hybrid extraction path ignores it.",
        ),
        "sample_fps": AnalysisControlMetadata(
            supported=False,
            reason="scene_v1_only",
            note="Hybrid sampling comes from the preset or sample_fps_override.",
        ),
        "allow_high_fps_sampling": AnalysisControlMetadata(
            supported=False,
            reason="scene_v1_only",
            note="Hybrid clamps sample_fps_override directly to source fps.",
        ),
        "detector_mode": AnalysisControlMetadata(
            supported=False,
            reason="scene_v1_only",
            note="Hybrid does not use the v1 detector mode selector.",
        ),
        "tolerance": AnalysisControlMetadata(
            supported=False,
            reason="scene_v1_only",
            note="Hybrid does not use the v1 tolerance mapping.",
        ),
    },
    "scene_v1": {
        "analysis_preset": AnalysisControlMetadata(
            supported=False,
            reason="hybrid_v2_only",
            note="Presets only affect the hybrid detector.",
        ),
        "advanced.sample_fps_override": AnalysisControlMetadata(
            supported=False,
            reason="hybrid_v2_only",
        ),
        "advanced.min_dwell_ms": AnalysisControlMetadata(
            supported=False,
            reason="hybrid_v2_only",
        ),
        "advanced.settle_window_ms": AnalysisControlMetadata(
            supported=False,
            reason="hybrid_v2_only",
        ),
        "advanced.proposal_threshold": AnalysisControlMetadata(
            supported=False,
            reason="hybrid_v2_only",
        ),
        "advanced.settle_threshold": AnalysisControlMetadata(
            supported=False,
            reason="hybrid_v2_only",
        ),
        "advanced.ocr_trigger_threshold": AnalysisControlMetadata(
            supported=False,
            reason="hybrid_v2_only",
        ),
        "advanced.enable_ocr": AnalysisControlMetadata(
            supported=False,
            reason="hybrid_v2_only",
        ),
        "min_scene_gap_ms": AnalysisControlMetadata(supported=True),
        "extract_offset_ms": AnalysisControlMetadata(supported=True),
        "sample_fps": AnalysisControlMetadata(supported=True),
        "allow_high_fps_sampling": AnalysisControlMetadata(supported=True),
        "detector_mode": AnalysisControlMetadata(supported=True),
        "tolerance": AnalysisControlMetadata(supported=True),
    },
}


def get_hybrid_preset_metadata(preset: AnalysisPreset) -> HybridPresetMetadata:
    return HYBRID_PRESET_METADATA[preset]


def serialize_analysis_metadata() -> dict[str, Any]:
    return {
        "hybrid_presets": {
            preset: {
                "label": metadata.label,
                "short_description": metadata.short_description,
                "intended_use": metadata.intended_use,
                "good_for": list(metadata.good_for),
                "tradeoffs": list(metadata.tradeoffs),
                "sample_fps": metadata.sample_fps,
                "min_dwell_ms": metadata.min_dwell_ms,
                "settle_window_ms": metadata.settle_window_ms,
                "proposal_threshold": metadata.proposal_threshold,
                "settle_threshold": metadata.settle_threshold,
                "ocr_trigger_threshold": metadata.ocr_trigger_threshold,
            }
            for preset, metadata in HYBRID_PRESET_METADATA.items()
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


def render_manual_hybrid_v2_presets_section() -> str:
    lines = [
        "### Hybrid v2 Presets",
        "",
        "Hybrid v2 has three presets.",
        "",
    ]

    for index, metadata in enumerate(HYBRID_PRESET_METADATA.values()):
        lines.extend(
            [
                f"#### {metadata.heading}",
                "",
                metadata.intended_use,
                "",
                "Good for:",
                "",
            ]
        )
        lines.extend(f"- {item}" for item in metadata.good_for)
        lines.extend(
            [
                "",
                "Tradeoff:",
                "",
            ]
        )
        lines.extend(f"- {item}" for item in metadata.tradeoffs)
        lines.extend(
            [
                "",
                "Current preset baseline:",
                "",
                f"- sample fps: {metadata.sample_fps}",
                f"- minimum dwell: {metadata.min_dwell_ms} ms",
                f"- settle window: {metadata.settle_window_ms} ms",
                f"- proposal threshold: {metadata.proposal_threshold:.2f}",
                f"- settle threshold: {metadata.settle_threshold:.2f}",
                f"- OCR trigger threshold: {metadata.ocr_trigger_threshold:.2f}",
            ]
        )
        if index < len(HYBRID_PRESET_METADATA) - 1:
            lines.append("")
    return "\n".join(lines)
