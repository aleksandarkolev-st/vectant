# PROTOTYPING AI ENGINE WITH PYTHON, LATER SWITCH TO RUST
from __future__ import annotations

from typing import List, Optional
import requests
import json
import sys
import os
import asyncio
import logging

# Configure logging for detailed debugging
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s [%(levelname)s] %(name)s: %(message)s',
    handlers=[
        logging.StreamHandler(sys.stdout)
    ]
)
logger = logging.getLogger('ai-engine')
logger.setLevel(logging.INFO)

# Also set up logging for proactive analyzer modules
for module in ['analyzer.proactive', 'analyzer.proactive.semantic_analyzer', 'analyzer.proactive.orchestrator']:
    logging.getLogger(module).setLevel(logging.INFO)
import time

from fastapi import FastAPI, HTTPException, BackgroundTasks
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from analyzer import get_analyzer
from analyzer import supported_languages

from llm.providers import get_provider
from llm.prompts import SPLIT_GUI_PROMPT
from llm.structural_prompts import (
    format_delta_addition_prompt,
    format_delta_deletion_prompt,
    inject_delta_into_code,
    apply_deletion_delta,
)

# New imports for enhanced architecture
from job_queue import (
    PriorityJobQueue, JobType, JobPriority, JobBudget, 
    JobWorker, get_queue
)
from verifier import AIOutputVerifier, get_verifier, VerificationStatus
from streaming import (
    StreamingManager, get_streaming_manager, 
    OpenAIStreamer, GeminiStreamer, StreamingStatus
)
from provenance import (
    ProvenanceTracker, get_provenance_tracker,
    ChangeType, VerificationStatus as ProvVerificationStatus, track_ai_call
)
# Proactive Analysis imports
from analyzer.proactive import (
    ProactiveAnalyzer,
    AnalysisResult,
    AnalysisTier,
    # Workspace analysis
    WorkspaceAnalyzer,
    get_workspace_analyzer,
    WorkspaceAnalysisRequest,
    WorkspaceAnalysisResult,
    FileChange,
)
from analyzer.proactive.types import AnalysisRequest, FileContext, Severity
from analyzer.proactive.cache import AnalysisCache

# Intelligence Aggregator - Unified Pipeline
from intelligence import (
    IntelligenceAggregator,
    AggregatedResult,
    get_aggregator,
    create_aggregator_with_ai,
    DiagnosticSource,
    UnifiedDiagnostic,
    StaticAnalysisProvider,
    AIAnalysisProvider,
    CompilerProvider,
    get_compiler_provider,
    FileWatcher,
    get_file_watcher,
    FileChangeEvent,
    FileChangeType,
)

app = FastAPI()

# Initialize proactive analyzer with shared cache
_analysis_cache = AnalysisCache(max_entries=2000, max_age_seconds=3600)
_proactive_analyzer_no_ai: Optional[ProactiveAnalyzer] = None


def get_proactive_analyzer(llm_provider=None) -> ProactiveAnalyzer:
    """
    Get or create the proactive analyzer.
    
    If llm_provider is supplied, always creates a fresh analyzer with AI enabled.
    If llm_provider is None, returns a cached analyzer with AI disabled (fast path).
    """
    global _proactive_analyzer_no_ai
    
    if llm_provider is not None:
        # AI tier requested - create fresh analyzer with provider
        return ProactiveAnalyzer(
            cache=_analysis_cache,
            llm_provider=llm_provider,
            enable_ai=True,
            ai_min_confidence=0.6,
        )
    
    # No AI - use cached analyzer for speed
    if _proactive_analyzer_no_ai is None:
        _proactive_analyzer_no_ai = ProactiveAnalyzer(
            cache=_analysis_cache,
            llm_provider=None,
            enable_ai=False,
            ai_min_confidence=0.6,
        )
    return _proactive_analyzer_no_ai


class FileModel(BaseModel):
    path: Optional[str] = None
    name: Optional[str] = None
    content: str


class AnalyzeRequest(BaseModel):
    code: str
    lang: str
    files: Optional[List[FileModel]] = None
    focus: Optional[str] = None


class AnalyzeAiRequest(BaseModel):
    code: str
    lang: str
    prompt: str = None
    mode: str = None
    files: Optional[List[FileModel]] = None
    focus: Optional[str] = None
    model: Optional[str] = None
    api_key: Optional[str] = None


class ProactiveAnalysisRequest(BaseModel):
    """Request for proactive code analysis."""
    code: str
    lang: str
    file_path: Optional[str] = "untitled"
    related_files: Optional[List[FileModel]] = None
    tiers: Optional[List[str]] = None  # "static", "semantic", "ai"
    include_ai: Optional[bool] = True
    max_diagnostics: Optional[int] = 50
    model: Optional[str] = None
    api_key: Optional[str] = None


class ContainerAnalysisRequest(BaseModel):
    """
    Container-First analysis request.
    Content is fetched from the server filesystem, NOT sent by client.
    This ensures analysis always sees the same content as the compiler.
    """
    slug: str  # Workspace slug
    file_path: str  # File path within workspace
    lang: str
    related_paths: Optional[List[str]] = None  # Paths to related files
    tiers: Optional[List[str]] = None
    include_ai: Optional[bool] = True
    max_diagnostics: Optional[int] = 50
    model: Optional[str] = None
    api_key: Optional[str] = None


# Collab server URL for fetching file content
COLLAB_SERVER_URL = os.environ.get('COLLAB_SERVER_URL', 'http://localhost:1234')


async def fetch_file_from_container(slug: str, file_path: str) -> Optional[str]:
    """
    Fetch file content from the collab server (container filesystem).
    This is the Source of Truth for all analysis.
    
    The collab server auto-flushes Y.js changes to disk (150ms debounce),
    so this always returns the latest content.
    """
    import aiohttp
    
    try:
        # Use the /file-content endpoint which reads directly from disk
        url = f"{COLLAB_SERVER_URL}/file-content/{slug}/{file_path}"
        logger.info(f"[Container] Fetching from: {url}")
        
        async with aiohttp.ClientSession() as session:
            async with session.get(url) as resp:
                if resp.status == 200:
                    content = await resp.text()
                    logger.info(f"[Container] Fetched {file_path}: {len(content)} chars")
                    logger.info(f"[Container] Content preview: {content[:200]}...")
                    return content
                elif resp.status == 404:
                    logger.warning(f"[Container] File not found: {slug}/{file_path}")
                    return None
                else:
                    error_body = await resp.text()
                    logger.warning(f"[Container] Failed to fetch {file_path}: {resp.status} - {error_body}")
                    return None
    except Exception as e:
        logger.error(f"[Container] Error fetching {file_path}: {e}")
        return None


