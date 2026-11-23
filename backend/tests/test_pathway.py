from __future__ import annotations

import csv
import json

from fastapi.testclient import TestClient

from app.services.export import build_accepted_steps, build_all_candidate_rows
from app.services.pathway import _mark_detours, _set_continuations, build_pathway


def _candidate(index: int, label: str | None, *, status: str = 'accepted', similar_to: int | None = None,
               title: str | None = None, origin: str = 'detected', dwell: int | None = 1_000,
               link: int | str | None = None, kind: str | None = None) -> dict:
    return {
        'id': f'c{index}',
        'detector_index': index,
        'candidate_origin': origin,
        'timestamp_ms': index * 1_000,
        'timestamp_tc': f'00:00:{index:02d}.000',
        'image_path': f'projects/demo/frames/c{index}.png',
        'status': status,
        'title': title,
        'notes': None,
        'scene_score': 0.5,
        'score_breakdown': None if label is None else {'transition_type': label, 'dwell_after_ms': dwell},
        'revisit_group_id': None,
        'similar_to_candidate_id': None if similar_to is None else f'c{similar_to}',
        'screen_link': f'c{link}' if isinstance(link, int) else link,
        'screen_kind': kind,
    }


def _pathway(candidates: list[dict], detail: str = 'screens') -> dict:
    return build_pathway(build_accepted_steps('demo', candidates), candidates, detail)


def _screens_of(pathway: dict) -> list[str]:
    return [step['screen_id'] for step in pathway['steps']]


def _moves(pathway: dict) -> list[tuple[str, str, str, list[int]]]:
    return [(t['from_screen'], t['to_screen'], t['kind'], [p['step_index'] for p in t['passes']]) for t in pathway['transitions']]


def test_a_linear_journey_is_one_screen_per_step() -> None:
    pathway = _pathway([_candidate(1, 'opening_screen'), _candidate(2, 'navigation'), _candidate(3, 'navigation')])

    assert _screens_of(pathway) == ['screen-01', 'screen-02', 'screen-03']
    assert [screen['reached_from'] for screen in pathway['screens']] == [None, 'screen-01', 'screen-02']
    assert _moves(pathway) == [
        ('screen-01', 'screen-02', 'forward', [2]),
        ('screen-02', 'screen-03', 'forward', [3]),
    ]
    assert pathway['step_count'] == 3 and pathway['screen_count'] == 3


def test_popup_and_return_branch_and_scroll() -> None:
    # Home, Settings, pop-up, Settings again, Home again, Explore, Explore scrolled, Post
    candidates = [
        _candidate(1, 'opening_screen', title='Home'),
        _candidate(2, 'navigation'),
        _candidate(3, 'modal'),
        _candidate(4, 'navigation', similar_to=2, title='Settings'),
        _candidate(5, 'navigation', similar_to=1),
        _candidate(6, 'navigation'),
        _candidate(7, 'scroll'),
        _candidate(8, 'navigation'),
    ]
    pathway = _pathway(candidates)

    assert _screens_of(pathway) == ['screen-01', 'screen-02', 'screen-03', 'screen-02', 'screen-01', 'screen-04',
                                    'screen-04', 'screen-05']
    assert _moves(pathway) == [
        ('screen-01', 'screen-02', 'forward', [2]),
        ('screen-02', 'screen-03', 'forward', [3]),
        ('screen-03', 'screen-02', 'return', [4]),
        ('screen-02', 'screen-01', 'return', [5]),
        ('screen-01', 'screen-04', 'forward', [6]),
        ('screen-04', 'screen-05', 'forward', [8]),
    ]
    home, settings, popup, explore, _post = pathway['screens']
    assert [screen['kind'] for screen in pathway['screens']] == ['screen', 'screen', 'popup', 'screen', 'screen']
    assert explore['reached_from'] == 'screen-01'  # the branch hangs off Home, not off the pop-up
    assert [visit['step_ids'] for visit in home['visits']] == [['step-001'], ['step-005']]
    assert [visit['step_ids'] for visit in explore['visits']] == [['step-006', 'step-007']]
    assert explore['time_on_screen_ms'] == 2_000 and home['time_on_screen_ms'] == 2_000
    # A screen is named after its first step that has a title, also when that is a later visit.
    assert (home['title'], home['title_step_id']) == ('Home', 'step-001')
    assert (settings['title'], settings['title_step_id']) == ('Settings', 'step-004')
    assert (popup['title'], popup['title_step_id']) == ('Screen 3', None)
    assert [step['grouped_by'] for step in pathway['steps']] == [None, None, None, 'revisit', 'revisit', None, 'scroll', None]


