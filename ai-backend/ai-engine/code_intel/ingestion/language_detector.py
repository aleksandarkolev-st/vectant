"""
Language Detection - Determine the programming language of a file.

Uses multiple signals:
1. File extension (primary)
2. Shebang line
3. Content patterns (fallback)
"""

from __future__ import annotations

import os
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Dict, Optional


# Extension to language mapping
EXTENSION_MAP: Dict[str, str] = {
    # Python
    ".py": "python",
    ".pyw": "python",
    ".pyi": "python",
    
    # JavaScript/TypeScript
    ".js": "javascript",
    ".jsx": "javascriptreact",
    ".mjs": "javascript",
    ".cjs": "javascript",
    ".ts": "typescript",
    ".tsx": "typescriptreact",
    
    # Java
    ".java": "java",
    
    # Go
    ".go": "go",
    
    # Rust
    ".rs": "rust",
    
    # C/C++
    ".c": "c",
    ".h": "c",
    ".cpp": "cpp",
    ".hpp": "cpp",
    ".cc": "cpp",
    ".cxx": "cpp",
    ".hh": "cpp",
    ".hxx": "cpp",
    
    # C#
    ".cs": "csharp",
    
    # Ruby
    ".rb": "ruby",
    ".rake": "ruby",
    ".gemspec": "ruby",
    
    # PHP
    ".php": "php",
    
    # Swift
    ".swift": "swift",
    
    # Kotlin
    ".kt": "kotlin",
    ".kts": "kotlin",
    
    # Scala
    ".scala": "scala",
    ".sc": "scala",
    
    # Vue/Svelte
    ".vue": "vue",
    ".svelte": "svelte",
    
    # Shell
    ".sh": "shell",
    ".bash": "shell",
    ".zsh": "shell",
    
    # Config/Data
    ".json": "json",
    ".yaml": "yaml",
    ".yml": "yaml",
    ".toml": "toml",
    ".xml": "xml",
    ".html": "html",
    ".htm": "html",
    ".css": "css",
    ".scss": "scss",
    ".sass": "sass",
    ".less": "less",
    
    # Markdown
    ".md": "markdown",
    ".markdown": "markdown",
    
    # SQL
    ".sql": "sql",
    
    # R
    ".r": "r",
    ".R": "r",
    
    # Lua
    ".lua": "lua",
    
    # Perl
    ".pl": "perl",
    ".pm": "perl",
    
    # Haskell
    ".hs": "haskell",
    ".lhs": "haskell",
    
    # Elixir
    ".ex": "elixir",
    ".exs": "elixir",
    
    # Erlang
    ".erl": "erlang",
    ".hrl": "erlang",
    
    # Clojure
    ".clj": "clojure",
    ".cljs": "clojure",
    ".cljc": "clojure",
    
    # F#
    ".fs": "fsharp",
    ".fsx": "fsharp",
    
    # OCaml
    ".ml": "ocaml",
    ".mli": "ocaml",
    
    # Zig
    ".zig": "zig",
    
    # Nim
    ".nim": "nim",
    
    # Julia
    ".jl": "julia",
    
    # Dart
    ".dart": "dart",
    
    # Groovy
    ".groovy": "groovy",
    ".gradle": "groovy",
}


# Shebang to language mapping
SHEBANG_PATTERNS: Dict[str, str] = {
    r"python": "python",
    r"node": "javascript",
    r"ruby": "ruby",
    r"perl": "perl",
    r"php": "php",
    r"bash|sh|zsh": "shell",
}


