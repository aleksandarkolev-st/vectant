"""
Keyword Filter — BM25-style keyword search over document summaries.

Provides the keyword-based signal for macro-retrieval. Complements
vector search by catching exact-match terms that embeddings might miss
(e.g., specific API names, acronyms, version numbers).

Uses a lightweight in-memory inverted index rather than a full BM25
library to keep dependencies minimal.
"""

from __future__ import annotations

import json
import logging
import math
import re
import tempfile
import shutil
import os
from collections import Counter, defaultdict
from pathlib import Path
from typing import Any, Dict, List, Optional, Set, Tuple

from ..config import MacroConfig, RAGConfig, StoreConfig, get_rag_config
from ..types import DocumentSummary
from ..exceptions import MacroRetrievalError

logger = logging.getLogger("code_intel.rag.macro.keyword_filter")


# ── Tokenizer ───────────────────────────────────────────────────────────────

_CAMEL_RE = re.compile(r'([a-z0-9])([A-Z])')
_SEP_RE = re.compile(r'[/_\\.\-:]+')
_NON_ALNUM_RE = re.compile(r'[^a-z0-9 ]')
_RAW_TOKEN_RE = re.compile(r'[A-Za-z][A-Za-z0-9_]*')

_STOP: Set[str] = {
    "a", "an", "the", "is", "are", "was", "be", "been", "have", "has",
    "do", "does", "did", "will", "would", "could", "should", "may",
    "i", "me", "my", "we", "our", "you", "your", "he", "she", "it",
    "they", "them", "their", "this", "that", "these", "those",
    "in", "on", "at", "to", "for", "of", "with", "by", "from", "as",
    "and", "but", "or", "not", "if", "then", "than", "so",
}


def tokenize(text: str) -> List[str]:
    """Tokenize text into lowercase terms with code-aware splitting.

    Mirrors `indexer/lexical_index.py`: splits camelCase, snake_case, dotted
    paths, and path separators so that `AuthService` and `auth_service` both
    produce {auth, service} — symmetric with what `query_analyzer.py` already
    does on the query side. Also keeps the original lowercased identifier
    (e.g., `authservice`) so exact-name matches still hit.
    """
    out: List[str] = []
    seen: Set[str] = set()

    def _add(term: str) -> None:
        if not term or len(term) < 2 or term in _STOP:
            return
        if term in seen:
            return
        seen.add(term)
        out.append(term)

    for raw in _RAW_TOKEN_RE.findall(text):
        # 1. The whole identifier, lowercased — preserves "authservice" for
        #    exact-name BM25 hits even when the user types it as one word.
        _add(raw.lower())

        # 2. camelCase / PascalCase split, then snake/path/punct split.
        split = _CAMEL_RE.sub(r'\1 \2', raw).lower()
        split = _SEP_RE.sub(' ', split)
        split = _NON_ALNUM_RE.sub('', split)
        for part in split.split():
            _add(part)

    return out


# ── BM25 Parameters ────────────────────────────────────────────────────────

_K1 = 1.5    # Term frequency saturation
_B = 0.75    # Length normalization


class KeywordSearchResult:
    """Result from keyword search."""

    def __init__(self, document_id: str, score: float, matched_terms: List[str]):
        self.document_id = document_id
        self.score = score
        self.matched_terms = matched_terms

    def __repr__(self) -> str:
        terms = ", ".join(self.matched_terms[:3])
        return f"KeywordSearchResult(doc={self.document_id}, score={self.score:.4f}, terms=[{terms}])"


