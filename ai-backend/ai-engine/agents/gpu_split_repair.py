"""Deterministic repair helpers for GPU split artifacts.

The splitter agent may propose generated roles, but generated artifacts are not
trusted until deterministic verification passes. These helpers perform narrow,
source-derived repairs on generated roles only, then the caller re-runs the
verifier. They intentionally avoid fixture- or symbol-specific rules.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Any, Dict, Iterable, List, Mapping, Optional, Sequence, Set, Tuple

from agents.abi_stamper import mask_comments_for_parsing
from verifier_gpu import (
    _CPP_DECL_KEYWORDS,
    _GUI_RENDER_EFFECT_RE,
    _GPU_SDK_VECTOR_TYPE_NAMES,
    SplitVerificationResult,
    _device_role_included_source_files as _verifier_device_role_included_source_files,
    _host_runner_routes_gui_module,
    _launch_initializer_args,
    _launch_kernel_name,
    _normalize_launch_buffer_arg,
    _render_backends_in_sources,
    _resolve_split_role_paths,
    _source_device_files as _verifier_source_device_files,
    _split_top_level_args,
    _strip_cpp_comments,
)


REPAIR_SCHEMA_VERSION = "synthi.gpu.split_repair.v1"

_DEVICE_SOURCE_EXTENSIONS = (".cu", ".hip")
_DEVICE_HEADER_EXTENSIONS = (".h", ".hpp", ".hh", ".hxx", ".cuh")
_QUOTE_INCLUDE_RE = re.compile(r"#\s*include\s+\"(?P<path>[^\"]+)\"")
_ANY_INCLUDE_RE = re.compile(r"#\s*include\s+[<\"](?P<path>[^>\"]+)[>\"]")
_INCLUDE_LINE_RE = re.compile(
    r"(?m)^[ \t]*#\s*include\s+[<\"](?P<path>[^>\"]+)[>\"][^\n]*(?:\n|$)"
)
_OBJECT_DEFINE_RE = re.compile(
    r"^\s*#\s*define\s+(?P<name>[A-Za-z_][A-Za-z0-9_]*)(?P<value>(?:\s+.*)?)$"
)
_DEFINE_NAME_RE = re.compile(r"^\s*#\s*define\s+(?P<name>[A-Za-z_][A-Za-z0-9_]*)\b")
_KERNEL_OPTION_CONDITION_RE = re.compile(r"^\s*#\s*(?:if|elif)\s+(?P<expr>.*)$")
_IDENTIFIER_RE = re.compile(r"\b[A-Za-z_][A-Za-z0-9_]*\b")
_SOURCE_DEVICE_CONST_DECL_RE = re.compile(
    r"(?P<decl>\b(?:(?:constexpr|const|__constant__)\s+)*"
    r"(?P<type>(?:std::)?uint32_t|unsigned\s+int|int|float|double)\s+"
    r"(?P<name>k[A-Z][A-Za-z0-9_]*)\s*(?:=[^;]*)?;)",
    re.MULTILINE,
)
_SCALAR_CONST_DECL_TEMPLATE = (
    r"(?m)^\s*(?:(?:constexpr|const|__constant__)\s+)*"
    r"(?:std::)?(?:uint32_t|unsigned\s+int|int|float|double)\s+"
    r"{name}\s*(?:=[^;]*)?;\s*$"
)
_GLOBAL_KERNEL_SIGNATURE_RE = re.compile(
    r"(?P<prefix>\b(?:extern\s+\"C\"\s+)?__global__\s+(?:void\s+)?)"
    r"(?P<name>[A-Za-z_][A-Za-z0-9_]*)\s*\((?P<params>[^)]*)\)",
    re.DOTALL,
)
_ANY_GLOBAL_KERNEL_RE = re.compile(
    r"(?:"
    r"(?:extern\s+\"C\"\s+)?__global__\s+(?:void\s+)?"
    r"|GLOBAL_KERNEL_SIGNATURE\s*\([^)]*\)\s+(?:__launch_bounds__\s*\([^)]*\)\s*)?"
    r")(?P<name>[A-Za-z_][A-Za-z0-9_]*)\s*\(",
    re.DOTALL,
)
_SOURCE_DEVICE_FUNCTION_RE = re.compile(
    r"\b(?:HIPRT_DEVICE|HIPRT_HOST_DEVICE|__device__|__host__\s+__device__|__device__\s+__host__)\b"
    r"(?P<signature>[^;{}]*?)"
    r"\b(?P<name>[A-Za-z_][A-Za-z0-9_]*)\s*"
    r"\([^;{}()]*(?:\([^;{}()]*\)[^;{}()]*)*\)"
    r"\s*(?P<terminator>[;{])",
    re.DOTALL,
)
_GPU_SDK_VECTOR_STRUCT_RE = re.compile(
    r"\b(?:struct|class)\s+(?P<name>"
    + "|".join(re.escape(name) for name in sorted(_GPU_SDK_VECTOR_TYPE_NAMES, key=len, reverse=True))
    + r")\s*\{"
)
_DEVICE_TO_HOST_COPY_MARKER_RE = re.compile(
    r"\b(?:cudaMemcpyDeviceToHost|hipMemcpyDeviceToHost)\b"
)
_GUI_RENDER_EFFECT_REASON_CODES = {
    "gui_render_no_effect",
    "gui_render_placeholder",
    "gui_render_too_sparse",
}
_SOURCE_OPENGL_MARKER_RE = re.compile(
    r"\b(?:glClear|glClearColor|glViewport|glMatrixMode|glOrtho|"
    r"glBegin|glDrawArrays|glDrawElements|glVertex[234][A-Za-z]*|"
    r"GLFWwindow|glfw[A-Za-z0-9_]*|GL/gl\.h|GLFW/glfw3\.h)\b"
)
_MISSING_INCLUDE_ERROR_RE = re.compile(
    r"(?:fatal\s+error:\s*)?[\"'](?P<path>[^\"']+\.(?:h|hh|hpp|hxx|cuh))[\"']\s+file\s+not\s+found",
    re.IGNORECASE,
)
_UNDECLARED_IDENTIFIER_ERROR_RE = re.compile(
    r"(?:use\s+of\s+)?undeclared\s+identifier\s+[\"'](?P<name>[A-Za-z_][A-Za-z0-9_]*)[\"']",
    re.IGNORECASE,
)
_OPENGL_INCLUDE_RE = re.compile(
    r"#\s*include\s+[<\"](?:GL/gl\.h|OpenGL/gl\.h|GLFW/glfw3\.h)[>\"]"
)
_LAUNCH_UNRESOLVED_REPAIR_SCOPE = {
    "launch_site_unresolved",
    "source_device_kernel_not_preserved",
    "source_device_kernel_signature_not_preserved",
    "source_device_kernel_body_not_preserved",
    "source_device_identifier_not_preserved",
    "source_device_identifier_not_used",
}
_RESERVED_DEFAULT_MACRO_NAMES = {
    "__launch_bounds__",
    "__restrict",
    "__restrict__",
    "__shared__",
}


@dataclass
class _ParamInfo:
    declaration: str
    type_text: str
    name: str
    is_pointer: bool


@dataclass
class _LaunchInfo:
    start: int
    end: int
    body: str
    args: List[str]
    kernel: str
    launch_args: List[str]
    pointer_buffers: Dict[str, Tuple[str, _ParamInfo]]
    is_init: bool


def repair_split_artifacts(
    *,
    files: Mapping[str, str],
    manifest: Optional[Mapping[str, Any]],
    source_files: Mapping[str, str],
    verification: Optional[SplitVerificationResult],
) -> tuple[Dict[str, str], dict]:
    """Return generated files after narrow deterministic repairs.

    The returned files still require `verify_split_output` before use.
    """

    repaired = {str(path): str(content) for path, content in files.items()}
    changed_files: Set[str] = set()
    repair_rules: List[str] = []
    input_reason_codes = (
        [violation.rule for violation in verification.violations]
        if verification is not None
        else []
    )

    role_paths = _resolve_split_role_paths(repaired, manifest)
    device_path = role_paths.get("device")
    core_path = role_paths.get("core")
    shared_path = role_paths.get("shared")
    gui_path = role_paths.get("gui")
    host_runner_path = role_paths.get("host_runner")

    if "generated_role_includes_project_header" in input_reason_codes:
        headers_by_role = _project_headers_by_role(verification)
        for role_path, headers in headers_by_role.items():
            if not role_path or role_path not in repaired or not headers:
                continue
            role_after, changed = _remove_generated_project_includes(
                repaired[role_path],
                headers,
            )
            if changed:
                repaired[role_path] = role_after
                changed_files.add(role_path)
        if changed_files:
            repair_rules.append("repair.generated_project_includes")

    if "generated_role_redeclares_gpu_sdk_type" in input_reason_codes:
        for role_path in (shared_path, core_path, gui_path, host_runner_path, device_path):
            if not role_path or role_path not in repaired:
                continue
            role_after, changed = _repair_gpu_sdk_type_redeclarations(repaired[role_path])
            if changed:
                repaired[role_path] = role_after
                changed_files.add(role_path)
        if changed_files:
            repair_rules.append("repair.gpu_sdk_type_redeclarations")

    if device_path and device_path in repaired:
        if any(
            rule.startswith(
                (
                    "source_device_identifier_",
                    "source_device_kernel_",
                )
            )
            for rule in input_reason_codes
        ):
            device_after, changed = _repair_source_device_semantics(
                repaired[device_path],
                source_files,
            )
            if changed:
                repaired[device_path] = device_after
                changed_files.add(device_path)
                repair_rules.append(
                    "repair.source_device_include_bridge"
                    if "Synthi source-device include bridge" in device_after
                    else "repair.source_device_semantics"
                )

        device_after, changed = _repair_device_constant_declarations(
            repaired[device_path],
            source_files,
        )
        if changed:
            repaired[device_path] = device_after
            changed_files.add(device_path)
            repair_rules.append("repair.source_device_constants")

    if core_path and core_path in repaired and "device_to_host_copy_not_launch_guarded" in input_reason_codes:
        core_after, changed = _repair_device_to_host_copy_guards(repaired[core_path])
        if changed:
            repaired[core_path] = core_after
            changed_files.add(core_path)
            repair_rules.append("repair.device_to_host_copy_guard")

    if gui_path and gui_path in repaired and any(
        rule in _GUI_RENDER_EFFECT_REASON_CODES for rule in input_reason_codes
    ):
        gui_after, changed = _repair_gui_render_effect(
            repaired[gui_path],
            source_files,
        )
        if changed:
            repaired[gui_path] = gui_after
            changed_files.add(gui_path)
            repair_rules.append("repair.gui_render_effect")

    if (
        host_runner_path
        and host_runner_path in repaired
        and "host_runner_omits_gui_module" in input_reason_codes
    ):
        host_after, changed = _repair_host_runner_gui_routing(repaired[host_runner_path])
        if changed:
            repaired[host_runner_path] = host_after
            changed_files.add(host_runner_path)
            repair_rules.append("repair.host_runner_gui_routing")

    if (
        core_path
        and device_path
        and core_path in repaired
        and device_path in repaired
    ):
        should_repair_init = any(
            rule in {"device_buffers_not_initialized", "device_init_kernel_incomplete"}
            for rule in input_reason_codes
        )
        if should_repair_init:
            device_lookup_source = _device_lookup_source_with_source_includes(
                repaired[device_path],
                source_files,
            )
            core_after, device_after, changed = _repair_init_kernel_buffers(
                core_source=repaired[core_path],
                device_source=repaired[device_path],
                lookup_device_source=device_lookup_source,
            )
            if changed:
                repaired[core_path] = core_after
                repaired[device_path] = device_after
                changed_files.update({core_path, device_path})
                repair_rules.append("repair.init_kernel_buffers")

        shared_source = repaired.get(shared_path or "", "")
        core_after, device_after, changed = _repair_launch_abi_mismatches(
            core_source=repaired[core_path],
            device_source=repaired[device_path],
            shared_source=shared_source,
        )
        if changed:
            repaired[core_path] = core_after
            repaired[device_path] = device_after
            changed_files.update({core_path, device_path})
            repair_rules.append("repair.launch_abi_mismatch")

    if (
        device_path
        and device_path in repaired
        and any(rule in _LAUNCH_UNRESOLVED_REPAIR_SCOPE for rule in input_reason_codes)
    ):
        unresolved_symbols = {
            str(violation.offending_symbol)
            for violation in (verification.violations if verification is not None else [])
            if violation.rule == "launch_site_unresolved" and violation.offending_symbol
        }
        host_launch_symbols = _host_launch_symbols(
            repaired,
            (core_path, gui_path, host_runner_path),
        )
        removable_symbols = _unresolved_generated_launch_symbols(
            unresolved_symbols=unresolved_symbols,
            host_launch_symbols=host_launch_symbols,
            device_source=repaired[device_path],
            source_files=source_files,
        )
        if removable_symbols:
            for host_path in (core_path, gui_path, host_runner_path):
                if not host_path or host_path not in repaired:
                    continue
                host_after, changed = _remove_unresolved_generated_launches(
                    repaired[host_path],
                    removable_symbols,
                )
                if changed:
                    repaired[host_path] = host_after
                    changed_files.add(host_path)
            if any(path in changed_files for path in (core_path, gui_path, host_runner_path) if path):
                repair_rules.append("repair.unresolved_generated_launches")

    return repaired, {
        "schemaVersion": REPAIR_SCHEMA_VERSION,
        "repaired": bool(repair_rules),
        "inputReasonCodes": input_reason_codes,
        "repairRules": repair_rules,
        "changedFiles": sorted(changed_files),
        "scope": "generated_artifacts_only",
    }


def _source_device_files(source_files: Mapping[str, str]) -> Dict[str, str]:
    files: Dict[str, str] = {}
    for path, source in source_files.items():
        normalized = path.replace("\\", "/")
        lower = normalized.lower()
        if not lower.endswith(_DEVICE_SOURCE_EXTENSIONS + _DEVICE_HEADER_EXTENSIONS):
            continue
        masked = mask_comments_for_parsing(source)
        if (
            "__global__" in masked
            or "__device__" in masked
            or "GLOBAL_KERNEL_SIGNATURE" in masked
            or "HIPRT_DEVICE" in masked
            or "HIPRT_HOST_DEVICE" in masked
        ):
            files[normalized] = source
    return files


def _device_lookup_source_with_source_includes(
    device_source: str,
    source_files: Mapping[str, str],
) -> str:
    source_device_sources = _verifier_source_device_files(source_files)
    included = _verifier_device_role_included_source_files(
        device_source,
        source_device_sources,
    )
    if not included:
        return device_source
    return "\n".join([device_source, *included.values()])


def _project_headers_by_role(
    verification: Optional[SplitVerificationResult],
) -> Dict[str, Set[str]]:
    headers_by_role: Dict[str, Set[str]] = {}
    if verification is None:
        return headers_by_role
    for violation in verification.violations:
        if violation.rule != "generated_role_includes_project_header":
            continue
        role_path = str(violation.offending_module or "").replace("\\", "/")
        header = str(violation.offending_symbol or "").replace("\\", "/")
        if not role_path or not header:
            continue
        headers_by_role.setdefault(role_path, set()).add(header)
    return headers_by_role


def _remove_generated_project_includes(
    source: str,
    headers: Set[str],
) -> tuple[str, bool]:
    normalized_headers = {header.replace("\\", "/").lstrip("./") for header in headers}

    def replacement(match: re.Match[str]) -> str:
        include_path = match.group("path").replace("\\", "/").lstrip("./")
        if include_path in normalized_headers:
            return ""
        return match.group(0)

    out = _INCLUDE_LINE_RE.sub(replacement, source)
    return out, out != source


def _resolve_quoted_include(
    include_path: str,
    *,
    including_path: str,
    source_files: Mapping[str, str],
) -> Optional[str]:
    include_path = include_path.strip().replace("\\", "/")
    if not include_path:
        return None
    including_dir = including_path.replace("\\", "/").rsplit("/", 1)[0]
    candidates = []
    if including_dir:
        candidates.append(f"{including_dir}/{include_path}")
    candidates.append(include_path)
    for candidate in candidates:
        parts: List[str] = []
        for part in candidate.replace("\\", "/").split("/"):
            if not part or part == ".":
                continue
            if part == "..":
                if parts:
                    parts.pop()
                continue
            parts.append(part)
        normalized = "/".join(parts)
        if normalized in source_files:
            return normalized

    basename = include_path.rsplit("/", 1)[-1]
    matches = [
        path.replace("\\", "/")
        for path in source_files
        if path.replace("\\", "/").rsplit("/", 1)[-1] == basename
    ]
    if len(matches) == 1:
        return matches[0]
    return None


def _source_device_reachable_files(source_files: Mapping[str, str]) -> Dict[str, str]:
    normalized = {path.replace("\\", "/"): source for path, source in source_files.items()}
    roots = sorted(_source_device_files(normalized))
    reachable: Dict[str, str] = {}
    queue = list(roots)
    while queue:
        path = queue.pop(0)
        if path in reachable:
            continue
        source = normalized.get(path)
        if source is None:
            continue
        reachable[path] = source
        masked_source = mask_comments_for_parsing(source)
        for match in _QUOTE_INCLUDE_RE.finditer(masked_source):
            resolved = _resolve_quoted_include(
                match.group("path"),
                including_path=path,
                source_files=normalized,
            )
            if resolved and resolved not in reachable:
                lower = resolved.lower()
                if lower.endswith(_DEVICE_SOURCE_EXTENSIONS + _DEVICE_HEADER_EXTENSIONS):
                    queue.append(resolved)
    return {path: reachable[path] for path in sorted(reachable)}


def _strip_project_includes(source: str) -> str:
    return _QUOTE_INCLUDE_RE.sub("", source)


def sanitize_generated_heal_output(
    *,
    module: str,
    source: str,
    errors: str,
) -> tuple[str, bool]:
    if module not in {"core", "gui", "shared", "host_runner"}:
        return source, False

    missing_includes = {
        match.group("path").replace("\\", "/").lstrip("./")
        for match in _MISSING_INCLUDE_ERROR_RE.finditer(errors or "")
    }
    undeclared_identifiers = {
        match.group("name")
        for match in _UNDECLARED_IDENTIFIER_ERROR_RE.finditer(errors or "")
    }
    if not missing_includes and not undeclared_identifiers:
        return source, False

    changed = False
    removed_include_stems: Set[str] = set()

    def include_replacement(match: re.Match[str]) -> str:
        nonlocal changed
        include_path = match.group("path").replace("\\", "/").lstrip("./")
        if include_path not in missing_includes:
            return match.group(0)
        changed = True
        stem = include_path.rsplit("/", 1)[-1].rsplit(".", 1)[0]
        removed_include_stems.add(_normalize_symbol_fragment(stem))
        return ""

    out = _INCLUDE_LINE_RE.sub(include_replacement, source)
    removal_names = set(undeclared_identifiers)
    if removed_include_stems:
        for namespace in re.findall(r"\b([A-Za-z_][A-Za-z0-9_]*)\s*::", out):
            if _normalize_symbol_fragment(namespace) in removed_include_stems:
                removal_names.add(namespace)

    for name in sorted(removal_names, key=len, reverse=True):
        statement_re = re.compile(
            rf"(?m)^[ \t]*(?:{re.escape(name)}\s*::[^\n;{{}}]*|{re.escape(name)}\s*\([^\n;{{}}]*\))[ \t]*;[ \t]*(?:\r?\n)?"
        )
        out_after = statement_re.sub("", out)
        if out_after != out:
            changed = True
            out = out_after
    return out, changed


def _normalize_symbol_fragment(value: str) -> str:
    return re.sub(r"[^a-z0-9]", "", value.lower())


def _repair_gpu_sdk_type_redeclarations(source: str) -> tuple[str, bool]:
    out = source
    changed = False
    while True:
        match = _GPU_SDK_VECTOR_STRUCT_RE.search(mask_comments_for_parsing(out))
        if not match:
            break
        open_brace = out.find("{", match.end() - 1)
        if open_brace < 0:
            break
        close_brace = _matching_brace(out, open_brace)
        if close_brace is None:
            break
        end = close_brace + 1
        while end < len(out) and out[end].isspace():
            end += 1
        if end < len(out) and out[end] == ";":
            end += 1
        start = match.start()
        while start > 0 and out[start - 1] in " \t":
            start -= 1
        if start > 0 and out[start - 1] == "\n":
            start -= 1
        out = out[:start] + out[end:]
        changed = True
    return out, changed


def _generated_validation_host_runner() -> str:
    return r'''#include <chrono>
#include <cstdio>
#include <dlfcn.h>
#include <thread>

using SynthiCoreLoadFn = void* (*)(void*, void*);
using SynthiCoreUpdateFn = void (*)(void*, double);
using SynthiGuiLoadFn = void* (*)(void*, void*, void*);
using SynthiGuiRenderFn = void (*)(void*);

static void* synthi_hmr_open_library(const char* path) {
    void* handle = dlopen(path, RTLD_NOW | RTLD_LOCAL);
    if (!handle) {
        std::fprintf(stderr, "[host_runner] dlopen failed for %s: %s\n", path, dlerror());
    }
    return handle;
}

template <typename Fn>
static Fn synthi_hmr_symbol(void* handle, const char* name) {
    return handle ? reinterpret_cast<Fn>(dlsym(handle, name)) : nullptr;
}

int main() {
    void* libcore = synthi_hmr_open_library("./libcore.so");
    void* libgui = synthi_hmr_open_library("./libgui.so");
    auto core_load = reinterpret_cast<SynthiCoreLoadFn>(dlsym(libcore, "core_on_load"));
    auto core_update = reinterpret_cast<SynthiCoreUpdateFn>(dlsym(libcore, "core_on_update"));
    auto gui_load = reinterpret_cast<SynthiGuiLoadFn>(dlsym(libgui, "gui_on_load"));
    auto gui_render = reinterpret_cast<SynthiGuiRenderFn>(dlsym(libgui, "gui_on_render"));
    if (!core_load || !core_update || !gui_render) {
        std::fprintf(stderr, "[host_runner] generated modules are missing required entrypoints\n");
        return 2;
    }
    void* core_state = core_load(nullptr, nullptr);
    if (gui_load) {
        (void)gui_load(core_state, nullptr, nullptr);
    }
    for (;;) {
        core_update(core_state, 0.016);
        gui_render(core_state);
        std::this_thread::sleep_for(std::chrono::milliseconds(16));
    }
    return 0;
}
'''


def _repair_host_runner_gui_routing(host_runner_source: str) -> tuple[str, bool]:
    if _host_runner_routes_gui_module(host_runner_source):
        return host_runner_source, False

    code = mask_comments_for_parsing(host_runner_source)
    render_match = re.search(
        r"\b(?P<var>[A-Za-z_][A-Za-z0-9_]*)\s*=\s*(?:reinterpret_cast\s*<[^>]+>\s*\(\s*)?"
        r"(?:dlsym|GetProcAddress)\s*\([^;]*[\"']gui_on_render[\"'][^;]*;",
        code,
        re.DOTALL,
    )
    if render_match:
        render_var = render_match.group("var")
        state_var = _host_runner_core_state_variable(code)
        if state_var:
            insertion = f"\n        if ({render_var}) {{ {render_var}({state_var}); }}\n"
            present_match = re.search(
                r"\b(?:SDL_RenderPresent|SDL_GL_SwapWindow|glfwSwapBuffers|glutSwapBuffers|SwapBuffers)\s*\(",
                code,
            )
            if present_match:
                out = host_runner_source[: present_match.start()] + insertion + host_runner_source[present_match.start() :]
                if _host_runner_routes_gui_module(out):
                    return out, True

            update_call = list(
                re.finditer(
                    r"\b(?P<callee>[A-Za-z_][A-Za-z0-9_]*update[A-Za-z0-9_]*)\s*\([^;]*\b"
                    + re.escape(state_var)
                    + r"\b[^;]*\)\s*;",
                    code,
                    re.IGNORECASE | re.DOTALL,
                )
            )
            if update_call:
                insert_at = update_call[-1].end()
                out = host_runner_source[:insert_at] + insertion + host_runner_source[insert_at:]
                if _host_runner_routes_gui_module(out):
                    return out, True

    fallback = _generated_validation_host_runner()
    return fallback, fallback != host_runner_source


def _host_runner_core_state_variable(host_runner_source: str) -> Optional[str]:
    for pattern in (
        r"\bvoid\s*\*\s*(?P<name>[A-Za-z_][A-Za-z0-9_]*)\s*=\s*[^;]*\b[A-Za-z_][A-Za-z0-9_]*load\s*\(",
        r"\bauto\s*\*?\s*(?P<name>[A-Za-z_][A-Za-z0-9_]*)\s*=\s*[^;]*\b[A-Za-z_][A-Za-z0-9_]*load\s*\(",
    ):
        match = re.search(pattern, host_runner_source, re.DOTALL)
        if match:
            return match.group("name")
    if re.search(r"\bcore_state\b", host_runner_source):
        return "core_state"
    return None


def _function_body_span(source: str, name: str) -> Optional[Tuple[int, int]]:
    for match in re.finditer(rf"\b{re.escape(name)}\s*\([^)]*\)\s*\{{", source):
        open_brace = source.find("{", match.end() - 1)
        if open_brace < 0:
            continue
        close_brace = _matching_brace(source, open_brace)
        if close_brace is not None:
            return open_brace + 1, close_brace
    return None


def _ensure_opengl_include(source: str) -> str:
    if _OPENGL_INCLUDE_RE.search(source):
        return source
    include_matches = list(re.finditer(r"(?m)^#\s*include\s+[<\"].*[>\"]\s*$", source))
    if include_matches:
        insert_at = include_matches[-1].end()
        return source[:insert_at] + "\n#include <GL/gl.h>" + source[insert_at:]
    return "#include <GL/gl.h>\n" + source


def _opengl_visible_render_body() -> str:
    return """
    GLint synthi_hmr_viewport[4] = {0, 0, 800, 600};
    glGetIntegerv(GL_VIEWPORT, synthi_hmr_viewport);
    const int synthi_hmr_width = synthi_hmr_viewport[2] > 0 ? synthi_hmr_viewport[2] : 800;
    const int synthi_hmr_height = synthi_hmr_viewport[3] > 0 ? synthi_hmr_viewport[3] : 600;
    glViewport(0, 0, synthi_hmr_width, synthi_hmr_height);
    glClearColor(0.03f, 0.04f, 0.07f, 1.0f);
    glClear(GL_COLOR_BUFFER_BIT | GL_DEPTH_BUFFER_BIT);
    glMatrixMode(GL_PROJECTION);
    glLoadIdentity();
    glOrtho(0.0, static_cast<double>(synthi_hmr_width), static_cast<double>(synthi_hmr_height), 0.0, -1.0, 1.0);
    glMatrixMode(GL_MODELVIEW);
    glLoadIdentity();
    const float synthi_hmr_x0 = synthi_hmr_width * 0.18f;
    const float synthi_hmr_y0 = synthi_hmr_height * 0.20f;
    const float synthi_hmr_x1 = synthi_hmr_width * 0.82f;
    const float synthi_hmr_y1 = synthi_hmr_height * 0.78f;
    glBegin(GL_QUADS);
    glColor3f(0.14f, 0.58f, 1.0f);
    glVertex2f(synthi_hmr_x0, synthi_hmr_y0);
    glColor3f(0.74f, 0.90f, 1.0f);
    glVertex2f(synthi_hmr_x1, synthi_hmr_y0);
    glColor3f(1.0f, 0.54f, 0.18f);
    glVertex2f(synthi_hmr_x1, synthi_hmr_y1);
    glColor3f(0.20f, 0.95f, 0.46f);
    glVertex2f(synthi_hmr_x0, synthi_hmr_y1);
    glEnd();
