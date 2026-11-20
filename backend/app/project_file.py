"""A whole project as one file: to keep it, take it to another server, or bring it back after it was deleted.

The file is a zip with the videos as they were uploaded, every run's screenshots, and ``project.json``, which says
what the rest is: each recording with its runs, and each run with its settings, its steps (the decisions on them,
titles, notes, screen and pop-up choices, rows) and its phases. The exports of runs, the log of each analysis and
who changed what last stay behind; the working copy of each video is made again after an import. Runs still
analysing are left out (``left_out`` says which).

Importing a file adds its recordings, with their runs and steps, to a project, all with new ids, so the same file
can be brought in twice, or on another server, without clashing.

Files from earlier versions keep opening. ``FORMAT_VERSION`` goes up whenever ``project.json`` changes in a way an
older reader would get wrong, and ``UPGRADES`` then gets a step that brings a file of the version before up to the
new one: a file of any earlier version passes through every later step on its way in. Fields a version does not
have yet are left at the database's defaults. A file from a newer version than this server reads is refused with a
word to update the server, rather than half read. ``tests/project_files`` keeps a file from each version, and the
tests check that every one of them still opens.

Every file in the zip is listed in ``project.json`` with its size and SHA-256, so a damaged or incomplete file is
noticed before anything of it is kept.
"""

from __future__ import annotations

import hashlib
import io
import json
import re
import shutil
import sqlite3
import time
import zipfile
import zlib
from collections.abc import Callable, Iterator
from pathlib import Path
from typing import IO, Any
from uuid import uuid4

from . import __version__
from .config import DATA_ROOT
from .database import connect
from .repository import ACTIVE_RUN_STATUSES, list_recordings
from .services.video import VideoToolError, probe_video, recording_slug_from_filename
from .storage import absolute_data_path, recording_dir, recording_source_path, relative_data_path, run_frames_dir
from .utils import sanitize_filename, utc_now

FORMAT = "stepthrough-project"
FORMAT_VERSION = 1
MANIFEST = "project.json"
SUFFIX = ".stepthrough.zip"
CHUNK = 1024 * 1024
# Room left on the server's disk after an import, so that analyses still have space to work in.
DISK_MARGIN = 512 * 1024 * 1024

# What is kept of each, as the database has it. A field added later goes here too; a file without it gets the
# database's default.
RECORDING_FIELDS = ("filename", "duration_ms", "width", "height", "fps", "created_at")
RUN_FIELDS = (
    "status", "phase", "analysis_engine", "analysis_preset", "analysis_advanced", "analysis_stable", "analysis_config",
    "detector_mode", "tolerance", "min_scene_gap_ms", "sample_fps", "allow_high_fps_sampling", "extract_offset_ms",
    "progress", "message", "created_at", "started_at", "completed_at", "updated_at", "run_number", "name",
    "modified_at",
)
STEP_FIELDS = (
    "id", "detector_index", "candidate_origin", "timestamp_ms", "timestamp_tc", "scene_score", "status", "title",
    "notes", "image_hash", "perceptual_hash", "histogram_signature", "ocr_text", "revisit_group_id",
    "similar_to_candidate_id", "similarity_distance", "score_breakdown", "screen_link", "screen_kind", "pathway_row",
    "created_at", "updated_at",
)

# Steps that bring a project.json of one version up to the next: UPGRADES[1] turns a version 1 file into version 2,
# and so on. None yet: version 1 is the first.
UPGRADES: dict[int, Callable[[dict[str, Any]], dict[str, Any]]] = {}


class ProjectFileError(Exception):
    """What is wrong with a project file, in words for the person who brought it."""


def file_name(project: dict[str, Any]) -> str:
    return f"{project['slug']}{SUFFIX}"


# ── writing ───────────────────────────────────────────────────────────────────────────────────────────────────


class _Pipe(io.RawIOBase):
    """Where the zip is written: whatever it holds is handed on to the download, a piece at a time."""

    def __init__(self) -> None:
        super().__init__()
        self._buffer = bytearray()

    def writable(self) -> bool:
        return True

    def write(self, data: Any) -> int:
        self._buffer += data
        return len(data)

    def take(self) -> bytes:
        data = bytes(self._buffer)
        self._buffer.clear()
        return data


