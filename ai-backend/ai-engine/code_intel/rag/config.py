"""
Configuration for the RAG subsystem.

All tunable parameters in one place, following the same pattern
as the parent CodeIntelConfig.
"""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from typing import Dict, List, Optional

# Load .env so GEMINI_API_KEY is available via os.getenv
try:
    from dotenv import load_dotenv
    load_dotenv()
except ImportError:
    pass


@dataclass
class IngestionConfig:
    """Configuration for the dual-ingestion pipeline (Step 1)."""

    # Supported file extensions for document ingestion
    document_extensions: List[str] = field(default_factory=lambda: [
        ".md", ".markdown", ".txt", ".rst", ".html", ".htm",
    ])

    # Code file extensions (for code-as-documentation)
    code_extensions: List[str] = field(default_factory=lambda: [
        ".py", ".ts", ".js", ".tsx", ".jsx", ".java", ".go",
        ".rs", ".cpp", ".c", ".h", ".hpp",
    ])

    # Glob patterns to ignore
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
    ])

    # Maximum file size for ingestion (bytes)
    max_file_size: int = 2_000_000  # 2MB

    # ToC extraction
    max_toc_depth: int = 6           # Maximum heading depth to index
    min_section_tokens: int = 20      # Skip sections smaller than this
    max_section_tokens: int = 4000    # Split sections larger than this

    # Summary generation
    summary_max_tokens: int = 200     # Max tokens for document summary
    summary_max_topics: int = 8       # Max topics per document
    summary_max_entities: int = 12    # Max entities per document

    # Content hashing
    hash_algorithm: str = "sha256"

    # Keyword extraction
    max_keywords_per_section: int = 10
    max_keywords_per_document: int = 25


@dataclass
class StoreConfig:
    """Configuration for the persistence layer."""

    # Storage directory (relative to workspace root)
    store_directory: str = ".synthi/rag"

    # Filenames
    documents_file: str = "documents.json"
    toc_file: str = "toc_trees.json"
    summaries_file: str = "summaries.json"
    sections_file: str = "sections.json"
    vectors_file: str = "summary_vectors.npz"
    keyword_index_file: str = "keyword_index.json"

    # Atomic write safety
    use_atomic_writes: bool = True

    # Memory limits
    max_cached_documents: int = 1000
    max_cached_sections: int = 10000

    # Compaction
    enable_compaction: bool = True
    compaction_threshold: int = 100    # Compact after N deletions


@dataclass
class MacroConfig:
    """Configuration for macro-retrieval (Step 2)."""

    # Vector search
    vector_top_k: int = 10            # Initial vector search candidates
    min_similarity: float = 0.3       # Minimum cosine similarity threshold

    # Keyword search
    enable_keyword: bool = True
    keyword_top_k: int = 20           # BM25 candidates
    keyword_min_score: float = 0.0

    # Hybrid scoring weights
    vector_weight: float = 0.6
    keyword_weight: float = 0.3
    recency_weight: float = 0.1

    # Final selection
    max_documents: int = 5            # Maximum documents to pass to micro-nav
    min_documents: int = 1            # Minimum documents (relax thresholds if needed)

    # Performance
    timeout_ms: int = 500             # Macro-retrieval timeout


@dataclass
class MicroConfig:
    """Configuration for micro-navigation (Step 3)."""

    # Routing model (fast LLM for ToC navigation)
    routing_model: str = "gemini-3.1-flash-lite-preview"
    routing_api_key: Optional[str] = field(
        default_factory=lambda: os.getenv("GEMINI_API_KEY")
    )

    # Navigation parameters
    max_sections_per_document: int = 5     # Max sections to extract per doc
    max_total_sections: int = 15           # Max total sections across all docs
    max_navigation_depth: int = 4          # Max depth to traverse in ToC tree
    max_routing_calls: int = 10            # Max LLM calls for routing

    # Scoring
    min_relevance_score: float = 0.3       # Minimum relevance to include section
    include_sibling_context: bool = True   # Include adjacent sections for context

    # Performance
    routing_timeout_ms: int = 3000         # Per-routing-call timeout
    total_timeout_ms: int = 10000          # Total micro-navigation timeout

    # Fallback
    fallback_to_top_sections: bool = True  # If routing fails, use top N by token count


