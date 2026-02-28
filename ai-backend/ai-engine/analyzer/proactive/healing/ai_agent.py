"""
AI Healing Agent — the core agentic loop.

Orchestrates:
    1. Context collection (imports, related files, project hints)
    2. Error detection via LLM
    3. Optional second-opinion validation via LLM
    4. Confidence calibration
    5. Conversion to HealingFix objects

This is the "truly agentic" layer — the LLM is the detector, not regex.
"""

from __future__ import annotations

import asyncio
import logging
import time
from typing import Any, Dict, List, Optional, Tuple
from dataclasses import dataclass, field

from llm.providers import get_provider

from .ai_prompts import (
    build_detect_prompt,
    build_validate_prompt,
    build_batch_prompt,
    format_related_files,
    format_context_notes,
    AGENT_SYSTEM_PROMPT,
)
from .ai_parser import (
    parse_detection_response,
    parse_validation_response,
    parse_batch_response,
)
from .ai_context import (
    collect_context,
    AnalysisContext,
)
from .ai_memory import AIAgentMemory, get_agent_memory
from .ai_rate_limiter import get_rate_limiter, RateLimitExceeded
from .ai_retry import with_retry
from .types import HealingFix, HealingSeverity

logger = logging.getLogger("healing.ai_agent")


# ── Configuration ─────────────────────────────────────────────────────

@dataclass
class AIAgentConfig:
    """Configuration for the AI healing agent."""

    # Whether to run a second LLM call to validate each fix
    validate_fixes: bool = True

    # Minimum confidence to keep a fix (after calibration)
    min_confidence: float = 0.55

    # Minimum validation confidence to keep a fix
    min_validation_confidence: float = 0.6

    # Maximum number of fixes per file
    max_fixes_per_file: int = 15

    # Timeout for a single LLM call (seconds)
    llm_timeout: float = 30.0

    # Whether to collect cross-file context
    use_cross_file_context: bool = True

    # Model override (None = use default)
    model: Optional[str] = None

    # API key override (None = use env var)
    api_key: Optional[str] = None

    # Confidence discount: AI confidence is multiplied by this factor
    # because LLMs tend to be over-confident
    confidence_discount: float = 0.85

    # Skip validation for fixes above this confidence
    auto_accept_threshold: float = 0.92


# ── Agent stats ───────────────────────────────────────────────────────

@dataclass
class AIAgentStats:
    """Runtime statistics for the AI agent."""
    total_detections: int = 0
    total_validations: int = 0
    total_fixes_proposed: int = 0
    total_fixes_rejected: int = 0
    total_llm_calls: int = 0
    total_llm_errors: int = 0
    total_latency_ms: float = 0.0
    avg_confidence: float = 0.0
    _confidence_sum: float = 0.0


# ── The Agent ─────────────────────────────────────────────────────────