def _rows(sql: str, params: tuple[Any, ...]) -> list[dict[str, Any]]:
    with connect() as conn:
        return [dict(row) for row in conn.execute(sql, params).fetchall()]


def _plan(project: dict[str, Any]) -> tuple[dict[str, Any], list[tuple[str, Path]]]:
    """What project.json says (without the list of files) and which files go in the zip, under which names."""
    manifest: dict[str, Any] = {
        "format": FORMAT,
        "format_version": FORMAT_VERSION,
        "made_with": f"Stepthrough {__version__}",
        "made_at": utc_now(),
        "project": {"name": project["name"], "created_at": project["created_at"]},
        "recordings": [],
        "left_out": [],
    }
    files: list[tuple[str, Path]] = []
    run_count = 0
    for number, recording in enumerate(sorted(list_recordings(project["id"]), key=lambda row: row["created_at"]), start=1):
        video = absolute_data_path(recording["source_path"])
        if not video.is_file():
            manifest["left_out"].append(f"{recording['filename']}: its video is missing on the server")
            continue
        video_name = f"videos/{number}/{video.name}"
        files.append((video_name, video))
        runs = []
        for run in _rows("SELECT * FROM detection_runs WHERE recording_id = ? ORDER BY created_at", (recording["id"],)):
            label = f"{recording['filename']}, run {run.get('run_number') or '?'}"
            if run["status"] in ACTIVE_RUN_STATUSES:
                manifest["left_out"].append(f"{label}: it was still analysing")
                continue
            run_count += 1
            steps = []
            for step in _rows("SELECT * FROM candidate_frames WHERE run_id = ? ORDER BY detector_index", (run["id"],)):
                image = absolute_data_path(step["image_path"]) if step.get("image_path") else None
                image_name = None
                if image is not None and image.is_file():
                    image_name = f"frames/{run_count}/{image.name}"
                    files.append((image_name, image))
                steps.append({**{field: step.get(field) for field in STEP_FIELDS}, "image": image_name})
            phases = _rows("SELECT start_ms, name FROM run_phases WHERE run_id = ? ORDER BY start_ms", (run["id"],))
            runs.append(
                {
                    **{field: run.get(field) for field in RUN_FIELDS},
                    "phases": [[phase["start_ms"], phase["name"]] for phase in phases],
                    "steps": steps,
                }
            )
        manifest["recordings"].append({**{field: recording.get(field) for field in RECORDING_FIELDS}, "video": video_name, "runs": runs})
    return manifest, files


def estimated_size(project: dict[str, Any]) -> int:
    """About how large the project file of ``project`` will be, in bytes: its files as they are, project.json, and
    the zip's own records (the files are stored, not compressed, so this is close)."""
    manifest, files = _plan(project)
    sizes = 0
    for _name, source in files:
        try:
            sizes += source.stat().st_size
        except OSError:
            pass
    # project.json goes in compressed, and without its list of files yet, which adds about 100 bytes a file
    listing = len(zlib.compress(json.dumps(manifest, ensure_ascii=False, indent=1).encode())) + 100 * len(files)
    return sizes + listing + 200 * (len(files) + 1)


def stream(project: dict[str, Any]) -> Iterator[bytes]:
    """The project file, a piece at a time, as it is made: the download starts at once, and nothing is kept on the
    server. The videos and screenshots go in as they are (they are compressed already); project.json, with each
    file's size and checksum, comes last."""
    manifest, files = _plan(project)
    pipe = _Pipe()
    now = time.localtime()[:6]
    listed: dict[str, dict[str, Any]] = {}
    with zipfile.ZipFile(pipe, "w", allowZip64=True) as archive:
        for name, source in files:
            info = zipfile.ZipInfo(name, date_time=now)
            info.compress_type = zipfile.ZIP_STORED
            info.file_size = source.stat().st_size
            digest = hashlib.sha256()
            size = 0
            with source.open("rb") as reader, archive.open(info, "w") as writer:
                while chunk := reader.read(CHUNK):
                    digest.update(chunk)
                    size += len(chunk)
                    writer.write(chunk)
                    if data := pipe.take():
                        yield data
            listed[name] = {"size": size, "sha256": digest.hexdigest()}
            if data := pipe.take():
                yield data
        manifest["files"] = listed
        info = zipfile.ZipInfo(MANIFEST, date_time=now)
        info.compress_type = zipfile.ZIP_DEFLATED
        archive.writestr(info, json.dumps(manifest, ensure_ascii=False, indent=1))
    if data := pipe.take():
        yield data


