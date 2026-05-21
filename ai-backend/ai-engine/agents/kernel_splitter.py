"""Kernel Splitter Agent — single LLM call producing the 5-file GPU split.

Spec: docs/GPU_HMR_ULTRAPLAN.md §5.6 item 2.

Inputs:

  - `user_code`: the single-file C++ application the user wrote, with
    GPU kernels in-line.
  - `provider`: an `AiProvider` from `llm/providers/base.py` (gemini /
    chatgpt / anthropic). Caller does provider selection.
  - `model` / `api_key`: forwarded as-is to `provider.ask_llm`.
  - `vendor_hint`: from `gpu_detect.detect_project` — used only for
    prompt context (to nudge the AI toward the right manifest fields);
    the AI's manifest is authoritative.

Output (`KernelSplitResult`):

  - `files`: dict[str, str] of the 5 split files,
  - `manifest`: dict — the raw <synthi_build_manifest> JSON, including
    the `gpu` sub-block,
  - `architecture_md`: the markdown architectural overview from
    `<synthi_arch_cache>` minus the structured sub-blocks,
  - `kernel_hashes`: dict[kernel_name, hash_hex] from
    `<synthi_kernel_hashes>`,
  - `launch_graph`: list of launch-site records from
    `<synthi_launch_graph>`,
  - `verification`: `verifier_gpu.SplitVerificationResult` — `.ok=False`
    means the AI broke a structural rule and the caller should retry.

The agent does NOT validate the manifest with `validate_manifest_v1` —
that's the caller's job (`main.py` already does it for the host
manifest, and the same call covers the GPU sub-block).
"""

from __future__ import annotations

import hashlib
import json
import os
import posixpath
import re
from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Any, Dict, Iterable, List, Mapping, Optional, Sequence

from agents.gpu_detect import GpuDetectionResult
from agents.gpu_split_repair import repair_split_artifacts
from agents.gpu_source_context import build_project_source_context
from llm.prompts import GPU_SPLIT_PROMPT
from verifier_gpu import SplitVerificationResult, Violation, verify_split_output

if TYPE_CHECKING:  # avoid pulling the provider factory + its heavy SDK deps
    # at module-import time. The runtime `provider` parameter is duck-typed
    # against `AiProvider.ask_llm` so tests can pass a stub without
    # installing `google.generativeai` / `anthropic` etc.
    from llm.providers.base import AiProvider


# ─────────────────────────────────────────────────────────────────────────────
# Result type
# ─────────────────────────────────────────────────────────────────────────────


@dataclass
class KernelSplitResult:
    files: Dict[str, str]
    manifest: Optional[dict]
    architecture_md: str
    kernel_hashes: Dict[str, str] = field(default_factory=dict)
    launch_graph: List[dict] = field(default_factory=list)
    source_context_report: dict = field(default_factory=dict)
    verification: Optional[SplitVerificationResult] = None
    repair_report: dict = field(default_factory=dict)
    raw_response: str = ""

    def to_dict(self) -> dict:
        return {
            "files": self.files,
            "manifest": self.manifest,
            "architecture_md": self.architecture_md,
            "kernel_hashes": self.kernel_hashes,
            "launch_graph": self.launch_graph,
            "source_context_report": self.source_context_report,
            "verification": self.verification.to_dict() if self.verification else None,
            "repair_report": self.repair_report,
        }


class KernelSplitterError(Exception):
    """Raised when the AI response is unparseable or fails the verifier
    and no fallback is appropriate. Callers convert into HTTPException(422).
    """


class KernelSplitterUnsupportedProjectError(KernelSplitterError):
    """Raised when deterministic source metadata rejects the project shape
    before any AI proposal is requested.
    """

    def __init__(
        self,
        reason_code: str,
        message: str,
        *,
        source_context_report: Optional[Mapping[str, Any]] = None,
    ):
        self.reason_code = reason_code
        self.source_context_report = dict(source_context_report or {})
        super().__init__(message)


class KernelSplitProviderError(Exception):
    """Raised when the upstream AI provider fails before producing a split."""

    def __init__(self, original: BaseException):
        self.original = original
        message = (
            f"{type(original).__name__}: {original}"
            if str(original)
            else type(original).__name__
        )
        super().__init__(message)


def split_provider_failure_verification(exc: BaseException) -> SplitVerificationResult:
    """Represent an AI provider failure as reason-coded split evidence."""

    original = exc.original if isinstance(exc, KernelSplitProviderError) else exc
    err_type = type(original).__name__
    message = str(original)
    lowered = f"{err_type} {message}".lower()
    if isinstance(original, TimeoutError) or "timeout" in lowered:
        rule = "ai_provider_timeout"
    elif "rate limit" in lowered or "429" in lowered:
        rule = "ai_provider_rate_limited"
    elif "unavailable" in lowered or "overload" in lowered or "503" in lowered:
        rule = "ai_provider_unavailable"
    else:
        rule = "ai_provider_error"
    detail = f"{err_type}: {message}" if message else err_type
    return split_failure_verification(rule, detail)


