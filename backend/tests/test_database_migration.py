from __future__ import annotations

import sqlite3

from app import database, repository

OLD_SCHEMA = """
CREATE TABLE projects (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    slug TEXT NOT NULL,
    created_at TEXT NOT NULL
);
CREATE TABLE recordings (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    filename TEXT NOT NULL,
    slug TEXT NOT NULL,
    source_path TEXT NOT NULL,
    duration_ms INTEGER NOT NULL,
    width INTEGER NOT NULL,
    height INTEGER NOT NULL,
    fps REAL NOT NULL,
    created_at TEXT NOT NULL
);
CREATE TABLE detection_runs (
    id TEXT PRIMARY KEY,
    recording_id TEXT NOT NULL REFERENCES recordings(id) ON DELETE CASCADE,
    status TEXT NOT NULL,
    detector_mode TEXT NOT NULL,
    tolerance REAL NOT NULL,
    min_scene_gap_ms INTEGER NOT NULL,
    sample_fps REAL,
    extract_offset_ms INTEGER NOT NULL,
    progress REAL NOT NULL DEFAULT 0,
    message TEXT,
    candidate_count INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    started_at TEXT,
    completed_at TEXT,
    updated_at TEXT NOT NULL,
    export_bundle_id TEXT
);
CREATE TABLE export_bundles (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL UNIQUE REFERENCES detection_runs(id) ON DELETE CASCADE,
    output_dir TEXT NOT NULL,
    zip_path TEXT NOT NULL,
    item_count INTEGER NOT NULL,
    created_at TEXT NOT NULL
);
"""


def test_init_db_migrates_existing_detection_runs(monkeypatch, tmp_path) -> None:
    db_path = tmp_path / 'legacy.sqlite3'
    monkeypatch.setattr(database, 'DB_PATH', db_path)

    with sqlite3.connect(db_path) as conn:
        conn.executescript(OLD_SCHEMA)
        conn.execute(
            "INSERT INTO projects (id, name, slug, created_at) VALUES ('project-1', 'Legacy', 'legacy', '2026-03-12T00:00:00+00:00')"
        )
        conn.execute(
            "INSERT INTO recordings (id, project_id, filename, slug, source_path, duration_ms, width, height, fps, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            ('recording-1', 'project-1', 'legacy.mp4', 'legacy', 'projects/legacy/source/legacy.mp4', 1000, 640, 360, 30.0, '2026-03-12T00:00:00+00:00'),
        )
        conn.execute(
            "INSERT INTO detection_runs (id, recording_id, status, detector_mode, tolerance, min_scene_gap_ms, sample_fps, extract_offset_ms, progress, message, candidate_count, created_at, started_at, completed_at, updated_at, export_bundle_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (
                'run-1',
                'recording-1',
                'completed',
                'content',
                50.0,
                900,
                4.0,
                200,
                1.0,
                'Legacy run',
                1,
                '2026-03-12T00:00:00+00:00',
                '2026-03-12T00:00:00+00:00',
                '2026-03-12T00:01:00+00:00',
                '2026-03-12T00:01:00+00:00',
                None,
            ),
        )
        conn.execute(
            "INSERT INTO export_bundles VALUES (?, ?, ?, ?, ?, ?)",
            ('bundle-1', 'run-1', 'old-bundle', 'old-bundle.zip', 1, '2026-03-12T00:01:00+00:00'),
        )
        conn.commit()

    database.init_db()

    with sqlite3.connect(db_path) as conn:
        columns = {row[1] for row in conn.execute('PRAGMA table_info(detection_runs)').fetchall()}
        assert 'phase' in columns
        assert 'analysis_engine' in columns
        assert 'analysis_preset' in columns
        assert 'analysis_advanced' in columns
        assert 'analysis_config' in columns
        candidate_columns = {row[1] for row in conn.execute('PRAGMA table_info(candidate_frames)').fetchall()}
        assert 'perceptual_hash' in candidate_columns
        assert 'ocr_text' in candidate_columns
        assert 'score_breakdown' in candidate_columns
        event_tables = {row[0] for row in conn.execute("SELECT name FROM sqlite_master WHERE type='table'").fetchall()}
        assert 'run_events' in event_tables
        phase = conn.execute("SELECT phase FROM detection_runs WHERE id = 'run-1'").fetchone()[0]
        assert phase == 'completed'
        # A database from before users: its projects go to the built-in user, an administrator.
        assert conn.execute("SELECT name, tags FROM users WHERE id = 'local'").fetchone() == ('local', '["admin"]')
        members = conn.execute("SELECT project_id, member, role FROM project_members").fetchall()
        assert members == [('project-1', 'local', 'owner')]

    database.init_db()  # running it again changes nothing
    assert repository.get_export_bundle_for_run('run-1')['zip_path'] == 'old-bundle.zip'
    with sqlite3.connect(db_path) as conn:
        assert conn.execute('SELECT COUNT(*) FROM users').fetchone()[0] == 1
        assert conn.execute('SELECT COUNT(*) FROM project_members').fetchone()[0] == 1


def test_runs_from_before_run_numbers_are_numbered_in_the_order_they_were_made(monkeypatch, tmp_path) -> None:
    db_path = tmp_path / 'legacy.sqlite3'
    monkeypatch.setattr(database, 'DB_PATH', db_path)
    with sqlite3.connect(db_path) as conn:
        conn.executescript(OLD_SCHEMA)
        conn.execute("INSERT INTO projects VALUES ('project-1', 'Legacy', 'legacy', '2026-03-12T00:00:00+00:00')")
        for recording_id in ('recording-1', 'recording-2'):
            conn.execute(
                "INSERT INTO recordings VALUES (?, 'project-1', 'legacy.mp4', 'legacy', 'source.mp4', 1000, 640, 360, 30.0, ?)",
                (recording_id, '2026-03-12T00:00:00+00:00'),
            )
        # inserted out of order; the second recording's run is numbered on its own
        for run_id, recording_id, created_at in [
            ('run-c', 'recording-1', '2026-03-14T00:00:00+00:00'),
            ('run-a', 'recording-1', '2026-03-12T00:00:00+00:00'),
            ('run-x', 'recording-2', '2026-03-13T00:00:00+00:00'),
            ('run-b', 'recording-1', '2026-03-13T00:00:00+00:00'),
        ]:
            conn.execute(
                "INSERT INTO detection_runs (id, recording_id, status, detector_mode, tolerance, min_scene_gap_ms, "
                "extract_offset_ms, created_at, updated_at) VALUES (?, ?, 'completed', 'content', 50, 900, 200, ?, ?)",
                (run_id, recording_id, created_at, created_at),
            )
    database.init_db()
    database.init_db()  # running it again changes nothing
    with sqlite3.connect(db_path) as conn:
        numbers = dict(conn.execute('SELECT id, run_number FROM detection_runs').fetchall())
    assert numbers == {'run-a': 1, 'run-b': 2, 'run-c': 3, 'run-x': 1}
    # and the next run of a recording comes after them
    run = repository.create_run('recording-1', repository.RunSettings())
    assert run['run_number'] == 4
    # a run from before changes were recorded says when it was made, and by no one
    assert repository.get_run('run-a')['last_modified_at'] == '2026-03-12T00:00:00+00:00'
