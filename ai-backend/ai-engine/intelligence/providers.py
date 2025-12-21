"""
DiagnosticProvider Interface and Types

This module defines the abstraction layer over different diagnostic sources:
- LSP (Language Server Protocol) for syntax/type checking
- Compiler for deep semantic analysis
- AI for context-aware suggestions

Each provider implements the DiagnosticProvider interface to ensure consistent
diagnostic output format.
"""

from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from enum import Enum
from typing import Any, Dict, List, Optional, Callable, Awaitable
import asyncio
import hashlib


class DiagnosticSource(str, Enum):
    """Source that produced the diagnostic."""
    LSP = "LSP"              # Language Server Protocol (Layer A)
    COMPILER = "Compiler"    # Actual compiler/build tool (Layer B)
    AI_REVIEW = "AI_Review"  # AI analysis (Layer C)
    STATIC = "Static"        # Pattern-based static analysis


class DiagnosticSeverity(str, Enum):
    """Severity levels following LSP conventions."""
    ERROR = "Error"
    WARNING = "Warning"
    INFORMATION = "Information"
    HINT = "Hint"
    SUGGESTION = "Suggestion"  # AI-specific


class CodeActionKind(str, Enum):
    """Types of code actions/quick fixes."""
    QUICK_FIX = "quickfix"
    REFACTOR = "refactor"
    SOURCE = "source"
    AI_FIX = "ai.fix"
    AI_REFACTOR = "ai.refactor"


@dataclass
class DiagnosticRange:
    """Range in source code (1-indexed for display)."""
    start_line: int
    start_column: int
    end_line: int
    end_column: int
    
    def to_dict(self) -> Dict[str, int]:
        return {
            "start": self.start_line,
            "startColumn": self.start_column,
            "end": self.end_line,
            "endColumn": self.end_column,
        }
    
    @classmethod
    def from_line(cls, line: int, column: int = 0, length: int = 1) -> "DiagnosticRange":
        """Create a range from a single line."""
        return cls(
            start_line=line,
            start_column=column,
            end_line=line,
            end_column=column + length,
        )


@dataclass
class RelatedInformation:
    """Additional context for a diagnostic."""
    file_path: str
    range: DiagnosticRange
    message: str
    
    def to_dict(self) -> Dict[str, Any]:
        return {
            "file": self.file_path,
            "range": self.range.to_dict(),
            "message": self.message,
        }


@dataclass
class CodeAction:
    """
    A code action (quick fix) that can resolve a diagnostic.
    
    Actions can be:
    - Deterministic (LSP): Direct text replacement
    - Generative (AI): Generated diff patch
    """
    title: str
    kind: CodeActionKind
    source: DiagnosticSource
    edit: Optional[Dict[str, Any]] = None  # WorkspaceEdit for deterministic fixes
    command: Optional[Dict[str, Any]] = None  # Command for AI-driven fixes
    is_preferred: bool = False
    diagnostic_ids: List[str] = field(default_factory=list)  # Associated diagnostics
    ai_patch: Optional[str] = None  # AI-generated diff patch (for AI fixes)
    
    def to_dict(self) -> Dict[str, Any]:
        result = {
            "title": self.title,
            "kind": self.kind.value,
            "source": self.source.value,
            "isPreferred": self.is_preferred,
        }
        if self.edit:
            result["edit"] = self.edit
        if self.command:
            result["command"] = self.command
        if self.diagnostic_ids:
            result["diagnosticIds"] = self.diagnostic_ids
        if self.ai_patch:
            result["aiPatch"] = self.ai_patch
        return result


@dataclass
class UnifiedDiagnostic:
    """
    Unified diagnostic format that aggregates info from all sources.
    
    This is the standard format sent to the frontend. It includes:
    - Source identification (LSP, Compiler, AI)
    - Standard severity and location
    - Associated code actions (quick fixes)
    - Deduplication ID for merging similar diagnostics
    """
    id: str  # Unique identifier for this diagnostic
    source: DiagnosticSource
    severity: DiagnosticSeverity
    range: DiagnosticRange
    message: str
    file_path: str
    code: Optional[str] = None  # Diagnostic code (e.g., "TS2304", "E0001")
    category: Optional[str] = None  # Category (syntax, type, logic, etc.)
    related_information: List[RelatedInformation] = field(default_factory=list)
    actions: List[CodeAction] = field(default_factory=list)
    explanation: Optional[str] = None  # AI explanation of the issue
    original_text: Optional[str] = None  # Source code snippet causing the issue
    confidence: float = 1.0  # Confidence score (AI diagnostics)
    
    def __post_init__(self):
        if not self.id:
            # Generate deterministic ID from content
            content = f"{self.file_path}:{self.range.start_line}:{self.source.value}:{self.message[:50]}"
            self.id = hashlib.sha256(content.encode()).hexdigest()[:12]
    
    @property
    def dedup_key(self) -> str:
        """Key for deduplicating similar diagnostics across sources."""
        # Normalize message for comparison
        msg_normalized = self.message.lower().replace('`', '').replace("'", "")[:50]
        return f"{self.file_path}:{self.range.start_line}:{msg_normalized}"
    
    def to_dict(self) -> Dict[str, Any]:
        result = {
            "id": self.id,
            "source": self.source.value,
            "severity": self.severity.value,
            "range": self.range.to_dict(),
            "message": self.message,
            "file": self.file_path,
        }
        if self.code:
            result["code"] = self.code
        if self.category:
            result["category"] = self.category
        if self.related_information:
            result["relatedInformation"] = [r.to_dict() for r in self.related_information]
        if self.actions:
            result["actions"] = [a.to_dict() for a in self.actions]
        if self.explanation:
            result["explanation"] = self.explanation
        if self.original_text:
            result["originalText"] = self.original_text
        if self.confidence < 1.0:
            result["confidence"] = self.confidence
        return result


