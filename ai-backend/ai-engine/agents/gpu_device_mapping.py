"""Deterministic source-to-generated mappings for GPU device roles."""

from __future__ import annotations

import hashlib
from pathlib import PurePosixPath
import re
from dataclasses import dataclass
from typing import Any, Dict, Mapping, Optional, Set

from agents.abi_stamper import constant_layout_hash, mask_comments_for_parsing, stamp_device_source


_GLOBAL_KERNEL_RE = re.compile(
    r'(?:extern\s+"C"\s+)?(?:'
    r'__global__\s+(?:void\s+)?'
    r'|GLOBAL_KERNEL_SIGNATURE\s*\([^)]*\)\s+(?:__launch_bounds__\s*\([^)]*\)\s*)?'
    r'(?:(?:inline|__forceinline__|static|constexpr)\s+)*'
    r')(?P<name>[A-Za-z_][A-Za-z0-9_]*)\s*\(',
    re.MULTILINE,
)
_LOCAL_INCLUDE_RE = re.compile(r'^\s*#\s*include\s+"(?P<path>[^"]+)"', re.MULTILINE)


@dataclass(frozen=True)
class KernelRegion:
    name: str
    params: str
    signature_hash: str
    signature_start: int
    body_start: int
    body_end: int


def build_device_mapping_report(
    *,
    source_files: Mapping[str, str],
    generated_files: Mapping[str, str],
    manifest: Mapping[str, Any],
) -> dict:
    """Build Milestone-1 device mapping evidence from deterministic spans.

    The fast path only consumes same-kernel-name mappings whose source and
    generated signatures match. Missing mappings are explicit so the worker can
    reject `device_only` instead of guessing.
    """

    generated_path = _manifest_device_path(manifest) or _first_device_path(generated_files)
    generated_source = generated_files.get(generated_path or "", "") if generated_path else ""
    generated_regions = extract_kernel_regions(generated_source)
    normalized_sources = {
        _normalize_path(path): source for path, source in source_files.items()
    }
    generated_included_sources = _generated_direct_source_includes(
        generated_path or "",
        generated_source,
        normalized_sources,
    )
    generated_semantic_source = "\n".join(
        [generated_source, *generated_included_sources.values()]
    )
    source_device_files = {
        _normalize_path(path): source
        for path, source in source_files.items()
        if _is_device_compilation_source(path, source)
    }
    reachable_headers, include_graph, missing_includes = _collect_device_reachable_headers(
        normalized_sources,
        set(source_device_files),
    )
    baseline_sources = {
        **source_device_files,
        **{
            path: normalized_sources[path]
            for path in sorted(reachable_headers)
            if path in normalized_sources
        },
    }

    mappings = []
    unmapped = []
    generated_include_paths = set(generated_included_sources)
    for source_path, source in sorted(source_device_files.items()):
        source_regions = extract_kernel_regions(source)
        for name, source_region in sorted(source_regions.items()):
            generated_region = generated_regions.get(name)
            if not generated_region and source_path in generated_include_paths:
                mappings.append(
                    {
                        "kind": "kernel",
                        "symbol": name,
                        "sourcePath": source_path,
                        "generatedRole": "device",
                        "generatedPath": generated_path,
                        "mappingConfidence": "generated_include_bridge_same_source",
                        "signatureHash": source_region.signature_hash,
                        "sourceBodyRange": {
                            "startByte": source_region.body_start,
                            "endByte": source_region.body_end,
                        },
                        "generatedMappingMode": "source_include_bridge",
                    }
                )
                continue
            if not generated_region:
                unmapped.append({"sourcePath": source_path, "symbol": name, "reason": "generated_kernel_missing"})
                continue
            if source_region.signature_hash != generated_region.signature_hash:
                unmapped.append({"sourcePath": source_path, "symbol": name, "reason": "signature_hash_mismatch"})
                continue
            mappings.append(
                {
                    "kind": "kernel",
                    "symbol": name,
                    "sourcePath": source_path,
                    "generatedRole": "device",
                    "generatedPath": generated_path,
                    "mappingConfidence": "same_name_signature",
                    "signatureHash": source_region.signature_hash,
                    "sourceBodyRange": {
                        "startByte": source_region.body_start,
                        "endByte": source_region.body_end,
                    },
                    "generatedBodyRange": {
                        "startByte": generated_region.body_start,
                        "endByte": generated_region.body_end,
                    },
                }
            )

    source_hashes = {path: _sha256(source) for path, source in sorted(baseline_sources.items())}
    source_baselines = {
        path: source for path, source in sorted(baseline_sources.items()) if path in source_hashes
    }
    generated_kernel_hashes = dict(stamp_device_source(generated_source))
    for source in generated_included_sources.values():
        generated_kernel_hashes.update(stamp_device_source(source))
    constant_layout_hashes = {
        "generated:device": constant_layout_hash(generated_semantic_source),
        **{
            path: constant_layout_hash(source)
            for path, source in sorted(source_device_files.items())
        },
    }

    return {
        "schemaVersion": "synthi.gpu.device_mapping.v1",
        "generatedDevicePath": generated_path,
        "mappingStatus": "mapped" if mappings and not unmapped else ("partial" if mappings else "missing"),
        "deviceMappings": mappings,
        "unmappedKernels": unmapped,
        "sourceBaselineHashes": source_hashes,
        "sourceBaselineContents": source_baselines,
        "kernelSignatureHashes": generated_kernel_hashes,
        "constantGlobalLayoutHashes": constant_layout_hashes,
        "deviceIncludeGraph": {
            "schemaVersion": "synthi.gpu.device_include_graph.v1",
            "status": "bounded" if not missing_includes else "missing_includes",
            "deviceTranslationUnits": sorted(source_device_files),
            "generatedDeviceIncludes": sorted(generated_included_sources),
            "reachableHeaders": sorted(reachable_headers),
            "edges": [
                {"source": source, "includes": includes}
                for source, includes in sorted(include_graph.items())
            ],
            "missingIncludes": missing_includes,
            "reasonCodes": [] if not missing_includes else ["include_not_found"],
        },
    }


