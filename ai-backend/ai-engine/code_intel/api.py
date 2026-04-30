"""
Code Intelligence FastAPI Routes.

Exposes the code intelligence system through REST endpoints.
"""

from __future__ import annotations

import logging
import os
from pathlib import Path
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, HTTPException, BackgroundTasks, Request
from pydantic import BaseModel, Field

from .engine import CodeIntelEngine, create_engine


logger = logging.getLogger("code_intel.api")


# ============================================================================
# Workspace Path Resolution
# ============================================================================

def resolve_workspace_path(workspace_path: str) -> str:
    """
    Resolve a workspace identifier to an actual filesystem path.
    
    The frontend typically passes a workspace slug (e.g., "cmgnslm7q0001u9bwhb4mdvfi"),
    or a slug/userId pair (e.g., "az3a08t9/113239851") for per-user repos.
    The code intel system needs the actual filesystem path where the repo is stored.
    
    Resolution order:
    1. If workspace_path is already an absolute path that exists, use it
    2. If it's a slug or slug/userId, resolve to {project_root}/backend/collab-server/repos/{path}
    3. If that doesn't exist, try relative to current working directory
    """
    # If it's already an absolute path that exists, use it directly (unless slug-only is enforced)
    require_slug = os.getenv("CODE_INTEL_REQUIRE_SLUG", "false").lower() == "true"
    if os.path.isabs(workspace_path) and os.path.exists(workspace_path):
        if require_slug:
            logger.warning("Absolute workspace paths are disabled by CODE_INTEL_REQUIRE_SLUG")
            return "__INVALID__"
        logger.debug(f"Using absolute path directly: {workspace_path}")
        return workspace_path
    
    # Check if it looks like a slug (alphanumeric, no path separators)
    # or a slug/userId pair (exactly one forward slash separating two segments)
    is_slug = (
        not os.path.sep in workspace_path and
        not "/" in workspace_path and
        not "\\" in workspace_path
    )
    
    # Also handle slug/userId format (e.g., "az3a08t9/113239851")
    parts = workspace_path.replace("\\", "/").split("/")
    is_slug_with_user = (
        len(parts) == 2 and
        all(p and not os.path.sep in p for p in parts)
    )
    
    if is_slug or is_slug_with_user:
        # Try to find the project root by looking for known markers
        # Start from the current file's location and work upward
        current_file = Path(__file__).resolve()
        project_root = current_file.parent
        
        # Walk up to find the project root (where backend/ folder exists)
        for _ in range(10):  # Safety limit
            potential_repos = project_root / "backend" / "collab-server" / "repos" / workspace_path.replace("/", os.sep)
            if potential_repos.exists():
                resolved = str(potential_repos)
                logger.info(f"Resolved workspace slug '{workspace_path}' to: {resolved}")
                return resolved
            
            parent = project_root.parent
            if parent == project_root:  # Reached filesystem root
                break
            project_root = parent
        
        # Also try from environment variable or known locations
        repos_base = os.environ.get("SYNTHI_REPOS_PATH")
        if repos_base:
            potential = os.path.join(repos_base, workspace_path.replace("/", os.sep))
            if os.path.exists(potential):
                logger.info(f"Resolved workspace from SYNTHI_REPOS_PATH: {potential}")
                return potential
    
    # If it looks like a relative path, resolve from cwd
    cwd_path = os.path.join(os.getcwd(), workspace_path)
    if os.path.exists(cwd_path):
        logger.info(f"Resolved workspace from cwd: {cwd_path}")
        return cwd_path
    
    # Last resort: return as-is and let downstream fail with a clear error
    logger.warning(f"Could not resolve workspace path: {workspace_path}")
    return workspace_path

router = APIRouter(prefix="/code-intel", tags=["code-intelligence"])

# Register RAG sub-routes on the same router
try:
    from .rag.api import register_rag_routes
    register_rag_routes(router)
except Exception as _rag_err:
    logger.warning(f"RAG routes not registered: {_rag_err}")


def _require_api_key(request: Request) -> None:
    required = os.getenv("CODE_INTEL_API_KEY")
    if not required:
        return
    provided = request.headers.get("x-code-intel-key") or request.headers.get("X-Code-Intel-Key")
    if not provided or provided != required:
        raise HTTPException(status_code=401, detail="Unauthorized")


# ============================================================================
# Request/Response Models
# ============================================================================

class IndexRequest(BaseModel):
    """Request to index workspace."""
    workspace_path: str = Field(..., description="Path to workspace")
    incremental: bool = Field(True, description="Incremental indexing")


class IndexResponse(BaseModel):
    """Response from indexing."""
    success: bool
    files_indexed: int
    chunks_indexed: int
    symbols_tracked: int
    duration_ms: float


class ContextRequest(BaseModel):
    """Request for context assembly."""
    workspace_path: str = Field(..., description="Path to workspace")
    query: str = Field(..., description="User query or intent")
    max_tokens: int = Field(8000, description="Maximum tokens for context")
    conversation_history: Optional[List[Dict[str, str]]] = Field(
        None, description="Previous conversation messages"
    )


class FastContextRequest(BaseModel):
    """Request for fast retrieval-only context (inline completion path)."""
    workspace_path: str = Field(..., description="Path to workspace")
    query: str = Field("", description="Free-text query — usually the last few lines of cursor context")
    symbols: Optional[List[str]] = Field(None, description="Identifiers extracted from the cursor neighborhood")
    language: Optional[str] = Field(None, description="Filter chunks to this language")
    max_chunks: int = Field(5, description="Hard cap on returned chunks")
    max_chars_per_chunk: int = Field(320, description="Truncate each chunk's snippet to this many chars")
    # Hybrid retrieval knob: how long the server may wait for an inline query
    # embedding before falling back to lexical-only. 0 disables inline embedding
    # entirely (cache-only). Default 120 ms is enough for a warm regional embed
    # call without blowing the 200–350 ms client-side budget.
    embed_timeout_ms: int = Field(120, description="Hard timeout for inline query embedding; 0 disables")