# ─────────────────────────────────────────────────────────────────────────────
# Extraction
# ─────────────────────────────────────────────────────────────────────────────


def split_attempt_record(
    *,
    attempt: int,
    max_attempts: int,
    model: Optional[str],
    prompt: Optional[str],
    source_files: Iterable[str],
    verification: Optional[SplitVerificationResult],
    repair_prompt: bool = False,
    repair_report: Optional[Mapping[str, Any]] = None,
) -> dict:
    """Return persisted metadata for one propose -> verify split attempt."""

    prompt_hash = hashlib.sha256((prompt or "").encode("utf-8")).hexdigest()
    ok = bool(verification.ok if verification else True)
    reason_codes = [v.rule for v in verification.violations] if verification else []
    violations = [v.to_dict() for v in verification.violations] if verification else []
    return {
        "attempt": attempt,
        "maxAttempts": max_attempts,
        "phase": "repair_verify" if repair_prompt else "propose_verify",
        "model": model,
        "promptHash": prompt_hash,
        "sourceFiles": sorted({str(path).replace("\\", "/") for path in source_files}),
        "repairScope": "generated_artifacts_only" if repair_prompt else None,
        "repairReport": dict(repair_report or {}),
        "accepted": ok,
        "verifiers": [
            {
                "name": "generated_role_schema_mapping",
                "status": "pass" if ok else "fail",
                "reasonCodes": reason_codes,
                "violations": violations,
            },
            {
                "name": "compile",
                "status": "pending_worker",
                "reasonCodes": [],
            },
            {
                "name": "runtime_screenshot",
                "status": "pending_worker",
                "reasonCodes": [],
            },
        ],
    }


def split_agentic_report(
    *,
    attempts: Sequence[Mapping[str, Any]],
    accepted: bool,
    max_attempts: int,
) -> dict:
    attempts_list = [dict(a) for a in attempts]
    return {
        "schemaVersion": "synthi.gpu.agentic_split.v1",
        "mode": "full_split",
        "attemptCount": len(attempts_list),
        "maxAttempts": max_attempts,
        "boundedRetries": True,
        "accepted": bool(accepted),
        "persistedAfterVerification": bool(accepted),
        "repairScope": "generated_artifacts_only",
        "attempts": attempts_list,
    }


def split_failure_verification(rule: str, message: str) -> SplitVerificationResult:
    """Represent a failed split proposal as deterministic verifier output."""

    return SplitVerificationResult(
        ok=False,
        violations=[
            Violation(
                rule=rule,
                message=message,
            )
        ],
    )


def _rejected_project_headers(rejection_notes: Sequence[str]) -> List[str]:
    headers: set[str] = set()
    for note in rejection_notes:
        for match in re.finditer(r"project header ['\"]([^'\"]+)['\"]", note):
            header = match.group(1).strip().replace("\\", "/")
            if header:
                headers.add(header)
    return sorted(headers)


def _retry_remediation_playbook(rejection_notes: Sequence[str]) -> str:
    joined = "\n".join(rejection_notes)
    guidance: List[str] = []
    if "generated_role_includes_project_header" in joined:
        guidance.append(
            "- Inline/adapt every quoted project header into generated role code; generated roles may quote-include only emitted role files or synthi_gpu_runtime.h."
        )
        rejected_headers = _rejected_project_headers(rejection_notes)
        if rejected_headers:
            guidance.append(
                "- The verifier rejected these original workspace headers as generated-role includes: "
                + ", ".join(f"`{header}`" for header in rejected_headers)
                + ". Do not emit any `#include` for them; copy/adapt the required declarations instead."
            )
    if "source_device_identifier_not_" in joined or "source_device_constant_" in joined:
        guidance.append(
            "- Copy device constants and helper bodies into device.hip/device.cu and keep actual reads of those identifiers in the preserved kernel body."
        )
    if "host_visible_mirror_not_initialized_for_render" in joined:
        guidance.append(
            "- In core_on_load, immediately fill every host-visible mirror that gui_on_render reads with varied on-screen values from the user's setup math."
        )
    if "gui_render_placeholder" in joined or "gui_render_no_effect" in joined:
        guidance.append(
            "- Replace placeholder render comments or stubs with concrete drawing commands for the source backend. gui_on_render must update the supplied render surface/context and produce visible non-black pixels on the first frame."
        )
    if "render_backend_changed" in joined:
        guidance.append(
            "- Preserve the source render backend exactly. If the source context reports GLFW/OpenGL, raylib, SFML, SDL, ImGui, or Vulkan, do not translate to another backend; generated gui.cpp and host_runner.cpp must use that same backend's runner-supplied surface/context."
        )
    if "device_init_kernel_incomplete" in joined:
        guidance.append(
            "- The init/seed kernel launch and signature must include every device pointer passed to update kernels, and the init body must write each pointer."
        )
    if "kernel_launch_abi_mismatch" in joined:
        guidance.append(
            "- For each synthi_gpu_launch call, make the host initializer-list match the generated kernel parameter list exactly. If the kernel takes a LaunchParams-style struct, create one host variable and pass its address as a single argument; otherwise flatten the kernel signature to match the host launch ABI."
        )
    if "generated.host_state_type_not_shared" in joined:
        guidance.append(
            "- Define the host-visible state record exactly once in shared.h; core.cpp, gui.cpp, and host_runner.cpp must include shared.h and use that type."
        )
    if "generated.shared_namespace_symbol_unqualified" in joined:
        guidance.append(
            "- If shared.h puts constants or types in a namespace, qualify every use in core.cpp/gui.cpp/host_runner.cpp or import them explicitly."
        )
    if "host_runner_omits_gui_module" in joined:
        guidance.append(
            "- host_runner.cpp must load/resolve gui_on_load and gui_on_render, store the resolved render function pointer, and invoke it on the core state every frame before presenting. Marker variables or dead references such as `auto gui_on_render = libgui` do not satisfy this contract. Use a real shape like `using GuiRenderFn = void (*)(void*); auto gui_render = reinterpret_cast<GuiRenderFn>(dlsym(libgui, \"gui_on_render\")); ... if (gui_render) { gui_render(core_state); }`."
        )
    if not guidance:
        return ""
    return "Verifier-specific repair checklist:\n" + "\n".join(guidance)


