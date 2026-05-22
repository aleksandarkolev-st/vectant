# GPU HMR CodeIntel Split Broker Implementation Plan

Draft date: 2026-05-21

Status: ready to start the next GPU HMR branch through Milestones 1-3, but not
frozen as the final implementation spec. This version is intentionally stricter
than the previous architecture draft. It defines the state machine, identity
model, retrieval identity, API semantics, broker packages, verifier contracts,
and promotion rules tightly enough to begin implementation while later
milestones continue to harden verifier detail and real validation.

## 1. Recommendation

Merge the current GPU HMR production-orchestrator PR after review and CI, then
start this work on a separate branch:

```text
feature/gpu-hmr-codeintel-split-broker
```

Do not continue expanding the current stabilization PR with this architecture
work. The current PR should stay focused on hardening the existing GPU HMR
path. This plan changes the split pipeline itself.

Do not call GPU HMR production ready until `docs/GPU_HMR_PROD_NEXT.md` has
current reproducible validation artifacts for every claimed backend/path.

## Architecture Intent

GPU HMR should become a transactional split-and-reload pipeline over a real
build target, not a prompt that happens to emit compilable files.

The intended architecture is:

```text
CodeIntel index + build metadata authority
  -> target-scoped projection
  -> phased readiness
  -> broker-issued role scope packages
  -> deterministic RAG-backed role context packages
  -> AI proposals inside explicit scope
  -> immutable candidate artifacts
  -> deterministic verifier promotion
  -> direct non-agentic HMR where locally provable
```

The key design choice is authority separation:

- CodeIntel and build metadata decide what source and target facts exist.
- The broker decides what each generated role may see, include, adapt, and
  write.
- RAG provides cited context and explanations, not safety decisions.
- AI proposes generated artifacts only inside a role generation package.
- Verifiers and the Arbiter decide whether a candidate can compile, run,
  reload, and be promoted.

This means the system can do background preparation for large projects without
touching active state, and it can reject unsafe or underspecified cases with
actionable reason codes instead of discovering scope errors through failed
compiles.

## 2. Non-Negotiable Design Rules

1. GPU HMR must not build a second RAG or indexing system.
2. GPU HMR consumes target-scoped projections over CodeIntel and build metadata.
3. RAG retrieves and explains; it never proves safety.
4. The broker owns source scope and generated write scope.
5. AI proposes artifacts only inside broker-issued packages.
6. Generated artifacts remain candidates until deterministic verifiers pass.
7. Promotion is an atomic pointer update to immutable candidate artifacts.
8. Direct `.hip` / `.cu` body-only edits stay non-agentic when local proof
   succeeds.
9. AI delta is a verifier-gated fallback, not the normal hot path.
10. Small-project single-call split cannot bypass readiness, broker packages,
    candidate spec manifests, verifiers, or promotion.

## 3. Ownership Boundaries

### CodeIntel Owns

- workspace file metadata
- index generations
- vector index
- lexical/BM25 index
- structural index and symbol graph
- edge confidence metadata
- RAG stores and retrieval traces
- grounding spans
- file reindexing on save/delete/rename

### Build Metadata Layer Owns

- build system discovery
- selected target identity
- compile command identity
- effective flags hash
- include roots
- generated header roots
- link libraries and link directories
- runtime library paths
- compiler/toolchain probes
- dependency scan evidence

### GPU HMR Owns

- target-scoped projections
- readiness reports
- role scope packages
- role generation packages
- candidate spec manifests
- candidate artifact directories
- verifier reports
- accepted candidate pointer
- reload plan and Arbiter integration

### AI Owns

- proposal text for the assigned generation package only

AI never owns:

- target selection
- source scope
- generated write scope
- dependency availability
- ABI safety
- runtime safety
- promotion

## 4. API Surface

GPU HMR needs explicit APIs. The worker should not infer readiness from
`/refactor/split/gpu`.

```text
POST /gpu-hmr/readiness
POST /gpu-hmr/projections
GET  /gpu-hmr/projections/{hash}
POST /gpu-hmr/prepare-candidate
GET  /gpu-hmr/candidates?selectedTargetIdentityHash=...
GET  /gpu-hmr/candidates/{id}
GET  /gpu-hmr/candidates/{id}/trace
POST /gpu-hmr/candidates/{id}/verify
POST /gpu-hmr/candidates/{id}/promote
POST /gpu-hmr/candidates/{id}/cancel
POST /gpu-hmr/candidates/{id}/diagnose
GET  /gpu-hmr/jobs/{id}
GET  /gpu-hmr/jobs/{id}/trace
POST /gpu-hmr/jobs/{id}/cancel
GET  /gpu-hmr/accepted/current
```

### API Semantics

`POST /gpu-hmr/readiness`

- synchronous
- no AI calls
- idempotent for the same identity inputs
- returns readiness phases and blocking/advisory reason codes

`POST /gpu-hmr/projections`

- synchronous for small workspaces when CodeIntel/build metadata are fresh
- may return `202 Accepted` and a job ID for large workspaces
- idempotent by projection identity
- never scans independently from CodeIntel/build metadata authority

`POST /gpu-hmr/prepare-candidate`

- asynchronous by default
- idempotent by candidate identity
- cancellable
- resumable only if all referenced generations still match
- returns candidate ID and current state

`GET /gpu-hmr/jobs/{id}`

- returns status for asynchronous projection, preparation, verification, or
  diagnostic jobs
- includes linked resource identity when the job created a projection or
  candidate
- idempotent and safe to poll

`GET /gpu-hmr/jobs/{id}/trace`

- returns bounded trace events, reason codes, and phase timings
- redacts raw source unless debug capture is explicitly enabled

`POST /gpu-hmr/jobs/{id}/cancel`

- marks cancellable jobs as cancelled
- does not delete immutable candidates or verified artifacts
- verification/promotion must fail closed if a dependent job is cancelled

`POST /gpu-hmr/candidates/{id}/verify`

- asynchronous when compile/runtime verification is requested
- fails closed on stale source, CodeIntel, retrieval, target, or runtime
  identity

`POST /gpu-hmr/candidates/{id}/promote`

- synchronous atomic pointer update
- requires promotion readiness
- rejects if another promotion transaction is active

Candidate list queries must use identity hashes, not display target names.
Target names collide across build roots, configurations, and manually selected
profiles.

