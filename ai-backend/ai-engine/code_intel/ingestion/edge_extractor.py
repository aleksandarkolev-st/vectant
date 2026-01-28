"""
Edge Extractor - Extract symbol relationships with proper confidence scoring.

Confidence is computed based on extraction method:
- LSP references: 1.0 (ground truth from language server)
- AST direct import/call: 0.9 (parser-verified references)
- Heuristic string match: 0.6 (pattern-based guesses)

This module unifies edge extraction logic and assigns consistent confidence scores.
"""

from __future__ import annotations

import logging
import re
from dataclasses import dataclass
from enum import Enum
from typing import Dict, List, Optional, Set, Tuple

from .parser_base import ParseResult, ParsedSymbol, ImportStatement
from ..core.types import EdgeType, SymbolEdge, QualifiedName, FilePath


logger = logging.getLogger("code_intel.ingestion.edge_extractor")


class ExtractionMethod(str, Enum):
    """Method used to extract the edge."""
    LSP = "lsp"              # Language Server Protocol reference
    AST = "ast"              # Direct AST/parser extraction
    HEURISTIC = "heuristic"  # Pattern/heuristic-based


# Confidence scores by extraction method
CONFIDENCE_SCORES = {
    ExtractionMethod.LSP: 1.0,
    ExtractionMethod.AST: 0.9,
    ExtractionMethod.HEURISTIC: 0.6,
}


@dataclass
class ExtractedEdge:
    """An extracted edge with metadata."""
    source: QualifiedName
    target: QualifiedName
    edge_type: EdgeType
    method: ExtractionMethod
    file_path: FilePath
    line: int
    confidence: float
    
    def to_symbol_edge(self) -> SymbolEdge:
        """Convert to SymbolEdge for indexing."""
        return SymbolEdge(
            source=self.source,
            target=self.target,
            edge_type=self.edge_type,
            file_path=self.file_path,
            line=self.line,
            confidence=self.confidence,
            source_method=self.method.value,
        )


