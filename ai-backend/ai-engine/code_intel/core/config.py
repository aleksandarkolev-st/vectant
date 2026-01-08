"""
Configuration for the Code Intelligence System.

All tunable parameters in one place.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Dict, List, Optional
import os


@dataclass
class ParserConfig:
    """Configuration for code parsers."""
    # Languages to support
    enabled_languages: List[str] = field(default_factory=lambda: [
        "python", "typescript", "javascript", "java", "go", "rust", "cpp", "c"
    ])
    
    # Files to ignore (glob patterns)
    ignore_patterns: List[str] = field(default_factory=lambda: [
        "node_modules/**",
        ".git/**",
        "__pycache__/**",
        "*.pyc",
        "dist/**",
        "build/**",
        ".next/**",
        "venv/**",
        ".venv/**",
        "*.min.js",
        "*.min.css",
        "*.map",
        "package-lock.json",
        "yarn.lock",
        "*.lock",
    ])
    
    # Max file size to parse (bytes)
    max_file_size: int = 500_000  # 500KB
    
    # Max depth for nested symbols
    max_symbol_depth: int = 5


@dataclass
class IndexerConfig:
    """Configuration for the dual indexer."""
    # Vector index settings
    embedding_model: str = "text-embedding-3-small"
    embedding_dimension: int = 1536
    
    # Structural index settings
    store_call_graph: bool = True
    store_import_graph: bool = True
    store_inheritance_graph: bool = True
    
    # Index persistence
    persist_to_disk: bool = True
    index_directory: str = ".synthi/code_intel"
    
    # Re-indexing threshold (0-1, lower = more aggressive)
    change_threshold: float = 0.1


@dataclass
class RetrievalConfig:
    """Configuration for context retrieval."""
    # Vector search
    top_k_candidates: int = 12  # Initial vector search
    min_similarity: float = 0.5  # Minimum cosine similarity
    
    # Structural expansion
    max_expansion_depth: int = 2
    max_expanded_chunks: int = 20
    
    # Ranking weights
    weight_relevance: float = 0.4
    weight_call_distance: float = 0.3
    weight_file_importance: float = 0.2
    weight_recency: float = 0.1
    
    # Budget
    default_budget_tokens: int = 8000
    
    # Safeguards
    max_files_per_subsystem: int = 5
    never_mix_test_prod: bool = True
    prefer_public_over_internal: bool = True


@dataclass
class SummaryConfig:
    """Configuration for summary generation."""
    # File summary
    file_summary_max_lines: int = 8
    file_summary_max_tokens: int = 150
    
    # Repo summary
    repo_summary_max_tokens: int = 800
    repo_summary_max_entry_points: int = 5
    repo_summary_max_subsystems: int = 8
    
    # Regeneration
    regenerate_on_change: bool = True
    summary_staleness_hours: int = 24


@dataclass
class ContextConfig:
    """Configuration for context management."""
    # Eviction
    context_expires_each_turn: bool = True
    pin_summaries: bool = True
    pin_raw_code: bool = False  # Never pin raw code
    
    # Overflow handling
    overflow_strategy: str = "drop_lowest_ranked"  # or "truncate"
    
    # Safety
    max_context_age_turns: int = 3  # Force eviction after N turns


@dataclass
class EditingConfig:
    """Configuration for editing workflow."""
    # Context loading
    load_target_symbol: bool = True
    load_direct_dependencies: bool = True
    load_callers: bool = False
    
    # Safety
    lock_context_during_edit: bool = True
    re_index_after_edit: bool = True
    
    # Verification
    verify_edit_compiles: bool = True
    verify_edit_passes_tests: bool = False


@dataclass
class CodeIntelConfig:
    """
    Master configuration for the Code Intelligence System.
    
    Load from environment, file, or use defaults.
    """
    parser: ParserConfig = field(default_factory=ParserConfig)
    indexer: IndexerConfig = field(default_factory=IndexerConfig)
    retrieval: RetrievalConfig = field(default_factory=RetrievalConfig)
    summary: SummaryConfig = field(default_factory=SummaryConfig)
    context: ContextConfig = field(default_factory=ContextConfig)
    editing: EditingConfig = field(default_factory=EditingConfig)
    
    # Global settings
    debug: bool = False
    log_level: str = "INFO"
    
    # API keys (from environment)
    openai_api_key: Optional[str] = None
    
    def __post_init__(self):
        # Load from environment
        self.openai_api_key = os.getenv("OPENAI_API_KEY")
        
        if os.getenv("CODE_INTEL_DEBUG"):
            self.debug = True
            self.log_level = "DEBUG"
    
    @classmethod
    def from_dict(cls, data: Dict) -> "CodeIntelConfig":
        """Create config from dictionary."""
        config = cls()
        
        if "parser" in data:
            for k, v in data["parser"].items():
                if hasattr(config.parser, k):
                    setattr(config.parser, k, v)
        
        if "indexer" in data:
            for k, v in data["indexer"].items():
                if hasattr(config.indexer, k):
                    setattr(config.indexer, k, v)
        
        if "retrieval" in data:
            for k, v in data["retrieval"].items():
                if hasattr(config.retrieval, k):
                    setattr(config.retrieval, k, v)
        
        if "summary" in data:
            for k, v in data["summary"].items():
                if hasattr(config.summary, k):
                    setattr(config.summary, k, v)
        
        if "context" in data:
            for k, v in data["context"].items():
                if hasattr(config.context, k):
                    setattr(config.context, k, v)
        
        if "editing" in data:
            for k, v in data["editing"].items():
                if hasattr(config.editing, k):
                    setattr(config.editing, k, v)
        
        return config


# Global config singleton
_config: Optional[CodeIntelConfig] = None


def get_config() -> CodeIntelConfig:
    """Get the global configuration."""
    global _config
    if _config is None:
        _config = CodeIntelConfig()
    return _config


def set_config(config: CodeIntelConfig) -> None:
    """Set the global configuration."""
    global _config
    _config = config
