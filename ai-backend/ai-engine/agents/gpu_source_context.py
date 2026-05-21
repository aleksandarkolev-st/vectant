"""Deterministic source-context selection for GPU HMR splits."""

from __future__ import annotations

import hashlib
import json
import re
import shlex
from typing import Any, Dict, List, Mapping, Optional, Tuple


SOURCE_CONTEXT_SCHEMA_VERSION = "synthi.gpu.source_context.v1"
DEFAULT_CONTEXT_MAX_CHARS = 70000
DEFAULT_CONTEXT_PER_FILE_MAX_CHARS = 3000

_SOURCE_EXT_RE = re.compile(r"\.(?:h|hpp|hh|hxx|cpp|cc|cxx|c|cu|cuh|hip)$", re.I)
_STATE_RE = re.compile(r"\b(?:struct|class)\s+[A-Za-z_][A-Za-z0-9_]*(?:State|Context)\b")
_RENDER_RE = re.compile(
    r"\b(?:glfw|SDL_|SDL2|raylib|InitWindow|BeginDrawing|ImGui|Vk[A-Z]|vk[A-Z]|gl[A-Z])\b",
    re.I,
)
_BACKEND_PATTERNS = {
    "sdl2": re.compile(r"\b(?:SDL2/SDL\.h|SDL_|SDL_Init|SDL_CreateWindow)\b", re.I),
    "glfw_opengl": re.compile(
        r"\b(?:GLFW/glfw3\.h|glfw[A-Z_]|GL/gl\.h|glClear|glBegin|glDraw)\b",
        re.I,
    ),
    "raylib": re.compile(r"\b(?:raylib\.h|InitWindow|BeginDrawing|DrawCircle|CloseWindow)\b", re.I),
    "sfml": re.compile(r"\b(?:SFML/Graphics\.hpp|sf::RenderWindow|sf::CircleShape)\b", re.I),
    "imgui": re.compile(r"\b(?:imgui\.h|ImGui::|ImGui_Impl)\b", re.I),
    "vulkan": re.compile(
        r"\b(?:vulkan/vulkan\.h|GLFW_INCLUDE_VULKAN|Vk[A-Z][A-Za-z0-9_]*|vk[A-Z][A-Za-z0-9_]*|VK_[A-Z0-9_]+)\b"
    ),
}
_KERNEL_DECL_RE = re.compile(r"\b__(?:global|device|constant|managed)__\b")
_TEMPLATE_EVIDENCE_BASENAMES = {
    "template-evidence.json",
    "template_evidence.json",
    "gpu-template-evidence.json",
    "gpu_template_evidence.json",
    "synthi-template-evidence.json",
    "synthi_template_evidence.json",
}


def normalize_path(path: str) -> str:
    normalized = str(path or "").strip().replace("\\", "/")
    while normalized.startswith("./"):
        normalized = normalized[2:]
    return normalized


def stable_hash(value: Any) -> str:
    encoded = json.dumps(value, sort_keys=True, separators=(",", ":")).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


def content_hash(text: str) -> str:
    return hashlib.sha256((text or "").encode("utf-8")).hexdigest()


def looks_like_source_file(path: str) -> bool:
    base = normalize_path(path).rsplit("/", 1)[-1]
    return bool(_SOURCE_EXT_RE.search(base))


def _is_build_metadata(path: str) -> bool:
    normalized = normalize_path(path)
    base = normalized.rsplit("/", 1)[-1]
    return (
        base in {"CMakeLists.txt", "CMakePresets.json", "compile_commands.json"}
        or normalized.startswith(".cmake/api/v1/reply/")
        or normalized.endswith("/CMakeLists.txt")
    )


def _is_generated_or_hidden(path: str) -> bool:
    normalized = normalize_path(path)
    parts = normalized.split("/")
    return (
        normalized.startswith(".synthi/")
        or normalized.startswith(".git/")
        or normalized.startswith("build/")
        or normalized.startswith("cmake-build-")
        or normalized.startswith("out/")
        or "__pycache__" in parts
        or normalized.endswith((".o", ".obj", ".so", ".dll", ".dylib", ".a", ".lib", ".exe"))
    )


