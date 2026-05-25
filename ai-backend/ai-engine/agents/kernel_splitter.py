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

from agents.abi_stamper import mask_comments_for_parsing, stamp_device_source
from agents.gpu_detect import GpuDetectionResult
from agents.gpu_device_markers import GPU_DEVICE_MARKER_RE as _GPU_DEVICE_MARKER_RE
from agents.gpu_split_repair import REPAIR_SCHEMA_VERSION, repair_split_artifacts
from agents.gpu_source_context import build_project_source_context
from agents.launch_graph_extractor import launch_graph_as_dicts
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


MAX_DETERMINISTIC_REPAIR_PASSES = 4


def _reason_codes(verification: SplitVerificationResult) -> List[str]:
    return [violation.rule for violation in verification.violations]


def _append_unique(target: List[str], values: Sequence[Any]) -> None:
    for value in values:
        text = str(value)
        if text and text not in target:
            target.append(text)


def _apply_split_repairs_until_stable(
    *,
    files: Mapping[str, str],
    manifest: Optional[Mapping[str, Any]],
    manifest_arch: Sequence[str],
    source_files: Mapping[str, str],
    verification: SplitVerificationResult,
    max_passes: int = MAX_DETERMINISTIC_REPAIR_PASSES,
) -> tuple[Dict[str, str], SplitVerificationResult, dict]:
    """Apply deterministic generated-artifact repairs to a fixed point.

    A repair can expose a narrower verifier failure on the next pass. For
    example, replacing a generated device role with a source include bridge can
    turn a previously declared fake lifecycle kernel into an unresolved host
    launch. That follow-up launch removal is still deterministic and should run
    before asking the model for another split attempt.
    """

    current_files = {str(path): str(content) for path, content in files.items()}
    current_verification = verification
    aggregate: dict = {
        "schemaVersion": REPAIR_SCHEMA_VERSION,
        "repaired": False,
        "inputReasonCodes": [],
        "repairRules": [],
        "changedFiles": [],
        "scope": "generated_artifacts_only",
        "passes": [],
        "remainingReasonCodes": _reason_codes(current_verification),
    }

    for pass_index in range(max(0, max_passes)):
        if current_verification.ok:
            break

        repaired_files, pass_report = repair_split_artifacts(
            files=current_files,
            manifest=manifest,
            source_files=source_files,
            verification=current_verification,
        )
        pass_record = dict(pass_report)
        pass_record["pass"] = pass_index + 1
        _append_unique(
            aggregate["inputReasonCodes"],
            pass_report.get("inputReasonCodes", []),
        )

        if not pass_report.get("repaired"):
            pass_record["remainingReasonCodes"] = _reason_codes(current_verification)
            aggregate["passes"].append(pass_record)
            break

        current_files = repaired_files
        current_verification = verify_split_output(
            files=current_files,
            manifest_arch=manifest_arch,
            manifest=manifest,
            source_files=source_files,
        )
        pass_record["remainingReasonCodes"] = _reason_codes(current_verification)
        aggregate["passes"].append(pass_record)
        aggregate["repaired"] = True
        _append_unique(aggregate["repairRules"], pass_report.get("repairRules", []))
        _append_unique(aggregate["changedFiles"], pass_report.get("changedFiles", []))

    aggregate["remainingReasonCodes"] = _reason_codes(current_verification)
    return current_files, current_verification, aggregate


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