@app.post("/analyze/static")
def analyze_code(req: AnalyzeRequest):
    try:
        analyzer = get_analyzer(req.lang)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))

    canonical_lang = analyzer.identifier()
    static_results = analyzer.analyze(req.code)

    return {
        "static_analysis": static_results,
        "lang": canonical_lang,
    }


@app.post("/analyze/proactive")
async def analyze_proactive(req: ProactiveAnalysisRequest):
    """
    Proactive code analysis endpoint.
    
    Runs multi-tier analysis (static, semantic, AI) to detect
    potential errors before compilation.
    
    Returns diagnostics from all tiers with severity, location,
    and suggested fixes.
    """
    def select_provider():
        if req.api_key:
            model_name = (req.model or '').lower()
            if 'gemini' in model_name:
                return get_provider(provider_name='gemini', use_custom=True)
            return get_provider(provider_name='chatgpt', use_custom=True)
        return get_provider()
    
    # Determine which tiers to run
    tiers = []
    if req.tiers:
        tier_map = {
            'static': AnalysisTier.STATIC,
            'semantic': AnalysisTier.SEMANTIC,
            'ai': AnalysisTier.AI,
        }
        tiers = [tier_map[t.lower()] for t in req.tiers if t.lower() in tier_map]
    else:
        # Default: run all tiers
        tiers = [AnalysisTier.STATIC, AnalysisTier.SEMANTIC]
        if req.include_ai:
            tiers.append(AnalysisTier.AI)
    
    # Build file context
    file_context = FileContext(
        path=req.file_path or "untitled",
        content=req.code,
        language=req.lang,
    )
    
    logger.info(f"=== PROACTIVE ANALYSIS START ===")
    logger.info(f"File: {file_context.path}")
    logger.info(f"Language: {file_context.language}")
    logger.info(f"Content length: {len(file_context.content)} chars")
    logger.info(f"Content preview: {file_context.content[:200]}...")
    logger.info(f"Tiers requested: {tiers}")
    
    # Build related files context
    related_files = []
    if req.related_files:
        logger.info(f"Related files count from request: {len(req.related_files)}")
        for rf in req.related_files:
            rf_path = rf.path or rf.name or f"file-{len(related_files)}"
            logger.info(f"  Related file: {rf_path} ({len(rf.content)} chars)")
            logger.info(f"    Content preview: {rf.content[:100]}...")
            related_files.append(FileContext(
                path=rf_path,
                content=rf.content,
                language=req.lang,
            ))
    else:
        logger.info("No related files in request")
    
    # Create analysis request
    analysis_request = AnalysisRequest(
        file=file_context,
        related_files=related_files,
        tiers=tiers,
        max_diagnostics=req.max_diagnostics or 50,
        include_fixes=True,
    )
    
    # Get analyzer with provider for AI tier
    provider = select_provider() if AnalysisTier.AI in tiers else None
    analyzer = get_proactive_analyzer(llm_provider=provider)
    
    try:
        result = await analyzer.analyze(analysis_request)
        logger.info(f"=== PROACTIVE ANALYSIS RESULT ===")
        logger.info(f"Total diagnostics: {len(result.all_diagnostics)}")
        for d in result.all_diagnostics:
            logger.info(f"  [{d.tier.value}] {d.severity.value}: {d.message} @ line {d.location.line}")
        logger.info(f"=== PROACTIVE ANALYSIS END ===")
        return result.to_dict()
    except Exception as e:
        logger.error(f"Analysis failed: {str(e)}", exc_info=True)
        raise HTTPException(status_code=500, detail=f"Analysis failed: {str(e)}")


@app.post("/analyze/proactive/quick")
async def analyze_proactive_quick(req: ProactiveAnalysisRequest):
    """
    Quick proactive analysis (static + semantic only).
    
    Optimized for real-time feedback during typing.
    Typically completes in < 200ms.
    """
    file_context = FileContext(
        path=req.file_path or "untitled",
        content=req.code,
        language=req.lang,
    )
    
    analyzer = get_proactive_analyzer()
    
    try:
        result = await analyzer.analyze_quick(file_context)
        return result.to_dict()
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Quick analysis failed: {str(e)}")


@app.get("/analyze/proactive/cache/stats")
async def get_cache_stats():
    """Get proactive analysis cache statistics."""
    analyzer = get_proactive_analyzer()
    return await analyzer.get_cache_stats()


@app.post("/analyze/proactive/cache/clear")
async def clear_cache():
    """Clear the proactive analysis cache."""
    analyzer = get_proactive_analyzer()
    await analyzer.clear_cache()
    return {"status": "ok", "message": "Cache cleared"}


