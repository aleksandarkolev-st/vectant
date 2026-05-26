# PROTOTYPING AI ENGINE WITH PYTHON, LATER SWITCH TO RUST
from __future__ import annotations

from typing import Any, List, Mapping, Optional, Union, Tuple
import re
import requests
import json
import sys
import os
import asyncio
import logging
import hmac
from pathlib import Path, PurePosixPath
from urllib.parse import quote

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
from fastapi.responses import JSONResponse, StreamingResponse
from pydantic import BaseModel
from analyzer import get_analyzer
from analyzer import supported_languages

from llm.providers import get_provider
from llm.prompts import SPLIT_GUI_PROMPT, UNIVERSAL_SPLIT_PROMPT
from llm.structural_prompts import format_heal_prompt
from build_manifest import (
    BuildManifest,
    ManifestRejection,
    internalize_gpu_generated_artifacts,
    normalize_gpu_split_manifest,
    parse_manifest,
    validate_manifest_v1,
    validate_include_link_coverage,
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
from analyzer.proactive.workspace_analyzer import HunkResolutionError
from analyzer.proactive.types import AnalysisRequest, FileContext, Hunk, Severity
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

def _parse_allowed_origins() -> List[str]:
    raw = os.environ.get(
        "AI_ENGINE_ALLOWED_ORIGINS",
        "http://localhost:3000,https://beta.synthi.app",
    )
    return [origin.strip() for origin in raw.split(",") if origin.strip()]


# Add CORS middleware to allow frontend access
app.add_middleware(
    CORSMiddleware,
    allow_origins=_parse_allowed_origins(),
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

AI_ENGINE_AUTH_TOKEN = os.environ.get("AI_BACKEND_AUTH_TOKEN") or os.environ.get("AI_ENGINE_AUTH_TOKEN") or ""
AI_ENGINE_AUTH_DISABLED = (
    os.environ.get("AI_ENGINE_AUTH_DISABLED", "false").lower() == "true"
    and os.environ.get("ENV", "").lower() != "production"
)
AI_ENGINE_PUBLIC_PATHS = {"/health"}


def _extract_bearer_token(value: str) -> str:
    if not value:
        return ""
    parts = value.split(None, 1)
    if len(parts) == 2 and parts[0].lower() == "bearer":
        return parts[1].strip()
    return ""


@app.middleware("http")
async def require_internal_auth(request: Request, call_next):
    if request.method == "OPTIONS" or request.url.path in AI_ENGINE_PUBLIC_PATHS:
        return await call_next(request)
    if AI_ENGINE_AUTH_DISABLED:
        return await call_next(request)
    if not AI_ENGINE_AUTH_TOKEN:
        return JSONResponse(
            {"detail": "AI engine auth token is not configured"},
            status_code=503,
        )

    candidate = (
        request.headers.get("x-synthi-internal-token")
        or _extract_bearer_token(request.headers.get("authorization", ""))
    )
    if not candidate or not hmac.compare_digest(candidate, AI_ENGINE_AUTH_TOKEN):
        return JSONResponse({"detail": "Authentication required"}, status_code=401)
    return await call_next(request)


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
    gpu_arch: Optional[str] = None


MAX_AI_REQUEST_CHARS = int(os.environ.get("AI_ENGINE_MAX_AI_REQUEST_CHARS", "32768"))
_CONTROL_CHARS_RE = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]")
_JAILBREAK_MARKERS = (
    "ignore previous instructions",
    "ignore all previous instructions",
    "developer mode",
    "dan mode",
    "jailbreak",
    "reveal your system prompt",
    "print your system prompt",
)


def _strip_llm_text(value: Optional[str], field_name: str) -> Optional[str]:
    if value is None:
        return value
    if not isinstance(value, str):
        raise HTTPException(status_code=400, detail=f"{field_name} must be a string")

    return _CONTROL_CHARS_RE.sub("", value)


def _sanitize_llm_instructions(value: Optional[str], field_name: str) -> Optional[str]:
    sanitized = _strip_llm_text(value, field_name)
    if sanitized is None:
        return sanitized

    lower = sanitized.lower()
    if any(marker in lower for marker in _JAILBREAK_MARKERS):
        raise HTTPException(status_code=400, detail=f"{field_name} contains disallowed prompt-injection markers")
    return sanitized


def enforce_ai_request_limits(req: AnalyzeAiRequest) -> None:
    req.code = _CONTROL_CHARS_RE.sub("", req.code or "")
    req.prompt = _sanitize_llm_instructions(req.prompt, "prompt")
    req.focus = _strip_llm_text(req.focus, "focus")
    total_chars = len(req.code) + len(req.prompt or "") + len(req.focus or "")

    if req.files:
        for file in req.files:
            file.content = _strip_llm_text(file.content, "files.content") or ""
            if file.path:
                file.path = _strip_llm_text(file.path, "files.path")
            if file.name:
                file.name = _strip_llm_text(file.name, "files.name")
            total_chars += len(file.content) + len(file.path or "") + len(file.name or "")

    if total_chars > MAX_AI_REQUEST_CHARS:
        raise HTTPException(
            status_code=413,
            detail=f"AI analysis request exceeds {MAX_AI_REQUEST_CHARS} characters",
        )


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


def validate_workspace_relative_path(file_path: str) -> str:
    if not isinstance(file_path, str) or not file_path.strip():
        raise ValueError("file_path must be a non-empty workspace-relative path")
    if "\\" in file_path:
        raise ValueError("file_path must use POSIX separators")

    path = PurePosixPath(file_path.strip())
    if path.is_absolute():
        raise ValueError("file_path must be relative")
    if any(part in ("", ".", "..") for part in path.parts):
        raise ValueError("file_path contains an unsafe path segment")

    return path.as_posix()


def encode_workspace_path(file_path: str) -> str:
    safe_path = validate_workspace_relative_path(file_path)
    return "/".join(quote(part, safe="") for part in PurePosixPath(safe_path).parts)


_SAFE_MODULE_FILENAME_RE = re.compile(r"^[A-Za-z0-9_./-]+$")


def resolve_under_workspace(workspace_root: str | Path, relative_path: str) -> Path:
    safe_relative = validate_workspace_relative_path(relative_path)
    if not _SAFE_MODULE_FILENAME_RE.match(safe_relative):
        raise ValueError("path contains unsupported characters")

    root = Path(workspace_root).expanduser().resolve()
    resolved = root.joinpath(*PurePosixPath(safe_relative).parts).resolve()
    try:
        resolved.relative_to(root)
    except ValueError as exc:
        raise ValueError("path escapes workspace root") from exc
    return resolved


async def fetch_file_from_container(slug: str, file_path: str) -> Optional[str]:
    """
    Fetch file content from the collab server (container filesystem).
    This is the Source of Truth for all analysis.
    
    The collab server auto-flushes Y.js changes to disk (150ms debounce),
    so this always returns the latest content.
    """
    import aiohttp
    
    try:
        # Use the /file-content endpoint which reads directly from disk.
        encoded_slug = quote(slug, safe="")
        encoded_path = encode_workspace_path(file_path)
        url = f"{COLLAB_SERVER_URL}/file-content/{encoded_slug}/{encoded_path}"
        
        timeout = aiohttp.ClientTimeout(total=10)
        async with aiohttp.ClientSession(timeout=timeout) as session:
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

    try:
        file_path = validate_workspace_relative_path(req.file_path)
        related_paths = [
            validate_workspace_relative_path(path)
            for path in (req.related_paths or [])
        ]
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))

    # Fetch main file content from container
    content = await fetch_file_from_container(req.slug, file_path)
    if content is None:
        raise HTTPException(status_code=404, detail=f"File not found: {file_path}")
    
    content_hash = hashlib.md5(content.encode()).hexdigest()[:16]
    logger.info(f"[CONTAINER] {file_path} | {len(content)} chars | hash={content_hash}")
    
    # Build file context
    file_context = FileContext(
        path=file_path,
        content=content,
        language=req.lang,
    )
    
    # Fetch related files from container
    related_files = []
    if related_paths:
        for rpath in related_paths:
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

