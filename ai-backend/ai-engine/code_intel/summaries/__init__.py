"""
Hierarchical Summaries Module - Compression Layer

You cannot rely on retrieval alone.

Generate summaries offline:
- Repo summary: Architecture, entry points, subsystems, conventions (300-800 tokens)
- File summaries: Responsibility, public API, dependencies, side effects (5-8 lines)

These summaries are cheap context. Raw code is expensive.
"""

from .file_summarizer import FileSummarizer, summarize_file
from .repo_summarizer import RepoSummarizer, summarize_repository
from .summary_store import SummaryStore, IncrementalSummaryManager
from .facts_store import FactsStore

__all__ = [
    "FileSummarizer",
    "summarize_file",
    "RepoSummarizer",
    "summarize_repository",
    "SummaryStore",
    "IncrementalSummaryManager",
    "FactsStore",
]
