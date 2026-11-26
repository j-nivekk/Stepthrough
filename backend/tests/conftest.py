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
    monkeypatch.setattr(main, '_start_background_ocr_probe', lambda: None)
    monkeypatch.setattr(main, '_start_account_cleanup', lambda: None)
    # Runs build the working copy themselves; a background transcode would outlive the test's tmp dir.
    monkeypatch.setattr(main, '_start_background_ingest', lambda recording_id: None)

    with TestClient(main.app) as test_client:
        main._set_ocr_state(
            main.OcrHealthState(
                status='unavailable',
                available=False,
                message='OCR disabled in tests by default; enable it explicitly in OCR-specific cases.',
            )
        )
        try:
            yield test_client
        finally:
            # A few tests only check queuing/counts. Their workers must finish before the next test swaps
            # the database path and job manager; otherwise they can write into the next test's database.
            manager = main._job_manager()
            with manager._lock:
                workers = list(manager._threads.items())
            for run_id, _worker in workers:
                manager.request_cancel(run_id)
            for _run_id, worker in workers:
                worker.join(timeout=15)
                assert not worker.is_alive(), 'analysis worker outlived its test'


class FakeReader:
    """Stands in for the process that reads text (services/text_queue.py): answers with what ``answer`` gives for a
    screenshot, and keeps which screenshots it was asked for, in order."""

    asked: list = []
    started: list = []

    def __init__(self, models, threads: int) -> None:
        self.threads = threads
        self.stopped = False
        FakeReader.started.append(self)

    @staticmethod
    def answer(screen) -> dict | None:
        return {'lines': [['sample text', 10, 20, 90, 18, 0.98]], 'width': 640, 'height': 360, 'memory_mb': 100}

    def read(self, screen) -> dict | None:
        FakeReader.asked.append(screen)
        return FakeReader.answer(screen)

    def stop(self) -> None:
        self.stopped = True


@pytest.fixture()
def fake_reader(monkeypatch: pytest.MonkeyPatch) -> type[FakeReader]:
    """Text is read by FakeReader, and text recognition is available."""
    import app.main as main
    import app.services.text_models as text_models
    import app.services.text_queue as text_queue

    answer = FakeReader.answer
    FakeReader.asked, FakeReader.started = [], []
    monkeypatch.setattr(text_queue, 'Reader', FakeReader)
    monkeypatch.setattr(text_models, 'ensure', lambda: Path('.'))
    main._set_ocr_state(main.OcrHealthState(status='available', available=True, message='Text recognition works.'))
    yield FakeReader
    FakeReader.answer = staticmethod(answer)


@pytest.fixture()
def wait_for_text():
    """Wait until nothing of a run is waiting to be read; returns its summary."""

    def _wait(client: TestClient, run_id: str) -> dict:
        import app.main as main

        for _ in range(200):
            summary = client.get(f'/runs/{run_id}').json()['summary']
            if summary['text']['waiting'] == 0 and not main._text_reading()._queue.has(run_id):
                return summary
            time.sleep(0.02)
        raise AssertionError(f'the text was not read in time: {summary["text"]}')

    return _wait


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