@app.post("/analyze/container")
async def analyze_from_container(req: ContainerAnalysisRequest):
    """
    Container-First proactive analysis endpoint.
    
    This endpoint fetches file content directly from the server filesystem
    (via collab server), ensuring the AI analyzes exactly what the compiler sees.
    
    This is the RECOMMENDED endpoint for production use.
    The client should NOT send content - only file paths.
    """
    logger.info(f"=== CONTAINER ANALYSIS START ===")
    logger.info(f"Slug: {req.slug}")
    logger.info(f"File: {req.file_path}")
    logger.info(f"Language: {req.lang}")
    
    # Fetch main file content from container
    content = await fetch_file_from_container(req.slug, req.file_path)
    if content is None:
        raise HTTPException(status_code=404, detail=f"File not found: {req.file_path}")
    
    logger.info(f"Fetched main file: {len(content)} chars")
    logger.info(f"Content preview: {content[:200]}...")
    
    # Build file context
    file_context = FileContext(
        path=req.file_path,
        content=content,
        language=req.lang,
    )
    
    # Fetch related files from container
    related_files = []
    if req.related_paths:
        logger.info(f"Fetching {len(req.related_paths)} related files from container...")
        for rpath in req.related_paths:
            rcontent = await fetch_file_from_container(req.slug, rpath)
            if rcontent is not None:
                related_files.append(FileContext(
                    path=rpath,
                    content=rcontent,
                    language=req.lang,
                ))
                logger.info(f"  Fetched {rpath}: {len(rcontent)} chars")
            else:
                logger.warning(f"  Could not fetch {rpath}")
    
    # Determine tiers
    tiers = []
    if req.tiers:
        tier_map = {
            'static': AnalysisTier.STATIC,
            'semantic': AnalysisTier.SEMANTIC,
            'ai': AnalysisTier.AI,
        }
        tiers = [tier_map[t.lower()] for t in req.tiers if t.lower() in tier_map]
    else:
        tiers = [AnalysisTier.STATIC, AnalysisTier.SEMANTIC]
        if req.include_ai:
            tiers.append(AnalysisTier.AI)
    
    # Create analysis request
    analysis_request = AnalysisRequest(
        file=file_context,
        related_files=related_files,
        tiers=tiers,
        max_diagnostics=req.max_diagnostics or 50,
        include_fixes=True,
    )
    
    # Get analyzer with provider for AI tier
    def select_provider():
        if req.api_key:
            model_name = (req.model or '').lower()
            if 'gemini' in model_name:
                return get_provider(provider_name='gemini', use_custom=True)
            return get_provider(provider_name='chatgpt', use_custom=True)
        return get_provider()
    
    provider = select_provider() if AnalysisTier.AI in tiers else None
    analyzer = get_proactive_analyzer(llm_provider=provider)
    
    try:
        result = await analyzer.analyze(analysis_request)
        logger.info(f"=== CONTAINER ANALYSIS RESULT ===")
        logger.info(f"Total diagnostics: {len(result.all_diagnostics)}")
        for d in result.all_diagnostics:
            logger.info(f"  [{d.tier.value}] {d.severity.value}: {d.message} @ line {d.location.line}")
        logger.info(f"=== CONTAINER ANALYSIS END ===")
        return result.to_dict()
    except Exception as e:
        logger.error(f"Container analysis failed: {str(e)}", exc_info=True)
        raise HTTPException(status_code=500, detail=f"Analysis failed: {str(e)}")


# ============================================================================
# Unified Intelligence Pipeline
# ============================================================================

class UnifiedAnalysisRequest(BaseModel):
    """
    Request for unified intelligence analysis.
    
    This is the recommended endpoint that combines:
    - Layer A: Static/LSP analysis (< 200ms)
    - Layer B: Compiler semantic analysis (500ms-1s)
    - Layer C: AI analysis (on-demand, triggered by Layer B errors)
    
    Content is fetched from container filesystem - NOT sent by client.
    """
    slug: str  # Workspace slug
    file_path: str  # File path within workspace
    lang: str
    # Version for stale detection - client increments on each keystroke
    version: int  # Client-side version counter (MANDATORY)
    # Layer control
    layers: Optional[List[str]] = None  # ["static", "compiler", "ai"]
    # AI configuration
    trigger_ai_on_errors: Optional[bool] = True  # Auto-trigger AI if compiler finds errors
    include_ai: Optional[bool] = False  # Force include AI layer
    # Limits
    max_diagnostics: Optional[int] = 50
    # API config
    model: Optional[str] = None
    api_key: Optional[str] = None


class UnifiedAnalysisResponse(BaseModel):
    """Unified response combining all diagnostic sources."""
    file_path: str
    diagnostics: List[dict]
    summary: dict  # error/warning/info counts per source
    analysis_time_ms: float
    layers_run: List[str]


# Aggregator instance (created on first use)
_aggregator_instance: Optional[IntelligenceAggregator] = None


def get_intelligence_aggregator() -> IntelligenceAggregator:
    """Get or create the Intelligence Aggregator singleton."""
    global _aggregator_instance
    if _aggregator_instance is None:
        logger.info("[Intelligence] Creating aggregator with providers...")
        # Create with default providers and AI
        _aggregator_instance = create_aggregator_with_ai(
            llm_provider=get_provider()
        )
        logger.info("[Intelligence] Aggregator initialized with Static + AI providers")
    return _aggregator_instance


