"""LLM patch Generator. Master plan §6.1.

Wave 1 supports the four style profiles but ships only two as production
defaults — `safe` and `idiomatic`. `minimalist` is wired in but its
post-hoc filter is a soft warning until the bench/ harness validates it
ahead of Wave 2 (per the §15.4 calibration commitment).

Today the only available provider is Gemini (see llm/providers/factory.py).
The model_pair concept from the plan is encoded in the call signature so
that Wave 2 can drop in additional providers without touching universe.py.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import List, Optional

logger = logging.getLogger("shadow.generator")

STYLE_PROMPTS = {
    "safe":
        "Conservative fix. Add defensive checks. Preserve API surface. "
        "Prefer explicit over implicit; do not refactor unrelated code.",
    "idiomatic":
        "Match the codebase's existing patterns. Prefer clarity over cleverness. "
        "Use the same testing/error/style conventions you observe in the surrounding files.",
    "minimalist":
        "Smallest possible patch. Prefer modify over add. Look for opportunities "
        "to remove. No defensive programming unless required.",
    "surgical":
        "Absolute minimum keystrokes. One-character fixes preferred. Reject any "
        "edit larger than the bug requires.",
}


@dataclass
class PatchBlock:
    path: str
    original: str   # file content the patch was generated against
    new_content: str  # generator's proposed full file content
    note: Optional[str] = None


@dataclass
class GeneratorRequest:
    user_request: str
    style: str
    model: str  # provider-qualified name; Wave 1 uses "gemini-pro"
    patches: List[PatchBlock]  # the seed patches from the chat (search/replace already resolved upstream)
    intent: str = "fix"


class Generator:
    """LLM-backed generator. Wave 1 is a thin pass-through that lets the
    pipeline run end-to-end with the chat-supplied patches.

    The interface is async + stateless so universes can be parallelized in
    Wave 2 without changes here.
    """

    def __init__(self, model: str = "gemini-pro", style: str = "safe"):
        self.model = model
        self.style = style

    async def generate(self, req: GeneratorRequest) -> List[PatchBlock]:
        """Wave 1: trust the chat-supplied patch text as the generator output.

        The slot for an LLM "rewrite the patch in this style" pass is here
        and is what Wave 2 fills in once the multi-provider keys are wired
        through from the chat request (master plan §5).
        """
        if self.style not in STYLE_PROMPTS:
            logger.warning("unknown style %r, falling back to safe", self.style)
        return list(req.patches)

    async def revise(self, req: GeneratorRequest, blocking_attacks: list[dict]) -> List[PatchBlock]:
        """One-pass revision when a blocking Critic attack survives.

        Wave 1 implementation is conservative: it returns the original
        patches unchanged and marks the universe as `revision_skipped` so
        the Critic survival rate still scores it correctly. Wave 2 will
        invoke the provider with the failing reproducers in context.
        """
        for p in req.patches:
            p.note = (p.note or "") + " [revision-skipped:wave1]"
        return list(req.patches)