# Content patterns for ambiguous cases
CONTENT_PATTERNS: Dict[str, list] = {
    "python": [
        r"^from\s+\w+\s+import",
        r"^import\s+\w+",
        r"^\s*def\s+\w+\s*\(",
        r"^\s*class\s+\w+.*:",
        r"if\s+__name__\s*==\s*['\"]__main__['\"]",
    ],
    "javascript": [
        r"^const\s+\w+\s*=",
        r"^let\s+\w+\s*=",
        r"^var\s+\w+\s*=",
        r"^function\s+\w+\s*\(",
        r"^export\s+(default\s+)?",
        r"^import\s+.*\s+from\s+['\"]",
        r"require\s*\(['\"]",
    ],
    "typescript": [
        r"^interface\s+\w+",
        r"^type\s+\w+\s*=",
        r":\s*(string|number|boolean|any|void)\b",
        r"<[A-Z]\w*>",
    ],
    "java": [
        r"^public\s+class\s+\w+",
        r"^package\s+[\w.]+;",
        r"^import\s+java\.",
        r"^\s*public\s+static\s+void\s+main",
    ],
    "go": [
        r"^package\s+\w+",
        r"^func\s+\w+\s*\(",
        r"^import\s+\(",
        r"^type\s+\w+\s+struct",
    ],
    "rust": [
        r"^use\s+\w+::",
        r"^fn\s+\w+\s*\(",
        r"^struct\s+\w+",
        r"^impl\s+\w+",
        r"^mod\s+\w+",
        r"#\[derive\(",
    ],
}


@dataclass
class DetectionResult:
    """Result of language detection."""
    language: str
    confidence: float  # 0.0 - 1.0
    method: str  # "extension", "shebang", "content"


class LanguageDetector:
    """
    Detect programming language of files.
    
    Detection order (by confidence):
    1. File extension (0.95 confidence)
    2. Shebang line (0.9 confidence)
    3. Content analysis (0.6-0.8 confidence)
    """
    
    def __init__(self):
        # Pre-compile content patterns
        self._content_patterns: Dict[str, list] = {}
        for lang, patterns in CONTENT_PATTERNS.items():
            self._content_patterns[lang] = [re.compile(p, re.MULTILINE) for p in patterns]
        
        # Pre-compile shebang patterns
        self._shebang_patterns = [
            (re.compile(pattern), lang)
            for pattern, lang in SHEBANG_PATTERNS.items()
        ]
    
    def detect(self, filepath: str, content: Optional[str] = None) -> DetectionResult:
        """
        Detect language of a file.
        
        Args:
            filepath: Path to file
            content: Optional file content (avoids re-reading)
            
        Returns:
            DetectionResult with language, confidence, and method
        """
        # Try extension first (most reliable)
        ext = Path(filepath).suffix.lower()
        if ext in EXTENSION_MAP:
            return DetectionResult(
                language=EXTENSION_MAP[ext],
                confidence=0.95,
                method="extension",
            )
        
        # Try shebang
        if content:
            shebang_result = self._detect_shebang(content)
            if shebang_result:
                return shebang_result
        
        # Try content analysis
        if content:
            content_result = self._detect_content(content)
            if content_result:
                return content_result
        
        # Unknown
        return DetectionResult(
            language="unknown",
            confidence=0.0,
            method="none",
        )
    
    def _detect_shebang(self, content: str) -> Optional[DetectionResult]:
        """Detect language from shebang line."""
        first_line = content.split("\n", 1)[0]
        if not first_line.startswith("#!"):
            return None
        
        for pattern, lang in self._shebang_patterns:
            if pattern.search(first_line):
                return DetectionResult(
                    language=lang,
                    confidence=0.9,
                    method="shebang",
                )
        
        return None
    
    def _detect_content(self, content: str) -> Optional[DetectionResult]:
        """Detect language from content patterns."""
        # Score each language by pattern matches
        scores: Dict[str, int] = {}
        
        for lang, patterns in self._content_patterns.items():
            score = sum(1 for p in patterns if p.search(content))
            if score > 0:
                scores[lang] = score
        
        if not scores:
            return None
        
        # Pick highest scoring language
        best_lang = max(scores, key=scores.get)
        best_score = scores[best_lang]
        total_patterns = len(self._content_patterns[best_lang])
        
        # Confidence based on match ratio
        confidence = min(0.8, 0.5 + (best_score / total_patterns) * 0.3)
        
        return DetectionResult(
            language=best_lang,
            confidence=confidence,
            method="content",
        )


# Global detector instance
_detector: Optional[LanguageDetector] = None


def detect_language(filepath: str, content: Optional[str] = None) -> str:
    """
    Convenience function to detect language.
    
    Args:
        filepath: Path to file
        content: Optional file content
        
    Returns:
        Language identifier string
    """
    global _detector
    if _detector is None:
        _detector = LanguageDetector()
    
    result = _detector.detect(filepath, content)
    return result.language
