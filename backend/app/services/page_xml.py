"""The text read on a screenshot as PAGE XML (version 2013-07-15), the format in which Transkribus, eScriptorium, OCR-D
and Loghi keep recognised text with its place on the image: https://github.com/PRImA-Research-Lab/PAGE-XML

An export has one file for each screenshot whose text was read, in ``images/page/`` with the screenshot's name, so that
the folder ``images`` can be opened in those tools as it is. Each file has one text region with the lines in reading
order; a line has its box (as a rectangle: there are no baselines) and how sure the engine was (``conf``).
"""

from __future__ import annotations

import re
import xml.etree.ElementTree as ET
from pathlib import Path
from typing import Any

NAMESPACE = "http://schema.primaresearch.org/PAGE/gts/pagecontent/2013-07-15"
SCHEMA = f"{NAMESPACE}/pagecontent.xsd"
XSI = "http://www.w3.org/2001/XMLSchema-instance"
FOLDER = "page"  # beside the screenshots
# What XML 1.0 cannot hold, whatever it is escaped as
_NOT_IN_XML = re.compile("[\x00-\x08\x0b\x0c\x0e-\x1f￾￿]")


def file_name(image_filename: str) -> str:
    return f"{Path(image_filename).stem}.xml"


def _points(left: int, top: int, right: int, bottom: int) -> str:
    return f"{left},{top} {right},{top} {right},{bottom} {left},{bottom}"


def _in(parent: ET.Element, tag: str, attributes: dict[str, str] | None = None) -> ET.Element:
    return ET.SubElement(parent, tag, attributes or {})


def _text(parent: ET.Element, text: str, conf: float | None = None) -> None:
    equiv = _in(parent, "TextEquiv", {"conf": f"{min(1.0, max(0.0, conf)):.3f}"} if conf is not None else None)
    _in(equiv, "Unicode").text = _NOT_IN_XML.sub("", text)


def page_xml(reading: dict[str, Any], image_filename: str, *, creator: str, created: str, comments: str | None = None) -> bytes:
    """``reading`` as ``step_text.parse_reading`` gives it; ``created`` a UTC time (``2026-11-26T09:50:12+00:00``)."""
    # The namespaces are written as they are: ElementTree cannot give attributes without one a default namespace.
    root = ET.Element("PcGts", {"xmlns": NAMESPACE, "xmlns:xsi": XSI, "xsi:schemaLocation": f"{NAMESPACE} {SCHEMA}"})
    metadata = _in(root, "Metadata")
    _in(metadata, "Creator").text = _NOT_IN_XML.sub("", creator)
    _in(metadata, "Created").text = created
    _in(metadata, "LastChange").text = created
    if comments:
        _in(metadata, "Comments").text = _NOT_IN_XML.sub("", comments)
    width, height = reading["width"], reading["height"]
    page = _in(root, "Page", {"imageFilename": image_filename, "imageWidth": str(width), "imageHeight": str(height)})
    boxes = []
    for _text_of_line, x, y, w, h, _score in reading["lines"]:
        left, top = min(max(0, x), width), min(max(0, y), height)
        boxes.append((left, top, min(width, max(left + 1, x + w)), min(height, max(top + 1, y + h))))
    if boxes:
        order = _in(_in(page, "ReadingOrder"), "OrderedGroup", {"id": "ro1"})
        _in(order, "RegionRefIndexed", {"index": "0", "regionRef": "r1"})
        region = _in(page, "TextRegion", {"id": "r1"})
        around = (min(b[0] for b in boxes), min(b[1] for b in boxes), max(b[2] for b in boxes), max(b[3] for b in boxes))
        _in(region, "Coords", {"points": _points(*around)})
        for number, ((line_text, *_place, score), box) in enumerate(zip(reading["lines"], boxes), start=1):
            line = _in(region, "TextLine", {"id": f"r1l{number}"})
            _in(line, "Coords", {"points": _points(*box)})
            _text(line, line_text, float(score))
        _text(region, "\n".join(line[0] for line in reading["lines"]))
    ET.indent(root, space="  ")
    return f'<?xml version="1.0" encoding="UTF-8"?>\n{ET.tostring(root, encoding="unicode")}\n'.encode()
