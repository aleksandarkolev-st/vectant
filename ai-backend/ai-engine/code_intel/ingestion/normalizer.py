"""
Normalizer - Clean and normalize code for consistent processing.

Handles:
- Whitespace normalization
- Comment extraction
- Code formatting consistency
"""

from __future__ import annotations

import re
from typing import List, Optional, Tuple

from .file_walker import WalkedFile


class Normalizer:
    """
    Normalize source code for consistent processing.
    
    This ensures that semantically equivalent code produces
    similar embeddings regardless of formatting differences.
    """
    
    def __init__(
        self,
        normalize_whitespace: bool = True,
        preserve_docstrings: bool = True,
        remove_comments: bool = False,
    ):
        self.normalize_whitespace = normalize_whitespace
        self.preserve_docstrings = preserve_docstrings
        self.remove_comments = remove_comments
    
    def normalize(self, content: str, language: str) -> str:
        """
        Normalize source code content.
        
        Args:
            content: Source code
            language: Language identifier
            
        Returns:
            Normalized source code
        """
        result = content
        
        # Remove comments if requested
        if self.remove_comments:
            result = self._remove_comments(result, language)
        
        # Normalize whitespace
        if self.normalize_whitespace:
            result = self._normalize_whitespace(result)
        
        return result
    
    def _normalize_whitespace(self, content: str) -> str:
        """Normalize whitespace while preserving structure."""
        lines = content.splitlines()
        normalized = []
        
        for line in lines:
            # Remove trailing whitespace
            line = line.rstrip()
            # Normalize tabs to spaces
            line = line.replace("\t", "    ")
            normalized.append(line)
        
        # Remove excessive blank lines (keep max 2)
        result = []
        blank_count = 0
        for line in normalized:
            if not line.strip():
                blank_count += 1
                if blank_count <= 2:
                    result.append(line)
            else:
                blank_count = 0
                result.append(line)
        
        return "\n".join(result)
    
    def _remove_comments(self, content: str, language: str) -> str:
        """Remove comments based on language."""
        if language in ("python", "py"):
            return self._remove_python_comments(content)
        elif language in ("javascript", "typescript", "js", "ts", "java", "go", "rust", "cpp", "c"):
            return self._remove_c_style_comments(content)
        return content
    
    def _remove_python_comments(self, content: str) -> str:
        """Remove Python comments but preserve docstrings."""
        lines = content.splitlines()
        result = []
        in_docstring = False
        docstring_char = None
        
        for line in lines:
            stripped = line.strip()
            
            # Track docstrings
            if not in_docstring:
                if stripped.startswith('"""') or stripped.startswith("'''"):
                    docstring_char = stripped[:3]
                    if stripped.count(docstring_char) >= 2 and len(stripped) > 3:
                        # Single-line docstring
                        if self.preserve_docstrings:
                            result.append(line)
                        continue
                    in_docstring = True
                    if self.preserve_docstrings:
                        result.append(line)
                    continue
            else:
                if docstring_char in stripped:
                    in_docstring = False
                if self.preserve_docstrings:
                    result.append(line)
                continue
            
            # Remove line comments
            if "#" in line:
                # Simple approach - doesn't handle # in strings
                comment_idx = line.find("#")
                line = line[:comment_idx].rstrip()
            
            if line.strip():
                result.append(line)
        
        return "\n".join(result)
    
    def _remove_c_style_comments(self, content: str) -> str:
        """Remove C-style comments (// and /* */)."""
        # Remove block comments
        content = re.sub(r'/\*[\s\S]*?\*/', '', content)
        
        # Remove line comments
        lines = content.splitlines()
        result = []
        for line in lines:
            if "//" in line:
                comment_idx = line.find("//")
                line = line[:comment_idx].rstrip()
            if line.strip():
                result.append(line)
        
        return "\n".join(result)
    
    def extract_docstring(self, content: str, language: str) -> Tuple[str, str]:
        """
        Extract docstring from code.
        
        Returns:
            Tuple of (docstring, code_without_docstring)
        """
        if language in ("python", "py"):
            return self._extract_python_docstring(content)
        elif language in ("javascript", "typescript", "js", "ts"):
            return self._extract_jsdoc(content)
        return ("", content)
    
    def _extract_python_docstring(self, content: str) -> Tuple[str, str]:
        """Extract Python docstring."""
        stripped = content.strip()
        
        for quote in ('"""', "'''"):
            if stripped.startswith(quote):
                end_idx = stripped.find(quote, 3)
                if end_idx > 0:
                    docstring = stripped[3:end_idx]
                    rest = stripped[end_idx + 3:].strip()
                    return (docstring, rest)
        
        return ("", content)
    
    def _extract_jsdoc(self, content: str) -> Tuple[str, str]:
        """Extract JSDoc comment."""
        match = re.match(r'/\*\*\s*([\s\S]*?)\s*\*/', content)
        if match:
            docstring = match.group(1)
            rest = content[match.end():].strip()
            return (docstring, rest)
        
        return ("", content)


def normalize_file(file: WalkedFile, **kwargs) -> WalkedFile:
    """
    Normalize a file's content.
    
    Args:
        file: WalkedFile to normalize
        **kwargs: Options passed to Normalizer
        
    Returns:
        New WalkedFile with normalized content
    """
    from .language_detector import detect_language
    
    normalizer = Normalizer(**kwargs)
    language = detect_language(file.path, file.content)
    normalized_content = normalizer.normalize(file.content, language)
    
    return WalkedFile(
        path=file.path,
        relative_path=file.relative_path,
        content=normalized_content,
        content_hash=file.content_hash,  # Keep original hash
        size_bytes=len(normalized_content.encode()),
        language=language,
    )
