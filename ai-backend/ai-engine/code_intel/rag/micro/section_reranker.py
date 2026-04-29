"""
Section Reranker — Improve precision of section ranking before MMR/synthesis.

The RelevanceScorer assigns each section a score in [0, 1] based on cheap
features (keyword overlap, title match). That score is good enough for
filtering but tends to flatten out for the top-N candidates — many sections
end up with similar scores. The reranker re-orders the top candidates using
finer-grained features that are too expensive to apply to every section.

Two backends are available:
  - "rule" (default): stronger rule-based scoring than RelevanceScorer.
    No new dependencies, runs in microseconds per section. Models exact
    phrase match, bigram coverage, IDF-weighted overlap, position-in-doc
    bias, and length normalization.
  - "cross_encoder" (optional): sentence-transformers cross-encoder model.
    Activated only when sentence-transformers is importable AND the
    config flag `section_rerank_backend == "cross_encoder"` is set. Falls
    back silently to "rule" if the package is missing.

Designed to slot between RelevanceScorer.score_sections and the MMR
diversity pass: rerank improves precision of the top-K, then MMR drops
near-duplicates.
"""

from __future__ import annotations

import logging
import math
import re
import time
from dataclasses import dataclass
from typing import List, Optional, Sequence, Set

from .relevance_scorer import ScoredSection
from ..config import RAGConfig, get_rag_config
from ..types import Section, SectionRelevance

logger = logging.getLogger("code_intel.rag.micro.section_reranker")


_TOKEN_RE = re.compile(r"[A-Za-z][A-Za-z0-9_]+")
_STOPWORDS = {
    "the", "a", "an", "and", "or", "but", "of", "in", "on", "at", "to",
    "for", "with", "by", "from", "as", "is", "are", "was", "were", "be",
    "been", "being", "have", "has", "had", "do", "does", "did", "this",
    "that", "these", "those", "it", "its", "if", "then", "than", "so",
    "we", "you", "they", "them", "our", "their", "i", "me", "my", "what",
    "how", "why", "when", "where", "who", "which",
}


@dataclass
class RerankSignals:
    """Per-section signals captured during reranking — surfaced for tracing."""
    phrase_match: float = 0.0
    bigram_overlap: float = 0.0
    idf_overlap: float = 0.0
    title_overlap: float = 0.0
    length_norm: float = 0.0
    position_bias: float = 0.0
    final: float = 0.0