class FastContextChunk(BaseModel):
    """A single retrieved chunk in the fast-context response."""
    file: str
    snippet: str
    start_line: int
    end_line: int
    symbol: str = ""
    score: float = 0.0


class FastContextResponse(BaseModel):
    """Response from fast-context retrieval."""
    chunks: List[FastContextChunk]
    elapsed_ms: float


class EditImpactRequest(BaseModel):
    """Request for cross-file impact prediction given an APPLIED edit (NEP Phase 2).

    The endpoint walks the symbol-dependency graph (caller→callee, importer→
    imported, sibling members) BFS depth 2 from seed symbols extracted from the
    edit, then ranks the resulting file/symbol pairs as likely follow-up edit
    sites.

    Concrete spec (the original NEP plan flagged "edit-impact graph edges are
    underspecified"):
      - depth-1 expansions: incoming/outgoing CALLS edges, IMPORTS edges,
        INHERITS edges, sibling symbols (same file_path AND same parent symbol)
      - depth-2: re-expand each depth-1 hit by the SAME edge set
      - ranking: edge-weighted (CALLS=3, IMPORTS=2, INHERITS=2, sibling=1),
        plus a co-change boost from ChangeImpactModel when git history exists
      - cap: max_candidates results, default 12
    """
    workspace_path: str = Field(..., description="Path to workspace")
    file_path: str = Field(..., description="Relative path of the file the edit was applied to")
    search: str = Field(..., description="The SEARCH text of the applied edit")
    replace: str = Field("", description="The REPLACE text of the applied edit")
    edit_kind: Optional[str] = Field(
        None,
        description="Optional client-side classifier hint: rename | signature_change | import_change | type_change | local_logic",
    )
    seed_symbols: Optional[List[str]] = Field(
        None,
        description="Optional explicit seed identifiers; if absent, the server extracts them from the SEARCH/REPLACE text",
    )
    max_candidates: int = Field(12, description="Hard cap on returned candidates")
    max_depth: int = Field(2, description="BFS depth, 1 or 2; rename/signature default to 2, local_logic to 1")


class EditImpactCandidate(BaseModel):
    """A predicted follow-up edit site."""
    file: str
    symbol: str = ""
    score: float = 0.0
    reasons: List[str] = Field(default_factory=list, description="Edge types that produced this candidate, ranked")
    distance: int = Field(1, description="BFS depth at which this candidate was reached")


class EditImpactResponse(BaseModel):
    """Ranked list of likely follow-up edit sites."""
    candidates: List[EditImpactCandidate]
    seeds_used: List[str]
    edit_kind_inferred: Optional[str] = None
    elapsed_ms: float


class ContextResponse(BaseModel):
    """Response with assembled context."""
    context: str = Field(..., description="Assembled context for LLM")
    chunks_used: int = Field(..., description="Number of chunks in context")
    tokens_used: int = Field(..., description="Estimated tokens used")
    sources: List[Dict[str, Any]] = Field(..., description="Source chunks")
    # Deterministic controller output
    sufficiency: str = Field("UNKNOWN", description="Context sufficiency: SUFFICIENT, PARTIAL, INSUFFICIENT, EMPTY, UNKNOWN")
    refusal: Optional[str] = Field(None, description="Refusal reason if context is insufficient")
    trace: Optional[List[Dict[str, Any]]] = Field(None, description="Selection trace for observability")
    grounding_spans: Optional[List[Dict[str, Any]]] = Field(None, description="Grounding spans for verifier")
    clarifying_question: Optional[str] = Field(None, description="Clarifying question when uncertainty is high")
    pipeline: str = Field("legacy", description="Retrieval pipeline used: 'rag' or 'legacy'")


class ToolCallRequest(BaseModel):
    """Request to execute a tool."""
    workspace_path: str = Field(..., description="Path to workspace")
    tool_name: str = Field(..., description="Name of tool to execute")
    arguments: Dict[str, Any] = Field(..., description="Tool arguments")


class ToolCallResponse(BaseModel):
    """Response from tool execution."""
    success: bool
    result: Dict[str, Any]


class ToolDefinitionsRequest(BaseModel):
    """Request for tool definitions."""
    workspace_path: str = Field(..., description="Path to workspace")
    format: str = Field("openai", description="Output format: openai or anthropic")


class ToolDefinitionsResponse(BaseModel):
    """Response with tool definitions."""
    tools: List[Dict[str, Any]]


class SummaryRequest(BaseModel):
    """Request for summaries."""
    workspace_path: str = Field(..., description="Path to workspace")
    file_path: Optional[str] = Field(None, description="Specific file path")


class SummaryResponse(BaseModel):
    """Response with summary."""
    summary: str
    token_count: int


class MetricsRequest(BaseModel):
    """Request for metrics."""
    workspace_path: str = Field(..., description="Path to workspace")
    include_all: bool = Field(False, description="Include all comprehensive metrics")


class LatencyMetrics(BaseModel):
    """Latency percentiles."""
    p50: float = 0.0
    p95: float = 0.0
    p99: float = 0.0


class ThroughputMetrics(BaseModel):
    """Throughput metrics."""
    tokens_per_second: LatencyMetrics = Field(default_factory=LatencyMetrics)
    requests_per_second: float = 0.0
    peak_rps: float = 0.0


class ModelMetrics(BaseModel):
    """Model/inference metrics."""
    inference_time: LatencyMetrics = Field(default_factory=LatencyMetrics)
    by_model: Dict[str, LatencyMetrics] = Field(default_factory=dict)


class RetrievalQualityMetrics(BaseModel):
    """Retrieval quality metrics."""
    recall_at_1: Optional[Dict[str, float]] = None
    recall_at_5: Optional[Dict[str, float]] = None
    recall_at_10: Optional[Dict[str, float]] = None
    mrr: Optional[Dict[str, float]] = None


