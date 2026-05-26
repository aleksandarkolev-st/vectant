"""Shared GPU device marker detection.

The split, repair, source-context, and verifier paths all need to recognize
project-defined device annotation macros without knowing the project or SDK
that defined them. Keep the pattern conservative: it only matches uppercase
macro-like identifiers that contain a GPU/device platform cue.
"""

from __future__ import annotations

import re


DEVICE_ANNOTATION_MACRO_PATTERN = r"[A-Z][A-Z0-9_]*(?:DEVICE|GPU|CUDA|HIP)[A-Z0-9_]*"
DEVICE_ANNOTATION_MACRO_RE = re.compile(rf"\b{DEVICE_ANNOTATION_MACRO_PATTERN}\b")

GPU_DEVICE_MARKER_RE = re.compile(
    rf"\b(?:"
    rf"__(?:global|device|constant|managed|host)__"
    rf"|GLOBAL_KERNEL_SIGNATURE\s*\("
    rf"|{DEVICE_ANNOTATION_MACRO_PATTERN}"
    rf"|oroModuleLaunchKernel"
    rf"|hiprtc(?:CreateProgram|CompileProgram|GetCode|GetBitcode)"
    rf"|cuModuleLaunchKernel"
    rf")",
    re.I,
)


def has_gpu_device_marker(masked_source: str) -> bool:
    return bool(GPU_DEVICE_MARKER_RE.search(masked_source or ""))
