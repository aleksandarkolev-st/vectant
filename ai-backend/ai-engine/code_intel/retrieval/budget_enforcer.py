"""
Budget Enforcer - Enforce hard token limits.

This is step 5 of the retrieval pipeline:
1. [QueryProcessor] Embed user request ✓
2. [ContextRetriever] Vector search top-k chunks ✓
3. [GraphExpander] Expand via dependency graph ✓
4. [ContextRanker] Rank by relevance, call distance, file importance ✓
5. [BudgetEnforcer] Enforce hard token budget ← YOU ARE HERE
6. [ContextAssembler] Assemble final context

Critical constraint: AI models have hard token limits.
This module ensures we never exceed them.

Budget allocation:
- Repo summary: ~300-500 tokens (fixed)
- File summaries: ~100 tokens each (variable)
- Code chunks: Remaining budget (main content)
- Reserve: ~200 tokens for model response
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field
from typing import Dict, List, Optional, Tuple

from ..core.types import SemanticChunk, FileSummary, RepoSummary, ContextBudget
from ..core.config import ContextConfig
from .retriever import RetrievalCandidate


logger = logging.getLogger("code_intel.retrieval.budget")


# Approximate token estimation
# Average English word ≈ 1.3 tokens
# Code is more dense: ~0.5-0.7 tokens per character on average
CHARS_PER_TOKEN = 4


@dataclass
class BudgetAllocation:
    """How the token budget is allocated."""
    
    # Fixed allocations
    repo_summary_tokens: int = 0
    system_prompt_tokens: int = 0
    
    # Variable allocations
    file_summary_tokens: int = 0
    code_chunk_tokens: int = 0
    
    # Reserve for response
    response_reserve: int = 0
    
    # Total and remaining
    total_budget: int = 0
    used_tokens: int = 0
    remaining_tokens: int = 0
    
    # What fit
    included_chunks: List[RetrievalCandidate] = field(default_factory=list)
    included_file_summaries: List[str] = field(default_factory=list)
    truncated_chunks: List[RetrievalCandidate] = field(default_factory=list)
    excluded_chunks: List[RetrievalCandidate] = field(default_factory=list)


class BudgetEnforcer:
    """
    Enforce token budgets for context assembly.
    
    Strategy:
    1. Reserve tokens for fixed elements (repo summary, system prompt)
    2. Allocate tokens to code chunks by rank order
    3. Fill remaining budget with file summaries
    4. Keep reserve for model response
    """
    
    def __init__(
        self,
        config: Optional[ContextConfig] = None,
    ):
        self.config = config or ContextConfig()
    
    def enforce(
        self,
        candidates: List[RetrievalCandidate],
        repo_summary: Optional[RepoSummary] = None,
        file_summaries: Optional[Dict[str, FileSummary]] = None,
        budget: Optional[ContextBudget] = None,
    ) -> BudgetAllocation:
        """
        Enforce budget constraints on context.
        
        Args:
            candidates: Ranked retrieval candidates
            repo_summary: Repository summary
            file_summaries: Map of file path -> summary
            budget: Token budget constraints
            
        Returns:
            BudgetAllocation with what fits
        """
        budget = budget or ContextBudget(
            max_tokens=self.config.max_context_tokens,
            reserved_for_response=self.config.response_reserve_tokens,
        )
        file_summaries = file_summaries or {}
        
        allocation = BudgetAllocation(
            total_budget=budget.max_tokens,
            response_reserve=budget.reserved_for_response,
        )
        
        available = budget.max_tokens - budget.reserved_for_response
        
        # Step 1: Reserve for repo summary
        if repo_summary:
            repo_tokens = self._estimate_tokens(self._format_repo_summary(repo_summary))
            allocation.repo_summary_tokens = repo_tokens
            available -= repo_tokens
        
        # Step 2: Allocate to code chunks (main budget)
        chunk_budget = int(available * 0.75)  # 75% for code
        summary_budget = available - chunk_budget  # 25% for summaries
        
        # Step 3: Add chunks until budget exhausted
        used_chunk_tokens = 0
        files_with_chunks: Set[str] = set()
        
        for cand in candidates:
            chunk_tokens = self._estimate_chunk_tokens(cand.chunk)
            
            if used_chunk_tokens + chunk_tokens <= chunk_budget:
                allocation.included_chunks.append(cand)
                used_chunk_tokens += chunk_tokens
                files_with_chunks.add(cand.chunk.file_path)
            elif chunk_tokens > chunk_budget * 0.3:
                # Chunk too large - try truncating
                truncated = self._truncate_chunk(
                    cand,
                    chunk_budget - used_chunk_tokens,
                )
                if truncated:
                    allocation.truncated_chunks.append(truncated)
                    used_chunk_tokens += self._estimate_chunk_tokens(truncated.chunk)
                else:
                    allocation.excluded_chunks.append(cand)
            else:
                allocation.excluded_chunks.append(cand)
        
        allocation.code_chunk_tokens = used_chunk_tokens
        
        # Step 4: Add file summaries for included files
        used_summary_tokens = 0
        
        # Prioritize summaries for files with included chunks
        priority_files = sorted(
            files_with_chunks,
            key=lambda f: sum(
                1 for c in allocation.included_chunks
                if c.chunk.file_path == f
            ),
            reverse=True,
        )
        
        for file_path in priority_files:
            if file_path not in file_summaries:
                continue
            
            summary = file_summaries[file_path]
            summary_tokens = self._estimate_tokens(self._format_file_summary(file_path, summary))
            
            if used_summary_tokens + summary_tokens <= summary_budget:
                allocation.included_file_summaries.append(file_path)
                used_summary_tokens += summary_tokens
        
        allocation.file_summary_tokens = used_summary_tokens
        
        # Calculate totals
        allocation.used_tokens = (
            allocation.repo_summary_tokens +
            allocation.file_summary_tokens +
            allocation.code_chunk_tokens
        )
        allocation.remaining_tokens = (
            allocation.total_budget -
            allocation.used_tokens -
            allocation.response_reserve
        )
        
        return allocation
    
    def _estimate_tokens(self, text: str) -> int:
        """Estimate token count from text."""
        return len(text) // CHARS_PER_TOKEN
    
    def _estimate_chunk_tokens(self, chunk: SemanticChunk) -> int:
        """Estimate tokens for a chunk."""
        total = 0
        
        # Signature
        if chunk.signature:
            total += self._estimate_tokens(chunk.signature)
        
        # Docstring
        if chunk.docstring:
            total += self._estimate_tokens(chunk.docstring)
        
        # Code body
        if chunk.code_body:
            total += self._estimate_tokens(chunk.code_body)
        
        # Metadata overhead (~20 tokens)
        total += 20
        
        return total
    
    def _truncate_chunk(
        self,
        candidate: RetrievalCandidate,
        max_tokens: int,
    ) -> Optional[RetrievalCandidate]:
        """
        Truncate a chunk to fit budget.
        
        Strategy: Keep signature + docstring, truncate body.
        """
        chunk = candidate.chunk
        
        # Calculate fixed parts
        fixed_tokens = 20  # Metadata
        if chunk.signature:
            fixed_tokens += self._estimate_tokens(chunk.signature)
        if chunk.docstring:
            fixed_tokens += self._estimate_tokens(chunk.docstring)
        
        if fixed_tokens >= max_tokens:
            return None
        
        # Calculate how much body we can keep
        body_budget = max_tokens - fixed_tokens
        body_chars = body_budget * CHARS_PER_TOKEN
        
        if chunk.code_body and len(chunk.code_body) > body_chars:
            # Truncate body
            truncated_body = chunk.code_body[:body_chars] + "\n# ... (truncated)"
            
            # Create new chunk with truncated body
            truncated_chunk = SemanticChunk(
                id=chunk.id + ":truncated",
                language=chunk.language,
                file_path=chunk.file_path,
                symbol_name=chunk.symbol_name,
                symbol_type=chunk.symbol_type,
                signature=chunk.signature,
                docstring=chunk.docstring,
                code_body=truncated_body,
                metadata=chunk.metadata,
            )
            
            return RetrievalCandidate(
                chunk=truncated_chunk,
                vector_score=candidate.vector_score,
                keyword_score=candidate.keyword_score,
                combined_score=candidate.combined_score * 0.8,  # Penalty
                source=candidate.source + ":truncated",
            )
        
        return candidate
    
    def _format_repo_summary(self, summary: RepoSummary) -> str:
        """Format repo summary for token estimation."""
        lines = [
            f"Architecture: {summary.architecture}",
            f"Languages: {', '.join(summary.languages)}",
            f"Frameworks: {', '.join(summary.frameworks)}",
            "Entry points: " + ", ".join(summary.entry_points),
            "Subsystems:",
        ]
        lines.extend(f"  - {s}" for s in summary.subsystems)
        lines.append("Conventions: " + ", ".join(summary.conventions))
        return "\n".join(lines)
    
    def _format_file_summary(self, file_path: str, summary: FileSummary) -> str:
        """Format file summary for token estimation."""
        lines = [
            f"## {file_path}",
            f"Responsibility: {summary.responsibility}",
            f"Public API: {', '.join(summary.public_api[:5])}",
        ]
        return "\n".join(lines)


def enforce_budget(
    candidates: List[RetrievalCandidate],
    max_tokens: int = 8000,
    repo_summary: Optional[RepoSummary] = None,
    file_summaries: Optional[Dict[str, FileSummary]] = None,
) -> BudgetAllocation:
    """Convenience function for budget enforcement."""
    enforcer = BudgetEnforcer()
    budget = ContextBudget(max_tokens=max_tokens)
    return enforcer.enforce(
        candidates,
        repo_summary=repo_summary,
        file_summaries=file_summaries,
        budget=budget,
    )


# Import Set for type hints
from typing import Set
