"""Analysis settings saved for new runs belong to the account, on the server, so they follow it to any computer."""

from __future__ import annotations

from collections.abc import Callable, Iterator

import pytest
from fastapi.testclient import TestClient

from app import main
from app.accounts import User, current_user
from app.database import connect
from app.repository import create_user, delete_user_record, set_project_member

RESET_HEADERS = {main.ADMIN_CONFIRM_HEADER: 'reset-database'}
DESKTOP = {'analysis_engine': 'stable_v3', 'stable': {'recording_type': 'desktop', 'min_dwell_ms': 1500}}
PHONE_WITH_OCR = {'analysis_engine': 'stable_v3', 'stable': {'recording_type': 'phone', 'enable_ocr': True}}


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


def saved(client: TestClient) -> dict[str | None, dict]:
    """What the logged-in person saved, by project (None: their own defaults), as the stable settings."""
    response = client.get('/me/run-settings')
    assert response.status_code == 200
    return {item['project_id']: item['settings']['stable'] for item in response.json()}


def saved_rows() -> list[tuple[str, str | None]]:
    with connect() as conn:
        rows = conn.execute('SELECT user_id, project_id FROM saved_run_settings ORDER BY user_id, project_id').fetchall()
    return [(row['user_id'], row['project_id']) for row in rows]


def test_saved_settings_belong_to_the_account_that_saved_them(client: TestClient, act_as) -> None:
    project = client.post('/projects', json={'name': 'Shared'}).json()
    ada, bo = make_user('ada', 'seminar'), make_user('bo', 'seminar')
    set_project_member(project['id'], 'tag:seminar', 'owner')

    act_as(ada)
    assert saved(client) == {}
    response = client.put('/me/run-settings/default', json=DESKTOP)
    assert response.status_code == 200
    assert response.json()['project_id'] is None
    assert response.json()['settings']['stable']['recording_type'] == 'desktop'
    assert client.put(f"/me/run-settings/projects/{project['id']}", json=PHONE_WITH_OCR).status_code == 200
    mine = saved(client)
    assert list(mine) == [None, project['id']]  # the defaults first
    assert (mine[None]['recording_type'], mine[None]['min_dwell_ms']) == ('desktop', 1500)
    assert (mine[project['id']]['recording_type'], mine[project['id']]['enable_ocr']) == ('phone', True)

    # Someone else in the same project starts from the built-in defaults, and saving theirs leaves Ada's alone.
    act_as(bo)
    assert saved(client) == {}
    assert client.put(f"/me/run-settings/projects/{project['id']}", json=DESKTOP).status_code == 200
    assert list(saved(client)) == [project['id']]
    act_as(ada)
    assert saved(client) == mine


def test_saving_again_replaces_what_was_saved(client: TestClient) -> None:
    project = client.post('/projects', json={'name': 'Notes'}).json()
    for settings in (DESKTOP, PHONE_WITH_OCR):
        client.put('/me/run-settings/default', json=settings)
        client.put(f"/me/run-settings/projects/{project['id']}", json=settings)
    assert saved_rows() == [('local', None), ('local', project['id'])]
    assert {scope: stable['recording_type'] for scope, stable in saved(client).items()} == {
        None: 'phone',
        project['id']: 'phone',
    }


def test_settings_for_a_project_need_access_to_it(client: TestClient, act_as) -> None:
    project = client.post('/projects', json={'name': 'Private'}).json()
    url = f"/me/run-settings/projects/{project['id']}"

    act_as(make_user('stranger'))
    response = client.put(url, json=DESKTOP)
    assert response.status_code == 404
    assert response.json() == client.put('/me/run-settings/projects/missing', json=DESKTOP).json()

    # A viewer cannot change the project, but may keep their own settings for it.
    viewer = make_user('viewer')
    set_project_member(project['id'], viewer.id, 'viewer')
    act_as(viewer)
    assert client.put(url, json=DESKTOP).status_code == 200
    assert saved_rows() == [(viewer.id, project['id'])]


def test_settings_are_checked_like_a_run(client: TestClient) -> None:
    too_short = {'analysis_engine': 'stable_v3', 'stable': {'min_dwell_ms': 5}}
    assert client.put('/me/run-settings/default', json=too_short).status_code == 422
    retired = client.put('/me/run-settings/default', json={'analysis_engine': 'hybrid_v2'})
    assert retired.status_code == 422
    assert 'retired' in retired.json()['detail']
    assert saved_rows() == []


def test_saved_settings_go_with_the_project_or_the_account(client: TestClient, act_as) -> None:
    kept = client.post('/projects', json={'name': 'Kept'}).json()
    gone = client.post('/projects', json={'name': 'Gone'}).json()
    ada = make_user('ada')
    for project in (kept, gone):
        set_project_member(project['id'], ada.id, 'owner')
    for user in (None, ada):
        act_as(user)
        client.put('/me/run-settings/default', json=DESKTOP)
        client.put(f"/me/run-settings/projects/{kept['id']}", json=DESKTOP)
        client.put(f"/me/run-settings/projects/{gone['id']}", json=DESKTOP)

    act_as(None)
    assert client.delete(f"/projects/{gone['id']}").status_code == 204
    assert sorted(saved_rows(), key=str) == sorted(
        [(ada.id, None), (ada.id, kept['id']), ('local', None), ('local', kept['id'])], key=str
    )

    delete_user_record(ada.id)
    assert saved_rows() == [('local', None), ('local', kept['id'])]

    # Resetting the database drops the projects, and the settings saved for them, but not anyone's defaults.
    assert client.post('/admin/reset-db', headers=RESET_HEADERS).status_code == 204
    assert saved_rows() == [('local', None)]
    assert saved(client)[None]['recording_type'] == 'desktop'


def test_settings_this_version_no_longer_accepts_are_left_out(client: TestClient) -> None:
    project = client.post('/projects', json={'name': 'Notes'}).json()
    client.put('/me/run-settings/default', json=DESKTOP)
    client.put(f"/me/run-settings/projects/{project['id']}", json=DESKTOP)
    with connect() as conn:
        conn.execute(
            "UPDATE saved_run_settings SET settings = ? WHERE project_id IS NOT NULL",
            ('{"analysis_engine": "stable_v3", "stable": {"min_dwell_ms": 1}}',),
        )
    assert list(saved(client)) == [None]
