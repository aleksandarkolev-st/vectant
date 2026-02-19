"""
Synthesis Package (Step 4)

Heavy model generates the final cited answer from precisely
extracted sections. Includes:
- Context assembly with token management
- Answer generation with citations
- Citation tracking for provenance
- Confidence scoring for answer quality
"""

from .context_builder import ContextBuilder
from .answer_synthesizer import AnswerSynthesizer
from .citation_tracker import CitationTracker
from .confidence_scorer import ConfidenceScorer

__all__ = [
    "ContextBuilder",
    "AnswerSynthesizer",
    "CitationTracker",
    "ConfidenceScorer",
]