def split_repair_retry_notes(repair_report: Optional[Mapping[str, Any]]) -> List[str]:
    """Summarize deterministic repair side effects for the next split prompt."""

    if not isinstance(repair_report, Mapping):
        return []
    rules = [str(rule) for rule in repair_report.get("repairRules", []) if rule]
    remaining = [
        str(rule) for rule in repair_report.get("remainingReasonCodes", []) if rule
    ]
    if not rules:
        return []

    notes = [
        "- deterministic_repair_applied: "
        f"rules={', '.join(rules)}"
        + (f"; remaining={', '.join(remaining)}" if remaining else "")
    ]
    if "repair.source_launch_args" in rules:
        notes.append(
            "- repair.source_launch_args: Deterministic repair had to rewrite or remove source-reachable launches whose generated arguments did not match SOURCE LAUNCH GRAPH owner expressions. Regenerate core with those exact source owner variables available before synthi_gpu_launch(...); do not emit a launch that repair will remove again."
        )
    if "repair.source_launch_sites" not in rules and "device_kernels_not_launched" in remaining:
        notes.append(
            "- repair.source_launch_sites_missing: Deterministic repair could not synthesize a source launch because the required SOURCE LAUNCH GRAPH grid/block/stream/argument owner expressions were not available in generated core."
        )
        launch_repair = repair_report.get("sourceLaunchSiteRepair")
        if isinstance(launch_repair, Mapping):
            missing = launch_repair.get("missing") or []
            if isinstance(missing, Sequence) and missing:
                compact_missing = []
                for item in missing[:4]:
                    if not isinstance(item, Mapping):
                        continue
                    compact_missing.append(
                        {
                            "site": item.get("site"),
                            "kernel": item.get("kernel"),
                            "missingExpressions": item.get("missingExpressions"),
                            "requiredHostArgumentOwners": item.get(
                                "requiredHostArgumentOwners"
                            ),
                        }
                    )
                if compact_missing:
                    notes.append(
                        "- repair.source_launch_sites_missing_records: "
                        + json.dumps(
                            compact_missing,
                            sort_keys=True,
                            separators=(",", ":"),
                        )
                    )
    return notes


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
            "- Inline/adapt quoted project headers into generated role code unless the verifier-selected device role is directly including a target-scoped device source/header listed by the source preservation contract. Core/gui/shared/host_runner may quote-include only emitted role files or synthi_gpu_runtime.h."
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
    if "device_buffers_not_initialized" in joined:
        guidance.append(
            "- For each real host-launched update kernel that receives device buffers, either add a dedicated init/seed kernel that writes every required device buffer before the update launch, or remove the host launch if it was a synthetic launch for a preserved-but-not-runtime-reachable source kernel. Preserved device kernels are mapping artifacts, not permission to launch every kernel in the project."
        )
    if "device_kernels_not_launched" in joined:
        guidance.append(
            "- Use the SOURCE LAUNCH GRAPH records to preserve a real source-reachable launch path. If you emit a synthi_gpu_launch(...) for a listed source kernel, materialize the listed host argument owner expressions in generated core state and pass those owners by address in the same order. Do not invent a different aggregate, placeholder buffer, or synthetic kernel just to make a launch compile; a launch without source-owned arguments is verifier-rejected."
        )
    if "constant_false_launch_guard" in joined:
        guidance.append(
            "- Never initialize a local launch guard with `false` and immediately branch on it. The guard must be assigned from the actual `synthi_gpu_launch(...)` result, or it must be a persistent state/static flag updated only after a successful launch. A local `bool initialized = false; if (initialized) { ... }` is always rejected."
        )
    if "kernel_launch_abi_mismatch" in joined:
        guidance.append(
            "- For each synthi_gpu_launch call, make the host initializer-list match the generated kernel parameter list exactly. If the kernel takes a LaunchParams-style struct, create one host variable and pass its address as a single argument; otherwise flatten the kernel signature to match the host launch ABI."
        )
    if "source_launch_args_not_preserved" in joined or "repair.source_launch_args" in joined:
        guidance.append(
            "- For each synthi_gpu_launch call that targets a source-reachable kernel from the source launch graph, preserve the same launch argument object names and order as the source launch site. Do not synthesize a different aggregate solely to satisfy the kernel parameter count; if the original argument pack cannot be reconstructed safely in generated core state, remove that runtime launch and keep the kernel preserved only for device mapping/HMR."
        )
    if "kernel_launch_bounds_exceeded" in joined:
        guidance.append(
            "- For each synthi_gpu_launch call, choose block dimensions whose total thread count is no greater than that kernel's __launch_bounds__ value. Preserve project semantics while deriving the block shape from the kernel's declared launch bound or target-scoped constants."
        )
    if "launch_site_unresolved" in joined:
        guidance.append(
            "- Do not invent placeholder host launches. Every synthi_gpu_launch kernel name must be an actual __global__ symbol emitted in the device role or a target-scoped source-device kernel preserved by the device role. If you add or keep a synthi_gpu_launch call, first ensure that exact kernel name is declared in device.hip/device.cu; otherwise remove the invented launch site instead of naming a fake kernel such as `my_function`."
        )
        guidance.append(
            "- Treat every identifier inside prompt examples, documentation snippets, tests, and previous rejected attempts as non-authoritative. A launch name copied from examples but absent from the source context is prompt leakage; remove it or replace it with a real source/device symbol plus a matching generated definition and descriptor entry."
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
            "- Generated core/gui/shared/host_runner role files must be self-contained. Quoted includes there may only target emitted Synthi role files or synthi_gpu_runtime.h; original workspace/project headers must be copied or adapted into those roles.",
            "- The generated device role may directly quote-include only target-scoped device source/header files listed in the source preservation contract, so large runtime-compiled kernel headers can remain source-authoritative. Do not include arbitrary project headers.",
            "- host_runner.cpp must resolve core_on_load/core_on_update and gui_on_load/gui_on_render from the generated modules, store the function pointers, call core_on_update, then call gui_on_render with the core state before the backend presents each frame. A valid runner has a real `void* core_state` returned from core_on_load and calls a resolved render pointer such as `gui_render(core_state);` inside the frame loop.",
            "- gui_on_render must contain executable backend drawing code, not TODOs, placeholder comments, or 'rendering logic' stubs. It must draw visible non-black output through the original project's render backend.",
            "- Generated GUI and runner code must not switch frameworks. Preserve the source render backend reported by deterministic context selection.",
            "- Device kernels and runtime-compiled kernel headers selected by source context must keep original kernel names and body semantics so later user body edits can map into the generated device role.",
            "- Host launch sites must not invent kernel names. Every `synthi_gpu_launch(...)` kernel string must match an actual generated or source-preserved device kernel symbol.",
            "- Example identifiers are not source facts. Any launch name copied from prompt examples, docs, tests, or a previous rejected attempt is invalid unless that identifier appears in the target-scoped source context or is introduced as a real generated helper with a matching device definition and descriptor entry.",
            "- Host launch block dimensions must respect source kernel `__launch_bounds__` when present. If a kernel declares `__launch_bounds__(N)`, the generated launch block must have at most N total threads.",
            "- Preserved source-device kernels are not all runtime entrypoints. Generate `synthi_gpu_launch(...)` calls only for host-reachable launch paths or the explicit first-frame pipeline you construct; do not launch every preserved kernel just because it appears in the device role.",
            "- Launch guards in `core_on_update` must be real launch results or persistent state/static flags. Never use local constants such as `bool initialized = false; if (initialized) { ... }` to gate runtime updates.",
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
_SOURCE_DEVICE_IDENTIFIER_RE = re.compile(r"\bk[A-Z][A-Za-z0-9_]*\b")
_QUOTE_INCLUDE_RE = re.compile(r"#\s*include\s+\"(?P<path>[^\"]+)\"")
_ANY_INCLUDE_RE = re.compile(r"#\s*include\s+[<\"](?P<path>[^>\"]+)[>\"]")
_PROJECT_CONTEXT_MAX_CHARS = 70000
_PROJECT_CONTEXT_PER_FILE_MAX_CHARS = 3000
_DEVICE_PRESERVATION_TOTAL_MAX_CHARS = 160000
_DEVICE_PRESERVATION_PER_FILE_MAX_CHARS = 8000


def _looks_like_source_file(name: str) -> bool:
    return bool(re.search(r"\.(?:h|hpp|hh|cpp|cc|cxx|cu|hip)$", name.replace("\\", "/"), re.I))


def _has_gpu_device_marker(source: str) -> bool:
    code = mask_comments_for_parsing(source or "")
    return bool(_GPU_DEVICE_MARKER_RE.search(code) or ("<<<" in code and ">>>" in code))


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


def _looks_like_structurally_escaped_source(value: str) -> bool:
    escaped_newlines = value.count(r"\n") + value.count(r"\r\n")
    actual_newlines = value.count("\n")
    if escaped_newlines < 2:
        return False
    if actual_newlines and actual_newlines * 3 >= escaped_newlines:
        return False
    return bool(
        re.search(
            r"\\n\s*(?:#|extern\b|struct\b|class\b|namespace\b|static\b|using\b|template\b|//|/\*|\})",
            value,
        )
    )


def _decode_structural_source_escapes(value: str) -> str:
    if not _looks_like_structurally_escaped_source(value):
        return value

    out: List[str] = []
    i = 0
    quote: Optional[str] = None
    escaped = False
    while i < len(value):
        ch = value[i]
        if quote:
            out.append(ch)
            if escaped:
                escaped = False
            elif ch == "\\":
                escaped = True
            elif ch == quote:
                quote = None
            i += 1
            continue

        if ch in {'"', "'"}:
            quote = ch
            out.append(ch)
            i += 1
            continue
        if ch == "\\" and i + 1 < len(value):
            nxt = value[i + 1]
            if nxt == "n":
                out.append("\n")
                i += 2
                continue
            if nxt == "r" and i + 3 < len(value) and value[i + 2 : i + 4] == r"\n":
                out.append("\n")
                i += 4
                continue
            if nxt == "t":
                out.append("\t")
                i += 2
                continue
        out.append(ch)
        i += 1
    return "".join(out)


def _is_file_map_like(value: Mapping[str, Any]) -> bool:
    return any(
        key in _ROLE_FILENAMES or _looks_like_source_file(str(key))
        for key in value.keys()
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
                if _is_file_map_like(decoded):
                    for nested_name, nested_value in decoded.items():
                        if nested_name in _ROLE_FILENAMES or _looks_like_source_file(str(nested_name)):
                            add(str(nested_name), nested_value)
                    return
                add(clean_name, decoded)
                return
            embedded = _extract_embedded_source_object(value)
            if embedded and _looks_like_source_file(clean_name):
                out[clean_name] = _decode_structural_source_escapes(embedded)
                return
        if isinstance(value, str) and value.strip() and _looks_like_source_file(clean_name):
            out[clean_name] = _decode_structural_source_escapes(value)
        elif isinstance(value, Mapping):
            filename = value.get("filename") or value.get("path") or value.get("name")
            content = value.get("content") or value.get("file_content") or value.get("source")
            if filename and isinstance(content, str) and content.strip():
                target_name = str(filename).strip().replace("\\", "/")
                if content.strip().startswith("{"):
                    try:
                        decoded = json.loads(content)
                    except json.JSONDecodeError:
                        decoded = None
                    if isinstance(decoded, Mapping) and _is_file_map_like(decoded):
                        for nested_name, nested_value in decoded.items():
                            if nested_name in _ROLE_FILENAMES or _looks_like_source_file(str(nested_name)):
                                add(str(nested_name), nested_value)
                        return
                    embedded = _extract_embedded_source_object(content)
                    if embedded:
                        out[target_name] = _decode_structural_source_escapes(embedded)
                        return
                out[target_name] = _decode_structural_source_escapes(content)
                return
            if isinstance(content, str) and content.strip() and _looks_like_source_file(clean_name):
                if content.strip().startswith("{"):
                    try:
                        decoded = json.loads(content)
                    except json.JSONDecodeError:
                        decoded = None
                    if isinstance(decoded, Mapping) and _is_file_map_like(decoded):
                        for nested_name, nested_value in decoded.items():
                            if nested_name in _ROLE_FILENAMES or _looks_like_source_file(str(nested_name)):
                                add(str(nested_name), nested_value)
                        return
                    embedded = _extract_embedded_source_object(content)
                    if embedded:
                        out[clean_name] = _decode_structural_source_escapes(embedded)
                        return
                out[clean_name] = _decode_structural_source_escapes(content)
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
        for match in _QUOTE_INCLUDE_RE.finditer(mask_comments_for_parsing(source)):
            resolved = _resolve_quoted_include(
                match.group("path"),
                including_path=path,
                source_files=normalized,
            )
            if resolved and resolved not in reachable and _looks_like_source_file(resolved):
                queue.append(resolved)
    return {path: reachable[path] for path in sorted(reachable)}


def _include_namespace(include_path: str) -> str:
    return include_path.replace("\\", "/").lstrip("./").split("/", 1)[0]


def _paths_for_include(source_files: Mapping[str, str], include_path: str) -> List[str]:
    normalized_include = include_path.replace("\\", "/").lstrip("./")
    if not normalized_include:
        return []
    return sorted(
        path
        for path in source_files
        if path == normalized_include or path.endswith(f"/{normalized_include}")
    )


def _device_compiler_prelude_scope(
    source_files: Mapping[str, str],
    device_sources: Mapping[str, str],
) -> set[str]:
    """Find project-declared compiler prelude files for reachable device code."""

    device_include_names = {
        match.group("path").replace("\\", "/").lstrip("./")
        for source in device_sources.values()
        for match in _ANY_INCLUDE_RE.finditer(mask_comments_for_parsing(source))
    }
    namespaces = {
        _include_namespace(include)
        for include in device_include_names
        if _include_namespace(include)
    }
    if not namespaces:
        return set()

    prelude_paths: set[str] = set()
    for path, source in source_files.items():
        includes = [
            match.group("path").replace("\\", "/").lstrip("./")
            for match in _ANY_INCLUDE_RE.finditer(mask_comments_for_parsing(source))
        ]
        for include in includes:
            basename = include.rsplit("/", 1)[-1].lower()
            if "device_impl" not in basename:
                continue
            if _include_namespace(include) not in namespaces:
                continue
            prelude_paths.add(path)
            prelude_paths.update(_paths_for_include(source_files, include))
    return prelude_paths


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


def _source_launch_graph_scope(
    source_files: Mapping[str, str],
    device_sources: Mapping[str, str],
) -> set[str]:
    kernel_names = {
        match.group(1)
        for source in device_sources.values()
        for match in _SOURCE_GLOBAL_KERNEL_RE.finditer(mask_comments_for_parsing(source))
    }
    if not kernel_names:
        return set()

    scoped_paths: set[str] = set()
    for item in launch_graph_as_dicts(source_files):
        kernel = str(item.get("kernel") or "").strip()
        if kernel not in kernel_names:
            continue
        site = str(item.get("site") or "").replace("\\", "/")
        path = site.rsplit(":", 1)[0] if ":" in site else site
        if path in source_files:
            scoped_paths.add(path)

    queue = list(scoped_paths)
    while queue:
        path = queue.pop(0)
        source = source_files.get(path)
        if source is None:
            continue
        for match in _QUOTE_INCLUDE_RE.finditer(mask_comments_for_parsing(source)):
            resolved = _resolve_quoted_include(
                match.group("path"),
                including_path=path,
                source_files=source_files,
            )
            if resolved and resolved not in scoped_paths and _looks_like_source_file(resolved):
                scoped_paths.add(resolved)
                queue.append(resolved)
    return scoped_paths


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
    device_sources: Dict[str, str] = {}
    if roots:
        device_sources = _device_reachable_source_files(normalized, roots=roots)
        scoped_paths.update(device_sources)
    else:
        included_device_roots = [
            path
            for path in sorted(scoped_paths)
            if path in normalized and _looks_like_source_file(path) and _has_gpu_device_marker(normalized[path])
        ]
        if included_device_roots:
            device_sources = _device_reachable_source_files(
                normalized, roots=included_device_roots
            )
            scoped_paths.update(device_sources)
    if device_sources:
        scoped_paths.update(_device_compiler_prelude_scope(normalized, device_sources))
        scoped_paths.update(_source_launch_graph_scope(normalized, device_sources))
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
            for match in _SOURCE_GLOBAL_KERNEL_RE.finditer(mask_comments_for_parsing(source))
        }
    )
    identifiers = sorted(
        {
            ident
            for source in device_sources.values()
            for ident in _SOURCE_DEVICE_IDENTIFIER_RE.findall(mask_comments_for_parsing(source))
        }
    )
    sections = [
        "# SOURCE DEVICE PRESERVATION CONTRACT",
        "The generated device role must copy/adapt the device-reachable user GPU source below, not summarize it.",
        "This includes selected .cu/.hip translation units, macro-wrapped kernel headers, runtime-compiled kernel sources, and quoted project headers reachable from them.",
        "Preserve original kernel names, non-empty kernel bodies, device helpers, constants, branches, boundary/reset logic, template helper math, and output writes.",
        "For core/gui/shared/host_runner, do not include original project headers; inline/adapt the needed structs, constants, and helper function bodies into generated roles.",
        "For the device role only, a direct quote-include of the listed target-scoped device source/header path is allowed when that preserves source-authoritative kernel bodies better than inlining.",
        "Do not emit dangling constant declarations, empty kernels, renamed kernels, or simplified substitute kernels.",
        "Required original kernels below are required for device-role preservation and HMR mapping only. They are not a request to synthesize host launches for every preserved kernel.",
        "Create host `synthi_gpu_launch(...)` calls only for source-reachable launch paths or for a deliberately constructed first-frame/update pipeline with valid initialized buffers.",
    ]
    if kernels:
        sections.append(f"Required original kernels: {', '.join(kernels)}.")
    if identifiers:
        sections.append(f"Required device identifiers/constants: {', '.join(identifiers)}.")
    root_set = {str(root).replace("\\", "/") for root in roots or []}

    def sort_key(item: tuple[str, str]) -> tuple[int, str]:
        path, source = item
        code = mask_comments_for_parsing(source)
        if path in root_set:
            return (0, path)
        if _SOURCE_GLOBAL_KERNEL_RE.search(code):
            return (1, path)
        if _has_gpu_device_marker(code):
            return (2, path)
        if "/kernels/" in path:
            return (3, path)
        return (4, path)

    used = sum(len(section) + 2 for section in sections)
    omitted: List[str] = []
    for path, source in sorted(device_sources.items(), key=sort_key):
        body = mask_comments_for_parsing(source)
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