class ReliabilityMetrics(BaseModel):
    """Reliability metrics."""
    total_requests: int = 0
    errors: int = 0
    error_rate: float = 0.0
    timeout_rate: float = 0.0
    timeouts: int = 0
    cold_starts: int = 0
    cold_start_latency: LatencyMetrics = Field(default_factory=LatencyMetrics)
    error_types: Dict[str, int] = Field(default_factory=dict)


class LoadMetrics(BaseModel):
    """Load behavior metrics."""
    latency_vs_concurrency: Dict[str, LatencyMetrics] = Field(default_factory=dict)
    current_concurrency: int = 0
    peak_concurrency: int = 0
    p95_at_peak: float = 0.0


class PromptOutputDistribution(BaseModel):
    """Prompt and output size distribution."""
    prompt_size: Dict[str, float] = Field(default_factory=dict)
    output_size: Dict[str, float] = Field(default_factory=dict)


class MetricsResponse(BaseModel):
    """Comprehensive metrics response."""
    # Original fields (backward compatible)
    latency: Dict[str, Dict[str, float]]
    counters: Dict[str, int]
    budgets: Dict[str, int]
    index_generation: Optional[str] = None
    
    # NEW: Enhanced latency metrics
    ttft: Optional[LatencyMetrics] = None  # Time to first token
    completion_latency: Optional[LatencyMetrics] = None  # Full completion time
    queue_delay: Optional[LatencyMetrics] = None  # Queue/scheduling delay
    
    # NEW: Throughput metrics
    throughput: Optional[ThroughputMetrics] = None
    
    # NEW: Model/inference metrics
    model: Optional[ModelMetrics] = None
    
    # NEW: Retrieval quality metrics
    retrieval_quality: Optional[RetrievalQualityMetrics] = None
    
    # NEW: Reliability metrics
    reliability: Optional[ReliabilityMetrics] = None
    
    # NEW: Load behavior metrics
    load: Optional[LoadMetrics] = None
    
    # NEW: Prompt/output distribution
    prompt_output_distribution: Optional[PromptOutputDistribution] = None


class EditPlanRequest(BaseModel):
    """Request to create an edit plan."""
    workspace_path: str = Field(..., description="Path to workspace")
    edits: List[Dict[str, Any]] = Field(..., description="List of edits")


class EditPlanResponse(BaseModel):
    """Response from edit execution."""
    success: bool
    files_modified: int
    edits_applied: int
    error: Optional[str] = None


# ============================================================================
# Engine Cache
# ============================================================================

# Cache engines by resolved workspace path
_engines: Dict[str, CodeIntelEngine] = {}


def get_engine(workspace_path: str) -> CodeIntelEngine:
    """Get or create engine for workspace, resolving the path first."""
    resolved_path = resolve_workspace_path(workspace_path)
    if resolved_path == "__INVALID__":
        raise HTTPException(status_code=403, detail="Absolute workspace paths are not allowed")
    
    if resolved_path not in _engines:
        logger.info(f"Creating new engine for: {resolved_path}")
        _engines[resolved_path] = create_engine(resolved_path)
    return _engines[resolved_path]


# ============================================================================
# Routes
# ============================================================================

@router.post("/index", response_model=IndexResponse)
async def index_workspace(request: IndexRequest, http_request: Request) -> IndexResponse:
    """
    Index a workspace.
    
    Parses all code files and builds vector + structural indices.
    """
    try:
        _require_api_key(http_request)
        engine = get_engine(request.workspace_path)
        stats = await engine.index_workspace(incremental=request.incremental)
        
        return IndexResponse(
            success=True,
            files_indexed=stats.files_indexed,
            chunks_indexed=stats.chunks_indexed,
            symbols_tracked=stats.symbols_tracked,
            duration_ms=stats.last_index_time_ms,
        )
    except Exception as e:
        logger.exception("Index failed")
        raise HTTPException(status_code=500, detail=str(e))


class IndexFileRequest(BaseModel):
    """Request to index a single file."""
    workspace_path: str = Field(..., description="Path to workspace")
    file_path: str = Field(..., description="Relative path to file within workspace")


class IndexFileResponse(BaseModel):
    """Response from single file indexing."""
    success: bool
    chunks_indexed: int


@router.post("/index/file", response_model=IndexFileResponse)
async def index_file(request: IndexFileRequest, http_request: Request) -> IndexFileResponse:
    """
    Index a single file.
    
    Used for incremental updates after file edits.
    """
    try:
        _require_api_key(http_request)
        engine = get_engine(request.workspace_path)
        chunks_indexed = await engine.index_file(request.file_path)
        
        return IndexFileResponse(
            success=True,
            chunks_indexed=chunks_indexed,
        )
    except Exception as e:
        logger.exception("File index failed")
        raise HTTPException(status_code=500, detail=str(e))


# ── Delete / Rename endpoints ───────────────────────────────────────────────

class DeleteFileRequest(BaseModel):
    """Request to remove a file from all indexes."""
    workspace_path: str = Field(..., description="Path to workspace")
    file_path: str = Field(..., description="Relative path to the deleted file")


class DeleteFileResponse(BaseModel):
    """Response from file deletion cleanup."""
    success: bool
    detail: dict = {}


@router.post("/index/file/delete", response_model=DeleteFileResponse)
async def delete_file(request: DeleteFileRequest, http_request: Request) -> DeleteFileResponse:
    """
    Purge a deleted file from all indexes and stores.

    Called by the frontend after a file is removed from the workspace.
    """
    try:
        _require_api_key(http_request)
        engine = get_engine(request.workspace_path)
        detail = await engine.delete_file(request.file_path)
        return DeleteFileResponse(success=True, detail=detail)
    except Exception as e:
        logger.exception("File delete cleanup failed")
        raise HTTPException(status_code=500, detail=str(e))


