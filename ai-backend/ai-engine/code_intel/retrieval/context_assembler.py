"""
Context Assembler - Assemble final context for the LLM.

This is step 6 (final) of the retrieval pipeline:
1. [QueryProcessor] Embed user request ✓
2. [ContextRetriever] Vector search top-k chunks ✓
3. [GraphExpander] Expand via dependency graph ✓
4. [ContextRanker] Rank by relevance, call distance, file importance ✓
5. [BudgetEnforcer] Enforce hard token budget ✓
6. [ContextAssembler] Assemble final context ← YOU ARE HERE

Output format:
```
# Repository Overview
{repo_summary}

# Relevant Files
{file_summaries}

# Code Context
{code_chunks}

# Note
{missing_context_note}
```
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field
from typing import Dict, List, Optional

from ..core.types import SemanticChunk, FileSummary, RepoSummary, ModuleSummary
from ..core.config import ContextConfig
from .retriever import RetrievalCandidate
from .budget_enforcer import BudgetAllocation


logger = logging.getLogger("code_intel.retrieval.assembler")


@dataclass
class AssembledContext:
    """Final assembled context ready for LLM."""
    
    # The formatted context string
    content: str
    
    # Metadata
    total_tokens: int = 0
    chunk_count: int = 0
    file_count: int = 0
    
    # What was included
    included_files: List[str] = field(default_factory=list)
    included_symbols: List[str] = field(default_factory=list)
    included_chunk_ids: List[str] = field(default_factory=list)
    
    # What was excluded (for transparency)
    excluded_count: int = 0
    truncation_note: Optional[str] = None


class ContextAssembler:
    """
    Assemble final context string for LLM consumption.
    
    Principles:
    - Structure context hierarchically (overview → details)
    - Group code by file for coherence
    - Include provenance (where code came from)
    - Note what's missing for transparency
    """
    
    def __init__(self, config: Optional[ContextConfig] = None):
        self.config = config or ContextConfig()
    
    def assemble(
        self,
        allocation: BudgetAllocation,
        repo_summary: Optional[RepoSummary] = None,
        file_summaries: Optional[Dict[str, FileSummary]] = None,
        module_summaries: Optional[Dict[str, ModuleSummary]] = None,
        query_summary: Optional[str] = None,
    ) -> AssembledContext:
        """
        Assemble context from budget allocation.
        
        Args:
            allocation: Budget allocation with included chunks
            repo_summary: Repository summary
            file_summaries: Map of file path -> summary
            query_summary: Brief description of what was searched
            
        Returns:
            AssembledContext ready for LLM
        """
        file_summaries = file_summaries or {}
        module_summaries = module_summaries or {}
        sections = []
        
        # Section 1: Repository Overview
        if repo_summary:
            sections.append(self._format_repo_section(repo_summary))
        
        # Section 2: Module Summaries
        if allocation.included_module_summaries:
            module_section = self._format_module_summaries_section(
                allocation.included_module_summaries,
                module_summaries,
            )
            if module_section:
                sections.append(module_section)

        # Section 3: File Summaries
        if allocation.included_file_summaries:
            summaries_section = self._format_file_summaries_section(
                allocation.included_file_summaries,
                file_summaries,
            )
            if summaries_section:
                sections.append(summaries_section)
        
        # Section 4: Code Chunks (grouped by file)
        code_section = self._format_code_section(
            allocation.included_chunks,
            allocation.truncated_chunks,
        )
        if code_section:
            sections.append(code_section)
        
        # Section 5: Missing Context Note
        if allocation.excluded_chunks:
            note = self._format_missing_note(
                allocation.excluded_chunks,
                allocation.remaining_tokens,
            )
            sections.append(note)
        
        # Combine sections
        content = "\n\n".join(sections)

        # Redact secrets from assembled context
        if getattr(self.config, "redact_secrets", False):
            content = self._redact(content)
        
        # Collect metadata
        included_files = list(set(
            c.chunk.file_path for c in allocation.included_chunks
        ))
        included_symbols = [
            c.chunk.symbol_name for c in allocation.included_chunks
            if c.chunk.symbol_name
        ]
        included_chunk_ids = [
            c.chunk.id for c in allocation.included_chunks
            if c.chunk.id
        ]
        
        return AssembledContext(
            content=content,
            total_tokens=allocation.used_tokens,
            chunk_count=len(allocation.included_chunks),
            file_count=len(included_files),
            included_files=included_files,
            included_symbols=included_symbols,
            included_chunk_ids=included_chunk_ids,
            excluded_count=len(allocation.excluded_chunks),
            truncation_note=self._get_truncation_note(allocation),
        )

    def _redact(self, text: str) -> str:
        import re

        redacted = text
        patterns = getattr(self.config, "redaction_patterns", []) or []
        for pattern in patterns:
            try:
                redacted = re.sub(pattern, "[REDACTED]", redacted)
            except re.error:
                continue
        return redacted
    
    def _format_repo_section(self, summary: RepoSummary) -> str:
        """Format repository overview section."""
        lines = [
            "# Repository Overview",
            "",
            f"**Architecture**: {summary.architecture}",
            f"**Languages**: {', '.join(summary.languages)}",
        ]
        
        if summary.frameworks:
            lines.append(f"**Frameworks**: {', '.join(summary.frameworks)}")
        
        if summary.entry_points:
            lines.append(f"**Entry Points**: {', '.join(summary.entry_points[:3])}")
        
        if summary.subsystems:
            lines.append("")
            lines.append("**Subsystems**:")
            for subsystem in summary.subsystems[:5]:
                lines.append(f"- {subsystem}")
        
        if summary.conventions:
            lines.append("")
            lines.append(f"**Conventions**: {', '.join(summary.conventions)}")
        
        return "\n".join(lines)
    
    def _format_file_summaries_section(
        self,
        file_paths: List[str],
        summaries: Dict[str, FileSummary],
    ) -> str:
        """Format file summaries section."""
        lines = [
            "# Relevant Files",
            "",
        ]
        
        for path in file_paths:
            if path not in summaries:
                continue
            
            summary = summaries[path]
            lines.append(f"## {path}")
            lines.append(f"- **Purpose**: {summary.responsibility}")
            
            if summary.public_api:
                api_preview = ", ".join(summary.public_api[:5])
                if len(summary.public_api) > 5:
                    api_preview += f" (+{len(summary.public_api) - 5} more)"
                lines.append(f"- **Public API**: {api_preview}")
            
            if summary.side_effects:
                lines.append(f"- **Side Effects**: {', '.join(summary.side_effects)}")
            
            lines.append("")
        
        return "\n".join(lines)

    def _format_module_summaries_section(
        self,
        module_paths: List[str],
        summaries: Dict[str, ModuleSummary],
    ) -> str:
        lines = [
            "# Module Summaries",
            "",
        ]
        for path in module_paths:
            summary = summaries.get(path)
            if not summary:
                continue
            lines.append(f"## {path}")
            lines.append(summary.summary)
            lines.append("")
        return "\n".join(lines)
    
    def _format_code_section(
        self,
        chunks: List[RetrievalCandidate],
        truncated: List[RetrievalCandidate],
    ) -> str:
        """Format code chunks section."""
        if not chunks and not truncated:
            return ""
        
        lines = [
            "# Code Context",
            "",
        ]
        
        # Group by file
        chunks_by_file: Dict[str, List[RetrievalCandidate]] = {}
        
        all_chunks = chunks + truncated
        for cand in all_chunks:
            file_path = cand.chunk.file_path
            if file_path not in chunks_by_file:
                chunks_by_file[file_path] = []
            chunks_by_file[file_path].append(cand)
        
        # Sort files by average score
        sorted_files = sorted(
            chunks_by_file.keys(),
            key=lambda f: sum(c.combined_score for c in chunks_by_file[f]) / len(chunks_by_file[f]),
            reverse=True,
        )
        
        for file_path in sorted_files:
            file_chunks = chunks_by_file[file_path]
            
            # Sort chunks within file by line number or score
            file_chunks.sort(key=lambda c: (
                c.chunk.metadata.start_line if c.chunk.metadata else 0,
            ))
            
            lines.append(f"## {file_path}")
            lines.append("")
            
            for cand in file_chunks:
                chunk = cand.chunk
                
                # Add symbol header
                symbol_header = self._format_symbol_header(chunk)
                if symbol_header:
                    lines.append(symbol_header)
                
                # Add code block
                lang = chunk.language or ""
                lines.append(f"```{lang}")
                
                # Include signature if separate
                if chunk.signature and chunk.code_body and chunk.signature not in chunk.code_body:
                    lines.append(chunk.signature)
                
                # Include code body
                if chunk.code_body:
                    lines.append(chunk.code_body)
                
                lines.append("```")
                lines.append("")
        
        return "\n".join(lines)
    
    def _format_symbol_header(self, chunk: SemanticChunk) -> str:
        """Format header for a code symbol."""
        parts = []
        
        if chunk.symbol_type:
            parts.append(chunk.symbol_type.capitalize())
        
        if chunk.symbol_name:
            parts.append(f"`{chunk.symbol_name}`")
        
        if chunk.metadata and chunk.metadata.start_line:
            parts.append(f"(lines {chunk.metadata.start_line}-{chunk.metadata.end_line})")
        
        if not parts:
            return ""
        
        return "### " + " ".join(parts)
    
    def _format_missing_note(
        self,
        excluded: List[RetrievalCandidate],
        remaining_tokens: int,
    ) -> str:
        """Format note about excluded context."""
        lines = [
            "# Additional Context Available",
            "",
            f"*{len(excluded)} additional code sections were found but not included due to token limits.*",
            "",
            "Excluded sections:",
        ]
        
        # List top excluded items
        for cand in excluded[:5]:
            chunk = cand.chunk
            name = chunk.symbol_name or chunk.file_path.split("/")[-1]
            lines.append(f"- {name} ({chunk.symbol_type or 'code'})")
        
        if len(excluded) > 5:
            lines.append(f"- ... and {len(excluded) - 5} more")
        
        lines.append("")
        lines.append("*Use exploration tools to request specific sections if needed.*")
        
        return "\n".join(lines)
    
    def _get_truncation_note(self, allocation: BudgetAllocation) -> Optional[str]:
        """Get truncation note if any chunks were truncated."""
        if not allocation.truncated_chunks:
            return None
        
        return f"{len(allocation.truncated_chunks)} chunk(s) were truncated to fit token budget"


def assemble_context(
    allocation: BudgetAllocation,
    repo_summary: Optional[RepoSummary] = None,
    file_summaries: Optional[Dict[str, FileSummary]] = None,
) -> AssembledContext:
    """Convenience function for context assembly."""
    assembler = ContextAssembler()
    return assembler.assemble(
        allocation,
        repo_summary=repo_summary,
        file_summaries=file_summaries,
    )
