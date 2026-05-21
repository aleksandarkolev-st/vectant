"""Mechanical GPU diagnostics triage."""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Any, Mapping, Optional


Tier = str

FATAL_CONTEXT_ERRORS = {
    "cudaerrorillegaladdress",
    "cudaerrorlaunchtimeout",
    "cudaerrorassert",
    "cudaerrorinvalidpc",
    "cudaerrorlaunchfailure",
    "hiperrorillegaladdress",
    "hiperrorlaunchtimeout",
    "hiperrorassert",
    "hiperrorlaunchfailure",
    "illegal_address",
    "launch_timeout",
    "assert",
    "invalid_pc",
    "launch_failure",
}


@dataclass(frozen=True)
class GpuTriageResult:
    tier: Tier
    prompt_name: str
    reason: str
    requires_restart: bool = False

    def to_dict(self) -> dict:
        return {
            "tier": self.tier,
            "prompt_name": self.prompt_name,
            "reason": self.reason,
            "requires_restart": self.requires_restart,
        }


def triage_gpu_error(payload: Mapping[str, Any]) -> GpuTriageResult:
    """Map compile/runtime diagnostics to one of the GPU healer tiers."""
    runtime_error = payload.get("runtime_error") or payload.get("gpu_runtime_error")
    if isinstance(runtime_error, Mapping) and runtime_error:
        kind = str(runtime_error.get("kind") or runtime_error.get("code") or "").lower()
        restart = _requires_restart(kind)
        return GpuTriageResult(
            tier="runtime",
            prompt_name="GPU_HEAL_RUNTIME_PROMPT",
            reason=kind or "runtime-error",
            requires_restart=restart,
        )

    if _compile_failed(payload):
        return GpuTriageResult(
            tier="compile_hard",
            prompt_name="GPU_HEAL_COMPILE_PROMPT",
            reason="toolchain-returned-nonzero-or-error",
            requires_restart=False,
        )

    diagnostics = payload.get("diagnostics") or payload.get("parsed") or {}
    soft_reason = _soft_compile_reason(diagnostics, payload)
    if soft_reason:
        return GpuTriageResult(
            tier="compile_soft",
            prompt_name="GPU_HEAL_PERF_PROMPT",
            reason=soft_reason,
            requires_restart=False,
        )

    return GpuTriageResult(
        tier="compile_soft",
        prompt_name="GPU_HEAL_PERF_PROMPT",
        reason="advisory-gpu-diagnostic",
        requires_restart=False,
    )


def _compile_failed(payload: Mapping[str, Any]) -> bool:
    code = payload.get("exit_code")
    if isinstance(code, int) and code != 0:
        return True
    raw = str(payload.get("raw") or payload.get("stderr") or payload.get("error") or "")
    return bool(re.search(r"\b(error|nvlink error|undefined reference)\b", raw, re.IGNORECASE))


def _soft_compile_reason(diagnostics: Any, payload: Mapping[str, Any]) -> Optional[str]:
    records = []
    if isinstance(diagnostics, Mapping):
        for key in ("records", "warnings", "ptxas", "kernels"):
            value = diagnostics.get(key)
            if isinstance(value, list):
                records.extend(value)
        if not records:
            records.append(diagnostics)
    elif isinstance(diagnostics, list):
        records = diagnostics

    for record in records:
        if not isinstance(record, Mapping):
            continue
        if int(record.get("spill_stores", 0) or record.get("spill_bytes", 0) or 0) > 0:
            return "ptxas-spill"
        if int(record.get("registers", 0) or 0) >= int(payload.get("register_threshold", 96) or 96):
            return "register-pressure"
        if int(record.get("constant_bytes", 0) or 0) > 58982:
            return "constant-memory-pressure"
        if int(record.get("shared_bytes", 0) or 0) > int(payload.get("shared_threshold", 49152) or 49152):
            return "shared-memory-pressure"

    raw = str(payload.get("raw") or payload.get("stderr") or "")
    if re.search(r"\b(spill|too much shared|registers)\b", raw, re.IGNORECASE):
        return "ptxas-warning"
    return None


def _requires_restart(kind: str) -> bool:
    normalized = kind.replace("_", "").replace("-", "").lower()
    return normalized in FATAL_CONTEXT_ERRORS