class SectionReranker:
    """
    Lightweight section reranker.

    Re-orders a scored section list by combining the original score with
    finer-grained features. The output is the same ScoredSection objects
    (mutated `score`) sorted by the new combined score.
    """

    def __init__(
        self,
        config: Optional[RAGConfig] = None,
        backend: Optional[str] = None,
    ):
        self.config = config or get_rag_config()
        cfg_backend = getattr(
            self.config.micro, "section_rerank_backend", "rule"
        )
        self.backend = (backend or cfg_backend or "rule").lower()
        self._cross_encoder = None
        if self.backend == "cross_encoder":
            self._cross_encoder = self._try_load_cross_encoder()
            if self._cross_encoder is None:
                logger.info(
                    "cross_encoder backend requested but unavailable — "
                    "falling back to rule-based reranker"
                )
                self.backend = "rule"

        # Mixing weight: final = (1 - blend) * original + blend * rerank.
        # 0.0 keeps the original ordering; 1.0 ignores it.
        self._blend = float(
            getattr(self.config.micro, "section_rerank_blend", 0.6)
        )
        self._top_k = int(
            getattr(self.config.micro, "section_rerank_top_k", 30)
        )

    # =========================================================================
    # Public API
    # =========================================================================

    def rerank(
        self,
        query_text: str,
        scored: List[ScoredSection],
    ) -> List[ScoredSection]:
        """
        Rerank a scored section list in-place and return the new ordering.

        Only the top `section_rerank_top_k` candidates are reranked — beyond
        that the original order is preserved. This keeps the reranker fast
        on long candidate lists.
        """
        if not scored:
            return scored

        t0 = time.time()
        head = scored[: self._top_k]
        tail = scored[self._top_k:]

        if self.backend == "cross_encoder" and self._cross_encoder is not None:
            new_scores = self._score_cross_encoder(query_text, head)
        else:
            new_scores = self._score_rule(query_text, head)

        # Blend: keep original score's calibration but let rerank reshuffle.
        blended: List[tuple] = []
        for ss, rerank_score in zip(head, new_scores):
            final = (
                (1.0 - self._blend) * float(ss.score)
                + self._blend * float(rerank_score)
            )
            blended.append((final, ss))
            ss.score = final

        blended.sort(key=lambda t: t[0], reverse=True)
        reordered = [t[1] for t in blended]

        # Update relevance band so downstream consumers (RelevanceScorer-style
        # filters) see consistent classifications.
        for ss in reordered:
            ss.relevance = self._classify(ss.score)

        elapsed_ms = (time.time() - t0) * 1000.0
        logger.debug(
            f"SectionReranker[{self.backend}] reranked {len(head)} "
            f"sections in {elapsed_ms:.1f}ms (kept {len(tail)} as tail)"
        )

        return reordered + tail

    # =========================================================================
    # Backend: Rule-based
    # =========================================================================

    def _score_rule(
        self,
        query_text: str,
        sections: Sequence[ScoredSection],
    ) -> List[float]:
        if not sections:
            return []

        query_terms = self._tokenize(query_text)
        query_set = set(query_terms) - _STOPWORDS
        query_lower = query_text.lower().strip()
        query_bigrams = self._bigrams(query_terms)

        # Compute corpus IDF over the section content. With a small N this is
        # noisy but still pulls down common words like "the", "function",
        # "section" — exactly what we want.
        idf = self._compute_idf([ss.section for ss in sections])

        results: List[float] = []
        n = len(sections)
        for i, ss in enumerate(sections):
            section = ss.section
            content_lower = (section.content or "").lower()
            title_lower = (section.title or "").lower()

            content_terms = self._tokenize(content_lower)
            content_set = set(content_terms) - _STOPWORDS
            title_terms = self._tokenize(title_lower)
            title_set = set(title_terms) - _STOPWORDS

            # 1. Phrase match — full query string appears verbatim.
            phrase = 0.0
            if query_lower and len(query_lower) >= 5:
                if query_lower in content_lower:
                    phrase = 1.0
                elif query_lower in title_lower:
                    phrase = 0.85

            # 2. Bigram overlap — multi-word concept match.
            content_bigrams = self._bigrams(content_terms)
            bigram_score = 0.0
            if query_bigrams and content_bigrams:
                inter = query_bigrams & content_bigrams
                bigram_score = len(inter) / len(query_bigrams)

            # 3. IDF-weighted overlap — rare terms count more.
            idf_score = 0.0
            if query_set:
                hits = query_set & content_set
                if hits:
                    total = sum(idf.get(t, 0.5) for t in query_set)
                    matched = sum(idf.get(t, 0.5) for t in hits)
                    idf_score = matched / total if total > 0 else 0.0

            # 4. Title overlap — query terms in section title.
            title_score = 0.0
            if query_set and title_set:
                title_score = len(query_set & title_set) / len(query_set)

            # 5. Length normalization — penalise extremely short sections
            # (likely noise) and very long ones (signal dilution).
            tok_count = section.token_count or max(
                1, len(section.content) // 4
            )
            if tok_count < 30:
                length_norm = 0.3
            elif tok_count > 1500:
                length_norm = 0.6
            elif 60 <= tok_count <= 600:
                length_norm = 1.0
            else:
                length_norm = 0.85

            # 6. Position bias — earlier candidates from prior scoring
            # already have stronger priors; preserve a tiny gradient.
            position_bias = 1.0 - (i / max(1, n)) * 0.15

            final = (
                0.30 * phrase
                + 0.20 * bigram_score
                + 0.25 * idf_score
                + 0.15 * title_score
                + 0.05 * length_norm
                + 0.05 * position_bias
            )
            results.append(min(1.0, max(0.0, final)))

        return results

    # =========================================================================
    # Backend: Cross-encoder (optional)
    # =========================================================================

    def _score_cross_encoder(
        self,
        query_text: str,
        sections: Sequence[ScoredSection],
    ) -> List[float]:
        """Score with a sentence-transformers CrossEncoder model.

        We truncate each section to ~600 chars so the model's max sequence
        length isn't exceeded — the leading paragraph is typically the
        most informative for relevance ranking anyway.
        """
        if not self._cross_encoder or not sections:
            return [float(ss.score) for ss in sections]

        try:
            pairs = [
                (query_text, (ss.section.content or "")[:600])
                for ss in sections
            ]
            scores = self._cross_encoder.predict(pairs)
            # CrossEncoder.predict returns a numpy array of logits in [-inf, +inf].
            # Squash to [0, 1] via sigmoid so the blend with original scores
            # is well-scaled.
            normed: List[float] = []
            for s in scores:
                normed.append(1.0 / (1.0 + math.exp(-float(s))))
            return normed
        except Exception as e:
            logger.warning(
                f"Cross-encoder rerank failed, using original scores: {e}"
            )
            return [float(ss.score) for ss in sections]

    @staticmethod
    def _try_load_cross_encoder():
        """Best-effort load of a small cross-encoder. Returns None on failure."""
        try:
            from sentence_transformers import CrossEncoder  # type: ignore
        except Exception:
            return None
        try:
            # ms-marco-MiniLM-L-6-v2 is the de-facto small-fast cross-encoder
            # (22M params, ~50ms/pair on CPU). Cached locally after first use.
            return CrossEncoder("cross-encoder/ms-marco-MiniLM-L-6-v2")
        except Exception as e:
            logger.info(f"CrossEncoder load failed: {e}")
            return None

    # =========================================================================
    # Helpers
    # =========================================================================

    @staticmethod
    def _tokenize(text: str) -> List[str]:
        if not text:
            return []
        return [t.lower() for t in _TOKEN_RE.findall(text)]

    @staticmethod
    def _bigrams(tokens: Sequence[str]) -> Set[str]:
        if len(tokens) < 2:
            return set()
        return {
            f"{a} {b}"
            for a, b in zip(tokens, tokens[1:])
            if a not in _STOPWORDS and b not in _STOPWORDS
        }

    @staticmethod
    def _compute_idf(sections: Sequence[Section]) -> dict:
        """Compute simple IDF over the candidate section content.

        Even with tiny N (top-30 sections) this still pulls down common
        function/comment words like "return", "this", "function" relative
        to query-specific identifiers.
        """
        n = len(sections)
        if n == 0:
            return {}
        df: dict = {}
        for s in sections:
            seen: Set[str] = set()
            for t in SectionReranker._tokenize(s.content or ""):
                if t in _STOPWORDS:
                    continue
                if t not in seen:
                    df[t] = df.get(t, 0) + 1
                    seen.add(t)
        return {t: math.log((n + 1) / (c + 0.5)) for t, c in df.items()}

    @staticmethod
    def _classify(score: float) -> SectionRelevance:
        if score >= 0.7:
            return SectionRelevance.CRITICAL
        if score >= 0.5:
            return SectionRelevance.HIGH
        if score >= 0.3:
            return SectionRelevance.MEDIUM
        if score >= 0.1:
            return SectionRelevance.LOW
        return SectionRelevance.NONE