class HunkModel(BaseModel):
    """A line-range replacement, half-open [start_line, end_line)."""
    start_line: int
    end_line: int
    new_lines: List[str]


class FileChangeModel(BaseModel):
    """Represents a file change for incremental analysis."""
    path: str
    content_hash: str
    change_type: str  # "added", "modified", "deleted"
    content: Optional[str] = None
    language: Optional[str] = None
    # Hunk-only optimization. When hunks is provided and content is omitted,
    # the analyzer reconstructs content from a stored baseline whose hash
    # equals base_hash. The post-apply hash is verified against content_hash.
    hunks: Optional[List[HunkModel]] = None
    base_hash: Optional[str] = None


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
            hunks = None
            if cf.hunks is not None:
                hunks = [
                    Hunk(
                        start_line=h.start_line,
                        end_line=h.end_line,
                        new_lines=h.new_lines,
                    )
                    for h in cf.hunks
                ]
            changed_files.append(FileChange(
                path=cf.path,
                content_hash=cf.content_hash,
                change_type=cf.change_type,
                content=cf.content,
                language=cf.language,
                hunks=hunks,
                base_hash=cf.base_hash,
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
    except HunkResolutionError as e:
        # 409 Conflict — frontend should drop its baseline for this path
        # and resend with full content. The structured detail lets the
        # frontend act on the failure without parsing free-text messages.
        raise HTTPException(
            status_code=409,
            detail={
                "error": "hunk_resolution_failed",
                "code": e.code,
                "path": e.path,
                "message": str(e),
            },
        )
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
    enforce_ai_request_limits(req)

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
def split_file(
    file_path: str,
    api_url: str = "http://localhost:8000/refactor/split",
    workspace_root: Optional[str] = None,
):
    root = workspace_root or os.environ.get("SPLIT_WORKSPACE_ROOT") or os.getcwd()
    try:
        source_path = resolve_under_workspace(root, file_path)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))

    if not source_path.exists() or not source_path.is_file():
        print(f"File not found: {file_path}")
        return

    with source_path.open('r') as f:
        content = f.read()
    
    ext = source_path.suffix[1:]
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
    
    print(f"Sending {source_path} to AI for analysis...")
    try:
        response = requests.post(api_url, json=payload, timeout=30)
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
                try:
                    target_path = resolve_under_workspace(root, fname)
                except ValueError as exc:
                    raise HTTPException(status_code=400, detail=f"Unsafe module filename: {exc}")
                target_path.parent.mkdir(parents=True, exist_ok=True)
                print(f"Writing {target_path}...")
                with target_path.open('w') as f:
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
        # return `manifest=None` so the Rust worker uses a generic fallback
        # without inferring framework link flags.
        manifest_parsed: Optional[BuildManifest] = None
        manifest_out: Optional[dict] = None
        if manifest_dict is not None:
            try:
                manifest_parsed = parse_manifest(manifest_dict)
                validate_manifest_v1(manifest_parsed)
                # ULTRAPLAN Phase 4.5: enforce the generic include→link rule
                # against the user's source. This is library-agnostic — it
                # scans the source's #include directives and checks that
                # every non-stdlib header has a corresponding link flag in
                # both runner_link_flags and gui_link_flags, OR is excused
                # via confidence.notes. Catches the common AI flake of
                # producing gui_link_flags=["-lSDL2"] but
                # runner_link_flags=["-lSDL2"] for a project that also
                # includes <fmod.h>, before the manifest reaches the worker.
                validate_include_link_coverage(manifest_parsed, req.code)
                manifest_out = manifest_to_dict(manifest_parsed)
                logger.info(
                    f"[split/verified] manifest parsed "
                    f"(compiler={manifest_parsed.compiler}, "
                    f"hot_reload_mode={manifest_parsed.hot_reload_mode}, "
                    f"confidence={manifest_parsed.confidence.overall})"
                )
            except ManifestRejection as e:
                # V1 can't execute this manifest (multi-step build, unknown
                # compiler, missing link flag for an include, etc.). Surface
                # as HTTP 422 with the actionable error card text (see
                # HMR_AGNOSTIC_ULTRAPLAN.md §5.3).
                tracker.mark_rejected(provenance_id, f"Manifest rejected: {e.message}")
                raise HTTPException(status_code=422, detail=e.message)
            except Exception as e:
                logger.warning(
                    f"[split/verified] manifest validation failed: {e}. "
                    "Proceeding with None (worker will use generic fallback)."
                )
                manifest_out = None
        else:
            logger.info(
                "[split/verified] no <synthi_build_manifest> in response "
                "(pre-universal prompt? worker uses generic fallback)"
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
            # prompt, or model failed to emit the block) — worker uses
            # a generic fallback and does not infer framework link flags.
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


# DiffPatchRequest, the prompt builder, and the edit-list validator now
# live in diff_patch_helpers.py so they can be unit-tested without
# dragging in main.py's full import chain (model clients, telemetry,
# etc.). Re-export them under the existing names so all the call sites
# in this file (the @app.post handler below) need no changes.
from diff_patch_helpers import (  # noqa: E402 — late import is intentional
    DiffPatchRequest,
    build_full_diff_patch_prompt as _build_full_diff_patch_prompt,
    validate_edit_list as _validate_edit_list,
    VALID_EDIT_MODULES as _VALID_EDIT_MODULES,
    VALID_EDIT_OPS as _VALID_EDIT_OPS,
    HealManifestRequest,
    HealManifestResponse,
    VALID_FAILED_MODULES as _VALID_FAILED_MODULES,
    build_manifest_heal_prompt as _build_manifest_heal_prompt,
    parse_heal_manifest_response as _parse_heal_manifest_response,
)
from agents.gpu_detect import detect_project as _detect_gpu_project  # noqa: E402
from agents.kernel_splitter import (  # noqa: E402
    KernelSplitProviderError as _KernelSplitProviderError,
    KernelSplitterError as _KernelSplitterError,
    KernelSplitterUnsupportedProjectError as _KernelSplitterUnsupportedProjectError,
    build_split_retry_prompt as _build_split_retry_prompt,
    run_kernel_splitter as _run_kernel_splitter,
    split_failure_verification as _split_failure_verification,
    split_provider_failure_verification as _split_provider_failure_verification,
    split_agentic_report as _split_agentic_report,
    split_attempt_record as _split_attempt_record,
    split_repair_retry_notes as _split_repair_retry_notes,
)
from agents.gpu_device_mapping import build_device_mapping_report  # noqa: E402
from agents.gpu_launch_indirection import build_launch_indirection_report  # noqa: E402
from agents.gpu_mod_delta import (  # noqa: E402
    GpuDiffPatchRequest,
    build_gpu_diff_patch_retry_prompt as _build_gpu_diff_patch_retry_prompt,
    build_gpu_diff_patch_prompt as _build_gpu_diff_patch_prompt,
    gpu_diff_patch_anchor_failures as _gpu_diff_patch_anchor_failures,
    gpu_diff_patch_content_failures as _gpu_diff_patch_content_failures,
    parse_gpu_diff_response as _parse_gpu_diff_response,
)
from agents.gpu_healer import (  # noqa: E402
    GpuHealRequest,
    build_gpu_heal_prompt as _build_gpu_heal_prompt,
    parse_gpu_heal_response as _parse_gpu_heal_response,
)


def _file_map_from_request(req: AnalyzeAiRequest) -> dict[str, str]:
    files = {}
    for f in req.files or []:
        path = getattr(f, "path", None) or getattr(f, "name", None) or "input.cpp"
        files[path] = f.content
    if req.code:
        files.setdefault(req.focus or "input.cpp", req.code)
    return files


_DEVICE_MAPPING_LOCAL_INCLUDE_RE = re.compile(
    r'^\s*#\s*include\s+"(?P<path>[^"]+)"',
    re.MULTILINE,
)


def _normalize_device_mapping_path(path: str) -> str:
    normalized = str(path).replace("\\", "/")
    while normalized.startswith("./"):
        normalized = normalized[2:]
    parts: list[str] = []
    for part in normalized.split("/"):
        if not part or part == ".":
            continue
        if part == ".." and parts and parts[-1] != "..":
            parts.pop()
        elif part == "..":
            parts.append(part)
        else:
            parts.append(part)
    return "/".join(parts)


def _resolve_device_mapping_include(
    source_path: str,
    include_path: str,
    file_map: Mapping[str, str],
) -> Optional[str]:
    include = _normalize_device_mapping_path(include_path)
    candidates: list[str] = []
    if not include.startswith("/"):
        parent = str(PurePosixPath(source_path).parent)
        if parent == ".":
            parent = ""
        candidates.append(
            _normalize_device_mapping_path(f"{parent}/{include}" if parent else include)
        )
    candidates.append(include)
    for candidate in candidates:
        if candidate in file_map:
            return candidate
    return None


def _expand_device_mapping_local_include_scope(
    scoped_paths: set[str],
    file_map: Mapping[str, str],
) -> set[str]:
    expanded = set(scoped_paths)
    stack = sorted(scoped_paths)
    while stack:
        current = stack.pop()
        source = file_map.get(current)
        if source is None:
            continue
        for match in _DEVICE_MAPPING_LOCAL_INCLUDE_RE.finditer(source):
            resolved = _resolve_device_mapping_include(
                current,
                match.group("path"),
                file_map,
            )
            if resolved and resolved not in expanded:
                expanded.add(resolved)
                stack.append(resolved)
    return expanded


def _device_mapping_source_scope(
    file_map: Mapping[str, str],
    source_context_report: Optional[Mapping[str, Any]],
) -> Mapping[str, str]:
    if not isinstance(source_context_report, Mapping):
        return file_map

    scoped_paths: set[str] = set()
    for section in ("included", "criticalDropped"):
        items = source_context_report.get(section)
        if not isinstance(items, list):
            continue
        for item in items:
            if isinstance(item, Mapping) and isinstance(item.get("path"), str):
                scoped_paths.add(str(item["path"]).replace("\\", "/"))

    topology = source_context_report.get("deviceTuTopology")
    if isinstance(topology, Mapping):
        device_tus = topology.get("deviceTranslationUnits")
        if isinstance(device_tus, list):
            for item in device_tus:
                if isinstance(item, Mapping) and isinstance(item.get("path"), str):
                    scoped_paths.add(str(item["path"]).replace("\\", "/"))

    if not scoped_paths:
        return file_map

    normalized_file_map = {
        _normalize_device_mapping_path(path): source
        for path, source in file_map.items()
    }
    scoped_paths = _expand_device_mapping_local_include_scope(
        {
            _normalize_device_mapping_path(path)
            for path in scoped_paths
        },
        normalized_file_map,
    )
    return {
        path: normalized_file_map[path]
        for path in sorted(scoped_paths)
        if path in normalized_file_map
    }


# ══════════════════════════════════════════════════════════════
# Diff-patch prompt builder (full 4-module mode)
# ══════════════════════════════════════════════════════════════
#
# The prompt builder + validator + DiffPatchRequest schema all live
# in diff_patch_helpers.py (extracted in Phase 5 so they can be
# unit-tested without dragging in main.py's import chain). The
# original full docstring + ordering rationale is in that module.
#
# Below kept ONLY for the historical comment; the actual implementation
# is in diff_patch_helpers.py and re-exported above.



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

    provider_name = os.getenv("SYNTHI_DIFF_PATCH_PROVIDER", "gemini").lower()
    provider = get_provider(provider_name=provider_name, use_custom=bool(req.api_key))
    prompt = _build_full_diff_patch_prompt(req)
    if req.architecture and req.architecture.strip():
        print(f"[DiffPatch] architecture hint ({len(req.architecture)} chars) injected into prompt")
    else:
        print(f"[DiffPatch] no architecture hint (fallback to generic prompt)")

    if provider_name == "openai":
        default_model = os.getenv("SYNTHI_OPENAI_MODEL", "qwen2.5-coder:7b")
    else:
        default_model = "gemini-3.1-flash-lite-preview"

    try:
        ai_response = await provider.ask_llm(
            prompt,
            "cpp",
            None,
            mode="delta",
            model=req.model or default_model,
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


@app.post("/refactor/split/gpu")
async def refactor_split_gpu(req: VerifiedAiRequest):
    """GPU Kernel Splitter Agent endpoint.

    Same external shape as `/refactor/split/verified`, but routes through
    `GPU_SPLIT_PROMPT` and requires a manifest `gpu` block. The returned
    `result` remains a raw JSON string so the Rust worker can parse it the
    same way it parses host split output.
    """
    start_time = time.time()

    def select_provider_name() -> str | None:
        if req.api_key:
            model_name = (req.model or "").lower()
            if "gemini" in model_name:
                return "gemini"
            return "chatgpt"
        return None

    provider = get_provider(provider_name=select_provider_name(), use_custom=bool(req.api_key))
    file_map = _file_map_from_request(req)
    logger.info(
        "[split/gpu] request file context count=%s focus=%s names=%s",
        len(file_map),
        req.focus or "",
        list(file_map.keys())[:30],
    )
    detection = _detect_gpu_project(file_map or {req.focus or "input.cpp": req.code})
    if not detection.is_gpu:
        raise HTTPException(status_code=422, detail="GPU split requested for source with no GPU markers")

    split = None
    split_model = (
        req.model
        or os.getenv("SYNTHI_GEMINI_MODEL")
        or "gemini-3.5-flash"
    )
    split_prompt = req.prompt
    max_split_attempts = 3
    split_attempts = []
    rejection_notes_history: list[str] = []
    for attempt in range(1, max_split_attempts + 1):
        try:
            split = await _run_kernel_splitter(
                provider=provider,
                user_code=req.code,
                lang=req.lang,
                detection=detection,
                extra_instructions=split_prompt,
                model=split_model,
                api_key=req.api_key,
                files=req.files,
                focus=req.focus,
            )
        except _KernelSplitterUnsupportedProjectError as e:
            verification = _split_failure_verification(
                e.reason_code,
                str(e),
            )
            logger.info("[split/gpu] deterministic unsupported project rejection: %s", e)
            raise HTTPException(
                status_code=422,
                detail={
                    "message": "GPU split unsupported for this project shape",
                    "verification": verification.to_dict(),
                    "source_context_report": e.source_context_report,
                    "agentic_report": _split_agentic_report(
                        attempts=[],
                        accepted=False,
                        max_attempts=0,
                    ),
                },
            )
        except _KernelSplitterError as e:
            verification = _split_failure_verification(
                "split_response_unparseable",
                str(e),
            )
            split_attempts.append(
                _split_attempt_record(
                    attempt=attempt,
                    max_attempts=max_split_attempts,
                    model=split_model,
                    prompt=split_prompt,
                    source_files=file_map.keys(),
                    verification=verification,
                    repair_prompt=attempt > 1,
                    repair_report={
                        "schemaVersion": "synthi.gpu.split_repair.v1",
                        "repaired": False,
                        "inputReasonCodes": [v.rule for v in verification.violations],
                        "repairRules": [],
                        "changedFiles": [],
                        "scope": "generated_artifacts_only",
                    },
                )
            )
            notes = "\n".join(
                f"- {v.rule}: {v.message}" for v in verification.violations
            )
            logger.info(
                "[split/gpu] splitter rejected split attempt %s/%s before verifier: %s",
                attempt,
                max_split_attempts,
                notes,
            )
            if attempt == max_split_attempts:
                raise HTTPException(
                    status_code=422,
                    detail={
                        "message": "GPU split failed before verification after retries",
                        "verification": verification.to_dict(),
                        "agentic_report": _split_agentic_report(
                            attempts=split_attempts,
                            accepted=False,
                            max_attempts=max_split_attempts,
                        ),
                    },
                )
            rejection_notes_history.append(notes)
            split_prompt = _build_split_retry_prompt(req.prompt, rejection_notes_history)
            continue
        except _KernelSplitProviderError as e:
            verification = _split_provider_failure_verification(e)
            split_attempts.append(
                _split_attempt_record(
                    attempt=attempt,
                    max_attempts=max_split_attempts,
                    model=split_model,
                    prompt=split_prompt,
                    source_files=file_map.keys(),
                    verification=verification,
                    repair_prompt=attempt > 1,
                    repair_report={
                        "schemaVersion": "synthi.gpu.split_repair.v1",
                        "repaired": False,
                        "inputReasonCodes": [v.rule for v in verification.violations],
                        "repairRules": [],
                        "changedFiles": [],
                        "scope": "generated_artifacts_only",
                    },
                )
            )
            notes = "\n".join(
                f"- {v.rule}: {v.message}" for v in verification.violations
            )
            logger.info(
                "[split/gpu] provider failed split attempt %s/%s before verifier: %s",
                attempt,
                max_split_attempts,
                notes,
            )
            rule = (
                verification.violations[0].rule
                if verification.violations
                else "ai_provider_error"
            )
            raise HTTPException(
                status_code=504 if rule == "ai_provider_timeout" else 503,
                detail={
                    "message": "GPU split AI provider failed before verification",
                    "verification": verification.to_dict(),
                    "agentic_report": _split_agentic_report(
                        attempts=split_attempts,
                        accepted=False,
                        max_attempts=max_split_attempts,
                    ),
                },
            )
        except Exception as e:
            raise HTTPException(status_code=400, detail=str(e))

        if split.repair_report and split.repair_report.get("inputReasonCodes"):
            post_repair_codes = (
                [v.rule for v in split.verification.violations]
                if split.verification
                else []
            )
            logger.info(
                "[split/gpu] split attempt %s/%s deterministic repair: repaired=%s rules=%s changed=%s remaining=%s",
                attempt,
                max_split_attempts,
                split.repair_report.get("repaired"),
                split.repair_report.get("repairRules", []),
                split.repair_report.get("changedFiles", []),
                post_repair_codes,
            )

        split_attempts.append(
            _split_attempt_record(
                attempt=attempt,
                max_attempts=max_split_attempts,
                model=split_model,
                prompt=split_prompt,
                source_files=file_map.keys(),
                verification=split.verification,
                repair_prompt=attempt > 1,
                repair_report=split.repair_report,
            )
        )

        if not (split.verification and not split.verification.ok):
            break

        notes = "\n".join(
            f"- {v.rule}: {v.message}" for v in split.verification.violations
        )
        repair_retry_notes = _split_repair_retry_notes(split.repair_report)
        if repair_retry_notes:
            notes = "\n".join([notes, *repair_retry_notes])
        logger.info(
            "[split/gpu] verifier rejected split attempt %s/%s: %s",
            attempt,
            max_split_attempts,
            notes,
        )
        if attempt == max_split_attempts:
            break
        rejection_notes_history.append(notes)
        split_prompt = _build_split_retry_prompt(req.prompt, rejection_notes_history)

    if split is None:
        raise HTTPException(status_code=400, detail="GPU split did not produce a result")

    if split.verification and not split.verification.ok:
        verification = split.verification.to_dict()
        raise HTTPException(
            status_code=422,
            detail={
                "message": "GPU split failed Synthi verifier after retries",
                "verification": verification,
                "agentic_report": _split_agentic_report(
                    attempts=split_attempts,
                    accepted=False,
                    max_attempts=max_split_attempts,
                ),
            },
        )

    request_arch_hint = (
        req.gpu_arch.strip()
        if req.gpu_arch and req.gpu_arch.strip().lower() != "auto"
        else None
    )
    try:
        manifest_raw = normalize_gpu_split_manifest(
            split.manifest if isinstance(split.manifest, dict) else {},
            split_files=split.files,
            link_hint_sources=file_map,
            vendor_hint=detection.vendor_hint,
            arch_hint=(
                request_arch_hint
                or os.getenv("SYNTHI_GPU_ARCH_HINT")
                or os.getenv("SYNTHI_GPU_ARCH")
                or None
            ),
            focus_path=req.focus,
        )
        manifest_parsed = parse_manifest(manifest_raw)
        validate_manifest_v1(manifest_parsed)
        manifest_out = manifest_to_dict(manifest_parsed)
        split_files_out, manifest_out, generated_artifact_report = (
            internalize_gpu_generated_artifacts(split.files, manifest_out)
        )
        manifest_parsed = parse_manifest(manifest_out)
        validate_manifest_v1(manifest_parsed)
        manifest_out = manifest_to_dict(manifest_parsed)
        device_mapping_report = build_device_mapping_report(
            source_files=_device_mapping_source_scope(file_map, split.source_context_report),
            generated_files=split_files_out,
            manifest=manifest_out,
        )
        launch_indirection_report = build_launch_indirection_report(
            generated_files=split_files_out,
            verification=split.verification.to_dict() if split.verification else None,
        )
    except ManifestRejection as e:
        raise HTTPException(status_code=422, detail=e.message)
    except Exception as e:
        raise HTTPException(status_code=422, detail=f"GPU manifest validation failed: {e}")

    elapsed = time.time() - start_time
    verification = split.verification.to_dict() if split.verification else None
    if split.verification and not split.verification.ok:
        logger.info("[split/gpu] verifier rejected GPU split: %s", verification)

    return {
        "result": json.dumps(split_files_out),
        "architecture": split.architecture_md,
        "manifest": manifest_out,
        "kernel_hashes": split.kernel_hashes,
        "launch_graph": split.launch_graph,
        "source_context_report": split.source_context_report,
        "gpu_detection": detection.to_dict(),
        "generated_artifact_report": generated_artifact_report,
        "device_mapping_report": device_mapping_report,
        "launch_indirection_report": launch_indirection_report,
        "agentic_report": _split_agentic_report(
            attempts=split_attempts,
            accepted=True,
            max_attempts=max_split_attempts,
        ),
        "split_repair_report": split.repair_report,
        "lang": req.lang,
        "verified": bool(split.verification.ok if split.verification else True),
        "verification": verification,
        "elapsed_seconds": elapsed,
    }


@app.post("/refactor/diff_patch/gpu")
async def refactor_diff_patch_gpu(req: GpuDiffPatchRequest):
    """GPU-aware diff patch endpoint.

    Adds `reload_plan` and the `device` edit module while preserving the
    existing anchor-based edit shape used by the Rust worker.
    """
    start_time = time.time()
    provider_name = os.getenv("SYNTHI_DIFF_PATCH_PROVIDER", "gemini").lower()
    provider = get_provider(provider_name=provider_name, use_custom=bool(req.api_key))
    prompt = _build_gpu_diff_patch_prompt(req)

    default_model = (
        os.getenv("SYNTHI_OPENAI_MODEL", "qwen2.5-coder:7b")
        if provider_name == "openai"
        else "gemini-3.1-flash-lite-preview"
    )
    max_delta_attempts = 2
    try:
        last_parsed = None
        last_failures = []
        for attempt in range(1, max_delta_attempts + 1):
            ai_response = await provider.ask_llm(
                prompt,
                "cpp",
                None,
                mode="delta",
                model=req.model or default_model,
                api_key=req.api_key,
            )
            parsed = _parse_gpu_diff_response(ai_response)
            failures = _gpu_diff_patch_anchor_failures(req, parsed["edits"])
            failures.extend(_gpu_diff_patch_content_failures(req, parsed["edits"]))
            if not failures:
                elapsed = time.time() - start_time
                print(
                    f"[GpuDiffPatch] plan={parsed['reload_plan']} "
                    f"edits={len(parsed['edits'])} attempt={attempt}/{max_delta_attempts} "
                    f"elapsed={elapsed:.2f}s"
                )
                return {**parsed, "elapsed_seconds": elapsed, "attempt_count": attempt}

            last_parsed = parsed
            last_failures = failures
            print(
                f"[GpuDiffPatch] verifier rejected attempt={attempt}/{max_delta_attempts} "
                f"failures={failures}"
            )
            if attempt < max_delta_attempts:
                prompt = _build_gpu_diff_patch_retry_prompt(prompt, failures)

        elapsed = time.time() - start_time
        raise HTTPException(
            status_code=422,
            detail={
                "message": "GPU diff patch verifier rejected AI edits after retries",
                "reload_plan": (last_parsed or {}).get("reload_plan"),
                "failures": last_failures,
                "elapsed_seconds": elapsed,
            },
        )
    except HTTPException:
        raise
    except json.JSONDecodeError as e:
        raise HTTPException(status_code=400, detail=f"Failed to parse GPU patch response: {e}")
    except Exception as e:
        print(f"[GpuDiffPatch] Error: {e}")
        raise HTTPException(status_code=400, detail=str(e))


@app.post("/refactor/heal/gpu")
async def refactor_heal_gpu(req: GpuHealRequest):
    """GPU compile/perf/runtime healer endpoint."""
    start_time = time.time()
    provider = get_provider(provider_name="gemini", use_custom=bool(req.api_key))
    prompt, triage = _build_gpu_heal_prompt(req)
    try:
        ai_response = await provider.ask_llm(
            prompt,
            "cpp",
            None,
            mode="delta",
            model=req.model or "gemini-3.1-flash-lite-preview",
            api_key=req.api_key,
        )
        parsed = _parse_gpu_heal_response(ai_response, req)
        elapsed = time.time() - start_time
        print(
            f"[GpuHeal] tier={triage.get('tier')} prompt={triage.get('prompt_name')} "
            f"edits={len(parsed['edits'])} elapsed={elapsed:.2f}s"
        )
        return {**parsed, "triage": triage, "elapsed_seconds": elapsed}
    except HTTPException:
        raise
    except json.JSONDecodeError as e:
        raise HTTPException(status_code=400, detail=f"Failed to parse GPU heal response: {e}")
    except Exception as e:
        print(f"[GpuHeal] Error: {e}")
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


def _unwrap_heal_content(result: str) -> str:
    """Recover complete-file content if the model wrapped it in JSON."""

    stripped = result.strip()
    if not stripped.startswith("{"):
        return result
    try:
        parsed = json.loads(stripped)
    except json.JSONDecodeError:
        parsed = None
    if isinstance(parsed, dict):
        for key in ("content", "file_content", "source"):
            value = parsed.get(key)
            if isinstance(value, str) and value.strip():
                return value.strip()

    match = re.search(
        r'"(?:content|file_content|source)"\s*:\s*"(?P<body>.*)"\s*(?:,|\})',
        stripped,
        re.DOTALL,
    )
    if not match:
        return result
    body = match.group("body")
    try:
        return json.loads('"' + body.replace("\n", "\\n").replace("\r", "\\r") + '"').strip()
    except json.JSONDecodeError:
        return (
            body
            .replace(r"\\", "\\")
            .replace(r"\"", '"')
            .replace(r"\n", "\n")
            .replace(r"\r", "\r")
            .replace(r"\t", "\t")
            .strip()
        )


_EXTERN_C_FUNCTION_RE = re.compile(
    r'extern\s+"C"\s+(?:[A-Za-z_][A-Za-z0-9_:<>\s*&]*\s+)*'
    r'(?P<name>[A-Za-z_][A-Za-z0-9_]*)\s*\(',
    re.DOTALL,
)


def _extern_c_function_names(source: str) -> set[str]:
    """Return exported C ABI function names from generated role source."""

    if not source:
        return set()
    masked = re.sub(r"//.*?$|/\*.*?\*/", "", source, flags=re.MULTILINE | re.DOTALL)
    return {match.group("name") for match in _EXTERN_C_FUNCTION_RE.finditer(masked)}


def _missing_preserved_exports(original: str, candidate: str) -> list[str]:
    required = _extern_c_function_names(original)
    if not required:
        return []
    present = _extern_c_function_names(candidate)
    return sorted(required - present)


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
        async def run_heal_once(heal_prompt: str) -> str:
            ai_response = await provider.ask_llm(
                heal_prompt,
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
            result = _unwrap_heal_content(result.strip())
            try:
                from agents.gpu_split_repair import sanitize_generated_heal_output

                sanitized, sanitized_changed = sanitize_generated_heal_output(
                    module=req.module_name,
                    source=result,
                    errors=req.error_messages,
                )
                if sanitized_changed:
                    print(f"[Heal] deterministic generated-role sanitizer adjusted {req.module_name}")
                    result = sanitized
            except Exception as sanitizer_error:
                print(f"[Heal] sanitizer skipped for {req.module_name}: {sanitizer_error}")
            return result

        result = await run_heal_once(prompt)
        missing_exports = _missing_preserved_exports(req.module_content, result)
        if missing_exports:
            print(
                f"[Heal] rejected {req.module_name} repair because it removed exports: "
                f"{','.join(missing_exports)}"
            )
            retry_prompt = "\n".join(
                [
                    prompt,
                    "",
                    "PREVIOUS REPAIR WAS REJECTED BY A DETERMINISTIC ABI CHECK.",
                    "It removed these existing extern C exports:",
                    ", ".join(missing_exports),
                    "",
                    "Return a new complete fixed file that preserves every listed export.",
                    "Do not replace the module with a header or a different role.",
                    "",
                    "REJECTED REPAIR:",
                    "```",
                    result,
                    "```",
                ]
            )
            result = await run_heal_once(retry_prompt)
            missing_exports = _missing_preserved_exports(req.module_content, result)
            if missing_exports:
                raise ValueError(
                    "AI heal removed required exports after retry: "
                    + ",".join(missing_exports)
                )

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
# /refactor/heal/manifest — ULTRAPLAN Phase 6
# =============================================================================
# Runtime safety net: when compile_core / compile_gui / compile_runner
# hits an `undefined reference` error, the worker extracts the symbols,
# sends them here, and we ask the AI to update the manifest's link
# flags. The worker retries the compile once with the new manifest.
#
# Library-agnostic by construction: see diff_patch_helpers.build_manifest_heal_prompt
# — no library names anywhere in the prompt, the AI uses general
# knowledge to map symbols → flags.

@app.post("/refactor/heal/manifest")
async def refactor_heal_manifest(req: HealManifestRequest):
    """
    Ask the AI to update a build manifest's link flags after a link-time
    failure. Runtime safety net for undefined-reference errors.

    Returns `{updated_manifest, unchanged, notes}`. When `unchanged` is
    True (AI couldn't infer a fix), the worker should NOT retry compile —
    surface the 3-option error card immediately to avoid loops.
    """
    start_time = time.time()

    if req.failed_module not in _VALID_FAILED_MODULES:
        raise HTTPException(
            status_code=400,
            detail=(
                f"failed_module must be one of {_VALID_FAILED_MODULES}, "
                f"got {req.failed_module!r}"
            ),
        )
    if not req.undefined_symbols:
        raise HTTPException(
            status_code=400,
            detail="undefined_symbols must be a non-empty list",
        )
    if not isinstance(req.current_manifest, dict) or not req.current_manifest:
        raise HTTPException(
            status_code=400,
            detail="current_manifest must be a non-empty JSON object",
        )

    provider = get_provider(provider_name='gemini', use_custom=bool(req.api_key))
    prompt = _build_manifest_heal_prompt(req)

    print(
        f"[ManifestHeal] failed_module={req.failed_module} "
        f"symbols={len(req.undefined_symbols)} "
        f"source_excerpt={len(req.source_excerpt)} chars"
    )

    try:
        ai_response = await provider.ask_llm(
            prompt,
            "cpp",
            None,
            mode="delta",
            # Pro model — manifest heal needs strong library knowledge
            # and the output is small (~50-200 tokens of JSON), so
            # latency cost is bounded.
            model=req.model or "gemini-3.1-flash-lite-preview",
            api_key=req.api_key,
        )
    except Exception as e:
        print(f"[ManifestHeal] AI call failed: {e}")
        raise HTTPException(status_code=502, detail=f"AI provider error: {e}")

    try:
        parsed = _parse_heal_manifest_response(ai_response)
    except ValueError as e:
        # AI returned non-JSON or wrong shape. Surface as 422 so the
        # Rust worker treats it as "heal failed" and shows the error
        # card instead of retrying with garbage.
        print(f"[ManifestHeal] response parse failed: {e}")
        raise HTTPException(
            status_code=422,
            detail=f"AI returned malformed manifest heal response: {e}",
        )

    elapsed = time.time() - start_time
    print(
        f"[ManifestHeal] {'unchanged' if parsed.unchanged else 'updated'} "
        f"in {elapsed:.2f}s — notes: {parsed.notes[:120]}"
    )

    return {
        "updated_manifest": parsed.updated_manifest,
        "unchanged": parsed.unchanged,
        "notes": parsed.notes,
        "elapsed_seconds": elapsed,
    }


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
# GPU HMR split-broker contract API
# =============================================================================
try:
    from gpu_hmr.api import router as gpu_hmr_router
    app.include_router(gpu_hmr_router)
    logger.info("GPU HMR split-broker module loaded")
except ImportError as e:
    logger.warning(f"GPU HMR split-broker module not available: {e}")


# =============================================================================
# Synthi Genome — shadow verification subsystem (Wave 1)
# =============================================================================
try:
    from shadow import shadow_router
    app.include_router(shadow_router)
    logger.info("Shadow verification module loaded")
except ImportError as e:
    logger.warning(f"Shadow verification module not available: {e}")


# =============================================================================
# Synthi Genome — continuous shadow (Wave 4)
# =============================================================================
try:
    from shadow_continuous.api import router as shadow_continuous_router
    app.include_router(shadow_continuous_router)
    logger.info("Continuous shadow module loaded")
except ImportError as e:
    logger.warning(f"Continuous shadow module not available: {e}")


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


class RuleTranslateRequest(BaseModel):
    """Convert a plain-English rule description into a structured healing rule.

    The frontend sends the free-form text the user typed; the backend asks
    Gemini to produce a rule JSON object matching the shape the frontend's
    ruleEngine.js expects.
    """
    plain_english: str
    target_vocabulary: Optional[List[str]] = None   # e.g. ['missing_imports', 'any_error', ...]
    scope_vocabulary: Optional[List[str]] = None    # e.g. ['any_file', 'javascript_files', ...]
    action_vocabulary: Optional[List[str]] = None   # e.g. ['auto_apply', 'suggest', ...]


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


# Default vocabularies mirror src/lib/healing/ruleEngine.js.  The frontend
# may override by passing its own lists in the request — useful if the
# vocabulary is extended without a backend deploy.
_DEFAULT_RULE_ACTIONS = ['auto_apply', 'suggest', 'ai_escalate', 'ignore']
_DEFAULT_RULE_TARGETS = [
    'any_error', 'any_warning', 'any_issue',
    'missing_imports', 'unused_imports', 'unused_variables',
    'missing_semicolons', 'missing_colons', 'missing_brackets',
    'syntax_errors', 'type_errors', 'style_warnings',
]
_DEFAULT_RULE_SCOPES = [
    'any_file',
    'javascript_files', 'typescript_files', 'python_files',
    'cpp_files', 'java_files', 'go_files', 'rust_files',
    'glob',
]


@app.post("/heal/rule/translate")
async def heal_rule_translate(req: RuleTranslateRequest):
    """Translate a plain-English rule description into a structured rule JSON.

    Example input:  "don't touch anything in the tests folder"
    Example output: {"action":"ignore","target":"any_issue","scope":"glob","pattern":"tests/**"}
    """
    text = (req.plain_english or '').strip()
    if not text:
        raise HTTPException(status_code=400, detail="plain_english is required")
    if len(text) > 500:
        raise HTTPException(status_code=400, detail="plain_english too long (max 500 chars)")

    actions = req.action_vocabulary or _DEFAULT_RULE_ACTIONS
    targets = req.target_vocabulary or _DEFAULT_RULE_TARGETS
    scopes = req.scope_vocabulary or _DEFAULT_RULE_SCOPES

    prompt = f"""You convert plain-English rules for a self-healing code system into a JSON rule object.

Rule shape:
{{
  "action": <one of {actions}>,
  "target": <one of {targets}>,
  "scope":  <one of {scopes}>,
  "pattern": <required only when scope == "glob", a glob like "tests/**">
}}

Action meanings:
- "auto_apply": silently fix
- "suggest": show a quick-fix the user has to approve
- "ai_escalate": ask AI for a second opinion
- "ignore": don't do anything

Target meanings:
- "any_error" / "any_warning" / "any_issue": severity filters
- "missing_imports" / "unused_imports" / "unused_variables": identifier-level issues
- "missing_semicolons" / "missing_colons" / "missing_brackets": syntax punctuation
- "syntax_errors" / "type_errors" / "style_warnings": broader categories

Scope meanings:
- "any_file": no filter
- "<lang>_files": only that language (e.g. "typescript_files")
- "glob": specify a file-path pattern like "tests/**" or "src/legacy/*"

User request: "{text}"

Output ONLY the JSON object. No prose, no markdown fences, no comments.
"""

    provider = get_provider(provider_name='gemini', use_custom=False)
    try:
        raw = await provider.ask_llm(
            code='',
            lang='plaintext',
            prompt=prompt,
            mode='rule_translate',
        )
    except ValueError as e:
        # No API key configured — return a helpful 503 instead of 500.
        raise HTTPException(status_code=503, detail=f"AI provider unavailable: {e}")
    except Exception as e:
        logger.error(f"[RuleTranslate] LLM error: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))

    # Strip markdown fences if Gemini added them despite instruction
    cleaned = (raw or '').strip()
    if cleaned.startswith('```'):
        cleaned = cleaned.split('```', 2)[-1]
        if cleaned.lstrip().startswith('json'):
            cleaned = cleaned.lstrip()[4:]
        cleaned = cleaned.rsplit('```', 1)[0].strip()

    try:
        parsed = json.loads(cleaned)
    except json.JSONDecodeError as e:
        logger.warning(f"[RuleTranslate] JSON parse failed: {e} · raw={raw[:200]!r}")
        raise HTTPException(
            status_code=422,
            detail=f"AI did not return valid JSON: {str(e)[:100]}",
        )

    if not isinstance(parsed, dict):
        raise HTTPException(status_code=422, detail="AI returned non-object JSON")

    action = parsed.get('action')
    target = parsed.get('target')
    scope = parsed.get('scope')
    pattern = parsed.get('pattern')

    if action not in actions:
        raise HTTPException(status_code=422, detail=f"invalid action: {action!r}")
    if target not in targets:
        raise HTTPException(status_code=422, detail=f"invalid target: {target!r}")
    if scope not in scopes:
        raise HTTPException(status_code=422, detail=f"invalid scope: {scope!r}")
    if scope == 'glob' and (not isinstance(pattern, str) or not pattern):
        raise HTTPException(status_code=422, detail="glob scope requires a pattern")

    return {
        'action': action,
        'target': target,
        'scope': scope,
        'pattern': pattern if scope == 'glob' else None,
    }


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
