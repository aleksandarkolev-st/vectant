"""
Graph Expander - Expand candidates via dependency graph.

This is step 3 of the retrieval pipeline:
1. [QueryProcessor] Embed user request ✓
2. [ContextRetriever] Vector search top-k chunks ✓
3. [GraphExpander] Expand via dependency graph ← YOU ARE HERE
4. [ContextRanker] Rank by relevance, call distance, file importance
5. [BudgetEnforcer] Enforce hard token budget
6. [ContextAssembler] Assemble final context

Key insight: Vector search finds entry points.
Graph expansion finds the supporting code needed to understand them.

CRITICAL RULES (without these, graph explosion occurs):
1. Hard cap per module: max N symbols from any one module
2. Caller vs callee selection: prefer callees (what we call) over callers
3. Depth limits: max 2 hops for calls, max 1 for imports
4. Score decay: each hop reduces relevance score
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field
from typing import Dict, List, Optional, Set, Tuple

from ..core.types import SemanticChunk, EdgeType
from ..core.config import RetrievalConfig
from .retriever import RetrievalCandidate


logger = logging.getLogger("code_intel.retrieval.expander")


@dataclass
class ExpansionRule:
    """Rule for graph expansion."""
    
    edge_type: EdgeType
    direction: str  # "forward", "backward", "both"
    max_hops: int
    score_decay: float  # How much to reduce score per hop
    priority: int = 0  # Higher = process first
    max_per_source: int = 5  # Max expansions per source symbol


@dataclass
class ModuleLimit:
    """Hard limits per module to prevent graph explosion."""
    
    max_symbols: int = 10
    max_files: int = 5
    max_tokens: int = 2000


class GraphExpander:
    """
    Expand retrieval candidates via the symbol graph.
    
    Given initial candidates, follow edges to find:
    - Definitions of used symbols
    - Implementations of interfaces
    - Callers/callees
    - Related types
    
    HARD LIMITS (non-negotiable):
    - Max symbols per module
    - Max total expansion
    - Max depth per edge type
    """
    
    # Default expansion rules with priorities
    # Higher priority rules are processed first
    DEFAULT_RULES = [
        # Find definitions of things we import/use (HIGH PRIORITY)
        ExpansionRule(
            EdgeType.IMPORTS, "forward", max_hops=1, score_decay=0.8,
            priority=10, max_per_source=5
        ),
        
        # Find what we call (MEDIUM-HIGH - needed for understanding)
        ExpansionRule(
            EdgeType.CALLS, "forward", max_hops=2, score_decay=0.6,
            priority=8, max_per_source=5
        ),
        
        # Find implementations (HIGH - needed for interfaces)
        ExpansionRule(
            EdgeType.IMPLEMENTS, "forward", max_hops=1, score_decay=0.85,
            priority=9, max_per_source=3
        ),
        
        # Find parent classes (MEDIUM)
        ExpansionRule(
            EdgeType.INHERITS, "forward", max_hops=2, score_decay=0.7,
            priority=7, max_per_source=3
        ),
        
        # Find type definitions (MEDIUM)
        ExpansionRule(
            EdgeType.USES_TYPE, "forward", max_hops=1, score_decay=0.65,
            priority=6, max_per_source=5
        ),
        
        # Find callers (LOW PRIORITY - can explode quickly)
        ExpansionRule(
            EdgeType.CALLS, "backward", max_hops=1, score_decay=0.4,
            priority=3, max_per_source=3  # Very limited!
        ),
    ]
    
    # Default per-module limits
    DEFAULT_MODULE_LIMIT = ModuleLimit(max_symbols=10, max_files=5, max_tokens=2000)
    
    def __init__(
        self,
        symbol_graph,  # SymbolGraph
        structural_index,  # StructuralIndex
        config: Optional[RetrievalConfig] = None,
        rules: Optional[List[ExpansionRule]] = None,
    ):
        self.symbol_graph = symbol_graph
        self.structural_index = structural_index
        self.config = config or RetrievalConfig()
        self.rules = rules or self.DEFAULT_RULES
        
        # Sort rules by priority (highest first)
        self.rules = sorted(self.rules, key=lambda r: r.priority, reverse=True)
        
        # Per-module limits (can be customized)
        self.module_limits: Dict[str, ModuleLimit] = {}
        self.default_module_limit = self.DEFAULT_MODULE_LIMIT
    
    def set_module_limit(
        self,
        module: str,
        max_symbols: int = 10,
        max_files: int = 5,
        max_tokens: int = 2000,
    ) -> None:
        """Set custom limit for a specific module."""
        self.module_limits[module] = ModuleLimit(
            max_symbols=max_symbols,
            max_files=max_files,
            max_tokens=max_tokens,
        )
    
    def expand(
        self,
        candidates: List[RetrievalCandidate],
        max_expanded: Optional[int] = None,
    ) -> List[RetrievalCandidate]:
        """
        Expand candidates via graph traversal.
        
        Args:
            candidates: Initial retrieval candidates
            max_expanded: Max total candidates after expansion
            
        Returns:
            Expanded list of candidates
        """
        max_expanded = max_expanded or (self.config.top_k * 3)
        
        # Track what we've seen
        seen_ids: Set[str] = set()
        all_candidates: Dict[str, RetrievalCandidate] = {}
        
        # Track per-module counts (CRITICAL for preventing explosion)
        module_symbol_counts: Dict[str, int] = {}
        module_file_counts: Dict[str, Set[str]] = {}
        
        # Track expansions per source symbol per rule
        source_expansion_counts: Dict[str, Dict[str, int]] = {}
        
        # Add initial candidates
        for cand in candidates:
            seen_ids.add(cand.chunk.id)
            all_candidates[cand.chunk.id] = cand
            
            # Track module usage
            module = self._get_module(cand.chunk.metadata.file_path)
            module_symbol_counts[module] = module_symbol_counts.get(module, 0) + 1
            if module not in module_file_counts:
                module_file_counts[module] = set()
            module_file_counts[module].add(cand.chunk.metadata.file_path)
        
        # Expand each initial candidate
        for cand in candidates:
            expanded = self._expand_candidate(
                cand, 
                seen_ids,
                module_symbol_counts,
                module_file_counts,
                source_expansion_counts,
            )
            
            for new_cand in expanded:
                chunk_id = new_cand.chunk.id
                
                if chunk_id in all_candidates:
                    # Update with better score if found again
                    if new_cand.combined_score > all_candidates[chunk_id].combined_score:
                        all_candidates[chunk_id] = new_cand
                else:
                    all_candidates[chunk_id] = new_cand
                    seen_ids.add(chunk_id)
                
                # Stop if we have enough
                if len(all_candidates) >= max_expanded:
                    break
            
            if len(all_candidates) >= max_expanded:
                break
        
        # Convert to list and sort
        result = list(all_candidates.values())
        result.sort(key=lambda c: c.combined_score, reverse=True)
        
        logger.info(
            f"Graph expansion: {len(candidates)} -> {len(result)} candidates "
            f"(modules: {len(module_symbol_counts)})"
        )
        
        return result[:max_expanded]
    
    def _get_module(self, file_path: str) -> str:
        """Extract module from file path."""
        parts = file_path.replace("\\", "/").split("/")
        if len(parts) > 1:
            return parts[0]
        return "root"
    
    def _check_module_limit(
        self,
        file_path: str,
        module_symbol_counts: Dict[str, int],
        module_file_counts: Dict[str, Set[str]],
    ) -> bool:
        """Check if module limits allow adding this symbol."""
        module = self._get_module(file_path)
        limit = self.module_limits.get(module, self.default_module_limit)
        
        # Check symbol limit
        current_symbols = module_symbol_counts.get(module, 0)
        if current_symbols >= limit.max_symbols:
            return False
        
        # Check file limit (if new file)
        current_files = module_file_counts.get(module, set())
        if file_path not in current_files and len(current_files) >= limit.max_files:
            return False
        
        return True
    
    def _record_module_usage(
        self,
        file_path: str,
        module_symbol_counts: Dict[str, int],
        module_file_counts: Dict[str, Set[str]],
    ) -> None:
        """Record that we're using a symbol from this module."""
        module = self._get_module(file_path)
        module_symbol_counts[module] = module_symbol_counts.get(module, 0) + 1
        if module not in module_file_counts:
            module_file_counts[module] = set()
        module_file_counts[module].add(file_path)
    
    def _expand_candidate(
        self,
        candidate: RetrievalCandidate,
        seen_ids: Set[str],
        module_symbol_counts: Dict[str, int],
        module_file_counts: Dict[str, Set[str]],
        source_expansion_counts: Dict[str, Dict[str, int]],
    ) -> List[RetrievalCandidate]:
        """Expand a single candidate with all safety limits."""
        expanded = []
        chunk = candidate.chunk
        
        # Get symbol name for this chunk
        symbol_name = chunk.metadata.symbol_name if hasattr(chunk, 'metadata') else getattr(chunk, 'symbol_name', '')
        if not symbol_name:
            return expanded
        
        # Initialize tracking for this source
        if symbol_name not in source_expansion_counts:
            source_expansion_counts[symbol_name] = {}
        
        # Apply each expansion rule (in priority order)
        for rule in self.rules:
            rule_key = f"{rule.edge_type.value}:{rule.direction}"
            
            # Check per-source limit for this rule
            current_count = source_expansion_counts[symbol_name].get(rule_key, 0)
            if current_count >= rule.max_per_source:
                continue
            
            related = self._follow_rule(
                symbol_name,
                rule,
                candidate.combined_score,
                candidate.expansion_depth,
                candidate.expansion_path,
                seen_ids,
                module_symbol_counts,
                module_file_counts,
            )
            
            for new_cand in related:
                if current_count >= rule.max_per_source:
                    break
                    
                if new_cand.chunk.id not in seen_ids:
                    expanded.append(new_cand)
                    current_count += 1
            
            source_expansion_counts[symbol_name][rule_key] = current_count
        
        return expanded
    
    def _follow_rule(
        self,
        symbol_name: str,
        rule: ExpansionRule,
        base_score: float,
        current_depth: int,
        current_path: List[str],
        seen_ids: Set[str],
        module_symbol_counts: Dict[str, int],
        module_file_counts: Dict[str, Set[str]],
    ) -> List[RetrievalCandidate]:
        """Follow edges according to a rule with safety limits."""
        if current_depth >= rule.max_hops:
            return []
        
        candidates = []
        
        # Find edges from this symbol
        if rule.direction in ("forward", "both"):
            edges = self.symbol_graph.get_edges_from(symbol_name)
            for edge in edges:
                if edge.edge_type == rule.edge_type:
                    cand = self._create_candidate_from_symbol(
                        edge.target,
                        base_score * rule.score_decay,
                        current_depth + 1,
                        current_path + [symbol_name],
                        f"graph:{rule.edge_type.value}",
                        seen_ids,
                        module_symbol_counts,
                        module_file_counts,
                    )
                    if cand:
                        candidates.append(cand)
        
        # Find edges to this symbol
        if rule.direction in ("backward", "both"):
            edges = self.symbol_graph.get_edges_to(symbol_name)
            for edge in edges:
                if edge.edge_type == rule.edge_type:
                    cand = self._create_candidate_from_symbol(
                        edge.source,
                        base_score * rule.score_decay,
                        current_depth + 1,
                        current_path + [symbol_name],
                        f"graph:{rule.edge_type.value}:inverse",
                        seen_ids,
                        module_symbol_counts,
                        module_file_counts,
                    )
                    if cand:
                        candidates.append(cand)
        
        return candidates
    
    def _create_candidate_from_symbol(
        self,
        symbol_name: str,
        score: float,
        depth: int,
        path: List[str],
        source: str,
        seen_ids: Set[str],
        module_symbol_counts: Dict[str, int],
        module_file_counts: Dict[str, Set[str]],
    ) -> Optional[RetrievalCandidate]:
        """Create a retrieval candidate from a symbol name with limit checks."""
        # Look up the symbol in structural index
        symbol_node = self.symbol_graph.get_node(symbol_name)
        if not symbol_node:
            return None
        
        file_path = symbol_node.file_path
        
        # Check module limits BEFORE creating candidate
        if not self._check_module_limit(file_path, module_symbol_counts, module_file_counts):
            logger.debug(f"Module limit reached, skipping {symbol_name} from {file_path}")
            return None
        
        # Get the chunk for this symbol
        chunk = self._get_chunk_for_symbol(symbol_name, file_path)
        if not chunk:
            return None
        
        # Check if already seen
        if chunk.id in seen_ids:
            return None
        
        # Record module usage
        self._record_module_usage(file_path, module_symbol_counts, module_file_counts)
        
        return RetrievalCandidate(
            chunk=chunk,
            vector_score=0.0,
            keyword_score=0.0,
            combined_score=score,
            source=source,
            expansion_depth=depth,
            expansion_path=path,
        )
    
    def _get_chunk_for_symbol(
        self,
        symbol_name: str,
        file_path: str,
    ) -> Optional[SemanticChunk]:
        """
        Get the semantic chunk for a symbol.
        
        Note: This requires a symbol -> chunk mapping.
        In a real implementation, this would be indexed.
        """
        # Get file entry from structural index
        file_entry = self.structural_index.get_file(file_path)
        if not file_entry:
            return None
        
        # Find matching symbol in file
        for symbol in file_entry.symbols:
            if symbol.name == symbol_name:
                # Create a minimal chunk
                # In production, this would look up the actual chunk
                return SemanticChunk(
                    id=f"{file_path}:{symbol_name}",
                    language=file_entry.language,
                    file_path=file_path,
                    symbol_name=symbol_name,
                    symbol_type=symbol.symbol_type,
                    signature=symbol.signature,
                    code_body="",  # Would be populated from chunk store
                )
        
        return None


def expand_via_graph(
    candidates: List[RetrievalCandidate],
    symbol_graph,
    structural_index,
    max_expanded: int = 30,
) -> List[RetrievalCandidate]:
    """Convenience function for graph expansion."""
    expander = GraphExpander(symbol_graph, structural_index)
    return expander.expand(candidates, max_expanded)