def _verifier_acceptance_gate_contract() -> str:
    return "\n".join(
        [
            "# GPU SPLIT VERIFIER ACCEPTANCE GATES",
            "- Generated role files must be self-contained. Quoted includes may only target emitted Synthi role files or synthi_gpu_runtime.h; original workspace/project headers must be copied or adapted into generated roles.",
            "- host_runner.cpp must resolve core_on_load/core_on_update and gui_on_load/gui_on_render from the generated modules, store the function pointers, call core_on_update, then call gui_on_render with the core state before the backend presents each frame. A valid runner has a real `void* core_state` returned from core_on_load and calls a resolved render pointer such as `gui_render(core_state);` inside the frame loop.",
            "- gui_on_render must contain executable backend drawing code, not TODOs, placeholder comments, or 'rendering logic' stubs. It must draw visible non-black output through the original project's render backend.",
            "- Generated GUI and runner code must not switch frameworks. Preserve the source render backend reported by deterministic context selection.",
            "- Device kernels and runtime-compiled kernel headers selected by source context must keep original kernel names and body semantics so later user body edits can map into the generated device role.",
        ]
    )


def build_split_retry_prompt(
    base_prompt: Optional[str],
    rejection_notes: Sequence[str],
) -> str:
    notes = "\n".join(note for note in rejection_notes if note.strip())
    playbook = _retry_remediation_playbook(rejection_notes)
    repair_instruction = (
        "The previous GPU split attempt failed Synthi's deterministic "
        "verifiers. Regenerate the complete GPU role split and fix all "
        "violations exactly. Do not repeat any rejected pattern:\n"
        f"{notes}"
    )
    return "\n\n".join(p for p in [base_prompt, repair_instruction, playbook] if p)


_JSON_BLOCK_RE = re.compile(r"<JSON>(?P<body>.*?)</JSON>", re.DOTALL)
_ARCH_BLOCK_RE = re.compile(
    r"<synthi_arch_cache>(?P<body>.*?)</synthi_arch_cache>", re.DOTALL
)
_MANIFEST_BLOCK_RE = re.compile(
    r"<synthi_build_manifest>(?P<body>.*?)</synthi_build_manifest>", re.DOTALL
)
_KERNEL_HASHES_BLOCK_RE = re.compile(
    r"<synthi_kernel_hashes>(?P<body>.*?)</synthi_kernel_hashes>", re.DOTALL
)
_LAUNCH_GRAPH_BLOCK_RE = re.compile(
    r"<synthi_launch_graph>(?P<body>.*?)</synthi_launch_graph>", re.DOTALL
)

