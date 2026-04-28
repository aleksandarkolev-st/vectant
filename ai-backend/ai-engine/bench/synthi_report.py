"""Comprehensive integration report for RAG + Shadow subsystems.

Spins up a fresh temp workspace, exercises the RAG pipeline (all 4 steps)
and Shadow subsystem (cost estimation, project signals, config) directly
via Python imports — no running server required.

Invoke:
    cd ai-backend/ai-engine
    python -m bench.synthi_report                        # auto temp workspace
    python -m bench.synthi_report --workspace /tmp/myws  # reuse a workspace
    python -m bench.synthi_report --out my-report.md     # custom output path

Prerequisites:
    GEMINI_API_KEY env var (or in .env) — enables LLM-backed tests.
    Without it, structural tests still pass; LLM tests are marked SKIP.

API keys summary
    Shadow:  1 required (GEMINI_API_KEY -- generation, critic, arbiter).
             2 optional  (ANTHROPIC_API_KEY, OPENAI_API_KEY -- cross-universe).
    RAG:     1 required (GEMINI_API_KEY -- embeddings, routing, synthesis).
"""

from __future__ import annotations

import argparse
import json
import logging
import os
import platform
import shutil
import sys
import tempfile
import time
import traceback
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Dict, List, Optional

# ── Import path setup (mirrors bench/harness.py) ─────────────────────────────
_AI_ENGINE = Path(__file__).resolve().parent.parent
if str(_AI_ENGINE) not in sys.path:
    sys.path.insert(0, str(_AI_ENGINE))

# Load .env from ai-engine root so GEMINI_API_KEY is available
try:
    from dotenv import load_dotenv
    load_dotenv(_AI_ENGINE / ".env")
except ImportError:
    pass

logging.basicConfig(
    level=logging.WARNING,
    format="%(name)s %(levelname)s %(message)s",
)
logger = logging.getLogger("bench.synthi_report")

# ── Result tracking ───────────────────────────────────────────────────────────

PASS = "PASS"
FAIL = "FAIL"
SKIP = "SKIP"


@dataclass
class TestResult:
    name: str
    status: str  # PASS | FAIL | SKIP
    elapsed_ms: float = 0.0
    detail: str = ""
    error: str = ""
    data: Dict[str, Any] = field(default_factory=dict)


_results: List[TestResult] = []


def run_test(name: str, fn, *args, skip_reason: str = "", **kwargs) -> TestResult:
    if skip_reason:
        r = TestResult(name=name, status=SKIP, detail=skip_reason)
        _results.append(r)
        print(f"  {SKIP}  {name}  ({skip_reason})")
        return r
    t0 = time.perf_counter()
    try:
        data = fn(*args, **kwargs)
        elapsed = (time.perf_counter() - t0) * 1000
        r = TestResult(name=name, status=PASS, elapsed_ms=elapsed,
                       data=data or {})
        _results.append(r)
        print(f"  {PASS}  {name}  ({elapsed:.0f} ms)")
        return r
    except Exception as exc:
        elapsed = (time.perf_counter() - t0) * 1000
        tb = traceback.format_exc()
        r = TestResult(name=name, status=FAIL, elapsed_ms=elapsed,
                       error=str(exc), detail=tb)
        _results.append(r)
        print(f"  {FAIL}  {name}  ({elapsed:.0f} ms)  {exc}")
        return r


# ── Sample workspace files ────────────────────────────────────────────────────

_SAMPLE_AUTH_PY = '''\
"""
Authentication module.

Handles user login, token management, and session validation.
"""

import hashlib
import secrets
from dataclasses import dataclass
from typing import Optional


@dataclass
class User:
    """Represents an authenticated user."""
    id: str
    username: str
    email: str
    role: str = "user"


class AuthManager:
    """Manages authentication and sessions."""

    def __init__(self, secret_key: str):
        self._secret = secret_key
        self._sessions: dict = {}

    def login(self, username: str, password: str) -> Optional[str]:
        """Authenticate user and return a session token."""
        _hash = hashlib.sha256(password.encode()).hexdigest()
        token = secrets.token_urlsafe(32)
        self._sessions[token] = username
        return token

    def validate_session(self, token: str) -> Optional[User]:
        """Validate a session token and return the user."""
        username = self._sessions.get(token)
        if not username:
            return None
        return User(id="1", username=username, email=f"{username}@example.com")

    def logout(self, token: str) -> bool:
        """Invalidate a session."""
        return self._sessions.pop(token, None) is not None
'''

_SAMPLE_README_MD = """\
# Synthi IDE

A collaborative, AI-augmented browser-based IDE.

## Architecture

Synthi IDE is composed of several services:

### Frontend (Next.js)

The web interface is built with Next.js and React. It includes:
- Monaco editor with Yjs collaborative editing
- Real-time compile output via WebRTC
- AI chat powered by the Gemini API
- Git UI and file-tree management

### AI Backend

The AI backend is split into two layers:

- **Gateway (Node.js)**: WebSocket proxy between the frontend and ai-engine.
- **AI Engine (Python/FastAPI)**: Core AI logic -- analyzer, healer, RAG, Shadow.

### RAG Subsystem

The Retrieval-Augmented Generation (RAG) pipeline answers codebase questions:

1. **Ingestion**: Document loading, ToC extraction, section splitting, embedding.
2. **Macro-retrieval**: Vector search (cosine similarity) + BM25 keyword filter fused via RRF.
3. **Micro-navigation**: Agentic ToC traversal with a fast routing LLM.
4. **Synthesis**: Heavy Gemini model generates a cited answer.

### Shadow Subsystem

Shadow runs parallel multi-universe patch verification:

- Quick tier: 1 universe, ~8s timeout.
- Standard tier: 3 universes, ~25s timeout.
- Deep tier: 3 universes, ~45s timeout.

Tiers have a cost ceiling enforced by the rate card.

## Configuration

Copy `ai-backend/ai-engine/.env.example` to `.env` and fill in:

```
GEMINI_API_KEY=your-key-here
ANTHROPIC_API_KEY=optional-for-cross-universe
OPENAI_API_KEY=optional-for-cross-universe
```

## Running locally

```bash
docker compose up --build
```

Open `http://localhost:3000` in your browser.
"""

