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
                                           include directives. Caller must
                                           resolve this from target metadata
                                           or explicit request settings.

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

_OPENCL_RE = re.compile(
    r"(?<![A-Za-z0-9_])(?:__(?:kernel|global|local|constant|private|generic)\b|"
    r"get_(?:global|local|group)_id\s*\(|"
    r"barrier\s*\(\s*CLK_(?:LOCAL|GLOBAL)_MEM_FENCE|"
    r"#\s*pragma\s+OPENCL\s+EXTENSION\b)",
    re.MULTILINE | re.IGNORECASE,
)
_WGSL_RE = re.compile(
    r"(?:@(?:compute|vertex|fragment|workgroup_size|group|binding)\b|"
    r"var\s*<\s*(?:storage|workgroup|uniform)\b)",
    re.IGNORECASE,
)
_GLSL_RE = re.compile(
    r"(?:^\s*#\s*version\s+\d+\b|"
    r"\bgl_(?:GlobalInvocationID|LocalInvocationID|WorkGroupID|Position)\b|"
    r"\blayout\s*\([^)]*(?:local_size|binding|set))",
    re.MULTILINE,
)
_HLSL_RE = re.compile(
    r"(?:\[\s*numthreads\s*\(|"
    r"\bSV_(?:DispatchThreadID|GroupID|GroupThreadID|Position)\b)",
    re.IGNORECASE,
)
_SYCL_RE = re.compile(
    r"(?:^\s*#\s*include\s*[<\"]sycl/(?:sycl\.hpp|[^>\"]+)[>\"]|"
    r"\bsycl::(?:queue|handler|parallel_for|single_task|nd_range)\b)",
    re.MULTILINE,
)
_VULKAN_API_RE = re.compile(
    r"(?<![A-Za-z0-9_])(?:vkCreateShaderModule|vkCreateComputePipelines|"
    r"vkCreateGraphicsPipelines|vkCmdDispatch|vkCmdBindPipeline)\s*\("
)
_WEBGPU_API_RE = re.compile(
    r"(?<![A-Za-z0-9_])(?:wgpuDeviceCreateShaderModule|"
    r"wgpuDeviceCreateComputePipeline|createShaderModule|"
    r"createComputePipeline|createRenderPipeline|dispatchWorkgroups)\s*\("
)

_CMAKE_BRACKET_COMMENT_RE = re.compile(
    r"#\[(?P<equals>=*)\[.*?\](?P=equals)\]",
    re.DOTALL,
)
_CMAKE_BRACKET_ARGUMENT_RE = re.compile(
    r"\[(?P<equals>=*)\[.*?\](?P=equals)\]",
    re.DOTALL,
)
_CMAKE_LINE_COMMENT_RE = re.compile(r"#[^\n]*")


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


def _strip_cmake_noise(source: str) -> str:
    cleaned = _CMAKE_BRACKET_COMMENT_RE.sub(" ", source)
    cleaned = _CMAKE_LINE_COMMENT_RE.sub("", cleaned)
    cleaned = _CMAKE_BRACKET_ARGUMENT_RE.sub(" ", cleaned)
    cleaned = _STRING_LITERAL_RE.sub('""', cleaned)
    return cleaned


def _cmake_language_declaration_hits(source: str, language: str) -> int:
    cleaned = _strip_cmake_noise(source)
    token = re.escape(language)
    patterns = (
        rf"\benable_language\s*\(\s*{token}\b",
        rf"\bproject\s*\([^)]{{0,4096}}\bLANGUAGES?\b[^)]{{0,4096}}\b{token}\b",
        rf"\bset\s*\(\s*CMAKE_{token}_ARCHITECTURES\b",
        rf"\b(?:set_source_files_properties|set_property)\s*\([^)]{{0,4096}}\bLANGUAGE\s+{token}\b",
    )
    return sum(len(re.findall(pattern, cleaned, re.IGNORECASE)) for pattern in patterns)


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
    opencl_hits: int = 0
    wgsl_hits: int = 0
    glsl_hits: int = 0
    hlsl_hits: int = 0
    sycl_hits: int = 0
    vulkan_api_hits: int = 0
    webgpu_api_hits: int = 0
    cuda_build_hits: int = 0
    hip_build_hits: int = 0

    @property
    def is_gpu_evidence(self) -> bool:
        return (
            self.qualifier_hits
            + self.launch_chevron_hits
            + self.cuda_api_hits
            + self.hip_api_hits
            + self.cuda_include_hits
            + self.hip_include_hits
            + self.opencl_hits
            + self.wgsl_hits
            + self.glsl_hits
            + self.hlsl_hits
            + self.sycl_hits
            + self.vulkan_api_hits
            + self.webgpu_api_hits
            + self.cuda_build_hits
            + self.hip_build_hits
        ) > 0


