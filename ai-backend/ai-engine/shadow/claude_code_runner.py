"""Claude Code runner adapter.

This module keeps Claude Code as a pluggable runner. It normalizes Claude
artifacts that were produced elsewhere; it does not call the Claude CLI from
the control plane.
"""

from __future__ import annotations

from typing import List

from .runner_base import BaseRunnerAdapter, RunnerInvocation


class ClaudeCodeRunner(BaseRunnerAdapter):
    runner_kind = "claude_code"

    def command_for(self, *, invocation: RunnerInvocation, executable: str = "claude") -> List[str]:
        """Build a non-interactive Claude Code invocation with explicit scope."""
        prompt = (
            f"Universe {invocation.universe_id}: {invocation.declared_condition}.\n"
            f"Task: {invocation.task_summary}\n"
            f"Policy hints: {' | '.join(invocation.policy_hints[:5]) or 'none'}\n"
            "Operate only in the current workspace. End with a concise structured branch summary."
        )
        return [executable, "-p", prompt, "--permission-mode", "acceptEdits"]