def _source_device_kernel_symbol_set(
    source_files: Mapping[str, str],
    roots: Optional[Sequence[str]] = None,
) -> set[str]:
    device_sources = _device_reachable_source_files(source_files, roots=roots)
    return {
        match.group(1)
        for source in device_sources.values()
        for match in _SOURCE_GLOBAL_KERNEL_RE.finditer(mask_comments_for_parsing(source))
    }


def _source_launch_graph_contract(
    source_files: Mapping[str, str],
    *,
    allowed_kernels: Optional[set[str]] = None,
) -> str:
    graph = launch_graph_as_dicts(source_files)
    if allowed_kernels is not None:
        graph = [
            item
            for item in graph
            if str(item.get("kernel") or "").strip() in allowed_kernels
        ]
    if not graph:
        return ""
    compact = [
        _compact_source_launch_record(item, source_files)
        for item in graph[:40]
    ]
    omitted = len(graph) - len(compact)
    lines = [
        "# SOURCE LAUNCH GRAPH",
        (
            "Deterministic source analysis found host-reachable GPU launch records. "
            "Generated core `synthi_gpu_launch(...)` calls must preserve these source "
            "launch kernels, argument ownership, and block/grid intent unless a "
            "separate generated initialization launch is required for the same data path."
        ),
        (
            "Do not replace a listed source launch with an unrelated preserved kernel "
            "solely because that other kernel compiles."
        ),
        (
            "For each emitted `synthi_gpu_launch(...)` that targets one of these "
            "records, the initializer-list entries must be the addresses of "
            "`requiredHostArgumentOwners` in the same order. Generated core code "
            "must materialize those owner expressions from adapted source state "
            "before the launch; do not replace them with newly named aggregate "
            "wrappers, placeholder buffers, or test-only data."
        ),
        (
            "If a listed owner expression cannot be represented in generated core "
            "without inventing state, do not emit that source launch. A verifier "
            "rejection is safer than a launch with different argument ownership."
        ),
        (
            "The records below are target-scoped and filtered to kernels that exist in "
            "the source-device preservation set."
        ),
        json.dumps(compact, sort_keys=True, separators=(",", ":")),
    ]
    if omitted > 0:
        lines.append(f"Launch records omitted for prompt budget: {omitted}.")
    return "\n".join(lines)


