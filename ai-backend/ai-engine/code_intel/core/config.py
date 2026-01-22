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
    # Chunking version (bump to force rebuild when chunking changes)
    chunking_version: str = "1"
    # Vector index settings
    embedding_model: str = "text-embedding-004"  # Gemini embedding model
    embedding_dimension: int = 768
    embedding_api_key: Optional[str] = field(default_factory=lambda: os.getenv("GEMINI_API_KEY"))
    
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
    top_k: int = 12  # Primary candidate count (alias for top_k_candidates)
    top_k_candidates: int = 12  # Initial vector search
    min_similarity: float = 0.5  # Minimum cosine similarity

    # Explicit candidate budgets
    vector_top_k: int = 80
    rerank_top_k: int = 40
    final_max_chunks: int = 30

    # Lexical/BM25 search
    enable_lexical: bool = True
    bm25_top_k: int = 200  # Candidate pool size for lexical search
    bm25_min_score: float = 0.0

    # Definition pull (symbol hops)
    definition_pull_top_k: int = 30
    definition_pull_symbols_per_chunk: int = 30
    
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

    # LLM summarization (Gemini)
    enable_llm_summaries: bool = True
    gemini_summary_model: str = "gemini-2.5-flash-lite"
    module_summary_max_tokens: int = 600
    symbol_summary_max_tokens: int = 200


@dataclass
class RoutingConfig:
    """Configuration for query routing."""
    enable_router: bool = True
    use_gemini_intent: bool = True
    gemini_intent_model: str = "gemini-2.5-flash-lite"
    max_seed_symbols: int = 12
    max_seed_files: int = 12
    max_seed_chunks: int = 25
    max_graph_hops: int = 2
    recent_edit_window_hours: int = 72
    hot_path_boost: float = 0.2
    recent_edit_boost: float = 0.2


@dataclass
class LspConfig:
    """Configuration for LSP enrichment."""
    enable_lsp_import: bool = False
    lsp_index_path: str = ".synthi/code_intel/lsp_index.json"


@dataclass
class ContextConfig:
    """Configuration for context management."""
    # Token limits
    max_context_tokens: int = 8000
    response_reserve_tokens: int = 500

    # Chunk cap for final context
    max_chunks: int = 30
    
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
    routing: RoutingConfig = field(default_factory=RoutingConfig)
    lsp: LspConfig = field(default_factory=LspConfig)
    context: ContextConfig = field(default_factory=ContextConfig)
    editing: EditingConfig = field(default_factory=EditingConfig)
    
    # Global settings
    debug: bool = False
    log_level: str = "INFO"
    
    # API keys (from environment)
    gemini_api_key: Optional[str] = None
    
    def __post_init__(self):
        # Load from environment
        self.gemini_api_key = os.getenv("GEMINI_API_KEY")
        
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

        if "routing" in data:
            for k, v in data["routing"].items():
                if hasattr(config.routing, k):
                    setattr(config.routing, k, v)

        if "lsp" in data:
            for k, v in data["lsp"].items():
                if hasattr(config.lsp, k):
                    setattr(config.lsp, k, v)
        
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