def test_closing_a_popup_returns_to_the_screen_under_it() -> None:
    # Settings, a pop-up, then Settings with a switch now on: not the same state, so the detector calls it no
    # revisit, but closing a pop-up always leads back to the screen under it.
    candidates = [_candidate(1, 'opening_screen'), _candidate(2, 'navigation'), _candidate(3, 'modal'),
                  _candidate(4, 'text_entry'), _candidate(5, 'modal_close'), _candidate(6, 'navigation')]
    pathway = _pathway(candidates)

    assert _screens_of(pathway) == ['screen-01', 'screen-02', 'screen-03', 'screen-03', 'screen-02', 'screen-04']
    assert pathway['steps'][4]['grouped_by'] == 'modal_close'
    assert [screen['kind'] for screen in pathway['screens']] == ['screen', 'screen', 'popup', 'screen']
    assert _moves(pathway)[:2] == [('screen-01', 'screen-02', 'forward', [2]), ('screen-02', 'screen-03', 'forward', [3])]
    assert ('screen-03', 'screen-02', 'return', [5]) in _moves(pathway)
    # By step, only the same screen state shares a box.
    assert len(set(_screens_of(_pathway(candidates, 'steps')))) == 6

    # A pop-up inside a pop-up closes onto the pop-up under it.
    nested = [_candidate(1, 'opening_screen'), _candidate(2, 'modal'), _candidate(3, 'modal'),
              _candidate(4, 'modal_close'), _candidate(5, 'modal_close')]
    assert _screens_of(_pathway(nested)) == ['screen-01', 'screen-02', 'screen-03', 'screen-02', 'screen-01']

    # Leaving for a new screen forgets the pop-up, and a closing without a known opening starts its own screen.
    left = [_candidate(1, 'opening_screen'), _candidate(2, 'modal'), _candidate(3, 'navigation'), _candidate(4, 'modal_close')]
    assert _screens_of(_pathway(left)) == ['screen-01', 'screen-02', 'screen-03', 'screen-04']


def test_the_reviewers_choice_comes_before_the_automatic_grouping() -> None:
    # Automatically: Home, List, List scrolled (same box), Detail.
    def journey(**third) -> list[dict]:
        return [_candidate(1, 'opening_screen'), _candidate(2, 'navigation'), _candidate(3, 'scroll', **third),
                _candidate(4, 'navigation')]

    assert _screens_of(_pathway(journey())) == ['screen-01', 'screen-02', 'screen-02', 'screen-03']

    # "A screen of its own" cuts the link back; the steps after it are not affected.
    own = _pathway(journey(link='new'))
    assert _screens_of(own) == ['screen-01', 'screen-02', 'screen-03', 'screen-04']
    assert [step['screen_choice'] for step in own['steps']] == ['automatic', 'automatic', 'new_screen', 'automatic']

    # "The same screen as step 1" replaces the automatic link to step 2, in both kinds of boxes.
    for detail in ('screens', 'steps'):
        same = _pathway(journey(link=1), detail)
        assert _screens_of(same) == ['screen-01', 'screen-02', 'screen-01', 'screen-03']
        assert same['steps'][2]['grouped_by'] == 'researcher' and same['steps'][2]['screen_choice'] == 'same_screen'

    # It also beats a revisit, and it works for a step added by hand and through a rejected step.
    candidates = [_candidate(1, 'opening_screen'), _candidate(2, 'navigation', status='rejected'),
                  _candidate(3, 'navigation', similar_to=1, link=2), _candidate(4, None, origin='manual', link=1)]
    assert _screens_of(_pathway(candidates)) == ['screen-01', 'screen-02', 'screen-01']


