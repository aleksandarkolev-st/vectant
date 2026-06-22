"""Runner adapter contract for counterfactual branch telemetry.

Adapters normalize external agent runs into BranchTrace. They do not own
selection, proof gates, or policy learning; those stay in the counterfactual
control plane.
"""

from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Dict, List, Optional

from .counterfactual_types import (
    BranchTrace,
    CostTrace,
    ExposureLevel,
    LatencyTrace,
    PhenotypeVector,
    RiskTrace,
)


@dataclass
class RunnerInvocation:
    run_id: str
    universe_id: str
    runner_id: str
    direction_id: str
    direction_label: str
    declared_condition: str
    start_state_hash: str
    prompt_lineage: List[str] = field(default_factory=list)


@dataclass
class RunnerArtifact:
    artifact_summary: str
    diff_summary: Dict[str, Any] = field(default_factory=dict)
    command_summary: Dict[str, Any] = field(default_factory=dict)
    tool_summary: Dict[str, Any] = field(default_factory=dict)
    detector_trace_ids: List[str] = field(default_factory=list)
    raw_log_ref: Optional[str] = None
    cost_estimated_usd: float = 0.0
    cost_actual_usd: Optional[float] = None
    latency_ms: int = 0
    timed_out: bool = False
    failed_hard_gates: List[str] = field(default_factory=list)
    risk_warnings: List[str] = field(default_factory=list)
    phenotype_vector: PhenotypeVector = field(default_factory=PhenotypeVector)
    novelty_vector: Dict[str, float] = field(default_factory=dict)
    proof_score: float = 0.0
    risk_score: float = 0.0
    end_state_hash: str = ""


class BaseRunnerAdapter:
    runner_kind = "custom"

    def prepare_workspace_snapshot(self, workspace_path: Path) -> Dict[str, Any]:
        path = Path(workspace_path)
        files = sorted(
            str(p.relative_to(path)).replace("\\", "/")
            for p in path.rglob("*")
            if p.is_file() and ".git" not in p.parts
        )
        digest = hashlib.sha1(json.dumps(files, sort_keys=True).encode("utf-8")).hexdigest()
        return {"workspace_path": str(path), "file_count": len(files), "state_hash": digest}

    def collect_trace(self, invocation: RunnerInvocation, artifact: RunnerArtifact) -> BranchTrace:
        tool_summary = dict(artifact.tool_summary)
        if artifact.raw_log_ref:
            tool_summary["raw_log_ref"] = artifact.raw_log_ref
        novelty = artifact.novelty_vector or artifact.phenotype_vector.to_dict()
        return BranchTrace(
            id=f"br_{invocation.run_id}_{invocation.universe_id}",
            counterfactual_run_id=invocation.run_id,
            universe_id=invocation.universe_id,
            runner_id=invocation.runner_id,
            runner_kind=self.runner_kind,
            direction_id=invocation.direction_id,
            direction_label=invocation.direction_label,
            declared_condition=invocation.declared_condition,
            prompt_lineage=list(invocation.prompt_lineage),
            start_state_hash=invocation.start_state_hash,
            end_state_hash=artifact.end_state_hash or _hash_artifact(artifact),
            artifact_summary=artifact.artifact_summary,
            diff_summary=dict(artifact.diff_summary),
            tool_trace_summary=tool_summary,
            command_trace_summary=dict(artifact.command_summary),
            detector_trace_ids=list(artifact.detector_trace_ids),
            cost_trace=CostTrace(
                estimated_usd=artifact.cost_estimated_usd,
                actual_usd=artifact.cost_actual_usd,
            ),
            latency_trace=LatencyTrace(
                duration_ms=artifact.latency_ms,
                timed_out=artifact.timed_out,
            ),
            risk_trace=RiskTrace(
                failed_hard_gates=list(artifact.failed_hard_gates),
                warnings=list(artifact.risk_warnings),
            ),
            phenotype_vector=artifact.phenotype_vector,
            novelty_vector=novelty,
            proof_score=artifact.proof_score,
            risk_score=artifact.risk_score,
            exposure_level=ExposureLevel.GENERATED,
        )


def _hash_artifact(artifact: RunnerArtifact) -> str:
    payload = {
        "artifact_summary": artifact.artifact_summary,
        "diff_summary": artifact.diff_summary,
        "command_summary": artifact.command_summary,
        "detector_trace_ids": artifact.detector_trace_ids,
        "raw_log_ref": artifact.raw_log_ref,
    }
    return hashlib.sha1(json.dumps(payload, sort_keys=True).encode("utf-8")).hexdigest()
