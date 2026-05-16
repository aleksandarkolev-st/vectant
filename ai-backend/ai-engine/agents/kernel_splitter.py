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
    prompt = build_prompt(user_code, detection=detection, extra_instructions=extra_instructions)

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
        files=parsed["files"], manifest_arch=arch_list
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
