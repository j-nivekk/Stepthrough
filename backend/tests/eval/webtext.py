"""How well the text of screenshots is read: screens of the web tester (``web/``), of which every word is known, and a
page with a sentence in several languages.

The screens are drawn at the sizes recordings have, from a phone to a 4K display, and go through the same compression as
a recording. A word counts as read when a line of text that stands where the word is has its letters and digits, whatever
the case and punctuation. Words that are cut off, covered or fainter than half are left out, and so are single letters.

Usage (from backend/, with Google Chrome or Chromium installed, and the models: ``python -m app.services.text_models``)::

    python -m tests.eval.webtext                      # every size
    python -m tests.eval.webtext --sizes phone,uhd --threads 2
"""

from __future__ import annotations

import argparse
import html
import json
import os
import statistics
import subprocess
import tempfile
import time
import unicodedata
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from difflib import SequenceMatcher
from pathlib import Path
from urllib.parse import urlencode

import cv2

from app.services import text_models
from app.services.text_engine import Line, TextEngine
from app.text_reader import memory_mb

from .webrec import COMPUTER, FPS, PHONE, SETS, WEB, Chrome

SHOTS, EVERY_S, FIRST_S = 6, 6, 1.5  # screens of each script


@dataclass(frozen=True)
class Size:
    """A screen: its size in CSS pixels, and how many pixels of the recording each has."""

    width: int
    height: int
    scale: float
    phone: bool = False


SIZES = {
    "phone": Size(390, 844, 3, True),  # 1170 x 2532
    "phone720": Size(390, 844, 720 / 390, True),
    "laptop": Size(1440, 900, 1),
    "retina": Size(1440, 900, 2),
    "qhd": Size(2560, 1440, 1),
    "wide": Size(3440, 1440, 1),
    "uhd": Size(3840, 2160, 1),
    "retina5k": Size(2560, 1440, 2),
}
LANGUAGES = {
    "Dutch": "Coördinatie van financiële gegevens: geïnteresseerd in één categorie? Zoeken, €12,50 korting.",
    "German": "Größe ändern, Übersicht öffnen und Einstellungen für Benachrichtigungen prüfen.",
    "French": "Réglages générés à l’arrivée : où êtes-vous né ? Déjà abonné, garçon naïf.",
    "Spanish": "¿Quién está viendo la televisión mañana? Configuración y búsqueda rápida.",
    "Polish": "Zażółć gęślą jaźń, następny krok: wyślij wiadomość.",
    "Turkish": "Değişiklikleri görüntüle, şifreni sıfırla ve çıkış yap.",
    "Chinese": "推荐内容 关注 朋友 搜索记录 隐私设置 已保存到相册",
    "Japanese": "おすすめの動画を検索 フォロー中 設定とプライバシー",
    "Russian": "Настройки конфиденциальности и уведомления",
    "Korean": "추천 동영상 검색 설정 및 개인정보",
    "Arabic": "الإعدادات والخصوصية",
}
# Every word that is seen whole, with its place: not cut off by the window or by something that scrolls, not covered.
WORDS = r"""(() => { const found = []; const walk = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  const shown = (x, y, p) => { const at = document.elementFromPoint(x, y); return at && (at === p || p.contains(at) || at.contains(p)); };
  while (walk.nextNode()) { const node = walk.currentNode, p = node.parentElement;
    if (!p || ['SCRIPT', 'STYLE', 'NOSCRIPT'].includes(p.tagName)) continue;
    const style = getComputedStyle(p); if (style.visibility === 'hidden' || style.display === 'none') continue;
    let opacity = 1; for (let e = p; e; e = e.parentElement) opacity *= parseFloat(getComputedStyle(e).opacity);
    if (opacity < 0.5) continue;
    for (const match of node.data.matchAll(/\S+/g)) { const range = document.createRange();
      range.setStart(node, match.index); range.setEnd(node, match.index + match[0].length);
      const rects = [...range.getClientRects()]; if (rects.length !== 1) continue; const b = rects[0], y = b.top + b.height / 2;
      if (b.width < 2 || b.left < 0 || b.top < 0 || b.right > innerWidth || b.bottom > innerHeight) continue;
      if (![b.left + 1, b.left + b.width / 2, b.right - 1].every((x) => shown(x, y, p))) continue;
      let cut = false; for (let e = p; e && e !== document.body; e = e.parentElement) { const c = getComputedStyle(e);
        if (c.overflowX === 'visible' && c.overflowY === 'visible') continue; const k = e.getBoundingClientRect();
        if (b.left < k.left - 1 || b.right > k.right + 1 || b.top < k.top - 1 || b.bottom > k.bottom + 1) cut = true; }
      if (!cut) found.push([match[0], b.left, b.top, b.right, b.bottom]); } }
  return found; })()"""


def letters(text: str) -> str:
    return "".join(character for character in unicodedata.normalize("NFC", text).casefold() if character.isalnum())


