"""The text of a screenshot as PAGE XML. With STEPTHROUGH_PAGE_SCHEMA naming PAGE's schema for 2013-07-15
(pagecontent.xsd, from https://www.primaresearch.org/schema/PAGE/gts/pagecontent/2013-07-15/pagecontent.xsd), the files
are also checked against it, with xmllint."""

from __future__ import annotations

import os
import shutil
import subprocess
import xml.etree.ElementTree as ET
from pathlib import Path

import pytest

from app.services.page_xml import NAMESPACE, file_name, page_xml

SCHEMA = os.environ.get("STEPTHROUGH_PAGE_SCHEMA")
N = {"pc": NAMESPACE}
READING = {
    "engine": "ppocrv6/1",
    "width": 1170,
    "height": 2532,
    "lines": [["Privacy & <settings>", 36, 170, 384, 40, 0.987], ["Wi\x07-Fi 設定", 36, 230, 200, 40, 1], ["edge", 1100, 2500, 100, 60, 0.5]],
}


def written(reading: dict = READING) -> bytes:
    return page_xml(reading, "step-003_00-00-12-300.png", creator="Stepthrough", created="2026-11-26T09:50:12+00:00", comments="step 3")


def test_lines_with_their_places_and_certainty() -> None:
    root = ET.fromstring(written())
    page = root.find("pc:Page", N)
    assert (page.get("imageFilename"), page.get("imageWidth"), page.get("imageHeight")) == ("step-003_00-00-12-300.png", "1170", "2532")
    lines = page.findall("pc:TextRegion/pc:TextLine", N)
    assert [line.find("pc:TextEquiv/pc:Unicode", N).text for line in lines] == ["Privacy & <settings>", "Wi-Fi 設定", "edge"]
    assert [line.find("pc:TextEquiv", N).get("conf") for line in lines] == ["0.987", "1.000", "0.500"]
    assert lines[0].find("pc:Coords", N).get("points") == "36,170 420,170 420,210 36,210"
    # a box that reaches past the screenshot ends at its edge
    assert lines[2].find("pc:Coords", N).get("points") == "1100,2500 1170,2500 1170,2532 1100,2532"
    region = page.find("pc:TextRegion", N)
    assert region.find("pc:Coords", N).get("points") == "36,170 1170,170 1170,2532 36,2532"
    assert region.find("pc:TextEquiv/pc:Unicode", N).text == "Privacy & <settings>\nWi-Fi 設定\nedge"
    assert page.find("pc:ReadingOrder/pc:OrderedGroup/pc:RegionRefIndexed", N).get("regionRef") == "r1"
    assert root.find("pc:Metadata/pc:Comments", N).text == "step 3"


def test_a_screen_without_text_has_a_page_and_nothing_on_it() -> None:
    page = ET.fromstring(written({**READING, "lines": []})).find("pc:Page", N)
    assert page is not None and list(page) == []


def test_it_is_named_after_the_screenshot() -> None:
    assert file_name("step-003_00-00-12-300.png") == "step-003_00-00-12-300.xml"


@pytest.mark.skipif(not SCHEMA or not shutil.which("xmllint"), reason="set STEPTHROUGH_PAGE_SCHEMA to PAGE's pagecontent.xsd")
@pytest.mark.parametrize("reading", [READING, {**READING, "lines": []}])
def test_it_is_valid_page(reading: dict, tmp_path: Path) -> None:
    path = tmp_path / "page.xml"
    path.write_bytes(written(reading))
    check = subprocess.run(["xmllint", "--noout", "--schema", str(SCHEMA), str(path)], capture_output=True, text=True)
    assert check.returncode == 0, check.stderr
