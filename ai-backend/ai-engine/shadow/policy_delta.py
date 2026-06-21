"""PolicyDelta helpers and in-memory workspace store."""

from __future__ import annotations

import time
import uuid
from dataclasses import dataclass, field
from typing import Dict, Iterable, List

from .counterfactual_types import PolicyDelta, PolicyDeltaKind, PolicyDeltaStatus


@dataclass
class PolicyDeltaStore:
    _by_workspace: Dict[str, List[PolicyDelta]] = field(default_factory=dict)

    def add(self, delta: PolicyDelta) -> None:
        self._by_workspace.setdefault(delta.workspace_id, []).append(delta)

    def list_active(self, workspace_id: str, task_class: str, *, now: float | None = None) -> List[PolicyDelta]:
        now_value = time.time() if now is None else now
        out: List[PolicyDelta] = []
        for delta in self._by_workspace.get(workspace_id, []):
            if delta.task_class != task_class:
                continue
            if delta.status in {PolicyDeltaStatus.CONTRADICTED, PolicyDeltaStatus.DELETED}:
                continue
            if delta.expiry is not None and delta.expiry <= now_value:
                continue
            out.append(delta)
        return out

    def clear(self) -> None:
        self._by_workspace.clear()


STORE = PolicyDeltaStore()


def make_policy_delta(
    *,
    run_id: str,
    workspace_id: str,
    task_class: str,
    delta_kind: PolicyDeltaKind,
    before: str,
    after: str,
    confidence: str,
    evidence_refs: Iterable[str],
    status: PolicyDeltaStatus = PolicyDeltaStatus.HYPOTHESIS,
) -> PolicyDelta:
    return PolicyDelta(
        id=f"pdelta_{uuid.uuid4().hex[:12]}",
        source_counterfactual_run_id=run_id,
        workspace_id=workspace_id,
        task_class=task_class,
        delta_kind=delta_kind,
        before=before,
        after=after,
        confidence=confidence,
        evidence_refs=list(evidence_refs),
        status=status,
    )


def persist_policy_deltas(deltas: Iterable[PolicyDelta]) -> None:
    for delta in deltas:
        STORE.add(delta)
