# GPU HMR Deterministic Partial Reload Plan

Draft date: 2026-05-25

Status: implementation plan for the correctness milestone before artifact
fission/performance architecture work.

## 1. Purpose

This document narrows the next GPU HMR work to one production-grade milestone:

```text
body-only .hip/.cu edit
  -> deterministic proof
  -> strict artifact selection
  -> partial device compile
  -> partial runtime reload
  -> symbol/state/correctness evidence
  -> explicit success, degraded, or rejected result
```

The goal is not to make one benchmark pass. The goal is a path that a senior
AMD or NVIDIA kernel engineer can trust because each decision is based on
build metadata, source mapping, symbol identity, verifier evidence, and runtime
observability.

This milestone explicitly does not include the larger artifact-fission
architecture. Fission is important for HIPRT-scale performance, but it should
not derail the correctness work. First prove that deterministic partial reload
is safe and observable. Then use that contract as the foundation for smaller
leaf artifacts.

## 2. Non-Negotiable Rules

- Do not hardcode project names, renderers, files, symbols, models, kernels, or
  fixture-specific behavior in production code.
- Do not build a second indexing or RAG system.
- Use CodeIntel, build metadata, compile database data, and device mapping
  reports as the source of facts.
- AI can propose or review, but deterministic verifiers decide safety.
- Direct body-only device edits should stay non-agentic when local proof
  succeeds.
- AI delta is a fallback only. It must be verifier-gated and must not widen
  scope.
- RAG retrieves and explains. It never certifies ABI or reload safety.
- Full-device fallback must never be silent.
- A compile log is not proof. Runtime reload and correctness evidence are
  required.

## 3. Milestone Boundary

### In Scope

- Strict path normalization contract.
- Strict symbol identity contract.
- Strict partial artifact selector.
- Body-only verifier reject cases, including "looks body-only but is not."
- Dependency-aware partial artifact cache keys.
- Explicit fallback/degraded telemetry.
- Runtime symbol ownership proof.
- Small-project numeric/readback correctness proof.
- HIPRT-scale mapping, compile, reload, and failure evidence.

### Out Of Scope For This Milestone

- New per-kernel leaf artifact architecture.
- Stable support/prelude artifact ABI model.
- Per-source/per-kernel HSACO prebuild pipeline.
- Cross-target distributed cache.
- Any optimization that changes project compile semantics.

Those belong in a separate performance milestone after this correctness
milestone is reliable.

## 4. Identity Model

Strict selection cannot be based on raw strings. GPU HMR needs explicit identity
types for paths, symbols, artifacts, and compile commands.

### 4.1 Path Identity

Every path used by the selector, verifier, cache, or runtime report should be
represented as:

```text
PathIdentity {
  displayPath,
  workspaceRelativePath,
  physicalCanonicalPath,
  containerPath,
  generatedPath,
  caseSensitivity,
  symlinkResolution,
  mountIdentity,
  origin
}
```

Where:

- `displayPath` is only for logs and UI.
- `workspaceRelativePath` is the stable logical project path, normalized to `/`.
- `physicalCanonicalPath` is the real filesystem path after symlink
  resolution, when available.
- `containerPath` is the path as seen by Docker/compiler processes.
- `generatedPath` is the internal `.synthi/generated/...` style path for
  generated roles.
- `caseSensitivity` records whether comparisons are case-sensitive for this
  filesystem/mount.
- `symlinkResolution` records whether the path was resolved, unresolved, or
  unavailable.
- `mountIdentity` records host/container path mapping used for normalization.
- `origin` records whether the path came from compile DB, CodeIntel, generated
  metadata, source map, depfile, runtime report, or MCP request.

### 4.2 Path Normalization Rules

Normalize paths before any comparison:

1. Convert `\` to `/` for logical comparison.
2. Remove `.` segments.
3. Resolve `..` only after anchoring to a known root.
4. Preserve original spelling for display.
5. Resolve symlinks for physical identity where the filesystem allows it.
6. Preserve lexical workspace path separately from physical path.
7. Treat generated paths as internal logical paths, not host paths.
8. Convert host Windows paths to container paths through an explicit mount map.
9. Convert container paths back to workspace-relative paths through the same
   mount map.
10. Compare case-insensitively only when the path identity says the underlying
    mount is case-insensitive.
11. Reject if two different workspace-relative paths resolve to the same
    physical path and the selector cannot prove which one the compiler used.
12. Reject if compile DB path, depfile path, mapping path, and request path
    cannot be joined into one unambiguous identity.

### 4.3 Compiler-Resolved Include Paths

Include identity must use compiler evidence where possible:

- Prefer compiler-emitted depfiles over a local include scanner.
- Parse depfile paths through the same path identity layer.
- Record whether each dependency came from user source, generated source,
  system SDK, build directory, or external dependency.
- Hash content for user/generated/build dependencies.
- For system SDK paths, include compiler and SDK version in the cache key.
- If a depfile path cannot be normalized, cache should be disabled for that
  artifact and telemetry should report `cache.disabled.path_identity_uncertain`.

## 5. Symbol Identity

Source symbol names are not enough. GPU code can contain namespaces, overloads,
templates, anonymous namespaces, `extern "C"`, macro-generated names, and
device-side mangling.

### 5.1 Symbol Identity Record

Every mapped kernel/device symbol should have:

```text
SymbolIdentity {
  sourceSpelling,
  qualifiedSourceName,
  signature,
  signatureHash,
  namespacePath,
  templateArity,
  overloadIndex,
  linkage,
  generatedRolePath,
  sourcePath,
  sourceSpan,
  mangledNames,
  demangledNames,
  exportedNames,
  mappingConfidence,
  origin
}
```

### 5.2 Comparison Levels

Selectors and verifiers should compare different symbol representations for
different tasks:

- Source edit ownership uses `qualifiedSourceName`, `signatureHash`,
  `sourcePath`, and `sourceSpan`.
- ABI safety uses old/new signature hash, linkage, namespace path, template
  arity, overload set, type layout hash, and global layout hash.
- Artifact export ownership uses exported and mangled names where tool output
  is available.
- UI/logs may show demangled names, but demangled names are not enough for
  safety.

### 5.3 Required Rules

- Exact symbol match means equal symbol identity, not just equal spelling.
- Overloads require signature-aware identity.
- Namespaces are part of identity.
- Anonymous namespace changes reject deterministic partial HMR.
- Template specialization or template parameter changes reject deterministic
  partial HMR.
- `extern "C"` affects linkage and must be part of identity.
- If source identity and exported/mangled identity disagree, reject or mark the
  reload degraded.
- Unknown exported symbols reject partial reload unless explicitly declared as
  a safe superset by verifier evidence.

## 6. Body-Only Verifier

The deterministic fast path must prove that the edit only changes executable
statements inside one or more known function/kernel bodies, without changing
declarations, ABI, layout, include roots, or overload resolution.

### 6.1 Positive Conditions

The local verifier may accept only when all are true:

- The edited source path has a stable `PathIdentity`.
- The edited symbol set is non-empty.
- Every edited symbol is known in `deviceMappingReport.deviceMappings`.
- Old and new source parse enough to locate unchanged symbol boundaries.
- Changed spans are inside unchanged function/kernel bodies.
- Kernel signatures are unchanged.
- Device function signatures are unchanged.
- Type layout hash is unchanged.
- Constant/global layout hash is unchanged.
- Directive summary is unchanged.
- Include graph root is unchanged.
- The selected partial artifact exists and passes strict selector rules.

### 6.2 Explicit Reject Cases

Reject deterministic partial HMR for:

- Template declaration changes.
- Template parameter changes.
- Macro body changes that affect declarations.
- Any `#include` change.
- Any `#define` or `#undef` change.
- Any `using` change.
- Any `typedef` or type alias change.
- Any `extern` declaration change.
- Any `__constant__` global change.
- Any `__device__` global variable change.
- Any `constexpr` or `static` data change visible across translation units.
- Kernel signature changes.
- Device function signature changes.
- Struct/class/union layout changes.
- Namespace changes.
- Anonymous namespace changes.
- Overload set changes.
- Added or removed kernels.
- Added or removed device functions.
- Include root changes.
- Macro-controlled signature/layout uncertainty.
- Parse failure unless the fallback parser proves the changed tokens are inside
  one unchanged body and no declaration/directive tokens changed.

### 6.3 Negative Tests For "Looks Body-Only But Is Not"

Add tests where the visual diff is small but deterministic HMR must reject:

- Change a macro used in a kernel signature.
- Change a macro used in a struct field declaration.
- Change a `constexpr` used by an inline device helper.
- Change an inline `__device__` function signature.
- Change a template parameter default.
- Change a type alias used by kernel arguments.
- Add a namespace wrapper.
- Add an overload that changes call resolution.
- Change an included declaration while the edited body text is unchanged.
- Change a `static` data initializer used by a device helper.
- Change an anonymous namespace helper.
- Add a default argument to a device function.
- Change `extern "C"` linkage.

