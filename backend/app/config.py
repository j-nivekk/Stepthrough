from __future__ import annotations

import os
import shutil
from dataclasses import dataclass
from pathlib import Path
from typing import Literal

ROOT_DIR = Path(__file__).resolve().parents[2]
DATA_ROOT = Path(os.environ.get("STEPTHROUGH_DATA_ROOT", ROOT_DIR / "data")).resolve()
DB_PATH = DATA_ROOT / "stepthrough.sqlite3"


@dataclass(frozen=True)
class ToolDiagnostics:
    ffmpeg_available: bool
    ffprobe_available: bool
    missing_tools: tuple[str, ...]
    message: str


DeploymentMode = Literal["local", "server"]
# `none`: every request comes from the built-in local user (the desktop app). `password`: people log in.
AuthMode = Literal["none", "password"]
LOCAL_DEV_ORIGINS = (
    "http://localhost:5173",
    "http://127.0.0.1:5173",
    "http://localhost:4173",
    "http://127.0.0.1:4173",
)
DEFAULT_MAX_UPLOAD_MB = 2048
# A project file holds every video of a project, so it may be larger than one upload.
DEFAULT_MAX_PROJECT_FILE_MB = 4096
DEFAULT_SERVER_MAX_CONCURRENT_RUNS = 2


@dataclass(frozen=True)
class ServerConfig:
    deployment: DeploymentMode
    cors_origins: tuple[str, ...]
    max_upload_bytes: int
    allow_admin_reset: bool
    # None means no limit: the desktop app runs whatever its one user starts.
    max_concurrent_runs: int | None = None
    # A built frontend (`npm run build` output) to serve from the API's own origin, as the Docker image does.
    frontend_dir: Path | None = None
    auth: AuthMode = "none"
    # The largest project file (app/project_file.py) brought in at once; never less than max_upload_bytes.
    max_project_file_bytes: int = DEFAULT_MAX_PROJECT_FILE_MB * 1024 * 1024


def _env_flag(name: str, default: bool) -> bool:
    value = os.environ.get(name)
    if value is None or not value.strip():
        return default
    return value.strip().lower() in {"1", "true", "yes", "on"}


def build_server_config() -> ServerConfig:
    """`local` keeps the single-user desktop behaviour; `server` is the shared, multi-user default."""
    deployment = os.environ.get("STEPTHROUGH_DEPLOYMENT", "local").strip().lower() or "local"
    if deployment not in ("local", "server"):
        raise ValueError(f"Invalid STEPTHROUGH_DEPLOYMENT `{deployment}`. Use `local` or `server`.")
    origins_env = os.environ.get("STEPTHROUGH_CORS_ORIGINS")
    if origins_env is not None:
        cors_origins = tuple(origin.strip().rstrip("/") for origin in origins_env.split(",") if origin.strip())
    else:
        # A server serves the frontend from its own origin, so it needs no cross-origin access by default.
        cors_origins = LOCAL_DEV_ORIGINS if deployment == "local" else ()
    max_upload_mb = float(os.environ.get("STEPTHROUGH_MAX_UPLOAD_MB") or DEFAULT_MAX_UPLOAD_MB)
    max_project_file_mb = max(max_upload_mb, float(os.environ.get("STEPTHROUGH_MAX_PROJECT_FILE_MB") or DEFAULT_MAX_PROJECT_FILE_MB))
    return ServerConfig(
        deployment=deployment,  # type: ignore[arg-type]
        cors_origins=cors_origins,
        max_upload_bytes=int(max_upload_mb * 1024 * 1024),
        allow_admin_reset=_env_flag("STEPTHROUGH_ALLOW_ADMIN_RESET", deployment == "local"),
        max_concurrent_runs=_max_concurrent_runs(deployment),
        frontend_dir=_frontend_dir(),
        auth=_auth_mode(deployment),
        max_project_file_bytes=int(max_project_file_mb * 1024 * 1024),
    )


def _auth_mode(deployment: str) -> AuthMode:
    """Whether people log in. A shared server always should; the desktop app has one user and no logins."""
    raw = (os.environ.get("STEPTHROUGH_AUTH") or "").strip().lower()
    if not raw:
        return "password" if deployment == "server" else "none"
    if raw not in ("none", "password"):
        raise ValueError(f"Invalid STEPTHROUGH_AUTH `{raw}`. Use `none` or `password`.")
    return raw  # type: ignore[return-value]


def build_label() -> str | None:
    """Which build this is, when it is not a release: `edge 80892ff` for an image built from the main branch.

    The Docker build passes the image's tag and commit in (STEPTHROUGH_BUILD, STEPTHROUGH_REVISION). Release images
    carry their version number (`1.0.0`), and builds from source carry nothing; neither needs a label.
    """
    build = (os.environ.get("STEPTHROUGH_BUILD") or "").strip()
    revision = (os.environ.get("STEPTHROUGH_REVISION") or "").strip()[:7]
    if not build or build == "dev" or build[0].isdigit():
        return None
    return f"{build} {revision}".strip() if revision and revision != "unknown" else build


def public_url() -> str | None:
    """The address people open: links printed by `python -m app.users` start with it (the web pages know their
    own), and an https address keeps the session cookie to HTTPS."""
    raw = (os.environ.get("STEPTHROUGH_PUBLIC_URL") or "").strip().rstrip("/")
    return raw or None


def _max_concurrent_runs(deployment: str) -> int | None:
    """Detection runs allowed at once; later runs wait as `queued`. `0` lifts the limit."""
    raw = (os.environ.get("STEPTHROUGH_MAX_CONCURRENT_RUNS") or "").strip()
    if not raw:
        # A shared server must not start one analysis per user at the same moment.
        return DEFAULT_SERVER_MAX_CONCURRENT_RUNS if deployment == "server" else None
    try:
        value = int(raw)
    except ValueError as exc:
        raise ValueError(f"Invalid STEPTHROUGH_MAX_CONCURRENT_RUNS `{raw}`. Use a whole number; 0 means no limit.") from exc
    if value < 0:
        raise ValueError(f"Invalid STEPTHROUGH_MAX_CONCURRENT_RUNS `{raw}`. Use a whole number; 0 means no limit.")
    return value or None


def _frontend_dir() -> Path | None:
    raw = (os.environ.get("STEPTHROUGH_FRONTEND_DIR") or "").strip()
    if not raw:
        return None
    directory = Path(raw).expanduser().resolve()
    if not (directory / "index.html").is_file():
        raise ValueError(f"STEPTHROUGH_FRONTEND_DIR `{directory}` has no index.html. Point it at the frontend's `dist` folder.")
    return directory


def ensure_app_dirs() -> None:
    DATA_ROOT.mkdir(parents=True, exist_ok=True)
    (DATA_ROOT / "projects").mkdir(parents=True, exist_ok=True)


def build_tool_diagnostics() -> ToolDiagnostics:
    ffmpeg_available = shutil.which("ffmpeg") is not None
    ffprobe_available = shutil.which("ffprobe") is not None
    missing = tuple(
        tool
        for tool, available in (("ffmpeg", ffmpeg_available), ("ffprobe", ffprobe_available))
        if not available
    )
    if missing:
        message = (
            "Missing required video tools: "
            + ", ".join(missing)
            + ". Install FFmpeg and ensure ffmpeg/ffprobe are on PATH."
        )
    else:
        message = "Video tools ready."
    return ToolDiagnostics(
        ffmpeg_available=ffmpeg_available,
        ffprobe_available=ffprobe_available,
        missing_tools=missing,
        message=message,
    )