@dataclass
class SynthesisConfig:
    """Configuration for heavy synthesis (Step 4)."""

    # Synthesis model (heavy reasoning LLM)
    synthesis_model: str = "gemini-3.1-flash-lite-preview"
    synthesis_api_key: Optional[str] = field(
        default_factory=lambda: os.getenv("GEMINI_API_KEY")
    )

    # Token budgets
    max_context_tokens: int = 8000         # Max tokens for context window
    max_answer_tokens: int = 2000          # Max tokens for generated answer
    reserved_for_prompt: int = 500         # Reserved for system prompt

    # Citation
    enable_citations: bool = True
    min_citation_confidence: float = 0.5   # Min confidence for citation inclusion
    max_citations: int = 10                # Max citations per answer

    # Confidence scoring
    enable_confidence_scoring: bool = True
    low_confidence_threshold: float = 0.3  # Below this, add uncertainty warning

    # Performance
    synthesis_timeout_ms: int = 30000      # Synthesis timeout

    # Answer quality
    require_grounding: bool = True         # Answer must be grounded in sources
    allow_partial_answers: bool = True     # Allow answers with incomplete info


@dataclass
class RAGConfig:
    """
    Master configuration for the RAG subsystem.

    Follows the same pattern as CodeIntelConfig for consistency.
    Load from environment, file, or use defaults.
    """
    ingestion: IngestionConfig = field(default_factory=IngestionConfig)
    store: StoreConfig = field(default_factory=StoreConfig)
    macro: MacroConfig = field(default_factory=MacroConfig)
    micro: MicroConfig = field(default_factory=MicroConfig)
    synthesis: SynthesisConfig = field(default_factory=SynthesisConfig)

    # Embedding model (shared between ingestion and macro)
    embedding_model: str = "gemini-embedding-001"
    embedding_dimension: int = 3072
    embedding_api_key: Optional[str] = field(
        default_factory=lambda: os.getenv("GEMINI_API_KEY")
    )
    embedding_batch_size: int = 64

    # Global settings
    debug: bool = False
    log_level: str = "INFO"

    # Performance
    enable_caching: bool = True
    cache_ttl_seconds: int = 600           # 10 minutes

    def __post_init__(self):
        # Load from environment
        if os.getenv("RAG_DEBUG"):
            self.debug = True
            self.log_level = "DEBUG"

        env_model = os.getenv("RAG_ROUTING_MODEL")
        if env_model:
            self.micro.routing_model = env_model

        env_synth = os.getenv("RAG_SYNTHESIS_MODEL")
        if env_synth:
            self.synthesis.synthesis_model = env_synth

    @classmethod
    def from_dict(cls, data: Dict) -> "RAGConfig":
        """Create config from dictionary."""
        config = cls()

        section_map = {
            "ingestion": config.ingestion,
            "store": config.store,
            "macro": config.macro,
            "micro": config.micro,
            "synthesis": config.synthesis,
        }

        for section_name, section_obj in section_map.items():
            if section_name in data:
                for k, v in data[section_name].items():
                    if hasattr(section_obj, k):
                        setattr(section_obj, k, v)

        # Top-level fields
        for k in ("embedding_model", "embedding_dimension", "embedding_batch_size",
                   "debug", "log_level", "enable_caching", "cache_ttl_seconds"):
            if k in data:
                setattr(config, k, data[k])

        return config

    def validate(self) -> List[str]:
        """Validate configuration and return list of warnings."""
        warnings: List[str] = []

        if self.macro.vector_top_k < self.macro.max_documents:
            warnings.append(
                f"vector_top_k ({self.macro.vector_top_k}) < max_documents "
                f"({self.macro.max_documents}); increase vector_top_k"
            )

        if self.micro.max_total_sections > 30:
            warnings.append(
                f"max_total_sections ({self.micro.max_total_sections}) is very high; "
                "may cause slow micro-navigation"
            )

        if self.synthesis.max_context_tokens < 2000:
            warnings.append(
                f"max_context_tokens ({self.synthesis.max_context_tokens}) is very low; "
                "synthesis quality may suffer"
            )

        if not self.embedding_api_key:
            warnings.append("No embedding API key configured; embeddings will fail")

        return warnings


# Global config singleton
_rag_config: Optional[RAGConfig] = None


def get_rag_config() -> RAGConfig:
    """Get the global RAG configuration."""
    global _rag_config
    if _rag_config is None:
        _rag_config = RAGConfig()
    return _rag_config


def set_rag_config(config: RAGConfig) -> None:
    """Set the global RAG configuration."""
    global _rag_config
    _rag_config = config
