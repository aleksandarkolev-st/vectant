"""
Structural Index - Symbol graph for dependency tracking.

This is what vectors cannot do. It stores:
- File → symbols
- Symbol → dependencies
- Import graph
- Call graph (best effort)

This answers "what must also be included" when given a set of candidates.

CRITICAL FIXES IMPLEMENTED:
1. Proper incremental deletion semantics (all chunks + edges for file)
2. Edge confidence tracking (LSP > AST > heuristic)
3. Expansion limits per confidence level
4. Chunks-to-file mapping for efficient reindexing
"""

from __future__ import annotations

import json
import logging
import os
from collections import defaultdict
from dataclasses import dataclass, field
from typing import Dict, FrozenSet, Iterator, List, Optional, Set, Tuple

from ..core.types import (
    ChunkId,
    EdgeType,
    FilePath,
    QualifiedName,
    SemanticChunk,
    SymbolEdge,
    SymbolNode,
    SymbolType,
    EXPANSION_LIMITS,
)


logger = logging.getLogger("code_intel.indexer.structural")


@dataclass
class FileEntry:
    """Index entry for a file."""
    path: FilePath
    content_hash: str
    language: str
    # Symbols defined in this file
    symbols: Set[QualifiedName] = field(default_factory=set)
    # Files this file imports
    imports: Set[FilePath] = field(default_factory=set)
    # Files that import this file
    imported_by: Set[FilePath] = field(default_factory=set)
    # Imported symbol names keyed by resolved file
    import_symbols: Dict[FilePath, Set[str]] = field(default_factory=dict)


