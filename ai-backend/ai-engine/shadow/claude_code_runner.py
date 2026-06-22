"""Claude Code runner adapter.

This module keeps Claude Code as a pluggable runner. It normalizes Claude
artifacts that were produced elsewhere; it does not call the Claude CLI from
the control plane.
"""

from __future__ import annotations

from .runner_base import BaseRunnerAdapter


class ClaudeCodeRunner(BaseRunnerAdapter):
    runner_kind = "claude_code"