def _drop_reason(path: str) -> Optional[str]:
    normalized = normalize_path(path)
    if _is_generated_or_hidden(normalized):
        return "generated_or_build_output"
    if normalized.startswith(("docs/", "doc/", "examples/", "test/", "tests/")):
        return "docs_tests_examples"
    if normalized.startswith(("vendor/", "third_party/", "external/", "node_modules/")):
        return "vendor_dependency"
    return None


def _reason_and_priority(path: str, source: str, focus: Optional[str]) -> Tuple[int, str]:
    normalized = normalize_path(path)
    focus_path = normalize_path(focus or "")
    if focus_path and normalized == focus_path:
        return (0, "entry_translation_unit")
    if _is_build_metadata(normalized):
        return (1, "build_metadata")
    if normalized.lower().endswith((".cu", ".cuh", ".hip")) and _KERNEL_DECL_RE.search(source):
        return (2, "device_translation_unit")
    if "<<<" in source and ">>>" in source:
        return (3, "kernel_launch_site")
    if _RENDER_RE.search(source):
        return (4, "render_backend")
    if _STATE_RE.search(source):
        return (5, "state_type_definition")
    if looks_like_source_file(normalized) and _KERNEL_DECL_RE.search(source):
        return (6, "kernel_declaration")
    if normalized.startswith("src/") and looks_like_source_file(normalized):
        return (7, "transitive_source_context")
    if looks_like_source_file(normalized):
        return (8, "source_context")
    return (99, "unsupported_file_type")


def _selected_target_source_scope(
    cmake_file_api: Optional[Mapping[str, Any]],
    focus: Optional[str],
) -> Optional[set[str]]:
    if not isinstance(cmake_file_api, Mapping):
        return None
    target_resolution = cmake_file_api.get("targetResolution")
    selected_target = (
        target_resolution.get("selectedTarget")
        if isinstance(target_resolution, Mapping)
        and target_resolution.get("status") == "selected"
        else None
    )
    if not isinstance(selected_target, Mapping):
        return None
    raw_sources = selected_target.get("sourceFiles")
    if not isinstance(raw_sources, list):
        return None
    scoped = {
        normalize_path(str(source))
        for source in raw_sources
        if str(source).strip()
    }
    focus_path = normalize_path(focus or "")
    if focus_path:
        scoped.add(focus_path)
    return scoped or None


def _graphics_backend_report(
    source_files: Mapping[str, str],
    *,
    focus: Optional[str] = None,
    cmake_file_api: Optional[Mapping[str, Any]] = None,
) -> dict:
    evidence: list[dict] = []
    detected: set[str] = set()
    scoped_paths = _selected_target_source_scope(cmake_file_api, focus)
    scope_mode = "selected_target_sources" if scoped_paths else "workspace_sources"
    for path, source in sorted(source_files.items()):
        normalized = normalize_path(path)
        if scoped_paths and not any(_path_matches(normalized, scoped) for scoped in scoped_paths):
            continue
        if not looks_like_source_file(normalized) and not normalized.endswith("CMakeLists.txt"):
            continue
        for backend, pattern in _BACKEND_PATTERNS.items():
            if pattern.search(source or ""):
                detected.add(backend)
                evidence.append(
                    {
                        "backend": backend,
                        "path": normalized,
                        "reason": "source_marker",
                        "scope": scope_mode,
                    }
                )

    if "imgui" in detected:
        if "sdl2" in detected:
            detected.add("imgui_sdl2")
        if "glfw_opengl" in detected:
            detected.add("imgui_glfw")

    primary = None
    for candidate in [
        "vulkan",
        "imgui_sdl2",
        "imgui_glfw",
        "imgui",
        "raylib",
        "sfml",
        "glfw_opengl",
        "sdl2",
    ]:
        if candidate in detected:
            primary = candidate
            break

    reason_codes: list[str] = []
    support_status = "unknown"
    if primary == "vulkan":
        support_status = "unsupported"
        reason_codes.append("unsupported.graphics_backend_vulkan")
        reason_codes.append("unsupported_project_shape")
    elif primary:
        support_status = "candidate"

    return {
        "schemaVersion": "synthi.gpu.graphics_backend.v1",
        "primary": primary,
        "detected": sorted(detected),
        "supportStatus": support_status,
        "reasonCodes": reason_codes,
        "evidence": evidence,
        "scope": scope_mode,
    }


