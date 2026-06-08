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
    chunking_version: str = "2"
    # Chunk sizing
    max_chunk_tokens: int = 2000
    language_chunk_tokens: Dict[str, int] = field(default_factory=lambda: {
        "typescript": 1800,
        "javascript": 1800,
        "python": 1400,
        "go": 1600,
        "rust": 1600,
    })
    # Vector index settings
    embedding_model: str = "gemini-embedding-001"  # Newer Gemini embedding model
    embedding_dimension: int = 3072
    embedding_api_key: Optional[str] = field(default_factory=lambda: os.getenv("GEMINI_API_KEY"))
    # Embedding throughput
    embedding_batch_size: int = 128
    
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

    # Explicit candidate budgets (optimized for faster response)
    vector_top_k: int = 40  # Reduced from 80 for faster search
    rerank_top_k: int = 25  # Reduced from 40
    final_max_chunks: int = 20  # Reduced from 30 for faster assembly

    # Lexical/BM25 search
    enable_lexical: bool = True
    bm25_top_k: int = 100  # Reduced from 200 for faster search
    bm25_min_score: float = 0.0

    # Definition pull (symbol hops)
    definition_pull_top_k: int = 20  # Reduced from 30
    definition_pull_symbols_per_chunk: int = 20  # Reduced from 30
    
    # Structural expansion (optimized for faster response)
    max_expansion_depth: int = 2  # Reduced from 3
    max_expanded_chunks: int = 20  # Reduced from 30
    
    # Ranking weights
    weight_relevance: float = 0.4
    weight_call_distance: float = 0.3
    weight_file_importance: float = 0.2
    weight_recency: float = 0.1
    
    # Budget
    default_budget_tokens: int = 12000

    # Dynamic budgets by query intent
    enable_dynamic_budgets: bool = True
    intent_budget_tokens: Dict[str, int] = field(default_factory=lambda: {
        "find": 6000,
        "understand": 12000,
        "modify": 14000,
        "debug": 14000,
        "create": 12000,
        "review": 10000,
    })
    intent_max_chunks: Dict[str, int] = field(default_factory=lambda: {
        "find": 20,
        "understand": 35,
        "modify": 40,
        "debug": 40,
        "create": 30,
        "review": 30,
    })

    # Multi-pass retrieval (relax thresholds if too few candidates)
    # Disabled by default for faster response - enable for better recall
    enable_multi_pass: bool = False  # Changed from True for faster response
    multi_pass_min_candidates: int = 8
    multi_pass_min_similarity: float = 0.35
    multi_pass_vector_top_k: int = 80  # Reduced from 120
    multi_pass_bm25_top_k: int = 200  # Reduced from 300
    multi_pass_include_tests: bool = True

    # LLM reranker (optional)
    enable_llm_rerank: bool = False
    llm_rerank_model: str = "gemini-3.1-flash-lite"
    llm_rerank_top_k: int = 20
    llm_rerank_min_score: float = 0.15
    llm_rerank_timeout_ms: int = 6000
    
    # Safeguards
    max_files_per_subsystem: int = 5
    never_mix_test_prod: bool = True
    prefer_public_over_internal: bool = True

    # Two-tier retrieval (fast path + slow path)
    enable_two_tier: bool = True
    fast_bm25_top_k: int = 30
    fast_vector_top_k: int = 8
    fast_min_candidates: int = 6
    fast_confidence_threshold: float = 0.55

    # Aggressive scoping
    aggressive_scoping: bool = True
    enforce_module_scope: bool = True
    enforce_folder_scope: bool = True

    # Multi-index specialization (tests/interfaces/infra/core)
    enable_multi_index: bool = True
    index_kind_default: str = "core"

    # Spec-first retrieval (docs/tests as specs)
    enable_spec_layer: bool = True
    spec_min_alignment: float = 0.2
    spec_required_chunks: int = 2
    spec_max_chunks: int = 4
    spec_chunk_chars: int = 1400
    spec_doc_globs: List[str] = field(default_factory=lambda: [
        "docs/**", "README*", "**/*.md",
    ])
    spec_test_globs: List[str] = field(default_factory=lambda: [
        "tests/**", "**/__tests__/**", "**/*test*.*", "**/*spec*.*",
    ])

    # Edits-aware retrieval
    recency_decay_hours: float = 72.0
    recency_max_boost: float = 0.25

    # Hybrid fusion (Reciprocal Rank Fusion + Maximal Marginal Relevance).
    # mmr_head_size caps how many top-RRF candidates we diversify — MMR is
    # O(K^2) so we don't rerun it over the long tail. mmr_lambda balances
    # relevance vs. novelty; 0.7 is the standard code-search default.
    mmr_head_size: int = 32
    mmr_lambda: float = 0.7

    # Change impact neighborhoods (git history)
    enable_change_impact: bool = True
    change_impact_commits: int = 200
    change_impact_max_neighbors: int = 20
    change_impact_boost: float = 0.15

    # Caching
    enable_retrieval_cache: bool = True
    cache_ttl_seconds: int = 300
    cache_max_entries: int = 200
    cache_min_candidates: int = 6

    # Reranking budget
    rerank_max_k: int = 20
    rerank_skip_confidence: float = 0.78

    # Active retrieval depth (answerability-driven)
    enable_active_retrieval: bool = True
    answerability_min_score: float = 0.48
    answerability_min_candidates: int = 8


