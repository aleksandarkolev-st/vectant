"""Shared GPU device marker detection.

The split, repair, source-context, and verifier paths all need to recognize
project-defined device annotation macros without knowing the project or SDK
that defined them. Keep the pattern conservative: it only matches uppercase
macro-like identifiers that contain a GPU/device platform cue.
"""

from __future__ import annotations

import re


DEVICE_ANNOTATION_MACRO_PATTERN = (
    r"[A-Z][A-Z0-9_]*(?:DEVICE|GPU|CUDA|HIP|OPENCL|SYCL|SHADER)[A-Z0-9_]*"
)
DEVICE_ANNOTATION_MACRO_RE = re.compile(rf"\b{DEVICE_ANNOTATION_MACRO_PATTERN}\b")

GPU_DEVICE_MARKER_RE = re.compile(
    rf"(?<![A-Za-z0-9_])(?:"
    rf"__(?:global|device|constant|managed|host)__"
    rf"|__(?:kernel|global|local|constant|private|generic)\b"
    rf"|GLOBAL_KERNEL_SIGNATURE\s*\("
    rf"|{DEVICE_ANNOTATION_MACRO_PATTERN}"
    rf"|oroModuleLaunchKernel"
    rf"|hiprtc(?:CreateProgram|CompileProgram|GetCode|GetBitcode)"
    rf"|cuModuleLaunchKernel"
    rf"|get_(?:global|local|group)_id\s*\("
    rf"|barrier\s*\(\s*CLK_(?:LOCAL|GLOBAL)_MEM_FENCE"
    rf"|@(?:compute|vertex|fragment|workgroup_size|group|binding)\b"
    rf"|var\s*<\s*(?:storage|workgroup|uniform)\b"
    rf"|gl_(?:GlobalInvocationID|LocalInvocationID|WorkGroupID|Position)\b"
    rf"|layout\s*\([^)]*(?:local_size|binding|set)"
    rf"|\[\s*numthreads\s*\("
    rf"|SV_(?:DispatchThreadID|GroupID|GroupThreadID|Position)\b"
    rf"|sycl::(?:queue|handler|parallel_for|single_task|nd_range)\b"
    rf"|vk(?:CreateShaderModule|CreateComputePipelines|CmdDispatch)\s*\("
    rf"|(?:wgpuDeviceCreateShaderModule|createShaderModule|dispatchWorkgroups)\s*\("
    rf")",
    re.I,
)


def has_gpu_device_marker(masked_source: str) -> bool:
    return bool(GPU_DEVICE_MARKER_RE.search(masked_source or ""))
