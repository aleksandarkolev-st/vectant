"""Targeted Auto-Fix Engine

Coordinates detection, classification, and application of targeted
code fixes. Supports two detection modes:

1. **Regex mode** (fast, <50ms): Heuristic rules for obvious syntax issues
2. **AI mode** (slower, <30s): LLM-powered detection for real bugs —
   logic errors, null safety, missing awaits, off-by-one, etc.

The AI agent is the "truly agentic" layer. It sends code to the LLM,
collects cross-file context, and validates each fix with a second
LLM call before proposing it.
"""

from __future__ import annotations

import asyncio
import hashlib
import logging
import time
from typing import Any, Callable, Dict, List, Optional, Set

from .ai_fix_utils import deduplicate_fixes

from .types import (
    HealingCategory,
    HealingSeverity,
    HealingAction,
    HealingFix,
    HealingResult,
    HealingConfig,
    HealingEvent,
    HealingStats,
)
from .classifier import HealingClassifier
from .rule_registry import HealingRuleRegistry, get_registry
from .cache import HealingCache
from .ai_agent import AIHealingAgent, AIAgentConfig

# Import rules to trigger registration
from . import rules  # noqa: F401

logger = logging.getLogger("healing.engine")


class SelfHealingEngine:
    """
    Targeted auto-fix engine.
    
    Coordinates detection and classification of micro-fixes.
    
    1. Conservative: Only fixes obvious, safe issues
    2. Fast: Rules are regex-based, typically < 50ms total
    3. Non-intrusive: Never changes program logic
    4. Transparent: Every fix is logged and can be undone
    
    Detection is regex + line-scanning. No AST, no LSP.
    Confidence values are hand-tuned heuristics, not calibrated probabilities.
    
    For AI-powered detection, use analyze_with_ai() instead of analyze().
    """
    
    def __init__(
        self,
        config: Optional[HealingConfig] = None,
        registry: Optional[HealingRuleRegistry] = None,
        classifier: Optional[HealingClassifier] = None,
        ai_config: Optional[AIAgentConfig] = None,
    ):
        self._config = config or HealingConfig()
        self._registry = registry or get_registry()
        self._classifier = classifier or HealingClassifier(
            min_confidence=self._config.min_confidence,
        )
        self._stats = HealingStats()
        self._cache = HealingCache()
        self._event_listeners: List[Callable[[HealingEvent], None]] = []
        self._last_heal_time: Dict[str, float] = {}  # file_path -> timestamp
        self._applied_fixes: Dict[str, List[HealingFix]] = {}  # file_path -> fixes
        self._cooldown_locks: Set[str] = set()
        self._rule_latencies: Dict[str, float] = {}  # rule_id -> last ms
        
        # AI agent — lazy-initialized
        self._ai_config = ai_config
        self._ai_agent: Optional[AIHealingAgent] = None
    
    @property
    def config(self) -> HealingConfig:
        return self._config
    
    @property
    def stats(self) -> HealingStats:
        return self._stats
    
    def update_config(self, **kwargs) -> None:
        """Update configuration dynamically."""
        for key, value in kwargs.items():
            if hasattr(self._config, key):
                setattr(self._config, key, value)
    
    def on_event(self, listener: Callable[[HealingEvent], None]) -> Callable:
        """Register an event listener. Returns an unsubscribe function."""
        self._event_listeners.append(listener)
        return lambda: self._event_listeners.remove(listener)
    
    def _emit_event(self, event: HealingEvent) -> None:
        """Emit an event to all listeners."""
        for listener in self._event_listeners:
            try:
                listener(event)
            except Exception as e:
                logger.warning(f"Event listener error: {e}")
    
    async def analyze(
        self,
        code: str,
        language: str,
        file_path: str = "untitled",
    ) -> HealingResult:
        """
        Analyze code and detect auto-healable issues.
        
        This is the main entry point. It:
        1. Runs all applicable healing rules
        2. Classifies each fix for safety
        3. Returns a HealingResult with safe and unsafe fixes
        
        Does NOT apply fixes - the caller decides what to do.
        """
        if not self._config.enabled:
            return HealingResult(
                file_path=file_path,
                language=language,
                content_hash=self._compute_hash(code),
            )
        
        start_time = time.perf_counter()
        content_hash = self._compute_hash(code)
        
        # Check cache first
        cached = self._cache.get(content_hash, language)
        if cached is not None:
            logger.debug(f"Cache hit for {file_path}")
            return cached
        
        # Check cooldown
        if self._is_on_cooldown(file_path):
            return HealingResult(
                file_path=file_path,
                language=language,
                content_hash=content_hash,
            )
        
        # Run all applicable rules
        all_fixes: List[HealingFix] = []
        skipped: List[Dict[str, Any]] = []
        
        applicable_rules = self._registry.get_rules_for_language(language)
        logger.debug(f"Running {len(applicable_rules)} healing rules for {language}")
        
        rule_timeout_ms = 10.0  # Per-rule timeout in ms
        
        for rule in applicable_rules:
            try:
                rule_start = time.perf_counter()
                fixes = rule.detect(code, language, file_path)
                rule_elapsed = (time.perf_counter() - rule_start) * 1000
                
                # Record per-rule latency for SLO tracking
                self._rule_latencies[rule.rule_id] = rule_elapsed
                
                if rule_elapsed > rule_timeout_ms:
                    logger.warning(
                        f"Rule {rule.rule_id} exceeded timeout: "
                        f"{rule_elapsed:.1f}ms > {rule_timeout_ms}ms"
                    )
                    skipped.append({
                        "ruleId": rule.rule_id,
                        "reason": "rule_timeout",
                        "elapsedMs": round(rule_elapsed, 1),
                    })
                    continue  # Drop results from slow rules
                
                # Filter by enabled categories
                for fix in fixes:
                    if fix.category in self._config.auto_heal_categories:
                        all_fixes.append(fix)
                    else:
                        skipped.append({
                            "ruleId": rule.rule_id,
                            "category": fix.category.value,
                            "reason": "category_disabled",
                            "description": fix.description,
                        })
            except Exception as e:
                logger.warning(f"Healing rule {rule.rule_id} failed: {e}")
                skipped.append({
                    "ruleId": rule.rule_id,
                    "reason": "rule_error",
                    "error": str(e),
                })
        
        # Classify all fixes for safety
        self._classifier.classify_fixes(all_fixes, code, language)
        
        # Resolve overlapping edit conflicts (drop lower-priority overlaps)
        all_fixes, conflict_skipped = self._resolve_conflicts(all_fixes)
        skipped.extend(conflict_skipped)
        
        # Deduplicate fixes (same location, same action)
        all_fixes = self._deduplicate_fixes(all_fixes)
        
        # Sort by priority: critical first, then moderate, then low
        severity_order = {
            HealingSeverity.CRITICAL: 0,
            HealingSeverity.MODERATE: 1,
            HealingSeverity.LOW: 2,
        }
        all_fixes.sort(key=lambda f: severity_order.get(f.severity, 99))
        
        # Limit number of fixes per pass
        if len(all_fixes) > self._config.max_fixes_per_pass:
            excess = all_fixes[self._config.max_fixes_per_pass:]
            all_fixes = all_fixes[:self._config.max_fixes_per_pass]
            for fix in excess:
                skipped.append({
                    "ruleId": fix.rule_id,
                    "category": fix.category.value,
                    "reason": "max_fixes_exceeded",
                    "description": fix.description,
                })
        
        elapsed_ms = (time.perf_counter() - start_time) * 1000
        
        result = HealingResult(
            file_path=file_path,
            language=language,
            content_hash=content_hash,
            fixes=all_fixes,
            skipped_issues=skipped,
            elapsed_ms=elapsed_ms,
        )
        
        # Emit detection events
        for fix in all_fixes:
            self._emit_event(HealingEvent(
                event_type="fix_detected",
                fix=fix,
                file_path=file_path,
                details={"isSafe": fix.is_safe},
            ))
        
        logger.info(
            f"Healing analysis: {len(all_fixes)} fixes found "
            f"({result.auto_fixable_count} auto-fixable) "
            f"in {elapsed_ms:.1f}ms for {file_path}"
        )
        
        # Cache the result
        self._cache.put(result)
        
        return result
    
    # ── AI-powered analysis ───────────────────────────────────────────

    def _get_ai_agent(self) -> AIHealingAgent:
        """Lazy-init the AI healing agent."""
        if self._ai_agent is None:
            self._ai_agent = AIHealingAgent(self._ai_config)
        return self._ai_agent

    async def analyze_with_ai(
        self,
        code: str,
        language: str,
        file_path: str = "untitled",
        workspace_root: Optional[str] = None,
        focus_range: Optional[tuple] = None,
        read_file_fn=None,
    ) -> HealingResult:
        """
        Analyze code using the AI agent (LLM-powered detection).

        This is the agentic alternative to analyze(). Instead of regex
        rules, it sends the code to an LLM which identifies real bugs:
        logic errors, null safety, missing awaits, off-by-one, etc.

        Slower than regex (~5-30s vs <50ms) but catches real issues
        that no regex can find.
        """
        if not self._config.enabled:
            return HealingResult(
                file_path=file_path,
                language=language,
                content_hash=self._compute_hash(code),
            )

        start_time = time.perf_counter()
        content_hash = self._compute_hash(code)

        agent = self._get_ai_agent()

        try:
            ai_fixes = await agent.detect(
                file_path=file_path,
                source_code=code,
                language=language,
                workspace_root=workspace_root,
                focus_range=focus_range,
                read_file_fn=read_file_fn,
            )
        except Exception as e:
            logger.error(f"AI agent detection failed: {e}")
            ai_fixes = []

        # Classify AI fixes for safety
        self._classifier.classify_fixes(ai_fixes, code, language)

        # Resolve conflicts
        ai_fixes, skipped = self._resolve_conflicts(ai_fixes)
        ai_fixes = self._deduplicate_fixes(ai_fixes)

        elapsed_ms = (time.perf_counter() - start_time) * 1000

        result = HealingResult(
            file_path=file_path,
            language=language,
            content_hash=content_hash,
            fixes=ai_fixes,
            skipped_issues=skipped,
            elapsed_ms=elapsed_ms,
        )

        for fix in ai_fixes:
            self._emit_event(HealingEvent(
                event_type="ai_fix_detected",
                fix=fix,
                file_path=file_path,
                details={"isSafe": fix.is_safe, "source": "ai_agent"},
            ))

        logger.info(
            f"AI analysis: {len(ai_fixes)} fixes found "
            f"({result.auto_fixable_count} auto-fixable) "
            f"in {elapsed_ms:.1f}ms for {file_path}"
        )

        return result

    async def analyze_hybrid(
        self,
        code: str,
        language: str,
        file_path: str = "untitled",
        workspace_root: Optional[str] = None,
        read_file_fn=None,
    ) -> HealingResult:
        """
        Run both regex rules AND AI detection, merge results.

        The regex rules run first (fast, <50ms), then the AI agent
        runs in parallel to find deeper issues. Results are merged
        with conflict resolution — AI fixes take priority over regex
        fixes at the same location.
        """
        # Run regex analysis first (fast)
        regex_result = await self.analyze(code, language, file_path)

        # Run AI analysis (slow)
        ai_result = await self.analyze_with_ai(
            code, language, file_path,
            workspace_root=workspace_root,
            read_file_fn=read_file_fn,
        )

        # Merge: start with AI fixes, add non-conflicting regex fixes
        merged_fixes = list(ai_result.fixes)
        ai_lines = {(f.line, f.end_line) for f in ai_result.fixes}

        for fix in regex_result.fixes:
            # Check if regex fix overlaps with any AI fix
            overlaps = any(
                not (fix.end_line < ai_start or fix.line > ai_end)
                for ai_start, ai_end in ai_lines
            )
            if not overlaps:
                merged_fixes.append(fix)

        # Deduplicate (higher-confidence wins for same line+category)
        merged_fixes = deduplicate_fixes(merged_fixes)

        # Re-resolve conflicts on merged set
        merged_fixes, merge_skipped = self._resolve_conflicts(merged_fixes)

        elapsed_ms = regex_result.elapsed_ms + ai_result.elapsed_ms

        return HealingResult(
            file_path=file_path,
            language=language,
            content_hash=ai_result.content_hash,
            fixes=merged_fixes,
            skipped_issues=(
                regex_result.skipped_issues
                + ai_result.skipped_issues
                + merge_skipped
            ),
            elapsed_ms=elapsed_ms,
        )

    def get_ai_stats(self) -> Dict[str, Any]:
        """Get AI agent statistics."""
        if self._ai_agent is None:
            return {"status": "not_initialized"}
        return self._ai_agent.get_stats()

    def apply_fix(
        self,
        code: str,
        fix: HealingFix,
    ) -> str:
        """
        Apply a single fix to the code and return the modified code.
        
        This does NOT validate safety - the caller should check
        fix.is_safe before calling this.
        """
        lines = code.split('\n')
        
        if fix.action == HealingAction.INSERT:
            # Insert text at position
            if fix.line < len(lines):
                line = lines[fix.line]
                new_line = line[:fix.column] + fix.replacement_text + line[fix.column:]
                lines[fix.line] = new_line
            elif fix.line == len(lines):
                # Append at end
                lines.append(fix.replacement_text)
        
        elif fix.action == HealingAction.DELETE:
            if fix.line == fix.end_line:
                # Single line deletion
                if fix.line < len(lines):
                    line = lines[fix.line]
                    new_line = line[:fix.column] + line[fix.end_column:]
                    if not new_line.strip():
                        # If the line is now empty, remove it entirely
                        lines.pop(fix.line)
                    else:
                        lines[fix.line] = new_line
            else:
                # Multi-line deletion
                if fix.line < len(lines):
                    end = min(fix.end_line + 1, len(lines))
                    del lines[fix.line:end]
        
        elif fix.action == HealingAction.REPLACE:
            if fix.line == fix.end_line:
                # Single line replacement
                if fix.line < len(lines):
                    line = lines[fix.line]
                    new_line = line[:fix.column] + fix.replacement_text + line[fix.end_column:]
                    lines[fix.line] = new_line
            else:
                # Multi-line replacement
                if fix.line < len(lines):
                    first_line = lines[fix.line]
                    last_line = lines[min(fix.end_line, len(lines) - 1)]
                    new_text = first_line[:fix.column] + fix.replacement_text + last_line[fix.end_column:]
                    end = min(fix.end_line + 1, len(lines))
                    lines[fix.line:end] = [new_text]
        
        # Record the applied fix
        self._stats.record_fix(fix, applied=True)
        self._emit_event(HealingEvent(
            event_type="fix_applied",
            fix=fix,
            file_path="",
        ))
        
        # Track for undo
        if fix.fix_id:
            file_key = fix.fix_id[:8]  # Use prefix as file key
            if file_key not in self._applied_fixes:
                self._applied_fixes[file_key] = []
            self._applied_fixes[file_key].append(fix)
        
        return '\n'.join(lines)
    
    def apply_safe_fixes(
        self,
        code: str,
        result: HealingResult,
    ) -> tuple[str, List[HealingFix]]:
        """
        Apply all safe fixes from a HealingResult.
        
        Returns (modified_code, list_of_applied_fixes).
        Fixes are applied in reverse order (bottom-up) to preserve
        line numbers.
        """
        safe_fixes = result.safe_fixes
        if not safe_fixes:
            return code, []
        
        # Sort fixes in reverse order by line/column so applying them
        # bottom-up preserves correct positions
        safe_fixes_sorted = sorted(
            safe_fixes,
            key=lambda f: (f.line, f.column),
            reverse=True,
        )
        
        applied: List[HealingFix] = []
        for fix in safe_fixes_sorted:
            try:
                code = self.apply_fix(code, fix)
                applied.append(fix)
            except Exception as e:
                logger.warning(f"Failed to apply fix {fix.fix_id}: {e}")
                self._stats.record_fix(fix, applied=False)
        
        # Update cooldown
        self._last_heal_time[result.file_path] = time.time()
        
        return code, applied
    
    def _deduplicate_fixes(self, fixes: List[HealingFix]) -> List[HealingFix]:
        """Remove duplicate fixes at the same location."""
        seen: Set[str] = set()
        unique: List[HealingFix] = []
        
        for fix in fixes:
            key = f"{fix.line}:{fix.column}:{fix.end_line}:{fix.end_column}:{fix.action.value}"
            if key not in seen:
                seen.add(key)
                unique.append(fix)
        
        return unique
    
    def _resolve_conflicts(
        self, fixes: List[HealingFix]
    ) -> tuple[List[HealingFix], List[Dict[str, Any]]]:
        """
        Detect and resolve overlapping edit ranges.
        
        When two fixes touch overlapping line ranges, keep the one with
        higher severity (then higher confidence as tiebreaker) and drop
        the other.  Dropped fixes are returned as skipped entries.
        
        Returns (kept_fixes, skipped_entries).
        """
        if len(fixes) <= 1:
            return fixes, []
        
        severity_rank = {
            HealingSeverity.CRITICAL: 0,
            HealingSeverity.MODERATE: 1,
            HealingSeverity.LOW: 2,
        }
        
        # Sort by start position
        sorted_fixes = sorted(fixes, key=lambda f: (f.line, f.column))
        
        kept: List[HealingFix] = []
        skipped: List[Dict[str, Any]] = []
        
        for fix in sorted_fixes:
            if not kept:
                kept.append(fix)
                continue
            
            prev = kept[-1]
            # Check overlap: prev.end_line >= fix.line means ranges touch
            if prev.end_line >= fix.line:
                # Overlap detected — keep higher priority
                prev_rank = (severity_rank.get(prev.severity, 99), -prev.confidence)
                fix_rank = (severity_rank.get(fix.severity, 99), -fix.confidence)
                
                if fix_rank < prev_rank:
                    # New fix is higher priority — drop prev, keep new
                    skipped.append({
                        "ruleId": prev.rule_id,
                        "category": prev.category.value,
                        "reason": "conflict_overlap",
                        "description": prev.description,
                        "conflictsWith": fix.rule_id,
                    })
                    kept[-1] = fix
                else:
                    # Prev is higher priority — drop new fix
                    skipped.append({
                        "ruleId": fix.rule_id,
                        "category": fix.category.value,
                        "reason": "conflict_overlap",
                        "description": fix.description,
                        "conflictsWith": prev.rule_id,
                    })
            else:
                kept.append(fix)
        
        if skipped:
            logger.info(
                f"Conflict resolution: kept {len(kept)}, "
                f"dropped {len(skipped)} overlapping fixes"
            )
        
        return kept, skipped
    
    def _is_on_cooldown(self, file_path: str) -> bool:
        """Check if a file is on cooldown."""
        last_time = self._last_heal_time.get(file_path, 0)
        return (time.time() - last_time) * 1000 < self._config.cooldown_ms
    
    @staticmethod
    def _compute_hash(content: str) -> str:
        """Compute content hash for change detection."""
        return hashlib.sha256(content.encode()).hexdigest()[:16]


# Module-level singleton
_engine_instance: Optional[SelfHealingEngine] = None


def get_healing_engine(config: Optional[HealingConfig] = None) -> SelfHealingEngine:
    """Get or create the global healing engine instance."""
    global _engine_instance
    if _engine_instance is None:
        _engine_instance = SelfHealingEngine(config=config)
    return _engine_instance


def reset_healing_engine() -> None:
    """Reset the global healing engine (mainly for testing)."""
    global _engine_instance
    _engine_instance = None
