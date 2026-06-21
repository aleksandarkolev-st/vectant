"""ChoiceScene capture and deterministic counterfactual strength."""

from __future__ import annotations

import time
from typing import Iterable, List, Optional

from .counterfactual_types import (
    BranchTrace,
    ChoiceScene,
    CounterfactualStrength,
    ExposureLevel,
    SelectionOutcome,
)


def build_choice_scene(
    *,
    run_id: str,
    base_state_hash: str,
    request_summary: str,
    task_class: str,
    available_universe_ids: Iterable[str],
    visible_universe_ids: Iterable[str],
    arbiter_recommendation: Optional[str],
    selector_action: str,
    selected_universe_id: Optional[str],
    opened_diff_universe_ids: Optional[Iterable[str]] = None,
    opened_explanation_universe_ids: Optional[Iterable[str]] = None,
    ambiguity_flags: Optional[List[str]] = None,
    cancel_stage: Optional[str] = None,
) -> ChoiceScene:
    visible = list(dict.fromkeys(visible_universe_ids))
    opened_diff = list(dict.fromkeys(opened_diff_universe_ids or visible))
    opened_explanation = list(dict.fromkeys(opened_explanation_universe_ids or []))
    flags = list(ambiguity_flags or [])
    if selector_action == "cancelled" and not visible:
        flags.append("branch_not_visible_to_selector")
    return ChoiceScene(
        id=f"choice_{run_id}_{int(time.time() * 1000)}",
        counterfactual_run_id=run_id,
        base_commit_or_state_hash=base_state_hash,
        request_summary=request_summary[:480],
        task_class=task_class,
        available_universe_ids=list(dict.fromkeys(available_universe_ids)),
        visible_universe_ids=visible,
        opened_diff_universe_ids=opened_diff,
        opened_explanation_universe_ids=opened_explanation,
        arbiter_recommendation=arbiter_recommendation,
        selector_action=selector_action,
        selected_universe_id=selected_universe_id,
        cancel_stage=cancel_stage,
        ambiguity_flags=list(dict.fromkeys(flags)),
    )


def compute_counterfactual_strength(branch: BranchTrace, choice_scene: ChoiceScene) -> CounterfactualStrength:
    uid = branch.universe_id
    if uid not in choice_scene.visible_universe_ids:
        return CounterfactualStrength.NONE
    if uid not in choice_scene.opened_diff_universe_ids:
        return CounterfactualStrength.WEAK
    if uid == choice_scene.arbiter_recommendation and choice_scene.user_overrode_arbiter:
        return CounterfactualStrength.STRONG
    if uid == choice_scene.selected_universe_id and choice_scene.selector_action == "applied":
        return CounterfactualStrength.MEDIUM
    return CounterfactualStrength.MEDIUM


def annotate_traces_with_choice(traces: List[BranchTrace], choice_scene: ChoiceScene) -> List[BranchTrace]:
    out: List[BranchTrace] = []
    selected = choice_scene.selected_universe_id
    for trace in traces:
        trace.counterfactual_strength = compute_counterfactual_strength(trace, choice_scene)
        if trace.universe_id == selected and choice_scene.selector_action == "applied":
            trace.selection_outcome = SelectionOutcome.SELECTED
            trace.exposure_level = ExposureLevel.APPLIED
        elif choice_scene.selector_action == "cancelled":
            trace.selection_outcome = SelectionOutcome.CANCELLED
        elif trace.counterfactual_strength == CounterfactualStrength.NONE:
            trace.selection_outcome = SelectionOutcome.UNKNOWN
            if "branch_not_visible_to_selector" not in trace.ambiguity_flags:
                trace.ambiguity_flags.append("branch_not_visible_to_selector")
        else:
            trace.selection_outcome = SelectionOutcome.NOT_SELECTED
            trace.exposure_level = ExposureLevel.DIFF_OPENED
        out.append(trace)
    return out
