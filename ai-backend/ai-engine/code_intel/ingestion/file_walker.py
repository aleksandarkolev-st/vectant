"""
File Walker - Traverse repository and discover files.

Handles:
- Recursive directory traversal
- Ignore patterns (gitignore-style)
- File size limits
- Change detection via hashing
"""

from __future__ import annotations

import fnmatch
import hashlib
import os
import unicodedata
from dataclasses import dataclass
from pathlib import Path
from typing import Dict, Iterator, List, Optional, Set
import logging

from ..core.config import get_config


logger = logging.getLogger("code_intel.ingestion.walker")


@dataclass
class WalkedFile:
    """A file discovered during repository walk."""
    path: str           # Absolute path
    relative_path: str  # Path relative to repo root
    content: str        # File content
    content_hash: str   # SHA-256 hash of content
    size_bytes: int     # File size
    language: str = ""  # Detected language (set later)
    imports: list = None  # Parser import statements (set later)
    exports: list = None  # Parser export statements (set later)
    
    @property
    def extension(self) -> str:
        return Path(self.path).suffix.lower()


class FileWalker:
    """
    Walk a repository and discover files for indexing.
    
    Features:
    - Respects ignore patterns (gitignore-style)
    - Tracks file hashes for incremental updates
    - Handles large repositories efficiently
    - Filters by file size
    """
    
    def __init__(
        self,
        root: str,
        ignore_patterns: Optional[List[str]] = None,
        max_file_size: int = 500_000,
        extensions: Optional[Set[str]] = None,
    ):
        self.root = os.path.abspath(root)
        self.config = get_config()
        
        # Merge ignore patterns
        self.ignore_patterns = set(ignore_patterns or [])
        self.ignore_patterns.update(self.config.parser.ignore_patterns)
        
        self.max_file_size = max_file_size
        
        # Supported extensions
        self.extensions = extensions or {
            ".py", ".pyw",  # Python
            ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs",  # JavaScript/TypeScript
            ".java",  # Java
            ".go",  # Go
            ".rs",  # Rust
            ".c", ".h", ".cpp", ".hpp", ".cc", ".cxx",  # C/C++
            ".cs",  # C#
            ".rb",  # Ruby
            ".php",  # PHP
            ".swift",  # Swift
            ".kt", ".kts",  # Kotlin
            ".scala",  # Scala
            ".vue",  # Vue
            ".svelte",  # Svelte
        }
        
        # Cache of file hashes for change detection
        self._hash_cache: Dict[str, str] = {}
        
        # Compiled ignore patterns
        self._compiled_ignores: List[str] = []
        self._compile_ignore_patterns()
    
    def _compile_ignore_patterns(self) -> None:
        """Pre-compile ignore patterns for performance."""
        self._compiled_ignores = list(self.ignore_patterns)
    
    def _should_ignore(self, relative_path: str) -> bool:
        """Check if a path should be ignored."""
        # Normalize path separators
        normalized = relative_path.replace("\\", "/")
        
        for pattern in self._compiled_ignores:
            # Handle directory patterns
            if pattern.endswith("/"):
                if normalized.startswith(pattern) or f"/{pattern}" in normalized:
                    return True
            # Handle glob patterns
            elif fnmatch.fnmatch(normalized, pattern):
                return True
            # Handle path segments
            elif any(fnmatch.fnmatch(segment, pattern) for segment in normalized.split("/")):
                return True
        
        return False
    
    def _compute_hash(self, content: str) -> str:
        """Compute SHA-256 hash of canonicalized text content."""
        canon = self._canonicalize_text(content)
        return hashlib.sha256(canon.encode("utf-8", errors="surrogateescape")).hexdigest()

    def _canonicalize_text(self, content: str) -> str:
        """
        Canonicalize text for stable hashing.

        Decisions (explicit):
        - BOM: stripped if present
        - Unicode normalization: NFC
        - Line endings: normalized to \n
        - Trailing whitespace: stripped per line
        """
        if content is None:
            return ""
        # Strip BOM
        if content.startswith("\ufeff"):
            content = content.lstrip("\ufeff")
        # Normalize unicode
        canon = unicodedata.normalize("NFC", content)
        # Normalize line endings to \n
        canon = canon.replace("\r\n", "\n").replace("\r", "\n")
        # Strip trailing whitespace per line
        canon = "\n".join([line.rstrip(" \t") for line in canon.split("\n")])
        return canon

    def _read_file_bytes(self, filepath: str) -> Optional[bytes]:
        try:
            with open(filepath, "rb") as f:
                return f.read()
        except Exception:
            return None

    def _decode_text(self, data: bytes) -> str:
        """
        Decode UTF-8 without replacement.
        Falls back to surrogateescape to preserve raw bytes deterministically.
        """
        try:
            return data.decode("utf-8", errors="strict")
        except UnicodeDecodeError:
            return data.decode("utf-8", errors="surrogateescape")

    def get_file_hash(self, relative_path: str) -> str:
        """Get current content hash for a file path (relative to root)."""
        filepath = os.path.join(self.root, relative_path)
        if not os.path.exists(filepath):
            return ""
        try:
            data = self._read_file_bytes(filepath)
            if data is None:
                return ""
            content = self._decode_text(data)
            return self._compute_hash(content)
        except Exception:
            return ""

    def get_file_stat(self, relative_path: str) -> Optional[Dict[str, int]]:
        """Get file mtime/size for snapshot validation."""
        filepath = os.path.join(self.root, relative_path)
        try:
            st = os.stat(filepath)
            return {"mtime_ns": int(st.st_mtime_ns), "size": int(st.st_size)}
        except Exception:
            return None

    def read_lines(self, file_path: str, start_line: int, end_line: int) -> str:
        """Read lines from a file path (relative or absolute)."""
        try:
            # Allow absolute paths
            filepath = file_path if os.path.isabs(file_path) else os.path.join(self.root, file_path)
            data = self._read_file_bytes(filepath)
            if data is None:
                return ""
            content = self._decode_text(data)
            # Normalize line endings for consistency
            content = content.replace("\r\n", "\n").replace("\r", "\n")
            lines = content.split("\n")
            start_idx = max(1, start_line) - 1
            end_idx = min(len(lines), end_line)
            return "\n".join(lines[start_idx:end_idx])
        except Exception:
            return ""
    
    def walk(self) -> Iterator[WalkedFile]:
        """
        Walk the repository and yield discovered files.
        
        Yields:
            WalkedFile instances for each relevant file
        """
        logger.info(f"Walking repository: {self.root}")
        files_found = 0
        files_skipped = 0
        
        for dirpath, dirnames, filenames in os.walk(self.root):
            # Filter out ignored directories in-place (optimization)
            rel_dir = os.path.relpath(dirpath, self.root)
            if rel_dir != ".":
                dirnames[:] = [
                    d for d in dirnames
                    if not self._should_ignore(f"{rel_dir}/{d}/")
                ]
            else:
                dirnames[:] = [
                    d for d in dirnames
                    if not self._should_ignore(f"{d}/")
                ]
            
            for filename in filenames:
                filepath = os.path.join(dirpath, filename)
                relative_path = os.path.relpath(filepath, self.root)
                
                # Check ignore patterns
                if self._should_ignore(relative_path):
                    files_skipped += 1
                    continue
                
                # Check extension
                ext = Path(filename).suffix.lower()
                if ext not in self.extensions:
                    files_skipped += 1
                    continue
                
                # Check file size
                try:
                    size = os.path.getsize(filepath)
                    if size > self.max_file_size:
                        logger.debug(f"Skipping large file: {relative_path} ({size} bytes)")
                        files_skipped += 1
                        continue
                except OSError:
                    continue
                
                # Read file content
                try:
                    data = self._read_file_bytes(filepath)
                    if data is None:
                        raise IOError("read failed")
                    content = self._decode_text(data)
                except Exception as e:
                    logger.warning(f"Failed to read {relative_path}: {e}")
                    continue
                
                content_hash = self._compute_hash(content)
                
                files_found += 1
                yield WalkedFile(
                    path=filepath,
                    relative_path=relative_path.replace("\\", "/"),
                    content=content,
                    content_hash=content_hash,
                    size_bytes=size,
                )
        
        logger.info(f"Walk complete: {files_found} files found, {files_skipped} skipped")
    
    def walk_changed(self, previous_hashes: Dict[str, str]) -> Iterator[WalkedFile]:
        """
        Walk only files that have changed since last walk.
        
        Args:
            previous_hashes: Map of relative_path -> content_hash from last walk
            
        Yields:
            WalkedFile instances for changed files only
        """
        for walked in self.walk():
            old_hash = previous_hashes.get(walked.relative_path)
            if old_hash != walked.content_hash:
                yield walked
    
    def get_file(self, relative_path: str) -> Optional[WalkedFile]:
        """
        Get a specific file by relative path.
        
        Args:
            relative_path: Path relative to repository root
            
        Returns:
            WalkedFile if found and valid, None otherwise
        """
        filepath = os.path.join(self.root, relative_path)
        
        if not os.path.exists(filepath):
            return None
        
        try:
            size = os.path.getsize(filepath)
            data = self._read_file_bytes(filepath)
            if data is None:
                return None
            content = self._decode_text(data)
            
            return WalkedFile(
                path=filepath,
                relative_path=relative_path.replace("\\", "/"),
                content=content,
                content_hash=self._compute_hash(content),
                size_bytes=size,
            )
        except Exception as e:
            logger.warning(f"Failed to get file {relative_path}: {e}")
            return None
    
    def get_all_hashes(self) -> Dict[str, str]:
        """
        Get current hashes for all files (for change detection).
        
        Returns:
            Map of relative_path -> content_hash
        """
        hashes = {}
        for walked in self.walk():
            hashes[walked.relative_path] = walked.content_hash
        return hashes
