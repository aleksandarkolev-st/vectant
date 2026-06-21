from __future__ import annotations

import sys
from dataclasses import dataclass, field
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from shadow import events
from shadow.counterfactual_types import PolicyDeltaKind
from shadow.multiverse import _capture_counterfactual_evidence
from shadow.policy_delta import STORE, make_policy_delta
from shadow.universe import UniverseSpec
from shadow.universe_planner import apply_policy_deltas


@dataclass
class FakeUniverseResult:
    universe_id: str
    score: float
    evidence: dict
    patches_applied: list = field(default_factory=list)


def test_capture_counterfactual_evidence_filters_failed_proof_branch():
    job = events.JobState("job", "standard", "ws", None)
    job.counterfactual_base_hash = "base"
    results = [
        FakeUniverseResult(
            "A",
            0.99,
            {
                "style": "safe",
                "diagnostics": {"lint": "clean", "types": "clean", "tests": "1/2 passed", "runtime": "clean"},
                "attacks": {"tested": 0, "survived": 0, "failed": []},
                "loc": "+1 −0",
                "score": 0.99,
            },
        ),
        FakeUniverseResult(
            "B",
            0.5,
            {
                "style": "minimalist",
                "diagnostics": {"lint": "clean", "types": "clean", "tests": "2/2 passed", "runtime": "clean"},
                "attacks": {"tested": 0, "survived": 0, "failed": []},
                "loc": "+2 −0",
                "score": 0.5,
            },
        ),
    ]

    eligible = _capture_counterfactual_evidence(job=job, valid=results)

    assert [r.universe_id for r in eligible] == ["B"]
    assert job.proof_verdict["blocked_universe_ids"] == ["A"]
    assert job.selection_verdict["winner"] == "B"


def test_active_policy_delta_changes_next_run_plan():
    STORE.clear()
    delta = make_policy_delta(
        run_id="run",
        workspace_id="workspace",
        task_class="fix",
        delta_kind=PolicyDeltaKind.UNIVERSE_DIRECTION_CHANGE,
        before="default",
        after="raise runtime-primitive universe priority for similar task class",
        confidence="medium",
        evidence_refs=["choice"],
    )
    STORE.add(delta)
    specs = [
        UniverseSpec("A", "minimalist", "m", "c"),
        UniverseSpec("B", "idiomatic", "m", "c"),
    ]

    planned = apply_policy_deltas(specs, STORE.list_active("workspace", "fix"))

    assert [spec.universe_id for spec in planned] == ["B", "A"]
