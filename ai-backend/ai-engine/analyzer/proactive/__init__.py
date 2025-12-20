"""
Proactive Code Analysis Module

This module provides multi-layered code analysis to detect potential errors
before compilation. It combines:

1. Static Analysis - Fast pattern-based detection
2. Semantic Analysis - Deep AST-based understanding  
3. AI-Powered Analysis - LLM-based error prediction

The analysis runs incrementally and returns results progressively
as each layer completes.

NEW: Workspace-level multi-file analysis with:
- Dependency tracking between files
- Cross-file issue detection
- Incremental analysis (only changed files + dependents)
- Smart AI batching to avoid sending all files constantly
- Multi-file suggestions and batch fixes
"""

from .orchestrator import ProactiveAnalyzer, AnalysisResult, AnalysisTier
from .semantic_analyzer import SemanticAnalyzer
from .ai_predictor import AIErrorPredictor
from .cache import AnalysisCache
from .dependency_tracker import DependencyTracker, get_dependency_tracker
from .workspace_analyzer import WorkspaceAnalyzer, get_workspace_analyzer
from .types import (
    WorkspaceAnalysisRequest,
    WorkspaceAnalysisResult,
    MultiFileDiagnostic,
    MultiFileFix,
    FileEdit,
    WorkspaceSuggestion,
    FileChange,
    CrossFileReference,
)

__all__ = [
    # Single-file analysis
    'ProactiveAnalyzer',
    'AnalysisResult', 
    'AnalysisTier',
    'SemanticAnalyzer',
    'AIErrorPredictor',
    'AnalysisCache',
    # Multi-file / workspace analysis
    'WorkspaceAnalyzer',
    'get_workspace_analyzer',
    'DependencyTracker',
    'get_dependency_tracker',
    'WorkspaceAnalysisRequest',
    'WorkspaceAnalysisResult',
    'MultiFileDiagnostic',
    'MultiFileFix',
    'FileEdit',
    'WorkspaceSuggestion',
    'FileChange',
    'CrossFileReference',
]
