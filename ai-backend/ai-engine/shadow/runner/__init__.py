"""Per-language runners. Master plan §9."""

from .base import Runner, RunResult, Diagnostic, detect_runner
from .python import PythonRunner
from .node import NodeRunner
from .syntax import SyntaxRunner

__all__ = [
    "Runner", "RunResult", "Diagnostic", "detect_runner",
    "PythonRunner", "NodeRunner", "SyntaxRunner",
]
