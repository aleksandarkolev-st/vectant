"""Regret Arbiter: deterministic lessons after real selection."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Dict, Iterable, List

from .counterfactual_types import (
    BranchTrace,
    ChoiceScene,
    CounterfactualStrength,
    PolicyDelta,
    PolicyDeltaKind,
)
from .policy_delta import make_policy_delta


@dataclass
class RegretLesson:
    kind: str
    text: str
    confidence: str
    policy_delta: PolicyDelta

    def to_dict(self) -> Dict[str, object]:
        return {
            "kind": self.kind,
            "text": self.text,
            "confidence": self.confidence,
            "policy_delta": self.policy_delta.to_dict(),
        }


def extract_regret_lessons(
    *,
    choice_scene: ChoiceScene,
    traces: Iterable[BranchTrace],
    workspace_id: str,
) -> List[RegretLesson]:
    if _too_ambiguous(choice_scene):
        return []
    if not choice_scene.user_overrode_arbiter:
        return []

    by_id = {trace.universe_id: trace for trace in traces}
    selected = by_id.get(choice_scene.selected_universe_id or "")
    arbiter_pick = by_id.get(choice_scene.arbiter_recommendation or "")
    if not selected or not arbiter_pick:
        return []
    if _trace_too_ambiguous(selected) or _trace_too_ambiguous(arbiter_pick):
        return []
    if arbiter_pick.counterfactual_strength != CounterfactualStrength.STRONG:
        return []

    lessons: List[RegretLesson] = []
    selected_loc = _loc(selected)
    arbiter_loc = _loc(arbiter_pick)
    if selected_loc < arbiter_loc:
        delta = make_policy_delta(
            run_id=choice_scene.counterfactual_run_id,
            workspace_id=workspace_id,
            task_class=choice_scene.task_class,
            delta_kind=PolicyDeltaKind.ARBITER_WEIGHT_CHANGE,
            before="size-tolerant ranking for similar task class",
            after="lower size tolerance unless proof delta is large",
            confidence="medium",
            evidence_refs=[choice_scene.id, selected.id, arbiter_pick.id],
        )
        lessons.append(RegretLesson(
            kind="smaller_over_higher_proof",
            text="Selector preferred smaller branch over Arbiter recommendation.",
            confidence="medium",
            policy_delta=delta,
        ))

    if selected.phenotype_vector.runtime_depth > arbiter_pick.phenotype_vector.runtime_depth:
        delta = make_policy_delta(
            run_id=choice_scene.counterfactual_run_id,
            workspace_id=workspace_id,
            task_class=choice_scene.task_class,
            delta_kind=PolicyDeltaKind.UNIVERSE_DIRECTION_CHANGE,
            before="default universe direction order",
            after="raise runtime-primitive universe priority for similar task class",
            confidence="medium",
            evidence_refs=[choice_scene.id, selected.id, arbiter_pick.id],
        )
        lessons.append(RegretLesson(
            kind="runtime_depth_over_surface",
            text="Selector preferred deeper runtime-level branch over surface-level recommendation.",
            confidence="medium",
            policy_delta=delta,
        ))
    return lessons


def _too_ambiguous(choice_scene: ChoiceScene) -> bool:
    blocking_flags = {
        "branch_not_visible_to_selector",
        "budget_exhausted",
        "detector_incomplete",
        "permission_blocked",
        "latency_abort",
        "merge_conflict",
        "stale_branch",
        "selector_unknown",
        "applied_due_to_time_pressure",
        "final_selection_external",
        "user_left_session",
    }
    return bool(blocking_flags.intersection(choice_scene.ambiguity_flags))


def _trace_too_ambiguous(trace: BranchTrace) -> bool:
    blocking_flags = {
        "branch_failed_before_comparison",
        "branch_not_visible_to_selector",
        "budget_exhausted",
        "detector_incomplete",
        "latency_abort",
        "merge_conflict",
        "permission_blocked",
        "stale_branch",
        "selector_unknown",
        "applied_due_to_time_pressure",
        "final_selection_external",
        "user_left_session",
    }
    return bool(blocking_flags.intersection(trace.ambiguity_flags))


def _loc(trace: BranchTrace) -> int:
    return int(trace.diff_summary.get("loc_added", 0) or 0) + int(trace.diff_summary.get("loc_removed", 0) or 0)
