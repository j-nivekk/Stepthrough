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