class RenameFileRequest(BaseModel):
    """Request to rename a file across all indexes."""
    workspace_path: str = Field(..., description="Path to workspace")
    old_path: str = Field(..., description="Previous relative file path")
    new_path: str = Field(..., description="New relative file path")


class RenameFileResponse(BaseModel):
    """Response from file rename."""
    success: bool
    chunks_indexed: int = 0
    detail: dict = {}


@router.post("/index/file/rename", response_model=RenameFileResponse)
async def rename_file(request: RenameFileRequest, http_request: Request) -> RenameFileResponse:
    """
    Update all indexes after a file rename.

    Atomically removes old-path data and re-indexes the new path.
    """
    try:
        _require_api_key(http_request)
        engine = get_engine(request.workspace_path)
        detail = await engine.rename_file(request.old_path, request.new_path)
        return RenameFileResponse(
            success=True,
            chunks_indexed=detail.get("chunks_indexed", 0),
            detail=detail,
        )
    except Exception as e:
        logger.exception("File rename cleanup failed")
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/context", response_model=ContextResponse)
async def get_context(request: ContextRequest, http_request: Request) -> ContextResponse:
    """
    Get context for a query.
    
    Assembles relevant code context for the given query within token budget.
    Uses the RAG pipeline (Macro-Retrieval + Micro-Navigation) when available,
    falling back to the legacy retrieval pipeline otherwise.
    Returns sufficiency indicator so LLM knows if context is complete.
    """
    try:
        _require_api_key(http_request)
        engine = get_engine(request.workspace_path)
        
        result = await engine.get_context(
            query=request.query,
            max_tokens=request.max_tokens,
            conversation_history=request.conversation_history,
        )
        
        # Extract sufficiency from result if available
        sufficiency = getattr(result, 'sufficiency', 'UNKNOWN')
        if hasattr(sufficiency, 'value'):
            sufficiency = sufficiency.value
        elif hasattr(sufficiency, 'name'):
            sufficiency = sufficiency.name
        else:
            sufficiency = str(sufficiency) if sufficiency else 'UNKNOWN'
        
        # Extract refusal reason if present - convert RefusalReason object to string
        refusal = getattr(result, 'refusal_reason', None)
        if refusal:
            if hasattr(refusal, 'message'):
                refusal = refusal.message
            elif hasattr(refusal, 'value'):
                refusal = refusal.value
            elif hasattr(refusal, 'name'):
                refusal = refusal.name
            else:
                refusal = str(refusal)
        
        trace = result.trace if result.trace else None
        pipeline_type = (result.debug or {}).get("pipeline", "legacy")

        if os.getenv("CODE_INTEL_DEBUG") and result.debug:
            if trace is None:
                trace = []
            trace.append({"debug": result.debug})

        # Build sources: from grounding_spans (RAG) or chunks (legacy)
        sources = []
        if result.grounding_spans:
            # RAG pipeline: sources come from grounding_spans
            for gs in result.grounding_spans:
                sources.append({
                    "file": gs.get("file", ""),
                    "start_line": gs.get("start_line", 0),
                    "end_line": gs.get("end_line", 0),
                    "symbol": gs.get("symbol", ""),
                    "score": gs.get("score", 0.0),
                })
        elif result.chunks:
            # Legacy pipeline: sources come from chunks
            score_by_chunk_id: Dict[str, float] = {}
            if trace:
                for item in trace:
                    if item.get("reason") != "included":
                        continue
                    chunk_id = item.get("chunk_id")
                    if not chunk_id:
                        continue
                    score = item.get("score")
                    if score is None:
                        continue
                    prev = score_by_chunk_id.get(chunk_id)
                    if prev is None or score > prev:
                        score_by_chunk_id[chunk_id] = score

            sources = [
                {
                    "file": c.metadata.file_path,
                    "start_line": c.metadata.start_line,
                    "end_line": c.metadata.end_line,
                    "symbol": c.metadata.symbol_name,
                    "score": score_by_chunk_id.get(c.id, 0.0),
                }
                for c in result.chunks
            ]

        chunks_used = len(result.chunks) if result.chunks else len(sources)

        logger.info(
            f"[Context] pipeline={pipeline_type} | query={request.query[:60]!r} | "
            f"sources={len(sources)} | tokens={result.total_tokens} | {sufficiency}"
        )

        return ContextResponse(
            context=result.assembled_context,
            chunks_used=chunks_used,
            tokens_used=result.total_tokens,
            sufficiency=sufficiency,
            refusal=refusal,
            sources=sources,
            trace=trace,
            grounding_spans=result.grounding_spans if result.grounding_spans else None,
            clarifying_question=result.clarifying_question,
            pipeline=pipeline_type,
        )
    except Exception as e:
        logger.exception("Context retrieval failed")
        raise HTTPException(status_code=500, detail=str(e))


async def _maybe_embed_query_for_fast_path(pipeline: Any, query: str, timeout_ms: int) -> Optional[List[float]]:
    """Resolve a query embedding for the fast retrieval path.

    Returns a vector when one is available within the time budget; ``None``
    otherwise. ``None`` is the "lexical-only" signal — `_fast_retrieve` accepts
    it and will skip the dense pass.

    Order of operations:
      1. Cache hit on the embedder's query cache (zero network).
      2. Inline `embed_query` call wrapped in `asyncio.wait_for(timeout)`.
      3. On timeout/error, give up. The background thread keeps running and
         the embedder's cache fills for the next call.
    """
    if not query or not query.strip():
        return None
    embedder = getattr(pipeline, "embedder", None)
    if embedder is None:
        return None
    # 1) Cache lookup (covers warm queries / fingerprint hits).
    try:
        if hasattr(embedder, "get_cached_query_embedding"):
            cached = embedder.get_cached_query_embedding(query)
            if cached is not None:
                return cached
    except Exception:
        pass
    # 2) Bounded inline embed.
    if timeout_ms <= 0 or not hasattr(embedder, "embed_query"):
        return None
    try:
        import asyncio
        return await asyncio.wait_for(
            asyncio.to_thread(embedder.embed_query, query),
            timeout=max(0.001, timeout_ms / 1000.0),
        )
    except Exception:
        # asyncio.TimeoutError, network errors, missing API key — all fall
        # through to lexical-only without surfacing to the user.
        return None