Compatibility rule:

- `/refactor/split/gpu` may call these APIs internally during transition.
- readiness failure must not silently fall back to the old one-shot split path.
- unsupported target/project states permit only diagnostics, not generation.

### Minimum API Payloads

All mutating requests require an idempotency key:

```json
{
  "idempotencyKey": "workspace-id:operation:identity-hash"
}
```

Common error shape:

```json
{
  "error": {
    "code": "target_resolution_ambiguous",
    "message": "Selected file belongs to more than one executable target.",
    "phase": "preflight_readiness",
    "severity": "blocking",
    "safeFallbackMode": "diagnostics_only",
    "remediation": "Select an explicit target."
  }
}
```

Status code policy:

```text
200 OK: synchronous operation completed
202 Accepted: asynchronous job started or resumed
400 Bad Request: malformed request
404 Not Found: candidate/projection/job not found
409 Conflict: stale identity, concurrent promotion, or cancelled dependency
422 Unprocessable Entity: valid request blocked by readiness/verifier policy
500 Internal Server Error: infrastructure failure without a safe verifier result
```

`POST /gpu-hmr/readiness`

Request:

```json
{
  "workspaceRootDigest": "...",
  "entryFile": "src/app/main.cpp",
  "selectedTargetIdentityHash": null,
  "operationMode": "normal",
  "idempotencyKey": "..."
}
```

Response `200 OK`:

```json
{
  "schemaVersion": "gpu-hmr-readiness-response-v1",
  "readiness": {
    "preflight": "pass",
    "projection": "pass",
    "scope": "blocked",
    "generation": "blocked",
    "compile": "blocked",
    "promotion": "blocked"
  },
  "blockingReasonCodes": [],
  "advisoryReasonCodes": [],
  "selectedTargetIdentityHash": "...",
  "projectionHash": "..."
}
```

`POST /gpu-hmr/projections`

Request:

```json
{
  "sourceSplitIdentityHash": "...",
  "selectedTargetIdentityHash": "...",
  "codeIntelGeneration": "...",
  "buildMetadataHash": "...",
  "idempotencyKey": "..."
}
```

Response `200 OK` or `202 Accepted`:

```json
{
  "projectionHash": "...",
  "jobId": null,
  "status": "ready"
}
```

`POST /gpu-hmr/prepare-candidate`

Request:

```json
{
  "projectionHash": "...",
  "sourceSplitIdentityHash": "...",
  "requestedRoles": ["shared", "core", "gui", "host_runner", "device.main"],
  "operationMode": "normal",
  "idempotencyKey": "..."
}
```

Response `202 Accepted`:

```json
{
  "candidateId": "...",
  "candidateSpecManifestHash": null,
  "jobId": "...",
  "state": "prepared_candidate"
}
```

`POST /gpu-hmr/candidates/{id}/verify`

Request:

```json
{
  "candidateSpecManifestHash": "...",
  "verificationKinds": ["schema", "scope", "dependency", "mapping", "abi", "compile", "runtime"],
  "runtimeVerificationIdentityHash": "...",
  "idempotencyKey": "..."
}
```

Response `200 OK` or `202 Accepted`:

```json
{
  "candidateId": "...",
  "candidateVerificationRecordHash": "...",
  "jobId": null,
  "state": "compile_verified_candidate",
  "verifierReportHashes": []
}
```

`POST /gpu-hmr/candidates/{id}/promote`

Request:

```json
{
  "candidateSpecManifestHash": "...",
  "candidateVerificationRecordHash": "...",
  "promotionIdentityHash": "...",
  "idempotencyKey": "..."
}
```

Response `200 OK`:

```json
{
  "acceptedPromotionRecordHash": "...",
  "acceptedPointerPath": ".synthi/gpu_hmr/accepted/current.json",
  "state": "active_promoted_candidate"
}
```

`GET /gpu-hmr/jobs/{id}`

Response `200 OK`:

```json
{
  "jobId": "...",
  "jobKind": "prepare_candidate",
  "status": "running",
  "linkedResource": {
    "candidateId": "...",
    "projectionHash": null
  },
  "phase": "role_generation",
  "reasonCodes": [],
  "startedAt": "...",
  "updatedAt": "..."
}
```

## 5. Identity Model

Do not use one large candidate identity for everything. Split identity by
phase so source-level split work is not invalidated by unrelated runtime
changes, and runtime-sensitive work is not reused unsafely.

### 5.1 Source Split Identity

Used for projection, broker scoping, source-to-role mapping, and AI source
generation. It contains target-level input identity only; broker-selected role
spans are recorded later as `roleSourceSpanHash`.

```json
{
  "schemaVersion": "gpu-hmr-source-split-identity-v1",
  "workspaceRootDigest": "...",
  "gitCommit": "...",
  "dirtyTreeHash": "...",
  "targetInputFileHash": "...",
  "buildConfigInputHash": "...",
  "generatedHeaderContentHash": "...",
  "buildSelectionEnvironmentHash": "...",
  "selectedTargetIdentityHash": "...",
  "codeIntelGeneration": "...",
  "splitSchemaVersion": "...",
  "promptSchemaVersion": "..."
}
```

### 5.2 Compile Candidate Identity

Used for generated artifact compile/cache validity.

```json
{
  "schemaVersion": "gpu-hmr-compile-candidate-identity-v1",
  "sourceSplitIdentityHash": "...",
  "selectedTargetIdentityHash": "...",
  "targetCompileMetadataHash": "...",
  "toolchainProbeHash": "...",
  "compilerToolchainIdentityHash": "...",
  "gpuExecutionProfileHash": "...",
  "buildWorkerEnvironmentHash": "...",
  "generatedArtifactHash": "..."
}
```

### 5.3 Runtime Verification Identity

Used for runtime/frame verification validity.

```json
{
  "schemaVersion": "gpu-hmr-runtime-verification-identity-v1",
  "compileCandidateIdentityHash": "...",
  "runtimeVerificationEnvironmentHash": "...",
  "verificationRuntimeEnvironmentHash": "...",
  "deploymentRuntimeEnvironmentHash": "...",
  "gpuRuntimeDriverHash": "...",
  "graphicsOwnershipState": "...",
  "displayBackend": "..."
}
```

### 5.4 AI Generation Identity

