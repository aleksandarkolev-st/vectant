"""
Proactive Code Analysis Module

This module provides multi-layered code analysis to detect potential errors
before compilation. It combines:

1. Static Analysis - Fast pattern-based detection
2. Semantic Analysis - Deep AST-based understanding  
3. AI-Powered Analysis - LLM-based error prediction

The analysis runs incrementally and returns results progressively
as each layer completes.
"""

from .orchestrator import ProactiveAnalyzer, AnalysisResult, AnalysisTier
from .semantic_analyzer import SemanticAnalyzer
from .ai_predictor import AIErrorPredictor
from .cache import AnalysisCache

__all__ = [
    'ProactiveAnalyzer',
    'AnalysisResult', 
    'AnalysisTier',
    'SemanticAnalyzer',
    'AIErrorPredictor',
    'AnalysisCache',
]
