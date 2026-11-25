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
    added = client.post(f"/runs/{run['id']}/candidates/manual", json={'timestamp_ms': 1500}).json()
    assert client.patch(f"/candidates/{added['id']}", json={'status': 'accepted'}).status_code == 200

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
    assert {'transition_type', 'change_started_ms', 'settled_ms', 'time_on_screen_ms', 'ocr_text', 'origin'} <= set(header)
    assert manifest['steps'][1]['transition_type'] == 'navigation'
    # A step added by hand says so, and has no timing of its own.
    by_origin = {step['source_candidate_id']: step for step in manifest['steps']}
    assert by_origin[added['id']]['origin'] == 'manual' and by_origin[added['id']]['settled_ms'] is None
    assert [step['origin'] for step in manifest['steps']].count('detected') == len(detail['candidates'])
    assert 'added by hand' in manifest['field_notes']['origin']
    # Readable without the app: no server URLs, no settings of other engines, units explained.
    assert all('image_url' not in step and 'ocr_text' in step for step in manifest['steps'])
    assert 'detector_mode' not in manifest['run'] and 'tolerance' not in manifest['run']
    assert manifest['recording']['width'] == 640 and manifest['recording']['height'] == 360
    assert 'stayed on screen' in manifest['field_notes']['time_on_screen_ms']
    assert 'pixels of the recording' in manifest['field_notes']['score_breakdown.changed_regions']


def test_adding_a_step_by_hand_keeps_the_detectors_revisit_links() -> None:
    import app.main as main

    def row(index: int, **extra) -> dict:
        # Every screenshot has the same hashes: compared by hash, each step looks like the first one.
        return {'id': f'c{index}', 'detector_index': index, 'candidate_origin': 'detected', 'timestamp_ms': index * 1_000,
                'scene_score': 0.5, 'score_breakdown': None, 'perceptual_hash': 'f' * 16, 'image_hash': 'f' * 16,
                'ocr_text': None, 'revisit_group_id': None, 'similar_to_candidate_id': None, **extra}

    # The detector found three different screens and one revisit (step 4 shows step 2 again).
    detected = [row(1), row(2, revisit_group_id='revisit-c2'), row(3, same_screen_reason='new'),
                row(4, revisit_group_id='revisit-c2', similar_to_candidate_id='c2', same_screen_as='c1', same_screen_reason='same_page')]
    added = row(5, id='manual', candidate_origin='manual', timestamp_ms=2_500)

    after = {c['id']: c for c in main._resequence_candidates([*detected, added], frozenset({'manual'}))}

    assert [c['id'] for c in sorted(after.values(), key=lambda c: c['detector_index'])] == ['c1', 'c2', 'manual', 'c3', 'c4']
    assert [after[key]['similar_to_candidate_id'] for key in ('c1', 'c2', 'c3', 'c4')] == [None, None, None, 'c2']
    assert after['c3']['revisit_group_id'] is None and after['c4']['revisit_group_id'] == 'revisit-c2'
    assert (after['c4']['same_screen_as'], after['c4']['same_screen_reason'], after['c3']['same_screen_reason']) == ('c1', 'same_page', 'new')
    # Only the added step is linked to its look-alike, and the two share a group.
    assert after['manual']['similar_to_candidate_id'] == 'c1'
    assert after['manual']['revisit_group_id'] == after['c1']['revisit_group_id'] == 'revisit-c1'


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


def test_terminal_status_is_published_with_its_final_event(client: TestClient, video_factory, monkeypatch) -> None:
    from contextlib import contextmanager
    import app.main as main
    import app.repository as repository

    project = _create_project(client)
    recording = _import_video(client, project['id'], video_factory('completion.mp4', ['red']))
    run = client.post(f"/recordings/{recording['id']}/runs/manual").json()
    repository.update_run(run['id'], status='running')
    connect = repository.connect
    observed = []

    class ObserveFinalEvent:
        def __init__(self, connection):
            self.connection = connection

        def execute(self, sql, *args):
            if 'INSERT INTO run_events' in sql:
                # A separate request must still see the run as active until its final log is stored. If it
                # sees "completed" first, it may delete the run under the worker's pending log insert.
                with connect() as reader:
                    observed.append(reader.execute('SELECT status FROM detection_runs WHERE id = ?', (run['id'],)).fetchone()[0])
            return self.connection.execute(sql, *args)

    @contextmanager
    def observing_connection():
        with connect() as connection:
            yield ObserveFinalEvent(connection)

    monkeypatch.setattr(repository, 'connect', observing_connection)
    main._set_run_state(run['id'], status='completed', phase='completed', message='Finished', progress=1.0)
    assert observed == ['running']
    detail = client.get(f"/runs/{run['id']}").json()
    assert detail['summary']['status'] == 'completed'
    assert detail['events'][-1]['message'] == 'Finished'


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