def _compact_source_launch_record(
    item: Mapping[str, Any],
    source_files: Mapping[str, str],
) -> dict:
    record = {
        "site": item.get("site"),
        "kernel": item.get("kernel"),
        "grid": item.get("grid"),
        "block": item.get("block"),
        "shared": item.get("shared"),
        "stream": item.get("stream"),
        "args": item.get("args"),
        "requiredHostArgumentOwners": item.get("args"),
        "form": item.get("form"),
    }
    snippet = _source_launch_site_snippet(source_files, item.get("site"))
    if snippet:
        record["sourceSnippet"] = snippet
    return record


def _source_launch_site_snippet(
    source_files: Mapping[str, str],
    site: Any,
    *,
    context_lines: int = 12,
    max_chars: int = 1200,
) -> str:
    if not isinstance(site, str) or ":" not in site:
        return ""
    path, line_text = site.rsplit(":", 1)
    try:
        line_no = int(line_text)
    except ValueError:
        return ""
    normalized_path = path.replace("\\", "/").lstrip("./")
    normalized_sources = {
        source_path.replace("\\", "/").lstrip("./"): source
        for source_path, source in source_files.items()
    }
    source = normalized_sources.get(normalized_path)
    if not source:
        return ""
    lines = source.splitlines()
    if not lines:
        return ""
    index = max(0, min(len(lines) - 1, line_no - 1))
    start = max(0, index - context_lines)
    end = min(len(lines), index + context_lines + 1)
    snippet = "\n".join(
        f"{line_index + 1}: {lines[line_index]}" for line_index in range(start, end)
    )
    if len(snippet) > max_chars:
        return snippet[:max_chars] + "\n/* ... launch snippet truncated ... */"
    return snippet


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


