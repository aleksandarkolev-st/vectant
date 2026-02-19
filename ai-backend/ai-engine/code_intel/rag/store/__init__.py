"""
Store sub-package for the RAG subsystem.

Provides persistent storage for:
- Documents and metadata
- ToC trees
- Document summaries and their embeddings
- Sections with content
"""

from .document_store import DocumentStore
from .toc_store import ToCStore
from .summary_index import SummaryIndex
from .section_store import SectionStore

__all__ = [
    "DocumentStore",
    "ToCStore",
    "SummaryIndex",
    "SectionStore",
]