@app.post("/analyze/unified")
async def analyze_unified(req: UnifiedAnalysisRequest):
    """
    Unified Intelligence Pipeline endpoint.
    
    This is the RECOMMENDED endpoint for all code analysis.
    It uses the ProactiveAnalyzer which includes:
    - Static analysis (syntax patterns)
    - Semantic analysis (CppSemanticAnalyzer, etc.)
    - Optional AI analysis (auto-triggered on errors if trigger_ai_on_errors=True)
    
    Content is fetched from container filesystem - client sends only paths.
    
    Version field enables stale detection: if response.version != current version,
    the client should discard the diagnostics.
    """
    import time
    import hashlib
    start_time = time.time()
    
    logger.info(f"=== UNIFIED ANALYSIS START ===")
    logger.info(f"Slug: {req.slug}")
    logger.info(f"File: {req.file_path}")
    logger.info(f"Language: {req.lang}")
    logger.info(f"Version: {req.version}")
    logger.info(f"Layers: {req.layers or ['static', 'semantic']}")
    logger.info(f"Auto-trigger AI on errors: {req.trigger_ai_on_errors}")
    
    # Fetch content from container
    content = await fetch_file_from_container(req.slug, req.file_path)
    if content is None:
        raise HTTPException(status_code=404, detail=f"File not found: {req.file_path}")
    
    logger.info(f"Fetched: {len(content)} chars")
    
    # DEBUG: Log content preview to verify correct content is being analyzed
    content_preview = content[:300].replace('\n', '\\n')
    logger.info(f"Content preview: {content_preview}...")
    
    # Compute content hash for client-side caching
    content_hash = hashlib.sha256(content.encode()).hexdigest()[:16]
    logger.info(f"Content hash: {content_hash}")
    
    # Determine which tiers to run (map layers to proactive tiers)
    layers = list(req.layers or ["static", "semantic"])
    initial_tiers = []
    if "static" in layers:
        initial_tiers.append(AnalysisTier.STATIC)
    if "semantic" in layers or "compiler" in layers:
        initial_tiers.append(AnalysisTier.SEMANTIC)
    if "ai" in layers or req.include_ai:
        initial_tiers.append(AnalysisTier.AI)
    
    # Default to static + semantic if nothing specified
    if not initial_tiers:
        initial_tiers = [AnalysisTier.STATIC, AnalysisTier.SEMANTIC]
    
    tiers = initial_tiers.copy()
    
    # Build file context for ProactiveAnalyzer
    file_context = FileContext(
        path=req.file_path,
        content=content,
        language=req.lang,
    )
    
    # Create analysis request
    analysis_request = AnalysisRequest(
        file=file_context,
        related_files=[],
        tiers=tiers,
        max_diagnostics=req.max_diagnostics or 50,
        include_fixes=True,
    )
    
    # Get proactive analyzer with optional AI
    def select_provider():
        if req.api_key:
            model_name = (req.model or '').lower()
            if 'gemini' in model_name:
                return get_provider(provider_name='gemini', use_custom=True)
            return get_provider(provider_name='chatgpt', use_custom=True)
        return get_provider()
    
    # First pass: Run static + semantic analysis
    provider = select_provider() if AnalysisTier.AI in tiers else None
    analyzer = get_proactive_analyzer(llm_provider=provider)
    
    try:
        # Run the actual analysis using ProactiveAnalyzer
        result = await analyzer.analyze(analysis_request)
        
        # AUTO-TRIGGER AI: If trigger_ai_on_errors is True and we found errors, run AI analysis
        ai_triggered = False
        should_run_ai = False
        
        if req.trigger_ai_on_errors and AnalysisTier.AI not in initial_tiers:
            # Count errors from static + semantic analysis
            error_count = sum(
                1 for d in result.all_diagnostics 
                if d.severity == Severity.ERROR or (hasattr(d.severity, 'value') and d.severity.value == 'error')
            )
            warning_count = sum(
                1 for d in result.all_diagnostics 
                if d.severity == Severity.WARNING or (hasattr(d.severity, 'value') and d.severity.value == 'warning')
            )
            info_count = sum(
                1 for d in result.all_diagnostics
                if d.severity == Severity.INFO or (hasattr(d.severity, 'value') and d.severity.value == 'info')
            )
            
            logger.info(f"[AUTO-AI] Static/Semantic analysis found: {error_count} errors, {warning_count} warnings, {info_count} infos")
            
            # Trigger AI if:
            # 1. Any errors found, OR
            # 2. Multiple warnings, OR  
            # 3. Any diagnostics at all (be proactive)
            if error_count > 0 or warning_count >= 1 or (info_count > 0 and req.lang in ['cpp', 'c++', 'c']):
                should_run_ai = True
                logger.info(f"[AUTO-AI] Triggering AI analysis due to {error_count} errors, {warning_count} warnings, {info_count} infos")
        
        if should_run_ai:
            try:
                
                # Run AI analysis
                ai_provider = select_provider()
                ai_analyzer = get_proactive_analyzer(llm_provider=ai_provider)
                
                ai_request = AnalysisRequest(
                    file=file_context,
                    related_files=[],
                    tiers=[AnalysisTier.AI],
                    max_diagnostics=req.max_diagnostics or 50,
                    include_fixes=True,
                )
                
                logger.info(f"[AUTO-AI] Running AI analysis on {file_context.path}...")
                ai_result = await ai_analyzer.analyze(ai_request)
                
                # Merge AI diagnostics into result
                if ai_result.tiers.get(AnalysisTier.AI):
                    result.tiers[AnalysisTier.AI] = ai_result.tiers[AnalysisTier.AI]
                    tiers.append(AnalysisTier.AI)
                    ai_triggered = True
                    ai_diag_count = len(ai_result.tiers[AnalysisTier.AI].diagnostics)
                    logger.info(f"[AUTO-AI] Added {ai_diag_count} AI diagnostics")
            except Exception as ai_err:
                logger.error(f"[AUTO-AI] AI analysis failed: {ai_err}", exc_info=True)
        
        elapsed_ms = (time.time() - start_time) * 1000
        
        # Build summary from result
        summary = {
            "static": {"errors": 0, "warnings": 0, "info": 0},
            "semantic": {"errors": 0, "warnings": 0, "info": 0},
            "ai": {"errors": 0, "warnings": 0, "info": 0},
        }
        
        # Collect diagnostics from result
        diagnostics_list = []
        for diag in result.all_diagnostics:
            # Map tier to layer name
            tier_name = diag.tier.value.lower() if hasattr(diag.tier, 'value') else str(diag.tier).lower()
            
            # Map severity
            sev = diag.severity.value.lower() if hasattr(diag.severity, 'value') else str(diag.severity).lower()
            if sev == 'information':
                sev = 'info'
            
            # Update summary
            if tier_name in summary and sev in summary[tier_name]:
                summary[tier_name][sev] += 1
            
            # Build diagnostic dict
            # Generate a deterministic ID if missing
            diag_id = getattr(diag, "id", None)
            if not diag_id:
                # Create a hash of the diagnostic content for deduplication
                content_str = f"{req.file_path}:{diag.location.line}:{diag.message}:{tier_name}"
                diag_id = hashlib.md5(content_str.encode()).hexdigest()[:12]

            # Get the actual code at this location for verification
            source_lines = content.splitlines()
            line_idx = diag.location.line
            code_at_line = source_lines[line_idx].strip() if 0 <= line_idx < len(source_lines) else ""
            
            diag_dict = {
                "id": diag_id,
                "source": tier_name.capitalize(),
                "severity": diag.severity.value if hasattr(diag.severity, 'value') else str(diag.severity),
                "message": diag.message,
                "file": req.file_path,
                "range": {
                    "start": diag.location.line,
                    "startColumn": diag.location.column,
                    "end": diag.location.end_line if diag.location.end_line is not None else diag.location.line,
                    "endColumn": diag.location.end_column if diag.location.end_column is not None else diag.location.column + 1,
                },
                "tier": tier_name,
                "codeAtLine": code_at_line,  # Actual code at this line for debugging
            }
            
            if diag.code:
                diag_dict["code"] = diag.code
            if diag.category:
                diag_dict["category"] = diag.category
            if diag.explanation:
                diag_dict["explanation"] = diag.explanation
            if diag.fixes:
                diag_dict["fixes"] = [
                    {"description": f.description, "replacement": f.replacement_text}
                    for f in diag.fixes
                ]
            
            diagnostics_list.append(diag_dict)
        
        # Deduplicate diagnostics
        # Strategy: Keep unique (line, message, severity). If duplicates exist, prefer SEMANTIC over STATIC.
        unique_diags = {}
        for d in diagnostics_list:
            # Create a signature key
            key = f"{d['range']['start']}:{d['message']}:{d['severity']}"
            
            if key not in unique_diags:
                unique_diags[key] = d
            else:
                # If we already have this diagnostic, check if the new one is from a "better" tier
                existing = unique_diags[key]
                if existing['tier'] == 'static' and d['tier'] == 'semantic':
                    unique_diags[key] = d
        
        diagnostics_list = list(unique_diags.values())
        
        # Determine which layers actually ran
        layers_run = []
        for tier in tiers:
            tier_name = tier.value.lower() if hasattr(tier, 'value') else str(tier).lower()
            if tier_name not in layers_run:
                layers_run.append(tier_name)
        
        logger.info(f"=== UNIFIED ANALYSIS RESULT ===")
        logger.info(f"Total diagnostics: {len(diagnostics_list)}")
        
        # DEBUG: Print every error and the code line it refers to
        source_lines = content.splitlines()
        for i, d in enumerate(diagnostics_list):
            line_idx = d['range']['start']
            # Handle 0-based vs 1-based indexing (diagnostics are usually 0-based internally but might be 1-based in output)
            # Assuming 0-based for array access
            code_line = source_lines[line_idx] if 0 <= line_idx < len(source_lines) else "<LINE OUT OF BOUNDS>"
            logger.info(f"  [DIAG #{i}] Line {line_idx}: {d['message']}")
            logger.info(f"    Code: {code_line.strip()}")
            logger.info(f"    Source: {d['source']} | Severity: {d['severity']}")

        logger.info(f"Summary: {summary}")
        logger.info(f"Time: {elapsed_ms:.1f}ms")
        logger.info(f"=== UNIFIED ANALYSIS END ===")
        
        return {
            "file_path": req.file_path,
            "diagnostics": diagnostics_list,
            "summary": summary,
            "analysis_time_ms": elapsed_ms,
            "layers_run": layers_run,
            "content_hash": content_hash,
            "version": req.version,  # Echo back for stale detection
        }
        
    except Exception as e:
        logger.error(f"Unified analysis failed: {str(e)}", exc_info=True)
        raise HTTPException(status_code=500, detail=f"Analysis failed: {str(e)}")


