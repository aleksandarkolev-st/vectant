"""
Exploration Tools - Core tool implementations.

These tools allow the AI to request additional context during conversation.
Each tool is designed to return focused, relevant information.
"""

from __future__ import annotations

import logging
import os
from dataclasses import dataclass, field
from pathlib import Path
from typing import Dict, List, Optional, Any, Union

from ..core.types import SemanticChunk, SymbolNode, EdgeType


logger = logging.getLogger("code_intel.tools")


@dataclass
class ToolError:
    """Error from tool execution."""
    code: str
    message: str
    details: Optional[Dict[str, Any]] = None


@dataclass
class ToolResult:
    """Result from tool execution."""
    
    success: bool
    data: Any = None
    error: Optional[ToolError] = None
    
    # Token cost estimate
    estimated_tokens: int = 0
    
    # What was accessed
    files_accessed: List[str] = field(default_factory=list)
    symbols_accessed: List[str] = field(default_factory=list)
    
    def to_context(self) -> str:
        """Format result for inclusion in context."""
        if not self.success:
            return f"Error: {self.error.message if self.error else 'Unknown error'}"
        return str(self.data)


class ExplorationTools:
    """
    Tools for AI-driven code exploration.
    
    Provides focused access to codebase information.
    """
    
    def __init__(
        self,
        workspace_root: str,
        vector_index=None,  # VectorIndex
        structural_index=None,  # StructuralIndex
        file_reader=None,  # FileWalker or similar
    ):
        self.workspace_root = Path(workspace_root)
        self.vector_index = vector_index
        self.structural_index = structural_index
        self.file_reader = file_reader
        
        # Limits to prevent excessive context
        self.max_files_per_list = 50
        self.max_lines_per_read = 200
        self.max_symbols_per_search = 20
        self.max_callers = 15
        self.max_callees = 15
    
    def list_files(
        self,
        directory: str = ".",
        pattern: Optional[str] = None,
        recursive: bool = False,
    ) -> ToolResult:
        """
        List files in a directory.
        
        Args:
            directory: Directory path (relative to workspace)
            pattern: Glob pattern to filter (e.g., "*.py")
            recursive: Whether to list recursively
            
        Returns:
            ToolResult with list of file paths
        """
        try:
            dir_path = self.workspace_root / directory
            
            if not dir_path.exists():
                return ToolResult(
                    success=False,
                    error=ToolError(
                        code="DIR_NOT_FOUND",
                        message=f"Directory not found: {directory}",
                    ),
                )
            
            if not dir_path.is_dir():
                return ToolResult(
                    success=False,
                    error=ToolError(
                        code="NOT_A_DIR",
                        message=f"Not a directory: {directory}",
                    ),
                )
            
            # List files
            files = []
            
            if recursive:
                glob_pattern = pattern or "*"
                for path in dir_path.rglob(glob_pattern):
                    if path.is_file() and not self._is_ignored(path):
                        rel_path = path.relative_to(self.workspace_root)
                        files.append(str(rel_path))
            else:
                for path in dir_path.iterdir():
                    if self._is_ignored(path):
                        continue
                    if pattern and not path.match(pattern):
                        continue
                    
                    rel_path = path.relative_to(self.workspace_root)
                    if path.is_dir():
                        files.append(str(rel_path) + "/")
                    else:
                        files.append(str(rel_path))
            
            # Sort and limit
            files.sort()
            truncated = len(files) > self.max_files_per_list
            files = files[:self.max_files_per_list]
            
            # Format result
            result_text = "\n".join(files)
            if truncated:
                result_text += f"\n... (truncated, {self.max_files_per_list} shown)"
            
            return ToolResult(
                success=True,
                data={"files": files, "truncated": truncated},
                estimated_tokens=len(result_text) // 4,
            )
            
        except Exception as e:
            logger.error(f"Error listing files: {e}")
            return ToolResult(
                success=False,
                error=ToolError(
                    code="LIST_ERROR",
                    message=str(e),
                ),
            )
    
    def open_file(
        self,
        path: str,
        start_line: Optional[int] = None,
        end_line: Optional[int] = None,
    ) -> ToolResult:
        """
        Read file contents.
        
        Args:
            path: File path (relative to workspace)
            start_line: Starting line (1-indexed)
            end_line: Ending line (inclusive)
            
        Returns:
            ToolResult with file contents
        """
        try:
            file_path = self.workspace_root / path
            
            if not file_path.exists():
                return ToolResult(
                    success=False,
                    error=ToolError(
                        code="FILE_NOT_FOUND",
                        message=f"File not found: {path}",
                    ),
                )
            
            if not file_path.is_file():
                return ToolResult(
                    success=False,
                    error=ToolError(
                        code="NOT_A_FILE",
                        message=f"Not a file: {path}",
                    ),
                )
            
            # Read file
            with open(file_path, "r", encoding="utf-8", errors="replace") as f:
                lines = f.readlines()
            
            total_lines = len(lines)
            
            # Apply line range
            if start_line is not None:
                start_idx = max(0, start_line - 1)
            else:
                start_idx = 0
            
            if end_line is not None:
                end_idx = min(total_lines, end_line)
            else:
                end_idx = min(start_idx + self.max_lines_per_read, total_lines)
            
            # Enforce max lines
            if end_idx - start_idx > self.max_lines_per_read:
                end_idx = start_idx + self.max_lines_per_read
            
            selected_lines = lines[start_idx:end_idx]
            content = "".join(selected_lines)
            
            # Detect language
            ext = file_path.suffix.lower()
            lang_map = {
                ".py": "python",
                ".js": "javascript",
                ".ts": "typescript",
                ".tsx": "typescript",
                ".jsx": "javascript",
                ".java": "java",
                ".go": "go",
                ".rs": "rust",
                ".c": "c",
                ".cpp": "cpp",
                ".h": "c",
            }
            language = lang_map.get(ext, "")
            
            return ToolResult(
                success=True,
                data={
                    "path": path,
                    "content": content,
                    "language": language,
                    "start_line": start_idx + 1,
                    "end_line": end_idx,
                    "total_lines": total_lines,
                },
                estimated_tokens=len(content) // 4,
                files_accessed=[path],
            )
            
        except Exception as e:
            logger.error(f"Error reading file: {e}")
            return ToolResult(
                success=False,
                error=ToolError(
                    code="READ_ERROR",
                    message=str(e),
                ),
            )
    
    def open_symbol(
        self,
        name: str,
        file_hint: Optional[str] = None,
    ) -> ToolResult:
        """
        Get definition of a symbol.
        
        Args:
            name: Symbol name to look up
            file_hint: Optional file to search in first
            
        Returns:
            ToolResult with symbol definition
        """
        if not self.structural_index:
            return ToolResult(
                success=False,
                error=ToolError(
                    code="NO_INDEX",
                    message="Structural index not available",
                ),
            )
        
        try:
            # Look up symbol
            symbol_graph = getattr(self.structural_index, 'symbol_graph', None)
            if not symbol_graph:
                return ToolResult(
                    success=False,
                    error=ToolError(
                        code="NO_GRAPH",
                        message="Symbol graph not available",
                    ),
                )
            
            # Try exact match first
            node = symbol_graph.get_node(name)
            
            if not node:
                # Try case-insensitive search
                for node_name in symbol_graph.nodes:
                    if node_name.lower() == name.lower():
                        node = symbol_graph.get_node(node_name)
                        break
            
            if not node:
                return ToolResult(
                    success=False,
                    error=ToolError(
                        code="SYMBOL_NOT_FOUND",
                        message=f"Symbol not found: {name}",
                    ),
                )
            
            # Get the code for this symbol
            # Use vector index to get chunk
            if self.vector_index:
                chunks = getattr(self.vector_index, 'chunks', {})
                for chunk_id, chunk in chunks.items():
                    if chunk.symbol_name == node.name:
                        return ToolResult(
                            success=True,
                            data={
                                "name": node.name,
                                "type": node.symbol_type,
                                "file": node.file_path,
                                "signature": chunk.signature,
                                "docstring": chunk.docstring,
                                "code": chunk.code_body,
                            },
                            estimated_tokens=len(chunk.code_body or "") // 4,
                            files_accessed=[node.file_path],
                            symbols_accessed=[node.name],
                        )
            
            # Fallback: return metadata only
            return ToolResult(
                success=True,
                data={
                    "name": node.name,
                    "type": node.symbol_type,
                    "file": node.file_path,
                    "signature": node.signature,
                },
                estimated_tokens=50,
                files_accessed=[node.file_path],
                symbols_accessed=[node.name],
            )
            
        except Exception as e:
            logger.error(f"Error looking up symbol: {e}")
            return ToolResult(
                success=False,
                error=ToolError(
                    code="LOOKUP_ERROR",
                    message=str(e),
                ),
            )
    
    def search_symbol(
        self,
        query: str,
        symbol_type: Optional[str] = None,
        file_pattern: Optional[str] = None,
    ) -> ToolResult:
        """
        Search for symbols by name pattern.
        
        Args:
            query: Search pattern (supports partial match)
            symbol_type: Filter by type (function, class, etc.)
            file_pattern: Filter by file path pattern
            
        Returns:
            ToolResult with matching symbols
        """
        if not self.structural_index:
            return ToolResult(
                success=False,
                error=ToolError(
                    code="NO_INDEX",
                    message="Structural index not available",
                ),
            )
        
        try:
            symbol_graph = getattr(self.structural_index, 'symbol_graph', None)
            if not symbol_graph:
                return ToolResult(
                    success=False,
                    error=ToolError(
                        code="NO_GRAPH",
                        message="Symbol graph not available",
                    ),
                )
            
            query_lower = query.lower()
            matches = []
            
            for node_name, node in symbol_graph.nodes.items():
                # Name match
                if query_lower not in node_name.lower():
                    continue
                
                # Type filter
                if symbol_type and node.symbol_type != symbol_type:
                    continue
                
                # File filter
                if file_pattern and file_pattern not in node.file_path:
                    continue
                
                matches.append({
                    "name": node.name,
                    "type": node.symbol_type,
                    "file": node.file_path,
                    "signature": node.signature,
                })
                
                if len(matches) >= self.max_symbols_per_search:
                    break
            
            return ToolResult(
                success=True,
                data={
                    "query": query,
                    "matches": matches,
                    "count": len(matches),
                },
                estimated_tokens=len(matches) * 30,
            )
            
        except Exception as e:
            logger.error(f"Error searching symbols: {e}")
            return ToolResult(
                success=False,
                error=ToolError(
                    code="SEARCH_ERROR",
                    message=str(e),
                ),
            )
    
    def get_callers(
        self,
        symbol: str,
    ) -> ToolResult:
        """
        Find what calls this symbol.
        
        Args:
            symbol: Symbol name
            
        Returns:
            ToolResult with calling symbols
        """
        return self._get_related_by_edge(
            symbol,
            EdgeType.CALLS,
            direction="incoming",
            max_results=self.max_callers,
        )
    
    def get_callees(
        self,
        symbol: str,
    ) -> ToolResult:
        """
        Find what this symbol calls.
        
        Args:
            symbol: Symbol name
            
        Returns:
            ToolResult with called symbols
        """
        return self._get_related_by_edge(
            symbol,
            EdgeType.CALLS,
            direction="outgoing",
            max_results=self.max_callees,
        )
    
    def get_related(
        self,
        symbol: str,
    ) -> ToolResult:
        """
        Find related symbols (imports, inherits, etc.).
        
        Args:
            symbol: Symbol name
            
        Returns:
            ToolResult with related symbols
        """
        if not self.structural_index:
            return ToolResult(
                success=False,
                error=ToolError(
                    code="NO_INDEX",
                    message="Structural index not available",
                ),
            )
        
        try:
            symbol_graph = getattr(self.structural_index, 'symbol_graph', None)
            if not symbol_graph:
                return ToolResult(
                    success=False,
                    error=ToolError(
                        code="NO_GRAPH",
                        message="Symbol graph not available",
                    ),
                )
            
            related = {
                "imports": [],
                "imported_by": [],
                "inherits": [],
                "inherited_by": [],
                "same_file": [],
            }
            
            # Get node
            node = symbol_graph.get_node(symbol)
            if not node:
                return ToolResult(
                    success=False,
                    error=ToolError(
                        code="SYMBOL_NOT_FOUND",
                        message=f"Symbol not found: {symbol}",
                    ),
                )
            
            # Get edges
            outgoing = symbol_graph.get_edges_from(symbol)
            incoming = symbol_graph.get_edges_to(symbol)
            
            for edge in outgoing:
                if edge.edge_type == EdgeType.IMPORTS:
                    related["imports"].append(edge.target)
                elif edge.edge_type == EdgeType.INHERITS:
                    related["inherits"].append(edge.target)
            
            for edge in incoming:
                if edge.edge_type == EdgeType.IMPORTS:
                    related["imported_by"].append(edge.source)
                elif edge.edge_type == EdgeType.INHERITS:
                    related["inherited_by"].append(edge.source)
            
            # Find symbols in same file
            for node_name, other_node in symbol_graph.nodes.items():
                if other_node.file_path == node.file_path and other_node.name != symbol:
                    related["same_file"].append(other_node.name)
            
            return ToolResult(
                success=True,
                data={
                    "symbol": symbol,
                    "file": node.file_path,
                    "related": related,
                },
                estimated_tokens=100,
                symbols_accessed=[symbol],
            )
            
        except Exception as e:
            logger.error(f"Error getting related symbols: {e}")
            return ToolResult(
                success=False,
                error=ToolError(
                    code="RELATED_ERROR",
                    message=str(e),
                ),
            )
    
    def _get_related_by_edge(
        self,
        symbol: str,
        edge_type: EdgeType,
        direction: str,
        max_results: int,
    ) -> ToolResult:
        """Helper to get related symbols by edge type."""
        if not self.structural_index:
            return ToolResult(
                success=False,
                error=ToolError(
                    code="NO_INDEX",
                    message="Structural index not available",
                ),
            )
        
        try:
            symbol_graph = getattr(self.structural_index, 'symbol_graph', None)
            if not symbol_graph:
                return ToolResult(
                    success=False,
                    error=ToolError(
                        code="NO_GRAPH",
                        message="Symbol graph not available",
                    ),
                )
            
            related = []
            
            if direction == "incoming":
                edges = symbol_graph.get_edges_to(symbol)
                for edge in edges:
                    if edge.edge_type == edge_type:
                        related.append({
                            "name": edge.source,
                            "file": symbol_graph.nodes.get(edge.source, {}).file_path if edge.source in symbol_graph.nodes else None,
                        })
            else:
                edges = symbol_graph.get_edges_from(symbol)
                for edge in edges:
                    if edge.edge_type == edge_type:
                        related.append({
                            "name": edge.target,
                            "file": symbol_graph.nodes.get(edge.target, {}).file_path if edge.target in symbol_graph.nodes else None,
                        })
            
            related = related[:max_results]
            
            return ToolResult(
                success=True,
                data={
                    "symbol": symbol,
                    "edge_type": edge_type.value,
                    "direction": direction,
                    "related": related,
                    "count": len(related),
                },
                estimated_tokens=len(related) * 20,
                symbols_accessed=[symbol],
            )
            
        except Exception as e:
            logger.error(f"Error getting related by edge: {e}")
            return ToolResult(
                success=False,
                error=ToolError(
                    code="EDGE_ERROR",
                    message=str(e),
                ),
            )
    
    def _is_ignored(self, path: Path) -> bool:
        """Check if path should be ignored."""
        ignored = {
            ".git", "__pycache__", "node_modules", ".venv", "venv",
            "dist", "build", ".next", ".cache",
        }
        
        for part in path.parts:
            if part in ignored:
                return True
        
        return False


# Convenience functions
def list_files(tools: ExplorationTools, directory: str = ".", **kwargs) -> ToolResult:
    """List files in a directory."""
    return tools.list_files(directory, **kwargs)


def open_file(tools: ExplorationTools, path: str, **kwargs) -> ToolResult:
    """Open and read a file."""
    return tools.open_file(path, **kwargs)


def open_symbol(tools: ExplorationTools, name: str, **kwargs) -> ToolResult:
    """Get definition of a symbol."""
    return tools.open_symbol(name, **kwargs)


def search_symbol(tools: ExplorationTools, query: str, **kwargs) -> ToolResult:
    """Search for symbols by pattern."""
    return tools.search_symbol(query, **kwargs)


def get_callers(tools: ExplorationTools, symbol: str) -> ToolResult:
    """Find what calls this symbol."""
    return tools.get_callers(symbol)


def get_callees(tools: ExplorationTools, symbol: str) -> ToolResult:
    """Find what this symbol calls."""
    return tools.get_callees(symbol)


def get_related(tools: ExplorationTools, symbol: str) -> ToolResult:
    """Find related symbols."""
    return tools.get_related(symbol)