_ROLE_FILENAMES = {
    "shared": "shared.h",
    "core": "core.cpp",
    "gui": "gui.cpp",
    "host_runner": "host_runner.cpp",
    "device": "device.cu",
}
_SOURCE_GLOBAL_KERNEL_RE = re.compile(
    r"\b(?:"
    r"__global__\s+(?:void\s+)?"
    r"|GLOBAL_KERNEL_SIGNATURE\s*\([^)]*\)\s+(?:__launch_bounds__\s*\([^)]*\)\s*)?"
    r")([A-Za-z_][A-Za-z0-9_]*)\s*\("
)
_GPU_DEVICE_MARKER_RE = re.compile(
    r"\b(?:"
    r"__(?:global|device|constant|managed|host)__"
    r"|GLOBAL_KERNEL_SIGNATURE\s*\("
    r"|HIPRT_(?:DEVICE|HOST_DEVICE)\b"
    r"|oroModuleLaunchKernel\b"
    r"|hiprtc(?:CreateProgram|CompileProgram|GetCode|GetBitcode)\b"
    r"|cuModuleLaunchKernel\b"
    r")",
    re.I,
)
_SOURCE_DEVICE_IDENTIFIER_RE = re.compile(r"\bk[A-Z][A-Za-z0-9_]*\b")
_QUOTE_INCLUDE_RE = re.compile(r"#\s*include\s+\"(?P<path>[^\"]+)\"")
_PROJECT_CONTEXT_MAX_CHARS = 70000
_PROJECT_CONTEXT_PER_FILE_MAX_CHARS = 3000
_DEVICE_PRESERVATION_TOTAL_MAX_CHARS = 160000
_DEVICE_PRESERVATION_PER_FILE_MAX_CHARS = 8000


def _looks_like_source_file(name: str) -> bool:
    return bool(re.search(r"\.(?:h|hpp|hh|cpp|cc|cxx|cu|hip)$", name.replace("\\", "/"), re.I))


def _has_gpu_device_marker(source: str) -> bool:
    return bool(_GPU_DEVICE_MARKER_RE.search(source or "") or ("<<<" in source and ">>>" in source))


def _extract_embedded_source_object(value: str) -> Optional[str]:
    """Unwrap model slips like '{"file_content": "...source..."}'.

    Gemini occasionally returns a JSON-looking object as the value for a
    filename. If the nested string contains literal newlines, `json.loads`
    rejects it even though the source itself is recoverable.
    """

    stripped = value.strip()
    if not stripped.startswith("{"):
        return None
    match = re.search(
        r'"(?:content|file_content|source)"\s*:\s*"(?P<body>.*)"\s*(?:,|\})',
        stripped,
        re.DOTALL,
    )
    if not match:
        return None
    body = match.group("body")
    try:
        return json.loads('"' + body.replace("\n", "\\n").replace("\r", "\\r") + '"')
    except json.JSONDecodeError:
        return (
            body
            .replace(r"\\", "\\")
            .replace(r"\"", '"')
            .replace(r"\n", "\n")
            .replace(r"\r", "\r")
            .replace(r"\t", "\t")
        )


def _normalise_file_map(files: Mapping[str, Any]) -> Dict[str, str]:
    """Accept common LLM file-map variants and return filename -> source."""

    out: Dict[str, str] = {}

    def add(name: str, value: Any) -> None:
        clean_name = str(name).strip().replace("\\", "/")
        if clean_name in _ROLE_FILENAMES:
            clean_name = _ROLE_FILENAMES[clean_name]
        if isinstance(value, str) and value.strip().startswith("{"):
            try:
                decoded = json.loads(value)
            except json.JSONDecodeError:
                decoded = None
            if isinstance(decoded, Mapping):
                add(clean_name, decoded)
                return
            embedded = _extract_embedded_source_object(value)
            if embedded and _looks_like_source_file(clean_name):
                out[clean_name] = embedded
                return
        if isinstance(value, str) and value.strip() and _looks_like_source_file(clean_name):
            out[clean_name] = value
        elif isinstance(value, Mapping):
            filename = value.get("filename") or value.get("path") or value.get("name")
            content = value.get("content") or value.get("file_content") or value.get("source")
            if filename and isinstance(content, str) and content.strip():
                out[str(filename).strip().replace("\\", "/")] = content
                return
            if isinstance(content, str) and content.strip() and _looks_like_source_file(clean_name):
                out[clean_name] = content
                return
            for nested_name, nested_value in value.items():
                if _looks_like_source_file(str(nested_name)):
                    add(str(nested_name), nested_value)

    for key, value in files.items():
        add(str(key), value)
    return out


def _source_file_map(files: Optional[Sequence[Mapping[str, Any]]]) -> Dict[str, str]:
    out: Dict[str, str] = {}
    if not files:
        return out
    for index, item in enumerate(files):
        if isinstance(item, Mapping):
            name = item.get("path") or item.get("name") or item.get("filename")
            content = item.get("content") or item.get("source") or item.get("file_content")
        else:
            name = (
                getattr(item, "path", None)
                or getattr(item, "name", None)
                or getattr(item, "filename", None)
            )
            content = (
                getattr(item, "content", None)
                or getattr(item, "source", None)
                or getattr(item, "file_content", None)
            )
        if not name:
            name = f"input-{index}.cpp"
        if isinstance(content, str) and content.strip():
            out[str(name).strip().replace("\\", "/")] = content
    return out


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
        normalized = posixpath.normpath(candidate.replace("\\", "/"))
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