def _manifest_device_path(
    manifest: Optional[Mapping[str, Any]],
    files: Mapping[str, str],
) -> Optional[str]:
    module_files = manifest.get("module_files") if isinstance(manifest, Mapping) else None
    if isinstance(module_files, Mapping):
        device = module_files.get("device")
        if isinstance(device, str) and device.strip() in files:
            return device.strip()
    for path in sorted(files):
        if path.replace("\\", "/").lower().endswith((".cu", ".hip")):
            return path
    return None


def _resolve_source_include(include_path: str, source_files: Mapping[str, str]) -> Optional[str]:
    normalized = include_path.replace("\\", "/").lstrip("./")
    normalized_sources = {
        path.replace("\\", "/").lstrip("./"): source
        for path, source in source_files.items()
    }
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
    return None


def _kernel_hashes_for_generated_split(
    *,
    files: Mapping[str, str],
    manifest: Optional[Mapping[str, Any]],
    source_files: Mapping[str, str],
) -> Dict[str, str]:
    device_path = _manifest_device_path(manifest, files)
    if not device_path:
        return {}
    device_source = files.get(device_path, "")
    hashes = dict(stamp_device_source(device_source))
    for match in _QUOTE_INCLUDE_RE.finditer(device_source):
        resolved = _resolve_source_include(match.group("path"), source_files)
        if resolved is not None:
            hashes.update(stamp_device_source(source_files[resolved]))
    return hashes


