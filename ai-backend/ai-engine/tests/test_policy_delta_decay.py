from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from shadow.counterfactual_types import PolicyDeltaKind
from shadow.policy_delta import PolicyDeltaStore, make_policy_delta


def test_policy_delta_expires_out_of_active_policy():
    store = PolicyDeltaStore()
    delta = make_policy_delta(
        run_id="run",
        workspace_id="ws",
        task_class="fix",
        delta_kind=PolicyDeltaKind.UNIVERSE_DIRECTION_CHANGE,
        before="default",
        after="raise runtime-primitive universe priority",
        confidence="medium",
        evidence_refs=["choice"],
        expiry=10.0,
    )
    store.add(delta)

    assert store.list_active("ws", "fix", now=9.0) == [delta]
    assert store.list_active("ws", "fix", now=10.0) == []


def test_policy_delta_delete_removes_delta_from_active_policy():
    store = PolicyDeltaStore()
    delta = make_policy_delta(
        run_id="run",
        workspace_id="ws",
        task_class="fix",
        delta_kind=PolicyDeltaKind.ARBITER_WEIGHT_CHANGE,
        before="size tolerant",
        after="lower size tolerance",
        confidence="medium",
        evidence_refs=["choice"],
    )
    store.add(delta)

    assert store.delete("ws", delta.id) is True
    assert store.list_active("ws", "fix") == []
    assert store.delete("ws", "missing") is False