@app.get("/analyze/unified/status")
async def get_unified_status():
    """Get the status of the Intelligence Aggregator."""
    aggregator = get_intelligence_aggregator()
    providers = [p.source.value for p in aggregator._providers]
    if aggregator._ai_provider:
        providers.append(aggregator._ai_provider.source.value)
    return {
        "status": "active",
        "providers": providers,
        "ai_auto_trigger": aggregator._enable_ai_auto_trigger,
    }


# ============================================================================
# Workspace Analysis Models
# ============================================================================

class FileChangeModel(BaseModel):
    """Represents a file change for incremental analysis."""
    path: str
    content_hash: str
    change_type: str  # "added", "modified", "deleted"
    content: Optional[str] = None
    language: Optional[str] = None


class WorkspaceFileModel(BaseModel):
    """A file in the workspace."""
    path: str
    content: str
    language: str


class WorkspaceAnalysisRequestModel(BaseModel):
    """Request for workspace-level analysis."""
    workspace_id: str
    # Files that changed since last analysis (for incremental mode)
    changed_files: Optional[List[FileChangeModel]] = None
    # All files to analyze (for full analysis or context)
    all_files: Optional[List[WorkspaceFileModel]] = None
    # Currently focused/edited file
    focus_file: Optional[str] = None
    # Analysis configuration
    tiers: Optional[List[str]] = None  # "static", "semantic", "ai"
    include_ai: Optional[bool] = False
    max_diagnostics_per_file: Optional[int] = 30
    max_total_diagnostics: Optional[int] = 200
    # Optimization flags
    incremental: Optional[bool] = True
    analyze_dependents: Optional[bool] = True
    # Custom model/API key
    model: Optional[str] = None
    api_key: Optional[str] = None


# ============================================================================
# Workspace Analysis Endpoints
# ============================================================================

@app.post("/analyze/workspace")
async def analyze_workspace(req: WorkspaceAnalysisRequestModel):
    """
    Workspace-level analysis endpoint.
    
    Analyzes multiple files with:
    - Incremental analysis (only changed files + dependents)
    - Cross-file issue detection
    - Multi-file suggestions
    - Smart AI batching to avoid excessive API calls
    
    Returns:
        WorkspaceAnalysisResult with per-file diagnostics,
        cross-file issues, and suggestions.
    """
    def select_provider():
        if req.api_key:
            model_name = (req.model or '').lower()
            if 'gemini' in model_name:
                return get_provider(provider_name='gemini', use_custom=True)
            return get_provider(provider_name='chatgpt', use_custom=True)
        return get_provider()
    
    # Determine tiers
    tiers = []
    if req.tiers:
        tier_map = {
            'static': AnalysisTier.STATIC,
            'semantic': AnalysisTier.SEMANTIC,
            'ai': AnalysisTier.AI,
        }
        tiers = [tier_map[t.lower()] for t in req.tiers if t.lower() in tier_map]
    else:
        tiers = [AnalysisTier.STATIC, AnalysisTier.SEMANTIC]
        if req.include_ai:
            tiers.append(AnalysisTier.AI)
    
    # Build file changes
    changed_files = []
    if req.changed_files:
        for cf in req.changed_files:
            changed_files.append(FileChange(
                path=cf.path,
                content_hash=cf.content_hash,
                change_type=cf.change_type,
                content=cf.content,
                language=cf.language,
            ))
    
    # Build all files context
    all_files = []
    if req.all_files:
        for f in req.all_files:
            all_files.append(FileContext(
                path=f.path,
                content=f.content,
                language=f.language,
            ))
    
    # Build request
    analysis_request = WorkspaceAnalysisRequest(
        workspace_id=req.workspace_id,
        changed_files=changed_files,
        all_files=all_files,
        focus_file=req.focus_file,
        tiers=tiers,
        include_ai=req.include_ai or False,
        max_diagnostics_per_file=req.max_diagnostics_per_file or 30,
        max_total_diagnostics=req.max_total_diagnostics or 200,
        incremental=req.incremental if req.incremental is not None else True,
        analyze_dependents=req.analyze_dependents if req.analyze_dependents is not None else True,
    )
    
    # Get analyzer with provider for AI
    provider = select_provider() if req.include_ai else None
    analyzer = get_workspace_analyzer(llm_provider=provider, enable_ai=req.include_ai or False)
    
    try:
        if req.incremental and req.changed_files:
            result = await analyzer.analyze_incremental(analysis_request)
        else:
            result = await analyzer.analyze(analysis_request)
        return result.to_dict()
    except Exception as e:
        import traceback
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=f"Workspace analysis failed: {str(e)}")


