"""One version number across the backend, the frontend and the release tags, and build labels for edge images."""

from __future__ import annotations

import json
import tomllib
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app import __version__
from app.config import build_label

ROOT = Path(__file__).resolve().parents[2]


def test_the_version_is_the_same_everywhere() -> None:
    backend = tomllib.loads((ROOT / 'backend' / 'pyproject.toml').read_text())['project']['version']
    assert __version__ == backend
    package = ROOT / 'frontend' / 'package.json'
    if not package.exists():
        pytest.skip('the frontend sources are not here (the Docker test image has only the built pages)')
    assert json.loads(package.read_text())['version'] == __version__


@pytest.mark.parametrize('build, revision, label', [
    (None, None, None),  # from source
    ('dev', 'unknown', None),  # an image built without CI's arguments
    ('1.0.0', '80892ff9306d', None),  # a release
    ('1.0.0-ocr', '80892ff9306d', None),
    ('edge', '80892ff9306d20255e0a8f37a72f87376cdcdf65', 'edge 80892ff'),
    ('edge-ocr', '80892ff9306d', 'edge-ocr 80892ff'),
    ('edge', 'unknown', 'edge'),
])
def test_edge_builds_say_which_build_they_are(
    monkeypatch: pytest.MonkeyPatch, build: str | None, revision: str | None, label: str | None
) -> None:
    for name, value in (('STEPTHROUGH_BUILD', build), ('STEPTHROUGH_REVISION', revision)):
        if value is None:
            monkeypatch.delenv(name, raising=False)
        else:
            monkeypatch.setenv(name, value)
    assert build_label() == label


def test_health_reports_the_version(client: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv('STEPTHROUGH_BUILD', 'edge')
    monkeypatch.setenv('STEPTHROUGH_REVISION', '80892ff9306d')
    health = client.get('/health').json()
    assert (health['version'], health['build']) == (__version__, 'edge 80892ff')