def _device_reachable_source_files(
    source_files: Mapping[str, str],
    roots: Optional[Sequence[str]] = None,
) -> Dict[str, str]:
    normalized = {path.replace("\\", "/"): source for path, source in source_files.items()}
    if roots:
        root_paths = sorted(
            path.replace("\\", "/")
            for path in roots
            if path and path.replace("\\", "/") in normalized
        )
    else:
        root_paths = sorted(
            path
            for path, source in normalized.items()
            if _looks_like_source_file(path) and _has_gpu_device_marker(source)
        )
    reachable: Dict[str, str] = {}
    queue = list(root_paths)
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
            if resolved and resolved not in reachable and _looks_like_source_file(resolved):
                queue.append(resolved)
    return {path: reachable[path] for path in sorted(reachable)}


def _device_roots_from_context_report(source_context_report: Mapping[str, Any]) -> List[str]:
    topology = source_context_report.get("deviceTuTopology")
    units = topology.get("deviceTranslationUnits") if isinstance(topology, Mapping) else None
    if not isinstance(units, list):
        return []
    roots = []
    for unit in units:
        if isinstance(unit, Mapping) and unit.get("path"):
            roots.append(str(unit["path"]).replace("\\", "/"))
    return roots


def _source_files_scoped_to_context(
    source_files: Mapping[str, str],
    source_context_report: Mapping[str, Any],
) -> Dict[str, str]:
    normalized = {path.replace("\\", "/"): source for path, source in source_files.items()}
    included = source_context_report.get("included")
    scoped_paths = {
        str(item.get("path")).replace("\\", "/")
        for item in included or []
        if isinstance(item, Mapping) and item.get("path")
    }
    roots = _device_roots_from_context_report(source_context_report)
    if roots:
        scoped_paths.update(_device_reachable_source_files(normalized, roots=roots))
    else:
        included_device_roots = [
            path
            for path in sorted(scoped_paths)
            if path in normalized and _looks_like_source_file(path) and _has_gpu_device_marker(normalized[path])
        ]
        if included_device_roots:
            scoped_paths.update(
                _device_reachable_source_files(normalized, roots=included_device_roots)
            )
    scoped = {
        path: normalized[path]
        for path in sorted(scoped_paths)
        if path in normalized
    }
    return scoped or dict(normalized)


def _source_device_preservation_contract(
    source_files: Mapping[str, str],
    roots: Optional[Sequence[str]] = None,
) -> str:
    device_sources = _device_reachable_source_files(source_files, roots=roots)
    if not device_sources:
        return ""
    kernels = sorted(
        {
            match.group(1)
            for source in device_sources.values()
            for match in _SOURCE_GLOBAL_KERNEL_RE.finditer(source)
        }
    )
    identifiers = sorted(
        {
            ident
            for source in device_sources.values()
            for ident in _SOURCE_DEVICE_IDENTIFIER_RE.findall(source)
        }
    )
    sections = [
        "# SOURCE DEVICE PRESERVATION CONTRACT",
        "The generated device role must copy/adapt the device-reachable user GPU source below, not summarize it.",
        "This includes selected .cu/.hip translation units, macro-wrapped kernel headers, runtime-compiled kernel sources, and quoted project headers reachable from them.",
        "Preserve original kernel names, non-empty kernel bodies, device helpers, constants, branches, boundary/reset logic, template helper math, and output writes.",
        "Do not include these original project headers from generated role files; inline/adapt the needed structs, constants, and helper function bodies into the generated roles.",
        "Do not emit dangling constant declarations, empty kernels, renamed kernels, or simplified substitute kernels.",
    ]
    if kernels:
        sections.append(f"Required original kernels: {', '.join(kernels)}.")
    if identifiers:
        sections.append(f"Required device identifiers/constants: {', '.join(identifiers)}.")
    root_set = {str(root).replace("\\", "/") for root in roots or []}

    def sort_key(item: tuple[str, str]) -> tuple[int, str]:
        path, source = item
        if path in root_set:
            return (0, path)
        if _SOURCE_GLOBAL_KERNEL_RE.search(source):
            return (1, path)
        if _has_gpu_device_marker(source):
            return (2, path)
        if "/kernels/" in path:
            return (3, path)
        return (4, path)

    used = sum(len(section) + 2 for section in sections)
    omitted: List[str] = []
    for path, source in sorted(device_sources.items(), key=sort_key):
        body = source
        if len(body) > _DEVICE_PRESERVATION_PER_FILE_MAX_CHARS:
            body = (
                body[:_DEVICE_PRESERVATION_PER_FILE_MAX_CHARS]
                + "\n/* ... file truncated for source-device preservation budget ... */"
            )
        block = f"```cpp\n// FILE: {path}\n{body}\n```"
        priority = sort_key((path, source))[0]
        if (
            priority > 0
            and used + len(block) + 2 > _DEVICE_PRESERVATION_TOTAL_MAX_CHARS
        ):
            omitted.append(path)
            continue
        sections.append(block)
        used += len(block) + 2
    if omitted:
        shown = ", ".join(omitted[:20])
        suffix = "" if len(omitted) <= 20 else f", and {len(omitted) - 20} more"
        sections.append(
            "Omitted lower-priority device-reachable files from this preservation prompt "
            f"because the deterministic prompt budget was reached: {shown}{suffix}. "
            "Reason: prompt-budget exclusion after device-anchor ranking."
        )
    return "\n".join(sections)


