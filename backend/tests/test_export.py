from app.services.export import build_accepted_steps


def test_build_accepted_steps_keeps_chronology_and_revisit_links() -> None:
    candidates = [
        {
            'id': 'candidate-a',
            'timestamp_ms': 1_000,
            'timestamp_tc': '00:00:01.000',
            'image_path': 'projects/demo/runs/run-1/frame-a.png',
            'status': 'accepted',
            'title': 'Home',
            'notes': None,
            'scene_score': 1.0,
            'revisit_group_id': 'revisit-home',
            'similar_to_candidate_id': None,
        },
        {
            'id': 'candidate-b',
            'timestamp_ms': 3_500,
            'timestamp_tc': '00:00:03.500',
            'image_path': 'projects/demo/runs/run-1/frame-b.png',
            'status': 'rejected',
            'title': 'Ignore me',
            'notes': None,
            'scene_score': 0.6,
            'revisit_group_id': None,
            'similar_to_candidate_id': None,
        },
        {
            'id': 'candidate-c',
            'timestamp_ms': 7_200,
            'timestamp_tc': '00:00:07.200',
            'image_path': 'projects/demo/runs/run-1/frame-c.png',
            'status': 'accepted',
            'title': 'Home again',
            'notes': 'Loop back',
            'scene_score': 0.4,
            'revisit_group_id': 'revisit-home',
            'similar_to_candidate_id': 'candidate-a',
        },
    ]

    steps = build_accepted_steps('demo-recording', candidates)

    assert [step['step_id'] for step in steps] == ['step-001', 'step-002']
    assert steps[0]['title'] == 'Home'
    assert steps[1]['title'] == 'Home again'
    assert steps[1]['similar_to_step_id'] == 'step-001'
    assert steps[1]['revisit_group_id'] == 'revisit-home'


def test_export_rows_carry_ocr_text() -> None:
    candidate = {
        'id': 'c1', 'status': 'accepted', 'timestamp_ms': 1200, 'timestamp_tc': '00:00:01.200',
        'image_path': 'projects/p/frames/c1.png', 'scene_score': 0.4, 'detector_index': 1,
        'ocr_text': 'Inbox 3 unread',
    }
    assert build_accepted_steps('demo', [candidate])[0]['ocr_text'] == 'Inbox 3 unread'


def test_hybrid_regions_are_exported_in_recording_pixels() -> None:
    from app.services.export import _regions_in_recording_pixels

    breakdown = {'changed_regions': [{'x': 10, 'y': 20, 'width': 100, 'height': 50, 'score': 0.5}]}
    run = {'analysis_engine': 'hybrid_v2', 'analysis_config': '{"max_frame_edge": 960}'}
    scaled = _regions_in_recording_pixels(breakdown, run, {'width': 1920, 'height': 1080})
    assert scaled['changed_regions'][0] == {'x': 20, 'y': 40, 'width': 200, 'height': 100, 'score': 0.5}
    # stable_v3 already stores recording pixels; small recordings were analysed at full size
    stable = {'analysis_engine': 'stable_v3'}
    assert _regions_in_recording_pixels(breakdown, stable, {'width': 1920, 'height': 1080}) is breakdown
    assert _regions_in_recording_pixels(breakdown, run, {'width': 640, 'height': 360}) is breakdown

