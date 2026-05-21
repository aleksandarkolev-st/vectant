# GPU HMR CodeIntel/RAG Split Orchestration Plan

Draft date: 2026-05-21

Status: final architecture plan for the next GPU HMR branch. This document
supersedes the earlier `GPU_HMR_RAG_SPLIT_IMPROVEMENT_PLAN.md` draft.

## 1. Executive Recommendation

Merge the current GPU HMR production-orchestrator PR after review and CI, but
do not continue expanding it with the work below.

Open a new branch for this architecture pass:

```text
feature/gpu-hmr-codeintel-split-broker
```

Reason:

- The current PR is a stabilization PR: GPU verifier hardening, direct
  device-body HMR improvements, generated-role contract fixes, real-repo
  validation harnesses, and matrix evidence.
- The next step changes the split architecture: GPU HMR should become a
  consumer of the existing CodeIntel/RAG system and should add a deterministic
  split broker. That is a separate review surface.
- Keeping the current PR focused makes it easier to merge, and gives the next
  PR a clean base.

Do not claim "GPU HMR production ready" in either PR until the validation
matrix in `docs/GPU_HMR_PROD_NEXT.md` has current reproducible artifacts.

## 2. What I Audited

This plan is based on a local code audit of the current CodeIntel/RAG system
and GPU split path.

Primary docs:

- `docs/AI_SYSTEM_ARCHITECTURE.md`
- `docs/AI_OUTPUT_QUALITY_FIX.md`
- `docs/synthi-diff-patch-training-plan.md`
- `ai-backend/ai-engine/code_intel/rag/README.md`
- `ai-backend/ai-engine/code_intel/rag/PLAN.md`
- `docs/GPU_HMR_PROD_NEXT.md`

Primary CodeIntel/RAG implementation:

- `ai-backend/ai-engine/code_intel/api.py`
- `ai-backend/ai-engine/code_intel/engine.py`
- `ai-backend/ai-engine/code_intel/core/config.py`
- `ai-backend/ai-engine/code_intel/core/types.py`
- `ai-backend/ai-engine/code_intel/indexer/dual_indexer.py`
- `ai-backend/ai-engine/code_intel/indexer/structural_index.py`
- `ai-backend/ai-engine/code_intel/indexer/vector_index.py`
- `ai-backend/ai-engine/code_intel/indexer/lexical_index.py`
- `ai-backend/ai-engine/code_intel/retrieval/pipeline.py`
- `ai-backend/ai-engine/code_intel/retrieval/controller.py`
- `ai-backend/ai-engine/code_intel/retrieval/graph_expander.py`
- `ai-backend/ai-engine/code_intel/retrieval/grounding_verifier.py`
- `ai-backend/ai-engine/code_intel/rag/pipeline.py`
- `ai-backend/ai-engine/code_intel/rag/config.py`
- `ai-backend/ai-engine/code_intel/rag/observability/tracing.py`

Primary GPU HMR split implementation:

- `ai-backend/ai-engine/agents/kernel_splitter.py`
- `ai-backend/ai-engine/agents/gpu_source_context.py`
- `ai-backend/ai-engine/verifier_gpu.py`
- `ai-backend/ai-engine/main.py`
- `backend/synthi-webrtc-compiler/worker/src/compiler/stages/ai_utils.rs`
- `backend/synthi-webrtc-compiler/worker/src/compiler/stages/compile_helpers.rs`

## 3. What The Existing CodeIntel/RAG System Already Provides

The repository already has most of the primitives needed for production-grade
GPU HMR split preparation. We should not build a second RAG system.

### 3.1 Tiered Code Intelligence Model

`docs/AI_SYSTEM_ARCHITECTURE.md` describes the intended model:

- workspace filesystem is authoritative
- metadata index is cheap and complete
- lexical/BM25 index catches names, paths, errors, identifiers
- vector index handles semantic retrieval
- blob/chunk store keeps raw content out of the vector DB
- repo intelligence cache stores summaries, facts, graphs
- retrieval combines BM25, vector search, symbol graph expansion, rerank, and
  deterministic context assembly

This matches the GPU HMR production requirement:

```text
deterministic source context, not prompt truncation
```

### 3.2 Engine And API

`code_intel/api.py` exposes:

- `/code-intel/index`
- `/code-intel/index/file`
- `/code-intel/index/file/delete`
- `/code-intel/index/file/rename`
- `/code-intel/context`
- `/code-intel/context/fast`

`code_intel/engine.py` owns:

- engine cache per resolved workspace
- full and incremental indexing
- dual indexer setup
- summary/facts sync
- background RAG ingestion after index
- single-file reindex
- RAG query surface

This is the correct place to attach a GPU-specific workspace intelligence
artifact.

### 3.3 Dual Indexer

`DualIndexer` already maintains:

- vector index
- structural index
- lexical index
- atomic generation pointer for index rebuilds
- chunking version invalidation
- per-file locks
- atomic delete-then-insert reindex semantics
- file hash tracking
- import resolution into structural index

This matters for GPU HMR because background split preparation needs the same
properties:

- no stale chunks after edits
- reproducible source context
- index generation IDs
- atomic promotion of generated metadata

### 3.4 Structural Index

`StructuralIndex` and `SymbolGraph` already support:

- file -> symbols
- symbol -> chunk
- stable symbol IDs
- import graph
- call graph where available
- outgoing/incoming edges
- edge confidence tracking: LSP > parser/AST > heuristic
- expansion limits by confidence
- file deletion cleanup

This is directly reusable for:

- kernel declaration discovery
- launch-site discovery
- state type discovery
- render ownership discovery
- affected-file reports
- routing candidate files into split stages

But the C/C++ parser is currently pattern-based and explicitly says production
should use tree-sitter or libclang. Therefore, CodeIntel graph evidence is
excellent for retrieval and ranking, but compiler-compatible parsing still owns
GPU HMR safety.

### 3.5 Retrieval Controller

`RetrievalController` is important because it already encodes the right
philosophy:

```text
The LLM never decides what context it receives.
```

It provides:

- deterministic include/exclude decisions
- hard per-file/module/token limits
- insufficiency signaling
- refusal reasons
- decision hashes

GPU HMR should use the same pattern. The split broker should decide the role
packages and source context. The model should only propose artifacts inside
that scope.

### 3.6 Retrieval Pipeline

`RetrievalPipeline` already provides:

- query processing
- vector retrieval
- lexical retrieval
- graph expansion
- ranking
- RRF/MMR fusion
- budget enforcement
- context assembly
- retrieval cache
- fast path support

This is suitable for role-specific split retrieval queries such as:

- "find device kernels and launch sites for target X"
- "find render/window ownership for target X"
- "find host/device shared state types"
- "find compile/link dependencies for generated GUI role"

### 3.7 RAG Pipeline

`RAGPipeline` already provides:

- document/code ingestion
- content-hash skip path
- async ingestion jobs
- summary index
- keyword index
- ToC/section stores
- query rewriting / HyDE
- macro retrieval
- micro navigation
- section reranking
- citation-capable synthesis
- query cache
- structured trace trees

For GPU HMR, RAG should be used for retrieval, summaries, and citations. It
should not certify reload safety.

### 3.8 Observability

`code_intel/rag/observability/tracing.py` provides nested span traces with
attributes, errors, events, and optional OpenTelemetry mirroring.

GPU HMR split preparation should reuse the same trace shape instead of adding
more ad hoc logs.

## 4. Current GPU HMR Gap

The current GPU split flow is still mostly independent from CodeIntel/RAG:

```text
worker sends file map
  -> /refactor/split/gpu
  -> gpu_source_context.py builds source report with local heuristics
  -> kernel_splitter.py builds one big prompt
  -> provider.ask_llm one split proposal per attempt
  -> verify_split_output
  -> deterministic generated artifact repair
  -> worker compile/runtime verifies later
```

This is better than prompt truncation, but not yet the production architecture.

Main gaps:

- `gpu_source_context.py` uses regex and path heuristics as primary selection
  authority.
