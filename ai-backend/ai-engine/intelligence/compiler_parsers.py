"""
Compiler Output Parsers - Convert stderr/logs to line-specific diagnostics

This module provides regex-based parsers for various compilers and interpreters
to extract structured diagnostic information from their output.

Supported languages:
- JavaScript/TypeScript (Node.js, tsc)
- Python (python, pylint, mypy)
- C/C++ (gcc, g++, clang)
- Rust (rustc, cargo)
- Go (go build)
"""

from __future__ import annotations

import re
import logging
from abc import ABC, abstractmethod
from dataclasses import dataclass
from typing import Any, Dict, List, Optional, Tuple
from enum import Enum

from .providers import (
    DiagnosticSource,
    DiagnosticSeverity,
    DiagnosticRange,
    UnifiedDiagnostic,
)


logger = logging.getLogger('intelligence.compiler_parsers')


class CompilerType(str, Enum):
    """Supported compiler types."""
    GCC = "gcc"
    CLANG = "clang"
    TYPESCRIPT = "typescript"
    PYTHON = "python"
    PYLINT = "pylint"
    MYPY = "mypy"
    RUSTC = "rustc"
    GO = "go"
    NODE = "node"


@dataclass
class ParsedError:
    """Raw parsed error from compiler output."""
    file_path: str
    line: int
    column: int
    severity: str
    message: str
    code: Optional[str] = None
    end_line: Optional[int] = None
    end_column: Optional[int] = None
    context_lines: List[str] = None
    
    def __post_init__(self):
        if self.context_lines is None:
            self.context_lines = []


class CompilerOutputParser(ABC):
    """Abstract base class for compiler output parsers."""
    
    @property
    @abstractmethod
    def compiler_type(self) -> CompilerType:
        """Return the compiler type this parser handles."""
        pass
    
    @property
    @abstractmethod
    def supported_languages(self) -> List[str]:
        """Return list of supported language identifiers."""
        pass
    
    @abstractmethod
    def parse(self, output: str, working_dir: str = "") -> List[ParsedError]:
        """
        Parse compiler output and extract errors.
        
        Args:
            output: Raw stderr/stdout from compiler
            working_dir: Working directory for resolving relative paths
            
        Returns:
            List of parsed errors
        """
        pass
    
    def to_diagnostics(
        self,
        output: str,
        working_dir: str = "",
    ) -> List[UnifiedDiagnostic]:
        """
        Parse output and convert to unified diagnostics.
        """
        errors = self.parse(output, working_dir)
        diagnostics = []
        
        for error in errors:
            severity = self._map_severity(error.severity)
            
            diagnostics.append(UnifiedDiagnostic(
                id="",
                source=DiagnosticSource.COMPILER,
                severity=severity,
                range=DiagnosticRange(
                    start_line=error.line,
                    start_column=error.column,
                    end_line=error.end_line or error.line,
                    end_column=error.end_column or (error.column + 1),
                ),
                message=error.message,
                file_path=error.file_path,
                code=error.code,
            ))
        
        return diagnostics
    
    def _map_severity(self, severity: str) -> DiagnosticSeverity:
        """Map compiler severity to unified severity."""
        severity = severity.lower()
        if 'error' in severity:
            return DiagnosticSeverity.ERROR
        elif 'warning' in severity or 'warn' in severity:
            return DiagnosticSeverity.WARNING
        elif 'note' in severity or 'info' in severity:
            return DiagnosticSeverity.INFORMATION
        elif 'hint' in severity:
            return DiagnosticSeverity.HINT
        else:
            return DiagnosticSeverity.ERROR