def test_a_step_can_be_put_with_a_later_step() -> None:
    # Moving step 1 into the box of step 3: both say the reviewer put them together.
    candidates = [_candidate(1, 'opening_screen', link=3), _candidate(2, 'navigation'), _candidate(3, 'navigation')]
    pathway = _pathway(candidates)
    assert _screens_of(pathway) == ['screen-01', 'screen-02', 'screen-01']
    assert [step['grouped_by'] for step in pathway['steps']] == [None, None, 'researcher']


def test_merging_a_box_moves_all_its_steps(client: TestClient, video_factory, wait_for_run) -> None:
    detail = _import_run(client, video_factory, wait_for_run)
    run_id = detail['summary']['id']
    first, second, third = detail['candidates']
    for candidate in detail['candidates']:
        client.patch(f"/candidates/{candidate['id']}", json={'status': 'accepted'})
    # A manually linked box whose first step points forward. Replacing only that first link would leave
    # the third step behind. Include a rejected member too, so accepting it later keeps the chosen merge.
    client.patch(f"/candidates/{first['id']}", json={'screen_link': third['id']})
    client.patch(f"/candidates/{third['id']}", json={'screen_link': 'new', 'status': 'rejected'})
    response = client.post(f'/runs/{run_id}/pathway/merge', json={
        'source_candidate_id': first['id'], 'target_candidate_id': second['id'], 'detail': 'screens',
    })
    assert response.status_code == 200
    # it says which steps it linked, the rejected member too, so that a browser can take it back
    assert sorted(response.json()['changed']) == sorted([first['id'], third['id']])
    client.patch(f"/candidates/{third['id']}", json={'status': 'accepted'})
    pathway = client.get(f'/runs/{run_id}/pathway').json()
    assert _screens_of(pathway) == ['screen-01'] * 3
    kept = client.get(f'/runs/{run_id}').json()['candidates']
    assert [candidate['screen_link'] for candidate in kept] == [second['id'], None, second['id']]

    # Invalid targets must leave the whole group alone, including candidates from another run.
    other_run = client.post(f"/recordings/{first['recording_id']}/runs/manual").json()
    other = client.post(f"/runs/{other_run['id']}/candidates/manual", json={'timestamp_ms': 500}).json()
    for source, target in ((first['id'], 'missing'), (first['id'], other['id']), (other['id'], second['id'])):
        assert client.post(f'/runs/{run_id}/pathway/merge', json={
            'source_candidate_id': source, 'target_candidate_id': target,
        }).status_code == 422
    assert client.get(f'/runs/{run_id}').json()['candidates'] == kept


def test_a_revisit_comes_before_a_label() -> None:
    # Step 3 was reached by a small change but shows step 1's screen again, so it is on that screen and does
    # not pull the screen of step 2 into it.
    candidates = [_candidate(1, 'opening_screen'), _candidate(2, 'navigation'), _candidate(3, 'content_update', similar_to=1)]
    pathway = _pathway(candidates)
    assert _screens_of(pathway) == ['screen-01', 'screen-02', 'screen-01']
    assert pathway['steps'][2]['grouped_by'] == 'revisit'


def test_the_reviewer_can_mark_a_popup_the_detector_missed() -> None:
    # A menu that does not dim the screen is labelled as an update, and so is the screen coming back.
    def journey(kind: str | None, back: dict) -> list[dict]:
        return [_candidate(1, 'opening_screen'), _candidate(2, 'content_update', kind=kind),
                _candidate(3, 'content_update', **back), _candidate(4, 'navigation')]

    assert _screens_of(_pathway(journey(None, {}))) == ['screen-01', 'screen-01', 'screen-01', 'screen-02']

    # Marked as a pop-up it gets a box of its own, and a revisit leads back to the screen under it.
    marked = _pathway(journey('popup', {'similar_to': 1}))
    assert _screens_of(marked) == ['screen-01', 'screen-02', 'screen-01', 'screen-03']
    assert [screen['kind'] for screen in marked['screens']] == ['screen', 'popup', 'screen']
    assert marked['steps'][1]['kind_choice'] == 'popup'
    # Without a revisit the next step stays in the pop-up until the reviewer says where it belongs.
    assert _screens_of(_pathway(journey('popup', {}))) == ['screen-01', 'screen-02', 'screen-02', 'screen-03']
    assert _screens_of(_pathway(journey('popup', {'link': 1}))) == ['screen-01', 'screen-02', 'screen-01', 'screen-03']

    # The other way round: a step labelled as a pop-up that is none is an ordinary screen.
    unmarked = _pathway([_candidate(1, 'opening_screen'), _candidate(2, 'modal', kind='screen')])
    assert [screen['kind'] for screen in unmarked['screens']] == ['screen', 'screen']