- CodeIntel index freshness is not part of GPU split readiness.
- The RAG retrieval pipeline is not used to build role-specific context.
- `RetrievalController` sufficiency/refusal semantics are not used by GPU HMR.
- GPU split is still one large coordinated AI response.
- Generated role dependency availability is caught too late, often at compile.
- There is no split broker that owns scopes, write sets, candidate states, and
  atomic promotion.

The real HIPRT validation showed the failure mode clearly:

- a large real project produced plausible generated roles
- model output depended on unavailable ImGui headers
- the issue was not just output-token budget
- dependency/render ownership should have been rejected before compile repair

## 5. Design Principle

Do not make the AI smarter by giving it one giant prompt.

Use the existing CodeIntel/RAG stack to build a controlled project intelligence
layer:

```text
workspace index
  -> build metadata
  -> GPU workspace intelligence
  -> split readiness gate
  -> deterministic split broker
  -> role-scoped retrieval packages
  -> staged AI proposals
  -> deterministic verifiers
  -> atomic candidate promotion
```

RAG retrieves and explains.

Verifiers decide.

The broker owns scope.

## 6. Target Architecture

### 6.1 New Component: GPU Workspace Intelligence

Add a GPU-specific intelligence artifact built on top of CodeIntel/RAG.

Suggested module:

```text
ai-backend/ai-engine/gpu_hmr/workspace_intelligence.py
```

Suggested persisted artifact:

```text
.synthi/gpu_hmr/workspace_intelligence.json
```

It should be derived from:

- CodeIntel file metadata
- DualIndexer generation ID
- structural index
- lexical/vector retrieval
- RAG summaries/citations
- compile database
- CMake File API
- selected target information
- include/link metadata
- GPU toolchain capability probes
- template evidence artifacts when present

Minimum shape:

```json
{
  "schemaVersion": "gpu-hmr-workspace-intelligence-v1",
  "workspaceRoot": "...",
  "indexGeneration": "...",
  "sourceHash": "...",
  "codeIntel": {
    "status": "fresh",
    "filesIndexed": 1817,
    "chunksIndexed": 4200,
    "symbolsTracked": 900,
    "ragStatus": "fresh"
  },
  "targetCandidates": [],
  "selectedTarget": null,
  "compileCommandIdentities": [],
  "deviceTranslationUnits": [],
  "kernelSymbols": [],
  "launchSites": [],
  "hostDeviceStateTypes": [],
  "graphicsOwnership": {
    "status": "unknown",
    "backendCandidates": [],
    "evidence": []
  },
  "dependencies": {
    "includeRoots": [],
    "linkLibraries": [],
    "availableHeaders": [],
    "unresolvedHeaders": []
  },
  "templateEvidence": {
    "status": "missing",
    "reasonCodes": ["template_evidence_missing"]
  },
  "reasonCodes": []
}
```

This artifact is not proof of reload safety. It is the input to split
readiness and broker role packaging.

### 6.2 New Component: Split Readiness Gate

Before any full AI split, compute a readiness report.

Suggested module:

```text
ai-backend/ai-engine/gpu_hmr/split_readiness.py
```

Suggested output:

```json
{
  "schemaVersion": "gpu-hmr-split-readiness-v1",
  "status": "ready",
  "workspaceIntelligenceHash": "...",
  "selectedTargetStatus": "selected",
  "compileMetadataStatus": "available",
  "codeIntelStatus": "fresh",
  "ragStatus": "fresh",
  "deviceTopologyStatus": "single_device_tu",
  "graphicsOwnershipStatus": "modeled",
  "dependencyStatus": "available",
  "reasonCodes": []
}
```

Failure examples:

```text
split_readiness.target_ambiguous
split_readiness.compile_db_missing
split_readiness.cmake_file_api_missing
split_readiness.codeintel_index_stale
split_readiness.rag_index_stale
split_readiness.graphics_ownership_unmodeled
split_readiness.generated_header_missing
split_readiness.dependency_unavailable
```

If readiness fails, do not call the AI split endpoint unless the failure is
explicitly marked as a non-blocking advisory. Return an actionable failure.

### 6.3 New Component: Split Broker

The split broker is the critical control layer.

Suggested module:

```text
ai-backend/ai-engine/gpu_hmr/split_broker.py
```