@router.post("/context/fast", response_model=FastContextResponse)
async def get_context_fast(request: FastContextRequest, http_request: Request) -> FastContextResponse:
    """
    Fast retrieval-only context for inline completions.

    Hits the retrieval pipeline's hybrid fast path — BM25 + symbol search,
    plus a dense pass when a query embedding is available within
    ``embed_timeout_ms``. No LLM. The full /context endpoint goes through
    macro + micro-navigation which is LLM-driven and benchmarks at ~8.5 s;
    this path targets ~50–250 ms so it can sit on the critical path for
    keystroke-driven completions.

    Returns a small set of relevant code chunks; the caller (typically the
    Next.js /api/completion route) injects them into the FIM prompt as
    targeted reference snippets.
    """
    import time
    t0 = time.time()
    try:
        _require_api_key(http_request)
        engine = get_engine(request.workspace_path)

        # Make sure the pipeline is initialized; if the workspace was never
        # indexed we just return an empty result rather than failing — the
        # caller treats absence of refs as a normal case.
        try:
            engine._initialize_components()
        except Exception:
            pass

        pipeline = getattr(engine, "_retrieval_pipeline", None)
        if pipeline is None:
            return FastContextResponse(chunks=[], elapsed_ms=(time.time() - t0) * 1000)

        # Hybrid step: try to obtain a query embedding so `_fast_retrieve` can
        # take its dense+lexical+symbol path instead of falling back to pure
        # lexical. Order: cache hit → bounded inline embed → give up.
        # The inline embed is run in a worker thread with a hard timeout —
        # if it doesn't return in time we fall through to lexical-only, but
        # the embedding call keeps running in the background and warms the
        # query cache for the next keystroke.
        cached_emb = await _maybe_embed_query_for_fast_path(
            pipeline=pipeline,
            query=request.query or "",
            timeout_ms=int(request.embed_timeout_ms or 0),
        )

        try:
            candidates, _stats = pipeline._fast_retrieve(
                cached_embedding=cached_emb,
                query_text=request.query or "",
                query_symbols=list(request.symbols or []),
                query_files=[],
                filter_language=request.language,
                include_tests=False,
                folder_scope=None,
                module_scope=None,
                index_kind=None,
            )
        except Exception as fast_err:
            logger.warning(f"Fast retrieve failed, returning empty: {fast_err}")
            return FastContextResponse(chunks=[], elapsed_ms=(time.time() - t0) * 1000)

        # Convert candidates → response chunks. SemanticChunk's body is held
        # in `_code_body` (exposed via `code_body` property) — typically loaded
        # at index time. If not loaded we skip the chunk: lazy disk reads on
        # the keystroke path would defeat the latency budget.
        chunks: List[FastContextChunk] = []
        max_chars = max(80, int(request.max_chars_per_chunk or 320))
        for cand in candidates[: max(1, int(request.max_chunks or 5))]:
            sc = getattr(cand, "chunk", None)
            if sc is None:
                continue
            body = getattr(sc, "code_body", "") or getattr(sc, "_code_body", "") or ""
            if not body:
                continue
            snippet = body if len(body) <= max_chars else body[:max_chars] + "\n…"
            chunks.append(FastContextChunk(
                file=sc.metadata.file_path or "",
                snippet=snippet,
                start_line=int(sc.metadata.start_line or 0),
                end_line=int(sc.metadata.end_line or 0),
                symbol=str(sc.metadata.symbol_name or ""),
                score=float(getattr(cand, "combined_score", 0.0) or getattr(cand, "keyword_score", 0.0) or 0.0),
            ))

        return FastContextResponse(chunks=chunks, elapsed_ms=(time.time() - t0) * 1000)
    except HTTPException:
        raise
    except Exception as e:
        logger.exception("Fast context retrieval failed")
        # Don't fail the inline-completion request on a backend hiccup —
        # the caller treats an empty payload as "no extra context available".
        return FastContextResponse(chunks=[], elapsed_ms=(time.time() - t0) * 1000)


# ============================================================================
# Edit-Impact (NEP Phase 2)
# ============================================================================

# Edge weights for ranking. CALLS dominates because a renamed/resignatured
# function pulls call sites first; IMPORTS and INHERITS are near-tie because
# they signal coupling at module/type granularity; sibling is the weakest
# because two symbols sharing a parent doesn't strongly predict co-edit.
_IMPACT_EDGE_WEIGHTS = {
    "calls": 3.0,
    "imports": 2.0,
    "inherits": 2.0,
    "sibling": 1.0,
    "co_change": 1.5,
}

_IMPACT_KEYWORDS = {
    # Common JS/TS/Python/C++ keywords. Intentionally non-exhaustive — the
    # goal is to drop top-frequency noise from BFS seeds, not be precise.
    "if", "else", "for", "while", "do", "switch", "case", "break",
    "continue", "return", "function", "def", "class", "struct", "enum",
    "interface", "type", "const", "let", "var", "int", "float", "double",
    "char", "bool", "void", "true", "false", "null", "None", "True",
    "False", "this", "self", "new", "delete", "import", "from", "as",
    "in", "of", "is", "not", "and", "or", "yield", "await", "async",
    "throw", "try", "catch", "finally", "with", "use", "using",
    "public", "private", "protected", "static", "final", "abstract",
    "override", "virtual", "extends", "implements", "namespace", "include",
}


def _impact_extract_seed_symbols(text: str) -> List[str]:
    """Pull candidate identifiers from a SEARCH/REPLACE block."""
    import re as _re
    if not text:
        return []
    out: List[str] = []
    seen = set()
    for m in _re.finditer(r"[A-Za-z_][A-Za-z0-9_]*", text):
        ident = m.group(0)
        if len(ident) < 3:
            continue
        if ident in _IMPACT_KEYWORDS:
            continue
        if ident in seen:
            continue
        seen.add(ident)
        out.append(ident)
    return out


