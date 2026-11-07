"""What the Docker image relies on: the run queue, server settings, serving the built frontend, and backups."""

from __future__ import annotations

import sqlite3
import threading
import time
from dataclasses import replace
from pathlib import Path

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

import app.backup as backup
import app.config as config
import app.main as main
from app.services.jobs import JobManager


def _import(client: TestClient, video_factory, name: str = 'queued.mp4') -> dict:
    project = client.post('/projects', json={'name': 'Queue'}).json()
    video = video_factory(name, ['red', 'blue'])
    with video.open('rb') as handle:
        response = client.post(
            '/recordings/import',
            data={'project_id': project['id']},
            files={'file': (name, handle, 'video/mp4')},
        )
    assert response.status_code == 200, response.text
    return response.json()


def _wait_until(predicate, timeout: float = 5.0) -> None:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if predicate():
            return
        time.sleep(0.02)
    raise AssertionError('condition not reached in time')


# --- Job queue -----------------------------------------------------------------------------------------------


def test_slots_are_handed_out_in_start_order() -> None:
    manager = JobManager(max_concurrent_runs=1)
    assert manager.wait_for_slot('first')
    started: list[str] = []

    def run(run_id: str) -> None:
        if manager.wait_for_slot(run_id):
            started.append(run_id)
            manager.finish(run_id)

    threads = []
    for run_id in ('second', 'third', 'fourth'):
        thread = threading.Thread(target=run, args=(run_id,))
        thread.start()
        threads.append(thread)
        _wait_until(lambda run_id=run_id: manager.runs_ahead(run_id) < len(threads))
    assert manager.runs_ahead('fourth') == 2
    assert not manager.has_free_slot()

    manager.finish('first')
    for thread in threads:
        thread.join(timeout=5)
    assert started == ['second', 'third', 'fourth']
    assert manager.has_free_slot()


def test_cancelling_a_waiting_run_frees_its_place_in_line() -> None:
    manager = JobManager(max_concurrent_runs=1)
    assert manager.wait_for_slot('running')
    outcome: dict[str, bool] = {}

    def wait(run_id: str) -> None:
        outcome[run_id] = manager.wait_for_slot(run_id)

    waiting = threading.Thread(target=wait, args=('waiting',))
    behind = threading.Thread(target=wait, args=('behind',))
    waiting.start()
    _wait_until(lambda: manager.runs_ahead('behind') == 1)
    behind.start()
    _wait_until(lambda: manager.runs_ahead('nobody') == 2)

    manager.request_cancel('waiting')
    waiting.join(timeout=5)
    assert outcome['waiting'] is False
    assert manager.runs_ahead('behind') == 0

    manager.finish('running')
    behind.join(timeout=5)
    assert outcome['behind'] is True


def test_no_limit_never_blocks() -> None:
    manager = JobManager()
    assert all(manager.wait_for_slot(f'run-{index}') for index in range(20))
    assert manager.has_free_slot()


def test_a_run_waits_as_queued_and_can_be_ended_before_it_starts(client: TestClient, video_factory, wait_for_run) -> None:
    manager = JobManager(max_concurrent_runs=1)
    main.app.state.job_manager = manager
    recording = _import(client, video_factory)
    assert manager.wait_for_slot('someone-else')  # every slot taken

    run = client.post(f"/recordings/{recording['id']}/runs", json={}).json()
    _wait_until(lambda: 'Waiting for a free analysis slot' in (client.get(f"/runs/{run['id']}").json()['summary']['message'] or ''))
    summary = client.get(f"/runs/{run['id']}").json()['summary']
    assert summary['status'] == 'queued'
    assert summary['is_abortable'] is True

    assert client.post(f"/runs/{run['id']}/cancel").status_code == 200
    ended = wait_for_run(client, run['id'])['summary']
    assert ended['status'] == 'cancelled'
    assert ended['message'] == 'Run ended before it started'

    # Once the slot is free, the next run starts and finishes as usual.
    manager.finish('someone-else')
    second = client.post(f"/recordings/{recording['id']}/runs", json={}).json()
    assert wait_for_run(client, second['id'])['summary']['status'] == 'completed'


