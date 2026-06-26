from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from shadow.claude_code_runner import ClaudeCodeRunner
from shadow.runner_base import RunnerArtifact, RunnerInvocation


def test_claude_code_runner_trace_shape():
    trace = ClaudeCodeRunner().collect_trace(
        RunnerInvocation(
            run_id="run",
            universe_id="C",
            runner_id="claude-code",
            direction_id="minimal",
            direction_label="minimal patch",
            declared_condition="keep the patch narrow",
            start_state_hash="base",
            prompt_lineage=["system", "user"],
        ),
        RunnerArtifact(
            artifact_summary="minimal branch",
            diff_summary={"loc_added": 2, "loc_removed": 0},
            raw_log_ref="artifact://claude/run/C/session.jsonl",
            risk_warnings=["manual review required"],
            risk_score=0.2,
        ),
    )

    assert trace.runner_kind == "claude_code"
    assert trace.prompt_lineage == ["system", "user"]
    assert trace.risk_trace.warnings == ["manual review required"]
    assert trace.tool_trace_summary["raw_log_ref"] == "artifact://claude/run/C/session.jsonl"