def test_review_carries_over_to_a_new_run_of_the_same_recording(client: TestClient, video_factory, wait_for_run) -> None:
    # After a run with other settings, the review of the first run goes to the steps it matches; steps added by
    # hand are added again; nothing already done on the new run is overwritten.
    project = _create_project(client)
    recording = _import_video(client, project['id'], video_factory('three.mp4', ['red', 'lime', 'blue']))
    first = wait_for_run(client, client.post(f"/recordings/{recording['id']}/runs", json={}).json()['id'])
    second = wait_for_run(client, client.post(f"/recordings/{recording['id']}/runs", json={}).json()['id'])
    a = sorted(first['candidates'], key=lambda c: c['timestamp_ms'])
    b = sorted(second['candidates'], key=lambda c: c['timestamp_ms'])
    assert len(a) == len(b) == 3

    client.patch(f"/candidates/{a[0]['id']}", json={'status': 'accepted', 'title': 'Red', 'notes': 'first screen'})
    client.patch(f"/candidates/{a[1]['id']}", json={'status': 'rejected', 'title': 'Lime'})
    client.patch(f"/candidates/{a[2]['id']}", json={'status': 'accepted', 'screen_link': a[0]['id']})
    manual = client.post(f"/runs/{first['summary']['id']}/candidates/manual", json={'timestamp_ms': 2500}).json()
    client.patch(f"/candidates/{manual['id']}", json={'status': 'accepted', 'title': 'Blue, later'})
    client.patch(f"/candidates/{a[0]['id']}", json={'pathway_row': 'below'})
    client.patch(f"/candidates/{a[1]['id']}", json={'returns_to': a[0]['id']})
    phase = {'name': 'Opening', 'first_step': a[0]['id'], 'last_step': a[0]['id']}
    assert client.put(f"/runs/{first['summary']['id']}/phases", json=phase).status_code == 200
    # already done on the new run: stays
    client.patch(f"/candidates/{b[1]['id']}", json={'title': 'Green'})

    pairs = [{'source_candidate_id': x['id'], 'target_candidate_id': y['id']} for x, y in zip(a, b)]
    response = client.post(f"/runs/{second['summary']['id']}/review-from", json={'source_run_id': first['summary']['id'], 'pairs': pairs})
    assert response.status_code == 200, response.text
    assert response.json() == {
        'decisions': 4, 'titles': 2, 'notes': 1, 'screen_choices': 3, 'added_manual': 1, 'unmatched': 0, 'phases': True,
    }

    after = sorted(client.get(f"/runs/{second['summary']['id']}").json()['candidates'], key=lambda c: c['timestamp_ms'])
    by_time = {c['timestamp_ms']: c for c in after}
    assert [c['status'] for c in after] == ['accepted', 'rejected', 'accepted', 'accepted']
    assert [c['title'] for c in after] == ['Red', 'Green', None, 'Blue, later']
    assert after[0]['notes'] == 'first screen'
    assert after[2]['screen_link'] == after[0]['id']  # pointed at the new run's own step
    assert after[0]['pathway_row'] == 'below'
    assert after[1]['returns_to'] == after[0]['id']
    assert by_time[2500]['candidate_origin'] == 'manual'
    # the phases go by time, so the same moments are in them
    pathway = client.get(f"/runs/{second['summary']['id']}/pathway").json()
    assert [(phase['name'], phase['first_step_index'], phase['last_step_index']) for phase in pathway['phases']] == [('Opening', 0, 0)]

    # pairs must name steps of these two runs, each once
    bad = client.post(
        f"/runs/{second['summary']['id']}/review-from",
        json={'source_run_id': first['summary']['id'], 'pairs': [pairs[0], {**pairs[1], 'target_candidate_id': b[0]['id']}]},
    )
    assert bad.status_code == 422
    assert client.post(f"/runs/{second['summary']['id']}/review-from", json={'source_run_id': second['summary']['id'], 'pairs': []}).status_code == 422


