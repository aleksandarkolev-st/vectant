"""
Answer Synthesizer — Generate final cited answer using a heavy model.

The last step of the RAG pipeline. Takes the assembled context and
user query, passes them to a heavy reasoning model (Gemini 2.5 Flash),
and generates a grounded, cited answer.

Features:
- Structured system prompt for citation format
- Grounding enforcement (answers must reference sources)
- Partial answer support (answers with incomplete information)
- Fallback to fast model on heavy model failure
"""

from __future__ import annotations

import json
import logging
import random
import re
import time
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional

from ..config import SynthesisConfig, RAGConfig, get_rag_config
from ..types import RAGQuery, RAGResult, Citation
from .context_builder import SynthesisContext, ContextSection
from ..exceptions import SynthesisError, SynthesisModelError

logger = logging.getLogger("code_intel.rag.synthesis.answer_synthesizer")


_SYSTEM_PROMPT = """You are a precise technical assistant that answers questions using provided source material.

RULES:
1. Answer ONLY based on the provided context sections. Do not make up information.
2. Cite your sources using the citation markers (e.g., [1], [2]) provided in the context.
3. If the context does not contain enough information, say so explicitly.
4. Be concise but thorough. Prefer code examples when relevant.
5. If multiple sections are relevant, synthesize the information coherently.
6. Use the exact citation markers from the context (e.g., [1], [2], [3]).

CITATION FORMAT:
- Inline citations: "The auth system uses OAuth 2.0 [1] with JWT tokens [2]."
- Multiple sources: "This feature requires both the gateway [1] and the worker [3]."
"""


@dataclass
class SynthesisResult:
    """Raw result from the synthesis model."""
    answer_text: str
    raw_citations: List[str]          # Citation markers found (e.g., ["[1]", "[2]"])
    model_used: str
    input_tokens: int = 0
    output_tokens: int = 0
    time_ms: float = 0.0


