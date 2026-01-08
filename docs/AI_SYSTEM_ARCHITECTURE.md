# Synthi Code Intelligence: Vector Storage & Retrieval

Technical deep-dive into how code is indexed, stored, and retrieved.

---

## 1. Semantic Chunking

Code is NOT stored as files or arbitrary token windows. Each **SemanticChunk** is a self-describing code unit:

```python
@dataclass
class SemanticChunk:
    id: str                          # SHA256 hash of path:name:line
    code_body: str                   # The actual code
    metadata: ChunkMetadata          # Everything needed for retrieval
    embedding: Optional[List[float]] # 768-dim vector (text-embedding-004)
    token_count: int                 # For budget management
```

**ChunkMetadata** carries:
- `file_path`, `start_line`, `end_line`, `start_col`, `end_col`
- `symbol_name`, `symbol_type` (FUNCTION, CLASS, METHOD, etc.)
- `signature` (full function signature)
- `docstring`
- `imports_used: FrozenSet[str]` - what this chunk imports
- `exports_provided: FrozenSet[str]` - what this chunk exports
- `parent_symbol` - containing class/module
- `is_public`, `is_test`, `complexity_estimate`

**Why this matters**: Bad chunking (fixed tokens, whole files) destroys retrieval quality. A function must include its signature + docstring + body as one unit.

---

## 2. Chunk Extraction Pipeline

```
File → LanguageDetector → Parser → ChunkExtractor → SemanticChunk[]
```

**ChunkExtractor** (`ingestion/chunk_extractor.py`):
1. Detects language from extension/content
2. Gets language-specific parser (Python, TS, Rust, Go, Java, C++)
3. Parser extracts `ParsedSymbol` objects (functions, classes, methods)
4. Converts each symbol to `SemanticChunk` with full metadata

```python
def extract(self, file: WalkedFile) -> List[SemanticChunk]:
    language = detect_language(file.path, file.content)
    parser = get_parser(language)  # python_parser, typescript_parser, etc.
    parse_result = parser.parse(file.content, file.relative_path)
    return self._symbols_to_chunks(parse_result, file.content_hash, file.relative_path)
```

Test detection happens here: paths containing `test/`, `__tests__/`, or symbols starting with `test_` are flagged `is_test=True`.

---

## 3. Embedding Generation

**Embedder** (`indexer/embedder.py`) uses Google's `text-embedding-004` (768 dimensions):

```python
def embed_chunk(self, chunk: SemanticChunk) -> SemanticChunk:
    # Build text: docstring + signature + code_body
    parts = []
    if chunk.metadata.docstring:
        parts.append(chunk.metadata.docstring)
    if chunk.metadata.signature:
        parts.append(chunk.metadata.signature)
    parts.append(chunk.code_body)
    text = "\n".join(parts)
    
    chunk.embedding = self.embed_text(text)  # → 768 floats
    return chunk
```

**Critical detail**: Query embeddings use `task_type="RETRIEVAL_QUERY"`, document embeddings use `task_type="RETRIEVAL_DOCUMENT"`. Different internal representations optimize dot-product similarity.

Batch processing: 100 chunks per API call, texts truncated at 30k chars.

---

## 4. Dual Index Architecture

Two indexes work together:

### VectorIndex (Semantic Similarity)
Answers: *"What seems relevant?"*

```python
class VectorIndex:
    _embeddings: Dict[ChunkId, np.ndarray]  # ID → normalized 768-dim vector
    _chunks: Dict[ChunkId, SemanticChunk]   # ID → full chunk data
```

**Storage**: In-memory numpy arrays. Vectors are L2-normalized on insert for cosine similarity via dot product.

**Search** (brute-force, fine for <100k chunks):
```python
def search(self, query_embedding, k=10, min_score=0.0):
    query = normalize(query_embedding)
    scores = [(chunk_id, np.dot(query, emb)) for chunk_id, emb in self._embeddings.items()]
    return sorted(scores, reverse=True)[:k]
```

**Persistence**: JSON serialization to `.code_intel/vectors.json`.

### StructuralIndex (Symbol Graph)
Answers: *"What MUST be included?"*

```python
class SymbolGraph:
    _nodes: Dict[QualifiedName, SymbolNode]           # Symbol definitions
    _edges: Dict[QualifiedName, List[SymbolEdge]]     # Outgoing edges
    _reverse_edges: Dict[QualifiedName, List[SymbolEdge]]  # Incoming edges
    _symbol_to_chunk: Dict[QualifiedName, ChunkId]    # Symbol → chunk mapping
```

**Edge types**: `IMPORTS`, `CALLS`, `INHERITS`, `IMPLEMENTS`, `USES_TYPE`, `CONTAINS`, `OVERRIDES`

