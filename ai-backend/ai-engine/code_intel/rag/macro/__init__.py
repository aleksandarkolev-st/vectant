"""
Macro-Retrieval Package (Step 2)

Narrows the full document corpus to the top 3-5 most relevant documents
using fast vector + keyword hybrid search over document summaries.

Pipeline:
    Query → QueryAnalyzer → SummarySearcher + KeywordFilter → DocumentRanker → top docs
"""

from .query_analyzer import QueryAnalyzer
from .summary_searcher import SummarySearcher
from .keyword_filter import KeywordFilter
from .document_ranker import DocumentRanker

__all__ = [
    "QueryAnalyzer",
    "SummarySearcher",
    "KeywordFilter",
    "DocumentRanker",
]