# ── reading ───────────────────────────────────────────────────────────────────────────────────────────────────


DAMAGED = "The project file is damaged or incomplete. Download it again from where it was made."


def read_manifest(archive: zipfile.ZipFile) -> dict[str, Any]:
    """project.json, brought up to this version; refused when it is not a project file, or one from a newer version."""
    try:
        raw = archive.read(MANIFEST)
    except KeyError:
        names = set(archive.namelist())
        if {"steps.json", "manifest.json"} & names:
            raise ProjectFileError(
                "This is the export of one run (its steps and screenshots, to work with elsewhere), not a project file. "
                "A project file is made with download, on the list of projects."
            ) from None
        raise ProjectFileError("This zip file is not a Stepthrough project file.") from None
    except (zipfile.BadZipFile, OSError):
        raise ProjectFileError(DAMAGED) from None
    try:
        manifest = json.loads(raw)
    except ValueError:
        raise ProjectFileError(DAMAGED) from None
    if not isinstance(manifest, dict) or manifest.get("format") != FORMAT:
        raise ProjectFileError("This zip file is not a Stepthrough project file.")
    version = manifest.get("format_version")
    if not isinstance(version, int) or version < 1:
        raise ProjectFileError(DAMAGED)
    if version > FORMAT_VERSION:
        made_with = manifest.get("made_with") or "a newer Stepthrough"
        raise ProjectFileError(
            f"This project file was made with {made_with}, which is newer than this server (Stepthrough {__version__}). "
            "Update the server first, or import it on one that is up to date."
        )
    while version < FORMAT_VERSION:
        manifest = UPGRADES[version](manifest)
        version += 1
        manifest["format_version"] = version
    return manifest


def project_name(source: IO[bytes]) -> str:
    """The name of the project in a file, for a new project made from it; refused as an import would be."""
    try:
        with zipfile.ZipFile(source) as archive:
            manifest = read_manifest(archive)
    except (zipfile.BadZipFile, OSError):
        raise ProjectFileError("This is not a Stepthrough project file: it should be a .zip file, made with download.") from None
    finally:
        source.seek(0)
    project = manifest.get("project") if isinstance(manifest.get("project"), dict) else {}
    name = " ".join(str(project.get("name") or "").split())[:120]
    return name or "imported project"


def _listed(manifest: dict[str, Any], archive: zipfile.ZipFile, name: Any) -> tuple[zipfile.ZipInfo, dict[str, Any]]:
    files = manifest.get("files")
    if not isinstance(name, str) or not isinstance(files, dict) or not isinstance(files.get(name), dict):
        raise ProjectFileError(DAMAGED)
    try:
        return archive.getinfo(name), files[name]
    except KeyError:
        raise ProjectFileError(DAMAGED) from None


def _unpack(archive: zipfile.ZipFile, info: zipfile.ZipInfo, listed: dict[str, Any], destination: Path) -> None:
    """One file out of the zip, checked against its size and checksum on the way."""
    size = listed.get("size")
    digest = hashlib.sha256()
    written = 0
    destination.parent.mkdir(parents=True, exist_ok=True)
    try:
        with archive.open(info) as reader, destination.open("wb") as writer:
            while chunk := reader.read(CHUNK):
                written += len(chunk)
                if not isinstance(size, int) or written > size:
                    raise ProjectFileError(DAMAGED)
                digest.update(chunk)
                writer.write(chunk)
    except (zipfile.BadZipFile, EOFError, zipfile.LargeZipFile):
        raise ProjectFileError(DAMAGED) from None
    if written != size or digest.hexdigest() != listed.get("sha256"):
        raise ProjectFileError(DAMAGED)


