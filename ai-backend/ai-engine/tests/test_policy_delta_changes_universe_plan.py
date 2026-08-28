from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from shadow.counterfactual_types import PolicyDeltaKind
from shadow.policy_delta import make_policy_delta
from shadow.universe import UniverseSpec
from shadow.universe_planner import apply_policy_deltas


def test_policy_delta_changes_universe_plan():
    specs = [
        UniverseSpec("A", "minimalist", "m", "c"),
        UniverseSpec("B", "idiomatic", "m", "c"),
        UniverseSpec("C", "safe", "m", "c"),
    ]
    delta = make_policy_delta(
        run_id="run",
        workspace_id="ws",
        task_class="fix",
        delta_kind=PolicyDeltaKind.UNIVERSE_DIRECTION_CHANGE,
        before="default",
        after="raise runtime-primitive universe priority for similar task class",
        confidence="medium",
        evidence_refs=["choice"],
    )

    planned = apply_policy_deltas(specs, [delta])

    assert planned[0].style == "idiomatic"