def _parse_compile_commands(source_files: Mapping[str, str]) -> Tuple[str, List[dict], Optional[str]]:
    for path, content in sorted(source_files.items()):
        if normalize_path(path).rsplit("/", 1)[-1] != "compile_commands.json":
            continue
        try:
            parsed = json.loads(content)
        except json.JSONDecodeError as exc:
            return ("parse_failed", [], str(exc))
        if not isinstance(parsed, list):
            return ("parse_failed", [], "compile_commands.json root is not a list")
        entries = [entry for entry in parsed if isinstance(entry, dict)]
        return ("available", entries, None)
    return ("missing", [], None)


def _parse_json_file(path: str, content: str) -> tuple[Optional[Any], Optional[str]]:
    try:
        return json.loads(content), None
    except json.JSONDecodeError as exc:
        return None, f"{path}: {exc}"


def _cmake_reply_files(source_files: Mapping[str, str]) -> Dict[str, str]:
    return {
        normalize_path(path): content
        for path, content in source_files.items()
        if normalize_path(path).startswith(".cmake/api/v1/reply/")
        and normalize_path(path).lower().endswith(".json")
    }


def _is_template_evidence_path(path: str) -> bool:
    normalized = normalize_path(path)
    base = normalized.rsplit("/", 1)[-1].lower()
    if base in _TEMPLATE_EVIDENCE_BASENAMES:
        return True
    return (
        normalized.startswith(".cmake/api/v1/reply/")
        and base.endswith(".json")
        and "template" in base
        and "evidence" in base
    )


def _target_compile_command_identities(
    source_files: Mapping[str, str],
    selected_command: Mapping[str, Any],
    cmake_file_api: Mapping[str, Any],
) -> list[dict]:
    status, entries, _error = _parse_compile_commands(source_files)
    if status != "available":
        entries = []

    target_resolution = cmake_file_api.get("targetResolution")
    selected_target = (
        target_resolution.get("selectedTarget")
        if isinstance(target_resolution, Mapping)
        else None
    )
    target_sources = set()
    if isinstance(selected_target, Mapping):
        raw_sources = selected_target.get("sourceFiles")
        if isinstance(raw_sources, list):
            target_sources = {
                normalize_path(str(source))
                for source in raw_sources
                if str(source).strip()
            }

    identities: list[dict] = []
    seen: set[tuple[str, str]] = set()
    for entry in entries:
        entry_path = _compile_command_file(entry)
        if target_sources and not any(_path_matches(entry_path, source) for source in target_sources):
            continue
        args = _command_arguments(entry)
        if not args:
            continue
        identity = {
            "file": entry_path,
            "compiler": args[0].rsplit("/", 1)[-1],
            "argumentsHash": stable_hash(args),
            "effectiveFlagsHash": stable_hash(args[1:] if len(args) > 1 else []),
            "source": "compile_commands.json",
            "targetOwned": bool(target_sources),
        }
        key = (identity["file"], identity["effectiveFlagsHash"])
        if key in seen:
            continue
        seen.add(key)
        identities.append(identity)

    selected_hash = selected_command.get("effectiveFlagsHash")
    selected_file = normalize_path(str(selected_command.get("file") or ""))
    if selected_hash and all(identity.get("effectiveFlagsHash") != selected_hash for identity in identities):
        identities.insert(
            0,
            {
                "file": selected_file,
                "compiler": selected_command.get("compiler"),
                "argumentsHash": selected_command.get("argumentsHash"),
                "effectiveFlagsHash": selected_hash,
                "source": selected_command.get("source") or "selected_compile_command",
                "targetOwned": any(_path_matches(selected_file, source) for source in target_sources)
                if target_sources and selected_file
                else False,
            },
        )

    return sorted(
        identities,
        key=lambda item: (
            0 if item.get("effectiveFlagsHash") == selected_hash else 1,
            str(item.get("file") or ""),
            str(item.get("effectiveFlagsHash") or ""),
        ),
    )


