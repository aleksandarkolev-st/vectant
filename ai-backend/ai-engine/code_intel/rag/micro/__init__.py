"""
Micro-Navigation Package (Step 3)

Agentic ToC tree traversal using a fast LLM to find exact sections
within the top documents selected by macro-retrieval.

Pipeline:
    Top docs → TreeNavigator (LLM reads ToC) → SectionExtractor → RelevanceScorer → precise sections
"""

from .tree_navigator import TreeNavigator
from .section_extractor import SectionExtractor
from .page_resolver import PageResolver
from .relevance_scorer import RelevanceScorer

__all__ = [
    "TreeNavigator",
    "SectionExtractor",
    "PageResolver",
    "RelevanceScorer",
]
