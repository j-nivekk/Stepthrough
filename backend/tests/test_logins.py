"""Password logins, one-time links, the administrators' user management, expiry, and requests from other sites."""

from __future__ import annotations

import time
from datetime import date
import pytest
from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

from app import account_routes, accounts, main
from app.accounts import SESSION_COOKIE, LoginLimiter
from app.repository import find_user_by_name, get_project, list_project_members, set_project_member
from app.storage import project_dir
from app.user_admin import create_account, delete_expired_accounts

ADMIN_PASSWORD = 'correct horse battery'
PASSWORD = 'a long enough password'


@pytest.fixture()
def passwords(client: TestClient, monkeypatch: pytest.MonkeyPatch) -> TestClient:
    """The server as a shared one: people log in with a password."""
    monkeypatch.setattr(main.app.state, 'auth_mode', 'password')
    monkeypatch.setattr(accounts, 'PASSWORD_ITERATIONS', 1_000)  # fast hashes; the format is the same
    monkeypatch.setattr(account_routes, 'login_limiter', LoginLimiter())
    return client


def browser() -> TestClient:
    """Another browser: its own cookies, the same server."""
    return TestClient(main.app)


def make_admin() -> None:
    create_account('ada', tags=['admin'], password=ADMIN_PASSWORD)


def log_in(client: TestClient, name: str, password: str) -> dict:
    response = client.post('/auth/login', json={'name': name, 'password': password})
    assert response.status_code == 200, response.text
    return response.json()


def invite(name: str, *tags: str, delete_after: str | None = None) -> str:
    _row, link = create_account(name, tags=tags, delete_after=delete_after)
    assert link is not None
    return link.token


def test_without_a_login_only_the_page_and_health_answer(passwords: TestClient) -> None:
    assert passwords.get('/auth/session').json() == {'mode': 'password', 'user': None, 'setup_needed': True}
    assert passwords.get('/health').status_code == 200
    for url in ('/me', '/projects', '/admin/users', '/assets/projects/x-12345678/source/a.mp4'):
        response = passwords.get(url)
        assert response.status_code == 401, url
    assert passwords.post('/projects', json={'name': 'x'}).json()['detail'] == 'Log in to continue.'
    with pytest.raises(WebSocketDisconnect), passwords.websocket_connect('/runs/anything/events'):
        pass


def test_an_invitation_link_sets_a_password_once_and_logs_in(passwords: TestClient) -> None:
    token = invite('12345678', 'seminar-a')
    details = passwords.post('/auth/link', json={'token': token}).json()
    assert details == {'name': '12345678', 'display_name': None, 'purpose': 'invite'}

    too_short = passwords.post('/auth/link/password', json={'token': token, 'password': 'short'})
    assert (too_short.status_code, too_short.json()['detail']) == (422, 'Use at least 8 characters.')
    done = passwords.post('/auth/link/password', json={'token': token, 'password': PASSWORD})
    assert done.status_code == 200
    assert done.json()['user']['name'] == '12345678'
    cookie = done.headers['set-cookie']
    assert 'HttpOnly' in cookie and 'SameSite=lax' in cookie and 'Path=/' in cookie and 'Secure' not in cookie
    assert passwords.get('/me').json()['tags'] == ['seminar-a']

    again = passwords.post('/auth/link/password', json={'token': token, 'password': 'something else entirely'})
    assert again.status_code == 404
    assert passwords.post('/auth/link', json={'token': token}).status_code == 404
    log_in(browser(), '12345678', PASSWORD)


def test_a_new_link_replaces_the_old_one_and_resets_the_password(passwords: TestClient) -> None:
    first = invite('bea')
    row = find_user_by_name('bea')
    second = accounts.new_user_link(row['id'])
    assert second.purpose == 'invite'
    assert passwords.post('/auth/link', json={'token': first}).status_code == 404
    passwords.post('/auth/link/password', json={'token': second.token, 'password': PASSWORD})

    other = browser()
    log_in(other, 'BEA', PASSWORD)  # names match in any case
    reset = accounts.new_user_link(row['id'])
    assert reset.purpose == 'reset'
    passwords.post('/auth/link/password', json={'token': reset.token, 'password': 'my new password'})
    # Setting a password logs every other browser out.
    assert other.get('/me').status_code == 401
    assert browser().post('/auth/login', json={'name': 'bea', 'password': PASSWORD}).status_code == 401
    log_in(browser(), 'bea', 'my new password')


