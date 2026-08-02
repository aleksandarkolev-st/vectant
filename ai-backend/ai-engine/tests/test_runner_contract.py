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


def test_runner_executes_explicit_argv_and_stores_raw_artifact_by_reference(tmp_path):
    adapter = BaseRunnerAdapter()
    invocation = RunnerInvocation(
        run_id="run-real", universe_id="A", runner_id="fixture", direction_id="safe",
        direction_label="safe", declared_condition="fixture execution", start_state_hash="base",
        task_summary="emit a bounded summary", timeout_seconds=10,
    )

    artifact = adapter.run(
        workspace_path=tmp_path,
        invocation=invocation,
        command=[sys.executable, "-c", "print('runner summary')"],
    )

    assert artifact.command_summary["exit_code"] == 0
    assert artifact.raw_log_ref == ".vectant/runner-artifacts/run-real/custom-A.json"
    assert "runner summary" in artifact.artifact_summary
    assert (tmp_path / artifact.raw_log_ref).is_file()
    trace = adapter.collect_trace(invocation, artifact)
    assert trace.tool_trace_summary["raw_log_ref"] == artifact.raw_log_ref
    assert "runner summary" not in trace.tool_trace_summary["raw_log_ref"]