Used for AI stage cache validity.

```json
{
  "schemaVersion": "gpu-hmr-ai-generation-identity-v1",
  "roleGenerationPackageHash": "...",
  "modelProfileHash": "...",
  "modelName": "...",
  "temperaturePolicy": "...",
  "promptHash": "...",
  "promptSchemaVersion": "...",
  "retrievalTraceHash": "...",
  "retrievalProfileHash": "...",
  "queryHash": "...",
  "rankerVersion": "...",
  "rrfMmrSettingsHash": "...",
  "contextBudgetHash": "...",
  "citationFilterHash": "...",
  "hydeQueryRewriteSettingHash": "...",
  "topKAndCandidateBudgetHash": "..."
}
```

### 5.5 Promotion Identity

Used to decide whether a verified candidate may become active.

```json
{
  "schemaVersion": "gpu-hmr-promotion-identity-v1",
  "candidateId": "...",
  "candidateSpecManifestHash": "...",
  "candidateVerificationRecordHash": "...",
  "requiredVerifierReportSetHash": "...",
  "sourceSplitIdentityHash": "...",
  "compileCandidateIdentityHash": "...",
  "runtimeVerificationIdentityHash": "...",
  "promotionVerifierReportHash": "..."
}
```

### 5.6 Hash Definitions

- `targetInputFileHash`: target-owned user input files known from build
  metadata before projection. Excludes `.synthi/`, generated roles, candidate
  directories, build outputs, and logs.
- `roleSourceSpanHash`: broker-selected source spans after role scoping. This
  is not part of `sourceSplitIdentityHash`, because projection is created
  before broker role spans exist.
- `buildConfigInputHash`: `CMakeLists.txt`, `CMakePresets.json`, toolchain
  files, manually selected target config, build-system project files, and
  environment inputs used by configuration.
- `generatedHeaderContentHash`: generated headers required by selected target
  before split generation.
- `targetCompileMetadataHash`: compile command entries, effective flags,
  include roots, system include roots, generated header roots, link flags, and
  runtime paths for the selected target.
- `toolchainProbeHash`: compiler/toolkit/runtime probe results.
- `buildSelectionEnvironmentHash`: environment variables that affect target
  selection, build configuration, compile commands, generated headers, or
  toolchain selection.
- `runtimeVerificationEnvironmentHash`: environment variables that affect
  display, GPU visibility, runtime libraries, capture, or driver/session
  verification. Runtime-only changes invalidate runtime verification, not
  source split work.
- `compilerToolchainIdentityHash`: canonical compiler, toolkit, runtime, and
  language-mode identity derived from selected target metadata and toolchain
  probes.
- `gpuExecutionProfileHash`: canonical GPU vendor, architecture, RDC/device-link
  mode, and device runtime capability identity.
- `generatedArtifactHash`: generated role files only. It does not include
  candidate spec manifests, verifier reports, status ledgers, or promotion
  records.
- `candidateSpecManifestHash`: immutable candidate spec manifest containing
  identities, role artifact refs, package hashes, and mapping refs.
- `candidateVerificationRecordHash`: verifier reports, runtime identity,
  current derived state, and transition history.
- `acceptedPromotionRecordHash`: candidate spec manifest hash plus required
  verifier report hashes and promotion identity.

### 5.7 Canonical Hashing Rules

Milestone 1 must implement one canonical hashing library and use it for every
identity, manifest, package, verifier report, and promotion record.

Canonicalization rules:

- JSON is serialized as UTF-8 without insignificant whitespace.
- Object keys are sorted lexicographically by Unicode code point.
- Arrays preserve semantic order when order is meaningful, such as ordered
  context spans, verifier transition history, and compiler arguments.
- Arrays are sorted by stable key when order is not meaningful, such as reason
  code sets, role package hash sets, verifier report hash sets, and dependency
  allowlists.
- Paths are workspace-relative, slash-normalized, dot-segment-normalized, and
  NFC-normalized.
- Filesystem identity records whether the workspace is case-sensitive or
  case-insensitive. Case-insensitive collisions are rejected before hashing.
- Symlinks are resolved according to the path-scope verifier policy before
  hashing. Symlink escapes are rejected.
- Source text is UTF-8 normalized to NFC before hashing.
- Line endings are normalized to `\n` for source/content hashes unless a file is
  classified as binary.
- Timestamps are excluded from identity hashes unless the field is explicitly
  part of an audit record, such as `createdAt` or `promotedAt`.
- Environment variables are sorted by key, include only allowlisted variables,
  and store redacted values when secrets are possible.
- Numeric values use canonical JSON number formatting.
- Null and omitted field semantics must be schema-defined. Do not treat them as
  equivalent by default.

If any producer cannot apply canonicalization, it must not emit a production
identity hash.

### 5.8 Candidate ID Derivation

Candidate lookup is keyed by `candidateSpecManifestHash`.

`candidateId` should be deterministic when all inputs are available:

```text
candidateId =
  hash(
    schemaVersion
    + sourceSplitIdentityHash
    + ordered(roleGenerationPackageHashes)
    + generatedArtifactHash
  )
```

If a UUID is used for in-progress asynchronous work before generated artifacts
exist, the final candidate resource must still publish and be retrievable by
`candidateSpecManifestHash`. Idempotent requests must resolve to the same
resource when the spec manifest hash matches.

## 6. Build Metadata Hierarchy

Manual config is high-priority when explicit, but must be validated.

Target resolution order:

1. explicit user/project target config
2. CMake File API
3. `compile_commands.json`
4. inferred fallback
5. unsupported

Metadata enrichment order after a target or compile command is known:

1. compiler dependency scan
2. toolchain probe
3. runtime probe
4. generated header content scan
5. link/runtime library resolution

Reason codes:

```text
target.explicit_project_config
target.cmake_file_api_selected
target.compile_commands_only
target.inferred_fallback
metadata.compiler_dependency_scan
metadata.toolchain_probe
metadata.runtime_probe
metadata.generated_header_scan
metadata.link_runtime_resolution
target_resolution_ambiguous
target_resolution_unmatched
target_config_invalid
build_metadata_missing
unsupported.build_system_unmodeled
```

Selected target identity must include:

- build system
- build root
- build configuration
- target name
- target type
- compiler path
- compiler ID/version
- language standards
- defines/undefines
- include/system include roots
- generated header roots
- source files
- link libraries/directories
- runtime library paths
- GPU vendor and arch
- RDC/device-link mode
- worker runtime/toolchain identity

## 7. Compile-Aware Metadata

This is an early milestone, not a nice-to-have.

Pattern parsing and tree-sitter are not enough for HIP/CUDA split safety.
Macros, compile flags, include paths, generated headers, and vendor dialects
matter.

Required capabilities:

- parse selected target files with selected compile commands
- use clangd/libclang/clang tooling where possible
- support compile-commands-backed macro expansion
- resolve quoted and angle includes with actual include roots
- integrate `clang-scan-deps` or equivalent where available
- record parser status and exact effective flags hash
- classify evidence source

Evidence classes:

```text
compiler_ast
compiler_dep_scan
lsp
codeintel_structural
rag_retrieval
regex_hint
manual_config
```

Only compiler-derived or verified build metadata evidence can participate in
ABI/layout safety. RAG and regex evidence can route or explain only.

Minimum evidence by operation:

```text
preflight/projection:
  selected target identity or blocking ambiguity reason
  targetInputFileHash
  CodeIntel generation
  build metadata identity

scope/generation:
  codeintel_structural evidence
  selected target metadata
  compile_commands-backed include/link roots
  no regex-only ownership decisions

compile:
  selected compile command
  compiler_dep_scan or compile_commands-backed include resolution
  generated header content hash
  toolchain probe hash

promotion for ABI-sensitive paths:
  compiler_ast or compiler-generated ABI probe
  vendor compiler artifact evidence where available
  launch-mode-specific ABI verifier report
```

If the minimum evidence for an operation is missing, that operation is blocked
with a precise reason code. The system may still produce diagnostics.

## 8. Target-Scoped Projection

Projection comes before readiness.

Suggested module:

```text
ai-backend/ai-engine/gpu_hmr/projection.py
```

Suggested persisted path:

```text
.synthi/gpu_hmr/projections/<projection_hash>.json
```

The projection is immutable and content-addressed. It is a compact view over
CodeIntel/build metadata, not copied RAG context and not an independent index.

Minimum shape:

```json
{
  "schemaVersion": "gpu-hmr-target-projection-v1",
  "projectionHash": "...",
  "sourceSplitIdentityHash": "...",
  "codeIntelGeneration": "...",
  "buildMetadataHash": "...",
  "selectedTargetIdentity": {},
  "sourceSets": {
    "targetOwned": [],
    "deviceReachable": [],
    "renderReachable": [],
    "stateReachable": []
  },
  "retrievalEvidence": {
    "device": {
      "retrievalTraceHash": "...",
      "retrievalProfileHash": "...",
      "citationSpanIds": [],
      "sufficiency": "retrieval_context_sufficient"
    }
  },
  "buildEvidenceRefs": [],
  "toolchainEvidenceRef": "...",
  "reasonCodes": []
}
```

Do not store large retrieved chunks, summaries, or copied source text in the
projection. Store pointers, span IDs, hashes, and sufficiency.

## 9. Readiness Model

Readiness is phased.

```text
preflight_readiness
projection_readiness
scope_readiness
generation_readiness
compile_readiness
promotion_readiness
```

### preflight_readiness

Allows metadata/index discovery.

Requires:

- workspace readable
- CodeIntel engine available
- build metadata discovery attempted

### projection_readiness

Allows creating a target-scoped projection.

Requires:

- selected target identity or target ambiguity/unsupported reason
- CodeIntel generation known
- build metadata identity known or explicit unsupported reason

### scope_readiness

Allows broker to create role scope packages.

Requires:

- fresh projection
- selected target identity
- source sets resolved
- compiler metadata sufficient for source ownership

Unsupported targets block scope readiness except in `diagnostics_only` mode.

### generation_readiness

Allows AI proposal for internal candidate artifacts.

Requires:

- role scope packages created
- role generation packages created
- required retrieval context sufficient
- blocking dependency precheck failures absent
- selected target identity present

Unsupported reason does not allow generation. It allows only:

```text
diagnostics_only
fallback_report
advisory_output
```

### compile_readiness

Allows compiling candidate artifacts.

Requires:

- candidate spec manifest exists
- candidate verification record exists
- role scope verifier passes
- dependency verifier passes or all unresolved dependencies are non-blocking
  with proof
- compile candidate identity matches current generations

### promotion_readiness

Allows active split promotion.

Requires:

- schema verifier pass
- role scope verifier pass
- mapping verifier pass
- dependency verifier pass
- ABI/layout verifier pass where required
- compile verifier pass
- runtime/frame verifier pass where required
- no source/target/CodeIntel/RAG/runtime generation changed during
  verification

Use precise reason names:

```text
retrieval_context_sufficient
retrieval_context_partial
retrieval_context_insufficient
safety_not_proven
compiler_metadata_sufficient
promotion_safety_verified
```

RAG freshness or sufficiency is never a safety verdict.

## 10. Broker Package Model

Avoid circular dependencies by separating scope packages from generation
packages.

### 10.1 Role Scope Package

Created by the broker from target projection and build/compiler evidence.

It defines what may be touched, referenced, adapted, or generated.

```json
{
  "schemaVersion": "gpu-hmr-role-scope-package-v1",
  "roleId": "device.main",
  "roleKind": "device",
  "sourceSplitIdentityHash": "...",
  "roleSourceSpanHash": "...",
  "allowedSourceFiles": [],
  "allowedSourceSpans": [],
  "sourceSpanAnchors": [],
  "writePathPolicy": {},
  "includePolicy": {},
  "sourceReferencePolicy": {},
  "dependencyPolicy": {},
  "crossRolePolicy": {},
  "requiredSymbols": [],
  "requiredVerifierRules": []
}
```

`forbiddenActions` may exist as human-readable labels, but enforcement must be
through structured constraints:

```json
{
  "constraints": {
    "writePaths": {},
    "includePolicy": {},
    "sourceReferencePolicy": {},
    "crossRolePolicy": {}
  }
}
```

### 10.2 Role Generation Package

Created after retrieval fills the role context.

