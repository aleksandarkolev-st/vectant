"""Conservative deterministic GPU split for simple source-owned HIP/CUDA apps.

This module is deliberately narrow. It handles one target-scoped source file
where static analysis can mechanically preserve device kernels, source launch
sites, GPU readbacks, and SDL rendering without semantic invention. Anything
outside that shape returns a reason-coded unsupported error so the normal AI
splitter path can try, or the caller can reject loudly.
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass, field
from typing import Any, Dict, List, Mapping, Optional, Sequence, Tuple

from agents.abi_stamper import mask_comments_for_parsing
from agents.gpu_device_mapping import extract_kernel_region_records
from agents.launch_graph_extractor import LaunchSite, extract_launch_graph, launch_graph_as_dicts


@dataclass
class DeterministicGpuSplitResult:
    files: Dict[str, str]
    manifest: dict
    architecture_md: str
    launch_graph: List[dict]
    report: dict = field(default_factory=dict)


class DeterministicGpuSplitUnsupported(Exception):
    def __init__(self, reason_code: str, message: str, *, report: Optional[Mapping[str, Any]] = None):
        self.reason_code = reason_code
        self.report = dict(report or {})
        super().__init__(message)


@dataclass(frozen=True)
class _Buffer:
    host_name: str
    device_name: str
    ctype: str
    count_expr: str
    bytes_expr: str


@dataclass
class _SeedPlan:
    function_name: str
    param_types: List[str]
    param_names: List[str]
    host_arg_names: List[str]
    loop_index: str
    count_expr: str
    body: str
    device_kernel_name: str = "synthi_generated_seed_buffers"


@dataclass
class _SourceShape:
    path: str
    source: str
    vendor: str
    arch: str
    launches: List[LaunchSite]
    buffers: List[_Buffer]
    constants: str
    launch_dim_decls: List[str]
    device_prelude: str
    render_block: str
    helper_functions: str
    seed_plan: Optional[_SeedPlan]


_SUPPORTED_VENDORS = {"rocm", "cuda"}
_RUNTIME_INCLUDE_RE = re.compile(r"#\s*include\s+<(?:hip/hip_runtime\.h|cuda_runtime\.h)>")
_SDL_INCLUDE_RE = re.compile(r"#\s*include\s+<SDL2/SDL\.h>")
_CONSTANT_BLOCK_RE = re.compile(
    r"(?:#ifndef\s+[A-Za-z_][A-Za-z0-9_]*\s*\n#define\s+[A-Za-z_][A-Za-z0-9_]*\s+[^\n]+\n#endif\s*\n+)|"
    r"(?:constexpr\s+(?:int|unsigned\s+int|size_t|float|double|unsigned\s+long\s+long|long\s+long)\s+"
    r"[A-Za-z_][A-Za-z0-9_]*\s*=\s*[^;]+;\s*)",
    re.MULTILINE,
)
_HOST_ARRAY_RE = re.compile(
    r"\b(?P<type>(?:const\s+)?(?:float|double|int|unsigned\s+int|uint32_t|std::uint32_t|unsigned\s+char))\s+"
    r"(?P<name>[A-Za-z_][A-Za-z0-9_]*)\s*\[\s*(?P<count>[^\]]+)\s*\]\s*;"
)
_DEVICE_PTR_RE = re.compile(
    r"\b(?P<type>(?:const\s+)?(?:float|double|int|unsigned\s+int|uint32_t|std::uint32_t|unsigned\s+char))\s*\*\s*"
    r"(?P<name>[A-Za-z_][A-Za-z0-9_]*)\s*=\s*(?:nullptr|NULL|0)\s*;"
)
_MEMCPY_RE = re.compile(
    r"\b(?P<fn>hipMemcpy|cudaMemcpy)\s*\(\s*(?P<dst>[^,]+?)\s*,\s*(?P<src>[^,]+?)\s*,\s*"
    r"(?P<bytes>[^,]+?)\s*,\s*(?P<kind>hipMemcpyDeviceToHost|cudaMemcpyDeviceToHost|hipMemcpyHostToDevice|cudaMemcpyHostToDevice)\s*\)",
    re.DOTALL,
)
_HELPER_FUNCTION_RE = re.compile(
    r"\bstatic\s+void\s+(?P<name>[A-Za-z_][A-Za-z0-9_]*)\s*\(",
    re.DOTALL,
)
_KERNEL_DECL_RE = re.compile(r"\b(?:extern\s+\"C\"\s+)?__global__\b")
_DEVICE_FUNC_RE = re.compile(r"\b__device__\b")
_MAIN_RE = re.compile(r"\bint\s+main\s*\(")


def try_build_deterministic_gpu_split(
    *,
    source_files: Mapping[str, str],
    source_context_report: Mapping[str, Any],
    vendor_hint: Optional[str],
    arch_hint: Optional[str],
    focus: Optional[str] = None,
) -> DeterministicGpuSplitResult:
    report: dict = {
        "schemaVersion": "synthi.gpu_hmr.deterministic_split.v1",
        "mode": "mechanical_single_source_gpu_split",
        "providerCallUsed": False,
        "supported": False,
        "reasonCodes": [],
        "evidence": [],
    }
    vendor = _normalize_vendor(vendor_hint)
    arch = str(arch_hint or "").strip()
    if vendor not in _SUPPORTED_VENDORS:
        _unsupported(report, "deterministic_split_vendor_missing", "deterministic split requires explicit CUDA or ROCm vendor evidence")
    if not arch or arch.lower() == "auto":
        _unsupported(report, "deterministic_split_arch_missing", "deterministic split requires an explicit GPU arch")
    _check_context_supported(source_context_report, report)

    path, source = _select_single_source(source_files, focus=focus, report=report)
    shape = _analyze_source_shape(path=path, source=source, vendor=vendor, arch=arch, report=report)
    files = _render_split_files(shape)
    manifest = _render_manifest(shape, files)
    launch_graph = launch_graph_as_dicts({shape.path: shape.source})
    architecture_md = _render_architecture(shape, report)
    report["supported"] = True
    report["sourcePath"] = shape.path
    report["kernelNames"] = sorted({site.kernel for site in shape.launches})
    report["bufferPairs"] = [
        {"host": buffer.host_name, "device": buffer.device_name, "type": buffer.ctype, "count": buffer.count_expr}
        for buffer in shape.buffers
    ]
    if shape.seed_plan:
        report["seedPlan"] = {
            "function": shape.seed_plan.function_name,
            "kernel": shape.seed_plan.device_kernel_name,
            "countExpr": shape.seed_plan.count_expr,
        }
    return DeterministicGpuSplitResult(
        files=files,
        manifest=manifest,
        architecture_md=architecture_md,
        launch_graph=launch_graph,
        report=report,
    )


def _unsupported(report: dict, reason_code: str, message: str) -> None:
    report.setdefault("reasonCodes", []).append(reason_code)
    raise DeterministicGpuSplitUnsupported(reason_code, message, report=report)


def _normalize_vendor(raw: Optional[str]) -> Optional[str]:
    value = str(raw or "").strip().lower()
    if value in {"hip", "amd", "amdhip"}:
        return "rocm"
    return value or None


def _check_context_supported(source_context_report: Mapping[str, Any], report: dict) -> None:
    if source_context_report.get("criticalDropped"):
        _unsupported(
            report,
            "deterministic_split_context_incomplete",
            "deterministic split requires complete target-scoped source context",
        )
    topology = source_context_report.get("deviceTuTopology")
    if isinstance(topology, Mapping):
        if topology.get("multiDeviceTu") is True:
            _unsupported(
                report,
                "deterministic_split_multi_device_tu",
                "deterministic split only supports one target-scoped device translation unit",
            )
        status = str(topology.get("supportStatus") or "")
        if status and status not in {"single_device_tu"}:
            _unsupported(
                report,
                str((topology.get("reasonCodes") or ["deterministic_split_device_topology_unsupported"])[0]),
                "deterministic split requires a single-device-TU topology",
            )
    graphics_backend = source_context_report.get("graphicsBackend")
    if isinstance(graphics_backend, Mapping):
        if graphics_backend.get("supportStatus") == "unsupported":
            reasons = graphics_backend.get("reasonCodes") or ["deterministic_split_graphics_backend_unsupported"]
            _unsupported(report, str(reasons[0]), "deterministic split cannot override unsupported graphics backend evidence")
        primary = str(graphics_backend.get("primary") or "").lower()
        if primary and primary not in {"sdl", "sdl2"}:
            _unsupported(
                report,
                "deterministic_split_non_sdl_render_backend",
                "deterministic visual split currently supports source-owned SDL rendering only",
            )


def _select_single_source(
    source_files: Mapping[str, str],
    *,
    focus: Optional[str],
    report: dict,
) -> Tuple[str, str]:
    normalized = {str(path).replace("\\", "/"): str(source) for path, source in source_files.items()}
    focus_norm = str(focus or "").replace("\\", "/")
    candidates: List[Tuple[int, str, str]] = []
    for path, source in normalized.items():
        masked = mask_comments_for_parsing(source)
        if not _MAIN_RE.search(masked):
            continue
        launches = extract_launch_graph({path: source})
        if not launches:
            continue
        score = 0 if focus_norm and path == focus_norm else 1
        candidates.append((score, path, source))
    candidates.sort(key=lambda item: (item[0], item[1]))
    if not candidates:
        _unsupported(
            report,
            "deterministic_split_no_single_source_launch_loop",
            "deterministic split requires one source file with main() and raw GPU launch sites",
        )
    if len(candidates) > 1 and (not focus_norm or candidates[0][0] != 0 or candidates[1][0] == 0):
        _unsupported(
            report,
            "deterministic_split_multiple_host_launch_sources",
            "deterministic split refuses to choose among multiple host launch sources",
        )
    return candidates[0][1], candidates[0][2]


def _analyze_source_shape(
    *,
    path: str,
    source: str,
    vendor: str,
    arch: str,
    report: dict,
) -> _SourceShape:
    masked = mask_comments_for_parsing(source)
    if not _SDL_INCLUDE_RE.search(masked):
        _unsupported(report, "deterministic_split_sdl_include_missing", "deterministic visual split requires SDL2 source rendering evidence")
    if not _RUNTIME_INCLUDE_RE.search(masked):
        _unsupported(report, "deterministic_split_gpu_runtime_include_missing", "deterministic split requires CUDA/HIP runtime includes in source")
    if vendor == "rocm" and "hip/hip_runtime.h" not in source:
        _unsupported(report, "deterministic_split_vendor_source_mismatch", "ROCm deterministic split requires HIP source APIs")
    if vendor == "cuda" and "cuda_runtime.h" not in source:
        _unsupported(report, "deterministic_split_vendor_source_mismatch", "CUDA deterministic split requires CUDA source APIs")

    launches = [site for site in extract_launch_graph({path: source}) if site.form == "raw_triple_chevron"]
    if not launches:
        _unsupported(report, "deterministic_split_raw_launch_missing", "deterministic split requires raw HIP/CUDA launch sites to rewrite")
    kernel_names = {region.name for region in extract_kernel_region_records(source)}
    missing = sorted({site.kernel for site in launches if site.kernel not in kernel_names})
    if missing:
        _unsupported(
            report,
            "deterministic_split_launch_kernel_unresolved",
            f"launch graph references kernels not declared in the source: {', '.join(missing)}",
        )

    buffers = _extract_buffers(source, report)
    if not buffers:
        _unsupported(report, "deterministic_split_buffer_mapping_missing", "deterministic split requires observed malloc/readback buffer pairs")
    launch_dim_decls = _extract_launch_dim_decls(source)
    _validate_launch_shapes(launches, launch_dim_decls, report)
    render_block = _extract_sdl_render_block(source, report)
    constants = _extract_constants(source)
    device_prelude = _extract_device_prelude(source, report)
    helper_functions = _extract_render_helpers(source, render_block)
    seed_plan = _extract_seed_plan(source, buffers, report)
    if _source_has_h2d(source) and seed_plan is None:
        _unsupported(
            report,
            "deterministic_split_unconvertible_host_to_device_init",
            "source uses HostToDevice initialization but no mechanical seed loop could be converted",
        )
    return _SourceShape(
        path=path,
        source=source,
        vendor=vendor,
        arch=arch,
        launches=launches,
        buffers=buffers,
        constants=constants,
        launch_dim_decls=launch_dim_decls,
        device_prelude=device_prelude,
        render_block=render_block,
        helper_functions=helper_functions,
        seed_plan=seed_plan,
    )


def _extract_constants(source: str) -> str:
    seen: List[str] = []
    for match in _CONSTANT_BLOCK_RE.finditer(source):
        block = match.group(0).strip()
        if block and block not in seen:
            seen.append(block)
    return "\n".join(seen)


def _extract_buffers(source: str, report: dict) -> List[_Buffer]:
    host_arrays = {
        match.group("name"): (match.group("type").strip(), match.group("count").strip())
        for match in _HOST_ARRAY_RE.finditer(source)
    }
    device_ptrs = {
        match.group("name"): match.group("type").strip()
        for match in _DEVICE_PTR_RE.finditer(source)
    }
    malloc_bytes = _extract_malloc_bytes(source)
    pairs: Dict[Tuple[str, str], str] = {}
    for match in _MEMCPY_RE.finditer(source):
        kind = match.group("kind")
        dst = _clean_expr(match.group("dst"))
        src = _clean_expr(match.group("src"))
        if kind.endswith("DeviceToHost"):
            host, device = dst, src
        elif kind.endswith("HostToDevice"):
            host, device = src, dst
        else:
            continue
        if host in host_arrays and device in device_ptrs:
            pairs.setdefault((host, device), re.sub(r"\s+", " ", match.group("bytes").strip()))
    buffers: List[_Buffer] = []
    for (host, device), bytes_expr in sorted(pairs.items()):
        host_type, count_expr = host_arrays[host]
        device_type = device_ptrs.get(device) or host_type
        if _normalize_type(host_type) != _normalize_type(device_type):
            _unsupported(
                report,
                "deterministic_split_buffer_type_mismatch",
                f"host/device buffer type mismatch for {host}/{device}",
            )
        buffers.append(
            _Buffer(
                host_name=host,
                device_name=device,
                ctype=host_type,
                count_expr=count_expr,
                bytes_expr=malloc_bytes.get(device) or bytes_expr,
            )
        )
    return buffers


def _extract_malloc_bytes(source: str) -> Dict[str, str]:
    malloc_bytes: Dict[str, str] = {}
    for match in re.finditer(r"\b(?:hipMalloc|cudaMalloc)\s*\(", source):
        body, _after = _read_balanced(source, match.end() - 1, "(", ")")
        args = _split_top_level(body)
        if len(args) < 2:
            continue
        ptr = _clean_expr(args[0])
        malloc_bytes[ptr] = re.sub(r"\s+", " ", args[1].strip())
    return malloc_bytes


def _clean_expr(expr: str) -> str:
    return re.sub(r"\s+", "", expr.strip().lstrip("&"))


def _normalize_type(value: str) -> str:
    return re.sub(r"\s+", " ", value.replace("std::", "")).strip()


def _source_has_h2d(source: str) -> bool:
    return any(match.group("kind").endswith("HostToDevice") for match in _MEMCPY_RE.finditer(source))


def _extract_launch_dim_decls(source: str) -> List[str]:
    masked = mask_comments_for_parsing(source)
    declarations: List[str] = []
    seen: set[str] = set()
    for match in re.finditer(
        r"\b(?:dim3|Dim3)\s+(?P<name>[A-Za-z_][A-Za-z0-9_]*)\s*(?:=)?\s*(?P<init>\{[^;]*\}|\([^;]*\))\s*;",
        masked,
        re.DOTALL,
    ):
        name = match.group("name")
        if name in seen:
            continue
        seen.add(name)
        init = source[match.start("init") : match.end("init")].strip()
        declarations.append(f"Dim3 {name}{init};")
    return declarations


def _validate_launch_shapes(launches: Sequence[LaunchSite], launch_dim_decls: Sequence[str], report: dict) -> None:
    declared_dims = {
        match.group("name")
        for decl in launch_dim_decls
        for match in [re.match(r"\s*Dim3\s+(?P<name>[A-Za-z_][A-Za-z0-9_]*)", decl)]
        if match
    }
    for launch in launches:
        for role, expr in (("grid", launch.grid), ("block", launch.block)):
            text = str(expr or "").strip()
            if _is_simple_identifier(text) and text not in declared_dims:
                _unsupported(
                    report,
                    f"deterministic_split_launch_{role}_unresolved",
                    f"launch {role} expression {text!r} has no parseable source dim3 declaration",
                )
        stream = str(launch.stream or "").strip()
        if stream and stream not in {"0", "nullptr", "NULL"}:
            _unsupported(
                report,
                "deterministic_split_non_default_stream",
                "deterministic split requires an observed default stream or a backend-specific stream proof",
            )


def _extract_sdl_render_block(source: str, report: dict) -> str:
    present = re.search(r"\bSDL_RenderPresent\s*\(\s*renderer\s*\)\s*;", source)
    if not present:
        _unsupported(report, "deterministic_split_sdl_present_missing", "SDL render loop must present through the source renderer")
    readbacks = [
        match
        for match in _MEMCPY_RE.finditer(source[: present.start()])
        if match.group("kind").endswith("DeviceToHost")
    ]
    if not readbacks:
        _unsupported(
            report,
            "deterministic_split_sdl_render_readback_boundary_missing",
            "SDL render block extraction requires a source DeviceToHost readback before presentation",
        )
    start = readbacks[-1].end()
    while start < present.start() and source[start] in " \t\r\n;":
        start += 1
    block = source[start: present.start()].strip()
    if "SDL_Render" not in block:
        _unsupported(report, "deterministic_split_sdl_draw_block_missing", "SDL render block has no render operations")
    return _rewrite_source_block_for_state(block)


def _rewrite_source_block_for_state(block: str) -> str:
    out = block
    out = re.sub(r"\bSDL_RenderPresent\s*\([^;]+;", "", out)
    out = re.sub(r"\bSDL_Delay\s*\([^;]+;", "", out)
    return out.strip()


def _extract_device_prelude(source: str, report: dict) -> str:
    main_match = _MAIN_RE.search(mask_comments_for_parsing(source))
    if not main_match:
        _unsupported(report, "deterministic_split_main_missing", "source must contain main()")
    pre_main = source[: main_match.start()]
    lines: List[str] = []
    for include in ("#include <hip/hip_runtime.h>", "#include <cuda_runtime.h>", "#include <cmath>", "#include <cstdlib>", "#include <cstdint>"):
        if include in pre_main and include not in lines:
            lines.append(include)
    body = _strip_constant_blocks(_strip_includes_and_host_only_comments(pre_main))
    body = _ensure_extern_c_global_kernels(body)
    if not (_KERNEL_DECL_RE.search(body) or _DEVICE_FUNC_RE.search(body)):
        _unsupported(report, "deterministic_split_device_code_missing", "source device code could not be extracted")
    lines.append(body.strip())
    return "\n\n".join(part for part in lines if part.strip())


def _strip_includes_and_host_only_comments(source: str) -> str:
    lines = []
    for line in source.splitlines():
        stripped = line.strip()
        if stripped.startswith("#include"):
            continue
        if stripped.startswith("// User-authored") or stripped.startswith("// BUILD:") or stripped.startswith("// LINK:"):
            continue
        lines.append(line)
    return "\n".join(lines)


def _strip_constant_blocks(source: str) -> str:
    return _CONSTANT_BLOCK_RE.sub("", source)


def _ensure_extern_c_global_kernels(source: str) -> str:
    return re.sub(
        r"(?<!extern\s\"C\"\s)\b__global__\s+void\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(",
        r'extern "C" __global__ void \1(',
        source,
    )


def _extract_render_helpers(source: str, render_block: str) -> str:
    helpers: List[str] = []
    masked = mask_comments_for_parsing(source)
    main_match = _MAIN_RE.search(masked)
    search_limit = main_match.start() if main_match else len(source)
    for match in _HELPER_FUNCTION_RE.finditer(masked[:search_limit]):
        name = match.group("name")
        if not re.search(rf"\b{re.escape(name)}\s*\(", render_block):
            continue
        open_paren = source.find("(", match.start())
        _params, after_params = _read_balanced(source, open_paren, "(", ")")
        body_open = source.find("{", after_params)
        if body_open < 0:
            continue
        body_close = _matching_brace(source, body_open)
        if body_close is None:
            continue
        helpers.append(source[match.start() : body_close + 1].strip())
    return "\n\n".join(helpers)


def _extract_seed_plan(source: str, buffers: Sequence[_Buffer], report: dict) -> Optional[_SeedPlan]:
    h2d_pairs = []
    for match in _MEMCPY_RE.finditer(source):
        if not match.group("kind").endswith("HostToDevice"):
            continue
        h2d_pairs.append((_clean_expr(match.group("src")), _clean_expr(match.group("dst"))))
    if not h2d_pairs:
        return None
    host_names = {host for host, _device in h2d_pairs}
    masked = mask_comments_for_parsing(source)
    main_match = _MAIN_RE.search(masked)
    search_limit = main_match.start() if main_match else len(source)
    main_body = masked[search_limit:]
    for match in _HELPER_FUNCTION_RE.finditer(masked[:search_limit]):
        name = match.group("name")
        call_match = re.search(rf"\b{re.escape(name)}\s*\((?P<args>[^;]+)\)\s*;", main_body)
        if not call_match:
            continue
        call_args = [_clean_expr(arg) for arg in _split_top_level(call_match.group("args"))]
        if not host_names.issubset(set(call_args)):
            continue
        open_paren = source.find("(", match.start())
        params, after_params = _read_balanced(source, open_paren, "(", ")")
        param_types, param_names = _parse_param_decls(params)
        body_open = source.find("{", after_params)
        if body_open < 0:
            continue
        body_close = _matching_brace(source, body_open)
        if body_close is None:
            continue
        body = source[body_open + 1 : body_close]
        loop = re.search(
            r"\bfor\s*\(\s*int\s+(?P<idx>[A-Za-z_][A-Za-z0-9_]*)\s*=\s*0\s*;\s*(?P=idx)\s*<\s*(?P<count>[^;]+?)\s*;\s*\+\+(?P=idx)\s*\)\s*\{",
            mask_comments_for_parsing(body),
        )
        if not loop:
            continue
        loop_open = body.find("{", loop.start())
        loop_close = _matching_brace(body, loop_open)
        if loop_close is None:
            continue
        if len(call_args) != len(param_names):
            continue
        param_host_map = dict(zip(param_names, call_args))
        if not host_names.issubset(set(param_host_map.values())):
            continue
        return _SeedPlan(
            function_name=name,
            param_types=param_types,
            param_names=param_names,
            host_arg_names=call_args,
            loop_index=loop.group("idx"),
            count_expr=loop.group("count").strip(),
            body=body[loop_open + 1 : loop_close].strip(),
        )
    _unsupported(
        report,
        "deterministic_split_seed_loop_missing",
        "source HostToDevice initialization did not have a parseable seed loop",
    )


def _render_split_files(shape: _SourceShape) -> Dict[str, str]:
    device_ext = "hip" if shape.vendor == "rocm" else "cu"
    files = {
        "shared.h": _render_shared(shape),
        "core.cpp": _render_core(shape),
        "gui.cpp": _render_gui(shape),
        "host_runner.cpp": _render_host_runner(),
        f"device.{device_ext}": _render_device(shape),
    }
    return files


def _render_shared(shape: _SourceShape) -> str:
    fields = [
        "    void* renderer = nullptr;",
        "    unsigned long long frame = 0ULL;",
        "    bool device_initialized = false;",
    ]
    for buffer in shape.buffers:
        fields.append(f"    {buffer.ctype}* {buffer.host_name} = nullptr;")
        fields.append(f"    {buffer.ctype}* {buffer.device_name} = nullptr;")
    return "\n".join(
        [
            "#pragma once",
            '#include "synthi_gpu_runtime.h"',
            "#include <cstddef>",
            "",
            shape.constants,
            "",
            "struct AppState {",
            *fields,
            "};",
            "",
        ]
    )


def _render_core(shape: _SourceShape) -> str:
    api = _api(shape.vendor)
    kernel_names = sorted({site.kernel for site in shape.launches} | ({shape.seed_plan.device_kernel_name} if shape.seed_plan else set()))
    arch_entries = ", ".join(f'"{shape.arch}"' for _ in [shape.arch])
    kernel_entries = ", ".join(f'"{name}"' for name in kernel_names)
    lines: List[str] = [
        '#include "shared.h"',
        api["include"],
        "#include <cmath>",
        "#include <cstdio>",
        "#include <cstdlib>",
        "#include <cstring>",
        "",
        "static AppState g_state{};",
        f"static const char* kSynthiGpuArches[] = {{ {arch_entries} }};",
        f"static const char* kSynthiGpuKernels[] = {{ {kernel_entries} }};",
        "",
    ]
    if shape.helper_functions:
        lines.append(shape.helper_functions)
        lines.append("")
    lines.extend(
        [
            'extern "C" const DeviceDescriptor* device_descriptor() {',
            f'    static DeviceDescriptor descriptor{{"{shape.vendor}", kSynthiGpuArches, kSynthiGpuKernels, 1, {len(kernel_names)}, 0}};',
            "    return &descriptor;",
            "}",
            "",
            'extern "C" void device_on_load(const unsigned char*, std::size_t) {}',
            'extern "C" std::size_t device_save_size() { return 0; }',
            'extern "C" void device_save_write(unsigned char*, std::size_t) {}',
            "",
            'extern "C" void* core_on_load(void* prev_state, void* renderer) {',
            "    if (prev_state) {",
            "        g_state = *static_cast<AppState*>(prev_state);",
            "    }",
            "    g_state.renderer = renderer;",
        ]
    )
    for buffer in shape.buffers:
        lines.append(f"    if (!g_state.{buffer.host_name}) {{")
        lines.append(f"        g_state.{buffer.host_name} = new {buffer.ctype}[{buffer.count_expr}];")
        lines.append("    }")
    lines.extend(_render_host_seed_initialization(shape))
    for buffer in shape.buffers:
        lines.append(f"    if (!g_state.{buffer.device_name}) {{")
        lines.append(f"        {api['malloc']}(&g_state.{buffer.device_name}, {buffer.bytes_expr});")
        lines.append(f'        synthi_register(g_state.{buffer.device_name}, {buffer.bytes_expr}, "persistent");')
        lines.append("    }")
    lines.extend(
        [
            "    return &g_state;",
            "}",
            "",
            'extern "C" void core_on_update(void* state_ptr, double) {',
            "    AppState* state = state_ptr ? static_cast<AppState*>(state_ptr) : &g_state;",
            "    bool synthi_all_launched = true;",
        ]
    )
    lines.extend(f"    {decl}" for decl in shape.launch_dim_decls)
    if shape.seed_plan:
        seed_block = _source_dim3_expr(shape.launches[0].block)
        seed_grid = _source_dim3_expr(shape.launches[0].grid)
        seed_args = []
        for host_arg_name in shape.seed_plan.host_arg_names:
            buffer = _buffer_by_host(shape.buffers, host_arg_name)
            if buffer is None:
                continue
            seed_args.append(f"&state->{buffer.device_name}")
        lines.extend(
            [
                "    if (!state->device_initialized) {",
                f"        Dim3 synthi_seed_grid = {seed_grid};",
                f"        Dim3 synthi_seed_block = {seed_block};",
                f'        bool synthi_seed_launched = synthi_gpu_launch(nullptr, "{shape.seed_plan.device_kernel_name}", synthi_seed_grid, synthi_seed_block, 0, nullptr, {{ {", ".join(seed_args)} }});',
                "        state->device_initialized = synthi_seed_launched;",
                "        synthi_all_launched = synthi_all_launched && synthi_seed_launched;",
                "    }",
            ]
        )
    for index, launch in enumerate(shape.launches):
        launch_grid = _source_dim3_expr(launch.grid)
        launch_block = _source_dim3_expr(launch.block)
        launch_stream = _source_stream_expr(launch.stream)
        scalar_args, launch_entries = _render_launch_args(shape, launch, index)
        lines.extend(f"    {line}" for line in scalar_args)
        lines.append(f"    Dim3 synthi_grid_{index} = {launch_grid};")
        lines.append(f"    Dim3 synthi_block_{index} = {launch_block};")
        site = _escape_cpp_string(launch.site)
        provenance = "source_instrumented"
        entries = ", ".join(launch_entries)
        lines.append(
            f'    bool synthi_launch_{index} = synthi_gpu_launch_source_location(nullptr, "{site}", "{provenance}", "{launch.kernel}", synthi_grid_{index}, synthi_block_{index}, {launch.shared or "0"}, {launch_stream}, {{ {entries} }});'
        )
        lines.append(f"    synthi_all_launched = synthi_all_launched && synthi_launch_{index};")
    lines.append("    if (synthi_all_launched) {")
    lines.append(f"        {api['sync']}();")
    for buffer in shape.buffers:
        lines.append(
            f"        {api['memcpy']}(state->{buffer.host_name}, state->{buffer.device_name}, {buffer.bytes_expr}, {api['d2h']});"
        )
    lines.append("    }")
    lines.append("}")
    return "\n".join(lines) + "\n"


def _render_host_seed_initialization(shape: _SourceShape) -> List[str]:
    return []


def _render_launch_args(shape: _SourceShape, launch: LaunchSite, index: int) -> Tuple[List[str], List[str]]:
    declarations: List[str] = []
    entries: List[str] = []
    kernel_params = _kernel_params_by_name(shape.device_prelude, launch.kernel)
    for arg_index, source_arg in enumerate(launch.args):
        clean = _clean_expr(source_arg)
        buffer = _buffer_by_device(shape.buffers, clean)
        if buffer is not None:
            entries.append(f"&state->{buffer.device_name}")
            continue
        ctype = _param_type_at(kernel_params, arg_index)
        var = f"synthi_arg_{index}_{arg_index}"
        expr = _rewrite_scalar_expr_for_state(source_arg)
        declarations.append(f"{ctype} {var} = {expr};")
        entries.append(f"&{var}")
    return declarations, entries


def _source_dim3_expr(expr: str) -> str:
    text = str(expr or "1").strip()
    if _is_simple_identifier(text):
        return text
    if re.match(r"^(?:dim3|Dim3)\s*(?:\(|\{)", text):
        return re.sub(r"^dim3\b", "Dim3", text, count=1)
    parts = _split_top_level(text)
    if len(parts) > 1:
        return f"Dim3({', '.join(parts)})"
    return f"Dim3({text}, 1, 1)"


def _source_stream_expr(expr: str) -> str:
    text = str(expr or "").strip()
    return "nullptr" if text in {"", "0", "NULL", "nullptr"} else text


def _is_simple_identifier(expr: str) -> bool:
    return bool(re.match(r"^[A-Za-z_][A-Za-z0-9_]*$", str(expr or "").strip()))


def _kernel_params_by_name(device_source: str, kernel: str) -> List[str]:
    match = re.search(
        rf'\b(?:extern\s+"C"\s+)?__global__\s+void\s+{re.escape(kernel)}\s*\((?P<params>[^)]*)\)',
        mask_comments_for_parsing(device_source),
        re.DOTALL,
    )
    if not match:
        return []
    return _split_top_level(match.group("params"))


def _param_type_at(params: Sequence[str], index: int) -> str:
    if index >= len(params):
        return "int"
    param = params[index].strip()
    param = re.sub(r"\s+", " ", param)
    param = re.sub(r"\s+[A-Za-z_][A-Za-z0-9_]*\s*(?:=.*)?$", "", param).strip()
    param = param.replace("const ", "").strip()
    if "*" in param or "&" in param:
        return "void*"
    return param or "int"


def _rewrite_scalar_expr_for_state(expr: str) -> str:
    text = expr.strip()
    text = re.sub(r"\bframe\s*\+\+", "state->frame++", text)
    return text


def _render_gui(shape: _SourceShape) -> str:
    alias_lines = ["    AppState* state = static_cast<AppState*>(state_ptr);", "    if (!state || !state->renderer) return;", "    SDL_Renderer* renderer = static_cast<SDL_Renderer*>(state->renderer);"]
    for buffer in shape.buffers:
        alias_lines.append(f"    {buffer.ctype}* {buffer.host_name} = state->{buffer.host_name};")
    alias_lines.append("    unsigned long long frame = state->frame;")
    block = _indent(shape.render_block, "    ")
    return "\n".join(
        [
            '#include "shared.h"',
            "#include <SDL2/SDL.h>",
            "#include <cmath>",
            "#include <cstdio>",
            "",
            shape.helper_functions,
            "",
            'extern "C" void* gui_on_load(void*, void*, void* core_state) { return core_state; }',
            'extern "C" void gui_on_render(void* state_ptr) {',
            *alias_lines,
            block,
            "}",
            "",
        ]
    )


def _render_host_runner() -> str:
    return r'''#include <chrono>
#include <cstdio>
#include <dlfcn.h>
#include <SDL2/SDL.h>
#include <thread>

using SynthiCoreLoadFn = void* (*)(void*, void*);
using SynthiCoreUpdateFn = void (*)(void*, double);
using SynthiGuiLoadFn = void* (*)(void*, void*, void*);
using SynthiGuiRenderFn = void (*)(void*);

int main() {
    void* libcore = dlopen("./libcore.so", RTLD_NOW | RTLD_LOCAL);
    void* libgui = dlopen("./libgui.so", RTLD_NOW | RTLD_LOCAL);
    auto core_load = reinterpret_cast<SynthiCoreLoadFn>(dlsym(libcore, "core_on_load"));
    auto core_update = reinterpret_cast<SynthiCoreUpdateFn>(dlsym(libcore, "core_on_update"));
    auto gui_load = reinterpret_cast<SynthiGuiLoadFn>(dlsym(libgui, "gui_on_load"));
    auto gui_render = reinterpret_cast<SynthiGuiRenderFn>(dlsym(libgui, "gui_on_render"));
    if (!core_load || !core_update || !gui_render) {
        std::fprintf(stderr, "[host_runner] generated modules are missing required entrypoints\n");
        return 2;
    }
    if (SDL_Init(SDL_INIT_VIDEO) != 0) {
        std::fprintf(stderr, "[host_runner] SDL_Init failed: %s\n", SDL_GetError());
        return 3;
    }
    SDL_Window* window = SDL_CreateWindow(
        "Synthi GPU HMR deterministic preview",
        SDL_WINDOWPOS_CENTERED,
        SDL_WINDOWPOS_CENTERED,
        800,
        600,
        0
    );
    SDL_Renderer* renderer = window ? SDL_CreateRenderer(window, -1, SDL_RENDERER_ACCELERATED) : nullptr;
    if (!window || !renderer) {
        std::fprintf(stderr, "[host_runner] SDL preview renderer failed: %s\n", SDL_GetError());
        if (renderer) SDL_DestroyRenderer(renderer);
        if (window) SDL_DestroyWindow(window);
        SDL_Quit();
        return 4;
    }
    void* core_state = core_load(nullptr, renderer);
    void* gui_state = core_state;
    if (gui_load) {
        gui_state = gui_load(nullptr, renderer, core_state);
    }
    bool running = true;
    for (;;) {
        SDL_Event event;
        while (SDL_PollEvent(&event)) {
            if (event.type == SDL_QUIT) {
                running = false;
            }
        }
        if (!running) break;
        core_update(core_state, 0.016);
        gui_render(gui_state);
        SDL_RenderPresent(renderer);
        std::this_thread::sleep_for(std::chrono::milliseconds(16));
    }
    SDL_DestroyRenderer(renderer);
    SDL_DestroyWindow(window);
    SDL_Quit();
    return 0;
}
'''


def _render_device(shape: _SourceShape) -> str:
    parts = ['#include "shared.h"', shape.device_prelude]
    if shape.seed_plan:
        parts.append(_render_seed_kernel(shape))
    return "\n\n".join(part for part in parts if part.strip()) + "\n"


def _render_seed_kernel(shape: _SourceShape) -> str:
    seed = shape.seed_plan
    if seed is None:
        return ""
    params = []
    for param_type, host_arg_name in zip(seed.param_types, seed.host_arg_names):
        buffer = _buffer_by_host(shape.buffers, host_arg_name)
        if buffer is not None:
            params.append(f"{buffer.ctype}* {buffer.device_name}")
    idx = seed.loop_index
    body = seed.body
    for param_name, host_arg_name in zip(seed.param_names, seed.host_arg_names):
        buffer = _buffer_by_host(shape.buffers, host_arg_name)
        if buffer is not None:
            body = re.sub(rf"\b{re.escape(param_name)}\b", buffer.device_name, body)
    return "\n".join(
        [
            f'extern "C" __global__ void {seed.device_kernel_name}({", ".join(params)}) {{',
            f"    int {idx} = blockIdx.x * blockDim.x + threadIdx.x;",
            f"    if ({idx} >= {seed.count_expr}) return;",
            _indent(body, "    "),
            "}",
        ]
    )


def _render_manifest(shape: _SourceShape, files: Mapping[str, str]) -> dict:
    device_name = "device.hip" if shape.vendor == "rocm" else "device.cu"
    return {
        "compiler": "clang++" if shape.vendor == "rocm" else "g++",
        "std": "c++17",
        "common_flags": ["-shared", "-fPIC"],
        "core_link_flags": [],
        "gui_link_flags": ["-lSDL2"],
        "shared_link_flags": [],
        "runner_link_flags": ["-lSDL2", "-ldl", "-pthread", "-rdynamic"],
        "files": list(files.keys()),
        "system_packages": [],
        "hot_reload_mode": "swap",
        "module_files": {
            "shared": "shared.h",
            "core": "core.cpp",
            "gui": "gui.cpp",
            "host_runner": "host_runner.cpp",
            "device": device_name,
        },
        "confidence": {
            "overall": "medium",
            "runner_synthesis": "medium",
            "link_flags": "medium",
            "notes": "deterministic mechanical split accepted only after verifier checks",
        },
        "gpu": {
            "vendor": shape.vendor,
            "device_compiler": "hipcc" if shape.vendor == "rocm" else "nvcc",
            "arch": [shape.arch],
            "device_flags": [],
            "runtime_libs": ["amdhip64"] if shape.vendor == "rocm" else ["cudart", "cuda"],
            "snapshot_mode": "auto",
            "fatbin_strategy": "sidecar_module",
        },
    }


def _render_architecture(shape: _SourceShape, report: Mapping[str, Any]) -> str:
    return "\n".join(
        [
            "# Deterministic GPU Split",
            "",
            "A conservative static splitter produced this role split without an AI provider call.",
            f"Source: `{shape.path}`",
            f"Backend: `{shape.vendor}` arch `{shape.arch}`",
            f"Launches: {', '.join(site.kernel for site in shape.launches)}",
            "",
            "<synthi_deterministic_split_report>",
            json.dumps(report, sort_keys=True),
            "</synthi_deterministic_split_report>",
        ]
    )


def _api(vendor: str) -> dict:
    if vendor == "rocm":
        return {
            "include": "#include <hip/hip_runtime.h>",
            "malloc": "hipMalloc",
            "memcpy": "hipMemcpy",
            "sync": "hipDeviceSynchronize",
            "d2h": "hipMemcpyDeviceToHost",
        }
    return {
        "include": "#include <cuda_runtime.h>",
        "malloc": "cudaMalloc",
        "memcpy": "cudaMemcpy",
        "sync": "cudaDeviceSynchronize",
        "d2h": "cudaMemcpyDeviceToHost",
    }


def _primary_count_expr(shape: _SourceShape) -> str:
    return shape.buffers[0].count_expr if shape.buffers else "1"


def _buffer_by_host(buffers: Sequence[_Buffer], host_name: str) -> Optional[_Buffer]:
    clean = _clean_expr(host_name)
    for buffer in buffers:
        if buffer.host_name == clean:
            return buffer
    return None


def _buffer_by_device(buffers: Sequence[_Buffer], device_name: str) -> Optional[_Buffer]:
    clean = _clean_expr(device_name)
    for buffer in buffers:
        if buffer.device_name == clean:
            return buffer
    return None


def _parse_param_decls(params: str) -> Tuple[List[str], List[str]]:
    types: List[str] = []
    names: List[str] = []
    for param in _split_top_level(params):
        text = re.sub(r"\s+", " ", param.strip())
        match = re.match(r"(?P<type>.+?)(?P<name>[A-Za-z_][A-Za-z0-9_]*)\s*$", text)
        if not match:
            continue
        type_text = match.group("type").strip()
        name = match.group("name").strip()
        types.append(type_text)
        names.append(name)
    return types, names


def _split_top_level(body: str) -> List[str]:
    args: List[str] = []
    start = 0
    stack: List[str] = []
    pairs = {"(": ")", "{": "}", "[": "]", "<": ">"}
    closers = set(pairs.values())
    in_string: Optional[str] = None
    escaped = False
    for index, ch in enumerate(body):
        if in_string:
            if escaped:
                escaped = False
            elif ch == "\\":
                escaped = True
            elif ch == in_string:
                in_string = None
            continue
        if ch in {'"', "'"}:
            in_string = ch
            continue
        if ch in pairs:
            if ch == "<" and (index == 0 or not re.match(r"[A-Za-z0-9_:]", body[index - 1])):
                continue
            stack.append(pairs[ch])
        elif ch in closers:
            if stack and stack[-1] == ch:
                stack.pop()
        elif ch == "," and not stack:
            args.append(body[start:index].strip())
            start = index + 1
    tail = body[start:].strip()
    if tail:
        args.append(tail)
    return args


def _read_balanced(source: str, open_index: int, opener: str, closer: str) -> Tuple[str, int]:
    if open_index < 0 or open_index >= len(source) or source[open_index] != opener:
        return "", open_index
    depth = 0
    in_string: Optional[str] = None
    escaped = False
    for index in range(open_index, len(source)):
        ch = source[index]
        if in_string:
            if escaped:
                escaped = False
            elif ch == "\\":
                escaped = True
            elif ch == in_string:
                in_string = None
            continue
        if ch in {'"', "'"}:
            in_string = ch
            continue
        if ch == opener:
            depth += 1
        elif ch == closer:
            depth -= 1
            if depth == 0:
                return source[open_index + 1 : index], index + 1
    return source[open_index + 1 :], len(source)


def _matching_brace(source: str, open_brace: int) -> Optional[int]:
    if open_brace < 0 or open_brace >= len(source) or source[open_brace] != "{":
        return None
    depth = 0
    in_string: Optional[str] = None
    escaped = False
    for index in range(open_brace, len(source)):
        ch = source[index]
        if in_string:
            if escaped:
                escaped = False
            elif ch == "\\":
                escaped = True
            elif ch == in_string:
                in_string = None
            continue
        if ch in {'"', "'"}:
            in_string = ch
            continue
        if ch == "{":
            depth += 1
        elif ch == "}":
            depth -= 1
            if depth == 0:
                return index
    return None


def _indent(source: str, prefix: str) -> str:
    return "\n".join(prefix + line if line.strip() else line for line in source.splitlines())


def _escape_cpp_string(value: str) -> str:
    return value.replace("\\", "\\\\").replace('"', '\\"')
