from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from shadow.counterfactual_types import PolicyDeltaKind
from shadow.policy_delta import make_policy_delta


def test_policy_delta_schema_serializes_status_and_kind():
    delta = make_policy_delta(
        run_id="run",
        workspace_id="ws",
        task_class="fix",
        delta_kind=PolicyDeltaKind.UNIVERSE_DIRECTION_CHANGE,
        before="default",
        after="raise runtime-primitive universe priority",
        confidence="medium",
        evidence_refs=["choice"],
    )

    data = delta.to_dict()
    assert data["delta_kind"] == "universe_direction_change"
    assert data["status"] == "hypothesis"
    assert data["evidence_refs"] == ["choice"]
