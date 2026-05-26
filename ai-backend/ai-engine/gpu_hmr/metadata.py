"""Compile-aware target metadata adapter for GPU HMR.

This module consumes the existing GPU source-context report and build metadata
files. It does not create another index: CodeIntel/source-context and build
metadata remain the authority, while GPU HMR receives compact identity hashes
and evidence references.
"""

from __future__ import annotations

import json
import posixpath
import re
import shlex
from typing import Any, Dict, Iterable, List, Mapping, Optional, Tuple

from gpu_hmr.canonical import GPU_HMR_IDENTITY_POLICY, CanonicalizationError, canonical_hash, normalize_workspace_path
from gpu_hmr.contracts import SelectedTargetIdentity
from gpu_hmr.reason_codes import assert_registered_reason_codes


TARGET_METADATA_RESOLUTION_SCHEMA_VERSION = "gpu-hmr-target-metadata-resolution-v1"
TARGET_COMPILE_METADATA_SCHEMA_VERSION = "gpu-hmr-target-compile-metadata-v1"
BUILD_METADATA_IDENTITY_SCHEMA_VERSION = "gpu-hmr-build-metadata-identity-v1"
TOOLCHAIN_IDENTITY_SCHEMA_VERSION = "gpu-hmr-toolchain-identity-v1"

_WINDOWS_ABSOLUTE_RE = re.compile(r"^[A-Za-z]:/")


