"""Signals shared by long-running jobs: progress reporting and cancellation."""

from __future__ import annotations

from typing import Callable

# (phase, message, progress 0-1, level)
ProgressCallback = Callable[[str, str, float, str], None]
CancellationCallback = Callable[[], bool]


class CancellationRequested(RuntimeError):
    pass
