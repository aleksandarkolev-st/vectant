"""GPU healer agent wrapper."""

from __future__ import annotations

import json
from typing import Any, Dict, Iterable, List, Mapping, Optional

try:
    from pydantic import BaseModel, Field
except ImportError:  # pragma: no cover
    BaseModel = object  # type: ignore
    Field = lambda default_factory=None, **_: default_factory()  # type: ignore

try:
    from fastapi import HTTPException
except ImportError:  # pragma: no cover
    class HTTPException(Exception):  # type: ignore
        def __init__(self, status_code: int, detail: str):
            super().__init__(detail)
            self.status_code = status_code
            self.detail = detail

from agents.gpu_error_triage import triage_gpu_error
from agents.gpu_mod_delta import validate_gpu_edit_list
from llm.prompts import (
    GPU_HEAL_COMPILE_PROMPT,
    GPU_HEAL_PERF_PROMPT,
    GPU_HEAL_RUNTIME_PROMPT,
)
from verifier_gpu import verify_heal_output


PROMPTS = {
    "compile_hard": GPU_HEAL_COMPILE_PROMPT,
    "compile_soft": GPU_HEAL_PERF_PROMPT,
    "runtime": GPU_HEAL_RUNTIME_PROMPT,
}


class GpuHealRequest(BaseModel):
    tier: Optional[str] = None
    error: Dict[str, Any] = Field(default_factory=dict)
    module_hint: Optional[str] = None
    arch_cache: str = ""
    launch_graph: List[dict] = Field(default_factory=list)
    manifest_gpu: Dict[str, Any] = Field(default_factory=dict)
    kernel_sig_hashes: Dict[str, str] = Field(default_factory=dict)
    previous_heal_attempts: List[dict] = Field(default_factory=list)
    project_files: List[str] = Field(default_factory=lambda: ["shared.h", "core.cpp", "gui.cpp", "host_runner.cpp", "device.cu"])
    existing_device_source: str = ""
    host_launch_sites: Dict[str, str] = Field(default_factory=dict)
    model: Optional[str] = None
    api_key: Optional[str] = None


def build_gpu_heal_prompt(req: GpuHealRequest) -> tuple[str, dict]:
    triage = triage_gpu_error(
        {
            "runtime_error": req.error if req.tier == "runtime" else None,
            "diagnostics": req.error.get("parsed") if isinstance(req.error, dict) else {},
            "raw": req.error.get("raw", "") if isinstance(req.error, dict) else "",
            "stderr": req.error.get("raw", "") if isinstance(req.error, dict) else "",
            "exit_code": req.error.get("exit_code") if isinstance(req.error, dict) else None,
        }
    )
    tier = req.tier or triage.tier
    prompt_template = PROMPTS.get(tier)
    if prompt_template is None:
        raise HTTPException(status_code=400, detail=f"unsupported GPU heal tier {tier!r}")
    payload = {
        "tier": tier,
        "error": req.error,
        "module_hint": req.module_hint,
        "arch_cache": req.arch_cache,
        "launch_graph": req.launch_graph,
        "manifest_gpu": req.manifest_gpu,
        "kernel_sig_hashes": req.kernel_sig_hashes,
        "previous_heal_attempts": req.previous_heal_attempts,
        "requires_restart": triage.requires_restart,
    }
    return prompt_template.replace("{PAYLOAD}", json.dumps(payload, indent=2, sort_keys=True)), triage.to_dict()


def parse_gpu_heal_response(raw: str, req: GpuHealRequest) -> dict:
    text = _strip_json_fence(raw)
    parsed = json.loads(text)
    if not isinstance(parsed, dict):
        raise HTTPException(status_code=400, detail="GPU heal response must be a JSON object")
    edits = validate_gpu_edit_list(parsed.get("edits", []))
    verifier_edits = [_to_file_module(edit, req.project_files) for edit in edits]
    verification = verify_heal_output(
        tier=req.tier or "compile_hard",
        project_files=req.project_files,
        edits=verifier_edits,
        existing_kernels=req.kernel_sig_hashes.keys(),
        existing_device_source=req.existing_device_source,
        host_launch_sites=req.host_launch_sites,
    )
    if not verification.ok:
        raise HTTPException(status_code=422, detail=verification.to_dict())
    return {"edits": edits, "verification": verification.to_dict()}


def _to_file_module(edit: Mapping[str, str], project_files: Iterable[str]) -> dict:
    out = dict(edit)
    module = out.get("module")
    files = set(project_files)
    if module == "device":
        out["module"] = "device.cu" if "device.cu" in files else "device.hip"
    elif module == "core":
        out["module"] = "core.cpp"
    elif module == "gui":
        out["module"] = "gui.cpp"
    elif module == "shared":
        out["module"] = "shared.h"
    elif module == "host_runner":
        out["module"] = "host_runner.cpp"
    return out


def _strip_json_fence(raw: str) -> str:
    text = (raw or "").strip()
    if "```json" in text:
        return text.split("```json", 1)[1].split("```", 1)[0].strip()
    if text.startswith("```"):
        return text.split("```", 1)[1].split("```", 1)[0].strip()
    return text
