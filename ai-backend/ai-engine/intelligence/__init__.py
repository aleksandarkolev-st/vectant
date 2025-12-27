"""
Intelligence Aggregator - Unified Code Intelligence Pipeline

This module implements the server-side Code Intelligence Pipeline that aggregates
three distinct layers of feedback into a single user experience:

- Layer A: Syntax Analysis (LSP) - Fast/Real-time (< 200ms)
- Layer B: Semantic Analysis (Compiler) - Deep/Asynchronous (< 1s)
- Layer C: AI Analysis (LLM) - Smart/On-demand

All analysis happens on the backend container filesystem. The client is merely
a view layer that renders the unified diagnostics.
"""

from .providers import (
    DiagnosticProvider,
    DiagnosticSource,
    UnifiedDiagnostic,
    DiagnosticSeverity,
    DiagnosticRange,
    CodeAction,
    CodeActionKind,
    StaticAnalysisProvider,
    AIAnalysisProvider,
)
from .aggregator import (
    IntelligenceAggregator,
    AggregatedResult,
    get_aggregator,
    create_aggregator_with_ai,
)
from .file_watcher import FileWatcher, FileChangeEvent, FileChangeType, get_file_watcher
from .compiler_parsers import (
    CompilerOutputParser,
    CompilerType,
    ParsedError,
    get_parser_for_language,
    get_parser,
    parse_compiler_output,
)
from .compiler_provider import CompilerProvider, get_compiler_provider

__all__ = [
    # Providers
    'DiagnosticProvider',
    'DiagnosticSource',
    'UnifiedDiagnostic',
    'DiagnosticSeverity',
    'DiagnosticRange',
    'CodeAction',
    'CodeActionKind',
    'StaticAnalysisProvider',
    'AIAnalysisProvider',
    'CompilerProvider',
    'get_compiler_provider',
    # Aggregator
    'IntelligenceAggregator',
    'AggregatedResult',
    'get_aggregator',
    'create_aggregator_with_ai',
    # File Watcher
    'FileWatcher',
    'FileChangeEvent',
    'FileChangeType',
    'get_file_watcher',
    # Compiler Parsers
    'CompilerOutputParser',
    'CompilerType',
    'ParsedError',
    'get_parser_for_language',
    'get_parser',
    'parse_compiler_output',
]