class GCCParser(CompilerOutputParser):
    """
    Parser for GCC/G++ compiler output.
    
    Format: filename:line:column: severity: message
    Example: main.cpp:10:5: error: 'x' was not declared in this scope
    """
    
    # GCC error pattern
    PATTERN = re.compile(
        r'^(?P<file>[^:\s]+):(?P<line>\d+):(?P<column>\d+):\s*'
        r'(?P<severity>error|warning|note):\s*(?P<message>.+)$',
        re.MULTILINE
    )
    
    # Extended pattern for "In file included from" context
    INCLUDE_PATTERN = re.compile(
        r'^In file included from (?P<file>[^:]+):(?P<line>\d+)',
        re.MULTILINE
    )
    
    @property
    def compiler_type(self) -> CompilerType:
        return CompilerType.GCC
    
    @property
    def supported_languages(self) -> List[str]:
        return ['c', 'cpp', 'c++']
    
    def parse(self, output: str, working_dir: str = "") -> List[ParsedError]:
        errors = []
        
        for match in self.PATTERN.finditer(output):
            errors.append(ParsedError(
                file_path=self._resolve_path(match.group('file'), working_dir),
                line=int(match.group('line')),
                column=int(match.group('column')),
                severity=match.group('severity'),
                message=match.group('message'),
            ))
        
        return errors
    
    def _resolve_path(self, path: str, working_dir: str) -> str:
        """Resolve relative path to absolute."""
        import os
        if os.path.isabs(path):
            return path
        if working_dir:
            return os.path.normpath(os.path.join(working_dir, path))
        return path


class ClangParser(GCCParser):
    """
    Parser for Clang compiler output.
    
    Similar format to GCC with some extensions.
    """
    
    @property
    def compiler_type(self) -> CompilerType:
        return CompilerType.CLANG


class TypeScriptParser(CompilerOutputParser):
    """
    Parser for TypeScript compiler (tsc) output.
    
    Format: file(line,column): severity TS[code]: message
    Example: src/index.ts(10,5): error TS2304: Cannot find name 'x'.
    """
    
    PATTERN = re.compile(
        r'^(?P<file>[^(\s]+)\((?P<line>\d+),(?P<column>\d+)\):\s*'
        r'(?P<severity>error|warning)\s+TS(?P<code>\d+):\s*(?P<message>.+)$',
        re.MULTILINE
    )
    
    @property
    def compiler_type(self) -> CompilerType:
        return CompilerType.TYPESCRIPT
    
    @property
    def supported_languages(self) -> List[str]:
        return ['typescript', 'javascript']
    
    def parse(self, output: str, working_dir: str = "") -> List[ParsedError]:
        errors = []
        
        for match in self.PATTERN.finditer(output):
            errors.append(ParsedError(
                file_path=match.group('file'),
                line=int(match.group('line')),
                column=int(match.group('column')),
                severity=match.group('severity'),
                message=match.group('message'),
                code=f"TS{match.group('code')}",
            ))
        
        return errors


class PythonParser(CompilerOutputParser):
    """
    Parser for Python interpreter errors.
    
    Handles:
    - SyntaxError: File "file.py", line 10
    - Traceback errors
    """
    
    # SyntaxError pattern
    SYNTAX_PATTERN = re.compile(
        r'File "(?P<file>[^"]+)", line (?P<line>\d+).*?\n'
        r'(?:.*?\n)?'
        r'(?P<severity>SyntaxError|IndentationError|TabError):\s*(?P<message>.+)$',
        re.MULTILINE | re.DOTALL
    )
    
    # Generic error in traceback
    TRACEBACK_PATTERN = re.compile(
        r'File "(?P<file>[^"]+)", line (?P<line>\d+).*?\n'
        r'(?P<severity>\w+Error):\s*(?P<message>.+)$',
        re.MULTILINE
    )
    
    @property
    def compiler_type(self) -> CompilerType:
        return CompilerType.PYTHON
    
    @property
    def supported_languages(self) -> List[str]:
        return ['python']
    
    def parse(self, output: str, working_dir: str = "") -> List[ParsedError]:
        errors = []
        
        # Try syntax errors first
        for match in self.SYNTAX_PATTERN.finditer(output):
            errors.append(ParsedError(
                file_path=match.group('file'),
                line=int(match.group('line')),
                column=1,
                severity='error',
                message=f"{match.group('severity')}: {match.group('message')}",
            ))
        
        # If no syntax errors, try traceback
        if not errors:
            for match in self.TRACEBACK_PATTERN.finditer(output):
                errors.append(ParsedError(
                    file_path=match.group('file'),
                    line=int(match.group('line')),
                    column=1,
                    severity='error',
                    message=f"{match.group('severity')}: {match.group('message')}",
                ))
        
        return errors


