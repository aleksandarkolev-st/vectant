from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from shadow.counterfactual_store import CounterfactualStore
from shadow.counterfactual_types import (
    BranchTrace,
    ChoiceScene,
    CounterfactualRun,
    DetectorKind,
    DetectorResult,
    DetectorStatus,
    PhenotypeVector,
)


def _trace(run_id: str, branch_id: str = "br_A") -> BranchTrace:
    return BranchTrace(
        id=branch_id,
        counterfactual_run_id=run_id,
        universe_id="A",
        runner_id="runner",
        runner_kind="internal",
        direction_id="safe",
        direction_label="safe",
        declared_condition="safe branch",
        prompt_lineage=[],
        start_state_hash="base",
        end_state_hash="end",
        artifact_summary="compact summary only",
        diff_summary={"loc_added": 1, "loc_removed": 0},
        tool_trace_summary={"raw_log_ref": "artifact://logs/run/A"},
        command_trace_summary={},
        detector_trace_ids=["det_A"],
        cost_trace={"estimated_usd": 0.0},
        latency_trace={"duration_ms": 0},
        risk_trace={"failed_hard_gates": []},
        phenotype_vector=PhenotypeVector(),
        novelty_vector={},
        proof_score=1.0,
        risk_score=0.0,
    )


def test_counterfactual_store_records_run_level_choice_scene_and_evidence_refs():
    store = CounterfactualStore()
    run = CounterfactualRun(
        run_id="run",
        workspace_id="ws",
        request_id="req",
        task_class="fix",
        base_state={"hash": "base"},
        created_at=1.0,
    )
    trace = _trace("run")
    detector = DetectorResult(
        id="det_A",
        branch_trace_id=trace.id,
        detector_kind=DetectorKind.UNIT_TESTS,
        status=DetectorStatus.PASSED,
        score=1.0,
        evidence_summary="2/2 tests passed",
        raw_artifact_ref="artifact://tests/run/A",
    )
    scene = ChoiceScene(
        id="choice",
        counterfactual_run_id="run",
        base_commit_or_state_hash="base",
        request_summary="request",
        task_class="fix",
        available_universe_ids=["A"],
        visible_universe_ids=["A"],
        opened_diff_universe_ids=["A"],
        opened_explanation_universe_ids=[],
        arbiter_recommendation="A",
        selector_action="applied",
        selected_universe_id="A",
    )

    store.put_run(run)
    store.add_branch_traces("run", [trace])
    store.add_detector_results([detector])
    store.add_choice_scene(scene)

    assert store.get_run("run") == run
    assert store.list_branch_traces("run")[0].tool_trace_summary["raw_log_ref"] == "artifact://logs/run/A"
    assert store.list_detector_results(trace.id)[0].raw_artifact_ref == "artifact://tests/run/A"
    assert store.list_choice_scenes("run")[0].selected_universe_id == "A"


def test_counterfactual_store_replaces_duplicate_branch_trace():
    store = CounterfactualStore()
    store.add_branch_traces("run", [_trace("run", "br_A")])
    updated = _trace("run", "br_A")
    updated.proof_score = 0.5
    store.add_branch_traces("run", [updated])

    traces = store.list_branch_traces("run")
    assert len(traces) == 1
    assert traces[0].proof_score == 0.5
