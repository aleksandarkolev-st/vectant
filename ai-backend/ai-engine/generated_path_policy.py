"""Project-neutral path policy for AI-generated workspace artifacts."""

from __future__ import annotations

import posixpath
import re
import unicodedata
from typing import Iterable, Mapping, TypeVar


T = TypeVar("T")


class GeneratedPathViolation(ValueError):
    """A generated path cannot be confined to the candidate workspace."""

    def __init__(self, reason_code: str, path: object, message: str):
        super().__init__(message)
        self.reason_code = reason_code
        self.path = path


_WINDOWS_DRIVE_RE = re.compile(r"^[A-Za-z]:")
_WINDOWS_RESERVED_NAMES = {
    "CON",
    "PRN",
    "AUX",
    "NUL",
    "CLOCK$",
    "CONIN$",
    "CONOUT$",
    *(f"COM{index}" for index in range(1, 10)),
    *(f"LPT{index}" for index in range(1, 10)),
    *(f"COM{index}" for index in "\u00b9\u00b2\u00b3"),
    *(f"LPT{index}" for index in "\u00b9\u00b2\u00b3"),
}
_WINDOWS_INVALID_FILENAME_CHARACTERS = frozenset('<>"|?*')


def normalize_generated_relative_path(raw_path: object) -> str:
    """Return one portable relative path or raise a typed refusal."""

    if not isinstance(raw_path, str) or not raw_path:
        raise GeneratedPathViolation(
            "generated.invalid_path_rejected",
            raw_path,
            "generated path must be a non-empty string",
        )
    if raw_path != raw_path.strip():
        raise GeneratedPathViolation(
            "generated.invalid_path_rejected",
            raw_path,
            "generated path must not have leading or trailing whitespace",
        )
    if any(unicodedata.category(character) == "Cc" for character in raw_path):
        raise GeneratedPathViolation(
            "generated.invalid_path_rejected",
            raw_path,
            "generated path contains a control character",
        )

    path = raw_path.replace("\\", "/")
    if path.startswith("/") or _WINDOWS_DRIVE_RE.match(path):
        raise GeneratedPathViolation(
            "generated.absolute_path_rejected",
            raw_path,
            "generated path must be relative to the candidate workspace",
        )
    if ":" in path:
        raise GeneratedPathViolation(
            "generated.invalid_path_rejected",
            raw_path,
            "generated path must not contain a drive or alternate-stream separator",
        )
    if any(character in _WINDOWS_INVALID_FILENAME_CHARACTERS for character in path):
        raise GeneratedPathViolation(
            "generated.invalid_path_rejected",
            raw_path,
            "generated path contains a non-portable filename character",
        )

    while path.startswith("./"):
        path = path[2:]
    segments = path.split("/")
    if ".." in segments:
        raise GeneratedPathViolation(
            "generated.path_traversal_rejected",
            raw_path,
            "generated path must not contain a parent traversal segment",
        )
    if any(not segment or segment == "." for segment in segments):
        raise GeneratedPathViolation(
            "generated.invalid_path_rejected",
            raw_path,
            "generated path contains an empty or ambiguous segment",
        )
    for segment in segments:
        if segment.endswith((" ", ".")):
            raise GeneratedPathViolation(
                "generated.invalid_path_rejected",
                raw_path,
                "generated path contains a segment with a non-portable suffix",
            )
        basename = segment.split(".", 1)[0].upper()
        if basename in _WINDOWS_RESERVED_NAMES:
            raise GeneratedPathViolation(
                "generated.invalid_path_rejected",
                raw_path,
                "generated path contains a reserved workspace filename",
            )

    normalized = unicodedata.normalize("NFC", posixpath.normpath(path))
    if normalized in {"", "."} or normalized.startswith("../"):
        raise GeneratedPathViolation(
            "generated.path_traversal_rejected",
            raw_path,
            "generated path escapes the candidate workspace",
        )
    return normalized


def normalize_generated_path_mapping(paths: Mapping[object, T]) -> dict[str, T]:
    """Normalize generated keys and reject portable-filesystem aliases."""

    normalized: dict[str, T] = {}
    owners_by_collision_key: dict[str, object] = {}
    for raw_path, value in paths.items():
        path = normalize_generated_relative_path(raw_path)
        collision_key = path.lower()
        previous = owners_by_collision_key.get(collision_key)
        if previous is not None:
            raise GeneratedPathViolation(
                "generated.case_collision_rejected",
                raw_path,
                f"generated paths {previous!r} and {raw_path!r} alias on a portable filesystem",
            )
        owners_by_collision_key[collision_key] = raw_path
        normalized[path] = value
    return normalized


def normalize_generated_path_list(
    paths: Iterable[object],
    *,
    allow_exact_duplicates: bool = False,
) -> list[str]:
    """Normalize an ordered path list while rejecting ambiguous aliases."""

    normalized: list[str] = []
    owners_by_collision_key: dict[str, object] = {}
    for raw_path in paths:
        path = normalize_generated_relative_path(raw_path)
        collision_key = path.lower()
        previous = owners_by_collision_key.get(collision_key)
        if previous is not None:
            if allow_exact_duplicates and previous == raw_path:
                normalized.append(path)
                continue
            raise GeneratedPathViolation(
                "generated.case_collision_rejected",
                raw_path,
                f"generated paths {previous!r} and {raw_path!r} alias on a portable filesystem",
            )
        owners_by_collision_key[collision_key] = raw_path
        normalized.append(path)
    return normalized
