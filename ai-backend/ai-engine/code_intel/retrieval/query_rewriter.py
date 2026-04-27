"""
Query rewriter — boosts RAG recall with two complementary techniques.

1. **Conversational rewrite**: when the user's latest message refers back to
   prior context ("now do the same for X", "fix that"), the bare query embeds
   poorly because it lacks nouns. We use a small LLM to fold the recent chat
   history into a self-contained query.

2. **HyDE (Hypothetical Document Embeddings)**: instead of embedding the
   user's question directly, we ask the LLM to *guess* what code answering
   the question might look like, then embed that. Hypothetical code is in
   the same semantic space as the indexed corpus, so cosine similarity is a
   far stronger signal than question→code.

Both calls are best-effort: every failure mode falls back to the original
query so retrieval still happens, just without the boost.
"""

from __future__ import annotations

import logging
import os
import re
import time
from dataclasses import dataclass
from typing import Dict, List, Optional


logger = logging.getLogger("code_intel.retrieval.query_rewriter")


@dataclass
class RewrittenQuery:
    """The product of one rewrite pass."""

    original: str
    rewritten: str                  # self-contained natural-language query
    hyde_document: Optional[str]    # synthetic code snippet for embedding (or None)
    used_history: bool
    used_hyde: bool
    elapsed_ms: float = 0.0
    error: Optional[str] = None

    @property
    def search_text(self) -> str:
        """Text suitable for BM25 / lexical search (combines rewrite + HyDE)."""
        if self.hyde_document:
            return f"{self.rewritten}\n\n{self.hyde_document}"
        return self.rewritten