_SAFE_NAME = re.compile(r"[^A-Za-z0-9._-]+")


def _frame_name(name: str, taken: set[str]) -> str:
    base = _SAFE_NAME.sub("-", Path(name).name).strip(".-") or "step.png"
    candidate, number = base, 1
    while candidate in taken:
        number += 1
        candidate = f"{Path(base).stem}-{number}{Path(base).suffix}"
    taken.add(candidate)
    return candidate


def _insert(conn: sqlite3.Connection, table: str, row: dict[str, Any], columns: set[str]) -> None:
    keys = [key for key in row if key in columns]
    conn.execute(
        f"INSERT INTO {table} ({', '.join(keys)}) VALUES ({', '.join('?' for _ in keys)})",
        [row[key] for key in keys],
    )


def _table_columns(conn: sqlite3.Connection, table: str) -> set[str]:
    return {row[1] for row in conn.execute(f"PRAGMA table_info({table})").fetchall()}


def needed_room(archive: zipfile.ZipFile) -> int:
    """How much the files of a project file take once unpacked."""
    return sum(info.file_size for info in archive.infolist() if info.filename != MANIFEST)


def import_into(
    source: IO[bytes],
    project: dict[str, Any],
    *,
    max_video_bytes: int | None = None,
    max_total_bytes: int | None = None,
    room_bytes: int | None = None,
    too_full: Callable[[int], str] | None = None,
) -> list[str]:
    """Bring the recordings of a project file, with their runs, steps and phases, into ``project``. Returns the new
    recordings' ids. ``max_video_bytes`` is the largest video this account may upload, ``max_total_bytes`` the
    largest project file the server takes in, and ``room_bytes`` how much the account may still keep (``too_full``
    says so, given what the file needs). Nothing stays behind when it fails."""
    try:
        archive = zipfile.ZipFile(source)
    except (zipfile.BadZipFile, OSError):
        raise ProjectFileError("This is not a Stepthrough project file: it should be a .zip file, made with download.") from None
    made: list[Path] = []
    try:
        with archive:
            manifest = read_manifest(archive)
            recordings = manifest.get("recordings")
            if not isinstance(recordings, list):
                raise ProjectFileError(DAMAGED)
            if not recordings:
                raise ProjectFileError("This project file has no videos in it, so there is nothing to bring in.")

            # Everything that can be known before unpacking is checked first.
            needed = needed_room(archive)
            for recording in recordings:
                if not isinstance(recording, dict):
                    raise ProjectFileError(DAMAGED)
                info, _ = _listed(manifest, archive, recording.get("video"))
                if max_video_bytes is not None and info.file_size > max_video_bytes:
                    raise ProjectFileError(
                        f"The video {recording.get('filename') or info.filename} is larger than the "
                        f"{max_video_bytes // (1024 * 1024)} MB upload limit of this account."
                    )
            if max_total_bytes is not None and needed > max_total_bytes:
                raise ProjectFileError(
                    f"This project file is larger than the {max_total_bytes // (1024 * 1024)} MB this server takes in at once."
                )
            if room_bytes is not None and needed > room_bytes:
                raise ProjectFileError(too_full(needed) if too_full else "There is not enough room left for this project file.")
            if needed > shutil.disk_usage(DATA_ROOT).free - DISK_MARGIN:
                raise ProjectFileError("There is not enough room left on the server for this project file.")

            rows: list[tuple[str, dict[str, Any]]] = []
            recording_ids: list[str] = []
            now = utc_now()
            for recording in recordings:
                rows_of_recording = _unpack_recording(archive, manifest, recording, project, made, now)
                recording_ids.append(rows_of_recording[0][1]["id"])
                rows.extend(rows_of_recording)

            with connect() as conn:
                columns = {table: _table_columns(conn, table) for table in {table for table, _ in rows}}
                try:
                    for table, row in rows:
                        _insert(conn, table, row, columns[table])
                except sqlite3.Error:
                    raise ProjectFileError(DAMAGED) from None
            return recording_ids
    except BaseException:
        for path in made:
            shutil.rmtree(path, ignore_errors=True)
        raise