def test_wrong_logins_get_one_answer_and_are_slowed_down(passwords: TestClient) -> None:
    make_admin()
    invite('no-password-yet')
    wrong = {'detail': 'That name and password do not match.'}
    assert passwords.post('/auth/login', json={'name': 'ada', 'password': 'nope'}).json() == wrong
    assert passwords.post('/auth/login', json={'name': 'nobody', 'password': 'nope'}).json() == wrong
    assert passwords.post('/auth/login', json={'name': 'no-password-yet', 'password': ''}).json() == wrong
    assert passwords.post('/auth/login', json={'name': 'local', 'password': ''}).json() == wrong
    for _ in range(9):
        passwords.post('/auth/login', json={'name': 'ada', 'password': 'nope'})
    blocked = passwords.post('/auth/login', json={'name': 'ada', 'password': ADMIN_PASSWORD})
    assert blocked.status_code == 429


def test_logging_out_ends_the_session(passwords: TestClient) -> None:
    make_admin()
    log_in(passwords, 'ada', ADMIN_PASSWORD)
    token = passwords.cookies[SESSION_COOKIE]
    assert passwords.get('/projects').status_code == 200
    assert passwords.post('/auth/logout').status_code == 204
    assert passwords.get('/projects').status_code == 401
    stolen = browser()
    stolen.cookies.set(SESSION_COOKIE, token)
    assert stolen.get('/projects').status_code == 401


def test_changing_your_password_keeps_you_in_and_logs_out_elsewhere(passwords: TestClient) -> None:
    make_admin()
    log_in(passwords, 'ada', ADMIN_PASSWORD)
    other = browser()
    log_in(other, 'ada', ADMIN_PASSWORD)
    wrong = passwords.post('/me/password', json={'current_password': 'nope', 'new_password': 'whatever you like'})
    assert wrong.status_code == 403
    short = passwords.post('/me/password', json={'current_password': ADMIN_PASSWORD, 'new_password': 'short'})
    assert short.status_code == 422
    done = passwords.post('/me/password', json={'current_password': ADMIN_PASSWORD, 'new_password': 'whatever you like'})
    assert done.status_code == 204
    assert passwords.get('/me').status_code == 200
    assert other.get('/me').status_code == 401
    log_in(browser(), 'ada', 'whatever you like')


def test_a_switched_off_account_cannot_log_in_or_stay_in(passwords: TestClient) -> None:
    make_admin()
    log_in(passwords, 'ada', ADMIN_PASSWORD)
    person = browser()
    person.post('/auth/link/password', json={'token': invite('cas'), 'password': PASSWORD})
    assert person.get('/me').status_code == 200
    cas = find_user_by_name('cas')
    assert passwords.patch(f"/admin/users/{cas['id']}", json={'is_disabled': True}).json()['is_disabled'] is True
    assert person.get('/me').status_code == 401
    refused = browser().post('/auth/login', json={'name': 'cas', 'password': PASSWORD})
    assert refused.status_code == 403


