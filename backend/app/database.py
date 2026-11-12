from __future__ import annotations

import json
import sqlite3
from contextlib import contextmanager
from pathlib import Path

from .config import DB_PATH, ensure_app_dirs
from .utils import utc_now

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
    analysis_engine TEXT NOT NULL DEFAULT 'scene_v1',
    analysis_preset TEXT NOT NULL DEFAULT 'balanced',
    analysis_advanced TEXT,
    analysis_stable TEXT,
    analysis_config TEXT,
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
    perceptual_hash TEXT,
    histogram_signature TEXT,
    ocr_text TEXT,
    revisit_group_id TEXT,
    similar_to_candidate_id TEXT,
    similarity_distance REAL,
    score_breakdown TEXT,
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

-- People who use the app. `name` is what they log in with (any case); `tags` is a JSON list, and the `admin` tag
-- makes an administrator. `password_hash` is empty until they set a password from their invitation link.
-- `delete_after` is a date (YYYY-MM-DD) from which the account and the projects only it owns are deleted.
-- The standalone app has one built-in user (LOCAL_USER_ID) and no login.
CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL UNIQUE COLLATE NOCASE,
    display_name TEXT,
    tags TEXT NOT NULL DEFAULT '[]',
    is_disabled INTEGER NOT NULL DEFAULT 0,
    delete_after TEXT,
    notes TEXT,
    password_hash TEXT,
    created_at TEXT NOT NULL,
    last_seen_at TEXT
);

-- Logged-in browsers. The cookie holds a random token; only its SHA-256 is stored, so a copy of the database
-- cannot be used to log in.
CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL,
    last_seen_at TEXT NOT NULL,
    expires_at TEXT NOT NULL
);

-- One-time links to set a password: `invite` for a new account, `reset` for a forgotten password. At most one per
-- user; like sessions, only the token's SHA-256 is stored.
CREATE TABLE IF NOT EXISTS user_links (
    token_hash TEXT PRIMARY KEY,
    user_id TEXT NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
    purpose TEXT NOT NULL CHECK (purpose IN ('invite', 'reset')),
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL
);

-- Who may open a project. `member` is a user id, or `tag:<name>` for everyone with that tag; `role` is `owner`
-- (may change it) or `viewer` (may only look). Recordings, runs, steps and exports follow their project.
CREATE TABLE IF NOT EXISTS project_members (
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    member TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'owner' CHECK (role IN ('owner', 'viewer')),
    created_at TEXT NOT NULL,
    PRIMARY KEY (project_id, member)
);