def extract_kernel_regions(source: str) -> Dict[str, KernelRegion]:
    regions: Dict[str, KernelRegion] = {}
    cursor = 0
    masked = mask_comments_for_parsing(source)
    signatures = stamp_device_source(source)
    while True:
        match = _GLOBAL_KERNEL_RE.search(masked, cursor)
        if not match:
            break
        name = match.group("name")
        params, after_params = _read_balanced(masked, match.end() - 1, "(", ")")
        body_open = _find_kernel_body_open(masked, after_params)
        if body_open is None:
            cursor = max(after_params, match.end())
            continue
        _body, body_close = _read_balanced(masked, body_open, "{", "}")
        regions[name] = KernelRegion(
            name=name,
            params=params,
            signature_hash=signatures.get(name, ""),
            signature_start=match.start(),
            body_start=body_open + 1,
            body_end=max(body_open + 1, body_close - 1),
        )
        cursor = max(body_close, match.end())
    return regions


def _manifest_device_path(manifest: Mapping[str, Any]) -> Optional[str]:
    module_files = manifest.get("module_files")
    if isinstance(module_files, Mapping):
        device = module_files.get("device")
        if isinstance(device, str) and device.strip():
            return _normalize_path(device)
    files = manifest.get("files")
    if isinstance(files, list):
        for path in files:
            if isinstance(path, str) and _is_device_source_path(path):
                return _normalize_path(path)
    return None


def _first_device_path(files: Mapping[str, str]) -> Optional[str]:
    for path in sorted(files):
        if _is_device_source_path(path):
            return _normalize_path(path)
    return None


def _is_device_source_path(path: str) -> bool:
    return _normalize_path(path).lower().endswith((".cu", ".hip"))


def _is_device_header_path(path: str) -> bool:
    return _normalize_path(path).lower().endswith((".cuh", ".hpp", ".hh", ".h"))


