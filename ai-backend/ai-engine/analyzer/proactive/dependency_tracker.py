"""
Dependency Tracker for Multi-File Analysis

This module tracks import/export relationships between files to:
1. Determine which files need re-analysis when a file changes
2. Build context for cross-file AI analysis
3. Optimize incremental analysis by understanding file relationships

Supports: JavaScript/TypeScript, Python, and other common languages.
"""

from __future__ import annotations

import hashlib
import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Dict, List, Optional, Set, Tuple

from .types import FileDependency, FileContext


# ============================================================================
# Import Pattern Matchers by Language
# ============================================================================

# JavaScript/TypeScript import patterns
JS_IMPORT_PATTERNS = [
    # ES6 imports: import x from 'y', import {x} from 'y', import * as x from 'y'
    re.compile(r'''import\s+(?:[\w\s{},*]+\s+from\s+)?['"]([@\w./-]+)['"]''', re.MULTILINE),
    # Dynamic imports: import('module')
    re.compile(r'''import\s*\(\s*['"]([@\w./-]+)['"]\s*\)''', re.MULTILINE),
    # require: const x = require('y')
    re.compile(r'''require\s*\(\s*['"]([@\w./-]+)['"]\s*\)''', re.MULTILINE),
    # export from: export { x } from 'y'
    re.compile(r'''export\s+(?:[\w\s{},*]+\s+from\s+)['"]([@\w./-]+)['"]''', re.MULTILINE),
]

# Python import patterns
PY_IMPORT_PATTERNS = [
    # from x import y, from x.y import z
    re.compile(r'''from\s+([\w.]+)\s+import''', re.MULTILINE),
    # import x, import x.y
    re.compile(r'''^\s*import\s+([\w.]+)''', re.MULTILINE),
]

# CSS/SCSS import patterns
CSS_IMPORT_PATTERNS = [
    re.compile(r'''@import\s+['"]([\w./-]+)['"]''', re.MULTILINE),
    re.compile(r'''@use\s+['"]([\w./-]+)['"]''', re.MULTILINE),
]

# Language to patterns mapping
IMPORT_PATTERNS: Dict[str, List[re.Pattern]] = {
    "javascript": JS_IMPORT_PATTERNS,
    "typescript": JS_IMPORT_PATTERNS,
    "javascriptreact": JS_IMPORT_PATTERNS,
    "typescriptreact": JS_IMPORT_PATTERNS,
    "jsx": JS_IMPORT_PATTERNS,
    "tsx": JS_IMPORT_PATTERNS,
    "python": PY_IMPORT_PATTERNS,
    "css": CSS_IMPORT_PATTERNS,
    "scss": CSS_IMPORT_PATTERNS,
    "sass": CSS_IMPORT_PATTERNS,
}


@dataclass
class DependencyNode:
    """A node in the dependency graph representing a file."""
    path: str
    content_hash: str
    language: str
    # Files this file imports
    imports: Set[str] = field(default_factory=set)
    # Files that import this file (reverse dependencies)
    imported_by: Set[str] = field(default_factory=set)
    # Raw import strings (before resolution)
    raw_imports: List[str] = field(default_factory=list)


