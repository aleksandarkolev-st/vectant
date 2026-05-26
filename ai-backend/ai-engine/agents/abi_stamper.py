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
    r"(?:"
    r"__global__\s+(?:void\s+)?"
    r"|GLOBAL_KERNEL_SIGNATURE\s*\([^)]*\)\s+(?:__launch_bounds__\s*\([^)]*\)\s*)?"
    r")(?P<name>[A-Za-z_][A-Za-z0-9_]*)\s*\(",
    re.MULTILINE,
)
_CONSTANT_DECL_RE = re.compile(
    r"\b(?P<storage>__constant__|__device__|__managed__)\s+(?P<decl>[^;]+);",
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
    masked = mask_comments_for_parsing(source)
    cursor = 0
    while True:
        match = _GLOBAL_DECL_RE.search(masked, cursor)
        if not match:
            break
        name = match.group("name")
        _params, end = _read_balanced(masked, match.end() - 1, "(", ")")
        params = source[match.end() : max(match.end(), end - 1)]
        sigs[name] = params
        cursor = max(end, match.end())
    return sigs


def constant_layout_hash(source: str) -> str:
    decls = []
    masked = mask_comments_for_parsing(source)
    for match in _CONSTANT_DECL_RE.finditer(masked):
        decl = re.sub(r"\s+", " ", source[match.start("decl") : match.end("decl")]).strip()
        if "(" in decl:
            continue
        decls.append(f"{match.group('storage')} {decl}")
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


def mask_comments_for_parsing(source: str) -> str:
    """Replace C/C++ comments with whitespace while preserving offsets."""

    chars = list(source or "")
    i = 0
    n = len(chars)
    in_string: str | None = None
    escaped = False
    while i < n:
        ch = chars[i]
        nxt = chars[i + 1] if i + 1 < n else ""
        if in_string:
            if escaped:
                escaped = False
            elif ch == "\\":
                escaped = True
            elif ch == in_string:
                in_string = None
            i += 1
            continue
        if ch in {'"', "'"}:
            in_string = ch
            i += 1
            continue
        if ch == "/" and nxt == "/":
            chars[i] = " "
            chars[i + 1] = " "
            i += 2
            while i < n and chars[i] not in "\r\n":
                chars[i] = " "
                i += 1
            continue
        if ch == "/" and nxt == "*":
            chars[i] = " "
            chars[i + 1] = " "
            i += 2
            while i < n:
                if chars[i] == "*" and i + 1 < n and chars[i + 1] == "/":
                    chars[i] = " "
                    chars[i + 1] = " "
                    i += 2
                    break
                if chars[i] not in "\r\n":
                    chars[i] = " "
                i += 1
            continue
        i += 1
    return "".join(chars)


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
