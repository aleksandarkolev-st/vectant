"""
Lightweight Reranker - Reduce false positives in retrieval results.

Even with good ranking, we get false positives. A reranker:
1. Cross-checks query against each candidate more carefully
2. Uses features that are expensive to compute upfront
3. Filters out low-quality matches

This is intentionally lightweight - not a full cross-encoder model.
"""

from __future__ import annotations

import logging
import re
import json
import time
from dataclasses import dataclass, field
from typing import Dict, List, Optional, Set, Tuple

from ..core.types import SemanticChunk, SYMBOL_STOPWORDS


logger = logging.getLogger("code_intel.retrieval.reranker")


@dataclass
class RerankerConfig:
    """Configuration for reranking."""
    # Thresholds
    min_relevance_score: float = 0.1  # Minimum score to keep
    query_term_threshold: float = 0.3  # Min query term coverage to keep
    
    # Weights for reranking factors
    query_coverage_weight: float = 0.3
    symbol_specificity_weight: float = 0.2
    code_quality_weight: float = 0.2
    context_alignment_weight: float = 0.3
    
    # Filtering
    max_results: int = 20
    filter_duplicates: bool = True
    filter_low_quality: bool = True

    # Maximal Marginal Relevance (Carbonell & Goldstein 1998).
    # Diversifies the top-k so the LLM doesn't see five copies of the
    # same chunk from one file. λ=1 disables (pure relevance);
    # λ=0 is pure diversity. 0.7 is a strong default for code search.
    enable_mmr: bool = True
    mmr_lambda: float = 0.7


@dataclass
class RerankedResult:
    """A result after reranking."""
    chunk: SemanticChunk
    original_score: float
    rerank_score: float
    relevance_reason: str  # Why this is relevant
    
    # Detailed factors
    query_coverage: float = 0.0
    symbol_specificity: float = 0.0
    code_quality: float = 0.0
    context_alignment: float = 0.0