def test_only_administrators_manage_users(passwords: TestClient) -> None:
    make_admin()
    person = browser()
    person.post('/auth/link/password', json={'token': invite('dex'), 'password': PASSWORD})
    assert person.get('/admin/users').status_code == 403
    assert person.post('/admin/users', json={'name': 'eve'}).status_code == 403

    log_in(passwords, 'ada', ADMIN_PASSWORD)
    listed = {user['name']: user for user in passwords.get('/admin/users').json()}
    assert set(listed) == {'ada', 'dex', 'local'}
    assert listed['local']['is_builtin'] and listed['ada']['is_admin'] and listed['dex']['has_password']

    made = passwords.post(
        '/admin/users', json={'name': 'eve', 'tags': ['seminar-b'], 'delete_after': '2027-02-01'}
    ).json()
    assert made['link']['purpose'] == 'invite'
    assert (made['user']['open_link'], made['user']['delete_after'], made['user']['has_password']) == (
        'invite', '2027-02-01', False
    )
    assert passwords.post('/admin/users', json={'name': 'EVE'}).status_code == 422
    assert passwords.post('/admin/users', json={'name': 'has space'}).json()['detail'].startswith('A name has no spaces')
    bad_tag = passwords.patch(f"/admin/users/{made['user']['id']}", json={'tags': ['two words']})
    assert bad_tag.status_code == 422
    kept = passwords.patch(f"/admin/users/{made['user']['id']}", json={'delete_after': None}).json()
    assert kept['delete_after'] is None and kept['tags'] == ['seminar-b']

    ada = listed['ada']['id']
    assert passwords.patch(f'/admin/users/{ada}', json={'tags': []}).status_code == 400
    assert passwords.patch(f'/admin/users/{ada}', json={'is_disabled': True}).status_code == 400
    assert passwords.delete(f'/admin/users/{ada}').status_code == 400
    assert passwords.patch('/admin/users/local', json={'tags': []}).status_code == 400
    assert passwords.delete('/admin/users/local').status_code == 400
    link = passwords.post(f"/admin/users/{listed['dex']['id']}/link").json()
    assert link['purpose'] == 'reset'


def test_deleting_an_account_deletes_only_the_projects_it_alone_owns(passwords: TestClient) -> None:
    make_admin()
    person = browser()
    person.post('/auth/link/password', json={'token': invite('fay', 'seminar-a'), 'password': PASSWORD})
    alone = person.post('/projects', json={'name': 'Alone'}).json()
    shared = person.post('/projects', json={'name': 'Shared'}).json()
    set_project_member(shared['id'], 'tag:seminar-a', 'owner')
    folders = {p['id']: project_dir(p['slug'], p['id']) for p in (get_project(alone['id']), get_project(shared['id']))}
    for folder in folders.values():
        folder.mkdir(parents=True)  # made on the first upload

    log_in(passwords, 'ada', ADMIN_PASSWORD)
    fay = find_user_by_name('fay')
    deleted = passwords.delete(f"/admin/users/{fay['id']}").json()
    assert deleted == {'deleted_projects': ['Alone']}
    assert passwords.get(f"/projects/{alone['id']}").status_code == 404
    assert passwords.get(f"/projects/{shared['id']}").status_code == 200
    assert [m['member'] for m in list_project_members(shared['id'])] == ['tag:seminar-a']
    assert not folders[alone['id']].exists() and folders[shared['id']].exists()
    assert person.get('/me').status_code == 401


def test_accounts_are_deleted_once_their_date_comes(passwords: TestClient) -> None:
    person = browser()
    person.post('/auth/link/password', json={'token': invite('gus', delete_after='2027-02-01'), 'password': PASSWORD})
    assert person.get('/me').json()['delete_after'] == '2027-02-01'
    project = person.post('/projects', json={'name': 'Field work'}).json()
    invite('hal', delete_after='2027-06-01')
    assert delete_expired_accounts(date(2027, 1, 31)) == []
    assert delete_expired_accounts(date(2027, 2, 1)) == ['gus']
    assert find_user_by_name('gus') is None and find_user_by_name('hal') is not None
    assert person.get('/me').status_code == 401
    log_in(passwords, *_admin())
    assert passwords.get(f"/projects/{project['id']}").status_code == 404


def _admin() -> tuple[str, str]:
    make_admin()
    return 'ada', ADMIN_PASSWORD


