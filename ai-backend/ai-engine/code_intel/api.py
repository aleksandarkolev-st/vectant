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
    but the code intel system needs the actual filesystem path where the repo is stored.
    
    Resolution order:
    1. If workspace_path is already an absolute path that exists, use it
    2. If it's a slug, resolve to {project_root}/backend/collab-server/repos/{slug}
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
    is_slug = (
        not os.path.sep in workspace_path and
        not "/" in workspace_path and
        not "\\" in workspace_path
    )
    
    if is_slug:
        # Try to find the project root by looking for known markers
        # Start from the current file's location and work upward
        current_file = Path(__file__).resolve()
        project_root = current_file.parent
        
        # Walk up to find the project root (where backend/ folder exists)
        for _ in range(10):  # Safety limit
            potential_repos = project_root / "backend" / "collab-server" / "repos" / workspace_path
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
            potential = os.path.join(repos_base, workspace_path)
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


class MetricsResponse(BaseModel):
    """Response for metrics."""
    latency: Dict[str, Dict[str, float]]
    counters: Dict[str, int]
    budgets: Dict[str, int]
    index_generation: Optional[str] = None


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


@router.post("/context", response_model=ContextResponse)
async def get_context(request: ContextRequest, http_request: Request) -> ContextResponse:
    """
    Get context for a query.
    
    Assembles relevant code context for the given query within token budget.
    Uses deterministic retrieval controller to decide what context to include.
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
        
        # Extract refusal reason if present
        refusal = getattr(result, 'refusal_reason', None)
        if refusal and hasattr(refusal, 'value'):
            refusal = refusal.value
        elif refusal and hasattr(refusal, 'name'):
            refusal = refusal.name
        
        trace = result.trace if result.trace else None
        if os.getenv("CODE_INTEL_DEBUG") and result.debug:
            if trace is None:
                trace = []
            trace.append({"debug": result.debug})

        return ContextResponse(
            context=result.assembled_context,
            chunks_used=len(result.chunks),
            tokens_used=result.total_tokens,
            sufficiency=sufficiency,
            refusal=refusal,
            sources=[
                {
                    "file": c.metadata.file_path,
                    "start_line": c.metadata.start_line,
                    "end_line": c.metadata.end_line,
                    "symbol": c.metadata.symbol_name,
                    "score": c.metadata.relevance_score,
                }
                for c in result.chunks
            ],
            trace=trace,
        )
    except Exception as e:
        logger.exception("Context retrieval failed")
        raise HTTPException(status_code=500, detail=str(e))


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
    """Get retrieval latency and budget metrics."""
    try:
        _require_api_key(http_request)
        engine = get_engine(request.workspace_path)
        metrics = engine.get_retrieval_metrics()
        return MetricsResponse(
            latency=metrics.get("latency", {}),
            counters=metrics.get("counters", {}),
            budgets=metrics.get("budgets", {}),
            index_generation=metrics.get("index_generation"),
        )
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
