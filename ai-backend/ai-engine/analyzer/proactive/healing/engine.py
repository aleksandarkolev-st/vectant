"""
Self-Healing Engine Core

The main engine that coordinates detection, classification, and
application of auto-healing fixes. This integrates with the existing
proactive analysis pipeline to provide real-time micro-fixes.
"""

from __future__ import annotations

import asyncio
import hashlib
import logging
import time
from typing import Any, Callable, Dict, List, Optional, Set

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

# Import rules to trigger registration
from . import rules  # noqa: F401

logger = logging.getLogger("healing.engine")


class SelfHealingEngine:
    """
    The core self-healing engine.
    
    Coordinates the detection and classification of micro-fixes.
    The engine is designed to be:
    
    1. Conservative: Only fixes obvious, safe issues
    2. Fast: Rules run in < 50ms typically
    3. Non-intrusive: Never changes program logic
    4. Transparent: Every fix is logged and can be undone
    """
    
    def __init__(
        self,
        config: Optional[HealingConfig] = None,
        registry: Optional[HealingRuleRegistry] = None,
        classifier: Optional[HealingClassifier] = None,
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
        
        for rule in applicable_rules:
            try:
                fixes = rule.detect(code, language, file_path)
                
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
