"""
File Summarizer - Generate concise summaries for individual files.

Target: 5-8 lines per file
Contents:
- Responsibility (one line)
- Public API (exported symbols)
- Key dependencies
- Side effects
"""

from __future__ import annotations

import hashlib
import logging
import re
from typing import List, Optional

from ..core.types import FileSummary, SemanticChunk, SymbolType
from ..ingestion import WalkedFile, ChunkExtractor


logger = logging.getLogger("code_intel.summaries.file")


class FileSummarizer:
    """
    Generate summaries for individual files.
    
    Summaries are deterministic (no LLM) for consistency and speed.
    They extract structural information to provide cheap context.
    """
    
    def __init__(self, max_api_items: int = 8, max_deps: int = 6):
        """
        Initialize file summarizer.
        
        Args:
            max_api_items: Maximum public API items to include
            max_deps: Maximum dependencies to include
        """
        self.max_api_items = max_api_items
        self.max_deps = max_deps
        self.extractor = ChunkExtractor()
    
    def summarize(self, file: WalkedFile) -> FileSummary:
        """
        Generate summary for a file.
        
        Args:
            file: WalkedFile to summarize
            
        Returns:
            FileSummary object
        """
        # Extract chunks for analysis
        chunks = self.extractor.extract(file)
        
        # Determine responsibility
        responsibility = self._infer_responsibility(file, chunks)
        
        # Extract public API
        public_api = self._extract_public_api(chunks)
        
        # Extract dependencies
        dependencies = self._extract_dependencies(chunks)
        
        # Detect side effects
        side_effects = self._detect_side_effects(file.content, chunks)
        
        return FileSummary(
            file_path=file.relative_path,
            language=file.language or "",
            responsibility=responsibility,
            public_api=public_api[:self.max_api_items],
            dependencies=dependencies[:self.max_deps],
            side_effects=side_effects,
            content_hash=file.content_hash,
        )
    
    def summarize_from_chunks(
        self,
        file_path: str,
        language: str,
        content: str,
        content_hash: str,
        chunks: List[SemanticChunk],
    ) -> FileSummary:
        """
        Generate summary from pre-extracted chunks.
        
        Args:
            file_path: Relative file path
            language: Language identifier
            content: File content
            content_hash: Hash of content
            chunks: Pre-extracted chunks
            
        Returns:
            FileSummary object
        """
        # Create a minimal file object
        file = WalkedFile(
            path=file_path,
            relative_path=file_path,
            content=content,
            content_hash=content_hash,
            size_bytes=len(content),
            language=language,
        )
        
        responsibility = self._infer_responsibility(file, chunks)
        public_api = self._extract_public_api(chunks)
        dependencies = self._extract_dependencies(chunks)
        side_effects = self._detect_side_effects(content, chunks)
        
        return FileSummary(
            file_path=file_path,
            language=language,
            responsibility=responsibility,
            public_api=public_api[:self.max_api_items],
            dependencies=dependencies[:self.max_deps],
            side_effects=side_effects,
            content_hash=content_hash,
        )
    
    def _infer_responsibility(
        self,
        file: WalkedFile,
        chunks: List[SemanticChunk],
    ) -> str:
        """Infer the file's main responsibility."""
        path = file.relative_path.lower()
        name = path.split("/")[-1].rsplit(".", 1)[0]
        
        # Check for common patterns in path
        if "test" in path or name.startswith("test_") or name.endswith("_test"):
            return f"Tests for {name.replace('test_', '').replace('_test', '')}"
        
        if "config" in name or name in ("settings", "constants"):
            return "Configuration and settings"
        
        if "utils" in name or "helpers" in name:
            return "Utility functions"
        
        if "types" in name or "interfaces" in name:
            return "Type definitions"
        
        if "index" in name or name == "__init__":
            return "Module entry point and exports"
        
        if "main" in name or "app" in name:
            return "Application entry point"
        
        if "router" in name or "routes" in name:
            return "Route definitions"
        
        if "model" in name:
            return "Data model definitions"
        
        if "service" in name:
            return "Business logic service"
        
        if "controller" in name:
            return "Request handling controller"
        
        if "middleware" in name:
            return "Request middleware"
        
        # Infer from contents
        if chunks:
            # Check for class-heavy files
            classes = [c for c in chunks if c.symbol_type == SymbolType.CLASS]
            if len(classes) == 1:
                return f"Defines {classes[0].symbol_name} class"
            elif len(classes) > 1:
                return f"Defines {len(classes)} related classes"
            
            # Check for function-heavy files
            functions = [c for c in chunks if c.symbol_type == SymbolType.FUNCTION]
            if functions:
                # Look at function names for hints
                func_names = [f.symbol_name for f in functions]
                if all("handle" in n.lower() for n in func_names):
                    return "Event/request handlers"
                if all("parse" in n.lower() for n in func_names):
                    return "Parsing utilities"
                if all("format" in n.lower() for n in func_names):
                    return "Formatting utilities"
        
        # Default: use docstring if present
        if chunks and chunks[0].metadata.docstring:
            doc = chunks[0].metadata.docstring
            first_line = doc.split("\n")[0].strip()
            if len(first_line) < 100:
                return first_line
        
        return f"Implementation for {name}"
    
    def _extract_public_api(self, chunks: List[SemanticChunk]) -> List[str]:
        """Extract public API symbols."""
        public = []
        
        for chunk in chunks:
            if not chunk.metadata.is_public:
                continue
            
            # Format based on type
            if chunk.symbol_type in (SymbolType.FUNCTION, SymbolType.METHOD):
                # Include signature for functions
                if chunk.metadata.signature:
                    sig = chunk.metadata.signature
                    # Truncate long signatures
                    if len(sig) > 60:
                        sig = sig[:57] + "..."
                    public.append(sig)
                else:
                    public.append(f"{chunk.symbol_name}()")
            
            elif chunk.symbol_type == SymbolType.CLASS:
                public.append(f"class {chunk.symbol_name}")
            
            elif chunk.symbol_type == SymbolType.INTERFACE:
                public.append(f"interface {chunk.symbol_name}")
            
            elif chunk.symbol_type == SymbolType.TYPE_ALIAS:
                public.append(f"type {chunk.symbol_name}")
            
            elif chunk.symbol_type in (SymbolType.CONSTANT, SymbolType.VARIABLE):
                public.append(chunk.symbol_name)
        
        return public
    
    def _extract_dependencies(self, chunks: List[SemanticChunk]) -> List[str]:
        """Extract key dependencies."""
        all_imports = set()
        
        for chunk in chunks:
            all_imports.update(chunk.metadata.imports_used)
        
        # Deduplicate and sort by "importance"
        deps = []
        
        # Prioritize non-standard library imports
        for imp in sorted(all_imports):
            # Skip internal/relative imports
            if imp.startswith(".") or imp.startswith("_"):
                continue
            deps.append(imp)
        
        return deps
    
    def _detect_side_effects(
        self,
        content: str,
        chunks: List[SemanticChunk],
    ) -> List[str]:
        """Detect potential side effects."""
        effects = []
        
        # File I/O
        if re.search(r'\b(open|write|read|unlink|mkdir)\s*\(', content):
            effects.append("File I/O")
        
        # Network
        if re.search(r'\b(fetch|request|axios|http|socket)\b', content, re.I):
            effects.append("Network requests")
        
        # Database
        if re.search(r'\b(query|execute|commit|transaction|cursor)\b', content, re.I):
            effects.append("Database operations")
        
        # Global state
        if re.search(r'\bglobal\s+\w+', content):
            effects.append("Modifies global state")
        
        # Environment
        if re.search(r'\b(environ|env|getenv|setenv)\b', content, re.I):
            effects.append("Environment access")
        
        # Process/system
        if re.search(r'\b(subprocess|system|exec|spawn|fork)\b', content, re.I):
            effects.append("Process execution")
        
        return effects


def summarize_file(file: WalkedFile) -> FileSummary:
    """Convenience function to summarize a file."""
    summarizer = FileSummarizer()
    return summarizer.summarize(file)