def _template_evidence_report(
    source_files: Mapping[str, str],
    selected_command: Mapping[str, Any],
    cmake_file_api: Mapping[str, Any],
) -> dict:
    candidates: list[tuple[str, str]] = [
        (normalize_path(path), content)
        for path, content in sorted(source_files.items())
        if _is_template_evidence_path(path)
    ]
    if not candidates:
        return {
            "status": "missing",
            "evidence": None,
            "evidenceHash": stable_hash(None),
            "candidateCount": 0,
            "invalidationReasons": ["template_evidence_missing"],
        }

    parsed_candidates: list[dict] = []
    parse_errors: list[str] = []
    selected_flags_hash = str(selected_command.get("effectiveFlagsHash") or "")
    compile_identities = _target_compile_command_identities(
        source_files,
        selected_command,
        cmake_file_api,
    )
    accepted_flags_hashes = {
        str(identity.get("effectiveFlagsHash"))
        for identity in compile_identities
        if identity.get("effectiveFlagsHash")
    }
    if selected_flags_hash:
        accepted_flags_hashes.add(selected_flags_hash)
    for path, content in candidates:
        parsed, error = _parse_json_file(path, content)
        if error:
            parse_errors.append(error)
            continue
        raw = parsed.get("templateEvidence") if isinstance(parsed, dict) else None
        if raw is None:
            raw = parsed
        if not isinstance(raw, dict):
            parse_errors.append(f"{path}: template evidence root is not an object")
            continue

        entries = raw.get("entries")
        if not isinstance(entries, list):
            entries = []
        bounded = raw.get("bounded")
        if bounded is None:
            bounded = raw.get("impactBounded")
        evidence = {
            "schemaVersion": raw.get("schemaVersion") or "synthi.gpu.template_evidence.v1",
            "status": raw.get("status") or raw.get("evidenceStatus") or "fresh",
            "producer": raw.get("producer"),
            "compileCommandHash": raw.get("compileCommandHash"),
            "effectiveFlagsHash": raw.get("effectiveFlagsHash"),
            "gpuArch": raw.get("gpuArch"),
            "bounded": bool(bounded),
            "entries": entries,
            "source": {
                "path": path,
                "kind": "compiler_template_evidence_artifact",
            },
        }
        evidence["evidenceHash"] = stable_hash(evidence)
        parsed_candidates.append(evidence)

    if not parsed_candidates:
        return {
            "status": "parse_failed",
            "evidence": None,
            "evidenceHash": stable_hash({"errors": parse_errors}),
            "candidateCount": len(candidates),
            "invalidationReasons": ["template_evidence_parse_failed"],
            "errors": parse_errors,
        }

    def candidate_rank(evidence: Mapping[str, Any]) -> tuple[int, str]:
        flags = str(evidence.get("effectiveFlagsHash") or "")
        status = str(evidence.get("status") or "")
        bounded = bool(evidence.get("bounded"))
        score = 0
        if selected_flags_hash and flags == selected_flags_hash:
            score -= 6
        elif flags and flags in accepted_flags_hashes:
            score -= 4
        if status == "fresh":
            score -= 2
        if bounded:
            score -= 1
        path = ""
        source = evidence.get("source")
        if isinstance(source, dict):
            path = str(source.get("path") or "")
        return score, path

    selected = sorted(parsed_candidates, key=candidate_rank)[0]
    invalidation: list[str] = []
    if selected.get("status") != "fresh":
        invalidation.append("template_evidence_stale")
    if not selected.get("effectiveFlagsHash"):
        invalidation.append("template_evidence_effective_flags_missing")
    elif (
        accepted_flags_hashes
        and str(selected.get("effectiveFlagsHash") or "") not in accepted_flags_hashes
    ):
        invalidation.append("template_evidence_effective_flags_mismatch")
    if not selected.get("bounded"):
        invalidation.append("template_instantiation_unbounded")
    if not selected.get("entries"):
        invalidation.append("template_evidence_missing_entries")

    return {
        "status": "fresh" if not invalidation else "stale",
        "evidence": selected,
        "evidenceHash": selected.get("evidenceHash") or stable_hash(selected),
        "candidateCount": len(candidates),
        "acceptedCompileCommandIdentities": compile_identities,
        "selectedPath": selected.get("source", {}).get("path")
        if isinstance(selected.get("source"), dict)
        else None,
        "invalidationReasons": invalidation,
        "parseErrors": parse_errors,
    }


def _path_matches(candidate: str, target: str) -> bool:
    candidate = normalize_path(candidate)
    target = normalize_path(target)
    return candidate == target or candidate.endswith("/" + target) or target.endswith("/" + candidate)


def _cmake_reply_json_path(reply_path: str, json_file: str) -> str:
    json_file = normalize_path(json_file)
    if json_file.startswith(".cmake/api/v1/reply/"):
        return json_file
    parent = normalize_path(reply_path).rsplit("/", 1)[0]
    return normalize_path(f"{parent}/{json_file}")


