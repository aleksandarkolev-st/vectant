from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from shadow.choice_scene import annotate_traces_with_choice, build_choice_scene
from shadow.counterfactual_types import BranchTrace, CounterfactualStrength, PhenotypeVector, SelectionOutcome


def _trace(uid: str) -> BranchTrace:
    return BranchTrace(
        id=f"br_{uid}",
        counterfactual_run_id="run",
        universe_id=uid,
        runner_id="runner",
        runner_kind="internal",
        direction_id=uid,
        direction_label=uid,
        declared_condition=uid,
        prompt_lineage=[],
        start_state_hash="base",
        end_state_hash="end",
        artifact_summary="summary",
        diff_summary={"loc_added": 1, "loc_removed": 0},
        tool_trace_summary={},
        command_trace_summary={},
        detector_trace_ids=[],
        cost_trace={"estimated_usd": 0.0},
        latency_trace={"duration_ms": 0},
        risk_trace={"failed_hard_gates": []},
        phenotype_vector=PhenotypeVector(),
        novelty_vector={},
        proof_score=1.0,
        risk_score=0.0,
    )


def test_generated_unshown_branch_has_no_counterfactual_strength():
    scene = build_choice_scene(
        run_id="run",
        base_state_hash="base",
        request_summary="request",
        task_class="fix",
        available_universe_ids=["A", "B"],
        visible_universe_ids=["A"],
        arbiter_recommendation="A",
        selector_action="applied",
        selected_universe_id="A",
    )
    traces = annotate_traces_with_choice([_trace("A"), _trace("B")], scene)
    b = next(t for t in traces if t.universe_id == "B")
    assert b.counterfactual_strength == CounterfactualStrength.NONE
    assert b.selection_outcome == SelectionOutcome.UNKNOWN


def test_opened_overridden_arbiter_winner_has_strong_signal():
    scene = build_choice_scene(
        run_id="run",
        base_state_hash="base",
        request_summary="request",
        task_class="fix",
        available_universe_ids=["A", "B"],
        visible_universe_ids=["A", "B"],
        opened_diff_universe_ids=["A", "B"],
        arbiter_recommendation="A",
        selector_action="applied",
        selected_universe_id="B",
    )
    traces = annotate_traces_with_choice([_trace("A"), _trace("B")], scene)
    a = next(t for t in traces if t.universe_id == "A")
    assert a.counterfactual_strength == CounterfactualStrength.STRONG