def test_detail_steps_only_joins_revisits() -> None:
    candidates = [_candidate(1, 'opening_screen'), _candidate(2, 'scroll'), _candidate(3, 'text_entry'),
                  _candidate(4, 'navigation', similar_to=1)]

    assert _screens_of(_pathway(candidates)) == ['screen-01', 'screen-01', 'screen-01', 'screen-01']
    by_step = _pathway(candidates, 'steps')
    assert _screens_of(by_step) == ['screen-01', 'screen-02', 'screen-03', 'screen-01']
    assert by_step['detail'] == 'steps'


def test_rejected_steps_still_decide_which_screen_a_step_is_on() -> None:
    # The rejected step went to a new screen; the accepted scroll after it is on that screen, not on the first.
    moved = [_candidate(1, 'opening_screen'), _candidate(2, 'navigation', status='rejected'), _candidate(3, 'scroll')]
    assert _screens_of(_pathway(moved)) == ['screen-01', 'screen-02']
    assert _moves(_pathway(moved)) == [('screen-01', 'screen-02', 'forward', [2])]

    # A rejected scroll keeps the chain: the next scroll is still on the first screen.
    stayed = [_candidate(1, 'opening_screen'), _candidate(2, 'scroll', status='rejected'), _candidate(3, 'scroll')]
    pathway = _pathway(stayed)
    assert _screens_of(pathway) == ['screen-01', 'screen-01']
    assert pathway['transitions'] == []
    assert pathway['steps'][1]['grouped_by'] == 'scroll'


def test_a_step_added_by_hand_stands_alone_and_does_not_break_the_chain() -> None:
    # The link of a step added by hand is a look-alike by image hash, not a revisit, so it does not join on it.
    candidates = [_candidate(1, 'opening_screen'), _candidate(2, None, origin='manual', similar_to=1), _candidate(3, 'scroll')]
    pathway = _pathway(candidates)

    # The scroll's label describes the change from the detected step before it, so it joins that screen.
    assert _screens_of(pathway) == ['screen-01', 'screen-02', 'screen-01']
    assert _moves(pathway) == [('screen-01', 'screen-02', 'forward', [2]), ('screen-02', 'screen-01', 'return', [3])]
    assert pathway['screens'][1]['time_on_screen_ms'] is None  # no timing for a step added by hand


def test_a_repeated_move_is_one_transition_with_two_passes() -> None:
    candidates = [_candidate(1, 'opening_screen'), _candidate(2, 'navigation'), _candidate(3, 'navigation', similar_to=1),
                  _candidate(4, 'navigation', similar_to=2)]

    assert _moves(_pathway(candidates)) == [
        ('screen-01', 'screen-02', 'forward', [2, 4]),
        ('screen-02', 'screen-01', 'return', [3]),
    ]


def test_no_accepted_steps_is_an_empty_pathway() -> None:
    pathway = _pathway([_candidate(1, 'opening_screen', status='pending')])
    assert (pathway['steps'], pathway['screens'], pathway['transitions']) == ([], [], [])


def test_every_candidate_can_be_a_step() -> None:
    candidates = [_candidate(1, 'opening_screen', status='rejected'), _candidate(2, 'navigation', status='pending')]
    pathway = build_pathway(build_all_candidate_rows('demo', candidates), candidates)
    assert [step['step_id'] for step in pathway['steps']] == ['candidate-001', 'candidate-002']
    assert _moves(pathway) == [('screen-01', 'screen-02', 'forward', [2])]


