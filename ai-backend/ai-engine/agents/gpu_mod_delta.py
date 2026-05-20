"""GPU edit classifier and GPU diff-patch helpers."""

from __future__ import annotations

import json
import re
from dataclasses import dataclass
from typing import Any, Dict, Iterable, List, Mapping, Optional

try:
    from pydantic import BaseModel
except ImportError:  # pragma: no cover
    BaseModel = object  # type: ignore

try:
    from fastapi import HTTPException
except ImportError:  # pragma: no cover
    class HTTPException(Exception):  # type: ignore
        def __init__(self, status_code: int, detail: str):
            super().__init__(detail)
            self.status_code = status_code
            self.detail = detail

from agents.abi_stamper import constant_layout_hash, stamp_device_source
from llm.prompts import GPU_DIFF_PATCH_PROMPT


ReloadPlan = str
VALID_RELOAD_PLANS = {"host_only", "device_only", "mixed", "abi_breaking"}
VALID_GPU_EDIT_MODULES = {"core", "gui", "shared", "host_runner", "device"}
VALID_GPU_EDIT_OPS = {"insert_after", "insert_before", "replace", "delete"}
DEVICE_PATHS = {"device.cu", "device.hip"}
HOST_PATH_TO_MODULE = {
    "core.cpp": "core",
    "gui.cpp": "gui",
    "shared.h": "shared",
    "host_runner.cpp": "host_runner",
}


class GpuDiffPatchRequest(BaseModel):
    diff: str
    core_content: str = ""
    gui_content: str = ""
    shared_content: str = ""
    host_runner_content: str = ""
    device_content: str = ""
    architecture: Optional[str] = None
    mapping_report: Optional[Any] = None
    compile_manifest: Optional[Any] = None
    reload_plan_report: Optional[Any] = None
    reload_plan: Optional[ReloadPlan] = None
    model: Optional[str] = None
    api_key: Optional[str] = None


@dataclass(frozen=True)
class ModDeltaClassification:
    reload_plan: ReloadPlan
    changed_paths: List[str]
    old_kernel_hashes: Dict[str, str]
    new_kernel_hashes: Dict[str, str]
    reason: str

    def to_dict(self) -> dict:
        return {
            "reload_plan": self.reload_plan,
            "changed_paths": self.changed_paths,
            "old_kernel_hashes": self.old_kernel_hashes,
            "new_kernel_hashes": self.new_kernel_hashes,
            "reason": self.reason,
        }


def classify_mod_delta(
    before_files: Mapping[str, str],
    after_files: Mapping[str, str],
    manifest_gpu: Optional[Mapping[str, object]] = None,
) -> ModDeltaClassification:
    """Classify a file delta into the worker reload plan."""
    all_paths = sorted(set(before_files) | set(after_files))
    changed = [p for p in all_paths if before_files.get(p, "") != after_files.get(p, "")]

    old_device = _device_source(before_files)
    new_device = _device_source(after_files)
    old_hashes = stamp_device_source(old_device)
    new_hashes = stamp_device_source(new_device)

    if _rdc_enabled(manifest_gpu):
        return ModDeltaClassification(
            reload_plan="abi_breaking",
            changed_paths=changed,
            old_kernel_hashes=old_hashes,
            new_kernel_hashes=new_hashes,
            reason="rdc-enabled-forces-cold-reload",
        )

    device_changed = any(_is_device_path(p) for p in changed)
    host_changed = any(_is_host_path(p) for p in changed)
    constant_changed = constant_layout_hash(old_device) != constant_layout_hash(new_device)
    signatures_changed = old_hashes != new_hashes

    if signatures_changed or constant_changed:
        return ModDeltaClassification(
            reload_plan="abi_breaking",
            changed_paths=changed,
            old_kernel_hashes=old_hashes,
            new_kernel_hashes=new_hashes,
            reason="kernel-signature-or-constant-layout-changed",
        )
    if device_changed and host_changed:
        plan, reason = "mixed", "host-and-device-files-changed"
    elif device_changed:
        plan, reason = "device_only", "device-file-only-edit"
    else:
        plan, reason = "host_only", "host-only-edit"
    return ModDeltaClassification(
        reload_plan=plan,
        changed_paths=changed,
        old_kernel_hashes=old_hashes,
        new_kernel_hashes=new_hashes,
        reason=reason,
    )


