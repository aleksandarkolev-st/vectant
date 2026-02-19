"""
Custom exception hierarchy for the RAG subsystem.

All exceptions inherit from RAGError for unified error handling.
Each subsystem has its own exception class for precise error routing.
"""

from __future__ import annotations

from typing import Any, Dict, Optional


class RAGError(Exception):
    """Base exception for all RAG subsystem errors."""

    def __init__(
        self,
        message: str,
        details: Optional[Dict[str, Any]] = None,
        cause: Optional[Exception] = None,
    ):
        super().__init__(message)
        self.details = details or {}
        self.cause = cause

    def to_dict(self) -> Dict[str, Any]:
        result: Dict[str, Any] = {
            "error": self.__class__.__name__,
            "message": str(self),
        }
        if self.details:
            result["details"] = self.details
        if self.cause:
            result["cause"] = str(self.cause)
        return result


class IngestionError(RAGError):
    """Error during document ingestion (Step 1)."""
    pass


class DocumentParseError(IngestionError):
    """Error parsing a document's content or structure."""
    pass


class ToCExtractionError(IngestionError):
    """Error extracting Table of Contents from a document."""
    pass


class SummaryGenerationError(IngestionError):
    """Error generating document summary."""
    pass


class StoreError(RAGError):
    """Error in the persistence layer."""
    pass


class DocumentNotFoundError(StoreError):
    """Requested document does not exist in the store."""
    pass


class SectionNotFoundError(StoreError):
    """Requested section does not exist in the store."""
    pass


class IndexCorruptionError(StoreError):
    """Vector or keyword index is corrupted."""
    pass


class MacroRetrievalError(RAGError):
    """Error during macro-retrieval (Step 2)."""
    pass


class NavigationError(RAGError):
    """Error during micro-navigation (Step 3)."""
    pass


class TreeNavigationError(NavigationError):
    """Error navigating the ToC tree."""
    pass


class RoutingModelError(NavigationError):
    """Error calling the fast routing model."""
    pass


class SynthesisError(RAGError):
    """Error during heavy synthesis (Step 4)."""
    pass


class SynthesisModelError(SynthesisError):
    """Error calling the heavy synthesis model."""
    pass


class CitationError(SynthesisError):
    """Error generating or validating citations."""
    pass


class BudgetExceededError(RAGError):
    """Token budget exceeded during pipeline execution."""

    def __init__(
        self,
        message: str,
        budget_tokens: int = 0,
        used_tokens: int = 0,
        **kwargs: Any,
    ):
        super().__init__(message, **kwargs)
        self.budget_tokens = budget_tokens
        self.used_tokens = used_tokens


class ConfigurationError(RAGError):
    """Invalid RAG configuration."""
    pass