def _impact_kind_to_depth(kind: Optional[str], default_depth: int) -> int:
    """rename + signature_change want depth 2 (chase the change); local_logic
    wants depth 1 (don't propagate edits the user didn't ask to propagate).
    """
    if not kind:
        return default_depth
    k = (kind or "").strip().lower()
    if k in ("rename", "signature_change"):
        return 2
    if k == "local_logic":
        return 1
    return default_depth


def _impact_walk(
    structural_index,
    seeds: List[str],
    max_depth: int,
) -> Dict[tuple, Dict[str, Any]]:
    """BFS depth-`max_depth` over the symbol graph.

    Returns a dict keyed by `(file, symbol)` of `{score, reasons, distance}`.
    Same symbol reached via two edges accumulates score on a single node — the
    ranking signal we want is "how strongly does this site couple to the
    seed?", and an edge-count tally is the cheap proxy.
    """
    if not structural_index:
        return {}
    symbol_graph = getattr(structural_index, "symbol_graph", None)
    if not symbol_graph:
        return {}

    nodes_attr = getattr(symbol_graph, "nodes", {})
    valid_seeds = [s for s in seeds if s in nodes_attr]

    out: Dict[tuple, Dict[str, Any]] = {}

    def add(file_path: Optional[str], symbol: str, edge_kind: str, distance: int) -> None:
        key = (file_path or "", symbol)
        weight = _IMPACT_EDGE_WEIGHTS.get(edge_kind, 1.0)
        # Distance damping: depth-2 edges are weaker than depth-1.
        damped = weight / (1.0 + 0.6 * (distance - 1))
        rec = out.get(key)
        if rec is None:
            out[key] = {"score": damped, "reasons": [edge_kind], "distance": distance}
        else:
            rec["score"] += damped
            if edge_kind not in rec["reasons"]:
                rec["reasons"].append(edge_kind)
            rec["distance"] = min(rec["distance"], distance)

    def siblings_of(symbol: str) -> List[tuple]:
        """Same file_path AND same parent symbol — the plan called this out as
        under-specified; this is the concrete rule.
        """
        n = nodes_attr.get(symbol)
        if n is None:
            return []
        file_path = getattr(n, "file_path", None)
        parent = getattr(n, "parent", None)
        sibs = []
        for other_name, other_node in nodes_attr.items():
            if other_name == symbol:
                continue
            if getattr(other_node, "file_path", None) != file_path:
                continue
            if getattr(other_node, "parent", None) != parent:
                continue
            sibs.append((other_name, file_path))
        return sibs

    frontier = list(valid_seeds)
    seen = set(frontier)
    for distance in range(1, max_depth + 1):
        next_frontier: List[str] = []
        for sym in frontier:
            # Outgoing edges (callees, imported modules, inherited bases).
            try:
                for edge in symbol_graph.get_edges_from(sym):
                    target = getattr(edge, "target", None)
                    if not target:
                        continue
                    target_node = nodes_attr.get(target)
                    target_file = getattr(target_node, "file_path", None) if target_node else None
                    et = getattr(edge, "edge_type", None)
                    et_val = getattr(et, "value", str(et) if et else "")
                    if et_val == "calls":
                        add(target_file, target, "calls", distance)
                    elif et_val == "imports":
                        add(target_file, target, "imports", distance)
                    elif et_val == "inherits":
                        add(target_file, target, "inherits", distance)
                    if target not in seen:
                        seen.add(target)
                        next_frontier.append(target)
            except Exception:
                pass
            # Incoming edges (callers, importers, subclasses) — dominant
            # signal for rename intent.
            try:
                for edge in symbol_graph.get_edges_to(sym):
                    source = getattr(edge, "source", None)
                    if not source:
                        continue
                    source_node = nodes_attr.get(source)
                    source_file = getattr(source_node, "file_path", None) if source_node else None
                    et = getattr(edge, "edge_type", None)
                    et_val = getattr(et, "value", str(et) if et else "")
                    if et_val == "calls":
                        add(source_file, source, "calls", distance)
                    elif et_val == "imports":
                        add(source_file, source, "imports", distance)
                    elif et_val == "inherits":
                        add(source_file, source, "inherits", distance)
                    if source not in seen:
                        seen.add(source)
                        next_frontier.append(source)
            except Exception:
                pass
            # Sibling members.
            for sib_name, sib_file in siblings_of(sym):
                add(sib_file, sib_name, "sibling", distance)
                if sib_name not in seen:
                    seen.add(sib_name)
                    next_frontier.append(sib_name)
        frontier = next_frontier
        if not frontier:
            break

    return out


