"""
Query Analyzer — Extracts structured information from a raw user query.

Responsibilities:
- Keyword extraction (stop word removal, stemming-lite)
- Intent classification (factual, conceptual, procedural)
- Query expansion with synonyms/related terms
- Embedding generation for vector search
"""

from __future__ import annotations

import hashlib
import logging
import re
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional, Set

from ..config import MacroConfig, RAGConfig, get_rag_config
from ..exceptions import MacroRetrievalError

logger = logging.getLogger("code_intel.rag.macro.query_analyzer")


# ── Stop words (minimal set for code-oriented queries) ─────────────────────
_STOP_WORDS: Set[str] = {
    "a", "an", "the", "is", "are", "was", "were", "be", "been", "being",
    "have", "has", "had", "do", "does", "did", "will", "would", "could",
    "should", "may", "might", "shall", "can",
    "i", "me", "my", "we", "our", "you", "your", "he", "she", "it",
    "they", "them", "their", "this", "that", "these", "those",
    "in", "on", "at", "to", "for", "of", "with", "by", "from", "as",
    "into", "about", "between", "through", "during", "before", "after",
    "above", "below", "up", "down", "out", "off", "over", "under",
    "and", "but", "or", "nor", "not", "so", "yet", "both", "either",
    "if", "then", "else", "when", "where", "why", "how", "what", "which",
    "who", "whom", "whose",
    "all", "each", "every", "any", "some", "no", "most", "other",
    "than", "too", "very", "just", "only", "also", "more",
}


class QueryIntent:
    """Classification of query intent."""
    FACTUAL = "factual"           # "What does X do?"
    CONCEPTUAL = "conceptual"     # "How does the auth system work?"
    PROCEDURAL = "procedural"     # "How to set up Oauth?"
    DEBUGGING = "debugging"       # "Why does X fail?"
    COMPARISON = "comparison"     # "What's the difference between X and Y?"
    UNKNOWN = "unknown"


@dataclass
class AnalyzedQuery:
    """Result of query analysis."""
    original_text: str
    keywords: List[str]                          # Extracted keywords
    expanded_keywords: List[str]                  # With synonyms/variants
    intent: str = QueryIntent.UNKNOWN
    entities: List[str] = field(default_factory=list)  # Named entities
    embedding: Optional[Any] = field(default=None, repr=False)  # numpy array

    # Query expansion
    expanded_text: str = ""                       # Expanded query for embedding

    # Diagnostics
    stop_words_removed: int = 0

    @property
    def all_keywords(self) -> List[str]:
        """All keywords including expanded."""
        seen: Set[str] = set()
        result: List[str] = []
        for kw in self.keywords + self.expanded_keywords:
            low = kw.lower()
            if low not in seen:
                seen.add(low)
                result.append(kw)
        return result