class KeywordFilter:
    """
    BM25-style keyword search over document summaries.

    Maintains an inverted index mapping terms → document IDs with
    term frequencies. Supports:
    - Okapi BM25 scoring
    - JSON persistence
    - Incremental updates (add/remove documents)
    """

    def __init__(
        self,
        storage_dir: str = "",
        config: Optional[RAGConfig] = None,
    ):
        """
        Initialize keyword filter.

        Args:
            storage_dir: Directory for index persistence.
            config: RAG configuration.
        """
        self.config = config or get_rag_config()
        self._store_cfg = self.config.store
        self._macro_cfg = self.config.macro

        self.storage_dir = Path(storage_dir) if storage_dir else None

        # Inverted index: term → {doc_id: term_frequency}
        self._index: Dict[str, Dict[str, int]] = defaultdict(dict)

        # Document length (in tokens) for normalization
        self._doc_lengths: Dict[str, int] = {}

        # Total document count
        self._doc_count: int = 0

        # Average document length (cached)
        self._avg_dl: float = 0.0

        # Load from disk if available
        if self.storage_dir:
            self._load()

    # =========================================================================
    # Index Management
    # =========================================================================

    def add_document(self, document_id: str, summary: DocumentSummary) -> None:
        """
        Add a document's summary to the keyword index.

        Extracts terms from: title, summary_text, key_topics, key_entities.
        Title and key_entities are weighted 3× by repetition — mirrors the
        symbol-name boost in `indexer/lexical_index.py` so doc names and
        named identifiers dominate over prose.
        """
        title_tokens = tokenize(summary.title or "")
        entity_tokens = tokenize(" ".join(summary.key_entities or []))
        body_tokens = tokenize(summary.summary_text or "")
        topic_tokens = tokenize(" ".join(summary.key_topics or []))

        # 3× boost for title + entities (term-frequency weighting via repetition)
        tokens: List[str] = (
            title_tokens * 3
            + entity_tokens * 3
            + body_tokens
            + topic_tokens
        )

        if not tokens:
            return

        # Remove old entry if exists
        self._remove_doc_from_index(document_id)

        # Count term frequencies
        tf = Counter(tokens)

        # Add to inverted index
        for term, count in tf.items():
            self._index[term][document_id] = count

        # Store document length
        self._doc_lengths[document_id] = len(tokens)
        self._doc_count = len(self._doc_lengths)
        self._avg_dl = sum(self._doc_lengths.values()) / max(self._doc_count, 1)

    def remove_document(self, document_id: str) -> None:
        """Remove a document from the keyword index."""
        self._remove_doc_from_index(document_id)
        self._doc_count = len(self._doc_lengths)
        self._avg_dl = sum(self._doc_lengths.values()) / max(self._doc_count, 1)

    def _remove_doc_from_index(self, document_id: str) -> None:
        """Internal: remove doc from inverted index."""
        if document_id not in self._doc_lengths:
            return

        # Remove from inverted index
        empty_terms: List[str] = []
        for term, postings in self._index.items():
            if document_id in postings:
                del postings[document_id]
                if not postings:
                    empty_terms.append(term)

        for term in empty_terms:
            del self._index[term]

        del self._doc_lengths[document_id]

    # =========================================================================
    # Search
    # =========================================================================

    def search(
        self,
        query_keywords: List[str],
        top_k: Optional[int] = None,
        min_score: Optional[float] = None,
        document_ids: Optional[List[str]] = None,
    ) -> List[KeywordSearchResult]:
        """
        Search for documents matching keywords using BM25 scoring.

        Args:
            query_keywords: List of query keywords.
            top_k: Maximum results. Defaults to config.keyword_top_k.
            min_score: Minimum BM25 score. Defaults to config.keyword_min_score.
            document_ids: Optional filter to specific document IDs.

        Returns:
            Sorted list of KeywordSearchResult (highest score first).
        """
        top_k = top_k or self._macro_cfg.keyword_top_k
        min_score = min_score if min_score is not None else self._macro_cfg.keyword_min_score

        if not query_keywords or self._doc_count == 0:
            return []

        # Tokenize query keywords
        query_terms = []
        for kw in query_keywords:
            query_terms.extend(tokenize(kw))

        if not query_terms:
            return []

        # Build candidate set
        candidates = set(document_ids) if document_ids else None

        # Score each document
        doc_scores: Dict[str, float] = defaultdict(float)
        doc_matches: Dict[str, List[str]] = defaultdict(list)

        for term in query_terms:
            postings = self._index.get(term, {})
            if not postings:
                continue

            # IDF: log((N - df + 0.5) / (df + 0.5) + 1)
            df = len(postings)
            idf = math.log((self._doc_count - df + 0.5) / (df + 0.5) + 1.0)

            for doc_id, tf in postings.items():
                if candidates is not None and doc_id not in candidates:
                    continue

                dl = self._doc_lengths.get(doc_id, 1)
                # BM25 term score
                numerator = tf * (_K1 + 1)
                denominator = tf + _K1 * (1 - _B + _B * dl / max(self._avg_dl, 1))
                score = idf * (numerator / denominator)

                doc_scores[doc_id] += score
                if term not in doc_matches[doc_id]:
                    doc_matches[doc_id].append(term)

        # Filter and sort
        results: List[KeywordSearchResult] = []
        for doc_id, score in doc_scores.items():
            if score >= min_score:
                results.append(KeywordSearchResult(
                    document_id=doc_id,
                    score=score,
                    matched_terms=doc_matches[doc_id],
                ))

        results.sort(key=lambda r: r.score, reverse=True)
        return results[:top_k]

    def count(self) -> int:
        """Get number of indexed documents."""
        return self._doc_count

    def get_stats(self) -> Dict[str, Any]:
        """Get index statistics."""
        return {
            "document_count": self._doc_count,
            "unique_terms": len(self._index),
            "avg_doc_length": round(self._avg_dl, 1),
        }

    # =========================================================================
    # Persistence
    # =========================================================================

    def save(self) -> None:
        """Save index to disk."""
        if not self.storage_dir:
            return

        self.storage_dir.mkdir(parents=True, exist_ok=True)
        path = self.storage_dir / self._store_cfg.keyword_index_file

        data = {
            "index": dict(self._index),
            "doc_lengths": self._doc_lengths,
            "doc_count": self._doc_count,
            "avg_dl": self._avg_dl,
        }

        content = json.dumps(data, ensure_ascii=False)

        if self._store_cfg.use_atomic_writes:
            fd, tmp_path = tempfile.mkstemp(
                dir=str(self.storage_dir),
                prefix=".tmp_kw_",
                suffix=".json",
            )
            try:
                with os.fdopen(fd, "w", encoding="utf-8") as f:
                    f.write(content)
                shutil.move(tmp_path, str(path))
            except Exception:
                try:
                    os.unlink(tmp_path)
                except OSError:
                    pass
                raise
        else:
            path.write_text(content, encoding="utf-8")

        logger.debug(f"Saved keyword index: {self._doc_count} docs, {len(self._index)} terms")

    def _load(self) -> None:
        """Load index from disk."""
        if not self.storage_dir:
            return

        path = self.storage_dir / self._store_cfg.keyword_index_file
        if not path.exists():
            return

        try:
            with open(path, "r", encoding="utf-8") as f:
                data = json.load(f)

            self._index = defaultdict(dict, data.get("index", {}))
            self._doc_lengths = data.get("doc_lengths", {})
            self._doc_count = data.get("doc_count", 0)
            self._avg_dl = data.get("avg_dl", 0.0)

            logger.debug(f"Loaded keyword index: {self._doc_count} docs, {len(self._index)} terms")
        except (json.JSONDecodeError, KeyError) as e:
            logger.warning(f"Failed to load keyword index: {e}")
            self._index = defaultdict(dict)
            self._doc_lengths = {}
            self._doc_count = 0
            self._avg_dl = 0.0

    def clear(self) -> None:
        """Clear the entire index."""
        self._index = defaultdict(dict)
        self._doc_lengths = {}
        self._doc_count = 0
        self._avg_dl = 0.0
