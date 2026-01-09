"""
Evaluation Harness for Code Intelligence.

Measures retrieval quality with:
1. Test queries with expected results
2. Recall@k metrics
3. Precision metrics
4. MRR (Mean Reciprocal Rank)

This allows us to track quality over time and catch regressions.
"""

from __future__ import annotations

import json
import logging
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional, Set

from ..core.types import SemanticChunk


logger = logging.getLogger("code_intel.evaluation")


# =============================================================================
# Data Structures
# =============================================================================

@dataclass
class EvalQuery:
    """A test query with expected results."""
    id: str
    query: str
    
    # Expected results (at least one should be found)
    expected_files: List[str] = field(default_factory=list)
    expected_symbols: List[str] = field(default_factory=list)
    
    # Context
    context_file: Optional[str] = None  # File user is editing
    intent: Optional[str] = None  # Query intent type
    
    # Tags for filtering
    tags: List[str] = field(default_factory=list)
    
    # Expected to NOT appear (false positive indicators)
    unexpected_files: List[str] = field(default_factory=list)
    unexpected_symbols: List[str] = field(default_factory=list)


@dataclass
class EvalResult:
    """Result of evaluating a single query."""
    query_id: str
    query: str
    
    # Metrics
    recall: float  # % of expected items found
    precision: float  # % of returned items that were expected
    mrr: float  # Mean Reciprocal Rank
    
    # Details
    found_expected: List[str]
    missed_expected: List[str]
    found_unexpected: List[str]  # False positives
    
    # Timing
    retrieval_time_ms: float
    
    # Full results
    top_k_results: List[str] = field(default_factory=list)


@dataclass
class EvalSummary:
    """Summary of all evaluation results."""
    total_queries: int
    
    # Aggregate metrics
    mean_recall: float
    mean_precision: float
    mean_mrr: float
    
    # Recall at different k
    recall_at_1: float
    recall_at_5: float
    recall_at_10: float
    
    # Quality indicators
    queries_with_full_recall: int
    queries_with_false_positives: int
    
    # Timing
    mean_retrieval_time_ms: float
    total_time_ms: float
    
    # Per-query details
    results: List[EvalResult] = field(default_factory=list)


# =============================================================================
# Evaluation Functions
# =============================================================================

def compute_recall(
    expected: Set[str],
    found: Set[str],
) -> float:
    """Compute recall: what fraction of expected items were found."""
    if not expected:
        return 1.0
    return len(expected & found) / len(expected)


def compute_precision(
    expected: Set[str],
    found: Set[str],
) -> float:
    """Compute precision: what fraction of found items were expected."""
    if not found:
        return 0.0
    return len(expected & found) / len(found)


def compute_mrr(
    expected: Set[str],
    ranked_results: List[str],
) -> float:
    """
    Compute Mean Reciprocal Rank.
    
    MRR = 1/rank of first relevant result
    """
    for i, result in enumerate(ranked_results, 1):
        if result in expected:
            return 1.0 / i
    return 0.0


def compute_recall_at_k(
    expected: Set[str],
    ranked_results: List[str],
    k: int,
) -> float:
    """Compute recall when only looking at top-k results."""
    top_k = set(ranked_results[:k])
    return compute_recall(expected, top_k)


# =============================================================================
# Evaluation Harness
# =============================================================================