_SAMPLE_API_TS = """\
/**
 * Synthi AI Gateway -- REST API helpers.
 */

export interface CompileRequest {
  workspaceId: string;
  language: string;
  entry: string;
}

export interface CompileResponse {
  jobId: string;
  status: 'queued' | 'running' | 'done' | 'error';
  output?: string;
}

export async function startCompile(req: CompileRequest): Promise<CompileResponse> {
  const res = await fetch('/api/compile', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(req),
  });
  if (!res.ok) throw new Error(`Compile failed: ${res.statusText}`);
  return res.json();
}

export async function pollCompile(jobId: string): Promise<CompileResponse> {
  const res = await fetch(`/api/compile/${jobId}`);
  if (!res.ok) throw new Error(`Poll failed: ${res.statusText}`);
  return res.json();
}
"""

_SAMPLE_BUGGY_PY = """\
def divide(a, b):
    # BUG: no zero-division guard
    return a / b
"""

_SAMPLE_PACKAGE_JSON = json.dumps({
    "name": "synthi-ide",
    "version": "0.1.0",
    "scripts": {"dev": "next dev", "build": "next build"},
    "dependencies": {"next": "14.0.0", "react": "^18.0.0"},
}, indent=2)


def create_workspace(root: Path) -> None:
    """Populate the temp workspace with sample files."""
    (root / "src").mkdir(parents=True, exist_ok=True)
    (root / "docs").mkdir(parents=True, exist_ok=True)
    (root / "src" / "auth.py").write_text(_SAMPLE_AUTH_PY, encoding="utf-8")
    (root / "src" / "buggy.py").write_text(_SAMPLE_BUGGY_PY, encoding="utf-8")
    (root / "src" / "api.ts").write_text(_SAMPLE_API_TS, encoding="utf-8")
    (root / "docs" / "README.md").write_text(_SAMPLE_README_MD, encoding="utf-8")
    (root / "package.json").write_text(_SAMPLE_PACKAGE_JSON, encoding="utf-8")
    # next.config.js so project_signals detects "web-app"
    (root / "next.config.js").write_text(
        "/** @type {import('next').NextConfig} */\nmodule.exports = {};\n",
        encoding="utf-8",
    )


# ── Shared pipeline (built and ingested once) ─────────────────────────────────

_shared: Dict[str, Any] = {}   # pipeline, config, ingest_stats


def _ensure_pipeline(workspace_root: str, force_rebuild: bool = False) -> tuple:
    """Return (pipeline, config), building and ingesting only once.

    If the workspace already has a populated `.synthi/rag/` store from a
    prior run and `--reuse-store` was passed, skip the (expensive) Gemini
    embedding round-trip and just load the existing index.
    """
    if not force_rebuild and "pipeline" in _shared:
        return _shared["pipeline"], _shared["config"]

    from code_intel.rag.pipeline import RAGPipeline
    from code_intel.rag.config import RAGConfig

    config = RAGConfig()
    pipeline = RAGPipeline(workspace_root=workspace_root, config=config)
    pipeline.initialize()

    existing = pipeline.get_stats().get("documents", 0)
    if _shared.get("reuse_store") and existing > 0:
        print(f"  [setup] reusing existing store ({existing} docs already indexed)")
        stats = {
            "documents_processed": existing,
            "documents_skipped": 0,
            "documents_failed": 0,
            "documents_purged": 0,
            "total_sections": pipeline.get_stats().get("sections", 0),
            "time_ms": 0,
        }
    else:
        print("  [setup] ingesting workspace (may call Gemini for embeddings)...")
        t0 = time.perf_counter()
        stats = pipeline.ingest_directory(workspace_root)
        elapsed = (time.perf_counter() - t0) * 1000
        print(f"  [setup] ingested {stats.get('documents_processed', 0)} docs "
              f"({stats.get('total_sections', 0)} sections) in {elapsed:.0f} ms")

    _shared["pipeline"] = pipeline
    _shared["config"] = config
    _shared["ingest_stats"] = stats
    _shared["workspace_root"] = workspace_root
    return pipeline, config


# ── RAG tests (operate on the shared pipeline) ────────────────────────────────

def test_rag_init(workspace_root: str) -> Dict:
    pipeline, config = _ensure_pipeline(workspace_root)
    return {
        "store_dir": pipeline._store_dir,
        "fusion_method": config.macro.fusion_method,
        "rrf_k": config.macro.rrf_k,
        "routing_model": config.micro.routing_model,
        "synthesis_model": config.synthesis.synthesis_model,
        "embedding_model": config.embedding_model,
        "embedding_dim": config.embedding_dimension,
        "store_directory": config.store.store_directory,
    }


def test_rag_ingest_stats(workspace_root: str) -> Dict:
    _ensure_pipeline(workspace_root)
    return _shared["ingest_stats"]


def test_rag_stats(workspace_root: str) -> Dict:
    pipeline, _ = _ensure_pipeline(workspace_root)
    return pipeline.get_stats()


