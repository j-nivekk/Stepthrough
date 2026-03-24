from __future__ import annotations

import subprocess
import time
from pathlib import Path

import pytest
from fastapi.testclient import TestClient


@pytest.fixture()
def client(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> TestClient:
    import app.config as config
    import app.database as database
    import app.main as main
    import app.storage as storage

    data_root = tmp_path / 'data'
    db_path = data_root / 'stepthrough.sqlite3'

    monkeypatch.setattr(config, 'DATA_ROOT', data_root)
    monkeypatch.setattr(config, 'DB_PATH', db_path)
    monkeypatch.setattr(database, 'DB_PATH', db_path)
    monkeypatch.setattr(storage, 'DATA_ROOT', data_root)
    monkeypatch.setattr(main, 'DATA_ROOT', data_root)

    with TestClient(main.app) as test_client:
        main.app.state.ocr_available = False
        main.app.state.ocr_message = 'OCR disabled in tests by default; enable it explicitly in OCR-specific cases.'
        yield test_client


@pytest.fixture()
def video_factory(tmp_path: Path):
    def create_video(filename: str, colors: list[str], segment_duration: float = 1.0) -> Path:
        output_path = tmp_path / filename
        command = ['ffmpeg', '-hide_banner', '-loglevel', 'error', '-y']
        filter_inputs: list[str] = []
        for color in colors:
            command.extend(['-f', 'lavfi', '-i', f'color=c={color}:s=640x360:d={segment_duration}'])
            filter_inputs.append(f'[{len(filter_inputs)}:v]')
        command.extend(['-filter_complex', f"{''.join(filter_inputs)}concat=n={len(colors)}:v=1:a=0", str(output_path)])
        subprocess.run(command, check=True)
        return output_path

    return create_video


@pytest.fixture()
def wait_for_run():
    def _wait(client: TestClient, run_id: str, terminal_states: set[str] | None = None) -> dict:
        terminal_states = terminal_states or {'completed', 'failed', 'cancelled'}
        for _ in range(120):
            detail = client.get(f'/runs/{run_id}').json()
            if detail['summary']['status'] in terminal_states:
                return detail
            time.sleep(0.1)
        raise AssertionError('run did not reach a terminal state in time')

    return _wait