def test_a_list_in_4cat_layout_imports(passwords: TestClient) -> None:
    log_in(passwords, *_admin())
    invite('existing')
    listing = (
        'Name;expires;tags;password;notes\n'
        '11111111;2027-02-01;seminar-a, group-1;;first\n'
        '22222222;;seminar-a;their own password;\n'
        'existing;;;;\n'
        'bad name;;;;\n'
        '33333333;1 Feb;;;\n'
        '44444444;;;short;\n'
        ';;;;\n'
    ).encode()
    result = passwords.post(
        '/admin/users/import',
        files={'file': ('people.csv', listing, 'text/csv')},
        data={'tags': 'intake-2026', 'delete_after': '2027-09-01'},
    ).json()
    created = {row['name']: row for row in result['created']}
    assert set(created) == {'11111111', '22222222', '44444444'}
    assert created['11111111']['link']['purpose'] == 'invite' and created['22222222']['link'] is None
    assert result['existing'] == ['existing']
    assert [(error['row'], error['name']) for error in result['errors']] == [(5, 'bad name'), (6, '33333333'), (8, None)]
    # A password from the list is kept as given, even a short one; the result says which are weak.
    assert created['44444444']['link'] is None and result['weak_passwords'] == ['44444444']
    log_in(browser(), '44444444', 'short')
    users = {user['name']: user for user in passwords.get('/admin/users').json()}
    assert users['11111111']['tags'] == ['group-1', 'intake-2026', 'seminar-a']
    assert users['11111111']['delete_after'] == '2027-02-01' and users['11111111']['notes'] == 'first'
    assert users['22222222']['delete_after'] == '2027-09-01'
    log_in(browser(), '22222222', 'their own password')
    no_name = passwords.post('/admin/users/import', files={'file': ('x.csv', b'email\na@b.c\n', 'text/csv')})
    assert no_name.status_code == 422 and 'name' in no_name.json()['detail']


def test_other_websites_cannot_change_anything(client: TestClient) -> None:
    # Also without logins: anything on the computer can reach the desktop app's backend.
    evil = {'Origin': 'https://evil.example', 'Sec-Fetch-Site': 'cross-site'}
    response = client.post('/projects', json={'name': 'x'}, headers=evil)
    assert (response.status_code, response.json()['detail']) == (403, 'Requests from other websites are not accepted.')
    assert client.post('/projects', json={'name': 'x'}, headers={'Origin': 'https://evil.example'}).status_code == 403
    assert client.post('/projects', json={'name': 'x'}, headers={'Sec-Fetch-Site': 'same-site'}).status_code == 403
    assert client.get('/projects', headers=evil).status_code == 200  # reading is left to CORS
    for headers in (
        {'Sec-Fetch-Site': 'same-origin', 'Origin': 'http://testserver'},
        {'Origin': 'http://testserver'},
        {'Origin': 'http://localhost:5173', 'Sec-Fetch-Site': 'same-site'},  # the development frontend
        {},
    ):
        assert client.post('/projects', json={'name': 'x'}, headers=headers).status_code == 200, headers
    run_socket = client.websocket_connect('/runs/missing/events', headers={'Origin': 'https://evil.example'})
    with pytest.raises(WebSocketDisconnect), run_socket:
        pass


def test_a_database_reset_keeps_accounts(passwords: TestClient) -> None:
    log_in(passwords, *_admin())
    passwords.post('/projects', json={'name': 'Gone soon'})
    response = passwords.post('/admin/reset-db', headers={'X-Stepthrough-Confirm': 'reset-database'})
    assert response.status_code == 204
    assert passwords.get('/projects').json() == []
    assert passwords.get('/me').json()['name'] == 'ada'


