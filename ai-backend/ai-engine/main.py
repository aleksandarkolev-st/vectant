# PROTOTYPING AI ENGINE WITH PYTHON, LATER SWITCH TO RUST
from __future__ import annotations

from typing import List, Optional, Union, Tuple
import re
import requests
import json
import sys
import os
import asyncio
import logging
from pathlib import Path

from dotenv import load_dotenv

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

AI_ENGINE_ROOT = Path(__file__).resolve().parent
load_dotenv(AI_ENGINE_ROOT / '.env', override=False)

# Also set up logging for proactive analyzer modules
for module in ['analyzer.proactive', 'analyzer.proactive.semantic_analyzer', 'analyzer.proactive.orchestrator']:
    logging.getLogger(module).setLevel(logging.INFO)
import time

from fastapi import FastAPI, HTTPException, BackgroundTasks, Request, Body
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from analyzer import get_analyzer
from analyzer import supported_languages

from llm.providers import get_provider
from llm.prompts import SPLIT_GUI_PROMPT, UNIVERSAL_SPLIT_PROMPT
from llm.structural_prompts import format_heal_prompt
from build_manifest import (
    BuildManifest,
    ManifestRejection,
    parse_manifest,
    validate_manifest_v1,
    manifest_to_dict,
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

# Map verifier status strings to provenance status strings
_VERIFIER_TO_PROV_STATUS = {
    "pass": "passed",
    "warn": "warned",
    "fail": "failed",
    "repaired": "repaired",
}

def _map_verification_status(verifier_status) -> ProvVerificationStatus:
    raw = verifier_status.value if hasattr(verifier_status, 'value') else str(verifier_status)
    mapped = _VERIFIER_TO_PROV_STATUS.get(raw, raw)
    return ProvVerificationStatus(mapped)


# ══════════════════════════════════════════════════════════════
# Architecture cache extraction (for /refactor/split/verified)
# ══════════════════════════════════════════════════════════════
#
# The split model emits a markdown architecture doc wrapped in
# <synthi_arch_cache>...</synthi_arch_cache> tags AFTER the JSON
# split block. We extract it before parsing the JSON so that:
#   1. The JSON parser never sees the architecture trailer.
#   2. The architecture string can be returned alongside the result
#      and cached by the Rust worker in the split sidecar.
#
# XML tags are used instead of `---ARCHITECTURE---` because `---` is
# valid markdown for horizontal rules and collides with pro-model
# prose / user source comments. XML open/close pairs fail cleanly if
# the model truncates — unmatched closing tag → no match → fallback.

_ARCH_TAG_RE = re.compile(
    r"""
    (?:^|\n)                                   # start of line
    \s*                                        # optional leading whitespace
    (?:```[a-zA-Z]*\s*\n)?                      # optional opening code fence
    <\s*synthi_arch_cache\s*>\s*\n?            # <synthi_arch_cache>
    (?P<body>.*?)                              # the architecture doc
    \n?\s*<\s*/\s*synthi_arch_cache\s*>        # </synthi_arch_cache>
    """,
    re.IGNORECASE | re.VERBOSE | re.DOTALL,
)


def extract_architecture(ai_response: str) -> Tuple[str, str]:
    """Split the raw LLM response into (json_part, architecture_md).

    Returns `(response, "")` if the architecture tags are not found — the
    caller then falls back to the generic prompt with no regression.
    Never raises.
    """
    if not isinstance(ai_response, str) or not ai_response:
        return ai_response or "", ""
    match = _ARCH_TAG_RE.search(ai_response)
    if not match:
        return ai_response, ""
    # The JSON lives BEFORE the <synthi_arch_cache> tag.
    json_part = ai_response[: match.start()].rstrip()
    # Strip any trailing code fence the model might have wrapped around
    # the whole tail block.
    json_part = re.sub(r"\n?```\s*$", "", json_part).rstrip()
    arch_part = (match.group("body") or "").strip()
    return json_part, arch_part


# ══════════════════════════════════════════════════════════════
# Build manifest extraction (for /refactor/split/verified V2 universal)
# ══════════════════════════════════════════════════════════════
#
# The universal split prompt (UNIVERSAL_SPLIT_PROMPT) asks the AI to
# emit a machine-readable JSON block inside the architecture cache,
# wrapped in <synthi_build_manifest>...</synthi_build_manifest> tags.
# We parse it with its own regex (nested inside the arch cache) and
# validate with pydantic in build_manifest.py.
#
# Nested XML tags (rather than a fenced ```json block) chosen because:
#   - Same regex shape as the outer <synthi_arch_cache> (easy to parse)
#   - Impossible to collide with markdown prose in the arch doc
#   - Fails cleanly on truncation (unmatched close → no match → no manifest)
#
# See HMR_AGNOSTIC_ULTRAPLAN.md §4 for the full schema.

_MANIFEST_TAG_RE = re.compile(
    r"""
    <\s*synthi_build_manifest\s*>\s*\n?
    (?P<body>.*?)
    \n?\s*<\s*/\s*synthi_build_manifest\s*>
    """,
    re.IGNORECASE | re.VERBOSE | re.DOTALL,
)

# The universal split prompt wraps the 4-file JSON object in <JSON>...</JSON>
# tags (see UNIVERSAL_SPLIT_PROMPT output format spec). The legacy
# SPLIT_GUI_PROMPT didn't, so the handler's `result_str` json.loads call
# used to work on raw JSON directly. With the universal prompt, we need to
# unwrap the tags here before returning `json_part` or the downstream
# json.loads explodes with a JSONDecodeError, the handler falls into its
# error-catch branch, and the response comes back as
# {result: None, error: ...} — which is exactly what the live test hit on
# its first run (0/3 tests passing, handler returning error-shape dicts).
#
# Non-greedy match + first-match-wins because the prompt spec says the
# <JSON> block comes FIRST in the response. Case-insensitive for forgiveness.
_JSON_WRAPPER_RE = re.compile(
    r"""
    <\s*JSON\s*>\s*\n?
    (?P<body>.*?)
    \n?\s*<\s*/\s*JSON\s*>
    """,
    re.IGNORECASE | re.VERBOSE | re.DOTALL,
)


def extract_architecture_and_manifest(
    ai_response: str,
) -> Tuple[str, str, Optional[dict]]:
    """Parse the universal-split AI response into its three parts.

    Returns `(json_part, architecture_md, manifest_dict)`:
      - `json_part` — the JSON object containing the 4 files, with any
        `<JSON>...</JSON>` wrapper stripped so the caller can pass it
        directly to `json.loads`. If the AI didn't wrap it, returned
        as-is (text before the arch cache, same as legacy extractor).
      - `architecture_md` — the markdown inside <synthi_arch_cache> (with
        the <synthi_build_manifest> block stripped out). Empty string if
        the tag was not present in the response.
      - `manifest_dict` — the JSON dict inside <synthi_build_manifest>.
        `None` if the tag was not present or the JSON failed to parse.

    Never raises — all failures degrade to partial results so the caller
    can decide whether to continue (pre-universal-prompt fallback) or
    error out.
    """
    if not isinstance(ai_response, str) or not ai_response:
        return (ai_response or ""), "", None

    # First split at the arch cache boundary (same as legacy extractor).
    json_part, arch_md = extract_architecture(ai_response)

    # Then pull the manifest JSON out of the arch cache. The manifest tag
    # lives INSIDE the arch cache, so we search the full original response
    # (not just arch_md) because the legacy extractor already stripped the
    # outer tags and the manifest may straddle whitespace edges.
    manifest_dict: Optional[dict] = None
    if arch_md:
        manifest_match = _MANIFEST_TAG_RE.search(ai_response)
        if manifest_match:
            manifest_raw = (manifest_match.group("body") or "").strip()
            try:
                manifest_dict = json.loads(manifest_raw)
            except json.JSONDecodeError as e:
                logger.warning(
                    f"[split/verified] <synthi_build_manifest> not valid JSON: {e}"
                )
                # Best-effort fallback: strip trailing commas some models emit
                cleaned = re.sub(r",(\s*[}\]])", r"\1", manifest_raw)
                try:
                    manifest_dict = json.loads(cleaned)
                    logger.info(
                        "[split/verified] manifest recovered after trailing-comma cleanup"
                    )
                except Exception:
                    manifest_dict = None

            # Also strip the manifest block from the returned arch_md so the
            # architecture markdown the worker stores doesn't duplicate JSON.
            arch_md = _MANIFEST_TAG_RE.sub("", arch_md).strip()

    # Unwrap <JSON>...</JSON> from json_part so the caller's json.loads sees
    # clean JSON. The universal split prompt wraps the 4-file object in these
    # tags; without this step, the handler's json.loads raises JSONDecodeError,
    # falls into its error branch, and returns {result: None, error: ...}
    # with no architecture / manifest / verified fields — exactly what the
    # live test hit before this fix. First-match-wins per the prompt spec
    # (the <JSON> block comes FIRST in the response).
    if isinstance(json_part, str) and json_part:
        json_wrap_match = _JSON_WRAPPER_RE.search(json_part)
        if json_wrap_match:
            json_part = (json_wrap_match.group("body") or "").strip()

    return json_part, arch_md, manifest_dict
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

from fastapi.middleware.cors import CORSMiddleware

app = FastAPI()

# Add CORS middleware to allow frontend access
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # In production, restrict to specific origins
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

@app.middleware("http")
async def log_requests(request: Request, call_next):
    import time
    start_time = time.time()
    
    response = await call_next(request)
    
    # Condensed request/response logging
    process_time = time.time() - start_time
    logger.info(f"[AI-ENGINE] {request.method} {request.url.path} -> {response.status_code} ({process_time:.3f}s)")
    
    return response

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
        
        async with aiohttp.ClientSession() as session:
            async with session.get(url) as resp:
                if resp.status == 200:
                    content = await resp.text()
                    return content
                elif resp.status == 404:
                    logger.warning(f"[Container] File not found: {slug}/{file_path}")
                    return None
                else:
                    error_body = await resp.text()
                    logger.warning(f"[Container] Failed to fetch {file_path}: {resp.status}")
                    return None
    except Exception as e:
        logger.error(f"[Container] Error fetching {file_path}: {e}")
        return None


# ============================================================
# INTENT CLASSIFICATION
# ============================================================

class IntentRequest(BaseModel):
    """Request for intent classification."""
    query: str
    context: Optional[str] = None


# Import the intent classifier
from code_intel.routing.intent_classifier import IntentClassifier
from code_intel.routing.types import QueryIntent

_intent_classifier: Optional[IntentClassifier] = None

def get_intent_classifier() -> IntentClassifier:
    global _intent_classifier
    if _intent_classifier is None:
        _intent_classifier = IntentClassifier()
    return _intent_classifier


@app.post("/classify/intent")
async def classify_intent(req: IntentRequest):
    """
    Classify user query intent using LLM-based classification.
    
    Returns the intent type which determines response format:
    - 'explain', 'navigate' -> No code changes (explain mode)
    - 'debug', 'refactor', 'generate', 'test', 'performance' -> Code changes expected
    - 'unknown' -> Defaults to code changes
    
    Also returns whether code changes are expected based on the intent.
    """
    classifier = get_intent_classifier()
    intent = classifier.classify(req.query, req.context)
    
    # Determine if this intent typically requires code changes
    # EXPLAIN and NAVIGATE are informational; others typically involve code modifications
    needs_code_changes = intent not in (QueryIntent.EXPLAIN, QueryIntent.NAVIGATE)
    
    return {
        "intent": intent.value,
        "needs_code_changes": needs_code_changes,
        "response_mode": "patch" if needs_code_changes else "explain",
    }


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
    
    import hashlib
    content_hash = hashlib.md5(req.code.encode()).hexdigest()[:16]
    logger.info(f"[PROACTIVE] {file_context.path} | {len(file_context.content)} chars | hash={content_hash} | tiers={tiers}")
    
    # Build related files context
    related_files = []
    if req.related_files:
        for rf in req.related_files:
            rf_path = rf.path or rf.name or f"file-{len(related_files)}"
            related_files.append(FileContext(
                path=rf_path,
                content=rf.content,
                language=req.lang,
            ))
    
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
        logger.info(f"[PROACTIVE] Result: {len(result.all_diagnostics)} diags")
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
    import hashlib
    
    # Fetch main file content from container
    content = await fetch_file_from_container(req.slug, req.file_path)
    if content is None:
        raise HTTPException(status_code=404, detail=f"File not found: {req.file_path}")
    
    content_hash = hashlib.md5(content.encode()).hexdigest()[:16]
    logger.info(f"[CONTAINER] {req.file_path} | {len(content)} chars | hash={content_hash}")
    
    # Build file context
    file_context = FileContext(
        path=req.file_path,
        content=content,
        language=req.lang,
    )
    
    # Fetch related files from container
    related_files = []
    if req.related_paths:
        for rpath in req.related_paths:
            rcontent = await fetch_file_from_container(req.slug, rpath)
            if rcontent is not None:
                related_files.append(FileContext(
                    path=rpath,
                    content=rcontent,
                    language=req.lang,
                ))
    
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
        logger.info(f"[CONTAINER] Result: {len(result.all_diagnostics)} diags")
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
    version: Union[int, str]  # Client-side version counter or hash (MANDATORY)
    # Optional content override (for unsaved changes)
    content: Optional[str] = None
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
    
    # Fetch content from container OR use provided content
    if req.content is not None:
        content = req.content
    else:
        content = await fetch_file_from_container(req.slug, req.file_path)
        if content is None:
            raise HTTPException(status_code=404, detail=f"File not found: {req.file_path}")
    
    # Compute content hash for client-side caching
    content_hash = hashlib.sha256(content.encode()).hexdigest()[:16]

    # Content fingerprinting for stale/shift debugging (no code is returned, only counts)
    normalized = content.replace("\r\n", "\n").replace("\r", "\n")
    split_lines = normalized.split("\n")
    leading_blank_lines = 0
    while leading_blank_lines < len(split_lines) and split_lines[leading_blank_lines] == "":
        leading_blank_lines += 1

    lines = content.splitlines()
    first_line = lines[0] if lines else ''
    used_content_override = req.content is not None

    # Condensed request logging
    logger.info(
        f"[UNIFIED] {req.file_path} | v={req.version} | {len(content)} chars | hash={content_hash} | lines={len(split_lines)} | lead_blank={leading_blank_lines} | override={used_content_override} | layers={req.layers or ['static', 'semantic']} | first=\"{first_line[:50]}\""
    )
    
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
    
    # For FAST analysis (static/semantic), ignore comments but preserve all line/column
    # positions by masking comment characters with spaces (newlines preserved).
    # IMPORTANT: Keep the original `content` for debug/codeAtLine snapshot checks.
    analysis_content = content
    if AnalysisTier.AI not in tiers:
        try:
            from analyzer.comment_masker import mask_comments_for_analysis

            analysis_content = mask_comments_for_analysis(content, req.lang)
        except Exception:
            # Never fail analysis due to comment masking.
            analysis_content = content

    # Build file context for ProactiveAnalyzer
    file_context = FileContext(
        path=req.file_path,
        content=analysis_content,
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
                
                # AI analysis should see original source (comments included).
                ai_file_context = FileContext(
                    path=req.file_path,
                    content=content,
                    language=req.lang,
                )

                ai_request = AnalysisRequest(
                    file=ai_file_context,
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
                diag_dict["fixes"] = [f.to_dict() for f in diag.fixes]
            
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
            "content_debug": {
                "line_count": len(split_lines),
                "leading_blank_lines": leading_blank_lines,
                "used_content_override": used_content_override,
            },
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
            # Split needs stronger reasoning — 88K prompt, structured
            # JSON output, must not drift. Pro model by default.
            model=req.model or "gemini-3.1-flash-lite-preview",
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
    grounding_spans: Optional[List[dict]] = None


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
            context={"grounding_spans": req.grounding_spans} if req.grounding_spans else None,
        )
        
        # Update provenance with verification
        tracker.update_verification(
            provenance_id,
            status=_map_verification_status(verification_result.status),
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

    # Use the universal library-agnostic split prompt (Phase 1 of ULTRAPLAN).
    # It produces a 4-file split (shared / core / gui / host_runner) + a
    # machine-readable build manifest inside the arch cache, for ANY C++
    # library (not just SDL2). Substitute the user source into the template
    # so it's inlined at request time.
    prompt = UNIVERSAL_SPLIT_PROMPT.replace("{USER_CODE}", req.code)
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
            # Universal split with 4-file output + build manifest needs
            # stronger reasoning; pro by default. Override via req.model.
            model=req.model or "gemini-3.1-flash-lite-preview",
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
        # Peel off the architecture cache AND the nested build manifest.
        # Universal prompt emits:
        #   <JSON>{4 files}</JSON>
        #   <synthi_arch_cache># Architecture...<synthi_build_manifest>{...}</synthi_build_manifest></synthi_arch_cache>
        # The extractor returns (json_part, arch_md, manifest_dict). The
        # manifest is validated via pydantic below and forwarded to the
        # Rust worker for compile dispatch.
        json_only_response, architecture_md, manifest_dict = (
            extract_architecture_and_manifest(ai_suggestion)
        )
        if architecture_md:
            logger.info(
                f"[split/verified] architecture cache captured ({len(architecture_md)} chars)"
            )
        else:
            logger.info(
                "[split/verified] no architecture cache in response (fallback to generic)"
            )

        # Parse + validate the manifest (Phase 2). If malformed, log and
        # return `manifest=None` so the Rust worker falls back to hardcoded
        # SDL2 defaults (backward compat with pre-universal sidecars).
        manifest_parsed: Optional[BuildManifest] = None
        manifest_out: Optional[dict] = None
        if manifest_dict is not None:
            try:
                manifest_parsed = parse_manifest(manifest_dict)
                validate_manifest_v1(manifest_parsed)
                manifest_out = manifest_to_dict(manifest_parsed)
                logger.info(
                    f"[split/verified] manifest parsed "
                    f"(compiler={manifest_parsed.compiler}, "
                    f"hot_reload_mode={manifest_parsed.hot_reload_mode}, "
                    f"confidence={manifest_parsed.confidence.overall})"
                )
            except ManifestRejection as e:
                # V1 can't execute this manifest (multi-step build, unknown
                # compiler, etc.). Surface as HTTP 422 with the actionable
                # error card text (see HMR_AGNOSTIC_ULTRAPLAN.md §5.3).
                tracker.mark_rejected(provenance_id, f"Manifest rejected: {e.message}")
                raise HTTPException(status_code=422, detail=e.message)
            except Exception as e:
                logger.warning(
                    f"[split/verified] manifest validation failed: {e}. "
                    "Proceeding with None (worker will fall back to SDL2 default)."
                )
                manifest_out = None
        else:
            logger.info(
                "[split/verified] no <synthi_build_manifest> in response "
                "(pre-universal prompt? worker falls back to SDL2 default)"
            )

        # Clean up markdown if present
        result_str = json_only_response
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
                status=_map_verification_status(verification_result.status),
                violations=[v.message for v in verification_result.violations],
                original_hash=verification_result.original_hash,
                verified_hash=verification_result.verified_hash,
                duration_ms=verification_result.duration_ms,
            )

            if not verification_result.passed:
                # Return the split result as a string even when verification finds issues.
                # The worker expects "result" to be a raw LLM string (same as /refactor/split),
                # and "result: null" causes the worker to bail completely, hanging the IDE on
                # "Compiling...". Bracket-balance warnings are often false positives for split
                # output (each file is a partial compile unit). The real compiler will catch
                # genuine syntax errors.
                tracker.mark_rejected(provenance_id, "Split verification failed (forwarding result anyway)")
                return {
                    "result": result_str,
                    "architecture": architecture_md,
                    "manifest": manifest_out,
                    "lang": req.lang,
                    "verified": False,
                    "verification": verification_result.to_dict(),
                    "provenance_id": provenance_id,
                }

        tracker.mark_accepted(provenance_id)

        return {
            # Return the raw JSON string so the worker can parse it the same way it handles
            # the /refactor/split response. Returning a parsed dict causes the worker's
            # "result.as_str()" check to fail and bail with "unexpected response format".
            "result": result_str,
            # Architecture cache (markdown, may be empty string if the model
            # forgot to emit the <synthi_arch_cache> block). Worker stores it
            # in the split sidecar and re-injects into diff_patch calls.
            "architecture": architecture_md,
            # Build manifest (ULTRAPLAN Phase 2): compiler flags, link flags,
            # hot_reload_mode, and confidence fields — emitted by the AI
            # inside <synthi_build_manifest>...</synthi_build_manifest>. May
            # be None if the response didn't contain one (pre-universal
            # prompt, or model failed to emit the block) — worker falls
            # back to hardcoded SDL2 defaults.
            "manifest": manifest_out,
            "lang": req.lang,
            "verified": True,
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
# /refactor/delta and /refactor/structural were REMOVED.
# ============================================================
#
# Both endpoints were SDL-hardcoded string-match delta paths:
#
# - /refactor/delta update_type="addition" used DELTA_ADDITION_PROMPT
#   which literally told the model to "Translate this X11 code snippet
#   to SDL2" and then spliced the result into the cached split using
#   hardcoded markers (`} AppState;`, `app_state.running = 1;`,
#   `SDL_RenderPresent`, `SDL_MOUSEBUTTONDOWN`). Silently failed half
#   its injections.
#
# - /refactor/delta update_type="deletion" used DELTA_DELETION_PROMPT
#   + apply_deletion_delta to comment out "matching patterns" with
#   `// REMOVED:` prefixes. On Tier 3 fallback, this path corrupted
#   the split by applying deletions to stale baselines while leaving
#   the user's actual additions missing — compile would succeed but
#   the edit never reached the running binary.
#
# - /refactor/structural was a back-compat redirect to /refactor/delta.
#
# All edit kinds — additions, deletions, expression changes, value
# changes — now flow through:
#
#   Tier 1 (handler.rs): pure Rust regex value patcher for value-only
#     edits, 0 AI calls.
#   Tier 2 (handler.rs): /refactor/diff_patch with the cached architecture
#     doc injected into the prompt. The model decides which modules to
#     patch based on the arch doc's "Where User Code Goes" section.
#   Tier 3 (handler.rs): if Tier 2 fails, fall through to
#     /refactor/split/verified for a full re-split. No cheap cache levels
#     in perform_ai_split — they were removed too.


class DiffPatchRequest(BaseModel):
    """Request for AI-powered diff patching of split modules.

    As of the classify-removal refactor, there is only one mode: full
    diff-patch with the cached architecture hint. The model receives all
    three module contents + the user's diff + the architecture doc +
    the priority rule, and returns updated content for whichever modules
    changed. The previous targeted-mode optimization (pick ONE module
    via an AI classifier, then send only that module) was removed —
    classify was costing ~4s per edit for a lite call, which exceeded
    the time saved by the smaller targeted prompt. One AI call per
    edit, no classifier, no silent drops on classifier timeout.
    """
    diff: str              # Unified diff of the user's source changes
    core_content: str = ""
    gui_content: str = ""
    shared_content: str = ""
    # Cached split architecture doc (markdown) — captured at initial
    # /refactor/split/verified time and re-injected here so the model
    # does not have to re-derive the module contract on every edit.
    # Empty string → fall back to the generic prompt (no regression).
    architecture: Optional[str] = None
    model: Optional[str] = None
    api_key: Optional[str] = None


# ══════════════════════════════════════════════════════════════
# Diff-patch prompt builder (full 3-module mode)
# ══════════════════════════════════════════════════════════════
#
# The prompt is assembled in a specific order to exploit the LLM's
# attention bias ("lost in the middle" — models attend most to
# start + end of the context window):
#
#   1. Role + task statement                         ← top
#   2. Generic CRITICAL RULES (file scope, etc.)
#   3. ARCHITECTURE section (cached markdown blob)   ← middle (long)
#   4. CURRENT core / gui / shared contents
#   5. PRIORITY RULE                                 ← bottom (recency boost)
#   6. DIFF (user's raw source changes)              ← last thing before generation
#   7. Output format instruction
#
# Putting the PRIORITY RULE immediately above the DIFF ensures it is
# the LAST instruction the model reads before generating output. This
# matters because the architecture cache is a HINT and can be stale
# (user renamed a variable mid-session) — the priority rule reminds
# the model to treat the diff as ground truth.
#
# The architecture doc itself tells the model which module to patch
# ("Where User Code Goes: rendering → gui_on_render" etc.), so the
# model does its own routing — we don't need an external classifier.

_DIFF_PATCH_ARCH_HEADER = (
    "ARCHITECTURE (cached from the initial split — describes how this\n"
    "project's split modules are organized):"
)

_DIFF_PATCH_PRIORITY_RULE = """PRIORITY RULE (read this carefully):
The ARCHITECTURE section above was captured at initial split time. It
describes how the ORIGINAL source's variables were relocated into the
split modules. It is a HINT, not ground truth.

If the user's DIFF (below) explicitly:
  - renames a variable (e.g. changes `r` to `main_renderer`)
  - redefines a type
  - restructures a function
  - introduces new fields or functions
...then the DIFF is authoritative. Follow the diff. Do NOT apply stale
mappings to references that no longer match the original form. The
cached mapping only applies to references that remain UNCHANGED from
the original source."""


def _build_full_diff_patch_prompt(req: DiffPatchRequest) -> str:
    """Assemble the full 3-module diff_patch prompt in edit-list format.

    Instead of asking the model to regenerate full updated module files
    (~2500-4000 output tokens per edit), we ask for a list of structured
    edits — anchor + operation + content — which Rust applies locally
    via `hmr::edit_applier::apply_edit`. Output tokens drop from ~3000
    to ~100, which cuts pro-model generation time from ~30s to ~1s.

    When `req.architecture` is empty, the ARCHITECTURE + PRIORITY_RULE
    blocks are omitted and the prompt degrades to the generic form —
    no regression for pre-migration sidecars that don't have a cached
    architecture yet.
    """
    parts: List[str] = [
        "You are generating EDIT INSTRUCTIONS for a SPLIT multi-module project.",
        "Return a JSON object with an `edits` array. The Rust worker will apply",
        "each edit locally by searching the current module content for `anchor`",
        "and performing `operation` at that location. You do NOT return full",
        "file contents — only the edits needed.",
        "",
        "CRITICAL RULES — these apply to any language/framework:",
        "",
        "1. The target files (core, gui, shared) are SPLIT modules, NOT standalone",
        "   programs. They may not have a main entrypoint and they export specific",
        "   lifecycle functions (e.g. *_on_load, *_on_update, *_on_render, etc.).",
        "   STUDY the current module contents below to identify each file's",
        "   existing function signatures — those are your template.",
        "",
        "2. The diff comes from the user's ORIGINAL source file, which may use raw",
        "   idioms (local variables, inline entrypoint, direct API references). You",
        "   must ADAPT those references to fit the split modules' existing structure:",
        "     - Local variables in the original source usually live on a shared state",
        "       object in the split modules. Look at the existing code to see how",
        "       state is accessed (e.g. a cast like `State* s = (State*)state_ptr;`)",
        "       and follow the same pattern.",
        "     - API handles (renderer, window, audio, etc.) are typically stored on",
        "       the state object — use the same field names the existing code uses.",
        "",
        "3. DECIDE which module(s) each diff hunk belongs to. The ARCHITECTURE",
        "   section below tells you the routing rules — use its 'Where User Code",
        "   Goes' section as the authoritative mapping. Each edit in your output",
        "   must set the `module` field to one of `core`, `gui`, or `shared`.",
        "",
        "4. Do NOT emit edits that paste the diff verbatim at file scope (would cause",
        "   declaration errors in C/C++ or top-level errors in Python/JS/Rust).",
        "   Do NOT redeclare existing variables, add duplicate entrypoints, or",
        "   create new top-level functions unless the existing file's convention",
        "   demands it. Your edits should merge the change into an existing",
        "   function body, or add to an existing struct definition, etc.",
        "",
    ]

    arch = (req.architecture or "").strip()
    if arch:
        parts += [_DIFF_PATCH_ARCH_HEADER, "", arch, ""]

    parts += [
        "CURRENT core module content:",
        "```",
        req.core_content or "",
        "```",
        "",
        "CURRENT gui module content:",
        "```",
        req.gui_content or "",
        "```",
        "",
        "CURRENT shared module content:",
        "```",
        req.shared_content or "",
        "```",
        "",
    ]

    if arch:
        # Priority rule sits AFTER the architecture + module contents and
        # immediately before the diff — last thing the model reads before
        # generating. Mitigates the "lost in the middle" effect.
        parts += [_DIFF_PATCH_PRIORITY_RULE, ""]

    parts += [
        "DIFF (from user's source — use as INTENT, apply the priority rule above):",
        "```",
        req.diff,
        "```",
        "",
        "# OUTPUT FORMAT",
        "",
        "Return a single JSON object with an `edits` array. Each edit has:",
        "",
        '  - `module`:    "core" | "gui" | "shared"',
        '  - `operation`: "insert_after" | "insert_before" | "replace" | "delete"',
        "  - `anchor`:    an EXACT substring of the current module content that",
        "                 locates the edit. Rust will call `content.find(anchor)`.",
        "                 The anchor MUST appear EXACTLY ONCE in the module — if",
        "                 it is missing or ambiguous the whole edit fails and we",
        "                 fall back to a full re-split. Include enough surrounding",
        "                 context (usually 1-3 lines, or a full statement) to make",
        "                 the anchor unique. Whitespace is preserved — copy the",
        "                 anchor verbatim from the current content above.",
        "  - `content`:   the new text. For insert_after / insert_before this is",
        "                 the code to insert. For replace this is what replaces",
        "                 the anchor. For delete this is ignored (use an empty",
        "                 string). Preserve the surrounding indentation style.",
        "",
        "Operations:",
        "  - insert_after:  put `content` immediately AFTER the anchor",
        "  - insert_before: put `content` immediately BEFORE the anchor",
        "  - replace:       replace the anchor with `content`",
        "  - delete:        remove the anchor (content ignored)",
        "",
        "If no changes are needed, return `{\"edits\": []}`.",
        "",
        "# EXAMPLE",
        "",
        "Suppose the diff adds a red button after an existing blue button. The",
        "current gui module contains:",
        "",
        "```",
        "    SDL_Rect btn1 = {50, 50, 200, 60};",
        "    SDL_SetRenderDrawColor(state->renderer, 60, 120, 220, 255);",
        "    SDL_RenderFillRect(state->renderer, &btn1);",
        "```",
        "",
        "A correct output would be:",
        "",
        "```",
        "{",
        '  "edits": [',
        "    {",
        '      "module": "gui",',
        '      "operation": "insert_after",',
        '      "anchor": "SDL_RenderFillRect(state->renderer, &btn1);",',
        '      "content": "\\n\\n    SDL_Rect btn2 = {50, 130, 200, 60};\\n    SDL_SetRenderDrawColor(state->renderer, 220, 60, 60, 255);\\n    SDL_RenderFillRect(state->renderer, &btn2);"',
        "    }",
        "  ]",
        "}",
        "```",
        "",
        "Return ONLY the JSON object. No markdown fences, no prose, no explanation.",
    ]
    return "\n".join(parts)


_VALID_EDIT_OPS = {"insert_after", "insert_before", "replace", "delete"}
_VALID_EDIT_MODULES = {"core", "gui", "shared"}


def _validate_edit_list(edits: object) -> List[dict]:
    """Validate that the AI returned a well-formed list of edits.

    Raises HTTPException(400) on any shape mismatch. Returns a cleaned
    list with only the expected fields so the Rust worker's serde
    deserializer sees exactly the schema it expects.
    """
    if not isinstance(edits, list):
        raise HTTPException(
            status_code=400,
            detail=f"`edits` must be a JSON array, got {type(edits).__name__}",
        )
    cleaned: List[dict] = []
    for i, e in enumerate(edits):
        if not isinstance(e, dict):
            raise HTTPException(
                status_code=400,
                detail=f"edit #{i} must be a JSON object, got {type(e).__name__}",
            )
        module = e.get("module")
        op = e.get("operation")
        anchor = e.get("anchor")
        content = e.get("content", "")
        if module not in _VALID_EDIT_MODULES:
            raise HTTPException(
                status_code=400,
                detail=f"edit #{i}: `module` must be one of {_VALID_EDIT_MODULES}, got {module!r}",
            )
        if op not in _VALID_EDIT_OPS:
            raise HTTPException(
                status_code=400,
                detail=f"edit #{i}: `operation` must be one of {_VALID_EDIT_OPS}, got {op!r}",
            )
        if not isinstance(anchor, str) or not anchor:
            raise HTTPException(
                status_code=400,
                detail=f"edit #{i}: `anchor` must be a non-empty string",
            )
        if not isinstance(content, str):
            raise HTTPException(
                status_code=400,
                detail=f"edit #{i}: `content` must be a string (use empty string for delete)",
            )
        cleaned.append({
            "module": module,
            "operation": op,
            "anchor": anchor,
            "content": content,
        })
    return cleaned


@app.post("/refactor/diff_patch")
async def refactor_diff_patch(req: DiffPatchRequest):
    """
    Apply a source diff to split module files using AI — edit-list format.

    The model returns a JSON object:
        {"edits": [{"module": "gui", "operation": "insert_after", ...}, ...]}

    Rust's hmr::edit_applier applies each edit locally by searching the
    current module content for the anchor. This format makes the output
    ~100 tokens instead of ~3000, dropping pro-model generation time from
    ~30s to ~1s.
    """
    start_time = time.time()

    provider = get_provider(provider_name='gemini', use_custom=bool(req.api_key))
    prompt = _build_full_diff_patch_prompt(req)
    if req.architecture and req.architecture.strip():
        print(f"[DiffPatch] architecture hint ({len(req.architecture)} chars) injected into prompt")
    else:
        print(f"[DiffPatch] no architecture hint (fallback to generic prompt)")

    try:
        ai_response = await provider.ask_llm(
            prompt,
            "cpp",
            None,
            mode="delta",
            # Pro for diff patches — we want high-quality anchor selection
            # and correct merging into split-module conventions. With the
            # edit-list output format, the pro-call output is short
            # (~100 tokens) so this is 1-2s of generation, not 30.
            model=req.model or "gemini-3.1-flash-lite-preview",
            api_key=req.api_key,
        )

        print(f"[DiffPatch] AI response:\n{ai_response[:500]}")

        # Parse JSON from response
        result_str = ai_response.strip()
        if "```json" in result_str:
            result_str = result_str.split("```json")[1].split("```")[0].strip()
        elif "```" in result_str:
            result_str = result_str.split("```")[1].split("```")[0].strip()

        parsed = json.loads(result_str)
        if not isinstance(parsed, dict):
            raise HTTPException(
                status_code=400,
                detail=f"AI response must be a JSON object, got {type(parsed).__name__}",
            )

        edits = _validate_edit_list(parsed.get("edits", []))

        elapsed = time.time() - start_time
        module_counts: dict = {}
        for e in edits:
            module_counts[e["module"]] = module_counts.get(e["module"], 0) + 1
        print(
            f"[DiffPatch] completed in {elapsed:.2f}s, {len(edits)} edit(s): {module_counts}"
        )

        return {
            "edits": edits,
            "elapsed_seconds": elapsed,
        }

    except json.JSONDecodeError as e:
        print(f"[DiffPatch] JSON parse error: {e}")
        raise HTTPException(status_code=400, detail=f"Failed to parse AI patch response: {e}")
    except HTTPException:
        raise
    except Exception as e:
        print(f"[DiffPatch] Error: {e}")
        raise HTTPException(status_code=400, detail=str(e))


# NOTE: /classify/edit endpoint + ClassifyEditRequest were removed.
# The endpoint ran an AI call (gemini-3.1-flash-lite-preview) to tell the
# Rust worker which module (core/gui/shared) a diff hunk belonged to.
# In practice it was costing ~4s per edit (network latency + Google API
# TTFT + Python SDK overhead), which exceeded the time saved by using a
# targeted single-module diff_patch prompt instead of a full 3-module
# one. And when classify timed out, the Tier 2 loop silently dropped
# the edit because hunks stayed EditTarget::Unknown.
#
# Net latency of classify + targeted (~10-12s/edit) was WORSE than
# full diff_patch with arch hint (~6-8s/edit). The architecture cache
# gives the full diff_patch prompt all the routing info it needs via
# the "Where User Code Goes" section, so the AI does its own routing
# without an external classifier. One call per edit, no silent drops,
# no hardcoded identifier-prefix heuristics.
#
# See commit message history / the architecture plan file for details.


class HealRequest(BaseModel):
    """Request for AI-powered compilation error healing."""
    module_name: str          # "core", "gui", or "shared"
    module_content: str       # the broken code
    error_messages: str       # compiler stderr / JSON diagnostics
    shared_content: str = ""  # context: shared header
    # Cached split architecture doc (markdown). Injected into the heal
    # prompt so project-specific "don'ts" (e.g. forbidden patterns)
    # come from the arch cache instead of hardcoded language-specific
    # rules in the prompt itself. Empty string → generic prompt.
    architecture: Optional[str] = None
    language: str = "cpp"     # defaults to cpp for back-compat


@app.post("/refactor/heal")
async def refactor_heal(req: HealRequest):
    """
    Fix a compilation error in AI-generated module code.

    The AI split produced code that doesn't compile. Instead of regex
    guardrails, we send the compiler error + the broken code to the
    AI and let it fix the specific error. Fast (~1-2s) because context
    is tiny. Project-specific restrictions come from the cached split
    architecture doc, not hardcoded prompt rules.
    """
    start_time = time.time()

    provider = get_provider(provider_name='gemini', use_custom=False)

    prompt = format_heal_prompt(
        module=req.module_name,
        code=req.module_content,
        errors=req.error_messages,
        shared=req.shared_content,
        architecture=req.architecture or "",
        language=req.language or "cpp",
    )
    if req.architecture and req.architecture.strip():
        print(f"[Heal] architecture hint ({len(req.architecture)} chars) injected into prompt")

    try:
        ai_response = await provider.ask_llm(
            prompt,
            "cpp",
            None,
            mode="delta",
            model="gemini-3.1-flash-lite-preview",
        )

        # Strip markdown fences if present
        result = ai_response.strip()
        if result.startswith("```cpp"):
            result = result[6:]
        elif result.startswith("```"):
            result = result[3:]
        if result.endswith("```"):
            result = result[:-3]
        result = result.strip()

        elapsed = time.time() - start_time
        print(f"[Heal] {req.module_name} fixed in {elapsed:.2f}s")

        return {
            "result": {"content": result},
            "elapsed_seconds": elapsed,
        }

    except Exception as e:
        print(f"[Heal] Error: {e}")
        raise HTTPException(status_code=400, detail=str(e))


# =============================================================================
# Code Intelligence Module - Context-aware code understanding
# =============================================================================
try:
    from code_intel.api import router as code_intel_router
    app.include_router(code_intel_router)
    logger.info("Code Intelligence module loaded")
except ImportError as e:
    logger.warning(f"Code Intelligence module not available: {e}")


# =============================================================================
# Self-Healing System
# =============================================================================
from analyzer.proactive.healing import SelfHealingEngine, HealingConfig
from analyzer.proactive.healing.engine import get_healing_engine

class HealingAnalyzeRequest(BaseModel):
    """Request for self-healing analysis."""
    code: str
    lang: str
    file_path: Optional[str] = "untitled"
    auto_apply: Optional[bool] = False  # Whether to auto-apply safe fixes


class HealingApplyRequest(BaseModel):
    """Request to apply specific healing fixes."""
    code: str
    lang: str
    file_path: Optional[str] = "untitled"
    fix_ids: Optional[List[str]] = None  # Specific fix IDs to apply (None = all safe)


class HealingConfigUpdateRequest(BaseModel):
    """Request to update healing configuration."""
    enabled: Optional[bool] = None
    min_confidence: Optional[float] = None
    max_fixes_per_pass: Optional[int] = None
    cooldown_ms: Optional[int] = None
    debounce_ms: Optional[int] = None
    auto_apply_safe: Optional[bool] = None
    auto_heal_categories: Optional[List[str]] = None


@app.post("/heal/analyze")
async def heal_analyze(req: HealingAnalyzeRequest):
    """
    Analyze code for auto-healable micro-issues.
    
    Returns detected fixes without applying them.
    If auto_apply is True, also returns the healed code.
    """
    engine = get_healing_engine()
    
    try:
        result = await engine.analyze(
            code=req.code,
            language=req.lang.lower(),
            file_path=req.file_path or "untitled",
        )
        
        response = result.to_dict()
        
        # Optionally auto-apply safe fixes
        if req.auto_apply and result.safe_fixes:
            healed_code, applied = engine.apply_safe_fixes(req.code, result)
            response["healedCode"] = healed_code
            response["appliedFixes"] = [f.to_dict() for f in applied]
            response["wasHealed"] = len(applied) > 0
        else:
            response["wasHealed"] = False
        
        return response
    except Exception as e:
        logger.error(f"[Healing] Analysis error: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/heal/apply")
async def heal_apply(req: HealingApplyRequest):
    """
    Apply healing fixes to code.
    
    Can apply all safe fixes or specific fix IDs.
    """
    engine = get_healing_engine()
    
    try:
        # First analyze to get current fixes
        result = await engine.analyze(
            code=req.code,
            language=req.lang.lower(),
            file_path=req.file_path or "untitled",
        )
        
        if req.fix_ids:
            # Apply specific fixes
            fix_map = {f.fix_id: f for f in result.fixes}
            fixes_to_apply = [fix_map[fid] for fid in req.fix_ids if fid in fix_map]
        else:
            # Apply all safe fixes
            fixes_to_apply = result.safe_fixes
        
        # Apply fixes bottom-up
        code = req.code
        applied = []
        for fix in sorted(fixes_to_apply, key=lambda f: (f.line, f.column), reverse=True):
            try:
                code = engine.apply_fix(code, fix)
                applied.append(fix)
            except Exception as e:
                logger.warning(f"[Healing] Fix application error: {e}")
        
        return {
            "healedCode": code,
            "appliedFixes": [f.to_dict() for f in applied],
            "appliedCount": len(applied),
            "contentHash": result.content_hash,
        }
    except Exception as e:
        logger.error(f"[Healing] Apply error: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/heal/container")
async def heal_container(req: ContainerAnalysisRequest):
    """
    Container-first healing: fetch content from container filesystem
    and analyze for auto-healable issues.
    """
    engine = get_healing_engine()
    
    try:
        content = await fetch_file_from_container(req.slug, req.file_path)
        if content is None:
            raise HTTPException(status_code=404, detail=f"File not found: {req.file_path}")
        
        result = await engine.analyze(
            code=content,
            language=req.lang.lower(),
            file_path=req.file_path,
        )
        
        response = result.to_dict()
        
        # Auto-apply safe fixes for container mode
        if result.safe_fixes:
            healed_code, applied = engine.apply_safe_fixes(content, result)
            response["healedCode"] = healed_code
            response["appliedFixes"] = [f.to_dict() for f in applied]
            response["wasHealed"] = len(applied) > 0
        else:
            response["wasHealed"] = False
        
        return response
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"[Healing] Container analysis error: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/heal/config")
async def get_heal_config():
    """Get current healing configuration."""
    engine = get_healing_engine()
    return engine.config.to_dict()


@app.post("/heal/config")
async def update_heal_config(req: HealingConfigUpdateRequest):
    """Update healing configuration."""
    engine = get_healing_engine()
    
    updates = {}
    if req.enabled is not None:
        updates["enabled"] = req.enabled
    if req.min_confidence is not None:
        updates["min_confidence"] = req.min_confidence
    if req.max_fixes_per_pass is not None:
        updates["max_fixes_per_pass"] = req.max_fixes_per_pass
    if req.cooldown_ms is not None:
        updates["cooldown_ms"] = req.cooldown_ms
    if req.debounce_ms is not None:
        updates["debounce_ms"] = req.debounce_ms
    if req.auto_apply_safe is not None:
        updates["auto_apply_safe"] = req.auto_apply_safe
    
    engine.update_config(**updates)
    return engine.config.to_dict()


@app.get("/heal/stats")
async def get_heal_stats():
    """Get healing system statistics."""
    engine = get_healing_engine()
    return engine.stats.to_dict()


@app.get("/heal/rules")
async def list_heal_rules():
    """List all registered healing rules."""
    from analyzer.proactive.healing.rule_registry import get_registry
    registry = get_registry()
    return {
        "rules": [
            {
                "ruleId": rule.rule_id,
                "category": rule.category.value,
                "languages": list(rule.languages),
                "description": rule.description,
                "enabled": rule.enabled,
            }
            for rule in registry.list_rules()
        ],
        "totalRules": registry.rule_count,
        "enabledRules": registry.enabled_rule_count,
    }


@app.post("/heal/batch")
async def batch_heal(payload: dict):
    """Batch analyse multiple files at once."""
    from analyzer.proactive.healing.batch_engine import BatchHealingEngine, BatchFileEntry
    from analyzer.proactive.healing.engine import get_healing_engine

    files = payload.get("files", [])
    if not files:
        return {"error": "No files provided"}

    entries = [
        BatchFileEntry(
            file_path=f["filePath"],
            language=f["language"],
            code=f["code"],
            priority=f.get("priority", 0),
        )
        for f in files
    ]

    batch_engine = BatchHealingEngine(engine=get_healing_engine())
    result = await batch_engine.analyze_batch(entries)

    return {
        "totalFiles": result.total_files,
        "analyzedFiles": result.analyzed_files,
        "totalFixes": result.total_fixes,
        "autoFixable": result.auto_fixable,
        "skippedFiles": result.skipped_files,
        "elapsedMs": round(result.elapsed_ms, 1),
        "files": {
            path: {
                "fixes": len(hr.fixes),
                "autoFixable": hr.auto_fixable_count,
                "fixDetails": [
                    {
                        "ruleId": f.rule_id,
                        "category": f.category.value,
                        "severity": f.severity.value,
                        "description": f.description,
                        "line": f.line,
                        "isSafe": f.is_safe,
                    }
                    for f in hr.fixes
                ],
            }
            for path, hr in result.file_results.items()
        },
        "errors": result.errors,
    }


@app.get("/heal/cache/stats")
async def heal_cache_stats():
    """Get healing cache statistics."""
    from analyzer.proactive.healing.engine import get_healing_engine
    engine = get_healing_engine()
    return engine._cache.stats


@app.get("/heal/presets")
async def list_heal_presets():
    """List all available healing configuration presets."""
    from analyzer.proactive.healing.config_schema import list_presets, get_preset
    presets = list_presets()
    return {
        "presets": {
            name: get_preset(name) for name in presets
        },
        "available": presets,
    }


@app.post("/heal/preset")
async def apply_heal_preset(payload: dict):
    """Apply a named healing configuration preset."""
    from analyzer.proactive.healing.config_schema import get_preset as fetch_preset
    from analyzer.proactive.healing.engine import get_healing_engine

    name = payload.get("preset")
    if not name:
        raise HTTPException(status_code=400, detail="Missing 'preset' field")

    preset = fetch_preset(name)
    if not preset:
        raise HTTPException(status_code=404, detail=f"Unknown preset: {name}")

    engine = get_healing_engine()
    engine.update_config(**preset)
    return {
        "applied": name,
        "config": engine.config.to_dict(),
    }


@app.get("/heal/metrics")
async def heal_metrics():
    """Get Prometheus-compatible healing metrics."""
    from analyzer.proactive.healing.metrics_export import HealingMetrics
    from analyzer.proactive.healing.engine import get_healing_engine
    from fastapi.responses import PlainTextResponse

    engine = get_healing_engine()
    metrics = HealingMetrics(
        rules_executed_total=engine.stats.get("rulesExecuted", 0),
        fixes_detected_total=engine.stats.get("totalDetected", 0),
        fixes_applied_total=engine.stats.get("totalApplied", 0),
        active_rules_count=engine.stats.get("activeRules", 0),
    )
    return PlainTextResponse(content=metrics.to_prometheus(), media_type="text/plain")


# =============================================================================
# AI Agent Endpoints (LLM-powered error detection)
# =============================================================================

class AIAnalyzeRequest(BaseModel):
    """Request for AI-powered code analysis."""
    code: str
    lang: str
    file_path: Optional[str] = "untitled"
    workspace_root: Optional[str] = None
    auto_apply: Optional[bool] = False
    focus_start_line: Optional[int] = None
    focus_end_line: Optional[int] = None
    validate_fixes: Optional[bool] = True
    min_confidence: Optional[float] = None


class AIBatchRequest(BaseModel):
    """Request for AI batch analysis across multiple files."""
    files: Dict[str, str]  # path -> source code
    lang: Optional[str] = None
    auto_apply: Optional[bool] = False


class AIHybridRequest(BaseModel):
    """Request for hybrid (regex + AI) analysis."""
    code: str
    lang: str
    file_path: Optional[str] = "untitled"
    workspace_root: Optional[str] = None
    auto_apply: Optional[bool] = False


class RuntimeErrorDiagnostic(BaseModel):
    """A single compiler/runtime diagnostic."""
    severity: Optional[str] = "error"
    message: str
    code: Optional[str] = None
    location: Optional[Dict[str, Any]] = None
    codeSnippet: Optional[str] = None
    snippetStartLine: Optional[int] = None
    suggestions: Optional[List[Dict[str, str]]] = None
    related: Optional[List[Dict[str, Any]]] = None


class AIRuntimeErrorRequest(BaseModel):
    """Request for runtime/compile error fixing via AI.
    
    This is the core of HMR runtime healing: the compiler reported
    errors, and we need the AI to fix them.
    """
    code: str
    lang: str
    file_path: Optional[str] = "untitled"
    diagnostics: List[RuntimeErrorDiagnostic]
    error_output: Optional[str] = None
    auto_apply: Optional[bool] = True  # default True for runtime healing
    module: Optional[str] = None  # HMR module identifier


@app.post("/heal/ai/analyze")
async def heal_ai_analyze(req: AIAnalyzeRequest):
    """
    Analyze code using the AI agent (LLM-powered detection).
    
    Sends code to the LLM which identifies real bugs:
    logic errors, null safety, missing awaits, off-by-one, etc.
    
    Slower than regex (~5-30s) but catches real issues.
    """
    engine = get_healing_engine()
    
    focus_range = None
    if req.focus_start_line is not None and req.focus_end_line is not None:
        focus_range = (req.focus_start_line, req.focus_end_line)
    
    try:
        result = await engine.analyze_with_ai(
            code=req.code,
            language=req.lang.lower(),
            file_path=req.file_path or "untitled",
            workspace_root=req.workspace_root,
            focus_range=focus_range,
        )
        
        response = result.to_dict()
        response["source"] = "ai_agent"
        
        if req.auto_apply and result.safe_fixes:
            healed_code, applied = engine.apply_safe_fixes(req.code, result)
            response["healedCode"] = healed_code
            response["appliedFixes"] = [f.to_dict() for f in applied]
            response["wasHealed"] = len(applied) > 0
        else:
            response["wasHealed"] = False
        
        return response
    except Exception as e:
        logger.error(f"[AI Healing] Analysis error: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/heal/ai/runtime")
async def heal_ai_runtime_error(req: AIRuntimeErrorRequest):
    """
    Fix compiler/runtime errors using the AI agent.
    
    This is the HMR runtime healing endpoint. When the compiler or
    runtime reports errors (compile-error, type-error, etc.), the
    frontend sends the diagnostics here. The AI reads the exact error
    messages and source code, then produces targeted fixes.
    
    Unlike /heal/ai/analyze (which asks the LLM to *find* bugs),
    this endpoint says "the compiler reported THESE errors — fix them."
    
    The response includes healed code ready to be written back to the
    file so HMR can re-trigger.
    """
    engine = get_healing_engine()
    agent = engine._get_ai_agent()
    
    # Convert Pydantic diagnostics to plain dicts for the prompt builder
    diag_dicts = [d.model_dump() for d in req.diagnostics]
    
    try:
        fixes = await agent.detect_runtime_errors(
            file_path=req.file_path or "untitled",
            source_code=req.code,
            diagnostics=diag_dicts,
            language=req.lang.lower(),
            error_output=req.error_output,
        )
        
        response = {
            "source": "runtime_error_agent",
            "filePath": req.file_path,
            "module": req.module,
            "fixes": [_fix_to_dict(f) for f in fixes],
            "fixCount": len(fixes),
            "diagnosticCount": len(req.diagnostics),
            "wasHealed": False,
            "healedCode": None,
            "appliedFixes": [],
        }
        
        # Auto-apply: apply all fixes that are safe
        if req.auto_apply and fixes:
            from analyzer.proactive.healing.types import HealingResult
            temp_result = HealingResult(
                file_path=req.file_path or "untitled",
                language=req.lang.lower(),
                content_hash="",
                fixes=fixes,
            )
            # For runtime errors, lower the safety threshold —
            # compiler-confirmed errors are real.
            safe_fixes = [f for f in fixes if f.confidence >= 0.7]
            if safe_fixes:
                temp_result_safe = HealingResult(
                    file_path=req.file_path or "untitled",
                    language=req.lang.lower(),
                    content_hash="",
                    fixes=safe_fixes,
                )
                healed_code, applied = engine.apply_safe_fixes(
                    req.code, temp_result_safe
                )
                response["healedCode"] = healed_code
                response["appliedFixes"] = [_fix_to_dict(f) for f in applied]
                response["wasHealed"] = len(applied) > 0
        
        logger.info(
            f"[Runtime Healing] {req.file_path}: "
            f"{len(req.diagnostics)} diagnostics → {len(fixes)} fixes, "
            f"healed={response['wasHealed']}"
        )
        
        return response
    except Exception as e:
        logger.error(f"[Runtime Healing] Error: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/heal/ai/batch")
async def heal_ai_batch(req: AIBatchRequest):
    """
    Analyze multiple files using the AI agent in a single LLM call.
    """
    engine = get_healing_engine()
    agent = engine._get_ai_agent()
    
    try:
        results = await agent.detect_batch(
            files=req.files,
            language=req.lang,
        )
        
        response = {
            "source": "ai_agent",
            "results": {},
        }
        
        for path, fixes in results.items():
            file_result = {
                "filePath": path,
                "fixes": [_fix_to_dict(f) for f in fixes],
                "fixCount": len(fixes),
            }
            
            if req.auto_apply and fixes:
                source = req.files.get(path, "")
                from analyzer.proactive.healing.types import HealingResult
                temp_result = HealingResult(
                    file_path=path,
                    language=req.lang or "unknown",
                    content_hash="",
                    fixes=fixes,
                )
                healed_code, applied = engine.apply_safe_fixes(source, temp_result)
                file_result["healedCode"] = healed_code
                file_result["appliedFixes"] = [_fix_to_dict(f) for f in applied]
            
            response["results"][path] = file_result
        
        return response
    except Exception as e:
        logger.error(f"[AI Batch] Analysis error: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/heal/ai/hybrid")
async def heal_ai_hybrid(req: AIHybridRequest):
    """
    Run both regex rules AND AI detection, merge results.
    
    Regex rules run first (fast), then AI agent finds deeper issues.
    Results are merged with AI fixes taking priority at overlapping locations.
    """
    engine = get_healing_engine()
    
    try:
        result = await engine.analyze_hybrid(
            code=req.code,
            language=req.lang.lower(),
            file_path=req.file_path or "untitled",
            workspace_root=req.workspace_root,
        )
        
        response = result.to_dict()
        response["source"] = "hybrid"
        
        if req.auto_apply and result.safe_fixes:
            healed_code, applied = engine.apply_safe_fixes(req.code, result)
            response["healedCode"] = healed_code
            response["appliedFixes"] = [f.to_dict() for f in applied]
            response["wasHealed"] = len(applied) > 0
        else:
            response["wasHealed"] = False
        
        return response
    except Exception as e:
        logger.error(f"[Hybrid Healing] Analysis error: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/heal/ai/stats")
async def heal_ai_stats():
    """Get AI agent statistics: LLM calls, latency, acceptance rate, rate limiter."""
    engine = get_healing_engine()
    stats = engine.get_ai_stats()

    # Augment with rate limiter stats
    from analyzer.proactive.healing.ai_rate_limiter import get_rate_limiter
    limiter = get_rate_limiter()
    if isinstance(stats, dict):
        stats["rate_limiter"] = limiter.stats

    # Augment with telemetry snapshot
    from analyzer.proactive.healing.ai_telemetry import get_telemetry
    tel = get_telemetry()
    if isinstance(stats, dict):
        stats["telemetry"] = tel.snapshot()

    # Augment with prompt cache stats
    from analyzer.proactive.healing.ai_prompt_cache import get_prompt_cache
    pcache = get_prompt_cache()
    if isinstance(stats, dict):
        stats["prompt_cache"] = pcache.stats()

    return stats


@app.get("/heal/ai/health")
async def heal_ai_health():
    """
    Health check for the AI healing pipeline.

    Validates that:
    - The LLM provider is configured (GEMINI_API_KEY is set)
    - The rate limiter is functional
    - The memory store is accessible
    - The dependency graph is initialized
    """
    import os
    checks = {}

    # 1. LLM provider
    api_key = os.environ.get("GEMINI_API_KEY", "")
    checks["llm_provider"] = {
        "configured": bool(api_key),
        "provider": "gemini",
        "key_prefix": api_key[:8] + "…" if len(api_key) > 8 else "(not set)",
    }

    # 2. Rate limiter
    from analyzer.proactive.healing.ai_rate_limiter import get_rate_limiter
    try:
        limiter = get_rate_limiter()
        checks["rate_limiter"] = {
            "ok": True,
            **limiter.stats,
        }
    except Exception as e:
        checks["rate_limiter"] = {"ok": False, "error": str(e)}

    # 3. Memory store
    from analyzer.proactive.healing.ai_memory import get_agent_memory
    try:
        memory = get_agent_memory()
        checks["memory"] = {
            "ok": True,
            "patterns": len(memory._pattern_stats) if hasattr(memory, "_pattern_stats") else 0,
            "history_size": len(memory._history) if hasattr(memory, "_history") else 0,
        }
    except Exception as e:
        checks["memory"] = {"ok": False, "error": str(e)}

    # 4. Dependency graph
    from analyzer.proactive.healing.ai_deps import get_dependency_graph
    try:
        graph = get_dependency_graph()
        checks["dep_graph"] = {
            "ok": True,
            **graph.summary(),
        }
    except Exception as e:
        checks["dep_graph"] = {"ok": False, "error": str(e)}

    all_ok = all(
        c.get("ok", c.get("configured", False))
        for c in checks.values()
    )

    return {
        "healthy": all_ok,
        "checks": checks,
    }


@app.post("/heal/ai/stream")
async def heal_ai_stream(req: AIAnalyzeRequest):
    """
    Stream AI analysis results via Server-Sent Events (SSE).
    
    Returns a stream of events:
    - progress: status updates with percentage
    - partial_fix: individual fixes as they're found
    - complete: final result with all fixes
    - error: analysis failed
    """
    from starlette.responses import StreamingResponse
    from analyzer.proactive.healing.ai_streaming import stream_ai_analysis

    return StreamingResponse(
        stream_ai_analysis(
            code=req.code,
            language=req.lang.lower(),
            file_path=req.file_path or "untitled",
            workspace_root=req.workspace_root,
        ),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",
        },
    )


class AIFeedbackRequest(BaseModel):
    """User feedback on an AI-detected fix."""
    rule_id: str
    category: str
    feedback: str  # "accepted", "rejected", "modified", "auto_applied"
    confidence: float
    language: str
    file_path: Optional[str] = None
    description: Optional[str] = None


class AIProjectAnalyzeRequest(BaseModel):
    """Request to analyze a changed file and its dependents."""
    code: str
    lang: str
    file_path: str
    workspace_root: str = ""
    related_files: Optional[Dict[str, str]] = None  # {path: content}
    validate_fixes: bool = True
    min_confidence: Optional[float] = None


class AIConfigUpdate(BaseModel):
    """Dynamic config update for the AI agent."""
    min_confidence: Optional[float] = None
    validate_fixes: Optional[bool] = None
    auto_accept_threshold: Optional[float] = None
    confidence_discount: Optional[float] = None
    max_fixes_per_file: Optional[int] = None
    llm_timeout: Optional[float] = None


@app.get("/heal/ai/config")
async def heal_ai_config_get():
    """Get current AI agent configuration."""
    from analyzer.proactive.healing.ai_agent import AIAgentConfig
    config = AIAgentConfig()
    return {
        "min_confidence": config.min_confidence,
        "validate_fixes": config.validate_fixes,
        "auto_accept_threshold": config.auto_accept_threshold,
        "confidence_discount": config.confidence_discount,
        "max_fixes_per_file": config.max_fixes_per_file,
        "llm_timeout": config.llm_timeout,
        "model": config.model,
    }


@app.put("/heal/ai/config")
async def heal_ai_config_update(req: AIConfigUpdate):
    """
    Update AI agent configuration dynamically.

    Only provided fields are updated; omitted fields keep defaults.
    Note: these changes are per-process and not persisted across restarts.
    """
    from analyzer.proactive.healing.ai_agent import AIAgentConfig
    # Since AIAgentConfig is a dataclass with defaults, we track
    # the live config on the app state.
    if not hasattr(app.state, "_ai_config"):
        app.state._ai_config = AIAgentConfig()

    cfg = app.state._ai_config
    if req.min_confidence is not None:
        cfg.min_confidence = req.min_confidence
    if req.validate_fixes is not None:
        cfg.validate_fixes = req.validate_fixes
    if req.auto_accept_threshold is not None:
        cfg.auto_accept_threshold = req.auto_accept_threshold
    if req.confidence_discount is not None:
        cfg.confidence_discount = req.confidence_discount
    if req.max_fixes_per_file is not None:
        cfg.max_fixes_per_file = req.max_fixes_per_file
    if req.llm_timeout is not None:
        cfg.llm_timeout = req.llm_timeout

    return {
        "updated": True,
        "config": {
            "min_confidence": cfg.min_confidence,
            "validate_fixes": cfg.validate_fixes,
            "auto_accept_threshold": cfg.auto_accept_threshold,
            "confidence_discount": cfg.confidence_discount,
            "max_fixes_per_file": cfg.max_fixes_per_file,
            "llm_timeout": cfg.llm_timeout,
        },
    }


@app.post("/heal/ai/cache/clear")
async def heal_ai_cache_clear():
    """Clear the AI prompt cache (forces fresh LLM calls on next analysis)."""
    from analyzer.proactive.healing.ai_prompt_cache import get_prompt_cache
    cache = get_prompt_cache()
    prev_size = cache.size
    cache.clear()
    return {"cleared": True, "entries_removed": prev_size}


@app.post("/heal/ai/preview")
async def heal_ai_preview(req: AIAnalyzeRequest):
    """
    Preview AI fixes WITHOUT applying them.

    Returns the analysis results along with a simulated diff showing
    what the code would look like after applying all safe fixes.
    Useful for review workflows and diff-preview UIs.
    """
    engine = get_healing_engine()

    try:
        result = await engine.analyze_with_ai(
            code=req.code,
            language=req.lang.lower(),
            file_path=req.file_path or "untitled",
            workspace_root=None,
        )

        response = result.to_dict()
        response["source"] = "ai_preview"

        # Simulate applying all safe fixes to generate a preview
        safe_fixes = result.safe_fixes
        if safe_fixes:
            preview_code = req.code
            for fix in sorted(safe_fixes, key=lambda f: (f.line, f.column), reverse=True):
                try:
                    preview_code = engine.apply_fix(preview_code, fix)
                except Exception:
                    pass
            response["previewCode"] = preview_code
            response["previewFixCount"] = len(safe_fixes)
        else:
            response["previewCode"] = req.code
            response["previewFixCount"] = 0

        response["wasApplied"] = False
        return response
    except Exception as e:
        logger.error(f"[AI Preview] Error: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/heal/ai/project")
async def heal_ai_project(req: AIProjectAnalyzeRequest):
    """
    Analyze a file AND its direct dependents for cross-file issues.

    Uses the dependency graph to identify which files import the target
    file, reads their content, and feeds everything into a single
    batched AI analysis so the LLM can detect issues that span files
    (e.g. wrong argument types, renamed exports, missing fields).
    """
    from analyzer.proactive.healing.ai_deps import get_dependency_graph
    from analyzer.proactive.healing.ai_agent import AIHealingAgent, AIAgentConfig

    graph = get_dependency_graph(req.workspace_root)

    # Register/update the target file in the graph
    graph.add_file(req.file_path, req.code, req.lang.lower())

    # Find files that import this one
    dependents = graph.dependents_of(req.file_path)

    # Build file map for batch analysis
    files = {req.file_path: req.code}

    # Add explicitly provided related files
    if req.related_files:
        for path, content in req.related_files.items():
            if path not in files:
                files[path] = content

    # For dependents not in related_files, we can only flag them
    missing_dependents = [d for d in dependents if d not in files]

    config = AIAgentConfig(
        validate_fixes=req.validate_fixes,
    )
    if req.min_confidence is not None:
        config.min_confidence = req.min_confidence

    agent = AIHealingAgent(config=config)
    result = await agent.detect_batch(files, req.lang.lower())

    return {
        "fixes": result.get("fixes", []),
        "stats": result.get("stats", {}),
        "analyzed_files": list(files.keys()),
        "dependents_found": list(dependents),
        "missing_dependents": missing_dependents,
        "graph_summary": graph.summary(),
    }


@app.post("/heal/ai/feedback")
async def heal_ai_feedback(req: AIFeedbackRequest):
    """
    Record user feedback on an AI-detected fix.
    
    This data is used to adjust future confidence scores:
    patterns the user always rejects get suppressed,
    patterns they accept get boosted.
    """
    from analyzer.proactive.healing.ai_memory import (
        get_agent_memory, FixFeedback, FeedbackType,
    )

    valid_types = {
        FeedbackType.ACCEPTED,
        FeedbackType.REJECTED,
        FeedbackType.MODIFIED,
        FeedbackType.AUTO_APPLIED,
    }
    if req.feedback not in valid_types:
        raise HTTPException(
            status_code=400,
            detail=f"Invalid feedback type: {req.feedback}. "
                   f"Must be one of: {', '.join(valid_types)}",
        )

    memory = get_agent_memory()
    memory.record_feedback(FixFeedback(
        rule_id=req.rule_id,
        category=req.category,
        feedback=req.feedback,
        confidence=req.confidence,
        language=req.language,
        file_path=req.file_path,
        description=req.description,
    ))

    return {"status": "recorded", "rule_id": req.rule_id, "feedback": req.feedback}


@app.get("/heal/ai/memory")
async def heal_ai_memory():
    """Get AI agent memory summary (pattern stats, suppressed patterns)."""
    from analyzer.proactive.healing.ai_memory import get_agent_memory

    memory = get_agent_memory()
    return memory.get_summary()


@app.delete("/heal/ai/memory")
async def heal_ai_memory_clear():
    """Clear AI agent memory (reset all learned patterns)."""
    from analyzer.proactive.healing.ai_memory import get_agent_memory

    memory = get_agent_memory()
    memory.clear()
    return {"status": "cleared"}


# ── AI Policy: Suppression Endpoints ──────────────────────────────────

@app.post("/heal/ai/policy/suppress")
async def heal_ai_policy_suppress(req: dict = Body(...)):
    """
    Record a suppression policy (user preference, NOT model-quality feedback).

    Body: { ruleId, fingerprint?, mode?, reason?, ttl? }
    """
    from analyzer.proactive.healing.ai_policy import get_suppression_policy

    rule_id = req.get("ruleId") or req.get("rule_id")
    if not rule_id:
        raise HTTPException(status_code=400, detail="ruleId is required")

    env = req.get("env", "development")
    workspace_id = req.get("workspaceId") or req.get("workspace_id", "default")

    policy = get_suppression_policy(env=env, workspace_id=workspace_id)
    entry = await policy.suppress(
        rule_id=rule_id,
        fingerprint=req.get("fingerprint"),
        mode=req.get("mode", "fingerprint"),
        reason=req.get("reason"),
        ttl=req.get("ttl"),
    )

    return {
        "status": "suppressed",
        "rule_id": rule_id,
        "mode": entry.mode,
        "suppress_count": entry.suppress_count,
        "escalated": entry.escalated,
    }


@app.post("/heal/ai/policy/unsuppress")
async def heal_ai_policy_unsuppress(req: dict = Body(...)):
    """Remove a suppression for a rule/fingerprint."""
    from analyzer.proactive.healing.ai_policy import get_suppression_policy

    rule_id = req.get("ruleId") or req.get("rule_id")
    if not rule_id:
        raise HTTPException(status_code=400, detail="ruleId is required")

    env = req.get("env", "development")
    workspace_id = req.get("workspaceId") or req.get("workspace_id", "default")

    policy = get_suppression_policy(env=env, workspace_id=workspace_id)
    removed = await policy.unsuppress(
        rule_id=rule_id,
        fingerprint=req.get("fingerprint"),
    )

    return {"status": "unsuppressed" if removed else "not_found", "rule_id": rule_id}


@app.get("/heal/ai/policy")
async def heal_ai_policy_list(req: Request):
    """List all current suppression policies."""
    from analyzer.proactive.healing.ai_policy import get_suppression_policy

    env = req.query_params.get("env", "development")
    workspace_id = req.query_params.get("workspaceId", "default")

    policy = get_suppression_policy(env=env, workspace_id=workspace_id)
    return await policy.summary()


@app.delete("/heal/ai/policy")
async def heal_ai_policy_clear(req: Request):
    """Clear all suppression policies."""
    from analyzer.proactive.healing.ai_policy import get_suppression_policy

    env = req.query_params.get("env", "development")
    workspace_id = req.query_params.get("workspaceId", "default")

    policy = get_suppression_policy(env=env, workspace_id=workspace_id)
    count = await policy.clear()
    return {"status": "cleared", "entries_removed": count}


def _fix_to_dict(fix) -> dict:
    """Helper to convert a HealingFix to a dict."""
    try:
        return fix.to_dict()
    except AttributeError:
        return {
            "line": fix.line,
            "description": fix.description,
            "confidence": fix.confidence,
        }


# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# Agentic Self-Healing API endpoints
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

# ── Diagnosis ─────────────────────────────────────────────────────────

@app.post("/heal/agentic/diagnose")
async def agentic_diagnose(request: Request):
    """Root-cause diagnosis from error text."""
    from analyzer.proactive.healing.diagnosis import get_diagnosis_agent, ErrorSource
    body = await request.json()
    error_text = body.get("errorText", "")
    file_path = body.get("filePath", "")
    language = body.get("language", "")
    source = body.get("source", "compiler")

    try:
        src = ErrorSource(source)
    except ValueError:
        src = ErrorSource.COMPILER

    agent = get_diagnosis_agent()
    graph = agent.diagnose(error_text, file_path, language, src)
    return {"ok": True, "diagnosis": graph.to_dict()}


# ── Repair Episodes ──────────────────────────────────────────────────

@app.post("/heal/agentic/episode/create")
async def create_episode(request: Request):
    """Create a new repair episode."""
    from analyzer.proactive.healing.repair_episode import get_episode_store, RepairEpisode
    body = await request.json()
    store = get_episode_store()
    episode = RepairEpisode(
        file_path=body.get("filePath", ""),
        error_message=body.get("errorMessage", ""),
        language=body.get("language", ""),
    )
    store.add(episode)
    return {"ok": True, "episodeId": episode.episode_id, "state": episode.state.value}


@app.get("/heal/agentic/episode/{episode_id}")
async def get_episode(episode_id: str):
    """Get a repair episode by ID."""
    from analyzer.proactive.healing.repair_episode import get_episode_store
    store = get_episode_store()
    ep = store.get(episode_id)
    if not ep:
        return {"ok": False, "error": "Episode not found"}
    return {"ok": True, "episode": ep.to_dict()}


@app.get("/heal/agentic/episodes")
async def list_episodes():
    """List recent repair episodes."""
    from analyzer.proactive.healing.repair_episode import get_episode_store
    store = get_episode_store()
    return {"ok": True, "episodes": [e.to_dict() for e in store.recent(20)]}


# ── Policy ────────────────────────────────────────────────────────────

@app.post("/heal/agentic/policy/evaluate")
async def evaluate_policy(request: Request):
    """Evaluate a repair action against policy."""
    from analyzer.proactive.healing.policy import get_policy_engine
    body = await request.json()
    engine = get_policy_engine()
    evaluation = engine.evaluate(
        file_path=body.get("filePath", ""),
        language=body.get("language", ""),
        num_files=body.get("numFiles", 1),
        estimated_lines_changed=body.get("estimatedLinesChanged", 0),
        step_types=body.get("stepTypes"),
    )
    return {"ok": True, "evaluation": evaluation.to_dict()}


@app.get("/heal/agentic/policy/status")
async def policy_status():
    """Get current policy engine status."""
    from analyzer.proactive.healing.policy import get_policy_engine
    return {"ok": True, "status": get_policy_engine().status()}


# ── Verification ──────────────────────────────────────────────────────

@app.post("/heal/agentic/verify")
async def verify_fix(request: Request):
    """Run verification pipeline on a fix."""
    from analyzer.proactive.healing.verification import get_verification_pipeline
    body = await request.json()
    pipeline = get_verification_pipeline()
    result = await pipeline.run(
        file_path=body.get("filePath", ""),
        original=body.get("original", ""),
        patched=body.get("patched", ""),
        language=body.get("language", ""),
    )
    return {"ok": True, "verification": result.to_dict()}


@app.post("/heal/agentic/guardrails")
async def check_guardrails(request: Request):
    """Check semantic guardrails on a patch."""
    from analyzer.proactive.healing.verification import get_semantic_guardrails
    body = await request.json()
    guardrails = get_semantic_guardrails()
    result = guardrails.check(
        patched_code=body.get("patched", ""),
        file_path=body.get("filePath", ""),
        original_code=body.get("original", ""),
    )
    return {"ok": True, "guardrails": result}


# ── Telemetry ─────────────────────────────────────────────────────────

@app.get("/heal/agentic/telemetry/calibration")
async def telemetry_calibration():
    """Get calibration table for all rules."""
    from analyzer.proactive.healing.precision_telemetry import get_precision_telemetry
    telem = get_precision_telemetry()
    return {"ok": True, "calibration": telem.get_calibration_table()}


@app.get("/heal/agentic/telemetry/degrading")
async def telemetry_degrading():
    """Get rules with degrading quality."""
    from analyzer.proactive.healing.precision_telemetry import get_precision_telemetry
    telem = get_precision_telemetry()
    return {"ok": True, "degradingRules": telem.get_degrading_rules()}


# ── Runtime healing ───────────────────────────────────────────────────

@app.post("/heal/agentic/runtime/ingest")
async def ingest_runtime_error(request: Request):
    """Ingest a runtime error for healing."""
    from analyzer.proactive.healing.runtime_healing import (
        get_runtime_healing_engine, RuntimeErrorSource, RuntimeErrorSeverity
    )
    body = await request.json()
    engine = get_runtime_healing_engine()

    try:
        source = RuntimeErrorSource(body.get("source", "terminal"))
    except ValueError:
        source = RuntimeErrorSource.TERMINAL

    try:
        severity = RuntimeErrorSeverity(body.get("severity", "error"))
    except ValueError:
        severity = RuntimeErrorSeverity.ERROR

    result = engine.ingest(
        message=body.get("message", ""),
        source=source,
        raw_output=body.get("rawOutput", ""),
        severity=severity,
        workspace_id=body.get("workspaceId", ""),
    )
    return {"ok": True, "result": result.to_dict()}


@app.get("/heal/agentic/runtime/stats")
async def runtime_stats():
    """Get runtime healing stats."""
    from analyzer.proactive.healing.runtime_healing import get_runtime_healing_engine
    return {"ok": True, "stats": get_runtime_healing_engine().stats}


# ── Observability ─────────────────────────────────────────────────────

@app.post("/heal/agentic/observability/error")
async def record_obs_error(request: Request):
    """Record an error for observability."""
    from analyzer.proactive.healing.observability import get_observability_hub
    hub = get_observability_hub()
    trigger = hub.record_error()
    return {"ok": True, "trigger": trigger.to_dict() if trigger else None}


@app.post("/heal/agentic/observability/build")
async def record_obs_build(request: Request):
    """Record a build duration."""
    from analyzer.proactive.healing.observability import get_observability_hub
    body = await request.json()
    hub = get_observability_hub()
    trigger = hub.record_build(body.get("durationSec", 0.0))
    return {"ok": True, "trigger": trigger.to_dict() if trigger else None}


@app.post("/heal/agentic/observability/hmr-failure")
async def record_obs_hmr(request: Request):
    """Record an HMR failure."""
    from analyzer.proactive.healing.observability import get_observability_hub
    body = await request.json()
    hub = get_observability_hub()
    trigger = hub.record_hmr_failure(body.get("filePath", ""))
    return {"ok": True, "trigger": trigger.to_dict() if trigger else None}


@app.get("/heal/agentic/observability/stats")
async def observability_stats():
    """Get observability hub stats."""
    from analyzer.proactive.healing.observability import get_observability_hub
    return {"ok": True, "stats": get_observability_hub().stats}


@app.get("/heal/agentic/observability/triggers")
async def observability_triggers():
    """Get recent triggers."""
    from analyzer.proactive.healing.observability import get_observability_hub
    return {"ok": True, "triggers": get_observability_hub().recent_triggers}


# ── Canary rollouts ──────────────────────────────────────────────────

@app.post("/heal/agentic/canary/create")
async def create_canary(request: Request):
    """Create a canary rollout."""
    from analyzer.proactive.healing.canary import get_canary_engine
    body = await request.json()
    engine = get_canary_engine()
    record = engine.create_rollout(
        canary_files=body.get("canaryFiles", []),
        remaining_files=body.get("remainingFiles", []),
        episode_id=body.get("episodeId", ""),
    )
    return {"ok": True, "rollout": record.to_dict()}


@app.get("/heal/agentic/canary")
async def list_canaries():
    """List canary rollouts."""
    from analyzer.proactive.healing.canary import get_canary_engine
    return {"ok": True, "rollouts": get_canary_engine().list_rollouts()}


@app.get("/heal/agentic/canary/stats")
async def canary_stats():
    """Get canary rollout stats."""
    from analyzer.proactive.healing.canary import get_canary_engine
    return {"ok": True, "stats": get_canary_engine().stats}


# ── Agentic overview ────────────────────────────────────────────────

@app.get("/heal/agentic/status")
async def agentic_status():
    """Combined status of all agentic self-healing subsystems."""
    from analyzer.proactive.healing.repair_episode import get_episode_store
    from analyzer.proactive.healing.policy import get_policy_engine
    from analyzer.proactive.healing.precision_telemetry import get_precision_telemetry
    from analyzer.proactive.healing.runtime_healing import get_runtime_healing_engine
    from analyzer.proactive.healing.observability import get_observability_hub
    from analyzer.proactive.healing.canary import get_canary_engine

    return {
        "ok": True,
        "agentic": {
            "episodes": {"recentCount": len(get_episode_store().recent(10))},
            "policy": get_policy_engine().status(),
            "telemetry": {"degradingRules": get_precision_telemetry().get_degrading_rules()},
            "runtime": get_runtime_healing_engine().stats,
            "observability": get_observability_hub().stats,
            "canary": get_canary_engine().stats,
        },
    }


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
            "code_intelligence",
            "self_healing",
            "agentic_self_healing",
        ],
    }


@app.get("/health")
def health_check():
    """Health check endpoint for service discovery."""
    return {"status": "healthy", "service": "ai-engine"}


if __name__ == "__main__":
    if len(sys.argv) > 1:
        split_file(sys.argv[1])
    else:
        import uvicorn
        # Bind to 0.0.0.0 to allow access from WSL/Containers
        uvicorn.run("main:app", host="0.0.0.0", port=8000, reload=True, timeout_keep_alive=120)