def _include_in_project_context(path: str, source: str) -> bool:
    normalized = path.replace("\\", "/")
    base = normalized.rsplit("/", 1)[-1]
    if base in {"CMakeLists.txt", "README.md"}:
        return True
    if normalized.startswith("src/") and _looks_like_source_file(normalized):
        return bool(source.strip())
    return False


def _project_context_sort_key(item: tuple[str, str], focus: Optional[str]) -> tuple[int, str]:
    path = item[0].replace("\\", "/")
    source = item[1]
    focus_path = (focus or "").replace("\\", "/")
    if focus_path and path == focus_path:
        return (0, path)
    if path == "CMakeLists.txt":
        return (1, path)
    if (path.startswith("src/gpu/") or path.startswith("src/kernels/") or "/kernels/" in path) and _has_gpu_device_marker(source):
        return (2, path)
    if path.startswith("src/app/"):
        return (3, path)
    if path.startswith("src/render/"):
        return (4, path)
    if path.startswith("src/config/") or path.startswith("src/math/"):
        return (5, path)
    if path.startswith("src/"):
        return (6, path)
    return (7, path)


def _project_source_context(source_files: Mapping[str, str], focus: Optional[str] = None) -> str:
    """Compact ordinary-project file context for the GPU split prompt.

    The worker already sends the full workspace payload. This helper makes the
    relevant source/config subset explicit inside the split prompt so the model
    does not only see the active editor file.
    """

    candidates = [
        (path.replace("\\", "/"), source)
        for path, source in source_files.items()
        if _include_in_project_context(path, source)
    ]
    if not candidates:
        return ""

    candidates.sort(key=lambda item: _project_context_sort_key(item, focus))
    sections = [
        "# FULL ORDINARY PROJECT SOURCE CONTEXT",
        (
            f"The worker delivered {len(source_files)} user file(s). "
            f"Use the {len(candidates)} source/config file(s) below as the "
            "ordinary user project context. They are not Synthi-generated role "
            "files; adapt their behavior into the generated HMR roles."
        ),
        "Do not assume the active editor file is the whole project.",
        (
            "Only source files containing actual GPU kernel/device markers "
            "(`__global__`, `__device__`, macro-wrapped kernel signatures, "
            "or runtime-compiled GPU kernel launch paths) are device-preservation "
            "anchors. Auxiliary `.hip`/`.cu` files without those markers are "
            "ordinary helper context; do not force every helper constant into "
            "the generated device role."
        ),
    ]
    used = sum(len(part) for part in sections)
    included = 0
    omitted = 0
    for path, source in candidates:
        body = source.strip()
        if len(body) > _PROJECT_CONTEXT_PER_FILE_MAX_CHARS:
            body = body[:_PROJECT_CONTEXT_PER_FILE_MAX_CHARS] + "\n/* ... file truncated for prompt budget ... */"
        block = f"```cpp\n// FILE: {path}\n{body}\n```"
        if used + len(block) + 2 > _PROJECT_CONTEXT_MAX_CHARS:
            omitted += 1
            continue
        sections.append(block)
        used += len(block) + 2
        included += 1
    if omitted:
        sections.append(f"Prompt budget omitted {omitted} lower-priority source/config file(s).")
    sections.append(f"Included source/config files in prompt: {included}.")
    return "\n\n".join(sections)


def _extract_block(pattern: re.Pattern, text: str) -> str:
    m = pattern.search(text)
    return m.group("body").strip() if m else ""


def _parse_json_block(label: str, body: str) -> Any:
    if not body:
        return None
    try:
        return json.loads(body)
    except json.JSONDecodeError as e:
        raise KernelSplitterError(
            f"{label} block is not valid JSON: {e}; first 200 chars: {body[:200]!r}"
        ) from e


