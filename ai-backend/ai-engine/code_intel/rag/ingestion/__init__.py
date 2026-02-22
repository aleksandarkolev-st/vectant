"""
Ingestion sub-package for the RAG subsystem.

Handles the dual-ingestion pipeline (Step 1):
- Document loading from various formats
- ToC tree extraction
- Section splitting
- Summary generation
- Content hashing for dedup
"""

from .document_loader import DocumentLoader
from .toc_extractor import ToCExtractor
from .section_splitter import SectionSplitter
from .summary_generator import SummaryGenerator
from .document_processor import DocumentProcessor
from .content_hasher import ContentHasher

__all__ = [
    "DocumentLoader",
    "ToCExtractor",
    "SectionSplitter",
    "SummaryGenerator",
    "DocumentProcessor",
    "ContentHasher",
]
