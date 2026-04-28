"""LLM patch Generator. Master plan §6.1.

Wave 1 supports the four style profiles but ships only two as production
defaults — `safe` and `idiomatic`. `minimalist` is wired in with the
post-hoc LOC filter (master plan §6.1 table) enforced by `Universe`
before the Critic runs.

Today the only available provider is Gemini (see llm/providers/factory.py).
The model_pair concept from the plan is encoded in the call signature so
that Wave 2 can drop in additional providers without touching universe.py.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Dict, List, Optional

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
    # Wave 4: optional few-shot examples drawn from the user's accepted-patch
    # history. Folded into the revise prompt as a `PREFERENCE EXAMPLES` block.
    few_shot: List[Dict[str, Any]] = field(default_factory=list)


class Generator:
    """LLM-backed generator. Wave 1 is a thin pass-through that lets the
    pipeline run end-to-end with the chat-supplied patches.

    The interface is async + stateless so universes can be parallelized in
    Wave 2 without changes here.
    """

    def __init__(
        self,
        model: str = "gemini-pro",
        style: str = "safe",
        provider: str = "gemini",
        api_key: Optional[str] = None,
    ):
        self.model = model
        self.style = style
        self.provider = provider
        self.api_key = api_key

    async def generate(self, req: GeneratorRequest) -> List[PatchBlock]:
        """Wave 1: trust the chat-supplied patch text as the generator output.

        The slot for an LLM "rewrite the patch in this style" pass is here
        and is what Wave 2 fills in once the multi-provider keys are wired
        through from the chat request (master plan §5).
        """
        if self.style not in STYLE_PROMPTS:
            logger.warning("unknown style %r, falling back to safe", self.style)
        return list(req.patches)

    async def revise(self, req: GeneratorRequest, blocking_attacks: List[Dict[str, Any]]) -> List[PatchBlock]:
        """One-pass revision when a blocking Critic attack survives.

        Master plan §6.2: severity gates revision; max 1 revision pass.
        We send the original patches + the failing executable reproducers
        to the LLM and ask for a revised file body per patch path. If the
        provider call fails (key missing, network, etc.), we degrade to
        the original patches with a `[revision-skipped]` note so scoring
        still works.
        """
        if not blocking_attacks:
            return list(req.patches)

        try:
            from llm.providers import get_provider
        except Exception as e:
            logger.warning("revise: provider unavailable: %s", e)
            return _mark_skipped(req.patches, "provider unavailable")

        try:
            provider = get_provider(self.provider)
        except Exception as e:
            logger.warning("revise: get_provider(%s) failed: %s", self.provider, e)
            return _mark_skipped(req.patches, f"provider-{self.provider}-unavailable")

        revised: List[PatchBlock] = []
        for p in req.patches:
            prompt = _build_revise_prompt(
                user_request=req.user_request,
                style=req.style,
                path=p.path,
                original=p.original,
                proposed=p.new_content,
                attacks=blocking_attacks,
                few_shot=req.few_shot,
            )
            try:
                text = await provider.ask_llm(
                    code=p.new_content, lang=_lang_for(p.path),
                    prompt=prompt, mode="patch",
                    model=self.model, api_key=self.api_key,
                )
            except Exception as e:
                logger.warning("revise: provider call failed for %s: %s", p.path, e)
                p.note = (p.note or "") + " [revision-skipped:provider-error]"
                revised.append(p)
                continue

            new_body = _extract_body(text, p.new_content)
            if new_body is None or new_body == p.new_content:
                p.note = (p.note or "") + " [revision-no-change]"
                revised.append(p)
                continue
            revised.append(PatchBlock(
                path=p.path, original=p.original, new_content=new_body,
                note=(p.note or "") + " [revised]",
            ))
        return revised


def _mark_skipped(patches: List[PatchBlock], reason: str) -> List[PatchBlock]:
    for p in patches:
        p.note = (p.note or "") + f" [revision-skipped:{reason}]"
    return list(patches)


_LANG_BY_EXT = {
    ".py": "python", ".ts": "typescript", ".tsx": "tsx",
    ".js": "javascript", ".jsx": "javascript",
    ".go": "go", ".rs": "rust", ".java": "java", ".rb": "ruby",
    ".html": "html", ".css": "css", ".json": "json",
}


def _lang_for(path: str) -> str:
    for ext, lang in _LANG_BY_EXT.items():
        if path.endswith(ext):
            return lang
    return "text"


def _build_revise_prompt(*, user_request: str, style: str, path: str,
                          original: str, proposed: str, attacks: List[Dict[str, Any]],
                          few_shot: Optional[List[Dict[str, Any]]] = None) -> str:
    style_hint = STYLE_PROMPTS.get(style, STYLE_PROMPTS["safe"])
    attacks_block = "\n".join(
        f"- [{a.get('severity','blocking')}] {a.get('kind','logic')}: {a.get('msg')}"
        + (f"\n  reproducer: {a['reproducer']}" if a.get("reproducer") else "")
        for a in attacks
    )
    few_shot_block = ""
    if few_shot:
        rendered: List[str] = []
        for i, ex in enumerate(few_shot[:3], start=1):
            rendered.append(
                f"<example {i}>\n"
                f"request: {ex.get('request_summary', '')}\n"
                f"style: {ex.get('style', '')}\n"
                f"loc: {ex.get('loc', '')}\n"
                f"accepted_diff:\n{ex.get('accepted_diff', '')}\n"
                f"</example {i}>"
            )
        few_shot_block = (
            "\n<PREFERENCE EXAMPLES>\n"
            + "\n\n".join(rendered)
            + "\n</PREFERENCE EXAMPLES>\n"
        )
    return (
        f"You are revising a patch that survived its first review but failed an "
        f"adversarial Critic. The Critic produced executable reproducers that "
        f"prove real flaws in the patch. Produce a revised version of the file "
        f"that fixes those flaws while keeping the original intent.\n\n"
        f"USER REQUEST:\n{user_request}\n\n"
        f"STYLE: {style} — {style_hint}\n\n"
        f"{few_shot_block}"
        f"FILE PATH: {path}\n\n"
        f"<ORIGINAL_FILE>\n{original}\n</ORIGINAL_FILE>\n\n"
        f"<PROPOSED_PATCH>\n{proposed}\n</PROPOSED_PATCH>\n\n"
        f"<BLOCKING_ATTACKS>\n{attacks_block}\n</BLOCKING_ATTACKS>\n\n"
        "Output the revised full file content. No commentary, no diff markers, "
        "no code fences. If the patch cannot be improved without breaking the "
        "user's intent, output the single token REFUSE on a line by itself."
    )


def _extract_body(text: str, fallback: str) -> Optional[str]:
    if not text:
        return None
    s = text.strip()
    if s == "REFUSE":
        return None
    if s.startswith("```"):
        # Strip fenced code-block wrapper if the model used one despite the prompt.
        s = s.strip("`")
        if "\n" in s:
            head, rest = s.split("\n", 1)
            if head.isalpha() or not head.strip():
                s = rest
        if s.endswith("```"):
            s = s[:-3]
    return s.rstrip() + ("\n" if fallback.endswith("\n") else "")
