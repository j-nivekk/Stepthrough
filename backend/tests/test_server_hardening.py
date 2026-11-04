from __future__ import annotations

from dataclasses import replace

from fastapi.testclient import TestClient

import app.main as main
import app.storage as storage
from app.repository import create_project, create_recording, create_run, get_run, list_run_events
from app.models import RunSettings


def _import(client: TestClient, video_factory, name: str = 'flow.mp4') -> dict:
    project = client.post('/projects', json={'name': 'Hardening'}).json()
    video = video_factory(name, ['red', 'blue'])
    with video.open('rb') as handle:
        response = client.post(
            '/recordings/import',
            data={'project_id': project['id']},
            files={'file': (name, handle, 'video/mp4')},
        )
    assert response.status_code == 200, response.text
    return response.json()


def test_database_and_models_are_not_served_as_assets(client: TestClient) -> None:
    client.post('/projects', json={'name': 'Private'})
    assert client.get('/assets/stepthrough.sqlite3').status_code == 404
    assert client.get('/assets/projects/../stepthrough.sqlite3').status_code == 404


def test_reset_requires_confirmation_header(client: TestClient) -> None:
    client.post('/projects', json={'name': 'Keep me'})
    assert client.post('/admin/reset-db').status_code == 400
    assert len(client.get('/projects').json()) == 1

    assert client.post('/admin/reset-db', headers={'X-Stepthrough-Confirm': 'reset-database'}).status_code == 204
    assert client.get('/projects').json() == []


def test_reset_is_disabled_when_configured_off(client: TestClient, monkeypatch) -> None:
    monkeypatch.setattr(main, 'server_config', replace(main.server_config, allow_admin_reset=False))
    response = client.post('/admin/reset-db', headers={'X-Stepthrough-Confirm': 'reset-database'})
    assert response.status_code == 403


def test_cors_only_allows_configured_origins(client: TestClient) -> None:
    allowed = client.get('/projects', headers={'Origin': 'http://localhost:5173'})
    assert allowed.headers.get('access-control-allow-origin') == 'http://localhost:5173'
    other = client.get('/projects', headers={'Origin': 'https://elsewhere.example'})
    assert 'access-control-allow-origin' not in other.headers
    preflight = client.options(
        '/admin/reset-db',
        headers={
            'Origin': 'https://elsewhere.example',
            'Access-Control-Request-Method': 'POST',
            'Access-Control-Request-Headers': 'x-stepthrough-confirm',
        },
    )
    assert preflight.status_code == 400


def test_oversized_upload_is_rejected_and_cleaned_up(client: TestClient, video_factory, monkeypatch, tmp_path) -> None:
    monkeypatch.setattr(main, 'server_config', replace(main.server_config, max_upload_bytes=1024))
    project = client.post('/projects', json={'name': 'Limits'}).json()
    video = video_factory('big.mp4', ['red', 'blue', 'green'])
    with video.open('rb') as handle:
        response = client.post(
            '/recordings/import',
            data={'project_id': project['id']},
            files={'file': ('big.mp4', handle, 'video/mp4')},
        )
    assert response.status_code == 413
    assert 'upload limit' in response.json()['detail']
    assert client.get(f"/projects/{project['id']}").json()['recordings'] == []


def test_runs_interrupted_by_a_restart_are_marked_failed(client: TestClient) -> None:
    project = create_project('Restart')
    recording = create_recording(
        project_id=project['id'], filename='x.mp4', slug='x', source_path='projects/x.mp4',
        duration_ms=1000, width=10, height=10, fps=30.0,
    )
    run = create_run(recording['id'], RunSettings())
    assert get_run(run['id'])['status'] == 'queued'

    main.startup()

    interrupted = get_run(run['id'])
    assert (interrupted['status'], interrupted['phase']) == ('failed', 'failed')
    assert 'restarted' in interrupted['message']
    assert list_run_events(run['id'])[-1]['level'] == 'error'


def test_runs_use_the_working_copy_and_serve_it_for_preview(client: TestClient, video_factory, wait_for_run) -> None:
    recording = _import(client, video_factory)
    assert recording['source_url'].endswith('/flow.mp4')

    run = client.post(f"/recordings/{recording['id']}/runs", json={'analysis_engine': 'hybrid_v2'}).json()
    detail = wait_for_run(client, run['id'])
    assert detail['summary']['status'] == 'completed', detail['summary']['message']
    assert any('working copy' in event['message'] for event in detail['events'])

    refreshed = client.get(f"/recordings/{recording['id']}").json()
    assert refreshed['source_url'].endswith('/working/working.mp4')
    assert refreshed['fps'] == 25.0  # constant-rate sources under the 30 fps cap keep their own rate
    # The /assets mount is bound to the real data root at import time, so check the file on disk here.
    relative = refreshed['source_url'].removeprefix('/assets/')
    assert (storage.DATA_ROOT / relative).stat().st_size > 0