def test_screen_choices_are_saved_checked_and_kept(client: TestClient, video_factory, wait_for_run) -> None:
    detail = _import_run(client, video_factory, wait_for_run)
    run_id = detail['summary']['id']
    first, second, third = detail['candidates']
    for candidate in detail['candidates']:
        client.patch(f"/candidates/{candidate['id']}", json={'status': 'accepted'})

    def screens() -> list[str]:
        return [step['screen_id'] for step in client.get(f'/runs/{run_id}/pathway').json()['steps']]

    assert screens() == ['screen-01', 'screen-02', 'screen-01']  # red, blue, red again

    saved = client.patch(f"/candidates/{third['id']}", json={'screen_link': 'new', 'screen_kind': 'popup'}).json()
    assert (saved['screen_link'], saved['screen_kind']) == ('new', 'popup')
    assert screens() == ['screen-01', 'screen-02', 'screen-03']
    assert client.patch(f"/candidates/{third['id']}", json={'screen_link': second['id']}).json()['screen_link'] == second['id']
    assert screens() == ['screen-01', 'screen-02', 'screen-02']

    # Only another step of the same run can be picked.
    for wrong in (second['id'], 'missing'):
        assert client.patch(f"/candidates/{second['id']}", json={'screen_link': wrong}).status_code == 422
    assert client.patch(f"/candidates/{third['id']}", json={'screen_kind': 'window'}).status_code == 422

    # Adding a step by hand numbers the steps again; the choices stay with their steps.
    assert client.post(f'/runs/{run_id}/candidates/manual', json={'timestamp_ms': 100}).status_code == 200
    kept = next(c for c in client.get(f'/runs/{run_id}').json()['candidates'] if c['id'] == third['id'])
    assert (kept['screen_link'], kept['screen_kind'], kept['detector_index']) == (second['id'], 'popup', 4)

    # Back to automatic, and the export says who decided.
    reset = client.patch(f"/candidates/{third['id']}", json={'screen_link': 'auto', 'screen_kind': 'auto'}).json()
    assert (reset['screen_link'], reset['screen_kind']) == (None, None)
    client.patch(f"/candidates/{third['id']}", json={'screen_link': second['id']})
    export = client.post(f'/runs/{run_id}/export', json={'mode': 'accepted'})
    import app.storage as storage

    exported = json.loads((storage.DATA_ROOT / export.json()['output_dir'] / 'pathway.json').read_text())
    assert [(step['grouped_by'], step['screen_choice']) for step in exported['steps']] == [
        (None, 'automatic'), (None, 'automatic'), ('researcher', 'same_screen')]


def _import_run(client: TestClient, video_factory, wait_for_run) -> dict:
    project = client.post('/projects', json={'name': 'Pathway Test'}).json()
    video = video_factory('pathway.mp4', ['red', 'blue', 'red'])
    with video.open('rb') as handle:
        recording = client.post('/recordings/import', files={'file': (video.name, handle, 'video/mp4')},
                                data={'project_id': project['id']}).json()
    run = client.post(f"/recordings/{recording['id']}/runs",
                      json={'stable': {'recording_type': 'desktop', 'min_dwell_ms': 500}}).json()
    return wait_for_run(client, run['id'])