class SymbolGraph:
    """
    Graph of symbol relationships.
    
    Nodes are symbols (functions, classes, etc.)
    Edges are relationships (calls, imports, inherits, etc.)
    
    Edge extraction priority (highest confidence first):
    1. LSP references (confidence=1.0)
    2. Parser/AST extraction (confidence=0.9)
    3. Heuristic fallbacks (confidence=0.6)
    """
    
    def __init__(self):
        # Symbol nodes by qualified name
        self._nodes: Dict[QualifiedName, SymbolNode] = {}
        
        # Edges: source -> [(target, edge_type, metadata)]
        self._edges: Dict[QualifiedName, List[SymbolEdge]] = defaultdict(list)
        
        # Reverse edges for fast lookups
        self._reverse_edges: Dict[QualifiedName, List[SymbolEdge]] = defaultdict(list)
        
        # Symbol to chunk mapping
        self._symbol_to_chunk: Dict[QualifiedName, ChunkId] = {}
        
        # Chunk to symbol mapping (for deletion)
        self._chunk_to_symbol: Dict[ChunkId, QualifiedName] = {}

        # Stable symbol ID to chunk mapping
        self._stable_to_chunk: Dict[str, ChunkId] = {}
        self._chunk_to_stable: Dict[ChunkId, str] = {}
        
        # File to symbols mapping (for deletion)
        self._file_to_symbols: Dict[FilePath, Set[QualifiedName]] = defaultdict(set)
        
        # File to edges mapping (for deletion)
        self._file_to_edges: Dict[FilePath, List[SymbolEdge]] = defaultdict(list)

    def to_dict(self) -> Dict:
        return {
            "nodes": [
                {
                    "qualified_name": n.qualified_name,
                    "simple_name": n.simple_name,
                    "symbol_type": n.symbol_type.value,
                    "file_path": n.file_path,
                    "line": n.line,
                    "chunk_id": n.chunk_id,
                    "is_public": n.is_public,
                    "stable_symbol_id": n.stable_symbol_id,
                }
                for n in self._nodes.values()
            ],
            "edges": [
                {
                    "source": e.source,
                    "target": e.target,
                    "edge_type": e.edge_type.value,
                    "file_path": e.file_path,
                    "line": e.line,
                    "confidence": e.confidence,
                    "source_method": e.source_method,
                }
                for edges in self._edges.values()
                for e in edges
            ],
        }

    def load_dict(self, data: Dict) -> None:
        self._nodes.clear()
        self._edges.clear()
        self._reverse_edges.clear()
        self._symbol_to_chunk.clear()
        self._chunk_to_symbol.clear()
        self._stable_to_chunk.clear()
        self._chunk_to_stable.clear()
        self._file_to_symbols.clear()
        self._file_to_edges.clear()

        for n in data.get("nodes", []):
            node = SymbolNode(
                qualified_name=n.get("qualified_name", ""),
                simple_name=n.get("simple_name", ""),
                symbol_type=SymbolType(n.get("symbol_type", SymbolType.UNKNOWN.value)),
                file_path=n.get("file_path", ""),
                line=int(n.get("line", 0) or 0),
                chunk_id=n.get("chunk_id", ""),
                is_public=bool(n.get("is_public", True)),
                stable_symbol_id=n.get("stable_symbol_id", ""),
            )
            if node.qualified_name:
                self.add_node(node, node.chunk_id)

        for e in data.get("edges", []):
            try:
                edge = SymbolEdge(
                    source=e.get("source", ""),
                    target=e.get("target", ""),
                    edge_type=EdgeType(e.get("edge_type", EdgeType.DEPENDS_ON.value)),
                    file_path=e.get("file_path", ""),
                    line=int(e.get("line", 0) or 0),
                    confidence=float(e.get("confidence", 1.0)),
                    source_method=e.get("source_method", "ast"),
                )
                if edge.source and edge.target:
                    self.add_edge(edge)
            except Exception:
                continue
    
    def add_node(self, node: SymbolNode, chunk_id: ChunkId) -> None:
        """Add a symbol node."""
        self._nodes[node.qualified_name] = node
        self._symbol_to_chunk[node.qualified_name] = chunk_id
        self._chunk_to_symbol[chunk_id] = node.qualified_name
        if node.stable_symbol_id:
            self._stable_to_chunk[node.stable_symbol_id] = chunk_id
            self._chunk_to_stable[chunk_id] = node.stable_symbol_id
        self._file_to_symbols[node.file_path].add(node.qualified_name)
    
    def add_edge(self, edge: SymbolEdge) -> None:
        """Add an edge between symbols."""
        self._edges[edge.source].append(edge)
        self._reverse_edges[edge.target].append(edge)
        
        # Track edge by file for deletion
        if edge.file_path:
            self._file_to_edges[edge.file_path].append(edge)

    def get_edges_for_file(self, file_path: FilePath) -> List[SymbolEdge]:
        """Get all edges originating from a file."""
        return list(self._file_to_edges.get(file_path, []))
    
    def get_node(self, name: QualifiedName) -> Optional[SymbolNode]:
        """Get a symbol node by name."""
        return self._nodes.get(name)
    
    def get_chunk_id(self, name: QualifiedName) -> Optional[ChunkId]:
        """Get chunk ID for a symbol."""
        return self._symbol_to_chunk.get(name)

    def get_chunk_id_by_stable_id(self, stable_symbol_id: str) -> Optional[ChunkId]:
        """Get chunk ID for a stable symbol ID."""
        return self._stable_to_chunk.get(stable_symbol_id)
    
    def get_symbol_for_chunk(self, chunk_id: ChunkId) -> Optional[QualifiedName]:
        """Get symbol name for a chunk ID."""
        return self._chunk_to_symbol.get(chunk_id)
    
    def get_outgoing_edges(
        self, name: QualifiedName, edge_types: Optional[Set[EdgeType]] = None
    ) -> List[SymbolEdge]:
        """Get edges going out from a symbol."""
        edges = self._edges.get(name, [])
        if edge_types:
            edges = [e for e in edges if e.edge_type in edge_types]
        return edges
    
    def get_incoming_edges(
        self, name: QualifiedName, edge_types: Optional[Set[EdgeType]] = None
    ) -> List[SymbolEdge]:
        """Get edges coming into a symbol."""
        edges = self._reverse_edges.get(name, [])
        if edge_types:
            edges = [e for e in edges if e.edge_type in edge_types]
        return edges
    
    def get_edges_by_confidence(
        self,
        name: QualifiedName,
        direction: str = "outgoing",
        min_confidence: float = 0.0,
    ) -> List[SymbolEdge]:
        """
        Get edges filtered by confidence level.
        
        Args:
            name: Symbol name
            direction: "outgoing" or "incoming"
            min_confidence: Minimum confidence threshold
            
        Returns:
            Edges meeting the confidence threshold
        """
        if direction == "outgoing":
            edges = self._edges.get(name, [])
        else:
            edges = self._reverse_edges.get(name, [])
        
        return [e for e in edges if e.confidence >= min_confidence]
    
    def get_expansion_limit(self, edge: SymbolEdge) -> int:
        """Get expansion limit for an edge based on its confidence/source."""
        return EXPANSION_LIMITS.get(edge.source_method, {}).get("max_per_source", 5)
    
    def get_max_hops(self, edge: SymbolEdge) -> int:
        """Get max hops for an edge based on its confidence/source."""
        return EXPANSION_LIMITS.get(edge.source_method, {}).get("max_hops", 2)
    
    def get_dependencies(
        self,
        name: QualifiedName,
        max_depth: int = 2,
        edge_types: Optional[Set[EdgeType]] = None,
    ) -> Set[QualifiedName]:
        """
        Get all dependencies of a symbol up to max_depth.
        
        This follows outgoing edges (what this symbol depends on).
        """
        visited = set()
        frontier = {name}
        
        for _ in range(max_depth):
            next_frontier = set()
            for sym in frontier:
                if sym in visited:
                    continue
                visited.add(sym)
                
                for edge in self.get_outgoing_edges(sym, edge_types):
                    if edge.target not in visited:
                        next_frontier.add(edge.target)
            
            frontier = next_frontier
            if not frontier:
                break
        
        visited.discard(name)  # Don't include the source
        return visited
    
    def get_dependents(
        self,
        name: QualifiedName,
        max_depth: int = 2,
        edge_types: Optional[Set[EdgeType]] = None,
    ) -> Set[QualifiedName]:
        """
        Get all dependents of a symbol up to max_depth.
        
        This follows incoming edges (what depends on this symbol).
        """
        visited = set()
        frontier = {name}
        
        for _ in range(max_depth):
            next_frontier = set()
            for sym in frontier:
                if sym in visited:
                    continue
                visited.add(sym)
                
                for edge in self.get_incoming_edges(sym, edge_types):
                    if edge.source not in visited:
                        next_frontier.add(edge.source)
            
            frontier = next_frontier
            if not frontier:
                break
        
        visited.discard(name)
        return visited
    
    def get_callers(self, name: QualifiedName, max_depth: int = 1) -> Set[QualifiedName]:
        """Get symbols that call this symbol."""
        return self.get_dependents(name, max_depth, {EdgeType.CALLS})
    
    def get_callees(self, name: QualifiedName, max_depth: int = 1) -> Set[QualifiedName]:
        """Get symbols that this symbol calls."""
        return self.get_dependencies(name, max_depth, {EdgeType.CALLS})
    
    def get_implementors(self, name: QualifiedName) -> Set[QualifiedName]:
        """Get symbols that implement this interface/trait."""
        return self.get_dependents(name, 1, {EdgeType.IMPLEMENTS})
    
    def remove_symbol(self, name: QualifiedName) -> None:
        """Remove a symbol and its edges."""
        if name in self._nodes:
            node = self._nodes[name]
            self._file_to_symbols[node.file_path].discard(name)
            del self._nodes[name]
        
        if name in self._symbol_to_chunk:
            chunk_id = self._symbol_to_chunk[name]
            del self._symbol_to_chunk[name]
            if chunk_id in self._chunk_to_symbol:
                del self._chunk_to_symbol[chunk_id]
            if chunk_id in self._chunk_to_stable:
                stable_id = self._chunk_to_stable[chunk_id]
                del self._chunk_to_stable[chunk_id]
                if stable_id in self._stable_to_chunk:
                    del self._stable_to_chunk[stable_id]
        
        # Remove outgoing edges
        if name in self._edges:
            for edge in self._edges[name]:
                self._reverse_edges[edge.target] = [
                    e for e in self._reverse_edges[edge.target] if e.source != name
                ]
            del self._edges[name]
        
        # Remove incoming edges
        if name in self._reverse_edges:
            for edge in self._reverse_edges[name]:
                self._edges[edge.source] = [
                    e for e in self._edges[edge.source] if e.target != name
                ]
            del self._reverse_edges[name]
    
    def remove_edges_from_file(self, file_path: FilePath) -> int:
        """
        Remove all edges originating from a file.
        
        CRITICAL for incremental reindexing:
        When a file is reindexed, we must remove ALL old edges
        from that file before adding new ones.
        
        Args:
            file_path: Path to the file
            
        Returns:
            Number of edges removed
        """
        if file_path not in self._file_to_edges:
            return 0
        
        edges_to_remove = self._file_to_edges[file_path]
        removed = 0
        
        for edge in edges_to_remove:
            # Remove from outgoing edges
            if edge.source in self._edges:
                self._edges[edge.source] = [
                    e for e in self._edges[edge.source]
                    if not (e.target == edge.target and e.edge_type == edge.edge_type)
                ]
            
            # Remove from incoming edges
            if edge.target in self._reverse_edges:
                self._reverse_edges[edge.target] = [
                    e for e in self._reverse_edges[edge.target]
                    if not (e.source == edge.source and e.edge_type == edge.edge_type)
                ]
            
            removed += 1
        
        del self._file_to_edges[file_path]
        return removed
    
    def get_symbols_for_file(self, file_path: FilePath) -> Set[QualifiedName]:
        """Get all symbols defined in a file."""
        return self._file_to_symbols.get(file_path, set()).copy()
    
    def get_chunks_for_file(self, file_path: FilePath) -> Set[ChunkId]:
        """Get all chunk IDs for a file."""
        symbols = self._file_to_symbols.get(file_path, set())
        return {
            self._symbol_to_chunk[sym]
            for sym in symbols
            if sym in self._symbol_to_chunk
        }
    
    def all_nodes(self) -> Iterator[SymbolNode]:
        """Iterate over all nodes."""
        return iter(self._nodes.values())
    
    def __len__(self) -> int:
        return len(self._nodes)


