# Synthi Code Intelligence: Vector Storage & Retrieval

Technical deep-dive into how code is indexed, stored, and retrieved.

---

## 1. Semantic Chunking

Code is NOT stored as files or arbitrary token windows. Each **SemanticChunk** is a self-describing code unit:

```python
@dataclass
class SemanticChunk:
    id: str                          # Stable ID (see below)
    code_body: str                   # Loaded lazily from disk
    metadata: ChunkMetadata          # Everything needed for retrieval
    embedding: Optional[np.ndarray]  # 768-dim float32 vector
    token_count: int                 # Counted with target model tokenizer
```

### Stable Chunk IDs

**Problem**: `SHA256(path:name:line)` breaks when lines shift—cache misses, broken pins, duplicate chunks.

**Solution**: IDs are computed from content-stable properties:
```python
def compute_chunk_id(file_path: str, qualified_name: str, signature: str, body_fingerprint: str) -> str:
    # AST-based fingerprint of normalized body (whitespace-insensitive)
    content = f"{file_path}|{qualified_name}|{signature}|{body_fingerprint}"
    return hashlib.sha256(content.encode()).hexdigest()[:16]
```

This means:
- Renaming a function → new ID (correct, it's a different symbol)
- Adding lines above → same ID (correct, symbol unchanged)
- Changing body → new ID via fingerprint (correct, semantics changed)

### ChunkMetadata

```python
@dataclass(frozen=True)
class ChunkMetadata:
    file_path: str
    start_line: int
    end_line: int
    qualified_name: str              # Full path: module.Class.method
    symbol_type: SymbolType
    signature: str
    docstring: str
    imports_used: FrozenSet[str]
    exports_provided: FrozenSet[str]
    parent_symbol: Optional[str]
    language: str
    is_public: bool
    is_test: bool
    module_group: str                # Canonical grouping (see §4)
```

---

## 2. Chunk Extraction Pipeline

```
File → LanguageDetector → Parser → ChunkExtractor → SemanticChunk[]
```

### Lazy Code Loading

**Problem**: Storing full `code_body` for every chunk consumes 100s of MB for large repos.

**Solution**: Store only metadata + line ranges. Load code on-demand:
```python
@dataclass
class SemanticChunk:
    _code_body: Optional[str] = None  # Cached after first load
    
    def get_code(self, file_reader: FileReader) -> str:
        if self._code_body is None:
            self._code_body = file_reader.read_lines(
                self.metadata.file_path,
                self.metadata.start_line,
                self.metadata.end_line
            )
        return self._code_body
```

### Incremental Deletion Semantics

On `reindex(file_path)`:
```python
def reindex_file(self, file_path: str):
    # 1. Delete ALL old chunks for this file
    old_chunk_ids = self.structural_index.get_chunks_for_file(file_path)
    for chunk_id in old_chunk_ids:
        self.vector_index.remove(chunk_id)
        self.structural_index.remove_chunk(chunk_id)
    
    # 2. Delete all graph edges originating from this file
    self.structural_index.remove_edges_from_file(file_path)
    
    # 3. Re-extract and insert new chunks
    new_chunks = self.extractor.extract(file_path)
    for chunk in new_chunks:
        self.vector_index.add(chunk)
        self.structural_index.add_chunk(chunk)
```

---

## 3. Embedding Generation

### Structured Embed Text

**Problem**: Raw `docstring + signature + code_body` truncated at 30k chars loses semantics for long functions.

**Solution**: Structured embedding text with key information preserved:
```python
def build_embed_text(chunk: SemanticChunk) -> str:
    parts = [
        f"SYMBOL: {chunk.metadata.qualified_name}",
        f"TYPE: {chunk.metadata.symbol_type.value}",
    ]
    
    if chunk.metadata.signature:
        parts.append(f"SIGNATURE: {chunk.metadata.signature}")
    
    if chunk.metadata.docstring:
        parts.append(f"DOC: {chunk.metadata.docstring[:500]}")  # Cap docstring
    
    # Extract key lines: returns, raises, external calls
    key_lines = extract_key_lines(chunk.get_code())
    if key_lines:
        parts.append(f"KEY: {key_lines}")
    
    # Imports used (semantic context)
    if chunk.metadata.imports_used:
        parts.append(f"USES: {', '.join(list(chunk.metadata.imports_used)[:10])}")
    
    return "\n".join(parts)  # Much shorter, more semantic
```

### Token Counting with Target Tokenizer

**Problem**: Token counts must match the model being prompted or budget enforcement fails.

**Solution**: Use the exact tokenizer for the target model:
```python
class TokenCounter:
    def __init__(self, model: str):
        if "gpt" in model:
            import tiktoken
            self._enc = tiktoken.encoding_for_model(model)
        elif "gemini" in model:
            # Gemini uses ~4 chars/token approximation or API count
            self._enc = None
            self._chars_per_token = 4
    
    def count(self, text: str) -> int:
        if self._enc:
            return len(self._enc.encode(text))
        return len(text) // self._chars_per_token
```

---

## 4. Dual Index Architecture

### VectorIndex (Binary Storage)

**Problem**: JSON with 768 Python floats per chunk is huge, slow, precision-lossy.

**Solution**: Binary float32 storage with numpy:
```python
class VectorIndex:
    def __init__(self, persist_path: str):
        self.persist_path = persist_path
        self._ids: List[str] = []                    # Ordered chunk IDs
        self._matrix: Optional[np.ndarray] = None    # (N, 768) float32
        self._id_to_idx: Dict[str, int] = {}
    
    def add(self, chunk_id: str, embedding: np.ndarray):
        embedding = embedding.astype(np.float32)
        embedding = embedding / np.linalg.norm(embedding)  # Normalize
        
        if self._matrix is None:
            self._matrix = embedding.reshape(1, -1)
        else:
            self._matrix = np.vstack([self._matrix, embedding])
        
        self._ids.append(chunk_id)
        self._id_to_idx[chunk_id] = len(self._ids) - 1
    
    def persist(self):
        np.savez_compressed(
            self.persist_path,
            ids=np.array(self._ids, dtype=object),
            vectors=self._matrix
        )
    
    def load(self):
        data = np.load(self.persist_path, allow_pickle=True)
        self._ids = data['ids'].tolist()
        self._matrix = data['vectors'].astype(np.float32)
        self._id_to_idx = {id: i for i, id in enumerate(self._ids)}
```

### Vectorized Search (No Python Loop)

**Problem**: `for chunk_id, emb in dict.items(): np.dot(...)` is O(N) in Python—slow under concurrency.

**Solution**: Single matrix multiply:
```python
def search(self, query: np.ndarray, k: int = 10) -> List[Tuple[str, float]]:
    query = query.astype(np.float32)
    query = query / np.linalg.norm(query)
    
    # One matmul: (1, 768) @ (768, N) → (1, N) scores
    scores = self._matrix @ query  # Vectorized dot product
    
    # Top-k via argpartition (faster than full sort for large N)
    top_k_idx = np.argpartition(scores, -k)[-k:]
    top_k_idx = top_k_idx[np.argsort(scores[top_k_idx])[::-1]]
    
    return [(self._ids[i], float(scores[i])) for i in top_k_idx]
```

**Scaling note**: For >20k chunks, switch to FAISS HNSW or similar ANN index.

### StructuralIndex (Symbol Graph)

Edge extraction priority order:
1. **LSP references** (highest confidence)
2. **Parser-level extraction** (AST-based)
3. **Heuristic fallbacks** (regex, naming conventions)

```python
@dataclass
class SymbolEdge:
    source: QualifiedName
    target: QualifiedName
    edge_type: EdgeType
    confidence: float  # 0.0-1.0, used for expansion limits
    source_method: str  # "lsp", "ast", "heuristic"
```

Expansion caps per confidence level:
```python
EXPANSION_LIMITS = {
    "lsp": {"max_per_source": 10, "max_hops": 2},
    "ast": {"max_per_source": 5, "max_hops": 2},
    "heuristic": {"max_per_source": 2, "max_hops": 1},
}
```

---

## 5. Canonical Module Grouping

**Problem**: "Max 10 symbols per module" is undefined across languages.

**Solution**: Language-specific canonical grouping:

| Language | Module Definition |
|----------|-------------------|
| Python | Package directory (closest `__init__.py` parent) |
| TypeScript | File path + tsconfig `paths` resolution |
| Java | Package (`com.example.auth`) |
| Rust | Crate + module path (`crate::auth::middleware`) |
| C++ | Header file or namespace |
| Go | Package directory |

```python
def get_module_group(file_path: str, language: str, symbol_name: str) -> str:
    if language == "python":
        return find_package_root(file_path)
    elif language in ("typescript", "javascript"):
        return resolve_ts_module(file_path)
    elif language == "java":
        return extract_java_package(file_path)
    elif language == "rust":
        return extract_rust_module_path(file_path)
    # ...
```

---

## 6. Retrieval Pipeline

### Stage 2: ContextRetriever (Improved Scoring)

**Problem**: Exact/prefix/contains scores produce junk for common names (`utils`, `handler`).

**Solution**: Namespace-aware scoring:
```python
def score_symbol_match(query_symbol: str, chunk: SemanticChunk, query_context: QueryContext) -> float:
    base_score = compute_string_match(query_symbol, chunk.metadata.symbol_name)
    
    # Downrank short/common symbols
    if len(chunk.metadata.symbol_name) < 4:
        base_score *= 0.5
    if chunk.metadata.symbol_name.lower() in STOPWORDS:
        base_score *= 0.3
    
    # Boost namespace proximity
    if same_package(chunk.metadata.module_group, query_context.current_file):
        base_score *= 1.5
    elif same_dependency_tree(chunk, query_context):
        base_score *= 1.2
    
    return base_score
```

### Stage 3: GraphExpander (Confidence-Aware)

```python
DEFAULT_RULES = [
    ExpansionRule(IMPORTS,    "forward",  max_hops=1, decay=0.8,  priority=10),
    ExpansionRule(CALLS,      "forward",  max_hops=2, decay=0.6,  priority=8),
    ExpansionRule(IMPLEMENTS, "forward",  max_hops=1, decay=0.85, priority=9),
    ExpansionRule(INHERITS,   "forward",  max_hops=2, decay=0.7,  priority=7),
    ExpansionRule(USES_TYPE,  "forward",  max_hops=1, decay=0.65, priority=6),
    ExpansionRule(CALLS,      "backward", max_hops=1, decay=0.4,  priority=3),
]

# Per-module hard limits (using canonical grouping)
MODULE_LIMITS = ModuleLimit(max_symbols=10, max_files=5, max_tokens=2000)

# Per-edge-confidence limits
def get_max_expansions(edge: SymbolEdge) -> int:
    return EXPANSION_LIMITS[edge.source_method]["max_per_source"]
```

### Stage 4: ContextRanker (Additive Scoring)

**Problem**: `vector_score × decay × importance` collapses scores to near-zero.

**Solution**: Weighted sum in log-space:
```python
def compute_final_score(candidate: RetrievalCandidate) -> float:
    weights = {"vector": 0.5, "graph": 0.3, "file": 0.2}
    
    # Log-space addition prevents collapse
    score = (
        weights["vector"] * candidate.vector_score +
        weights["graph"] * (1.0 - candidate.expansion_depth * 0.15) +
        weights["file"] * candidate.file_importance
    )
    
    # Normalize to 0-1
    return min(1.0, max(0.0, score))
```

---

## 7. Storage Layout

```
workspace/
└── .code_intel/
    ├── vectors.npz         # Binary: ids + (N,768) float32 matrix
    ├── structure.json      # Symbol graph (nodes, edges with confidence)
    ├── chunk_meta.json     # Metadata only (no code bodies)
    └── summaries/
        ├── file_summaries.json
        └── repo_summary.json
```

**Security**: Storage is per-workspace. Cross-tenant access requires explicit ACL checks. Never persist embeddings for untrusted workspaces without access control.

---

## 8. Query Example

**User**: "How does the auth middleware validate tokens?"

```
1. QueryProcessor extracts: symbols=[auth, middleware, validate, token]
2. TokenCounter initialized with target model (gpt-4, gemini-pro, etc.)
3. Embedder.embed_query(structured_text) → 768 float32
4. VectorIndex.search(query_vec, k=20) via single matmul
5. GraphExpander:
   - auth_middleware imports jwt_utils (LSP edge, confidence=1.0) → add
   - validate_token calls decode_jwt (AST edge, confidence=0.9) → add
   - decode_jwt uses UserModel (heuristic edge, confidence=0.6) → add with limit
   - Stops at module cap: max 10 from `auth` package
6. ContextRanker: additive scoring, validate_token=0.82, auth_middleware=0.78
7. BudgetEnforcer: 8000 tokens (counted with target tokenizer)
8. ContextAssembler: Load code bodies lazily, format with file paths
```

**Result**: LLM receives exactly what it needs—auth_middleware + jwt_utils + decode_jwt + UserModel—with correct token budget.
