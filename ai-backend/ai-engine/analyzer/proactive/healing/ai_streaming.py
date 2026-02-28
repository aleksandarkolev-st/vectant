"""
Streaming AI analysis.

Wraps the AI agent to support Server-Sent Events (SSE) streaming,
allowing the frontend to display partial results as the LLM generates
them. Also supports progress reporting.

Usage:
    from .ai_streaming import stream_ai_analysis

    @app.post("/heal/ai/stream")
    async def heal_ai_stream(req: AIAnalyzeRequest):
        return StreamingResponse(
            stream_ai_analysis(req.code, req.lang, req.file_path),
            media_type="text/event-stream",
        )
"""

from __future__ import annotations

import asyncio
import json
import logging
import time
from typing import AsyncIterator, Dict, List, Optional, Tuple

from .ai_agent import AIHealingAgent, AIAgentConfig
from .ai_context import collect_context
from .ai_prompts import build_detect_prompt, format_related_files, format_context_notes
from .types import HealingFix

logger = logging.getLogger("healing.ai_streaming")


async def stream_ai_analysis(
    code: str,
    language: str,
    file_path: str = "untitled",
    workspace_root: Optional[str] = None,
    agent_config: Optional[AIAgentConfig] = None,
) -> AsyncIterator[str]:
    """
    Generator that yields SSE events as AI analysis progresses.

    Events:
    - "progress" — status update with percentage
    - "partial_fix" — a single fix detected so far
    - "complete" — final result with all fixes
    - "error" — analysis failed

    Each event is a JSON-encoded SSE string:
        data: {"event": "progress", "data": {...}}
    """
    agent = AIHealingAgent(agent_config or AIAgentConfig())
    start_time = time.time()

    def sse(event: str, data: dict) -> str:
        payload = json.dumps({"event": event, "data": data})
        return f"data: {payload}\n\n"

    # Phase 1: Context collection
    yield sse("progress", {
        "phase": "context",
        "message": "Collecting code context...",
        "percent": 10,
    })

    try:
        ctx = collect_context(
            file_path=file_path,
            source_code=code,
            language=language,
            workspace_root=workspace_root,
        )
    except Exception as e:
        yield sse("error", {"message": f"Context collection failed: {e}"})
        return

    yield sse("progress", {
        "phase": "context_done",
        "message": f"Context ready ({len(ctx.related_files)} related files)",
        "percent": 20,
    })

    # Phase 2: LLM detection
    yield sse("progress", {
        "phase": "detecting",
        "message": "AI is analyzing your code...",
        "percent": 30,
    })

    try:
        fixes = await agent.detect(
            file_path=file_path,
            source_code=code,
            language=language,
            workspace_root=workspace_root,
        )
    except Exception as e:
        yield sse("error", {"message": f"AI detection failed: {e}"})
        return

    yield sse("progress", {
        "phase": "detection_done",
        "message": f"Found {len(fixes)} potential issues",
        "percent": 70,
    })

    # Phase 3: Emit individual fixes
    for i, fix in enumerate(fixes):
        yield sse("partial_fix", {
            "index": i,
            "total": len(fixes),
            "fix": _fix_to_sse_dict(fix),
        })
        # Small delay to let frontend render
        await asyncio.sleep(0.05)

    yield sse("progress", {
        "phase": "finalizing",
        "message": "Finalizing results...",
        "percent": 90,
    })

    # Phase 4: Complete
    elapsed_ms = (time.time() - start_time) * 1000

    yield sse("complete", {
        "fixCount": len(fixes),
        "fixes": [_fix_to_sse_dict(f) for f in fixes],
        "elapsedMs": round(elapsed_ms, 1),
        "agentStats": agent.get_stats(),
    })

    yield sse("progress", {
        "phase": "done",
        "message": "Analysis complete",
        "percent": 100,
    })


def _fix_to_sse_dict(fix: HealingFix) -> dict:
    """Convert a HealingFix to a dict for SSE transmission."""
    try:
        return fix.to_dict()
    except AttributeError:
        return {
            "line": fix.line,
            "end_line": fix.end_line,
            "column": fix.column,
            "end_column": fix.end_column,
            "description": fix.description,
            "original_text": fix.original_text,
            "replacement_text": fix.replacement_text,
            "confidence": fix.confidence,
            "severity": getattr(fix.severity, "value", "moderate"),
            "category": getattr(fix.category, "value", "other"),
            "is_safe": fix.is_safe,
            "rule_id": fix.rule_id,
        }