class StructuralIndex:
    """
    Structural index combining file index and symbol graph.
    
    Provides:
    - File → symbols mapping
    - Import graph between files
    - Symbol dependency graph
    - Efficient queries for structural expansion
    """
    
    def __init__(self, persist_path: Optional[str] = None):
        self.persist_path = persist_path
        
        # File index
        self._files: Dict[FilePath, FileEntry] = {}
        
        # Symbol graph
        self._graph = SymbolGraph()
        
        # Chunk to file mapping
        self._chunk_to_file: Dict[ChunkId, FilePath] = {}
        
        # Dirty flag for persistence
        self._dirty = False
        
        # Load if exists
        if persist_path and os.path.exists(persist_path):
            self._load()
    
    def index_chunk(self, chunk: SemanticChunk) -> None:
        """
        Index a semantic chunk.
        
        Updates both file index and symbol graph.
        """
        file_path = chunk.file_path
        
        # Ensure file entry exists
        if file_path not in self._files:
            self._files[file_path] = FileEntry(
                path=file_path,
                content_hash="",
                language=chunk.language,
            )
        
        file_entry = self._files[file_path]
        
        # Build qualified name
        if chunk.metadata.qualified_name:
            qualified_name = chunk.metadata.qualified_name
        elif chunk.metadata.parent_symbol:
            qualified_name = f"{chunk.metadata.parent_symbol}.{chunk.symbol_name}"
        else:
            qualified_name = chunk.symbol_name
        
        # Add to file's symbols
        file_entry.symbols.add(qualified_name)
        
        # Create symbol node
        node = SymbolNode(
            qualified_name=qualified_name,
            simple_name=chunk.symbol_name,
            symbol_type=chunk.symbol_type,
            file_path=file_path,
            line=chunk.metadata.start_line,
            chunk_id=chunk.id,
            is_public=chunk.metadata.is_public,
            stable_symbol_id=chunk.metadata.stable_symbol_id,
        )
        self._graph.add_node(node, chunk.id)
        
        # Track chunk to file
        self._chunk_to_file[chunk.id] = file_path
        
        # Add dependency edges from imports
        for imported in chunk.metadata.imports_used:
            edge = SymbolEdge(
                source=qualified_name,
                target=imported,
                edge_type=EdgeType.IMPORTS,
                file_path=file_path,
                line=chunk.metadata.start_line,
            )
            self._graph.add_edge(edge)

        # Add type reference edges
        for type_ref in chunk.metadata.type_refs:
            edge = SymbolEdge(
                source=qualified_name,
                target=type_ref,
                edge_type=EdgeType.USES_TYPE,
                file_path=file_path,
                line=chunk.metadata.start_line,
            )
            self._graph.add_edge(edge)
        
        # Add parent-child edge if nested
        if chunk.metadata.parent_symbol:
            edge = SymbolEdge(
                source=chunk.metadata.parent_symbol,
                target=qualified_name,
                edge_type=EdgeType.CONTAINS,
                file_path=file_path,
            )
            self._graph.add_edge(edge)
        
        self._dirty = True
    
    def index_file_imports(
        self,
        file_path: FilePath,
        imports: List[str],
        content_hash: str,
        language: str,
        import_symbols: Optional[Dict[FilePath, Set[str]]] = None,
    ) -> None:
        """
        Index import relationships for a file.
        
        Called during initial file processing.
        """
        if file_path not in self._files:
            self._files[file_path] = FileEntry(
                path=file_path,
                content_hash=content_hash,
                language=language,
            )
        
        file_entry = self._files[file_path]
        file_entry.content_hash = content_hash

        # Store imported symbol names (for linking)
        file_entry.import_symbols = import_symbols or {}
        
        # Resolve and add imports
        old_imports = file_entry.imports.copy()
        file_entry.imports = set(imports)
        
        # Update reverse mappings
        for old_import in old_imports - file_entry.imports:
            if old_import in self._files:
                self._files[old_import].imported_by.discard(file_path)
        
        for new_import in file_entry.imports:
            if new_import in self._files:
                self._files[new_import].imported_by.add(file_path)
            else:
                # Create placeholder for unknown file
                self._files[new_import] = FileEntry(
                    path=new_import,
                    content_hash="",
                    language=language,
                    imported_by={file_path},
                )
        
        self._dirty = True

    def resolve_import_symbol_edges(self, file_path: FilePath) -> int:
        """Resolve import edges to qualified symbols for a file."""
        if file_path not in self._files:
            return 0
        file_entry = self._files[file_path]
        import_symbols = file_entry.import_symbols or {}
        if not import_symbols:
            return 0

        # Build quick lookup for imported files
        imported_symbol_maps: Dict[FilePath, Dict[str, Set[str]]] = {}
        for imported_file, names in import_symbols.items():
            if imported_file not in self._files:
                continue
            symbols = self._files[imported_file].symbols
            simple_map: Dict[str, Set[str]] = {}
            for qn in symbols:
                simple = qn.split(".")[-1]
                simple_map.setdefault(simple, set()).add(qn)
            imported_symbol_maps[imported_file] = simple_map

        existing = set(
            (e.source, e.target, e.edge_type.value)
            for e in self._graph.get_edges_for_file(file_path)
        )

        added = 0
        for edge in self._graph.get_edges_for_file(file_path):
            if edge.edge_type != EdgeType.IMPORTS:
                continue
            target_name = edge.target
            # Try resolve against imported files' symbol maps
            for imported_file, name_map in imported_symbol_maps.items():
                for qn in name_map.get(target_name, set()):
                    key = (edge.source, qn, EdgeType.IMPORTS.value)
                    if key in existing:
                        continue
                    self._graph.add_edge(SymbolEdge(
                        source=edge.source,
                        target=qn,
                        edge_type=EdgeType.IMPORTS,
                        file_path=file_path,
                        line=edge.line,
                        confidence=min(1.0, edge.confidence + 0.1),
                        source_method="resolver",
                    ))
                    existing.add(key)
                    added += 1

        if added:
            self._dirty = True
        return added
    
    def remove_file(self, file_path: FilePath) -> None:
        """Remove a file from the index."""
        if file_path not in self._files:
            return
        
        file_entry = self._files[file_path]
        
        # 1. Remove all edges originating from this file FIRST
        self._graph.remove_edges_from_file(file_path)
        
        # 2. Remove all symbols from this file
        for symbol in list(file_entry.symbols):  # Copy to avoid mutation during iteration
            self._graph.remove_symbol(symbol)
        
        # 3. Update import relationships
        for imported in file_entry.imports:
            if imported in self._files:
                self._files[imported].imported_by.discard(file_path)
        
        # 4. Clean up chunk mappings
        chunks_to_remove = [
            cid for cid, fp in self._chunk_to_file.items() if fp == file_path
        ]
        for cid in chunks_to_remove:
            del self._chunk_to_file[cid]
        
        del self._files[file_path]
        self._dirty = True
        
        logger.debug(f"Removed file from index: {file_path} ({len(chunks_to_remove)} chunks)")
    
    def get_chunks_for_file(self, file_path: FilePath) -> Set[ChunkId]:
        """
        Get all chunk IDs for a file.
        
        CRITICAL for incremental deletion:
        When reindexing, we need to remove ALL old chunks for a file.
        """
        return {
            cid for cid, fp in self._chunk_to_file.items()
            if fp == file_path
        }
    
    def get_file_symbols(self, file_path: FilePath) -> Set[QualifiedName]:
        """Get all symbols defined in a file."""
        if file_path not in self._files:
            return set()
        return self._files[file_path].symbols.copy()
    
    def get_file_imports(self, file_path: FilePath) -> Set[FilePath]:
        """Get files imported by a file."""
        if file_path not in self._files:
            return set()
        return self._files[file_path].imports.copy()
    
    def get_file_importers(self, file_path: FilePath) -> Set[FilePath]:
        """Get files that import a file."""
        if file_path not in self._files:
            return set()
        return self._files[file_path].imported_by.copy()

    def list_files(self) -> List[FilePath]:
        """List all indexed files."""
        return list(self._files.keys())

    def find_chunks_for_symbol(self, symbol_name: str) -> Set[ChunkId]:
        """Find chunk IDs for a symbol name (qualified or simple)."""
        if not symbol_name:
            return set()
        name = symbol_name.strip()
        matches: Set[ChunkId] = set()

        # Qualified name match
        node = self._graph.get_node(name)
        if node:
            matches.add(node.chunk_id)

        # Simple name match
        for qn, n in self._graph._nodes.items():
            if n.simple_name == name or qn.endswith(f".{name}"):
                matches.add(n.chunk_id)

        return matches

    def find_chunks_for_stable_symbol(self, stable_symbol_id: str) -> Set[ChunkId]:
        """Find chunk IDs for a stable symbol ID."""
        if not stable_symbol_id:
            return set()
        cid = self._graph.get_chunk_id_by_stable_id(stable_symbol_id)
        return {cid} if cid else set()

    def compute_call_centrality(self) -> Dict[QualifiedName, int]:
        """Compute simple call-graph in-degree centrality for symbols."""
        centrality: Dict[QualifiedName, int] = {}
        for target, edges in self._graph._reverse_edges.items():
            count = sum(1 for e in edges if e.edge_type == EdgeType.CALLS)
            if count:
                centrality[target] = count
        return centrality
    
    def get_affected_files(self, file_path: FilePath, max_depth: int = 2) -> Set[FilePath]:
        """
        Get files affected by changes to a file.
        
        Follows import graph to find dependents.
        """
        affected = set()
        frontier = {file_path}
        
        for _ in range(max_depth):
            next_frontier = set()
            for fp in frontier:
                if fp in affected:
                    continue
                affected.add(fp)
                
                # Add files that import this file
                if fp in self._files:
                    next_frontier.update(self._files[fp].imported_by)
            
            frontier = next_frontier
            if not frontier:
                break
        
        affected.discard(file_path)
        return affected
    
    def expand_to_dependencies(
        self,
        chunk_ids: Set[ChunkId],
        max_depth: int = 2,
    ) -> Set[ChunkId]:
        """
        Expand chunk set to include dependencies.
        
        This is the core structural expansion used during retrieval.
        
        Args:
            chunk_ids: Initial set of chunk IDs
            max_depth: How deep to follow dependencies
            
        Returns:
            Expanded set of chunk IDs
        """
        expanded = set(chunk_ids)
        
        # Get symbols for initial chunks
        symbols = set()
        for cid in chunk_ids:
            # Find symbol for this chunk (reverse lookup)
            for name, stored_cid in self._graph._symbol_to_chunk.items():
                if stored_cid == cid:
                    symbols.add(name)
                    break
        
        # Expand via symbol graph
        for symbol in symbols:
            deps = self._graph.get_dependencies(symbol, max_depth)
            for dep in deps:
                dep_chunk = self._graph.get_chunk_id(dep)
                if dep_chunk:
                    expanded.add(dep_chunk)
        
        return expanded
    
    def get_related_chunks(
        self,
        chunk_id: ChunkId,
        include_callers: bool = True,
        include_callees: bool = True,
        include_siblings: bool = True,
    ) -> Set[ChunkId]:
        """
        Get chunks related to a given chunk.
        
        Used for context expansion during retrieval.
        """
        related = set()
        
        # Find symbol
        symbol_name = None
        for name, cid in self._graph._symbol_to_chunk.items():
            if cid == chunk_id:
                symbol_name = name
                break
        
        if not symbol_name:
            return related
        
        # Get callers
        if include_callers:
            callers = self._graph.get_callers(symbol_name)
            for caller in callers:
                cid = self._graph.get_chunk_id(caller)
                if cid:
                    related.add(cid)
        
        # Get callees
        if include_callees:
            callees = self._graph.get_callees(symbol_name)
            for callee in callees:
                cid = self._graph.get_chunk_id(callee)
                if cid:
                    related.add(cid)
        
        # Get siblings (same file)
        if include_siblings:
            file_path = self._chunk_to_file.get(chunk_id)
            if file_path and file_path in self._files:
                for sym in self._files[file_path].symbols:
                    cid = self._graph.get_chunk_id(sym)
                    if cid and cid != chunk_id:
                        related.add(cid)
        
        return related
    
    @property
    def graph(self) -> SymbolGraph:
        """Access the symbol graph."""
        return self._graph
    
    def persist(self) -> None:
        """Persist index to disk."""
        if not self.persist_path or not self._dirty:
            return
        
        os.makedirs(os.path.dirname(self.persist_path), exist_ok=True)
        
        data = {
            "files": {
                path: {
                    "content_hash": entry.content_hash,
                    "language": entry.language,
                    "symbols": list(entry.symbols),
                    "imports": list(entry.imports),
                    "imported_by": list(entry.imported_by),
                    "import_symbols": {
                        k: list(v) for k, v in (entry.import_symbols or {}).items()
                    },
                }
                for path, entry in self._files.items()
            },
            "chunk_to_file": self._chunk_to_file,
            "graph": self._graph.to_dict(),
        }
        
        with open(self.persist_path, "w") as f:
            json.dump(data, f)
        
        self._dirty = False
        logger.info(f"Persisted structural index: {len(self._files)} files")
    
    def _load(self) -> None:
        """Load index from disk."""
        if not self.persist_path or not os.path.exists(self.persist_path):
            return
        
        try:
            with open(self.persist_path, "r") as f:
                data = json.load(f)
            
            for path, entry_data in data.get("files", {}).items():
                self._files[path] = FileEntry(
                    path=path,
                    content_hash=entry_data.get("content_hash", ""),
                    language=entry_data.get("language", ""),
                    symbols=set(entry_data.get("symbols", [])),
                    imports=set(entry_data.get("imports", [])),
                    imported_by=set(entry_data.get("imported_by", [])),
                    import_symbols={
                        k: set(v or []) for k, v in (entry_data.get("import_symbols") or {}).items()
                    },
                )
            
            self._chunk_to_file = data.get("chunk_to_file", {})

            graph_data = data.get("graph")
            if graph_data:
                self._graph.load_dict(graph_data)
            
            logger.info(f"Loaded structural index: {len(self._files)} files")
            
        except Exception as e:
            logger.error(f"Failed to load structural index: {e}")
    
    def stats(self) -> Dict:
        """Get index statistics."""
        return {
            "total_files": len(self._files),
            "total_symbols": len(self._graph),
            "total_edges": sum(
                len(edges) for edges in self._graph._edges.values()
            ),
        }


# Global instance
_structural_index: Optional[StructuralIndex] = None


def get_structural_index(persist_path: Optional[str] = None) -> StructuralIndex:
    """Get or create the structural index."""
    global _structural_index
    if _structural_index is None:
        _structural_index = StructuralIndex(persist_path)
    return _structural_index
