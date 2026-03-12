from __future__ import annotations

import time

from fastapi.testclient import TestClient


def _create_project(client: TestClient, name: str) -> dict:
    response = client.post('/projects', json={'name': name})
    assert response.status_code == 200
    return response.json()


def _import_video(client: TestClient, project_id: str, path) -> dict:
    with path.open('rb') as handle:
        response = client.post(
            '/recordings/import',
            files={'file': (path.name, handle, 'video/mp4')},
            data={'project_id': project_id},
        )
    assert response.status_code == 200
    return response.json()


def test_project_summary_reports_counts_and_last_activity(client: TestClient, video_factory) -> None:
    project = _create_project(client, 'Entry Summary')

    project_index = client.get('/projects')
    assert project_index.status_code == 200
    summary = next(item for item in project_index.json() if item['id'] == project['id'])
    assert summary['recording_count'] == 0
    assert summary['run_count'] == 0
    assert summary['last_activity_at'] == summary['created_at']

    video = video_factory('project-summary.mp4', ['red', 'blue'])
    recording = _import_video(client, project['id'], video)

    project_detail = client.get(f"/projects/{project['id']}")
    assert project_detail.status_code == 200
    updated_summary = project_detail.json()['project']
    assert updated_summary['recording_count'] == 1
    assert updated_summary['run_count'] == 0
    assert updated_summary['last_activity_at'] >= recording['created_at']

    run_response = client.post(
        f"/recordings/{recording['id']}/runs",
        json={'tolerance': 50, 'min_scene_gap_ms': 900, 'sample_fps': 4, 'detector_mode': 'content', 'extract_offset_ms': 200},
    )
    assert run_response.status_code == 200
    run = run_response.json()

    refreshed_detail = client.get(f"/projects/{project['id']}")
    assert refreshed_detail.status_code == 200
    refreshed_summary = refreshed_detail.json()['project']
    assert refreshed_summary['recording_count'] == 1
    assert refreshed_summary['run_count'] == 1
    assert refreshed_summary['last_activity_at'] >= run['updated_at']


def test_project_index_orders_by_last_activity_without_overcounting_runs(client: TestClient, video_factory) -> None:
    first_project = _create_project(client, 'First Project')
    time.sleep(0.01)
    second_project = _create_project(client, 'Second Project')

    first_video = video_factory('first-project.mp4', ['red', 'green'])
    first_recording = _import_video(client, first_project['id'], first_video)

    for _ in range(2):
        response = client.post(
            f"/recordings/{first_recording['id']}/runs",
            json={'tolerance': 40, 'min_scene_gap_ms': 500, 'sample_fps': 5, 'detector_mode': 'content', 'extract_offset_ms': 150},
        )
        assert response.status_code == 200

    project_index = client.get('/projects')
    assert project_index.status_code == 200
    projects = project_index.json()

    first_summary = next(item for item in projects if item['id'] == first_project['id'])
    second_summary = next(item for item in projects if item['id'] == second_project['id'])

    assert first_summary['recording_count'] == 1
    assert first_summary['run_count'] == 2
    assert second_summary['recording_count'] == 0
    assert second_summary['run_count'] == 0
    assert projects[0]['id'] == first_project['id']