## 7. Partial Artifact Selector Contract

A partial artifact is eligible only if:

- Requested edited symbol set is non-empty.
- Every edited symbol is known.
- Artifact generated path equals selected generated device path after path
  normalization.
- Artifact source paths contain the normalized edited source path.
- Artifact source root matches the edited source root unless the artifact
  explicitly declares multi-root co-ownership and verifier evidence proves it.
- Artifact symbol set equals the edited symbol set, or is a safe superset.
- Unknown symbols reject selection.
- Changed include graph root rejects selection.
- Macro-controlled ABI/layout uncertainty rejects selection.

Safe superset means:

- Every extra symbol is known.
- Every extra symbol maps to the same normalized source root and generated path.
- Runtime reload supports replacing the whole artifact as a multi-symbol unit.
- Telemetry labels `selectionReason: "safe_symbol_superset"`.

If multiple candidates pass, choose:

1. Exact source path match.
2. Exact symbol set before safe superset.
3. Smallest `contentBytes`.
4. Deterministic filename sort.

Required rejection reasons:

- `selection.empty_edited_symbols`
- `selection.generated_path_mismatch`
- `selection.source_path_mismatch`
- `selection.unknown_symbol`
- `selection.symbol_set_mismatch`
- `selection.unsafe_symbol_superset`
- `selection.include_root_changed`
- `selection.macro_controlled_abi_uncertain`
- `selection.path_identity_uncertain`
- `selection.symbol_identity_uncertain`
- `selection.runtime_multi_symbol_reload_unsupported`

## 8. Cache Key Contract

The cache key for partial device artifacts must include enough information that
an unchanged include wrapper still recompiles when included source changes.

Required inputs:

- Artifact schema version.
- Normalized artifact filename.
- Artifact kind.
- Artifact content hash.
- Dependency hash.
- Normalized compile command tokens.
- Compile command hash.
- Compiler executable identity.
- Compiler version output.
- HIP/ROCm SDK version for ROCm.
- CUDA toolkit version for CUDA.
- Target triple.
- GPU vendor.
- GPU arch list.
- Env-affecting compile variables.
- Target-scoped include paths.
- Target-scoped defines.
- Target-scoped language standard.
- Path identity version.
- Symbol identity version.

Dependency hash mechanism:

- Prefer compiler-emitted depfiles.
- Use the same include, define, standard, target, and arch flags as the real
  compile.
- Normalize all dependency paths through `PathIdentity`.
- Hash sorted entries of normalized path, content hash, and file size.
- Use mtime only if content cannot be read.
- Disable cache if dependency discovery exceeds safety limits.

Required hard test:

```text
wrapper bytes unchanged
included file bytes changed
dependency hash changes
cache key changes
cache miss occurs
new HSACO emitted
old cached HSACO not reused
```

## 9. Fallback Semantics

Full-device fallback is allowed only when:

- The call site explicitly opts in, or
- The result is returned as degraded HMR, not normal partial HMR.

Every result must label itself as:

- `gpu-hmr-partial`
- `gpu-hmr-degraded-full-device`
- `gpu-hmr-rejected`

Telemetry must include:

- `fallbackUsed`
- `fallbackReason`
- `requestedArtifactKind`
- `selectedArtifactKind`
- `selectedArtifactBytes`
- `fullDeviceBytes`
- `selectionReason`
- `rejectionReason`
- `verifierEvidenceId`
- `dependencyHash`
- `compileCommandHash`

Tests must assert that success-path narrow HMR has `fallbackUsed == false`.

## 10. Runtime Correctness And Ownership

Partial compile success does not prove runtime correctness.

Before reload:

- Inspect compiled artifact exports when tools are available.
- ROCm tools may include `llvm-objdump`, `llvm-readobj`, or ROCm LLVM tools.
- CUDA tools may include `cuobjdump` or `nvdisasm`.
- Compare exported/mangled/demangled names with expected symbol identities.
- Reject unknown exports unless verifier evidence declares a safe superset.

During reload:

- Pass expected symbol identities to runtime reload.
- Runtime reports touched modules and touched symbols.
- Runtime reports whether the whole device module was replaced.
- If `requirePartial == true`, whole-module replacement is rejected or marked
  degraded.
- Device-only reload must not replace host/core/gui state wholesale.

Correctness proof:

- Small projects must have numeric/readback checks where possible.
- Visible projects must also have screenshot evidence.
- HIPRT-scale projects should expose at least dispatch success count, symbol hit
  count, output buffer hash, or another deterministic observable.