# ─────────────────────────────────────────────────────────────────────────────
# Agent entry point
# ─────────────────────────────────────────────────────────────────────────────


def _core_path_for_generated_split(
    manifest: Optional[Mapping[str, Any]],
    files: Mapping[str, str],
) -> Optional[str]:
    module_files = manifest.get("module_files") if isinstance(manifest, Mapping) else None
    if isinstance(module_files, Mapping):
        core = module_files.get("core")
        if isinstance(core, str) and core.strip() in files:
            return core.strip()
    for path in sorted(files):
        normalized = path.replace("\\", "/").lower()
        if normalized.endswith("core.cpp") or normalized.endswith("/core.cpp"):
            return path
    return None


def _stamp_core_device_kernel_sig_hashes(
    *,
    files: Mapping[str, str],
    manifest: Optional[Mapping[str, Any]],
    kernel_hashes: Mapping[str, str],
) -> Dict[str, str]:
    core_path = _core_path_for_generated_split(manifest, files)
    if not core_path:
        return dict(files)
    core_source = files.get(core_path, "")
    if not core_source:
        return dict(files)
    stamped = _replace_device_kernel_sig_hash_export(core_source, kernel_hashes)
    if stamped == core_source:
        return dict(files)
    updated = dict(files)
    updated[core_path] = stamped
    return updated


