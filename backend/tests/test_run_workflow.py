from __future__ import annotations

import time
from threading import Event

from fastapi.testclient import TestClient


def _set_ocr_state(main, *, status: str, available: bool | None, message: str, warnings: tuple[str, ...] = ()) -> None:
    main._set_ocr_state(
        main.OcrHealthState(
            status=status,
            available=available,
            message=message,
            warnings=warnings,
        )
    )


def _configure_test_paths(monkeypatch, tmp_path):
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
    return main


def test_health_reports_ocr_availability(client: TestClient, monkeypatch) -> None:
    import app.main as main

    _set_ocr_state(
        main,
        status='unavailable',
        available=False,
        message='Unsupported Paddle OCR stack in the backend Python environment. Install paddlepaddle==3.3.0 and paddleocr==3.3.0.',
    )

    response = client.get('/health')

    assert response.status_code == 200
    assert response.json()['ocr_status'] == 'unavailable'
    assert response.json()['ocr_available'] is False
    assert 'Unsupported Paddle OCR stack' in response.json()['ocr_message']
    assert response.json()['ocr_warnings'] == []


def test_health_returns_checking_while_background_probe_runs(monkeypatch, tmp_path) -> None:
    import app.main as main
    import app.services.hybrid_detection as hybrid_detection

    main = _configure_test_paths(monkeypatch, tmp_path)
    allow_probe_to_finish = Event()
    probe_started = Event()

    def slow_probe():
        probe_started.set()
        allow_probe_to_finish.wait(timeout=1.0)
        return hybrid_detection.PaddleOcrProbeResult(available=True, message='PaddleOCR ready.', warnings=('ccache warning',))

    monkeypatch.setattr(main, 'probe_paddleocr_availability', slow_probe)

    with TestClient(main.app) as client:
        assert probe_started.wait(timeout=1.0)
        response = client.get('/health')
        payload = response.json()

        assert response.status_code == 200
        assert payload['ocr_status'] == 'checking'
        assert payload['ocr_available'] is None
        assert payload['ocr_message'] == 'Checking PaddleOCR availability in the background.'
        assert payload['ocr_warnings'] == []
        allow_probe_to_finish.set()


def test_background_probe_updates_health_state(monkeypatch, tmp_path) -> None:
    import app.main as main
    import app.services.hybrid_detection as hybrid_detection

    main = _configure_test_paths(monkeypatch, tmp_path)
    monkeypatch.setattr(
        main,
        'probe_paddleocr_availability',
        lambda: hybrid_detection.PaddleOcrProbeResult(
            available=False,
            message='PaddleOCR is unavailable.',
            warnings=('No ccache found.', 'Requests dependency mismatch.'),
        ),
    )

    with TestClient(main.app) as client:
        for _ in range(20):
            payload = client.get('/health').json()
            if payload['ocr_status'] != 'checking':
                break
            time.sleep(0.02)
        else:
            raise AssertionError('OCR status did not leave checking state')

    assert payload['ocr_status'] == 'unavailable'
    assert payload['ocr_available'] is False
    assert payload['ocr_message'] == 'PaddleOCR is unavailable.'
    assert payload['ocr_warnings'] == ['No ccache found.', 'Requests dependency mismatch.']



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


def test_hybrid_run_locks_ocr_off_when_unavailable(
    client: TestClient,
    video_factory,
    wait_for_run,
    monkeypatch,
) -> None:
    import app.main as main

    _set_ocr_state(
        main,
        status='unavailable',
        available=False,
        message='Local OCR mode requires both STEPTHROUGH_OCR_DET_MODEL_DIR and STEPTHROUGH_OCR_REC_MODEL_DIR.',
    )

    project = _create_project(client)
    video = video_factory('hybrid-ocr-lock.mp4', ['black', 'white'])
    recording = _import_video(client, project['id'], video)

    response = client.post(
        f"/recordings/{recording['id']}/runs",
        json={
            'analysis_engine': 'hybrid_v2',
            'analysis_preset': 'balanced',
            'advanced': {'enable_ocr': True, 'ocr_backend': 'paddleocr'},
            'tolerance': 50,
            'min_scene_gap_ms': 900,
            'sample_fps': 4,
            'detector_mode': 'content',
            'extract_offset_ms': 200,
        },
    )
    run = response.json()
    detail = wait_for_run(client, run['id'])

    assert response.status_code == 200
    assert run['advanced']['enable_ocr'] is False
    assert run['advanced']['ocr_backend'] is None
    assert detail['summary']['advanced']['enable_ocr'] is False
    assert detail['summary']['advanced']['ocr_backend'] is None


