"""Deterministic ABI stamps for GPU kernels.

Phase-2 reload planning compares per-kernel parameter-list hashes. The
ultraplan names SipHash-2-4; Python's standard library does not expose
SipHash, so this module uses keyed BLAKE2b truncated to 64 bits as the
deterministic implementation in the AI engine. The contract is still a
stable 64-bit ABI stamp over the normalized kernel parameter types.
"""

from __future__ import annotations

import hashlib
import re
from dataclasses import dataclass
from typing import Dict, Iterable, Mapping


_GLOBAL_DECL_RE = re.compile(
    r"__global__\s+(?:void\s+)?(?P<name>[A-Za-z_][A-Za-z0-9_]*)\s*\(",
    re.MULTILINE,
)
_CONSTANT_DECL_RE = re.compile(
    r"__constant__\s+(?P<decl>[^;]+);",
    re.MULTILINE,
)
_HASH_KEY = b"synthi-gpu-hmr-v1"


@dataclass(frozen=True)
class KernelAbiStamp:
    name: str
    normalized_params: str
    hash_hex: str

    def to_dict(self) -> dict:
        return {
            "name": self.name,
            "normalized_params": self.normalized_params,
            "hash": self.hash_hex,
        }


def stamp_device_source(source: str) -> Dict[str, str]:
    """Return `kernel_name -> 0x<16 hex>` for every `__global__` kernel."""
    return {stamp.name: stamp.hash_hex for stamp in collect_kernel_stamps(source)}


def collect_kernel_stamps(source: str) -> Iterable[KernelAbiStamp]:
    for name, params in extract_kernel_signatures(source).items():
        normalized = normalize_param_list(params)
        yield KernelAbiStamp(
            name=name,
            normalized_params=normalized,
            hash_hex=_hash64_hex(f"{name}({normalized})"),
        )


def extract_kernel_signatures(source: str) -> Dict[str, str]:
    sigs: Dict[str, str] = {}
    cursor = 0
    while True:
        match = _GLOBAL_DECL_RE.search(source, cursor)
        if not match:
            break
        name = match.group("name")
        params, end = _read_balanced(source, match.end() - 1, "(", ")")
        sigs[name] = params
        cursor = max(end, match.end())
    return sigs


def constant_layout_hash(source: str) -> str:
    decls = []
    for match in _CONSTANT_DECL_RE.finditer(source):
        decls.append(re.sub(r"\s+", " ", match.group("decl")).strip())
    return _hash64_hex(";".join(sorted(decls)))


def normalize_param_list(params: str) -> str:
    parts = [_normalize_param(p) for p in _split_top_level(params)]
    return ",".join(p for p in parts if p)


def write_split_meta(files: Mapping[str, str]) -> dict:
    """Build the `.synthi_split_meta.json` GPU subsection shape."""
    device_source = files.get("device.cu") or files.get("device.hip") or ""
    return {
        "gpu": {
            "kernel_sig_hashes": stamp_device_source(device_source),
            "constant_layout_hash": constant_layout_hash(device_source),
        }
    }


def _normalize_param(param: str) -> str:
    p = re.sub(r"\s+", " ", param.strip())
    if not p or p == "void":
        return ""
    # Drop default values.
    p = p.split("=", 1)[0].strip()
    # Drop a likely parameter name at the end while preserving pointer
    # and reference qualifiers attached to the type.
    m = re.match(r"(?P<type>.+?)(?:\s+|\s*(?=[*&]))(?P<name>[A-Za-z_][A-Za-z0-9_]*)$", p)
    if m:
        type_part = m.group("type").strip()
        name = m.group("name")
        if name not in {"const", "volatile"} and not type_part.endswith("::"):
            p = type_part
    p = p.replace(" *", "*").replace("* ", "*")
    p = p.replace(" &", "&").replace("& ", "&")
    p = re.sub(r"\s*,\s*", ",", p)
    return p.strip()


def _hash64_hex(text: str) -> str:
    digest = hashlib.blake2b(text.encode("utf-8"), digest_size=8, key=_HASH_KEY).hexdigest()
    return "0x" + digest


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


def _split_top_level(text: str) -> list[str]:
    parts: list[str] = []
    start = 0
    depth = 0
    for i, ch in enumerate(text):
        if ch in "([{<":
            depth += 1
        elif ch in ")]}>" and depth > 0:
            depth -= 1
        elif ch == "," and depth == 0:
            parts.append(text[start:i].strip())
            start = i + 1
    tail = text[start:].strip()
    if tail:
        parts.append(tail)
    return parts