def _cmake_file_api_report(source_files: Mapping[str, str], focus: Optional[str]) -> dict:
    reply_files = _cmake_reply_files(source_files)
    if not reply_files:
        if any(normalize_path(path).rsplit("/", 1)[-1] == "CMakeLists.txt" for path in source_files):
            return {
                "status": "cmake_project_file_api_missing",
                "codemodelHash": None,
                "targetResolution": {
                    "status": "missing",
                    "method": "cmake_file_api_missing",
                    "reasonCodes": ["cmake_file_api_missing"],
                },
                "targets": [],
            }
        return {
            "status": "not_cmake_project",
            "codemodelHash": None,
            "targetResolution": {
                "status": "not_applicable",
                "method": "not_cmake_project",
                "reasonCodes": [],
            },
            "targets": [],
        }

    codemodel_items: list[tuple[str, dict]] = []
    parse_errors: list[str] = []
    for path, content in sorted(reply_files.items()):
        parsed, error = _parse_json_file(path, content)
        if error:
            parse_errors.append(error)
            continue
        if isinstance(parsed, dict) and (
            parsed.get("kind") == "codemodel"
            or path.rsplit("/", 1)[-1].startswith("codemodel")
        ):
            codemodel_items.append((path, parsed))

    if parse_errors and not codemodel_items:
        return {
            "status": "parse_failed",
            "codemodelHash": stable_hash(reply_files),
            "targetResolution": {
                "status": "parse_failed",
                "method": "cmake_file_api_parse_failed",
                "reasonCodes": ["cmake_file_api_parse_failed"],
            },
            "targets": [],
            "errors": parse_errors,
        }
    if not codemodel_items:
        return {
            "status": "codemodel_missing",
            "codemodelHash": stable_hash(reply_files),
            "targetResolution": {
                "status": "missing",
                "method": "cmake_codemodel_missing",
                "reasonCodes": ["cmake_codemodel_missing"],
            },
            "targets": [],
        }

    targets: list[dict] = []
    for codemodel_path, codemodel in codemodel_items:
        configurations = codemodel.get("configurations")
        if not isinstance(configurations, list):
            continue
        for configuration in configurations:
            if not isinstance(configuration, dict):
                continue
            config_name = str(configuration.get("name") or "")
            for target_ref in configuration.get("targets") or []:
                if not isinstance(target_ref, dict):
                    continue
                target_name = str(target_ref.get("name") or "")
                target_id = str(target_ref.get("id") or "")
                target_json_file = str(target_ref.get("jsonFile") or "")
                target_path = _cmake_reply_json_path(codemodel_path, target_json_file) if target_json_file else ""
                target_obj: dict[str, Any] = {}
                if target_path in reply_files:
                    parsed_target, error = _parse_json_file(target_path, reply_files[target_path])
                    if error:
                        parse_errors.append(error)
                    elif isinstance(parsed_target, dict):
                        target_obj = parsed_target
                sources = []
                for source in target_obj.get("sources") or []:
                    if isinstance(source, dict):
                        source_path = source.get("path") or source.get("compileGroupIndex")
                        if isinstance(source_path, str):
                            sources.append(normalize_path(source_path))
                    elif isinstance(source, str):
                        sources.append(normalize_path(source))
                target_type = str(target_obj.get("type") or target_ref.get("type") or "")
                targets.append(
                    {
                        "name": target_obj.get("name") or target_name,
                        "id": target_obj.get("id") or target_id,
                        "configuration": config_name,
                        "type": target_type,
                        "jsonFile": target_json_file or None,
                        "sourceFiles": sorted(set(sources)),
                    }
                )

    focus_path = normalize_path(focus or "")
    matching_targets = [
        target
        for target in targets
        if focus_path
        and any(_path_matches(source, focus_path) for source in target.get("sourceFiles", []))
    ]
    executable_matches = [
        target for target in matching_targets if str(target.get("type") or "").upper() == "EXECUTABLE"
    ]
    selected: Optional[dict] = None
    method = "no_matching_target"
    status = "unmatched"
    reason_codes: list[str] = []
    if len(executable_matches) == 1:
        selected = executable_matches[0]
        method = "single_executable_target_containing_focus"
        status = "selected"
    elif len(executable_matches) > 1:
        method = "ambiguous_executable_targets_containing_focus"
        status = "ambiguous"
        reason_codes.append("target_resolution_ambiguous")
    elif len(matching_targets) == 1:
        selected = matching_targets[0]
        method = "single_target_containing_focus"
        status = "selected"
    elif len(matching_targets) > 1:
        method = "ambiguous_targets_containing_focus"
        status = "ambiguous"
        reason_codes.append("target_resolution_ambiguous")
    elif targets:
        reason_codes.append("target_resolution_unmatched")
    else:
        status = "missing"
        method = "cmake_targets_missing"
        reason_codes.append("cmake_targets_missing")

    return {
        "status": "available",
        "codemodelHash": stable_hash(
            {path: content_hash(content) for path, content in sorted(reply_files.items())}
        ),
        "targetCount": len(targets),
        "targets": targets,
        "errors": parse_errors,
        "targetResolution": {
            "status": status,
            "method": method,
            "selectedTarget": selected,
            "matchingTargets": matching_targets,
            "reasonCodes": reason_codes,
        },
    }


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