**Key operations**:
```python
get_dependencies(name, max_depth=2)  # What does this symbol depend on?
get_dependents(name, max_depth=2)    # What depends on this symbol?
get_callers(name)                    # Who calls this?
get_callees(name)                    # What does this call?
get_implementors(name)               # What implements this interface?
```

---

## 5. Retrieval Pipeline

Six-stage pipeline from query to context:

### Stage 1: QueryProcessor
Extracts intent, symbol names, file patterns from natural language.

### Stage 2: ContextRetriever
```python
def retrieve(self, query_embedding, query_symbols, query_files, top_k):
    # Vector search (primary)
    vector_results = self._vector_search(query_embedding, top_k * 2)
    
    # Symbol name matching (secondary)
    symbol_results = self._symbol_search(query_symbols, top_k)
    
    # File path matching
    file_results = self._file_search(query_files, top_k)
    
    # Merge with score weighting
    return self._merge_results(vector_results, symbol_results, file_results)
```

**Symbol matching scores**: Exact=1.0, Prefix=0.8, Contains=0.6

### Stage 3: GraphExpander
Follows symbol graph to find supporting code. **Critical for preventing hallucination**.

```python
# Expansion rules with priorities and limits
DEFAULT_RULES = [
    ExpansionRule(IMPORTS,    "forward",  max_hops=1, decay=0.8,  priority=10, max_per_source=5),
    ExpansionRule(CALLS,      "forward",  max_hops=2, decay=0.6,  priority=8,  max_per_source=5),
    ExpansionRule(IMPLEMENTS, "forward",  max_hops=1, decay=0.85, priority=9,  max_per_source=3),
    ExpansionRule(INHERITS,   "forward",  max_hops=2, decay=0.7,  priority=7,  max_per_source=3),
    ExpansionRule(USES_TYPE,  "forward",  max_hops=1, decay=0.65, priority=6,  max_per_source=5),
    ExpansionRule(CALLS,      "backward", max_hops=1, decay=0.4,  priority=3,  max_per_source=3),  # Limited!
]
```

**Hard limits** (prevent graph explosion):
- Max 10 symbols per module
- Max 5 files per module  
- Max 2000 tokens per module
- Callers (backward) heavily limited (can explode quickly)

### Stage 4: ContextRanker
Multi-factor scoring: `vector_score × graph_distance_decay × file_importance`

### Stage 5: BudgetEnforcer
Hard token limit (default 8000). Eviction policies:
- **LRU**: Least recently shown chunks evicted first
- **Importance**: Score by `recency × frequency × references`
- Pinned chunks (user-marked critical) never evicted

### Stage 6: ContextAssembler
Formats final context: `repo_summary + file_summaries + ranked_chunks`

---

## 6. DualIndexer Orchestration

```python
class DualIndexer:
    def index_repository(self, skip_embeddings=False):
        files = list(self.walker.walk())  # Respects .gitignore
        
        for file in files:
            chunks = self._index_single_file(file, skip_embeddings)
            all_chunks.extend(chunks)
            self._file_hashes[file.relative_path] = file.content_hash
        
        # Batch embed (100 at a time)
        if not skip_embeddings:
            self.embedder.embed_chunks(chunks_without_embedding)
        
        # Add to vector index
        for chunk in all_chunks:
            if chunk.embedding:
                self.vector_index.add(chunk)
        
        # Persist both indexes
        self.vector_index.persist()   # → .code_intel/vectors.json
        self.structural_index.persist() # → .code_intel/structure.json
```

**Incremental updates**: Track `_file_hashes`. On re-index, only process files where `content_hash` changed.

---

## 7. Storage Layout

```
workspace/
└── .code_intel/
    ├── vectors.json        # {chunk_id: [768 floats], ...}
    ├── structure.json      # Symbol graph (nodes, edges)
    └── summaries/
        ├── file_summaries.json
        └── repo_summary.json
```

---

## 8. Query Example

**User**: "How does the auth middleware validate tokens?"

```
1. QueryProcessor extracts: symbols=[auth, middleware, validate, token]
2. Embedder.embed_query("auth middleware validate tokens") → [768 floats]
3. VectorIndex.search(query_vec, k=20) → top 20 similar chunks
4. GraphExpander:
   - auth_middleware imports jwt_utils → add jwt_utils chunks
   - validate_token calls decode_jwt → add decode_jwt
   - decode_jwt uses UserModel type → add UserModel
   - Stops at max_hops=2, max 10 symbols from each module
5. ContextRanker scores: validate_token=0.92, auth_middleware=0.88, ...
6. BudgetEnforcer: 8000 token budget, evict lowest-scored chunks
7. ContextAssembler: Format as markdown with file paths and line numbers
```

**Result**: LLM receives auth_middleware + jwt_utils + decode_jwt + UserModel—everything needed to answer, nothing irrelevant.