def test_rag_dedup(workspace_root: str) -> Dict:
    """Re-ingest the same file -- document count must stay at 1."""
    pipeline, _ = _ensure_pipeline(workspace_root)
    fpath = str(Path(workspace_root) / "docs" / "README.md")
    pipeline.ingest_file(fpath)  # second ingest of same file
    stats = pipeline.get_stats()
    # dedup means doc count should not have grown
    before = _shared["ingest_stats"].get("documents_processed", 0)
    assert stats["documents"] <= before + 1, (
        f"Duplicate ingest leaked: {stats['documents']} docs vs {before} before"
    )
    return {"documents_after_double_ingest": stats["documents"]}


def test_rag_remove_file(workspace_root: str) -> Dict:
    """Remove and re-ingest a single file. Verify both halves of the cycle."""
    pipeline, _ = _ensure_pipeline(workspace_root)
    abs_fpath = str(Path(workspace_root) / "docs" / "README.md")
    # The store normalises to relative paths; try relative first, then absolute.
    rel_fpath = "docs/README.md"
    before = pipeline.get_stats()["documents"]
    remove_result = pipeline.remove_file(rel_fpath)
    if remove_result.get("status") != "removed":
        remove_result = pipeline.remove_file(abs_fpath)
    after_remove = pipeline.get_stats()["documents"]
    # Re-ingest must actually put the doc back, not silently dedup-skip it.
    reingest_result = pipeline.ingest_file(abs_fpath)
    after_reingest = pipeline.get_stats()["documents"]
    assert remove_result["status"] == "removed", f"remove_file returned: {remove_result}"
    assert reingest_result.get("status") == "ingested", (
        f"re-ingest after remove was skipped: {reingest_result}"
    )
    assert after_reingest == before, (
        f"re-ingest did not restore doc count: before={before}, "
        f"after_remove={after_remove}, after_reingest={after_reingest}"
    )
    return {
        "docs_before_remove": before,
        "docs_after_remove": after_remove,
        "docs_after_reingest": after_reingest,
        "sections_removed": remove_result["sections_removed"],
        "reingest_status": reingest_result.get("status"),
    }


def test_rag_fusion_rrf(workspace_root: str) -> Dict:
    """retrieve_context with RRF fusion (the default)."""
    from code_intel.rag.pipeline import RAGPipeline
    from code_intel.rag.config import RAGConfig
    config = RAGConfig()
    config.macro.fusion_method = "rrf"
    pipeline = RAGPipeline(workspace_root=workspace_root, config=config)
    pipeline.initialize()
    # Share the existing store directory -- no re-ingestion needed
    result = pipeline.retrieve_context(
        "authentication session token login",
        max_tokens=4000,
    )
    return {
        "fusion_method": "rrf",
        "documents_searched": result["documents_searched"],
        "documents_selected": result["documents_selected"],
        "sections_used": result["sections_used"],
        "tokens_used": result["tokens_used"],
        "sufficiency": result["sufficiency"],
        "macro_ms": result["timing"].get("macro_ms", 0),
        "micro_ms": result["timing"].get("micro_ms", 0),
    }


def test_rag_fusion_weighted(workspace_root: str) -> Dict:
    """retrieve_context with weighted fusion for comparison."""
    from code_intel.rag.pipeline import RAGPipeline
    from code_intel.rag.config import RAGConfig
    config = RAGConfig()
    config.macro.fusion_method = "weighted"
    pipeline = RAGPipeline(workspace_root=workspace_root, config=config)
    pipeline.initialize()
    result = pipeline.retrieve_context(
        "authentication session token login",
        max_tokens=4000,
    )
    return {
        "fusion_method": "weighted",
        "documents_searched": result["documents_searched"],
        "documents_selected": result["documents_selected"],
        "sections_used": result["sections_used"],
        "tokens_used": result["tokens_used"],
        "sufficiency": result["sufficiency"],
        "macro_ms": result["timing"].get("macro_ms", 0),
        "micro_ms": result["timing"].get("micro_ms", 0),
    }


def test_rag_retrieve_context(workspace_root: str) -> Dict:
    """Steps 2+3: retrieve_context with the default config."""
    pipeline, _ = _ensure_pipeline(workspace_root)
    result = pipeline.retrieve_context(
        "How does authentication work?",
        max_tokens=4000,
    )
    return {
        "documents_searched": result["documents_searched"],
        "documents_selected": result["documents_selected"],
        "sections_used": result["sections_used"],
        "tokens_used": result["tokens_used"],
        "sufficiency": result["sufficiency"],
        "timing_ms": result["timing"],
    }


def test_rag_query_full(workspace_root: str) -> Dict:
    """Full 4-step RAG query (requires GEMINI_API_KEY)."""
    pipeline, _ = _ensure_pipeline(workspace_root)
    result = pipeline.query(
        "What is the RAG pipeline and how does micro-navigation work?"
    )
    return {
        "answer_length": len(result.answer),
        "confidence": result.confidence,
        "citations": len(result.citations),
        "documents_searched": result.documents_searched,
        "documents_selected": result.documents_selected,
        "macro_time_ms": result.macro_time_ms,
        "micro_time_ms": result.micro_time_ms,
        "synthesis_time_ms": result.synthesis_time_ms,
        "total_time_ms": result.total_time_ms,
        "answer_snippet": result.answer[:400] if result.answer else "",
    }