class QueryRewriter:
    """
    LLM-backed query rewriter for the RAG pipeline.

    Initialised with a Gemini API key; if no key is available, every call is a
    no-op that returns the original query unchanged. Keeps the runtime path
    quiet when running offline / in tests.
    """

    DEFAULT_MODEL = "gemini-3.1-flash-lite-preview"

    def __init__(
        self,
        api_key: Optional[str] = None,
        model: str = DEFAULT_MODEL,
        timeout_s: float = 4.0,
    ):
        self.api_key = api_key or os.getenv("GEMINI_API_KEY")
        self.model = model
        self.timeout_s = timeout_s
        # Tiny LRU cache so repeated identical queries don't re-call the LLM.
        self._cache: Dict[str, RewrittenQuery] = {}
        self._cache_max = 128

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    def rewrite(
        self,
        query: str,
        conversation_history: Optional[List[Dict[str, str]]] = None,
        enable_hyde: bool = True,
    ) -> RewrittenQuery:
        """
        Produce a self-contained query and (optionally) a HyDE document.

        Args:
            query: User's latest message, raw.
            conversation_history: Previous messages [{role, content}, ...].
            enable_hyde: When False, only conversational rewriting runs.
        """
        original = (query or "").strip()
        if not original:
            return RewrittenQuery(original="", rewritten="", hyde_document=None,
                                  used_history=False, used_hyde=False)

        cache_key = self._cache_key(original, conversation_history, enable_hyde)
        cached = self._cache.get(cache_key)
        if cached is not None:
            return cached

        start = time.time()
        rewritten = original
        used_history = False
        used_hyde = False
        hyde_doc = None
        error = None

        # Stage 1: conversational rewrite (only if we actually have prior turns).
        history_lines = self._format_history(conversation_history)
        if history_lines and self._needs_history(original):
            rewrite_text = self._call_llm(self._history_prompt(original, history_lines))
            if rewrite_text:
                cleaned = self._clean_rewrite(rewrite_text)
                if cleaned and cleaned.lower() != original.lower():
                    rewritten = cleaned
                    used_history = True

        # Stage 2: HyDE (always operates on the rewritten query).
        if enable_hyde and self.api_key:
            hyde_text = self._call_llm(self._hyde_prompt(rewritten))
            if hyde_text:
                cleaned = self._clean_hyde(hyde_text)
                if cleaned:
                    hyde_doc = cleaned
                    used_hyde = True
            else:
                error = error or "hyde_empty"

        elapsed_ms = (time.time() - start) * 1000.0
        result = RewrittenQuery(
            original=original,
            rewritten=rewritten,
            hyde_document=hyde_doc,
            used_history=used_history,
            used_hyde=used_hyde,
            elapsed_ms=elapsed_ms,
            error=error,
        )
        self._cache_put(cache_key, result)
        return result

    # ------------------------------------------------------------------
    # Internals
    # ------------------------------------------------------------------

    # Cheap heuristic: does the message read like a follow-up that needs context?
    _PRONOUN_RE = re.compile(
        r"\b(it|that|this|those|these|same|again|now|also|then|there|"
        r"the (function|class|file|method|code|change))\b",
        re.IGNORECASE,
    )

    def _needs_history(self, query: str) -> bool:
        if len(query.split()) <= 4:
            return True  # very short queries usually need context
        return bool(self._PRONOUN_RE.search(query))

    def _format_history(self, history: Optional[List[Dict[str, str]]]) -> List[str]:
        if not history:
            return []
        # Take the last 6 turns; condense to one short line each.
        recent = history[-6:]
        lines: List[str] = []
        for msg in recent:
            role = msg.get("role") or "user"
            content = (msg.get("content") or "").strip().replace("\n", " ")
            if not content:
                continue
            content = content[:240]
            lines.append(f"{role}: {content}")
        return lines

    def _history_prompt(self, query: str, history_lines: List[str]) -> str:
        history_block = "\n".join(history_lines)
        return (
            "You rewrite a user's latest message into a single self-contained "
            "search query for code retrieval. Resolve pronouns, include the "
            "relevant nouns from the conversation, and keep the user's intent "
            "exactly. Output the rewritten query on a single line — no "
            "explanation, no quotes, no markdown.\n\n"
            f"Conversation:\n{history_block}\n\n"
            f"Latest message: {query}\n\n"
            "Rewritten query:"
        )

    def _hyde_prompt(self, query: str) -> str:
        return (
            "You generate a SHORT hypothetical code snippet (10-25 lines max) "
            "that would plausibly appear in a real codebase and answer the "
            "question below. Write idiomatic code. Include the function "
            "signature, key variable names, and one or two illustrative lines "
            "of body. Do NOT include explanations, prose, markdown fences, or "
            "imports unless essential.\n\n"
            f"Question: {query}\n\n"
            "Hypothetical code:"
        )

    def _call_llm(self, prompt: str) -> Optional[str]:
        if not self.api_key:
            return None
        try:
            import google.generativeai as genai
        except Exception as e:
            logger.debug("genai import failed: %s", e)
            return None

        try:
            genai.configure(api_key=self.api_key)
            model = genai.GenerativeModel(self.model)
            start = time.time()
            response = model.generate_content(
                prompt,
                generation_config={"temperature": 0.1, "max_output_tokens": 320},
            )
            if (time.time() - start) > self.timeout_s:
                # Soft timeout: still return the result if we got one, but warn.
                logger.debug("Query rewrite call exceeded %.1fs", self.timeout_s)
            text = (getattr(response, "text", "") or "").strip()
            return text or None
        except Exception as e:
            logger.debug("Query rewrite call failed: %s", e)
            return None

    def _clean_rewrite(self, text: str) -> str:
        text = text.strip()
        # Strip markdown fences and surrounding quotes.
        text = re.sub(r"^```[a-zA-Z]*\n?", "", text)
        text = re.sub(r"```$", "", text)
        text = text.strip().strip('"').strip("'")
        # Take only the first non-empty line.
        for line in text.splitlines():
            if line.strip():
                return line.strip()[:280]
        return ""

    def _clean_hyde(self, text: str) -> str:
        text = text.strip()
        # Strip markdown fences but keep the inner code body.
        m = re.match(r"^```[a-zA-Z]*\n?([\s\S]*?)\n?```$", text)
        if m:
            text = m.group(1).strip()
        # Hard cap so the embedding call doesn't get billed for an essay.
        if len(text) > 1200:
            text = text[:1200]
        return text

    def _cache_key(
        self,
        query: str,
        history: Optional[List[Dict[str, str]]],
        enable_hyde: bool,
    ) -> str:
        # Last user/assistant turns are the only history bits that affect
        # the rewrite — hashing those keeps the key stable across cosmetic
        # changes elsewhere.
        tail = ""
        if history:
            for msg in reversed(history):
                role = msg.get("role")
                if role in ("user", "assistant", "model"):
                    tail = (msg.get("content") or "")[:120]
                    break
        return f"{int(enable_hyde)}|{query}|{tail}"

    def _cache_put(self, key: str, value: RewrittenQuery) -> None:
        self._cache[key] = value
        if len(self._cache) > self._cache_max:
            # Drop the oldest ~10% of entries.
            for k in list(self._cache.keys())[: max(1, self._cache_max // 10)]:
                self._cache.pop(k, None)