def _compile_command_file(entry: Mapping[str, Any]) -> str:
    return normalize_path(str(entry.get("file") or ""))


def _selected_compile_command(
    source_files: Mapping[str, str],
    focus: Optional[str],
) -> dict:
    status, entries, error = _parse_compile_commands(source_files)
    compile_db_hash = stable_hash(entries) if entries else None
    if status != "available":
        return {
            "status": status,
            "source": "compile_commands.json",
            "error": error,
            "compileDatabaseHash": compile_db_hash,
        }

    focus_path = normalize_path(focus or "")
    source_priorities = {
        normalize_path(path): _reason_and_priority(path, source, focus)[0]
        for path, source in source_files.items()
        if looks_like_source_file(path)
    }
    ranked_sources = sorted(source_priorities.items(), key=lambda item: (item[1], item[0]))

    selected: Optional[Mapping[str, Any]] = None
    if focus_path:
        selected = next((entry for entry in entries if _path_matches(_compile_command_file(entry), focus_path)), None)
    if selected is None:
        for source_path, _priority in ranked_sources:
            selected = next(
                (entry for entry in entries if _path_matches(_compile_command_file(entry), source_path)),
                None,
            )
            if selected is not None:
                break

    if selected is None:
        return {
            "status": "unmatched",
            "source": "compile_commands.json",
            "entryCount": len(entries),
            "candidateSourceFiles": [path for path, _priority in ranked_sources[:16]],
            "compileDatabaseHash": compile_db_hash,
        }

    args = _command_arguments(selected)
    selected_file = _compile_command_file(selected)
    duplicate_count = sum(1 for entry in entries if _compile_command_file(entry) == selected_file)
    return {
        "status": "selected",
        "source": "compile_commands.json",
        "file": selected_file,
        "directory": str(selected.get("directory") or ""),
        "compiler": args[0].rsplit("/", 1)[-1] if args else None,
        "argumentsHash": stable_hash(args),
        "effectiveFlagsHash": stable_hash(args[1:] if len(args) > 1 else []),
        "compileDatabaseHash": compile_db_hash,
        "entryCount": len(entries),
        "duplicateCommandCount": duplicate_count,
        "usesArgumentsField": isinstance(selected.get("arguments"), list),
    }


