from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from shadow.hermes_runner import HermesRunner
from shadow.runner_base import RunnerInvocation


def test_hermes_runner_uses_noninteractive_safe_contract():
    invocation = RunnerInvocation(
        run_id="run", universe_id="H", runner_id="hermes", direction_id="safe",
        direction_label="safe", declared_condition="keep scope narrow", start_state_hash="base",
        task_summary="implement safely", policy_hints=["do not touch secrets"],
    )

    argv = HermesRunner().command_for(invocation=invocation)

    assert argv[:5] == ["hermes", "chat", "--quiet", "--query", argv[4]]
    assert "--checkpoints" in argv
    assert "--yolo" in argv
    assert "--ignore-user-config" in argv
    assert "--ignore-rules" in argv
    assert argv[4].startswith("Universe H")