def _unpack_recording(
    archive: zipfile.ZipFile,
    manifest: dict[str, Any],
    recording: dict[str, Any],
    project: dict[str, Any],
    made: list[Path],
    now: str,
) -> list[tuple[str, dict[str, Any]]]:
    """Unpack one recording's video and screenshots into place, and return the rows to store for it, its own first."""
    info, listed = _listed(manifest, archive, recording.get("video"))
    recording_id = uuid4().hex
    filename = sanitize_filename(str(recording.get("filename") or Path(info.filename).name))
    slug = recording_slug_from_filename(filename)
    made.append(recording_dir(project["slug"], project["id"], slug, recording_id))
    video = recording_source_path(project["slug"], project["id"], slug, recording_id, filename)
    _unpack(archive, info, listed, video)
    try:
        metadata = probe_video(video)
    except VideoToolError as error:
        raise ProjectFileError(f"The video {filename} in the project file cannot be read: {error}") from None
    rows: list[tuple[str, dict[str, Any]]] = [
        (
            "recordings",
            {
                "id": recording_id,
                "project_id": project["id"],
                "filename": filename,
                "slug": slug,
                "source_path": relative_data_path(video),
                "duration_ms": metadata.duration_ms,
                "width": metadata.width,
                "height": metadata.height,
                "fps": metadata.fps,
                "created_at": now,
            },
        )
    ]
    runs = recording.get("runs") or []
    if not isinstance(runs, list):
        raise ProjectFileError(DAMAGED)
    numbers = [run.get("run_number") for run in runs if isinstance(run, dict) and isinstance(run.get("run_number"), int)]
    next_number = max(numbers, default=0) + 1
    for run in runs:
        if not isinstance(run, dict) or not isinstance(run.get("steps", []), list):
            raise ProjectFileError(DAMAGED)
        run_id = uuid4().hex
        row = {field: run.get(field) for field in RUN_FIELDS if field in run}
        if not isinstance(row.get("run_number"), int):
            row["run_number"], next_number = next_number, next_number + 1
        if row.get("status") in ACTIVE_RUN_STATUSES:
            # not written by Stepthrough, which leaves running analyses out, but it cannot go on here
            row.update(status="cancelled", phase="cancelled", message="Ended before the project file was made")
        steps = run.get("steps") or []
        row.update(id=run_id, recording_id=recording_id, candidate_count=len(steps))
        rows.append(("detection_runs", row))

        frames = run_frames_dir(project["slug"], project["id"], slug, recording_id, run_id)
        if not all(isinstance(step, dict) for step in steps):
            raise ProjectFileError(DAMAGED)
        new_ids = [uuid4().hex for _ in steps]
        # the file's ids only say which step another one points at (its screen, or the one it looks like)
        ids = {step["id"]: new_id for step, new_id in zip(steps, new_ids) if isinstance(step.get("id"), str)}
        taken: set[str] = set()
        for step, new_id in zip(steps, new_ids):
            image_path = ""
            if step.get("image") is not None:
                image_info, image_listed = _listed(manifest, archive, step["image"])
                image = frames / _frame_name(image_info.filename, taken)
                _unpack(archive, image_info, image_listed, image)
                image_path = relative_data_path(image)
            screen_link = step.get("screen_link")
            rows.append(
                (
                    "candidate_frames",
                    {
                        **{field: step.get(field) for field in STEP_FIELDS if field in step},
                        "id": new_id,
                        "run_id": run_id,
                        "recording_id": recording_id,
                        "image_path": image_path,
                        "similar_to_candidate_id": ids.get(step.get("similar_to_candidate_id")),
                        "screen_link": screen_link if screen_link in (None, "new") else ids.get(screen_link),
                    },
                )
            )
        for phase in run.get("phases") or []:
            if not (isinstance(phase, list) and len(phase) == 2 and isinstance(phase[0], int) and isinstance(phase[1], str)):
                raise ProjectFileError(DAMAGED)
            rows.append(("run_phases", {"run_id": run_id, "start_ms": phase[0], "name": phase[1]}))
    return rows