@router.post("/edit-impact", response_model=EditImpactResponse)
async def edit_impact(request: EditImpactRequest, http_request: Request) -> EditImpactResponse:
    """Predict likely follow-up edit sites for an applied edit.

    Phase 2 NEP: when the user accepts a SEARCH→REPLACE block, the editor
    pings this endpoint with the applied edit and merges the candidates into
    the next NEP request's prompt context, so the model can pre-stage cross-
    file blocks.
    """
    import time as _time
    _require_api_key(http_request)
    t0 = _time.time()
    try:
        engine = get_engine(request.workspace_path)
    except HTTPException:
        raise
    except Exception:
        # Engine/index may not be ready (cold cache); return empty rather than
        # fail — the editor treats this as "no impact data, proceed without".
        return EditImpactResponse(
            candidates=[], seeds_used=[], edit_kind_inferred=None,
            elapsed_ms=(_time.time() - t0) * 1000,
        )

    structural_index = getattr(engine, "_structural_index", None)

    # Seed extraction. Prefer explicit seeds; otherwise pull identifiers from
    # both SEARCH and REPLACE — including REPLACE catches new identifiers the
    # user just introduced (their not-yet-existing call sites in OTHER files
    # don't matter, but their new module imports do).
    explicit = list(request.seed_symbols or [])
    seeds = explicit or (
        _impact_extract_seed_symbols(request.search)
        + _impact_extract_seed_symbols(request.replace)
    )
    seen_seeds = set()
    seeds = [s for s in seeds if not (s in seen_seeds or seen_seeds.add(s))]

    depth = _impact_kind_to_depth(request.edit_kind, default_depth=request.max_depth)
    walked = _impact_walk(structural_index, seeds, max_depth=depth)

    # Co-change boost. ChangeImpactModel is a separate, file-level signal
    # ("these files are commonly edited together"). Useful fallback when the
    # symbol graph is sparse, and a useful tie-breaker even when it isn't.
    try:
        from .routing.change_impact import ChangeImpactModel
        cim = ChangeImpactModel(workspace_root=getattr(engine, "_workspace_root", request.workspace_path))
        cim.build()
        co_neighbors = cim.get_neighbors([request.file_path]) or []
        for i, neighbor_file in enumerate(co_neighbors[:8]):
            damped = _IMPACT_EDGE_WEIGHTS["co_change"] / (1.0 + 0.4 * i)
            key = (neighbor_file, "")
            rec = walked.get(key)
            if rec is None:
                walked[key] = {"score": damped, "reasons": ["co_change"], "distance": 1}
            else:
                rec["score"] += damped
                if "co_change" not in rec["reasons"]:
                    rec["reasons"].append("co_change")
    except Exception:
        # ChangeImpactModel is best-effort; never fail the request on it.
        pass

    # Drop the originating file — the editor already has it open and the
    # impact endpoint is for OTHER follow-up sites. Edits that loop back to
    # the same file ride the recent-edits ring buffer, not the impact graph.
    walked = {
        (file_path, symbol): rec
        for (file_path, symbol), rec in walked.items()
        if file_path != request.file_path
    }

    ranked = sorted(walked.items(), key=lambda kv: kv[1]["score"], reverse=True)
    ranked = ranked[: max(1, request.max_candidates)]

    candidates = [
        EditImpactCandidate(
            file=fp,
            symbol=sym,
            score=round(rec["score"], 3),
            reasons=rec["reasons"],
            distance=rec["distance"],
        )
        for (fp, sym), rec in ranked
    ]

    return EditImpactResponse(
        candidates=candidates,
        seeds_used=seeds,
        edit_kind_inferred=request.edit_kind,
        elapsed_ms=(_time.time() - t0) * 1000,
    )