class AnswerSynthesizer:
    """
    Generate answers using a heavy reasoning model.

    Orchestrates the final synthesis step:
    1. Build prompt from context + query
    2. Call heavy model (Gemini 2.5 Flash)
    3. Parse response for citations
    4. Return structured answer
    """

    def __init__(
        self,
        config: Optional[RAGConfig] = None,
        api_key: Optional[str] = None,
    ):
        """
        Initialize answer synthesizer.

        Args:
            config: RAG configuration.
            api_key: Override API key.
        """
        self.config = config or get_rag_config()
        self._synth = self.config.synthesis
        self._api_key = api_key or self._synth.synthesis_api_key
        self._genai = None

    # =========================================================================
    # Public API
    # =========================================================================

    def synthesize(
        self,
        query: RAGQuery,
        context: SynthesisContext,
    ) -> SynthesisResult:
        """
        Generate an answer from context.

        Args:
            query: User query.
            context: Assembled context with citation markers.

        Returns:
            SynthesisResult with answer text and citations.
        """
        t0 = time.time()

        # Build the full prompt
        prompt = self._build_prompt(query.text, context)

        # Call synthesis model
        try:
            raw_text, model_used = self._call_model(prompt)
        except Exception as e:
            # Try fallback to fast model
            logger.warning(f"Heavy model failed: {e}; trying fallback")
            try:
                raw_text, model_used = self._call_model(
                    prompt,
                    model_override=self.config.micro.routing_model,
                )
            except Exception as e2:
                raise SynthesisModelError(
                    f"Both heavy and fallback models failed: {e2}"
                ) from e2

        elapsed = (time.time() - t0) * 1000

        # Extract citation markers
        citations = self._extract_citation_markers(raw_text)

        # Validate grounding
        if self._synth.require_grounding and not citations:
            raw_text = self._add_grounding_warning(raw_text, context)

        # Estimate token usage
        input_tokens = len(prompt) // 4 + 1
        output_tokens = len(raw_text) // 4 + 1

        return SynthesisResult(
            answer_text=raw_text,
            raw_citations=citations,
            model_used=model_used,
            input_tokens=input_tokens,
            output_tokens=output_tokens,
            time_ms=elapsed,
        )

    def synthesize_with_retry(
        self,
        query: RAGQuery,
        context: SynthesisContext,
        max_retries: int = 1,
    ) -> SynthesisResult:
        """
        Synthesize with retry on failure.

        On retry, adds a hint to the prompt asking for citations.
        """
        last_error: Optional[Exception] = None

        for attempt in range(max_retries + 1):
            try:
                result = self.synthesize(query, context)

                # If no citations and we have context, retry with stronger prompt
                if (
                    attempt == 0
                    and not result.raw_citations
                    and context.section_count > 0
                    and self._synth.enable_citations
                ):
                    logger.debug("No citations found; retrying with emphasis")
                    continue

                return result

            except SynthesisError as e:
                last_error = e
                if attempt < max_retries:
                    logger.warning(
                        f"Synthesis attempt {attempt + 1} failed: {e}"
                    )
                    continue
                raise

        raise SynthesisError(f"All synthesis attempts failed: {last_error}")

    # =========================================================================
    # Internal: Prompt Building
    # =========================================================================

    def _build_prompt(
        self,
        query_text: str,
        context: SynthesisContext,
    ) -> str:
        """Build the complete synthesis prompt."""
        parts = [
            _SYSTEM_PROMPT,
            "",
            "CONTEXT:",
            context.context_text,
            "",
        ]

        if context.truncated:
            parts.append(
                "NOTE: Context was truncated. Some information may be missing."
            )
            parts.append("")

        parts.extend([
            f"QUESTION: {query_text}",
            "",
            "ANSWER:",
        ])

        return "\n".join(parts)

    # =========================================================================
    # Internal: Model Call
    # =========================================================================

    def _call_model(
        self,
        prompt: str,
        model_override: Optional[str] = None,
    ) -> tuple:
        """
        Call the synthesis model with exponential-backoff retry on 429.

        Returns:
            Tuple of (response_text, model_name).
        """
        model_name = model_override or self._synth.synthesis_model

        genai = self._get_genai()
        model = genai.GenerativeModel(
            model_name,
            generation_config=genai.GenerationConfig(
                temperature=0.3,
                max_output_tokens=self._synth.max_answer_tokens,
            ),
        )

        # Match the retry pattern used by routing/summary/embedder. Synthesis
        # is the longest call in the pipeline; without retry, a single
        # transient 429 forces the user to re-ask the question.
        max_retries = 2
        last_err: Optional[Exception] = None
        for attempt in range(max_retries + 1):
            try:
                response = model.generate_content(prompt)
                text = (response.text or "").strip()

                if not text:
                    raise SynthesisModelError("Model returned empty response")

                return text, model_name

            except Exception as e:
                last_err = e
                err_str = str(e).lower()
                is_rate_limit = (
                    "429" in err_str
                    or "resource" in err_str
                    or "quota" in err_str
                )
                if is_rate_limit and attempt < max_retries:
                    delay = (0.5 * (2 ** attempt)) + (random.random() * 0.3)
                    logger.warning(
                        f"Rate limited on synthesis ({model_name}), retry "
                        f"{attempt + 1}/{max_retries} after {delay:.2f}s"
                    )
                    time.sleep(delay)
                    continue
                if is_rate_limit:
                    raise SynthesisModelError(
                        f"Rate limited on synthesis model after retries: {e}"
                    ) from e
                raise SynthesisModelError(
                    f"Synthesis model call failed: {e}"
                ) from e

        raise SynthesisModelError(
            f"Synthesis model call exhausted retries: {last_err}"
        )

    # =========================================================================
    # Internal: Citation Extraction
    # =========================================================================

    def _extract_citation_markers(self, text: str) -> List[str]:
        """
        Extract citation markers from model response.

        Finds patterns like [1], [2], [3] etc.
        """
        markers = re.findall(r'\[\d+\]', text)
        # Deduplicate while preserving order
        seen = set()
        unique = []
        for m in markers:
            if m not in seen:
                seen.add(m)
                unique.append(m)
        return unique

    def _add_grounding_warning(
        self,
        text: str,
        context: SynthesisContext,
    ) -> str:
        """Add a warning when answer has no citations."""
        if not self._synth.allow_partial_answers:
            return (
                "I could not find a well-grounded answer in the provided sources. "
                "The available context may not contain the information needed to "
                "answer this question accurately."
            )

        return text + (
            "\n\n*Note: This answer could not be directly grounded in "
            "the available source material. Please verify independently.*"
        )

    # =========================================================================
    # Internal: GenAI Client
    # =========================================================================

    def _get_genai(self):
        """Lazy-load Google GenAI client."""
        if self._genai is not None:
            return self._genai

        try:
            import google.generativeai as genai
            genai.configure(api_key=self._api_key)
            self._genai = genai
            return genai
        except ImportError:
            raise SynthesisModelError(
                "google-generativeai package required for synthesis"
            )