- If HIPRT frames are black or dispatch fails, do not claim visual correctness.

## 11. Role Of AI In Body-Only Correctness

AI should not be the certifier for body-only safety.

AI can help in bounded, non-authoritative ways:

- Suggest which verifier reject rule may apply.
- Explain a deterministic rejection report.
- Propose test cases for uncovered syntax forms.
- Propose source-to-generated mapping hypotheses.
- Propose a patch when deterministic local proof fails.
- Rank suspected symbols for human/debug display.
- Help summarize large mapping reports.

AI must not:

- Decide that an ABI/layout change is safe.
- Override path identity uncertainty.
- Override symbol identity uncertainty.
- Widen source scope for a delta.
- Approve a multi-role edit without deterministic verifier and policy gates.
- Convert a rejected local proof into partial HMR without new deterministic
  evidence.

### 11.1 Agent-Assisted Correctness Loop

An optional correctness agent can run as an advisor:

```text
deterministic verifier report
  -> agent proposes missing evidence or likely reject class
  -> deterministic verifier reruns or test is generated
  -> verifier/arbiter makes final decision
```

The agent output should be stored as advisory metadata only:

```json
{
  "agentRole": "correctness_advisor",
  "authority": "advisory_only",
  "suggestedRejectReasons": [],
  "suggestedTests": [],
  "requiresDeterministicVerification": true
}
```

This is useful for developer experience and test generation, but it should not
be part of the acceptance path.

### 11.2 AI Delta Boundary

AI delta starts only after deterministic proof fails or the request explicitly
forces AI delta.

AI delta receives only the narrowest broker-approved scope. It may produce a
candidate patch, but:

- The candidate must pass the same verifier gates.
- The selected artifact must pass the same selector contract.
- Runtime reload must pass the same ownership checks.
- Multi-role AI delta requires explicit policy approval.

## 12. Validation Matrix

Small project:

- Single-kernel body edit.
- Different expression edit in another body location.
- Multi-kernel project.
- Source-include-backed edit.
- Generated-source-backed edit.
- Rejected ABI/layout edit.
- Rejected macro/declaration edit.
- Degraded fallback opt-in path.

Large project:

- HIPRT scale split.
- HIPRT device body edit.
- No full-device fallback on success path.
- Selected artifact is partial.
- Symbol ownership report is present.
- Runtime touched-symbol report is present.
- Dispatch/correctness observable is present or limitation is explicit.

CUDA project:

- Compile path validation.
- Device artifact selection.
- Runtime reload if hardware/toolchain are available.
- Otherwise clearly record as compile-only or unvalidated runtime.

## 13. Acceptance Criteria

This milestone is acceptable when:

- Deterministic local body-only HMR succeeds without AI for proven body edits.
- Strict selector tests cover path, source, symbol, and superset cases.
- Negative verifier tests reject body-looking ABI/layout/declaration edits.
- Cache test proves unchanged wrapper plus changed include invalidates cache.
- Runtime ownership telemetry reports expected and touched symbols.
- Small project has numeric/readback proof plus screenshot proof.
- HIPRT-scale run records exact status, including dispatch failures if any.
- No success path silently uses full-device fallback.
- No production code hardcodes a concrete project, renderer, symbol, model, or
  path to satisfy validation.

## 14. Commit Sequence

Keep commits narrow:

1. `fix(gpu-hmr): require reload support for symbol supersets`
2. `fix(gpu-hmr): formalize path identity for partial selection`
3. `fix(gpu-hmr): formalize symbol identity for device mappings`
4. `fix(gpu-hmr): reject non-body device fast path edits`
5. `fix(gpu-hmr): hash partial dependencies for device cache`
6. `test(gpu-hmr): assert narrow runtime reload ownership`
7. `test(gpu-hmr): add deterministic gpu readback probes`

Artifact fission should start only after these land and validate:

1. `feat(gpu-hmr): model device support and leaf artifacts`
2. `feat(gpu-hmr): select leaf artifacts for body-only edits`
3. `test(gpu-hmr): prove leaf artifact cache invalidation`
4. `test(gpu-hmr): validate hiprt-scale leaf artifact performance`

## 15. Implementation Discipline

For every patch:

1. Inspect current dirty state.
2. Edit only intended files.
3. Run targeted tests.
4. Run hardcoding scan on added diff.
5. Rebuild affected Docker container if code changed.
6. Run the smallest meaningful validation.
7. Review the diff again before commit.
8. Commit only intended files.
9. Push at useful milestones.