The broker is deterministic. It owns:

- role boundaries
- allowed source scope
- allowed generated write set
- role dependencies
- stage order
- candidate artifact state
- cross-role transaction policy
- promotion policy

The AI never decides what it is allowed to touch.

Role package example:

```json
{
  "schemaVersion": "gpu-hmr-role-package-v1",
  "roleId": "device.main",
  "roleKind": "device",
  "selectedTarget": "gpu_app",
  "allowedSourceFiles": [
    "src/gpu/raster.hip",
    "src/gpu/raster_helpers.hpp"
  ],
  "allowedGeneratedFiles": [
    ".synthi/generated/.../device_raster.hip"
  ],
  "requiredSymbols": [
    "shade_pixels"
  ],
  "requiredCitations": [
    {
      "path": "src/gpu/raster.hip",
      "reason": "kernel_definition"
    }
  ],
  "forbiddenActions": [
    "write_user_workspace",
    "include_unowned_project_header",
    "invent_external_dependency",
    "rename_kernel_without_mapping"
  ],
  "dependencies": {
    "generatedRoles": ["shared"],
    "headers": [],
    "libraries": []
  }
}
```

The broker should reject generated output that:

- writes into the user workspace
- references source files outside the role package
- invents includes or libraries not backed by metadata
- touches another role without a broker-issued multi-role transaction
- omits required citations
- bypasses launch indirection in reloadable paths

### 6.4 Candidate Artifact Lifecycle

Background split output must be stored as candidate state, not active state.

Suggested states:

```text
draft
  -> schema_verified
  -> dependency_verified
  -> mapping_verified
  -> abi_verified
  -> compile_verified
  -> runtime_verified
  -> accepted
  -> promoted
```

Rejected candidates are kept with reason-coded evidence.

Promotion is atomic and only allowed after required verifiers pass.

Suggested location:

```text
.synthi/gpu_hmr/candidates/<candidate_id>/
.synthi/gpu_hmr/accepted/current.json
```

The active `.synthi_split_meta.json` can reference the accepted candidate, but
should not be the only source of truth for in-progress split work.

## 7. Background Modular Split Strategy

Yes, GPU HMR should split modules in the background.

But "background" must mean:

```text
prepare candidate internal artifacts
```

not:

```text
mutate user source or silently replace active generated roles
```

### 7.1 Why Background Split Helps

Large projects are too complex for a compile-click-time full split:

- RAG indexing and summaries can be expensive.
- Render ownership may need several retrieval passes.
- Device dependencies may need graph expansion.
- Generated dependency availability should be checked before compile.
- One giant split call makes repair imprecise.

Background split lets the system do heavy discovery before the user presses
compile.

### 7.2 How It Avoids Touching The Wrong Files

The broker controls write scope.

Rules:

- user workspace is read-only to split agents
- generated write paths are broker-assigned
- each role package has explicit allowed source files
- every generated symbol must map back to source evidence
- every include/library must be backed by build metadata or explicit generated
  role output
- cross-role changes require a broker transaction
- active split is only updated by atomic promotion after verification

The AI can propose. It cannot expand its own authority.

## 8. Staged Split Orchestration

Replace one full AI split call with coordinated stages for large projects.

Small projects may still use a single-call path when readiness says it is safe
and under budget, but the production path should support staged generation.

Recommended stages:

```text
Stage 0: workspace intelligence and split readiness
Stage 1: architecture summary
Stage 2: shared ABI/state contract
Stage 3: device role package(s)
Stage 4: core role package
Stage 5: GUI/render role package
Stage 6: host runner/reload ABI role package
Stage 7: integration manifest
Stage 8: verifier/repair loop
Stage 9: candidate promotion
```

Each stage receives:

- role package
- selected target metadata
- CodeIntel/RAG citations
- accepted previous stage outputs
- relevant source snippets
- verifier feedback from prior attempts

Each stage emits:

- structured role artifact
- source citations
- generated dependencies
- assumptions
- unsupported reason codes
- verifier expectations

Do not persist or promote partial outputs as active split artifacts.

## 9. How To Use Existing RAG/CodeIntel

