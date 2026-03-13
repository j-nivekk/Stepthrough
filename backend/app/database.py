from __future__ import annotations

import sqlite3
from contextlib import contextmanager
from pathlib import Path

from .config import DB_PATH, ensure_app_dirs

SCHEMA = """
CREATE TABLE IF NOT EXISTS projects (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    slug TEXT NOT NULL,
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS recordings (
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

CREATE TABLE IF NOT EXISTS detection_runs (
    id TEXT PRIMARY KEY,
    recording_id TEXT NOT NULL REFERENCES recordings(id) ON DELETE CASCADE,
    status TEXT NOT NULL,
    phase TEXT NOT NULL DEFAULT 'queued',
    detector_mode TEXT NOT NULL,
    tolerance REAL NOT NULL,
    min_scene_gap_ms INTEGER NOT NULL,
    sample_fps REAL,
    allow_high_fps_sampling INTEGER NOT NULL DEFAULT 0,
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

CREATE TABLE IF NOT EXISTS candidate_frames (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL REFERENCES detection_runs(id) ON DELETE CASCADE,
    recording_id TEXT NOT NULL REFERENCES recordings(id) ON DELETE CASCADE,
    detector_index INTEGER NOT NULL,
    candidate_origin TEXT NOT NULL DEFAULT 'detected',
    timestamp_ms INTEGER NOT NULL,
    timestamp_tc TEXT NOT NULL,
    image_path TEXT NOT NULL,
    scene_score REAL NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'pending',
    title TEXT,
    notes TEXT,
    image_hash TEXT,
    histogram_signature TEXT,
    revisit_group_id TEXT,
    similar_to_candidate_id TEXT,
    similarity_distance REAL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE(run_id, detector_index)
);

CREATE TABLE IF NOT EXISTS export_bundles (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL UNIQUE REFERENCES detection_runs(id) ON DELETE CASCADE,
    output_dir TEXT NOT NULL,
    zip_path TEXT NOT NULL,
    item_count INTEGER NOT NULL,
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS run_events (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL REFERENCES detection_runs(id) ON DELETE CASCADE,
    phase TEXT NOT NULL,
    level TEXT NOT NULL,
    message TEXT NOT NULL,
    progress REAL,
    created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_recordings_project_id ON recordings(project_id);
CREATE INDEX IF NOT EXISTS idx_runs_recording_id ON detection_runs(recording_id);
CREATE INDEX IF NOT EXISTS idx_candidates_run_id ON candidate_frames(run_id);
CREATE INDEX IF NOT EXISTS idx_run_events_run_id ON run_events(run_id, created_at);
"""


def get_connection() -> sqlite3.Connection:
    ensure_app_dirs()
    conn = sqlite3.connect(DB_PATH, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    return conn


@contextmanager
def connect() -> sqlite3.Connection:
    conn = get_connection()
    try:
        yield conn
        conn.commit()
    finally:
        conn.close()


def _table_columns(conn: sqlite3.Connection, table_name: str) -> set[str]:
    return {row[1] for row in conn.execute(f"PRAGMA table_info({table_name})").fetchall()}


def _ensure_column(conn: sqlite3.Connection, table_name: str, column_name: str, definition: str) -> None:
    if column_name not in _table_columns(conn, table_name):
        conn.execute(f"ALTER TABLE {table_name} ADD COLUMN {column_name} {definition}")


def _backfill_detection_run_phase(conn: sqlite3.Connection) -> None:
    conn.execute(
        """
        UPDATE detection_runs
        SET phase = CASE status
            WHEN 'completed' THEN 'completed'
            WHEN 'failed' THEN 'failed'
            WHEN 'cancelled' THEN 'cancelled'
            WHEN 'awaiting_fallback' THEN 'awaiting_fallback'
            WHEN 'running' THEN 'primary_scan'
            ELSE 'queued'
        END
        WHERE phase IS NULL OR phase = '' OR phase = 'queued'
        """
    )


def init_db() -> None:
    ensure_app_dirs()
    Path(DB_PATH).parent.mkdir(parents=True, exist_ok=True)
    with connect() as conn:
        conn.executescript(SCHEMA)
        _ensure_column(conn, "detection_runs", "phase", "TEXT NOT NULL DEFAULT 'queued'")
        _ensure_column(conn, "detection_runs", "allow_high_fps_sampling", "INTEGER NOT NULL DEFAULT 0")
        _ensure_column(conn, "candidate_frames", "candidate_origin", "TEXT NOT NULL DEFAULT 'detected'")
        _backfill_detection_run_phase(conn)
