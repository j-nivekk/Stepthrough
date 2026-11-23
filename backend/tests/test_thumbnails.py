from __future__ import annotations

import io
import os
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from PIL import Image

from app import thumbnails


def _image(path: Path, size: tuple[int, int]) -> Path:
    Image.new('RGB', size, (200, 40, 40)).save(path)
    return path


def test_a_copy_is_made_once_beside_the_image_and_again_when_the_image_changes(tmp_path: Path) -> None:
    source = _image(tmp_path / 'frame.png', (1600, 1000))
    copy = thumbnails.thumbnail(source, 640)
    assert copy == tmp_path / '.thumbs' / 'frame.w640.webp'
    with Image.open(copy) as image:
        assert image.format == 'WEBP' and image.size == (640, 400)

    made = copy.stat().st_mtime_ns
    assert thumbnails.thumbnail(source, 640) == copy
    assert copy.stat().st_mtime_ns == made, 'a current copy is used as it is'

    _image(source, (1600, 800))
    later = copy.stat().st_mtime + 5
    os.utime(source, (later, later))
    with Image.open(thumbnails.thumbnail(source, 640)) as image:
        assert image.size == (640, 320), 'a newer image is copied again'
    assert not [name for name in os.listdir(copy.parent) if name.endswith('.tmp')]


def test_an_image_no_wider_than_asked_is_used_as_it_is(tmp_path: Path) -> None:
    source = _image(tmp_path / 'small.png', (300, 600))
    assert thumbnails.thumbnail(source, 320) == source
    with pytest.raises(ValueError):
        thumbnails.thumbnail(source, 500)


def test_the_asset_route_hands_out_copies_of_screenshots(client: TestClient, video_factory, wait_for_run) -> None:
    project = client.post('/projects', json={'name': 'Thumbnails'}).json()
    video = video_factory('thumbs.mp4', ['red', 'blue'])
    with video.open('rb') as handle:
        recording = client.post('/recordings/import', files={'file': (video.name, handle, 'video/mp4')},
                                data={'project_id': project['id']}).json()
    run = client.post(f"/recordings/{recording['id']}/runs", json={}).json()
    detail = wait_for_run(client, run['id'])
    url = detail['candidates'][0]['image_url']

    full = client.get(url)
    assert full.status_code == 200 and full.headers['content-type'] == 'image/png'
    small = client.get(f'{url}?w=320')
    assert small.status_code == 200 and small.headers['content-type'] == 'image/webp'
    with Image.open(io.BytesIO(small.content)) as image:
        assert image.width == 320
    assert len(small.content) < len(full.content)
    # the copy is checked like the image: "not modified" when the browser's copy is current
    again = client.get(f'{url}?w=320', headers={'if-none-match': small.headers['etag']})
    assert again.status_code == 304
    # the test video is 640 wide: asked for as wide, the screenshot itself comes back
    assert client.get(f'{url}?w=640').headers['content-type'] == 'image/png'
    assert client.get(f'{url}?w=500').status_code == 422