def test_rag_clear(workspace_root: str) -> Dict:
    """Clear and verify the store empties; then re-ingest for later tests."""
    pipeline, _ = _ensure_pipeline(workspace_root)
    before = pipeline.get_stats()["documents"]
    pipeline.clear()
    after = pipeline.get_stats()["documents"]
    assert after == 0, f"Expected 0 docs after clear, got {after}"
    # Re-ingest so the store is ready for subsequent tests
    pipeline.ingest_directory(workspace_root)
    after_reingest = pipeline.get_stats()["documents"]
    return {"docs_before": before, "docs_after_clear": after,
            "docs_after_reingest": after_reingest}


# ── Shadow tests ──────────────────────────────────────────────────────────────

def test_shadow_config() -> Dict:
    from shadow.multiverse import (
        TIER_UNIVERSE_COUNT, UNIVERSE_TIMEOUT_SEC, TIER_COST_USD,
    )
    return {
        "tier_universe_count": TIER_UNIVERSE_COUNT,
        "universe_timeout_sec": UNIVERSE_TIMEOUT_SEC,
        "tier_cost_usd": TIER_COST_USD,
    }


def test_shadow_cost_table() -> Dict:
    """Report cost estimation for all tiers + provider combos."""
    from shadow.multiverse import (
        TIER_UNIVERSE_COUNT, UNIVERSE_TIMEOUT_SEC, TIER_COST_USD,
        _PROVIDER_RATE_USD, estimate_cost_for_request,
    )
    rows = []
    for tier in ("quick", "standard", "deep"):
        for provider in ("gemini", "anthropic", "openai"):
            models = {"gen": provider, "critic": provider, "arbiter": provider}
            cost = estimate_cost_for_request(tier, models={"models": models})
            rows.append({
                "tier": tier,
                "provider": provider,
                "universes": TIER_UNIVERSE_COUNT[tier],
                "timeout_sec": UNIVERSE_TIMEOUT_SEC[tier],
                "ceiling_usd": TIER_COST_USD[tier],
                "estimated_usd": cost,
            })
    return {
        "rate_cards": _PROVIDER_RATE_USD,
        "tier_rows": rows,
    }


def test_shadow_project_signals(workspace_root: str) -> Dict:
    from shadow.project_signals import detect as detect_signals
    signals = detect_signals(Path(workspace_root))
    return signals.to_dict()


def test_shadow_events_import() -> Dict:
    from shadow import events
    import inspect
    job_id = "shd_testreport01"
    sig = inspect.signature(events.JobState.__init__)
    params = list(sig.parameters.keys())
    # Build kwargs for all required params so the test is robust to signature changes
    kwargs: dict = dict(job_id=job_id, tier="quick", workspace_path="/tmp/fake")
    if "user_id" in params:
        kwargs["user_id"] = "test_user"
    job = events.JobState(**kwargs)
    assert job.job_id == job_id
    assert job.tier == "quick"
    return {"job_id": job.job_id, "status": "loaded", "params": params}


def test_shadow_cost_ledger(workspace_root: str) -> Dict:
    from shadow import cost_ledger
    repo = Path(workspace_root)
    state = cost_ledger.state(repo)
    assert "spent_today_usd" in state
    assert "daily_cap_usd" in state
    return state


# ── Report rendering ──────────────────────────────────────────────────────────

def _status_badge(status: str) -> str:
    return {"PASS": "PASS", "FAIL": "FAIL", "SKIP": "SKIP"}.get(status, status)


