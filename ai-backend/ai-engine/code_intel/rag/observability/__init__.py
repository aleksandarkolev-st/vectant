"""
Observability subsystem for the RAG pipeline.

Replaces ad-hoc `logger.info` strings with structured spans that nest by
pipeline step and are exported either:
  - to OpenTelemetry collectors when `opentelemetry` is importable, or
  - to a structured log line + the RAGResult.trace field as a fallback.

Public surface:
    from code_intel.rag.observability import Tracer, NULL_TRACER, span
"""

from .tracing import Tracer, Span, NULL_TRACER

__all__ = ["Tracer", "Span", "NULL_TRACER"]