class QueryAnalyzer:
    """
    Analyze a raw user query for macro-retrieval.

    Extracts keywords, classifies intent, and generates an embedding
    for vector search over document summaries.
    """

    def __init__(
        self,
        config: Optional[RAGConfig] = None,
        embedder: Optional[Any] = None,
    ):
        """
        Initialize query analyzer.

        Args:
            config: RAG configuration. Uses global config if None.
            embedder: Optional embedder instance. If None, will create one
                     lazily using the existing code_intel Embedder.
        """
        self.config = config or get_rag_config()
        self._embedder = embedder

    # =========================================================================
    # Public API
    # =========================================================================

    def analyze(
        self,
        query_text: str,
        generate_embedding: bool = True,
        embedding_text: Optional[str] = None,
    ) -> AnalyzedQuery:
        """
        Analyze a user query.

        Args:
            query_text: Raw user query text. Used for keyword/intent/entity
                extraction.
            generate_embedding: Whether to generate an embedding vector.
            embedding_text: Optional override for the text fed to the
                embedder. When set, keywords still come from ``query_text``
                but the vector signal embeds this string instead. Used by
                the HyDE path so the embedding lives in the same semantic
                space as the indexed corpus while BM25 keeps the user's
                actual terms.

        Returns:
            AnalyzedQuery with keywords, intent, and optional embedding.
        """
        if not query_text or not query_text.strip():
            raise MacroRetrievalError("Empty query text")

        text = query_text.strip()

        # Extract keywords
        keywords, stop_count = self._extract_keywords(text)

        # Classify intent
        intent = self._classify_intent(text)

        # Extract entities (PascalCase, UPPER_CASE, backticked)
        entities = self._extract_entities(text)

        # Expand keywords with variants
        expanded = self._expand_keywords(keywords, entities)

        # Build expanded text for embedding
        expanded_text = self._build_expanded_text(text, keywords, entities)

        # Generate embedding (HyDE override takes precedence when supplied)
        embedding = None
        if generate_embedding:
            embed_input = embedding_text.strip() if embedding_text and embedding_text.strip() else expanded_text
            embedding = self._generate_embedding(embed_input)

        return AnalyzedQuery(
            original_text=text,
            keywords=keywords,
            expanded_keywords=expanded,
            intent=intent,
            entities=entities,
            embedding=embedding,
            expanded_text=expanded_text,
            stop_words_removed=stop_count,
        )

    # =========================================================================
    # Keyword Extraction
    # =========================================================================

    def _extract_keywords(self, text: str) -> tuple:
        """
        Extract keywords from query text.

        Returns:
            Tuple of (keywords list, stop words removed count).
        """
        # Tokenize: keep alphanumeric, underscores, hyphens
        tokens = re.findall(r'[a-zA-Z_][a-zA-Z0-9_\-]*', text)

        keywords: List[str] = []
        stop_count = 0

        for token in tokens:
            lower = token.lower()
            if lower in _STOP_WORDS:
                stop_count += 1
                continue
            if len(lower) < 2:
                continue
            keywords.append(token)

        # Deduplicate while preserving order
        seen: Set[str] = set()
        unique: List[str] = []
        for kw in keywords:
            low = kw.lower()
            if low not in seen:
                seen.add(low)
                unique.append(kw)

        return unique, stop_count

    # =========================================================================
    # Intent Classification
    # =========================================================================

    def _classify_intent(self, text: str) -> str:
        """
        Classify query intent using heuristic rules.

        No LLM call — this must be fast for macro-retrieval.
        """
        lower = text.lower()

        # Procedural: "how to", "steps to", "guide", "setup", "configure"
        procedural_patterns = [
            r'\bhow\s+(?:to|do|can)\b',
            r'\bsteps?\s+(?:to|for)\b',
            r'\bguide\b', r'\bsetup\b', r'\bconfigure\b',
            r'\binstall\b', r'\bcreate\b', r'\bbuild\b',
        ]
        for pat in procedural_patterns:
            if re.search(pat, lower):
                return QueryIntent.PROCEDURAL

        # Debugging: "error", "fail", "bug", "issue", "wrong", "doesn't work"
        debug_patterns = [
            r'\berror\b', r'\bfail(?:s|ed|ing)?\b', r'\bbug\b',
            r'\bissue\b', r'\bwrong\b', r"doesn'?t\s+work\b",
            r'\bbroken\b', r'\bcrash(?:es|ing)?\b',
        ]
        for pat in debug_patterns:
            if re.search(pat, lower):
                return QueryIntent.DEBUGGING

        # Comparison: "difference", "compare", "vs", "versus", "or"
        comparison_patterns = [
            r'\bdifference\b', r'\bcompare\b', r'\bvs\.?\b',
            r'\bversus\b', r'\bbetter\b',
        ]
        for pat in comparison_patterns:
            if re.search(pat, lower):
                return QueryIntent.COMPARISON

        # Factual: "what is", "what does", "define", "explain"
        factual_patterns = [
            r'\bwhat\s+(?:is|does|are)\b',
            r'\bdefine\b', r'\bexplain\b', r'\bdescribe\b',
        ]
        for pat in factual_patterns:
            if re.search(pat, lower):
                return QueryIntent.FACTUAL

        # Conceptual: "how does", "architecture", "design", "concept"
        conceptual_patterns = [
            r'\bhow\s+does\b', r'\barchitecture\b', r'\bdesign\b',
            r'\bconcept\b', r'\bpattern\b', r'\bstrategy\b',
        ]
        for pat in conceptual_patterns:
            if re.search(pat, lower):
                return QueryIntent.CONCEPTUAL

        return QueryIntent.UNKNOWN

    # =========================================================================
    # Entity Extraction
    # =========================================================================

    def _extract_entities(self, text: str) -> List[str]:
        """
        Extract named entities from query using pattern matching.

        Targets:
        - PascalCase identifiers (e.g., AuthService, VectorIndex)
        - UPPER_CASE constants (e.g., MAX_RETRIES, API_KEY)
        - Backticked terms (e.g., `generate_content`)
        - Dotted paths (e.g., code_intel.indexer)
        """
        entities: List[str] = []
        seen: Set[str] = set()

        def _add(entity: str) -> None:
            if entity and entity.lower() not in seen:
                seen.add(entity.lower())
                entities.append(entity)

        # Backticked terms
        for match in re.finditer(r'`([^`]+)`', text):
            _add(match.group(1).strip())

        # PascalCase (at least two capitals)
        for match in re.finditer(r'\b([A-Z][a-z]+(?:[A-Z][a-z]+)+)\b', text):
            _add(match.group(1))

        # UPPER_CASE (at least 2 chars with underscore)
        for match in re.finditer(r'\b([A-Z][A-Z0-9_]{2,})\b', text):
            _add(match.group(1))

        # Dotted paths
        for match in re.finditer(r'\b([a-zA-Z_]\w+(?:\.\w+)+)\b', text):
            _add(match.group(1))

        # snake_case identifiers (2+ words)
        for match in re.finditer(r'\b([a-z]+_[a-z_]+)\b', text):
            term = match.group(1)
            if term.lower() not in _STOP_WORDS and len(term) > 4:
                _add(term)

        return entities

    # =========================================================================
    # Keyword Expansion
    # =========================================================================

    def _expand_keywords(
        self,
        keywords: List[str],
        entities: List[str],
    ) -> List[str]:
        """
        Expand keywords with related terms.

        Uses simple rule-based expansion (no LLM call).
        """
        expanded: List[str] = []
        seen: Set[str] = {kw.lower() for kw in keywords}

        for kw in keywords:
            # Split PascalCase: AuthService -> auth, service
            parts = re.findall(r'[A-Z][a-z]+|[a-z]+|[A-Z]+', kw)
            for part in parts:
                low = part.lower()
                if low not in seen and low not in _STOP_WORDS and len(low) > 2:
                    seen.add(low)
                    expanded.append(low)

            # Split snake_case: auth_service -> auth, service
            if '_' in kw:
                for part in kw.split('_'):
                    low = part.lower()
                    if low not in seen and low not in _STOP_WORDS and len(low) > 2:
                        seen.add(low)
                        expanded.append(low)

        # Add entity parts
        for entity in entities:
            parts = re.findall(r'[A-Z][a-z]+|[a-z]+|[A-Z]+', entity)
            for part in parts:
                low = part.lower()
                if low not in seen and low not in _STOP_WORDS and len(low) > 2:
                    seen.add(low)
                    expanded.append(low)

        return expanded

    # =========================================================================
    # Embedding
    # =========================================================================

    def _build_expanded_text(
        self,
        text: str,
        keywords: List[str],
        entities: List[str],
    ) -> str:
        """Build expanded text for embedding generation."""
        parts = [text]
        if entities:
            parts.append(f"Entities: {', '.join(entities)}")
        if keywords:
            parts.append(f"Keywords: {', '.join(keywords)}")
        return "\n".join(parts)

    def _generate_embedding(self, text: str) -> Optional[Any]:
        """
        Generate embedding for query text.

        Uses the existing code_intel Embedder to maintain consistency.
        """
        embedder = self._get_embedder()
        if not embedder:
            return None

        try:
            vector = embedder.embed_query(text)
            return vector
        except Exception as e:
            logger.warning(f"Failed to generate query embedding: {e}")
            return None

    def _get_embedder(self):
        """Lazy-load embedder."""
        if self._embedder is not None:
            return self._embedder

        try:
            from ...indexer.embedder import Embedder
            self._embedder = Embedder(
                model=self.config.embedding_model,
                api_key=self.config.embedding_api_key,
            )
            return self._embedder
        except (ImportError, Exception) as e:
            logger.warning(f"Could not initialize Embedder: {e}")
            return None