class AIHealingAgent:
    """
    Agentic AI-powered error detection and fix generation.

    Unlike the regex-based rules, this agent sends code to an LLM and
    asks it to identify real bugs: logic errors, null safety issues,
    missing awaits, off-by-one errors, etc.

    The agent:
    1. Collects context (imports, related files)
    2. Sends code + context to LLM for detection
    3. Parses the structured JSON response
    4. Optionally validates each fix with a second LLM call
    5. Calibrates confidence (discounts over-confident LLM scores)
    6. Returns validated HealingFix objects
    """

    def __init__(self, config: Optional[AIAgentConfig] = None):
        self.config = config or AIAgentConfig()
        self.stats = AIAgentStats()
        self._provider = None
        self._memory = get_agent_memory()

    def _get_provider(self):
        """Lazy-init the LLM provider."""
        if self._provider is None:
            self._provider = get_provider()
        return self._provider

    # ── Single-file detection ─────────────────────────────────────────

    async def detect(
        self,
        file_path: str,
        source_code: str,
        language: Optional[str] = None,
        workspace_root: Optional[str] = None,
        focus_range: Optional[Tuple[int, int]] = None,
        read_file_fn=None,
    ) -> List[HealingFix]:
        """
        Detect errors in a single file using AI.

        Returns a list of HealingFix objects, each representing a
        real bug found by the LLM. Fixes are validated and confidence-
        calibrated.
        """
        start_time = time.time()

        # 1. Collect context
        ctx = collect_context(
            file_path=file_path,
            source_code=source_code,
            language=language,
            workspace_root=workspace_root,
            focus_range=focus_range,
            read_file_fn=read_file_fn if self.config.use_cross_file_context else None,
        )

        # 2. Build the detection prompt
        if ctx.related_files:
            related_text = format_related_files([
                {"path": f.path, "content": f.content}
                for f in ctx.related_files
            ])
            context_notes_text = format_context_notes(ctx.context_notes)
            prompt = build_detect_prompt(
                ctx.source_code,
                ctx.language,
                related_files=related_text,
                context_notes=context_notes_text,
            )
        else:
            prompt = build_detect_prompt(ctx.source_code, ctx.language)

        # 3. Call the LLM
        raw_response = await self._call_llm(
            code=ctx.source_code,
            language=ctx.language,
            prompt=prompt,
        )
        self.stats.total_detections += 1

        if not raw_response:
            return []

        # 4. Parse the response
        fixes = parse_detection_response(
            raw_response, ctx.source_code, file_path
        )

        # 5. Calibrate confidence
        fixes = self._calibrate_confidence(fixes)

        # 6. Filter by minimum confidence
        fixes = [f for f in fixes if f.confidence >= self.config.min_confidence]

        # 7. Optionally validate each fix
        if self.config.validate_fixes:
            fixes = await self._validate_fixes(fixes, ctx)

        # 8. Limit count
        fixes = fixes[: self.config.max_fixes_per_file]

        # 9. Update stats
        self.stats.total_fixes_proposed += len(fixes)
        elapsed = (time.time() - start_time) * 1000
        self.stats.total_latency_ms += elapsed

        logger.info(
            f"AI agent detected {len(fixes)} fixes in {file_path} "
            f"({elapsed:.0f}ms)"
        )

        return fixes

    # ── Batch detection ───────────────────────────────────────────────

    async def detect_batch(
        self,
        files: Dict[str, str],
        language: Optional[str] = None,
    ) -> Dict[str, List[HealingFix]]:
        """
        Detect errors across multiple files in one LLM call.

        More efficient than calling detect() per file when analyzing
        a batch of related files.
        """
        if not files:
            return {}

        if len(files) == 1:
            path, source = next(iter(files.items()))
            fixes = await self.detect(path, source, language)
            return {path: fixes} if fixes else {}

        # For batch, use the batch prompt
        prompt = build_batch_prompt(files, language or "unknown")

        # Use first file's source as the primary code arg
        first_path = next(iter(files))
        first_source = files[first_path]

        raw_response = await self._call_llm(
            code=first_source,
            language=language or "unknown",
            prompt=prompt,
        )
        self.stats.total_detections += 1

        if not raw_response:
            return {}

        results = parse_batch_response(raw_response, files)

        # Calibrate confidence for all files
        for path in results:
            results[path] = self._calibrate_confidence(results[path])
            results[path] = [
                f for f in results[path]
                if f.confidence >= self.config.min_confidence
            ]

        return results

    # ── Validation ────────────────────────────────────────────────────

    async def _validate_fixes(
        self,
        fixes: List[HealingFix],
        ctx: AnalysisContext,
    ) -> List[HealingFix]:
        """
        Run a second LLM call to validate each fix.

        High-confidence fixes above auto_accept_threshold skip validation.
        """
        if not fixes:
            return []

        validated = []
        tasks = []

        for fix in fixes:
            # Skip validation for very high confidence fixes
            if fix.confidence >= self.config.auto_accept_threshold:
                validated.append(fix)
                continue
            tasks.append((fix, self._validate_single_fix(fix, ctx)))

        # Run validations concurrently (with some limit)
        if tasks:
            semaphore = asyncio.Semaphore(3)  # Max 3 concurrent validations

            async def bounded_validate(fix, coro):
                async with semaphore:
                    return fix, await coro

            results = await asyncio.gather(
                *[bounded_validate(f, c) for f, c in tasks],
                return_exceptions=True,
            )

            for result in results:
                if isinstance(result, Exception):
                    logger.warning(f"Validation error: {result}")
                    continue
                fix, validation = result
                if validation["is_valid"]:
                    # Blend validation confidence with detection confidence
                    val_conf = validation["confidence"]
                    fix.confidence = (fix.confidence + val_conf) / 2

                    # Use improved replacement if provided
                    improved = validation.get("improved_replacement")
                    if improved and improved != fix.replacement_text:
                        fix.replacement_text = improved
                        fix.description += " (AI-refined)"

                    if fix.confidence >= self.config.min_validation_confidence:
                        validated.append(fix)
                    else:
                        self.stats.total_fixes_rejected += 1
                else:
                    self.stats.total_fixes_rejected += 1
                    logger.debug(
                        f"Fix rejected by validation: {validation.get('reason', 'unknown')}"
                    )

        self.stats.total_validations += len(tasks)
        return validated

    async def _validate_single_fix(
        self,
        fix: HealingFix,
        ctx: AnalysisContext,
    ) -> Dict[str, Any]:
        """Validate a single fix with a second LLM call."""
        prompt = build_validate_prompt(
            original=fix.original_text,
            replacement=fix.replacement_text,
            language=ctx.language,
            surrounding_code=self._get_surrounding_code(
                ctx.source_code, fix.line, radius=5
            ),
        )

        raw = await self._call_llm(
            code=ctx.source_code,
            language=ctx.language,
            prompt=prompt,
        )

        return parse_validation_response(raw)

    # ── LLM call wrapper ──────────────────────────────────────────────

    async def _call_llm(
        self,
        code: str,
        language: str,
        prompt: str,
    ) -> Optional[str]:
        """
        Call the LLM with rate limiting, timeout, and error handling.

        Returns the raw response text, or None on failure.
        """
        provider = self._get_provider()
        self.stats.total_llm_calls += 1

        # Acquire a rate-limit token (waits up to 15s, then raises)
        limiter = get_rate_limiter()
        try:
            await limiter.acquire()
        except RateLimitExceeded as e:
            logger.warning(f"LLM rate limit exceeded: {e}")
            self.stats.total_llm_errors += 1
            return None

        try:
            result = await with_retry(
                coroutine_fn=lambda: asyncio.wait_for(
                    provider.ask_llm(
                        code=code,
                        lang=language,
                        prompt=prompt,
                        model=self.config.model,
                        api_key=self.config.api_key,
                    ),
                    timeout=self.config.llm_timeout,
                ),
                max_retries=2,
                base_delay=1.0,
                max_delay=8.0,
                on_retry=lambda attempt, exc, delay: logger.info(
                    f"LLM retry {attempt + 1}/2 in {delay:.1f}s ({exc})"
                ),
            )
            return result
        except asyncio.TimeoutError:
            logger.warning(
                f"LLM call timed out after {self.config.llm_timeout}s (after retries)"
            )
            self.stats.total_llm_errors += 1
            return None
        except Exception as e:
            logger.error(f"LLM call failed after retries: {e}")
            self.stats.total_llm_errors += 1
            return None

    # ── Confidence calibration ────────────────────────────────────────

    def _calibrate_confidence(self, fixes: List[HealingFix]) -> List[HealingFix]:
        """
        Apply confidence calibration using both discount factor and
        historical user feedback from the agent memory.

        1. Apply base discount (LLMs are over-confident)
        2. Apply memory adjustment (boost accepted patterns, penalize rejected)
        3. Filter out suppressed patterns (user always rejects)
        """
        discount = self.config.confidence_discount
        calibrated = []

        for fix in fixes:
            # Skip suppressed patterns
            if self._memory.is_suppressed(fix.rule_id):
                logger.debug(f"Suppressed fix: {fix.rule_id} — {fix.description}")
                self.stats.total_fixes_rejected += 1
                continue

            # Base discount
            fix.confidence = round(fix.confidence * discount, 3)

            # Memory-based adjustment
            memory_adj = self._memory.get_confidence_adjustment(fix.rule_id)
            fix.confidence = round(fix.confidence * memory_adj, 3)
            fix.confidence = max(0.0, min(1.0, fix.confidence))

            # Boost for high-severity issues
            if fix.severity == HealingSeverity.CRITICAL:
                fix.confidence = min(1.0, fix.confidence * 1.1)

            # Track for stats
            self.stats._confidence_sum += fix.confidence
            calibrated.append(fix)

        total = self.stats.total_fixes_proposed + len(calibrated)
        if total > 0:
            self.stats.avg_confidence = self.stats._confidence_sum / total

        return calibrated

    # ── Helpers ────────────────────────────────────────────────────────

    @staticmethod
    def _get_surrounding_code(
        source: str, line: int, radius: int = 5
    ) -> str:
        """Get code surrounding a specific line."""
        lines = source.split("\n")
        start = max(0, line - radius)
        end = min(len(lines), line + radius + 1)
        numbered = []
        for i in range(start, end):
            marker = ">>>" if i == line else "   "
            numbered.append(f"{marker} {i + 1:4d} | {lines[i]}")
        return "\n".join(numbered)

    def get_stats(self) -> Dict[str, Any]:
        """Return current agent statistics."""
        return {
            "total_detections": self.stats.total_detections,
            "total_validations": self.stats.total_validations,
            "total_fixes_proposed": self.stats.total_fixes_proposed,
            "total_fixes_rejected": self.stats.total_fixes_rejected,
            "total_llm_calls": self.stats.total_llm_calls,
            "total_llm_errors": self.stats.total_llm_errors,
            "total_latency_ms": round(self.stats.total_latency_ms, 1),
            "avg_confidence": round(self.stats.avg_confidence, 3),
            "acceptance_rate": (
                round(
                    self.stats.total_fixes_proposed
                    / max(1, self.stats.total_fixes_proposed + self.stats.total_fixes_rejected),
                    3,
                )
            ),
        }

    def reset_stats(self):
        """Reset agent statistics."""
        self.stats = AIAgentStats()