"""


def _repair_gui_render_effect(
    gui_source: str,
    source_files: Mapping[str, str],
) -> tuple[str, bool]:
    span = _function_body_span(gui_source, "gui_on_render")
    if span is None:
        return gui_source, False
    body = gui_source[span[0] : span[1]]
    if _GUI_RENDER_EFFECT_RE.search(_strip_cpp_comments(body)):
        return gui_source, False

    source_blob = "\n".join(str(source) for source in source_files.values())
    backends = _render_backends_in_sources(source_files.values())
    if not (
        {"glfw", "glut"} & backends
        or _SOURCE_OPENGL_MARKER_RE.search(source_blob)
        or _SOURCE_OPENGL_MARKER_RE.search(gui_source)
    ):
        return gui_source, False

    out = _ensure_opengl_include(gui_source)
    span_after_include = _function_body_span(out, "gui_on_render")
    if span_after_include is None:
        return gui_source, False
    replacement = _opengl_visible_render_body()
    out = out[: span_after_include[0]] + replacement + out[span_after_include[1] :]
    return out, out != gui_source


def _strip_single_namespace_wrapper(source: str) -> str:
    text = re.sub(r"(?m)^\s*#\s*pragma\s+once\s*$", "", source).strip()
    match = re.search(r"\bnamespace\s+[A-Za-z_][A-Za-z0-9_]*\s*\{", text)
    if not match:
        return text
    prefix = text[: match.start()].strip()
    if prefix:
        return text
    close = _matching_brace(text, match.end() - 1)
    if close is None:
        return text
    suffix = text[close + 1 :].strip()
    if suffix:
        return text
    return text[match.end() : close].strip()


def _inlineable_device_source(source: str) -> str:
    return _strip_single_namespace_wrapper(_strip_project_includes(source))


def _kernel_function_span(source: str, kernel: str) -> Optional[Tuple[int, int]]:
    masked = mask_comments_for_parsing(source)
    for match in _ANY_GLOBAL_KERNEL_RE.finditer(masked):
        if match.group("name") != kernel:
            continue
        open_brace = source.find("{", match.end())
        if open_brace < 0:
            return None
        close_brace = _matching_brace(source, open_brace)
        if close_brace is None:
            return None
        return match.start(), close_brace + 1
    return None


def _source_device_support_preamble(reachable: Mapping[str, str]) -> str:
    parts: List[str] = []
    seen: Set[str] = set()
    for path, source in sorted(reachable.items()):
        inline_source = _inlineable_device_source(source)
        if path.lower().endswith(_DEVICE_SOURCE_EXTENSIONS):
            first_kernel = _ANY_GLOBAL_KERNEL_RE.search(mask_comments_for_parsing(inline_source))
            if first_kernel:
                inline_source = inline_source[: first_kernel.start()]
        inline_source = inline_source.strip()
        if not inline_source or inline_source in seen:
            continue
        seen.add(inline_source)
        parts.append(f"// Inlined from {path}\n{inline_source}")
    return "\n\n".join(parts).strip()


def _kernelcc_condition_mode(line: str) -> Optional[bool]:
    if re.match(r"^\s*#\s*ifndef\s+__KERNELCC__\b", line):
        return True
    if re.match(r"^\s*#\s*if\s+!\s*defined\s*\(\s*__KERNELCC__\s*\)", line):
        return True
    if re.match(r"^\s*#\s*ifdef\s+__KERNELCC__\b", line):
        return False
    if re.match(r"^\s*#\s*if\s+defined\s*\(\s*__KERNELCC__\s*\)", line):
        return False
    return None


def _source_device_cpu_only_macro_defaults(reachable: Mapping[str, str]) -> List[Tuple[str, str]]:
    defaults: Dict[str, str] = {}
    order: List[str] = []
    for _path, source in sorted(reachable.items()):
        stack: List[Optional[bool]] = []
        for raw_line in mask_comments_for_parsing(source).splitlines():
            stripped = raw_line.strip()
            if re.match(r"^\s*#\s*if(?:def|ndef)?\b", stripped):
                stack.append(_kernelcc_condition_mode(stripped))
                continue
            if re.match(r"^\s*#\s*elif\b", stripped):
                if stack:
                    stack[-1] = _kernelcc_condition_mode(stripped)
                continue
            if re.match(r"^\s*#\s*else\b", stripped):
                if stack and stack[-1] is not None:
                    stack[-1] = not stack[-1]
                continue
            if re.match(r"^\s*#\s*endif\b", stripped):
                if stack:
                    stack.pop()
                continue

            in_cpu_only_section = any(frame is True for frame in stack) and not any(
                frame is False for frame in stack
            )
            if not in_cpu_only_section:
                continue
            match = _OBJECT_DEFINE_RE.match(raw_line)
            if not match:
                continue
            name = match.group("name")
            if name.startswith("__") or name in _RESERVED_DEFAULT_MACRO_NAMES:
                continue
            value = match.group("value").strip() or "1"
            if name not in defaults:
                order.append(name)
            defaults[name] = value
    return [(name, defaults[name]) for name in order]


def _source_device_defined_macros(reachable: Mapping[str, str]) -> Set[str]:
    defined: Set[str] = set()
    for source in reachable.values():
        for raw_line in mask_comments_for_parsing(source).splitlines():
            match = _DEFINE_NAME_RE.match(raw_line)
            if match:
                defined.add(match.group("name"))
    return defined


def _source_device_option_macro_defaults(
    reachable: Mapping[str, str],
    existing_names: Set[str],
) -> List[Tuple[str, str]]:
    defined = _source_device_defined_macros(reachable)
    ignored = {
        "defined",
        "KERNEL_OPTION_TRUE",
        "KERNEL_OPTION_FALSE",
        "__KERNELCC__",
        "__HIPCC__",
        "__HIP_DEVICE_COMPILE__",
        "__CUDACC__",
        "__CUDA_ARCH__",
    }
    defaults: Dict[str, str] = {}
    order: List[str] = []
    for _path, source in sorted(reachable.items()):
        for raw_line in mask_comments_for_parsing(source).splitlines():
            match = _KERNEL_OPTION_CONDITION_RE.match(raw_line)
            if not match:
                continue
            expr = match.group("expr")
            if "KERNEL_OPTION_TRUE" not in expr and "KERNEL_OPTION_FALSE" not in expr:
                continue
            for token in _IDENTIFIER_RE.findall(expr):
                if (
                    token.startswith("__")
                    or token in ignored
                    or token in _RESERVED_DEFAULT_MACRO_NAMES
                    or token in defined
                    or token in existing_names
                ):
                    continue
                if token not in defaults:
                    order.append(token)
                defaults[token] = "KERNEL_OPTION_FALSE"
    return [(name, defaults[name]) for name in order]


def _source_device_default_macro_block(reachable: Mapping[str, str]) -> str:
    defaults = _source_device_cpu_only_macro_defaults(reachable)
    existing_names = {name for name, _value in defaults}
    defaults.extend(_source_device_option_macro_defaults(reachable, existing_names))
    if not defaults:
        return ""
    lines = ["// Synthi source-derived device macro defaults"]
    for name, value in defaults:
        lines.extend(
            [
                f"#ifndef {name}",
                f"#define {name} {value}".rstrip(),
                "#endif",
            ]
        )
    return "\n".join(lines)


def _source_device_compiler_prelude_includes(
    reachable: Mapping[str, str],
    source_files: Mapping[str, str],
) -> List[str]:
    source_blob = "\n".join(mask_comments_for_parsing(source) for source in reachable.values())
    include_names = {match.group("path").replace("\\", "/") for match in _ANY_INCLUDE_RE.finditer(source_blob)}
    normalized_paths = {path.replace("\\", "/") for path in source_files}
    namespaces = {
        include.lstrip("./").split("/", 1)[0]
        for include in include_names
        if include.lstrip("./").split("/", 1)[0]
    }

    prelude: List[str] = []
    prelude_includes: List[str] = []
    for source in source_files.values():
        for match in _ANY_INCLUDE_RE.finditer(mask_comments_for_parsing(source)):
            include_path = match.group("path").replace("\\", "/").lstrip("./")
            basename = include_path.rsplit("/", 1)[-1].lower()
            namespace = include_path.split("/", 1)[0]
            if "device_impl" in basename and namespace in namespaces:
                prelude_includes.append(include_path)

    for path in normalized_paths:
        basename = path.rsplit("/", 1)[-1].lower()
        if "device_impl" not in basename:
            continue
        for namespace in namespaces:
            marker = f"{namespace}/"
            marker_index = path.find(marker)
            if marker_index >= 0:
                prelude_includes.append(path[marker_index:])

    for include_path in sorted(dict.fromkeys(prelude_includes)):
        prelude.append(f"#include <{include_path}>")
    return prelude


def _resolve_source_path_for_include(
    include_path: str,
    source_files: Mapping[str, str],
) -> Optional[str]:
    normalized_sources = {path.replace("\\", "/"): source for path, source in source_files.items()}
    normalized = include_path.replace("\\", "/").lstrip("./")
    if normalized in normalized_sources:
        return normalized
    matches = [
        path
        for path in normalized_sources
        if path.endswith("/" + normalized)
        or (path.startswith("src/") and path[4:] == normalized)
    ]
    if len(matches) == 1:
        return matches[0]
    basename = normalized.rsplit("/", 1)[-1]
    basename_matches = [
        path
        for path in normalized_sources
        if path.rsplit("/", 1)[-1] == basename
    ]
    if len(basename_matches) == 1:
        return basename_matches[0]
    return None


def _source_device_function_names(
    source: str,
    *,
    terminator: Optional[str] = None,
) -> Set[str]:
    names: Set[str] = set()
    for match in _SOURCE_DEVICE_FUNCTION_RE.finditer(mask_comments_for_parsing(source)):
        if terminator is not None and match.group("terminator") != terminator:
            continue
        name = match.group("name")
        if name in _CPP_DECL_KEYWORDS or name in {"operator", "new", "delete"}:
            continue
        names.add(name)
    return names


def _source_device_prelude_definition_headers(
    reachable: Mapping[str, str],
    source_files: Mapping[str, str],
    prelude_include_paths: Sequence[str],
    kernel_headers: Sequence[str],
) -> List[str]:
    normalized_source_files = {
        path.replace("\\", "/"): source for path, source in source_files.items()
    }
    prelude_declarations: Set[str] = set()
    for include_path in prelude_include_paths:
        resolved = _resolve_source_path_for_include(include_path, source_files)
        if resolved is None:
            continue
        source = normalized_source_files.get(resolved)
        if source:
            prelude_declarations.update(_source_device_function_names(source, terminator=";"))

    if not prelude_declarations:
        return []

    kernel_header_set = set(kernel_headers)
    headers: List[str] = []
    for path, source in sorted(reachable.items()):
        if path in kernel_header_set or not path.lower().endswith(_DEVICE_HEADER_EXTENSIONS):
            continue
        definitions = _source_device_function_names(source, terminator="{")
        if definitions & prelude_declarations:
            headers.append(path)
    return headers


def _source_device_transitive_include_paths(
    root_paths: Sequence[str],
    source_files: Mapping[str, str],
) -> Set[str]:
    normalized_source_files = {
        path.replace("\\", "/"): source for path, source in source_files.items()
    }
    included: Set[str] = set()
    visited: Set[str] = set()
    queue = [path.replace("\\", "/") for path in root_paths]
    while queue and len(visited) < 160:
        path = queue.pop(0)
        if path in visited:
            continue
        visited.add(path)
        source = normalized_source_files.get(path)
        if source is None:
            continue
        for match in _ANY_INCLUDE_RE.finditer(mask_comments_for_parsing(source)):
            include_path = match.group("path").replace("\\", "/").lstrip("./")
            if not include_path:
                continue
            included.add(include_path)
            resolved = _resolve_source_path_for_include(include_path, normalized_source_files)
            if resolved is not None:
                included.add(resolved)
                if resolved not in visited:
                    queue.append(resolved)
    return included


def _source_device_include_bridge(
    reachable: Mapping[str, str],
    source_files: Mapping[str, str],
) -> Optional[str]:
    kernel_headers = [
        path
        for path, source in sorted(reachable.items())
        if path.lower().endswith(_DEVICE_HEADER_EXTENSIONS)
        and _ANY_GLOBAL_KERNEL_RE.search(mask_comments_for_parsing(source))
    ]
    if not kernel_headers:
        return None

    prelude_include_lines = _source_device_compiler_prelude_includes(reachable, source_files)
    prelude_include_paths = [
        match.group("path")
        for line in prelude_include_lines
        if (match := _ANY_INCLUDE_RE.search(line))
    ]
    definition_headers = _source_device_prelude_definition_headers(
        reachable,
        source_files,
        prelude_include_paths,
        kernel_headers,
    )
    definition_include_paths = _source_device_transitive_include_paths(
        definition_headers,
        source_files,
    )
    filtered_prelude_include_lines: List[str] = []
    for line, include_path in zip(prelude_include_lines, prelude_include_paths):
        resolved = _resolve_source_path_for_include(include_path, source_files)
        if include_path in definition_include_paths or (
            resolved is not None and resolved in definition_include_paths
        ):
            continue
        filtered_prelude_include_lines.append(line)
    include_paths = list(dict.fromkeys([*definition_headers, *kernel_headers]))
    includes = "\n".join(f'#include "{path}"' for path in include_paths)
    prelude_includes = "\n".join(filtered_prelude_include_lines)
    if prelude_includes:
        prelude_includes += "\n"
    default_macro_block = _source_device_default_macro_block(reachable)
    if default_macro_block:
        default_macro_block += "\n\n"
    return (
        "// Synthi source-device include bridge\n"
        "#if defined(__HIPCC__) || defined(__HIP_DEVICE_COMPILE__)\n"
        "#include <hip/hip_runtime.h>\n"
        "#elif defined(__CUDACC__) || defined(__CUDA_ARCH__)\n"
        "#include <cuda_runtime.h>\n"
        "#endif\n"
        f"{prelude_includes}"
        '#include "synthi_gpu_runtime.h"\n'
        "#ifndef __KERNELCC__\n"
        "#define __KERNELCC__ 1\n"
        "#endif\n\n"
        f"{default_macro_block}"
        f"{includes}\n"
    )


def _repair_source_device_semantics(
    device_source: str,
    source_files: Mapping[str, str],
) -> tuple[str, bool]:
    reachable = _source_device_reachable_files(source_files)
    if not reachable:
        return device_source, False

    bridge = _source_device_include_bridge(reachable, source_files)
    if bridge is not None:
        return bridge, bridge != device_source

    out = device_source
    preamble = _source_device_support_preamble(reachable)
    marker = "// Synthi source-device preservation preamble"
    if preamble and marker not in out:
        include_matches = list(re.finditer(r"(?m)^#\s*include\s+[<\"].*[>\"]\s*$", out))
        insert_at = include_matches[-1].end() if include_matches else 0
        out = out[:insert_at] + f"\n\n{marker}\n{preamble}\n" + out[insert_at:]

    for path, source in sorted(reachable.items()):
        if not path.lower().endswith(_DEVICE_SOURCE_EXTENSIONS):
            continue
        inline_source = _inlineable_device_source(source)
        for match in list(_GLOBAL_KERNEL_SIGNATURE_RE.finditer(inline_source)):
            kernel = match.group("name")
            source_span = _kernel_function_span(inline_source, kernel)
            if source_span is None:
                continue
            source_function = inline_source[source_span[0] : source_span[1]].strip()
            generated_span = _kernel_function_span(out, kernel)
            if generated_span is None:
                out = out.rstrip() + "\n\n" + source_function + "\n"
            else:
                out = out[: generated_span[0]] + source_function + out[generated_span[1] :]
    return out, out != device_source


def _source_device_kernel_names(source_files: Mapping[str, str]) -> Set[str]:
    names: Set[str] = set()
    for source in _source_device_reachable_files(source_files).values():
        for match in _ANY_GLOBAL_KERNEL_RE.finditer(mask_comments_for_parsing(source)):
            names.add(match.group("name"))
    return names


def _source_constant_declarations(source_files: Mapping[str, str]) -> Dict[str, str]:
    declarations: Dict[str, str] = {}
    for _path, source in sorted(_source_device_reachable_files(source_files).items()):
        for match in _SOURCE_DEVICE_CONST_DECL_RE.finditer(source):
            declaration = re.sub(r"\s+", " ", match.group("decl").strip())
            if "=" not in declaration:
                continue
            declarations.setdefault(match.group("name"), declaration)
    return declarations


def _repair_device_constant_declarations(
    device_source: str,
    source_files: Mapping[str, str],
) -> tuple[str, bool]:
    if "Synthi source-device include bridge" in device_source:
        return device_source, False

    declarations = _source_constant_declarations(source_files)
    if not declarations:
        return device_source, False

    changed = False
    out = device_source
    for name, declaration in sorted(declarations.items()):
        correct_decl = declaration if declaration.endswith(";") else f"{declaration};"
        exact_pattern = re.compile(
            rf"(?m)^\s*{re.escape(correct_decl)}\s*$"
        )
        if exact_pattern.search(out):
            continue

        existing_pattern = re.compile(
            _SCALAR_CONST_DECL_TEMPLATE.format(name=re.escape(name))
        )
        if existing_pattern.search(out):
            out = existing_pattern.sub(correct_decl, out, count=1)
        else:
            out = _insert_declaration_before_first_kernel(out, correct_decl)
        changed = True
    return out, changed


def _insert_declaration_before_first_kernel(source: str, declaration: str) -> str:
    match = _GLOBAL_KERNEL_SIGNATURE_RE.search(source)
    if match:
        return source[: match.start()] + declaration + "\n" + source[match.start():]

    include_matches = list(re.finditer(r"(?m)^#\s*include\s+[<\"].*[>\"]\s*$", source))
    if include_matches:
        insert_at = include_matches[-1].end()
        return source[:insert_at] + "\n" + declaration + source[insert_at:]
    return declaration + "\n" + source


def _iter_launch_spans(source: str) -> Iterable[Tuple[int, int, str]]:
    needle = "synthi_gpu_launch("
    cursor = 0
    while True:
        start = source.find(needle, cursor)
        if start < 0:
            return
        i = start + len(needle)
        depth = 1
        while i < len(source) and depth:
            if source[i] == "(":
                depth += 1
            elif source[i] == ")":
                depth -= 1
            i += 1
        if depth != 0:
            return
        yield start, i, source[start + len(needle) : i - 1]
        cursor = i


def _statement_end(source: str, call_end: int) -> Optional[int]:
    index = call_end
    while index < len(source) and source[index].isspace():
        index += 1
    if index < len(source) and source[index] == ";":
        return index + 1
    return None


def _iter_call_statement_spans(source: str, name: str) -> Iterable[Tuple[int, int, str]]:
    needle = f"{name}("
    cursor = 0
    while True:
        start = source.find(needle, cursor)
        if start < 0:
            return
        i = start + len(needle)
        depth = 1
        while i < len(source) and depth:
            if source[i] == "(":
                depth += 1
            elif source[i] == ")":
                depth -= 1
            i += 1
        if depth != 0:
            return
        end = _statement_end(source, i)
        if end is not None:
            yield start, end, source[start:end]
        cursor = i


def _repair_device_to_host_copy_guards(core_source: str) -> tuple[str, bool]:
    if "synthi_gpu_launch(" not in core_source or not _DEVICE_TO_HOST_COPY_MARKER_RE.search(core_source):
        return core_source, False
    if re.search(
        r"(?:\bif\s*\(\s*synthi_gpu_launch\s*\(|\b(?:const\s+)?(?:bool|auto)(?:\s+const)?\s+[A-Za-z_][A-Za-z0-9_]*\s*=\s*synthi_gpu_launch\s*\()",
        core_source,
        re.DOTALL,
    ):
        return core_source, False

    launch_statements: List[Tuple[int, int, str]] = []
    for start, call_end, _body in _iter_launch_spans(core_source):
        statement_end = _statement_end(core_source, call_end)
        if statement_end is not None:
            launch_statements.append((start, statement_end, core_source[start:statement_end]))
    if not launch_statements:
        return core_source, False

    copy_statements: List[Tuple[int, int, str]] = []
    for name in ("cudaMemcpy", "hipMemcpy"):
        for start, end, statement in _iter_call_statement_spans(core_source, name):
            if _DEVICE_TO_HOST_COPY_MARKER_RE.search(statement):
                copy_statements.append((start, end, statement))
    if not copy_statements:
        return core_source, False

    launch_vars: Dict[int, str] = {}
    replacements: Dict[Tuple[int, int], str] = {}
    for copy_start, copy_end, copy_statement in sorted(copy_statements):
        prior_launches = [
            (index, launch_start, launch_end, launch_statement)
            for index, (launch_start, launch_end, launch_statement) in enumerate(launch_statements)
            if launch_end <= copy_start
        ]
        if not prior_launches:
            continue
        launch_index, launch_start, launch_end, launch_statement = prior_launches[-1]
        launch_var = launch_vars.setdefault(
            launch_index,
            f"synthi_hmr_launch_ok_{launch_index + 1}",
        )
        replacements[(launch_start, launch_end)] = f"bool {launch_var} = {launch_statement}"
        replacements[(copy_start, copy_end)] = f"if ({launch_var}) {{ {copy_statement} }}"

    if not replacements:
        return core_source, False

    out = core_source
    for (start, end), replacement in sorted(replacements.items(), reverse=True):
        out = out[:start] + replacement + out[end:]
    return out, out != core_source


def _kernel_params(device_source: str, kernel: str) -> List[_ParamInfo]:
    for match in _GLOBAL_KERNEL_SIGNATURE_RE.finditer(device_source):
        if match.group("name") != kernel:
            continue
        params = []
        for raw in _split_top_level_args(match.group("params")):
            raw = raw.strip()
            if not raw or raw == "void":
                continue
            tokens = re.findall(r"[A-Za-z_][A-Za-z0-9_]*", raw)
            name = tokens[-1] if tokens else f"arg{len(params)}"
            type_text = raw.rsplit(name, 1)[0].strip() if name in raw else raw
            params.append(
                _ParamInfo(
                    declaration=raw,
                    type_text=type_text,
                    name=name,
                    is_pointer="*" in raw,
                )
            )
        return params
    return []


def _collect_launches(core_source: str, device_source: str) -> List[_LaunchInfo]:
    launches: List[_LaunchInfo] = []
    for start, end, body in _iter_launch_spans(core_source):
        args = _split_top_level_args(body)
        if len(args) != 7:
            continue
        kernel = _launch_kernel_name(args[1])
        if not kernel:
            continue
        launch_args = _launch_initializer_args(args[-1])
        if not launch_args:
            continue
        params = _kernel_params(device_source, kernel)
        pointer_buffers: Dict[str, Tuple[str, _ParamInfo]] = {}
        for index, param in enumerate(params):
            if not param.is_pointer or index >= len(launch_args):
                continue
            launch_arg = launch_args[index].strip()
            pointer_buffers[_normalize_launch_buffer_arg(launch_arg)] = (
                launch_arg,
                param,
            )
        launches.append(
            _LaunchInfo(
                start=start,
                end=end,
                body=body,
                args=args,
                kernel=kernel,
                launch_args=launch_args,
                pointer_buffers=pointer_buffers,
                is_init=bool(re.search(r"(?:init|seed|setup|reset)", kernel, re.I)),
            )
        )
    return launches


def _device_declared_kernel_names(device_source: str) -> Set[str]:
    return {
        match.group("name")
        for match in _ANY_GLOBAL_KERNEL_RE.finditer(mask_comments_for_parsing(device_source))
    }


def _effective_device_kernel_names(
    device_source: str,
    source_files: Mapping[str, str],
) -> Set[str]:
    names = _device_declared_kernel_names(device_source)
    normalized_sources = {
        path.replace("\\", "/"): source
        for path, source in source_files.items()
    }
    masked = mask_comments_for_parsing(device_source)
    for match in _QUOTE_INCLUDE_RE.finditer(masked):
        resolved = _resolve_quoted_include(
            match.group("path"),
            including_path="device.hip",
            source_files=normalized_sources,
        )
        if not resolved:
            continue
        for kernel_match in _ANY_GLOBAL_KERNEL_RE.finditer(
            mask_comments_for_parsing(normalized_sources[resolved])
        ):
            names.add(kernel_match.group("name"))
    return names


def _host_launch_symbols(
    files: Mapping[str, str],
    host_paths: Sequence[Optional[str]],
) -> Set[str]:
    symbols: Set[str] = set()
    for path in host_paths:
        if not path or path not in files:
            continue
        for _start, _end, body in _iter_launch_spans(files[path]):
            args = _split_top_level_args(body)
            if len(args) != 7:
                continue
            kernel = _launch_kernel_name(args[1])
            if kernel:
                symbols.add(kernel)
    return symbols


def _unresolved_generated_launch_symbols(
    *,
    unresolved_symbols: Set[str],
    host_launch_symbols: Set[str],
    device_source: str,
    source_files: Mapping[str, str],
) -> Set[str]:
    if not _source_device_files(source_files):
        return set()
    candidates = set(unresolved_symbols) if unresolved_symbols else set(host_launch_symbols)
    if not candidates:
        return set()
    declared = _effective_device_kernel_names(device_source, source_files)
    return {
        symbol
        for symbol in candidates
        if symbol not in declared
    }


def _remove_unresolved_generated_launches(
    host_source: str,
    unresolved_symbols: Set[str],
) -> tuple[str, bool]:
    if not unresolved_symbols or "synthi_gpu_launch(" not in host_source:
        return host_source, False

    replacements: Dict[Tuple[int, int], str] = {}
    for start, end, body in _iter_launch_spans(host_source):
        args = _split_top_level_args(body)
        if len(args) != 7:
            continue
        kernel = _launch_kernel_name(args[1])
        if kernel not in unresolved_symbols:
            continue
        statement_start = _statement_start(host_source, start)
        statement_end = _statement_end(host_source, end)
        prefix = host_source[statement_start:start]
        if statement_end is not None:
            assignment = re.match(
                r"(?P<indent>[ \t]*)(?:(?:const\s+)?(?P<type>bool|auto)(?:\s+const)?\s+)"
                r"(?P<name>[A-Za-z_][A-Za-z0-9_]*)\s*=\s*$",
                prefix,
                re.DOTALL,
            )
            if assignment:
                indent = assignment.group("indent") or ""
                name = assignment.group("name")
                replacements[(statement_start, statement_end)] = f"{indent}bool {name} = false;"
            elif prefix.strip():
                replacements[(start, end)] = "false"
            else:
                replacements[(statement_start, statement_end)] = ""
        else:
            replacements[(start, end)] = "false"

    if not replacements:
        return host_source, False

    out = host_source
    for (start, end), replacement in sorted(replacements.items(), reverse=True):
        out = out[:start] + replacement + out[end:]
    return out, out != host_source


def _repair_init_kernel_buffers(
    *,
    core_source: str,
    device_source: str,
    lookup_device_source: Optional[str] = None,
) -> tuple[str, str, bool]:
    lookup_source = lookup_device_source or device_source
    launches = _collect_launches(core_source, lookup_source)
    update_launches = [launch for launch in launches if not launch.is_init]
    if not update_launches:
        return core_source, device_source, False

    required: Dict[str, Tuple[str, _ParamInfo]] = {}
    required_order: List[Tuple[str, str, _ParamInfo]] = []
    for launch in update_launches:
        for buffer, info in launch.pointer_buffers.items():
            if buffer not in required:
                required_order.append((buffer, info[0], info[1]))
            required[buffer] = info

    init_launches = [launch for launch in launches if launch.is_init]
    if not init_launches:
        return _insert_synthi_init_kernel(
            core_source=core_source,
            device_source=device_source,
            lookup_device_source=lookup_source,
            update_launch=update_launches[0],
            required_order=required_order,
        )

    initialized: Set[str] = set()
    for launch in init_launches:
        initialized.update(launch.pointer_buffers)

    missing = [buffer for buffer in sorted(required) if buffer not in initialized]
    if not missing:
        return core_source, device_source, False

    init_launch = init_launches[0]
    additions = [
        (buffer, launch_arg, param)
        for buffer, launch_arg, param in required_order
        if buffer in missing
    ]
    init_params_before = _kernel_params(lookup_source, init_launch.kernel)
    core_after = _append_init_launch_args(
        core_source,
        init_launch,
        additions,
        init_params_before,
    )
    device_after = _append_init_kernel_params_and_writes(
        device_source,
        init_launch.kernel,
        additions,
    )
    return core_after, device_after, core_after != core_source or device_after != device_source


def _insert_synthi_init_kernel(
    *,
    core_source: str,
    device_source: str,
    lookup_device_source: Optional[str] = None,
    update_launch: _LaunchInfo,
    required_order: Sequence[Tuple[str, str, _ParamInfo]],
) -> tuple[str, str, bool]:
    if not required_order:
        return core_source, device_source, False

    lookup_source = lookup_device_source or device_source
    count_arg, count_param = _launch_count_argument(lookup_source, update_launch)
    if not count_arg or not count_param:
        return core_source, device_source, False

    kernel_name = _unique_kernel_name(device_source, "synthi_hmr_init_buffers")
    pointer_params: List[_ParamInfo] = []
    existing_names: Set[str] = {count_param.name}
    launch_args: List[str] = []
    for buffer, launch_arg, update_param in required_order:
        param = _init_param_from_update(buffer, update_param)
        unique_name = _unique_param_name(param.name, existing_names)
        if unique_name != param.name:
            param = _ParamInfo(
                declaration=f"{param.type_text} {unique_name}".strip(),
                type_text=param.type_text,
                name=unique_name,
                is_pointer=param.is_pointer,
            )
        pointer_params.append(param)
        launch_args.append(launch_arg)

    launch_args.append(count_arg)
    params = pointer_params + [count_param]
    init_kernel = _synthi_init_kernel_source(kernel_name, params, count_param.name)
    device_after = device_source.rstrip() + "\n\n" + init_kernel + "\n"

    args = list(update_launch.args)
    args[1] = f'"{kernel_name}"'
    args[-1] = "{ " + ", ".join(launch_args) + " }"
    init_call = "synthi_gpu_launch(" + ", ".join(args) + ")"
    init_block = (
        "static bool synthi_hmr_device_initialized = false;\n"
        "    if (!synthi_hmr_device_initialized) {\n"
        f"        bool synthi_hmr_init_ok = {init_call};\n"
        "        if (synthi_hmr_init_ok) synthi_hmr_device_initialized = true;\n"
        "    }\n"
    )
    insert_at = _statement_start(core_source, update_launch.start)
    core_after = core_source[:insert_at] + init_block + core_source[insert_at:]
    return core_after, device_after, True


def _append_init_launch_args(
    core_source: str,
    init_launch: _LaunchInfo,
    additions: Sequence[Tuple[str, str, _ParamInfo]],
    init_params: Sequence[_ParamInfo],
) -> str:
    required = {buffer: (launch_arg, param) for buffer, launch_arg, param in additions}
    used_required: Set[str] = set()
    used_current_indexes: Set[int] = set()
    new_args: List[str] = []

    for index, init_param in enumerate(init_params):
        current_arg = (
            init_launch.launch_args[index]
            if index < len(init_launch.launch_args) and index not in used_current_indexes
            else None
        )
        current_buffer = (
            _normalize_launch_buffer_arg(current_arg)
            if current_arg is not None
            else None
        )
        selected_arg: Optional[str] = None

        if init_param.is_pointer:
            if current_buffer in required and current_buffer not in used_required:
                selected_arg = current_arg
                used_current_indexes.add(index)
                used_required.add(current_buffer)
            else:
                for buffer, (launch_arg, update_param) in required.items():
                    if buffer in used_required:
                        continue
                    if _param_matches_required_buffer(init_param, buffer, update_param):
                        selected_arg = launch_arg
                        used_required.add(buffer)
                        break

        if selected_arg is None:
            for current_index, candidate_arg in enumerate(init_launch.launch_args):
                if current_index in used_current_indexes:
                    continue
                if _launch_arg_matches_param(candidate_arg, init_param):
                    selected_arg = candidate_arg
                    used_current_indexes.add(current_index)
                    break

        if selected_arg is None and current_arg is not None:
            selected_arg = current_arg
            used_current_indexes.add(index)
            if current_buffer in required:
                used_required.add(current_buffer)

        if selected_arg is not None:
            new_args.append(selected_arg)

    for buffer, (launch_arg, _param) in required.items():
        if buffer not in used_required:
            new_args.append(launch_arg)

    args = list(init_launch.args)
    args[-1] = "{ " + ", ".join(new_args) + " }"
    replacement = "synthi_gpu_launch(" + ", ".join(args) + ")"
    return core_source[: init_launch.start] + replacement + core_source[init_launch.end :]


def _kernel_body_source(device_source: str, kernel: str) -> str:
    span = _kernel_function_span(device_source, kernel)
    if span is None:
        return ""
    function_source = device_source[span[0] : span[1]]
    body_start = function_source.find("{")
    if body_start < 0:
        return ""
    return function_source[body_start + 1 : -1]


def _launch_count_argument(
    device_source: str,
    launch: _LaunchInfo,
) -> Tuple[Optional[str], Optional[_ParamInfo]]:
    params = _kernel_params(device_source, launch.kernel)
    body = _kernel_body_source(device_source, launch.kernel)
    count_name = _count_param_name(body, params)
    if count_name:
        for index, param in enumerate(params):
            if param.name == count_name and index < len(launch.launch_args):
                return launch.launch_args[index], param

    for index in range(len(params) - 1, -1, -1):
        param = params[index]
        if param.is_pointer or index >= len(launch.launch_args):
            continue
        if re.search(r"\b(?:int|size_t|uint32_t|unsigned\s+int)\b", param.type_text):
            return launch.launch_args[index], param
    return None, None


def _unique_kernel_name(device_source: str, base: str) -> str:
    existing = {match.group("name") for match in _GLOBAL_KERNEL_SIGNATURE_RE.finditer(device_source)}
    if base not in existing:
        return base
    index = 2
    while f"{base}_{index}" in existing:
        index += 1
    return f"{base}_{index}"


def _synthi_init_kernel_source(
    kernel_name: str,
    params: Sequence[_ParamInfo],
    count_name: str,
) -> str:
    param_text = ", ".join(param.declaration for param in params)
    return (
        f'extern "C" __global__ void {kernel_name}({param_text}) {{'
        f"{_init_write_block(count_name, [param for param in params if param.is_pointer])}"
        "}"
    )


def _statement_start(source: str, call_start: int) -> int:
    index = max(0, min(call_start, len(source)))
    while index > 0 and source[index - 1] not in ";\n{}":
        index -= 1
    while index < call_start and source[index].isspace() and source[index] != "\n":
        index += 1
    return index


def _launch_arg_matches_param(arg: str, param: _ParamInfo) -> bool:
    normalized = _normalize_launch_buffer_arg(arg)
    tail_name = _sanitize_param_name(normalized, "")
    return tail_name == param.name or normalized == param.name


def _sanitize_param_name(buffer: str, fallback: str) -> str:
    tail = re.split(r"(?:->|\.)", buffer.strip())[-1]
    tail = re.sub(r"\[[^\]]*\]", "", tail)
    name = re.sub(r"[^A-Za-z0-9_]", "_", tail).strip("_")
    if not name or not re.match(r"[A-Za-z_]", name):
        name = fallback
    return name


def _init_param_from_update(buffer: str, param: _ParamInfo) -> _ParamInfo:
    name = _sanitize_param_name(buffer, param.name)
    type_text = re.sub(r"\bconst\s+", "", param.type_text).strip()
    declaration = f"{type_text} {name}".strip()
    return _ParamInfo(
        declaration=declaration,
        type_text=type_text,
        name=name,
        is_pointer=True,
    )


def _param_matches_required_buffer(
    init_param: _ParamInfo,
    buffer: str,
    update_param: _ParamInfo,
) -> bool:
    if not init_param.is_pointer:
        return False
    candidate_names = {
        _sanitize_param_name(buffer, update_param.name),
        update_param.name,
        _sanitize_param_name(buffer, ""),
    }
    return init_param.name in {name for name in candidate_names if name}


def _unique_param_name(base: str, existing_names: Set[str]) -> str:
    candidate = base or "buffer"
    if candidate not in existing_names:
        existing_names.add(candidate)
        return candidate
    index = 2
    while True:
        next_candidate = f"{candidate}_{index}"
        if next_candidate not in existing_names:
            existing_names.add(next_candidate)
            return next_candidate
        index += 1


def _append_init_kernel_params_and_writes(
    device_source: str,
    kernel: str,
    additions: Sequence[Tuple[str, str, _ParamInfo]],
) -> str:
    if not additions:
        return device_source

    match = next(
        (
            match
            for match in _GLOBAL_KERNEL_SIGNATURE_RE.finditer(device_source)
            if match.group("name") == kernel
        ),
        None,
    )
    if not match:
        return device_source

    existing_params = _kernel_params(device_source, kernel)
    existing_names = {param.name for param in existing_params}
    represented_buffers: Set[str] = set()
    write_params: List[_ParamInfo] = []
    for existing_param in existing_params:
        if not existing_param.is_pointer:
            continue
        for buffer, _launch_arg, update_param in additions:
            if buffer in represented_buffers:
                continue
            if _param_matches_required_buffer(existing_param, buffer, update_param):
                represented_buffers.add(buffer)
                write_params.append(existing_param)
                break

    params_to_add: List[_ParamInfo] = []
    for buffer, _launch_arg, update_param in additions:
        if buffer in represented_buffers:
            continue
        param = _init_param_from_update(buffer, update_param)
        unique_name = _unique_param_name(param.name, existing_names)
        if unique_name != param.name:
            param = _ParamInfo(
                declaration=f"{param.type_text} {unique_name}".strip(),
                type_text=param.type_text,
                name=unique_name,
                is_pointer=param.is_pointer,
            )
        params_to_add.append(param)
        write_params.append(param)

    new_param_text = match.group("params").strip()
    source = device_source
    if params_to_add:
        appended = ", ".join(param.declaration for param in params_to_add)
        if new_param_text and new_param_text != "void":
            new_param_text = f"{new_param_text}, {appended}"
        else:
            new_param_text = appended
        source = (
            device_source[: match.start("params")]
            + new_param_text
            + device_source[match.end("params") :]
        )

    updated_match = next(
        (
            match
            for match in _GLOBAL_KERNEL_SIGNATURE_RE.finditer(source)
            if match.group("name") == kernel
        ),
        None,
    )
    if not updated_match:
        return source

    body_start = source.find("{", updated_match.end())
    if body_start < 0:
        return source
    body_end = _matching_brace(source, body_start)
    if body_end is None:
        return source

    params_after = _kernel_params(source, kernel)
    count_name = _count_param_name(source[body_start + 1 : body_end], params_after)
    if not count_name:
        return source

    write_block = _init_write_block(count_name, write_params)
    return source[:body_end] + write_block + source[body_end:]


def _repair_launch_abi_mismatches(
    *,
    core_source: str,
    device_source: str,
    shared_source: str,
) -> tuple[str, str, bool]:
    out_core = core_source
    out_device = device_source
    changed = False
    type_sources = (core_source, shared_source, device_source)

    next_core = _repair_aggregate_launch_args(
        out_core,
        out_device,
        type_sources,
    )
    if next_core != out_core:
        out_core = next_core
        changed = True

    next_core = _repair_launch_argument_addresses(out_core)
    if next_core != out_core:
        out_core = next_core
        changed = True

    launches = _collect_launches(out_core, out_device)
    if not launches:
        return out_core, out_device, changed

    for launch in launches:
        params = _kernel_params(out_device, launch.kernel)
        if len(launch.launch_args) <= len(params):
            continue

        existing_names = {param.name for param in params}
        additions: List[_ParamInfo] = []
        for index, launch_arg in enumerate(launch.launch_args[len(params) :], start=len(params)):
            inferred = _param_from_launch_arg(
                launch_arg,
                type_sources=type_sources,
                existing_names=existing_names,
                fallback=f"arg{index}",
            )
            if inferred is None:
                return out_core, out_device, changed
            additions.append(inferred)

        if additions:
            next_device = _append_kernel_params(out_device, launch.kernel, additions)
            if next_device != out_device:
                out_device = next_device
                changed = True

    return out_core, out_device, changed


def _repair_aggregate_launch_args(
    core_source: str,
    device_source: str,
    type_sources: Sequence[str],
) -> str:
    replacements: Dict[Tuple[int, int], str] = {}
    insertions: Dict[int, str] = {}
    unique_index = 1

    for launch in _collect_launches(core_source, device_source):
        params = _kernel_params(device_source, launch.kernel)
        if len(launch.launch_args) <= len(params):
            continue

        for param_index, param in enumerate(params):
            if param.is_pointer:
                continue
            fields = _struct_fields(param.type_text, type_sources)
            if len(fields) <= 1:
                continue
            if len(launch.launch_args) - len(params) + 1 != len(fields):
                continue

            values = launch.launch_args[param_index : param_index + len(fields)]
            if len(values) != len(fields):
                continue
            if not all(_addressable_launch_expr(_normalize_launch_buffer_arg(value)) for value in values):
                continue

            variable_name = f"synthi_hmr_launch_params_{unique_index}"
            unique_index += 1
            initializer = ", ".join(_normalize_launch_buffer_arg(value) for value in values)
            declaration = f"{param.type_text} {variable_name} = {{ {initializer} }};\n"
            new_launch_args = (
                launch.launch_args[:param_index]
                + [f"&{variable_name}"]
                + launch.launch_args[param_index + len(fields) :]
            )
            new_call_args = list(launch.args)
            new_call_args[-1] = "{ " + ", ".join(new_launch_args) + " }"
            replacements[(launch.start, launch.end)] = "synthi_gpu_launch(" + ", ".join(new_call_args) + ")"
            insertions[_statement_start(core_source, launch.start)] = declaration
            break

    if not replacements and not insertions:
        return core_source

    out = core_source
    for (start, end), replacement in sorted(replacements.items(), reverse=True):
        out = out[:start] + replacement + out[end:]
    for insert_at, declaration in sorted(insertions.items(), reverse=True):
        out = out[:insert_at] + declaration + out[insert_at:]
    return out


def _statement_start(source: str, index: int) -> int:
    cursor = index
    while cursor > 0 and source[cursor - 1].isspace():
        cursor -= 1
    while cursor > 0 and source[cursor - 1] not in ";{}":
        cursor -= 1
    while cursor < len(source) and source[cursor].isspace():
        cursor += 1
    return cursor


def _struct_fields(type_text: str, type_sources: Sequence[str]) -> List[Tuple[str, str]]:
    type_name = re.sub(r"\b(?:const|volatile|struct|class)\b", " ", type_text)
    type_name = type_name.replace("*", " ").replace("&", " ")
    type_name = re.sub(r"\s+", " ", type_name).strip()
    type_name = type_name.rsplit("::", 1)[-1]
    if not type_name:
        return []

    struct_re = re.compile(
        rf"\bstruct\s+{re.escape(type_name)}\s*\{{(?P<body>.*?)\}}\s*;",
        re.DOTALL,
    )
    fields: List[Tuple[str, str]] = []
    for source in type_sources:
        match = struct_re.search(source)
        if not match:
            continue
        for raw_declaration in match.group("body").split(";"):
            field_match = re.search(
                r"^\s*(?P<type>[A-Za-z_][A-Za-z0-9_:<>]*(?:\s+[A-Za-z_][A-Za-z0-9_:<>]*)*(?:\s*[*&])*)\s+"
                r"(?P<name>[A-Za-z_][A-Za-z0-9_]*)\s*(?:=[^;]*)?\s*$",
                raw_declaration,
            )
            if not field_match:
                continue
            fields.append(
                (
                    re.sub(r"\s+", " ", field_match.group("type")).strip(),
                    field_match.group("name"),
                )
            )
        if fields:
            return fields
    return []


def _append_kernel_params(
    device_source: str,
    kernel: str,
    additions: Sequence[_ParamInfo],
) -> str:
    match = next(
        (
            match
            for match in _GLOBAL_KERNEL_SIGNATURE_RE.finditer(device_source)
            if match.group("name") == kernel
        ),
        None,
    )
    if not match:
        return device_source

    new_param_text = match.group("params").strip()
    appended = ", ".join(param.declaration for param in additions)
    if new_param_text and new_param_text != "void":
        new_param_text = f"{new_param_text}, {appended}"
    else:
        new_param_text = appended
    return (
        device_source[: match.start("params")]
        + new_param_text
        + device_source[match.end("params") :]
    )


def _param_from_launch_arg(
    launch_arg: str,
    *,
    type_sources: Sequence[str],
    existing_names: Set[str],
    fallback: str,
) -> Optional[_ParamInfo]:
    expression = _normalize_launch_buffer_arg(launch_arg)
    if not _addressable_launch_expr(expression):
        return None
    type_text = _infer_launch_expr_type(expression, type_sources)
    if not type_text:
        return None
    name = _unique_param_name(_sanitize_param_name(expression, fallback), existing_names)
    declaration = f"{type_text} {name}".strip()
    return _ParamInfo(
        declaration=declaration,
        type_text=type_text,
        name=name,
        is_pointer="*" in type_text,
    )


def _addressable_launch_expr(expression: str) -> bool:
    return bool(
        re.match(
            r"^[A-Za-z_][A-Za-z0-9_]*(?:(?:->|\.)[A-Za-z_][A-Za-z0-9_]*)*(?:\[[^\]]+\])?$",
            expression.strip(),
        )
    )


def _infer_launch_expr_type(expression: str, type_sources: Sequence[str]) -> Optional[str]:
    field_match = re.search(r"(?:->|\.)(?P<field>[A-Za-z_][A-Za-z0-9_]*)$", expression)
    if field_match:
        return _declared_value_type(field_match.group("field"), type_sources)
    name_match = re.match(r"(?P<name>[A-Za-z_][A-Za-z0-9_]*)$", expression)
    if name_match:
        return _declared_value_type(name_match.group("name"), type_sources)
    return None


def _declared_value_type(name: str, type_sources: Sequence[str]) -> Optional[str]:
    name_re = re.escape(name)
    declaration_re = re.compile(
        rf"(?:^|[;{{,]\s*)(?:static\s+|const\s+|constexpr\s+|volatile\s+)*"
        rf"(?P<type>[A-Za-z_][A-Za-z0-9_:<>]*(?:\s+[A-Za-z_][A-Za-z0-9_:<>]*)*(?:\s*[*&])*)\s+"
        rf"{name_re}\b\s*(?:[;=,\[])"
    )
    for source in type_sources:
        for raw_line in source.splitlines():
            line = raw_line.strip()
            if not line or "(" in line:
                continue
            for match in declaration_re.finditer(line):
                type_text = re.sub(r"\s+", " ", match.group("type")).strip()
                if type_text and type_text not in _CPP_DECL_KEYWORDS:
                    return type_text
    return None


def _repair_launch_argument_addresses(core_source: str) -> str:
    replacements: Dict[Tuple[int, int], str] = {}
    insertions: Dict[int, List[str]] = {}
    unique_index = 1
    for start, end, body in _iter_launch_spans(core_source):
        args = _split_top_level_args(body)
        if len(args) != 7:
            continue
        launch_args = _launch_initializer_args(args[-1])
        if not launch_args:
            continue
        fixed_entries: List[str] = []
        changed = False
        for entry in launch_args:
            stripped = entry.strip()
            if stripped.startswith("&"):
                fixed_entries.append(stripped)
                continue
            if _addressable_launch_expr(stripped):
                fixed_entries.append(f"&{stripped}")
                changed = True
            elif _inline_launch_initializer_expr(stripped):
                while f"synthi_hmr_launch_arg_{unique_index}" in core_source:
                    unique_index += 1
                variable_name = f"synthi_hmr_launch_arg_{unique_index}"
                unique_index += 1
                insert_at = _statement_start(core_source, start)
                insertions.setdefault(insert_at, []).append(f"auto {variable_name} = {stripped};\n")
                fixed_entries.append(f"&{variable_name}")
                changed = True
            else:
                fixed_entries.append(stripped)
        if not changed:
            continue
        args[-1] = "{ " + ", ".join(fixed_entries) + " }"
        replacements[(start, end)] = "synthi_gpu_launch(" + ", ".join(args) + ")"

    out = core_source
    for (start, end), replacement in sorted(replacements.items(), reverse=True):
        out = out[:start] + replacement + out[end:]
    for insert_at, declarations in sorted(insertions.items(), reverse=True):
        out = out[:insert_at] + "".join(declarations) + out[insert_at:]
    return out


def _inline_launch_initializer_expr(expression: str) -> bool:
    expr = expression.strip()
    return bool(
        re.match(
            r"^(?:(?:const|volatile)\s+)*[A-Za-z_][A-Za-z0-9_:<>]*(?:\s+[A-Za-z_][A-Za-z0-9_:<>]*)*\s*\{.*\}$",
            expr,
            re.DOTALL,
        )
    )


def _matching_brace(source: str, open_brace: int) -> Optional[int]:
    depth = 0
    for i in range(open_brace, len(source)):
        if source[i] == "{":
            depth += 1
        elif source[i] == "}":
            depth -= 1
            if depth == 0:
                return i
    return None


def _count_param_name(body: str, params: Sequence[_ParamInfo]) -> Optional[str]:
    guard = re.search(
        r"\b[A-Za-z_][A-Za-z0-9_]*\s*<\s*"
        r"(?P<count>[A-Za-z_][A-Za-z0-9_]*(?:(?:->|\.)[A-Za-z_][A-Za-z0-9_]*)*)",
        body,
    )
    if guard:
        return guard.group("count")
    for param in reversed(params):
        if param.is_pointer:
            continue
        if re.search(r"\b(?:int|size_t|uint32_t|unsigned\s+int)\b", param.type_text):
            return param.name
    return None


def _zero_value_for_pointer(type_text: str) -> str:
    compact = re.sub(r"\s+", " ", type_text)
    if "double" in compact:
        return "0.0"
    if "float" in compact:
        return "0.0f"
    if "unsigned" in compact or "uint" in compact:
        return "0u"
    return "0"


def _init_write_block(count_name: str, params: Sequence[_ParamInfo]) -> str:
    lines = [
        "",
        "    {",
        "        int synthi_hmr_i = blockIdx.x * blockDim.x + threadIdx.x;",
        f"        if (synthi_hmr_i < {count_name}) {{",
    ]
    for param in params:
        zero = _zero_value_for_pointer(param.type_text)
        lines.append(
            f"            if ({param.name}) {param.name}[synthi_hmr_i] = {zero};"
        )
    lines.extend(["        }", "    }", ""])
    return "\n".join(lines)