@app.post("/analyze/workspace/incremental")
async def analyze_workspace_incremental(req: WorkspaceAnalysisRequestModel):
    """
    Incremental workspace analysis endpoint.
    
    Optimized for use during editing - only analyzes:
    1. Files that changed
    2. Files that depend on changed files
    
    Much faster than full workspace analysis.
    """
    # Force incremental mode
    req.incremental = True
    return await analyze_workspace(req)


@app.get("/analyze/workspace/{workspace_id}/stats")
async def get_workspace_stats(workspace_id: str):
    """Get statistics for a workspace's analysis state."""
    analyzer = get_workspace_analyzer()
    return analyzer.get_workspace_stats(workspace_id)


@app.post("/analyze/workspace/{workspace_id}/clear")
async def clear_workspace(workspace_id: str):
    """Clear cached analysis state for a workspace."""
    analyzer = get_workspace_analyzer()
    analyzer.clear_workspace(workspace_id)
    return {"status": "ok", "message": f"Workspace {workspace_id} cleared"}


@app.post("/analyze/ai")
async def analyze_code_ai(req: AnalyzeAiRequest):
    def select_provider_name() -> str | None:
        if req.api_key:
            model_name = (req.model or '').lower()
            if 'gemini' in model_name:
                return 'gemini'
            # default to OpenAI when a custom key is present but model is not explicitly Gemini
            return 'chatgpt'
        return None

    provider = get_provider(provider_name=select_provider_name(), use_custom=bool(req.api_key))
    try:
        ai_suggestion = await provider.ask_llm(
            req.code,
            req.lang,
            req.prompt,
            mode=req.mode,
            files=req.files,
            focus=req.focus,
            model=req.model,
            api_key=req.api_key,
        )
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))

    return {
        "ai_suggestion": ai_suggestion,
        "lang": req.lang,
    }


@app.post("/refactor/split")
async def refactor_split(req: AnalyzeAiRequest):
    def select_provider_name() -> str | None:
        if req.api_key:
            model_name = (req.model or '').lower()
            if 'gemini' in model_name:
                return 'gemini'
            return 'chatgpt'
        return None

    provider = get_provider(provider_name=select_provider_name(), use_custom=bool(req.api_key))
    
    prompt = SPLIT_GUI_PROMPT
    if req.prompt:
        prompt += "\nUser Instructions: " + req.prompt
        
    try:
        ai_suggestion = await provider.ask_llm(
            req.code,
            req.lang,
            prompt,
            mode="split",
            files=req.files,
            focus=req.focus,
            model=req.model,
            api_key=req.api_key,
        )
        print(f"--- AI SPLIT OUTPUT START ---\n{ai_suggestion}\n--- AI SPLIT OUTPUT END ---")
    except Exception as e:
        print(f"AI Split Error: {e}")
        raise HTTPException(status_code=400, detail=str(e))

    return {
        "result": ai_suggestion,
        "lang": req.lang,
    }

@app.post("/refactor/split_file")
def split_file(file_path: str, api_url: str = "http://localhost:8000/refactor/split"):
    if not os.path.exists(file_path):
        print(f"File not found: {file_path}")
        return

    with open(file_path, 'r') as f:
        content = f.read()
    
    ext = os.path.splitext(file_path)[1][1:]
    lang = "cpp"
    if ext == "rs": lang = "rust"
    elif ext == "ts": lang = "typescript"
    elif ext == "js": lang = "javascript"
    elif ext == "py": lang = "python"

    payload = {
        "code": content,
        "lang": lang,
        "mode": "split"
    }
    
    print(f"Sending {file_path} to AI for analysis...")
    try:
        response = requests.post(api_url, json=payload)
        response.raise_for_status()
        result = response.json().get("result")
        
        # Parse the JSON string returned by the LLM
        if isinstance(result, str):
            # The LLM might return markdown code blocks, so we need to clean it
            if "```json" in result:
                result = result.split("```json")[1].split("```")[0].strip()
            elif "```" in result:
                result = result.split("```")[1].split("```")[0].strip()
            
            try:
                data = json.loads(result)
            except json.JSONDecodeError:
                print("Failed to parse JSON response from AI:")
                print(result)
                return
        else:
            data = result
        
        # Save files
        for key, module in data.items():
            if isinstance(module, dict) and "filename" in module and "content" in module:
                fname = module["filename"]
                print(f"Writing {fname}...")
                with open(fname, 'w') as f:
                    f.write(module["content"])
                    
        print("Split complete!")
        if "explanation" in data:
            print("\nExplanation:")
            print(data["explanation"])
            
    except Exception as e:
        print(f"Error: {e}")


# ============================================================
# ENHANCED API ENDPOINTS
# ============================================================

class VerifiedAiRequest(AnalyzeAiRequest):
    """Request with verification options."""
    verify: bool = True
    auto_repair: bool = True
    session_id: Optional[str] = None


@app.post("/analyze/ai/verified")
async def analyze_code_ai_verified(req: VerifiedAiRequest):
    """
    AI analysis with verification and provenance tracking.
    
    This endpoint:
    1. Tracks provenance of the request
    2. Calls AI provider for analysis
    3. Verifies output for invariants
    4. Auto-repairs if possible
    5. Returns verified result with provenance
    """
    start_time = time.time()
    tracker = get_provenance_tracker()
    verifier = get_verifier()
    
    # Create provenance record
    provenance_id = track_ai_call(
        change_type=ChangeType.ANALYSIS if req.mode != "refactor" else ChangeType.REFACTOR,
        original_code=req.code,
        prompt=req.prompt or "",
        target_file=req.focus,
        target_language=req.lang,
        session_id=req.session_id,
    )
    
    def select_provider_name() -> str | None:
        if req.api_key:
            model_name = (req.model or '').lower()
            if 'gemini' in model_name:
                return 'gemini'
            return 'chatgpt'
        return None

    provider = get_provider(provider_name=select_provider_name(), use_custom=bool(req.api_key))
    
    try:
        ai_suggestion = await provider.ask_llm(
            req.code,
            req.lang,
            req.prompt,
            mode=req.mode,
            files=req.files,
            focus=req.focus,
            model=req.model,
            api_key=req.api_key,
        )
        
        # Update provenance with model info
        latency_ms = (time.time() - start_time) * 1000
        tracker.update_model_info(
            provenance_id,
            provider=select_provider_name() or "default",
            model_name=req.model or "default",
            temperature=0.2,
            max_tokens=4096,
            latency_ms=latency_ms,
        )
        tracker.update_output(provenance_id, ai_suggestion)
        
    except Exception as e:
        tracker.mark_rejected(provenance_id, f"AI error: {e}")
        raise HTTPException(status_code=400, detail=str(e))

    # Verify output
    verification_result = None
    if req.verify:
        verification_result = verifier.verify(
            ai_suggestion,
            original_code=req.code,
            lang=req.lang,
        )
        
        # Update provenance with verification
        tracker.update_verification(
            provenance_id,
            status=ProvVerificationStatus(verification_result.status.value),
            violations=[v.message for v in verification_result.violations],
            original_hash=verification_result.original_hash,
            verified_hash=verification_result.verified_hash,
            auto_repaired=verification_result.repaired_output is not None,
            duration_ms=verification_result.duration_ms,
        )
        
        # Use repaired output if available
        if verification_result.repaired_output:
            ai_suggestion = verification_result.repaired_output
        
        # Reject if verification failed
        if not verification_result.passed:
            tracker.mark_rejected(provenance_id, "Verification failed")
            return {
                "ai_suggestion": None,
                "lang": req.lang,
                "verification": verification_result.to_dict(),
                "provenance_id": provenance_id,
                "error": "Output failed verification",
            }
    
    tracker.mark_accepted(provenance_id)
    
    return {
        "ai_suggestion": ai_suggestion,
        "lang": req.lang,
        "verification": verification_result.to_dict() if verification_result else None,
        "provenance_id": provenance_id,
    }