```json
{
  "schemaVersion": "gpu-hmr-role-generation-package-v1",
  "roleScopePackageHash": "...",
  "retrievalTraceHash": "...",
  "retrievalProfileHash": "...",
  "queryHash": "...",
  "rankerVersion": "...",
  "rrfMmrSettingsHash": "...",
  "contextBudgetHash": "...",
  "citationFilterHash": "...",
  "hydeQueryRewriteSettingHash": "...",
  "topKAndCandidateBudgetHash": "...",
  "citationSpanIds": [],
  "orderedContextSpanRefs": [],
  "contextAssemblyHash": "...",
  "contextSanitizerVersion": "...",
  "promptTemplateVersion": "...",
  "renderedPromptHash": "...",
  "retrievalContextSufficiency": "retrieval_context_sufficient",
  "promptInputsHash": "...",
  "modelCapabilityProfileHash": "..."
}
```

AI receives the role generation package, not the whole project.

### 10.3 Broker Escalation

If AI or a verifier needs wider scope, it must emit an escalation:

```json
{
  "brokerEscalation": {
    "type": "missing_source_scope",
    "requestedFiles": ["src/render/presenter.cpp"],
    "reason": "launch site references state type not in role scope package"
  }
}
```

The broker approves or rejects deterministically. AI cannot widen its own
scope.

## 11. Stable Source Span Anchors

Line numbers are display data only.

Every source span must include:

- normalized path
- file content hash
- span text hash
- stable symbol ID where available
- CodeIntel generation
- start/end line for display
- start/end byte for exact same-generation lookup
- compiler evidence ID if ABI/layout relevant

Example:

```json
{
  "path": "src/gpu/raster.hip",
  "fileContentHash": "...",
  "spanTextHash": "...",
  "stableSymbolId": "...",
  "codeIntelGeneration": "...",
  "startByte": 1024,
  "endByte": 1890,
  "displayStartLine": 44,
  "displayEndLine": 79
}
```

### Source-To-Generated Mapping Schema

Milestone 1 must define this schema before AI delta or direct body-only HMR can
depend on it.

Minimum mapping entry:

```json
{
  "schemaVersion": "gpu-hmr-source-generated-mapping-v1",
  "mappingId": "kernel:shade_pixels(float*,int,int):device.main",
  "candidateSpecManifestHash": "...",
  "roleId": "device.main",
  "mappingKind": "kernel_body",
  "source": {
    "path": "src/gpu/raster.hip",
    "sourceSpanAnchorHash": "...",
    "fileContentHash": "...",
    "spanTextHash": "...",
    "stableSymbolId": "kernel:shade_pixels(float*,int,int)",
    "displayStartLine": 44,
    "displayEndLine": 79
  },
  "generated": {
    "path": ".synthi/gpu_hmr/candidates/<id>/device/main.hip",
    "generatedArtifactHash": "...",
    "startByte": 3400,
    "endByte": 4266,
    "spanTextHash": "..."
  },
  "abiRelevance": {
    "kernelSignature": true,
    "launchAbi": true,
    "constantOrGlobalLayout": false,
    "hostDeviceSharedLayout": false,
    "stateLayout": false
  },
  "patchability": {
    "directDeviceOnlyEligible": true,
    "aiDeltaEligible": true,
    "requiresWarmRebuild": false,
    "requiresFullResplit": false
  },
  "confidence": "compiler_verified",
  "evidenceRefs": [
    {
      "kind": "compiler_ast",
      "hash": "..."
    }
  ]
}
```

Allowed `mappingKind` values:

```text
kernel_body
device_helper_body
kernel_signature
launch_site
constant_symbol
device_global_symbol
shared_type
host_state_type
render_entrypoint
generated_dependency
```

Allowed `confidence` values:

```text
compiler_verified
codeintel_structural
rag_cited_advisory
regex_hint_only
```

`regex_hint_only` and `rag_cited_advisory` mappings may route diagnostics or
broker escalation, but cannot authorize direct device-only patching, ABI safety,
or promotion.

## 12. Candidate Lifecycle

Background split prepares candidates. It does not imply runtime acceptance.

States:

```text
prepared_candidate
schema_verified_candidate
scope_verified_candidate
dependency_verified_candidate
mapping_verified_candidate
abi_verified_candidate
compile_verified_candidate
runtime_verified_candidate
active_promoted_candidate
rejected_candidate
stale_candidate
cancelled_candidate
```

Do not call a candidate accepted if runtime evidence is required but missing.

Candidate directories are immutable:

```text
.synthi/gpu_hmr/candidates/<candidate_id>/
```

Candidate state is not stored by rewriting the immutable candidate spec
manifest.
Use:

```text
candidate_spec_manifest.json     immutable
verification_record.jsonl        append-only or content-addressed snapshots
promotion_record.json            immutable after promotion
```

Active promotion is a single pointer file:

```text
.synthi/gpu_hmr/accepted/current.json
```

Minimum candidate spec manifest:

```json
{
  "schemaVersion": "gpu-hmr-candidate-spec-manifest-v1",
  "candidateId": "...",
  "sourceSplitIdentityHash": "...",
  "compileCandidateIdentityHash": "...",
  "generatedArtifactHash": "...",
  "roleArtifacts": [
    {
      "roleId": "device.main",
      "path": ".synthi/gpu_hmr/candidates/<id>/device/main.hip",
      "sha256": "..."
    }
  ],
  "roleScopePackageHashes": [],
  "roleGenerationPackageHashes": [],
  "aiGenerationIdentityHashes": [],
  "sourceToGeneratedMappingHash": "...",
  "createdAt": "...",
  "createdBy": "gpu-hmr-prepare-candidate"
}
```

Minimum candidate verification record:

```json
{
  "schemaVersion": "gpu-hmr-candidate-verification-record-v1",
  "candidateId": "...",
  "candidateSpecManifestHash": "...",
  "runtimeVerificationIdentityHash": null,
  "state": "prepared_candidate",
  "transitionHistory": [],
  "verifierReportHashes": [],
  "updatedAt": "..."
}
```

Minimum accepted promotion record:

```json
{
  "schemaVersion": "gpu-hmr-accepted-promotion-record-v1",
  "candidateId": "...",
  "candidateSpecManifestHash": "...",
  "candidateVerificationRecordHash": "...",
  "promotionIdentityHash": "...",
  "requiredVerifierReportHashes": [],
  "promotedAt": "..."
}
```

