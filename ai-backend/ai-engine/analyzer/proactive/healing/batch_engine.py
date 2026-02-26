"""
Batch analysis engine for the self-healing system.

Provides multi-file and project-wide analysis capabilities,
enabling batch healing across an entire workspace with
intelligent prioritisation and rate-limiting.
"""

from __future__ import annotations

import asyncio
import logging
import time
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional

from .types import HealingConfig, HealingFix, HealingResult
from .engine import SelfHealingEngine, get_healing_engine

logger = logging.getLogger("healing.batch")


@dataclass
class BatchFileEntry:
    """One file queued for batch analysis."""
    file_path: str
    language: str
    code: str
    priority: int = 0  # higher = sooner


@dataclass
class BatchResult:
    """Result of a batch analysis run."""
    total_files: int = 0
    analyzed_files: int = 0
    total_fixes: int = 0
    auto_fixable: int = 0
    skipped_files: int = 0
    elapsed_ms: float = 0.0
    file_results: Dict[str, HealingResult] = field(default_factory=dict)
    errors: List[Dict[str, Any]] = field(default_factory=list)

    @property
    def summary(self) -> str:
        return (
            f"Batch: {self.analyzed_files}/{self.total_files} files, "
            f"{self.total_fixes} fixes ({self.auto_fixable} auto-fixable), "
            f"{self.elapsed_ms:.0f}ms"
        )


class BatchHealingEngine:
    """
    Batch analysis engine for multi-file healing.

    Features:
    - Priority queue (modified-recently files first)
    - Concurrency-limited parallel analysis
    - Progress callbacks for the UI
    - Aggregated result summary
    """

    def __init__(
        self,
        engine: Optional[SelfHealingEngine] = None,
        max_concurrent: int = 4,
        max_file_size_kb: int = 500,
    ):
        self._engine = engine or get_healing_engine()
        self._max_concurrent = max_concurrent
        self._max_file_size = max_file_size_kb * 1024
        self._cancelled = False

    def cancel(self) -> None:
        """Signal cancellation of the current batch run."""
        self._cancelled = True

    async def analyze_batch(
        self,
        files: List[BatchFileEntry],
        on_progress: Optional[callable] = None,
    ) -> BatchResult:
        """
        Analyze multiple files concurrently with priority ordering.

        Args:
            files: List of files to analyse.
            on_progress: Optional callback(done, total, file_path) for progress.

        Returns:
            Aggregated BatchResult.
        """
        self._cancelled = False
        result = BatchResult(total_files=len(files))
        start = time.perf_counter()

        # Sort by priority (descending)
        sorted_files = sorted(files, key=lambda f: f.priority, reverse=True)

        # Filter oversized files
        valid_files: List[BatchFileEntry] = []
        for entry in sorted_files:
            if len(entry.code.encode("utf-8", errors="replace")) > self._max_file_size:
                result.skipped_files += 1
                result.errors.append({
                    "file": entry.file_path,
                    "reason": "file_too_large",
                })
            else:
                valid_files.append(entry)

        # Concurrency-limited analysis
        semaphore = asyncio.Semaphore(self._max_concurrent)
        done_count = 0

        async def _analyze_one(entry: BatchFileEntry) -> Optional[HealingResult]:
            nonlocal done_count
            if self._cancelled:
                return None
            async with semaphore:
                try:
                    hr = await self._engine.analyze(
                        code=entry.code,
                        language=entry.language,
                        file_path=entry.file_path,
                    )
                    done_count += 1
                    if on_progress:
                        on_progress(done_count, len(valid_files), entry.file_path)
                    return hr
                except Exception as exc:
                    result.errors.append({
                        "file": entry.file_path,
                        "reason": "analysis_error",
                        "error": str(exc),
                    })
                    return None

        tasks = [_analyze_one(f) for f in valid_files]
        results = await asyncio.gather(*tasks)

        for hr in results:
            if hr is None:
                continue
            result.analyzed_files += 1
            result.total_fixes += len(hr.fixes)
            result.auto_fixable += hr.auto_fixable_count
            result.file_results[hr.file_path] = hr

        result.elapsed_ms = (time.perf_counter() - start) * 1000
        logger.info(result.summary)
        return result

    async def auto_fix_batch(
        self,
        files: List[BatchFileEntry],
        on_progress: Optional[callable] = None,
    ) -> Dict[str, tuple[str, List[HealingFix]]]:
        """
        Analyze and auto-fix safe issues across multiple files.

        Returns: {file_path: (fixed_code, applied_fixes)}
        """
        batch_result = await self.analyze_batch(files, on_progress)

        fixed: Dict[str, tuple[str, List[HealingFix]]] = {}
        for entry in files:
            hr = batch_result.file_results.get(entry.file_path)
            if hr is None or hr.auto_fixable_count == 0:
                continue

            new_code, applied = self._engine.apply_safe_fixes(entry.code, hr)
            if applied:
                fixed[entry.file_path] = (new_code, applied)

        return fixed
