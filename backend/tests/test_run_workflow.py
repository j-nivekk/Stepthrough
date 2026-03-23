from __future__ import annotations

import time

from fastapi.testclient import TestClient



def _create_project(client: TestClient) -> dict:
    response = client.post('/projects', json={'name': 'Workflow Test'})
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



def test_single_scene_run_completes_and_persists_log_events(client: TestClient, video_factory, wait_for_run) -> None:
    project = _create_project(client)
    video = video_factory('single-scene.mp4', ['red'])
    recording = _import_video(client, project['id'], video)

    run = client.post(
        f"/recordings/{recording['id']}/runs",
        json={'tolerance': 50, 'min_scene_gap_ms': 900, 'sample_fps': 4, 'detector_mode': 'content', 'extract_offset_ms': 200},
    ).json()

    detail = wait_for_run(client, run['id'])

    assert detail['summary']['status'] == 'completed'
    assert detail['summary']['phase'] == 'completed'
    assert detail['summary']['progress'] == 1.0
    assert detail['summary']['candidate_count'] == 1
    assert any(event['phase'] == 'primary_scan' for event in detail['events'])
    assert any(event['phase'] == 'completed' for event in detail['events'])



def test_hybrid_run_completes_and_serializes_engine_metadata(client: TestClient, video_factory, wait_for_run) -> None:
    project = _create_project(client)
    video = video_factory('hybrid-workflow.mp4', ['black', 'white'])
    recording = _import_video(client, project['id'], video)

    run = client.post(
        f"/recordings/{recording['id']}/runs",
        json={
            'analysis_engine': 'hybrid_v2',
            'analysis_preset': 'balanced',
            'advanced': {'enable_ocr': False},
            'tolerance': 50,
            'min_scene_gap_ms': 900,
            'sample_fps': 4,
            'detector_mode': 'content',
            'extract_offset_ms': 200,
        },
    ).json()

    detail = wait_for_run(client, run['id'])

    assert detail['summary']['status'] == 'completed'
    assert detail['summary']['analysis_engine'] == 'hybrid_v2'
    assert detail['summary']['analysis_preset'] == 'balanced'
    assert detail['summary']['advanced']['enable_ocr'] is False
    assert detail['candidates']
    assert detail['candidates'][0]['score_breakdown'] is not None


def test_run_creation_defaults_to_hybrid_v2_engine(client: TestClient, video_factory, wait_for_run) -> None:
    project = _create_project(client)
    video = video_factory('default-engine.mp4', ['red'])
    recording = _import_video(client, project['id'], video)

    response = client.post(
        f"/recordings/{recording['id']}/runs",
        json={'tolerance': 50, 'min_scene_gap_ms': 900, 'sample_fps': 4, 'detector_mode': 'content', 'extract_offset_ms': 200},
    )

    assert response.status_code == 200
    run = response.json()
    assert run['analysis_engine'] == 'hybrid_v2'
    assert run['analysis_preset'] == 'balanced'
    detail = wait_for_run(client, run['id'])
    assert detail['summary']['analysis_engine'] == 'hybrid_v2'


def test_delete_project_removes_it_and_its_recordings(client: TestClient, video_factory) -> None:
    project = _create_project(client)
    video = video_factory('project-delete.mp4', ['red'])
    recording = _import_video(client, project['id'], video)

    delete_response = client.delete(f"/projects/{project['id']}")
    assert delete_response.status_code == 204

    missing_project_response = client.get(f"/projects/{project['id']}")
    assert missing_project_response.status_code == 404

    missing_recording_response = client.get(f"/recordings/{recording['id']}")
    assert missing_recording_response.status_code == 404


def test_project_delete_blocks_while_any_run_is_active(client: TestClient, video_factory, wait_for_run, monkeypatch) -> None:
    import app.main as main
    from app.services.detection import CancellationRequested

    original_detect = main.detect_candidates

    def slow_detect_candidates(*, progress_callback, cancellation_callback, **kwargs):
        progress_callback('primary_scan', 'Scanning video for interaction changes (5%)', 0.2, 'info')
        for _ in range(40):
            if cancellation_callback():
                raise CancellationRequested('Run cancelled while scanning the video.')
            time.sleep(0.05)
        return original_detect(progress_callback=progress_callback, cancellation_callback=cancellation_callback, **kwargs)

    monkeypatch.setattr(main, 'detect_candidates', slow_detect_candidates)

    project = _create_project(client)
    video = video_factory('project-delete-guard.mp4', ['red', 'blue', 'green'], segment_duration=2)
    recording = _import_video(client, project['id'], video)

    run = client.post(
        f"/recordings/{recording['id']}/runs",
        json={
            'analysis_engine': 'scene_v1',
            'tolerance': 35,
            'min_scene_gap_ms': 300,
            'sample_fps': 6,
            'detector_mode': 'content',
            'extract_offset_ms': 50,
        },
    ).json()

    time.sleep(0.2)
    delete_response = client.delete(f"/projects/{project['id']}")
    assert delete_response.status_code == 409

    cancel_response = client.post(f"/runs/{run['id']}/cancel")
    assert cancel_response.status_code == 200

    detail = wait_for_run(client, run['id'], {'cancelled'})
    assert detail['summary']['status'] == 'cancelled'

    delete_response = client.delete(f"/projects/{project['id']}")
    assert delete_response.status_code == 204


def test_abort_blocks_recording_delete_until_run_stops(client: TestClient, video_factory, wait_for_run, monkeypatch) -> None:
    import app.main as main
    from app.services.detection import CancellationRequested

    original_detect = main.detect_candidates

    def slow_detect_candidates(*, progress_callback, cancellation_callback, **kwargs):
        progress_callback('primary_scan', 'Scanning video for interaction changes (5%)', 0.2, 'info')
        for _ in range(40):
            if cancellation_callback():
                raise CancellationRequested('Run cancelled while scanning the video.')
            time.sleep(0.05)
        return original_detect(progress_callback=progress_callback, cancellation_callback=cancellation_callback, **kwargs)

    monkeypatch.setattr(main, 'detect_candidates', slow_detect_candidates)

    project = _create_project(client)
    video = video_factory('delete-guard.mp4', ['red', 'blue', 'green'], segment_duration=2)
    recording = _import_video(client, project['id'], video)

    run = client.post(
        f"/recordings/{recording['id']}/runs",
        json={
            'analysis_engine': 'scene_v1',
            'tolerance': 35,
            'min_scene_gap_ms': 300,
            'sample_fps': 6,
            'detector_mode': 'content',
            'extract_offset_ms': 50,
        },
    ).json()

    time.sleep(0.2)
    delete_response = client.delete(f"/recordings/{recording['id']}")
    assert delete_response.status_code == 409

    cancel_response = client.post(f"/runs/{run['id']}/cancel")
    assert cancel_response.status_code == 200

    detail = wait_for_run(client, run['id'], {'cancelled'})
    assert detail['summary']['status'] == 'cancelled'

    delete_response = client.delete(f"/recordings/{recording['id']}")
    assert delete_response.status_code == 204