class MypyParser(CompilerOutputParser):
    """
    Parser for mypy type checker output.
    
    Format: file:line: severity: message
    Example: src/main.py:10: error: Incompatible types
    """
    
    PATTERN = re.compile(
        r'^(?P<file>[^:\s]+):(?P<line>\d+):\s*'
        r'(?P<severity>error|warning|note):\s*(?P<message>.+)$',
        re.MULTILINE
    )
    
    @property
    def compiler_type(self) -> CompilerType:
        return CompilerType.MYPY
    
    @property
    def supported_languages(self) -> List[str]:
        return ['python']
    
    def parse(self, output: str, working_dir: str = "") -> List[ParsedError]:
        errors = []
        
        for match in self.PATTERN.finditer(output):
            errors.append(ParsedError(
                file_path=match.group('file'),
                line=int(match.group('line')),
                column=1,
                severity=match.group('severity'),
                message=match.group('message'),
            ))
        
        return errors


class RustcParser(CompilerOutputParser):
    """
    Parser for Rust compiler (rustc/cargo) output.
    
    Format: error[E0001]: message
             --> file:line:column
    """
    
    # Main error pattern
    PATTERN = re.compile(
        r'(?P<severity>error|warning)\[(?P<code>E\d+)\]:\s*(?P<message>.+)\n'
        r'\s*-->\s*(?P<file>[^:]+):(?P<line>\d+):(?P<column>\d+)',
        re.MULTILINE
    )
    
    # Simpler pattern for errors without code
    SIMPLE_PATTERN = re.compile(
        r'(?P<severity>error|warning):\s*(?P<message>.+)\n'
        r'\s*-->\s*(?P<file>[^:]+):(?P<line>\d+):(?P<column>\d+)',
        re.MULTILINE
    )
    
    @property
    def compiler_type(self) -> CompilerType:
        return CompilerType.RUSTC
    
    @property
    def supported_languages(self) -> List[str]:
        return ['rust']
    
    def parse(self, output: str, working_dir: str = "") -> List[ParsedError]:
        errors = []
        
        # Try pattern with error code first
        for match in self.PATTERN.finditer(output):
            errors.append(ParsedError(
                file_path=match.group('file'),
                line=int(match.group('line')),
                column=int(match.group('column')),
                severity=match.group('severity'),
                message=match.group('message'),
                code=match.group('code'),
            ))
        
        # Also try simple pattern
        for match in self.SIMPLE_PATTERN.finditer(output):
            # Avoid duplicates
            file_path = match.group('file')
            line = int(match.group('line'))
            if not any(e.file_path == file_path and e.line == line for e in errors):
                errors.append(ParsedError(
                    file_path=file_path,
                    line=line,
                    column=int(match.group('column')),
                    severity=match.group('severity'),
                    message=match.group('message'),
                ))
        
        return errors


class GoParser(CompilerOutputParser):
    """
    Parser for Go compiler output.
    
    Format: file:line:column: message
    Example: main.go:10:5: undefined: x
    """
    
    PATTERN = re.compile(
        r'^(?P<file>[^:\s]+\.go):(?P<line>\d+):(?P<column>\d+):\s*(?P<message>.+)$',
        re.MULTILINE
    )
    
    @property
    def compiler_type(self) -> CompilerType:
        return CompilerType.GO
    
    @property
    def supported_languages(self) -> List[str]:
        return ['go']
    
    def parse(self, output: str, working_dir: str = "") -> List[ParsedError]:
        errors = []
        
        for match in self.PATTERN.finditer(output):
            errors.append(ParsedError(
                file_path=match.group('file'),
                line=int(match.group('line')),
                column=int(match.group('column')),
                severity='error',  # Go doesn't have warnings
                message=match.group('message'),
            ))
        
        return errors