class EdgeExtractor:
    """
    Extract symbol relationship edges from parsed code.
    
    Extraction is done in priority order:
    1. LSP references (if available) - highest confidence
    2. AST-based extraction - high confidence
    3. Heuristic patterns - lower confidence
    
    Each method assigns appropriate confidence scores.
    """
    
    def __init__(self):
        # Regex for heuristic detection
        self._call_pattern = re.compile(r'\b([A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*)\s*\(')
        self._type_pattern = re.compile(r':\s*([A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*)')
        self._extends_pattern = re.compile(r'(?:extends|implements|:)\s*([A-Za-z_][A-Za-z0-9_]*(?:\s*,\s*[A-Za-z_][A-Za-z0-9_]*)*)')
    
    def extract_from_parse_result(
        self,
        parse_result: ParseResult,
        file_path: FilePath,
        lsp_references: Optional[Dict[str, List[Tuple[str, int]]]] = None,
    ) -> List[ExtractedEdge]:
        """
        Extract edges from a parse result.
        
        Args:
            parse_result: Parser output
            file_path: Path to the source file
            lsp_references: Optional LSP reference map {symbol -> [(target, line), ...]}
            
        Returns:
            List of extracted edges with confidence scores
        """
        edges: List[ExtractedEdge] = []
        
        # 1. LSP references (highest confidence)
        if lsp_references:
            edges.extend(self._extract_from_lsp(lsp_references, file_path))
        
        # 2. Import edges (AST confidence)
        edges.extend(self._extract_import_edges(parse_result.imports, file_path))
        
        # 3. Symbol-level edges (AST confidence)
        for symbol in parse_result.symbols:
            edges.extend(self._extract_symbol_edges(symbol, parse_result, file_path))
        
        # 4. Heuristic edges (lower confidence, avoid duplicates)
        existing_targets = {(e.source, e.target, e.edge_type) for e in edges}
        heuristic_edges = self._extract_heuristic_edges(parse_result, file_path)
        for edge in heuristic_edges:
            key = (edge.source, edge.target, edge.edge_type)
            if key not in existing_targets:
                edges.append(edge)
        
        return edges
    
    def _extract_from_lsp(
        self,
        lsp_references: Dict[str, List[Tuple[str, int]]],
        file_path: FilePath,
    ) -> List[ExtractedEdge]:
        """Extract edges from LSP reference data."""
        edges = []
        confidence = CONFIDENCE_SCORES[ExtractionMethod.LSP]
        
        for source, refs in lsp_references.items():
            for target, line in refs:
                # Determine edge type from context
                edge_type = EdgeType.CALLS  # Default, could be refined
                
                edges.append(ExtractedEdge(
                    source=source,
                    target=target,
                    edge_type=edge_type,
                    method=ExtractionMethod.LSP,
                    file_path=file_path,
                    line=line,
                    confidence=confidence,
                ))
        
        return edges
    
    def _extract_import_edges(
        self,
        imports: List[ImportStatement],
        file_path: FilePath,
    ) -> List[ExtractedEdge]:
        """Extract edges from import statements."""
        edges = []
        confidence = CONFIDENCE_SCORES[ExtractionMethod.AST]
        
        for imp in imports:
            source = imp.module  # The file doing the import
            
            for name in imp.names:
                target = f"{imp.source}.{name}" if imp.source else name
                
                edges.append(ExtractedEdge(
                    source=source if source else file_path,
                    target=target,
                    edge_type=EdgeType.IMPORTS,
                    method=ExtractionMethod.AST,
                    file_path=file_path,
                    line=imp.line,
                    confidence=confidence,
                ))
        
        return edges
    
    def _extract_symbol_edges(
        self,
        symbol: ParsedSymbol,
        parse_result: ParseResult,
        file_path: FilePath,
    ) -> List[ExtractedEdge]:
        """Extract edges from a symbol's AST data."""
        edges = []
        confidence = CONFIDENCE_SCORES[ExtractionMethod.AST]
        
        qualified_name = symbol.qualified_name
        
        # Inheritance edges
        if symbol.bases:
            for base in symbol.bases:
                edges.append(ExtractedEdge(
                    source=qualified_name,
                    target=base,
                    edge_type=EdgeType.INHERITS,
                    method=ExtractionMethod.AST,
                    file_path=file_path,
                    line=symbol.start_line,
                    confidence=confidence,
                ))
        
        # Type usage edges
        if symbol.type_refs:
            for type_ref in symbol.type_refs:
                edges.append(ExtractedEdge(
                    source=qualified_name,
                    target=type_ref,
                    edge_type=EdgeType.USES_TYPE,
                    method=ExtractionMethod.AST,
                    file_path=file_path,
                    line=symbol.start_line,
                    confidence=confidence,
                ))
        
        # Call edges (if parser provides them)
        if symbol.calls:
            for call in symbol.calls:
                edges.append(ExtractedEdge(
                    source=qualified_name,
                    target=call,
                    edge_type=EdgeType.CALLS,
                    method=ExtractionMethod.AST,
                    file_path=file_path,
                    line=symbol.start_line,
                    confidence=confidence,
                ))
        
        # Parent containment
        if symbol.parent:
            edges.append(ExtractedEdge(
                source=symbol.parent,
                target=qualified_name,
                edge_type=EdgeType.CONTAINS,
                method=ExtractionMethod.AST,
                file_path=file_path,
                line=symbol.start_line,
                confidence=confidence,
            ))
        
        # Decorator edges
        if symbol.decorators:
            for decorator in symbol.decorators:
                edges.append(ExtractedEdge(
                    source=decorator,
                    target=qualified_name,
                    edge_type=EdgeType.DECORATES,
                    method=ExtractionMethod.AST,
                    file_path=file_path,
                    line=symbol.start_line,
                    confidence=confidence,
                ))
        
        return edges
    
    def _extract_heuristic_edges(
        self,
        parse_result: ParseResult,
        file_path: FilePath,
    ) -> List[ExtractedEdge]:
        """
        Extract edges using heuristic pattern matching.
        
        LOWER CONFIDENCE: These are guesses based on patterns.
        They are only used when LSP/AST extraction didn't find them.
        """
        edges = []
        confidence = CONFIDENCE_SCORES[ExtractionMethod.HEURISTIC]
        
        # Build set of known symbols for filtering
        known_symbols = {s.name for s in parse_result.symbols}
        known_symbols.update({s.qualified_name for s in parse_result.symbols if s.qualified_name})
        
        for symbol in parse_result.symbols:
            code = symbol.code
            
            # Find potential function calls
            for match in self._call_pattern.finditer(code):
                potential_call = match.group(1)
                
                # Skip self/this and common builtins
                if potential_call in ('self', 'this', 'super', 'print', 'len', 'str', 'int'):
                    continue
                
                # Skip if it's calling the symbol itself (recursion handled elsewhere)
                if potential_call == symbol.name:
                    continue
                
                edges.append(ExtractedEdge(
                    source=symbol.qualified_name or symbol.name,
                    target=potential_call,
                    edge_type=EdgeType.CALLS,
                    method=ExtractionMethod.HEURISTIC,
                    file_path=file_path,
                    line=symbol.start_line,
                    confidence=confidence,
                ))
            
            # Find potential type references
            for match in self._type_pattern.finditer(code):
                type_ref = match.group(1)
                
                # Skip primitive types
                if type_ref.lower() in ('str', 'int', 'float', 'bool', 'none', 'void', 'any'):
                    continue
                
                edges.append(ExtractedEdge(
                    source=symbol.qualified_name or symbol.name,
                    target=type_ref,
                    edge_type=EdgeType.USES_TYPE,
                    method=ExtractionMethod.HEURISTIC,
                    file_path=file_path,
                    line=symbol.start_line,
                    confidence=confidence,
                ))
        
        return edges


