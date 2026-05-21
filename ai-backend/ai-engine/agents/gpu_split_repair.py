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
    _CPP_DECL_KEYWORDS,
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
_DEVICE_TO_HOST_COPY_MARKER_RE = re.compile(
    r"\b(?:cudaMemcpyDeviceToHost|hipMemcpyDeviceToHost)\b"
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
    shared_path = role_paths.get("shared")

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

    if core_path and core_path in repaired and "device_to_host_copy_not_launch_guarded" in input_reason_codes:
        core_after, changed = _repair_device_to_host_copy_guards(repaired[core_path])
        if changed:
            repaired[core_path] = core_after
            changed_files.add(core_path)
            repair_rules.append("repair.device_to_host_copy_guard")

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
    required_order: List[Tuple[str, str, _ParamInfo]] = []
    initialized: Set[str] = set()
    for launch in update_launches:
        for buffer, info in launch.pointer_buffers.items():
            if buffer not in required:
                required_order.append((buffer, info[0], info[1]))
            required[buffer] = info
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
    init_params_before = _kernel_params(device_source, init_launch.kernel)
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
    launches = _collect_launches(core_source, device_source)
    if not launches:
        return core_source, device_source, False

    out_core = core_source
    out_device = device_source
    changed = False
    type_sources = (core_source, shared_source, device_source)

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

    next_core = _repair_launch_argument_addresses(out_core)
    if next_core != out_core:
        out_core = next_core
        changed = True

    return out_core, out_device, changed


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
            else:
                fixed_entries.append(stripped)
        if not changed:
            continue
        args[-1] = "{ " + ", ".join(fixed_entries) + " }"
        replacements[(start, end)] = "synthi_gpu_launch(" + ", ".join(args) + ")"

    out = core_source
    for (start, end), replacement in sorted(replacements.items(), reverse=True):
        out = out[:start] + replacement + out[end:]
    return out


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
