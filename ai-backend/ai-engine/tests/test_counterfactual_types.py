from __future__ import annotations

import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from shadow.counterfactual_types import BranchTrace, CounterfactualStrength, ExposureLevel, PhenotypeVector


def test_branch_trace_serializes_enum_values():
    trace = BranchTrace(
        id="br_1",
        counterfactual_run_id="run_1",
        universe_id="A",
        runner_id="runner",
        runner_kind="internal",
        direction_id="safe",
        direction_label="safe",
        declared_condition="safe universe",
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
        exposure_level=ExposureLevel.SHOWN,
        counterfactual_strength=CounterfactualStrength.WEAK,
    )

    data = trace.to_dict()
    assert data["exposure_level"] == "shown"
    assert data["counterfactual_strength"] == "weak"
    assert data["phenotype_vector"]["reversibility"] == 1.0
