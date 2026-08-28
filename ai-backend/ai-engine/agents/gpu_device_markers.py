"""Shared GPU device marker detection.

The split, repair, source-context, and verifier paths all need to recognize
project-defined device annotation macros without knowing the project or SDK
that defined them. Macro names are only candidates; declaration use or a
definition backed by concrete device syntax is required before they count.
"""

from __future__ import annotations

import re


DEVICE_ANNOTATION_MACRO_PATTERN = (
    r"[A-Z][A-Z0-9_]*(?:DEVICE|KERNEL|GPU|CUDA|HIP|OPENCL|SYCL|SHADER)[A-Z0-9_]*"
)
DEVICE_ANNOTATION_MACRO_RE = re.compile(rf"\b{DEVICE_ANNOTATION_MACRO_PATTERN}\b")

GPU_DEVICE_MARKER_RE = re.compile(
    rf"(?<![A-Za-z0-9_])(?:"
    rf"__(?:global|device|constant|managed)__"
    rf"|__(?:kernel|global|local|constant|private|generic)\b"
    rf"|GLOBAL_KERNEL_SIGNATURE\s*\("
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

_MACRO_DEFINITION_RE = re.compile(
    rf"^\s*#\s*define\s+(?P<name>{DEVICE_ANNOTATION_MACRO_PATTERN})"
    rf"(?:\s*\([^\n]*\))?\s+(?P<replacement>[^\n]+)$",
    re.MULTILINE,
)


def _mask_literals(source: str) -> str:
    """Mask string and character literals while preserving offsets."""

    chars = list(source or "")
    index = 0
    while index < len(chars):
        quote = chars[index]
        if quote not in {'"', "'"}:
            index += 1
            continue
        chars[index] = " "
        index += 1
        escaped = False
        while index < len(chars):
            current = chars[index]
            chars[index] = "\n" if current == "\n" else " "
            index += 1
            if escaped:
                escaped = False
            elif current == "\\":
                escaped = True
            elif current == quote:
                break
    return "".join(chars)


def _skip_balanced_parentheses(source: str, index: int) -> int:
    if index >= len(source) or source[index] != "(":
        return index
    depth = 0
    while index < len(source):
        if source[index] == "(":
            depth += 1
        elif source[index] == ")":
            depth -= 1
            if depth == 0:
                return index + 1
        index += 1
    return len(source)


def _macro_annotates_function(source: str, match: re.Match[str]) -> bool:
    """Require a candidate macro to occupy an annotation position."""

    line_start = source.rfind("\n", 0, match.start()) + 1
    line_end = source.find("\n", match.end())
    if line_end < 0:
        line_end = len(source)
    if source[line_start:line_end].lstrip().startswith("#"):
        return False

    segment_start = max(
        source.rfind(";", 0, match.start()),
        source.rfind("{", 0, match.start()),
        source.rfind("}", 0, match.start()),
    ) + 1
    terminal_positions = [
        position
        for token in (";", "{", "}")
        if (position := source.find(token, match.end())) >= 0
    ]
    segment_end = min(terminal_positions) if terminal_positions else len(source)
    segment_end = min(segment_end, match.end() + 512)
    segment = source[segment_start:segment_end]
    relative_start = match.start() - segment_start
    relative_end = match.end() - segment_start

    suffix_index = relative_end
    while suffix_index < len(segment) and segment[suffix_index].isspace():
        suffix_index += 1
    if suffix_index < len(segment) and segment[suffix_index] == "(":
        suffix_index = _skip_balanced_parentheses(segment, suffix_index)
    suffix = segment[suffix_index:]
    function_match = re.search(r"\b[A-Za-z_][A-Za-z0-9_]*\s*\(", suffix)
    if not function_match:
        return False

    before_function = suffix[: function_match.start()]
    if any(token in before_function for token in ("=", ";", "{", "}")):
        return False
    if before_function.strip():
        return True

    prefix = segment[:relative_start].strip()
    return bool(prefix and not prefix.endswith(("=", ",", "(", "[")))


def _has_device_annotation_macro(source: str) -> bool:
    definitions = {
        definition.group("name"): definition.group("replacement")
        for definition in _MACRO_DEFINITION_RE.finditer(source)
    }
    concrete_definitions = {
        name for name, replacement in definitions.items() if GPU_DEVICE_MARKER_RE.search(replacement)
    }
    while True:
        newly_resolved = {
            name
            for name, replacement in definitions.items()
            if name not in concrete_definitions
            and any(
                re.search(rf"\b{re.escape(resolved)}\b", replacement)
                for resolved in concrete_definitions
            )
        }
        if not newly_resolved:
            break
        concrete_definitions.update(newly_resolved)
    for match in DEVICE_ANNOTATION_MACRO_RE.finditer(source):
        if match.group(0) in concrete_definitions or _macro_annotates_function(source, match):
            return True
    return False


def has_gpu_device_marker(masked_source: str) -> bool:
    source = _mask_literals(masked_source or "")
    return bool(GPU_DEVICE_MARKER_RE.search(source) or _has_device_annotation_macro(source))