def resolve_target_metadata(
    source_files: Mapping[str, str],
    *,
    focus: Optional[str] = None,
    environment: Optional[Mapping[str, str]] = None,
    source_context_report: Optional[Mapping[str, Any]] = None,
) -> Dict[str, Any]:
    """Resolve a selected target identity from existing build metadata.

    The returned object is suitable for feeding `/gpu-hmr/projections`: it
    contains a selected target identity hash, build metadata hash, target compile
    metadata hash, evidence refs, and reason codes. Ambiguous or missing target
    ownership fails closed.
    """

    normalized_files = {_loose_normalize(path): content for path, content in source_files.items() if _loose_normalize(path)}
    if source_context_report is None:
        from agents.gpu_source_context import build_source_context_report

        report = build_source_context_report(normalized_files, focus=focus)
    else:
        report = dict(source_context_report)
    build_metadata = report.get("buildMetadata") if isinstance(report.get("buildMetadata"), Mapping) else {}
    target_resolution = (
        build_metadata.get("targetResolution")
        if isinstance(build_metadata.get("targetResolution"), Mapping)
        else {}
    )
    selected_command = (
        build_metadata.get("selectedCompileCommand")
        if isinstance(build_metadata.get("selectedCompileCommand"), Mapping)
        else {}
    )
    selected_target = (
        target_resolution.get("selectedTarget")
        if isinstance(target_resolution, Mapping) and target_resolution.get("status") == "selected"
        else None
    )

    blocking_reason_codes: List[str] = []
    advisory_reason_codes: List[str] = []
    target_status = str(target_resolution.get("status") or "")
    if target_status == "ambiguous":
        blocking_reason_codes.append("target_resolution_ambiguous")
    elif target_status in {"unmatched", "missing"}:
        blocking_reason_codes.extend(str(code) for code in target_resolution.get("reasonCodes") or [])

    command_status = str(selected_command.get("status") or "")
    if command_status != "selected":
        blocking_reason_codes.append("build_metadata_missing")

    if selected_target:
        advisory_reason_codes.append("target.cmake_file_api_selected")
    elif command_status == "selected":
        advisory_reason_codes.append("target.compile_commands_only")

    known_paths = set(normalized_files)
    compile_entry = _selected_compile_entry(normalized_files, selected_command, known_paths)
    if command_status == "selected" and compile_entry is None:
        blocking_reason_codes.append("build_metadata_missing")

    identity: Optional[SelectedTargetIdentity] = None
    identity_hash: Optional[str] = None
    target_compile_metadata_hash: Optional[str] = None
    toolchain_identity_hash: Optional[str] = None
    compile_metadata: Dict[str, Any] = {}

    if not blocking_reason_codes and compile_entry is not None:
        args = _command_arguments(compile_entry)
        compile_file = _workspace_path_from_compile_file(
            str(compile_entry.get("file") or selected_command.get("file") or ""),
            known_paths,
        )
        target_sources = _target_sources(selected_target, compile_file, known_paths)
        if not compile_file or not target_sources:
            blocking_reason_codes.append("target_config_invalid")
        else:
            flags = _parse_compile_arguments(args)
            env = dict(environment or {})
            gpu_vendor = env.get("SYNTHI_GPU_VENDOR")
            gpu_arch = env.get("SYNTHI_GPU_ARCH")
            compile_metadata = {
                "schemaVersion": TARGET_COMPILE_METADATA_SCHEMA_VERSION,
                "compileCommandFile": compile_file,
                "compileCommandDirectory": str(compile_entry.get("directory") or ""),
                "argumentsHash": canonical_hash(args),
                "effectiveFlagsHash": canonical_hash(args[1:] if len(args) > 1 else []),
                "languageStandards": flags["languageStandards"],
                "defines": flags["defines"],
                "undefines": flags["undefines"],
                "includeRoots": flags["includeRoots"],
                "systemIncludeRoots": flags["systemIncludeRoots"],
                "generatedHeaderRoots": flags["generatedHeaderRoots"],
                "linkLibraries": flags["linkLibraries"],
                "linkDirectories": flags["linkDirectories"],
                "rawExternalIncludeRootHash": canonical_hash(flags["externalIncludeRoots"]),
                "rawExternalLinkDirectoryHash": canonical_hash(flags["externalLinkDirectories"]),
            }
            target_compile_metadata_hash = canonical_hash(
                compile_metadata,
                policy=GPU_HMR_IDENTITY_POLICY,
            )
            toolchain_identity_hash = canonical_hash(
                {
                    "schemaVersion": TOOLCHAIN_IDENTITY_SCHEMA_VERSION,
                    "compilerPath": args[0] if args else selected_command.get("compiler"),
                    "compilerId": _compiler_id(args[0] if args else selected_command.get("compiler")),
                    "languageStandards": flags["languageStandards"],
                    "gpuVendor": gpu_vendor,
                    "gpuArch": gpu_arch,
                    "rdcMode": _rdc_mode(args),
                    "deviceLinkMode": _device_link_mode(args, target_sources),
                },
                policy=GPU_HMR_IDENTITY_POLICY,
            )
            try:
                identity = SelectedTargetIdentity(
                    buildSystem="cmake" if selected_target else "compile_commands",
                    buildRoot=_safe_relative_path(str(compile_entry.get("directory") or "")) or "",
                    buildConfiguration=str(selected_target.get("configuration") or "") if isinstance(selected_target, Mapping) else None,
                    targetName=str(selected_target.get("name") or compile_file) if isinstance(selected_target, Mapping) else compile_file,
                    targetType=str(selected_target.get("type") or "TRANSLATION_UNIT") if isinstance(selected_target, Mapping) else "TRANSLATION_UNIT",
                    compilerPath=str(args[0] if args else selected_command.get("compiler") or ""),
                    compilerId=_compiler_id(args[0] if args else selected_command.get("compiler")),
                    compilerVersion=None,
                    languageStandards=flags["languageStandards"],
                    defines=flags["defines"],
                    undefines=flags["undefines"],
                    includeRoots=flags["includeRoots"],
                    systemIncludeRoots=flags["systemIncludeRoots"],
                    generatedHeaderRoots=flags["generatedHeaderRoots"],
                    sourceFiles=target_sources,
                    linkLibraries=flags["linkLibraries"],
                    linkDirectories=flags["linkDirectories"],
                    runtimeLibraryPaths=[],
                    gpuVendor=gpu_vendor,
                    gpuArch=gpu_arch,
                    rdcMode=_rdc_mode(args),
                    deviceLinkMode=_device_link_mode(args, target_sources),
                    workerRuntimeToolchainIdentityHash=toolchain_identity_hash,
                )
                identity_hash = identity.contract_hash()
            except (CanonicalizationError, ValueError) as exc:
                identity = None
                identity_hash = None
                blocking_reason_codes.append("target_config_invalid")
                compile_metadata["identityError"] = str(exc)

    blocking_reason_codes = _sorted_unique(blocking_reason_codes)
    advisory_reason_codes = _sorted_unique(advisory_reason_codes)
    assert_registered_reason_codes([*blocking_reason_codes, *advisory_reason_codes])

    build_identity = {
        "schemaVersion": BUILD_METADATA_IDENTITY_SCHEMA_VERSION,
        "sourceContextHash": report.get("sourceContextHash"),
        "compileDbHash": build_metadata.get("compileDbHash"),
        "cmakeCodemodelHash": build_metadata.get("cmakeCodemodelHash"),
        "targetResolutionMethod": target_resolution.get("method") if isinstance(target_resolution, Mapping) else None,
        "selectedTargetIdentityHash": identity_hash,
        "targetCompileMetadataHash": target_compile_metadata_hash,
    }
    build_metadata_hash = canonical_hash(build_identity, policy=GPU_HMR_IDENTITY_POLICY)
    evidence_refs = _evidence_refs(report, build_metadata, target_compile_metadata_hash, toolchain_identity_hash)

    return {
        "schemaVersion": TARGET_METADATA_RESOLUTION_SCHEMA_VERSION,
        "status": "blocked" if blocking_reason_codes else "selected",
        "selectedTargetIdentity": identity.contract_dict() if identity else None,
        "selectedTargetIdentityHash": identity_hash,
        "buildMetadataHash": build_metadata_hash,
        "targetCompileMetadataHash": target_compile_metadata_hash,
        "toolchainIdentityHash": toolchain_identity_hash,
        "compileMetadata": compile_metadata,
        "evidenceRefs": evidence_refs,
        "blockingReasonCodes": blocking_reason_codes,
        "advisoryReasonCodes": advisory_reason_codes,
        "sourceContextHash": report.get("sourceContextHash"),
    }


