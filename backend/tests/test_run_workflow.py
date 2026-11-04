from __future__ import annotations

import json
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
    import app.services.ocr as ocr_module

    main = _configure_test_paths(monkeypatch, tmp_path)
    allow_probe_to_finish = Event()
    probe_started = Event()

    def slow_probe():
        probe_started.set()
        allow_probe_to_finish.wait(timeout=1.0)
        return ocr_module.PaddleOcrProbeResult(available=True, message='PaddleOCR ready.', warnings=('ccache warning',))

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
    import app.services.ocr as ocr_module

    main = _configure_test_paths(monkeypatch, tmp_path)
    monkeypatch.setattr(
        main,
        'probe_paddleocr_availability',
        lambda: ocr_module.PaddleOcrProbeResult(
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

    run = client.post(f"/recordings/{recording['id']}/runs", json={}).json()

    detail = wait_for_run(client, run['id'])

    assert detail['summary']['status'] == 'completed'
    assert detail['summary']['phase'] == 'completed'
    assert detail['summary']['progress'] == 1.0
    assert detail['summary']['candidate_count'] == 1
    assert any(event['phase'] == 'primary_scan' for event in detail['events'])
    assert any(event['phase'] == 'completed' for event in detail['events'])


def test_retired_engines_cannot_start_but_their_runs_still_open_and_export(
    client: TestClient, video_factory, wait_for_run
) -> None:
    from app.repository import update_run

    project = _create_project(client)
    video = video_factory('retired-engine.mp4', ['black', 'white'])
    recording = _import_video(client, project['id'], video)

    for engine in ('hybrid_v2', 'scene_v1'):
        response = client.post(f"/recordings/{recording['id']}/runs", json={'analysis_engine': engine})
        assert response.status_code == 422
        assert 'retired' in response.json()['detail']

    # A run made before the engines were retired: rewrite a finished run's stored settings to hybrid v2.
    run = client.post(f"/recordings/{recording['id']}/runs", json={}).json()
    detail = wait_for_run(client, run['id'])
    update_run(
        run['id'],
        analysis_engine='hybrid_v2',
        analysis_preset='balanced',
        analysis_advanced=json.dumps({'enable_ocr': False}),
        analysis_stable=None,
        analysis_config=json.dumps({'engine_version': 'hybrid_v2', 'max_frame_edge': 320}),
    )

    old = client.get(f"/runs/{run['id']}").json()
    assert old['summary']['analysis_engine'] == 'hybrid_v2'
    assert old['summary']['advanced']['enable_ocr'] is False
    assert len(old['candidates']) == len(detail['candidates'])

    export = client.post(f"/runs/{run['id']}/export", json={'mode': 'all'})
    assert export.status_code == 200
    import app.storage as storage

    manifest = json.loads((storage.DATA_ROOT / export.json()['output_dir'] / 'steps.json').read_text())
    assert manifest['run']['analysis_engine'] == 'hybrid_v2'
    assert 'scene_score' in manifest['field_notes']


def test_run_locks_ocr_off_when_unavailable(client: TestClient, video_factory, wait_for_run) -> None:
    import app.main as main

    _set_ocr_state(
        main,
        status='unavailable',
        available=False,
        message='Local OCR mode requires both STEPTHROUGH_OCR_DET_MODEL_DIR and STEPTHROUGH_OCR_REC_MODEL_DIR.',
    )

    project = _create_project(client)
    video = video_factory('ocr-lock.mp4', ['black', 'white'])
    recording = _import_video(client, project['id'], video)

    response = client.post(f"/recordings/{recording['id']}/runs", json={'stable': {'enable_ocr': True}})
    run = response.json()
    detail = wait_for_run(client, run['id'])

    assert response.status_code == 200
    assert run['stable']['enable_ocr'] is False
    assert detail['summary']['stable']['enable_ocr'] is False


def test_run_emits_warning_and_continues_when_ocr_init_fails(
    client: TestClient,
    video_factory,
    wait_for_run,
    monkeypatch,
) -> None:
    import app.main as main
    import app.services.stable_detection as stable_detection

    _set_ocr_state(main, status='available', available=True, message='PaddleOCR 3.3.0 is configured.')
    monkeypatch.setattr(stable_detection, 'load_ocr_engine', lambda: (None, 'model bootstrap failed'))

    project = _create_project(client)
    video = video_factory('ocr-warning.mp4', ['black', 'white'])
    recording = _import_video(client, project['id'], video)

    run = client.post(f"/recordings/{recording['id']}/runs", json={'stable': {'enable_ocr': True}}).json()
    detail = wait_for_run(client, run['id'])

    assert detail['summary']['status'] == 'completed'
    assert any(
        event['level'] == 'warning' and 'OCR disabled: model bootstrap failed' in event['message']
        for event in detail['events']
    )
    assert detail['candidates']


def test_run_reads_screenshot_text_when_ocr_is_on(
    client: TestClient,
    video_factory,
    wait_for_run,
    monkeypatch,
) -> None:
    import app.main as main
    import app.services.stable_detection as stable_detection

    class FakeOcrEngine:
        def extract_text(self, _image):
            return 'sample text'

    _set_ocr_state(main, status='available', available=True, message='PaddleOCR 3.3.0 is configured.')
    monkeypatch.setattr(stable_detection, 'load_ocr_engine', lambda: (FakeOcrEngine(), None))

    project = _create_project(client)
    video = video_factory('ocr-invoked.mp4', ['black', 'white'])
    recording = _import_video(client, project['id'], video)

    run = client.post(f"/recordings/{recording['id']}/runs", json={'stable': {'enable_ocr': True}}).json()
    detail = wait_for_run(client, run['id'])

    assert detail['summary']['status'] == 'completed'
    assert any('OCR read ' in event['message'] for event in detail['events'])
    from app.repository import list_candidates

    stored = list_candidates(run['id'])
    assert stored and all(candidate['ocr_text'] == 'sample text' for candidate in stored)


def test_run_creation_defaults_to_stable_v3_engine(client: TestClient, video_factory, wait_for_run) -> None:
    project = _create_project(client)
    video = video_factory('default-engine.mp4', ['red', 'blue'])
    recording = _import_video(client, project['id'], video)

    response = client.post(f"/recordings/{recording['id']}/runs", json={})

    assert response.status_code == 200
    run = response.json()
    assert run['analysis_engine'] == 'stable_v3'
    assert run['stable']['recording_type'] == 'phone'
    assert run['advanced'] is None
    detail = wait_for_run(client, run['id'])
    summary = detail['summary']
    assert summary['status'] == 'completed'
    assert summary['engine_version'].startswith('stable_v3/')
    # The resolved settings and what was measured are stored with the run, for reproducibility.
    assert summary['analysis_config']['min_dwell_ms'] == 450
    assert summary['analysis_config']['measured']['pixel_threshold'] >= 10
    breakdowns = [candidate['score_breakdown'] for candidate in detail['candidates']]
    assert [b['transition_type'] for b in breakdowns] == ['opening_screen', 'navigation']
    assert breakdowns[0]['dwell_after_ms'] >= 900


def test_stable_run_export_records_engine_and_timings(client: TestClient, video_factory, wait_for_run) -> None:
    project = _create_project(client)
    video = video_factory('export-engine.mp4', ['red', 'blue'])
    recording = _import_video(client, project['id'], video)
    run = client.post(
        f"/recordings/{recording['id']}/runs",
        json={'analysis_engine': 'stable_v3', 'stable': {'recording_type': 'desktop', 'min_dwell_ms': 500}},
    ).json()
    detail = wait_for_run(client, run['id'])
    for candidate in detail['candidates']:
        assert client.patch(f"/candidates/{candidate['id']}", json={'status': 'accepted'}).status_code == 200

    export = client.post(f"/runs/{run['id']}/export", json={'mode': 'accepted'})
    assert export.status_code == 200
    import app.storage as storage

    bundle = storage.DATA_ROOT / export.json()['output_dir']
    manifest = json.loads((bundle / 'steps.json').read_text())
    assert manifest['run']['analysis_engine'] == 'stable_v3'
    assert manifest['run']['engine_version'].startswith('stable_v3/')
    assert manifest['run']['settings']['stable']['min_dwell_ms'] == 500
    assert manifest['run']['resolved_settings']['min_change_percent'] == 0.25
    header = (bundle / 'steps.csv').read_text().splitlines()[0].split(',')
    assert {'transition_type', 'change_started_ms', 'settled_ms', 'time_on_screen_ms', 'ocr_text'} <= set(header)
    assert manifest['steps'][1]['transition_type'] == 'navigation'
    # Readable without the app: no server URLs, no settings of other engines, units explained.
    assert all('image_url' not in step and 'ocr_text' in step for step in manifest['steps'])
    assert 'detector_mode' not in manifest['run'] and 'tolerance' not in manifest['run']
    assert manifest['recording']['width'] == 640 and manifest['recording']['height'] == 360
    assert 'stayed on screen' in manifest['field_notes']['time_on_screen_ms']
    assert 'pixels of the recording' in manifest['field_notes']['score_breakdown.changed_regions']


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
    from app.services.run_control import CancellationRequested

    original_detect = main.detect_candidates_stable

    def slow_detect_candidates(*, progress_callback, cancellation_callback, **kwargs):
        progress_callback('primary_scan', 'Scanning video for stable screens (5%)', 0.2, 'info')
        for _ in range(40):
            if cancellation_callback():
                raise CancellationRequested('Run cancelled while scanning the video.')
            time.sleep(0.05)
        return original_detect(progress_callback=progress_callback, cancellation_callback=cancellation_callback, **kwargs)

    monkeypatch.setattr(main, 'detect_candidates_stable', slow_detect_candidates)

    project = _create_project(client)
    video = video_factory('project-delete-guard.mp4', ['red', 'blue', 'green'], segment_duration=2)
    recording = _import_video(client, project['id'], video)

    run = client.post(
        f"/recordings/{recording['id']}/runs",
        json={},
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
    from app.services.run_control import CancellationRequested

    original_detect = main.detect_candidates_stable

    def slow_detect_candidates(*, progress_callback, cancellation_callback, **kwargs):
        progress_callback('primary_scan', 'Scanning video for stable screens (5%)', 0.2, 'info')
        for _ in range(40):
            if cancellation_callback():
                raise CancellationRequested('Run cancelled while scanning the video.')
            time.sleep(0.05)
        return original_detect(progress_callback=progress_callback, cancellation_callback=cancellation_callback, **kwargs)

    monkeypatch.setattr(main, 'detect_candidates_stable', slow_detect_candidates)

    project = _create_project(client)
    video = video_factory('delete-guard.mp4', ['red', 'blue', 'green'], segment_duration=2)
    recording = _import_video(client, project['id'], video)

    run = client.post(
        f"/recordings/{recording['id']}/runs",
        json={},
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
