"""Make frontend/src/lib/pathwayBadgeData.ts: what the badge on exported pathways is drawn from.

The badge is drawn as outlines, not as text, so that it looks the same wherever the SVG is opened, also
without Inter installed: Inter's letters, its slashed zero, and a QR code of the repository's address.

Run from the repository root when the fonts, the letters needed or the address change:

    uv run --with fonttools --with qrcode python frontend/scripts/make_pathway_badge.py
"""

from __future__ import annotations

import json
from pathlib import Path

import qrcode
from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.pens.transformPen import TransformPen
from fontTools.ttLib import TTFont

ROOT = Path(__file__).resolve().parents[1]
FONTS = ROOT / "src" / "assets" / "fonts"
OUTPUT = ROOT / "src" / "lib" / "pathwayBadgeData.ts"

REPOSITORY_URL = "https://github.com/j-nivekk/Stepthrough"
# Lower-case letters, digits and the marks in a date, a version and a web address; S for the name.
UPRIGHT = "abcdefghijklmnopqrstuvwxyz0123456789./-:_+S"
ITALIC = "Stepthrough"


def slashed_zero(font: TTFont) -> str:
    """The glyph the `zero` feature puts in place of 0."""
    gsub = font["GSUB"].table
    for record in gsub.FeatureList.FeatureRecord:
        if record.FeatureTag != "zero":
            continue
        for index in record.Feature.LookupListIndex:
            for subtable in gsub.LookupList.Lookup[index].SubTable:
                mapping = getattr(subtable, "mapping", None) or getattr(getattr(subtable, "ExtSubTable", None), "mapping", {})
                if "zero" in mapping:
                    return mapping["zero"]
    raise SystemExit("this font has no slashed zero")


def outlines(path: Path, characters: str, *, slash_zero: bool) -> tuple[dict[str, list], int]:
    font = TTFont(path)
    glyphs = font.getGlyphSet()  # the default instance of the variable font: regular weight
    cmap = font.getBestCmap()
    result: dict[str, list] = {" ": [font["hmtx"][cmap[ord(" ")]][0], ""]}
    for character in dict.fromkeys(characters):
        name = cmap[ord(character)]
        if character == "0" and slash_zero:
            name = slashed_zero(font)
        pen = SVGPathPen(glyphs, ntos=lambda value: str(round(value)))
        glyphs[name].draw(TransformPen(pen, (1, 0, 0, -1, 0, 0)))  # fonts have y upwards, SVG downwards
        result[character] = [font["hmtx"][name][0], pen.getCommands()]
    return result, font["head"].unitsPerEm


def qr_rows(text: str) -> list[str]:
    code = qrcode.QRCode(error_correction=qrcode.constants.ERROR_CORRECT_M, border=0, box_size=1)
    code.add_data(text)
    code.make(fit=True)
    return ["".join("1" if dark else "0" for dark in row) for row in code.get_matrix()]


def main() -> None:
    upright, units = outlines(FONTS / "InterVariable.ttf", UPRIGHT, slash_zero=True)
    italic, italic_units = outlines(FONTS / "InterVariable-Italic.ttf", ITALIC, slash_zero=False)
    assert units == italic_units
    rows = qr_rows(REPOSITORY_URL)
    dump = lambda value: json.dumps(value, separators=(",", ":"), ensure_ascii=False)
    OUTPUT.write_text(
        "// Made by frontend/scripts/make_pathway_badge.py; change that script and run it again, not this file.\n"
        "// Outlines of Inter (SIL Open Font License) with its slashed zero, and a QR code of the repository's address.\n\n"
        "/** One letter: how far the next one starts (in font units) and its outline, with y downwards. */\n"
        "export type BadgeGlyph = [advance: number, outline: string];\n\n"
        f"export const BADGE_UNITS_PER_EM = {units};\n"
        f"export const BADGE_REPOSITORY_URL = {dump(REPOSITORY_URL)};\n\n"
        f"export const BADGE_GLYPHS: Record<string, BadgeGlyph> = {dump(upright)};\n\n"
        f"export const BADGE_ITALIC_GLYPHS: Record<string, BadgeGlyph> = {dump(italic)};\n\n"
        "/** The QR code, row by row: 1 is a dark square. */\n"
        f"export const BADGE_QR: string[] = {dump(rows)};\n",
        encoding="utf-8",
    )
    print(f"{OUTPUT.relative_to(ROOT.parent)}: {len(upright)} upright and {len(italic)} italic letters, "
          f"QR {len(rows)} x {len(rows[0])}, {OUTPUT.stat().st_size / 1024:.1f} KB")


if __name__ == "__main__":
    main()