def save(chrome: Chrome, path: Path, scale: float) -> None:
    """The screen as a frame of a recording of it, and beside it the words on it."""
    words = chrome.run(WORDS)
    raw, video = path.with_suffix(".raw.png"), path.with_suffix(".mp4")
    raw.write_bytes(chrome.picture())
    filters = "scale=trunc(iw/2)*2:trunc(ih/2)*2:out_color_matrix=bt709:out_range=tv,format=yuv420p"
    for command in (
        ["-i", str(raw), "-vf", filters, "-c:v", "libx264", "-preset", "veryfast", "-crf", "18", str(video)],
        ["-i", str(video), "-frames:v", "1", str(path)],
    ):
        subprocess.run(["ffmpeg", "-v", "error", "-y", *command], check=True)
    raw.unlink()
    video.unlink()
    path.with_suffix(".json").write_text(json.dumps([[word, *(side * scale for side in box)] for word, *box in words]))


def draw(name: str, scenario: str, seed: int, folder: Path) -> None:
    size, chrome = SIZES[name], Chrome()
    try:
        query = urlencode({"scenario": scenario, "device": "phone" if size.phone else "computer", "seed": seed, "mode": "record"})
        chrome.open(f"{(WEB / 'index.html').as_uri()}?{query}", (size.width, size.height, size.scale), size.phone)
        chrome.run(f"Kit.begin({json.dumps(scenario)})")
        shots = frame = 0
        while shots < SHOTS:
            answer = json.loads(chrome.run(f"Kit.step({1000 / FPS if frame else 0})"))
            frame += 1
            if frame % (FPS * EVERY_S) == round(FPS * FIRST_S):
                save(chrome, folder / f"{scenario}_{shots}.png", size.scale)
                shots += 1
            if answer["done"] or answer["error"]:
                break
    finally:
        chrome.close()


def draw_languages(folder: Path) -> Path:
    rows = "".join(f"<p lang='x'>{html.escape(text)}</p>" for text in LANGUAGES.values())
    page = folder / "languages.html"
    page.write_text(
        "<!doctype html><meta charset=utf-8><meta name=viewport content='width=device-width'><style>body{margin:0;padding:50px 18px;"
        "font:15px/1.45 system-ui,sans-serif;color:#1c1c1e}p{margin:0 0 14px}</style>" + rows + "<script>const Kit={}</script>",
        encoding="utf-8",
    )
    size, chrome = SIZES["phone"], Chrome()
    try:
        chrome.open(page.as_uri(), (size.width, size.height, size.scale), True)
        save(chrome, folder / "languages.png", size.scale)
    finally:
        chrome.close()
    return folder / "languages.png"


def has(line: Line, x: float, y: float) -> bool:
    left, top, right, bottom = line.box
    return left - 6 <= x <= right + 6 and top - 6 <= y <= bottom + 6


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--sizes", default=",".join(SIZES))
    parser.add_argument("--threads", type=int, default=4)
    parser.add_argument("--jobs", type=int, default=max(1, (os.cpu_count() or 4) // 3))
    args = parser.parse_args()
    cv2.setNumThreads(1)
    engine = TextEngine(text_models.ensure(say=print), args.threads)
    with tempfile.TemporaryDirectory() as temporary:
        for name in args.sizes.split(","):
            folder = Path(temporary) / name
            folder.mkdir()
            scripts = [(f"{app}_{script}", seed) for script, seed in SETS.values() for app in (PHONE if SIZES[name].phone else COMPUTER)]
            with ThreadPoolExecutor(args.jobs) as pool:
                for drawing in [pool.submit(draw, name, scenario, seed, folder) for scenario, seed in scripts]:
                    drawing.result()
            read = known = 0
            seconds = []
            for path in sorted(folder.glob("*.png")):
                image = cv2.imread(str(path))
                began = time.perf_counter()
                lines = engine.read(image)
                seconds.append(time.perf_counter() - began)
                for word, left, top, right, bottom in json.loads(path.with_suffix(".json").read_text()):
                    wanted = letters(word)
                    if len(wanted) < 2:
                        continue
                    known += 1
                    read += any(wanted in letters(line.text) for line in lines if has(line, (left + right) / 2, (top + bottom) / 2))
            print(f"{name:9} {len(seconds):3} screens, {read} of {known} words ({read / known:.2%}), {statistics.median(seconds):.2f} s each, "
                  f"{max(seconds):.2f} s at most, {memory_mb()} MB at most", flush=True)
        page = letters("".join(line.text for line in engine.read(cv2.imread(str(draw_languages(Path(temporary)))))))
        for language, text in LANGUAGES.items():
            wanted = letters(text)
            blocks = SequenceMatcher(None, wanted, page, autojunk=False).get_matching_blocks()
            print(f"{language:9} {sum(block.size for block in blocks if block.size > 1) / len(wanted):.0%} of its letters")


if __name__ == "__main__":
    main()
