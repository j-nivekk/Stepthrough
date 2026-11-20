import assert from 'node:assert/strict';
import test from 'node:test';

import { formatSize, formatTimeLeft, listTagProblems, tagProblem, uploadProblem, visitorDeletionDate, visitorRowsWithoutDate } from '../src/lib/visitors';
import type { SessionUser } from '../src/types';

const MB = 1024 * 1024;

function visitor(used: number | null = 0): SessionUser {
  return {
    id: 'guest',
    name: 'guest',
    display_name: null,
    tags: ['visitor'],
    is_admin: false,
    delete_after: null,
    visitor: { keep_hours: 72, upload_limit_bytes: 500 * MB, storage_limit_bytes: 2000 * MB, storage_used_bytes: used },
  };
}

test('shared and visitor never go on one account, nor either on an administrator', () => {
  assert.match(tagProblem(['shared', 'visitor']) ?? '', /shared or visitor, not both/);
  assert.match(tagProblem(['visitor', ' admin ']) ?? '', /administrator/);
  assert.match(tagProblem(['shared', 'admin']) ?? '', /administrator/);
  assert.equal(tagProblem(['visitor', 'group-a']), null);
  assert.equal(tagProblem(['shared', 'group-a']), null);
  assert.equal(tagProblem([]), null);
});

test('a visitor is told before an upload that would be refused', () => {
  assert.match(uploadProblem(visitor(), { size: 501 * MB }, 'video') ?? '', /500 MB limit/);
  // a project file is held to the room left, not to the upload limit
  assert.equal(uploadProblem(visitor(), { size: 600 * MB }, 'project'), null);
  assert.match(uploadProblem(visitor(1900 * MB), { size: 200 * MB }, 'project') ?? '', /100 MB of 2000 MB left/);
  assert.equal(uploadProblem(visitor(null), { size: 400 * MB }, 'video'), null);
  const ordinary = { ...visitor(), tags: [], visitor: null };
  assert.equal(uploadProblem(ordinary, { size: 5000 * MB }, 'video'), null);
});

test('sizes and times read as people say them', () => {
  assert.equal(formatSize(500 * MB), '500 MB');
  assert.equal(formatSize(2000 * MB), '2000 MB');
  assert.equal(formatSize(20480 * MB), '20 GB');
  assert.equal(formatSize(43909), '43 KB');
  const now = Date.parse('2026-11-20T12:00:00Z');
  assert.equal(formatTimeLeft('2026-11-21T08:00:00Z', now), 'in 20 hours');
  assert.equal(formatTimeLeft('2026-11-20T12:30:00Z', now), 'in 30 minutes');
  assert.equal(formatTimeLeft('2026-11-23T12:00:00Z', now), 'in 3 days');
});

test('a list of people is checked for tags that cannot go together before it is sent', () => {
  const list = 'name,expires,tags\nann,,visitor\nbob,,"shared, visitor"\ncarl,,shared\n';
  assert.deepEqual(
    listTagProblems(list, []).map(({ row, name }) => [row, name]),
    [[3, 'bob']],
  );
  // the tags for everyone count with each row's own
  assert.deepEqual(
    listTagProblems(list, ['visitor']).map(({ row, name }) => [row, name]),
    [[3, 'bob'], [4, 'carl']],
  );
  assert.deepEqual(listTagProblems('name;tags\r\ndora;visitor shared\r\n', []).map(({ name }) => name), ['dora']);
  assert.deepEqual(listTagProblems('name\nemil\n', ['shared']), []);
});

test('every account is told before sending a file larger than the server takes in', () => {
  const ordinary: SessionUser = {
    id: 'ada', name: 'ada', display_name: null, tags: [], is_admin: false, delete_after: null, visitor: null,
    upload_limit_bytes: 1024 * MB, project_file_limit_bytes: 4096 * MB,
  };
  assert.match(uploadProblem(ordinary, { size: 1025 * MB }, 'video') ?? '', /1024 MB upload limit/);
  assert.equal(uploadProblem(ordinary, { size: 3000 * MB }, 'project'), null);
  assert.match(uploadProblem(ordinary, { size: 4097 * MB }, 'project') ?? '', /4096 MB this server takes in/);
  assert.equal(uploadProblem(null, { size: 9999 * MB }, 'project'), null);
});

test('visitor accounts without a date are told the one they get', () => {
  assert.equal(visitorDeletionDate(14, new Date(2026, 10, 20)), '2026-12-04');
  assert.equal(visitorDeletionDate(null), null);
  const list = 'name,expires,tags\nann,,visitor\nbob,2027-01-01,visitor\ncarl,,group-a\n';
  assert.equal(visitorRowsWithoutDate(list, []), 1);
  assert.equal(visitorRowsWithoutDate(list, ['visitor']), 2);
});
