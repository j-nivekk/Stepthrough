from __future__ import annotations

import sqlite3

from app import database

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
