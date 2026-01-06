"""
Intelligence Aggregator - The Hub for Code Intelligence

This service acts as the central hub that:
1. Subscribes to diagnostic streams from Layer A (LSP), B (Compiler), C (AI)
2. Deduplicates similar diagnostics across sources
3. Merges code actions from all providers
4. Sends unified JSON payload to frontend via WebSocket
"""

from __future__ import annotations

import asyncio
import logging
from dataclasses import dataclass, field
from typing import Any, Callable, Dict, List, Optional, Set
from collections import defaultdict
import time

from .providers import (
    DiagnosticProvider,
    DiagnosticSource,
    UnifiedDiagnostic,
    DiagnosticSeverity,
    CodeAction,
    StaticAnalysisProvider,
    AIAnalysisProvider,
)


logger = logging.getLogger('intelligence.aggregator')


@dataclass
class AggregatedResult:
    """
    Aggregated analysis result from all providers.
    
    This is the unified payload sent to the frontend.
    """
    file_path: str
    diagnostics: List[UnifiedDiagnostic] = field(default_factory=list)
    actions: List[CodeAction] = field(default_factory=list)
    sources_completed: Set[DiagnosticSource] = field(default_factory=set)
    total_elapsed_ms: float = 0.0
    
    def to_dict(self) -> Dict[str, Any]:
        return {
            "file": self.file_path,
            "diagnostics": [d.to_dict() for d in self.diagnostics],
            "actions": [a.to_dict() for a in self.actions],
            "sources": [s.value for s in self.sources_completed],
            "summary": {
                "errors": sum(1 for d in self.diagnostics if d.severity == DiagnosticSeverity.ERROR),
                "warnings": sum(1 for d in self.diagnostics if d.severity == DiagnosticSeverity.WARNING),
                "suggestions": sum(1 for d in self.diagnostics if d.severity == DiagnosticSeverity.SUGGESTION),
                "total": len(self.diagnostics),
            },
            "elapsedMs": self.total_elapsed_ms,
        }


