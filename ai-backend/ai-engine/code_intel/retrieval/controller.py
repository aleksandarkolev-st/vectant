"""
Deterministic Retrieval Controller - Non-LLM context decision maker.

THIS IS THE CRITICAL COMPONENT.

The LLM NEVER decides what context it receives.
This controller makes all context decisions deterministically.

Responsibilities:
1. Accept query + constraints
2. Decide what enters the prompt (not the LLM)
3. Apply hard limits per module/file
4. Signal when context is insufficient
5. Return deterministic, reproducible context

Key principle: If you let the model decide context, your system is unstable by design.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field
from enum import Enum
from typing import Dict, List, Optional, Set, Tuple

from ..core.types import SemanticChunk, ContextBudget, RetrievalResult, FileSummary, RepoSummary
from ..core.config import RetrievalConfig


logger = logging.getLogger("code_intel.retrieval.controller")


class ContextSufficiency(Enum):
    """How sufficient is the assembled context."""
    
    SUFFICIENT = "sufficient"  # All requested context included
    PARTIAL = "partial"  # Some context excluded due to budget
    INSUFFICIENT = "insufficient"  # Critical context missing
    EMPTY = "empty"  # No relevant context found


@dataclass
class RefusalReason:
    """Reason why context is insufficient."""
    
    code: str  # Machine-readable code
    message: str  # Human-readable message
    missing_files: List[str] = field(default_factory=list)
    missing_symbols: List[str] = field(default_factory=list)
    
    def to_signal(self) -> str:
        """Format as signal for LLM."""
        lines = [f"⚠️ CONTEXT LIMITATION: {self.message}"]
        if self.missing_files:
            lines.append(f"Missing files: {', '.join(self.missing_files[:5])}")
            if len(self.missing_files) > 5:
                lines.append(f"  ... and {len(self.missing_files) - 5} more")
        if self.missing_symbols:
            lines.append(f"Missing symbols: {', '.join(self.missing_symbols[:5])}")
            if len(self.missing_symbols) > 5:
                lines.append(f"  ... and {len(self.missing_symbols) - 5} more")
        lines.append("\nYou should request additional context using available tools before proceeding.")
        return "\n".join(lines)


@dataclass
class ControllerDecision:
    """Decision from the retrieval controller."""
    
    # Context to include
    chunks: List[SemanticChunk]
    repo_summary: Optional[str] = None
    file_summaries: Dict[str, str] = field(default_factory=dict)
    
    # Context sufficiency
    sufficiency: ContextSufficiency = ContextSufficiency.SUFFICIENT
    refusal: Optional[RefusalReason] = None
    
    # Budget accounting
    tokens_used: int = 0
    tokens_budget: int = 0
    tokens_remaining: int = 0
    
    # What was excluded
    excluded_chunks: List[SemanticChunk] = field(default_factory=list)
    excluded_reasons: Dict[str, str] = field(default_factory=dict)
    
    # Determinism tracking
    decision_hash: str = ""
    
    def get_context_signal(self) -> Optional[str]:
        """Get signal to append to context if insufficient."""
        if self.sufficiency == ContextSufficiency.INSUFFICIENT and self.refusal:
            return self.refusal.to_signal()
        if self.sufficiency == ContextSufficiency.PARTIAL:
            return (
                "⚠️ PARTIAL CONTEXT: Some relevant code was excluded due to token limits. "
                "Request specific files/symbols if needed."
            )
        if self.sufficiency == ContextSufficiency.EMPTY:
            return (
                "⚠️ NO CONTEXT FOUND: No relevant code was found for this query. "
                "Try rephrasing or use exploration tools to find relevant files."
            )
        return None


@dataclass
class ModuleBudget:
    """Budget limits per module/directory."""
    
    max_files: int = 5
    max_chunks_per_file: int = 10
    max_tokens_per_module: int = 2000


class RetrievalController:
    """
    Deterministic controller for context assembly.
    
    This is NOT an LLM. This is deterministic logic that decides:
    - What files/chunks enter the context
    - When to signal insufficient context
    - When to refuse (and what to tell the model)
    
    The LLM sees only what this controller allows.
    """
    
    def __init__(
        self,
        config: Optional[RetrievalConfig] = None,
    ):
        self.config = config or RetrievalConfig()
        
        # Hard limits (non-negotiable)
        self.max_files_total = 20
        self.max_chunks_total = 50
        self.max_chunks_per_file = 10
        self.max_tokens_per_file = 3000
        self.max_test_files = 3  # Tests are low priority
        
        # Module-level budgets to prevent graph explosion
        self.module_budgets: Dict[str, ModuleBudget] = {}
        self.default_module_budget = ModuleBudget()
    
    def decide(
        self,
        candidates: List[SemanticChunk],
        budget: ContextBudget,
        repo_summary: Optional[RepoSummary] = None,
        file_summaries: Optional[Dict[str, FileSummary]] = None,
        required_files: Optional[List[str]] = None,
        required_symbols: Optional[List[str]] = None,
    ) -> ControllerDecision:
        """
        Make a deterministic decision about what context to include.
        
        Args:
            candidates: Ranked candidates from retrieval pipeline
            budget: Token budget constraints
            repo_summary: Repository summary (cheap context)
            file_summaries: Per-file summaries (cheap context)
            required_files: Files that MUST be included (or signal insufficient)
            required_symbols: Symbols that MUST be included (or signal insufficient)
            
        Returns:
            ControllerDecision with selected context
        """
        import hashlib
        
        # Initialize decision
        decision = ControllerDecision(
            chunks=[],
            tokens_budget=budget.max_tokens,
        )
        
        # Start with summaries (cheap context)
        tokens_used = 0
        
        if repo_summary:
            tokens_used += repo_summary.token_count
            decision.repo_summary = repo_summary.content
        
        file_summaries = file_summaries or {}
        
        # Track what we include
        included_files: Set[str] = set()
        included_symbols: Set[str] = set()
        file_chunk_counts: Dict[str, int] = {}
        module_token_counts: Dict[str, int] = {}
        
        # Track exclusions
        excluded: List[SemanticChunk] = []
        exclusion_reasons: Dict[str, str] = {}
        
        # Process candidates in rank order (deterministic)
        for chunk in candidates:
            file_path = chunk.metadata.file_path
            symbol_name = chunk.metadata.symbol_name
            module = self._get_module(file_path)
            chunk_tokens = chunk.metadata.token_count
            
            # Check hard limits
            
            # 1. Total file limit
            if file_path not in included_files and len(included_files) >= self.max_files_total:
                excluded.append(chunk)
                exclusion_reasons[chunk.id] = "max_files_exceeded"
                continue
            
            # 2. Total chunk limit
            if len(decision.chunks) >= self.max_chunks_total:
                excluded.append(chunk)
                exclusion_reasons[chunk.id] = "max_chunks_exceeded"
                continue
            
            # 3. Per-file chunk limit
            file_chunk_counts.setdefault(file_path, 0)
            if file_chunk_counts[file_path] >= self.max_chunks_per_file:
                excluded.append(chunk)
                exclusion_reasons[chunk.id] = "max_chunks_per_file_exceeded"
                continue
            
            # 4. Per-module token limit
            module_budget = self.module_budgets.get(module, self.default_module_budget)
            module_token_counts.setdefault(module, 0)
            if module_token_counts[module] + chunk_tokens > module_budget.max_tokens_per_module:
                excluded.append(chunk)
                exclusion_reasons[chunk.id] = "module_budget_exceeded"
                continue
            
            # 5. Test file limit
            if chunk.metadata.is_test:
                test_count = sum(1 for c in decision.chunks if c.metadata.is_test)
                if test_count >= self.max_test_files:
                    excluded.append(chunk)
                    exclusion_reasons[chunk.id] = "test_file_limit_exceeded"
                    continue
            
            # 6. Total token budget
            if tokens_used + chunk_tokens > budget.available_tokens:
                excluded.append(chunk)
                exclusion_reasons[chunk.id] = "token_budget_exceeded"
                continue
            
            # Include this chunk
            decision.chunks.append(chunk)
            tokens_used += chunk_tokens
            included_files.add(file_path)
            if symbol_name:
                included_symbols.add(symbol_name)
            file_chunk_counts[file_path] += 1
            module_token_counts[module] += chunk_tokens
            
            # Include file summary if not already
            if file_path in file_summaries and file_path not in decision.file_summaries:
                fs = file_summaries[file_path]
                if tokens_used + fs.token_count <= budget.available_tokens:
                    decision.file_summaries[file_path] = fs.content
                    tokens_used += fs.token_count
        
        # Store exclusions
        decision.excluded_chunks = excluded
        decision.excluded_reasons = exclusion_reasons
        
        # Calculate sufficiency
        decision.tokens_used = tokens_used
        decision.tokens_remaining = budget.available_tokens - tokens_used
        
        # Check required files/symbols
        missing_files = []
        missing_symbols = []
        
        if required_files:
            missing_files = [f for f in required_files if f not in included_files]
        
        if required_symbols:
            missing_symbols = [s for s in required_symbols if s not in included_symbols]
        
        # Determine sufficiency
        if not decision.chunks:
            decision.sufficiency = ContextSufficiency.EMPTY
            decision.refusal = RefusalReason(
                code="no_context",
                message="No relevant code found for this query.",
            )
        elif missing_files or missing_symbols:
            decision.sufficiency = ContextSufficiency.INSUFFICIENT
            decision.refusal = RefusalReason(
                code="missing_required",
                message="Required context could not be included.",
                missing_files=missing_files,
                missing_symbols=missing_symbols,
            )
        elif excluded:
            decision.sufficiency = ContextSufficiency.PARTIAL
        else:
            decision.sufficiency = ContextSufficiency.SUFFICIENT
        
        # Generate determinism hash
        chunk_ids = sorted([c.id for c in decision.chunks])
        hash_input = "|".join(chunk_ids)
        decision.decision_hash = hashlib.md5(hash_input.encode()).hexdigest()[:12]
        
        logger.info(
            f"Controller decision: {len(decision.chunks)} chunks, "
            f"{tokens_used}/{budget.max_tokens} tokens, "
            f"sufficiency={decision.sufficiency.value}, "
            f"hash={decision.decision_hash}"
        )
        
        return decision
    
    def _get_module(self, file_path: str) -> str:
        """Extract module/directory from file path."""
        parts = file_path.replace("\\", "/").split("/")
        if len(parts) > 1:
            return parts[0]
        return "root"
    
    def set_module_budget(
        self,
        module: str,
        max_files: int = 5,
        max_chunks_per_file: int = 10,
        max_tokens: int = 2000,
    ) -> None:
        """Set custom budget for a specific module."""
        self.module_budgets[module] = ModuleBudget(
            max_files=max_files,
            max_chunks_per_file=max_chunks_per_file,
            max_tokens_per_module=max_tokens,
        )
    
    def format_context(
        self,
        decision: ControllerDecision,
        include_signal: bool = True,
    ) -> str:
        """
        Format the decision into LLM-ready context.
        
        Deterministic ordering:
        1. Repo summary (if present)
        2. File summaries (sorted by path)
        3. Code chunks (in rank order)
        4. Context signal (if insufficient)
        """
        sections = []
        
        # 1. Repo summary
        if decision.repo_summary:
            sections.append("## Repository Overview\n" + decision.repo_summary)
        
        # 2. File summaries (deterministic order)
        if decision.file_summaries:
            summary_lines = ["## File Summaries"]
            for path in sorted(decision.file_summaries.keys()):
                summary_lines.append(f"### {path}")
                summary_lines.append(decision.file_summaries[path])
            sections.append("\n".join(summary_lines))
        
        # 3. Code chunks (maintain rank order)
        if decision.chunks:
            chunk_lines = ["## Code Context"]
            for chunk in decision.chunks:
                meta = chunk.metadata
                header = f"### {meta.file_path}"
                if meta.symbol_name:
                    header += f" :: {meta.symbol_name}"
                header += f" (lines {meta.start_line}-{meta.end_line})"
                chunk_lines.append(header)
                chunk_lines.append(f"```{meta.language or ''}\n{chunk.content}\n```")
            sections.append("\n".join(chunk_lines))
        
        # 4. Context signal
        if include_signal:
            signal = decision.get_context_signal()
            if signal:
                sections.append(signal)
        
        return "\n\n".join(sections)


def create_controller(config: Optional[RetrievalConfig] = None) -> RetrievalController:
    """Create a retrieval controller with default configuration."""
    return RetrievalController(config)
