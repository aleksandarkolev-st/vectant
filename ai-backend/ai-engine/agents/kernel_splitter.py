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

import json
import os
import re
from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Any, Dict, List, Mapping, Optional, Sequence

from agents.gpu_detect import GpuDetectionResult
from llm.prompts import GPU_SPLIT_PROMPT
from verifier_gpu import SplitVerificationResult, verify_split_output

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
    verification: Optional[SplitVerificationResult] = None
    raw_response: str = ""

    def to_dict(self) -> dict:
        return {
            "files": self.files,
            "manifest": self.manifest,
            "architecture_md": self.architecture_md,
            "kernel_hashes": self.kernel_hashes,
            "launch_graph": self.launch_graph,
            "verification": self.verification.to_dict() if self.verification else None,
        }


class KernelSplitterError(Exception):
    """Raised when the AI response is unparseable or fails the verifier
    and no fallback is appropriate. Callers convert into HTTPException(422).
    """


# ─────────────────────────────────────────────────────────────────────────────
# Extraction
# ─────────────────────────────────────────────────────────────────────────────


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
_SOURCE_GLOBAL_KERNEL_RE = re.compile(r"\b__global__\s+(?:void\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*\(")
_SOURCE_DEVICE_IDENTIFIER_RE = re.compile(r"\bk[A-Z][A-Za-z0-9_]*\b")
_PROJECT_CONTEXT_MAX_CHARS = 70000
_PROJECT_CONTEXT_PER_FILE_MAX_CHARS = 3000


def _looks_like_source_file(name: str) -> bool:
    return bool(re.search(r"\.(?:h|hpp|hh|cpp|cc|cxx|cu|hip)$", name.replace("\\", "/"), re.I))


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


def _source_device_preservation_contract(source_files: Mapping[str, str]) -> str:
    device_sources = {
        path: source
        for path, source in source_files.items()
        if path.lower().endswith((".cu", ".hip")) and ("__global__" in source or "__device__" in source)
    }
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
        "The generated device role must copy/adapt the user GPU source below, not summarize it.",
        "Preserve original __global__ kernel names, non-empty kernel bodies, device helpers, constants, branches, boundary/reset logic, and output writes.",
        "Do not emit dangling constant declarations, empty kernels, renamed kernels, or simplified substitute kernels.",
    ]
    if kernels:
        sections.append(f"Required original kernels: {', '.join(kernels)}.")
    if identifiers:
        sections.append(f"Required device identifiers/constants: {', '.join(identifiers)}.")
    for path, source in sorted(device_sources.items()):
        body = source if len(source) <= 12000 else source[:12000] + "\n/* ... truncated ... */"
        sections.append(f"```cpp\n// FILE: {path}\n{body}\n```")
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
    focus_path = (focus or "").replace("\\", "/")
    if focus_path and path == focus_path:
        return (0, path)
    if path == "CMakeLists.txt":
        return (1, path)
    if path.startswith("src/gpu/") or path.startswith("src/kernels/"):
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
    prompt = build_prompt(
        user_code,
        detection=detection,
        extra_instructions="\n\n".join(
            part
            for part in [
                extra_instructions,
                _project_source_context(source_map, focus=focus),
                _source_device_preservation_contract(source_map),
            ]
            if part
        ),
    )

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
        source_files=source_map,
    )

    return KernelSplitResult(
        files=parsed["files"],
        manifest=parsed["manifest"],
        architecture_md=parsed["architecture_md"],
        kernel_hashes=parsed["kernel_hashes"],
        launch_graph=parsed["launch_graph"],
        verification=verification,
        raw_response=raw,
    )