class LightweightReranker:
    """
    Rerank retrieval results to reduce false positives.
    
    This is NOT a neural reranker. It uses rule-based scoring:
    1. Query term coverage - how many query terms appear in the result
    2. Symbol specificity - is this a specific symbol or a generic one
    3. Code quality indicators - does it have docs, proper naming, etc.
    4. Context alignment - does it fit the query context
    
    Goal: Remove obviously irrelevant results that slipped through.
    """
    
    def __init__(self, config: Optional[RerankerConfig] = None):
        self.config = config or RerankerConfig()
        
        # Compile patterns for efficiency
        self._identifier_pattern = re.compile(r'[A-Za-z_][A-Za-z0-9_]*')
        self._camel_split = re.compile(r'(?<!^)(?=[A-Z])')
    
    def rerank(
        self,
        candidates: List[Tuple[SemanticChunk, float]],
        query: str,
        query_symbols: Optional[List[str]] = None,
        current_file: Optional[str] = None,
    ) -> List[RerankedResult]:
        """
        Rerank candidates to reduce false positives.
        
        Args:
            candidates: List of (chunk, score) from initial retrieval
            query: Original user query
            query_symbols: Symbols extracted from query
            current_file: File user is currently editing
            
        Returns:
            Reranked and filtered results
        """
        if not candidates:
            return []
        
        query_symbols = query_symbols or []
        
        # Extract query terms


        query_terms = self._extract_terms(query)
        query_terms.update(self._extract_terms(" ".join(query_symbols)))
        
        # Rerank each candidate
        results: List[RerankedResult] = []
        seen_signatures: Set[str] = set()  # For deduplication


        
        for chunk, original_score in candidates:
            # Compute reranking factors
            query_coverage = self._compute_query_coverage(chunk, query_terms)
            symbol_specificity = self._compute_symbol_specificity(chunk)
            code_quality = self._compute_code_quality(chunk)
            context_alignment = self._compute_context_alignment(
                chunk, current_file, query_terms
            )
            
            # Combined rerank score
            rerank_score = (
                self.config.query_coverage_weight * query_coverage +
                self.config.symbol_specificity_weight * symbol_specificity +
                self.config.code_quality_weight * code_quality +
                self.config.context_alignment_weight * context_alignment
            )

            
            # Filter low scores
            if rerank_score < self.config.min_relevance_score:
                continue
            
            # Filter poor query coverage
            if query_coverage < self.config.query_term_threshold:
                # Unless original score was very high (semantic match)
                if original_score < 0.8:
                    continue
            
            # Deduplicate by signature
            if self.config.filter_duplicates:
                sig = self._get_signature(chunk)
                if sig in seen_signatures:
                    continue
                seen_signatures.add(sig)
            
            # Generate relevance reason
            reason = self._generate_relevance_reason(
                chunk, query_terms, query_coverage, symbol_specificity
            )
            
            results.append(RerankedResult(
                chunk=chunk,
                original_score=original_score,
                rerank_score=rerank_score,
                relevance_reason=reason,
                query_coverage=query_coverage,
                symbol_specificity=symbol_specificity,
                code_quality=code_quality,
                context_alignment=context_alignment,
            ))
        
        # Sort by rerank score
        results.sort(key=lambda r: r.rerank_score, reverse=True)

        # Diversity pass via MMR — prevents five near-duplicates from the
        # same file dominating the top-k. Skip when MMR is disabled or
        # when there are fewer results than the cap.
        if self.config.enable_mmr and len(results) > self.config.max_results:
            results = self._mmr_select(results, top_k=self.config.max_results)
            return results

        # Limit results
        return results[:self.config.max_results]

    def _mmr_select(
        self,
        results: List[RerankedResult],
        *,
        top_k: int,
    ) -> List[RerankedResult]:
        """Apply Maximal Marginal Relevance over the reranked list.

        We measure inter-chunk similarity via two cheap signals stacked:
          1. Same file → +0.6 base similarity (heavy penalty for clones).
          2. Symbol token Jaccard → up to +0.4 incremental similarity.

        Embedding cosine would be more accurate but the chunks here may
        not have hot embeddings on the same vector — keeping it cheap
        ensures MMR runs in <1ms even on 100 candidates.
        """
        from .fusion import jaccard_similarity, mmr

        max_score = max((r.rerank_score for r in results), default=1.0) or 1.0

        def relevance(r: RerankedResult) -> float:
            return r.rerank_score / max_score

        def tokens_for(r: RerankedResult) -> Set[str]:
            md = r.chunk.metadata
            tokens = set()
            for attr in (
                getattr(md, "qualified_name", None),
                getattr(md, "symbol_name", None),
                getattr(md, "signature", None),
            ):
                if attr:
                    tokens.update(self._extract_terms(str(attr)))
            return tokens

        def similarity(a: RerankedResult, b: RerankedResult) -> float:
            sim = 0.0
            file_a = getattr(a.chunk.metadata, "file_path", None)
            file_b = getattr(b.chunk.metadata, "file_path", None)
            if file_a and file_b and file_a == file_b:
                sim += 0.6
            sim += 0.4 * jaccard_similarity(tokens_for(a), tokens_for(b))
            return min(1.0, sim)

        return mmr(
            candidates=results,
            relevance_fn=relevance,
            similarity_fn=similarity,
            lambda_=self.config.mmr_lambda,
            top_k=top_k,
        )
    
    def _extract_terms(self, text: str) -> Set[str]:
        """Extract searchable terms from text."""
        terms = set()
        
        # Find identifiers
        for match in self._identifier_pattern.finditer(text):
            term = match.group().lower()
            
            # Skip very short terms
            if len(term) < 3:
                continue
            
            # Skip stopwords
            if term in SYMBOL_STOPWORDS:
                continue
            
            terms.add(term)
            
            # Also add camelCase parts
            parts = self._camel_split.split(match.group())
            for part in parts:
                if len(part) >= 3:
                    terms.add(part.lower())
        
        return terms
    
    def _compute_query_coverage(
        self,
        chunk: SemanticChunk,
        query_terms: Set[str],
    ) -> float:
        """Compute how many query terms appear in the chunk."""
        if not query_terms:
            return 0.5  # Neutral if no specific terms
        
        # Extract chunk text
        chunk_text = self._get_searchable_text(chunk).lower()
        
        # Count matches
        matched = sum(1 for term in query_terms if term in chunk_text)
        
        return matched / len(query_terms)
    
    def _compute_symbol_specificity(self, chunk: SemanticChunk) -> float:
        """
        Compute how specific/unique the symbol name is.
        
        Generic names get lower scores.
        """
        symbol_name = chunk.symbol_name.lower() if chunk.symbol_name else ""
        
        if not symbol_name:
            return 0.3
        
        # Length bonus (longer = usually more specific)
        length_score = min(1.0, len(symbol_name) / 20)
        
        # Penalize generic names
        generic_penalty = 0.0
        generic_words = {
            "utils", "util", "helper", "handler", "manager",
            "service", "controller", "data", "item", "base",
            "get", "set", "do", "make", "create", "process",
        }
        
        parts = self._camel_split.split(symbol_name)
        parts = [p.lower() for p in symbol_name.split("_")]
        
        generic_count = sum(1 for p in parts if p in generic_words)
        if generic_count > 0:
            generic_penalty = min(0.5, generic_count * 0.15)
        
        return max(0.1, (length_score * 0.5 + 0.5) - generic_penalty)
    
    def _compute_code_quality(self, chunk: SemanticChunk) -> float:
        """
        Compute code quality indicators.
        
        Higher quality = more likely to be relevant.
        """
        score = 0.5  # Base score
        
        # Has docstring
        if chunk.docstring:
            score += 0.2
        
        # Has type annotations (heuristic)
        code = chunk.code_body if chunk.code_body else ""
        if "->" in code or ": " in code:
            score += 0.1
        
        # Has reasonable length (not too short, not too long)
        code_lines = len(code.split("\n")) if code else 0
        if 5 <= code_lines <= 100:
            score += 0.1
        elif code_lines > 200:
            score -= 0.1
        
        # Is public
        if chunk.metadata and chunk.metadata.is_public:
            score += 0.1
        
        return min(1.0, max(0.0, score))
    
    def _compute_context_alignment(
        self,
        chunk: SemanticChunk,
        current_file: Optional[str],
        query_terms: Set[str],
    ) -> float:
        """
        Compute how well chunk aligns with query context.
        """
        score = 0.5  # Base score
        
        # Same file bonus
        if current_file and chunk.file_path:
            if chunk.file_path == current_file:
                score += 0.3
            elif self._same_directory(chunk.file_path, current_file):
                score += 0.15
        
        # Check if qualified name matches query context
        if chunk.metadata and chunk.metadata.qualified_name:
            qname_lower = chunk.metadata.qualified_name.lower()
            for term in query_terms:
                if term in qname_lower:
                    score += 0.1
                    break
        
        return min(1.0, score)
    
    def _get_searchable_text(self, chunk: SemanticChunk) -> str:
        """Get all searchable text from a chunk."""
        parts = []
        
        if chunk.symbol_name:
            parts.append(chunk.symbol_name)
        
        if chunk.metadata:
            if chunk.metadata.qualified_name:
                parts.append(chunk.metadata.qualified_name)
            if chunk.metadata.signature:
                parts.append(chunk.metadata.signature)
        
        if chunk.docstring:
            parts.append(chunk.docstring)
        
        if chunk.code_body:
            # Just first few lines for efficiency
            lines = chunk.code_body.split("\n")[:10]
            parts.extend(lines)
        
        return " ".join(parts)
    
    def _get_signature(self, chunk: SemanticChunk) -> str:
        """Get a signature for deduplication."""
        parts = [
            chunk.file_path or "",
            chunk.symbol_name or "",
            str(chunk.metadata.start_line) if chunk.metadata else "",
        ]
        return "|".join(parts)
    
    def _same_directory(self, path1: str, path2: str) -> bool:
        """Check if two paths are in the same directory."""
        import os
        dir1 = os.path.dirname(path1)
        dir2 = os.path.dirname(path2)
        return dir1 == dir2
    
    def _generate_relevance_reason(
        self,
        chunk: SemanticChunk,
        query_terms: Set[str],
        query_coverage: float,
        symbol_specificity: float,
    ) -> str:
        """Generate human-readable reason why this is relevant."""
        reasons = []
        
        # Check for term matches
        chunk_text = self._get_searchable_text(chunk).lower()
        matched_terms = [t for t in query_terms if t in chunk_text]
        
        if matched_terms:
            reasons.append(f"Matches: {', '.join(matched_terms[:3])}")
        
        # Symbol type
        if chunk.metadata and chunk.metadata.symbol_type:
            reasons.append(chunk.metadata.symbol_type.value)
        
        # Location context
        if chunk.file_path:
            file_name = chunk.file_path.split("/")[-1].split("\\")[-1]
            reasons.append(f"in {file_name}")
        
        return " | ".join(reasons) if reasons else "Semantic match"


