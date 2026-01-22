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

        for q in queries:
            query = q.get("query", "")
            expected_chunks = set(q.get("expected_chunks", []))
            expected_files = set(q.get("expected_files", []))

            start = time.time()
            result = self.engine._retrieval_pipeline.retrieve(query=query)
            latency_ms = (time.time() - start) * 1000

            retrieved_chunks = set(result.context.included_chunk_ids or [])
            retrieved_files = set(result.context.included_files or [])

            recall = self._recall(expected_chunks or expected_files, retrieved_chunks or retrieved_files)
            precision = self._precision(expected_chunks or expected_files, retrieved_chunks or retrieved_files)
            total_recall += recall
            total_precision += precision

            results.append({
                "id": q.get("id"),
                "query": query,
                "recall": recall,
                "precision": precision,
                "latency_ms": latency_ms,
            })

        count = max(1, len(queries))
        return {
            "avg_recall": total_recall / count,
            "avg_precision": total_precision / count,
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