class NodeParser(CompilerOutputParser):
    """
    Parser for Node.js runtime errors.
    
    Handles JavaScript runtime errors from Node.js.
    """
    
    # Stack trace file:line pattern
    PATTERN = re.compile(
        r'at\s+(?:\S+\s+)?\(?(?P<file>[^:]+):(?P<line>\d+):(?P<column>\d+)\)?',
        re.MULTILINE
    )
    
    # Error message pattern
    ERROR_PATTERN = re.compile(
        r'^(?P<file>[^:\s]+):(?P<line>\d+)\n'
        r'.*?\n'
        r'(?P<severity>\w+Error):\s*(?P<message>.+)$',
        re.MULTILINE | re.DOTALL
    )
    
    @property
    def compiler_type(self) -> CompilerType:
        return CompilerType.NODE
    
    @property
    def supported_languages(self) -> List[str]:
        return ['javascript', 'typescript']
    
    def parse(self, output: str, working_dir: str = "") -> List[ParsedError]:
        errors = []
        
        for match in self.ERROR_PATTERN.finditer(output):
            errors.append(ParsedError(
                file_path=match.group('file'),
                line=int(match.group('line')),
                column=1,
                severity='error',
                message=f"{match.group('severity')}: {match.group('message')}",
            ))
        
        return errors


# Parser registry
_PARSERS: Dict[str, CompilerOutputParser] = {
    'gcc': GCCParser(),
    'g++': GCCParser(),
    'clang': ClangParser(),
    'clang++': ClangParser(),
    'tsc': TypeScriptParser(),
    'python': PythonParser(),
    'python3': PythonParser(),
    'mypy': MypyParser(),
    'rustc': RustcParser(),
    'cargo': RustcParser(),
    'go': GoParser(),
    'node': NodeParser(),
}

_LANGUAGE_PARSERS: Dict[str, List[CompilerOutputParser]] = {
    'c': [GCCParser(), ClangParser()],
    'cpp': [GCCParser(), ClangParser()],
    'c++': [GCCParser(), ClangParser()],
    'typescript': [TypeScriptParser(), NodeParser()],
    'javascript': [NodeParser()],
    'python': [PythonParser(), MypyParser()],
    'rust': [RustcParser()],
    'go': [GoParser()],
}


def get_parser(compiler: str) -> Optional[CompilerOutputParser]:
    """Get parser for a specific compiler."""
    return _PARSERS.get(compiler.lower())


def get_parser_for_language(language: str) -> Optional[CompilerOutputParser]:
    """
    Get the primary parser for a language.
    
    Returns the first matching parser (usually the native compiler).
    """
    parsers = _LANGUAGE_PARSERS.get(language.lower(), [])
    return parsers[0] if parsers else None


def get_all_parsers_for_language(language: str) -> List[CompilerOutputParser]:
    """Get all applicable parsers for a language."""
    return _LANGUAGE_PARSERS.get(language.lower(), [])


def parse_compiler_output(
    output: str,
    language: str,
    working_dir: str = "",
) -> List[UnifiedDiagnostic]:
    """
    Parse compiler output for a given language.
    
    Tries all applicable parsers and returns combined results.
    """
    diagnostics = []
    parsers = get_all_parsers_for_language(language)
    
    for parser in parsers:
        try:
            diags = parser.to_diagnostics(output, working_dir)
            diagnostics.extend(diags)
        except Exception as e:
            logger.error(f"Parser {parser.compiler_type.value} failed: {e}")
    
    # Deduplicate by file+line
    seen = set()
    unique = []
    for d in diagnostics:
        key = (d.file_path, d.range.start_line, d.message[:50])
        if key not in seen:
            seen.add(key)
            unique.append(d)
    
    return unique