@app.post("/refactor/split/verified")
async def refactor_split_verified(req: VerifiedAiRequest):
    """
    Split refactoring with verification.
    
    Verifies that:
    1. All modules have valid structure
    2. Combined exports match original
    3. Each file is syntactically valid
    """
    start_time = time.time()
    tracker = get_provenance_tracker()
    verifier = get_verifier()
    
    provenance_id = track_ai_call(
        change_type=ChangeType.SPLIT,
        original_code=req.code,
        prompt=req.prompt or "",
        target_file=req.focus,
        target_language=req.lang,
        session_id=req.session_id,
    )
    
    def select_provider_name() -> str | None:
        if req.api_key:
            model_name = (req.model or '').lower()
            if 'gemini' in model_name:
                return 'gemini'
            return 'chatgpt'
        return None

    provider = get_provider(provider_name=select_provider_name(), use_custom=bool(req.api_key))
    
    prompt = SPLIT_GUI_PROMPT
    if req.prompt:
        prompt += "\nUser Instructions: " + req.prompt
        
    try:
        ai_suggestion = await provider.ask_llm(
            req.code,
            req.lang,
            prompt,
            mode="split",
            files=req.files,
            focus=req.focus,
            model=req.model,
            api_key=req.api_key,
        )
        
        latency_ms = (time.time() - start_time) * 1000
        tracker.update_model_info(
            provenance_id,
            provider=select_provider_name() or "default",
            model_name=req.model or "default",
            temperature=0.2,
            max_tokens=8192,
            latency_ms=latency_ms,
        )
        tracker.update_output(provenance_id, ai_suggestion)
        
    except Exception as e:
        tracker.mark_rejected(provenance_id, f"AI error: {e}")
        raise HTTPException(status_code=400, detail=str(e))

    # Parse and verify split result
    try:
        # Clean up markdown if present
        result_str = ai_suggestion
        if "```json" in result_str:
            result_str = result_str.split("```json")[1].split("```")[0].strip()
        elif "```" in result_str:
            result_str = result_str.split("```")[1].split("```")[0].strip()
        
        split_result = json.loads(result_str)
        
        if req.verify:
            verification_result = verifier.verify_split_result(
                split_result,
                original_code=req.code,
                lang=req.lang,
            )
            
            tracker.update_verification(
                provenance_id,
                status=ProvVerificationStatus(verification_result.status.value),
                violations=[v.message for v in verification_result.violations],
                original_hash=verification_result.original_hash,
                verified_hash=verification_result.verified_hash,
                duration_ms=verification_result.duration_ms,
            )
            
            if not verification_result.passed:
                tracker.mark_rejected(provenance_id, "Split verification failed")
                return {
                    "result": None,
                    "lang": req.lang,
                    "verification": verification_result.to_dict(),
                    "provenance_id": provenance_id,
                    "error": "Split output failed verification",
                }
        
        tracker.mark_accepted(provenance_id)
        
        return {
            "result": split_result,
            "lang": req.lang,
            "verification": verification_result.to_dict() if req.verify else None,
            "provenance_id": provenance_id,
        }
        
    except json.JSONDecodeError as e:
        tracker.mark_rejected(provenance_id, f"Invalid JSON: {e}")
        return {
            "result": None,
            "raw_output": ai_suggestion,
            "lang": req.lang,
            "provenance_id": provenance_id,
            "error": f"Failed to parse split result: {e}",
        }


class JobSubmitRequest(BaseModel):
    """Request to submit a job to the queue."""
    job_type: str  # static, ai_analyze, ai_refactor, ai_generate
    payload: dict
    priority: str = "normal"  # critical, high, normal, low, bulk
    budget_time_seconds: Optional[float] = None
    budget_tokens: Optional[int] = None


@app.post("/queue/submit")
async def submit_job(req: JobSubmitRequest):
    """Submit a job to the priority queue."""
    queue = get_queue()
    
    # Map string to enum
    job_type_map = {
        "static": JobType.STATIC,
        "ai_analyze": JobType.AI_ANALYZE,
        "ai_refactor": JobType.AI_REFACTOR,
        "ai_generate": JobType.AI_GENERATE,
    }
    
    priority_map = {
        "critical": JobPriority.CRITICAL,
        "high": JobPriority.HIGH,
        "normal": JobPriority.NORMAL,
        "low": JobPriority.LOW,
        "bulk": JobPriority.BULK,
    }
    
    job_type = job_type_map.get(req.job_type, JobType.AI_ANALYZE)
    priority = priority_map.get(req.priority, JobPriority.NORMAL)
    
    budget = None
    if req.budget_time_seconds or req.budget_tokens:
        budget = JobBudget(
            max_time_seconds=req.budget_time_seconds or 30.0,
            max_tokens=req.budget_tokens or 4096,
        )
    
    job_id = await queue.submit(job_type, req.payload, priority, budget)
    
    return {"job_id": job_id, "status": "queued"}


@app.get("/queue/status/{job_id}")
async def get_job_status(job_id: str):
    """Get status of a queued job."""
    queue = get_queue()
    job = await queue.get_job(job_id)
    
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")
    
    return {
        "job_id": job.job_id,
        "status": "running" if job.started_at else "queued",
        "created_at": job.created_at,
        "started_at": job.started_at,
        "completed_at": job.completed_at,
        "result": job.result,
        "error": job.error,
    }