### 9.1 Index Trigger

Use existing CodeIntel indexing first:

```text
POST /code-intel/index
```

Then attach GPU workspace intelligence refresh to the same lifecycle.

Triggers:

- workspace open
- compile database change
- CMake File API reply change
- selected target change
- file save
- branch checkout
- explicit "refresh GPU HMR index"

### 9.2 Retrieval Profiles

Do not use one generic RAG query. Use role-specific retrieval profiles.

Device role:

```text
Find HIP/CUDA device kernels, device helper functions, runtime compiler APIs,
module launch calls, and target-owned device headers for selected target <T>.
```

Launch graph:

```text
Find host code that launches kernels or calls runtime module launch APIs for
selected target <T>. Include argument construction and state dependencies.
```

Shared ABI:

```text
Find structs, constants, enums, buffers, and state types shared between host,
device, core, GUI, and launch wrappers.
```

Render ownership:

```text
Find window/context creation, frame presentation, texture/display upload, GUI
library setup, and ownership boundaries for selected target <T>.
```

Dependency availability:

```text
Find headers and libraries required by selected target <T>, including include
roots, link libraries, generated headers, and optional GUI dependencies.
```

The output should be citations and ranked evidence, not final safety decisions.

### 9.3 Use RetrievalController Semantics

GPU HMR should produce sufficiency status like CodeIntel:

```text
sufficient
partial
insufficient
empty
```

If required files/symbols cannot be included, the split readiness gate should
block or degrade with explicit reason codes.

### 9.4 Use Grounding Spans

Generated split artifacts should carry citations to CodeIntel/RAG spans.

Example:

```json
{
  "claim": "gui role owns GLFW frame presentation",
  "evidence": [
    {
      "file": "src/main.cpp",
      "startLine": 120,
      "endLine": 180,
      "symbol": "main"
    }
  ]
}
```

The grounding verifier can be extended from text output to generated role
contracts.

## 10. Hardcoding To Remove Or Downgrade

### 10.1 `gpu_source_context.py`

Current hardcoded areas:

- fixed context budgets
- backend regex table
- render regex authority
- `HIPRT_DEVICE` / `HIPRT_HOST_DEVICE` project-family macro hints
- `/kernels/` priority
- `src/` priority
- blanket omission of `examples/`, `tests/`, `vendor/`

Replacement:

- budgets come from model capability profile and broker policy
- backend regexes become low-confidence hints only
- macro evidence comes from compiler/preprocessor metadata or project
  capability profiles
- target-owned files override default omission policy
- CodeIntel/RAG citations explain inclusion
- compile/CMake metadata is authoritative when available

### 10.2 `kernel_splitter.py`

Current issues:

- still describes itself as a single LLM call
- still builds custom project context locally
- still has source-device preservation prompt budgets
- still uses one large prompt plus deterministic repair

Replacement:

- route through split broker for large/real projects
- preserve single-call path only as a small-project optimization
- move source/device preservation into role package contracts
- use staged generation and per-stage verifier feedback

### 10.3 `ai_utils.rs`

Current issues:

- GPU marker detection includes project-family macros
- split cache is source-hash oriented, not accepted-candidate oriented
- worker call shape does not request CodeIntel readiness

Replacement:

- worker asks AI engine for split readiness/candidate status
- accepted candidate IDs become cache keys
- GPU marker detection is advisory only
- source hash remains part of invalidation, not the only identity

### 10.4 Prompt Bias

Active production prompts should not contain fixture-shaped examples or
backend-specific reference implementations that bias outputs.

Replacement:

- prompts generated from role package
- backend capability profile inserts only relevant constraints
- examples are abstract and contract-level

## 11. AI Delta Policy

AI delta is not the normal hot path.

Use AI delta only when:

- a verified split exists
- mappings exist
- user edit is localized
- direct local patch cannot prove safety
- deterministic warm rebuild is not sufficient or not cheaper
- Arbiter policy allows the cost/risk

AI delta receives:

- accepted candidate manifest
- role packages
- source-to-generated mappings
- user delta
- relevant CodeIntel/RAG citations
- reload plan attempt
- verifier/build/runtime failure feedback

