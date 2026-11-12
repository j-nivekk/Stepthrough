"""Who may open and change what: project members, viewers, tags, administrators, and the media route."""

from __future__ import annotations

from collections.abc import Callable, Iterator
from dataclasses import dataclass

import pytest
from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

from app import main
from app.accounts import User, current_user
from app.repository import create_user, list_project_members, set_project_member

RESET_HEADERS = {main.ADMIN_CONFIRM_HEADER: 'reset-database'}


@dataclass
class World:
    """One project, made by the built-in user, with everything in it that has its own endpoint."""

    project_id: str
    folder: str
    recording_id: str
    run_id: str
    candidate_id: str
    bundle_id: str
    image_url: str
    source_url: str


@pytest.fixture()
def act_as(client: TestClient) -> Iterator[Callable[[User | None], None]]:
    """Make the following requests come from ``user`` (``None``: the built-in local user again)."""

    def switch(user: User | None) -> None:
        if user is None:
            main.app.dependency_overrides.pop(current_user, None)
        else:
            main.app.dependency_overrides[current_user] = lambda: user

    yield switch
    main.app.dependency_overrides.pop(current_user, None)


def make_user(name: str, *tags: str) -> User:
    return User.from_row(create_user(name, tags=tags))


@pytest.fixture()
def world(client: TestClient, video_factory) -> World:
    project = client.post('/projects', json={'name': 'Field notes'}).json()
    video = video_factory('flow.mp4', ['red', 'blue'])
    with video.open('rb') as handle:
        recording = client.post(
            '/recordings/import', files={'file': (video.name, handle, 'video/mp4')}, data={'project_id': project['id']}
        ).json()
    run = client.post(f"/recordings/{recording['id']}/runs/manual").json()
    candidate = client.post(f"/runs/{run['id']}/candidates/manual", json={'timestamp_ms': 1500}).json()
    bundle = client.post(f"/runs/{run['id']}/export", json={'mode': 'all'}).json()
    folder = recording['source_url'].removeprefix('/assets/projects/').split('/')[0]
    return World(
        project_id=project['id'],
        folder=folder,
        recording_id=recording['id'],
        run_id=run['id'],
        candidate_id=candidate['id'],
        bundle_id=bundle['id'],
        image_url=candidate['image_url'],
        source_url=recording['source_url'],
    )


def read_requests(w: World) -> list[tuple[str, str, dict]]:
    return [
        ('GET', f'/projects/{w.project_id}', {}),
        ('GET', f'/recordings/{w.recording_id}', {}),
        ('GET', f'/runs/{w.run_id}', {}),
        ('GET', f'/runs/{w.run_id}/pathway', {}),
        ('GET', f'/exports/{w.bundle_id}/download', {}),
        ('GET', w.image_url, {}),
        ('GET', w.source_url, {}),
    ]


def write_requests(w: World) -> list[tuple[str, str, dict]]:
    return [
        ('PATCH', f'/projects/{w.project_id}', {'json': {'name': 'Renamed'}}),
        ('POST', '/recordings/import', {'files': {'file': ('x.mp4', b'not a video', 'video/mp4')},
                                        'data': {'project_id': w.project_id}}),
        ('PATCH', f'/recordings/{w.recording_id}', {'json': {'filename': 'renamed.mp4'}}),
        ('POST', f'/recordings/{w.recording_id}/runs/manual', {}),
        ('POST', f'/recordings/{w.recording_id}/runs', {'json': {}}),
        ('POST', f'/runs/{w.run_id}/cancel', {}),
        ('PATCH', f'/candidates/{w.candidate_id}', {'json': {'status': 'accepted'}}),
        ('PATCH', f'/candidates/{w.candidate_id}', {'json': {'screen_link': 'new', 'screen_kind': 'popup'}}),
        ('POST', f'/runs/{w.run_id}/pathway/merge', {'json': {
            'source_candidate_id': w.candidate_id, 'target_candidate_id': w.candidate_id,
        }}),
        ('POST', f'/runs/{w.run_id}/candidates/manual', {'json': {'timestamp_ms': 500}}),
        ('POST', f'/runs/{w.run_id}/export', {'json': {'mode': 'all'}}),
        ('DELETE', f'/runs/{w.run_id}', {}),
        ('DELETE', f'/recordings/{w.recording_id}', {}),
        ('DELETE', f'/projects/{w.project_id}', {}),
    ]


def assert_world_unchanged(client: TestClient, w: World) -> None:
    project = client.get(f'/projects/{w.project_id}').json()
    assert project['project']['name'] == 'Field notes'
    assert [r['id'] for r in project['recordings']] == [w.recording_id]
    detail = client.get(f'/runs/{w.run_id}').json()
    assert [c['id'] for c in detail['candidates']] == [w.candidate_id]
    assert detail['candidates'][0]['status'] == 'pending'