def build_gpu_diff_patch_prompt(req: GpuDiffPatchRequest) -> str:
    replacements = {
        "{ARCHITECTURE}": req.architecture or "",
        "{MAPPING_REPORT}": _json_block(req.mapping_report),
        "{COMPILE_MANIFEST}": _json_block(req.compile_manifest),
        "{RELOAD_PLAN_REPORT}": _json_block(req.reload_plan_report),
        "{SHARED_CONTENT}": req.shared_content or "",
        "{CORE_CONTENT}": req.core_content or "",
        "{GUI_CONTENT}": req.gui_content or "",
        "{HOST_RUNNER_CONTENT}": req.host_runner_content or "",
        "{DEVICE_CONTENT}": req.device_content or "",
        "{DIFF}": req.diff or "",
    }
    prompt = GPU_DIFF_PATCH_PROMPT
    for needle, value in replacements.items():
        prompt = prompt.replace(needle, value)
    if req.reload_plan:
        prompt += f"\n\nClassifier reload_plan hint: {req.reload_plan}\n"
    return prompt


def gpu_diff_patch_anchor_failures(
    req: GpuDiffPatchRequest,
    edits: Iterable[Mapping[str, object]],
) -> List[dict]:
    contents = {
        "shared": req.shared_content or "",
        "core": req.core_content or "",
        "gui": req.gui_content or "",
        "host_runner": req.host_runner_content or "",
        "device": req.device_content or "",
    }
    failures: List[dict] = []
    for index, edit in enumerate(edits):
        module = _normalize_module(str(edit.get("module", "")))
        anchor = edit.get("anchor")
        if module not in contents:
            failures.append(
                {
                    "index": index,
                    "module": module,
                    "reason": "unknown_module",
                    "anchor": str(anchor or ""),
                }
            )
            continue
        if not isinstance(anchor, str) or not anchor:
            failures.append(
                {
                    "index": index,
                    "module": module,
                    "reason": "missing_anchor",
                    "anchor": "",
                }
            )
            continue
        content = contents[module]
        count = content.count(anchor)
        if count == 1:
            continue
        failures.append(
            {
                "index": index,
                "module": module,
                "reason": "anchor_missing" if count == 0 else "anchor_ambiguous",
                "anchor": anchor,
                "match_count": count,
            }
        )
    return failures


def build_gpu_diff_patch_retry_prompt(
    original_prompt: str,
    failures: Iterable[Mapping[str, object]],
) -> str:
    lines = [
        original_prompt,
        "",
        "DETERMINISTIC VERIFIER REJECTION:",
        "Your previous GPU delta edit list was rejected before the worker applied it.",
        "Return a corrected JSON object using the same schema.",
        "",
        "Anchor rules:",
        "- Every anchor must be copied verbatim from the CURRENT FILES blocks above.",
        "- For module \"device\", the anchor must come from the CURRENT generated device role.",
        "- Do not use a line that appears only in USER DIFF or the original user source.",
        "- Every anchor must appear exactly once in its target module.",
        "",
        "Rejected edits:",
    ]
    for failure in failures:
        anchor = str(failure.get("anchor") or "")
        if len(anchor) > 240:
            anchor = anchor[:237] + "..."
        lines.append(
            "- edit #{index} module={module} reason={reason} match_count={count} anchor={anchor!r}".format(
                index=failure.get("index"),
                module=failure.get("module"),
                reason=failure.get("reason"),
                count=failure.get("match_count", "n/a"),
                anchor=anchor,
            )
        )
    lines += [
        "",
        "Return ONLY the corrected JSON object. No markdown fences, no prose.",
    ]
    return "\n".join(lines)


