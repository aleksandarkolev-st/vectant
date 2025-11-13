from __future__ import annotations

import argparse
import json
import sys
from typing import List

from analyzer.AllLanguageAnalyzers import PythonAnalyzer


def run_python_analyzer(code: str) -> List[dict]:
    """Return diagnostics for the provided Python source string."""
    analyzer = PythonAnalyzer()
    return analyzer.analyze(code)


def _main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Run Synthi's Python analyzer against a source file or stdin."
    )
    parser.add_argument(
        "path",
        nargs="?",
        help="Python file to analyze. If omitted, reads code from stdin.",
    )
    args = parser.parse_args(argv)

    if args.path:
        with open(args.path, "r", encoding="utf-8") as handle:
            code = handle.read()
    else:
        code = sys.stdin.read()

    diagnostics = run_python_analyzer(code)
    json.dump(diagnostics, sys.stdout, indent=2)
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(_main())
