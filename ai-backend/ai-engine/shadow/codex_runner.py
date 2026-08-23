"""Codex runner adapter.

This module keeps Codex as a pluggable runner. It normalizes Codex artifacts
that were produced elsewhere; it does not call the Codex CLI from the control
plane.
"""

from __future__ import annotations

from pathlib import Path
from typing import List

from .runner_base import BaseRunnerAdapter, RunnerInvocation


class CodexRunner(BaseRunnerAdapter):
    runner_kind = "codex"

    def command_for(
        self,
        *,
        invocation: RunnerInvocation,
        output_schema: Path,
        output_path: Path,
        executable: str = "codex",
    ) -> List[str]:
        """Build Codex' documented non-interactive argv, never a shell string."""
        prompt = (
            f"Universe {invocation.universe_id}: {invocation.declared_condition}.\n"
            f"Task: {invocation.task_summary}\n"
            f"Policy hints: {' | '.join(invocation.policy_hints[:5]) or 'none'}\n"
            "Work only in the current workspace. Return a bounded branch summary matching the output schema."
        )
        return [
            executable, "exec", "--sandbox", "workspace-write",
            "--output-schema", str(output_schema), "-o", str(output_path), prompt,
        ]

    def live_command_for(self, *, invocation: RunnerInvocation, executable: str = "codex") -> List[str]:
        """Build the live harness contract without controller-owned files."""
        prompt = (
            f"Universe {invocation.universe_id}: {invocation.declared_condition}.\n"
            f"Task: {invocation.task_summary}\n"
            f"Policy hints: {' | '.join(invocation.policy_hints[:5]) or 'none'}\n"
            "Work only in the current workspace. Do not modify protected files."
        )
        return [executable, "exec", "--sandbox", "workspace-write", prompt]