def build_source_context_report(
    source_files: Mapping[str, str],
    *,
    focus: Optional[str] = None,
    max_chars: int = DEFAULT_CONTEXT_MAX_CHARS,
    per_file_max_chars: int = DEFAULT_CONTEXT_PER_FILE_MAX_CHARS,
) -> dict:
    normalized_files = {
        normalize_path(path): source
        for path, source in source_files.items()
        if normalize_path(path)
    }
    candidates: List[dict] = []
    dropped: List[dict] = []

    for path, source in sorted(normalized_files.items()):
        static_drop = _drop_reason(path)
        priority, reason = _reason_and_priority(path, source, focus)
        record = {
            "path": path,
            "reason": reason,
            "priority": priority,
            "bytes": len(source.encode("utf-8")),
            "contentHash": content_hash(source),
        }
        if static_drop:
            dropped.append({**record, "dropReason": static_drop})
        elif priority >= 99:
            dropped.append({**record, "dropReason": "unsupported_file_type"})
        else:
            candidates.append(record)

    candidates.sort(key=lambda item: (item["priority"], item["path"]))

    included: List[dict] = []
    prompt_chars = 0
    for record in candidates:
        source = normalized_files.get(record["path"], "")
        body = source.strip()
        truncated = len(body) > per_file_max_chars
        if truncated:
            body = body[:per_file_max_chars] + "\n/* ... file truncated for prompt budget ... */"
        block_chars = len(body) + len(record["path"]) + 32
        if prompt_chars + block_chars > max_chars:
            dropped.append({**record, "dropReason": "prompt_budget_exclusion"})
            continue
        included.append(
            {
                **record,
                "promptBytes": len(body.encode("utf-8")),
                "truncated": truncated,
                "includeReason": record["reason"],
            }
        )
        prompt_chars += block_chars

    critical_dropped = [
        item
        for item in dropped
        if item.get("dropReason") == "prompt_budget_exclusion"
        and int(item.get("priority", 99)) <= 4
    ]
    device_translation_units = [
        {
            "path": item["path"],
            "contentHash": item["contentHash"],
            "includedInPrompt": any(included_item["path"] == item["path"] for included_item in included),
        }
        for item in candidates
        if item.get("reason") == "device_translation_unit"
    ]
    multi_device_tu = len(device_translation_units) > 1
    selected_command = _selected_compile_command(normalized_files, focus)
    cmake_file_api = _cmake_file_api_report(normalized_files, focus)
    template_evidence = _template_evidence_report(
        normalized_files,
        selected_command,
        cmake_file_api,
    )
    graphics_backend = _graphics_backend_report(
        normalized_files,
        focus=focus,
        cmake_file_api=cmake_file_api,
    )
    report = {
        "schemaVersion": SOURCE_CONTEXT_SCHEMA_VERSION,
        "focus": normalize_path(focus or ""),
        "workspaceFileCount": len(normalized_files),
        "candidateFileCount": len(candidates),
        "includedFileCount": len(included),
        "droppedFileCount": len(dropped),
        "included": included,
        "dropped": sorted(dropped, key=lambda item: (item.get("dropReason", ""), item["path"])),
        "criticalDropped": critical_dropped,
        "deterministicContextComplete": not critical_dropped,
        "deviceTuTopology": {
            "deviceTranslationUnitCount": len(device_translation_units),
            "deviceTranslationUnits": device_translation_units,
            "multiDeviceTu": multi_device_tu,
            "supportStatus": (
                "single_device_tu"
                if not multi_device_tu
                else "multi_device_tu_requires_topology_verification"
            ),
            "reasonCodes": (
                []
                if not multi_device_tu
                else ["multi_device_tu_requires_topology_verification"]
            ),
        },
        "graphicsBackend": graphics_backend,
        "promptBudget": {
            "maxChars": max_chars,
            "perFileMaxChars": per_file_max_chars,
            "usedChars": prompt_chars,
        },
        "buildMetadata": {
            "compileCommandsStatus": selected_command.get("status"),
            "compileDbHash": selected_command.get("compileDatabaseHash"),
            "cmakeFileApiStatus": cmake_file_api.get("status"),
            "selectedCompileCommand": selected_command,
            "cmakeFileApi": cmake_file_api,
            "cmakeCodemodelHash": cmake_file_api.get("codemodelHash"),
            "targetResolution": cmake_file_api.get("targetResolution"),
            "templateEvidence": template_evidence.get("evidence"),
            "templateEvidenceStatus": template_evidence.get("status"),
            "templateEvidenceHash": template_evidence.get("evidenceHash"),
            "templateEvidenceCandidateCount": template_evidence.get("candidateCount"),
            "templateEvidenceCompileCommands": template_evidence.get(
                "acceptedCompileCommandIdentities"
            ),
            "templateEvidenceInvalidationReasons": template_evidence.get(
                "invalidationReasons"
            ),
        },
    }
    report["sourceContextHash"] = stable_hash(
        {
            "focus": report["focus"],
            "included": [
                {
                    "path": item["path"],
                    "reason": item["includeReason"],
                    "contentHash": item["contentHash"],
                    "truncated": item["truncated"],
                }
                for item in included
            ],
            "selectedCompileCommand": selected_command,
        }
    )
    return report


