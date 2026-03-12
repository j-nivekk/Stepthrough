from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

from PIL import Image


@dataclass(frozen=True)
class ImageFingerprint:
    ahash: int
    histogram: tuple[float, ...]


HASH_BITS = 64


def fingerprint_image(path: Path) -> ImageFingerprint:
    with Image.open(path) as image:
        grayscale = image.convert("L").resize((8, 8))
        pixels = list(grayscale.getdata())
        mean = sum(pixels) / len(pixels)
        bits = 0
        for pixel in pixels:
            bits = (bits << 1) | int(pixel >= mean)

        histogram = image.convert("RGB").resize((32, 32)).histogram()
        total = float(sum(histogram)) or 1.0
        normalized = tuple(value / total for value in histogram)
    return ImageFingerprint(ahash=bits, histogram=normalized)


def hash_to_hex(value: int) -> str:
    return f"{value:016x}"


def hex_to_hash(value: str) -> int:
    return int(value, 16)


def histogram_to_string(histogram: tuple[float, ...]) -> str:
    return ",".join(f"{value:.8f}" for value in histogram)


def histogram_from_string(signature: str | None) -> tuple[float, ...]:
    if not signature:
        return tuple()
    return tuple(float(part) for part in signature.split(","))


def hamming_distance(left: int, right: int) -> int:
    return (left ^ right).bit_count()


def normalized_hash_distance(left: int, right: int) -> float:
    return hamming_distance(left, right) / HASH_BITS


def histogram_distance(left: tuple[float, ...], right: tuple[float, ...]) -> float:
    if not left or not right:
        return 1.0
    size = min(len(left), len(right))
    return sum(abs(left[index] - right[index]) for index in range(size)) / 2.0


def blended_distance(current: ImageFingerprint, previous: ImageFingerprint) -> float:
    return (normalized_hash_distance(current.ahash, previous.ahash) * 0.7) + (
        histogram_distance(current.histogram, previous.histogram) * 0.3
    )


def annotate_candidate_similarity(candidates: list[dict]) -> list[dict]:
    previous_fingerprints: list[ImageFingerprint] = []

    for index, candidate in enumerate(candidates):
        current = ImageFingerprint(
            ahash=hex_to_hash(candidate["image_hash"]),
            histogram=histogram_from_string(candidate.get("histogram_signature")),
        )
        if index == 0:
            candidate["scene_score"] = 1.0
        else:
            previous = previous_fingerprints[index - 1]
            candidate["scene_score"] = round(blended_distance(current, previous), 4)

        best_score = 999.0
        best_candidate: dict | None = None
        for previous_index, previous_candidate in enumerate(candidates[:index]):
            score = blended_distance(current, previous_fingerprints[previous_index])
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
        previous_fingerprints.append(current)

    return candidates
