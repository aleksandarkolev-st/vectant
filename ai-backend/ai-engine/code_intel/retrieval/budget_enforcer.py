"""
Budget Enforcer - Enforce hard token limits.

This is step 5 of the retrieval pipeline:
1. [QueryProcessor] Embed user request ✓
2. [ContextRetriever] Vector search top-k chunks ✓
3. [GraphExpander] Expand via dependency graph ✓
4. [ContextRanker] Rank by relevance, call distance, file importance ✓
5. [BudgetEnforcer] Enforce hard token budget ← YOU ARE HERE
6. [ContextAssembler] Assemble final context

CRITICAL: Uses target model tokenizer for accurate counting.
If token counts don't match the model, context will overflow or underflow.

Budget allocation:
- Repo summary: ~300-500 tokens (fixed)
- File summaries: ~100 tokens each (variable)
- Code chunks: Remaining budget (main content)
- Reserve: ~200 tokens for model response
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field
from typing import Dict, List, Optional, Set, Tuple

from ..core.types import SemanticChunk, FileSummary, RepoSummary, ModuleSummary, ContextBudget, TokenCounter
from ..core.config import ContextConfig
from .retriever import RetrievalCandidate


logger = logging.getLogger("code_intel.retrieval.budget")


@dataclass
class BudgetAllocation:
    """How the token budget is allocated."""
    
    # Fixed allocations
    repo_summary_tokens: int = 0
    system_prompt_tokens: int = 0
    
    # Variable allocations
    file_summary_tokens: int = 0
    module_summary_tokens: int = 0
    code_chunk_tokens: int = 0
    spec_chunk_tokens: int = 0
    
    # Reserve for response
    response_reserve: int = 0
    
    # Total and remaining
    total_budget: int = 0
    used_tokens: int = 0
    remaining_tokens: int = 0
    
    # What fit
    included_chunks: List[RetrievalCandidate] = field(default_factory=list)
    included_spec_chunks: List[RetrievalCandidate] = field(default_factory=list)
    included_file_summaries: List[str] = field(default_factory=list)
    included_module_summaries: List[str] = field(default_factory=list)
    truncated_chunks: List[RetrievalCandidate] = field(default_factory=list)
    excluded_chunks: List[RetrievalCandidate] = field(default_factory=list)


class BudgetEnforcer:
    """
    Enforce token budgets for context assembly.
    
    CRITICAL: Uses target model tokenizer for accurate counting.
    
    Strategy:
    1. Reserve tokens for fixed elements (repo summary, system prompt)
    2. Allocate tokens to code chunks by rank order
    3. Fill remaining budget with file summaries
    4. Keep reserve for model response
    """
    
    def __init__(
        self,
        config: Optional[ContextConfig] = None,
        target_model: str = "gemini-gemini-3-flash-preview",
    ):
        self.config = config or ContextConfig()
        self.token_counter = TokenCounter(target_model)
    
    def enforce(
        self,
        candidates: List[RetrievalCandidate],
        spec_candidates: Optional[List[RetrievalCandidate]] = None,
        repo_summary: Optional[RepoSummary] = None,
        file_summaries: Optional[Dict[str, FileSummary]] = None,
        module_summaries: Optional[Dict[str, ModuleSummary]] = None,
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
        module_summaries = module_summaries or {}
        
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
        spec_budget = max(0, int(available * 0.10))  # 10% for specs
        chunk_budget = max(0, int(available * 0.70))  # 70% for code
        summary_budget = max(0, available - chunk_budget - spec_budget)  # 20% for summaries
        module_budget = int(summary_budget * 0.4)
        file_summary_budget = summary_budget - module_budget
        
        # Step 3: Add spec chunks first (if provided)
        used_spec_tokens = 0
        for cand in spec_candidates or []:
            chunk_tokens = self._estimate_chunk_tokens(cand.chunk)
            if used_spec_tokens + chunk_tokens <= spec_budget:
                allocation.included_spec_chunks.append(cand)
                used_spec_tokens += chunk_tokens
            else:
                allocation.excluded_chunks.append(cand)

        allocation.spec_chunk_tokens = used_spec_tokens

        # Step 4: Add chunks until budget exhausted
        used_chunk_tokens = 0
        files_with_chunks: Set[str] = set()
        max_chunks = getattr(self.config, "max_chunks", None)
        
        for cand in candidates:
            if max_chunks is not None and len(allocation.included_chunks) >= max_chunks:
                allocation.excluded_chunks.append(cand)
                continue
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
        
        # Step 5: Add module summaries
        used_summary_tokens = 0
        used_module_tokens = 0

        for module_path, summary in module_summaries.items():
            module_tokens = self._estimate_tokens(self._format_module_summary(module_path, summary))
            if used_module_tokens + module_tokens <= module_budget:
                allocation.included_module_summaries.append(module_path)
                used_module_tokens += module_tokens

        allocation.module_summary_tokens = used_module_tokens

        # Step 6: Add file summaries (prefer raw chunks; skip summaries for files with chunks)
        
        # Prioritize summaries for files with included chunks
        priority_files = sorted(
            [f for f in file_summaries.keys() if f not in files_with_chunks],
            key=lambda f: f,
        )
        
        for file_path in priority_files:
            if file_path not in file_summaries:
                continue
            
            summary = file_summaries[file_path]
            summary_tokens = self._estimate_tokens(self._format_file_summary(file_path, summary))
            
            if used_summary_tokens + summary_tokens <= file_summary_budget:
                allocation.included_file_summaries.append(file_path)
                used_summary_tokens += summary_tokens
        
        allocation.file_summary_tokens = used_summary_tokens
        
        # Calculate totals
        allocation.used_tokens = (
            allocation.repo_summary_tokens +
            allocation.module_summary_tokens +
            allocation.file_summary_tokens +
            allocation.code_chunk_tokens +
            allocation.spec_chunk_tokens
        )
        allocation.remaining_tokens = (
            allocation.total_budget -
            allocation.used_tokens -
            allocation.response_reserve
        )
        
        return allocation
    
    def _estimate_tokens(self, text: str) -> int:
        """
        Estimate token count using target model tokenizer.
        
        CRITICAL: This must match the model being prompted.
        """
        return self.token_counter.count(text)

    def _format_module_summary(self, module_path: str, summary: ModuleSummary) -> str:
        return f"## {module_path}\n{summary.summary}\n"
    
    def _estimate_chunk_tokens(self, chunk: SemanticChunk) -> int:
        """Estimate tokens for a chunk using target tokenizer."""
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