def _json_block(value: object) -> str:
    if value is None:
        return ""
    if isinstance(value, str):
        return value
    try:
        return json.dumps(value, sort_keys=True, indent=2)
    except TypeError:
        return str(value)


def validate_gpu_edit_list(edits: object) -> List[dict]:
    if not isinstance(edits, list):
        raise HTTPException(status_code=400, detail="`edits` must be a JSON array")
    cleaned: List[dict] = []
    for i, edit in enumerate(edits):
        if not isinstance(edit, dict):
            raise HTTPException(status_code=400, detail=f"edit #{i} must be an object")
        module = _normalize_module(str(edit.get("module", "")))
        op = edit.get("operation")
        anchor = edit.get("anchor")
        content = edit.get("content", "")
        if module not in VALID_GPU_EDIT_MODULES:
            raise HTTPException(
                status_code=400,
                detail=f"edit #{i}: module must be one of {VALID_GPU_EDIT_MODULES}, got {edit.get('module')!r}",
            )
        if op not in VALID_GPU_EDIT_OPS:
            raise HTTPException(
                status_code=400,
                detail=f"edit #{i}: operation must be one of {VALID_GPU_EDIT_OPS}, got {op!r}",
            )
        if not isinstance(anchor, str) or not anchor:
            raise HTTPException(status_code=400, detail=f"edit #{i}: anchor must be non-empty")
        if not isinstance(content, str):
            raise HTTPException(status_code=400, detail=f"edit #{i}: content must be a string")
        cleaned.append({"module": module, "operation": op, "anchor": anchor, "content": content})
    return cleaned


def parse_gpu_diff_response(raw: str) -> dict:
    text = _strip_json_fence(raw)
    parsed = json.loads(text)
    if not isinstance(parsed, dict):
        raise HTTPException(status_code=400, detail="GPU diff response must be a JSON object")
    plan = parsed.get("reload_plan") or "mixed"
    if plan not in VALID_RELOAD_PLANS:
        raise HTTPException(status_code=400, detail=f"invalid reload_plan {plan!r}")
    edits = validate_gpu_edit_list(parsed.get("edits", []))
    return {"reload_plan": plan, "edits": edits}


def _normalize_module(module: str) -> str:
    if module in HOST_PATH_TO_MODULE:
        return HOST_PATH_TO_MODULE[module]
    if module in DEVICE_PATHS:
        return "device"
    return module


def _strip_json_fence(raw: str) -> str:
    text = (raw or "").strip()
    if "```json" in text:
        return text.split("```json", 1)[1].split("```", 1)[0].strip()
    if text.startswith("```"):
        return text.split("```", 1)[1].split("```", 1)[0].strip()
    return text


def _device_source(files: Mapping[str, str]) -> str:
    return files.get("device.cu") or files.get("device.hip") or files.get("device") or ""


def _is_device_path(path: str) -> bool:
    lower = path.lower()
    return lower in {"device"} or lower.endswith((".cu", ".cuh", ".hip"))


def _is_host_path(path: str) -> bool:
    return not _is_device_path(path) and not path.endswith(".json")


def _rdc_enabled(manifest_gpu: Optional[Mapping[str, object]]) -> bool:
    if not manifest_gpu:
        return False
    if bool(manifest_gpu.get("rdc")):
        return True
    flags = manifest_gpu.get("device_flags") or []
    if isinstance(flags, str):
        flags = [flags]
    return any(re.search(r"(^|=)(true|1)$", str(f)) and "rdc" in str(f) for f in flags) or any(
        str(f) in {"-rdc=true", "--relocatable-device-code=true", "--gpu-rdc"} for f in flags
    )
