from __future__ import annotations

from pathlib import Path

from .config import DATA_ROOT


def absolute_data_path(relative_path: str) -> Path:
    return DATA_ROOT / relative_path


def relative_data_path(path: Path) -> str:
    return path.resolve().relative_to(DATA_ROOT).as_posix()


def asset_url(relative_path: str) -> str:
    return f"/assets/{relative_path}"


def project_dir(project_slug: str, project_id: str) -> Path:
    return DATA_ROOT / "projects" / f"{project_slug}-{project_id[:8]}"


def recording_dir(project_slug: str, project_id: str, recording_slug: str, recording_id: str) -> Path:
    return project_dir(project_slug, project_id) / "recordings" / f"{recording_slug}-{recording_id[:8]}"


def recording_source_dir(project_slug: str, project_id: str, recording_slug: str, recording_id: str) -> Path:
    return recording_dir(project_slug, project_id, recording_slug, recording_id) / "source"


def recording_source_path(
    project_slug: str,
    project_id: str,
    recording_slug: str,
    recording_id: str,
    filename: str,
) -> Path:
    base = recording_source_dir(project_slug, project_id, recording_slug, recording_id)
    base.mkdir(parents=True, exist_ok=True)
    return base / filename


def run_dir(project_slug: str, project_id: str, recording_slug: str, recording_id: str, run_id: str) -> Path:
    return recording_dir(project_slug, project_id, recording_slug, recording_id) / "runs" / run_id


def run_frames_dir(project_slug: str, project_id: str, recording_slug: str, recording_id: str, run_id: str) -> Path:
    path = run_dir(project_slug, project_id, recording_slug, recording_id, run_id) / "frames"
    path.mkdir(parents=True, exist_ok=True)
    return path


def run_exports_dir(project_slug: str, project_id: str, recording_slug: str, recording_id: str, run_id: str) -> Path:
    path = run_dir(project_slug, project_id, recording_slug, recording_id, run_id) / "exports"
    path.mkdir(parents=True, exist_ok=True)
    return path
