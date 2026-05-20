"""Deterministic source-to-generated mappings for GPU device roles."""

from __future__ import annotations

import hashlib
import re
from dataclasses import dataclass
from typing import Any, Dict, Mapping, Optional

from agents.abi_stamper import constant_layout_hash, stamp_device_source


_GLOBAL_KERNEL_RE = re.compile(
    r'(?:extern\s+"C"\s+)?__global__\s+(?:void\s+)?(?P<name>[A-Za-z_][A-Za-z0-9_]*)\s*\(',
    re.MULTILINE,
)


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
    source_device_files = {
        _normalize_path(path): source
        for path, source in source_files.items()
        if _is_device_source_path(path) and ("__global__" in source or "__device__" in source)
    }

    mappings = []
    unmapped = []
    for source_path, source in sorted(source_device_files.items()):
        source_regions = extract_kernel_regions(source)
        for name, source_region in sorted(source_regions.items()):
            generated_region = generated_regions.get(name)
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

    source_hashes = {
        path: _sha256(source) for path, source in sorted(source_device_files.items())
    }
    source_baselines = {
        path: source for path, source in sorted(source_device_files.items()) if path in source_hashes
    }
    constant_layout_hashes = {
        "generated:device": constant_layout_hash(generated_source),
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
        "kernelSignatureHashes": stamp_device_source(generated_source),
        "constantGlobalLayoutHashes": constant_layout_hashes,
    }


def extract_kernel_regions(source: str) -> Dict[str, KernelRegion]:
    regions: Dict[str, KernelRegion] = {}
    cursor = 0
    signatures = stamp_device_source(source)
    while True:
        match = _GLOBAL_KERNEL_RE.search(source, cursor)
        if not match:
            break
        name = match.group("name")
        params, after_params = _read_balanced(source, match.end() - 1, "(", ")")
        body_open = _find_next_non_ws(source, after_params)
        if body_open is None or body_open >= len(source) or source[body_open] != "{":
            cursor = max(after_params, match.end())
            continue
        _body, body_close = _read_balanced(source, body_open, "{", "}")
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


def _normalize_path(path: str) -> str:
    normalized = str(path).replace("\\", "/")
    while normalized.startswith("./"):
        normalized = normalized[2:]
    return normalized


def _sha256(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def _find_next_non_ws(source: str, index: int) -> Optional[int]:
    i = index
    while i < len(source):
        if not source[i].isspace():
            return i
        i += 1
    return None


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