def _replace_device_kernel_sig_hash_export(
    core_source: str,
    kernel_hashes: Mapping[str, str],
) -> str:
    replacement = _render_device_kernel_sig_hash_export(kernel_hashes)
    match = re.search(
        r'extern\s+"C"\s+unsigned\s+long\s+long\s+device_kernel_sig_hash\s*\([^)]*\)\s*\{',
        core_source,
    )
    if not match:
        return core_source.rstrip() + "\n\n" + replacement + "\n"
    open_brace = core_source.find("{", match.start(), match.end())
    if open_brace < 0:
        return core_source
    close_brace = _matching_brace(core_source, open_brace)
    if close_brace is None:
        return core_source
    return core_source[: match.start()] + replacement + core_source[close_brace + 1 :]


def _render_device_kernel_sig_hash_export(kernel_hashes: Mapping[str, str]) -> str:
    lines = [
        'extern "C" unsigned long long device_kernel_sig_hash(const char* name) {',
        "    auto synthi_kernel_name_eq = [](const char* left, const char* right) -> bool {",
        "        if (!left || !right) return false;",
        "        while (*left && *right && *left == *right) { ++left; ++right; }",
        "        return *left == *right;",
        "    };",
    ]
    for name, hash_hex in sorted((str(k), str(v)) for k, v in kernel_hashes.items()):
        if not re.fullmatch(r"0x[0-9a-fA-F]{1,16}", hash_hex):
            continue
        escaped_name = name.replace("\\", "\\\\").replace('"', '\\"')
        lines.append(
            f'    if (synthi_kernel_name_eq(name, "{escaped_name}")) return {hash_hex}ULL;'
        )
    lines.extend(["    return 0ULL;", "}"])
    return "\n".join(lines)


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
                _source_launch_graph_contract(
                    scoped_source_map,
                    allowed_kernels=_source_device_kernel_symbol_set(
                        scoped_source_map,
                        roots=device_preservation_roots,
                    ),
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
    parsed["files"], verification, repair_report = _apply_split_repairs_until_stable(
        files=parsed["files"],
        manifest=parsed["manifest"] if isinstance(parsed["manifest"], dict) else None,
        manifest_arch=arch_list,
        source_files=scoped_source_map,
        verification=verification,
    )
    parsed["kernel_hashes"] = _kernel_hashes_for_generated_split(
        files=parsed["files"],
        manifest=parsed["manifest"] if isinstance(parsed["manifest"], dict) else None,
        source_files=scoped_source_map,
    )
    stamped_files = _stamp_core_device_kernel_sig_hashes(
        files=parsed["files"],
        manifest=parsed["manifest"] if isinstance(parsed["manifest"], dict) else None,
        kernel_hashes=parsed["kernel_hashes"],
    )
    if stamped_files != parsed["files"]:
        parsed["files"] = stamped_files
        verification = verify_split_output(
            files=parsed["files"],
            manifest_arch=arch_list,
            manifest=parsed["manifest"] if isinstance(parsed["manifest"], dict) else None,
            source_files=scoped_source_map,
        )

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