class DependencyTracker:
    """
    Tracks dependencies between files in a workspace.
    
    Provides:
    - Import extraction for multiple languages
    - Dependency graph building
    - Impact analysis (what files are affected by a change)
    - Smart batching for analysis
    """
    
    def __init__(self):
        # path -> DependencyNode
        self._nodes: Dict[str, DependencyNode] = {}
        # path -> content_hash (for change detection)
        self._hashes: Dict[str, str] = {}
        # Workspace root for path resolution
        self._workspace_root: Optional[str] = None
        
    def set_workspace_root(self, root: str):
        """Set the workspace root for path resolution."""
        self._workspace_root = root
    
    def update_file(self, file: FileContext) -> Set[str]:
        """
        Update the dependency graph for a file.
        
        Returns set of files that might need re-analysis due to this change.
        """
        old_hash = self._hashes.get(file.path)
        
        # Check if file actually changed
        if old_hash == file.content_hash:
            return set()
        
        self._hashes[file.path] = file.content_hash
        
        # Extract imports
        raw_imports = self._extract_imports(file.content, file.language)
        resolved_imports = self._resolve_imports(raw_imports, file.path, file.language)
        
        # Get old node to compare
        old_node = self._nodes.get(file.path)
        old_imports = old_node.imports if old_node else set()
        
        # Update node
        node = DependencyNode(
            path=file.path,
            content_hash=file.content_hash,
            language=file.language,
            imports=resolved_imports,
            raw_imports=raw_imports,
        )
        self._nodes[file.path] = node
        
        # Update reverse dependencies
        # Remove from old imports
        for old_import in old_imports:
            if old_import in self._nodes:
                self._nodes[old_import].imported_by.discard(file.path)
        
        # Add to new imports
        for new_import in resolved_imports:
            if new_import in self._nodes:
                self._nodes[new_import].imported_by.add(file.path)
            else:
                # Create placeholder node for unresolved import
                self._nodes[new_import] = DependencyNode(
                    path=new_import,
                    content_hash="",
                    language=file.language,
                    imported_by={file.path},
                )
        
        # Calculate affected files (files that import this file)
        affected = self._get_dependents(file.path)
        affected.add(file.path)  # Include the file itself
        
        return affected
    
    def remove_file(self, path: str) -> Set[str]:
        """
        Remove a file from the dependency graph.
        
        Returns set of files that were importing the removed file.
        """
        node = self._nodes.pop(path, None)
        self._hashes.pop(path, None)
        
        if not node:
            return set()
        
        # Remove from imported files' imported_by sets
        for imported in node.imports:
            if imported in self._nodes:
                self._nodes[imported].imported_by.discard(path)
        
        return node.imported_by.copy()
    
    def get_dependencies(self, path: str) -> List[FileDependency]:
        """Get all dependencies for a file."""
        node = self._nodes.get(path)
        if not node:
            return []
        
        deps = []
        for i, target in enumerate(node.imports):
            raw_import = node.raw_imports[i] if i < len(node.raw_imports) else target
            deps.append(FileDependency(
                source_path=path,
                target_path=target,
                import_name=raw_import,
                is_resolved=target in self._nodes and self._nodes[target].content_hash != "",
            ))
        
        return deps
    
    def get_dependents(self, path: str) -> Set[str]:
        """Get all files that depend on a given file (directly or indirectly)."""
        return self._get_dependents(path)
    
    def get_related_files(self, path: str, max_depth: int = 2) -> Set[str]:
        """
        Get files related to a given file (imports and dependents).
        
        Useful for building context for AI analysis.
        """
        related = set()
        node = self._nodes.get(path)
        
        if not node:
            return related
        
        # BFS for imports
        queue = [(imp, 1) for imp in node.imports]
        while queue:
            current, depth = queue.pop(0)
            if current in related or depth > max_depth:
                continue
            related.add(current)
            if current in self._nodes and depth < max_depth:
                for imp in self._nodes[current].imports:
                    queue.append((imp, depth + 1))
        
        # Add direct dependents
        related.update(node.imported_by)
        
        return related
    
    def get_analysis_order(self, files: Set[str]) -> List[str]:
        """
        Determine optimal order to analyze files (dependencies first).
        
        Uses topological sort to ensure dependencies are analyzed before dependents.
        """
        # Build in-degree map for selected files only
        in_degree = {f: 0 for f in files}
        
        for f in files:
            node = self._nodes.get(f)
            if node:
                for imp in node.imports:
                    if imp in files:
                        in_degree[f] += 1
        
        # Kahn's algorithm for topological sort
        result = []
        queue = [f for f, degree in in_degree.items() if degree == 0]
        
        while queue:
            current = queue.pop(0)
            result.append(current)
            
            # Decrease in-degree for dependents
            for f, node in self._nodes.items():
                if f in files and current in node.imports:
                    in_degree[f] -= 1
                    if in_degree[f] == 0:
                        queue.append(f)
        
        # Handle cycles - add remaining files
        remaining = [f for f in files if f not in result]
        result.extend(remaining)
        
        return result
    
    def get_all_dependencies(self) -> List[FileDependency]:
        """Get all dependencies in the workspace."""
        deps = []
        for path, node in self._nodes.items():
            for i, target in enumerate(node.imports):
                raw_import = node.raw_imports[i] if i < len(node.raw_imports) else target
                deps.append(FileDependency(
                    source_path=path,
                    target_path=target,
                    import_name=raw_import,
                    is_resolved=target in self._nodes and self._nodes[target].content_hash != "",
                ))
        return deps
    
    def _extract_imports(self, content: str, language: str) -> List[str]:
        """Extract import statements from file content."""
        patterns = IMPORT_PATTERNS.get(language.lower(), [])
        imports = []
        
        for pattern in patterns:
            matches = pattern.findall(content)
            imports.extend(matches)
        
        # Deduplicate while preserving order
        seen = set()
        result = []
        for imp in imports:
            if imp not in seen:
                seen.add(imp)
                result.append(imp)
        
        return result
    
    def _resolve_imports(self, raw_imports: List[str], source_path: str, language: str) -> Set[str]:
        """
        Resolve import paths to actual file paths.
        
        This is a simplified resolver - real resolution would need
        to check file existence and handle module resolution algorithms.
        """
        resolved = set()
        source_dir = str(Path(source_path).parent)
        
        for raw_import in raw_imports:
            # Skip external packages (npm packages, pip packages, etc.)
            if self._is_external_import(raw_import, language):
                continue
            
            # Resolve relative paths
            resolved_path = self._resolve_path(raw_import, source_dir, language)
            if resolved_path:
                resolved.add(resolved_path)
        
        return resolved
    
    def _is_external_import(self, import_path: str, language: str) -> bool:
        """Check if an import is for an external package."""
        if language.lower() in ("python",):
            # Python: standard library and pip packages don't start with .
            # This is a heuristic - real detection would need stdlib list
            if not import_path.startswith("."):
                # Check if it looks like a local module path
                if "/" not in import_path and import_path not in self._nodes:
                    return True
        else:
            # JS/TS: external packages don't start with . or /
            if not import_path.startswith((".", "/", "@/")):
                return True
            # Scoped packages like @org/package
            if import_path.startswith("@") and "/" in import_path:
                parts = import_path.split("/")
                if len(parts) >= 2 and not parts[1].startswith("."):
                    return True
        
        return False
    
    def _resolve_path(self, import_path: str, source_dir: str, language: str) -> Optional[str]:
        """Resolve an import path to a file path."""
        if language.lower() == "python":
            return self._resolve_python_import(import_path, source_dir)
        else:
            return self._resolve_js_import(import_path, source_dir)
    
    def _resolve_python_import(self, import_path: str, source_dir: str) -> Optional[str]:
        """Resolve a Python import to a file path."""
        # Convert dots to path separators
        if import_path.startswith("."):
            # Relative import
            dots = len(import_path) - len(import_path.lstrip("."))
            module_path = import_path[dots:].replace(".", "/")
            
            # Go up directories based on number of dots
            base = Path(source_dir)
            for _ in range(dots - 1):
                base = base.parent
            
            resolved = str(base / module_path)
        else:
            # Absolute import - try from workspace root
            module_path = import_path.replace(".", "/")
            if self._workspace_root:
                resolved = str(Path(self._workspace_root) / module_path)
            else:
                resolved = module_path
        
        # Try with .py extension
        return f"{resolved}.py"
    
    def _resolve_js_import(self, import_path: str, source_dir: str) -> Optional[str]:
        """Resolve a JavaScript/TypeScript import to a file path."""
        if import_path.startswith("@/"):
            # Alias imports (common pattern: @/ -> src/)
            if self._workspace_root:
                import_path = import_path.replace("@/", f"{self._workspace_root}/src/")
            else:
                import_path = import_path.replace("@/", "src/")
        
        if import_path.startswith("."):
            # Relative import
            resolved = str((Path(source_dir) / import_path).resolve())
        elif import_path.startswith("/"):
            # Absolute from workspace root
            if self._workspace_root:
                resolved = str(Path(self._workspace_root) / import_path[1:])
            else:
                resolved = import_path
        else:
            # Non-relative, non-external (already filtered)
            resolved = import_path
        
        # Normalize path
        resolved = resolved.replace("\\", "/")
        
        # Don't add extension - could be .js, .jsx, .ts, .tsx, or index file
        # The caller should handle extension resolution
        return resolved
    
    def _get_dependents(self, path: str, visited: Optional[Set[str]] = None) -> Set[str]:
        """Get all files that depend on the given file (recursively)."""
        if visited is None:
            visited = set()
        
        if path in visited:
            return set()
        visited.add(path)
        
        node = self._nodes.get(path)
        if not node:
            return set()
        
        dependents = node.imported_by.copy()
        
        # Recursively get dependents of dependents
        for dep in node.imported_by:
            dependents.update(self._get_dependents(dep, visited))
        
        return dependents
    
    def clear(self):
        """Clear all tracked dependencies."""
        self._nodes.clear()
        self._hashes.clear()
    
    def stats(self) -> Dict[str, Any]:
        """Get statistics about the dependency graph."""
        total_imports = sum(len(node.imports) for node in self._nodes.values())
        return {
            "files": len(self._nodes),
            "total_imports": total_imports,
            "avg_imports_per_file": total_imports / len(self._nodes) if self._nodes else 0,
        }


# Singleton instance for use across the application
_workspace_tracker = DependencyTracker()


def get_dependency_tracker() -> DependencyTracker:
    """Get the global dependency tracker instance."""
    return _workspace_tracker