`acceptedPromotionRecordHash` is the content hash of this record. It is not a
field inside the hashed record.

Verifier state transitions:

| From | To | Required proof |
| --- | --- | --- |
| `prepared_candidate` | `schema_verified_candidate` | `schemaVerifierReport.pass` |
| `schema_verified_candidate` | `scope_verified_candidate` | `roleScopeVerifierReport.pass` |
| `scope_verified_candidate` | `dependency_verified_candidate` | `dependencyVerifierReport.pass` |
| `dependency_verified_candidate` | `mapping_verified_candidate` | `mappingVerifierReport.pass` or `mappingNotRequiredReason` |
| `mapping_verified_candidate` | `abi_verified_candidate` | `abiVerifierReport.pass` or `abiProofNotRequiredReason` |
| `abi_verified_candidate` | `compile_verified_candidate` | `compileVerifierReport.pass` |
| `compile_verified_candidate` | `runtime_verified_candidate` | `runtimeVerifierReport.pass` or `runtimeProofNotRequiredReason` |
| `runtime_verified_candidate` | `active_promoted_candidate` | `promotionVerifierReport.pass` and atomic pointer update |

Any verifier failure moves the candidate to `rejected_candidate` with the
verifier report hash and reason code. Any identity/generation mismatch moves it
to `stale_candidate`. These state changes append verification records; they do
not mutate the candidate spec manifest.

## 13. Verifier Report Schema

Verifier reports are immutable and content-addressed. Promotion consumes report
hashes; it does not re-interpret raw logs.

Minimum shape:

```json
{
  "schemaVersion": "gpu-hmr-verifier-report-v1",
  "verifierName": "dependency",
  "candidateId": "...",
  "candidateSpecManifestHash": "...",
  "inputIdentitySnapshot": {
    "sourceSplitIdentityHash": "...",
    "compileCandidateIdentityHash": "...",
    "runtimeVerificationIdentityHash": null,
    "codeIntelGeneration": "...",
    "retrievalTraceHashes": []
  },
  "status": "pass",
  "blocking": true,
  "reasonCodes": [],
  "proofRefs": [
    {
      "kind": "compiler_dep_scan",
      "hash": "...",
      "path": ".synthi/gpu_hmr/evidence/..."
    }
  ],
  "createdAt": "...",
  "toolVersion": "..."
}
```

Allowed statuses:

```text
pass
fail
warning
not_required
skipped_blocked_by_prior_failure
```

Every transition in the candidate lifecycle must reference a verifier report
hash or an explicit `not_required` report.

## 14. Atomic Promotion Details

Promotion must be implemented as:

1. acquire single workspace promotion lock
2. validate candidate spec manifest hash
3. validate all identity inputs still match
4. reject symlinked pointer path
5. write `current.json.tmp`
6. fsync temp file
7. atomic rename temp to `current.json`
8. fsync parent directory
9. read back pointer
10. verify candidate spec manifest hash after rename
11. release promotion lock

Crash recovery:

- leftover temp pointer files are ignored or cleaned
- previous `current.json` remains valid if rename did not complete
- promoted candidate is immutable and can be revalidated by hash

## 15. RAG Retrieval Identity And Policy

RAG generation alone is insufficient.

Candidate identity must include:

- retrieval trace hash
- retrieval profile hash
- query hash
- ranker version
- RRF/MMR settings hash
- context budget hash
- citation filter hash
- HyDE/query rewrite setting
- top-k and candidate budget settings

For GPU HMR critical retrieval:

- disable HyDE/query rewriting by default
- use deterministic retrieval profiles
- allow LLM query expansion only as advisory evidence
- record per-role retrieval generation IDs
- store span IDs and hashes, not copied large chunks

Retrieval profiles:

```text
device_definitions
kernel_launch_sites
shared_abi_state
render_ownership
generated_dependency_availability
```

## 16. Dependency Policy

Dependency classes alone are too broad. Use class plus explicit allowlists.

Example:

```json
{
  "class": "toolchain_runtime",
  "allowedHeaders": ["hip/hip_runtime.h"],
  "allowedLibraries": ["amdhip64"],
  "toolchainProbeHash": "..."
}
```

Dependency classes:

```text
standard_library
toolchain_runtime
target_declared
generated_role
owned_project_header
read_only_project_header
adapted_project_header
forbidden_project_header
external_optional
external_unavailable
unmodeled
```

Policy:

- `standard_library`: allowed only for the selected language mode and compiler
  probe, for example C++20 plus libstdc++ probe hash.
- `toolchain_runtime`: allowed only through explicit header/library allowlist
  and toolchain probe.
- `target_declared`: allowed when selected target metadata declares it.
- `generated_role`: allowed when broker declared it.
- `owned_project_header`: role package owns and may quote/include or adapt it.
- `read_only_project_header`: may be cited/read for context, not included from
  generated roles.
- `adapted_project_header`: selected declarations may be copied/adapted with
  source-span evidence.
- `forbidden_project_header`: reject if generated role references it.
- `external_optional`: warning unless role requires it for visible output.
- `external_unavailable`: block.
- `unmodeled`: block for promotion.

Resolve:

- quoted includes
- angle includes
- standard library headers
- HIP/CUDA runtime headers
- generated role headers
- transitive project headers
- generated headers
- compile definitions
- include directories
- link libraries
- runtime shared libraries

Split environments:

- `build_worker_environment`
- `verification_runtime_environment`
- `deployment_runtime_environment`

A candidate may compile in the worker and still fail runtime verification if
the verification runtime lacks a library/device/display capability.

## 17. ABI Verifier By Launch Mode

ABI checks depend on launch mechanism.

Launch modes:

```text
direct_compiled_launch
runtime_module_symbol_launch
indirect_reload_trampoline
device_only_body_patch
```

### direct_compiled_launch

Required:

- launch wrapper signature
- kernel parameter order
- parameter sizes/alignment
- host launch argument layout
- host/device shared struct parity

Mangled-name proof may be advisory, not always blocking.

### runtime_module_symbol_launch

Required:

- stable runtime symbol string
- exported/mangled symbol availability where applicable
- runtime module lookup proof
- parameter layout and buffer ownership proof

Symbol-name proof is blocking.

### indirect_reload_trampoline

Required:

- launch indirection table entry
- stable symbol ID
- no stale direct launch pointer
- generation/version tracking
- old artifact lifetime handling

