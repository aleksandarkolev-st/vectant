"""
RAG API — FastAPI endpoints for the RAG subsystem.

Provides REST endpoints for:
- Document ingestion
- Query execution  
- Pipeline management and stats
"""

from __future__ import annotations

import logging
from typing import Any, Dict, List, Optional

logger = logging.getLogger("code_intel.rag.api")

# Lazy import to avoid circular dependencies
_pipeline = None
_workspace_root = None


def set_rag_workspace(workspace_root: str) -> None:
    """Set the workspace root for the RAG pipeline singleton."""
    global _workspace_root, _pipeline
    _workspace_root = workspace_root
    _pipeline = None  # Reset pipeline to pick up new workspace


def _get_pipeline():
    """Get or create the RAG pipeline singleton."""
    global _pipeline
    if _pipeline is None:
        from .pipeline import RAGPipeline
        workspace = _workspace_root or "."
        _pipeline = RAGPipeline(workspace_root=workspace)
        _pipeline.initialize()
    return _pipeline


def register_rag_routes(router):
    """
    Register RAG endpoints on a FastAPI router.

    Args:
        router: FastAPI APIRouter instance.
    """

    @router.post("/rag/query")
    async def rag_query(payload: Dict[str, Any]) -> Dict[str, Any]:
        """
        Execute a RAG query.

        Body:
            {
                "query": "How does the auth system work?",
                "max_documents": 5,
                "max_sections": 10,
                "require_citations": true
            }
        """
        query_text = payload.get("query", "")
        if not query_text:
            return {"error": "Missing 'query' field"}

        kwargs = {}
        for key in ("max_documents", "max_sections", "max_tokens",
                     "require_citations", "document_ids", "tags"):
            if key in payload:
                kwargs[key] = payload[key]

        try:
            pipeline = _get_pipeline()
            result = pipeline.query(query_text, **kwargs)
            return result.to_dict()
        except Exception as e:
            logger.error(f"RAG query failed: {e}", exc_info=True)
            return {"error": str(e), "answer": ""}

    @router.post("/rag/ingest")
    async def rag_ingest(payload: Dict[str, Any]) -> Dict[str, Any]:
        """
        Trigger document ingestion.

        Body:
            {
                "directory": "/path/to/docs",  // optional
                "file": "/path/to/file.md"     // optional (single file)
            }
        """
        try:
            pipeline = _get_pipeline()

            if "file" in payload:
                result = pipeline.ingest_file(payload["file"])
                return result

            directory = payload.get("directory")
            stats = pipeline.ingest_directory(directory)
            return stats

        except Exception as e:
            logger.error(f"RAG ingestion failed: {e}", exc_info=True)
            return {"error": str(e)}

    @router.get("/rag/stats")
    async def rag_stats() -> Dict[str, Any]:
        """Get RAG pipeline statistics."""
        try:
            pipeline = _get_pipeline()
            return pipeline.get_stats()
        except Exception as e:
            return {"error": str(e)}

    @router.post("/rag/clear")
    async def rag_clear() -> Dict[str, Any]:
        """Clear all RAG data."""
        try:
            pipeline = _get_pipeline()
            pipeline.clear()
            return {"status": "cleared"}
        except Exception as e:
            return {"error": str(e)}

    @router.get("/rag/documents")
    async def rag_documents() -> Dict[str, Any]:
        """List all ingested documents."""
        try:
            pipeline = _get_pipeline()
            doc_ids = pipeline.document_store.list_ids()
            documents = []
            for doc_id in doc_ids[:100]:  # Limit response
                meta = pipeline.document_store.get_metadata(doc_id)
                if meta:
                    documents.append({
                        "id": doc_id,
                        "title": meta.title,
                        "file_path": meta.file_path,
                        "format": meta.format.value,
                        "section_count": meta.section_count,
                    })
            return {
                "total": len(doc_ids),
                "documents": documents,
            }
        except Exception as e:
            return {"error": str(e)}

    @router.get("/rag/health")
    async def rag_health() -> Dict[str, Any]:
        """Health check for RAG subsystem."""
        try:
            pipeline = _get_pipeline()
            stats = pipeline.get_stats()
            return {
                "status": "healthy",
                "documents": stats["documents"],
                "sections": stats["sections"],
            }
        except Exception as e:
            return {
                "status": "unhealthy",
                "error": str(e),
            }

    @router.get("/rag/diagnostics")
    async def rag_diagnostics() -> Dict[str, Any]:
        """
        Detailed diagnostics for the RAG subsystem.

        Surfaces internal state useful for debugging latency, rate-limiting,
        and cache effectiveness — not just the document counts that /stats
        exposes.
        """
        try:
            pipeline = _get_pipeline()
            stats = pipeline.get_stats()

            # Embedder caches (query-level + in-flight dedup).
            embedder = getattr(pipeline, "_embedder_instance", None)
            embedder_info: Dict[str, Any] = {"available": False}
            if embedder is not None:
                embedder_info = {
                    "available": True,
                    "model": getattr(embedder, "model", None),
                    "dimension": getattr(embedder, "_dimension", None),
                    "has_api_key": bool(
                        getattr(embedder, "has_api_key", lambda: False)()
                    ),
                    "query_cache_size": len(getattr(embedder, "_query_cache", {}) or {}),
                    "query_cache_capacity": getattr(embedder, "_cache_size", 0),
                    "in_flight": len(getattr(embedder, "_in_flight", {}) or {}),
                }

            cfg = pipeline.config
            return {
                "status": "ok",
                "stats": stats,
                "embedder": embedder_info,
                "config": {
                    "embedding_model": cfg.embedding_model,
                    "embedding_dimension": cfg.embedding_dimension,
                    "fusion_method": cfg.macro.fusion_method,
                    "rrf_k": cfg.macro.rrf_k,
                    "max_documents": cfg.macro.max_documents,
                    "routing_model": cfg.micro.routing_model,
                    "synthesis_model": cfg.synthesis.synthesis_model,
                    "max_sections_per_document": cfg.micro.max_sections_per_document,
                    "max_total_sections": cfg.micro.max_total_sections,
                    "routing_timeout_ms": cfg.micro.routing_timeout_ms,
                    "total_timeout_ms": cfg.micro.total_timeout_ms,
                    "query_cache_enabled": getattr(
                        getattr(cfg, "cache", None), "enable_query_cache", False
                    ),
                    "query_cache_ttl_seconds": getattr(
                        getattr(cfg, "cache", None), "ttl_seconds", 0
                    ),
                },
                "workspace_root": str(getattr(pipeline, "workspace_root", "")),
            }
        except Exception as e:
            logger.exception("RAG diagnostics failed")
            return {"status": "error", "error": str(e)}

    @router.post("/rag/cache/invalidate")
    async def rag_cache_invalidate() -> Dict[str, Any]:
        """Manually drop the query result cache (e.g. after content edits)."""
        try:
            pipeline = _get_pipeline()
            pipeline._invalidate_query_cache("api_request")
            return {"status": "invalidated"}
        except Exception as e:
            return {"status": "error", "error": str(e)}

    logger.info("RAG API routes registered")