def _is_device_compilation_source(path: str, source: str) -> bool:
    normalized = _normalize_path(path).lower()
    masked = mask_comments_for_parsing(source)
    if normalized.endswith((".cu", ".hip")):
        return "__global__" in masked or "__device__" in masked
    if not _is_device_header_path(path):
        return False
    return bool(
        "__global__" in masked
        or "__device__" in masked
        or "GLOBAL_KERNEL_SIGNATURE" in masked
        or "HIPRT_DEVICE" in masked
        or "HIPRT_HOST_DEVICE" in masked
    )


def _normalize_path(path: str) -> str:
    normalized = str(path).replace("\\", "/")
    while normalized.startswith("./"):
        normalized = normalized[2:]
    parts = []
    for part in normalized.split("/"):
        if not part or part == ".":
            continue
        if part == ".." and parts and parts[-1] != "..":
            parts.pop()
        elif part == "..":
            parts.append(part)
        else:
            parts.append(part)
    return "/".join(parts)


def _resolve_local_include(source_path: str, include_path: str, files: Mapping[str, str]) -> Optional[str]:
    include = _normalize_path(include_path)
    candidates = []
    if not include.startswith("/"):
        parent = str(PurePosixPath(source_path).parent)
        if parent == ".":
            parent = ""
        candidates.append(_normalize_path(f"{parent}/{include}" if parent else include))
    candidates.append(include)
    for candidate in candidates:
        if candidate in files:
            return candidate
    return None


def _generated_direct_source_includes(
    generated_path: str,
    generated_source: str,
    source_files: Mapping[str, str],
) -> Dict[str, str]:
    included: Dict[str, str] = {}
    masked = mask_comments_for_parsing(generated_source)
    for match in _LOCAL_INCLUDE_RE.finditer(masked):
        resolved = _resolve_local_include(generated_path, match.group("path"), source_files)
        if resolved and _is_device_compilation_source(resolved, source_files[resolved]):
            included[resolved] = source_files[resolved]
    return included


def _collect_device_reachable_headers(
    files: Mapping[str, str],
    device_translation_units: Set[str],
) -> tuple[Set[str], Dict[str, list[str]], list[dict[str, str]]]:
    reachable: Set[str] = set()
    include_graph: Dict[str, list[str]] = {}
    missing: list[dict[str, str]] = []
    stack = sorted(device_translation_units)
    visited: Set[str] = set()

    while stack:
        current = stack.pop()
        if current in visited:
            continue
        visited.add(current)
        source = files.get(current, "")
        masked = mask_comments_for_parsing(source)
        includes: list[str] = []
        for match in _LOCAL_INCLUDE_RE.finditer(masked):
            raw_include = match.group("path")
            resolved = _resolve_local_include(current, raw_include, files)
            if not resolved:
                missing.append({"source": current, "include": _normalize_path(raw_include)})
                continue
            includes.append(resolved)
            if _is_device_header_path(resolved) and resolved not in reachable:
                reachable.add(resolved)
                stack.append(resolved)
        include_graph[current] = sorted(set(includes))

    return reachable, include_graph, missing


def _sha256(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def _find_next_non_ws(source: str, index: int) -> Optional[int]:
    i = index
    while i < len(source):
        if not source[i].isspace():
            return i
        i += 1
    return None


def _find_kernel_body_open(source: str, after_params: int) -> Optional[int]:
    """Find a kernel body after signatures, including preprocessor alternates."""

    next_token = _find_next_non_ws(source, after_params)
    if next_token is None:
        return None
    if source[next_token] == "{":
        return next_token

    search_limit = min(len(source), after_params + 4096)
    body_open = source.find("{", after_params, search_limit)
    if body_open < 0:
        return None

    between = source[after_params:body_open]
    if ";" in between:
        return None
    if "}" in between:
        return None
    return body_open


def _read_balanced(source: str, open_index: int, open_ch: str, close_ch: str) -> tuple[str, int]:
    if open_index < 0 or open_index >= len(source) or source[open_index] != open_ch:
        return "", open_index
    depth = 0
    start = open_index + 1
    i = open_index
    while i < len(source):
        ch = source[i]
        if ch == open_ch:
            depth += 1
        elif ch == close_ch:
            depth -= 1
            if depth == 0:
                return source[start:i], i + 1
        i += 1
    return source[start:], len(source)
