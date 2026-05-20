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
_KERNEL_DECL_RE = re.compile(r"\b__(?:global|device|constant|managed)__\b")


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


def _selected_compile_command(
    source_files: Mapping[str, str],
    focus: Optional[str],
) -> dict:
    status, entries, error = _parse_compile_commands(source_files)
    if status != "available":
        return {
            "status": status,
            "source": "compile_commands.json",
            "error": error,
        }

    focus_path = normalize_path(focus or "")
    source_priorities = {
        normalize_path(path): _reason_and_priority(path, source, focus)[0]
        for path, source in source_files.items()
        if looks_like_source_file(path)
    }
    ranked_sources = sorted(source_priorities.items(), key=lambda item: (item[1], item[0]))

    def entry_file(entry: Mapping[str, Any]) -> str:
        return normalize_path(str(entry.get("file") or ""))

    def matches(candidate: str, target: str) -> bool:
        return candidate == target or candidate.endswith("/" + target) or target.endswith("/" + candidate)

    selected: Optional[Mapping[str, Any]] = None
    if focus_path:
        selected = next((entry for entry in entries if matches(entry_file(entry), focus_path)), None)
    if selected is None:
        for source_path, _priority in ranked_sources:
            selected = next((entry for entry in entries if matches(entry_file(entry), source_path)), None)
            if selected is not None:
                break

    if selected is None:
        return {
            "status": "unmatched",
            "source": "compile_commands.json",
            "entryCount": len(entries),
            "candidateSourceFiles": [path for path, _priority in ranked_sources[:16]],
        }

    args = _command_arguments(selected)
    selected_file = entry_file(selected)
    duplicate_count = sum(1 for entry in entries if entry_file(entry) == selected_file)
    return {
        "status": "selected",
        "source": "compile_commands.json",
        "file": selected_file,
        "directory": str(selected.get("directory") or ""),
        "compiler": args[0].rsplit("/", 1)[-1] if args else None,
        "argumentsHash": stable_hash(args),
        "effectiveFlagsHash": stable_hash(args[1:] if len(args) > 1 else []),
        "entryCount": len(entries),
        "duplicateCommandCount": duplicate_count,
        "usesArgumentsField": isinstance(selected.get("arguments"), list),
    }


def _cmake_file_api_status(source_files: Mapping[str, str]) -> str:
    if any(normalize_path(path).startswith(".cmake/api/v1/reply/") for path in source_files):
        return "available"
    if any(normalize_path(path).rsplit("/", 1)[-1] == "CMakeLists.txt" for path in source_files):
        return "cmake_project_file_api_missing"
    return "not_cmake_project"


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
    selected_command = _selected_compile_command(normalized_files, focus)
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
        "promptBudget": {
            "maxChars": max_chars,
            "perFileMaxChars": per_file_max_chars,
            "usedChars": prompt_chars,
        },
        "buildMetadata": {
            "compileCommandsStatus": selected_command.get("status"),
            "cmakeFileApiStatus": _cmake_file_api_status(normalized_files),
            "selectedCompileCommand": selected_command,
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