AI delta output is accepted only after:

- schema verifier
- role scope verifier
- mapping verifier
- ABI verifier
- dependency verifier
- compile verifier
- runtime/frame verifier where applicable

Direct `.hip` / `.cu` body-only edits remain non-agentic when local proof
succeeds.

## 12. Verifiers To Add

### 12.1 Generated Dependency Availability Verifier

Before compile, inspect generated includes and link flags.

Reject with:

```text
generated.include_unavailable
generated.library_unavailable
generated.backend_dependency_unmodeled
```

This catches failures like generated ImGui includes missing from the worker
image before compile repair loops.

### 12.2 Role Scope Verifier

Verify each generated role stays within its broker package:

- generated path is allowed
- referenced source files are allowed
- generated includes are allowed
- cross-role references are declared
- no user workspace writes

Reject with:

```text
generated.role_scope_violation
generated.unowned_source_reference
generated.cross_role_dependency_unapproved
```

### 12.3 Citation Completeness Verifier

Every critical generated claim should cite source evidence:

- entrypoint
- selected target
- kernel definitions
- launch sites
- shared ABI state
- render/window ownership
- external dependencies

Missing citations block production proof and can block promotion for critical
roles.

### 12.4 Graphics Ownership Verifier

Verify:

- who creates the window/context
- who owns presentation/swap
- whether generated runner may own a window
- whether output is actual GUI or frame-like adapter
- whether framework dependencies exist

Reject with:

```text
unsupported.graphics_ownership_unmodeled
generated.render_dependency_unavailable
generated.gui_role_no_visible_effect
```

### 12.5 Split Candidate Promotion Verifier

Verify the candidate has passed all required stages before becoming active:

```text
candidate.schema_verified
candidate.mapping_verified
candidate.dependency_verified
candidate.compile_verified
candidate.runtime_verified
```

Promotion failure:

```text
candidate_promotion.verifier_missing
candidate_promotion.artifact_stale
candidate_promotion.index_generation_mismatch
```

## 13. Implementation Milestones

### Milestone 0: Keep Current PR Focused

Tasks:

- finish current PR review
- do not add broker/RAG architecture to current PR
- do not commit temp real-repo clones or local compose overrides
- commit only intentional validation logs if reviewers need them

Done when:

- current GPU HMR hardening PR is mergeable

### Milestone 1: Split Readiness And Model Capabilities

Tasks:

- add model capability profile for context/output budgets
- add split readiness schema
- report CodeIntel/RAG freshness in split readiness
- downgrade regex context matches to fallback evidence
- keep old source context behavior as compatibility fallback

Done when:

- GPU split can say "not ready" before calling AI
- budgets are not hardcoded in `gpu_source_context.py`
- readiness report is emitted in split responses and run reports

### Milestone 2: Generated Dependency Verifier

Tasks:

- extract includes and link deps from generated roles
- compare against selected target include/link metadata
- classify optional vs required only with explicit evidence
- reject unavailable generated deps before compile repair

Done when:

- HIPRT-style missing ImGui header is rejected before compile
- verifier emits reason-coded dependency evidence

### Milestone 3: GPU Workspace Intelligence Artifact

Tasks:

- add GPU intelligence builder on top of CodeIntel engine/indexes
- persist `.synthi/gpu_hmr/workspace_intelligence.json`
- include index generation, source hash, target metadata, device graph, render
  ownership evidence, dependency availability, and RAG status
- add invalidation rules

Done when:

- source context selection can cite workspace intelligence instead of redoing
  prompt-time discovery

### Milestone 4: Split Broker And Role Packages

Tasks:

- add role package schema
- add deterministic broker for shared/device/core/gui/runner packages
- add role scope verifier
- store candidate artifacts separately from accepted artifacts
- add atomic promotion

Done when:

- AI cannot expand its own source or write scope
- generated artifacts remain internal and candidate-based until verified

### Milestone 5: RAG-Backed Role Retrieval

Tasks:

- define retrieval profiles for device, launch, shared ABI, render ownership,
  dependencies