def test_hybrid_run_emits_warning_and_continues_when_ocr_init_fails(
    client: TestClient,
    video_factory,
    wait_for_run,
    monkeypatch,
) -> None:
    import app.main as main
    import app.services.hybrid_detection as hybrid_detection

    _set_ocr_state(
        main,
        status='available',
        available=True,
        message='PaddleOCR 3.3.0 is configured through the backend environment. First use may initialize or download models.',
    )
    monkeypatch.setattr(hybrid_detection, '_maybe_load_ocr_engine', lambda config: (None, 'model bootstrap failed'))

    project = _create_project(client)
    video = video_factory('hybrid-ocr-warning.mp4', ['black', 'white'])
    recording = _import_video(client, project['id'], video)

    response = client.post(
        f"/recordings/{recording['id']}/runs",
        json={
            'analysis_engine': 'hybrid_v2',
            'analysis_preset': 'balanced',
            'advanced': {'enable_ocr': True, 'ocr_backend': 'paddleocr'},
            'tolerance': 50,
            'min_scene_gap_ms': 900,
            'sample_fps': 4,
            'detector_mode': 'content',
            'extract_offset_ms': 200,
        },
    )
    run = response.json()
    detail = wait_for_run(client, run['id'])

    assert response.status_code == 200
    assert detail['summary']['status'] == 'completed'
    assert any(event['level'] == 'warning' and 'OCR disabled: model bootstrap failed' in event['message'] for event in detail['events'])
    assert detail['candidates']


def test_hybrid_run_reports_when_ocr_is_invoked(
    client: TestClient,
    video_factory,
    wait_for_run,
    monkeypatch,
) -> None:
    import app.main as main
    import app.services.hybrid_detection as hybrid_detection

    class FakeOcrEngine:
        def extract_text(self, _image):
            return 'sample text'

    _set_ocr_state(
        main,
        status='available',
        available=True,
        message='PaddleOCR 3.3.0 is configured through the backend environment. First use may initialize or download models.',
    )
    monkeypatch.setattr(hybrid_detection, '_maybe_load_ocr_engine', lambda config: (FakeOcrEngine(), None))

    project = _create_project(client)
    video = video_factory('hybrid-ocr-invoked.mp4', ['black', 'white'])
    recording = _import_video(client, project['id'], video)

    response = client.post(
        f"/recordings/{recording['id']}/runs",
        json={
            'analysis_engine': 'hybrid_v2',
            'analysis_preset': 'balanced',
            'advanced': {'enable_ocr': True, 'ocr_backend': 'paddleocr'},
            'tolerance': 50,
            'min_scene_gap_ms': 900,
            'sample_fps': 4,
            'detector_mode': 'content',
            'extract_offset_ms': 200,
        },
    )
    run = response.json()
    detail = wait_for_run(client, run['id'])

    assert response.status_code == 200
    assert detail['summary']['status'] == 'completed'
    assert any('OCR enabled with PaddleOCR' in event['message'] for event in detail['events'])
    assert any('OCR invoked ' in event['message'] for event in detail['events'])


def test_hybrid_min_scene_gap_reduces_close_candidates(client: TestClient, video_factory, wait_for_run) -> None:
    project = _create_project(client)
    video = video_factory('hybrid-gap.mp4', ['black', 'white', 'black', 'white'], segment_duration=0.45)
    recording = _import_video(client, project['id'], video)

    base_payload = {
        'analysis_engine': 'hybrid_v2',
        'analysis_preset': 'subtle_ui',
        'advanced': {
            'enable_ocr': False,
            'sample_fps_override': 12,
            'min_dwell_ms': 0,
            'settle_window_ms': 100,
        },
        'tolerance': 50,
        'sample_fps': 4,
        'detector_mode': 'content',
        'extract_offset_ms': 0,
    }

    run_without_gap = client.post(
        f"/recordings/{recording['id']}/runs",
        json={**base_payload, 'min_scene_gap_ms': 0},
    ).json()
    detail_without_gap = wait_for_run(client, run_without_gap['id'])

    run_with_gap = client.post(
        f"/recordings/{recording['id']}/runs",
        json={**base_payload, 'min_scene_gap_ms': 900},
    ).json()
    detail_with_gap = wait_for_run(client, run_with_gap['id'])

    assert detail_without_gap['summary']['status'] == 'completed'
    assert detail_with_gap['summary']['status'] == 'completed'
    assert len(detail_without_gap['candidates']) > len(detail_with_gap['candidates'])


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