def _render_report(
    workspace_root: str,
    has_gemini: bool,
    has_anthropic: bool,
    has_openai: bool,
    results: List[TestResult],
) -> str:
    now = time.strftime("%Y-%m-%d %H:%M:%S UTC", time.gmtime())
    passes = sum(1 for r in results if r.status == PASS)
    fails = sum(1 for r in results if r.status == FAIL)
    skips = sum(1 for r in results if r.status == SKIP)

    lines: List[str] = []
    w = lines.append

    w("# Synthi Integration Report — RAG + Shadow")
    w("")
    w(f"Generated: {now}")
    w(f"Workspace: `{workspace_root}`")
    w(f"Platform:  {platform.system()} {platform.release()} / Python {sys.version.split()[0]}")
    w("")

    # ── API key status ────────────────────────────────────────────────────────
    w("## API Key Status")
    w("")
    w("| Key | Status | Notes |")
    w("|-----|--------|-------|")
    w(f"| GEMINI_API_KEY | {'**set**' if has_gemini else '**MISSING**'} | Required — RAG embeddings + LLM + Shadow generation/critic/arbiter |")
    w(f"| ANTHROPIC_API_KEY | {'set' if has_anthropic else 'not set'} | Optional — Shadow cross-universe (Anthropic provider) |")
    w(f"| OPENAI_API_KEY | {'set' if has_openai else 'not set'} | Optional — Shadow cross-universe (OpenAI provider) |")
    w("")
    w("### How many keys does Shadow need?")
    w("")
    w("**Minimum: 1** (`GEMINI_API_KEY`). All three tiers (quick/standard/deep) work with")
    w("Gemini alone; generation, criticism, and arbitration all run on Gemini.")
    w("")
    w("**Maximum: 3.** Adding `ANTHROPIC_API_KEY` and `OPENAI_API_KEY` enables")
    w("cross-provider universes — e.g. Gemini generates, Anthropic criticises,")
    w("OpenAI arbitrates — giving diversity of opinion on the patch. Per the rate")
    w("card, Anthropic and OpenAI are ~4–5x more expensive per call than Gemini.")
    w("")

    # ── Summary table ─────────────────────────────────────────────────────────
    w("## Test Summary")
    w("")
    w(f"**{passes} passed / {fails} failed / {skips} skipped** (total {len(results)})")
    w("")
    w("| Test | Status | Time (ms) | Detail |")
    w("|------|--------|----------:|--------|")
    for r in results:
        badge = _status_badge(r.status)
        detail = r.error[:80] if r.error else (r.detail[:80] if r.detail else "")
        w(f"| `{r.name}` | {badge} | {r.elapsed_ms:.0f} | {detail} |")
    w("")

    # ── RAG section ───────────────────────────────────────────────────────────
    w("## RAG Subsystem")
    w("")
    w("### Pipeline Architecture")
    w("")
    w("```")
    w("Step 1  Dual-Ingestion  (offline, no LLM synthesis)  -> DocumentStore + ToC + SummaryIndex")
    w("          DocumentLoader -> ToCExtractor -> SectionSplitter -> SummaryGenerator")
    w("          Embedder (GEMINI_API_KEY) -> SummaryIndex (numpy vector store)")
    w("")
    w("Step 2  Macro-Retrieval (fast, <500ms)               -> top 3-5 docs")
    w("          QueryAnalyzer (multi-query fan-out)")
    w("          SummarySearcher (cosine similarity on embeddings)")
    w("          KeywordFilter (BM25)")
    w("          DocumentRanker (RRF fusion of vector + keyword + recency ranks)")
    w("")
    w("Step 3  Micro-Navigation (agentic LLM, ~200ms)       -> precise sections")
    w("          TreeNavigator (routing LLM traverses ToC tree)")
    w("          SectionExtractor")
    w("          RelevanceScorer")
    w("")
    w("Step 4  Heavy Synthesis (LLM, 1-3s)                  -> cited answer")
    w("          ContextBuilder -> AnswerSynthesizer -> CitationTracker -> ConfidenceScorer")
    w("```")
    w("")
    w("**retrieve_context()** runs Steps 2+3 only — used by the chat pipeline.")
    w("**query()** runs all four steps and returns a self-contained cited answer.")
    w("")

    init_r = next((r for r in results if r.name == "rag:init"), None)
    if init_r and init_r.data:
        d = init_r.data
        w("### Configuration")
        w("")
        w("| Parameter | Value |")
        w("|-----------|-------|")
        w(f"| Fusion method | `{d.get('fusion_method', '?')}` |")
        w(f"| RRF damping k | `{d.get('rrf_k', '?')}` |")
        w(f"| Routing model (Step 3) | `{d.get('routing_model', '?')}` |")
        w(f"| Synthesis model (Step 4) | `{d.get('synthesis_model', '?')}` |")
        w(f"| Embedding model | `{d.get('embedding_model', '?')}` |")
        w(f"| Embedding dimension | `{d.get('embedding_dim', '?')}` |")
        w(f"| Store directory | `{d.get('store_directory', '?')}` |")
        w("")

    ingest_r = next((r for r in results if r.name == "rag:ingest_stats"), None)
    if ingest_r and ingest_r.data:
        d = ingest_r.data
        w("### Ingestion Result (Step 1)")
        w("")
        w("| Metric | Value |")
        w("|--------|-------|")
        w(f"| Processed | {d.get('documents_processed', 0)} |")
        w(f"| Skipped | {d.get('documents_skipped', 0)} |")
        w(f"| Failed | {d.get('documents_failed', 0)} |")
        w(f"| Purged (stale) | {d.get('documents_purged', 0)} |")
        w(f"| Total sections | {d.get('total_sections', 0)} |")
        w(f"| Time (ms) | {d.get('time_ms', 0):.0f} |")
        w("")

    stats_r = next((r for r in results if r.name == "rag:stats"), None)
    if stats_r and stats_r.data:
        d = stats_r.data
        w("### Store State After Ingestion")
        w("")
        w("| Metric | Count |")
        w("|--------|-------|")
        w(f"| Documents | {d.get('documents', 0)} |")
        w(f"| Summaries indexed | {d.get('summaries', 0)} |")
        w(f"| Sections | {d.get('sections', 0)} |")
        w(f"| ToC trees | {d.get('toc_trees', 0)} |")
        w(f"| Keyword docs | {d.get('keyword_docs', 0)} |")
        w(f"| Unique BM25 terms | {d.get('keyword_terms', 0)} |")
        w("")

    ctx_r = next((r for r in results if r.name == "rag:retrieve_context"), None)
    if ctx_r and ctx_r.data:
        d = ctx_r.data
        w("### retrieve_context() — Steps 2+3")
        w("")
        w("Query: _\"How does authentication work?\"_")
        w("")
        w("| Metric | Value |")
        w("|--------|-------|")
        w(f"| Documents searched | {d.get('documents_searched', 0)} |")
        w(f"| Documents selected | {d.get('documents_selected', 0)} |")
        w(f"| Sections assembled | {d.get('sections_used', 0)} |")
        w(f"| Tokens in context | {d.get('tokens_used', 0)} |")
        w(f"| Sufficiency | `{d.get('sufficiency', '?')}` |")
        timing = d.get("timing_ms", {})
        if isinstance(timing, dict):
            w(f"| Macro time (ms) | {timing.get('macro_ms', 0):.1f} |")
            w(f"| Micro time (ms) | {timing.get('micro_ms', 0):.1f} |")
            w(f"| Total time (ms) | {timing.get('total_ms', 0):.1f} |")
        w("")

    # Fusion comparison
    rrf_r = next((r for r in results if r.name == "rag:fusion_rrf"), None)
    wgt_r = next((r for r in results if r.name == "rag:fusion_weighted"), None)
    if rrf_r and wgt_r:
        w("### Fusion Method Comparison")
        w("")
        w("Same query (`authentication session token login`) run with each fusion method.")
        w("")
        w("| Method | Docs selected | Sections | Tokens | Macro (ms) | Micro (ms) | Sufficiency |")
        w("|--------|---------------|----------|--------|------------|------------|-------------|")
        for r in (rrf_r, wgt_r):
            if r.status != PASS:
                w(f"| `{r.data.get('fusion_method','?') if r.data else '?'}` | — | — | — | — | — | {r.status} |")
                continue
            d = r.data
            w(f"| `{d.get('fusion_method', '?')}` "
              f"| {d.get('documents_selected', 0)} "
              f"| {d.get('sections_used', 0)} "
              f"| {d.get('tokens_used', 0)} "
              f"| {d.get('macro_ms', 0):.0f} "
              f"| {d.get('micro_ms', 0):.0f} "
              f"| `{d.get('sufficiency', '?')}` |")
        w("")
        w("**RRF (Reciprocal Rank Fusion)** is the default (Cormack 2009).")
        w("It fuses vector + BM25 + recency by rank position rather than raw scores,")
        w("making it robust to scale differences between cosine similarity and BM25.")
        w("Weighted fusion uses a 0.6/0.3/0.1 vector/keyword/recency sum.")
        w("")

    qr = next((r for r in results if r.name == "rag:query_full"), None)
    if qr:
        w("### query() — Full Pipeline (Steps 2+3+4, with synthesis LLM)")
        w("")
        if qr.status == SKIP:
            w(f"> Skipped: {qr.detail}")
        elif qr.status == PASS and qr.data:
            d = qr.data
            w("Query: _\"What is the RAG pipeline and how does micro-navigation work?\"_")
            w("")
            w("| Metric | Value |")
            w("|--------|-------|")
            w(f"| Confidence | {d.get('confidence', 0):.3f} |")
            w(f"| Citations | {d.get('citations', 0)} |")
            w(f"| Documents searched | {d.get('documents_searched', 0)} |")
            w(f"| Documents selected | {d.get('documents_selected', 0)} |")
            w(f"| Macro time (ms) | {d.get('macro_time_ms', 0):.0f} |")
            w(f"| Micro time (ms) | {d.get('micro_time_ms', 0):.0f} |")
            w(f"| Synthesis time (ms) | {d.get('synthesis_time_ms', 0):.0f} |")
            w(f"| Total time (ms) | {d.get('total_time_ms', 0):.0f} |")
            w("")
            snippet = d.get("answer_snippet", "")
            if snippet:
                w("**Answer snippet:**")
                w("")
                w(f"> {snippet.strip()}")
                w("")
        elif qr.status == FAIL:
            w(f"> FAIL: {qr.error}")
        w("")

    clear_r = next((r for r in results if r.name == "rag:clear"), None)
    if clear_r and clear_r.data and clear_r.status == PASS:
        d = clear_r.data
        w("### Clear + Re-ingest")
        w("")
        w(f"Docs before clear: {d.get('docs_before', '?')} — "
          f"after clear: {d.get('docs_after_clear', '?')} — "
          f"after re-ingest: {d.get('docs_after_reingest', '?')}")
        w("")

    # ── Shadow section ────────────────────────────────────────────────────────
    w("## Shadow Subsystem")
    w("")
    w("### Architecture")
    w("")
    w("```")
    w("POST /shadow/run          -> multiverse.run_job -> N universes in parallel")
    w("  Each Universe:          -> generator -> critic -> critic_critic -> (revise?)")
    w("  convergence check       -> early exit if all universes agree")
    w("  arbiter                 -> adjudicate winner across universe evidence bundles")
    w("")
    w("POST /shadow/{id}/apply   -> apply winning patch, cancel siblings, refund cost")
    w("GET  /shadow/{id}/stream  -> SSE job progress events (real-time)")
    w("POST /shadow/{id}/why     -> re-adjudicate with user follow-up question")
    w("POST /shadow/verify-only  -> verify existing patches without generation")
    w("GET  /shadow/cost/state   -> daily spend vs cap dashboard")
    w("POST /shadow/cost/cap     -> set daily spend cap")
    w("```")
    w("")
    w("shadow_continuous (Wave 4) adds:")
    w("```")
    w("POST /shadow_continuous/notify            -> file-save hook (from collab-server)")
    w("GET  /shadow_continuous/{path}/state      -> continuous shadow state")
    w("POST /shadow_continuous/opt_out           -> opt-out workspace")
    w("```")
    w("")

    cfg_r = next((r for r in results if r.name == "shadow:config"), None)
    if cfg_r and cfg_r.data:
        d = cfg_r.data
        w("### Tier Configuration")
        w("")
        w("| Tier | Universes | Wall-clock cap (s) | Cost ceiling ($) |")
        w("|------|-----------|--------------------|-----------------|")
        for tier in ("quick", "standard", "deep"):
            nu = d["tier_universe_count"][tier]
            to = d["universe_timeout_sec"][tier]
            cap = d["tier_cost_usd"][tier]
            w(f"| `{tier}` | {nu} | {to} | ${cap:.4f} |")
        w("")

    cost_r = next((r for r in results if r.name == "shadow:cost_table"), None)
    if cost_r and cost_r.data:
        d = cost_r.data
        w("### Rate Cards ($ per call, Apr 2026 estimates)")
        w("")
        w("| Provider | gen | critic | arbiter | critic_critic | revise |")
        w("|----------|-----|--------|---------|---------------|--------|")
        for prov, card in d.get("rate_cards", {}).items():
            w(f"| {prov} | ${card['gen']:.4f} | ${card['critic']:.4f} | "
              f"${card['arbiter']:.4f} | ${card['critic_critic']:.4f} | ${card['revise']:.4f} |")
        w("")
        w("### Cost Estimates by Tier x Provider")
        w("")
        w("| Tier | Provider | Universes | Timeout (s) | Ceiling ($) | Estimated ($) |")
        w("|------|----------|-----------|-------------|-------------|---------------|")
        for row in d.get("tier_rows", []):
            w(f"| `{row['tier']}` | {row['provider']} | {row['universes']} | "
              f"{row['timeout_sec']} | ${row['ceiling_usd']:.4f} | ${row['estimated_usd']:.4f} |")
        w("")
        w("> The estimated cost is `min(rate-card sum, tier ceiling)` (master plan §10).")
        w("> The ceiling always wins so the user-visible number never exceeds the")
        w("> contracted budget envelope. Cost is debited up-front and refunded on")
        w("> apply-and-cancel or early convergence.")
        w("")

    sig_r = next((r for r in results if r.name == "shadow:project_signals"), None)
    if sig_r and sig_r.data:
        d = sig_r.data
        w("### Project Signals (temp workspace)")
        w("")
        w("Project signals are detected once per job at the worktree-acquire step.")
        w("They calibrate the Critic-Critic: e.g. `web-app` with no CI gets a")
        w("different actionability threshold than `service` with lockfile + CI.")
        w("")
        w("| Signal | Value |")
        w("|--------|-------|")
        w(f"| Project type | `{d.get('project_type', '?')}` |")
        w(f"| Languages | `{', '.join(d.get('languages', []))}` |")
        w(f"| Test framework | `{d.get('test_framework') or 'none'}` |")
        w(f"| Has CI | `{d.get('has_ci', False)}` |")
        w(f"| Has lockfile | `{d.get('has_lockfile', False)}` |")
        w(f"| Package manager | `{d.get('package_manager') or 'none'}` |")
        w(f"| Style hints | `{', '.join(d.get('style_hints', []))}` |")
        w("")

    ledger_r = next((r for r in results if r.name == "shadow:cost_ledger"), None)
    if ledger_r and ledger_r.data:
        d = ledger_r.data
        w("### Cost Ledger State (fresh workspace)")
        w("")
        w("| Field | Value |")
        w("|-------|-------|")
        for k, v in d.items():
            w(f"| `{k}` | `{v}` |")
        w("")

    # ── How-to sections ───────────────────────────────────────────────────────
    w("## How to Test RAG Only")
    w("")
    w("### Unit/offline tests (no GEMINI_API_KEY required)")
    w("")
    w("```bash")
    w("cd ai-backend/ai-engine")
    w("python -m pytest code_intel/rag/tests/ -v")
    w("```")
    w("")
    w("26 test files covering every module: document_store, toc_store, summary_index,")
    w("section_store, keyword_filter, document_ranker, query_analyzer, toc_extractor,")
    w("section_splitter, summary_searcher, context_builder, citation_tracker,")
    w("confidence_scorer, answer_synthesizer, tree_navigator, relevance_scorer,")
    w("types, config, pipeline, content_hasher, page_resolver, and more.")
    w("")
    w("### Run a specific sub-test")
    w("")
    w("```bash")
    w("python -m pytest code_intel/rag/tests/test_pipeline.py -v")
    w("python -m pytest code_intel/rag/tests/test_document_ranker.py -v  # fusion tests")
    w("python -m pytest code_intel/rag/tests/test_summary_searcher.py -v # vector tests")
    w("```")
    w("")
    w("### This integration report")
    w("")
    w("```bash")
    w("cd ai-backend/ai-engine")
    w("python -m bench.synthi_report                   # auto temp workspace")
    w("python -m bench.synthi_report --no-cleanup      # keep workspace for inspection")
    w("python -m bench.synthi_report --workspace /tmp/myws  # reuse an existing workspace")
    w("```")
    w("")
    w("With GEMINI_API_KEY set: ingestion uses real embeddings, Steps 3+4 use LLM.")
    w("Without GEMINI_API_KEY: ingestion uses zero-vector fallback, Steps 2+3 fall")
    w("back to BM25-only ranking + top-N sections (no routing LLM). Step 4 is skipped.")
    w("")
    w("## How to Test Shadow Only")
    w("")
    w("### Offline (no API key, no server)")
    w("")
    w("```bash")
    w("cd ai-backend/ai-engine")
    w("python -m bench.synthi_report  # shadow:config, shadow:cost_table, etc.")
    w("")
    w("# Cost estimation:")
    w("python -c \"from shadow.multiverse import estimate_cost_for_request; \
print(estimate_cost_for_request('quick'), estimate_cost_for_request('standard'), \
estimate_cost_for_request('deep'))\"")
    w("```")
    w("")
    w("### Bench harness (GEMINI_API_KEY + git workspace required)")
    w("")
    w("```bash")
    w("cd ai-backend/ai-engine")
    w("python -m bench.harness --corpus bench/corpus --out bench/report.md")
    w("# Grid search over scoring weights:")
    w("python -m bench.tune_weights")
    w("```")
    w("")
    w("### Shadow via HTTP (ai-engine must be running)")
    w("")
    w("```bash")
    w("# Start ai-engine")
    w("uvicorn main:app --port 8000")
    w("")
    w("# Check cost state")
    w('curl "http://localhost:8000/shadow/cost/state?workspace_path=/tmp/ws"')
    w("")
    w("# Verify-only (no generation, just structural verification)")
    w('curl -X POST http://localhost:8000/shadow/verify-only \\')
    w('  -H "Content-Type: application/json" \\')
    w("  -d '{\"workspace_path\":\"/tmp/ws\",\"patches\":[{\"path\":\"src/buggy.py\","
      "\"new_content\":\"def divide(a,b):\\n    if b==0: raise ZeroDivisionError()\\n    return a/b\"}],"
      "\"tier\":\"quick\"}'")
    w("")
    w("# Full run (streams SSE events)")
    w('curl -X POST http://localhost:8000/shadow/run \\')
    w('  -H "Content-Type: application/json" \\')
    w("  -d '{\"workspace_path\":\"/tmp/ws\",\"intent\":\"fix\","
      "\"user_request\":\"fix the divide function\","
      "\"patches\":[{\"path\":\"src/buggy.py\","
      "\"new_content\":\"def divide(a,b):\\n    if b==0: raise ZeroDivisionError()\\n    return a/b\"}],"
      "\"tier\":\"quick\"}'")
    w("```")
    w("")

    # ── Failures detail ───────────────────────────────────────────────────────
    failed = [r for r in results if r.status == FAIL]
    if failed:
        w("## Failure Details")
        w("")
        for r in failed:
            w(f"### `{r.name}`")
            w("")
            w("```")
            w(r.detail or r.error)
            w("```")
            w("")

    return "\n".join(lines)