- call CodeIntel/RAG retrieval from broker
- record citations and context sufficiency
- feed role-scoped context into staged split prompts

Done when:

- large project split context comes from indexed retrieval and citations
- every included/dropped file has a metadata/RAG reason

### Milestone 6: Staged Split Generation

Tasks:

- split architecture summary from role generation
- generate roles in stages
- run stage contract verifier after each stage
- pass accepted contracts forward
- repair only failed stages where safe

Done when:

- a GUI dependency failure does not require rerunning every role
- large real projects no longer depend on one giant AI response

### Milestone 7: Real Project Validation

Tasks:

- validate at least two real ROCm GUI-ish projects or one real GUI project plus
  one real ROCm workload with a generic frame adapter
- record target resolution, index freshness, retrieval citations, split stage
  timings, first frame, user `.hip` edit, reload plan, HMR timing, screenshots
- explicitly record unsupported/fallback cases

Done when:

- failures are classified, not generic build errors
- reproducible artifacts exist for each claimed backend/project

## 14. Testing Strategy

Unit tests:

- split readiness blocks stale CodeIntel index
- target-owned `examples/` or `tests/` source is not dropped
- regex backend hints are low-confidence evidence
- model capability profile controls context/output budgets
- generated dependency verifier catches missing includes
- role scope verifier catches unowned source references
- candidate promotion requires verifier completion

Integration tests:

- existing SDL2/ROCm natural device-only path
- GLFW/OpenGL ROCm path
- ambiguous multi-target CMake project
- duplicate compile command entries
- Vulkan explicit unsupported fallback
- missing generated dependency case
- stale RAG index case

Real project tests:

- real ROCm GUI/render project if available
- real ROCm workload with generic frame adapter
- large project with more than 1,000 files

Required metrics:

- CodeIntel index time
- RAG ingest freshness and time
- split readiness time
- role retrieval time
- split stage times
- first compile time
- first frame time
- direct HMR wall time
- AI delta count
- verifier failure reason codes
- screenshot paths

## 15. Branch And Commit Plan

Branch:

```text
feature/gpu-hmr-codeintel-split-broker
```

Suggested commits:

1. `docs(gpu-hmr): finalize codeintel split broker plan`
2. `feat(gpu-hmr): add split readiness schema`
3. `feat(gpu-hmr): add model capability split budgets`
4. `feat(gpu-hmr): add generated dependency verifier`
5. `feat(gpu-hmr): build gpu workspace intelligence artifact`
6. `feat(gpu-hmr): add deterministic split broker packages`
7. `feat(gpu-hmr): attach codeintel retrieval to role packages`
8. `feat(gpu-hmr): stage gpu full split generation`
9. `test(gpu-hmr): validate staged split on real rocm projects`

Commit frequently, but keep validation artifacts intentional and reviewable.

## 16. Acceptance Criteria

This architecture is working when:

1. GPU HMR uses CodeIntel/RAG as project intelligence, not a parallel scanner.
2. Split readiness can block unsafe AI calls before generation.
3. Source context is metadata-first and citation-backed.
4. Regex heuristics are advisory, not authority.
5. The split broker owns source scope and generated write scope.
6. AI cannot silently touch unowned files or roles.
7. Generated dependency failures are caught before compile repair loops.
8. Large projects use staged split calls.
9. Candidate split artifacts are promoted only after deterministic verification.
10. Direct body-only device edits remain non-agentic when locally provable.
11. AI delta remains a verifier-gated fallback, not the default edit path.
12. Every production claim has reproducible validation artifacts.

## 17. Final Architecture Summary

The final shape should be:

```text
CodeIntel index + RAG ingest
  -> GPU workspace intelligence artifact
  -> split readiness gate
  -> deterministic split broker
  -> role-scoped retrieval packages
  -> staged AI proposals
  -> schema/dependency/mapping/ABI/compile/runtime verifiers
  -> atomic candidate promotion
  -> direct device-only HMR for safe body edits
  -> AI delta only when local proof cannot safely patch
```

That uses the sophisticated system already in the repo instead of adding
another RAG layer, and it aligns with `docs/GPU_HMR_PROD_NEXT.md`.