def test_run_pathway_and_its_export(client: TestClient, video_factory, wait_for_run) -> None:
    detail = _import_run(client, video_factory, wait_for_run)
    run_id = detail['summary']['id']
    assert len(detail['candidates']) == 3

    assert client.get(f'/runs/{run_id}/pathway').json()['steps'] == []  # nothing accepted yet
    for candidate in detail['candidates']:
        assert client.patch(f"/candidates/{candidate['id']}", json={'status': 'accepted'}).status_code == 200

    pathway = client.get(f'/runs/{run_id}/pathway').json()
    assert pathway['format'] == 'stepthrough.pathway/1' and pathway['detail'] == 'screens'
    # red, blue, red again: the third step is back on the first screen
    assert [step['screen_id'] for step in pathway['steps']] == ['screen-01', 'screen-02', 'screen-01']
    assert [(t['from_screen'], t['to_screen'], t['kind']) for t in pathway['transitions']] == [
        ('screen-01', 'screen-02', 'forward'), ('screen-02', 'screen-01', 'return')]
    assert all(step['image_url'] == f"/assets/{step['image_path']}" for step in pathway['steps'])
    assert client.get(f'/runs/{run_id}/pathway', params={'detail': 'steps'}).json()['detail'] == 'steps'
    assert client.get(f'/runs/{run_id}/pathway', params={'detail': 'everything'}).status_code == 422
    assert client.get('/runs/missing/pathway').status_code == 404

    export = client.post(f'/runs/{run_id}/export', json={'mode': 'accepted'})
    assert export.status_code == 200
    import app.storage as storage

    bundle = storage.DATA_ROOT / export.json()['output_dir']
    exported = json.loads((bundle / 'pathway.json').read_text())
    manifest = json.loads((bundle / 'steps.json').read_text())
    assert exported['steps_file'] == 'steps.json' and exported['bundle_id'] == manifest['bundle_id']
    assert [step['step_id'] for step in exported['steps']] == [step['step_id'] for step in manifest['steps']]
    # Readable without the app: images are the ones in the bundle, and every field is explained.
    assert [step['image_path'] for step in exported['steps']] == [step['image_path'] for step in manifest['steps']]
    assert all((bundle / step['image_path']).exists() for step in exported['steps'])
    assert all('image_url' not in step and 'export_filename' not in step for step in exported['steps'])
    assert 'the step it arrives at' in exported['field_notes']['transitions.passes']
    # each step's number along the main way, and whether it is an optional detour (here every step counts)
    assert [(step['main_step'], step['detour']) for step in manifest['steps']] == [(1, False), (2, False), (3, False)]
    assert exported['main_step_count'] == 3 and exported['step_count'] == 3
    rows = list(csv.DictReader((bundle / 'steps.csv').open(encoding='utf-8')))
    assert [(row['main_step'], row['detour']) for row in rows] == [('1', 'false'), ('2', 'false'), ('3', 'false')]


def test_phases_are_named_stretches_of_time() -> None:
    from app.services.pathway import phase_at, set_phase

    phases = set_phase([], 'Sign up', 2_000, 5_000)
    assert phases == [(2_000, 'Sign up'), (5_000, '')]
    assert [phase_at(phases, ms) for ms in (0, 2_000, 4_999, 5_000)] == [None, 'Sign up', 'Sign up', None]
    # a phase in the middle of another leaves what comes after it in the one it was in
    assert set_phase(phases, 'Code', 3_000, 4_000) == [(2_000, 'Sign up'), (3_000, 'Code'), (4_000, 'Sign up'), (5_000, '')]
    # the same name next to it makes one phase; to the end of the recording when it has no end
    assert set_phase(phases, 'Sign up', 5_000, None) == [(2_000, 'Sign up')]
    # an empty name takes a stretch out of every phase
    assert set_phase(phases, '', 2_000, 5_000) == []


def test_the_pathway_counts_the_steps_screens_and_time_of_each_phase() -> None:
    # Home, Form, Form scrolled, Code, Form again, Done
    candidates = [
        _candidate(1, 'opening_screen'), _candidate(2, 'navigation'), _candidate(3, 'scroll'),
        _candidate(4, 'navigation'), _candidate(5, 'navigation', similar_to=2), _candidate(6, 'navigation', dwell=1_500),
    ]
    phases = [(2_000, 'Sign up'), (6_000, 'Finish')]
    pathway = build_pathway(build_accepted_steps('demo', candidates), candidates, 'screens', phases)
    assert [step['phase'] for step in pathway['steps']] == [None, 'Sign up', 'Sign up', 'Sign up', 'Sign up', 'Finish']
    assert [(p['name'], p['first_step_index'], p['last_step_index'], p['step_count'], p['screen_count'], p['duration_ms'])
            for p in pathway['phases']] == [('Sign up', 2, 5, 4, 2, 4_000), ('Finish', 6, 6, 1, 1, 1_500)]
    assert pathway['phases'][0]['screen_ids'] == ['screen-02', 'screen-03']


def test_the_first_step_with_a_say_about_its_row_decides_for_its_box() -> None:
    candidates = [_candidate(1, 'opening_screen'), _candidate(2, 'scroll'), _candidate(3, 'navigation')]
    candidates[1]['pathway_row'] = 'continue'
    candidates[2]['pathway_row'] = 'below'
    pathway = _pathway(candidates)
    assert [screen['row_choice'] for screen in pathway['screens']] == ['continue', 'below']
    candidates[0]['pathway_row'] = 'below'
    assert [screen['row_choice'] for screen in _pathway(candidates)['screens']] == ['below', 'below']