def test_projects_can_be_handed_over(passwords: TestClient) -> None:
    # Made before logins were switched on: owned by the built-in account, in nobody's list.
    old = passwords.app.state.auth_mode
    passwords.app.state.auth_mode = 'none'
    legacy = passwords.post('/projects', json={'name': 'From before'}).json()
    passwords.app.state.auth_mode = old
    log_in(passwords, *_admin())
    assert passwords.get('/projects').json() == []
    ada = find_user_by_name('ada')
    viewer = browser()
    viewer.post('/auth/link/password', json={'token': invite('ivy'), 'password': PASSWORD})
    set_project_member(legacy['id'], find_user_by_name('ivy')['id'], 'viewer')

    moved = passwords.post('/admin/users/local/transfer-projects', json={'to_user_id': ada['id']})
    assert moved.json() == {'moved': 1}
    assert [p['id'] for p in passwords.get('/projects').json()] == [legacy['id']]
    assert [(m['member'], m['role']) for m in list_project_members(legacy['id'])] == [
        (find_user_by_name('ivy')['id'], 'viewer'), (ada['id'], 'owner')
    ]
    refused = passwords.post('/admin/users/local/transfer-projects', json={'to_user_id': 'local'})
    assert refused.status_code == 422


# ── defences against guessing and other misuse ──────────────────────────────────────────────────────────────


def from_address(address: str) -> dict[str, str]:
    """What the web server in front adds: the visitor's address, after anything the browser sent itself."""
    return {'X-Forwarded-For': address}


@pytest.mark.parametrize('password, why', [
    ('password1', 'common'),
    ('QWERTYUIOP', 'common'),
    ('aaaaaaaaaaaa', 'common'),
    ('ivy-and-a-secret', 'name'),
    ('my stepthrough login', 'name'),
])
def test_weak_passwords_are_refused(passwords: TestClient, password: str, why: str) -> None:
    token = invite('ivy')
    response = passwords.post('/auth/link/password', json={'token': token, 'password': password})
    assert response.status_code == 422
    expected = 'one of the most common ones' if why == 'common' else 'cannot contain your name'
    assert expected in response.json()['detail']
    # The link still works for a better password.
    assert passwords.post('/auth/link/password', json={'token': token, 'password': PASSWORD}).status_code == 200


def test_a_guesser_does_not_lock_the_real_person_out(passwords: TestClient) -> None:
    make_admin()
    for i in range(10):
        login = passwords.post('/auth/login', json={'name': 'ada', 'password': f'guess {i}'}, headers=from_address('198.51.100.7'))
        assert login.status_code == 401
    guesser = passwords.post('/auth/login', json={'name': 'ada', 'password': ADMIN_PASSWORD}, headers=from_address('198.51.100.7'))
    assert guesser.status_code == 429
    real = browser().post('/auth/login', json={'name': 'ada', 'password': ADMIN_PASSWORD}, headers=from_address('203.0.113.5'))
    assert real.status_code == 200


def test_guessing_one_name_from_many_addresses_stops(passwords: TestClient) -> None:
    make_admin()
    for i in range(100):
        passwords.post('/auth/login', json={'name': 'ada', 'password': f'guess {i}'}, headers=from_address(f'198.51.100.{i}'))
    refused = passwords.post('/auth/login', json={'name': 'ada', 'password': ADMIN_PASSWORD}, headers=from_address('203.0.113.5'))
    assert refused.status_code == 429


def test_an_address_trying_many_names_stops_whatever_it_claims_to_be(passwords: TestClient) -> None:
    for i in range(100):
        # The browser may put anything before the web server's own entry; only the last one counts.
        headers = from_address(f'10.9.{i}.{i}, 198.51.100.7')
        assert passwords.post('/auth/login', json={'name': f'spray-{i}', 'password': 'Welcome2026'}, headers=headers).status_code == 401
    refused = passwords.post('/auth/login', json={'name': 'someone-else', 'password': 'Welcome2026'}, headers=from_address('1.2.3.4, 198.51.100.7'))
    assert refused.status_code == 429
    other = passwords.post('/auth/login', json={'name': 'someone-else', 'password': 'Welcome2026'}, headers=from_address('203.0.113.5'))
    assert other.status_code == 401


def test_changing_a_password_cannot_be_used_to_guess_the_current_one(passwords: TestClient) -> None:
    make_admin()
    log_in(passwords, 'ada', ADMIN_PASSWORD)
    for i in range(10):
        wrong = passwords.post('/me/password', json={'current_password': f'guess {i}', 'new_password': 'a fine new password'})
        assert wrong.status_code == 403
    blocked = passwords.post('/me/password', json={'current_password': ADMIN_PASSWORD, 'new_password': 'a fine new password'})
    assert blocked.status_code == 429


