"""Canonical JSON hashing for GPU HMR identity material.

The split-broker architecture needs hashes that mean the same thing across
producers. This module owns the ai-engine side of that contract: deterministic
JSON bytes, explicit path/source normalization, and opt-in set-like array
sorting for fields whose order is not semantic.
"""

from __future__ import annotations

import hashlib
import json
import math
import posixpath
import re
import unicodedata
from dataclasses import dataclass, field
from typing import Any, Iterable, Mapping, Sequence


class CanonicalizationError(ValueError):
    """Raised when identity material cannot be safely canonicalized."""


@dataclass(frozen=True)
class CanonicalHashPolicy:
    """Field-level canonicalization policy.

    Arrays keep their original order unless their current field name appears in
    `unordered_array_keys`. Paths and source text are normalized only for fields
    explicitly listed in this policy so existing generic hashes do not silently
    reinterpret arbitrary strings.
    """

    path_keys: frozenset[str] = field(default_factory=frozenset)
    source_text_keys: frozenset[str] = field(default_factory=frozenset)
    unordered_array_keys: frozenset[str] = field(default_factory=frozenset)
    environment_keys: frozenset[str] = field(default_factory=frozenset)
    environment_allowlist: frozenset[str] = field(default_factory=frozenset)


GPU_HMR_IDENTITY_POLICY = CanonicalHashPolicy(
    path_keys=frozenset(
        {
            "acceptedPointerPath",
            "buildRoot",
            "candidatePath",
            "directory",
            "entryFile",
            "file",
            "focus",
            "generatedPath",
            "generatedHeaderRoots",
            "generatedRolePaths",
            "includeRoots",
            "internalPath",
            "linkDirectories",
            "path",
            "runtimeLibraryPaths",
            "sourcePath",
            "sourceFiles",
            "systemIncludeRoots",
            "targetInputFile",
            "workspaceRelativePath",
            "writableGeneratedPaths",
            "writeScope",
        }
    ),
    source_text_keys=frozenset({"content", "source", "sourceText"}),
    unordered_array_keys=frozenset(
        {
            "advisoryReasonCodes",
            "affectedGeneratedRoles",
            "affectedUserFiles",
            "blockingReasonCodes",
            "deviceRoles",
            "fallbacksAvailable",
            "generatedRolePaths",
            "proofRefs",
            "reasonCodes",
            "retrievalTraceHashes",
            "roleGenerationPackageHashes",
            "rolePackageHashes",
            "sourceFiles",
            "verifierReportHashes",
        }
    ),
    environment_keys=frozenset(
        {
            "buildSelectionEnvironment",
            "deploymentRuntimeEnvironment",
            "environment",
            "runtimeVerificationEnvironment",
            "verificationRuntimeEnvironment",
        }
    ),
    environment_allowlist=frozenset(
        {
            "CUDA_VISIBLE_DEVICES",
            "HIP_VISIBLE_DEVICES",
            "ROCR_VISIBLE_DEVICES",
            "SYNTHI_GPU_ARCH",
            "SYNTHI_GPU_VENDOR",
            "SYNTHI_SCALE_RENDER_BACKEND",
        }
    ),
)

_WINDOWS_ABSOLUTE_RE = re.compile(r"^[A-Za-z]:/")
_SECRET_KEY_RE = re.compile(r"(?:TOKEN|SECRET|PASSWORD|KEY|CREDENTIAL)", re.I)


def normalize_text(text: str) -> str:
    """Normalize source or identity strings to NFC with LF line endings."""

    return unicodedata.normalize("NFC", str(text).replace("\r\n", "\n").replace("\r", "\n"))


def normalize_workspace_path(path: str) -> str:
    """Return a slash-normalized workspace-relative path.

    Absolute paths and traversal outside the workspace are invalid identity
    material. Symlink checks require filesystem context and belong to the path
    scope verifier, not this pure serializer.
    """

    normalized = normalize_text(path).strip().replace("\\", "/")
    while normalized.startswith("./"):
        normalized = normalized[2:]
    if normalized.startswith("/") or normalized.startswith("//") or _WINDOWS_ABSOLUTE_RE.match(normalized):
        raise CanonicalizationError(f"path must be workspace-relative: {path!r}")
    normalized = posixpath.normpath(normalized)
    if normalized == ".":
        return ""
    if normalized == ".." or normalized.startswith("../"):
        raise CanonicalizationError(f"path escapes workspace: {path!r}")
    return normalized


def canonicalize(
    value: Any,
    *,
    policy: CanonicalHashPolicy | None = None,
    _key_path: Sequence[str] = (),
) -> Any:
    """Convert `value` into canonical JSON-compatible material."""

    policy = policy or CanonicalHashPolicy()
    current_key = _key_path[-1] if _key_path else ""

    if isinstance(value, Mapping):
        if current_key in policy.environment_keys:
            value = _canonical_environment(value, policy)
        result: dict[str, Any] = {}
        for raw_key in sorted(value.keys(), key=lambda k: unicodedata.normalize("NFC", str(k))):
            key = unicodedata.normalize("NFC", str(raw_key))
            result[key] = canonicalize(value[raw_key], policy=policy, _key_path=(*_key_path, key))
        return result

    if isinstance(value, (list, tuple)):
        items = [canonicalize(item, policy=policy, _key_path=_key_path) for item in value]
        if current_key in policy.unordered_array_keys:
            return sorted(items, key=_canonical_json_text)
        return items

    if isinstance(value, str):
        if current_key in policy.path_keys:
            return normalize_workspace_path(value)
        if current_key in policy.source_text_keys:
            return normalize_text(value)
        return unicodedata.normalize("NFC", value)

    if value is None or isinstance(value, bool) or isinstance(value, int):
        return value

    if isinstance(value, float):
        if not math.isfinite(value):
            raise CanonicalizationError("non-finite floats are not valid identity material")
        return value

    raise CanonicalizationError(f"unsupported canonical value type: {type(value).__name__}")


def canonical_json_bytes(
    value: Any,
    *,
    policy: CanonicalHashPolicy | None = None,
) -> bytes:
    """Serialize identity material as canonical UTF-8 JSON bytes."""

    canonical = canonicalize(value, policy=policy)
    return json.dumps(
        canonical,
        sort_keys=True,
        separators=(",", ":"),
        ensure_ascii=False,
        allow_nan=False,
    ).encode("utf-8")


def canonical_hash(
    value: Any,
    *,
    policy: CanonicalHashPolicy | None = None,
) -> str:
    """Return the SHA-256 hex digest of canonical JSON bytes."""

    return hashlib.sha256(canonical_json_bytes(value, policy=policy)).hexdigest()


def _canonical_json_text(value: Any) -> str:
    return json.dumps(
        value,
        sort_keys=True,
        separators=(",", ":"),
        ensure_ascii=False,
        allow_nan=False,
    )


def _canonical_environment(
    value: Mapping[Any, Any],
    policy: CanonicalHashPolicy,
) -> dict[str, Any]:
    allowed = {str(key) for key in policy.environment_allowlist}
    result: dict[str, Any] = {}
    for raw_key, raw_value in value.items():
        key = str(raw_key)
        if allowed and key not in allowed:
            continue
        result[key] = "[redacted]" if _SECRET_KEY_RE.search(key) else raw_value
    return result


def hash_many(
    values: Iterable[Any],
    *,
    policy: CanonicalHashPolicy | None = None,
) -> str:
    """Hash an ordered sequence of canonical identity fragments."""

    return canonical_hash(list(values), policy=policy)
