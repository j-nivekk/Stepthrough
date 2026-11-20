"""Make the sample project file of the current format version, for tests/test_project_file.py.

Run it once when FORMAT_VERSION goes up, from backend/:

    uv run python tests/project_files/make_sample.py

and commit the new file next to the older ones, which stay: every later version must still open them. The sample
is made up (a few seconds of coloured video), so it holds nothing of anyone's.
"""

from __future__ import annotations

import subprocess
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).parent
sys.path.insert(0, str(HERE.parent.parent))


def main() -> None:
    with tempfile.TemporaryDirectory() as folder:
        root = Path(folder).resolve()
        import app.config as config
        import app.database as database
        import app.main as main_module
        import app.storage as storage

        data = root / "data"
        for module, name, value in (
            (config, "DATA_ROOT", data),
            (config, "DB_PATH", data / "stepthrough.sqlite3"),
            (database, "DB_PATH", data / "stepthrough.sqlite3"),
            (storage, "DATA_ROOT", data),
            (main_module, "DATA_ROOT", data),
        ):
            setattr(module, name, value)
        main_module._start_background_ocr_probe = lambda: None
        main_module._start_account_cleanup = lambda: None
        main_module._start_background_ingest = lambda recording_id: None

        from fastapi.testclient import TestClient

        from app import project_file

        video = root / "sample.mp4"
        inputs = []
        for color in ("white", "skyblue", "orange", "white"):
            inputs += ["-f", "lavfi", "-i", f"color=c={color}:s=96x54:d=0.5"]
        joined = "".join(f"[{index}:v]" for index in range(4))
        subprocess.run(
            ["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", *inputs,
             "-filter_complex", f"{joined}concat=n=4:v=1:a=0", "-pix_fmt", "yuv420p", str(video)],
            check=True,
        )

        with TestClient(main_module.app) as client:
            def ok(response):
                assert response.status_code in (200, 204), response.text
                return response.json() if response.status_code == 200 else None

            project = ok(client.post("/projects", json={"name": "Sample project"}))["id"]
            recording = ok(client.post(
                "/recordings/import", data={"project_id": project}, files={"file": ("sample.mp4", video.read_bytes(), "video/mp4")}
            ))["id"]
            run = ok(client.post(f"/recordings/{recording}/runs/manual"))["id"]
            steps = [ok(client.post(f"/runs/{run}/candidates/manual", json={"timestamp_ms": 200 + 500 * i}))["id"] for i in range(4)]
            ok(client.post(f"/runs/{run}/candidates/status", json={"candidate_ids": steps[:3], "status": "accepted"}))
            ok(client.post(f"/runs/{run}/candidates/status", json={"candidate_ids": steps[3:], "status": "rejected"}))
            ok(client.patch(f"/candidates/{steps[0]}", json={"title": "start", "notes": "a made-up first screen"}))
            ok(client.patch(f"/candidates/{steps[1]}", json={"title": "form", "screen_kind": "popup"}))
            ok(client.patch(f"/candidates/{steps[2]}", json={"screen_link": steps[0], "pathway_row": "below"}))
            ok(client.patch(f"/runs/{run}", json={"name": "sample run"}))
            ok(client.put(f"/runs/{run}/phases", json={"name": "sign up", "first_step": steps[0], "last_step": steps[1]}))
            data_bytes = client.get(f"/projects/{project}/project-file").content

        target = HERE / f"v{project_file.FORMAT_VERSION}.stepthrough.zip"
        target.write_bytes(data_bytes)
        print(f"wrote {target} ({len(data_bytes) // 1024} KB)")


if __name__ == "__main__":
    main()