class DiagnosticProvider(ABC):
    """
    Abstract base class for diagnostic providers.
    
    Each provider (LSP, Compiler, AI) implements this interface to ensure
    consistent diagnostic output. The Intelligence Aggregator consumes
    diagnostics from all providers.
    """
    
    @property
    @abstractmethod
    def source(self) -> DiagnosticSource:
        """Return the source type of this provider."""
        pass
    
    @property
    @abstractmethod
    def priority(self) -> int:
        """
        Return the priority of this provider (lower = higher priority).
        Used for deduplication: keep diagnostics from higher priority sources.
        AI = 0, Compiler = 1, LSP = 2
        """
        pass
    
    @abstractmethod
    async def analyze(
        self,
        file_path: str,
        content: str,
        language: str,
        related_files: Optional[Dict[str, str]] = None,
    ) -> List[UnifiedDiagnostic]:
        """
        Analyze a file and return diagnostics.
        
        Args:
            file_path: Path to the file being analyzed
            content: File content
            language: Language identifier (e.g., "python", "typescript")
            related_files: Map of path -> content for related files
            
        Returns:
            List of unified diagnostics
        """
        pass
    
    @abstractmethod
    async def get_code_actions(
        self,
        file_path: str,
        content: str,
        diagnostics: List[UnifiedDiagnostic],
    ) -> List[CodeAction]:
        """
        Get code actions (quick fixes) for the given diagnostics.
        
        Args:
            file_path: Path to the file
            content: Current file content
            diagnostics: Diagnostics to generate fixes for
            
        Returns:
            List of code actions
        """
        pass


class StaticAnalysisProvider(DiagnosticProvider):
    """
    Provider for fast static/pattern-based analysis (Layer A substitute).
    
    This runs pattern-based checks without invoking a full LSP server.
    In production, this would be replaced by actual LSP integration.
    """
    
    def __init__(self):
        from analyzer import get_analyzer, supported_languages
        self._analyzers = {}
        self._supported = supported_languages
    
    @property
    def source(self) -> DiagnosticSource:
        return DiagnosticSource.STATIC
    
    @property
    def priority(self) -> int:
        return 2  # Lower priority than compiler and AI
    
    async def analyze(
        self,
        file_path: str,
        content: str,
        language: str,
        related_files: Optional[Dict[str, str]] = None,
    ) -> List[UnifiedDiagnostic]:
        from analyzer import get_analyzer
        
        if language not in self._supported:
            return []
        
        try:
            analyzer = get_analyzer(language)
            # Run analysis in thread pool to avoid blocking
            loop = asyncio.get_event_loop()
            result = await loop.run_in_executor(None, analyzer.analyze, content)
            
            diagnostics = []
            for diag in result.get('diagnostics', []):
                diagnostics.append(UnifiedDiagnostic(
                    id="",  # Will be generated
                    source=DiagnosticSource.STATIC,
                    severity=self._map_severity(diag.get('severity', 'error')),
                    range=DiagnosticRange.from_line(
                        line=diag.get('line', 1),
                        column=diag.get('column', 0),
                    ),
                    message=diag.get('message', 'Unknown error'),
                    file_path=file_path,
                    code=diag.get('code'),
                    category=diag.get('category'),
                ))
            
            return diagnostics
            
        except Exception as e:
            # Return empty on error - don't crash the pipeline
            return []
    
    async def get_code_actions(
        self,
        file_path: str,
        content: str,
        diagnostics: List[UnifiedDiagnostic],
    ) -> List[CodeAction]:
        # Static analysis doesn't provide code actions by itself
        return []
    
    def _map_severity(self, severity: str) -> DiagnosticSeverity:
        mapping = {
            'error': DiagnosticSeverity.ERROR,
            'warning': DiagnosticSeverity.WARNING,
            'info': DiagnosticSeverity.INFORMATION,
            'hint': DiagnosticSeverity.HINT,
        }
        return mapping.get(severity.lower(), DiagnosticSeverity.ERROR)


