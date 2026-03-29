"""Core types for the eval pipeline.

Every scenario produces a ``ScenarioResult`` containing the generated video and
a list of ``GroundTruthEvent`` entries that describe exactly what happens and
when.  The evaluator matches engine output candidates against these events and
returns ``EvalMetrics``.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
from typing import Literal


Difficulty = Literal["easy", "medium", "hard"]
Category = Literal[
    "navigation",
    "scrolling",
    "feed",
    "overlay",
    "content",
    "composite",
]


@dataclass(frozen=True)
class GroundTruthEvent:
    """A known event embedded in a synthetic eval video.

    Attributes:
        event_type: Semantic label for the event.  One of:
            navigation   -- full-screen or major layout change
            scroll       -- content moves within a viewport
            card_swap    -- feed card replaced (chrome stable)
            content_update -- text/data change, layout unchanged
            modal        -- overlay/dialog appears
            small_ui_change -- toast, badge, indicator
            loading      -- skeleton/spinner to content
        start_ms: Timestamp when the transition begins (first changed frame).
        end_ms: Timestamp when the transition completes (first fully-settled
                frame of the new state).  Equal to start_ms for instantaneous
                changes.
        metadata: Arbitrary key/value bag for type-specific details.
        difficulty: How hard this event should be to detect.
    """

    event_type: str
    start_ms: int
    end_ms: int
    metadata: dict = field(default_factory=dict)
    difficulty: Difficulty = "medium"


@dataclass(frozen=True)
class ScenarioResult:
    """Output of a scenario generator: the video and its ground truth.

    Attributes:
        video_path: Absolute path to the generated ``.avi`` file.
        ground_truth: Ordered list of events embedded in the video.
        duration_ms: Total video duration in milliseconds.
        fps: Frame rate of the generated video.
        width: Frame width in pixels.
        height: Frame height in pixels.
        description: Human-readable summary of what the scenario tests.
        category: Which capability area this scenario exercises.
        difficulty: Overall difficulty rating (hardest event wins).
    """

    video_path: Path
    ground_truth: list[GroundTruthEvent]
    duration_ms: int
    fps: float
    width: int
    height: int
    description: str
    category: Category = "navigation"
    difficulty: Difficulty = "medium"


@dataclass
class EventMatchResult:
    """Result of matching a single ground truth event against candidates.

    Attributes:
        ground_truth: The ground truth event being matched.
        matched_candidate_index: Index into the candidate list, or None.
        matched_candidate_timestamp_ms: Timestamp of the matched candidate.
        timing_error_ms: Absolute timing error in ms, or None if unmatched.
    """

    ground_truth: GroundTruthEvent
    matched_candidate_index: int | None = None
    matched_candidate_timestamp_ms: int | None = None
    timing_error_ms: int | None = None


@dataclass
class EvalMetrics:
    """Aggregate metrics from evaluating engine output against ground truth.

    Attributes:
        precision: TP / (TP + FP).
        recall: TP / (TP + FN).
        f1: Harmonic mean of precision and recall.
        mean_timing_error_ms: Average timing error for matched events.
        false_positives: Candidates not matched to any ground truth event.
        missed_events: Ground truth events with no matched candidate.
        total_ground_truth: Number of ground truth events.
        total_candidates: Number of engine candidates.
        per_event_results: Detailed match results per ground truth event.
    """

    precision: float
    recall: float
    f1: float
    mean_timing_error_ms: float
    false_positives: int
    missed_events: int
    total_ground_truth: int
    total_candidates: int
    per_event_results: list[EventMatchResult] = field(default_factory=list)