def extract_edges(
    parse_result: ParseResult,
    file_path: FilePath,
    lsp_references: Optional[Dict[str, List[Tuple[str, int]]]] = None,
) -> List[SymbolEdge]:
    """
    Convenience function to extract edges from a parse result.
    
    Args:
        parse_result: Parser output
        file_path: Source file path
        lsp_references: Optional LSP reference map
        
    Returns:
        List of SymbolEdge objects ready for indexing
    """
    extractor = EdgeExtractor()
    extracted = extractor.extract_from_parse_result(parse_result, file_path, lsp_references)
    return [e.to_symbol_edge() for e in extracted]


def compute_edge_confidence(
    source_method: str,
    edge_type: Optional[EdgeType] = None,
    is_direct: bool = True,
) -> float:
    """
    Compute confidence score for an edge.
    
    Args:
        source_method: "lsp", "ast", or "heuristic"
        edge_type: Type of edge (may affect confidence)
        is_direct: Whether the edge is a direct reference
        
    Returns:
        Confidence score 0.0-1.0
    """
    try:
        method = ExtractionMethod(source_method)
        base_confidence = CONFIDENCE_SCORES[method]
    except (ValueError, KeyError):
        base_confidence = 0.5
    
    # Adjust based on edge type (some types are more reliable)
    if edge_type in (EdgeType.IMPORTS, EdgeType.INHERITS, EdgeType.IMPLEMENTS):
        # These are very reliable from AST
        base_confidence = min(1.0, base_confidence + 0.05)
    elif edge_type == EdgeType.CALLS:
        # Call detection can be less reliable
        pass
    elif edge_type in (EdgeType.USES_TYPE, EdgeType.DECORATES):
        # Type refs and decorators are usually reliable
        base_confidence = min(1.0, base_confidence + 0.02)
    
    # Indirect references are less reliable
    if not is_direct:
        base_confidence *= 0.8
    
    return base_confidence
