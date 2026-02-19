# RAG Subsystem — Architecture Reference

## Overview

The RAG (Retrieval-Augmented Generation) subsystem implements a 4-step
document-aware pipeline for answering questions about large codebases
with full citation tracking.

## Architecture

```
Query → [Macro-Retrieval] → [Micro-Navigation] → [Synthesis] → Cited Answer
               ↑                    ↑                  ↑
          SummaryIndex          ToCTree            gemini-2.5-flash
          KeywordFilter      TreeNavigator        CitationTracker
          DocumentRanker    SectionExtractor     ConfidenceScorer
```

## 4-Step Pipeline

### Step 1: Dual-Ingestion (Offline)

Each document is processed through two parallel paths:

1. **Structural Path**: Extract a ToC tree (headings, classes, functions),
   split into sections, store with breadcrumbs and line numbers.

2. **Summary Path**: Generate a high-level summary with key topics and
   entities, embed into a vector index for fast similarity search.

Components: `DocumentLoader`, `ToCExtractor`, `SectionSplitter`,
`SummaryGenerator`, `DocumentProcessor`, `ContentHasher`

### Step 2: Macro-Retrieval (Fast, <50ms target)

Narrows the full corpus (N documents) → top 3-5 candidates using:

- **Vector search**: Cosine similarity on summary embeddings
- **Keyword filter**: BM25 scoring on document summaries  
- **Hybrid ranking**: Weighted combination (0.6 vector + 0.3 keyword + 0.1 recency)

Components: `QueryAnalyzer`, `SummarySearcher`, `KeywordFilter`, `DocumentRanker`

### Step 3: Micro-Navigation (Agentic, ~200ms target)

For each top document, the system navigates the ToC tree using a fast
routing LLM (gemini-2.0-flash-lite) to find the most relevant sections:

1. Start at the root of the ToC tree
2. At each level, the LLM picks which children to drill into
3. Continue until leaf sections are reached
4. Extract and score section content by relevance

Components: `TreeNavigator`, `SectionExtractor`, `PageResolver`, `RelevanceScorer`

### Step 4: Heavy Synthesis (~1-3s target)

The extracted sections are formatted as a citation-ready context and
passed to a heavy reasoning model (gemini-2.5-flash) which:

1. Generates a comprehensive answer
2. Includes [1], [2], ... citation markers
3. Citations are tracked back to source sections
4. Confidence is scored across 4 dimensions

Components: `ContextBuilder`, `AnswerSynthesizer`, `CitationTracker`, `ConfidenceScorer`

## Storage Layer

All data is persisted to disk using JSON + numpy:

| Store | Format | Purpose |
|-------|--------|---------|
| `DocumentStore` | JSON + text files | Document metadata and content |
| `ToCStore` | JSON | ToC tree structure per document |
| `SummaryIndex` | JSON + numpy .npz | Summary embeddings for vector search |
| `SectionStore` | JSON + text files | Section metadata and content |
| `KeywordFilter` | JSON | BM25 inverted index |

All writes use atomic temp-file + rename for crash safety.

## Configuration

`RAGConfig` in `config.py` controls all parameters:

- **IngestionConfig**: File extensions, ignore patterns, ToC depth limits
- **StoreConfig**: Storage directory, atomic write settings
- **MacroConfig**: Vector top-k, hybrid weights, max documents
- **MicroConfig**: Routing model, max routing calls, timeouts
- **SynthesisConfig**: Synthesis model, token budgets, citation settings

## API Endpoints

Registered under `/code-intel/rag/`:

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/rag/query` | POST | Execute a RAG query |
| `/rag/ingest` | POST | Ingest documents |
| `/rag/stats` | GET | Pipeline statistics |
| `/rag/clear` | POST | Clear all data |
| `/rag/documents` | GET | List ingested documents |
| `/rag/health` | GET | Health check |

## Models Used

| Purpose | Model | Latency |
|---------|-------|---------|
| Embeddings | gemini-embedding-001 (3072d) | ~20ms |
| Fast routing | gemini-2.0-flash-lite | ~100ms |
| Heavy synthesis | gemini-2.5-flash | ~1-3s |