def format_source_context_prompt(report: Mapping[str, Any], source_files: Mapping[str, str]) -> str:
    included = report.get("included")
    if not isinstance(included, list) or not included:
        return ""

    normalized_files = {normalize_path(path): source for path, source in source_files.items()}
    prompt_budget = report.get("promptBudget") if isinstance(report.get("promptBudget"), dict) else {}
    per_file_max_chars = int(prompt_budget.get("perFileMaxChars") or DEFAULT_CONTEXT_PER_FILE_MAX_CHARS)
    lines = [
        "# FULL ORDINARY PROJECT SOURCE CONTEXT",
        (
            f"The worker delivered {report.get('workspaceFileCount', 0)} user file(s). "
            f"The deterministic selector included {len(included)} file(s) and "
            f"dropped {report.get('droppedFileCount', 0)} file(s) with explicit reasons."
        ),
        "Do not assume the active editor file is the whole project.",
        f"Source context hash: {report.get('sourceContextHash', '')}.",
    ]

    selected = (
        report.get("buildMetadata", {})
        if isinstance(report.get("buildMetadata"), dict)
        else {}
    ).get("selectedCompileCommand", {})
    if isinstance(selected, dict) and selected.get("status") == "selected":
        lines.append(
            "Selected compile command: "
            f"{selected.get('compiler')} for {selected.get('file')} "
            f"(flags hash {selected.get('effectiveFlagsHash')})."
        )
    else:
        lines.append(
            "Selected compile command: unavailable; preserve source semantics and rely on the manifest contract."
        )
    target_resolution = (
        report.get("buildMetadata", {})
        if isinstance(report.get("buildMetadata"), dict)
        else {}
    ).get("targetResolution", {})
    if isinstance(target_resolution, dict):
        selected_target = target_resolution.get("selectedTarget")
        if isinstance(selected_target, dict) and target_resolution.get("status") == "selected":
            lines.append(
                "Resolved CMake target: "
                f"{selected_target.get('name')} "
                f"({target_resolution.get('method')}, configuration={selected_target.get('configuration')})."
            )
        elif target_resolution.get("status") == "ambiguous":
            lines.append(
                "CMake target resolution is ambiguous; do not guess target-specific flags or sources."
            )
    graphics_backend = report.get("graphicsBackend")
    if isinstance(graphics_backend, dict):
        primary = graphics_backend.get("primary")
        if primary:
            lines.append(
                "Graphics backend: "
                f"{primary} (status={graphics_backend.get('supportStatus')}, "
                f"reasonCodes={','.join(graphics_backend.get('reasonCodes') or []) or 'none'})."
            )
        if graphics_backend.get("supportStatus") == "unsupported":
            lines.append(
                "This graphics backend is unsupported for GPU HMR unless a deterministic ownership model exists; do not claim hot reload support."
            )
    template_evidence = (
        report.get("buildMetadata", {})
        if isinstance(report.get("buildMetadata"), dict)
        else {}
    ).get("templateEvidence")
    if isinstance(template_evidence, dict):
        lines.append(
            "Template evidence: "
            f"status={template_evidence.get('status')} "
            f"producer={template_evidence.get('producer')} "
            f"entries={len(template_evidence.get('entries') or [])}. "
            "Use it only as deterministic metadata; verifier policy owns safety."
        )

    for item in included:
        if not isinstance(item, dict):
            continue
        path = normalize_path(str(item.get("path") or ""))
        source = normalized_files.get(path, "").strip()
        if len(source) > per_file_max_chars:
            source = source[:per_file_max_chars] + "\n/* ... file truncated for prompt budget ... */"
        lines.append(
            f"```cpp\n// FILE: {path}\n// INCLUDE_REASON: {item.get('includeReason')}\n{source}\n```"
        )
    if report.get("criticalDropped"):
        lines.append("Critical source context was dropped; do not claim deterministic context completeness.")
    return "\n\n".join(lines)


def build_project_source_context(
    source_files: Mapping[str, str],
    *,
    focus: Optional[str] = None,
    max_chars: int = DEFAULT_CONTEXT_MAX_CHARS,
    per_file_max_chars: int = DEFAULT_CONTEXT_PER_FILE_MAX_CHARS,
) -> Tuple[str, dict]:
    report = build_source_context_report(
        source_files,
        focus=focus,
        max_chars=max_chars,
        per_file_max_chars=per_file_max_chars,
    )
    return format_source_context_prompt(report, source_files), report