def test_attempts_are_logged(passwords: TestClient, caplog: pytest.LogCaptureFixture) -> None:
    make_admin()
    with caplog.at_level('INFO', logger='stepthrough.accounts'):
        passwords.post('/auth/login', json={'name': 'ada', 'password': 'nope'}, headers=from_address('198.51.100.7'))
        passwords.post('/auth/login', json={'name': 'ghost', 'password': 'nope'}, headers=from_address('198.51.100.7'))
        log_in(passwords, 'ada', ADMIN_PASSWORD)
    messages = [record.getMessage() for record in caplog.records]
    assert "Wrong password for 'ada' from 198.51.100.7." in messages
    assert "Wrong password for 'ghost' from 198.51.100.7 (no such account)." in messages
    assert any(message.startswith("'ada' logged in from") for message in messages)
    assert not any('nope' in message or ADMIN_PASSWORD in message for message in messages)


def test_the_limiter_forgets_old_counts_when_it_fills_up() -> None:
    limiter = LoginLimiter(max_keys=50)
    for i in range(200):
        limiter.failed(f'name-{i}', f'198.51.100.{i % 7}')
    assert len(limiter) <= 50
    limiter = LoginLimiter(window_seconds=0.01, max_keys=10)
    for i in range(20):
        limiter.failed(f'name-{i}', '198.51.100.1')
    time.sleep(0.02)
    limiter.failed('last', '198.51.100.2')
    assert len(limiter) == 3  # only the last attempt's counts remain


def test_names_that_spreadsheets_would_run_are_refused(passwords: TestClient) -> None:
    log_in(passwords, *_admin())
    for name in ('=1+1', '+31612345678', '-cmd', '@SUM(A1)'):
        response = passwords.post('/admin/users', json={'name': name})
        assert response.status_code == 422, name
        assert 'formula' in response.json()['detail']
    listing = b'name\n=HYPERLINK("http://x")\nfine.name\n'
    result = passwords.post('/admin/users/import', files={'file': ('x.csv', listing, 'text/csv')}).json()
    assert [row['name'] for row in result['created']] == ['fine.name']
    assert [error['row'] for error in result['errors']] == [2]


def test_reset_links_are_short_lived_and_idle_sessions_end(passwords: TestClient) -> None:
    from datetime import datetime, timedelta, timezone

    from app.database import connect

    invitation = accounts.new_user_link(create_account('jo')[0]['id'])
    jo = find_user_by_name('jo')
    passwords.post('/auth/link/password', json={'token': invitation.token, 'password': PASSWORD})
    reset = accounts.new_user_link(jo['id'])
    days = lambda link: (datetime.fromisoformat(link.expires_at) - datetime.now(timezone.utc)).days  # noqa: E731
    assert (invitation.purpose, days(invitation)) == ('invite', 13)
    assert (reset.purpose, days(reset)) == ('reset', 2)

    assert passwords.get('/me').status_code == 200
    eight_days_ago = (datetime.now(timezone.utc) - timedelta(days=8)).isoformat()
    with connect() as conn:
        conn.execute('UPDATE sessions SET last_seen_at = ?', (eight_days_ago,))
    assert passwords.get('/me').status_code == 401


def test_answers_carry_security_headers(passwords: TestClient) -> None:
    for response in (
        passwords.get('/auth/session'),
        passwords.get('/health'),
        passwords.post('/projects', json={'name': 'x'}, headers={'Origin': 'https://evil.example', 'Sec-Fetch-Site': 'cross-site'}),
    ):
        assert response.headers['x-content-type-options'] == 'nosniff'
        assert response.headers['x-frame-options'] == 'DENY'
        assert response.headers['content-security-policy'] == "frame-ancestors 'none'"
        assert response.headers['referrer-policy'] == 'no-referrer'


