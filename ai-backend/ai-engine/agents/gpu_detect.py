"""GPU project detector — no LLM.

Phase-0 entry point for the GPU HMR pipeline. Scans a project's source
files with cheap regex and returns whether the project contains any
GPU code, plus a vendor hint when it's unambiguous.

Spec: docs/GPU_HMR_ULTRAPLAN.md §5.6 item 1.

The detector runs on every compile request *before* the Kernel Splitter
Agent fires, so it has to be deterministic, fast, and never call out
to a model. Regex is the primary path; tree-sitter is intentionally
NOT a dependency here — the codebase only uses tree-sitter lazily in
`shadow/runner/syntax.py:44-58` and we don't want every worker pod to
need libtree-sitter just to answer "is this a GPU project?".

The vendor hint is a separate axis from `is_gpu`:

    is_gpu=False, vendor_hint=None       → host-only project, fall
                                           through to the existing
                                           split pipeline.
    is_gpu=True,  vendor_hint="cuda"     → CUDA-only source (no HIP
                                           markers seen).
    is_gpu=True,  vendor_hint="rocm"     → HIP-only source.
    is_gpu=True,  vendor_hint="ambiguous"→ both vendors mentioned, or
                                           only `__global__` with no
                                           include directives. Caller
                                           defaults to `cuda` and lets
                                           the user override via the
                                           manifest's `gpu.vendor`.

The signals we look for were chosen because each one *uniquely*
implies GPU code — no false positives from ordinary C++:

  - `__global__` / `__device__` qualifiers — both CUDA and HIP use
    them; HIP is intentionally source-compatible with CUDA there.
  - Triple-chevron launch syntax `<<<grid, block, shared, stream>>>`
    — illegal C++ outside `nvcc`/`hipcc`.
  - `cudaMalloc` / `hipMalloc` and friends — the runtime libraries.
  - `#include <cuda_runtime.h>` / `#include <hip/hip_runtime.h>` —
    the headers. These are the *only* way to disambiguate vendor
    when the source uses only the shared CUDA/HIP subset.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Iterable, List, Literal, Mapping, Optional


VendorHint = Optional[Literal["cuda", "rocm", "ambiguous"]]


# ─────────────────────────────────────────────────────────────────────────────
# Detection patterns
# ─────────────────────────────────────────────────────────────────────────────
#
# Each regex is anchored conservatively so that:
#
#   - tokens inside string / character literals don't trip it (we strip
#     them before scanning),
#   - identifier prefix matches like `my__global___count` don't fire
#     the `__global__` rule,
#   - a comment like `// uses cudaMalloc later` doesn't fire (we strip
#     comments first).
#
# We match against the *cleaned* source: comments stripped, string and
# char literals replaced with empty placeholders, line endings normalised.


_VENDOR_NEUTRAL_QUALIFIER_RE = re.compile(
    r"(?<![A-Za-z0-9_])(?:__global__|__device__|__host__|__forceinline__|"
    r"__shared__|__constant__|__restrict__)(?![A-Za-z0-9_])"
)

# Triple-chevron launch: `kernel<<<grid, block>>>(args)` or
# `kernel<<<grid, block, shared, stream>>>(args)`. The closing `>>>`
# is distinctive — C++ template syntax never produces three `>` in a
# row without a space in older standards, and even in C++20 the
# combination of `<<<` *and* `>>>` in launch position is unambiguous.
_LAUNCH_CHEVRON_RE = re.compile(r"<<<[^;]{0,256}?>>>")

# CUDA runtime API surface — we look for the most common names.
# Lookahead on `(` filters out `cudaMalloc` mentioned in comments
# (which we already stripped) or struct-field accesses like
# `metrics.cudaMalloc_count`.
_CUDA_API_RE = re.compile(
    r"(?<![A-Za-z0-9_])(?:cudaMalloc|cudaFree|cudaMemcpy|cudaLaunchKernel|"
    r"cudaStreamCreate|cudaEventCreate|cudaDeviceSynchronize|"
    r"cudaGetLastError|cudaPeekAtLastError|cuModuleLoadData|cuMemcpyDtoH)"
    r"\s*\("
)

# HIP runtime API surface — mirrors CUDA naming with `hip` prefix.
_HIP_API_RE = re.compile(
    r"(?<![A-Za-z0-9_])(?:hipMalloc|hipFree|hipMemcpy|hipLaunchKernel|"
    r"hipStreamCreate|hipEventCreate|hipDeviceSynchronize|"
    r"hipGetLastError|hipPeekAtLastError|hipModuleLoad|hipMemcpyDtoH)"
    r"\s*\("
)

# Header includes are the strongest vendor signal — they're explicit
# about which runtime the source targets.
_CUDA_INCLUDE_RE = re.compile(
    r'^\s*#\s*include\s*[<"](?:cuda\.h|cuda_runtime\.h|cuda_runtime_api\.h|'
    r'device_launch_parameters\.h|cooperative_groups\.h)[>"]',
    re.MULTILINE,
)
_HIP_INCLUDE_RE = re.compile(
    r'^\s*#\s*include\s*[<"](?:hip/hip_runtime\.h|hip/hip_runtime_api\.h|'
    r'hip/hip_common\.h)[>"]',
    re.MULTILINE,
)


# ─────────────────────────────────────────────────────────────────────────────
# Source cleaning — strip comments + string/char literals
# ─────────────────────────────────────────────────────────────────────────────


_BLOCK_COMMENT_RE = re.compile(r"/\*.*?\*/", re.DOTALL)
_LINE_COMMENT_RE = re.compile(r"//[^\n]*")
# String / char literals — non-greedy, escape-aware enough for normal C++.
_STRING_LITERAL_RE = re.compile(r'"(?:[^"\\\n]|\\.)*"')
_CHAR_LITERAL_RE = re.compile(r"'(?:[^'\\\n]|\\.)*'")


def _strip_noise(source: str) -> str:
    """Remove comments and string/char literals before pattern scanning."""
    cleaned = _BLOCK_COMMENT_RE.sub(" ", source)
    cleaned = _LINE_COMMENT_RE.sub("", cleaned)
    cleaned = _STRING_LITERAL_RE.sub('""', cleaned)
    cleaned = _CHAR_LITERAL_RE.sub("''", cleaned)
    return cleaned


# ─────────────────────────────────────────────────────────────────────────────
# Public API
# ─────────────────────────────────────────────────────────────────────────────


@dataclass(frozen=True)
class GpuDetectionEvidence:
    """Per-file evidence breakdown returned alongside the verdict.

    Useful for debugging false positives / negatives and for the
    Kernel Splitter Agent's prompt context — it tells the LLM which
    file contained the GPU markers so it doesn't have to re-scan.
    """

    qualifier_hits: int = 0
    launch_chevron_hits: int = 0
    cuda_api_hits: int = 0
    hip_api_hits: int = 0
    cuda_include_hits: int = 0
    hip_include_hits: int = 0

    @property
    def is_gpu_evidence(self) -> bool:
        return (
            self.qualifier_hits
            + self.launch_chevron_hits
            + self.cuda_api_hits
            + self.hip_api_hits
            + self.cuda_include_hits
            + self.hip_include_hits
        ) > 0


@dataclass(frozen=True)
class GpuDetectionResult:
    is_gpu: bool
    vendor_hint: VendorHint
    per_file: Mapping[str, GpuDetectionEvidence]

    def to_dict(self) -> dict:
        return {
            "is_gpu": self.is_gpu,
            "vendor_hint": self.vendor_hint,
            "per_file": {
                path: {
                    "qualifier_hits": ev.qualifier_hits,
                    "launch_chevron_hits": ev.launch_chevron_hits,
                    "cuda_api_hits": ev.cuda_api_hits,
                    "hip_api_hits": ev.hip_api_hits,
                    "cuda_include_hits": ev.cuda_include_hits,
                    "hip_include_hits": ev.hip_include_hits,
                }
                for path, ev in self.per_file.items()
                if ev.is_gpu_evidence
            },
        }


def detect_file(source: str) -> GpuDetectionEvidence:
    """Score a single file's GPU evidence. Doesn't decide vendor —
    `detect_project` aggregates per-file evidence and resolves the hint.
    """
    cleaned = _strip_noise(source)
    return GpuDetectionEvidence(
        qualifier_hits=len(_VENDOR_NEUTRAL_QUALIFIER_RE.findall(cleaned)),
        launch_chevron_hits=len(_LAUNCH_CHEVRON_RE.findall(cleaned)),
        cuda_api_hits=len(_CUDA_API_RE.findall(cleaned)),
        hip_api_hits=len(_HIP_API_RE.findall(cleaned)),
        # Includes are scanned on the *original* source so commented-out
        # includes still count as "not present" (the block-comment strip
        # already removed them from `cleaned`, but multi-line raw-string
        # `R"(...)"` literals are an edge case we accept).
        cuda_include_hits=len(_CUDA_INCLUDE_RE.findall(cleaned)),
        hip_include_hits=len(_HIP_INCLUDE_RE.findall(cleaned)),
    )


def detect_project(files: Mapping[str, str]) -> GpuDetectionResult:
    """Scan an entire project's files for GPU markers.

    `files` is a path → content mapping. Paths with extensions that can
    never contain GPU C++ source (`.json`, `.md`, `.txt`, ...) are
    skipped to save work; we keep `.h` / `.hpp` / `.cpp` / `.cc` /
    `.cu` / `.hip` / `.c` plus extensionless files (treated as source).
    """
    per_file: dict[str, GpuDetectionEvidence] = {}
    cuda_total = 0
    hip_total = 0
    qualifier_total = 0
    launch_chevron_total = 0
    cuda_include_total = 0
    hip_include_total = 0

    for path, content in files.items():
        if not _looks_like_source(path):
            continue
        ev = detect_file(content)
        per_file[path] = ev
        cuda_total += ev.cuda_api_hits
        hip_total += ev.hip_api_hits
        qualifier_total += ev.qualifier_hits
        launch_chevron_total += ev.launch_chevron_hits
        cuda_include_total += ev.cuda_include_hits
        hip_include_total += ev.hip_include_hits

    has_gpu_markers = (
        qualifier_total
        + launch_chevron_total
        + cuda_total
        + hip_total
        + cuda_include_total
        + hip_include_total
    ) > 0

    if not has_gpu_markers:
        return GpuDetectionResult(is_gpu=False, vendor_hint=None, per_file=per_file)

    vendor_hint = _resolve_vendor_hint(
        cuda_include_total=cuda_include_total,
        hip_include_total=hip_include_total,
        cuda_api_total=cuda_total,
        hip_api_total=hip_total,
    )
    return GpuDetectionResult(is_gpu=True, vendor_hint=vendor_hint, per_file=per_file)


# ─────────────────────────────────────────────────────────────────────────────
# Internals
# ─────────────────────────────────────────────────────────────────────────────


_SOURCE_SUFFIXES = (
    ".cpp", ".cc", ".cxx", ".c", ".C",
    ".h", ".hpp", ".hh", ".hxx", ".H",
    ".cu", ".cuh", ".hip",
)


def _looks_like_source(path: str) -> bool:
    """Heuristic: should we scan this file for GPU markers?

    We deliberately err on the side of scanning rather than skipping —
    a misnamed file (`device.txt` containing CUDA snippets) is rare
    enough that paying for the regex pass is fine, but a missed scan
    silently routes a GPU project through the host pipeline.
    """
    lower = path.lower()
    if lower.endswith(".synthi_split_meta.json"):
        return False
    if "/." in lower or lower.startswith("."):
        # Dotfiles, hidden dirs.
        if not any(lower.endswith(ext) for ext in _SOURCE_SUFFIXES):
            return False
    if not any(lower.endswith(ext) for ext in _SOURCE_SUFFIXES):
        # Extensionless `Makefile`, `LICENSE`, etc. — skip; user GPU
        # code lives in files with known C/C++/CUDA extensions.
        return "." not in lower.rsplit("/", 1)[-1]
    return True


def _resolve_vendor_hint(
    *,
    cuda_include_total: int,
    hip_include_total: int,
    cuda_api_total: int,
    hip_api_total: int,
) -> VendorHint:
    """Decide vendor when we know the project is GPU.

    Include directives win — they're the user's explicit declaration
    of which runtime they're targeting. If neither side has includes
    but one has dominant API hits, we use that. If both sides have
    evidence, or neither has anything beyond bare `__global__`, we
    return `"ambiguous"` and let the caller resolve.
    """
    cuda_signal = cuda_include_total > 0 or cuda_api_total > 0
    hip_signal = hip_include_total > 0 or hip_api_total > 0

    if cuda_include_total > 0 and hip_include_total == 0:
        return "cuda"
    if hip_include_total > 0 and cuda_include_total == 0:
        return "rocm"
    if cuda_signal and not hip_signal:
        return "cuda"
    if hip_signal and not cuda_signal:
        return "rocm"
    if cuda_signal and hip_signal:
        return "ambiguous"
    # Bare `__global__` with no API or include — unambiguous to "is GPU"
    # but vendor is unknowable from the regex alone.
    return "ambiguous"
