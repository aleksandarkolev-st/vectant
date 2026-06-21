"""Execution Niche Map aggregation from active policy deltas."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Dict, List

from .counterfactual_types import PolicyDelta, PolicyDeltaKind


@dataclass
class ExecutionNicheMap:
    workspace_id: str
    task_class: str
    policy_hints: List[str] = field(default_factory=list)
    patch_size_bias: str = "neutral"
    runtime_depth_preference: str = "neutral"
    confidence: str = "low"
    sample_count: int = 0
    last_fossil_ids: List[str] = field(default_factory=list)

    def to_dict(self) -> Dict[str, object]:
        return {
            "workspace_id": self.workspace_id,
            "task_class": self.task_class,
            "policy_hints": self.policy_hints,
            "patch_size_bias": self.patch_size_bias,
            "runtime_depth_preference": self.runtime_depth_preference,
            "confidence": self.confidence,
            "sample_count": self.sample_count,
            "last_fossil_ids": self.last_fossil_ids,
        }


def build_execution_niche_map(workspace_id: str, task_class: str, deltas: List[PolicyDelta]) -> ExecutionNicheMap:
    hints: List[str] = []
    patch_size_bias = "neutral"
    runtime_depth_preference = "neutral"
    for delta in deltas:
        hints.append(delta.after)
        if delta.delta_kind == PolicyDeltaKind.ARBITER_WEIGHT_CHANGE and "size" in delta.after:
            patch_size_bias = "smaller_when_proof_close"
        if delta.delta_kind == PolicyDeltaKind.UNIVERSE_DIRECTION_CHANGE and "runtime" in delta.after:
            runtime_depth_preference = "raise_runtime_primitive"
    confidence = "medium" if deltas else "low"
    return ExecutionNicheMap(
        workspace_id=workspace_id,
        task_class=task_class,
        policy_hints=hints[:5],
        patch_size_bias=patch_size_bias,
        runtime_depth_preference=runtime_depth_preference,
        confidence=confidence,
        sample_count=len(deltas),
        last_fossil_ids=[ref for delta in deltas[-5:] for ref in delta.evidence_refs[:1]],
    )