def test_health_details_are_for_administrators(passwords: TestClient) -> None:
    main._set_ocr_state(main.OcrHealthState(
        status='available', available=True, message='Models live in /data/ocr-models.', warnings=('paddle 3.3.0 says hi',)
    ))
    anonymous = passwords.get('/health').json()
    assert (anonymous['ocr_message'], anonymous['ocr_warnings']) == ('Text recognition is available.', [])
    assert anonymous['ocr_available'] is True and anonymous['ffmpeg_available'] is True
    person = browser()
    person.post('/auth/link/password', json={'token': invite('kim'), 'password': PASSWORD})
    assert person.get('/health').json()['ocr_warnings'] == []
    log_in(passwords, *_admin())
    admin = passwords.get('/health').json()
    assert (admin['ocr_message'], admin['ocr_warnings']) == ('Models live in /data/ocr-models.', ['paddle 3.3.0 says hi'])


def test_passwords_an_administrator_supplies_are_kept_as_given(
    passwords: TestClient, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    import io

    from app.users import main as users_main

    log_in(passwords, *_admin())
    listing = b'name,password\nlee,12345678\nmona,mona-2026!\nnia,a long enough password\n'
    result = passwords.post('/admin/users/import', files={'file': ('x.csv', listing, 'text/csv')}).json()
    assert sorted(row['name'] for row in result['created']) == ['lee', 'mona', 'nia']
    assert result['weak_passwords'] == ['lee', 'mona'] and result['errors'] == []
    lee = browser()
    log_in(lee, 'lee', '12345678')
    log_in(browser(), 'mona', 'mona-2026!')
    # What people choose themselves still follows the rules.
    again = lee.post('/me/password', json={'current_password': '12345678', 'new_password': 'password1'})
    assert again.status_code == 422
    assert lee.post('/me/password', json={'current_password': '12345678', 'new_password': PASSWORD}).status_code == 204

    # The same from the command line: kept, with a note.
    monkeypatch.setattr('sys.stdin', io.StringIO('qwertyuiop\n'))
    assert users_main(['add', 'pat', '--password-stdin']) == 0
    assert 'It is kept, because an administrator set it' in capsys.readouterr().err
    log_in(browser(), 'pat', 'qwertyuiop')
    too_long = passwords.post(
        '/admin/users/import', files={'file': ('x.csv', b'name,password\nroy,' + b'x' * 1025 + b'\n', 'text/csv')}
    ).json()
    assert too_long['created'] == [] and 'at most 1024' in too_long['errors'][0]['message']


def test_the_login_page_learns_when_nobody_can_log_in_yet(client: TestClient, passwords: TestClient) -> None:
    assert passwords.get('/auth/session').json()['setup_needed'] is True
    invite('only-invited')  # an account without a password still cannot log in
    assert passwords.get('/auth/session').json()['setup_needed'] is True
    make_admin()
    assert passwords.get('/auth/session').json()['setup_needed'] is False
    passwords.app.state.auth_mode = 'none'
    assert passwords.get('/auth/session').json()['setup_needed'] is False
    passwords.app.state.auth_mode = 'password'


@pytest.mark.parametrize('deployment, setting, expected', [
    ('server', None, 'password'),
    ('server', '', 'password'),  # what compose passes when .env does not set it
    ('server', 'none', 'none'),
    ('local', None, 'none'),
    ('local', 'password', 'password'),
])
def test_compose_leaves_servers_on_logins_unless_told(
    monkeypatch: pytest.MonkeyPatch, deployment: str, setting: str | None, expected: str
) -> None:
    from app.config import build_server_config

    monkeypatch.setenv('STEPTHROUGH_DEPLOYMENT', deployment)
    monkeypatch.delenv('STEPTHROUGH_FRONTEND_DIR', raising=False)
    if setting is None:
        monkeypatch.delenv('STEPTHROUGH_AUTH', raising=False)
    else:
        monkeypatch.setenv('STEPTHROUGH_AUTH', setting)
    assert build_server_config().auth == expected