def parse_kernel_split_response(raw: str) -> Dict[str, Any]:
    """Pure parser. Splits a raw LLM response into the structured parts.

    Doesn't run the verifier — caller composes parser + verifier so the
    parser is independently testable.
    """
    files_body = _extract_block(_JSON_BLOCK_RE, raw)
    if not files_body:
        raise KernelSplitterError(
            "Response missing <JSON>...</JSON> file block — AI did not follow the response format."
        )
    files = _parse_json_block("<JSON>", files_body)
    if not isinstance(files, dict):
        raise KernelSplitterError(
            "<JSON> block did not parse to a dict; "
            f"got {type(files).__name__}"
        )
    files = _normalise_file_map(files)
    if not files:
        raise KernelSplitterError("<JSON> block did not contain any source files")

    arch_body = _extract_block(_ARCH_BLOCK_RE, raw)
    manifest_body = _extract_block(_MANIFEST_BLOCK_RE, arch_body or raw)
    manifest = _parse_json_block("<synthi_build_manifest>", manifest_body) if manifest_body else None

    kernel_hashes_body = _extract_block(_KERNEL_HASHES_BLOCK_RE, arch_body or raw)
    kernel_hashes = _parse_json_block("<synthi_kernel_hashes>", kernel_hashes_body) or {}
    if not isinstance(kernel_hashes, dict):
        raise KernelSplitterError("<synthi_kernel_hashes> did not parse to a dict")

    launch_graph_body = _extract_block(_LAUNCH_GRAPH_BLOCK_RE, arch_body or raw)
    launch_graph = _parse_json_block("<synthi_launch_graph>", launch_graph_body) or []
    if not isinstance(launch_graph, list):
        raise KernelSplitterError("<synthi_launch_graph> did not parse to a list")

    # Architecture markdown is the arch cache body with the structured
    # sub-blocks stripped, so downstream consumers don't see them twice.
    architecture_md = arch_body
    for pat in (_MANIFEST_BLOCK_RE, _KERNEL_HASHES_BLOCK_RE, _LAUNCH_GRAPH_BLOCK_RE):
        architecture_md = pat.sub("", architecture_md)
    architecture_md = architecture_md.strip()

    return {
        "files": files,
        "manifest": manifest,
        "architecture_md": architecture_md,
        "kernel_hashes": {str(k): str(v) for k, v in kernel_hashes.items()},
        "launch_graph": launch_graph,
    }


# ─────────────────────────────────────────────────────────────────────────────
# Agent entry point
# ─────────────────────────────────────────────────────────────────────────────


def build_prompt(
    user_code: str,
    detection: Optional[GpuDetectionResult] = None,
    extra_instructions: Optional[str] = None,
) -> str:
    """Public helper — build the prompt body. Split out so tests can
    assert the substitutions without touching ask_llm."""
    prompt = GPU_SPLIT_PROMPT.replace("{USER_CODE}", user_code)
    hint_lines = []
    if detection is not None and detection.vendor_hint:
        hint_lines.append(
            f"# DETECTION HINT\nVendor hint from regex scan: "
            f"{detection.vendor_hint}. If your manifest disagrees, you "
            "MUST justify the choice in confidence.notes."
        )
    runtime_vendor = _runtime_vendor_hint()
    runtime_arch = _runtime_arch_hint()
    if runtime_vendor or runtime_arch:
        target_bits = []
        if runtime_vendor:
            target_bits.append(f"vendor={runtime_vendor}")
        if runtime_arch:
            target_bits.append(f"arch={runtime_arch}")
        hint_lines.append(
            "# RUNTIME GPU TARGET\n"
            f"Detected worker GPU target: {', '.join(target_bits)}. "
            "Use this target when the source is ambiguous. If the source "
            "explicitly uses CUDA or HIP APIs for another vendor, preserve "
            "that source target unless you can translate it cleanly and "
            "explain the choice in confidence.notes."
        )
    if extra_instructions:
        hint_lines.append(f"# EXTRA INSTRUCTIONS\n{extra_instructions}")
    if hint_lines:
        prompt = "\n\n".join(hint_lines) + "\n\n" + prompt
    return prompt


def _runtime_vendor_hint() -> Optional[str]:
    raw = (
        os.getenv("SYNTHI_GPU_VENDOR_HINT")
        or os.getenv("SYNTHI_GPU_VENDOR")
        or ""
    ).strip().lower()
    return raw if raw in {"cuda", "rocm"} else None


def _runtime_arch_hint() -> Optional[str]:
    raw = (
        os.getenv("SYNTHI_GPU_ARCH_HINT")
        or os.getenv("SYNTHI_GPU_ARCH")
        or ""
    ).strip()
    if not raw or raw.lower() == "auto":
        return None
    return raw


