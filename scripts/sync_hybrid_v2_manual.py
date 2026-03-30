from __future__ import annotations

import sys
from pathlib import Path


def main() -> int:
    repo_root = Path(__file__).resolve().parents[1]
    backend_root = repo_root / "backend"
    sys.path.insert(0, str(backend_root))

    from app.analysis_metadata import (  # pylint: disable=import-outside-toplevel
        MANUAL_HYBRID_PRESETS_END,
        MANUAL_HYBRID_PRESETS_START,
        render_manual_hybrid_v2_presets_section,
    )

    manual_path = repo_root / "manual.md"
    manual_text = manual_path.read_text()

    start_marker = MANUAL_HYBRID_PRESETS_START
    end_marker = MANUAL_HYBRID_PRESETS_END
    start_index = manual_text.find(start_marker)
    end_index = manual_text.find(end_marker)
    if start_index == -1 or end_index == -1 or end_index < start_index:
        raise RuntimeError("Could not find generated hybrid preset markers in manual.md.")

    end_index += len(end_marker)
    generated_block = "\n".join(
        [
            start_marker,
            render_manual_hybrid_v2_presets_section(),
            end_marker,
        ]
    )
    updated_text = manual_text[:start_index] + generated_block + manual_text[end_index:]
    manual_path.write_text(updated_text)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