@dataclass
class SummaryConfig:
    """Configuration for summary generation."""
    # File summary
    file_summary_max_lines: int = 6
    file_summary_max_tokens: int = 120
    
    # Repo summary
    repo_summary_max_tokens: int = 600
    repo_summary_max_entry_points: int = 5
    repo_summary_max_subsystems: int = 8
    
    # Regeneration
    regenerate_on_change: bool = True
    summary_staleness_hours: int = 24

    # LLM summarization (Gemini)
    enable_llm_summaries: bool = True
    gemini_summary_model: str = "gemini-3.1-flash-lite"
    module_summary_max_tokens: int = 400
    symbol_summary_max_tokens: int = 150


@dataclass
class RoutingConfig:
    """Configuration for query routing."""
    enable_router: bool = True
    use_gemini_intent: bool = True
    gemini_intent_model: str = "gemini-3.1-flash-lite"
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
    max_context_tokens: int = 200_000
    response_reserve_tokens: int = 2000

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

    # Redaction (security)
    redact_secrets: bool = True
    redaction_patterns: List[str] = field(default_factory=lambda: [
        r"(?i)api[_-]?key\s*[:=]\s*['\"]?[A-Za-z0-9_\-]{16,}['\"]?",
        r"(?i)secret\s*[:=]\s*['\"]?[A-Za-z0-9_\-]{16,}['\"]?",
        r"(?i)token\s*[:=]\s*['\"]?[A-Za-z0-9_\-]{16,}['\"]?",
        r"(?i)access[_-]?token\s*[:=]\s*['\"]?[A-Za-z0-9_\-]{16,}['\"]?",
        r"-----BEGIN(?:.|\n)*?PRIVATE KEY-----[\s\S]*?-----END(?:.|\n)*?PRIVATE KEY-----",
    ])


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
    
    # RAG subsystem (4-step retrieval-augmented generation)
    enable_rag: bool = True
    
    # Global settings
    debug: bool = False
    log_level: str = "INFO"
    
    # API keys (from environment)
    gemini_api_key: Optional[str] = None
    
    def __post_init__(self):
        # Load from environment
        self.gemini_api_key = os.getenv("GEMINI_API_KEY")

        if os.getenv("CODE_INTEL_LLM_RERANK", "").lower() == "true":
            self.retrieval.enable_llm_rerank = True
        if os.getenv("CODE_INTEL_MULTI_PASS", "").lower() == "false":
            self.retrieval.enable_multi_pass = False
        if os.getenv("CODE_INTEL_DYNAMIC_BUDGETS", "").lower() == "false":
            self.retrieval.enable_dynamic_budgets = False
        if os.getenv("CODE_INTEL_RAG", "").lower() == "false":
            self.enable_rag = False
        
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