async def run_kernel_splitter(
    *,
    provider: "AiProvider",
    user_code: str,
    lang: str = "cpp",
    detection: Optional[GpuDetectionResult] = None,
    extra_instructions: Optional[str] = None,
    model: Optional[str] = None,
    api_key: Optional[str] = None,
    files: Optional[Sequence[Mapping[str, Any]]] = None,
    focus: Optional[str] = None,
) -> KernelSplitResult:
    """Run the Kernel Splitter Agent end-to-end.

    Side-effects: one call to `provider.ask_llm`. No filesystem writes —
    persistence is the caller's responsibility (matches the host split
    endpoint in `main.py`, which writes the sidecar after validation).

    Raises `KernelSplitterError` on unparseable output. Returns a result
    with `verification.ok == False` on a structural rule violation;
    callers decide whether to retry the prompt with the violations
    appended to `extra_instructions`.
    """
    source_map = _source_file_map(files)
    if focus and user_code:
        source_map.setdefault(str(focus).strip().replace("\\", "/"), user_code)
    project_context, source_context_report = build_project_source_context(
        source_map,
        focus=focus,
    )
    scoped_source_map = _source_files_scoped_to_context(
        source_map,
        source_context_report,
    )
    device_preservation_roots = _device_roots_from_context_report(source_context_report)
    graphics_backend = source_context_report.get("graphicsBackend")
    if isinstance(graphics_backend, dict) and graphics_backend.get("supportStatus") == "unsupported":
        reason_codes = graphics_backend.get("reasonCodes") or []
        reason_code = str(reason_codes[0] if reason_codes else "unsupported_project_shape")
        raise KernelSplitterUnsupportedProjectError(
            reason_code,
            (
                "GPU split unsupported for graphics backend "
                f"{graphics_backend.get('primary') or 'unknown'}: {','.join(reason_codes)}"
            ),
            source_context_report=source_context_report,
        )
    build_metadata = source_context_report.get("buildMetadata")
    target_resolution = (
        build_metadata.get("targetResolution")
        if isinstance(build_metadata, dict)
        else None
    )
    if isinstance(target_resolution, dict) and target_resolution.get("status") == "ambiguous":
        reason_codes = target_resolution.get("reasonCodes") or []
        reason_code = str(reason_codes[0] if reason_codes else "target_resolution_ambiguous")
        matching = target_resolution.get("matchingTargets") or []
        matching_names = [
            str(target.get("name"))
            for target in matching
            if isinstance(target, Mapping) and target.get("name")
        ]
        raise KernelSplitterUnsupportedProjectError(
            reason_code,
            (
                "GPU split requires one selected CMake target, but target "
                f"resolution is ambiguous via {target_resolution.get('method') or 'unknown'}"
                + (f": {', '.join(matching_names)}" if matching_names else "")
            ),
            source_context_report=source_context_report,
        )
    prompt = build_prompt(
        user_code,
        detection=detection,
        extra_instructions="\n\n".join(
            part
            for part in [
                extra_instructions,
                _verifier_acceptance_gate_contract(),
                project_context,
                _source_device_preservation_contract(
                    scoped_source_map,
                    roots=device_preservation_roots,
                ),
            ]
            if part
        ),
    )

    try:
        raw = await provider.ask_llm(
            user_code,
            lang,
            prompt,
            mode="split",
            files=files,
            focus=focus,
            model=model,
            api_key=api_key,
        )
    except Exception as exc:
        raise KernelSplitProviderError(exc) from exc

    parsed = parse_kernel_split_response(raw)
    arch_list: List[str] = []
    if isinstance(parsed["manifest"], dict):
        gpu_block = parsed["manifest"].get("gpu") or {}
        if isinstance(gpu_block, dict):
            arch_value = gpu_block.get("arch")
            if isinstance(arch_value, list):
                arch_list = [str(a) for a in arch_value]

    verification = verify_split_output(
        files=parsed["files"],
        manifest_arch=arch_list,
        manifest=parsed["manifest"] if isinstance(parsed["manifest"], dict) else None,
        source_files=scoped_source_map,
    )
    repair_report: dict = {
        "schemaVersion": "synthi.gpu.split_repair.v1",
        "repaired": False,
        "inputReasonCodes": [v.rule for v in verification.violations],
        "repairRules": [],
        "changedFiles": [],
        "scope": "generated_artifacts_only",
    }
    if not verification.ok:
        repaired_files, repair_report = repair_split_artifacts(
            files=parsed["files"],
            manifest=parsed["manifest"] if isinstance(parsed["manifest"], dict) else None,
            source_files=scoped_source_map,
            verification=verification,
        )
        if repair_report.get("repaired"):
            repaired_verification = verify_split_output(
                files=repaired_files,
                manifest_arch=arch_list,
                manifest=parsed["manifest"] if isinstance(parsed["manifest"], dict) else None,
                source_files=scoped_source_map,
            )
            parsed["files"] = repaired_files
            verification = repaired_verification

    return KernelSplitResult(
        files=parsed["files"],
        manifest=parsed["manifest"],
        architecture_md=parsed["architecture_md"],
        kernel_hashes=parsed["kernel_hashes"],
        launch_graph=parsed["launch_graph"],
        source_context_report=source_context_report,
        verification=verification,
        repair_report=repair_report,
        raw_response=raw,
    )