-- Analysis settings that someone saved to start new runs from: their own defaults (`project_id` NULL), or theirs
-- for one project. `settings` is a run's settings as JSON. They belong to the account, so they follow it to every
-- computer, and go with the account or the project.
CREATE TABLE IF NOT EXISTS saved_run_settings (
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
    settings TEXT NOT NULL,
    saved_at TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_saved_run_settings_scope ON saved_run_settings(user_id, IFNULL(project_id, ''));
CREATE INDEX IF NOT EXISTS idx_saved_run_settings_project ON saved_run_settings(project_id);
CREATE INDEX IF NOT EXISTS idx_project_members_member ON project_members(member);
CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_recordings_project_id ON recordings(project_id);
CREATE INDEX IF NOT EXISTS idx_runs_recording_id ON detection_runs(recording_id);
CREATE INDEX IF NOT EXISTS idx_candidates_run_id ON candidate_frames(run_id);
CREATE INDEX IF NOT EXISTS idx_run_events_run_id ON run_events(run_id, created_at);
"""


# The standalone app's only user, and the owner of every project made before there were users.
LOCAL_USER_ID = "local"
LOCAL_USER_NAME = "local"
ADMIN_TAG = "admin"

# Runs write progress from their own threads while requests read and write too. A writer waits this long for
# another to finish instead of failing at once with "database is locked" (sqlite3's default is 5 s).
BUSY_TIMEOUT_SECONDS = 30


def get_connection() -> sqlite3.Connection:
    ensure_app_dirs()
    conn = sqlite3.connect(DB_PATH, check_same_thread=False, timeout=BUSY_TIMEOUT_SECONDS)
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


def _ensure_local_user(conn: sqlite3.Connection) -> None:
    conn.execute(
        """
        INSERT OR IGNORE INTO users (id, name, display_name, tags, created_at)
        VALUES (?, ?, 'This computer', ?, ?)
        """,
        (LOCAL_USER_ID, LOCAL_USER_NAME, json.dumps([ADMIN_TAG]), utc_now()),
    )


def _adopt_projects_without_members(conn: sqlite3.Connection) -> None:
    """Give projects that nobody may open (all of them, in a database from before users) to the built-in user."""
    conn.execute(
        """
        INSERT INTO project_members (project_id, member, role, created_at)
        SELECT p.id, ?, 'owner', p.created_at
        FROM projects p
        WHERE NOT EXISTS (SELECT 1 FROM project_members m WHERE m.project_id = p.id)
        """,
        (LOCAL_USER_ID,),
    )


def reset_db() -> None:
    """Drop all projects and what is in them, and reinitialise the schema. Accounts and logins are kept, so an
    administrator who resets a shared server can still log in afterwards, and so are everyone's own default
    settings; settings saved for a project go with it."""
    ensure_app_dirs()
    with connect() as conn:
        conn.executescript("""
            PRAGMA foreign_keys = OFF;
            DROP TABLE IF EXISTS project_members;
            DROP TABLE IF EXISTS export_bundles;
            DROP TABLE IF EXISTS run_events;
            DROP TABLE IF EXISTS candidate_frames;
            DROP TABLE IF EXISTS detection_runs;
            DROP TABLE IF EXISTS recordings;
            DROP TABLE IF EXISTS projects;
            PRAGMA foreign_keys = ON;
        """)
    init_db()
    with connect() as conn:
        # Dropping `projects` with foreign keys off does not cascade.
        conn.execute("DELETE FROM saved_run_settings WHERE project_id IS NOT NULL")


def init_db() -> None:
    ensure_app_dirs()
    Path(DB_PATH).parent.mkdir(parents=True, exist_ok=True)
    with connect() as conn:
        # Write-ahead logging lets readers carry on while a run writes, and is a property of the file, so set once
        # here. Back the database up with SQLite's backup API (`python -m app.backup`), not by copying the file.
        conn.execute("PRAGMA journal_mode = WAL")
        conn.executescript(SCHEMA)
        _ensure_column(conn, "detection_runs", "phase", "TEXT NOT NULL DEFAULT 'queued'")
        _ensure_column(conn, "detection_runs", "analysis_engine", "TEXT NOT NULL DEFAULT 'scene_v1'")
        _ensure_column(conn, "detection_runs", "analysis_preset", "TEXT NOT NULL DEFAULT 'balanced'")
        _ensure_column(conn, "detection_runs", "analysis_advanced", "TEXT")
        _ensure_column(conn, "detection_runs", "analysis_config", "TEXT")
        _ensure_column(conn, "detection_runs", "analysis_stable", "TEXT")
        _ensure_column(conn, "detection_runs", "allow_high_fps_sampling", "INTEGER NOT NULL DEFAULT 0")
        _ensure_column(conn, "candidate_frames", "candidate_origin", "TEXT NOT NULL DEFAULT 'detected'")
        _ensure_column(conn, "candidate_frames", "perceptual_hash", "TEXT")
        _ensure_column(conn, "candidate_frames", "ocr_text", "TEXT")
        _ensure_column(conn, "candidate_frames", "score_breakdown", "TEXT")
        _ensure_column(conn, "recordings", "working_path", "TEXT")
        _ensure_column(conn, "users", "notes", "TEXT")
        _ensure_column(conn, "users", "password_hash", "TEXT")
        _backfill_detection_run_phase(conn)
        _ensure_local_user(conn)
        _adopt_projects_without_members(conn)