def rerank_results(
    candidates: List[Tuple[SemanticChunk, float]],
    query: str,
    **kwargs,
) -> List[RerankedResult]:
    """Convenience function for reranking."""
    reranker = LightweightReranker()
    return reranker.rerank(candidates, query, **kwargs)


@dataclass
class LlmRerankResult:
    """LLM reranker output entry."""
    chunk_id: str
    score: float
    reason: str = ""


class GeminiReranker:
    """
    LLM-based reranker using Gemini.

    This is optional and only used when an API key is available.
    It scores candidates from 0.0 to 1.0 based on query relevance.
    """

    def __init__(
        self,
        api_key: Optional[str] = None,
        model: str = "gemini-3.1-flash-lite-preview",
        timeout_ms: int = 6000,
    ):
        self.api_key = api_key
        self.model = model
        self.timeout_ms = timeout_ms

    def rerank(
        self,
        candidates: List[Tuple[SemanticChunk, float]],
        query: str,
        max_results: int = 20,
    ) -> List[LlmRerankResult]:
        if not candidates:
            return []
        if not self.api_key:
            return []

        try:
            import google.generativeai as genai
        except Exception:
            return []

        genai.configure(api_key=self.api_key)
        model = genai.GenerativeModel(self.model)

        payload = []
        for chunk, score in candidates[:max_results]:
            snippet = (chunk.code_body or "")
            snippet = snippet[:700]
            payload.append({
                "id": chunk.id,
                "file": chunk.metadata.file_path,
                "symbol": chunk.metadata.symbol_name,
                "signature": chunk.metadata.signature,
                "doc": (chunk.metadata.docstring or "")[:200],
                "score": float(score),
                "snippet": snippet,
            })

        prompt = (
            "You are a code retrieval reranker. "
            "Score each candidate from 0.0 to 1.0 for relevance to the query. "
            "Return ONLY valid JSON: {\"results\": [{\"id\":...,\"score\":...,\"reason\":...}, ...]}.\n\n"
            f"Query:\n{query}\n\nCandidates:\n{json.dumps(payload, ensure_ascii=False)}"
        )

        start = time.time()
        try:
            response = model.generate_content(
                prompt,
                generation_config={"temperature": 0.1, "max_output_tokens": 512},
            )
        except Exception:
            return []

        if (time.time() - start) * 1000 > self.timeout_ms:
            return []

        text = (response.text or "").strip()
        parsed = self._extract_json(text)
        if not parsed:
            return []

        results = []
        for item in parsed.get("results", []):
            try:
                cid = str(item.get("id"))
                score = float(item.get("score"))
                reason = str(item.get("reason") or "")
            except Exception:
                continue
            results.append(LlmRerankResult(chunk_id=cid, score=score, reason=reason))

        return results

    def _extract_json(self, text: str) -> Optional[Dict]:
        try:
            return json.loads(text)
        except Exception:
            pass

        fence_match = re.search(r"```(?:json)?\s*(\{[\s\S]*?\})\s*```", text)
        if fence_match:
            try:
                return json.loads(fence_match.group(1))
            except Exception:
                return None

        obj_match = re.search(r"(\{[\s\S]*\})", text)
        if obj_match:
            try:
                return json.loads(obj_match.group(1))
            except Exception:
                return None
        return None