def test_phases_are_set_by_steps_and_exported(client: TestClient, video_factory, wait_for_run) -> None:
    detail = _import_run(client, video_factory, wait_for_run)
    run_id = detail['summary']['id']
    steps = sorted(detail['candidates'], key=lambda c: c['timestamp_ms'])
    for candidate in steps:
        assert client.patch(f"/candidates/{candidate['id']}", json={'status': 'accepted'}).status_code == 200
    first, second, third = (candidate['id'] for candidate in steps)

    def named() -> list[tuple[str, int, int]]:
        pathway = client.get(f'/runs/{run_id}/pathway').json()
        return [(p['name'], p['first_step_index'], p['last_step_index']) for p in pathway['phases']]

    answer = client.put(f'/runs/{run_id}/phases', json={'name': ' Look ', 'first_step': first, 'last_step': second})
    assert answer.status_code == 200
    assert named() == [('Look', 1, 2)]
    # the answer is every phase after the change, so a browser can take it back
    after_first = answer.json()['phases']
    assert [b['name'] for b in after_first] == ['Look', '']
    # changed: the old stretch is let go before the new one is named
    changed = {'name': 'Look', 'first_step': second, 'last_step': third, 'replacing': {'first_step': first, 'last_step': second}}
    assert client.put(f'/runs/{run_id}/phases', json=changed).status_code == 200
    assert named() == [('Look', 2, 3)]
    # taken back as a whole, as long as nobody changed them since
    current = client.get(f'/runs/{run_id}').json()['phases']
    assert client.put(f'/runs/{run_id}/phases/all', json={'phases': after_first, 'expected': after_first}).status_code == 409
    assert client.put(f'/runs/{run_id}/phases/all', json={'phases': after_first, 'expected': current}).json()['phases'] == after_first
    assert named() == [('Look', 1, 2)]
    assert client.put(f'/runs/{run_id}/phases/all', json={'phases': current}).status_code == 200
    assert named() == [('Look', 2, 3)]
    # the run itself says where each phase starts, for the step review
    boundaries = client.get(f'/runs/{run_id}').json()['phases']
    assert [b['name'] for b in boundaries] == ['Look'] and boundaries[0]['start_ms'] == steps[1]['timestamp_ms']
    # backwards, or steps that are not accepted steps of this run, are refused
    assert client.put(f'/runs/{run_id}/phases', json={'name': 'x', 'first_step': third, 'last_step': first}).status_code == 422
    assert client.put(f'/runs/{run_id}/phases', json={'name': 'x', 'first_step': 'missing', 'last_step': first}).status_code == 422
    client.patch(f'/candidates/{first}', json={'pathway_row': 'below'})
    assert client.get(f'/runs/{run_id}/pathway').json()['screens'][0]['row_choice'] == 'below'
    assert client.patch(f'/candidates/{first}', json={'pathway_row': 'auto'}).json()['pathway_row'] is None

    export = client.post(f'/runs/{run_id}/export', json={'mode': 'accepted'})
    import app.storage as storage

    bundle = storage.DATA_ROOT / export.json()['output_dir']
    manifest = json.loads((bundle / 'steps.json').read_text())
    assert [step['phase'] for step in manifest['steps']] == [None, 'Look', 'Look']
    assert 'phase' in (bundle / 'steps.csv').read_text().splitlines()[0].split(',')
    exported = json.loads((bundle / 'pathway.json').read_text())
    assert [(p['name'], p['step_count']) for p in exported['phases']] == [('Look', 2)]

    assert client.put(f'/runs/{run_id}/phases', json={'name': '', 'first_step': second, 'last_step': third}).status_code == 200
    assert named() == []