class EvaluationHarness:
    """
    Harness for evaluating retrieval quality.
    
    Usage:
        harness = EvaluationHarness()
        harness.add_query(EvalQuery(...))
        summary = harness.run(retrieval_fn)
    """
    
    def __init__(self):
        self.queries: List[EvalQuery] = []
    
    def add_query(self, query: EvalQuery) -> None:
        """Add an evaluation query."""
        self.queries.append(query)
    
    def add_queries(self, queries: List[EvalQuery]) -> None:
        """Add multiple evaluation queries."""
        self.queries.extend(queries)
    
    def load_queries(self, path: str) -> None:
        """Load queries from a JSON file."""
        with open(path, "r") as f:
            data = json.load(f)
        
        for item in data.get("queries", []):
            self.queries.append(EvalQuery(
                id=item["id"],
                query=item["query"],
                expected_files=item.get("expected_files", []),
                expected_symbols=item.get("expected_symbols", []),
                context_file=item.get("context_file"),
                intent=item.get("intent"),
                tags=item.get("tags", []),
                unexpected_files=item.get("unexpected_files", []),
                unexpected_symbols=item.get("unexpected_symbols", []),
            ))
    
    def run(
        self,
        retrieval_fn: Callable[[str, Optional[str]], List[SemanticChunk]],
        k: int = 10,
        tags: Optional[List[str]] = None,
    ) -> EvalSummary:
        """
        Run evaluation on all queries.
        
        Args:
            retrieval_fn: Function that takes (query, context_file) and returns chunks
            k: Number of results to retrieve
            tags: Only run queries with these tags (None = all)
            
        Returns:
            Summary of evaluation results
        """
        # Filter queries by tag if specified
        queries = self.queries
        if tags:
            queries = [q for q in queries if any(t in q.tags for t in tags)]
        
        if not queries:
            logger.warning("No queries to evaluate")
            return EvalSummary(
                total_queries=0,
                mean_recall=0,
                mean_precision=0,
                mean_mrr=0,
                recall_at_1=0,
                recall_at_5=0,
                recall_at_10=0,
                queries_with_full_recall=0,
                queries_with_false_positives=0,
                mean_retrieval_time_ms=0,
                total_time_ms=0,
            )
        
        results: List[EvalResult] = []
        start_time = time.time()
        
        for query in queries:
            result = self._evaluate_query(query, retrieval_fn, k)
            results.append(result)
        
        total_time = (time.time() - start_time) * 1000
        
        # Compute aggregate metrics
        return EvalSummary(
            total_queries=len(results),
            mean_recall=sum(r.recall for r in results) / len(results),
            mean_precision=sum(r.precision for r in results) / len(results),
            mean_mrr=sum(r.mrr for r in results) / len(results),
            recall_at_1=self._compute_recall_at_k_aggregate(results, 1),
            recall_at_5=self._compute_recall_at_k_aggregate(results, 5),
            recall_at_10=self._compute_recall_at_k_aggregate(results, 10),
            queries_with_full_recall=sum(1 for r in results if r.recall == 1.0),
            queries_with_false_positives=sum(1 for r in results if r.found_unexpected),
            mean_retrieval_time_ms=sum(r.retrieval_time_ms for r in results) / len(results),
            total_time_ms=total_time,
            results=results,
        )
    
    def _evaluate_query(
        self,
        query: EvalQuery,
        retrieval_fn: Callable[[str, Optional[str]], List[SemanticChunk]],
        k: int,
    ) -> EvalResult:
        """Evaluate a single query."""
        # Run retrieval
        start = time.time()
        chunks = retrieval_fn(query.query, query.context_file)
        retrieval_time = (time.time() - start) * 1000
        
        # Extract identifiers from results
        found_files: Set[str] = set()
        found_symbols: Set[str] = set()
        top_k_results: List[str] = []
        
        for chunk in chunks[:k]:
            if chunk.file_path:
                # Normalize path for comparison
                file_id = self._normalize_path(chunk.file_path)
                found_files.add(file_id)
            
            if chunk.symbol_name:
                found_symbols.add(chunk.symbol_name)
            
            # Track result ordering
            result_id = f"{chunk.file_path}:{chunk.symbol_name}"
            top_k_results.append(result_id)
        
        # Build expected sets
        expected_files = {self._normalize_path(f) for f in query.expected_files}
        expected_symbols = set(query.expected_symbols)
        expected_all = expected_files | expected_symbols
        found_all = found_files | found_symbols
        
        # Build unexpected sets
        unexpected_files = {self._normalize_path(f) for f in query.unexpected_files}
        unexpected_symbols = set(query.unexpected_symbols)
        unexpected_all = unexpected_files | unexpected_symbols
        
        # Compute metrics
        recall = compute_recall(expected_all, found_all)
        precision = compute_precision(expected_all, found_all)
        
        # For MRR, check which items in order
        mrr = 0.0
        for i, result in enumerate(top_k_results, 1):
            file_path, symbol = result.split(":", 1) if ":" in result else (result, "")
            file_id = self._normalize_path(file_path)
            if file_id in expected_files or symbol in expected_symbols:
                mrr = 1.0 / i
                break
        
        return EvalResult(
            query_id=query.id,
            query=query.query,
            recall=recall,
            precision=precision,
            mrr=mrr,
            found_expected=list(expected_all & found_all),
            missed_expected=list(expected_all - found_all),
            found_unexpected=list(unexpected_all & found_all),
            retrieval_time_ms=retrieval_time,
            top_k_results=top_k_results,
        )
    
    def _normalize_path(self, path: str) -> str:
        """Normalize path for comparison."""
        # Get just the filename for simple comparison
        return Path(path).name
    
    def _compute_recall_at_k_aggregate(
        self,
        results: List[EvalResult],
        k: int,
    ) -> float:
        """Compute aggregate recall@k across all queries."""
        total = 0.0
        for result in results:
            # Re-compute recall with only top-k
            found_in_top_k = set(result.top_k_results[:k])
            expected = set(result.found_expected) | set(result.missed_expected)
            
            # Check how many expected are in top-k (by file/symbol name)
            found_count = 0
            for exp in expected:
                for res in found_in_top_k:
                    if exp in res:
                        found_count += 1
                        break
            
            total += found_count / len(expected) if expected else 1.0
        
        return total / len(results) if results else 0.0