### device_only_body_patch

Required:

- mapped source span unchanged outside body
- kernel/helper signature unchanged
- constants/device globals unchanged
- host launch ABI unchanged
- compiler artifact confirms ABI/layout where available

Common checks:

- `sizeof`
- `alignof`
- `offsetof`
- `extern "C"` boundaries where used
- calling convention where relevant
- pointer ownership class
- buffer lifetime expectations
- RDC/device-link topology

## 18. Graphics Ownership States

Use explicit states:

```text
compute_only
offscreen_render_only
existing_window_owned_by_app
generated_runner_may_own_window
host_application_plugin
remote_or_headless_display
frame_adapter_only
unsupported
ambiguous
```

Notes:

- `compute_only` is not unknown graphics; it means no GUI proof is expected.
- `offscreen_render_only` may provide frame output without a window.
- `host_application_plugin` means generated runner cannot own process/window
  lifecycle.
- `remote_or_headless_display` requires environment-specific frame capture.
- `frame_adapter_only` is useful validation, but not full app GUI HMR.

## 19. Multi-Target And Multi-TU Policy

Device topology:

```text
single_tu
multi_tu_supported
multi_tu_unsupported
```

MVP may support only `single_tu`, but must report:

```text
unsupported.multi_device_tu_for_mvp
```

Multi-target projects must include target identity in every projection,
candidate, role scope package, generation package, verifier report, and reload
plan.

## 20. AI Delta Policy

AI delta is allowed only when:

- an active promoted candidate exists
- source-to-generated mappings exist
- changed user source is localized
- direct deterministic patch cannot prove safety
- warm deterministic rebuild is insufficient or more disruptive
- broker can issue bounded delta role packages
- Arbiter policy allows the cost/risk

AI delta receives:

- active promotion record
- accepted candidate spec manifest
- affected role scope package
- affected role generation package
- source-to-generated mappings
- user delta
- relevant retrieval/citation span IDs
- reload plan attempt
- verifier/build/runtime failure feedback

AI delta may not:

- widen source scope
- write user source
- touch unassigned generated roles
- bypass dependency/ABI/verifier failures
- silently fall back to full split

Direct body-only patch wins when local proof succeeds.

Blocking verifier failures:

```text
delta.scope_widening_attempt
delta.mapping_missing
delta.abi_safety_unproven
delta.generated_dependency_unavailable
delta.multi_role_transaction_unapproved
```

## 21. Concurrency And Staleness

Required controls:

- monotonic workspace generations
- CodeIntel generation locks
- candidate cancellation
- stale job detection
- branch/build-dir invalidation
- one active promotion transaction per workspace
- no promotion if source generation changed during verification
- no promotion if target metadata changed during verification
- no promotion if retrieval identity changed during verification
- no promotion if runtime/toolchain identity changed during verification

Reason codes:

```text
candidate.stale_source_generation
candidate.stale_codeintel_generation
candidate.stale_retrieval_identity
candidate.verification_cancelled
candidate.branch_changed
candidate.build_dir_changed
promotion.concurrent_transaction
```

## 22. Security And Path Scope

Verifiers must reject:

- absolute generated paths
- `..` traversal
- symlink escape
- case-insensitive path collision
- generated files outside `.synthi/gpu_hmr/candidates/<id>/`
- generated CMake or post-build command injection
- generated include of user private file outside broker scope
- prompt-injection text in source comments that tries to override role package

Reason codes:

```text
generated.absolute_path_rejected
generated.path_traversal_rejected
generated.symlink_escape_rejected
generated.case_collision_rejected
generated.command_injection_rejected
source.prompt_injection_ignored
```

## 23. Reason Code Registry

Reason codes must be registered in one versioned registry, not scattered as
free-form strings.

Suggested registry path:

```text
ai-backend/ai-engine/gpu_hmr/reason_codes.json
```

Minimum entry shape:

```json
{
  "code": "target_resolution_ambiguous",
  "phase": "preflight_readiness",
  "severity": "blocking",
  "blocking": true,
  "message": "Selected file belongs to more than one executable target.",
  "requiredRemediation": "Select an explicit target or project target config.",
  "safeFallbackMode": "diagnostics_only",
  "owner": "build_metadata"
}
```

Required fields:

- `code`
- `phase`
- `severity`: `blocking` / `advisory` / `info`
- `blocking`
- `message`
- `requiredRemediation`
- `safeFallbackMode`
- `owner`

Verifier reports, readiness responses, job traces, and UI cards must reference
registered codes. Unknown reason codes are allowed only in debug builds and are
treated as blocking in production.

## 24. Cost And Provider Control

Track:

- model capability profile
- model name/version
- max output tokens
- max context tokens
- prompt hash
- temperature policy
- retry limit
- per-workspace budget
- per-candidate budget
- stage cache hit/miss
- AI call reason
- user-visible reason when generation is skipped

Reason codes:

```text
budget.candidate_ai_limit_exceeded
budget.workspace_ai_limit_exceeded
budget.stage_cache_hit
budget.stage_cache_miss
```

## 25. Revised Milestones

This order is intentional. Projection must exist before readiness can be
meaningful. Full promotion-affecting verifiers need broker packages and
candidate spec manifests, although verifier stubs and schemas can start
earlier.

### Milestone 1: Schemas And Identity

Tasks:

- selected target identity schema
- source split identity schema
- compile candidate identity schema
- runtime verification identity schema
- AI generation identity schema
- promotion identity schema
- candidate spec manifest schema
- candidate verification record schema
- role scope package schema
- role generation package schema
- source-to-generated mapping schema
- accepted pointer schema
- canonical hashing library and fixtures
- deterministic candidate ID derivation

Done when:

- unsafe cache reuse is structurally blocked by identity mismatch
- two implementations produce the same hashes for the same canonical fixture

### Milestone 2: Compile-Aware Metadata

Tasks:

- compile database resolver
- CMake File API adapter
- explicit/manual target config validation
- include/link extraction
- toolchain/runtime/environment probes
- compiler-aware parser/dependency scanner integration

Done when:

- selected target metadata can drive source scope and dependency checks

### Milestone 3: Target-Scoped Projection

Tasks:

- projection builder over CodeIntel/build metadata
- content-addressed projection files
- compact retrieval evidence references
- invalidation rules
- no independent source scanning authority