def test_the_long_way_on_carries_the_row_and_the_reviewer_can_say_otherwise() -> None:
    def screens(tree: list[tuple[int, int | None]], rows: dict[int, str] | None = None) -> list[dict]:
        made = [{'id': f's{index}', 'reached_from': f's{parent}' if parent else None,
                 'row_choice': (rows or {}).get(index, 'automatic')} for index, parent in tree]
        _set_continuations(made)
        return made

    # s2 leads first to a short trip (s3, s4) and later to the long rest (s5 to s7)
    tree = [(1, None), (2, 1), (3, 2), (4, 3), (5, 2), (6, 5), (7, 6)]
    on = {screen['id']: screen['continues_with'] for screen in screens(tree)}
    assert on == {'s1': 's2', 's2': 's5', 's3': 's4', 's4': None, 's5': 's6', 's6': 's7', 's7': None}
    # the reviewer put the short trip on the row
    assert next(s for s in screens(tree, {3: 'continue'}) if s['id'] == 's2')['continues_with'] == 's3'
    # ... or the long way below: the short trip carries the row on
    assert next(s for s in screens(tree, {5: 'below'}) if s['id'] == 's2')['continues_with'] == 's3'
    # nothing carries on a row whose boxes were all put below; equal ways on: the first reached
    assert next(s for s in screens(tree, {3: 'below', 5: 'below'}) if s['id'] == 's2')['continues_with'] is None
    assert screens([(1, None), (2, 1), (3, 1)])[0]['continues_with'] == 's2'


def _walk(visits: list[str], tree: dict[str, str | None], popups: frozenset[str] = frozenset()) -> tuple[list[dict], list[dict]]:
    """Steps on the screens in ``visits`` (one step each, in time), screens reached as in ``tree``."""
    screens = [{'id': screen, 'reached_from': parent, 'row_choice': 'automatic', 'kind': 'popup' if screen in popups else 'screen'}
               for screen, parent in tree.items()]
    _set_continuations(screens)
    steps = [{'step_id': f'step-{index}', 'screen_id': screen} for index, screen in enumerate(visits, start=1)]
    _mark_detours(steps, screens)
    return steps, screens


def test_a_trip_off_the_main_way_that_comes_back_is_optional() -> None:
    # a -> b -> (c -> d, and back to b) -> e -> f -> g: the long way on is b -> e -> f -> g
    tree = {'a': None, 'b': 'a', 'c': 'b', 'd': 'c', 'e': 'b', 'f': 'e', 'g': 'f'}
    steps, screens = _walk(['a', 'b', 'c', 'd', 'b', 'e', 'f', 'g'], tree)
    assert [screen['id'] for screen in screens if screen['main']] == ['a', 'b', 'e', 'f', 'g']
    # the trip and the step that comes back are optional; the rest are numbered along the main way
    assert [step['detour'] for step in steps] == [False, False, True, True, True, False, False, False]
    assert [step['main_step'] for step in steps] == [1, 2, None, None, None, 3, 4, 5]


def test_a_trip_that_never_comes_back_or_only_shows_popups_counts() -> None:
    tree = {'a': None, 'b': 'a', 'c': 'b', 'd': 'b', 'e': 'd'}
    # the recording ends on the trip (c): it is part of what was done
    steps, _ = _walk(['a', 'b', 'd', 'e', 'b', 'c'], tree)
    assert steps[-1]['screen_id'] == 'c' and not any(step['detour'] for step in steps[4:])
    # a pop-up over b, dismissed (b -> p -> b), is in the way, not chosen: counted
    steps, _ = _walk(['a', 'b', 'p', 'b', 'c', 'd'], {'a': None, 'b': 'a', 'p': 'b', 'c': 'b', 'd': 'c'}, frozenset({'p'}))
    assert not any(step['detour'] for step in steps)
    assert [step['main_step'] for step in steps] == [1, 2, 3, 4, 5, 6]


def test_the_pathway_and_its_phases_count_the_steps_with_and_without_detours() -> None:
    candidates = [_candidate(index, 'tap', similar_to=similar) for index, similar in
                  [(0, None), (1, None), (2, None), (3, 1), (4, None), (5, None)]]
    pathway = _pathway(candidates)
    by_index = {step['step_index']: step for step in pathway['steps']}
    assert pathway['step_count'] == 6
    assert pathway['main_step_count'] == sum(1 for step in pathway['steps'] if not step['detour'])
    assert pathway['main_step_count'] + sum(step['detour'] for step in pathway['steps']) == 6
    assert all((step['main_step'] is None) == step['detour'] for step in by_index.values())

