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
ShellMode = Literal["mobile_app", "desktop_browser", "fullscreen"]
Orientation = Literal["portrait", "landscape"]
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
class ScenarioContext:
    """Scenario execution context for device-aware eval variants."""

    variant_id: str
    profile_id: str
    shell: ShellMode
    logical_width: int
    logical_height: int
    encoded_width: int
    encoded_height: int
    source_fps: float
    sample_fps: float | None = None

    @property
    def orientation(self) -> Orientation:
        return "portrait" if self.logical_height >= self.logical_width else "landscape"


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
        variant_id: Scenario variant identifier.
        profile_id: Device/profile identifier.
        orientation: Portrait or landscape.
        shell: Visual shell/chrome mode used to render the scenario.
        logical_width: Width used for logical UI layout before encoding.
        logical_height: Height used for logical UI layout before encoding.
        encoded_width: Width of the written video frames.
        encoded_height: Height of the written video frames.
        source_fps: Source frame rate used to render the video.
        sample_fps: Optional detector sample-fps override for this scenario.
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
    variant_id: str = "baseline"
    profile_id: str = "baseline"
    orientation: Orientation = "landscape"
    shell: ShellMode = "mobile_app"
    logical_width: int | None = None
    logical_height: int | None = None
    encoded_width: int | None = None
    encoded_height: int | None = None
    source_fps: float | None = None
    sample_fps: float | None = None

    def __post_init__(self) -> None:
        logical_width = self.logical_width if self.logical_width is not None else self.width
        logical_height = self.logical_height if self.logical_height is not None else self.height
        encoded_width = self.encoded_width if self.encoded_width is not None else self.width
        encoded_height = self.encoded_height if self.encoded_height is not None else self.height
        source_fps = self.source_fps if self.source_fps is not None else self.fps
        orientation: Orientation = "portrait" if logical_height >= logical_width else "landscape"
        object.__setattr__(self, "logical_width", logical_width)
        object.__setattr__(self, "logical_height", logical_height)
        object.__setattr__(self, "encoded_width", encoded_width)
        object.__setattr__(self, "encoded_height", encoded_height)
        object.__setattr__(self, "source_fps", source_fps)
        object.__setattr__(self, "orientation", orientation)


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