@dataclass(frozen=True)
class GpuDetectionResult:
    is_gpu: bool
    vendor_hint: VendorHint
    per_file: Mapping[str, GpuDetectionEvidence]
    backend_hints: tuple[str, ...] = ()

    def to_dict(self) -> dict:
        return {
            "is_gpu": self.is_gpu,
            "vendor_hint": self.vendor_hint,
            "backend_hints": list(self.backend_hints),
            "per_file": {
                path: {
                    "qualifier_hits": ev.qualifier_hits,
                    "launch_chevron_hits": ev.launch_chevron_hits,
                    "cuda_api_hits": ev.cuda_api_hits,
                    "hip_api_hits": ev.hip_api_hits,
                    "cuda_include_hits": ev.cuda_include_hits,
                    "hip_include_hits": ev.hip_include_hits,
                    "opencl_hits": ev.opencl_hits,
                    "wgsl_hits": ev.wgsl_hits,
                    "glsl_hits": ev.glsl_hits,
                    "hlsl_hits": ev.hlsl_hits,
                    "sycl_hits": ev.sycl_hits,
                    "vulkan_api_hits": ev.vulkan_api_hits,
                    "webgpu_api_hits": ev.webgpu_api_hits,
                    "cuda_build_hits": ev.cuda_build_hits,
                    "hip_build_hits": ev.hip_build_hits,
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
        opencl_hits=len(_OPENCL_RE.findall(cleaned)),
        wgsl_hits=len(_WGSL_RE.findall(cleaned)),
        glsl_hits=len(_GLSL_RE.findall(cleaned)),
        hlsl_hits=len(_HLSL_RE.findall(cleaned)),
        sycl_hits=len(_SYCL_RE.findall(cleaned)),
        vulkan_api_hits=len(_VULKAN_API_RE.findall(cleaned)),
        webgpu_api_hits=len(_WEBGPU_API_RE.findall(cleaned)),
    )


def detect_cmake_file(source: str) -> GpuDetectionEvidence:
    return GpuDetectionEvidence(
        cuda_build_hits=_cmake_language_declaration_hits(source, "CUDA"),
        hip_build_hits=_cmake_language_declaration_hits(source, "HIP"),
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
    cuda_build_total = 0
    hip_build_total = 0
    portable_backend_totals = {
        "opencl": 0,
        "webgpu_wgsl": 0,
        "glsl": 0,
        "hlsl": 0,
        "sycl": 0,
        "vulkan": 0,
        "webgpu": 0,
    }

    for path, content in files.items():
        if _looks_like_cmake(path):
            ev = detect_cmake_file(content)
        elif _looks_like_source(path):
            ev = detect_file(content)
        else:
            continue
        per_file[path] = ev
        cuda_total += ev.cuda_api_hits
        hip_total += ev.hip_api_hits
        qualifier_total += ev.qualifier_hits
        launch_chevron_total += ev.launch_chevron_hits
        cuda_include_total += ev.cuda_include_hits
        hip_include_total += ev.hip_include_hits
        cuda_build_total += ev.cuda_build_hits
        hip_build_total += ev.hip_build_hits
        portable_backend_totals["opencl"] += ev.opencl_hits
        portable_backend_totals["webgpu_wgsl"] += ev.wgsl_hits
        portable_backend_totals["glsl"] += ev.glsl_hits
        portable_backend_totals["hlsl"] += ev.hlsl_hits
        portable_backend_totals["sycl"] += ev.sycl_hits
        portable_backend_totals["vulkan"] += ev.vulkan_api_hits
        portable_backend_totals["webgpu"] += ev.webgpu_api_hits

    has_gpu_markers = (
        qualifier_total
        + launch_chevron_total
        + cuda_total
        + hip_total
        + cuda_include_total
        + hip_include_total
        + cuda_build_total
        + hip_build_total
        + sum(portable_backend_totals.values())
    ) > 0

    if not has_gpu_markers:
        return GpuDetectionResult(
            is_gpu=False,
            vendor_hint=None,
            per_file=per_file,
            backend_hints=(),
        )

    vendor_hint = _resolve_vendor_hint(
        cuda_include_total=cuda_include_total,
        hip_include_total=hip_include_total,
        cuda_api_total=cuda_total + cuda_build_total,
        hip_api_total=hip_total + hip_build_total,
    )
    backend_hints = set(
        backend for backend, hit_count in portable_backend_totals.items() if hit_count > 0
    )
    if cuda_include_total > 0 or cuda_total > 0 or cuda_build_total > 0:
        backend_hints.add("cuda")
    if hip_include_total > 0 or hip_total > 0 or hip_build_total > 0:
        backend_hints.add("hip")
    if qualifier_total > 0 or launch_chevron_total > 0:
        backend_hints.add("cuda_or_hip")
    return GpuDetectionResult(
        is_gpu=True,
        vendor_hint=vendor_hint,
        per_file=per_file,
        backend_hints=tuple(sorted(backend_hints)),
    )


# ─────────────────────────────────────────────────────────────────────────────
# Internals
# ─────────────────────────────────────────────────────────────────────────────


_SOURCE_SUFFIXES = (
    ".cpp", ".cc", ".cxx", ".c", ".C",
    ".h", ".hpp", ".hh", ".hxx", ".H",
    ".cu", ".cuh", ".hip",
    ".cl", ".opencl", ".wgsl", ".glsl", ".vert", ".frag",
    ".geom", ".comp", ".tesc", ".tese", ".hlsl", ".metal",
    ".slang", ".js", ".jsx", ".ts", ".tsx",
)


def _looks_like_cmake(path: str) -> bool:
    name = path.replace("\\", "/").rsplit("/", 1)[-1].lower()
    return name == "cmakelists.txt" or name.endswith(".cmake")


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
