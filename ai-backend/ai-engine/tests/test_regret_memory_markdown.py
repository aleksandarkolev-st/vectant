from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from shadow.counterfactual_types import PolicyDeltaKind
from shadow.policy_delta import make_policy_delta
from shadow.regret_memory_markdown import append_session_memory, load_policy_deltas, memory_path


def test_appends_hidden_markdown_and_reloads_policy_delta(tmp_path):
    repo = tmp_path / "workspace"
    repo.mkdir()
    delta = make_policy_delta(
        run_id="run_1",
        workspace_id=str(repo),
        task_class="fix",
        delta_kind=PolicyDeltaKind.UNIVERSE_DIRECTION_CHANGE,
        before="default universe direction order",
        after="raise runtime-primitive universe priority for similar task class",
        confidence="medium",
        evidence_refs=["choice_1"],
    )

    path = append_session_memory(
        repo,
        task_class="fix",
        learned_lines=["Selector preferred deeper runtime-level branch."],
        policy_deltas=[delta],
        run_id="run_1",
        now=1_800_000_000,
    )

    assert path == memory_path(repo)
    assert path.name == "regret-memory.md"
    assert path.parent.name == ".vectant"
    text = path.read_text(encoding="utf-8")
    assert "Selector preferred deeper runtime-level branch." in text
    assert "vectant:policy-delta" in text

    loaded = load_policy_deltas(repo, "fix", workspace_id=str(repo))
    assert len(loaded) == 1
    assert loaded[0].id == delta.id
    assert loaded[0].after == "raise runtime-primitive universe priority for similar task class"


def test_load_policy_deltas_ignores_unrelated_task_class(tmp_path):
    repo = tmp_path / "workspace"
    repo.mkdir()
    delta = make_policy_delta(
        run_id="run_1",
        workspace_id=str(repo),
        task_class="refactor",
        delta_kind=PolicyDeltaKind.ARBITER_WEIGHT_CHANGE,
        before="default",
        after="lower size tolerance unless proof delta is large",
        confidence="medium",
        evidence_refs=["choice_1"],
    )
    append_session_memory(
        repo,
        task_class="refactor",
        learned_lines=[],
        policy_deltas=[delta],
        run_id="run_1",
    )

    assert load_policy_deltas(repo, "fix", workspace_id=str(repo)) == []
