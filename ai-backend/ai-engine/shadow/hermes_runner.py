"""Hermes Agent runner adapter with an explicit non-interactive write contract."""

from __future__ import annotations

from typing import List

from .runner_base import BaseRunnerAdapter, RunnerInvocation


class HermesRunner(BaseRunnerAdapter):
    """Construct the supported Hermes Agent one-shot invocation.

    The container launcher, rather than the CLI, is the enforcement boundary
    for filesystem and network access. Hermes' safe-root remains a useful
    defense in depth control and is supplied by that launcher.
    """

    runner_kind = "hermes"

    def command_for(self, *, invocation: RunnerInvocation, executable: str = "hermes") -> List[str]:
        prompt = (
            f"Universe {invocation.universe_id}: {invocation.declared_condition}.\n"
            f"Task: {invocation.task_summary}\n"
            f"Policy hints: {' | '.join(invocation.policy_hints[:5]) or 'none'}\n"
            "Operate only in the current workspace. Do not modify protected files. "
            "End with a concise structured branch summary."
        )
        # subprocess receives an argv list (never a shell string), so the
        # prompt is not interpreted by a shell even when it contains quotes.
        return [
            executable, "chat", "--quiet", "--query", prompt, "--checkpoints",
            "--yolo", "--ignore-user-config", "--ignore-rules", "--source", "tool",
        ]
