"""Launch-graph extractor for Synthi GPU HMR.

The splitter prompt asks the model to emit a launch graph, but the
worker and tests need a deterministic backstop. This module extracts
both supported host forms:

  - raw CUDA/HIP syntax in pre-rewrite source:
    `kernel<<<grid, block, shared, stream>>>(args...)`
  - Synthi's runtime boundary in split source:
    `synthi_gpu_launch(gpu, "kernel", grid, block, shared, stream, {...})`

No LLM is used here. Symbolic expressions are kept as strings.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Iterable, List, Mapping, Optional


@dataclass(frozen=True)
class LaunchSite:
    site: str
    kernel: str
    grid: str
    block: str
    shared: str
    stream: str
    args: List[str]
    form: str

    def to_dict(self) -> dict:
        return {
            "site": self.site,
            "kernel": self.kernel,
            "grid": self.grid,
            "block": self.block,
            "shared": self.shared,
            "stream": self.stream,
            "args": self.args,
            "form": self.form,
        }


_RAW_LAUNCH_RE = re.compile(
    r"(?P<kernel>[A-Za-z_][A-Za-z0-9_]*)\s*<<<(?P<config>.*?)>>>\s*\(",
    re.DOTALL,
)
_BOUNDARY_CALL_RE = re.compile(r"\bsynthi_gpu_launch\s*\(", re.DOTALL)


def extract_launch_graph(files: Mapping[str, str]) -> List[LaunchSite]:
    """Extract launch sites from a path -> source mapping."""
    sites: List[LaunchSite] = []
    for path, source in files.items():
        if not _looks_like_host_source(path):
            continue
        sites.extend(_extract_raw_launches(path, source))
        sites.extend(_extract_boundary_launches(path, source))
    return sites


def launch_graph_as_dicts(files: Mapping[str, str]) -> List[dict]:
    return [site.to_dict() for site in extract_launch_graph(files)]


def _extract_raw_launches(path: str, source: str) -> Iterable[LaunchSite]:
    for match in _RAW_LAUNCH_RE.finditer(source):
        kernel = match.group("kernel")
        config_parts = _split_top_level(match.group("config"))
        args_body, _ = _read_balanced(source, match.end() - 1, "(", ")")
        args = _split_top_level(args_body)
        yield LaunchSite(
            site=_site(path, source, match.start()),
            kernel=kernel,
            grid=_part(config_parts, 0, "1"),
            block=_part(config_parts, 1, "1"),
            shared=_part(config_parts, 2, "0"),
            stream=_part(config_parts, 3, "0"),
            args=args,
            form="raw_triple_chevron",
        )


def _extract_boundary_launches(path: str, source: str) -> Iterable[LaunchSite]:
    for match in _BOUNDARY_CALL_RE.finditer(source):
        body, _ = _read_balanced(source, match.end() - 1, "(", ")")
        parts = _split_top_level(body)
        if len(parts) < 6:
            continue
        kernel = _strip_quotes(parts[1])
        if not kernel:
            continue
        yield LaunchSite(
            site=_site(path, source, match.start()),
            kernel=kernel,
            grid=parts[2].strip(),
            block=parts[3].strip(),
            shared=parts[4].strip() or "0",
            stream=parts[5].strip() or "0",
            args=_extract_boundary_args(parts[6] if len(parts) > 6 else ""),
            form="synthi_gpu_launch",
        )


def _extract_boundary_args(arg_expr: str) -> List[str]:
    text = arg_expr.strip()
    if text.startswith("{") and text.endswith("}"):
        text = text[1:-1]
    return [p.lstrip("&").strip() for p in _split_top_level(text) if p.strip()]


def _read_balanced(source: str, open_index: int, open_ch: str, close_ch: str) -> tuple[str, int]:
    if open_index < 0 or open_index >= len(source) or source[open_index] != open_ch:
        return "", open_index
    depth = 0
    start = open_index + 1
    i = open_index
    in_string: Optional[str] = None
    escape = False
    while i < len(source):
        ch = source[i]
        if in_string:
            if escape:
                escape = False
            elif ch == "\\":
                escape = True
            elif ch == in_string:
                in_string = None
        else:
            if ch in {'"', "'"}:
                in_string = ch
            elif ch == open_ch:
                depth += 1
            elif ch == close_ch:
                depth -= 1
                if depth == 0:
                    return source[start:i], i + 1
        i += 1
    return source[start:], len(source)


def _split_top_level(text: str) -> List[str]:
    parts: List[str] = []
    start = 0
    depth = 0
    in_string: Optional[str] = None
    escape = False
    pairs = {"(": ")", "{": "}", "[": "]", "<": ">"}
    closing = set(pairs.values())
    for i, ch in enumerate(text):
        if in_string:
            if escape:
                escape = False
            elif ch == "\\":
                escape = True
            elif ch == in_string:
                in_string = None
            continue
        if ch in {'"', "'"}:
            in_string = ch
        elif ch in pairs:
            depth += 1
        elif ch in closing and depth > 0:
            depth -= 1
        elif ch == "," and depth == 0:
            parts.append(text[start:i].strip())
            start = i + 1
    tail = text[start:].strip()
    if tail:
        parts.append(tail)
    return parts


def _part(parts: List[str], index: int, default: str) -> str:
    if index >= len(parts) or not parts[index].strip():
        return default
    return parts[index].strip()


def _strip_quotes(value: str) -> str:
    v = value.strip()
    if len(v) >= 2 and v[0] == v[-1] and v[0] in {'"', "'"}:
        return v[1:-1]
    return v


def _site(path: str, source: str, offset: int) -> str:
    line = source.count("\n", 0, offset) + 1
    return f"{path}:{line}"


def _looks_like_host_source(path: str) -> bool:
    lower = path.lower()
    return lower.endswith((".cpp", ".cc", ".cxx", ".c", ".h", ".hpp")) and not lower.endswith(
        (".cu", ".cuh", ".hip")
    )