@router.post("/tools/definitions", response_model=ToolDefinitionsResponse)
async def get_tool_definitions(request: ToolDefinitionsRequest, http_request: Request) -> ToolDefinitionsResponse:
    """
    Get tool definitions for LLM.
    
    Returns tool schemas in OpenAI or Anthropic format.
    """
    try:
        _require_api_key(http_request)
        engine = get_engine(request.workspace_path)
        tools = engine.get_tool_definitions(format=request.format)
        
        return ToolDefinitionsResponse(tools=tools)
    except Exception as e:
        logger.exception("Tool definitions failed")
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/tools/execute", response_model=ToolCallResponse)
async def execute_tool(request: ToolCallRequest, http_request: Request) -> ToolCallResponse:
    """
    Execute an exploration tool.
    
    Runs a tool like find_usages, get_definition, etc.
    """
    try:
        _require_api_key(http_request)
        engine = get_engine(request.workspace_path)
        
        result = await engine.execute_tool(
            tool_name=request.tool_name,
            arguments=request.arguments,
        )
        
        return ToolCallResponse(
            success=True,
            result=result,
        )
    except Exception as e:
        logger.exception("Tool execution failed")
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/summary/repo", response_model=SummaryResponse)
async def get_repo_summary(request: SummaryRequest, http_request: Request) -> SummaryResponse:
    """
    Get repository summary.
    
    Returns a high-level summary of the entire repository.
    """
    try:
        _require_api_key(http_request)
        engine = get_engine(request.workspace_path)
        summary = engine.get_repo_summary()
        
        if not summary:
            raise HTTPException(status_code=404, detail="No summary available")
        
        return SummaryResponse(
            summary=summary.content,
            token_count=summary.token_count,
        )
    except HTTPException:
        raise
    except Exception as e:
        logger.exception("Summary retrieval failed")
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/summary/file", response_model=SummaryResponse)
async def get_file_summary(request: SummaryRequest, http_request: Request) -> SummaryResponse:
    """
    Get file summary.
    
    Returns a summary of a specific file.
    """
    try:
        if not request.file_path:
            raise HTTPException(status_code=400, detail="file_path required")
        
        _require_api_key(http_request)
        engine = get_engine(request.workspace_path)
        summary = engine.get_file_summary(request.file_path)
        
        if not summary:
            raise HTTPException(status_code=404, detail="No summary available")
        
        return SummaryResponse(
            summary=summary.content,
            token_count=summary.token_count,
        )
    except HTTPException:
        raise
    except Exception as e:
        logger.exception("File summary retrieval failed")
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/metrics", response_model=MetricsResponse)
async def get_metrics(request: MetricsRequest, http_request: Request) -> MetricsResponse:
    """Get retrieval latency and budget metrics.
    
    Set include_all=True to get comprehensive metrics including:
    - TTFT (Time to First Token) P50/P95/P99
    - Full completion latency P50/P95
    - Queue/scheduling delay P50/P95
    - Tokens per second P50/P95
    - Requests per second at saturation
    - Inference time P50/P95
    - Prompt/output size distribution
    - Retrieval latency P50/P95/P99
    - Recall@k / MRR (quality metrics)
    - Error rate, timeout rate
    - Cold start latency
    - Latency vs concurrency curve
    - P95 under peak load
    """
    try:
        _require_api_key(http_request)
        engine = get_engine(request.workspace_path)
        metrics = engine.get_retrieval_metrics(include_all=request.include_all)
        
        # Build basic response
        response = MetricsResponse(
            latency=metrics.get("latency", {}),
            counters=metrics.get("counters", {}),
            budgets=metrics.get("budgets", {}),
            index_generation=metrics.get("index_generation"),
        )
        
        # Add comprehensive metrics if requested
        if request.include_all:
            all_metrics = metrics.get("all", {})
            
            # Helper to safely get percentile dict with defaults
            def get_latency(data: dict, *keys) -> dict:
                result = data
                for key in keys:
                    result = result.get(key, {}) if isinstance(result, dict) else {}
                return {"p50": result.get("p50", 0.0), "p95": result.get("p95", 0.0), "p99": result.get("p99", 0.0)}
            
            # Latency metrics - always populate
            latency_data = all_metrics.get("latency", {})
            response.ttft = LatencyMetrics(**get_latency(latency_data, "ttft"))
            response.completion_latency = LatencyMetrics(**get_latency(latency_data, "completion"))
            response.queue_delay = LatencyMetrics(**get_latency(latency_data, "queue_delay"))
            
            # Throughput - always populate
            t = all_metrics.get("throughput", {})
            response.throughput = ThroughputMetrics(
                tokens_per_second=LatencyMetrics(**get_latency(t, "tokens_per_second")),
                requests_per_second=t.get("requests_per_second", 0.0),
                peak_rps=t.get("peak_rps", 0.0),
            )
            
            # Model metrics - always populate
            m = all_metrics.get("model", {})
            by_model = {}
            for model_name, vals in m.get("by_model", {}).items():
                by_model[model_name] = LatencyMetrics(**get_latency({"v": vals}, "v"))
            response.model = ModelMetrics(
                inference_time=LatencyMetrics(**get_latency(m, "inference_time")),
                by_model=by_model,
            )
            
            # Retrieval quality - always populate
            q = all_metrics.get("retrieval", {}).get("quality", {})
            response.retrieval_quality = RetrievalQualityMetrics(
                recall_at_1=q.get("recall_at_1"),
                recall_at_5=q.get("recall_at_5"),
                recall_at_10=q.get("recall_at_10"),
                mrr=q.get("mrr"),
            )
            
            # Reliability - always populate
            r = all_metrics.get("reliability", {})
            response.reliability = ReliabilityMetrics(
                total_requests=r.get("total_requests", 0),
                errors=r.get("errors", 0),
                error_rate=r.get("error_rate", 0.0),
                timeout_rate=r.get("timeout_rate", 0.0),
                timeouts=r.get("timeouts", 0),
                cold_starts=r.get("cold_starts", 0),
                cold_start_latency=LatencyMetrics(**get_latency(r, "cold_start_latency")),
                error_types=r.get("error_types", {}),
            )
            
            # Load behavior - always populate
            l = all_metrics.get("load", {})
            latency_by_concurrency = {}
            for conc, vals in l.get("latency_vs_concurrency", {}).items():
                latency_by_concurrency[conc] = LatencyMetrics(**get_latency({"v": vals}, "v"))
            response.load = LoadMetrics(
                latency_vs_concurrency=latency_by_concurrency,
                current_concurrency=l.get("current_concurrency", 0),
                peak_concurrency=l.get("peak_concurrency", 0),
                p95_at_peak=l.get("p95_at_peak", 0.0),
            )
            
            # Prompt/output distribution - always populate
            pod = all_metrics.get("prompt_output_distribution", {})
            response.prompt_output_distribution = PromptOutputDistribution(
                prompt_size=pod.get("prompt_size", {}),
                output_size=pod.get("output_size", {}),
            )
        
        return response
    except Exception as e:
        logger.exception("Metrics retrieval failed")
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/edit", response_model=EditPlanResponse)
async def execute_edits(request: EditPlanRequest, http_request: Request) -> EditPlanResponse:
    """
    Execute code edits.
    
    Applies a set of edits with validation and rollback support.
    """
    try:
        _require_api_key(http_request)
        engine = get_engine(request.workspace_path)
        
        # Create session
        session = engine.create_edit_session()
        plan = session.create_plan()
        
        # Add edits
        for edit in request.edits:
            edit_type = edit.get("type", "replace")
            
            if edit_type == "insert":
                plan.add_insert(
                    file_path=edit["file_path"],
                    line=edit["line"],
                    content=edit["content"],
                )
            elif edit_type == "replace":
                plan.add_replace(
                    file_path=edit["file_path"],
                    start_line=edit["start_line"],
                    end_line=edit["end_line"],
                    old_content=edit.get("old_content", ""),
                    new_content=edit["new_content"],
                )
            elif edit_type == "delete":
                plan.add_delete(
                    file_path=edit["file_path"],
                    start_line=edit["start_line"],
                    end_line=edit["end_line"],
                )
            elif edit_type == "create_file":
                plan.add_create_file(
                    file_path=edit["file_path"],
                    content=edit["content"],
                )
        
        # Execute
        result = session.execute()
        
        return EditPlanResponse(
            success=result.success,
            files_modified=result.files_modified,
            edits_applied=result.edits_applied,
            error=result.error,
        )
    except Exception as e:
        logger.exception("Edit execution failed")
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/save")
async def save_state(request: SummaryRequest, http_request: Request) -> Dict[str, bool]:
    """Save engine state to disk."""
    try:
        _require_api_key(http_request)
        engine = get_engine(request.workspace_path)
        await engine.save()
        return {"success": True}
    except Exception as e:
        logger.exception("Save failed")
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/load")
async def load_state(request: SummaryRequest, http_request: Request) -> Dict[str, bool]:
    """Load engine state from disk."""
    try:
        _require_api_key(http_request)
        engine = get_engine(request.workspace_path)
        loaded = await engine.load()
        return {"success": loaded}
    except Exception as e:
        logger.exception("Load failed")
        raise HTTPException(status_code=500, detail=str(e))
