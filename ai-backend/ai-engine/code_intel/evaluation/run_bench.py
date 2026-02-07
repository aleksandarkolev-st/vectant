from __future__ import annotations

import argparse
import json
import os
from pathlib import Path

from ..engine import create_engine
from .bench import RetrievalBenchmark


def main() -> int:
    parser = argparse.ArgumentParser(description="Run Code Intel retrieval benchmark")
    parser.add_argument("--workspace", required=True, help="Workspace root or slug")
    parser.add_argument("--dataset", required=True, help="Path to dataset JSON")
    parser.add_argument("--min-recall", type=float, default=0.0, help="Minimum avg recall threshold")
    parser.add_argument("--min-file-recall", type=float, default=0.0, help="Minimum avg file recall threshold")
    parser.add_argument("--min-symbol-recall", type=float, default=0.0, help="Minimum avg symbol recall threshold")
    parser.add_argument("--skip-index", action="store_true", help="Skip indexing before benchmark")
    args = parser.parse_args()

    engine = create_engine(args.workspace)
    if not args.skip_index:
        try:
            # Full index to ensure consistency
            import asyncio
            asyncio.run(engine.index_workspace(incremental=False))
        except Exception:
            pass

    bench = RetrievalBenchmark(engine)
    results = bench.run(args.dataset)

    print(json.dumps(results, indent=2))

    if results.get("avg_recall", 0.0) < args.min_recall:
        return 2
    if results.get("avg_file_recall", 0.0) < args.min_file_recall:
        return 3
    if results.get("avg_symbol_recall", 0.0) < args.min_symbol_recall:
        return 4

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