def _parse_compile_commands(source_files: Mapping[str, str]) -> List[dict]:
    for path, content in sorted(source_files.items()):
        if _loose_normalize(path).rsplit("/", 1)[-1] != "compile_commands.json":
            continue
        try:
            parsed = json.loads(content)
        except json.JSONDecodeError:
            return []
        if not isinstance(parsed, list):
            return []
        return [entry for entry in parsed if isinstance(entry, dict)]
    return []


def _selected_compile_entry(
    source_files: Mapping[str, str],
    selected_command: Mapping[str, Any],
    known_paths: Iterable[str],
) -> Optional[Mapping[str, Any]]:
    selected_file = _workspace_path_from_compile_file(str(selected_command.get("file") or ""), known_paths)
    entries = _parse_compile_commands(source_files)
    if not selected_file:
        return None
    for entry in entries:
        entry_file = _workspace_path_from_compile_file(str(entry.get("file") or ""), known_paths)
        if entry_file == selected_file:
            return entry
    return None


def _command_arguments(entry: Mapping[str, Any]) -> List[str]:
    arguments = entry.get("arguments")
    if isinstance(arguments, list):
        return [str(arg) for arg in arguments]
    command = entry.get("command")
    if isinstance(command, str):
        try:
            return shlex.split(command)
        except ValueError:
            return command.split()
    return []


def _parse_compile_arguments(args: List[str]) -> Dict[str, List[str]]:
    include_roots: List[str] = []
    system_include_roots: List[str] = []
    generated_header_roots: List[str] = []
    external_include_roots: List[str] = []
    link_directories: List[str] = []
    external_link_directories: List[str] = []
    link_libraries: List[str] = []
    defines: List[str] = []
    undefines: List[str] = []
    standards: List[str] = []

    index = 1
    while index < len(args):
        arg = args[index]
        next_arg = args[index + 1] if index + 1 < len(args) else None
        if arg == "-I" and next_arg is not None:
            _append_path_flag(next_arg, include_roots, external_include_roots)
            index += 2
            continue
        if arg.startswith("-I") and len(arg) > 2:
            _append_path_flag(arg[2:], include_roots, external_include_roots)
        elif arg == "-isystem" and next_arg is not None:
            _append_path_flag(next_arg, system_include_roots, external_include_roots)
            index += 2
            continue
        elif arg.startswith("-isystem") and len(arg) > len("-isystem"):
            _append_path_flag(arg[len("-isystem"):], system_include_roots, external_include_roots)
        elif arg.startswith("-D") and len(arg) > 2:
            defines.append(arg[2:])
        elif arg == "-D" and next_arg is not None:
            defines.append(next_arg)
            index += 2
            continue
        elif arg.startswith("-U") and len(arg) > 2:
            undefines.append(arg[2:])
        elif arg == "-U" and next_arg is not None:
            undefines.append(next_arg)
            index += 2
            continue
        elif arg.startswith("-std=") or arg.startswith("--std="):
            standards.append(arg.split("=", 1)[1])
        elif arg == "-L" and next_arg is not None:
            _append_path_flag(next_arg, link_directories, external_link_directories)
            index += 2
            continue
        elif arg.startswith("-L") and len(arg) > 2:
            _append_path_flag(arg[2:], link_directories, external_link_directories)
        elif arg.startswith("-l") and len(arg) > 2:
            link_libraries.append(arg[2:])
        index += 1

    for root in include_roots:
        lower = root.lower()
        if "/generated" in lower or lower.startswith(("build/", "cmake-build-", "out/")):
            generated_header_roots.append(root)

    return {
        "includeRoots": _sorted_unique(include_roots),
        "systemIncludeRoots": _sorted_unique(system_include_roots),
        "generatedHeaderRoots": _sorted_unique(generated_header_roots),
        "externalIncludeRoots": _sorted_unique(external_include_roots),
        "linkDirectories": _sorted_unique(link_directories),
        "externalLinkDirectories": _sorted_unique(external_link_directories),
        "linkLibraries": _sorted_unique(link_libraries),
        "defines": _sorted_unique(defines),
        "undefines": _sorted_unique(undefines),
        "languageStandards": _sorted_unique(standards),
    }


