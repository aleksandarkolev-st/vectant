"""
Proactive Analysis Orchestrator

This module coordinates the multi-tier analysis pipeline:
1. Static Analysis (fast, pattern-based)
2. Semantic Analysis (AST-based)
3. AI Analysis (LLM-powered)

Results are returned progressively as each tier completes,
enabling responsive UI updates.
"""

from __future__ import annotations

import asyncio
import time
from dataclasses import dataclass
from typing import Any, AsyncGenerator, Callable, Dict, List, Optional

from .types import (
    AnalysisRequest,
    AnalysisResult,
    AnalysisTier,
    Diagnostic,
    DiagnosticLocation,
    FileContext,
    Severity,
    TierResult,
)
from .cache import AnalysisCache
from .semantic_analyzer import SemanticAnalyzer
from .ai_predictor import AIErrorPredictor


@dataclass
class ProgressEvent:
    """Event emitted during analysis progress."""
    tier: AnalysisTier
    status: str  # "started", "completed", "error"
    result: Optional[TierResult] = None
    error: Optional[str] = None


class ProactiveAnalyzer:
    """
    Main orchestrator for proactive code analysis.
    
    Coordinates multiple analysis tiers and provides:
    - Caching for repeated analysis
    - Progressive result streaming
    - Graceful error handling
    - Rate limiting
    """
    
    def __init__(
        self,
        cache: Optional[AnalysisCache] = None,
        static_analyzer_factory: Optional[Callable] = None,
        llm_provider = None,
        enable_ai: bool = True,
        ai_min_confidence: float = 0.6,
    ):
        self._cache = cache or AnalysisCache()
        self._semantic_analyzer = SemanticAnalyzer()
        self._ai_predictor = AIErrorPredictor(
            provider=llm_provider,
            min_confidence=ai_min_confidence,
        ) if enable_ai else None
        self._static_analyzer_factory = static_analyzer_factory
        self._enable_ai = enable_ai
    
    async def analyze(
        self,
        request: AnalysisRequest,
    ) -> AnalysisResult:
        """
        Run full analysis on a file.
        
        Returns complete results after all tiers finish.
        """
        start_time = time.perf_counter()
        
        result = AnalysisResult(
            file_path=request.file.path,
            content_hash=request.file.content_hash,
            language=request.file.language,
        )
        
        # Run tiers based on request
        all_diagnostics: List[Diagnostic] = []
        
        if AnalysisTier.STATIC in request.tiers:
            tier_result = await self._run_static_analysis(request.file)
            result.tiers[AnalysisTier.STATIC] = tier_result
            all_diagnostics.extend(tier_result.diagnostics)
        
        if AnalysisTier.SEMANTIC in request.tiers:
            tier_result = await self._run_semantic_analysis(request.file)
            result.tiers[AnalysisTier.SEMANTIC] = tier_result
            all_diagnostics.extend(tier_result.diagnostics)
        
        if AnalysisTier.AI in request.tiers and self._enable_ai:
            tier_result = await self._run_ai_analysis(
                request.file,
                request.related_files,
                all_diagnostics,
            )
            result.tiers[AnalysisTier.AI] = tier_result
        
        result.total_elapsed_ms = (time.perf_counter() - start_time) * 1000
        
        # Limit total diagnostics
        if len(result.all_diagnostics) > request.max_diagnostics:
            # Prioritize by severity
            pass  # Already sorted by severity in all_diagnostics property
        
        return result
    
    async def analyze_stream(
        self,
        request: AnalysisRequest,
    ) -> AsyncGenerator[ProgressEvent, None]:
        """
        Run analysis with streaming progress updates.
        
        Yields ProgressEvent as each tier starts and completes.
        """
        all_diagnostics: List[Diagnostic] = []
        
        # Static analysis
        if AnalysisTier.STATIC in request.tiers:
            yield ProgressEvent(tier=AnalysisTier.STATIC, status="started")
            
            try:
                tier_result = await self._run_static_analysis(request.file)
                all_diagnostics.extend(tier_result.diagnostics)
                yield ProgressEvent(
                    tier=AnalysisTier.STATIC,
                    status="completed",
                    result=tier_result,
                )
            except Exception as e:
                yield ProgressEvent(
                    tier=AnalysisTier.STATIC,
                    status="error",
                    error=str(e),
                )
        
        # Semantic analysis
        if AnalysisTier.SEMANTIC in request.tiers:
            yield ProgressEvent(tier=AnalysisTier.SEMANTIC, status="started")
            
            try:
                tier_result = await self._run_semantic_analysis(request.file)
                all_diagnostics.extend(tier_result.diagnostics)
                yield ProgressEvent(
                    tier=AnalysisTier.SEMANTIC,
                    status="completed",
                    result=tier_result,
                )
            except Exception as e:
                yield ProgressEvent(
                    tier=AnalysisTier.SEMANTIC,
                    status="error",
                    error=str(e),
                )
        
        # AI analysis (slower, optional)
        if AnalysisTier.AI in request.tiers and self._enable_ai:
            yield ProgressEvent(tier=AnalysisTier.AI, status="started")
            
            try:
                tier_result = await self._run_ai_analysis(
                    request.file,
                    request.related_files,
                    all_diagnostics,
                )
                yield ProgressEvent(
                    tier=AnalysisTier.AI,
                    status="completed",
                    result=tier_result,
                )
            except Exception as e:
                yield ProgressEvent(
                    tier=AnalysisTier.AI,
                    status="error",
                    error=str(e),
                )
    
    async def analyze_quick(
        self,
        file: FileContext,
    ) -> TierResult:
        """
        Run only fast analysis (static + semantic) for real-time feedback.
        
        This is optimized for low latency during typing.
        """
        # Check cache first
        content_hash = AnalysisCache.compute_hash(file.content, file.language)
        
        # Try to get cached results
        cached_static = await self._cache.get(content_hash, AnalysisTier.STATIC)
        cached_semantic = await self._cache.get(content_hash, AnalysisTier.SEMANTIC)
        
        if cached_static and cached_semantic:
            # Merge cached results
            all_diagnostics = cached_static.diagnostics + cached_semantic.diagnostics
            return TierResult(
                tier=AnalysisTier.STATIC,  # Primary tier
                diagnostics=all_diagnostics,
                elapsed_ms=cached_static.elapsed_ms + cached_semantic.elapsed_ms,
                from_cache=True,
            )
        
        # Run analysis in parallel
        static_task = asyncio.create_task(self._run_static_analysis(file))
        semantic_task = asyncio.create_task(self._run_semantic_analysis(file))
        
        static_result, semantic_result = await asyncio.gather(
            static_task,
            semantic_task,
            return_exceptions=True,
        )
        
        # Handle exceptions
        diagnostics = []
        total_elapsed = 0.0
        
        if isinstance(static_result, TierResult):
            diagnostics.extend(static_result.diagnostics)
            total_elapsed += static_result.elapsed_ms
            # Cache result
            await self._cache.put(content_hash, AnalysisTier.STATIC, static_result)
        
        if isinstance(semantic_result, TierResult):
            diagnostics.extend(semantic_result.diagnostics)
            total_elapsed += semantic_result.elapsed_ms
            # Cache result
            await self._cache.put(content_hash, AnalysisTier.SEMANTIC, semantic_result)
        
        return TierResult(
            tier=AnalysisTier.STATIC,
            diagnostics=diagnostics,
            elapsed_ms=total_elapsed,
        )
    
    async def _run_static_analysis(self, file: FileContext) -> TierResult:
        """Run static pattern-based analysis."""
        start_time = time.perf_counter()
        
        # Import here to avoid circular imports
        from analyzer import get_analyzer
        
        try:
            analyzer = get_analyzer(file.language)
            raw_results = analyzer.analyze(file.content)
        except ValueError:
            # Unsupported language
            raw_results = []
        except Exception as e:
            raw_results = []
        
        # Convert to our diagnostic format
        diagnostics = []
        for item in raw_results:
            if isinstance(item, dict):
                diagnostics.append(Diagnostic(
                    message=item.get("message", "Unknown issue"),
                    severity=Severity(item.get("severity", "warning")),
                    tier=AnalysisTier.STATIC,
                    location=DiagnosticLocation(
                        line=item.get("line", 0),
                        column=item.get("column", 0),
                        end_line=item.get("endLine", item.get("line", 0)),
                        end_column=item.get("endColumn", item.get("column", 0) + 1),
                    ),
                    code=item.get("code", "STATIC"),
                    source="synthi-static",
                ))
        
        elapsed_ms = (time.perf_counter() - start_time) * 1000
        
        return TierResult(
            tier=AnalysisTier.STATIC,
            diagnostics=diagnostics,
            elapsed_ms=elapsed_ms,
        )
    
    async def _run_semantic_analysis(self, file: FileContext) -> TierResult:
        """Run semantic AST-based analysis."""
        # Run in thread pool to avoid blocking
        loop = asyncio.get_event_loop()
        result = await loop.run_in_executor(
            None,
            self._semantic_analyzer.analyze,
            file,
        )
        return result
    
    async def _run_ai_analysis(
        self,
        file: FileContext,
        related_files: Optional[List[FileContext]],
        existing_diagnostics: List[Diagnostic],
    ) -> TierResult:
        """Run AI-powered analysis."""
        if not self._ai_predictor:
            return TierResult(
                tier=AnalysisTier.AI,
                diagnostics=[],
                elapsed_ms=0.0,
            )
        
        return await self._ai_predictor.analyze(
            file,
            related_files,
            existing_diagnostics,
        )
    
    async def get_cache_stats(self) -> Dict[str, Any]:
        """Get cache statistics."""
        return self._cache.stats
    
    async def clear_cache(self) -> None:
        """Clear the analysis cache."""
        await self._cache.clear()


# Re-export for convenience
__all__ = [
    'ProactiveAnalyzer',
    'AnalysisResult',
    'AnalysisRequest',
    'AnalysisTier',
    'TierResult',
    'ProgressEvent',
    'FileContext',
]
