from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from shadow.codex_runner import CodexRunner
from shadow.runner_base import RunnerArtifact, RunnerInvocation


def test_codex_runner_trace_shape():
    trace = CodexRunner().collect_trace(
        RunnerInvocation(
            run_id="run",
            universe_id="B",
            runner_id="codex-local",
            direction_id="runtime",
            direction_label="runtime primitive",
            declared_condition="try a runtime-level primitive",
            start_state_hash="base",
        ),
        RunnerArtifact(
            artifact_summary="runtime primitive branch",
            diff_summary={"loc_added": 8, "loc_removed": 2},
            command_summary={"commands": ["pytest -q"]},
            raw_log_ref="artifact://codex/run/B/log.jsonl",
            latency_ms=120,
            proof_score=0.88,
        ),
    )

    assert trace.runner_kind == "codex"
    assert trace.runner_id == "codex-local"
    assert trace.direction_label == "runtime primitive"
    assert trace.command_trace_summary["commands"] == ["pytest -q"]
    assert trace.tool_trace_summary["raw_log_ref"] == "artifact://codex/run/B/log.jsonl"
    assert trace.latency_trace.duration_ms == 120


def test_codex_runner_uses_noninteractive_workspace_write_contract(tmp_path):
    invocation = RunnerInvocation(
        run_id="run", universe_id="B", runner_id="codex-local", direction_id="runtime",
        direction_label="runtime primitive", declared_condition="runtime primitive", start_state_hash="base",
        task_summary="implement the primitive", policy_hints=["prefer proof"],
    )
    argv = CodexRunner().command_for(
        invocation=invocation, output_schema=tmp_path / "schema.json", output_path=tmp_path / "out.json",
    )

    assert argv[:4] == ["codex", "exec", "--sandbox", "workspace-write"]
    assert "--output-schema" in argv
    assert "Universe B" in argv[-1]
