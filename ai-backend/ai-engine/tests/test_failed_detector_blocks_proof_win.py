from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from shadow.counterfactual_types import BranchTrace, DetectorKind, DetectorResult, DetectorStatus, PhenotypeVector
from shadow.proof_arbiter import adjudicate_proof
from shadow.selection_arbiter import rank_selection


def _trace(uid: str, score: float) -> BranchTrace:
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
        proof_score=score,
        risk_score=0.0,
    )


def test_failed_detector_blocks_selection_even_with_high_score():
    traces = [_trace("A", 0.99), _trace("B", 0.5)]
    detectors = [
        DetectorResult("det_a", "br_A", DetectorKind.UNIT_TESTS, DetectorStatus.FAILED, 0.0, "1/2 passed"),
        DetectorResult("det_b", "br_B", DetectorKind.UNIT_TESTS, DetectorStatus.PASSED, 1.0, "2/2 passed"),
    ]

    proof = adjudicate_proof(traces, detectors)
    selection = rank_selection(traces, proof)

    assert proof.blocked_universe_ids == ["A"]
    assert selection.winner == "B"
    assert selection.risky_candidates == ["A"]