@app.post("/queue/cancel/{job_id}")
async def cancel_job(job_id: str):
    """Cancel a queued job."""
    queue = get_queue()
    cancelled = await queue.cancel(job_id)
    
    return {"cancelled": cancelled}


@app.get("/queue/stats")
async def get_queue_stats():
    """Get queue statistics."""
    queue = get_queue()
    stats = await queue.get_stats()
    return stats.model_dump()


@app.get("/provenance/{record_id}")
async def get_provenance(record_id: str):
    """Get provenance record for an AI change."""
    tracker = get_provenance_tracker()
    record = tracker.get_record(record_id)
    
    if not record:
        raise HTTPException(status_code=404, detail="Provenance record not found")
    
    return record.to_dict()


@app.get("/provenance/file/{file_path:path}")
async def get_file_provenance(file_path: str):
    """Get all provenance records for a file."""
    tracker = get_provenance_tracker()
    records = tracker.get_records_for_file(file_path)
    return [r.to_dict() for r in records]


@app.get("/provenance/stats")
async def get_provenance_stats():
    """Get provenance statistics."""
    tracker = get_provenance_tracker()
    return tracker.get_statistics()


# ============================================================
# FAST STRUCTURAL UPDATE ENDPOINTS (for HMR)
# ============================================================

class StructuralUpdateRequest(BaseModel):
    """Request for fast structural updates (add/remove elements)."""
    update_type: str  # "addition", "deletion"
    changes_description: str = ""  # What changed (for addition/deletion)
    core_content: str
    gui_content: str
    shared_content: str
    # Existing cached split result to inject delta into
    cached_result: Optional[dict] = None
    model: Optional[str] = None
    api_key: Optional[str] = None


@app.post("/refactor/delta")
async def refactor_delta(req: StructuralUpdateRequest):
    """
    Delta-based code translation endpoint for fast HMR.
    
    Instead of regenerating all code:
    1. Keeps existing working code (with guardrails applied)
    2. Takes the X11 delta the user wrote
    3. Asks AI to TRANSLATE that X11 code to SDL2
    4. Injects the translated SDL2 code into the existing modules
    
    Uses Gemini by default for fast ~2-3s response vs ~18s for full split.
    """
    start_time = time.time()
    
    # Always use Gemini for delta operations (fast and efficient)
    provider = get_provider(provider_name='gemini', use_custom=bool(req.api_key))
    
    try:
        if req.update_type == "addition":
            print(f"[Delta] Translating X11 code to SDL2:\n{req.changes_description[:200]}...")
            
            # Generate the translation prompt - AI translates X11 -> SDL2
            prompt = format_delta_addition_prompt(
                req.changes_description,
                req.core_content,
                req.gui_content,
                req.shared_content
            )
            
            # Call AI to translate X11 to SDL2
            ai_response = await provider.ask_llm(
                prompt,
                "cpp",
                None,
                mode="delta",
                model=req.model or "gemini-2.5-flash-lite",
                api_key=req.api_key,
            )
            
            print(f"[Delta] SDL2 translation:\n{ai_response}")
            
            # Parse the delta JSON from AI response
            delta = _parse_delta_json(ai_response)
            
            # If we have a cached result, inject the delta into it
            if req.cached_result:
                updated_result = inject_delta_into_code(req.cached_result, delta)
                elapsed = time.time() - start_time
                print(f"[Delta Addition] completed in {elapsed:.2f}s")
                
                return {
                    "result": updated_result,
                    "delta": delta,
                    "update_type": "addition",
                    "elapsed_seconds": elapsed
                }
            else:
                # Return just the delta if no cached result to inject into
                elapsed = time.time() - start_time
                return {
                    "delta": delta,
                    "update_type": "addition", 
                    "elapsed_seconds": elapsed
                }
                
        elif req.update_type == "deletion":
            # Generate deletion prompt
            prompt = format_delta_deletion_prompt(req.changes_description)
            
            ai_response = await provider.ask_llm(
                prompt,
                "cpp",
                None,
                mode="delta",
                model=req.model or "gemini-2.5-flash-lite",
                api_key=req.api_key,
            )
            
            delta = _parse_delta_json(ai_response)
            
            if req.cached_result:
                updated_result = apply_deletion_delta(req.cached_result, delta)
                elapsed = time.time() - start_time
                print(f"[Delta Deletion] completed in {elapsed:.2f}s")
                
                return {
                    "result": updated_result,
                    "delta": delta,
                    "update_type": "deletion",
                    "elapsed_seconds": elapsed
                }
            else:
                elapsed = time.time() - start_time
                return {
                    "delta": delta,
                    "update_type": "deletion",
                    "elapsed_seconds": elapsed
                }
        else:
            raise HTTPException(status_code=400, detail=f"Unknown update_type: {req.update_type}. Use 'addition' or 'deletion'.")
            
    except json.JSONDecodeError as e:
        print(f"[Delta] JSON parse error: {e}")
        raise HTTPException(status_code=400, detail=f"Failed to parse AI delta response: {e}")
    except Exception as e:
        print(f"[Delta] Error: {e}")
        raise HTTPException(status_code=400, detail=str(e))


def _parse_delta_json(ai_response: str) -> dict:
    """Parse JSON from AI response, handling markdown code blocks."""
    result_str = ai_response.strip()
    
    # Clean up markdown if present
    if "```json" in result_str:
        result_str = result_str.split("```json")[1].split("```")[0].strip()
    elif "```" in result_str:
        result_str = result_str.split("```")[1].split("```")[0].strip()
    
    return json.loads(result_str)


@app.post("/refactor/structural")
async def refactor_structural(req: StructuralUpdateRequest):
    """
    Legacy structural update endpoint - redirects to delta-based approach.
    Kept for backwards compatibility.
    """
    # Redirect to delta endpoint
    return await refactor_delta(req)


@app.get("/")
def root():
    return {
        "status": "ai-engine-online",
        "supported_languages": list(supported_languages()),
        "features": [
            "job_queue",
            "verification",
            "streaming",
            "provenance_tracking",
        ],
    }


if __name__ == "__main__":
    if len(sys.argv) > 1:
        split_file(sys.argv[1])
    else:
        import uvicorn
        # Bind to 0.0.0.0 to allow access from WSL/Containers
        uvicorn.run("main:app", host="0.0.0.0", port=8000, reload=True)