def test_runs_keep_their_number_when_renamed_or_when_another_is_deleted(client: TestClient, video_factory) -> None:
    project = _create_project(client)
    recording = _import_video(client, project['id'], video_factory('numbers.mp4', ['red']))
    runs = [client.post(f"/recordings/{recording['id']}/runs/manual").json() for _ in range(3)]
    assert [run['run_number'] for run in runs] == [1, 2, 3]
    assert [run['name'] for run in runs] == [None, None, None]

    assert client.delete(f"/runs/{runs[1]['id']}").status_code == 204
    # a new run never takes the number of a deleted one, and the others keep theirs
    assert client.post(f"/recordings/{recording['id']}/runs/manual").json()['run_number'] == 4

    renamed = client.patch(f"/runs/{runs[2]['id']}", json={'name': '  Second try  '})
    assert renamed.status_code == 200
    assert (renamed.json()['name'], renamed.json()['run_number']) == ('Second try', 3)
    listed = client.get(f"/recordings/{recording['id']}").json()['runs']
    assert sorted((run['run_number'], run['name']) for run in listed) == [(1, None), (3, 'Second try'), (4, None)]

    cleared = client.patch(f"/runs/{runs[2]['id']}", json={'name': ' '}).json()
    assert (cleared['name'], cleared['run_number']) == (None, 3)
    assert client.patch(f"/runs/{runs[2]['id']}", json={'name': 'x' * 121}).status_code == 422


def test_a_run_and_its_project_record_the_last_change_someone_made(client: TestClient, video_factory, monkeypatch) -> None:
    import app.repository as repository
    import app.storage as storage

    project = _create_project(client)
    recording = _import_video(client, project['id'], video_factory('changes.mp4', ['red', 'blue']))
    monkeypatch.setattr(repository, 'utc_now', lambda: '2026-11-18T10:00:00+00:00')
    run = client.post(f"/recordings/{recording['id']}/runs/manual").json()
    assert run['modified_at'] == '2026-11-18T10:00:00+00:00'
    # in the app without logins every change is the built-in user's, so no name is shown
    assert run['modified_by_name'] is None

    monkeypatch.setattr(repository, 'utc_now', lambda: '2026-11-18T11:00:00+00:00')
    step = client.post(f"/runs/{run['id']}/candidates/manual", json={'timestamp_ms': 400}).json()
    assert client.patch(f"/candidates/{step['id']}", json={'status': 'accepted'}).status_code == 200

    # an export leaves the run as it was
    monkeypatch.setattr(repository, 'utc_now', lambda: '2026-11-18T12:00:00+00:00')
    assert client.post(f"/runs/{run['id']}/export", json={'mode': 'accepted'}).status_code == 200
    summary = client.get(f"/runs/{run['id']}").json()['summary']
    assert summary['modified_at'] == '2026-11-18T11:00:00+00:00'
    listed = next(item for item in client.get('/projects').json() if item['id'] == project['id'])
    assert listed['modified_at'] == '2026-11-18T11:00:00+00:00' and listed['modified_by_name'] is None

    # nor does saving settings of one's own for the project
    stable = {'analysis_engine': 'stable_v3', 'stable': {'recording_type': 'phone'}}
    assert client.put(f"/me/run-settings/projects/{project['id']}", json=stable).status_code == 200
    listed = next(item for item in client.get('/projects').json() if item['id'] == project['id'])
    assert listed['modified_at'] == '2026-11-18T11:00:00+00:00'

    # renaming the run is a change to it and to its project
    monkeypatch.setattr(repository, 'utc_now', lambda: '2026-11-18T13:00:00+00:00')
    assert client.patch(f"/runs/{run['id']}", json={'name': 'Checked'}).json()['modified_at'] == '2026-11-18T13:00:00+00:00'
    assert client.get(f"/projects/{project['id']}").json()['project']['modified_at'] == '2026-11-18T13:00:00+00:00'

    export = client.post(f"/runs/{run['id']}/export", json={'mode': 'accepted'})
    manifest = json.loads((storage.DATA_ROOT / export.json()['output_dir'] / 'steps.json').read_text())
    assert (manifest['run']['number'], manifest['run']['name']) == (1, 'Checked')
