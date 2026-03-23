from __future__ import annotations

import json
import re
from dataclasses import dataclass
from pathlib import Path

import cv2
import numpy as np
from PIL import Image


@dataclass(frozen=True)
class ImageFingerprint:
    average_hash: int
    perceptual_hash: int
    histogram: tuple[float, ...]


HASH_BITS = 64
TOKEN_PATTERN = re.compile(r"[a-z0-9]+")


def _perceptual_hash(image: Image.Image) -> int:
    grayscale = np.asarray(image.convert("L").resize((32, 32), Image.Resampling.LANCZOS), dtype=np.float32)
    transformed = cv2.dct(grayscale)
    low_frequency = transformed[:8, :8]
    values = low_frequency.flatten()
    mean = float(np.mean(values[1:])) if values.size > 1 else float(np.mean(values))
    bits = 0
    for value in values:
        bits = (bits << 1) | int(value >= mean)
    return bits


def fingerprint_image(path: Path) -> ImageFingerprint:
    with Image.open(path) as image:
        grayscale = image.convert("L").resize((8, 8), Image.Resampling.LANCZOS)
        pixels = np.asarray(grayscale, dtype=np.uint8).reshape(-1).tolist()
        mean = sum(pixels) / len(pixels)
        average_hash = 0
        for pixel in pixels:
            average_hash = (average_hash << 1) | int(pixel >= mean)

        histogram = image.convert("RGB").resize((32, 32), Image.Resampling.LANCZOS).histogram()
        total = float(sum(histogram)) or 1.0
        normalized = tuple(value / total for value in histogram)
        perceptual_hash = _perceptual_hash(image)
    return ImageFingerprint(average_hash=average_hash, perceptual_hash=perceptual_hash, histogram=normalized)


def hash_to_hex(value: int) -> str:
    return f"{value:016x}"


def hex_to_hash(value: str | None) -> int | None:
    if not value:
        return None
    return int(value, 16)


def histogram_to_string(histogram: tuple[float, ...]) -> str:
    return ",".join(f"{value:.8f}" for value in histogram)


def histogram_from_string(signature: str | None) -> tuple[float, ...]:
    if not signature:
        return tuple()
    return tuple(float(part) for part in signature.split(","))


def hamming_distance(left: int, right: int) -> int:
    return (left ^ right).bit_count()


def normalized_hash_distance(left: int | None, right: int | None) -> float:
    if left is None or right is None:
        return 1.0
    return hamming_distance(left, right) / HASH_BITS


def histogram_distance(left: tuple[float, ...], right: tuple[float, ...]) -> float:
    if not left or not right:
        return 1.0
    size = min(len(left), len(right))
    return sum(abs(left[index] - right[index]) for index in range(size)) / 2.0


def _text_tokens(value: str | None) -> set[str]:
    if not value:
        return set()
    return set(TOKEN_PATTERN.findall(value.lower()))


def text_distance(left: str | None, right: str | None) -> float:
    left_tokens = _text_tokens(left)
    right_tokens = _text_tokens(right)
    if not left_tokens and not right_tokens:
        return 1.0
    if not left_tokens or not right_tokens:
        return 1.0
    intersection = len(left_tokens & right_tokens)
    union = len(left_tokens | right_tokens)
    return 1.0 - (intersection / max(1, union))


def blended_distance(current: dict, previous: dict) -> float:
    current_phash = hex_to_hash(current.get("perceptual_hash")) or hex_to_hash(current.get("image_hash"))
    previous_phash = hex_to_hash(previous.get("perceptual_hash")) or hex_to_hash(previous.get("image_hash"))
    base_distance = normalized_hash_distance(current_phash, previous_phash)

    # Backward-compatible fallback for legacy rows that only have the old histogram signature.
    if not current.get("perceptual_hash") or not previous.get("perceptual_hash"):
        base_distance = (base_distance * 0.7) + (
            histogram_distance(
                histogram_from_string(current.get("histogram_signature")),
                histogram_from_string(previous.get("histogram_signature")),
            )
            * 0.3
        )

    current_text = current.get("ocr_text")
    previous_text = previous.get("ocr_text")
    if current_text or previous_text:
        return (base_distance * 0.75) + (text_distance(current_text, previous_text) * 0.25)
    return base_distance


def _normalize_score_breakdown(value: str | dict | None) -> dict | None:
    if value is None:
        return None
    if isinstance(value, dict):
        return value
    try:
        return json.loads(value)
    except json.JSONDecodeError:
        return None


def annotate_candidate_similarity(candidates: list[dict]) -> list[dict]:
    for index, candidate in enumerate(candidates):
        if index == 0 and not candidate.get("scene_score"):
            candidate["scene_score"] = 1.0
        elif index > 0 and not candidate.get("scene_score"):
            candidate["scene_score"] = round(blended_distance(candidate, candidates[index - 1]), 4)

        candidate["score_breakdown"] = _normalize_score_breakdown(candidate.get("score_breakdown"))

        best_score = 999.0
        best_candidate: dict | None = None
        for previous_candidate in candidates[:index]:
            score = blended_distance(candidate, previous_candidate)
            if score < best_score:
                best_score = score
                best_candidate = previous_candidate

        if best_candidate is not None:
            candidate["similarity_distance"] = round(best_score, 4)
            if best_score <= 0.16:
                group_id = best_candidate.get("revisit_group_id") or f"revisit-{best_candidate['id'][:8]}"
                best_candidate.setdefault("revisit_group_id", group_id)
                candidate["revisit_group_id"] = group_id
                candidate["similar_to_candidate_id"] = best_candidate["id"]

    return candidates
