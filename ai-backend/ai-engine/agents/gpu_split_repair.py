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

from verifier_gpu import (
    SplitVerificationResult,
    _launch_initializer_args,
    _launch_kernel_name,
    _normalize_launch_buffer_arg,
    _resolve_split_role_paths,
    _split_top_level_args,
)


REPAIR_SCHEMA_VERSION = "synthi.gpu.split_repair.v1"

_DEVICE_SOURCE_EXTENSIONS = (".cu", ".hip")
_DEVICE_HEADER_EXTENSIONS = (".h", ".hpp", ".hh", ".hxx", ".cuh")
_QUOTE_INCLUDE_RE = re.compile(r"#\s*include\s+\"(?P<path>[^\"]+)\"")
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
                repair_rules.append("repair.source_device_semantics")

        device_after, changed = _repair_device_constant_declarations(
            repaired[device_path],
            source_files,
        )
        if changed:
            repaired[device_path] = device_after
            changed_files.add(device_path)
            repair_rules.append("repair.source_device_constants")

    if (
        core_path
        and device_path
        and core_path in repaired
        and device_path in repaired
    ):
        core_after, device_after, changed = _repair_init_kernel_buffers(
            core_source=repaired[core_path],
            device_source=repaired[device_path],
        )
        if changed:
            repaired[core_path] = core_after
            repaired[device_path] = device_after
            changed_files.update({core_path, device_path})
            repair_rules.append("repair.init_kernel_buffers")

    return repaired, {
        "schemaVersion": REPAIR_SCHEMA_VERSION,
        "repaired": bool(repair_rules),
        "inputReasonCodes": input_reason_codes,
        "repairRules": repair_rules,
        "changedFiles": sorted(changed_files),
        "scope": "generated_artifacts_only",
    }


def _source_device_files(source_files: Mapping[str, str]) -> Dict[str, str]:
    return {
        path.replace("\\", "/"): source
        for path, source in source_files.items()
        if path.replace("\\", "/").lower().endswith(_DEVICE_SOURCE_EXTENSIONS)
        and ("__global__" in source or "__device__" in source)
    }


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
        for match in _QUOTE_INCLUDE_RE.finditer(source):
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
    for match in _GLOBAL_KERNEL_SIGNATURE_RE.finditer(source):
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
            first_kernel = _GLOBAL_KERNEL_SIGNATURE_RE.search(inline_source)
            if first_kernel:
                inline_source = inline_source[: first_kernel.start()]
        inline_source = inline_source.strip()
        if not inline_source or inline_source in seen:
            continue
        seen.add(inline_source)
        parts.append(f"// Inlined from {path}\n{inline_source}")
    return "\n\n".join(parts).strip()


def _repair_source_device_semantics(
    device_source: str,
    source_files: Mapping[str, str],
) -> tuple[str, bool]:
    reachable = _source_device_reachable_files(source_files)
    if not reachable:
        return device_source, False

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


def _repair_init_kernel_buffers(
    *,
    core_source: str,
    device_source: str,
) -> tuple[str, str, bool]:
    launches = _collect_launches(core_source, device_source)
    init_launches = [launch for launch in launches if launch.is_init]
    update_launches = [launch for launch in launches if not launch.is_init]
    if not init_launches or not update_launches:
        return core_source, device_source, False

    required: Dict[str, Tuple[str, _ParamInfo]] = {}
    initialized: Set[str] = set()
    for launch in update_launches:
        required.update(launch.pointer_buffers)
    for launch in init_launches:
        initialized.update(launch.pointer_buffers)

    missing = [buffer for buffer in sorted(required) if buffer not in initialized]
    if not missing:
        return core_source, device_source, False

    init_launch = init_launches[0]
    additions = [(buffer, required[buffer][0], required[buffer][1]) for buffer in missing]
    core_after = _append_init_launch_args(core_source, init_launch, additions)
    init_params = [_init_param_from_update(buffer, param) for buffer, _arg, param in additions]
    device_after = _append_init_kernel_params_and_writes(
        device_source,
        init_launch.kernel,
        init_params,
    )
    return core_after, device_after, core_after != core_source or device_after != device_source


def _append_init_launch_args(
    core_source: str,
    init_launch: _LaunchInfo,
    additions: Sequence[Tuple[str, str, _ParamInfo]],
) -> str:
    existing = {_normalize_launch_buffer_arg(arg) for arg in init_launch.launch_args}
    new_args = list(init_launch.launch_args)
    for buffer, launch_arg, _param in additions:
        if buffer not in existing:
            new_args.append(launch_arg)
            existing.add(buffer)

    args = list(init_launch.args)
    args[-1] = "{ " + ", ".join(new_args) + " }"
    replacement = "synthi_gpu_launch(" + ", ".join(args) + ")"
    return core_source[: init_launch.start] + replacement + core_source[init_launch.end :]


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


def _append_init_kernel_params_and_writes(
    device_source: str,
    kernel: str,
    additions: Sequence[_ParamInfo],
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
    params_to_add = [param for param in additions if param.name not in existing_names]
    if not params_to_add:
        return device_source

    new_param_text = match.group("params").strip()
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

    body_start = source.find("{", match.end())
    if body_start < 0:
        return source
    body_end = _matching_brace(source, body_start)
    if body_end is None:
        return source

    params_after = _kernel_params(source, kernel)
    count_name = _count_param_name(source[body_start + 1 : body_end], params_after)
    if not count_name:
        return source

    write_block = _init_write_block(count_name, params_to_add)
    return source[:body_end] + write_block + source[body_end:]


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
    guard = re.search(r"\b[A-Za-z_][A-Za-z0-9_]*\s*<\s*(?P<count>[A-Za-z_][A-Za-z0-9_]*)", body)
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