# --- Settings ------------------------------------------------------------------------------------------------


def test_server_mode_caps_runs_by_default(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv('STEPTHROUGH_MAX_CONCURRENT_RUNS', raising=False)
    monkeypatch.delenv('STEPTHROUGH_FRONTEND_DIR', raising=False)
    monkeypatch.setenv('STEPTHROUGH_DEPLOYMENT', 'server')
    assert config.build_server_config().max_concurrent_runs == config.DEFAULT_SERVER_MAX_CONCURRENT_RUNS
    monkeypatch.setenv('STEPTHROUGH_DEPLOYMENT', 'local')
    assert config.build_server_config().max_concurrent_runs is None

    monkeypatch.setenv('STEPTHROUGH_MAX_CONCURRENT_RUNS', '4')
    assert config.build_server_config().max_concurrent_runs == 4
    monkeypatch.setenv('STEPTHROUGH_MAX_CONCURRENT_RUNS', '0')
    assert config.build_server_config().max_concurrent_runs is None
    for bad in ('-1', 'two'):
        monkeypatch.setenv('STEPTHROUGH_MAX_CONCURRENT_RUNS', bad)
        with pytest.raises(ValueError, match='STEPTHROUGH_MAX_CONCURRENT_RUNS'):
            config.build_server_config()


def test_frontend_dir_must_hold_a_build(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv('STEPTHROUGH_FRONTEND_DIR', str(tmp_path))
    with pytest.raises(ValueError, match='index.html'):
        config.build_server_config()
    (tmp_path / 'index.html').write_text('<!doctype html>')
    assert config.build_server_config().frontend_dir == tmp_path.resolve()


# --- Serving the built frontend ------------------------------------------------------------------------------


@pytest.fixture()
def built_frontend(tmp_path: Path) -> Path:
    dist = tmp_path / 'dist'
    (dist / 'assets').mkdir(parents=True)
    (dist / 'index.html').write_text('<!doctype html><title>Stepthrough</title>')
    (dist / 'assets' / 'index-abc123.js').write_text('console.log(1)')
    (dist / 'icon.svg').write_text('<svg/>')
    return dist


def test_root_serves_the_frontend_when_one_is_configured(client: TestClient, built_frontend: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    assert client.get('/').json() == {'app': 'stepthrough', 'status': 'ok'}
    monkeypatch.setattr(main, 'server_config', replace(main.server_config, frontend_dir=built_frontend))
    response = client.get('/')
    assert response.status_code == 200
    assert '<title>Stepthrough</title>' in response.text
    assert response.headers['cache-control'] == 'no-cache'


def test_frontend_assets_are_cached_and_api_routes_still_win(tmp_path: Path, built_frontend: Path) -> None:
    media = tmp_path / 'projects'
    media.mkdir()
    (media / 'shot.png').write_bytes(b'png')
    app = FastAPI()

    @app.get('/projects')
    def projects() -> list[str]:
        return ['api']

    app.mount('/assets/projects', main.StaticFiles(directory=str(media)), name='assets')
    main.mount_frontend(app, built_frontend)
    client = TestClient(app)

    asset = client.get('/assets/index-abc123.js')
    assert asset.status_code == 200
    assert asset.headers['cache-control'] == 'public, max-age=31536000, immutable'
    assert client.get('/icon.svg').headers['cache-control'] == 'no-cache'
    assert client.get('/assets/projects/shot.png').content == b'png'
    assert client.get('/projects').json() == ['api']
    assert client.get('/assets/missing.js').status_code == 404


# --- Database ------------------------------------------------------------------------------------------------


def test_database_uses_write_ahead_logging(client: TestClient) -> None:
    with sqlite3.connect(config.DB_PATH) as conn:
        assert conn.execute('PRAGMA journal_mode').fetchone()[0] == 'wal'


def test_backup_copies_the_live_database(client: TestClient, tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(backup, 'DB_PATH', config.DB_PATH)
    client.post('/projects', json={'name': 'Backed up'})
    copy = backup.backup_database(tmp_path / 'backups')
    with sqlite3.connect(copy) as conn:
        assert [row[0] for row in conn.execute('SELECT name FROM projects')] == ['Backed up']
