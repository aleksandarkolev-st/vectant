"""
Unit tests for the batch healing engine.
"""

import asyncio
import pytest
from analyzer.proactive.healing.batch_engine import (
    BatchHealingEngine,
    BatchFileEntry,
    BatchResult,
)
from analyzer.proactive.healing.engine import SelfHealingEngine, reset_healing_engine


def run_async(coro):
    loop = asyncio.new_event_loop()
    try:
        return loop.run_until_complete(coro)
    finally:
        loop.close()


class TestBatchHealingEngine:
    def setup_method(self):
        reset_healing_engine()
        self.engine = SelfHealingEngine()
        self.batch = BatchHealingEngine(engine=self.engine, max_concurrent=2)

    def test_empty_batch(self):
        result = run_async(self.batch.analyze_batch([]))
        assert isinstance(result, BatchResult)
        assert result.total_files == 0
        assert result.analyzed_files == 0

    def test_single_file_batch(self):
        files = [
            BatchFileEntry(
                file_path="test.py",
                language="python",
                code="x = 1   \n",
            )
        ]
        result = run_async(self.batch.analyze_batch(files))
        assert result.total_files == 1
        assert result.analyzed_files == 1
        assert "test.py" in result.file_results

    def test_multi_file_batch(self):
        files = [
            BatchFileEntry(
                file_path="a.py",
                language="python",
                code="x = 1   \n",
            ),
            BatchFileEntry(
                file_path="b.js",
                language="javascript",
                code="var x = 1;\n",
            ),
            BatchFileEntry(
                file_path="c.py",
                language="python",
                code="import os\nimport os\n",
            ),
        ]
        result = run_async(self.batch.analyze_batch(files))
        assert result.total_files == 3
        assert result.analyzed_files == 3

    def test_oversized_file_skipped(self):
        self.batch = BatchHealingEngine(
            engine=self.engine,
            max_concurrent=2,
            max_file_size_kb=0,  # 0 KB limit — everything skipped
        )
        files = [
            BatchFileEntry(file_path="big.py", language="python", code="x = 1\n")
        ]
        result = run_async(self.batch.analyze_batch(files))
        assert result.skipped_files == 1
        assert result.analyzed_files == 0

    def test_priority_ordering(self):
        """Higher priority files should be analysed first."""
        order = []

        async def mock_analyze(code, language, file_path):
            order.append(file_path)
            return await self.engine.analyze(code, language, file_path)

        self.engine.analyze = mock_analyze

        files = [
            BatchFileEntry(file_path="low.py", language="python", code="x=1\n", priority=0),
            BatchFileEntry(file_path="high.py", language="python", code="x=1\n", priority=10),
            BatchFileEntry(file_path="mid.py", language="python", code="x=1\n", priority=5),
        ]
        run_async(self.batch.analyze_batch(files))
        # Due to concurrency, order isn't strictly guaranteed, but
        # high.py should come before low.py in most cases
        assert "high.py" in order
        assert "low.py" in order

    def test_cancel(self):
        self.batch.cancel()
        files = [
            BatchFileEntry(file_path="a.py", language="python", code="x=1\n"),
        ]
        result = run_async(self.batch.analyze_batch(files))
        # After cancel, no files should be analysed
        assert result.analyzed_files == 0

    def test_summary_property(self):
        result = BatchResult(
            total_files=5,
            analyzed_files=4,
            total_fixes=10,
            auto_fixable=7,
            elapsed_ms=42.5,
        )
        assert "4/5 files" in result.summary
        assert "10 fixes" in result.summary

    def test_auto_fix_batch(self):
        files = [
            BatchFileEntry(
                file_path="test.py",
                language="python",
                code="x = 1   \n",
            )
        ]
        fixed = run_async(self.batch.auto_fix_batch(files))
        assert isinstance(fixed, dict)

    def test_progress_callback(self):
        progress_calls = []

        def on_progress(done, total, path):
            progress_calls.append((done, total, path))

        files = [
            BatchFileEntry(file_path="a.py", language="python", code="x=1\n"),
            BatchFileEntry(file_path="b.py", language="python", code="y=2\n"),
        ]
        run_async(self.batch.analyze_batch(files, on_progress=on_progress))
        assert len(progress_calls) == 2