def _append_path_flag(raw_path: str, relative_paths: List[str], external_paths: List[str]) -> None:
    relative = _safe_relative_path(raw_path)
    if relative is not None:
        relative_paths.append(relative)
    else:
        external_paths.append(str(raw_path))


def _target_sources(
    selected_target: Optional[Any],
    compile_file: Optional[str],
    known_paths: Iterable[str],
) -> List[str]:
    known = set(known_paths)
    sources: List[str] = []
    if isinstance(selected_target, Mapping):
        for source in selected_target.get("sourceFiles") or []:
            matched = _workspace_path_from_compile_file(str(source), known)
            if matched:
                sources.append(matched)
    if compile_file:
        sources.append(compile_file)
    return _sorted_unique(sources)


def _workspace_path_from_compile_file(raw_path: str, known_paths: Iterable[str]) -> Optional[str]:
    normalized = _loose_normalize(raw_path)
    if not normalized:
        return None
    if not _is_absolute_path(normalized):
        try:
            return normalize_workspace_path(normalized)
        except CanonicalizationError:
            return None
    normalized_lower = normalized.casefold()
    matches = [
        known
        for known in known_paths
        if normalized_lower.endswith("/" + _loose_normalize(known).casefold())
        or normalized_lower == _loose_normalize(known).casefold()
    ]
    if not matches:
        return None
    return sorted(matches, key=lambda item: (-len(item), item))[0]


def _safe_relative_path(raw_path: str) -> Optional[str]:
    normalized = _loose_normalize(raw_path)
    if not normalized or _is_absolute_path(normalized):
        return None
    try:
        return normalize_workspace_path(normalized)
    except CanonicalizationError:
        return None


def _loose_normalize(path: str) -> str:
    normalized = str(path or "").strip().replace("\\", "/")
    while normalized.startswith("./"):
        normalized = normalized[2:]
    if not normalized:
        return ""
    if _is_absolute_path(normalized):
        return posixpath.normpath(normalized)
    normalized = posixpath.normpath(normalized)
    return "" if normalized == "." else normalized


def _is_absolute_path(path: str) -> bool:
    return path.startswith("/") or path.startswith("//") or bool(_WINDOWS_ABSOLUTE_RE.match(path))


def _compiler_id(compiler: Any) -> str:
    base = str(compiler or "").replace("\\", "/").rsplit("/", 1)[-1].lower()
    if "hipcc" in base:
        return "hipcc"
    if "nvcc" in base:
        return "nvcc"
    if "clang" in base:
        return "clang"
    if base in {"g++", "gcc", "c++", "cc"} or base.endswith(("-g++", "-gcc")):
        return "gcc"
    return base or "unknown"


def _rdc_mode(args: List[str]) -> str:
    lowered = [arg.lower() for arg in args]
    enabled = any(
        arg in {"-fgpu-rdc", "--relocatable-device-code=true", "-rdc=true"}
        or arg.startswith("--relocatable-device-code=true")
        for arg in lowered
    )
    disabled = any(arg in {"--relocatable-device-code=false", "-rdc=false"} for arg in lowered)
    if enabled and not disabled:
        return "on"
    if disabled:
        return "off"
    return "off"


def _device_link_mode(args: List[str], source_files: Iterable[str]) -> str:
    device_source_count = sum(1 for path in source_files if str(path).lower().endswith((".cu", ".cuh", ".hip")))
    if _rdc_mode(args) == "on" or device_source_count > 1:
        return "multi_tu_supported"
    return "single_tu"


def _evidence_refs(
    report: Mapping[str, Any],
    build_metadata: Mapping[str, Any],
    target_compile_metadata_hash: Optional[str],
    toolchain_identity_hash: Optional[str],
) -> List[Dict[str, Any]]:
    refs = []
    if report.get("sourceContextHash"):
        refs.append({"kind": "source_context_report", "hash": report.get("sourceContextHash")})
    if build_metadata.get("compileDbHash"):
        refs.append({"kind": "compile_commands", "hash": build_metadata.get("compileDbHash")})
    if build_metadata.get("cmakeCodemodelHash"):
        refs.append({"kind": "cmake_file_api", "hash": build_metadata.get("cmakeCodemodelHash")})
    if target_compile_metadata_hash:
        refs.append({"kind": "target_compile_metadata", "hash": target_compile_metadata_hash})
    if toolchain_identity_hash:
        refs.append({"kind": "toolchain_identity", "hash": toolchain_identity_hash})
    return refs


def _sorted_unique(values: Iterable[str]) -> List[str]:
    return sorted({str(value) for value in values if str(value)})