class AIAnalysisProvider(DiagnosticProvider):
    """
    Provider for AI-powered analysis (Layer C).
    
    This provider:
    - Detects logic errors and code smells
    - Generates explanations for complex issues
    - Creates generative fixes (AI patches)
    """
    
    def __init__(self, llm_provider=None):
        self._llm_provider = llm_provider
    
    @property
    def source(self) -> DiagnosticSource:
        return DiagnosticSource.AI_REVIEW
    
    @property
    def priority(self) -> int:
        return 0  # Highest priority
    
    async def analyze(
        self,
        file_path: str,
        content: str,
        language: str,
        related_files: Optional[Dict[str, str]] = None,
        compiler_errors: Optional[List[UnifiedDiagnostic]] = None,
    ) -> List[UnifiedDiagnostic]:
        """
        Analyze code with AI.
        
        If compiler_errors are provided, the AI focuses on explaining and
        suggesting fixes for those specific errors.
        """
        if not self._llm_provider:
            return []
        
        from analyzer.proactive import ProactiveAnalyzer, AnalysisTier
        from analyzer.proactive.types import FileContext, AnalysisRequest
        from analyzer.proactive.cache import AnalysisCache
        
        try:
            # Create file context
            file_ctx = FileContext(
                path=file_path,
                content=content,
                language=language,
            )
            
            # Create related file contexts
            related = []
            if related_files:
                for path, rcontent in related_files.items():
                    related.append(FileContext(
                        path=path,
                        content=rcontent,
                        language=language,
                    ))
            
            # Create analysis request - AI tier only
            request = AnalysisRequest(
                file=file_ctx,
                related_files=related,
                tiers=[AnalysisTier.AI],
                max_diagnostics=20,
                include_fixes=True,
            )
            
            # Run AI analysis
            cache = AnalysisCache(max_entries=100, max_age_seconds=300)
            analyzer = ProactiveAnalyzer(
                cache=cache,
                llm_provider=self._llm_provider,
                enable_ai=True,
                ai_min_confidence=0.5,
            )
            
            result = await analyzer.analyze(request)
            
            # Convert to unified diagnostics
            diagnostics = []
            for diag in result.all_diagnostics:
                diagnostics.append(UnifiedDiagnostic(
                    id="",
                    source=DiagnosticSource.AI_REVIEW,
                    severity=self._map_severity(diag.severity.value),
                    range=DiagnosticRange(
                        start_line=diag.location.line,
                        start_column=diag.location.column,
                        end_line=diag.location.end_line,
                        end_column=diag.location.end_column,
                    ),
                    message=diag.message,
                    file_path=file_path,
                    code=diag.code,
                    category=diag.category.value if diag.category else None,
                    explanation=diag.explanation,
                    original_text=diag.originalText,
                    confidence=diag.confidence,
                ))
            
            return diagnostics
            
        except Exception as e:
            import logging
            logging.getLogger('intelligence.providers').error(f"AI analysis failed: {e}")
            return []
    
    async def get_code_actions(
        self,
        file_path: str,
        content: str,
        diagnostics: List[UnifiedDiagnostic],
    ) -> List[CodeAction]:
        """Generate AI-powered code actions for diagnostics."""
        if not self._llm_provider:
            return []
        
        actions = []
        
        for diag in diagnostics:
            if diag.source == DiagnosticSource.AI_REVIEW:
                # AI diagnostics already have suggested fixes
                continue
            
            # For compiler/LSP errors, generate AI fix suggestions
            try:
                action = await self._generate_ai_fix(file_path, content, diag)
                if action:
                    actions.append(action)
            except Exception:
                pass  # Skip on error
        
        return actions
    
    async def _generate_ai_fix(
        self,
        file_path: str,
        content: str,
        diagnostic: UnifiedDiagnostic,
    ) -> Optional[CodeAction]:
        """Generate an AI fix for a specific diagnostic."""
        # This would use the LLM to generate a fix
        # For now, return None - implement with actual LLM call
        return None
    
    def _map_severity(self, severity: str) -> DiagnosticSeverity:
        mapping = {
            'error': DiagnosticSeverity.ERROR,
            'warning': DiagnosticSeverity.WARNING,
            'info': DiagnosticSeverity.INFORMATION,
            'hint': DiagnosticSeverity.HINT,
        }
        return mapping.get(severity.lower(), DiagnosticSeverity.SUGGESTION)
