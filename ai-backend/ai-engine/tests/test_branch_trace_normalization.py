from __future__ import annotations

import sys
from dataclasses import dataclass, field
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from shadow.branch_trace import normalize_universe_result, parse_loc


@dataclass
class FakeUniverseResult:
    universe_id: str
    evidence: dict
    patches_applied: list = field(default_factory=list)


def test_parse_loc_accepts_unicode_minus():
    assert parse_loc("+12 −3") == (12, 3)


def test_normalize_universe_result_emits_branch_trace_and_detectors():
    result = FakeUniverseResult(
        universe_id="B",
        evidence={
            "style": "idiomatic",
            "model_pair": ["gpt", "claude"],
            "diagnostics": {"lint": "clean", "types": "clean", "tests": "2/2 passed", "runtime": "clean"},
            "attacks": {"tested": 1, "survived": 1, "failed": []},
            "loc": "+8 −2",
            "score": 0.92,
            "duration_ms": 120,
        },
        patches_applied=[object()],
    )

    trace, detectors = normalize_universe_result(run_id="run_1", universe_result=result, start_state_hash="base")

    assert trace.universe_id == "B"
    assert trace.diff_summary == {"loc_added": 8, "loc_removed": 2, "files_changed": 1}
    assert trace.proof_score == 0.92
    assert trace.latency_trace.duration_ms == 120
    assert len(detectors) == 5
    assert {d.status.value for d in detectors} == {"passed"}