Done when:

- projection fails closed on any referenced generation/hash mismatch

### Milestone 4: Readiness Gate

Tasks:

- preflight/projection/scope/generation/compile/promotion readiness
- blocking vs advisory reason codes
- CodeIntel generation checks
- retrieval identity checks
- target ambiguity checks
- dependency prechecks

Done when:

- GPU HMR can refuse discovery/generation/compile/promotion with precise reason
  codes before unsafe work begins

### Milestone 5: Split Broker

Tasks:

- role scope packages
- role generation packages
- deterministic source sets
- deterministic write sets
- dependency policies
- broker escalation protocol
- multi-role transaction policy

Done when:

- AI cannot choose its own source scope or generated write scope

### Milestone 6: Verifiers

Tasks:

- dependency verifier
- role scope verifier
- citation verifier
- mapping verifier
- ABI verifier by launch mode
- path/security verifier
- promotion verifier

Done when:

- generated dependency, wrong-scope, stale candidate, path escape, and ABI drift
  failures are caught before unsafe promotion

### Milestone 7: RAG-Backed Role Retrieval

Tasks:

- deterministic retrieval profiles
- HyDE disabled for critical retrieval
- source-span citations
- retrieval identity hashes
- context sufficiency reports

Done when:

- role generation packages receive indexed/cited context instead of ad hoc
  prompt bundles

### Milestone 8: Staged Generation

Tasks:

- deterministic evidence manifest
- optional AI architecture summary over scoped evidence
- role-by-role generation
- failed-stage repair only
- no active partial artifacts

Done when:

- large project split no longer depends on one giant AI response

### Milestone 9: Real Validation

Tasks:

- pin named projects and commits
- pin environment/toolchain
- record screenshots/logs/hashes
- validate stale-state and target-ambiguity failures
- validate large repo and real GUI/frame output cases

Done when:

- validation artifacts prove each claimed workflow

## 26. Validation Set

Current named real project already exercised:

```text
project: HIPRT-Path-Tracer
repo: https://github.com/TomClabault/HIPRT-Path-Tracer.git
commit: d114ed0d4c1d4ff9ea4e2511841819ed9aa59e6e
build system: CMake
target observed: HIPRTPathTracer
classification: real ROCm/HIP GUI/render project
current result: split reached generated GUI compile, failed on unavailable ImGui dependency
purpose: dependency/render ownership and large-project split validation
```

Before implementation of Milestone 9, add at least two more pinned cases:

```text
project: TBD-real-rocm-gui-or-frame-app-2
repo: TBD
commit: TBD
build system: TBD
target: TBD
expected output: visible frame or explicit unsupported fallback
```

```text
project: TBD-real-rocm-workload-with-generic-frame-adapter-3
repo: TBD
commit: TBD
build system: TBD
target: TBD
expected output: frame-like observable output, clearly labeled adapter
```

No production readiness claim is allowed until the TBD cases are resolved with
real pinned repositories, commits, environment, outputs, and artifacts.

## 27. Tests To Add

Add tests for:

- malicious source comment tries to override role package
- absolute generated path rejected
- symlink escape rejected
- case-insensitive path collision rejected
- candidate generated under `.synthi` tries to include user private file
- retrieval profile changed but RAG generation unchanged
- same RAG store generation but different top-k invalidates candidate
- manual target config overrides ambiguous CMake target
- compile command path points outside workspace
- generated header content changes without source file change
- runtime library available in worker but missing in runtime verifier
- direct launch path does not require mangled-name proof
- runtime module launch path requires symbol-name proof
- AI delta cannot widen source scope
- small-project single-call still produces candidate spec manifest
- promotion interrupted between write and rename recovers safely
- candidate stale after file save
- candidate stale after branch checkout
- promotion blocked by CodeIntel generation mismatch
- promotion blocked by retrieval identity mismatch
- standard library include allowed through compiler probe
- ROCm/CUDA runtime include allowed only through toolchain probe
- generated CMake/post-build command injection
- multi-target project with same source file
- multi-config build directory
- duplicate kernel names in different namespaces/files
- macro-generated kernel declarations
- struct ABI drift after user edit
- target-owned `examples/` file not dropped
- target-owned vendor adapter not dropped
- unsupported vendor dependency explicitly rejected

## 28. Defer Or Downgrade

### Defer Template Evidence

Do not add `templateEvidence` as a broad field until producer, invalidation,
and safety authority are defined.

For now:

```text
template_evidence_unavailable
```

blocks template-dependent warm rebuilds.

### Downgrade Global RAG Freshness

Global `ragStatus: fresh` is too coarse.

Use per-role retrieval identity and per-role sufficiency.

### Remove Project Capability Profiles As Authority

Project capability profiles are allowed only if explicit, versioned, and
user-visible. Otherwise they become hidden hardcoding.

## 29. Acceptance Criteria

This architecture is ready to implement when:

1. identity is split into source, compile, runtime, AI, and promotion identities
2. target-scoped projection precedes readiness
3. readiness is phased and non-circular
4. role scope package and role generation package are distinct
5. retrieval identity includes trace/profile/query/ranker/budget hashes
6. projections store compact evidence refs, not copied RAG cache content
7. build metadata hierarchy prioritizes explicit validated config
8. ABI checks are launch-mode-specific
9. dependency policy uses explicit allowlists
10. atomic promotion is specified at filesystem-operation level
11. AI delta policy is explicit and verifier-gated
12. canonical hashing and candidate ID derivation are specified
13. source-to-generated mapping schema is explicit
14. real validation set is pinned before production claims

## 30. Final Flow

```text
CodeIntel index + build metadata
  -> compile-aware metadata/probes
  -> target-scoped projection
  -> phased readiness
  -> broker role scope packages
  -> deterministic RAG-backed retrieval profiles
  -> broker role generation packages
  -> staged AI proposals inside scope
  -> dependency/scope/citation/mapping/ABI/path/compile/runtime verifiers
  -> immutable candidate directory
  -> atomic accepted/current.json promotion
  -> direct non-agentic device_only HMR where locally provable
  -> AI delta only as verifier-gated fallback
```

This keeps GPU HMR aligned with `docs/GPU_HMR_PROD_NEXT.md` without building a
parallel semi-indexing system or letting AI choose its own scope.
