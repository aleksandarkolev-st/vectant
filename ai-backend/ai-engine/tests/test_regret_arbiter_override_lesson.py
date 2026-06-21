from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from shadow.choice_scene import annotate_traces_with_choice, build_choice_scene
from shadow.counterfactual_types import BranchTrace, PhenotypeVector
from shadow.regret_arbiter import extract_regret_lessons


def _trace(uid: str, loc: int, runtime_depth: float = 0.1) -> BranchTrace:
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
        diff_summary={"loc_added": loc, "loc_removed": 0},
        tool_trace_summary={},
        command_trace_summary={},
        detector_trace_ids=[],
        cost_trace={"estimated_usd": 0.0},
        latency_trace={"duration_ms": 0},
        risk_trace={"failed_hard_gates": []},
        phenotype_vector=PhenotypeVector(runtime_depth=runtime_depth),
        novelty_vector={},
        proof_score=1.0,
        risk_score=0.0,
    )


def test_regret_arbiter_extracts_override_policy_delta():
    scene = build_choice_scene(
        run_id="run",
        base_state_hash="base",
        request_summary="request",
        task_class="agent_feature",
        available_universe_ids=["A", "B"],
        visible_universe_ids=["A", "B"],
        opened_diff_universe_ids=["A", "B"],
        arbiter_recommendation="A",
        selector_action="applied",
        selected_universe_id="B",
    )
    traces = annotate_traces_with_choice([_trace("A", 40), _trace("B", 5)], scene)

    lessons = extract_regret_lessons(choice_scene=scene, traces=traces, workspace_id="ws")

    assert [lesson.kind for lesson in lessons] == ["smaller_over_higher_proof"]
    assert lessons[0].policy_delta.delta_kind.value == "arbiter_weight_change"


def test_cancel_before_visibility_does_not_create_taste_lesson():
    scene = build_choice_scene(
        run_id="run",
        base_state_hash="base",
        request_summary="request",
        task_class="agent_feature",
        available_universe_ids=["A", "B"],
        visible_universe_ids=[],
        arbiter_recommendation="A",
        selector_action="cancelled",
        selected_universe_id=None,
    )
    traces = annotate_traces_with_choice([_trace("A", 40), _trace("B", 5)], scene)

    assert extract_regret_lessons(choice_scene=scene, traces=traces, workspace_id="ws") == []
