"""The process that reads the text of screenshots, started and spoken to by ``services/text_queue.py``.

It reads one screenshot at a time: a line of JSON comes in, a line of JSON goes out. Being a process of its own, it
cannot slow the web server down, or take it along when it runs out of memory or crashes on a damaged image; and when it
ends, all its memory is free again. It runs at low priority, and ends by itself when the server does (its input closes).

    python -m app.text_reader --check     # whether text can be read here, as one line of JSON
"""

from __future__ import annotations

import argparse
import json
import os
import signal
import sys
import time
from collections import OrderedDict
from pathlib import Path
from typing import Any, TextIO

KEPT_SCREENS = 3  # runs whose last screen is kept, for the lines the next one has in common with it


def memory_mb() -> int | None:
    """The most memory this process has used so far, where the system says so."""
    try:
        import resource
    except ImportError:  # Windows
        return None
    most = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
    return round(most / (1024 * 1024 if sys.platform == "darwin" else 1024))


def _low_priority() -> None:
    if hasattr(os, "nice"):  # on Windows the server starts it at a low priority
        try:
            os.nice(10)
        except OSError:
            pass


def _open_image(path: str) -> Any:
    import cv2
    import numpy as np

    # read here rather than by OpenCV, which cannot open every path on Windows
    image = cv2.imdecode(np.frombuffer(Path(path).read_bytes(), np.uint8), cv2.IMREAD_COLOR)
    if image is None:
        raise ValueError("the screenshot is not an image that can be opened")
    return image


def check() -> dict[str, Any]:
    """Whether the packages for reading text work here. Loading them is the test: one can be there and not load."""
    try:
        import cv2  # noqa: F401
        import onnxruntime
        import yaml  # noqa: F401
    except Exception as error:  # noqa: BLE001 - whatever is wrong with them, it is the answer
        return {"ok": False, "missing": getattr(error, "name", None) if isinstance(error, ModuleNotFoundError) else None,
                "error": " ".join(str(error).split()) or type(error).__name__}
    return {"ok": True, "onnxruntime": onnxruntime.__version__}


def serve(models: Path, threads: int, requests: TextIO, answers: TextIO) -> None:
    def answer(**what: Any) -> None:
        answers.write(json.dumps(what) + "\n")
        answers.flush()

    try:
        import cv2

        cv2.setNumThreads(1)
        from app.services.text_engine import Line, TextEngine

        engine = TextEngine(models, threads)
    except Exception as error:  # noqa: BLE001
        answer(ready=False, error=" ".join(str(error).split()) or type(error).__name__)
        return
    answer(ready=True)
    last: OrderedDict[str, tuple[Any, list[Line]]] = OrderedDict()
    for request in requests:
        job = json.loads(request)
        began = time.perf_counter()
        try:
            image = _open_image(job["image"])
            lines = engine.read(image, last.get(job["run"]))
        except Exception as error:  # noqa: BLE001 - this screenshot cannot be read; the next one may
            answer(id=job["id"], error=" ".join(str(error).split()) or type(error).__name__, memory_mb=memory_mb())
            continue
        last[job["run"]] = (image, lines)
        last.move_to_end(job["run"])
        while len(last) > KEPT_SCREENS:
            last.popitem(last=False)
        answer(
            id=job["id"],
            lines=[line.packed() for line in lines],
            width=image.shape[1],
            height=image.shape[0],
            reused=engine.reused,
            seconds=round(time.perf_counter() - began, 3),
            memory_mb=memory_mb(),
        )


def main() -> int:
    parser = argparse.ArgumentParser(description="Reads the text of screenshots for the Stepthrough server.")
    parser.add_argument("--check", action="store_true")
    parser.add_argument("--models", type=Path)
    parser.add_argument("--threads", type=int, default=1)
    options = parser.parse_args()
    # The answers have the output to themselves: what a library prints goes to the log, with its other messages.
    answers = os.fdopen(os.dup(1), "w", encoding="utf-8")
    os.dup2(2, 1)
    if options.check:
        answers.write(json.dumps(check()) + "\n")
        answers.flush()
        return 0
    if options.models is None:
        parser.error("--models says where the models are")
    signal.signal(signal.SIGINT, signal.SIG_IGN)  # Control-C is for the server; this ends when its input closes
    _low_priority()
    try:
        serve(options.models, options.threads, sys.stdin, answers)
    except BrokenPipeError:
        os._exit(0)  # the server is gone, and nobody is there to be answered
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