class IntelligenceAggregator:
    """
    Central hub for code intelligence that aggregates diagnostics from multiple sources.
    
    Features:
    - Parallel execution of providers (LSP, Compiler, AI)
    - Deduplication of similar diagnostics
    - Priority-based merging (AI > Compiler > LSP)
    - Streaming results as each tier completes
    - AI auto-trigger when compiler errors detected
    """
    
    def __init__(
        self,
        providers: Optional[List[DiagnosticProvider]] = None,
        ai_provider: Optional[AIAnalysisProvider] = None,
        enable_ai_auto_trigger: bool = True,
        ai_trigger_threshold: int = 0,  # Trigger AI if error_count > threshold
    ):
        self._providers: List[DiagnosticProvider] = providers or []
        self._ai_provider = ai_provider
        self._enable_ai_auto_trigger = enable_ai_auto_trigger
        self._ai_trigger_threshold = ai_trigger_threshold
        
        # Subscribers for streaming results
        self._subscribers: Dict[str, List[Callable]] = defaultdict(list)
        
        # Cache for recent results
        self._cache: Dict[str, AggregatedResult] = {}
        self._cache_max_age = 30  # seconds
        
        logger.info(f"IntelligenceAggregator initialized with {len(self._providers)} providers")
    
    def add_provider(self, provider: DiagnosticProvider):
        """Add a diagnostic provider."""
        self._providers.append(provider)
        logger.info(f"Added provider: {provider.source.value}")
    
    def subscribe(self, file_path: str, callback: Callable[[AggregatedResult], None]):
        """
        Subscribe to analysis updates for a file.
        
        The callback is invoked whenever new diagnostics are available.
        """
        self._subscribers[file_path].append(callback)
        return lambda: self._subscribers[file_path].remove(callback)
    
    def _notify_subscribers(self, file_path: str, result: AggregatedResult):
        """Notify all subscribers for a file."""
        for callback in self._subscribers.get(file_path, []):
            try:
                callback(result)
            except Exception as e:
                logger.error(f"Subscriber callback error: {e}")
    
    def clear_diagnostics(self, file_path: str):
        """
        Clear diagnostics for a file (notify subscribers).
        
        This is called immediately when a new analysis request is received
        to prevent "ghost errors" (stale diagnostics at old coordinates).
        """
        # Create empty result
        result = AggregatedResult(file_path=file_path)
        self._notify_subscribers(file_path, result)
        logger.info(f"Cleared diagnostics for {file_path}")

    async def analyze(
        self,
        file_path: str,
        content: str,
        language: str,
        related_files: Optional[Dict[str, str]] = None,
        force_ai: bool = False,
        on_tier_complete: Optional[Callable[[DiagnosticSource, List[UnifiedDiagnostic]], None]] = None,
    ) -> AggregatedResult:
        """
        Run full analysis pipeline on a file.
        
        Args:
            file_path: Path to the file being analyzed
            content: File content
            language: Language identifier
            related_files: Map of path -> content for related files
            force_ai: Force AI analysis regardless of error count
            on_tier_complete: Callback when each tier completes (for streaming)
            
        Returns:
            Aggregated result with deduplicated diagnostics
        """
        # Task 2: Immediate Clear / Versioning
        # Notify subscribers that analysis is starting (clearing old state)
        self.clear_diagnostics(file_path)
        
        start_time = time.time()
        
        result = AggregatedResult(file_path=file_path)
        all_diagnostics: List[UnifiedDiagnostic] = []
        compiler_errors: List[UnifiedDiagnostic] = []
        
        # Step 1: Run fast providers in parallel (Static/LSP, Compiler)
        fast_providers = [p for p in self._providers if p.source != DiagnosticSource.AI_REVIEW]
        
        if fast_providers:
            tasks = [
                self._run_provider(p, file_path, content, language, related_files)
                for p in fast_providers
            ]
            
            results = await asyncio.gather(*tasks, return_exceptions=True)
            
            for provider, diags in zip(fast_providers, results):
                if isinstance(diags, Exception):
                    logger.error(f"Provider {provider.source.value} failed: {diags}")
                    continue
                
                all_diagnostics.extend(diags)
                result.sources_completed.add(provider.source)
                
                # Track compiler errors for AI trigger
                if provider.source == DiagnosticSource.COMPILER:
                    compiler_errors = [d for d in diags if d.severity == DiagnosticSeverity.ERROR]
                
                # Notify tier complete
                if on_tier_complete:
                    try:
                        on_tier_complete(provider.source, diags)
                    except Exception as e:
                        logger.error(f"Tier complete callback error: {e}")
        
        # Step 2: Deduplicate diagnostics so far
        deduped = self._deduplicate(all_diagnostics)
        
        # Step 3: Trigger AI analysis if conditions met
        should_run_ai = (
            force_ai or
            (self._enable_ai_auto_trigger and len(compiler_errors) > self._ai_trigger_threshold)
        )
        
        if should_run_ai and self._ai_provider:
            logger.info(f"Triggering AI analysis (compiler_errors={len(compiler_errors)})")
            
            try:
                ai_diags = await self._ai_provider.analyze(
                    file_path=file_path,
                    content=content,
                    language=language,
                    related_files=related_files,
                    compiler_errors=compiler_errors,
                )
                
                all_diagnostics.extend(ai_diags)
                result.sources_completed.add(DiagnosticSource.AI_REVIEW)
                
                # Re-deduplicate with AI diagnostics
                deduped = self._deduplicate(all_diagnostics)
                
                if on_tier_complete:
                    try:
                        on_tier_complete(DiagnosticSource.AI_REVIEW, ai_diags)
                    except Exception:
                        pass
                        
            except Exception as e:
                logger.error(f"AI analysis failed: {e}")
        
        # Step 4: Gather code actions from all providers
        all_actions: List[CodeAction] = []
        for provider in self._providers:
            if provider.source in result.sources_completed:
                try:
                    actions = await provider.get_code_actions(file_path, content, deduped)
                    all_actions.extend(actions)
                except Exception as e:
                    logger.error(f"Code action gathering failed for {provider.source.value}: {e}")
        
        # Step 5: Finalize result
        result.diagnostics = deduped
        result.actions = all_actions
        result.total_elapsed_ms = (time.time() - start_time) * 1000
        
        # Cache and notify
        self._cache[file_path] = result
        self._notify_subscribers(file_path, result)
        
        logger.info(
            f"Analysis complete: {file_path} - "
            f"{len(result.diagnostics)} diagnostics, "
            f"{len(result.actions)} actions, "
            f"{result.total_elapsed_ms:.1f}ms"
        )
        
        return result
    
    async def _run_provider(
        self,
        provider: DiagnosticProvider,
        file_path: str,
        content: str,
        language: str,
        related_files: Optional[Dict[str, str]],
    ) -> List[UnifiedDiagnostic]:
        """Run a single provider with timeout."""
        try:
            # Timeout based on provider type
            timeout = 5.0 if provider.source == DiagnosticSource.COMPILER else 2.0
            
            return await asyncio.wait_for(
                provider.analyze(file_path, content, language, related_files),
                timeout=timeout,
            )
        except asyncio.TimeoutError:
            logger.warning(f"Provider {provider.source.value} timed out")
            return []
        except Exception as e:
            logger.error(f"Provider {provider.source.value} error: {e}")
            return []
    
    def _deduplicate(self, diagnostics: List[UnifiedDiagnostic]) -> List[UnifiedDiagnostic]:
        """
        Deduplicate diagnostics, keeping higher priority sources.
        
        Priority: AI (0) > Compiler (1) > LSP/Static (2)
        """
        # Map from dedup_key to diagnostic
        seen: Dict[str, UnifiedDiagnostic] = {}
        
        # Priority mapping
        priority = {
            DiagnosticSource.AI_REVIEW: 0,
            DiagnosticSource.COMPILER: 1,
            DiagnosticSource.LSP: 2,
            DiagnosticSource.STATIC: 3,
        }
        
        for diag in diagnostics:
            key = diag.dedup_key
            
            if key in seen:
                existing = seen[key]
                # Keep higher priority (lower number)
                if priority.get(diag.source, 99) < priority.get(existing.source, 99):
                    seen[key] = diag
            else:
                seen[key] = diag
        
        # Sort by severity and line
        severity_order = {
            DiagnosticSeverity.ERROR: 0,
            DiagnosticSeverity.WARNING: 1,
            DiagnosticSeverity.INFORMATION: 2,
            DiagnosticSeverity.HINT: 3,
            DiagnosticSeverity.SUGGESTION: 4,
        }
        
        return sorted(
            seen.values(),
            key=lambda d: (severity_order.get(d.severity, 99), d.range.start_line)
        )
    
    async def apply_code_action(
        self,
        file_path: str,
        action_id: str,
        current_content: str,
    ) -> Optional[str]:
        """
        Apply a code action and return the new content.
        
        For AI fixes, this applies the AI-generated patch.
        For LSP fixes, this applies the workspace edit.
        """
        # Find the action in cache
        result = self._cache.get(file_path)
        if not result:
            return None
        
        action = next((a for a in result.actions if a.title == action_id), None)
        if not action:
            return None
        
        if action.ai_patch:
            # Apply AI patch
            # TODO: Implement patch application
            pass
        elif action.edit:
            # Apply workspace edit
            # TODO: Implement edit application
            pass
        
        return None
    
    def get_cached_result(self, file_path: str) -> Optional[AggregatedResult]:
        """Get cached result for a file if still valid."""
        result = self._cache.get(file_path)
        if result:
            # Check if cache is still valid
            # For now, always return cached result
            return result
        return None
    
    def clear_cache(self, file_path: Optional[str] = None):
        """Clear cached results."""
        if file_path:
            self._cache.pop(file_path, None)
        else:
            self._cache.clear()


# Singleton instance
_aggregator: Optional[IntelligenceAggregator] = None


def get_aggregator() -> IntelligenceAggregator:
    """Get or create the global IntelligenceAggregator instance."""
    global _aggregator
    
    if _aggregator is None:
        # Create with default providers
        static_provider = StaticAnalysisProvider()
        
        _aggregator = IntelligenceAggregator(
            providers=[static_provider],
            enable_ai_auto_trigger=True,
            ai_trigger_threshold=0,
        )
    
    return _aggregator


def create_aggregator_with_ai(llm_provider) -> IntelligenceAggregator:
    """Create an aggregator with AI provider enabled."""
    static_provider = StaticAnalysisProvider()
    ai_provider = AIAnalysisProvider(llm_provider=llm_provider)
    
    return IntelligenceAggregator(
        providers=[static_provider],
        ai_provider=ai_provider,
        enable_ai_auto_trigger=True,
        ai_trigger_threshold=0,
    )
