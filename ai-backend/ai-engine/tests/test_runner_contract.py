from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from shadow.counterfactual_types import BranchTrace
from shadow.runner_base import BaseRunnerAdapter, RunnerArtifact, RunnerInvocation


def test_runner_contract_normalizes_artifact_without_inlining_logs(tmp_path):
    (tmp_path / "app.py").write_text("print('ok')\n", encoding="utf-8")
    adapter = BaseRunnerAdapter()
    snapshot = adapter.prepare_workspace_snapshot(tmp_path)
    trace = adapter.collect_trace(
        RunnerInvocation(
            run_id="run",
            universe_id="A",
            runner_id="runner-a",
            direction_id="safe",
            direction_label="safe",
            declared_condition="conservative local fix",
            start_state_hash=snapshot["state_hash"],
            prompt_lineage=["root"],
        ),
        RunnerArtifact(
            artifact_summary="one-file patch",
            diff_summary={"files_changed": 1, "loc_added": 1, "loc_removed": 0},
            raw_log_ref="artifact://logs/run/A",
            detector_trace_ids=["det_1"],
            proof_score=0.9,
        ),
    )

    assert isinstance(trace, BranchTrace)
    assert trace.runner_kind == "custom"
    assert trace.start_state_hash == snapshot["state_hash"]
    assert trace.tool_trace_summary == {"raw_log_ref": "artifact://logs/run/A"}
    assert "print('ok')" not in trace.to_dict()["artifact_summary"]


def test_runner_snapshot_hash_changes_with_workspace_files(tmp_path):
    adapter = BaseRunnerAdapter()
    before = adapter.prepare_workspace_snapshot(tmp_path)["state_hash"]
    (tmp_path / "new.txt").write_text("x", encoding="utf-8")
    after = adapter.prepare_workspace_snapshot(tmp_path)["state_hash"]

    assert before != after