# =============================================================================
# Pre-built Test Suites
# =============================================================================

def create_basic_test_suite() -> List[EvalQuery]:
    """Create a basic test suite for common patterns."""
    return [
        # Definition lookup
        EvalQuery(
            id="def_simple_function",
            query="find the definition of parse_query",
            expected_symbols=["parse_query", "ParsedQuery"],
            tags=["definition", "function"],
        ),
        EvalQuery(
            id="def_class",
            query="where is the User class defined",
            expected_symbols=["User"],
            tags=["definition", "class"],
        ),
        
        # Usage patterns
        EvalQuery(
            id="usage_api_call",
            query="how to use the API client",
            expected_symbols=["APIClient", "api_call", "client"],
            tags=["usage", "api"],
        ),
        
        # Error handling
        EvalQuery(
            id="error_handling",
            query="how are errors handled",
            expected_symbols=["Exception", "Error", "handle_error"],
            tags=["error", "exception"],
        ),
        
        # Configuration
        EvalQuery(
            id="config_lookup",
            query="where is the database configuration",
            expected_files=["config.py", "settings.py", "database.py"],
            expected_symbols=["DatabaseConfig", "DB_URL"],
            tags=["config", "database"],
        ),
        
        # Testing patterns
        EvalQuery(
            id="test_example",
            query="show me test examples for the parser",
            expected_files=["test_parser.py"],
            tags=["test", "example"],
        ),
    ]


def create_code_navigation_suite() -> List[EvalQuery]:
    """Test suite for code navigation scenarios."""
    return [
        EvalQuery(
            id="nav_imports",
            query="what does this file import from",
            expected_symbols=["import"],
            tags=["navigation", "imports"],
        ),
        EvalQuery(
            id="nav_references",
            query="find all usages of validate_input",
            expected_symbols=["validate_input"],
            tags=["navigation", "references"],
        ),
        EvalQuery(
            id="nav_inheritance",
            query="what classes inherit from BaseHandler",
            expected_symbols=["BaseHandler"],
            tags=["navigation", "inheritance"],
        ),
    ]


def save_eval_results(summary: EvalSummary, path: str) -> None:
    """Save evaluation results to a JSON file."""
    data = {
        "summary": {
            "total_queries": summary.total_queries,
            "mean_recall": summary.mean_recall,
            "mean_precision": summary.mean_precision,
            "mean_mrr": summary.mean_mrr,
            "recall_at_1": summary.recall_at_1,
            "recall_at_5": summary.recall_at_5,
            "recall_at_10": summary.recall_at_10,
            "queries_with_full_recall": summary.queries_with_full_recall,
            "queries_with_false_positives": summary.queries_with_false_positives,
            "mean_retrieval_time_ms": summary.mean_retrieval_time_ms,
            "total_time_ms": summary.total_time_ms,
        },
        "results": [
            {
                "query_id": r.query_id,
                "query": r.query,
                "recall": r.recall,
                "precision": r.precision,
                "mrr": r.mrr,
                "found_expected": r.found_expected,
                "missed_expected": r.missed_expected,
                "found_unexpected": r.found_unexpected,
                "retrieval_time_ms": r.retrieval_time_ms,
            }
            for r in summary.results
        ],
    }
    
    with open(path, "w") as f:
        json.dump(data, f, indent=2)


def print_eval_summary(summary: EvalSummary) -> None:
    """Print a human-readable summary."""
    print("\n" + "=" * 60)
    print("EVALUATION SUMMARY")
    print("=" * 60)
    print(f"Total queries:           {summary.total_queries}")
    print(f"Mean recall:             {summary.mean_recall:.2%}")
    print(f"Mean precision:          {summary.mean_precision:.2%}")
    print(f"Mean MRR:                {summary.mean_mrr:.3f}")
    print("-" * 60)
    print(f"Recall@1:                {summary.recall_at_1:.2%}")
    print(f"Recall@5:                {summary.recall_at_5:.2%}")
    print(f"Recall@10:               {summary.recall_at_10:.2%}")
    print("-" * 60)
    print(f"Full recall:             {summary.queries_with_full_recall}/{summary.total_queries}")
    print(f"False positives:         {summary.queries_with_false_positives}/{summary.total_queries}")
    print(f"Mean retrieval time:     {summary.mean_retrieval_time_ms:.1f}ms")
    print("=" * 60 + "\n")