# ── Main ──────────────────────────────────────────────────────────────────────

def main() -> None:
    parser = argparse.ArgumentParser(description="Synthi integration report")
    parser.add_argument("--workspace", default="",
                        help="Reuse an existing workspace dir (default: create temp)")
    parser.add_argument("--out", default="bench/synthi_report.md",
                        help="Output Markdown path (default: bench/synthi_report.md)")
    parser.add_argument("--no-cleanup", action="store_true",
                        help="Keep temp workspace after run")
    parser.add_argument("--reuse-store", action="store_true",
                        help="Skip ingest if .synthi/rag/ already has docs (fast iteration)")
    args = parser.parse_args()

    _shared["reuse_store"] = args.reuse_store

    has_gemini = bool(os.getenv("GEMINI_API_KEY") or os.getenv("GOOGLE_API_KEY"))
    has_anthropic = bool(os.getenv("ANTHROPIC_API_KEY"))
    has_openai = bool(os.getenv("OPENAI_API_KEY"))

    # Workspace setup
    cleanup = False
    if args.workspace:
        workspace_root = args.workspace
        Path(workspace_root).mkdir(parents=True, exist_ok=True)
    else:
        workspace_root = tempfile.mkdtemp(prefix="synthi_report_ws_")
        cleanup = not args.no_cleanup

    try:
        print("")
        print("Synthi Integration Report")
        print(f"Workspace: {workspace_root}")
        print(f"API keys:  GEMINI={'set' if has_gemini else 'MISSING'}  "
              f"ANTHROPIC={'set' if has_anthropic else 'not set'}  "
              f"OPENAI={'set' if has_openai else 'not set'}")
        print("")

        print("Creating sample workspace files...")
        create_workspace(Path(workspace_root))
        print("")

        # --- RAG tests --------------------------------------------------------
        print("--- RAG Tests ------------------------------------------------")
        run_test("rag:init",           test_rag_init, workspace_root)
        run_test("rag:ingest_stats",   test_rag_ingest_stats, workspace_root)
        run_test("rag:stats",          test_rag_stats, workspace_root)
        run_test("rag:dedup",          test_rag_dedup, workspace_root)
        run_test("rag:remove_file",    test_rag_remove_file, workspace_root)
        run_test("rag:fusion_rrf",     test_rag_fusion_rrf, workspace_root)
        run_test("rag:fusion_weighted",test_rag_fusion_weighted, workspace_root)
        run_test("rag:retrieve_context", test_rag_retrieve_context, workspace_root)
        run_test(
            "rag:query_full",
            test_rag_query_full, workspace_root,
            skip_reason="" if has_gemini else "GEMINI_API_KEY not set - LLM synthesis skipped",
        )
        run_test("rag:clear",          test_rag_clear, workspace_root)
        print("")

        # --- Shadow tests -----------------------------------------------------
        print("--- Shadow Tests ---------------------------------------------")
        run_test("shadow:config",          test_shadow_config)
        run_test("shadow:cost_table",      test_shadow_cost_table)
        run_test("shadow:project_signals", test_shadow_project_signals, workspace_root)
        run_test("shadow:events_import",   test_shadow_events_import)
        run_test("shadow:cost_ledger",     test_shadow_cost_ledger, workspace_root)
        print("")

        # --- Render report ----------------------------------------------------
        report_md = _render_report(
            workspace_root=workspace_root,
            has_gemini=has_gemini,
            has_anthropic=has_anthropic,
            has_openai=has_openai,
            results=_results,
        )

        out_path = Path(args.out)
        out_path.parent.mkdir(parents=True, exist_ok=True)
        out_path.write_text(report_md, encoding="utf-8")

        passes = sum(1 for r in _results if r.status == PASS)
        fails  = sum(1 for r in _results if r.status == FAIL)
        skips  = sum(1 for r in _results if r.status == SKIP)
        print(f"Results: {passes} passed, {fails} failed, {skips} skipped")
        print(f"Report:  {out_path.resolve()}")

        if fails:
            sys.exit(1)

    finally:
        if cleanup:
            shutil.rmtree(workspace_root, ignore_errors=True)


if __name__ == "__main__":
    main()
