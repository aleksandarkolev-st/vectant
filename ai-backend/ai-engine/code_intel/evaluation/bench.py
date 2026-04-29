from __future__ import annotations

import json
import time
from typing import Dict, List, Optional

from ..engine import CodeIntelEngine


class RetrievalBenchmark:
    def __init__(self, engine: CodeIntelEngine):
        self.engine = engine

    def run(self, dataset_path: str) -> Dict:
        self.engine._initialize_components()
        with open(dataset_path, "r", encoding="utf-8") as f:
            data = json.load(f)

        queries = data.get("queries", [])
        results = []
        total_recall = 0.0
        total_precision = 0.0
        total_symbol_recall = 0.0
        total_file_recall = 0.0

        for q in queries:
            query = q.get("query", "")
            expected_chunks = set(q.get("expected_chunks", []))
            expected_files = set(q.get("expected_files", []))
            expected_symbols = set(q.get("expected_symbols", []))

            start = time.time()
            result = self.engine._retrieval_pipeline.retrieve(query=query)
            latency_ms = (time.time() - start) * 1000

            retrieved_chunks = set(result.context.included_chunk_ids or [])
            retrieved_files = set(result.context.included_files or [])
            retrieved_symbols = set(result.context.included_symbols or [])

            recall = self._recall(expected_chunks or expected_files, retrieved_chunks or retrieved_files)
            precision = self._precision(expected_chunks or expected_files, retrieved_chunks or retrieved_files)
            symbol_recall = self._recall(expected_symbols, retrieved_symbols)
            file_recall = self._recall(expected_files, retrieved_files)
            total_recall += recall
            total_precision += precision
            total_symbol_recall += symbol_recall
            total_file_recall += file_recall

            results.append({
                "id": q.get("id"),
                "query": query,
                "recall": recall,
                "precision": precision,
                "symbol_recall": symbol_recall,
                "file_recall": file_recall,
                "latency_ms": latency_ms,
            })

        count = max(1, len(queries))
        return {
            "avg_recall": total_recall / count,
            "avg_precision": total_precision / count,
            "avg_symbol_recall": total_symbol_recall / count,
            "avg_file_recall": total_file_recall / count,
            "results": results,
        }

    def _recall(self, expected: set, retrieved: set) -> float:
        if not expected:
            return 1.0
        return len(expected.intersection(retrieved)) / max(1, len(expected))

    def _precision(self, expected: set, retrieved: set) -> float:
        if not retrieved:
            return 1.0 if not expected else 0.0
        return len(expected.intersection(retrieved)) / max(1, len(retrieved))

    def compare_fusion_methods(
        self,
        dataset_path: str,
        methods: Optional[List[str]] = None,
    ) -> Dict[str, Dict]:
        """Run the same dataset under each macro fusion method and return
        a side-by-side. Used by tooling to confirm RRF wins (or doesn't)
        before flipping the config default.

        We patch the macro config in place around each run, then restore
        the original method so the engine state stays consistent.
        """
        methods = methods or ["weighted", "rrf"]
        report: Dict[str, Dict] = {}

        # Reach into the RAG config; if there's no macro config (legacy
        # engine path) we just bail with a single method run.
        try:
            from ..rag.config import get_rag_config
            macro = get_rag_config().macro
        except Exception:
            return {"single": self.run(dataset_path)}

        original = getattr(macro, "fusion_method", "weighted")
        try:
            for m in methods:
                macro.fusion_method = m
                report[m] = self.run(dataset_path)
        finally:
            macro.fusion_method = original
        return report
