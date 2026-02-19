"""Tests for RAG configuration."""

import pytest
from ..config import (
    RAGConfig,
    IngestionConfig,
    StoreConfig,
    MacroConfig,
    MicroConfig,
    SynthesisConfig,
    get_rag_config,
    set_rag_config,
)


class TestRAGConfig:
    def test_default_values(self):
        config = RAGConfig()
        assert config.embedding_model == "gemini-embedding-001"
        assert config.embedding_dimension == 3072
        assert config.macro.max_documents == 5
        assert config.micro.routing_model == "gemini-2.0-flash-lite"
        assert config.synthesis.synthesis_model == "gemini-2.5-flash"

    def test_ingestion_config(self):
        config = IngestionConfig()
        assert ".md" in config.document_extensions
        assert ".py" in config.code_extensions
        assert config.max_section_tokens == 4000
        assert config.summary_max_tokens == 200

    def test_store_config(self):
        config = StoreConfig()
        assert config.use_atomic_writes is True
        assert config.documents_file == "documents.json"
        assert config.vectors_file == "summary_vectors.npz"

    def test_macro_config(self):
        config = MacroConfig()
        assert config.vector_weight + config.keyword_weight + config.recency_weight == 1.0
        assert config.vector_top_k >= config.max_documents

    def test_micro_config(self):
        config = MicroConfig()
        assert config.max_sections_per_document <= config.max_total_sections
        assert config.routing_timeout_ms < config.total_timeout_ms

    def test_synthesis_config(self):
        config = SynthesisConfig()
        assert config.max_context_tokens > config.reserved_for_prompt
        assert config.enable_citations is True

    def test_from_dict(self):
        data = {
            "macro": {"max_documents": 3, "vector_top_k": 8},
            "synthesis": {"synthesis_model": "gemini-pro"},
            "embedding_dimension": 1024,
        }
        config = RAGConfig.from_dict(data)
        assert config.macro.max_documents == 3
        assert config.macro.vector_top_k == 8
        assert config.synthesis.synthesis_model == "gemini-pro"
        assert config.embedding_dimension == 1024

    def test_validate(self):
        config = RAGConfig()
        warnings = config.validate()
        # Should have a warning about missing API key
        assert any("API key" in w for w in warnings)

    def test_validate_bad_config(self):
        config = RAGConfig()
        config.macro.vector_top_k = 2
        config.macro.max_documents = 5
        warnings = config.validate()
        assert any("vector_top_k" in w for w in warnings)

    def test_singleton(self):
        config1 = get_rag_config()
        config2 = get_rag_config()
        assert config1 is config2

        new_config = RAGConfig()
        new_config.debug = True
        set_rag_config(new_config)
        assert get_rag_config().debug is True

        # Reset
        set_rag_config(RAGConfig())
