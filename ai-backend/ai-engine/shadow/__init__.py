"""Synthi Genome — shadow verification subsystem.

Wave 1 scope (per synthi-genome-master-plan.md):
  - single universe + Critic with executable reproducers
  - worktree pool with dep-install lock
  - snapshot / 3-way-merge / AI-rebase
  - non-blocking verify panel (SSE)
  - apply-and-cancel + staleness UI
  - Verify-only mode
  - evaluation harness (bench/)
  - Python / Node / tree-sitter runners

The `shadow_router` symbol is exported lazily so that submodules (events,
scoring, runner, …) can be imported in environments that don't have
FastAPI installed (e.g., bench/ tests).
"""

__all__ = ["shadow_router"]


def __getattr__(name):
    if name == "shadow_router":
        from .api import router
        return router
    raise AttributeError(name)