def test_the_built_in_user_is_an_administrator_and_owns_what_it_makes(client: TestClient, world: World) -> None:
    me = client.get('/me').json()
    assert (me['name'], me['is_admin'], me['tags']) == ('local', True, ['admin'])
    assert [(m['member'], m['role']) for m in list_project_members(world.project_id)] == [('local', 'owner')]
    assert [p['id'] for p in client.get('/projects').json()] == [world.project_id]


def test_someone_else_cannot_tell_the_project_exists(client: TestClient, world: World, act_as) -> None:
    act_as(make_user('stranger'))
    assert client.get('/projects').json() == []
    for method, url, kwargs in read_requests(world) + write_requests(world):
        response = client.request(method, url, **kwargs)
        assert response.status_code == 404, (method, url, response.status_code)
    # The same answer as for things that do not exist.
    assert client.get(f'/projects/{world.project_id}').json() == client.get('/projects/missing').json()
    with pytest.raises(WebSocketDisconnect), client.websocket_connect(f'/runs/{world.run_id}/events'):
        pass
    assert client.post('/admin/reset-db', headers=RESET_HEADERS).status_code == 403
    assert client.post('/admin/recheck-ocr').status_code == 403
    act_as(None)
    assert_world_unchanged(client, world)


def test_a_viewer_can_look_but_not_change(client: TestClient, world: World, act_as) -> None:
    viewer = make_user('viewer')
    set_project_member(world.project_id, viewer.id, 'viewer')
    act_as(viewer)
    assert [p['id'] for p in client.get('/projects').json()] == [world.project_id]
    for method, url, kwargs in read_requests(world):
        assert client.request(method, url, **kwargs).status_code == 200, url
    with client.websocket_connect(f'/runs/{world.run_id}/events'):
        pass
    for method, url, kwargs in write_requests(world):
        response = client.request(method, url, **kwargs)
        assert response.status_code == 403, (method, url, response.status_code)
        assert response.json()['detail'] == 'You can view this project but not change it.'
    act_as(None)
    assert_world_unchanged(client, world)


def test_a_tag_shares_a_project_with_everyone_who_has_it(client: TestClient, world: World, act_as) -> None:
    set_project_member(world.project_id, 'tag:seminar-a', 'viewer')
    act_as(make_user('in-seminar', 'seminar-a'))
    assert client.get(f'/projects/{world.project_id}').status_code == 200
    assert client.get(world.image_url).status_code == 200
    act_as(make_user('other-seminar', 'seminar-b'))
    assert client.get(f'/projects/{world.project_id}').status_code == 404


def test_an_owner_role_beats_a_viewer_role(client: TestClient, world: World, act_as) -> None:
    member = make_user('member', 'seminar-a')
    set_project_member(world.project_id, 'tag:seminar-a', 'viewer')
    set_project_member(world.project_id, member.id, 'owner')
    act_as(member)
    response = client.patch(f'/projects/{world.project_id}', json={'name': 'Renamed'})
    assert response.status_code == 200


def test_new_projects_belong_to_whoever_makes_them(client: TestClient, act_as) -> None:
    alice, bob = make_user('alice'), make_user('bob')
    act_as(alice)
    project = client.post('/projects', json={'name': 'Alice'}).json()
    assert [p['id'] for p in client.get('/projects').json()] == [project['id']]
    assert [(m['member'], m['role']) for m in list_project_members(project['id'])] == [(alice.id, 'owner')]
    act_as(bob)
    assert client.get('/projects').json() == []
    assert client.get(f"/projects/{project['id']}").status_code == 404
    # Administrators may open and change any project, but their list only shows their own.
    act_as(make_user('admin-2', 'admin'))
    assert client.get(f"/projects/{project['id']}").status_code == 200
    assert client.patch(f"/projects/{project['id']}", json={'name': 'Checked'}).status_code == 200
    assert client.get('/projects').json() == []


def test_media_supports_ranges_and_revalidation(client: TestClient, world: World) -> None:
    full = client.get(world.source_url)
    assert full.status_code == 200
    assert full.headers['accept-ranges'] == 'bytes'
    assert full.headers['cache-control'] == 'private, no-cache'
    part = client.get(world.source_url, headers={'Range': 'bytes=0-99'})
    assert (part.status_code, len(part.content)) == (206, 100)
    assert part.content == full.content[:100]
    again = client.get(world.source_url, headers={'If-None-Match': full.headers['etag']})
    assert (again.status_code, again.content) == (304, b'')
    assert client.head(world.image_url).status_code == 200


@pytest.mark.parametrize('path', [
    '{folder}',
    '{folder}/',
    '{folder}/..%2F..%2Fstepthrough.sqlite3',
    '{folder}/%2E%2E/%2E%2E/stepthrough.sqlite3',
    'missing-12345678/source/flow.mp4',
    'no-dash/flow.mp4',
])
def test_media_outside_a_project_is_not_served(client: TestClient, world: World, path: str) -> None:
    assert client.get('/assets/projects/' + path.format(folder=world.folder)).status_code == 404
