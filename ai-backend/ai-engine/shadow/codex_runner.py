"""Codex runner adapter.

This module keeps Codex as a pluggable runner. It normalizes Codex artifacts
that were produced elsewhere; it does not call the Codex CLI from the control
plane.
"""

from __future__ import annotations

from .runner_base import BaseRunnerAdapter


class CodexRunner(BaseRunnerAdapter):
    runner_kind = "codex"
