# GPU HMR Universal Acceptance Implementation Status

Status date: 2026-07-01

This document records the current implementation status against `GPU_HMR_UNIVERSAL_ACCEPTANCE_PROOF_PLAN.md`.

## 2026-07-01 Source-First Visual Coverage Boundary

The `source_first_uncompiled_project_validation` plan coverage entry now uses the same source-first visual selector family as broad readiness, with only the broad-only source-authority and explicit output-oracle-facet requirements relaxed. It still requires typed source-first ingestion, support-only async visual/CAS evidence, accepted visual artifacts, schema-bound matrix-recomputed full-runtime authority, `authority=strict_runtime_proof_artifact`, and strict runtime visual authority. The old coverage path could count a row through a weaker compute/output fallback; that shortcut is removed.

Smoke coverage now proves that forged source-first schemas and forged async visual runtime/dispatch authority fail both broad readiness and the source-first plan coverage entry. Missing explicit `outputOracleFacet` still fails broad readiness, while generic source-first coverage can remain accepted when strict runtime visual authority and visual artifacts are present; this keeps the aggregate arbitrary-user proof stricter than ordinary source-first validation inventory.

Verification for this patch:

```text
node --check mcp/synthi-mcp/scripts/lib/gpu-hmr-validation-matrix-ledger.mjs -> passed
node --check mcp/synthi-mcp/scripts/tests/gpu-hmr-validation-matrix-ledger-smoke.mjs -> passed
node mcp/synthi-mcp/scripts/tests/gpu-hmr-validation-matrix-ledger-smoke.mjs -> passed, including source-first plan coverage refusal for forged source-first schema and forged async visual authority, latest observed proof gpu-validation-matrix-ledger:sha256:07cedbe5bf03bd91a747a0b47388012966dc72d9be207c85049a60b032dbf954, rows=66
```

## 2026-07-01 Source-First Visual Full-Runtime Authority Boundary

The recomputed `fullRuntimeEvidenceAuthority` facet now carries the explicit schema `synthi.gpu_hmr.full_runtime_evidence_authority.v1` and proof authority `matrix_recomputed_full_runtime_evidence_authority_not_row_declared`. Source-first visual broad-readiness selection and source-first coverage require that schema, proof authority, and `authority=strict_runtime_proof_artifact` before a visual row can count toward aggregate broad readiness.

This closes a boolean-only shortcut: accepted visual pixels, accepted async visual/CAS support, and `fullRuntimeEvidenceAuthority.accepted=true` are not enough unless the full-runtime authority facet is matrix-recomputed and schema-bound. The retained source-first visual predicate now records `requiredFullRuntimeEvidenceAuthoritySchema`, `requiredFullRuntimeEvidenceAuthority`, `requiredFullRuntimeAuthoritySource`, and the required signal `full_runtime_evidence_authority_schema_accepted`.

Verification for this patch:

```text
node --check mcp/synthi-mcp/scripts/lib/gpu-hmr-validation-matrix-ledger.mjs -> passed
node --check mcp/synthi-mcp/scripts/tests/gpu-hmr-validation-matrix-ledger-smoke.mjs -> passed
node mcp/synthi-mcp/scripts/tests/gpu-hmr-validation-matrix-ledger-smoke.mjs -> passed, including schema-bound full-runtime authority assertions in the source-first visual broad predicate and source-first coverage rows, proof gpu-validation-matrix-ledger:sha256:ad34ad8676ad3831e197aa1264ac8d9d36299bdabc7d5036c5450ecf0fda695a, rows=66
post-patch source-first visual predicate hash for new recomputes -> sha256:ef2698dcccb9fd4d1a52dd7a15bb22672dc238e6140e276a6f2da5d6cee8467a
```

## 2026-07-01 Source-First Visual Schema Boundary

The source-first visual broad-readiness selector now requires the `synthi.gpu.hmr.agent_split_source_first_ingestion.v1` schema directly before a row can satisfy the aggregate visual lane. The broad proof already recorded that required schema; the selector now enforces it instead of relying only on `accepted=true`, proof authority, and source authority.

The smoke matrix now spoofs an otherwise accepted source-first visual row with a forged source-first ingestion schema. The matrix query remains valid as an audit artifact, but broad readiness closes with `sourceFirstVisualRowCount=0` and `broad_acceptance_requires_source_first_visual_full_runtime_row`. This prevents a serialized source-first object with success-shaped booleans from satisfying broad readiness outside the typed source-first contract.

Verification for this patch:

```text
node --check mcp/synthi-mcp/scripts/lib/gpu-hmr-validation-matrix-ledger.mjs -> passed
node --check mcp/synthi-mcp/scripts/tests/gpu-hmr-validation-matrix-ledger-smoke.mjs -> passed
node mcp/synthi-mcp/scripts/tests/gpu-hmr-validation-matrix-ledger-smoke.mjs -> passed, including forged source-first schema refusal, proof gpu-validation-matrix-ledger:sha256:3e32c47b1f25057ad10055b975cfdb51393cb120d55ad6db1eab9f057a927d06, rows=66
```

## 2026-07-01 Source-First Visual Output-Oracle Boundary

The source-first visual broad-readiness selector now requires an accepted `outputOracleFacet` with `kind=visual_oracle`. It no longer counts a row that has accepted visual pixels, async visual/CAS support, and strict runtime visual authority when the output-oracle facet is absent or not explicitly visual. This aligns the implementation with the retained predicate signal `visual_output_oracle_accepted`.

The smoke matrix now removes the output-oracle facet from otherwise accepted source-first visual rows. The matrix query remains a valid audit artifact, but broad readiness closes with `sourceFirstVisualRowCount=0` and `broad_acceptance_requires_source_first_visual_full_runtime_row`. This prevents screenshot/diff evidence or runtime visual flags from bypassing the ledger-bound output oracle.

Verification for this patch:

```text
node --check mcp/synthi-mcp/scripts/lib/gpu-hmr-validation-matrix-ledger.mjs -> passed
node --check mcp/synthi-mcp/scripts/tests/gpu-hmr-validation-matrix-ledger-smoke.mjs -> passed
node mcp/synthi-mcp/scripts/tests/gpu-hmr-validation-matrix-ledger-smoke.mjs -> passed, including missing source-first visual output-oracle facet refusal, proof gpu-validation-matrix-ledger:sha256:11e4b1b306b99c676b6355596e3775bbbe302bff8430d8f6f15b2df31249520e, rows=66
```

## 2026-07-01 Source-First Visual Support-Authority Boundary

The source-first visual broad-readiness predicate is now enforced against support-facet authority claims, not just recorded in the broad proof. A row can satisfy the source-first visual broad lane only when the source-first ingestion and async visual/CAS support facets remain non-authoritative: no `acceptedForGpuHmr`, no `gpuHmrSuccess`, no `canSatisfyRuntimeProof`, and no `canSatisfyDispatchProof` claims. The async visual support facet now emits explicit false runtime/dispatch authority fields alongside its existing false GPU HMR success fields.

The smoke matrix now forges an otherwise accepted source-first visual lane by setting runtime/dispatch authority on async visual support. The aggregate matrix query still succeeds as an audit query, but broad readiness closes with `sourceFirstVisualRowCount=0` and `broad_acceptance_requires_source_first_visual_full_runtime_row`. This keeps visual proof support from becoming a hidden runtime-proof shortcut.

Verification for this patch:

```text
node --check mcp/synthi-mcp/scripts/lib/gpu-hmr-validation-matrix-ledger.mjs -> passed
node --check mcp/synthi-mcp/scripts/tests/gpu-hmr-validation-matrix-ledger-smoke.mjs -> passed
node mcp/synthi-mcp/scripts/tests/gpu-hmr-validation-matrix-ledger-smoke.mjs -> passed, including forged async visual support runtime/dispatch authority refusal, proof gpu-validation-matrix-ledger:sha256:be52ea90a57d057410b29225e95a71c2c825e5738ac29f4b5084e20da758040b, rows=66
```

## 2026-07-01 Broad Readiness Row-Scope Boundary

Validation-matrix broad readiness now keeps aggregate generalization proof separate from row-local broad acceptance. A scoped HIP/OpenCL/Vulkan/WebGPU runtime row can contribute to the recomputed `synthi.gpu_hmr.broad_library_agnostic_matrix_proof.v1`, but it is not rewritten into `broad_library_agnostic` row scope. Only rows with explicit row-local broad scope and matching broad-scope proof may count as broad full-runtime rows; the current matrix has none.

The broad proof now records `matrixGeneralizationRuntimeRows` for strict scoped rows that support the aggregate proof, while `broadRuntimeRows` remains row-local. This closes the overclaim where a matrix-level readiness proof made every scoped row look like arbitrary-project acceptance. It is deliberately fail-closed for arbitrary projects: a real user project still needs its own same-process loader, epoch publication, dispatch trace, host identity, visual or compute output oracle, CPU/full-rebuild/restart firewall, and strict proof-ledger closure.

Latest retained validation matrix: `gpu-validation-matrix-ledger:sha256:70a59fb470f0b433993ec70cc699a3cb47efdfda0cf3d81c1185df9e09225e59`, JSON `mcp/synthi-mcp/.gpu-hmr-test-logs/validation-matrix/gpu-hmr-validation-matrix-20260701T095015Z.json`, 114 rows, 19 accepted full-runtime GPU HMR, 0 broad library-agnostic full-runtime GPU HMR, 19 scoped full-runtime GPU HMR, 19 all full-runtime, 74 refusals, 8 cold splits, 8 preflight-only rows, 2 deterministic fission rows, 3 visual-profile rows, and 0 included unproven rows. Scope breakdown: `generated_rocm_hip_preview_visual: 4`, `hip_module_declared_compute_readback: 2`, `opencl_declared_compute_readback: 2`, `vulkan_declared_pipeline_visual: 1`, `webgpu_declared_compute_readback: 2`, and `webgpu_declared_pipeline_visual: 8`. `per_target_run_modes status=accepted`.

Latest broad readiness remains `accepted=true` with broad proof `gpu-hmr-broad-library-agnostic-proof:sha256:c2c76ea4ef18f7a8c22b98b4740173c801a29589c51401d1d74b19edab554ea2`, `broadRuntimeRows=0`, `broadRuntimeRowsMissing=false`, `rowLocalBroadRuntimeRowsMissing=true`, `scopedRuntimeRows=19`, `matrixGeneralizationRuntimeRows=19`, `randomColdPathRowCount=5`, `randomColdPathCandidateRowCount=7`, `sourceFirstVisualRowCount=2`, and open gaps `none`. The broad proof now also records `sourceFirstVisualSelectionPredicate=synthi.gpu_hmr.source_first_visual_broad_readiness_predicate.v1`, `sourceFirstVisualPredicateAuthority=matrix_static_source_first_visual_predicate_not_project_name_whitelist`, `sourceFirstVisualPredicateHash=sha256:6b31a1b7e1d17ca9344e551f72d30441727398a424518f91aa5d6fb60c1b9165`, `sourceFirstVisualTargetNameIndependent=true`, and empty project/target whitelists. This is a matrix-level readiness proof across strict scoped runtime rows, adversarial refusals, direct user-owned source-first visual proof, and five large direct arbitrary cold-path refusals; it is not production acceptance for every arbitrary GPU project.

Verification for this patch:

```text
node --check mcp/synthi-mcp/scripts/lib/gpu-hmr-validation-matrix-ledger.mjs -> passed
node --check mcp/synthi-mcp/scripts/tests/gpu-hmr-validation-matrix-ledger-smoke.mjs -> passed
node mcp/synthi-mcp/scripts/tests/gpu-hmr-validation-matrix-ledger-smoke.mjs -> passed, including row-local broad/scoped matrix-generalization separation, source-first visual predicate assertions, and opaque target-id broad-readiness fixture, proof gpu-validation-matrix-ledger:sha256:8da2c98a8d9a1afc55273de196b68757c430c7099813674652dc0eb3b8ec316d, rows=66
npm --prefix mcp/synthi-mcp run proof:validation-matrix -> passed, proof gpu-validation-matrix-ledger:sha256:70a59fb470f0b433993ec70cc699a3cb47efdfda0cf3d81c1185df9e09225e59, rows=114
```

## 2026-07-01 Random Cold-Path Build Metadata Content Boundary

Broad-readiness random cold-path selection no longer counts a large arbitrary project when the runner merely discovers build-system filenames. A qualifying direct cold-path refusal now requires both accepted build metadata discovery and accepted `synthi.gpu_hmr.cold_build_metadata_content.v1` byte evidence, including a normalized SHA-256 content hash read from the immutable source tree. Discovery-only rows remain useful diagnostics, but they do not satisfy the arbitrary-project cold-path gate.

The smoke matrix now includes five direct arbitrary cold-path rows with build metadata discovery accepted but content evidence missing, plus a declared-only adversarial set where accepted/hash fields are present but the actual content-evidence facet is absent. The aggregate matrix remains internally accepted as a ledger query, but broad readiness stays closed with `randomColdPathRowCount=0`. The retained broad-readiness predicate now records the required signals `build_metadata_discovery_accepted`, `build_metadata_content_evidence_accepted`, `build_metadata_content_schema_authority_accepted`, `build_metadata_content_byte_hashes_observed`, and `build_metadata_content_hash_observed`, in addition to direct source input, immutable source identity, source-derived backend candidates, candidate declarations as diagnostic-only, source-tree intake, validated runtime-boundary template support, and no GPU HMR/runtime/dispatch authority claims.

The matrix verifier now treats cold build-metadata content as a two-pass evidence object. Raw `synthi.gpu_hmr.cold_build_metadata_content.v1` facets are accepted only when the schema and `build_metadata_content_bytes_only_not_gpu_hmr_success` authority match, at least one build file carries a path plus SHA-256 content hash, no GPU HMR/runtime/dispatch authority is claimed, and the facet content hash recomputes. Matrix-normalized facets can pass a second broad-readiness pass only when their stored recomputed hash still matches the content hash and all schema/authority/build-file checks remain clean.

After this stricter predicate, the previous retained matrix no longer had enough qualifying large direct cold paths. Fresh direct source-url cold probes against Filament and Vulkan-Samples supplied content-backed rows, while the direct Iced probe stayed a candidate because it is below the large-project threshold. That checkpoint retained `mcp/synthi-mcp/.gpu-hmr-test-logs/validation-matrix/gpu-hmr-validation-matrix-20260701T090447Z.json`, proof `gpu-validation-matrix-ledger:sha256:7e2ed0581f667e3b10cc3ab3a3f40dbafbc9c9c1cf2d7b9763e4446e4380dd9f`, broad proof `gpu-hmr-broad-library-agnostic-proof:sha256:1d5db3250ac1028c08d81d866a150ffd0dc421661938eb00d1bac8cc540b28c5`, and predicate hash `sha256:a184d8c93a3ec1ec35957e7aa2982c536a346a15c16322955294da4660dcde89`; it is superseded by the row-scope boundary matrix above.

Verification for this patch:

```text
node --check mcp/synthi-mcp/scripts/lib/gpu-hmr-validation-matrix-ledger.mjs -> passed
node --check mcp/synthi-mcp/scripts/tests/gpu-hmr-validation-matrix-ledger-smoke.mjs -> passed
node mcp/synthi-mcp/scripts/tests/gpu-hmr-validation-matrix-ledger-smoke.mjs -> passed, including discovery-only and declared-only build metadata refusals, proof gpu-validation-matrix-ledger:sha256:e6c7b1634eca857ddd5a0fd0a88a804ffab85e7248d2e81d3f8c7813acf6c2cf, rows=66
npm --prefix mcp/synthi-mcp run proof:validation-matrix -> passed, proof gpu-validation-matrix-ledger:sha256:7e2ed0581f667e3b10cc3ab3a3f40dbafbc9c9c1cf2d7b9763e4446e4380dd9f, rows=114
```

## 2026-07-01 HIPRT/OIDN Plan-Coverage Diagnostic Boundary

Validation-matrix plan coverage now distinguishes non-authoritative evidence from missing evidence for HIPRT and OIDN/HIP. Source-adapted HIPRT visual-profile rows can make `hiprt_visual_path` report `visual_profile_only` and `hiprt_run_modes` report `visual_profile_partial` when cold/hot support is present, but those entries explicitly keep `acceptedForGpuHmr=false`, `gpuHmrSuccess=false`, and diagnostic-only authority. They still require a no-shim same-process runtime boundary, loader, epoch, dispatch, host identity, visual oracle, firewall, and strict ledger before any HIPRT GPU HMR acceptance.

OIDN/HIP runtime-preflight refusals now surface as `refused` coverage for `oidn_hip_runtime_preflight` instead of looking absent when the backend evidence is schema-correct but failed closed. This does not turn preflight or output bytes into GPU HMR proof; OIDN output still needs full runtime ledger closure before acceptance. The smoke suite covers a source-adapted HIPRT visual/run-mode diagnostic path and an OIDN/HIP runtime-preflight refusal, while retaining the forged preflight-success rejection.

Verification for this patch:

```text
node --check mcp/synthi-mcp/scripts/lib/gpu-hmr-validation-matrix-ledger.mjs -> passed
node --check mcp/synthi-mcp/scripts/tests/gpu-hmr-validation-matrix-ledger-smoke.mjs -> passed
node mcp/synthi-mcp/scripts/tests/gpu-hmr-validation-matrix-ledger-smoke.mjs -> passed, including HIPRT visual_profile_only/visual_profile_partial diagnostics and OIDN runtime-preflight refusal coverage, proof gpu-validation-matrix-ledger:sha256:5569cc65f34bd87ed830fa49678ddf5c55b72c5d25673327bc7f1184263cb275, rows=66
```

## 2026-07-01 Random Cold-Path Backend Declaration Boundary

Validation-matrix ingestion now records `randomColdBackendEvidence` for `synthi.gpu_hmr.random_large_project_cold_path.v1` rows. The row backend is selected only from source-intake/backend candidates derived from the source listing, build metadata discovery, and runtime-boundary expectation. Candidate-declared `backend`, `backendFamily`, and `backendCandidates` fields are preserved as diagnostics with `candidateBackendUsedForAcceptance=false` and authority `candidate_backend_declaration_diagnostic_only_not_backend_contract`.

Broad-readiness random cold-path selection now also requires source-derived backend candidates and records that requirement in the predicate as `source_derived_backend_candidates_observed` plus `candidate_backend_declarations_diagnostic_only`. A smoke fixture now forges a direct arbitrary cold-path candidate that declares HIP/ROCm while the source intake proves Vulkan/WebGPU; the matrix row remains backend `vulkan`, records the forged HIP declaration as diagnostic-only, and keeps GPU HMR false.

Verification for this patch:

```text
node --check mcp/synthi-mcp/scripts/lib/gpu-hmr-validation-matrix-ledger.mjs -> passed
node --check mcp/synthi-mcp/scripts/tests/gpu-hmr-validation-matrix-ledger-smoke.mjs -> passed
node mcp/synthi-mcp/scripts/tests/gpu-hmr-validation-matrix-ledger-smoke.mjs -> passed, including forged candidate backend declaration refusal, proof gpu-validation-matrix-ledger:sha256:8776d5ec767f800355ab2c3306218f8746ac18ad7b2ab6d257f05bd56f01790b, rows=66
```

## 2026-07-01 Random Cold-Path Oracle-Hint Boundary

Random large-project cold-path runtime-boundary expectation now treats candidate oracle hints as diagnostics only. `synthi.gpu_hmr.cold_runtime_boundary_expectation.v1` derives acceptable oracle kinds from source-derived backend candidates and build metadata evidence, records candidate-declared oracle kinds separately, and sets `candidateOracleHintsUsedForAcceptance=false`. A candidate manifest that claims `oracleHints.acceptedByDeclaration=true` now fails the expectation with `candidate_oracle_hint_acceptance_claim_rejected` instead of enriching the support template.

The emitted cold runtime-boundary event-manifest template carries the same derivation fields, and validation-matrix ingestion rejects fresh templates that use candidate oracle hints for acceptance, claim oracle authority, or include acceptable oracle kinds that are not source-derived. This keeps arbitrary cold-path testing generic: project lists, candidate JSON, profile IDs, and oracle declarations can describe what to look for, but they cannot satisfy visual/compute oracle support or GPU HMR acceptance. Runtime acceptance still requires observed loader, epoch, dispatch, host identity, output oracle bytes, firewall, and strict proof-ledger closure.

Verification for this patch:

```text
node --check mcp/synthi-mcp/scripts/gpu-hmr-random-large-project-cold-path.mjs -> passed
node --check mcp/synthi-mcp/scripts/lib/gpu-hmr-validation-matrix-ledger.mjs -> passed
node --check mcp/synthi-mcp/scripts/tests/gpu-hmr-validation-matrix-ledger-smoke.mjs -> passed
npm --prefix mcp/synthi-mcp run proof:random-large-project:cold:self-check -> passed, including forged candidate oracle-acceptance hint refusal
node mcp/synthi-mcp/scripts/tests/gpu-hmr-validation-matrix-ledger-smoke.mjs -> passed, including forged non-source-derived oracle-kind template refusal, proof gpu-validation-matrix-ledger:sha256:e18cb92d1a3033b7fdd88dffaa304fa4016f36899cb3b3a704b2c2445d2717c5, rows=66
```

## 2026-07-01 OIDN Output Oracle Support Boundary

The OIDN/HIP preflight runner now has a generic file-backed output-oracle manifest path through `SYNTHI_OIDN_OUTPUT_ORACLE_MANIFEST_PATH` or `--output-oracle-manifest`. The manifest schema is `synthi.gpu_hmr.oidn_output_oracle.v1` with authority `oidn_output_oracle_file_bytes_only_not_gpu_hmr_success`. The runner reads noisy input, denoised output, and optional expected-output files only under approved roots, verifies readable byte lengths and SHA-256 hashes, requires the denoised output to differ from the noisy input, and requires an expected-output hash match before `oidnHipOutputProofAccepted=true` can be recorded.

This is deliberately not GPU HMR acceptance. The output-oracle facet always records `acceptedForGpuHmr=false`, `gpuHmrSuccess=false`, and `canSatisfyRuntimeProof=false`. Validation-matrix ingestion now recomputes the OIDN output-oracle facet shape before honoring any serialized `acceptedForOidnHipOutputProof=true`; a boolean output-success claim without schema-correct, evidence-only, internally consistent output bytes falls back to preflight-only/missing-output status. Even when the OIDN output oracle is accepted, the matrix keeps the row `preflight_only` with `proofChain=runtime_preflight_and_output_oracle_only` and explicit gaps for `oidn_full_runtime_hmr_ledger_not_proven` and `strict_runtime_proof_ledger_required`.

Verification for this patch:

```text
node --check mcp/synthi-mcp/scripts/gpu-hmr-oidn-preflight.mjs -> passed
node --check mcp/synthi-mcp/scripts/lib/gpu-hmr-validation-matrix-ledger.mjs -> passed
node --check mcp/synthi-mcp/scripts/tests/gpu-hmr-validation-matrix-ledger-smoke.mjs -> passed
npm --prefix mcp/synthi-mcp run proof:oidn:preflight:self-check -> passed, including accepted file-backed output oracle and forged success/hash-mismatch refusals
node mcp/synthi-mcp/scripts/tests/gpu-hmr-validation-matrix-ledger-smoke.mjs -> passed, proof gpu-validation-matrix-ledger:sha256:0d6eabd97f62b2f6c3a818c501a56e7f8a3c9723c3648ecfc5e25146a5ccd4af, rows=66
```

## 2026-07-01 Packaged Proof Runner Coverage

The MCP package proof-runner allowlist is now derived and tested generically instead of relying on remembered individual script entries. `proof:real-rocm:package-scripts:self-check` scans non-test `proof:*` npm commands, extracts direct `node scripts/*.mjs` runners and `node -e import('./scripts/*.mjs')` runners, and fails if any exposed proof runner is missing from the package `files` list.

This closed a packaged-proof gap for the OIDN/HIP preflight lane and other proof entry points. The packaged runner set now includes `gpu-hmr-oidn-preflight.mjs`, `gpu-hmr-opencl-preflight.mjs`, `gpu-hmr-vulkan-preflight.mjs`, `gpu-hmr-runtime-profile-proof.mjs`, `gpu-hmr-agent-split-workspace-test.mjs`, `gpu-hmr-external-project-profile.mjs`, `gpu-hmr-timing-metrics-summary.mjs`, and `hiprt-light-math-warm-proof.mjs`, alongside the existing real-ROCm, random cold-path, WebGPU, HIP module, OpenCL runtime, Vulkan runtime, and HIPRT target-progression runners. `npm pack --dry-run --json` confirmed those runner files are present in the generated tarball.

This is packaging and reproducibility hardening only. A packaged OIDN/HIP preflight runner still reports runtime capability or precise refusal; it cannot satisfy output proof or GPU HMR acceptance without a same-process loader, epoch publication, dispatch trace, host identity, visual or compute output oracle, firewall evidence, and strict proof-ledger closure.

Verification for this patch:

```text
node --check mcp/synthi-mcp/scripts/tests/gpu-hmr-real-rocm-package-scripts-smoke.mjs -> passed
npm --prefix mcp/synthi-mcp run proof:real-rocm:package-scripts:self-check -> passed; packagedProofRunnerFiles includes OIDN/OpenCL/Vulkan preflight, source-first, runtime-profile, external-profile, timing, HIPRT warm, and runtime proof runners
npm pack --dry-run --json in mcp/synthi-mcp -> passed; tarball file list includes scripts/gpu-hmr-oidn-preflight.mjs and the other exposed proof runners
```

## 2026-07-01 Direct User-Owned Source-First Visual Proof

The source-first visual path now accepts direct user-owned source input instead of relying only on packaged profile source files. `proof:agent-split:source-first` can read `SYNTHI_GPU_AGENT_SOURCE_MANIFEST_PATH` / `SYNTHI_GPU_AGENT_DIRECT_SOURCE_MANIFEST_PATH`, optionally bind paths under `SYNTHI_GPU_AGENT_SOURCE_ROOT`, and require a direct source authority from `SYNTHI_GPU_AGENT_SOURCE_AUTHORITY` or the manifest. Accepted authorities are `direct_source_url_commit`, `direct_local_git_repo_path`, `user_source_files`, `workspace_source_files`, and `cli_or_env_direct_source`; `profile_source_files` is deliberately rejected for this direct-source lane.

The live direct-source run used `sourceAuthority=user_source_files` and workspace `gpu-agent-split-1782857972436`. It seeded `src/main.cpp` plus `src/scene_config.h` from the direct manifest, preserved the quoted include closure, generated explicit module files/device roles under `.synthi/generated/gpu/`, selected ROCm/HIP device compilation, published two hot GPU epochs, and closed strict visual runtime proof for both hot deltas. The run produced source-first ingestion proof `agent-split-source-first-ingestion:sha256:0ae316fea86ed97fca27833d76158cdb8d7da5bbc2b4809f37bfc3ccf9b31a1d`, cold compile proof `gpu-proof:832beee637c93a2ac9be011db2775791e4df29bd1dc53ca98538cb1a3cca71c5`, hot delta 1 runtime proof `gpu-runtime-proof:sha256:78c905b5fee0a02c0e99d15e32cb90c6cd13eb315d28b87d5c59ace5e6d7783e`, and hot delta 2 runtime proof `gpu-runtime-proof:sha256:edea80e28b4c7e844e0b2e0a088afa2dcda1e71001434faf9ced4114ac02ccb5`.

Visual proof remained byte-backed and ledger-gated. Hot delta 1 recorded `changed=73.75%`, `mean_abs=18.37`, `control_changed=0.00%`, and `control_mean_abs=0.02`; hot delta 2 recorded `changed=99.50%`, `mean_abs=37.27`, `control_changed=0.00%`, and `control_mean_abs=0.01`. Total validator wall time was `6.553s` and `7.134s`; device compile time was `32.55ms` and `24.07ms`. The negative ABI edit refused before GPU HMR acceptance.

The saved validation matrix artifact after this direct-source visual run was refreshed again after a Flow visual rerun, the large-cold-path size-gate hardening, direct cold-path probes against large arbitrary projects, the non-whitelisted direct-input evidence audit, source-derived backend declaration hardening, the content-backed build metadata gate, and the row-local broad/scope separation. The current retained matrix is `mcp/synthi-mcp/.gpu-hmr-test-logs/validation-matrix/gpu-hmr-validation-matrix-20260701T095015Z.json`. It records proof `gpu-validation-matrix-ledger:sha256:70a59fb470f0b433993ec70cc699a3cb47efdfda0cf3d81c1185df9e09225e59`, with 114 rows, broad readiness `accepted=true`, broad proof `gpu-hmr-broad-library-agnostic-proof:sha256:c2c76ea4ef18f7a8c22b98b4740173c801a29589c51401d1d74b19edab554ea2`, `broadRuntimeRows=0`, `broadRuntimeRowsMissing=false`, `rowLocalBroadRuntimeRowsMissing=true`, `scopedRuntimeRows=19`, `matrixGeneralizationRuntimeRows=19`, five qualifying large cold-path targets, seven direct cold-path candidates, user-owned source-first visual rows still present, no broad-readiness open gaps, and a recorded target-name-independent predicate hash `sha256:a184d8c93a3ec1ec35957e7aa2982c536a346a15c16322955294da4660dcde89` that requires accepted `synthi.gpu_hmr.random_cold_path_direct_source_input.v1` evidence, `direct_cli_or_env_input_mode_observed`, `source_derived_backend_candidates_observed`, `candidate_backend_declarations_diagnostic_only`, `build_metadata_discovery_accepted`, `build_metadata_content_evidence_accepted`, and `build_metadata_content_hash_observed`.

Saved matrix summary: 114 rows, 19 accepted full-runtime GPU HMR, 0 broad library-agnostic full-runtime GPU HMR, 19 scoped full-runtime GPU HMR, 19 all full-runtime, 74 refusals, 8 cold splits, 8 preflight-only rows, 2 deterministic fission rows, 3 visual-profile rows, and 0 included unproven rows. Scope breakdown: `generated_rocm_hip_preview_visual: 4`, `hip_module_declared_compute_readback: 2`, `opencl_declared_compute_readback: 2`, `vulkan_declared_pipeline_visual: 1`, `webgpu_declared_compute_readback: 2`, and `webgpu_declared_pipeline_visual: 8`. Accepted full-runtime source authority still includes the two direct `user_source_files` visual rows, while the aggregate broad proof now also requires and sees five large direct arbitrary cold-path refusals with content-backed build metadata: `direct-llama-cpp-current-template`, `direct-filament-user-path-current-template`, `direct-vulkan-samples-user-path-current-template`, `direct-bevy-user-path-current-template`, and `direct-wgpu-user-path-current-template`. The direct Iced row remains retained as a candidate only because it is below the large-project threshold.

The refreshed Flow visual rows use target `generated-gpu-split:3e2e1e99e0bfca5a804d336c` and source authority `builtin_fixture_source`. They prove strict visual GPU HMR for that current fixture path with runtime proofs `gpu-runtime-proof:sha256:a338092627d95fdd4036796ee1199c12f373d4f5acf4134ff413fe3743289600` and `gpu-runtime-proof:sha256:4f6872093794127975d1d2793e0a952bc5a7afd56e7475c04c8e5ce45b857949`, plus ledgers `gpu-ledger-proof:sha256:2a31c12b5ea8bbe1d345be20a1d0905ca7160e694da9919e6cbaaabab3155dd4` and `gpu-ledger-proof:sha256:9ff10575110cb3b56758309951b35d99d5c9fafeb3de1fbb67c959438ed588cd`. Because the source authority is fixture-backed, these rows are regression and visual-coverage evidence only; they do not replace the direct/user-owned source-first visual gate and do not claim arbitrary-user acceptance.

This closes the direct/user-owned source-first visual lane and the matrix-level broad-readiness checklist. It still does not make arbitrary projects succeed by repository name, sample membership, profile identity, or cold-intake evidence. Large libraries and user applications need their own same-process loader, epoch publication, dispatch trace, host-identity proof, visual or compute output oracle, CPU/full-rebuild/restart firewall, and strict proof-ledger closure before any per-project GPU HMR success can be reported.

Verification for this patch:

```text
node --check mcp/synthi-mcp/scripts/gpu-hmr-agent-split-workspace-test.mjs -> passed
npm --prefix mcp/synthi-mcp run proof:agent-split:source-first:self-check -> passed, including direct-source manifest acceptance and smuggled profile_source_files refusal
npm --prefix mcp/synthi-mcp run proof:agent-split:source-first with SYNTHI_GPU_AGENT_SOURCE_MANIFEST_PATH, SYNTHI_GPU_AGENT_SOURCE_ROOT, and SYNTHI_GPU_AGENT_SOURCE_AUTHORITY=user_source_files -> passed, workspace gpu-agent-split-1782857972436
saved validation-matrix refresh -> proofId gpu-validation-matrix-ledger:sha256:7e2ed0581f667e3b10cc3ab3a3f40dbafbc9c9c1cf2d7b9763e4446e4380dd9f, path mcp/synthi-mcp/.gpu-hmr-test-logs/validation-matrix/gpu-hmr-validation-matrix-20260701T090447Z.json, rows=114, broad readiness accepted=true, broad proof gpu-hmr-broad-library-agnostic-proof:sha256:1d5db3250ac1028c08d81d866a150ffd0dc421661938eb00d1bac8cc540b28c5, random cold-path predicate authority=matrix_static_predicate_not_project_name_whitelist, predicate hash sha256:a184d8c93a3ec1ec35957e7aa2982c536a346a15c16322955294da4660dcde89, required direct-input evidence=synthi.gpu_hmr.random_cold_path_direct_source_input.v1, required authority=runner_cli_env_direct_source_input_only_not_gpu_hmr_success, required backend evidence=source_derived_backend_candidates_observed,candidate_backend_declarations_diagnostic_only, required build metadata content evidence=build_metadata_discovery_accepted,build_metadata_content_evidence_accepted,build_metadata_content_schema_authority_accepted,build_metadata_content_byte_hashes_observed,build_metadata_content_hash_observed, current Flow fixture visual rows accepted only as fixture-backed coverage, random large cold-path targets=direct-llama-cpp-current-template,direct-filament-user-path-current-template,direct-vulkan-samples-user-path-current-template,direct-bevy-user-path-current-template,direct-wgpu-user-path-current-template
```

## 2026-06-30 Real ROCm Run-Id Lifecycle Status Recovery

The real ROCm runner now binds upstream lifecycle status recovery to a fresh `SYNTHI_REAL_ROCM_LIFECYCLE_RUN_ID` for each attempt. Before configure starts, the worker truncates configure/build/run logs, writes a run-id-bound `synthi.real_rocm.worker_lifecycle_status_recovery.v1` status file, and clears any prior configure metadata snapshot. CMake metadata is copied into a run-local snapshot only after configure returns successfully.

This closes the stale-log/stale-metadata gap exposed by bounded MIOpen attempts. If the worker timeout kills configure before CMake returns, the status facet remains `configure_exit_code=unknown`, `run_exit_code=not-run`, and `metadata_snapshot_status=unknown`; the classifier records `upstream_configure_status_incomplete_after_lifecycle_failure` as refusal-only evidence. Metadata recovery then tries only the current run's snapshot and the current build tree. Old wrapper-owned skip lines and old `compile_commands.json` files cannot satisfy source-delta, runtime-boundary, output-oracle, or strict ledger gates.

The latest bounded MIOpen rerun, `gpu-real-rocm-MIOpen-20260630171112`, exercised that path with `SYNTHI_REAL_ROCM_UPSTREAM_TIMEOUT_MS=120000`. It reached shared-CAS source staging, external header prerequisite evidence, target-environment export, finalizer adapter execution, and adapter-result transport, then failed closed because configure did not return before the lifecycle timeout and no current-run metadata snapshot existed. The retained result has `gpuHmrSuccess=false`, `fullRuntimeProven=false`, rejected strict runtime proof `gpu-runtime-proof:sha256:7092e5e2b9ecb63442d8db218268caba18f82ef4939d3568edb0121b8ed81ad0`, no event-manifest boundary lines, no artifact transport, no epoch, no dispatch, no host identity, no output oracle, no firewall, and no runtime-chain or proof-ledger closure. This supersedes the older stale-log diagnosis while remaining large-project refusal evidence only.

The validation plan now also has an explicit random large-project cold-path lane. Sampled projects must record selection seed, repo URL, immutable commit, size signals, cold source-tree intake, build metadata discovery, runtime-boundary classification, and fail-closed gaps. Acceptance for any sampled project still requires the normal same-process loader, epoch, dispatch, host-identity, output-oracle, firewall, and strict ledger gates; otherwise the correct outcome is a precise refusal, not a generalized success claim.

That lane is now backed by `mcp/synthi-mcp/scripts/gpu-hmr-random-large-project-cold-path.mjs`. The sampler selects serious real-project profiles by deterministic seed, records `synthi.gpu_hmr.random_large_project_cold_path.v1` manifests with evidence-only authority `random_large_project_cold_path_selection_only_not_gpu_hmr_success`, and can either dry-run selection or invoke the normal real ROCm runner with cold checkout settings (`SYNTHI_REAL_ROCM_REUSE_WORKER_REPO=0`, `SYNTHI_REAL_ROCM_CLEAN_BUILD=1`). Actual execution writes a pending manifest before launching the long runner, then writes a final manifest with completion, timeout, spawn-error, candidate-error, or unprofiled-refusal status. Candidates without a packaged profile are accepted into the manifest as `profileMode=unprofiled_arbitrary_project_cold_intake` and refused with generic missing-contract/runtime-proof gaps instead of fabricating a profile. The manifest always starts with `acceptedForGpuHmr=false`, `gpuHmrSuccess=false`, and `canSatisfyRuntimeProof=false`; selected projects still need their own strict runtime ledger closure before any acceptance claim.

The latest bounded actual random cold-path attempt selected `real-rocm-hipblaslt-gelu-aux-bias-large-ml`, reached Docker and a real `ROCm/hipBLASLt` checkout at commit `3a609b06926c8227e753b62087555e1f435bf2d4` with `files=2860`, and then failed closed at the sampler's 15 second outer runner timeout. Final manifest `sha256:fb806f1d9a0a6e09e48b854b26d71acb7196e156de2b3afbb9c64c44405f1d03` references pending manifest `sha256:1f6767f3f96a49b3d7b4f0766050834405533ef6e821bf9682bd5d76602efcf3`; result status is `runner_timeout_failed_closed`, with `acceptedForGpuHmr=false`, `gpuHmrSuccess=false`, and `canSatisfyRuntimeProof=false`.

A non-profiled arbitrary-project check resolved `https://github.com/ggerganov/llama.cpp.git` to exact commit `4f31eedb0ccf546b7e8d6bb243b170f12522f54d`, then ran the sampler with that project as an external candidate and no profile. The latest retained final manifest `sha256:458e284f1861792ec270b96f3ef8842e108a46a4c45d0a5eb107a43a0c35cb4c` references pending manifest `sha256:8e8a3cc1c7fed69e73d2c0dacac95e3efcce33ea29911e81c5f640df34094ca2`; result status is `unprofiled_arbitrary_project_cold_intake_refused`. Source-tree intake accepted through `github_git_tree_api_recursive`, counted 3,011 files and 154,991,455 known bytes, produced listing hash `sha256:8fa51e93e94b52ea3248e2e3e00c0ef0ed401d17e6d23d35336f3adfaaccd4f3`, and detected backend candidates `cuda`, `hip_rocm`, `metal`, `opencl`, `sycl`, `vulkan`, and `webgpu_wgsl`. Acceptance still refuses with gaps for missing local backend runner, runtime profile contract, semantic build metadata verification, same-process loader, epoch publication, dispatch trace, host identity, output oracle, and strict runtime ledger.

The sampler's default candidate pool now includes unprofiled arbitrary projects as first-class cold-intake candidates, not just the enrolled ROCm profiles. The current seeded dry-run selected `unprofiled-dawn-webgpu-stack` and retained manifest `sha256:7419645ca7eb374749bbdd77ad1f3a6b4fc8a1208cf2d5e60e25b9b5c4dcd626`; the actual default run retained manifest `sha256:746456bb431c40655427a38539f5c8f7d3a94476347180933229933e07e3e89a` and refused because the GitHub recursive tree response was truncated, so source-tree intake could not be authoritative. The Dawn source-intake facet `sha256:ac4be2b42b318a52d650411df9fe43b910ddc45c9052f3f3d80fb744fbf37f79` now records a non-authoritative fallback plan with authority `fallback_plan_only_not_source_intake_or_gpu_hmr_success` and explicit opt-in `SYNTHI_GPU_HMR_UNPROFILED_GIT_FALLBACK=1` for a live blobless git listing; the default path does not start that long fetch. A second actual unprofiled run selected `unprofiled-wgpu-rust-graphics-stack`, retained manifest `sha256:3f20a4e8c622e20e14943ac10240de7949d676ac129ff896e9d72bfa08616512`, accepted source-intake facet `sha256:1a80affe42c6e0b50d8781a3be2dc34ff3fb4f0cb1b9f4c6948d01a1c5559f07`, listing hash `sha256:637cc42807a851a8a27f5d9ff4b27d02ee4e1f2fae3707bb064be20e3e7131b7`, 2,445 files, 35,885,065 known bytes, 34 build metadata signals, 80 sampled GPU source signals, and `metal`, `vulkan`, and `webgpu_wgsl` backend candidates. Both outcomes are refusal proof only until a sampled project closes the same loader, epoch, dispatch, host identity, output oracle, firewall, and strict ledger gates.

The cold-path runner now also supports direct arbitrary user input: `--source-url`, immutable `--commit`, optional `--source-id`, and optional `--backend-family`. Direct candidates do not need a prewritten profile or candidate JSON and are marked `candidateSource=direct_source_url_commit`. The direct wgpu user-path run retained manifest `sha256:0c43d180417d4d8f25ba52f6de87b67d7f6c5a91ec4738269526bdf6d0578303`, accepted source-tree intake for 2,445 files with listing hash `sha256:637cc42807a851a8a27f5d9ff4e1f2fae3707bb064be20e3e7131b7`, then correctly refused with gaps for missing backend runner, runtime profile contract, build metadata verification, loader, epoch, dispatch, host identity, output oracle, and strict runtime ledger.

Local arbitrary checkout intake is now covered too. `--repo-path` creates a `direct_local_git_repo_path` candidate, verifies the requested immutable commit, rejects dirty worktrees before accepting a source listing, and records `local_git_ls_tree_clean_worktree` only for clean checkouts. The current workspace-local run retained manifest `sha256:96eef09f737c4d49a7a844c0ec133cee8fe2229b1a449b148102f0a874b45178` and correctly refused with `source_intake_local_git_dirty` because this checkout has unrelated dirty/untracked files.

Accepted source intake now carries support-only build metadata discovery and bounded content evidence. The earlier direct wgpu build-metadata run retained manifest `sha256:1632b2625ab0522639fddf5027fb81216bf9636c26c03b57d4fc50ab0fbf7b6d`, emitted `synthi.gpu_hmr.cold_build_metadata_discovery.v1` discovery hash `sha256:0a595a95d5df5ab88d9e8ac165b43f24e25a4802e41629c588f8d900a7062eaf`, detected `cargo` and `npm_or_node` across 34 build signals, and refined the remaining refusal to `semantic_build_metadata_verification_missing`.

The follow-up content path emits `synthi.gpu_hmr.cold_build_metadata_content.v1` with authority `build_metadata_content_bytes_only_not_gpu_hmr_success`. It reads at most 12 detected build files from the immutable source tree, records byte lengths, SHA-256 content hashes, generic family summaries, and a content evidence hash, then refines the refusal to `semantic_build_metadata_execution_missing`. This is still not build execution, compile database verification, runtime profile proof, loader proof, epoch proof, dispatch proof, host identity, output oracle, firewall proof, or strict ledger closure.

Two fresh direct arbitrary cold-path runs exercised large user-style projects through `--source-url` and immutable commits. wgpu retained manifest `sha256:3fcfee8fd5769eba8c9108649c9ec27dbdfc146c0bec7f6c51fea55e5a84a032`, accepted source-tree intake, accepted build metadata content, hashed 12 build files, and emitted content evidence `sha256:1aa362d604b10f49da4cd2b79a2242c9a4710dd011a8c4e60620e8e07e922b07`. Bevy was resolved with `git ls-remote https://github.com/bevyengine/bevy.git HEAD -> 5558f7bb5d04b351e3d7123c32674b0b2f013e3a`; its direct run retained manifest `sha256:cf805567cdf23e2967a7bff3e384c256609f0d0e5d7b85f9b27ac499572c4c97`, accepted source-tree intake, accepted build metadata content, hashed 12 build files, and emitted content evidence `sha256:7d7447b71c4952b5e7957e585c7a9dd60acf11f946261b04d1da118c5dd7faa4`. Both remained `unprofiled_arbitrary_project_cold_intake_refused` with `acceptedForGpuHmr=false` and `gpuHmrSuccess=false`.

The git materialization fallback is now auditable and bounded. `SYNTHI_GPU_HMR_UNPROFILED_FORCE_GIT_FALLBACK=1` forces the `git_fetch_depth_1_blobless` source-intake path for any arbitrary candidate, and content evidence can read build files from that materialized repo by pinned `git show`. Timeout handling now forces a final result after child cleanup, releases Node child handles, and records a path-targeted Windows cleanup facet so a long arbitrary git listing does not leave only a pending manifest. A bounded forced-fallback wgpu run retained final manifest `sha256:bb51164348974cf42630416f71289f72045ca5a837b15f62a6a38946debacd00`, source-intake facet `sha256:8ea019ed7b01ca11e69c65a7c1b2a3478a805d9f2612c275cadfba6ef0b6e37b`, `source_intake_listing_failed`, `timeout-forced-finalize`, `timeoutKillAttempted=true`, and cleanup of git PID `34712`; a process check after the run showed no remaining git/node child processes. The row still has `sourceTreeIntakeAccepted=false`, `acceptedForGpuHmr=false`, and `gpuHmrSuccess=false`.

The follow-up size-free tree path fixes the fallback scalability issue exposed by that run. Blobless/materialized fallback listings now use `git ls-tree -r --full-tree` without `-l`, and the parser accepts size-free rows while recording `byteLengthMode=unknown_avoids_blob_fetch`. Local materialized checkouts can opt into the same listing mode with `SYNTHI_GPU_HMR_LOCAL_GIT_NO_SIZE=1`; build-file content reads disable lazy blob fetch by default with `GIT_NO_LAZY_FETCH=1`. A no-network materialized wgpu run retained manifest `sha256:a722a52c95c753a43ffd592f7303703b3a720e4cce603e5c1a0b64f82302bbc6`, accepted source intake for 2,445 files via `local_git_ls_tree_no_size_clean_worktree`, recorded `totalKnownBytes=0`, detected `cargo`, `npm_or_node`, `metal`, `vulkan`, and `webgpu_wgsl`, and failed all 12 selected build-file content reads quickly because lazy blob fetch was disabled. It still refused GPU HMR with `acceptedForGpuHmr=false` and `gpuHmrSuccess=false`.

Accepted cold source intake now also derives a generic runtime-boundary expectation facet. `synthi.gpu_hmr.cold_runtime_boundary_expectation.v1` is recomputed from source-detected backend candidates and build metadata discovery; runtime-boundary hints and oracle hints are retained only as diagnostics. It lists required stages, expected runtime event families, source-derived acceptable oracle kinds, and per-backend obligations, but it is explicitly `runtime_boundary_expectation_only_not_gpu_hmr_success`: an expectation cannot satisfy runtime proof. A no-network materialized wgpu run retained manifest `sha256:32af5c871c225599ff8a5cd3b10e812cde3338b9b1a229206bde389354b163b2` and expectation hash `sha256:4f954bd649c9b2e9575b1901210869102e97beaeb63e725e8c3aa7c378fc90c8`. It accepted runtime-boundary expectation for `metal`, `vulkan`, and `webgpu_wgsl`, required artifact transport, pipeline layout/binding or pipeline recreate, epoch publication, dispatch trace, host identity, output oracle, CPU/full-rebuild/restart firewall, and strict ledger, then still refused with `acceptedForGpuHmr=false` and `gpuHmrSuccess=false`.

That expectation is now actionable through a support-only runtime-boundary event-manifest template facet. `synthi.gpu_hmr.cold_runtime_boundary_event_manifest_template.v1` derives five `synthi.gpu_hmr.runtime_boundary_event.v1` event object templates for `artifact_transport`, `epoch_publication`, `dispatch_trace`, `host_identity`, and `output_oracle`, plus backend-specific field hints for HIP/ROCm, OpenCL, Vulkan, WebGPU, Metal, CUDA, and SYCL. The template deliberately does not emit a populated `runtimeBoundaryEvents` array, so it cannot be replayed as observed runtime proof. The materialized wgpu run retained manifest `sha256:152be8457623c5ca7b1e3a07b25c54c64d7e1e084b93360719ca426ccef136f8`, accepted source intake, accepted runtime-boundary expectation, accepted the event-manifest template with template hash `sha256:f49030222a1390e3cc972c78bf66b170d4da0b1e53932f7400e03ceeb8981aa5`, and still recorded `gpuHmrSuccess=false` and `canSatisfyRuntimeProof=false`.

Validation-matrix code now has an independent `coldRuntimeBoundaryEventManifestTemplateFacet` verifier for that cold template. It recomputes the top-level template hash, recomputes every per-event template hash, requires the five app-hook event kinds, rejects any GPU HMR/runtime/dispatch authority claim, and refuses templates that smuggle populated `runtimeBoundaryEvents` into a support artifact. The matrix smoke suite covers the accepted support-only template plus forged success, populated-runtime-events, missing output-oracle, bad per-event hash, and bad top-level hash cases.

Random large-project cold-path manifests are now first-class validation-matrix rows instead of producer-only artifacts. Matrix ingestion classifies `synthi.gpu_hmr.random_large_project_cold_path.v1` manifests into pending, dry-run, or fail-closed cold-intake rows, summarizes source-tree/build/backend evidence without copying huge file listings into the row, recomputes the cold runtime-boundary event-manifest template when present, and emits `random_large_arbitrary_project_cold_path` plan coverage. Row safety refuses any random cold-path row, cold template, or serialized row field that claims GPU HMR acceptance, GPU HMR success, runtime authority, or dispatch authority. A forged populated runtime-event template now fails the matrix row with `random_large_project_cold_template_not_validated` before it can be treated as observed loader/epoch/dispatch/output proof.

Broad library-agnostic readiness now also requires the matrix to contain at least five support-only random large arbitrary-project cold-path refusals with accepted source-tree intake, build metadata evidence, validated cold runtime-boundary event templates, and source-tree scale of at least 1000 files or 10 MiB of known source bytes. Random cold-path rows are counted as their own required evidence class and no longer inflate the adversarial-refusal minimum. The broad proof stays closed with `broad_acceptance_requires_random_large_project_cold_path` when strict full-runtime rows exist but the arbitrary cold-path lane is absent, with `broad_acceptance_requires_large_random_project_cold_paths` when only tiny direct rows are present, and with `broad_acceptance_requires_more_random_large_project_cold_paths` when only one to four large qualifying arbitrary cold paths are present. The latest retained matrix has five large qualifying direct cold-path rows and nine cold-path candidates, so the broad-readiness cold lane is open without converting cold-intake refusal evidence into per-project GPU HMR acceptance.

That broad-readiness cold-path gate now requires direct user-style arbitrary intake, not merely a packaged large-project profile or an internally configured sample-pool candidate. Qualifying rows must carry `profileMode=unprofiled_arbitrary_project_cold_intake`, `candidateSource=direct_source_url_commit` or `candidateSource=direct_local_git_repo_path`, immutable source identity from a URL or local repo path plus commit, accepted source-tree intake, accepted build metadata evidence, and validated support-only event-template evidence. A profile-backed real-ROCm cold attempt and a configured-pool unprofiled sample can still be useful refusal evidence, but neither can satisfy the arbitrary cold-path requirement by itself.

Broad readiness also requires at least one accepted source-first visual full-runtime row with strict runtime visual authority, accepted async visual/CAS support, and direct/user-owned source authority. Accepted source authorities are `direct_source_url_commit`, `direct_local_git_repo_path`, `user_source_files`, `workspace_source_files`, and `cli_or_env_direct_source`; profiled or built-in fixture source authority does not count. The source-first evidence remains non-authoritative by itself (`source_first_ingestion_provenance_only_not_runtime_proof` and `async_visual_metrics_and_transport_only`), but the broad proof must see it attached to a row that already passed full-runtime ledger, visual oracle, and row-safety gates. This selection is now retained as `synthi.gpu_hmr.source_first_visual_broad_readiness_predicate.v1` with authority `matrix_static_source_first_visual_predicate_not_project_name_whitelist`, predicate hash `sha256:6b31a1b7e1d17ca9344e551f72d30441727398a424518f91aa5d6fb60c1b9165`, `targetNameIndependent=true`, empty project/target whitelists, required strict visual/runtime signals, and ignored target/profile/fixture/project/source-basename values. The direct `user_source_files` visual run satisfies this visual lane, and the five large arbitrary cold-path rows satisfy the separate cold-intake lane in the latest retained matrix.

Verification for this patch:

```text
node --check mcp/synthi-mcp/scripts/gpu-hmr-real-rocm-repo-validation.mjs -> passed
npm --prefix mcp/synthi-mcp run proof:real-rocm:self-check -> passed, including run-id lifecycle status recovery and metadata snapshot checks
npm --prefix mcp/synthi-mcp run proof:real-rocm:large-ml-miopen with SYNTHI_REAL_ROCM_UPSTREAM_TIMEOUT_MS=120000 -> failed closed, gpu-real-rocm-MIOpen-20260630171112
node --check mcp/synthi-mcp/scripts/gpu-hmr-random-large-project-cold-path.mjs -> passed
npm --prefix mcp/synthi-mcp run proof:random-large-project:cold:self-check -> passed, including default unprofiled arbitrary candidate coverage
node --check mcp/synthi-mcp/scripts/lib/gpu-hmr-validation-matrix-ledger.mjs -> passed
node --check mcp/synthi-mcp/scripts/tests/gpu-hmr-validation-matrix-ledger-smoke.mjs -> passed
npm --prefix mcp/synthi-mcp run proof:random-large-project:cold:self-check -> passed with escalation after sandboxed Node `git` spawn returned EPERM; includes spoofed candidate JSON attempting to declare `direct_source_url_commit`, which is normalized back to `configured_candidate_pool`
node mcp/synthi-mcp/scripts/tests/gpu-hmr-validation-matrix-ledger-smoke.mjs -> passed, including random cold-path matrix rows, non-whitelisted direct-input broad-readiness predicate audit, forged direct candidate-source without runner input-mode marker refusal, forged serialized direct-input evidence refusal, broad-readiness random cold-path requirement, small-cold-path insufficiency, profiled cold-path insufficiency, configured-pool unprofiled insufficiency, single-random-cold-path insufficiency, source-first visual broad-readiness requirement, source-first visual predicate audit, opaque source-first visual target-id fixture, profiled source-first visual insufficiency, cold runtime-boundary event-template adversarial cases, and forged populated-runtime-event refusal, proofId gpu-validation-matrix-ledger:sha256:8da2c98a8d9a1afc55273de196b68757c430c7099813674652dc0eb3b8ec316d
retained validation-matrix recompute after content-backed build metadata hardening and row-local broad/scope separation -> proofId gpu-validation-matrix-ledger:sha256:70a59fb470f0b433993ec70cc699a3cb47efdfda0cf3d81c1185df9e09225e59, JSON mcp/synthi-mcp/.gpu-hmr-test-logs/validation-matrix/gpu-hmr-validation-matrix-20260701T095015Z.json, rows=114, acceptedFullRuntime=19, broadFullRuntime=0, scopedFullRuntime=19, allFullRuntime=19, refusals=74, cold splits=8, randomColdPathRowCount=5, randomColdPathCandidateRowCount=7, broad readiness accepted=true, broad proof gpu-hmr-broad-library-agnostic-proof:sha256:c2c76ea4ef18f7a8c22b98b4740173c801a29589c51401d1d74b19edab554ea2, broadRuntimeRowsMissing=false, rowLocalBroadRuntimeRowsMissing=true, matrixGeneralizationRuntimeRows=19, random cold predicate hash sha256:a184d8c93a3ec1ec35957e7aa2982c536a346a15c16322955294da4660dcde89, source-first visual predicate hash sha256:6b31a1b7e1d17ca9344e551f72d30441727398a424518f91aa5d6fb60c1b9165, source-first visual predicate authority=matrix_static_source_first_visual_predicate_not_project_name_whitelist, required direct-input evidence=synthi.gpu_hmr.random_cold_path_direct_source_input.v1, required authority=runner_cli_env_direct_source_input_only_not_gpu_hmr_success, required signals include source_derived_backend_candidates_observed, candidate_backend_declarations_diagnostic_only, build_metadata_content_evidence_accepted, build_metadata_content_hash_observed, strict_runtime_visual_authority_accepted, and visual_output_oracle_accepted, open gaps=none
npm --prefix mcp/synthi-mcp run proof:status-docs:self-check -> passed after the row-scope boundary documentation update against retained matrix gpu-validation-matrix-ledger:sha256:70a59fb470f0b433993ec70cc699a3cb47efdfda0cf3d81c1185df9e09225e59, broadFullRuntimeRows=0, scopedFullRuntimeRows=19
node mcp/synthi-mcp/scripts/gpu-hmr-random-large-project-cold-path.mjs --dry-run --source-url https://example.invalid/user/project.git --commit 1111111111111111111111111111111111111111 --source-id direct-user-project -> passed, selected direct-user-project, manifest sha256:896d0e4dc1097f9a1e69d860a313eda596d7053f3f31a38a395cd1e71a1da178
SYNTHI_GPU_HMR_UNPROFILED_SOURCE_INTAKE=0 node mcp/synthi-mcp/scripts/gpu-hmr-random-large-project-cold-path.mjs --source-url https://example.invalid/user/project.git --commit 1111111111111111111111111111111111111111 --source-id direct-user-project -> passed as fail-closed direct arbitrary-project refusal, manifest sha256:7b19a1e689b26ff13b43402edecc434fcd1bc44430c5976355697f82e4fd922b
node mcp/synthi-mcp/scripts/gpu-hmr-random-large-project-cold-path.mjs --source-url https://github.com/gfx-rs/wgpu.git --commit 22c6cb18d4b73254b0d62511e6a9d68e06dea70f --source-id direct-wgpu-user-path -> passed as fail-closed direct arbitrary-project intake with accepted source listing, manifest sha256:0c43d180417d4d8f25ba52f6de87b67d7f6c5a91ec4738269526bdf6d0578303
node mcp/synthi-mcp/scripts/gpu-hmr-random-large-project-cold-path.mjs --repo-path . --commit 430db98de60aaecef3ef0be53dc1e9ecf4b6aec5 --source-id direct-local-workspace -> passed as fail-closed local checkout intake with dirty-worktree refusal, manifest sha256:96eef09f737c4d49a7a844c0ec133cee8fe2229b1a449b148102f0a874b45178
node mcp/synthi-mcp/scripts/gpu-hmr-random-large-project-cold-path.mjs --source-url https://github.com/gfx-rs/wgpu.git --commit 22c6cb18d4b73254b0d62511e6a9d68e06dea70f --source-id direct-wgpu-user-path-buildmeta -> passed as fail-closed direct arbitrary-project intake with build metadata discovery, manifest sha256:1632b2625ab0522639fddf5027fb81216bf9636c26c03b57d4fc50ab0fbf7b6d
node mcp/synthi-mcp/scripts/gpu-hmr-random-large-project-cold-path.mjs --source-url https://github.com/gfx-rs/wgpu.git --commit 22c6cb18d4b73254b0d62511e6a9d68e06dea70f --source-id direct-wgpu-user-path-content -> passed as fail-closed direct arbitrary-project intake with build metadata content evidence, manifest sha256:3fcfee8fd5769eba8c9108649c9ec27dbdfc146c0bec7f6c51fea55e5a84a032, content evidence sha256:1aa362d604b10f49da4cd2b79a2242c9a4710dd011a8c4e60620e8e07e922b07
git ls-remote https://github.com/bevyengine/bevy.git HEAD -> 5558f7bb5d04b351e3d7123c32674b0b2f013e3a
node mcp/synthi-mcp/scripts/gpu-hmr-random-large-project-cold-path.mjs --source-url https://github.com/bevyengine/bevy.git --commit 5558f7bb5d04b351e3d7123c32674b0b2f013e3a --source-id direct-bevy-user-path-content -> passed as fail-closed direct arbitrary-project intake with build metadata content evidence, manifest sha256:cf805567cdf23e2967a7bff3e384c256609f0d0e5d7b85f9b27ac499572c4c97, content evidence sha256:7d7447b71c4952b5e7957e585c7a9dd60acf11f946261b04d1da118c5dd7faa4
SYNTHI_GPU_HMR_UNPROFILED_FORCE_GIT_FALLBACK=1 SYNTHI_GPU_HMR_UNPROFILED_SOURCE_INTAKE_TIMEOUT_MS=15000 node mcp/synthi-mcp/scripts/gpu-hmr-random-large-project-cold-path.mjs --source-url https://github.com/gfx-rs/wgpu.git --commit 22c6cb18d4b73254b0d62511e6a9d68e06dea70f --source-id direct-wgpu-forced-git-fallback-timeout -> passed as bounded fail-closed forced git fallback, manifest sha256:bb51164348974cf42630416f71289f72045ca5a837b15f62a6a38946debacd00, source-intake facet sha256:8ea019ed7b01ca11e69c65a7c1b2a3478a805d9f2612c275cadfba6ef0b6e37b, cleanup authority source_intake_timeout_cleanup_only_not_gpu_hmr_success
SYNTHI_GPU_HMR_LOCAL_GIT_NO_SIZE=1 GIT_NO_LAZY_FETCH=1 node mcp/synthi-mcp/scripts/gpu-hmr-random-large-project-cold-path.mjs --repo-path mcp/synthi-mcp/.gpu-hmr-test-logs/random-large-project-cold-path/source-intake/direct-wgpu-forced-git-fallback-timeout-22c6cb18d4b7 --commit 22c6cb18d4b73254b0d62511e6a9d68e06dea70f --source-id direct-wgpu-materialized-nosize -> passed as fail-closed materialized no-size arbitrary source intake, manifest sha256:a722a52c95c753a43ffd592f7303703b3a720e4cce603e5c1a0b64f82302bbc6
SYNTHI_GPU_HMR_LOCAL_GIT_NO_SIZE=1 GIT_NO_LAZY_FETCH=1 node mcp/synthi-mcp/scripts/gpu-hmr-random-large-project-cold-path.mjs --repo-path mcp/synthi-mcp/.gpu-hmr-test-logs/random-large-project-cold-path/source-intake/direct-wgpu-forced-git-fallback-timeout-22c6cb18d4b7 --commit 22c6cb18d4b73254b0d62511e6a9d68e06dea70f --source-id direct-wgpu-materialized-runtime-boundary -> passed as fail-closed materialized arbitrary source intake with runtime-boundary expectation, manifest sha256:32af5c871c225599ff8a5cd3b10e812cde3338b9b1a229206bde389354b163b2, expectation hash sha256:4f954bd649c9b2e9575b1901210869102e97beaeb63e725e8c3aa7c378fc90c8
SYNTHI_GPU_HMR_LOCAL_GIT_NO_SIZE=1 GIT_NO_LAZY_FETCH=1 node mcp/synthi-mcp/scripts/gpu-hmr-random-large-project-cold-path.mjs --repo-path mcp/synthi-mcp/.gpu-hmr-test-logs/random-large-project-cold-path/source-intake/direct-wgpu-forced-git-fallback-timeout-22c6cb18d4b7 --commit 22c6cb18d4b73254b0d62511e6a9d68e06dea70f --source-id direct-wgpu-materialized-event-template -> passed as fail-closed materialized arbitrary source intake with runtime-boundary event-manifest template, manifest sha256:152be8457623c5ca7b1e3a07b25c54c64d7e1e084b93360719ca426ccef136f8, template hash sha256:f49030222a1390e3cc972c78bf66b170d4da0b1e53932f7400e03ceeb8981aa5
npm --prefix mcp/synthi-mcp run proof:random-large-project:cold:dry-run -> passed, selected unprofiled-dawn-webgpu-stack, manifest sha256:7419645ca7eb374749bbdd77ad1f3a6b4fc8a1208cf2d5e60e25b9b5c4dcd626
npm --prefix mcp/synthi-mcp run proof:random-large-project:cold -> default unprofiled-dawn-webgpu-stack failed closed on truncated source-tree intake with fallback-plan evidence, manifest sha256:746456bb431c40655427a38539f5c8f7d3a94476347180933229933e07e3e89a
node mcp/synthi-mcp/scripts/gpu-hmr-random-large-project-cold-path.mjs --candidate unprofiled-wgpu-rust-graphics-stack -> accepted source-tree intake and refused runtime acceptance, manifest sha256:3f20a4e8c622e20e14943ac10240de7949d676ac129ff896e9d72bfa08616512
previous bounded profiled run: SYNTHI_GPU_HMR_LARGE_PROJECT_COLD_TIMEOUT_MS=120000 SYNTHI_GPU_HMR_LARGE_PROJECT_COLD_RUN_TIMEOUT_MS=15000 npm --prefix mcp/synthi-mcp run proof:random-large-project:cold -> passed as fail-closed bounded actual invocation, selected real-rocm-hipblaslt-gelu-aux-bias-large-ml, final manifest sha256:fb806f1d9a0a6e09e48b854b26d71acb7196e156de2b3afbb9c64c44405f1d03, pending manifest sha256:1f6767f3f96a49b3d7b4f0766050834405533ef6e821bf9682bd5d76602efcf3, status runner_timeout_failed_closed
git ls-remote https://github.com/ggerganov/llama.cpp.git HEAD -> 4f31eedb0ccf546b7e8d6bb243b170f12522f54d
SYNTHI_GPU_HMR_LARGE_PROJECT_COLD_CANDIDATES_JSON=[llama.cpp unprofiled candidate] npm --prefix mcp/synthi-mcp run proof:random-large-project:cold -> passed as fail-closed unprofiled arbitrary-project intake with accepted source listing, final manifest sha256:458e284f1861792ec270b96f3ef8842e108a46a4c45d0a5eb107a43a0c35cb4c, pending manifest sha256:8e8a3cc1c7fed69e73d2c0dacac95e3efcce33ea29911e81c5f640df34094ca2, source listing sha256:8fa51e93e94b52ea3248e2e3e00c0ef0ed401d17e6d23d35336f3adfaaccd4f3, status unprofiled_arbitrary_project_cold_intake_refused
```

## 2026-06-30 Source-First Compile-Proof Gate And Default Visual Rerun

The source-first agent-split runner now separates a cold compile-proof gate from a runtime GPU HMR acceptance gate. A structured `synthi.gpu_hmr.requested_proof_state_gate.v1` record can accept only the requested `gpu-hmr-compile-proven` boundary from a top-level rejected wait when the structured validation is satisfied, the effective rank is at least compile-proven, the immutable proof id is present, and the proof artifact path is present. The evidence is explicitly non-authoritative for runtime acceptance: `proofAuthority=structured_requested_proof_state_validation_only_not_gpu_hmr_acceptance`, `acceptedForGpuHmr=false`, `gpuHmrSuccess=false`, and `canSatisfyRuntimeProof=false`. Rejected waits cannot satisfy full-runtime, output-oracle, visual, host-preservation, or hot-device HMR gates.

The self-check covers the exact cold-boundary shape plus hostile cases: timeout status, wait error, rank below the requested state, a forged rejected full-runtime proof state, and missing proof artifact path. This keeps the earlier `gpu-agent-split-1782837031653` default-timeout failure as useful evidence of the bug without turning rejection into GPU HMR success.

After the fix, `proof:agent-split:source-first:realistic-raytrace` passed on the default runner path without `SYNTHI_GPU_WAIT_HMR_TIMEOUT_MS`. The retained workspace is `gpu-agent-split-1782837775261` at `http://localhost:3000/workspace/gpu-agent-split-1782837775261`. It started from profile source files (`src/main.cpp` plus `src/scene_config.h`), produced source-first ingestion proof `agent-split-source-first-ingestion:sha256:4cbb37a7b248720dbd5dc7e3b3be8d3f96f5af23b315a48d4ca7bd0408d4f660`, cold compile proof `gpu-proof:df58b9ddafc02401487992d5dcad3da10e6466174dafbcafc70f9c558456dac5`, hot delta 1 runtime proof `gpu-runtime-proof:sha256:95b7118d8dc6576fce67f86d7544ffc4aab49dcc1ebb71923d7b2b5ac5d01cab` with ledger `gpu-ledger-proof:sha256:878693032ed737890a166adeb4012ace13af23967b3f535362dc32474731cfa6`, and hot delta 2 runtime proof `gpu-runtime-proof:sha256:8fd173b95924f8bfc3e1e1268d4e2c36ea0bf9245059f0164227fcc540199be3` with ledger `gpu-ledger-proof:sha256:be57c47e3d978d5aeb6b59cbb0d7f4ca35de8bb18fcaff14a485c8550aeb6570`.

Visual proof remained byte-backed and frame-gated. Hot delta 1 changed `73.73%` of visible pixels with `mean_abs=18.40`; hot delta 2 changed `99.50%` with `mean_abs=37.25`; both selected frames were captured after epoch dispatch, and the negative ABI edit refused before GPU HMR acceptance. Timings for the latest accepted default run were:

```text
cold: device_compile_wall_time=20.88ms, runtime_probe_time=9.192s, total_validator_wall_time=9.213s
hot_delta_1: device_compile_wall_time=14.46ms, runtime_probe_time=4.982s, total_validator_wall_time=4.997s
hot_delta_2: device_compile_wall_time=30.95ms, runtime_probe_time=3.920s, total_validator_wall_time=3.951s
```

Verification for this patch and rerun:

```text
node --check mcp/synthi-mcp/scripts/gpu-hmr-agent-split-workspace-test.mjs -> passed
npm --prefix mcp/synthi-mcp run proof:agent-split:source-first:self-check -> passed, including requested proof-state gate adversarial checks
npm --prefix mcp/synthi-mcp run proof:agent-split:source-first:realistic-raytrace -> passed, workspace gpu-agent-split-1782837775261, strict visual runtime proofs accepted for hot_delta_1 and hot_delta_2
```

## 2026-06-30 Agent-Split Proof Wait Retry And MCP Cleanup

The source-first agent-split runner now has a generic strict-proof finalization retry for `synthi_wait_hmr`. The retry is limited to proof-pending/missing strict-proof cases such as `proof_state_missing`, `proof_ledger_missing`, or `runtime_proof_artifact_missing`; it does not retry terminal rejections, `failed_fast` timeout-intelligence results, malformed errors, CPU/full-rebuild/restart evidence, failed ledger invariants, rejected runtime proof artifacts, or non-strict waits. The second wait reuses the same compile dispatch timestamp, `since_ts`, module, selected generated path, edit id/hash, and required proof contract. It is bounded to one support-only retry by default.

The retry evidence is intentionally non-authoritative: `synthi.gpu_hmr.strict_proof_wait_retry.v1`, `proofAuthority=strict_proof_wait_retry_scheduling_only_not_gpu_hmr_acceptance`, `acceptedForGpuHmr=false`, `gpuHmrSuccess=false`, and `canSatisfyRuntimeProof=false`. It records per-attempt status, reason, result state/rank, proof ids, failed gates, retry budget, elapsed time, and the stable wait-contract binding. A later accepted wait still has to pass the existing full-runtime proof and visual/output oracle gates; retry evidence cannot lower the requested proof state or satisfy GPU HMR by itself.

The same patch fixes MCP startup cleanup in the agent-split runner. If MCP `initialize` or `tools/list` fails before `mcpState` is assigned, the just-spawned MCP process is now terminated immediately and the cleanup is recorded. MCP startup waits now use the runner's generic `MCP_REQUEST_TIMEOUT_MS` budget instead of a hardcoded 20 second cap. This addresses a real default rerun failure where MCP initialize timed out and left Node child processes alive.

Verification for this patch:

```text
node --check mcp/synthi-mcp/scripts/gpu-hmr-agent-split-workspace-test.mjs -> passed
npm --prefix mcp/synthi-mcp run proof:agent-split:source-first:self-check -> passed, including proof-finalization retry and MCP startup cleanup self-checks
npm --prefix mcp/synthi-mcp run proof:agent-split:source-first:realistic-raytrace without SYNTHI_GPU_WAIT_HMR_TIMEOUT_MS -> initially failed closed as gpu-agent-split-1782837031653 at the cold source-first compile/apply gate; this was superseded by the compile-proof gate fix and successful default rerun gpu-agent-split-1782837775261
```

## 2026-06-30 Source-First Visual Proof And MIOpen Bounded Rerun

The source-first realistic raytrace user path was rerun from uncompiled profile source files with a longer strict proof wait window. The runner seeded `src/main.cpp` plus `src/scene_config.h`, preserved the local quoted-include closure through the deterministic splitter, generated explicit module files and device roles under `.synthi/generated/gpu/`, selected worker-detected ROCm arch `gfx1201`, published two hot GPU epochs, and closed strict visual runtime proof for both hot deltas. That retained workspace is `gpu-agent-split-1782834376257`; the newer default-timeout accepted workspace is `gpu-agent-split-1782837775261`.

This is the user-facing no-precompiled path, but the claim remains scoped. The accepted row proves generated/profiled ROCm/HIP visual GPU HMR for this source-first workload: source-first ingestion proof `agent-split-source-first-ingestion:sha256:7c1aa01e72f97043b2b5591f931f7c495c3620bbd92da31d6caf09e4b07136a1`, hot delta 1 runtime proof `gpu-runtime-proof:sha256:d30824d8199a012d7752cf15d68dad1ea458dd83e97fd9c3c8af1b8c4a7ed0e5` with ledger `gpu-ledger-proof:sha256:7e9ce98917844018ed6d5dcc7c20434b9f5884f32078d04c48377c24f3b137d4`, and hot delta 2 runtime proof `gpu-runtime-proof:sha256:6219c77c1cebdd3fe2cdb69500655f2309bdeeb853cf3a01267274131ab2384d` with ledger `gpu-ledger-proof:sha256:74272e54e0e8efd1f92a819184d31ec5973c696320216cfed8569451eb1629fc`. Visual proof was byte-backed, not log-backed: before/after/diff PNGs were opened locally and the image evidence is nonblank, visibly raytraced, and scene-level with foreground gems, storefront geometry, reflective surfaces, shadows, and vehicle geometry. Hot visual deltas were `changed=73.72%, mean_abs=18.37` and `changed=99.50%, mean_abs=37.28`; control deltas stayed effectively unchanged. The negative ABI edit still refused before GPU HMR acceptance.

The large ROCm MIOpen path was rerun after Docker and the compose services were available, using `SYNTHI_REAL_ROCM_UPSTREAM_TIMEOUT_MS=120000`. The retained attempt `gpu-real-rocm-MIOpen-20260630155225` reached the real MIOpen repository at `06977176afd94476c18d5290f21cb40745bb73a9`, staged the source tree through shared CAS, accepted the external header prerequisite, exported the generic runtime-boundary target environment, executed the lifecycle-finalizer adapter, and copied the adapter-result transport. It still correctly failed closed: upstream configure/build failed without usable metadata, event-manifest materialization found zero real boundary lines, no event-manifest transport was copied, no native launch/runtime boundary lines were captured, and no artifact transport, epoch publication, dispatch trace, host identity, output oracle, firewall, runtime chain, or strict proof-ledger closure was observed.

The MIOpen strict runtime proof remains refusal-only. The final rejected strict proof was `gpu-runtime-proof:sha256:617a811ee630e9389693778ea1584aca3ba3cb1679ea282ff3bb5a1708d9df84`; the pre-collection fatal artifact also recorded rejected strict proof `gpu-runtime-proof:sha256:823563285b721c5fcf4f7fceafb48453c80d714301e4e1d265a70bba1a88ec19`. No MIOpen visual or compute output oracle was produced. This is serious-project infrastructure evidence and fail-closed proof discipline, not MIOpen hot-reload acceptance and not arbitrary-project acceptance by template, target name, or logs.

Verification for this rerun batch:

```text
npm --prefix mcp/synthi-mcp run proof:agent-split:source-first:realistic-raytrace with SYNTHI_GPU_WAIT_HMR_TIMEOUT_MS=60000 -> passed, workspace gpu-agent-split-1782834376257, strict visual runtime proofs accepted for hot_delta_1 and hot_delta_2
npm --prefix mcp/synthi-mcp run proof:real-rocm:large-ml-miopen with SYNTHI_REAL_ROCM_UPSTREAM_TIMEOUT_MS=120000 -> failed closed, gpu-real-rocm-MIOpen-20260630155225, gpuHmrSuccess=false, fullRuntimeProven=false
local image inspection -> opened source-first before/after/diff PNGs; frames are nonblank and visibly raytraced; this inspection is supporting evidence only and strict acceptance remains ledger-driven
```

## 2026-06-30 Matrix Event-Manifest Boundary Transport

Validation-matrix ingestion now treats copied real ROCm runtime-adapter event manifests as first-class boundary-source transport, separate from adapter-result bytes. A boundary-only bridge can preserve `resultPresent=false`, `eventManifestPresent=true`, and boundary lines from the event manifest while still refusing strict adapter-result import. The matrix recomputes the boundary payload, ignores `runtime_profile_adapter_result_unreadable` only for boundary import when the event manifest is present and carries accepted boundary lines, and recomputes target-process provenance with `eventManifestTransportCopied` plus `boundarySourceTransportCopied`.

This is generic adapter plumbing, not a large-project shortcut. Copied runtime-adapter event manifests may satisfy boundary-source transport only for boundary-only adapter-result evidence, only when the event-manifest transport facet is accepted, and only when the adapter-result transport failure is limited to missing result bytes. Forged result-transport schema/authority/success claims remain blockers even if event-manifest transport is clean. Both transport facets reject wrong schema, wrong evidence-only authority, missing copied status, missing hash/byte length/evidence refs, and any GPU HMR/runtime/dispatch authority claims. Full-runtime acceptance still depends on strict proof-ledger success, runtime-chain closure, output oracle bytes, target-process provenance, same-process/firewall proof, and row-safety checks.

Verification for this patch:

```text
node --check mcp/synthi-mcp/scripts/lib/gpu-hmr-validation-matrix-ledger.mjs -> passed
node --check mcp/synthi-mcp/scripts/tests/gpu-hmr-validation-matrix-ledger-smoke.mjs -> passed
npm --prefix mcp/synthi-mcp run proof:validation-matrix:self-check -> passed; focused smoke proof gpu-validation-matrix-ledger:sha256:c009e5f61f48f963ad57fa3112b5118d71c89a25240cbcc7839a79a0f38119d9, rows=65; retained self-check proof gpu-validation-matrix-ledger:sha256:0e55b69fdd414c23e884cd126af1d1342c72c26b6abcc18a01aa704a5ed629f4
```

## 2026-06-30 Real ROCm Timeout Source Audit

Large ROCm ML package scripts now label the source of `SYNTHI_REAL_ROCM_UPSTREAM_TIMEOUT_MS` before they apply the default. A caller-provided value is recorded as `caller_env`; the package default is recorded as `package_default`. The real ROCm runner carries that label and the raw env value into `synthi.real_rocm.worker_lifecycle_timeout_control.v1`, and validation-matrix ingestion recomputes timeout arithmetic from the retained facet: `timeoutMs`, `timeoutSeconds`, `killAfterSeconds`, `timeoutSource`, and `timeoutEnvValue` must agree.

This closes an orchestration-audit gap exposed by bounded serious-project runs. A retained report can now prove whether a two-minute MIOpen/CK/hipBLASLt run actually used the caller override or silently fell back to the two-hour package default. The facet remains support/refusal evidence only; timeout source, timeout math, wrapper cleanup, and process-marker evidence cannot satisfy artifact transport, epoch publication, dispatch trace, host identity, app-hook closure, output oracle, firewall, strict runtime proof, or proof-ledger success.

Validation coverage is generic. The package-script smoke check verifies all large-ML scripts preserve caller overrides and emit timeout-source instrumentation. Matrix smoke coverage accepts a clean `caller_env` timeout (`120000 ms -> 120 s`, `killAfterSeconds=6`) and refuses a forged row whose env value says `120000` while the retained timeout claims `7200000`, with `real_rocm_worker_lifecycle_timeout_control_env_value_mismatch` and `real_rocm_operational_evidence_not_accepted`.

Verification for this patch:

```text
node --check mcp/synthi-mcp/scripts/gpu-hmr-real-rocm-repo-validation.mjs -> passed
node --check mcp/synthi-mcp/scripts/lib/gpu-hmr-validation-matrix-ledger.mjs -> passed
node --check mcp/synthi-mcp/scripts/tests/gpu-hmr-real-rocm-package-scripts-smoke.mjs -> passed
node --check mcp/synthi-mcp/scripts/tests/gpu-hmr-validation-matrix-ledger-smoke.mjs -> passed
npm --prefix mcp/synthi-mcp run proof:real-rocm:package-scripts:self-check -> passed, upstreamTimeoutSourceRecorded=true, callerOverridePreserved=true
npm --prefix mcp/synthi-mcp run proof:real-rocm:self-check -> passed; POSIX adapter-template execution self-checks still skip fail-closed on this Windows host with EPERM
node mcp/synthi-mcp/scripts/tests/gpu-hmr-validation-matrix-ledger-smoke.mjs -> passed, proof gpu-validation-matrix-ledger:sha256:5276baa7c379f94928ba56bc4e02d128de51d77c800aeaa2b6febdcc9b950caa, rows=65
npm --prefix mcp/synthi-mcp run proof:validation-matrix:self-check -> passed after rerun with a longer command timeout; smoke proof gpu-validation-matrix-ledger:sha256:4ef0142b948a99bfda673c66a06de5f9b39bb9949baef41428b691545c08c959, retained self-check proof gpu-validation-matrix-ledger:sha256:f4c73514d8f968a2b810ca53dd8c8419da6d85a5e8ec934e1ba931c4bcd8ec1d
npm --prefix mcp/synthi-mcp run proof:status-docs:self-check -> passed, retained matrix gpu-validation-matrix-ledger:sha256:e9ee4aaa7c6386b325780c2ddc0261df7e42337c3e9c1ac6b3b9b0c6ac634bd2, rowCount=63, acceptedFullRuntimeRows=17, broadFullRuntimeRows=17
```

## 2026-06-30 Real ROCm Lifecycle Status Classifier Hardening

The real ROCm upstream lifecycle classifier now treats timeout-fallback `unknown` status fields as unknown locally, then recovers `configure_status`, `post_configure_status`, `build_status`, and `run_status` only from wrapper-owned skip lines such as `upstream build skipped after ...` and `upstream run skipped after ...`. Arbitrary project logs that print success-shaped `*_status=0` tokens are ignored for status recovery, so a build script cannot spoof a configure/build/run success by writing convenient text.

This closes a serious-project refusal fidelity gap without adding any project branch. A run that configured successfully and then timed out or was terminated in build now classifies as `upstream_build_failed` / `upstream_run_not_started_after_build_failure`, not as a configure failure just because fallback timing text had `configure_ms=failed`. Post-configure failures now have explicit `upstream_post_configure_failed`, build-blocked, and run-blocked reasons. The resulting proof-scheduling signals remain refusal-only and cannot satisfy artifact transport, epoch publication, dispatch trace, host identity, app-hook closure, output oracle, firewall, strict runtime proof, or proof-ledger success.

Validation-matrix ingestion now repeats that lifecycle-status recompute from retained timing text and configure/build/run log tails when they exist. This prevents a stale serialized lifecycle facet from preserving a false configure-failure reason after wrapper-owned logs prove configure succeeded and build timed out. The matrix smoke suite covers both stale-facet repair and project-log status spoof refusal.

The follow-up bounded MIOpen verification attempt after this code change timed out before producing a retained result, and the marked worker-side lifecycle process was cleaned up. No new MIOpen success or new retained MIOpen proof artifact is claimed from that timed attempt; the latest retained serious-project evidence remains the fail-closed `gpu-real-rocm-MIOpen-20260630132711` artifact described below.

Verification for this patch:

```text
node --check mcp/synthi-mcp/scripts/gpu-hmr-real-rocm-repo-validation.mjs -> passed
npm --prefix mcp/synthi-mcp run proof:real-rocm:self-check -> passed, including timeout-build, post-configure, and project-log status-spoof lifecycle classifier checks
npm --prefix mcp/synthi-mcp run proof:validation-matrix:self-check -> passed; self-check proof gpu-validation-matrix-ledger:sha256:8c6464d679ea7fe27738d1994489b34139a5f872d3868d634786335ff09c9c7a
```

## 2026-06-30 Vulkan Host Runtime And Broad Matrix Refresh

Vulkan now has scoped live full-runtime visual proof on this Windows host through a generic host-local Vulkan transport. The runtime proof still records the worker-container Vulkan preflight as refusal-only support when the worker has only `libvulkan.so.1` and no ICD/tooling. On Windows hosts with usable Vulkan, the runner executes a temporary PowerShell `Add-Type` probe that binds `vulkan-1.dll`, creates a real Vulkan instance/device/queue, descriptor set, pipeline layouts, shader modules, compute pipelines, command buffers, fences, and a host-visible readback buffer, then dispatches epoch 1 before creating/loading/publishing and dispatching epoch 2.

This is scoped Vulkan proof, not arbitrary Vulkan engine or framework acceptance. Transport metadata remains support-only (`runtime_probe_execution_transport_only_not_gpu_hmr_success`), and acceptance depends on the recomputed proof ledger, strict runtime artifact, visual PNG byte proof, deterministic visual mode, native Vulkan API counts, timestamp order, artifact hash chain, no-shim source identity, declared `vulkan_declared_pipeline_visual` scope, and negative pipeline-layout edit refusal. The live path now fails closed when native counts or loader/epoch/dispatch/output trace arrays are missing, when epoch 2 is not actually loaded after epoch 1 output, or when dispatch/output IDs do not bind.

Latest saved validation matrix after content-backed build metadata hardening for random large arbitrary cold paths and row-local broad/scope separation: `gpu-validation-matrix-ledger:sha256:70a59fb470f0b433993ec70cc699a3cb47efdfda0cf3d81c1185df9e09225e59`, JSON `mcp/synthi-mcp/.gpu-hmr-test-logs/validation-matrix/gpu-hmr-validation-matrix-20260701T095015Z.json`, 114 rows, 19 accepted full-runtime GPU HMR, 0 broad library-agnostic full-runtime GPU HMR, 19 scoped full-runtime GPU HMR, 19 all full-runtime, 74 refusals, 8 cold splits. Scope breakdown: `generated_rocm_hip_preview_visual: 4`, `hip_module_declared_compute_readback: 2`, `opencl_declared_compute_readback: 2`, `vulkan_declared_pipeline_visual: 1`, `webgpu_declared_compute_readback: 2`, and `webgpu_declared_pipeline_visual: 8`. The saved matrix carries strict scoped full-runtime HIP, OpenCL, Vulkan, and WebGPU evidence plus two accepted direct/user-owned source-first visual rows. Broad readiness is now `accepted=true` with proof `gpu-hmr-broad-library-agnostic-proof:sha256:c2c76ea4ef18f7a8c22b98b4740173c801a29589c51401d1d74b19edab554ea2`, `broadRuntimeRows=0`, `broadRuntimeRowsMissing=false`, `rowLocalBroadRuntimeRowsMissing=true`, `scopedRuntimeRows=19`, and `matrixGeneralizationRuntimeRows=19` because five direct large arbitrary cold-path rows meet the source/build-content/template support gate: `direct-llama-cpp-current-template`, `direct-filament-user-path-current-template`, `direct-vulkan-samples-user-path-current-template`, `direct-bevy-user-path-current-template`, and `direct-wgpu-user-path-current-template`. The broad proof records `synthi.gpu_hmr.random_cold_path_broad_readiness_predicate.v1` with authority `matrix_static_predicate_not_project_name_whitelist`, `targetNameIndependent=true`, empty `projectNameWhitelist` / `specificTargetIdsAllowed`, source identity role `identity_presence_and_immutable_commit_only_not_whitelist`, accepted `synthi.gpu_hmr.random_cold_path_direct_source_input.v1` evidence with authority `runner_cli_env_direct_source_input_only_not_gpu_hmr_success`, required signals `direct_source_input_evidence_accepted`, `direct_cli_or_env_input_mode_observed`, `source_derived_backend_candidates_observed`, `candidate_backend_declarations_diagnostic_only`, `build_metadata_discovery_accepted`, `build_metadata_content_evidence_accepted`, and `build_metadata_content_hash_observed`, and predicate hash `sha256:a184d8c93a3ec1ec35957e7aa2982c536a346a15c16322955294da4660dcde89`. It also records `synthi.gpu_hmr.source_first_visual_broad_readiness_predicate.v1` with authority `matrix_static_source_first_visual_predicate_not_project_name_whitelist`, `targetNameIndependent=true`, empty `projectNameWhitelist` / `specificTargetIdsAllowed`, accepted direct/user-owned source authorities, required strict visual/runtime signals including `strict_runtime_visual_authority_accepted` and `visual_output_oracle_accepted`, ignored target/profile/fixture/project/source-basename fields, and predicate hash `sha256:6b31a1b7e1d17ca9344e551f72d30441727398a424518f91aa5d6fb60c1b9165`. This is aggregate matrix readiness, not automatic acceptance for MIOpen, Composable Kernel, hipBLASLt, HIPRT no-shim apps, Filament, Vulkan-Samples, Bevy, CUDA, wgpu, llama.cpp, or arbitrary engine-owned pipeline caches.

Previous saved validation matrix artifacts that reported broad readiness under weaker cold-path rules are retained for traceability only. They are superseded by the size-gated, content-backed, predicate-audited matrix above, where broad readiness reopens only after five large direct arbitrary cold-path rows qualify through a recorded non-whitelist predicate with source-derived backend identity and build metadata byte evidence.

Current Vulkan row in that matrix: `gpu-validation-matrix-row:sha256:c0e9f8d1509334ae80200ee736df5050e585e12bb11ae7a8fd951248893342e8`, proof `vulkan-runtime-proof:sha256:de768ddd560863deac94f7740adf55af5a3fb59e730c9e0109fd383135bc8e84`, runtime artifact `vulkan-runtime-proof-artifact:62fbf87f8551fdce10a33595c8c5a76d42683ac3522676a942c7f1a5c4a94134`, ledger `gpu-ledger-proof:sha256:599ef0607b62dab245d7b29b9dae68ed6a30733520bb8aaaff7a54371ae03fb1`. The visual proof artifacts were opened locally from `mcp/synthi-mcp/.gpu-hmr-test-artifacts/vulkan-runtime-proof/vulkan-runtime-frame-20260630124806/`; they are nonblank before/after/diff readback images with changed pixel ratio `1.0`, mean absolute delta `132`, and visible pixel count `16384`.

Verification for this patch:

```text
node --check mcp/synthi-mcp/scripts/gpu-hmr-vulkan-runtime-proof.mjs -> passed
npm --prefix mcp/synthi-mcp run proof:vulkan:runtime:self-check -> passed, including forged after-frame hash refusal
npm --prefix mcp/synthi-mcp run proof:vulkan:runtime -> passed, vulkan-runtime-proof:sha256:de768ddd560863deac94f7740adf55af5a3fb59e730c9e0109fd383135bc8e84, runtime artifact vulkan-runtime-proof-artifact:62fbf87f8551fdce10a33595c8c5a76d42683ac3522676a942c7f1a5c4a94134, ledger gpu-ledger-proof:sha256:599ef0607b62dab245d7b29b9dae68ed6a30733520bb8aaaff7a54371ae03fb1
npm --prefix mcp/synthi-mcp run proof:validation-matrix:self-check -> superseded by retained recompute `gpu-validation-matrix-ledger:sha256:70a59fb470f0b433993ec70cc699a3cb47efdfda0cf3d81c1185df9e09225e59`, which reopens broad readiness only as aggregate matrix generalization after five large arbitrary cold-path rows qualify through the non-whitelisted direct-input evidence predicate audit, source-derived backend identity, and build metadata content hashes
npm --prefix mcp/synthi-mcp run proof:validation-matrix -> passed, gpu-validation-matrix-ledger:sha256:70a59fb470f0b433993ec70cc699a3cb47efdfda0cf3d81c1185df9e09225e59, json=mcp/synthi-mcp/.gpu-hmr-test-logs/validation-matrix/gpu-hmr-validation-matrix-20260701T095015Z.json
```

The large ROCm ML rows remain refusal evidence only. The broad matrix proof is a recomputed validation-matrix generalization claim over strict rows and adversarial refusals; it does not authorize MIOpen, Composable Kernel, hipBLASLt, HIPRT no-shim apps, Bevy, CUDA, or arbitrary engine-owned pipeline caches without their own runtime boundary, output-oracle, firewall, and strict ledger closure.

## 2026-06-30 Real ROCm Runtime-Adapter Lifecycle Finalizer

Declared `runtimeAdapter.runWhen=after_lifecycle_attempt` adapters now have a finalizer execution slot before runtime evidence collection when the normal run path exits early and no `runtime_adapter_execution` facet exists. This is keyed only on the generic lifecycle enum and declared/enabled adapter state; non-finalizer lifecycle slots, undeclared adapters, and rows that already have an execution facet are skipped.

The purpose is to preserve fail-closed adapter/result/event-manifest evidence for large ROCm lifecycle failures such as configure, build, or metadata collection errors. The facet remains support/refusal evidence only: adapter command success, copied result manifests, copied event manifests, boundary lines, and template identity still cannot authorize GPU HMR without the normal strict runtime proof artifact, recomputed ledger, runtime-chain closure, artifact transport, epoch publication, dispatch trace, host identity, output oracle, firewall, and row-safety gates.

Verification for this patch:

```text
node --check mcp/synthi-mcp/scripts/gpu-hmr-real-rocm-repo-validation.mjs -> passed
npm --prefix mcp/synthi-mcp run proof:real-rocm:self-check -> passed, including lifecycle-finalizer eligibility checks; POSIX template execution self-checks remain skipped fail-closed on this Windows host with EPERM
```

## 2026-06-30 Runtime-Boundary Event-Manifest Materializer

The real ROCm runner now has a generic producer for declared runtime-boundary event manifests when the upstream target emits actual `[gpu-runtime-boundary]` lines only into the run log. The materializer runs only for declared/enabled adapters with a safe repo-relative event-manifest path, preserves exact observed lines, records line hashes plus five-stage coverage, and writes a support-only `synthi.gpu_hmr.runtime_boundary_event_manifest.v1` manifest. It does not synthesize boundary events from profile declarations, repository names, target names, or adapter success.

Partial coverage is still refusal/support evidence: missing stages are recorded as `runtime_boundary_event_manifest_<stage>_missing`, and the validation matrix/bridge must still recompute stage events, target-process provenance, output oracle, firewall, runtime chain, strict proof artifact, and proof-ledger closure. When no boundary lines are observed, no manifest is fabricated and the existing `runtime_adapter_event_manifest_transport_worker_file_missing` gap remains.

Fresh bounded MIOpen check: the sandboxed run failed at Docker preflight with `spawn EPERM`; the approved unsandboxed rerun `gpu-real-rocm-MIOpen-20260630132711` reached Docker, source-tree CAS staging, external header prerequisite evidence, and target-environment export, then failed closed during configure/build metadata collection. The runtime-adapter finalizer executed, copied the adapter result, and exercised the materializer. Because the run log contained zero real boundary lines, materialization stayed `runtime_boundary_event_manifest_materialization_no_boundary_lines`, event-manifest transport stayed `runtime_adapter_event_manifest_transport_missing`, and strict runtime proof `gpu-runtime-proof:sha256:fc7ae97d93b58e06f034a97b7d8f44037d1da8ed16f22bed499a3e249b25e02a` was rejected. `gpuHmrSuccess=false` and `fullRuntimeProven=false`.

Verification for this patch:

```text
node --check mcp/synthi-mcp/scripts/gpu-hmr-real-rocm-repo-validation.mjs -> passed
npm --prefix mcp/synthi-mcp run proof:real-rocm:self-check -> passed, including complete, partial, and empty run-log materializer checks; POSIX template execution self-checks remain skipped fail-closed on this Windows host with EPERM
npm --prefix mcp/synthi-mcp run proof:validation-matrix:self-check -> passed, retained matrix gpu-validation-matrix-ledger:sha256:e9ee4aaa7c6386b325780c2ddc0261df7e42337c3e9c1ac6b3b9b0c6ac634bd2
npm --prefix mcp/synthi-mcp run proof:validation-matrix -> passed, gpu-validation-matrix-ledger:sha256:e9ee4aaa7c6386b325780c2ddc0261df7e42337c3e9c1ac6b3b9b0c6ac634bd2, json=mcp/synthi-mcp/.gpu-hmr-test-logs/validation-matrix/gpu-hmr-validation-matrix-20260630T133648Z.json
npm --prefix mcp/synthi-mcp run proof:real-rocm:large-ml-miopen with SYNTHI_REAL_ROCM_UPSTREAM_TIMEOUT_MS=120000 -> failed closed, gpu-real-rocm-MIOpen-20260630132711, materialization_status=runtime_boundary_event_manifest_materialization_no_boundary_lines
```

## 2026-06-30 OpenCL Host Runtime And Matrix Refresh

OpenCL now has scoped live full-runtime compute/readback proof on this Windows host through a generic host-local OpenCL transport. The runtime proof still first attempts the worker-container path; when that path is structurally unavailable because the container has no usable OpenCL ICD/platform, the runner can execute a temporary PowerShell `Add-Type` probe that binds `OpenCL.dll`, builds before/after OpenCL C programs, dispatches `synthi_opencl_epoch_kernel` through `clEnqueueNDRangeKernel`, reads raw output bytes through `clEnqueueReadBuffer`, and emits the same runtime trace/readback artifacts used by the existing strict proof ledger.

This is scoped OpenCL proof, not broad arbitrary-project acceptance. The transport metadata is support-only (`runtime_probe_execution_transport_only_not_gpu_hmr_success`), and acceptance still depends on the recomputed proof ledger, strict runtime artifact, raw byte-backed compute oracle, expected output verification, native API counts, timestamp order, artifact hash chain, no-shim source identity, declared OpenCL scope, and negative ABI-edit refusal.

Latest retained validation matrix artifact: `gpu-validation-matrix-ledger:sha256:521a502b6c1d1fe3aec510942022ceee6d2e118fb6b3958a4110608350fbd1d0`, JSON `mcp/synthi-mcp/.gpu-hmr-test-logs/validation-matrix/gpu-hmr-validation-matrix-20260630T113320Z.json`, 60 rows, 16 accepted full-runtime GPU HMR rows, 0 broad library-agnostic full-runtime GPU HMR rows, 16 scoped full-runtime GPU HMR rows, 16 all full-runtime rows, 31 refusals, 7 cold splits, 2 deterministic fission rows, 3 visual-profile rows, 1 preflight-only row, and 0 included unproven rows. Scope breakdown: `generated_rocm_hip_preview_visual: 2`, `hip_module_declared_compute_readback: 2`, `opencl_declared_compute_readback: 2`, `webgpu_declared_compute_readback: 2`, `webgpu_declared_pipeline_visual: 8`. `per_target_run_modes status=accepted`. Broad readiness remains `accepted=false` with open gap `broad_acceptance_requires_more_backend_families`; current accepted strict backend families are HIP, OpenCL, and WebGPU.

Current OpenCL rows in that matrix: hot delta 1 `gpu-validation-matrix-row:sha256:4943d7b099075a431f37236b184ad7dfbac131d385dae48eb6ed99731f1b5773`; hot delta 2 `gpu-validation-matrix-row:sha256:d5e45d4eb8952ca30a1fbc882ea02b491581783f66f3fbd566de71f07959ca84`.

Verification for this patch:

```text
node --check mcp/synthi-mcp/scripts/gpu-hmr-opencl-runtime-proof.mjs -> passed
npm --prefix mcp/synthi-mcp run proof:opencl:runtime:self-check -> passed, including Windows probe source-shape checks and forged raw-readback refusal
npm --prefix mcp/synthi-mcp run proof:opencl:runtime -> passed, opencl-runtime-proof:sha256:73594daf0b31354da7eaea6f1487c9d51ad5cee5acc5c88384eb965411209e82, runtime artifact opencl-runtime-proof-artifact:dafde562ec2f1afe02f3c18ac275c9004b622fa56135702cb991000a31e92771, ledger gpu-ledger-proof:sha256:35d4a1e5a9c9408e5dd516bd32a1a3fdb8fa6350245e41f1251a20310f1f808c
npm --prefix mcp/synthi-mcp run proof:opencl:runtime:hot2 -> passed, opencl-runtime-proof:sha256:4ffef3afdc58d5a8bab8623d451c98b7683f02efbbd950bdceb24ea53fed9fc7, runtime artifact opencl-runtime-proof-artifact:ec6dde15d1eca85866e24cd78f471d532aa4706b0bfdc8f7536a25f09c3ecbbf, ledger gpu-ledger-proof:sha256:983ba910d94009c28ddd1f70f46824c1a6b343ea1544eeae0bfa51d14be137c2
npm --prefix mcp/synthi-mcp run proof:opencl:preflight -> passed as refusal-only worker-container evidence, opencl-preflight-proof:sha256:98ec455f0f00cbe74c1716644124dd3cff7341cfd52d694427b80892da010875, opencl_accepted=false, unsupported_reasons=opencl_vendor_icd_missing,clinfo_missing
npm --prefix mcp/synthi-mcp run proof:validation-matrix:self-check -> passed; retained matrix gpu-validation-matrix-ledger:sha256:521a502b6c1d1fe3aec510942022ceee6d2e118fb6b3958a4110608350fbd1d0 reports 16 scoped full-runtime rows and 0 broad rows
npm --prefix mcp/synthi-mcp run proof:validation-matrix -> passed, gpu-validation-matrix-ledger:sha256:521a502b6c1d1fe3aec510942022ceee6d2e118fb6b3958a4110608350fbd1d0, json=mcp/synthi-mcp/.gpu-hmr-test-logs/validation-matrix/gpu-hmr-validation-matrix-20260630T113320Z.json
npm --prefix mcp/synthi-mcp run proof:real-rocm:large-ml-miopen with SYNTHI_REAL_ROCM_UPSTREAM_TIMEOUT_MS=120000 -> failed closed, gpu-real-rocm-MIOpen-20260630113345, strict runtime proof gpu-runtime-proof:sha256:c2693e5f9ab7930ea7d2899fc9e19c7c2053fb803ff21adef1418acb0144c9f0 rejected
```

## 2026-06-30 Runtime-Adapter Stage-Events App-Hook Derivation

Real ROCm runtime-adapter stage events can now derive the required app-hook contract generically when all five support-only stages are complete: `artifact_transport`, `epoch_publication`, `dispatch_trace`, `host_identity`, and `output_oracle`. The runner uses the derived contract only when no explicit app-hook contract was declared, and the validation matrix recomputes the same derivation from typed stage-event evidence, facet hashes, boundary-line hashes, and stage evidence refs.

This is not a success shortcut. The derived contract can remove only the stale missing-contract configuration gap. Full-runtime acceptance still requires the normal strict runtime proof artifact, recomputed ledger success, runtime-chain closure, output-oracle closure, same-process proof, sidecar/firewall gates, and accepted row safety. Smoke coverage includes a strict positive fixture where stage events derive the app-hook contract, plus a serialized derived-contract forgery with the stage events removed; the forged row remains `unproven`.

Runner final-support gating now also accepts the imported adapter-result manifest path without a direct `runtime_adapter_execution` facet only when the bridge is strict-proof accepted or boundary-import accepted, stage events are complete, target-process provenance is accepted, and declared result transport is accepted. A present but failed execution facet still blocks. This keeps external/profile-driven adapter result manifests usable for arbitrary projects without converting copied manifests or boundary logs into runtime authority.

Validation-matrix runtime-chain overlay now mirrors that rule: support-only boundary-result facets with `acceptedAsBoundaryEvidence=true` can feed the runtime-chain overlay even when `accepted=false`, provided they do not claim GPU HMR/runtime/dispatch authority. Smoke coverage removes all adapter-execution facets from a boundary-only bridge fixture and verifies the overlay source is `runtime_profile_adapter_result`, not execution masking.

Verification for this patch:

```text
node --check mcp/synthi-mcp/scripts/gpu-hmr-real-rocm-repo-validation.mjs -> passed
node --check mcp/synthi-mcp/scripts/lib/gpu-hmr-validation-matrix-ledger.mjs -> passed
node --check mcp/synthi-mcp/scripts/tests/gpu-hmr-validation-matrix-ledger-smoke.mjs -> passed
node mcp/synthi-mcp/scripts/gpu-hmr-real-rocm-repo-validation.mjs --self-check -> passed, including bridge-only adapter-result final-support coverage
node mcp/synthi-mcp/scripts/tests/gpu-hmr-validation-matrix-ledger-smoke.mjs -> passed, gpu-validation-matrix-ledger:sha256:24f9bdfa6508199beb31d9fc684f93655c62ad938cc7bf5079d044c899b3709b, rows=65
npm --prefix mcp/synthi-mcp run proof:validation-matrix:self-check -> passed after rerun with a longer command timeout; smoke proof gpu-validation-matrix-ledger:sha256:93a1875207bc37bbe7722fef3414a910ed63ff21a9044df8d5e1ac79ca88f1cd, retained matrix gpu-validation-matrix-ledger:sha256:9021cc8be6f4e5f65643be933368394843db710d6e010bc30834ad34b4383787
npm --prefix mcp/synthi-mcp run proof:validation-matrix -> passed, gpu-validation-matrix-ledger:sha256:9021cc8be6f4e5f65643be933368394843db710d6e010bc30834ad34b4383787, json=mcp/synthi-mcp/.gpu-hmr-test-logs/validation-matrix/gpu-hmr-validation-matrix-20260630T061201Z.json
```

## 2026-06-30 Native Runtime Trace Facet

The real ROCm runner now derives a support-only `synthi.real_rocm.native_runtime_trace.v1` facet from observed native launch, artifact transport, and output-oracle runtime evidence. Native launch observations can now be represented as canonical dispatch-boundary events in `runtime_trace`, and validation-matrix ingestion passes that row-level facet through the existing native runtime trace gate.

This does not authorize GPU HMR. The facet is emitted with `acceptedForGpuHmr=false`, `gpuHmrSuccess=false`, and `canSatisfyRuntimeProof=false`. A native dispatch-boundary diagnostic still refuses when loader/artifact transport or output boundaries are missing, and full-runtime authority still requires accepted strict runtime proof, recomputed ledger success, runtime-chain closure, same-process identity, output oracle, CPU/full-rebuild/restart firewall proof, and app-hook/stage closure where required.

Verification for this patch:

```text
node --check mcp/synthi-mcp/scripts/gpu-hmr-real-rocm-repo-validation.mjs -> passed
node --check mcp/synthi-mcp/scripts/lib/gpu-hmr-validation-matrix-ledger.mjs -> passed
node mcp/synthi-mcp/scripts/gpu-hmr-real-rocm-repo-validation.mjs --self-check -> passed; native launch observation now derives a dispatch-boundary runtime trace while loader/output boundaries remain explicit refusal gaps
npm --prefix mcp/synthi-mcp run proof:real-rocm:self-check -> passed; POSIX template execution self-checks skipped fail-closed on this host
npm --prefix mcp/synthi-mcp run proof:validation-matrix:self-check -> passed; smoke ledger `gpu-validation-matrix-ledger:sha256:91a95ee4630bf3f63ea82c294dc4abd907abaca0b9759531f78d3c6d7505110d`, retained matrix `gpu-validation-matrix-ledger:sha256:ff79cf4569ec473daea685e3884c2a6c9f5bce7d37dd6c36e7c3a3db5349d897`, 56 rows, 14 scoped full-runtime rows, 0 broad rows
```

## 2026-06-30 Native Observer Host-Identity Breadcrumbs

The real ROCm native launch observer now emits generic support-only `host_identity` boundary breadcrumbs around observer-ready, native launch attempt, and native launch observed events. The emitted fields include explicit `process_id=pid:<pid>` plus runner-process and stream-context identities, so arbitrary target runs no longer depend on runtime-session string shape for basic process/stream diagnostics.

Runtime host-identity parsing now consumes explicit `process_id`, `device_uuid`, `context_id`, and `queue_id` fields. Same-process and native-runtime bridge gates were tightened so a PID or host-identity line alone cannot satisfy the host-identity stage. Host proof still requires the host-preservation proof or explicit stable identity evidence, and the new self-check keeps native observer breadcrumbs non-authoritative without device identity, preserved identity lineage, artifact transport, epoch publication, dispatch, output oracle, firewall proof, strict runtime proof, and ledger closure.

This is not broad real-ROCm GPU HMR acceptance. The latest matrix self-check still reports 56 rows, 14 scoped full-runtime rows, and 0 broad library-agnostic full-runtime rows.

Verification for this patch:

```text
node --check mcp/synthi-mcp/scripts/gpu-hmr-real-rocm-repo-validation.mjs -> passed
node --check mcp/synthi-mcp/scripts/lib/gpu-hmr-runtime-evidence.mjs -> passed
docker run --rm --entrypoint cc -v "${PWD}\backend\synthi-webrtc-compiler\worker:/workspace" -w /workspace vectant-ade-worker:latest -fsyntax-only cpp_src/synthi_gpu_native_launch_observer.c -> passed
node mcp/synthi-mcp/scripts/gpu-hmr-real-rocm-repo-validation.mjs --self-check -> passed; includes native host-identity breadcrumb coverage and strict non-authority checks
npm --prefix mcp/synthi-mcp run proof:real-rocm:self-check -> passed; POSIX template execution self-checks skipped fail-closed on this host
npm --prefix mcp/synthi-mcp run proof:validation-matrix:self-check -> passed after rerun with a longer command timeout; smoke ledger `gpu-validation-matrix-ledger:sha256:a4329aa6730ef4bf5f70608f1d217f5a447ecd221f15e36db9581ef937322c66`, retained matrix `gpu-validation-matrix-ledger:sha256:7eda4b3f463acd44889c5db88722487fd48b271a2ecf477ce34720cd6743d2bc`, 56 rows, 14 scoped full-runtime rows, 0 broad rows
```

## 2026-06-30 Runtime-Boundary Target-Process Provenance

Real ROCm runtime-boundary support now binds adapter/native-observer boundary lines to target-process provenance before those lines can support final real-ROCm acceptance. The native launch observer emits a generic runtime session from `SYNTHI_REAL_ROCM_RUNTIME_SESSION` or `SYNTHI_GPU_HMR_RUNTIME_SESSION`, falling back to a process-derived observer session only when no explicit session is provided, and includes `process_id=pid:<pid>` on emitted `[gpu-runtime-boundary]` lines.

The runner derives `synthi.real_rocm.runtime_boundary_target_process_provenance.v1` from adapter boundary lines, target-environment exposure, adapter-result bridge evidence, adapter execution evidence, and adapter-result transport evidence. The facet is accepted only as support evidence when it binds exactly one runtime session, exactly one explicit process identity, accepted target-environment exposure, a matching target-environment session, complete required boundary-event coverage, and no GPU HMR/runtime/dispatch authority claims.

The validation matrix recomputes this support facet from raw adapter-result or adapter-execution boundary lines rather than trusting serialized provenance fields. Serialized-only target-process provenance, missing source boundary lines, missing explicit process IDs, missing target-environment session, and declared-but-not-copied adapter result transport remain refusal/support gaps even when the report carries accepted-looking hashes or line records.

This is not a success path. The facet stays `acceptedForGpuHmr=false`, `gpuHmrSuccess=false`, and `canSatisfyRuntimeProof=false`. A full-runtime proof that otherwise looks successful is degraded when adapter boundary events are present but target-process provenance is missing or failed. Strict acceptance still requires real artifact transport into the target process, epoch publication, dispatch trace, host identity, output oracle, firewall proof, accepted strict runtime proof artifact, and recomputed ledger closure.

Verification for this patch:

```text
node --check mcp/synthi-mcp/scripts/gpu-hmr-real-rocm-repo-validation.mjs -> passed
node --check mcp/synthi-mcp/scripts/lib/gpu-hmr-validation-proof-artifact.mjs -> passed
node --check mcp/synthi-mcp/scripts/lib/gpu-hmr-validation-matrix-ledger.mjs -> passed
node --check mcp/synthi-mcp/scripts/tests/gpu-hmr-validation-matrix-ledger-smoke.mjs -> passed
docker exec vectant-ade-worker-1 sh -lc "cc -fsyntax-only /tmp/synthi_gpu_native_launch_observer.c" -> passed after copying the edited native observer source into the worker container
node mcp/synthi-mcp/scripts/gpu-hmr-real-rocm-repo-validation.mjs --self-check -> passed; includes target-process provenance positive coverage, session-mismatch refusal, missing-process-identity refusal, and strict proof downgrade when provenance is absent or failed
node mcp/synthi-mcp/scripts/tests/gpu-hmr-validation-matrix-ledger-smoke.mjs -> passed; 65-row smoke ledger includes support-only target-process provenance, forged target-process authority refusal, and serialized-only target-process provenance refusal
npm --prefix mcp/synthi-mcp run proof:validation-matrix:self-check -> passed after rerun with a longer command timeout; smoke ledger `gpu-validation-matrix-ledger:sha256:13a6cdc8656e44781a78f99837a981271f95e94983b238ddba3837b2686faa65`, retained matrix `gpu-validation-matrix-ledger:sha256:4d8d07c74c792d6ad7000e3d9ac3524714bb832acf357738bb83d9f9efb52590`, retained matrix remains 56 rows, 14 scoped full-runtime rows, 0 broad rows
npm --prefix mcp/synthi-mcp run proof:status-docs:self-check -> passed; retained matrix remains `gpu-validation-matrix-ledger:sha256:9021cc8be6f4e5f65643be933368394843db710d6e010bc30834ad34b4383787`, 56 rows, 14 scoped full-runtime rows, 0 broad rows
```

## 2026-06-30 Runtime-Boundary Target Environment

Real ROCm upstream target runs now receive generic runtime-boundary environment variables only when a runtime adapter is explicitly declared and enabled. The runner records `synthi.real_rocm.runtime_boundary_target_environment.v1` with `proofAuthority=target_environment_exposure_only_not_gpu_hmr_success`, validates repo-relative result/event-manifest paths, creates worker-side parent directories, and exports aliases such as `SYNTHI_REAL_ROCM_RUNTIME_BOUNDARY_EVENT_MANIFEST_PATH`, `SYNTHI_GPU_HMR_RUNTIME_BOUNDARY_EVENT_MANIFEST_PATH`, `SYNTHI_REAL_ROCM_RUNTIME_ADAPTER_EVENT_MANIFEST_PATH`, and `SYNTHI_REAL_ROCM_RUNTIME_ADAPTER_RESULT_PATH` into the actual upstream run environment.

This is project-neutral plumbing for arbitrary upstream processes to write structured runtime-boundary event manifests. It is not proof authority: the facet stays `acceptedForGpuHmr=false`, `gpuHmrSuccess=false`, and `canSatisfyRuntimeProof=false`; undeclared adapters export nothing; disabled upstream runs remain a support gap; and strict acceptance still requires observed artifact transport, epoch publication, dispatch trace, host identity, output oracle, firewall, runtime-chain closure, and an accepted strict proof ledger.

The validation matrix and runtime proof artifact builder now consume this facet explicitly instead of treating it as inert report metadata. Matrix ingestion normalizes the facet from reports, summaries, runtime proof artifacts, and evidence blocks; accepted real-ROCm rows fail safety if the facet has the wrong schema/authority, claims GPU HMR/runtime/dispatch authority, exports adapter env without a declared/enabled adapter, omits required event/result aliases, or carries blocking gaps. Runtime proof artifacts snapshot the same support-only facet and emit a strict limitation for forged authority even when the embedded proof ledger invariants are otherwise successful.

Verification for this patch:

```text
node --check mcp/synthi-mcp/scripts/gpu-hmr-real-rocm-repo-validation.mjs -> passed
node --check mcp/synthi-mcp/scripts/lib/real-rocm-upstream-lifecycle.mjs -> passed
node --check mcp/synthi-mcp/scripts/lib/gpu-hmr-validation-proof-artifact.mjs -> passed
node --check mcp/synthi-mcp/scripts/lib/gpu-hmr-validation-matrix-ledger.mjs -> passed
node --check mcp/synthi-mcp/scripts/tests/gpu-hmr-validation-matrix-ledger-smoke.mjs -> passed
node mcp/synthi-mcp/scripts/gpu-hmr-real-rocm-repo-validation.mjs --self-check -> passed; includes exported target-environment support, undeclared-adapter no-export refusal, disabled-upstream support gap, and existing adapter bridge/manifest checks
node mcp/synthi-mcp/scripts/tests/gpu-hmr-validation-matrix-ledger-smoke.mjs -> passed; 65-row smoke ledger, includes support-only target-environment fixture, forged target-environment authority refusal, and runtime-proof-artifact limitation when a forged facet claims runtime/dispatch authority
npm --prefix mcp/synthi-mcp run proof:real-rocm:self-check -> passed
npm --prefix mcp/synthi-mcp run proof:validation-matrix:self-check -> passed after rerun with a longer command timeout; smoke ledger rows=65, retained matrix remains 56 rows, 14 scoped full-runtime rows, 0 broad rows
npm --prefix mcp/synthi-mcp run proof:status-docs:self-check -> passed; live matrix remains 56 rows, 14 scoped full-runtime rows, 0 broad rows
```

## 2026-06-30 Runtime-Adapter Result Bridge Hardening

Real ROCm runtime evidence now consumes adapter-result boundary lines only from a usable imported bridge: declared and present result, exact evidence-only authority, accepted strict proof summary, zero bridge blocking gaps, active runtime-profile id match, no GPU HMR/runtime/dispatch authority claims, and copied result transport when transport is declared.

The runner no longer lets a refused adapter result refresh `runtime_adapter_execution` or feed `workerEvidence`. A bridge with complete boundary lines but `gpuHmrSuccess` / `canSatisfyRuntimeProof` claims remains refusal evidence; a copied=false transport remains unusable; and a mismatched `profileId` cannot be imported as the active runtime profile. Runtime proof artifacts now preserve refused adapter-result bridges as strict limitations even when the embedded strict proof id is otherwise accepted.

The real ROCm final verdict has an additional generic adapter-final-support gate for configured adapter/result paths. This does not make adapter support proof authority; it prevents a retained report from claiming `gpu_hmr_success=true` before matrix recomputation when the adapter bridge, execution facet, result transport, or stage-events support facet is rejected.

Verification for this patch:

```text
node --check mcp/synthi-mcp/scripts/gpu-hmr-real-rocm-repo-validation.mjs -> passed
node --check mcp/synthi-mcp/scripts/lib/gpu-hmr-validation-proof-artifact.mjs -> passed
node mcp/synthi-mcp/node_modules/vitest/vitest.mjs run mcp/synthi-mcp/tests/unit/gpu_hmr_runtime_proof.test.ts -> passed, 283 tests
node mcp/synthi-mcp/scripts/gpu-hmr-real-rocm-repo-validation.mjs --self-check -> passed; includes profile-id mismatch refusal, forged adapter-result authority refusal, copied=false transport refusal, result-bridge execution refresh, and final-support gate checks
npm --prefix mcp/synthi-mcp run proof:real-rocm:self-check -> passed
npm --prefix mcp/synthi-mcp run proof:strict-gates:self-check -> passed
npm --prefix mcp/synthi-mcp run proof:validation-matrix:self-check -> passed; smoke ledger rows=65, retained matrix summary remains 56 rows, 14 scoped full-runtime rows, 0 broad rows
```

## 2026-06-30 Runtime-Adapter Event Manifest Template

Real ROCm runtime adapters now support a generic structured event-manifest path. A profile or env-declared `runtimeAdapter` can provide repo-relative `eventManifestPath` / `event_manifest_path`, which the runner validates with the same no-traversal relative path rules as adapter result paths and exports into the worker as `SYNTHI_REAL_ROCM_RUNTIME_ADAPTER_EVENT_MANIFEST_PATH` plus the `SYNTHI_GPU_HMR_RUNTIME_ADAPTER_EVENT_MANIFEST_PATH` alias.

A new packaged `runtime_boundary_event_manifest_v1` adapter template publishes that manifest to the configured adapter result path without requiring inline project-specific shell commands. This lets arbitrary projects provide a structured `synthi.gpu_hmr.runtime_profile_adapter_result.v1` manifest containing typed runtime-boundary events and app-hook evidence. The copied manifest is not proof authority: bridge import, structured event materialization, stage-events, runtime-chain closure, output oracle, firewall, strict runtime proof artifact, and proof-ledger gates still recompute the evidence and reject any success-authority claims.

The existing large ROCm ML profiles remain on the generic `runtime_boundary_log_harvest_v1` template and still report strict refusals until real target-process artifact transport, epoch publication, dispatch trace, host identity, output oracle, firewall, and accepted strict runtime proof are observed.

Verification for this patch:

```text
node --check mcp/synthi-mcp/scripts/gpu-hmr-real-rocm-repo-validation.mjs -> passed
node mcp/synthi-mcp/scripts/gpu-hmr-real-rocm-repo-validation.mjs --self-check -> passed; POSIX shell execution of adapter templates skipped on this host, but template normalization, structured bridge import, unsafe event-manifest path rejection, and support-only authority checks passed
npm --prefix mcp/synthi-mcp run proof:real-rocm:package-scripts:self-check -> passed
npm --prefix mcp/synthi-mcp run proof:real-rocm:self-check -> passed
npm --prefix mcp/synthi-mcp run proof:status-docs:self-check -> passed before this documentation update; retained matrix still reports 56 rows, 14 scoped full-runtime rows, and 0 broad library-agnostic full-runtime rows
```

## 2026-06-30 Structured Runtime-Adapter Event Materialization

Runtime-profile adapter result manifests can now emit typed `synthi.gpu_hmr.runtime_boundary_event.v1` objects through `runtimeBoundaryEvents`, `runtime_boundary_events`, `adapterRuntimeBoundaryEvents`, or `adapter_runtime_boundary_events`. The real ROCm runner materializes recognized event kinds into canonical `[gpu-runtime-boundary]` lines and then sends those lines through the existing artifact-transport, epoch-publication, dispatch, host-identity, output-oracle, stage-events, adapter-result bridge, and validation-matrix parsers.

This is a structured JSON input path for arbitrary project adapters, not a new proof authority. Materialized events use only scalar no-whitespace key/value fields, unrecognized schemas or event kinds are ignored, and all GPU HMR success fields remain controlled by the strict runtime proof artifact, proof ledger, runtime-chain, output oracle, host identity, firewall, and matrix acceptance gates.

The runner self-check now writes an adapter result manifest with no prebuilt boundary lines and a full set of structured event objects, then verifies the bridge imports the materialized lines, sees all five app-hook event families, and records the expected boundary hashes. The validation matrix self-check still reports 56 rows, 14 accepted scoped full-runtime rows, and 0 broad library-agnostic full-runtime rows.

Verification for this patch:

```text
node --check mcp/synthi-mcp/scripts/gpu-hmr-real-rocm-repo-validation.mjs -> passed
node mcp/synthi-mcp/scripts/gpu-hmr-real-rocm-repo-validation.mjs --self-check -> passed with structured runtime-boundary event materialization imported through the adapter result bridge
npm --prefix mcp/synthi-mcp run proof:validation-matrix:self-check -> passed after rerun with a longer command timeout; smoke ledger rows=65 and current matrix summary remained 56 rows, 14 scoped full-runtime rows, 0 broad rows
```

## 2026-06-30 Runtime-Adapter Stage Events And Overlay Closure

The real ROCm runtime-adapter path now emits a generic support-only `synthi.real_rocm.runtime_adapter_stage_events.v1` facet from adapter `[gpu-runtime-boundary]` output. The runner normalizes boundary lines into the five app-hook stages `artifact_transport`, `epoch_publication`, `dispatch_trace`, `host_identity`, and `output_oracle`, records per-stage boundary hashes, evidence refs, field checks, missing proof kinds, and a content-addressed facet hash, and preserves the facet in retained reports and runtime evidence.

The facet cannot authorize GPU HMR. It is always `acceptedForGpuHmr=false`, `gpuHmrSuccess=false`, `canSatisfyRuntimeProof=false`, and `canSatisfyDispatchProof=false`. Validation-matrix ingestion recomputes stage proof-kind requirements from the field checks and rejects forged stage-event facets that claim GPU HMR, runtime, or dispatch authority.

Adapter boundary overlays are also constrained so they cannot close a runtime chain by declaration. When adapter boundary lines are present, the base ledger/runtime record must independently carry the core closure fields for artifact transport kind/hash, same-process runtime session, process identity, epoch, dispatch ID, dispatch-table entry, output target, post-dispatch output identity, timestamp order, and CPU/full-rebuild/restart firewall state. Overlay evidence can support consistency with an already closed chain; it cannot replace loader, epoch, dispatch, host-identity, output-oracle, firewall, or strict runtime-proof closure.

New smoke coverage includes a complete stage-events fixture, a forged authority fixture that remains `unproven`, and an overlay-only runtime-chain fixture where the strict ledger is internally successful but the matrix refuses because required base closure fields are missing. This is generic large-project adapter hardening, not project-specific acceptance and not broad library-agnostic GPU HMR.

Verification for this patch:

```text
node --check mcp/synthi-mcp/scripts/gpu-hmr-real-rocm-repo-validation.mjs -> passed
node --check mcp/synthi-mcp/scripts/lib/gpu-hmr-validation-matrix-ledger.mjs -> passed
node --check mcp/synthi-mcp/scripts/tests/gpu-hmr-validation-matrix-ledger-smoke.mjs -> passed
node mcp/synthi-mcp/scripts/gpu-hmr-real-rocm-repo-validation.mjs --self-check -> passed with complete stage-events support evidence and weak/missing-stage negatives refused
node mcp/synthi-mcp/scripts/tests/gpu-hmr-validation-matrix-ledger-smoke.mjs -> passed with forged stage-event authority and adapter-overlay-only closure refused
npm --prefix mcp/synthi-mcp run proof:validation-matrix:self-check -> passed; current retained matrix still reports 56 rows, 14 accepted scoped full-runtime rows, and 0 broad library-agnostic full-runtime rows
```

## 2026-06-30 Runtime-Adapter Visual Oracle Bridge

The real ROCm runtime-adapter bridge now accepts generic visual output-oracle artifacts from adapter-emitted `[gpu-runtime-boundary] output_oracle` lines. An adapter can declare before/after/diff PNG paths or role-bound CAS manifests, SHA-256 hashes, camera-state hash, swapchain size, capture backend, frame number, output target, dispatch ID, artifact ID, and deterministic probe metadata.

The runner resolves visual artifacts only under approved artifact/CAS roots, validates readable bytes and declared hashes, decodes the images through the same visual evidence thresholds used by the rest of the proof system, rejects blank/same-frame/low-quality diffs, and feeds accepted `visual_oracle_artifacts` plus visual evidence refs into the normal output-proof classifier. A positive visual artifact is still not runtime authority: dispatch, epoch publication, deterministic probe-contract closure, post-dispatch output oracle, host identity, firewall, strict runtime proof, and ledger closure remain required before any GPU HMR row can be accepted.

New self-check coverage includes a CAS-backed positive adapter visual oracle that closes only with matching dispatch/epoch/probe/output proof, a forged after-image hash refusal, and a path escape refusal. Validation-matrix smoke coverage now also proves the row-level path: a real-ROCm visual-oracle row can accept only with strict ledger closure and three validated visual CAS locators, while a forged role-bound after-image hash remains `unproven` with the normal output-or-visual-proof gap. This is generic arbitrary-project adapter plumbing; it is not keyed to MIOpen, HIPRT, raytrace, or any profile name, and it does not change broad readiness.

Strict proof-ledger recomputation now also consumes a resolved visual artifact overlay when the ledger carries role-bound visual CAS locators. The overlay is derived only from matrix-validated CAS locators for the before/after/diff PNG bytes and is used only for strict artifact-readability/hash checks; it does not mutate the canonical ledger record or proof ID. A forged visual CAS hash now fails at the ledger facet with `proof_ledger_success_required` before the row can be classified as an accepted visual oracle.

Verification for this patch:

```text
node --check mcp/synthi-mcp/scripts/lib/gpu-hmr-runtime-evidence.mjs -> passed
node --check mcp/synthi-mcp/scripts/gpu-hmr-real-rocm-repo-validation.mjs -> passed
node mcp/synthi-mcp/scripts/gpu-hmr-real-rocm-repo-validation.mjs --self-check -> passed with runtime adapter visual output oracle artifacts accepted in the positive self-check and forged/path-escape negatives refused
node mcp/synthi-mcp/scripts/tests/gpu-hmr-validation-matrix-ledger-smoke.mjs -> passed, 65-row smoke ledger with real-ROCm visual CAS positive and forged visual-hash refusal at strict-ledger recomputation
node mcp/synthi-mcp/node_modules/vitest/vitest.mjs run mcp/synthi-mcp/tests/unit/gpu_hmr_runtime_proof.test.ts -> passed, 282 tests
npm --prefix mcp/synthi-mcp run proof:validation-matrix:self-check -> passed, current matrix still reports 56 rows, 14 accepted scoped full-runtime rows, and 0 broad library-agnostic full-runtime rows
```

## 2026-06-30 Runtime-Adapter Host Identity Boundary Gate

Adapter boundary coverage now recomputes host-identity proof shape instead of accepting a loose event-family line. When `[gpu-runtime-boundary] host_identity ...` is present, the matrix runs the shared `runtimeHostIdentityEvidence` classifier and requires generic numeric before/after identity lineage plus preserved runner-process, host-state, and runtime-resource roles with stable non-null pointers. Runtime generation tokens remain bound to the strict ledger; the host-identity snapshot lineage is carried separately through generic fields such as `host_identity_previous_generation` and `host_identity_active_generation`.

New smoke coverage keeps all five adapter boundary event families present but replaces the host identity snapshot with a single role-less event. That row remains `unproven`, with both adapter-result and direct adapter-execution facets failing `real_rocm_runtime_adapter_boundary_host_identity_fields_incomplete`. The complete bridge fixture still accepts only when the normal strict ledger, same-process oracle, runtime chain, app-hook, sidecar, output oracle, firewall, and runtime-proof gates close. This is generic large-ROCm adapter hardening, not project-specific acceptance.

Verification for this patch:

```text
node --check mcp/synthi-mcp/scripts/lib/gpu-hmr-validation-matrix-ledger.mjs -> passed
node --check mcp/synthi-mcp/scripts/tests/gpu-hmr-validation-matrix-ledger-smoke.mjs -> passed
node mcp/synthi-mcp/scripts/tests/gpu-hmr-validation-matrix-ledger-smoke.mjs -> passed, gpu-validation-matrix-ledger:sha256:39a94118e82494841200e7ab967403f9a56a64ac6b38673eb29a9c4ac75ccce1, rows=65
```

## 2026-06-30 Source-First Role Hardening

The source-first generated split validator now fails closed unless the generated sidecar declares explicit module files and explicit GPU device roles. It no longer invents default generated split paths such as `shared.h`, `core.cpp`, `gui.cpp`, `host_runner.cpp`, or vendor-default `device.hip` / `device.cu`. Device role paths must be present in `compile_manifest.module_files`, generated files are read from the declared manifest path set, and host-source exclusions for deterministic fission are derived from declared non-device module files instead of fixed role names.

The shared generated-split granularity library also stopped inferring a device translation unit from the backend vendor alone. It can still use an explicit `module_files.device` declaration as legacy manifest evidence, but a manifest with no device role and no explicit device module now reports `generated_split.device_roles_missing` instead of silently analyzing a default `device.hip`.

New self-check coverage rejects the old forged default-file shortcut and undeclared device-role paths. This hardens the source-first/no-precompiled path only. It does not change the accepted matrix scope: broad library-agnostic full-runtime GPU HMR remains unproven, and the current source-first realistic raytrace rows remain scoped generated/profiled ROCm/HIP visual proof.

Latest retained validation matrix artifact for this checkpoint is `gpu-validation-matrix-ledger:sha256:9021cc8be6f4e5f65643be933368394843db710d6e010bc30834ad34b4383787`, JSON `mcp/synthi-mcp/.gpu-hmr-test-logs/validation-matrix/gpu-hmr-validation-matrix-20260630T061201Z.json`, 56 rows, 14 accepted full-runtime GPU HMR rows, 0 broad library-agnostic full-runtime GPU HMR rows, 14 scoped full-runtime rows, 29 refusals, 7 cold splits, 2 deterministic fission rows, 3 visual-profile rows, 1 preflight-only row, and broad readiness still `accepted=false`.

## 2026-06-30 Matrix-Level Broad-Proof Scaffold

Validation-matrix coverage now carries a recomputed `synthi.gpu_hmr.broad_library_agnostic_matrix_proof.v1` object instead of treating row-level broad claims as proof. The proof accepts broad rows only when strict accepted full-runtime rows cover the required backend-family count, acceptance-scope count, visual and compute oracle modes, and adversarial refusal floor; forged broad row declarations remain rejected. The current retained matrix still reports 0 broad library-agnostic full-runtime rows because the accepted strict runtime rows are scoped HIP/WebGPU evidence only.

Verification for this patch:

```text
node --check mcp/synthi-mcp/scripts/gpu-hmr-agent-split-workspace-test.mjs -> passed
node --check mcp/synthi-mcp/scripts/lib/gpu-hmr-generated-split-granularity.mjs -> passed
node mcp/synthi-mcp/scripts/tests/gpu-hmr-generated-split-granularity-smoke.mjs -> passed
npm --prefix mcp/synthi-mcp run proof:agent-split:source-first:self-check -> passed
npm --prefix mcp/synthi-mcp run proof:generated-split-granularity:self-check -> passed
npm --prefix mcp/synthi-mcp run proof:validation-matrix:self-check -> passed with current broadFullRuntimeGpuHmrRows=0
```

## 2026-06-29 Continuation Checkpoint

Source-first/no-precompiled realistic raytrace was rerun after the deterministic splitter was fixed generically to preserve constants from source-owned quoted include closures. The splitter now analyzes all submitted `source.files`, walks local includes such as `src/scene_config.h`, emits discovered scalar constant blocks into generated `shared.h`, and records `constantSourcePaths` in the split report. This is not keyed to `PIXEL_COUNT`, raytrace, or any project name.

The latest retained source-first realistic matrix selection is `source-first-realistic-raytrace-20260629-clockfix`, created from `src/main.cpp` plus `src/scene_config.h` with worker-detected ROCm arch `gfx1201`. It produced source-first ingestion proof `agent-split-source-first-ingestion:sha256:a898e9bca1c7fee46d7e375c631a51d25b346f7676e2af5eb2fdce25247eb687`, accepted cold split row `historical-gpu-validation-matrix-row-sha256-87f740bc751d0fc8be062127e0a22cd02d733ddea36c02c86b2e105c1bde9615`, accepted hot-delta rows `historical-gpu-validation-matrix-row-sha256-df44f7e0790a508aac703b3746cb2f80be2ff907a753d16a2bf7d7083adcbdff` and `historical-gpu-validation-matrix-row-sha256-be05fd92aaee4bc25fcdb00a3e061fd5e86c8f185078529c93493545f5f7d595`, and negative refusal row `historical-gpu-validation-matrix-row-sha256-84347a9a017de043fc6a0abec4fffd786a0e7aa84aeca62525b2210c769ac26e`. Hot delta 1 runtime proof is `gpu-runtime-proof:sha256:43a005919819b67ccb6ef994338fff641acbd422c159eb34c2a116dab2a0c1d9` with matrix ledger `gpu-ledger-proof:sha256:93284ff0e2db5c5b14e103f2a19841a13805f6db7be7ba45efff0fa8cc343e68`; hot delta 2 runtime proof is `gpu-runtime-proof:sha256:357e9f62e03699eb198c9ccb3bbe315f026634f5218ec93d87bd9dfd820593d9` with matrix ledger `gpu-ledger-proof:sha256:1de246b3324e16f14862c21d2351ec7c0fa40bc457b9b4895cf370599cdd24a5`. Persisted visual artifacts remain nonblank visual proof for this scoped generated/profiled ROCm/HIP path, and deterministic fission is accepted for `render_realistic_raytrace` under row `historical-gpu-validation-matrix-row-sha256-ab0cb77eb89e7aa8061f3a10a7a3401f4288b0615d39b276cb9ba40ef45c767e`.

Fresh large ROCm ML runs were executed through the same profile-driven harness, not through project-specific success branches. MIOpen `gpu-real-rocm-MIOpen-20260629-checkpoint2` recovered metadata, used shared source-tree CAS transport, executed hot-delta-1/hot-delta-2/negative-edit source-delta compile projections, materialized the external `half/half.hpp` prerequisite from exact upstream source evidence, wrote a fail-closed retained checkpoint before runtime evidence collection, then wrote the final retained artifact after runtime evidence collection. It still has no accepted post-dispatch MIOpen output oracle, Synthi artifact transport into the target process, epoch publication, dispatch trace, host identity, app-hook runtime observation, firewall closure, or accepted strict runtime proof. The final row is `historical-gpu-validation-matrix-row-sha256-16305e7aef533eb74ffd73e8fdda199da25aef72e27be2fbb6710b632d32b235` with proof IDs `gpu-ledger-proof:sha256:d4276ec0e4eee3a406c823bb9e170890d0ebc1490fafa1cc5477f3e29eb4a770`, `gpu-runtime-proof:sha256:4539a61af192d16ed56006d79ce1306121df369cf29adc7d6f8b8ec07c4457fd`, and `real-rocm-validation:sha256:265e1f9e6a9e96b2efa1bf92986a254457c78e41a807c3945579b9b6b6c58503`; it is `refusal_proven`, `acceptedForGpuHmr=false`, and `gpuHmrSuccess=false`. Composable Kernel `gpu-real-rocm-composable-kernel-20260629080933` and hipBLASLt `gpu-real-rocm-hipBLASLt-20260629081428` also remain strict refusals. A non-happy-path issue was found during this MIOpen run: the host-side timeout could leave the worker-side upstream build running. The runner now wraps real ROCm upstream lifecycle commands in a worker-side timeout with a generic lifecycle run marker and marker-based cleanup. This is orchestration hardening only; cleanup evidence is `acceptedForGpuHmr=false` and cannot satisfy runtime proof.

Latest generated validation matrix after this rerun is `gpu-validation-matrix-ledger:sha256:8d60a57c77aa390610f97884dc5499f7bb2c49dfb4f888d6de40b9a18fcb361b`, JSON `mcp/synthi-mcp/.gpu-hmr-test-logs/validation-matrix/gpu-hmr-validation-matrix-20260629T213811Z.json`, 56 rows, 14 accepted full-runtime GPU HMR, 0 broad library-agnostic full-runtime GPU HMR, 14 scoped full-runtime GPU HMR, 14 all full-runtime, 29 refusals, 7 cold splits, 2 deterministic fission, 3 visual profiles, 1 preflight-only row, and 0 included unproven rows. Scope breakdown: generated_rocm_hip_preview_visual: 2, hip_module_declared_compute_readback: 2, webgpu_declared_compute_readback: 2, webgpu_declared_pipeline_visual: 8. Broad readiness remains `accepted=false` with `broadFullRuntimeGpuHmrRows=0`. `per_target_run_modes status=accepted`. The latest history audit is `gpu-validation-matrix-ledger:sha256:aa905942109909b5181c6236cb348a68710ebc667ac8f8dde7d572385c7e349c`, JSON `mcp/synthi-mcp/.gpu-hmr-test-logs/validation-matrix-unproven-audit/gpu-hmr-validation-matrix-20260629T113226Z.json`, 678 rows with 622 historical unproven rows.

The validation framework now also offloads single-frame visual recomputation to the async visual proof worker by default. Cold/single-frame visual evidence and diff-frame visibility checks record `recomputeEngine=matrix_async_visual_worker_rgba` and require accepted worker metrics; the old local `sharp` raw loop remains only an explicit fallback when async metrics are disabled. This closes the remaining matrix-side pixel loop for cold visual proof without weakening ledger acceptance.

Visual proof scheduling now has a generic proof-pending job manifest. `createAsyncVisualProofJob` stages before/after frames into CAS and emits content-addressed `synthi.gpu_hmr.async_visual_proof_job.v1` evidence with `eventType=proof_pending`, `acceptedForGpuHmr=false`, and `gpuHmrSuccess=false`; `completeAsyncVisualProofJob` consumes the same manifest to produce the existing `proof_ready` async worker metrics. The agent-split visual runner now records the pending job before awaiting strict completion. This improves dev-loop scheduling without changing acceptance authority.

HIPRT visual-profile rows now expose an explicit backend contract facet. Matrix ingestion derives `synthi.gpu_hmr.hiprt_contract_evidence.v1` from the HIPRT row or strict runtime artifact acceptance contract and requires field-level evidence for `kernel_entry`, `scene_or_bvh_handles`, `framebuffer_handle`, `material_or_geometry_buffers`, `camera_state_hash`, `same_process_reload_hook`, and `visual_oracle` before a HIPRT warm visual or run-mode row can stay `visual_profile_accepted`. The facet is evidence-only (`acceptedForGpuHmr=false`, `gpuHmrSuccess=false`), so the current CameraRays and MegaKernel direct-light-gain evidence remains source-adapted visual-profile evidence, not no-shim full-runtime GPU HMR. A missing HIPRT contract now keeps otherwise pixel-valid rows unproven with `hiprt_contract_required` instead of relying on implicit visual/runtime context.

Generic adapter-boundary bridge smoke coverage was added for the large-ROCm runtime closure path. The matrix now preserves accepted adapter boundary lines from `synthi.real_rocm.runtime_profile_adapter_result_bridge.v1` and can use them as a conservative runtime-chain overlay: missing observed boundary fields may be filled, but ledger/adapter conflicts remain hard failures. The complete fixture emits all five app-hook stage signals (`artifact_transport`, `epoch_publication`, `dispatch_trace`, `host_identity`, and `output_oracle`) through project-neutral adapter boundary evidence and accepts only because the normal strict ledger, same-process runtime oracle, app-hook materialization, sidecar consistency, output oracle, firewall, runtime-chain, and runtime-proof gates all close. The paired negative fixture leaves the strict ledger successful but deliberately mismatches the adapter output oracle's post-dispatch identity, so the row remains `unproven` with `real_rocm_runtime_chain_adapter_output_dispatch_mismatch`. This proves the next arbitrary-project bridge path is not accepted by declaration or target name.

2026-06-30 boundary-import hardening follow-up: the adapter-result bridge can now import complete runtime boundary lines from a refusal-only adapter result to break strict-proof summary circularity, but the matrix recomputes boundary coverage from the actual lines and does not trust serialized `acceptedAsBoundaryEvidence` or empty `boundaryImportBlockingGaps`. A boundary-only bridge must contain all five generic stages (`artifact_transport`, `epoch_publication`, `dispatch_trace`, `host_identity`, and `output_oracle`) and must still rely on a separately accepted strict runtime proof artifact, recomputed ledger, runtime chain, output oracle, firewall, and same-process proof before the row can pass. The new smoke negative removes the `output_oracle` line from a boundary-only bridge and verifies the row remains `unproven` with `real_rocm_runtime_profile_adapter_result_boundary_coverage_incomplete`. Runtime boundary parsing now accepts quoted whitespace paths and normalized adapter aliases for artifact/output fields while retaining rejected-candidate diagnostics. Verification: `node mcp/synthi-mcp/scripts/gpu-hmr-real-rocm-repo-validation.mjs --self-check` passed, and `npm --prefix mcp/synthi-mcp run proof:validation-matrix:self-check` passed with self-check proof `gpu-validation-matrix-ledger:sha256:71d65478e7d7a24b49449b433cdcd199491a17ce027fd12cbdaa5dd6284451e1`; default matrix self-check still reports 56 rows, 14 scoped full-runtime rows, and 0 broad full-runtime rows.

Runtime-adapter execution evidence now preserves its captured `[gpu-runtime-boundary]` lines directly on the execution facet and merges those lines into the same `workerEvidence` stream used by the existing runtime classifiers. This is generic normalization for arbitrary-project adapters: it lets live adapter output feed artifact transport, epoch, dispatch, host identity, and output-oracle evidence without depending on retained log text, but it still does not create a success path or bypass strict runtime-ledger closure.

Native ROCm launch observations now expose diagnostic stage candidates. If the native observer sees generic function resolution, launch attempts, launch observations, runtime sessions, or observer-ready process context, the runner records candidate rows for `dispatch_trace` and `host_identity` under the native launch-boundary facet and propagates them into `real_rocm_runtime_stage_obligations` as `candidateEvidencePresent=true`. These candidates deliberately keep `runtimeObserved=false`, keep the required proof kinds missing, and remain `candidate_native_boundary_evidence_only_not_runtime_proof`. They make MIOpen/CK/hipBLASLt-style refusals more actionable without satisfying GPU HMR acceptance.

Runtime-adapter output-oracle evidence now also supports file-backed compute artifacts. A generic adapter boundary line can declare `raw_readback_bin`, `readback_schema_json`, `rendered_card_png`, `raw_readback_hash`, `checksum_before`, `checksum_after`, deterministic slice fields, and advisory `expected_output_verified`; the runner maps those fields into the existing `compute_oracle_artifacts` object and then relies on `computeOracleArtifactsFromFiles` to reread bytes, recompute hashes, verify slice bounds, and validate the PNG proof card. The same fields can be supplied through `synthi.cas.artifact_locator.v1` manifest paths (`raw_readback_cas_manifest`, `readback_schema_cas_manifest`, `rendered_card_cas_manifest`) and are accepted only after readable-byte CAS validation under allowed artifact/CAS roots. Direct adapter paths are realpath-checked against approved roots before any byte reader sees them. The self-check includes a valid file-backed adapter oracle, a CAS-manifest-backed adapter oracle, a forged hash refusal, and a direct path escape refusal. This is not a classifier success path and does not change broad readiness.

Validation-matrix compute-oracle ingestion now also validates role-bound CAS artifact locators inside `compute_oracle_artifacts` for raw readback bytes, readback schema JSON, and rendered proof-card PNGs. The resolver prefers accepted CAS locators, verifies readable bytes, byte length, SHA-256 content hash, role binding, and allowed artifact/CAS roots, and records `computeArtifactCasResolution` as transport/file-integrity support evidence only. A forged role-specific locator now blocks direct-path fallback and keeps the row refused instead of silently using a direct path. Strict proof-ledger recomputation can now evaluate CAS-only compute ledgers through a validated artifact overlay without mutating the canonical ledger record or proof ID. Stale supplied query/success summaries are ignored only when every role-bound CAS locator for that compute artifact set validates cleanly; bad locators remain ledger-level failures. This is CAS-native proof transport support, not a broad-runtime acceptance shortcut.

Verification for this checkpoint:

```text
python -m py_compile ai-backend/ai-engine/agents/gpu_deterministic_split.py ai-backend/ai-engine/tests/test_kernel_splitter.py -> passed
direct deterministic splitter smoke for `src/main.cpp` plus quoted `src/scene_config.h` -> passed; `constantSourcePaths=["src/scene_config.h"]`, header constants emitted into `shared.h`, provider path not required
python -m pytest ai-backend/ai-engine/tests/test_kernel_splitter.py -k deterministic_rocm -q -> not run, pytest is not installed in this environment
node --check mcp/synthi-mcp/scripts/gpu-hmr-agent-split-workspace-test.mjs -> passed
node --check mcp/synthi-mcp/scripts/lib/gpu-hmr-validation-matrix-ledger.mjs -> passed after compute artifact CAS resolver
node --check mcp/synthi-mcp/scripts/tests/gpu-hmr-validation-matrix-ledger-smoke.mjs -> passed after compute artifact CAS smoke rows
node --check mcp/synthi-mcp/scripts/gpu-hmr-real-rocm-repo-validation.mjs -> passed after runtime-adapter execution normalization
node --check mcp/synthi-mcp/scripts/lib/gpu-hmr-runtime-evidence.mjs -> passed after file-backed output-oracle field parsing
node --check mcp/synthi-mcp/scripts/lib/gpu-hmr-proof-ledger.mjs -> passed after strict-ledger compute CAS overlay support
node --check mcp/synthi-mcp/scripts/lib/gpu-hmr-validation-proof-artifact.mjs -> passed after CAS-only compute artifact materialization support
node --check mcp/synthi-mcp/scripts/lib/gpu-hmr-validation-matrix-ledger.mjs -> passed after HIPRT contract facet gating
node --check mcp/synthi-mcp/scripts/tests/gpu-hmr-validation-matrix-ledger-smoke.mjs -> passed after HIPRT contract fixture coverage
node mcp/synthi-mcp/scripts/tests/gpu-hmr-validation-matrix-ledger-smoke.mjs -> passed after HIPRT contract facet gating, gpu-validation-matrix-ledger:sha256:ffaf311f36bccbd4a394fd1585badfad2c67e0d2ab4089e3508e5fc9640c6a88, rows=63
npm --prefix mcp/synthi-mcp run proof:validation-matrix:self-check -> passed after HIPRT contract facet gating, smoke proof gpu-validation-matrix-ledger:sha256:95768ff9c73a2a3ae90a9d6703502fffa4e1f75767b263c83e843f367e5f8933, current matrix proof gpu-validation-matrix-ledger:sha256:46a988cadeecd79172e2b4b254482513f60cdf5d8e4d17f3e6097c032008e079, rowCount=56, acceptedFullRuntimeGpuHmrRows=14, broadFullRuntimeGpuHmrRows=0
node mcp/synthi-mcp/scripts/gpu-hmr-real-rocm-repo-validation.mjs --self-check -> passed after runtime-adapter execution boundary lines fed artifact-transport evidence, file-backed/CAS-backed output-oracle artifacts verified, forged hashes refused, and direct path escapes refused
node mcp/synthi-mcp/scripts/gpu-hmr-real-rocm-repo-validation.mjs --self-check -> passed after native-boundary stage candidates were added for dispatch/host breadcrumbs while preserving runtime-stage refusal
npm --prefix mcp/synthi-mcp run proof:validation-matrix:self-check -> passed after native-boundary stage candidates, smoke proof gpu-validation-matrix-ledger:sha256:2c13b98b8b5bec89252b3b1bf7c7be6375ea9e2d0bc607538e30f68bb9318b73, current matrix proof gpu-validation-matrix-ledger:sha256:46a988cadeecd79172e2b4b254482513f60cdf5d8e4d17f3e6097c032008e079, rowCount=56, acceptedFullRuntimeGpuHmrRows=14, broadFullRuntimeGpuHmrRows=0
npm --prefix mcp/synthi-mcp run proof:agent-split:source-first:self-check -> passed
npm --prefix mcp/synthi-mcp run proof:generated-split-granularity:self-check -> passed
npm --prefix mcp/synthi-mcp run proof:visual-proof-worker:self-check -> passed
npm --prefix mcp/synthi-mcp run proof:visual-evidence:self-check -> passed with async_visual_proof_pending_job_manifest coverage
npm --prefix mcp/synthi-mcp run proof:agent-split:source-first:self-check -> passed after visual proof job scheduling patch
npm --prefix mcp/synthi-mcp run proof:validation-matrix:self-check -> passed after adapter artifact path/CAS safety patch; smoke proof gpu-validation-matrix-ledger:sha256:38658b203881449185aa20be93721a0bc9ab0a0d56012c3f7ff6a539aa6443c9, then-current matrix gpu-validation-matrix-ledger:sha256:c5b74ecb25b0eca0e39b6ff4540ae24282191685589c1cf3866622a6aad08127
npm --prefix mcp/synthi-mcp run proof:validation-matrix:self-check -> passed after matrix compute artifact CAS resolver
npm --prefix mcp/synthi-mcp run proof:validation-matrix -> passed, then-current gpu-validation-matrix-ledger:sha256:c5b74ecb25b0eca0e39b6ff4540ae24282191685589c1cf3866622a6aad08127
npm --prefix mcp/synthi-mcp run proof:validation-matrix:history -> passed, gpu-validation-matrix-ledger:sha256:aa905942109909b5181c6236cb348a68710ebc667ac8f8dde7d572385c7e349c
node mcp/synthi-mcp/scripts/tests/gpu-hmr-validation-matrix-ledger-smoke.mjs -> passed after the adapter-boundary bridge fixture and adapter artifact path/CAS safety patch, latest smoke proof gpu-validation-matrix-ledger:sha256:38658b203881449185aa20be93721a0bc9ab0a0d56012c3f7ff6a539aa6443c9, rows=63
node mcp/synthi-mcp/scripts/tests/gpu-hmr-validation-matrix-ledger-smoke.mjs -> passed after CAS-only compute ledger overlay and forged role-specific locator refusal, gpu-validation-matrix-ledger:sha256:65d01eca8214ac7bf49c348a27dcebf39a6fe386815beae36b1058f648d777af, rows=63
node mcp/synthi-mcp/scripts/tests/gpu-hmr-validation-matrix-ledger-smoke.mjs -> passed after generic adapter-boundary runtime-chain overlay support and adapter/ledger conflict refusal, gpu-validation-matrix-ledger:sha256:4b37b1359f35db9fdd7c095cc1fc59faf46e597c109d3959ea86e8ab75a99eb1, rows=63
npm --prefix mcp/synthi-mcp run proof:validation-matrix:self-check -> passed after generic adapter-boundary runtime-chain overlay support; smoke proof gpu-validation-matrix-ledger:sha256:e78d6023ce12498a739595a852dd5718efd816fec3ae2e27fdccec89ba12a7be, current matrix proof gpu-validation-matrix-ledger:sha256:7ec3bab055a9ea70d762004630adfcaa2872315622f6d57c241487ca8dd6cae8, rowCount=56, acceptedFullRuntimeGpuHmrRows=14, broadFullRuntimeGpuHmrRows=0
npm --prefix mcp/synthi-mcp run proof:validation-matrix:self-check -> passed after strict-ledger CAS-only compute overlay support; smoke proof gpu-validation-matrix-ledger:sha256:331c38136606525b63202cc1ba0a7e0cb45a64c147d79328b3cc301e720f5542, current matrix gpu-validation-matrix-ledger:sha256:eb8d959b795ac57161ce26e25d56fd745b722f1ff54a453937304c31ee8a9f0f
npm --prefix mcp/synthi-mcp run proof:status-docs:self-check -> passed under default heap after metadata-only history summary extraction
node --max-old-space-size=8192 mcp/synthi-mcp/scripts/tests/gpu-hmr-status-docs-freshness-smoke.mjs --live-recompute -> passed for opt-in live current-matrix recompute; deep history recompute remains covered by npm --prefix mcp/synthi-mcp run proof:validation-matrix:history
```

The runtime-profile adapter-result bridge is now matrix-auditable rather than report-only. Real ROCm validation matrix ingestion normalizes `real_rocm_runtime_profile_adapter_result` / `runtimeProfileAdapterResult` from top-level reports, summaries, and runtime proof artifacts into a `synthi.real_rocm.runtime_profile_adapter_result_bridge.v1` facet. A present facet is accepted only with the evidence-only authority `declared_adapter_result_import_not_runtime_authority`, explicit strict proof/runtime-artifact/proof-ledger presence, strict proof and ledger IDs, a content-addressed adapter result hash, evidence refs, and no blocking gaps. The row and accepted-row safety layers both reject forged bridge facets that claim GPU HMR acceptance, GPU HMR success, runtime authority, or dispatch authority.

Generic real ROCm runtime-adapter execution is now implemented separately from adapter-result import. Profiles or env may declare a `runtimeAdapter` command, the runner executes it inside the configured worker context, records `synthi.real_rocm.runtime_adapter_execution.v1`, and feeds observed runtime-boundary/app-hook material into the existing stage classifiers. This is still evidence-only: the facet records `acceptedForGpuHmr=false`, `gpuHmrSuccess=false`, and `canSatisfyRuntimeProof=false`, and forged adapter output cannot satisfy artifact transport, epoch publication, dispatch trace, host identity, output oracle, firewall, or strict runtime proof closure.

Runtime-adapter scheduling is now profile-driven across generic lifecycle points instead of being locked to one post-run slot. `runtimeAdapter.runWhen` supports `after_upstream_run`, `after_configure_success`, `after_build_attempt`, and `after_lifecycle_attempt`; unknown/project-named values reject, and explicit `requiresSuccessfulBuild` / `requiresSuccessfulRun` still block execution. The execution facet records the selected lifecycle point. Profile proof obligations now recompute with profile-declared, env-declared, or adapter-imported app-hook contracts, which removes stale configuration-only app-hook gaps without satisfying runtime stage gates by declaration.

The packaged large ROCm ML profiles now declare the shared `runtime_boundary_log_harvest_v1` runtime-adapter template. MIOpen, Composable Kernel, and hipBLASLt use the same template, lifecycle point, and result-path pattern; the packaged profiles do not carry inline adapter shell commands or success-authority flags. The template harvests real `[gpu-runtime-boundary]` lines from the worker run log when available, writes those exact lines into the refusal-only adapter result manifest as `runtimeBoundaryLines` / `adapterRuntimeBoundaryLines`, and remains non-authoritative unless the normal artifact transport, epoch, dispatch, host identity, output oracle, firewall, and strict runtime proof gates close. This is generic large-project evidence plumbing, not project acceptance.

Runtime-adapter execution and result-transport evidence now preserve adapter identity through `adapterTemplate` and `adapterCommandHash`. Imported runtime-profile adapter results are also row-bound to the strict runtime proof artifact ID and recomputed proof-ledger ID; mismatched adapter result proof IDs produce explicit matrix gaps and keep the row unproven. The validation matrix keeps those fields on `realRocmRuntimeAdapterExecution`, `realRocmRuntimeAdapterResultTransport`, and `realRocmRuntimeProfileAdapterResult`, and the adapter-boundary smoke fixture asserts the `runtime_boundary_log_harvest_v1` template/command hash remains non-success while a proof-ID replay is refused. This improves auditability for arbitrary-project adapters without broadening acceptance.

This remains support/refusal evidence only. It does not replace observed artifact transport, epoch publication, dispatch trace, host identity, output oracle, firewall proof, or accepted strict runtime proof closure, and it does not change broad readiness: current broad library-agnostic full-runtime GPU HMR remains unproven.

```text
implementation commit: e0a06ccd1 feat(gpu-hmr): add generic rocm runtime adapter evidence
latest local patch: runtime-adapter host-identity boundary proof-shape gate
subagent used: real-ROCm validation matrix adapter-result bridge audit
subagent used: focused docs/overclaim audit for latest runtime-adapter, MIOpen, source-first, and visual-proof evidence
subagent used: real-ROCm runtime-adapter/app-hook scheduling audit
subagent used: source-first/visual proof path audit
subagent used: generic large-ROCm adapter-boundary bridge audit
subagent used: runtime-adapter execution normalization audit
subagent used: validation-matrix compute artifact CAS resolver audit
subagent used: strict-ledger CAS-only compute artifact overlay audit
subagent used: generic runtime-adapter execution/result-path audit
subagent used: generic large-ROCm app-hook/runtime adapter stage-closure audit
verification: node --check mcp/synthi-mcp/scripts/gpu-hmr-real-rocm-repo-validation.mjs -> passed
verification: node --check mcp/synthi-mcp/scripts/lib/real-rocm-validation-command-env.mjs -> passed
verification: node mcp/synthi-mcp/scripts/gpu-hmr-real-rocm-repo-validation.mjs --self-check -> passed after self-contained adapter-result boundary-line checks; optional POSIX template execution skipped on this Windows host because `sh` was blocked or unavailable
verification: node --check mcp/synthi-mcp/scripts/lib/gpu-hmr-validation-matrix-ledger.mjs -> passed
verification: node --check mcp/synthi-mcp/scripts/tests/gpu-hmr-validation-matrix-ledger-smoke.mjs -> passed
verification: node mcp/synthi-mcp/scripts/tests/gpu-hmr-validation-matrix-ledger-smoke.mjs -> passed after host-identity boundary proof-shape gating, gpu-validation-matrix-ledger:sha256:39a94118e82494841200e7ab967403f9a56a64ac6b38673eb29a9c4ac75ccce1, rows=65
verification: node mcp/synthi-mcp/scripts/tests/gpu-hmr-validation-matrix-ledger-smoke.mjs -> passed after runtime-adapter result transport matrix ingestion, gpu-validation-matrix-ledger:sha256:682e9c68d102eb03cf242ac2a7e8a9ee2bd364f1848e7c7dc0d100d1d08bdbdf, rows=63
verification: node mcp/synthi-mcp/scripts/tests/gpu-hmr-validation-matrix-ledger-smoke.mjs -> passed after direct runtime-adapter execution overlay support, gpu-validation-matrix-ledger:sha256:83584ae0a146f8344c6ce81107ed04e273987e71c96228ff0276b252f99faef8, rows=63
verification: npm --prefix mcp/synthi-mcp run proof:validation-matrix:self-check -> passed after direct runtime-adapter execution overlay support, generic worker-to-host adapter result transport, and runtime-adapter result transport matrix ingestion; smoke proof gpu-validation-matrix-ledger:sha256:52e71a078861b4804fa9f4a6dfc2f663815d67b55454b9e65b0c9be75edaab7a, current matrix proof gpu-validation-matrix-ledger:sha256:4b9c3cc0beb76f2192055b0b1753b7e3f6818c56c720a55223f87ec76b3f90be, rowCount=56, acceptedFullRuntimeGpuHmrRows=14, broadFullRuntimeGpuHmrRows=0
new smoke coverage: imported adapter-result bridge remains evidence-only/non-success; forged bridge row refuses claimed GPU HMR/runtime/dispatch authority; accepted-row safety rejects a forged bridge facet even when attached to an otherwise accepted real-ROCm row
new smoke coverage: runtime-adapter execution requires actual runtime-boundary evidence before it can even become support evidence, and complete boundary evidence still remains non-authoritative/non-success until strict runtime proof closes
new smoke coverage: runtime-adapter scheduling can explicitly run after configure/build/lifecycle attempts without pretending upstream build/run succeeded; strict build/run requirements still reject, and supplied app-hook contracts satisfy only the profile-obligation declaration check, not runtime stage proof
new smoke coverage: validation-matrix runtime-chain overlays now accept direct `real_rocm_runtime_adapter_execution` boundary lines as support evidence in addition to imported adapter-result bridge lines; the complete row reports both overlay sources and the paired negative proves direct execution output-dispatch mismatch still refuses with `real_rocm_runtime_chain_adapter_output_dispatch_mismatch`
runner bridge update: configured `runtimeAdapter.resultPath` / runtime-profile adapter result paths are now exported to runtime adapter commands as worker-side result-path environment variables and, when present, copied back to the repo-bound host path before bridge import. The transport facet is `runtime_adapter_result_transport_only_not_gpu_hmr_success`; missing, invalid, or uncopyable files remain refusal evidence and cannot authorize runtime success.
matrix bridge update: validation-matrix ingestion now normalizes `real_rocm_runtime_adapter_result_transport` / `runtimeAdapterResultTransport` from reports, summaries, runtime proof artifacts, and evidence blocks. Accepted transport requires schema `synthi.real_rocm.runtime_adapter_result_transport.v1`, the transport-only authority, copied result evidence with byte length, SHA-256, evidence refs, and no blocking gaps. Forged transport records that claim GPU HMR acceptance, GPU HMR success, runtime authority, or dispatch authority are surfaced in row reasons/open gaps and rejected by accepted-row safety. This is still transport evidence only, not runtime proof.
verification: npm --prefix mcp/synthi-mcp run proof:real-rocm:package-scripts:self-check -> passed; large ROCm ML package scripts preserve caller-provided SYNTHI_REAL_ROCM_UPSTREAM_TIMEOUT_MS while keeping strict runtime proof and native observer gates enabled
verification: npm --prefix mcp/synthi-mcp run proof:real-rocm:self-check -> passed; proof scheduling now verifies a structurally blocked requested wait below the diagnostic budget remains bounded instead of being inflated
verification: node --check mcp/synthi-mcp/scripts/tests/gpu-hmr-real-rocm-package-scripts-smoke.mjs -> passed after packaged runtime-adapter template checks
verification: node mcp/synthi-mcp/scripts/tests/gpu-hmr-real-rocm-package-scripts-smoke.mjs -> passed after verifying the three large ROCm profiles declare the shared template, safe result paths, refusal-only obligations, and no adapter success-authority fields
verification: npm --prefix mcp/synthi-mcp run proof:real-rocm:package-scripts:self-check -> passed after packaged runtime-adapter template checks
verification: npm --prefix mcp/synthi-mcp run proof:real-rocm:self-check -> passed after profile-id safety, runtime-adapter template, unknown-template, and missing-command/template self-checks
verification: node --check mcp/synthi-mcp/scripts/lib/gpu-hmr-validation-matrix-ledger.mjs -> passed after adapter template/hash row binding
verification: node mcp/synthi-mcp/scripts/tests/gpu-hmr-validation-matrix-ledger-smoke.mjs -> passed after adapter execution/result-transport template and command-hash assertions plus adapter-result strict-runtime-proof/proof-ledger row binding, gpu-validation-matrix-ledger:sha256:9f69d59739f6b5e8fd42fb962e10fc84437edd131d068d433307b087cfb8b2bc, rows=63
verification: node mcp/synthi-mcp/scripts/gpu-hmr-real-rocm-repo-validation.mjs --self-check -> passed after runtime-adapter execution template/hash preservation
verification: npm --prefix mcp/synthi-mcp run proof:validation-matrix:self-check -> passed after adapter-result row-bound proof-ID gates, smoke proof gpu-validation-matrix-ledger:sha256:34eddc1bae21621039172e51e05288b9c0a1d4951f89b47d5e0730619fbd6452, self-check matrix gpu-validation-matrix-ledger:sha256:40a57b1c03eba71b5540f3e80725f38b0b82f3ff4da0c9500bcb0484674fbf85, rowCount=56, acceptedFullRuntimeGpuHmrRows=14, broadFullRuntimeGpuHmrRows=0
verification: npm --prefix mcp/synthi-mcp run proof:status-docs:self-check -> passed after status freshness audit, then-current live matrix gpu-validation-matrix-ledger:sha256:c5b74ecb25b0eca0e39b6ff4540ae24282191685589c1cf3866622a6aad08127, rowCount=56, acceptedFullRuntimeRows=14, broadFullRuntimeRows=0, history gpu-validation-matrix-ledger:sha256:aa905942109909b5181c6236cb348a68710ebc667ac8f8dde7d572385c7e349c
verification: npm --prefix mcp/synthi-mcp run proof:status-docs:self-check -> passed after denial-context anti-overclaim smoke hardening; the smoke now rejects forged positive "Every arbitrary GPU project is production accepted" status text instead of accepting mere token presence
```

Additional 2026-06-29 visual CAS replay hardening:

```text
implementation commit: ff3301995 fix(gpu-hmr): require CAS visual worker replay
matrix behavior: visual recompute now prefers validated CAS artifact locators as async worker before/after inputs, records the requested worker input transport, and requires workerCasInputAccepted=true before asyncVisualCasBundle support can accept
fallback behavior: direct local paths, serialized bytes, or unvalidated locators can still support diagnostic recompute, but the support facet fails with async_visual_worker_cas_input_missing instead of being counted as optimized shared-CAS proof
proof boundary: asyncVisualCasBundle remains support-only with acceptedForGpuHmr=false and gpuHmrSuccess=false; strict runtime-ledger closure is still required for GPU HMR acceptance
subagent used: visual proof and CAS transport audit; remaining follow-ups at this point were true proof-pending scheduling, native image-worker identity, typed ROI/tile manifest binding, and large real-ROCm app-hook/runtime closure
verification: node --check mcp/synthi-mcp/scripts/lib/gpu-hmr-validation-matrix-ledger.mjs -> passed
verification: node --check mcp/synthi-mcp/scripts/tests/gpu-hmr-validation-matrix-ledger-smoke.mjs -> passed
verification: node mcp/synthi-mcp/scripts/tests/gpu-hmr-visual-proof-worker-smoke.mjs -> passed
verification: node mcp/synthi-mcp/scripts/tests/gpu-hmr-visual-evidence-smoke.mjs -> passed
verification: node mcp/synthi-mcp/scripts/tests/gpu-hmr-validation-matrix-ledger-smoke.mjs -> passed
verification: npm --prefix mcp/synthi-mcp run proof:validation-matrix:self-check -> passed, gpu-validation-matrix-ledger:sha256:425a5f02cc756ee518d41fdb8ce71398ed8660b34025eb65f41a92e9f7bd3b62, rowCount=56, acceptedFullRuntimeGpuHmrRows=14, broadFullRuntimeGpuHmrRows=0
verification: npm --prefix mcp/synthi-mcp run proof:validation-matrix -> passed, gpu-validation-matrix-ledger:sha256:425a5f02cc756ee518d41fdb8ce71398ed8660b34025eb65f41a92e9f7bd3b62
verification: npm --prefix mcp/synthi-mcp run proof:validation-matrix:history -> passed, gpu-validation-matrix-ledger:sha256:84a53b01ac48ac2f6d17cc953122e5f8f4515789cc513f0578da7e283468609b, rows=678, historicalUnprovenRows=622
trust-boundary follow-up: compute CAS roots are now authorized only by trusted runner/options/env/repo roots; source-declared CAS roots are metadata unless they are inside a trusted root, and role-specific compute CAS locators reject role smuggling before path materialization
trust-boundary follow-up: async visual proof completion now recomputes and enforces the pending job hash, requires caller-supplied trusted read/output roots, and treats job-owned roots as evidence-only rather than filesystem authority
subagent used: async visual proof/CAS transport trust-boundary audit
new smoke coverage: self-declared outside compute CAS roots cannot materialize raw readback paths, role-mismatched raw readback CAS manifests fail closed, async visual proof jobs without trusted roots reject, and tampered pending jobs reject with `async_visual_proof_job_hash_mismatch`
verification: node mcp/synthi-mcp/scripts/tests/gpu-hmr-artifact-cas-smoke.mjs -> passed
verification: node mcp/synthi-mcp/scripts/tests/gpu-hmr-visual-proof-worker-smoke.mjs -> passed
verification: npm --prefix mcp/synthi-mcp run proof:visual-evidence:self-check -> passed with async visual pending-job manifest and trusted-completion checks
verification: node mcp/synthi-mcp/scripts/tests/gpu-hmr-validation-matrix-ledger-smoke.mjs -> passed after trusted compute CAS root and role-mismatch hardening, gpu-validation-matrix-ledger:sha256:16beb644ee9952146a8d593a779cae2dfff4a06545f6638dc26db3ffa97ed3e4, rows=63
verification: npm --prefix mcp/synthi-mcp run proof:validation-matrix:self-check -> passed after trusted compute CAS root and async visual job completion hardening; smoke proof gpu-validation-matrix-ledger:sha256:518490eb634145e313702f2bbd1ccc89502fcbc1ebbcac1aff351fbaf450f2be, matrix self-check proof gpu-validation-matrix-ledger:sha256:40a57b1c03eba71b5540f3e80725f38b0b82f3ff4da0c9500bcb0484674fbf85, rowCount=56, acceptedFullRuntimeGpuHmrRows=14, broadFullRuntimeGpuHmrRows=0
verification: npm --prefix mcp/synthi-mcp run build -> passed
```

Additional 2026-06-29 native/incremental visual proof binding:

```text
implementation commit: d44d927ff fix(gpu-hmr): bind visual worker native identity
implementation commit: 22671f6a3 fix(gpu-hmr): bind incremental visual proof evidence
matrix behavior: asyncVisualCasBundle support now requires worker native image dependency identity, tile binding acceptance, and recomputed typed incremental evidence bindings before the support facet can accept
native binding: worker executable identity includes `synthi.gpu_hmr.visual_worker_native_dependency_manifest.v1` for the native image decode/diff backend (`sharp`/libvips runtime versions), and the matrix fails with async_visual_native_dependency_identity_missing when that manifest is absent
incremental binding: tile grids and ROI hashes carry `synthi.gpu_hmr.visual_incremental_evidence_binding.v1` records bound to before/after encoded hashes, raw frame hashes, dimensions, tile-list hash, ROI hashes, optional deterministic visual-mode hash, and a recomputed binding hash
proof boundary: native dependency identity, tile hashes, ROI hashes, binding hashes, CAS transport, and proof_ready worker events remain support-only with acceptedForGpuHmr=false and gpuHmrSuccess=false; strict runtime-ledger closure is still required for GPU HMR acceptance
subagent used: async visual proof native/ROI binding audit
verification: node --check mcp/synthi-mcp/scripts/lib/gpu-hmr-visual-proof-worker.mjs -> passed
verification: node --check mcp/synthi-mcp/scripts/lib/gpu-hmr-visual-proof-worker-thread.mjs -> passed
verification: node --check mcp/synthi-mcp/scripts/lib/gpu-hmr-validation-matrix-ledger.mjs -> passed
verification: node --check mcp/synthi-mcp/scripts/tests/gpu-hmr-visual-proof-worker-smoke.mjs -> passed
verification: node --check mcp/synthi-mcp/scripts/tests/gpu-hmr-validation-matrix-ledger-smoke.mjs -> passed
verification: node mcp/synthi-mcp/scripts/tests/gpu-hmr-visual-proof-worker-smoke.mjs -> passed
verification: node mcp/synthi-mcp/scripts/tests/gpu-hmr-visual-evidence-smoke.mjs -> passed
verification: node mcp/synthi-mcp/scripts/tests/gpu-hmr-validation-matrix-ledger-smoke.mjs -> passed, gpu-validation-matrix-ledger:sha256:22ec7e85dfe3e29a3524935ed3fa2bccbd9a761583b8d64a9e62a4d09db0442e, rows=58
verification: npm --prefix mcp/synthi-mcp run proof:validation-matrix:self-check -> passed; smoke proof gpu-validation-matrix-ledger:sha256:736a586ee31b899eb5a250ff01752c7d5eebec2d4c0c3a0dc31cfb5653cf77a6, matrix self-check proof gpu-validation-matrix-ledger:sha256:425a5f02cc756ee518d41fdb8ce71398ed8660b34025eb65f41a92e9f7bd3b62, rowCount=56, acceptedFullRuntimeGpuHmrRows=14, broadFullRuntimeGpuHmrRows=0
verification: npm --prefix mcp/synthi-mcp run proof:validation-matrix -> passed, gpu-validation-matrix-ledger:sha256:425a5f02cc756ee518d41fdb8ce71398ed8660b34025eb65f41a92e9f7bd3b62
verification: npm --prefix mcp/synthi-mcp run proof:validation-matrix:history -> passed, gpu-validation-matrix-ledger:sha256:84a53b01ac48ac2f6d17cc953122e5f8f4515789cc513f0578da7e283468609b, rows=678, historicalUnprovenRows=622
```

Additional 2026-06-29 large-ROCm prerequisite and transport progress:

```text
implementation: real ROCm profiles now support generic `externalHeaderPrerequisites` with git source URL, exact commit, optional `cmake_install` materialization, required-header inspection, and `${REAL_ROCM_EXTERNAL_INCLUDE:<id>}` CMake token expansion only after dependency evidence is accepted
proof authority: external_header_dependency_evidence_only_not_gpu_hmr_success
not proof: external header materialization has acceptedForGpuHmr=false, gpuHmrSuccess=false, canSatisfyRuntimeProof=false, and cannot satisfy artifact transport, epoch publication, dispatch trace, host identity, app-hook, output-oracle, firewall, or strict runtime proof gates
matrix follow-up: validation matrix ingestion now normalizes `real_rocm_external_header_prerequisites` / `externalHeaderPrerequisites` from top-level reports, summaries, runtime proof artifacts, and evidence blocks. A present facet must keep dependency-only authority, schema-correct aggregate and child prerequisite records, exact immutable commits, materialization/install/header inspection evidence, content-addressed header-set hashes, and no blocking gaps. The matrix and accepted-row safety reject forged external-header facets that claim GPU HMR acceptance, GPU HMR success, runtime authority, or dispatch authority.
MIOpen profile change: `-DHALF_INCLUDE_DIR=${REAL_ROCM_EXTERNAL_INCLUDE:rocm-half}` plus upstream `ROCm/half.git` at commit `10abd99e7815f0ca5d892f58dd7d15a23b7cf92c`, installed through the project's own CMake install path into shared CAS
previous retained MIOpen slug before the runtime-adapter rerun: gpu-real-rocm-MIOpen-20260629075614
previous retained MIOpen json before the runtime-adapter rerun: mcp/synthi-mcp/.gpu-hmr-test-logs/real-rocm-results/gpu-real-rocm-MIOpen-20260629075614.json
external headers: earlier `ROCm/half` prerequisite evidence is retained as dependency-only historical evidence; it is not a runtime or dispatch proof authority
source-tree transport: status=source_tree_transport_evidence_accepted, transferOperation=cas_shared_volume, hotPathOptimized=true, blockingGaps=[]
upstream lifecycle: configured successfully, recovered metadata, and executed source-delta compile projections for first split, hot delta 1, hot delta 2, and negative edit; those projections are evidence-only because no runtime bridge material was observed
runtime proof: gpu-runtime-proof:sha256:c93dc1af943c2db531fc494388c7ccbbebefc3f4aebe3825927bf9a25228f2eb, fullRuntimeProven=false, gpuHmrSuccess=false
proof ledger: gpu-ledger-proof:sha256:1b0d25ab7f427cd41099af5b4ef2b8ab24250f818dd459701c6d9984b70914d3
validation proof: real-rocm-validation:sha256:016cfa8945a99d49d4afcfe9a35e23aab63a36187fcf345a1c7cb17c7d995d37
large ROCm verdict: still refused, acceptedForGpuHmr=false; no Synthi artifact transport, epoch publication, dispatch trace, host identity, app-hook contract/runtime observation, or post-dispatch output/visual oracle proof was collected
visual proof: supplemental screenshots were retained and inspected as nonblank, but no post-epoch MIOpen output target or frame-gated visual oracle was observed
cleanup: a later detached long MIOpen build continued after the host validator timeout and was stopped because no live validator process remained to collect proof artifacts
verification: node --check mcp/synthi-mcp/scripts/gpu-hmr-real-rocm-repo-validation.mjs -> passed
verification: node mcp/synthi-mcp/scripts/gpu-hmr-real-rocm-repo-validation.mjs --self-check -> passed
verification: npm --prefix mcp/synthi-mcp run proof:real-rocm:self-check -> passed
verification: git diff --check -- mcp/synthi-mcp/scripts/gpu-hmr-real-rocm-repo-validation.mjs mcp/synthi-mcp/scripts/profiles/real-rocm-miopen-activation-large-ml.json -> passed
matrix verification: node --check mcp/synthi-mcp/scripts/lib/gpu-hmr-validation-matrix-ledger.mjs -> passed
matrix verification: node --check mcp/synthi-mcp/scripts/tests/gpu-hmr-validation-matrix-ledger-smoke.mjs -> passed
matrix verification: node mcp/synthi-mcp/scripts/tests/gpu-hmr-validation-matrix-ledger-smoke.mjs -> passed, gpu-validation-matrix-ledger:sha256:e6ca7aed37a793f30314180aa72af4ea171ff97d92054d02fbf62ddffccba5a3, rows=58
matrix verification: npm --prefix mcp/synthi-mcp run proof:validation-matrix:self-check -> passed on retry with longer timeout; smoke proof gpu-validation-matrix-ledger:sha256:16f6bb05e9402a64a7496701103b6a5e5ad7197d732937935eb7c9358685046f, matrix self-check proof gpu-validation-matrix-ledger:sha256:425a5f02cc756ee518d41fdb8ce71398ed8660b34025eb65f41a92e9f7bd3b62, rowCount=56, acceptedFullRuntimeGpuHmrRows=14, broadFullRuntimeGpuHmrRows=0
matrix refresh: npm --prefix mcp/synthi-mcp run proof:validation-matrix -> passed, gpu-validation-matrix-ledger:sha256:425a5f02cc756ee518d41fdb8ce71398ed8660b34025eb65f41a92e9f7bd3b62
matrix refresh json: mcp/synthi-mcp/.gpu-hmr-test-logs/validation-matrix/gpu-hmr-validation-matrix-20260629T031244Z.json
matrix refresh summary: rowCount=56, acceptedFullRuntimeGpuHmrRows=14, scopedFullRuntimeGpuHmrRows=14, broadFullRuntimeGpuHmrRows=0, refusalProvenRows=29
historical matrix MIOpen row after external-header gate: historical-row-sha256:c44445aa3738bbc7a90eb134f5fab2b7730e90ce0ae13ee3f922d8309f89b7c4, outcome=refusal_proven, proofChain=real_rocm_strict_runtime_refusal, externalHeaderPrerequisites=accepted dependency evidence only, acceptedForGpuHmr=false, gpuHmrSuccess=false, canSatisfyRuntimeProof=false
new smoke coverage: accepted dependency-only external-header prerequisite evidence is preserved on large real ROCm rows; forged aggregate/child prerequisite facets are rejected when they claim GPU HMR/runtime/dispatch authority; accepted-row safety rejects a forged external-header prerequisite facet on an otherwise accepted row
```

Fresh 2026-06-29 runtime-adapter-check MIOpen attempt:

```text
command: npm --prefix mcp/synthi-mcp run proof:real-rocm:large-ml-miopen with SLUG=gpu-real-rocm-MIOpen-20260629-runtime-adapter-check
sandboxed retained json: mcp/synthi-mcp/.gpu-hmr-test-logs/real-rocm-results/gpu-real-rocm-MIOpen-20260629-runtime-adapter-check.json
sandboxed retained txt: mcp/synthi-mcp/.gpu-hmr-test-logs/real-rocm-results/gpu-real-rocm-MIOpen-20260629-runtime-adapter-check.txt
sandboxed result: failed closed before Docker/container evidence in 13.0791ms, repo_commit=null, runtimeAdapterDeclared=false, runtimeAdapterExecution=null, gpuHmrSuccess=false, fullRuntimeProven=false, runtimeProofArtifact=null, no visual or compute oracle, no runtime adapter result, and target-progression/app-hook/runtime-stage gates still missing
approved rerun observation: the unsandboxed rerun reached the real MIOpen upstream build, configured successfully, and progressed deep into native compilation before the host validator shell timeout
proof status of approved rerun: no retained strict runtime proof artifact or output-oracle artifact was produced because the validator process timed out before proof collection could close; the detached build was stopped rather than counted
interpretation: serious large-project execution progress only. MIOpen remains refused for GPU HMR because there is still no Synthi artifact transport, epoch publication, dispatch trace, host identity, app-hook runtime observation, output oracle, firewall proof, or accepted strict runtime proof closure; this run did not declare or execute a runtime adapter.
visual proof: none for this compute/upstream-lifecycle profile; no post-epoch MIOpen frame or readback oracle was observed
```

Fresh 2026-06-29 source-first/no-precompiled user-path check:

```text
implementation patch: source-first/no-precompiled purity evidence now scans every submitted initial seed file and binds the scan to the exact initial compile manifest through `sourcePurityInitialManifestHash == initialManifestHash`
matrix behavior: rows with missing, incomplete, dirty, or extra source-purity scan files now reject with `source_first_seed_purity_manifest_missing`, `source_first_seed_purity_manifest_incomplete`, `source_first_seed_purity_manifest_hash_mismatch`, or `source_first_seed_purity_file_set_mismatch`; older source-first rows without exact-manifest purity evidence are fail-closed instead of grandfathered
subagent used: source-first whole-manifest purity binding audit
verification: npm --prefix mcp/synthi-mcp run proof:agent-split:source-first:self-check -> passed
verification: npm --prefix mcp/synthi-mcp run proof:validation-matrix:self-check -> passed after the source-first closure and large-ROCm reruns
matrix refresh: npm --prefix mcp/synthi-mcp run proof:validation-matrix -> passed, gpu-validation-matrix-ledger:sha256:c5b74ecb25b0eca0e39b6ff4540ae24282191685589c1cf3866622a6aad08127
then-current matrix refresh json: mcp/synthi-mcp/.gpu-hmr-test-logs/validation-matrix/gpu-hmr-validation-matrix-20260629T112859Z.json; summary: 56 rows, 14 accepted full-runtime GPU HMR rows, 0 broad library-agnostic full-runtime GPU HMR rows, 14 scoped full-runtime GPU HMR rows, 14 all full-runtime rows, 29 refusals, 7 cold splits, 0 included unproven rows
matrix scope breakdown: generated_rocm_hip_preview_visual: 2, hip_module_declared_compute_readback: 2, webgpu_declared_compute_readback: 2, webgpu_declared_pipeline_visual: 8
per_target_run_modes status=accepted
per_target_run_modes open gap: none
history refresh: npm --prefix mcp/synthi-mcp run proof:validation-matrix:history -> passed, gpu-validation-matrix-ledger:sha256:aa905942109909b5181c6236cb348a68710ebc667ac8f8dde7d572385c7e349c
history refresh json: mcp/synthi-mcp/.gpu-hmr-test-logs/validation-matrix-unproven-audit/gpu-hmr-validation-matrix-20260629T113226Z.json; summary: 678 rows, 14 accepted full-runtime GPU HMR rows, 0 broad library-agnostic full-runtime GPU HMR rows, 14 scoped full-runtime GPU HMR rows, 14 all full-runtime rows, 29 refusals, 7 cold splits, 622 historical unproven rows
history scope breakdown: generated_rocm_hip_preview_visual: 2, hip_module_declared_compute_readback: 2, webgpu_declared_compute_readback: 2, webgpu_declared_pipeline_visual: 8
new smoke coverage: source-first rows with incomplete source-purity scan coverage, a forged source-purity initial manifest hash, or extra scanned files outside the initial seed manifest remain unproven even if they claim source-first acceptance
source-first closure realistic command: SLUG=source-first-cold-cas-realistic-20260629 npm --prefix mcp/synthi-mcp run proof:agent-split:source-first:realistic-raytrace -> passed with strict visual HMR proof
source-first closure realistic workspace: source-first-cold-cas-realistic-20260629
source-first exact-purity scan: source hash sha256:057c83a0a2af53eea19ba3f189836978c804a0048dfd2436bb2cc41bc882662e, files=2, manifest=sha256:52c54da7c6757bf109bec206a56a847e991bf1e7f14ade2d5ac1acb0145bb952
source-first closure artifact: mcp/synthi-mcp/.gpu-hmr-test-logs/agent-split-artifacts/source-first-cold-cas-realistic-20260629/agent-split-results.txt
source-first proof id: agent-split-source-first-ingestion:sha256:dbef11d86091ba64402333b6598f208c619f231474ced92da53fed8d15e1920f
source-first current hot rows: historical-gpu-validation-matrix-row-sha256-df44f7e0790a508aac703b3746cb2f80be2ff907a753d16a2bf7d7083adcbdff, historical-gpu-validation-matrix-row-sha256-be05fd92aaee4bc25fcdb00a3e061fd5e86c8f185078529c93493545f5f7d595
source-first negative refusal row: historical-gpu-validation-matrix-row-sha256-84347a9a017de043fc6a0abec4fffd786a0e7aa84aeca62525b2210c769ac26e
source-first visual proof: cold-split-frame.png, before-after-diff.png, and hot-delta-2-diff.png were opened locally and were visibly nonblank
source-first seed-only command: npm --prefix mcp/synthi-mcp run proof:agent-split:source-first:seed-only -> passed
source-first seed-only workspace: gpu-agent-split-1782741683475
source-first seed-only url: http://localhost:3000/workspace/gpu-agent-split-1782741683475
source-first seed-only artifact: mcp/synthi-mcp/.gpu-hmr-test-logs/agent-split-artifacts/gpu-agent-split-1782741683475/agent-split-seed-results.txt
source-first seed-only scope: seeded default source fixture files only; no GPU split, runtime epoch, visual proof, output oracle, or strict ledger acceptance
historical source-first provider-preflight failure: workspace gpu-agent-split-1782704006982 failed before AI split with provider diagnostic source-first-provider-diagnostic:sha256:dec0f1aa6adfa3903bac78832b4ce974095b4b6bdce72f69df61e8bad54e002a, reason ai_provider_account_suspended, acceptedForGpuHmr=false, gpuHmrSuccess=false, canSatisfyRuntimeProof=false
```

Follow-up validation in the same checkpoint kept the large-project and source-first paths honest:

```text
large ROCm command: bounded direct MIOpen profile run with SYNTHI_REAL_ROCM_UPSTREAM_TIMEOUT_MS=120000, SYNTHI_REAL_ROCM_HMR_TIMEOUT_MS=60000, SYNTHI_REAL_ROCM_PROOF_FAST_FAIL=1, reuse worker repo on, clean build off
large ROCm result slug: gpu-real-rocm-MIOpen-20260628214946
large ROCm retained json: mcp/synthi-mcp/.gpu-hmr-test-logs/real-rocm-results/gpu-real-rocm-MIOpen-20260628214946.json
large ROCm retained txt: mcp/synthi-mcp/.gpu-hmr-test-logs/real-rocm-results/gpu-real-rocm-MIOpen-20260628214946.txt
large ROCm result: refused, acceptedForGpuHmr=false, gpuHmrSuccess=false, fullRuntimeProven=false
large ROCm source-tree transport: source_tree_transport_evidence_accepted, gaps=[]
large ROCm missing dependency proof: missing_dependency_refusal_evidence, gaps=missing_build_dependency,missing_dependency:half_half.hpp,missing_header:half_half.hpp
large ROCm runtime proof: gpu-runtime-proof:sha256:bf1be9ca501dfaa08c629f49a035f77d5eb641afb6ad859fb8f56fd72c13ed42
large ROCm target progression ledger: target-progression-ledger:sha256:8d39e9609ed37566bbceac9424c73b9137a189daf8bfd58f6a6d1ddc14ae947b
large ROCm app-hook/runtime status: required_app_hook_contract_missing, refused_missing_runtime_proof

source-first realistic command: npm --prefix mcp/synthi-mcp run proof:agent-split:source-first:realistic-raytrace
source-first realistic workspace: gpu-agent-split-1782683642905
source-first realistic result: failed closed at compile/proof gate before AI split verification
source-first realistic reason: ai_provider_account_suspended from provider preflight; acceptedForGpuHmr=false and no visual HMR artifact was produced by this rerun
source-first realistic timing: cold total_validator_wall_time=613146300ns, device_compile_wall_time=11617800ns, runtime_probe_time=601292900ns
source-first seed-only command: npm --prefix mcp/synthi-mcp run proof:agent-split:source-first:seed-only -> passed
source-first seed-only workspace: gpu-agent-split-1782683658537
source-first seed-only url: http://localhost:3000/workspace/gpu-agent-split-1782683658537

matrix refresh command: npm --prefix mcp/synthi-mcp run proof:validation-matrix -> process exceeded the shell timeout but completed and emitted a new ledger
matrix refresh proof: gpu-validation-matrix-ledger:sha256:99c1f2bfcc7767b4d7c209477787bb9e5a40cc087d24bddb75c8f741f4329e14
matrix refresh json: mcp/synthi-mcp/.gpu-hmr-test-logs/validation-matrix/gpu-hmr-validation-matrix-20260628T220032Z.json
matrix refresh summary: rowCount=56, acceptedFullRuntimeGpuHmrRows=14, scopedFullRuntimeGpuHmrRows=14, broadFullRuntimeGpuHmrRows=0, refusalProvenRows=29
historical MIOpen row hash in that superseded matrix: sha256:c69995d9009b1146ffe358f89dbc195133d174de81038da791d25b6d0ae34201, outcome=refusal_proven, proofChain=real_rocm_strict_runtime_refusal, sourceTreeTransport=source_tree_transport_evidence_accepted, missingDependency=missing_dependency_refusal_evidence
```

## 2026-06-28 Continuation Checkpoint

The validator fast-path diagnosis is now recorded in the proof plan: the interactive path must stay `edit -> compile -> load -> epoch publish -> visible change`, while hashing, PNG decode, pixel diff, ledger recompute, matrix ingestion, and proof packaging move behind an asynchronous proof worker. This is a performance and orchestration requirement only; it does not relax strict proof gates.

Latest 2026-06-28 follow-up after subagent-audited source-first and large-ROCm reruns:

```text
subagents used: source-first/no-precompiled path audit, large ROCm ML progression audit, and strict missing-dependency/matrix row audit
verification: npm --prefix mcp/synthi-mcp run proof:visual-proof-worker:self-check -> passed
verification: npm --prefix mcp/synthi-mcp run proof:artifact-cas:self-check -> passed
verification: npm --prefix mcp/synthi-mcp run proof:visual-evidence:self-check -> passed
verification: npm --prefix mcp/synthi-mcp run proof:agent-split:source-first:self-check -> passed
verification: node --check mcp/synthi-mcp/scripts/gpu-hmr-real-rocm-repo-validation.mjs -> passed
verification: node mcp/synthi-mcp/scripts/gpu-hmr-real-rocm-repo-validation.mjs --self-check -> passed
verification: npm --prefix mcp/synthi-mcp run proof:runtime-profile:self-check -> passed
verification: node node_modules/vitest/vitest.mjs run tests/unit/gpu_hmr_runtime_proof.test.ts from mcp/synthi-mcp -> 279 passed
verification: node --check mcp/synthi-mcp/scripts/lib/gpu-hmr-validation-matrix-ledger.mjs -> passed
verification: node --check mcp/synthi-mcp/scripts/tests/gpu-hmr-validation-matrix-ledger-smoke.mjs -> passed
verification: node mcp/synthi-mcp/scripts/tests/gpu-hmr-validation-matrix-ledger-smoke.mjs -> passed
verification: npm --prefix mcp/synthi-mcp run proof:validation-matrix:self-check -> passed
verification: npm --prefix mcp/synthi-mcp run proof:validation-matrix -> passed
verification: npm --prefix mcp/synthi-mcp run proof:validation-matrix:history -> passed
source-first seed-only command: npm --prefix mcp/synthi-mcp run proof:agent-split:source-first:seed-only -> passed
source-first seed-only workspace: gpu-agent-split-1782675324866
source-first seed-only url: http://localhost:3000/workspace/gpu-agent-split-1782675324866
source-first seed-only artifact: mcp/synthi-mcp/.gpu-hmr-test-logs/agent-split-artifacts/gpu-agent-split-1782675324866/agent-split-seed-results.txt
source-first realistic command: npm --prefix mcp/synthi-mcp run proof:agent-split:source-first:realistic-raytrace -> failed closed before AI split verification
source-first realistic workspace: gpu-agent-split-1782675331957
source-first realistic artifact: mcp/synthi-mcp/.gpu-hmr-test-logs/agent-split-artifacts/gpu-agent-split-1782675331957/agent-split-results.txt
source-first provider diagnostic: source-first-provider-diagnostic:sha256:dec0f1aa6adfa3903bac78832b4ce974095b4b6bdce72f69df61e8bad54e002a
source-first provider reason: ai_provider_account_suspended
source-first provider verdict: acceptedForGpuHmr=false, gpuHmrSuccess=false, canSatisfyRuntimeProof=false
source-first realistic timing: cold failed proof gate total_validator_wall_time=449938600ns, device_compile_wall_time=7142200ns, runtime_probe_time=442464100ns
source-first visual proof: none for this rerun because AI split did not complete; the existing accepted source-first realistic raytrace visual rows remain the current visual proof authority
large ROCm command: npm --prefix mcp/synthi-mcp run proof:real-rocm:large-ml-miopen -> expected fail-closed refusal
large ROCm slug: gpu-real-rocm-MIOpen-20260628193652
large ROCm result: mcp/synthi-mcp/.gpu-hmr-test-logs/real-rocm-results/gpu-real-rocm-MIOpen-20260628193652.json
large ROCm runtime proof: gpu-runtime-proof:sha256:f5e78adb4ca5011aa8c003736976329fb22026d5ea6684f5e903f5d2980a508c
historical large ROCm matrix row: historical-row-sha256:c44445aa3738bbc7a90eb134f5fab2b7730e90ce0ae13ee3f922d8309f89b7c4
large ROCm matrix proof ids: gpu-ledger-proof:sha256:d46f7e2837b3ca0f6bfbcb5e3bee20836dbea96851204635180c9f76c1fe1f0c, gpu-runtime-proof:sha256:f5e78adb4ca5011aa8c003736976329fb22026d5ea6684f5e903f5d2980a508c, real-rocm-validation:sha256:369c0c2aec2cbdd1f093cc79d9c7ddef854b515c0508cc1f5b967b748e422d34
large ROCm target progression: target-progression-ledger:sha256:7b52dfda8ef860ed877bcc2a049fd42c3885724f45496fb3cbfd755ee9bbe226, entryStatus=fail
large ROCm source transport: cas_shared_volume, hotPathOptimized=true, acceptedAsTransportEvidence=true, sharedMountCount=4, worker_file_count=7807, source_tree_listing_hash=sha256:91d1b933061ae6b6005e7f7b5ec2b47936f4868bad1254da3bbf55dabd5d749c, source_tree_cas_hash=sha256:5203d3f73980dcbdfe4b2a45cb7824af7a7f09d148af2920a0f7d4f2b35ed916, blockingGaps=[]
large ROCm upstream refusal: missing_build_dependency half/half.hpp, upstream_build_failed, upstream_run_not_started_after_build_failure
large ROCm missing-dependency probe: schema=synthi.real_rocm.missing_dependency_probe.v1, status=missing_dependency_refusal_evidence, dependency=half/half.hpp, missing_header_count=1, acceptedForGpuHmr=false, gpuHmrSuccess=false, canSatisfyRuntimeProof=false, blockingGaps=missing_build_dependency,missing_dependency:half_half.hpp,missing_header:half_half.hpp
large ROCm source-delta execution: real-rocm-source-delta-execution:sha256:518087b65ec428e3510323bccacc6bc4ed906cfda3815e674ee04c9bacda295b, phase_count=3, accepted=true
large ROCm visual proof: none; this compute/upstream-lifecycle profile has no frame-gated visual oracle and screenshot attempts captured no frame
large ROCm app-hook materialization: app_hook_materialization_incomplete, sidecarBackend=opencl, outputOracleMaterialized=false, gaps=app_hook_materialization_output_oracle_contract_missing,app_hook_materialization_contract_not_declared,app_hook_materialization_epoch_publication_candidate_missing,app_hook_materialization_host_identity_candidate_missing,app_hook_materialization_output_oracle_candidate_missing
previous validation matrix before the runtime-adapter rerun: gpu-validation-matrix-ledger:sha256:c5b74ecb25b0eca0e39b6ff4540ae24282191685589c1cf3866622a6aad08127
previous validation matrix json before the runtime-adapter rerun: mcp/synthi-mcp/.gpu-hmr-test-logs/validation-matrix/gpu-hmr-validation-matrix-20260629T112859Z.json
latest matrix summary: 56 rows, 14 accepted full-runtime GPU HMR, 0 broad library-agnostic full-runtime GPU HMR, 14 scoped full-runtime GPU HMR, 29 refusals, 7 cold splits, 2 deterministic fission, 3 visual profiles, 1 preflight-only row
latest history audit: gpu-validation-matrix-ledger:sha256:aa905942109909b5181c6236cb348a68710ebc667ac8f8dde7d572385c7e349c, json=mcp/synthi-mcp/.gpu-hmr-test-logs/validation-matrix-unproven-audit/gpu-hmr-validation-matrix-20260629T113226Z.json, 678 rows with 622 historical unproven rows included
```

The first dev-loop split is now implemented at the MCP wait boundary: non-strict `synthi_wait_hmr` responses that reach `applied` can return `proof_pending=true` plus a typed `gpu_hmr_dev_loop` block. That block explicitly says the response is `hmr_fast_path_only_not_gpu_hmr_acceptance`, with `accepted_for_gpu_hmr=false` and `gpu_hmr_success=false`. Strict callers that pass `requiredGpuProofState` or `requireGpuFullRuntimeProof` still fail closed with `gpu_hmr_proof_insufficient` until the requested proof ladder validates.

Strict proof waits now include generic post-apply timeout intelligence. Once HMR reaches `applied`, a matching observed proof slice that cannot structurally satisfy the requested strict proof state can fail closed immediately with `gpu_proof_wait.status=failed_fast` and `proof_wait_timeout_intelligence.evidence_authority=strict_proof_wait_timeout_intelligence_not_gpu_hmr_acceptance`. Missing proof and lower-rank partial proof still wait for later valid proof material, so this reduces wasted validator wall time without weakening acceptance. Real ROCm proof scheduling now also records `skip_async_runtime_waits=true` only when upstream lifecycle evidence already proves runtime stages are absent; the matrix accepts that flag only as refusal evidence and rejects forged skip claims that lack fast-fail scheduling plus the upstream-runtime-absent blocker.

Large real ROCm app-hook materialization is now surfaced as a generic evidence-only facet, not a success shortcut. The runner derives `real_rocm_app_hook_materialization` from profile obligations, source-delta execution, device-sidecar candidates, compile-bridge evidence, output-oracle materialization, and per-stage plans for `artifact_transport`, `epoch_publication`, `dispatch_trace`, `host_identity`, and `output_oracle`. Retained reports, strict runtime proof artifacts, proof summaries, matrix rows, and large-ROCm per-target coverage now preserve the facet. The matrix accepts well-formed incomplete materialization as refusal/planning evidence, but rejects forged facets that claim GPU HMR, runtime-proof, or dispatch authority.

Runtime-profile adapters now emit generic content-addressed result manifests and the real ROCm runner can import them as evidence-only bridge facets. `gpu-hmr-runtime-profile-proof.mjs --result-path` writes `synthi.gpu_hmr.runtime_profile_adapter_result.v1` with captured runner output hashes, proof JSON byte hashes, and strict runtime-proof summary fields. Real ROCm profiles can declare that result path through runtime-profile fields or env, but the imported `synthi.real_rocm.runtime_profile_adapter_result_bridge.v1` facet remains `acceptedForGpuHmr=false`, `gpuHmrSuccess=false`, and `canSatisfyRuntimeProof=false`. It connects adapter evidence to the audit trail without replacing observed artifact transport, epoch publication, dispatch trace, host identity, output oracle, firewall proof, or accepted strict runtime proof closure.

Generic transport groundwork was added in commit `20398e6b3 feat(gpu-hmr): add artifact cas locator contract`:

```text
schema: synthi.cas.artifact_locator.v1
purpose: content-addressed artifact locator/transport integrity only
not proof: CAS locator acceptedForGpuHmr=false, gpuHmrSuccess=false
checks: sha256/artifact id normalization, readable-byte hash verification, realpath root-escape refusal, snake_case/camelCase GPU HMR success-claim refusal, serialized fallback gap reporting, visual transport metadata stays non-authoritative
2026-06-28 extension: CAS locators can now be portable across container mount namespaces. Producers may omit the producer-local absolute `storage.localPath`; consumers resolve the content-addressed `sha256/<prefix>/<digest>` relative path under their own allowed CAS root, then verify readable byte length and SHA-256 before accepting transport evidence. Optional shared mount metadata records generic roles such as worker/MCP/frontend and rejects forged mount paths, but it remains `shared_artifact_addressing_only`, not GPU HMR proof authority.
2026-06-28 real ROCm source-tree transport: commit `f6d116db4 fix(gpu-hmr): ledger real rocm source tree transport` adds `synthi.real_rocm.source_tree_transport.v1` evidence with Git tree/listing identity, manifest hashes, optional CAS artifact validation, and explicit transport gaps. The matrix treats this as `source_tree_transport_evidence_accepted` only; `acceptedForGpuHmr=false`, `gpuHmrSuccess=false`, `canSatisfyRuntimeProof=false`, and `canSatisfyDispatchProof=false`.
2026-06-28 shared source-tree transport: frontend, MCP, and worker compose services now share `/var/lib/synthi/artifact-cas`, and the current MIOpen run used `cas_shared_volume` instead of `docker_cp` for source-tree staging. The runner can use explicit shared-mount env or the compose-default local root `mcp/synthi-mcp/.gpu-hmr-shared-cas`, with `SYNTHI_REAL_ROCM_DISABLE_DEFAULT_SOURCE_TREE_CAS=1` available for non-compose deployments. The worker inspected `/var/lib/synthi/artifact-cas/source-trees/MIOpen/06977176afd94476c18d5290f21cb40745bb73a9`, matched the expected Git commit and origin, counted 7807 files, and recorded `hotPathOptimized=true`. This is still source-tree transport evidence only and cannot satisfy runtime proof, dispatch, epoch, host identity, app-hook, or output-oracle gates.
2026-06-28 previous source-tree CAS root checkpoint: the code path added in that checkpoint made the source-tree transport facet resolve its CAS root from the same generic shared-source-tree producer mount used for repo staging, instead of requiring a separate CAS-root env var. Rerun `gpu-real-rocm-MIOpen-20260628-cas-transport-rerun` recorded `transferOperation=cas_shared_volume`, `transportKind=cas_shared_volume`, `hotPathOptimized=true`, `acceptedAsTransportEvidence=true`, `sharedMountCount=4`, `sharedStorageAccepted=true`, `sourceTreeCasRootSource=resolved_source_tree_mount_producer_root`, `blockingGaps=[]`, and `failedGates=[]`. The run still refused GPU HMR with runtime proof `gpu-runtime-proof:sha256:fc803c1bc7d904f3987e91eab15b1ed50afded53b44d3245bdcb7155c5c67e8c` because no runtime artifact transport, epoch publication, dispatch trace, host identity, app-hook/runtime-oracle proof, or post-dispatch output/visual oracle proof was observed.
2026-06-28 visual CAS validation follow-up: the validation matrix now validates visual `synthi.cas.artifact_locator.v1` manifests with readable-byte SHA-256 checks before it uses CAS transport as visual evidence. A smoke row with no local visual paths now decodes before/after/diff PNGs from CAS-only `sha256/<prefix>/<digest>` locators and accepts only after the image bytes match the manifest; a forged CAS relative path remains `unproven` with `visual_artifact_cas_locator_validation_failed`. This is transport/oracle-byte validation only and remains non-authoritative without strict runtime-ledger closure.
verification: npm --prefix mcp/synthi-mcp run proof:artifact-cas:self-check -> passed
verification: npm --prefix mcp/synthi-mcp run proof:visual-evidence:self-check -> passed
verification: npm --prefix mcp/synthi-mcp run proof:visual-proof-worker:self-check -> passed with portable CAS manifests
```

Async visual proof worker hardening was added without project-specific branches:

```text
commit: d9c0aeb05 fix(gpu-hmr): bind async visual worker identity
commit: 708b1a3b4 fix(gpu-hmr): guard roi early exits with tile evidence
commit: 016eabef3 fix(gpu-hmr): schedule visual proof workers concurrently
commit: bbc18c1ce fix(gpu-hmr): recompute visual pairs with worker metrics
current checkpoint: direct worker paths and diff output paths require explicit allowed roots; readable CAS paths are realpath-bound before bytes are consumed; the parent wrapper now terminates worker threads on success/error/timeout and the worker thread closes its parent port after posting the proof result
worker identity gate: accepted-looking async visual worker results now require proof_ready, off-main-thread execution, a matching sha256 worker executable manifest hash covering the worker entry, parent wrapper, and artifact-CAS helper, plus a bound native image dependency manifest for the sharp/libvips decode/diff backend
ROI/tile gate: unchanged ROI hashes can skip full-frame diff only when tile hashes prove no changed tiles; outside-ROI, ambiguous tile changes, or disabled tile hashing force full-frame visual proof. Tile and ROI evidence now also carries typed binding hashes tied to before/after encoded hashes, raw frame hashes, dimensions, tile-list hashes, ROI hashes, and optional deterministic visual-mode hash.
runner scheduling: agent-split visual candidate comparisons now use bounded concurrent worker-thread tasks instead of serially awaiting every post-HMR frame comparison; `SYNTHI_GPU_HMR_VISUAL_WORKER_PARALLELISM` and profile `visualProof.workerParallelism` control the cap, and the runner records `synthi.gpu_hmr.visual_delta_worker_scheduling.v1` as support-only evidence
matrix recompute: validation-matrix before/after visual-pair metrics now use async visual-worker output (`matrix_async_visual_worker_rgba`) instead of a local matrix-process full pair RGBA loop. Worker timeout/failure is covered by a generic smoke fixture and remains fail-closed through `visual_pair_async_worker_recompute_not_accepted`.
matrix summary: async visual worker summaries retain stable executor identity, executable manifest hash/schema/module count, and still strip volatile thread IDs
not proof by itself: async worker events, native dependency identity, CAS locators, ROI hashes, tile hashes, incremental binding hashes, and visual-worker scheduling evidence still remain acceptedForGpuHmr=false and gpuHmrSuccess=false unless the strict runtime ledger closes
verification: node --check mcp/synthi-mcp/scripts/gpu-hmr-agent-split-workspace-test.mjs -> passed
verification: node --check mcp/synthi-mcp/scripts/lib/gpu-hmr-validation-matrix-ledger.mjs -> passed
verification: node --check mcp/synthi-mcp/scripts/tests/gpu-hmr-validation-matrix-ledger-smoke.mjs -> passed
verification: npm --prefix mcp/synthi-mcp run proof:agent-split:source-first:self-check -> passed
verification: npm --prefix mcp/synthi-mcp run proof:visual-proof-worker:self-check -> passed
verification: npm --prefix mcp/synthi-mcp run proof:artifact-cas:self-check -> passed
verification: npm --prefix mcp/synthi-mcp run proof:visual-evidence:self-check -> passed
verification: npm --prefix mcp/synthi-mcp run build -> passed
verification: node mcp/synthi-mcp/scripts/tests/gpu-hmr-validation-matrix-ledger-smoke.mjs -> passed, gpu-validation-matrix-ledger:sha256:066528e1509cdee8dbcc7f16dd51ec2ed3b3e45b2d0cf81e34b90d02a417b226
verification: node mcp/synthi-mcp/scripts/gpu-hmr-validation-matrix-ledger.mjs --self-check -> passed during the preceding hardening checkpoint
verification: validation-matrix smoke and CLI self-check components passed after source-first generated-artifact namespace/hash-overlap hardening, source-tree manifest hardening, generic real-ROCm app-hook materialization surfacing, source-first async/CAS support gating, matrix visual-worker recompute, content-addressed external visual artifacts, CAS-validated visual locator ingestion, and external-header prerequisite ingestion; latest generated validation matrix proof after external-header matrix ingestion gpu-validation-matrix-ledger:sha256:425a5f02cc756ee518d41fdb8ce71398ed8660b34025eb65f41a92e9f7bd3b62
transport note: the agent-split proof runner MCP client now sends newline-delimited JSON for the installed Node MCP SDK and tolerates both newline-delimited and Content-Length-framed responses. A direct docker MCP initialize probe passed with the newline path. This is transport compatibility only, not proof authority.
missing-dependency probe note: large real ROCm reports now preserve generic read-only `synthi.real_rocm.missing_dependency_probe.v1` evidence for upstream missing headers/tools/packages. The probe inspects worker paths only, never installs or shims dependencies, is recorded into runtime proof artifacts/proof summaries/matrix rows, and blocks GPU HMR success anywhere it appears. This keeps serious-project prerequisite failures explicit without turning them into success evidence.
```

Real ROCm diagnostic visual evidence now has a generic supplemental-only path. Screenshots that are readable and nonblank but not frame-gated after an epoch dispatch are retained for diagnostics, while runtime visual proof counts, proof summaries, target-progression accepted visual counts, visual proof-artifact limitations, and matrix small-oracle visual fallback use only non-supplemental runtime visual evidence. This preserves visual inspection without letting preview screenshots stand in for post-dispatch output-oracle proof.

The proof plan now tracks source-first uncompiled project validation as the next user-facing axis. The intended test path starts from an uncompiled source tree/workspace, lets AI propose GPU split candidates, compiles through the normal backend toolchain, publishes a runtime epoch, and requires post-epoch visual or compute proof. Fixture/profile runs can only serve as smoke coverage when they exercise the same generic source-first machinery; fixture names, target strings, and profile IDs remain non-authoritative.

Fresh source-first realistic ROCm raytrace visual proof was rerun from profile-declared source files rather than a precompiled GPU artifact, after hardening source-first provenance against empty initial manifests, stale proof IDs, fixed split counts, generated artifact namespace forgery, pre-existing generated artifact path/content smuggling, and fixture-only source authority:

```text
command path: mcp/synthi-mcp/scripts/gpu-hmr-agent-split-workspace-test.mjs
slug: source-first-cold-cas-realistic-20260629
workspace url: http://localhost:3000/workspace/source-first-cold-cas-realistic-20260629
artifact dir: mcp/synthi-mcp/.gpu-hmr-test-logs/agent-split-artifacts/source-first-cold-cas-realistic-20260629
profile: agent-realistic-raytrace-scene
fixture: realistic-raytrace
source mode: profile_source_files, source tree `src/main.cpp` plus `src/scene_config.h`, source_hash=sha256:057c83a0a2af53eea19ba3f189836978c804a0048dfd2436bb2cc41bc882662e
worker arch: gfx1201, selected from worker-container evidence
source-first proof id: agent-split-source-first-ingestion:sha256:dbef11d86091ba64402333b6598f208c619f231474ced92da53fed8d15e1920f
source-first matrix gate: accepted=true, proof_id_matches=true, initial_manifest_hash=sha256:4a2a92e6b71b2be9185ab441d2068706e0874bc6a7257afc467c5265283d9672, source_tree_manifest_hash=sha256:4a2a92e6b71b2be9185ab441d2068706e0874bc6a7257afc467c5265283d9672, source_tree_manifest_hash_matches=true, initial_source_hash_matches=true, generated_artifact_count=5, target_id=generated-gpu-split:027b3898466b27e6e28119e7, sidecar_hash=sha256:77765997d2fe1763bf12ebd195db8f8dea5220e6ab05f09918fa6e41f2975cc5, compile_manifest_hash=sha256:ab746efa71a702f5b7cc292a29bb5041d1478ecef6f3eb83dc77ba8b2d999c62, proofAuthority=source_first_ingestion_provenance_only_not_runtime_proof, acceptedForGpuHmr=false, gpuHmrSuccess=false
source-first evidence: profile-declared `src/main.cpp` source had no Synthi ABI, MCP compiled with `use_ai_split=true`, the initial compile manifest carried the declared source hash, the worker produced structured GPU split/sidecar evidence, no pre-existing `.synthi` generated artifact path was present in the initial manifest, no initial file content hash overlapped the later generated artifact/sidecar/compile-manifest hashes, and generated split artifacts were content-addressed after the split/compiler path produced `.synthi/generated/gpu/device.hip`. The profile now carries `source.files`; every declared source-tree file must carry an explicit sha256 content hash and be present in the initial compile manifest, and forged rows where the profile source tree differs from the seeded compile files are refused with `source_first_source_tree_manifest_mismatch`.
source-first async/CAS support: the `source_first_uncompiled_project_validation` coverage row is accepted only when strict full-runtime visual proof is present and the row also carries support-only `asyncVisualCasBundle.accepted=true`, `proofAuthority=async_visual_metrics_and_transport_only`, `acceptedForGpuHmr=false`, `gpuHmrSuccess=false`, `proofReady=true`, `offMainThread=true`, `transportAccepted=true`, matrix-validated before/after/diff CAS hashes, and tile evidence. Smoke fixtures prove that a strict-runtime source-first row with no CAS transport remains excluded, a CAS-only visual row can decode validated PNG bytes from CAS, and a forged CAS locator remains unproven.
source-first multi-file follow-up: the packaged realistic raytrace profile declares a two-file source tree, `src/main.cpp` (`sha256:057c83a0a2af53eea19ba3f189836978c804a0048dfd2436bb2cc41bc882662e`) and `src/scene_config.h` (`sha256:347d94f7f096ecbfaa1bc25817ebb09a7f1e1b50fd727d6e05d7a38eb2fb96f6`). The deterministic splitter now preserves generic local quoted-include constant closure, so header-defined `PIXEL_COUNT`-style constants do not require scenario-specific hardcoding.
visual inspection: before/after/diff PNGs were opened locally on 2026-06-29; the scene is nonblank and shows a faceted diamond, small stones, slab reflections, wall/awning geometry, cafe bulbs, and car geometry with visible post-epoch diffs
hot1 row: historical-gpu-validation-matrix-row-sha256-df44f7e0790a508aac703b3746cb2f80be2ff907a753d16a2bf7d7083adcbdff
hot1 proof ids: agent-split-run-mode-proof:sha256:29df6b1b91f01284ab71108c4f1edea8c797e0ddf8a2c9677c0a18f82fd9d3e2, gpu-ledger-proof:sha256:b528a70627bc3152fc82a053a122c8c10118b0f330bffb72f4c8bbb42a4f765b, gpu-runtime-proof:sha256:d545c64da1874fe605ed9462ff9b130d83b2ee272c4ae23c447fcfc3cc55c1b5
hot1 visual delta: changed=81.96%, mean_abs_delta_8bit=17.90, selected_frame_capture_after_epoch_dispatch=true
hot1 timing: device_compile_wall_time=23597100ns, runtime_probe_time=7455927300ns, total_validator_wall_time=7479596100ns
hot2 row: historical-gpu-validation-matrix-row-sha256-be05fd92aaee4bc25fcdb00a3e061fd5e86c8f185078529c93493545f5f7d595
hot2 proof ids: agent-split-run-mode-proof:sha256:fd1c143a4cc3efe5244ee689cc27641970855f3c40d1003fa076ff8be50df606, gpu-ledger-proof:sha256:1c1b3e34b5e35372011426d966ddab89310c57b43ce9cd6261b9e6447adece8d, gpu-runtime-proof:sha256:d87d8195217ea17b5c069a5a7ee8b4f1ddd233f0c5c641ff095b24887de870f9
hot2 visual delta: changed=99.86%, mean_abs_delta_8bit=37.40, selected_frame_capture_after_epoch_dispatch=true
hot2 timing: device_compile_wall_time=17633400ns, runtime_probe_time=9834452900ns, total_validator_wall_time=9852162200ns
negative edit refusal row: historical-gpu-validation-matrix-row-sha256-84347a9a017de043fc6a0abec4fffd786a0e7aa84aeca62525b2210c769ac26e, proof=agent-split-negative-edit-refusal:sha256:70207e3fd1ba9f0206b35bb2dd24da8ae143f0d12ce582f153b86fe3cbafd27f
deterministic fission: accepted per_kernel_hmr for render_realistic_raytrace, row=historical-gpu-validation-matrix-row-sha256-ab0cb77eb89e7aa8061f3a10a7a3401f4288b0615d39b276cb9ba40ef45c767e, selected verifier evidence `evidence:fission-verifier-report:generated-split:sha256:b8c8fa5f69c6c24e7fa9c287fce4d423df516cc2a1b0c2813fb26e6eaec2b91e`
scope: source-first profile-backed generated ROCm/HIP preview visual evidence only; the latest default matrix binds the accepted rows to row-bound proof IDs and source-first provenance. This is not arbitrary project/library acceptance and not a claim that fixture/profile identity authorizes success.
```

The source-first runner and matrix self-check now both cover forged success rows where a generated artifact path is outside the generated namespace and where an ordinary initial path such as a build cache carries the same content hash as the later generated artifact. The runner refuses the forged ordinary-path artifact before accepted provenance is emitted, and matrix recomputation still keeps those rows `unproven` with source-first ingestion refused.

Current source-first user-path scripts:

```text
npm --prefix mcp/synthi-mcp run proof:agent-split:source-first
npm --prefix mcp/synthi-mcp run proof:agent-split:source-first:self-check
npm --prefix mcp/synthi-mcp run proof:agent-split:source-first:seed-only
npm --prefix mcp/synthi-mcp run proof:agent-split:source-first:realistic-raytrace
```

Latest source-first seed-only user-path check:

```text
command: npm --prefix mcp/synthi-mcp run proof:agent-split:source-first:seed-only
result: passed, workspace seeded from source without a precompiled project
current workspace after source-first follow-up: gpu-agent-split-1782741683475
current url: http://localhost:3000/workspace/gpu-agent-split-1782741683475
previous workspaces: gpu-agent-split-1782703995585, gpu-agent-realistic-raytrace-20260629-seed-only-user-path, gpu-agent-split-1782675324866, gpu-agent-split-1782662705070, gpu-agent-split-1782662336315, gpu-agent-split-1782646543988, gpu-agent-split-1782641505949, gpu-agent-split-1782625580501
fixture/profile: flow default source fixture
source hash: sha256:9363600ec85c4e9da9ad780cefbe83cb6117ab55976d4eb2ebdb0e3eb6cfde3a
latest result artifact: mcp/synthi-mcp/.gpu-hmr-test-logs/agent-split-artifacts/gpu-agent-split-1782741683475/agent-split-seed-results.txt
interpretation: this verifies the source-first user entry point and workspace seed path only. It is not GPU HMR acceptance and does not bypass AI split, runtime load, epoch publication, visual proof, output oracle, or strict ledger closure.
```

Earlier large ROCm ML validation, superseded by the external-header and runtime-adapter-check notes above, was started against the explicit MIOpen profile, not a hardcoded target branch:

```text
profile: real-rocm-miopen-activation-large-ml
latest rerun slug: gpu-real-rocm-MIOpen-20260628193652
result: strict refusal, not GPU HMR acceptance
retained result: mcp/synthi-mcp/.gpu-hmr-test-logs/real-rocm-results/gpu-real-rocm-MIOpen-20260628193652.json
runtime proof artifact: gpu-runtime-proof:sha256:f5e78adb4ca5011aa8c003736976329fb22026d5ea6684f5e903f5d2980a508c
proof ledger: gpu-ledger-proof:sha256:d46f7e2837b3ca0f6bfbcb5e3bee20836dbea96851204635180c9f76c1fe1f0c
validation proof: real-rocm-validation:sha256:369c0c2aec2cbdd1f093cc79d9c7ddef854b515c0508cc1f5b967b748e422d34
historical matrix row: historical-row-sha256:c44445aa3738bbc7a90eb134f5fab2b7730e90ce0ae13ee3f922d8309f89b7c4 in gpu-validation-matrix-ledger:sha256:425a5f02cc756ee518d41fdb8ce71398ed8660b34025eb65f41a92e9f7bd3b62
upstream lifecycle: configure_exit_code=0, build_exit_code=2, run_exit_code=not-run
source-delta execution: first split, hot delta 1, hot delta 2, and negative edit compile projections executed from profile-declared source deltas
upstream blocker: `MIOpenDriver` build reached the source compile path and failed on `half/half.hpp`; no compatibility shim, symlink, or vendored header was added
source-tree transport: status=source_tree_transport_evidence_accepted, transferOperation=cas_shared_volume, transportKind=cas_shared_volume, hotPathOptimized=true, acceptedAsTransportEvidence=true, sharedMountCount=4, sharedStorageAccepted=true, sourceTreeCasRootSource=resolved_source_tree_mount_producer_root, listingHash=sha256:91d1b933061ae6b6005e7f7b5ec2b47936f4868bad1254da3bbf55dabd5d749c, casContentHash=sha256:5203d3f73980dcbdfe4b2a45cb7824af7a7f09d148af2920a0f7d4f2b35ed916, blockingGaps=[], failedGates=[]; acceptedForGpuHmr=false and cannot satisfy runtime or dispatch proof
missing-dependency probe: status=missing_dependency_refusal_evidence, dependency=half/half.hpp, missingHeaderCount=1, acceptedForGpuHmr=false, gpuHmrSuccess=false, canSatisfyRuntimeProof=false
visual artifacts: no MIOpen frame-gated visual artifacts were captured in this shared-transport rerun; screenshots=[] in the retained report. This is correct for a compute/upstream-lifecycle refusal because no MIOpen post-epoch dispatch/output target was observed.
strict blockers: no Synthi runtime artifact transport, epoch publication, dispatch trace, host identity, app-hook contract, or post-dispatch output/visual oracle was observed; runtime capability preflight still reports ROCm array/texture capability gaps
app-hook materialization: app_hook_materialization_incomplete
proof scheduling: long waits were bounded with `skip_async_runtime_waits=true` once upstream lifecycle, output oracle, and app-hook obligations made full runtime proof structurally impossible; the row remains `refusal_proven`
```

Historical profile-backed realistic ROCm raytrace visual GPU HMR was rerun after routing agent-split visual deltas through the generic async/CAS visual proof bundle. The corrected MCP container entry is `/app/dist/index.js`. This run is retained as supporting historical evidence; the latest default matrix-selected realistic raytrace authority is the source-first run above:

```text
profile: agent-realistic-raytrace-scene
slug: gpu-agent-profile-realistic-raytrace-20260627-agent-cas-worker2
workspace url: http://localhost:3000/workspace/gpu-agent-profile-realistic-raytrace-20260627-agent-cas-worker2
artifact dir: mcp/synthi-mcp/.gpu-hmr-test-logs/agent-split-artifacts/gpu-agent-profile-realistic-raytrace-20260627-agent-cas-worker2
visual inspection: before/after/diff PNGs were opened locally and re-opened on 2026-06-29; the scene is nonblank and shows a faceted diamond, small stones, glossy slab reflections, wall/awning geometry, cafe bulbs, and a car with visible post-epoch diffs
async/CAS visual transport: each selected hot-delta visual artifact carries 3 `synthi.cas.artifact_locator.v1` records for before/after/diff, with `visualArtifactTransportEvidence.accepted=true`, `acceptedForGpuHmr=false`, and `proofAuthority=transport_integrity_only_not_visual_or_ledger_proof`
historical hot1 row hash: sha256:a0df2300f4410e37f66b6b6bf99814f3794b5a19d2b79e9a62acddec22af81b4
hot1 proof ids: agent-split-run-mode-proof:sha256:cc383eacf9eb781eca84d8d61940ab1fefe8ca650ca73f80a75d4d3163dcbea1, gpu-ledger-proof:sha256:e030e2412f9d50594f15d99f849a63772d6e0c4ff01e49df84dac2abce4a5231, gpu-runtime-proof:sha256:089697f498eabe5f59548725a0d97da10717dc18fd9a262da1398b1367ba560a
hot1 visual delta: changed=82.64%, mean_abs=17.89, control_changed=0.00%, control_mean_abs=0.02
hot1 timing: device_compile_wall_time=87520100ns, runtime_probe_time=6765742200ns, total_validator_wall_time=6853352500ns
historical hot2 row hash: sha256:f3cdc75c6b776e7aa329044bca871cbfdc30edcfbd31e9eb2afc4d549b5a66db
hot2 proof ids: agent-split-run-mode-proof:sha256:03f7de7e9956197e2f3cd1f7d29bfeb3e546e5644610f2d6c210296f4cf0acb6, gpu-ledger-proof:sha256:12586c613fbc76d73b8ca5395ef79f18a9296d5f33970b957a02fab4043f5409, gpu-runtime-proof:sha256:39768f789cccfa507f7207873b9574c1fd48d317abd3b6dbb83cbfabb414279a
hot2 visual delta: changed=99.87%, mean_abs=37.38, control_changed=0.00%, control_mean_abs=0.03
hot2 timing: device_compile_wall_time=90923600ns, runtime_probe_time=6032621500ns, total_validator_wall_time=6123677100ns
negative edit: ABI/layout-changing edit refused before GPU HMR acceptance
fission: deterministic verifier accepted per_kernel_hmr for render_realistic_raytrace
scope: generated_rocm_hip_preview_visual, scoped_profile only; this is not arbitrary HIP application/library acceptance
```

Latest validation matrix after these runs, the checkpointed MIOpen refusal, and the current external visual-profile rerun:

```text
proof id: gpu-validation-matrix-ledger:sha256:8d60a57c77aa390610f97884dc5499f7bb2c49dfb4f888d6de40b9a18fcb361b
json: mcp/synthi-mcp/.gpu-hmr-test-logs/validation-matrix/gpu-hmr-validation-matrix-20260629T213811Z.json
summary: 56 rows, 14 accepted full-runtime GPU HMR, 0 broad library-agnostic full-runtime GPU HMR, 14 scoped full-runtime GPU HMR, 14 all full-runtime rows, 29 structurally proven refusals, 7 cold splits, 2 deterministic fission, 3 visual profiles, 1 preflight-only row, 0 included unproven rows
scope breakdown: generated_rocm_hip_preview_visual: 2, hip_module_declared_compute_readback: 2, webgpu_declared_compute_readback: 2, webgpu_declared_pipeline_visual: 8
broad readiness: accepted=false, broadRuntimeRows=0, scopedRuntimeRows=14
self-check: validation-matrix smoke -> passed; node scripts/gpu-hmr-validation-matrix-ledger.mjs --self-check -> passed
MIOpen current row: historical-gpu-validation-matrix-row-sha256-16305e7aef533eb74ffd73e8fdda199da25aef72e27be2fbb6710b632d32b235 -> refusal_proven, acceptedForGpuHmr=false, gpuHmrSuccess=false
external visual profile row: threejs-webgl-shader-lava -> visual_profile_accepted only, row historical-gpu-validation-matrix-row-sha256-e6ab8e0597707e0db2d8d87c3b95fc5c14251a25e78a4712c4152e57b30fcdcf, acceptedForGpuHmr=false, gpuHmrSuccess=false, open gap=full_runtime_gpu_hmr_ledger_not_present
history audit: npm --prefix mcp/synthi-mcp run proof:validation-matrix:history -> passed, gpu-validation-matrix-ledger:sha256:aa905942109909b5181c6236cb348a68710ebc667ac8f8dde7d572385c7e349c, 678 rows with 622 historical unproven rows included
history audit json: mcp/synthi-mcp/.gpu-hmr-test-logs/validation-matrix-unproven-audit/gpu-hmr-validation-matrix-20260629T113226Z.json
history audit summary: 678 rows, 14 accepted full-runtime GPU HMR, 0 broad library-agnostic full-runtime GPU HMR, 14 scoped full-runtime GPU HMR, 14 all full-runtime rows, 29 refusals under the stricter structural gate, 7 cold splits, 2 deterministic fission, 3 visual profiles, 1 preflight-only row, 622 historical unproven rows
history audit scope breakdown: generated_rocm_hip_preview_visual: 2, hip_module_declared_compute_readback: 2, webgpu_declared_compute_readback: 2, webgpu_declared_pipeline_visual: 8
```

## Executive Status

Accepted local proof is scoped ROCm/HIP-profile proof on the AMD Radeon RX 9070 XT (`gfx1201`). CUDA was not validated on this machine.

Current accepted proof spans multiple scoped profiles, but it is not universal production acceptance and is not broad library-agnostic GPU HMR:

- generated/profiled ROCm/HIP device-artifact full-runtime proof-ledger acceptance for scoped proof profiles,
- a deterministic realistic ROCm/HIP raytrace visual workload with faceted diamond geometry, smaller stones, a wall/awning background, cafe bulbs, fixed 2x2 subpixel rays, secondary reflection/refraction probes, glossy car geometry, slab reflections, hot delta 1, hot delta 2 with a different edit, negative edit refusal, image-tool-inspected before/after/diff PNGs, and strict runtime-ledger artifacts,
- MCP preview visual HMR for generated ray-light and Flow workloads with cold split, hot delta 1, hot delta 2 with a different edit, and negative edit refusal,
- deterministic generated-split fission verification for ray-light `trace_light_rays`,
- HIPRT same-process CameraRays and MegaKernel direct-light-gain ray-traced visual proof artifacts are preserved only as source-adapted visual-profile evidence; because they disclose profile source adaptations, they are not accepted as no-shim full-runtime GPU HMR rows,
- external project rows now require typed external contract facets and content-addressed before/after/diff visual oracle hashes before they can count; the current ThreeJS WebGL shader-lava rerun is retained as typed external visual-profile evidence only, not as full-runtime GPU HMR,
- WebGPU Chrome/AMD runtime visual HMR proof for both an explicit-empty-layout WGSL shader/pipeline profile and an explicit-profiled pipeline profile with a real uniform bind group plus float32 vertex buffer runtime trace, each with cold/hot1/hot2-different-edit/negative run-mode coverage,
- WebGPU Chrome/AMD compute/readback full-runtime proof for an explicit profiled storage/uniform float32 WGSL compute pipeline, with raw mapped GPU bytes, schema/hash verification, data-derived PNG cards, hot delta 1, hot delta 2 with a different shader edit, negative ABI refusal, and accepted strict `runtimeProofArtifact` rows; this is scoped compute/readback acceptance, not broad WebGPU app or engine-cache acceptance,
- ROCm/HIP module-load/readback scoped full-runtime proof for declared HIP module profiles, compiling real `.hip` sources to HSACO inside the ROCm worker, loading the changed code object through `hipModuleLoadData`, resolving with `hipModuleGetFunction`, dispatching with `hipModuleLaunchKernel`, reading raw GPU bytes back, and rendering data-derived proof cards for hot delta 1 and hot delta 2 with a different edit. The current matrix counts these as two scoped full-runtime rows under `hip_module_declared_compute_readback` because each row carries an accepted strict `runtimeProofArtifact`; this remains non-acceptance for arbitrary HIP applications, frameworks, or libraries without app-hook, epoch, dispatch, host-identity, and output-oracle evidence.

Current fail-closed evidence also includes:

- large real ROCm ML infrastructure validation against upstream MIOpen, which attempts the upstream CMake/build/driver path under the native observer and emits rejected runtime diagnostic artifacts only, not an accepted strict runtime proof artifact; the current matrix-selected refusal records successful configure, recovered metadata, attempted build, executed source-delta compile projections, required app-hook/runtime-oracle obligations, and no full-runtime Synthi proof ledger success, artifact transport, epoch publication, dispatch trace, host identity, or post-dispatch output/visual oracle proof,
- real ROCm matrix multiplication validation against upstream `ROCm/rocm-examples`, which derives and syncs a source-backed buffer checksum oracle, observes the native HIP launch boundary, and is retained as a current real ROCm row alongside MIOpen in the generated validation matrix, but is refused because Synthi artifact transport, epoch publication, dispatch trace, host identity, and runtime output-oracle observation are missing,
- large real ROCm ML infrastructure validation against upstream `ROCm/composable_kernel`, which clones a 7,234-file serious HIP/C++ template project, derives a generic HIP source-bridge candidate for the GEMM example, and is retained as a current fail-closed matrix row, but is refused because the upstream target did not build, no Synthi artifact transport/epoch/dispatch/host identity/output-oracle proof was observed, and the output-oracle/app-hook obligations are explicitly missing,
- large real ROCm ML infrastructure validation against upstream `ROCm/hipBLASLt`, which clones and transfers a serious fused GEMM/GELU/AUX/bias library/sample tree into the ROCm worker and is retained as a current fail-closed matrix row; the latest run preserves the upstream compile summary and incomplete device-sidecar evidence, but refuses before build metadata because CMake cannot find Python development/module components and no Synthi artifact transport, epoch, dispatch, host identity, app-hook, or output-oracle proof is observed,
- negative/rejection evidence for HIPRT blank-frame direct-light-zero, OIDN HIP, Bevy, OpenCL, and Vulkan where proof is missing, blank, or the runtime dependency is incompatible.

Current strict matrix behavior deliberately downgrades older HIPRT warm visual artifacts that lack an embedded proof ledger and data-derived oracle-region proof. HIPRT matrix ingestion now recomputes the oracle region from the persisted before/after PNG pixels; JSON claims about a nonblank region are not accepted by themselves. Source-adapted HIPRT CameraRays and MegaKernel direct-light-gain reruns are classified as `visual_profile_accepted`, not full-runtime GPU HMR, because their runtime probe instrumentation discloses profile source adaptations. The MegaKernel direct-light-zero profile is a proven blank-oracle-region refusal, not a success. OIDN HIP runtime preflight is now split from OIDN HIP output proof; the latest live worker preflight refused because the declared HIPRT checkout/tool path was unavailable, while earlier real-checkout artifacts still show the ROCm 7 OIDN HIP device-library dependency mismatch. No symlink, ABI shim, fake ICD, or synthesized runtime was added.

The 2026-06-24/2026-06-25 continuation added these generic anti-overclaim gates:

- validation matrix row IDs are recomputed at query time and stale/mutated rows are removed from accepted coverage summaries,
- accepted rows must bind their matrix backend to the recomputed proof-ledger record backend,
- preflight backend evidence requires schema-correct typed backend/backend-family fields with field-level evidence refs, not raw strings plus generic refs; WebGPU preflight now emits the same typed backend contract shape as OpenCL/Vulkan/OIDN and remains preflight-only until shader-module epoch, pipeline recreation, and output-oracle proof exist; OIDN HIP runtime availability is tracked separately from OIDN HIP output proof,
- external project rows require a typed `synthi.gpu_hmr.external_project_contract.v2` facet with field-level evidence, manifest hash, runtime evidence refs, and explicit no-broad-claim flags.
- real ROCm acceptance now requires explicit observed runtime-capability preflight, typed output-oracle resolution, and explicit sidecar consistency/not-applicable facets; device-sidecar contracts are recomputed after runtime proof collection and can satisfy the sidecar gate only when artifact transport, epoch publication, dispatch trace, host identity, output oracle, and full-runtime proof are all observed,
- HIPRT and large real ROCm proof runners now detect GPU arch and ROCm prefix from the worker or explicit env, instead of defaulting to a local `gfx*` arch or `/opt/rocm` path,
- OIDN no-shim/no-symlink proof now comes from worker path inspection, ELF file-type checks, resolved paths, and sha256 hashes,
- visual profile coverage now requires typed profile evidence with exact row-bound proof IDs or evidence refs; target names, path substrings, and free-form Flow/ray-light evidence strings cannot satisfy the coverage gate,
- visual artifact evidence now resolves paths only inside allowed repo/log roots, records byte-level PNG hashes, verifies declared hashes, recomputes before/after pixel deltas from readable images, and rejects path escapes, forged hashes, blank after frames, blank diffs, and unrecomputed visual pairs,
- external visual-profile proof now recomputes deterministic visual controls from the declared mode or linked proof artifact. A serialized `deterministicVisualModeEvaluation.accepted=true` flag cannot satisfy the fixed-seed, frozen-camera, frame-boundary, swapchain-count, temporal, TAA, or denoiser gates by itself.
- validation matrix ledgers now include a proof-hashed `attemptHistory` section when `includeUnproven=true`, so the newest collected attempt for an attempt key remains machine-auditable even when canonical row selection keeps an older, more complete refusal as the selected row.
- Flow/ray-light visual profile coverage is no longer a hardcoded matrix table; coverage rows are derived only from accepted rows with typed `validationProfileEvidence` that is bound to the row proof IDs or evidence refs,
- runtime profile proof CLIs now fail closed unless a profile is explicitly selected by CLI/env or a packaged default is explicitly allowed for diagnostics,
- proof runner CLIs now fail closed by default when the runtime output proof is rejected; source-adapted HIPRT visual profiles and rejected OIDN preflights require explicit diagnostic allow flags and still cannot set `gpuHmrSuccess=true`.
- real ROCm strict proof waits now have generic timeout intelligence in the `wait_hmr` loop: after a diagnostic proof slice, proof-insufficient responses with terminal rejected runtime-proof material, missing proof states already backed by structural profile/output-oracle/app-hook blockers, or upstream configure/build lifecycle evidence that proves runtime stages cannot appear, emit refusal-only `real_rocm_proof_scheduling` / `timeout_intelligence_failure` evidence with missing runtime stages instead of burning the full HMR wait window. When the upstream lifecycle blocker proves runtime stages are absent, the runner can skip async runtime waits and records `proof_scheduling_skipped_async_runtime_wait`; the matrix validates this as refusal evidence only. Plain upstream run failure is not treated as runtime absence, and the matrix smoke test rejects forged timeout-intelligence aliases that claim GPU HMR success, runtime authority, or skip behavior without the required blockers.
- accepted full-runtime rows now expose `fullRuntimeEvidenceAuthority`; rows must carry a strict accepted runtime proof artifact. Backend-native recomputed ledger traces with loader, dispatch, output boundary, accepted oracle, and row-bound evidence refs are retained as supporting evidence only and cannot authorize GPU HMR success by themselves.
- WebGPU visual proof companion artifacts now carry row-bound `runModeCoverageSupport` derived from the recomputed proof ledger/runtime proof artifact. The support builder is generic over proof IDs, contract hashes, and artifact hashes; it is not tied to a WebGPU target name or one timestamp.
- legacy external rejection reports can now recover typed external contract fields only from a matching packaged profile manifest. Recovered profile selections are marked `explicit=false` and `recovered=true`; conflicting legacy report fields reject recovery instead of combining report data with a packaged manifest hash. The recovered Bevy row remains a refusal, not GPU HMR acceptance.
- source-derived real ROCm output-oracle instrumentation is now recorded as source adaptation and is a no-shim blocker; it can support diagnostic compute evidence, but it cannot satisfy no-shim GPU HMR acceptance.
- real ROCm HIPRT runtime probing is opt-in through explicit env/profile config; the runner no longer enables HIPRT probing or selects a special run command from repo or target names.
- real ROCm profile proof obligations are recomputed by the validation matrix from raw profile and target-progression evidence. Serialized obligation facets can add stricter gaps, but cannot erase raw-profile obligations for large ROCm ML or final-acceptance rows.
- real ROCm source-delta execution evidence is recomputed from runner-observed source write/compile phases, content-addressed before/after/edit hashes, and expected-refusal metadata. Declared fixture candidates cannot satisfy hot-delta-2 or negative-edit obligations by themselves.
- real ROCm profile selection is no longer default-open for normal runner invocations. The runner requires `SYNTHI_REAL_ROCM_PROFILE_PATH` or `SYNTHI_REAL_ROCM_PROFILE_JSON`; the packaged SAXPY profile is available only for explicit diagnostic/default-profile runs through `SYNTHI_REAL_ROCM_ALLOW_DEFAULT_PROFILE=1` or `--self-check`, and the warm npm script supplies the SAXPY profile path explicitly.
- real ROCm final-acceptance rows cannot use `outputOracle.profile=auto` to source-instrument a target. They must provide explicit runtime-oracle profile evidence or stay refused; refusal-only profiles can still record disabled/diagnostic oracle state without turning into acceptance.
- real ROCm backend inference no longer treats HIPRT-path-tracer-style class names as backend proof. HIPRT candidates require explicit backend/API evidence such as a typed backend setting or HIPRT API coverage; name-shaped strings remain heuristic text only.
- real ROCm same-process runtime-oracle acceptance now requires a proven same-process path: either a complete native runtime bridge for rows where an app hook is not required, or a generic app-hook/runtime contract plus observed artifact transport, epoch publication, dispatch using the published epoch, stable process identity, dispatch/output-oracle target continuity, post-dispatch observation, artifact/epoch hash continuity, and explicit CPU/full-rebuild/restart firewall proof. If a profile/native-boundary gate requires an app hook, a native bridge alone cannot satisfy final acceptance. Smoke coverage includes one generic native-bridge positive fixture, one generic large-ROCm ML app-hook positive contract fixture, and generic negative fixtures for missing/unresolved hooks, missing facet, wrong schema, missing artifact transport, missing epoch, missing dispatch, dispatch/epoch mismatch, missing output oracle, missing output target, mismatched output target, process mismatch/restart, oracle-before-dispatch, artifact mismatch, CPU-HMR/full-rebuild firewall violations, full-runtime-proof gaps, and missing strict runtime proof artifacts; none of these gates are keyed to a repository or library name.
- real ROCm app-hook contract acceptance now independently validates the five generic stages `artifact_transport`, `epoch_publication`, `dispatch_trace`, `host_identity`, and `output_oracle`. A serialized `canSatisfyRuntimeProof=true` field is only advisory unless the facet schema, content-addressed contract hash, resolved evidence refs, contract evidence, and runtime observations all pass; forged stage evidence remains unproven. Complete support-only runtime-adapter stage events can derive this app-hook contract only through matrix-recomputed hashes and evidence refs; serialized derived contracts without matching stage events remain unproven.
- accepted full-runtime row safety now recomputes a generic row/ledger identity binding. A row target must either match the strict ledger project/edit identity or be explicitly bound as a source-first/profile alias through accepted source-first provenance and validation-profile evidence that names the row target and the same strict ledger/runtime proof IDs. Serialized identity-binding facets are diagnostic only and cannot authorize acceptance; a coherently retargeted source-first replay with a recomputed source-first proof ID remains refused when it reuses another runtime ledger without row-target evidence.
- real ROCm runtime output-oracle, app-hook, and device-sidecar contracts can now be supplied as validated JSON-object environment inputs (`SYNTHI_REAL_ROCM_OUTPUT_ORACLE_RUNTIME_PROFILE_JSON`, `SYNTHI_REAL_ROCM_APP_HOOK_CONTRACT_JSON`, `SYNTHI_REAL_ROCM_DEVICE_SIDECAR_CONTRACT_JSON`, plus `SYNTHI_GPU_HMR_*` aliases). These inputs are recorded in command metadata and source fields, but they are evidence-only declarations; the runtime still has to prove loader/artifact transport, epoch publication, dispatch, host identity, output oracle, firewall, and strict runtime proof closure before any row can be accepted.
- real ROCm runtime `output_oracle` boundary evidence can now resolve the output-oracle contract/profile gate through `selectedSource=runtime_output_oracle_evidence`, but only when the same file-backed compute or visual artifact verifier accepts the bytes. Forged compute hashes and unsupported serialized success sources remain refused, and the emitted runtime-output-oracle profile remains evidence-only (`acceptedForGpuHmr=false`, `gpuHmrSuccess=false`, `canSatisfyRuntimeProof=false`) until strict runtime proof, ledger, runtime-chain, app-hook, firewall, and output-oracle closure all pass.
- final-acceptance `large_rocm_ml_infrastructure` profiles now implicitly require an app-hook contract from `targetClass`/profile evidence, even when a profile omits an explicit `requiresAppHookContract` flag. The runner self-check covers this as a target-class rule rather than a repo-name branch.
- runtime-adapter boundary coverage and runtime-chain overlay parsing now agree on generic dispatch event shapes. The matrix accepts `[gpu-runtime-boundary] synthi_gpu_launch ...` and `[gpu-runtime-boundary] native_runtime_dispatch ...` as dispatch-boundary evidence sources for overlay extraction, then still requires artifact hash, epoch, dispatch ID, output target, process identity, timestamp ordering, output oracle, firewall, and strict runtime-proof closure before acceptance. The complete adapter-boundary bridge smoke fixture uses `synthi_gpu_launch`, while the mismatch fixture still exercises `native_runtime_dispatch`.
- runtime-adapter boundary host-identity coverage now requires proof-shaped identity snapshots, not just a host-identity event line. Matrix ingestion recomputes host preservation from generic boundary fields, requires numeric before/after identity lineage plus preserved runner-process, host-state, and runtime-resource roles, and refuses a role-less host identity line even when artifact transport, epoch publication, dispatch trace, and output oracle boundary events are all present.
- real ROCm target-progression ledger entries now rederive mandatory proof gates from the report fields before writing the retained ledger artifact. A serialized or stale `pass` row cannot override missing final-acceptance full-runtime, output-oracle, prior-phase, or visual/compute proof.
- real ROCm worker repository transfer failures now emit a generic structured `synthi.real_rocm.worker_repo_transfer_failure.v1` facet and the validation matrix treats accepted transfer facets as fail-closed refusal evidence. The smoke fixture is project-agnostic and verifies `gpuHmrSuccess=false`, `acceptedForGpuHmr=false`, `proofChain=real_rocm_strict_runtime_refusal`, and attempt-completeness score 70.
- compute-oracle/runtime-chain epoch checks now normalize string and numeric epoch fields before comparing loader, publish, dispatch, output, and oracle evidence. Numeric JSON epochs emitted by HIP module runtime artifacts can pass only when the strict runtime proof artifact, proof ledger, dispatch event, and readback oracle all agree; missing or mismatched epochs still fail closed.
- agent-split visual proof can now run from an explicit `SYNTHI_GPU_AGENT_PROFILE_PATH` profile (`synthi.gpu_hmr.agent_split_visual_profile.v1`) with inline/path/fixture source, entry path, resolution, profile identity/hash, source content hash, deterministic-mode hash, visual-proof threshold hash, optional visual-scene manifest hash, and declared hot-delta edits that must match exactly one source occurrence when `requireDeclaredEdits=true`. The matrix binding rejects profile/source/scene-manifest hash mismatches, profile visual thresholds can only tighten the baseline visual-diff gate, and supplied scene manifests must be bound to row/ledger evidence refs. This makes realistic raytrace and future external visual workloads profile-driven instead of target-name or scenario hardcoded.

The latest generated machine-readable validation matrix ledger reports 56 rows after source-first include-closure preservation, worker-detected ROCm arch binding, the source-first realistic ROCm raytrace visual proof, source-first fixture/profile identity hardening, source-first generated-artifact namespace/hash-overlap hardening, source-first source-tree manifest hardening, stricter structured runner proof gates, strict WebGPU compute/readback runtime-proof authority, strict HIP module runtime-proof authority, the refreshed large ROCm ML refusals, packaged runtime-adapter execution/result-transport evidence, runtime-adapter stage-events app-hook derivation, the live OIDN runtime-split refusal, the fresh OIDN declared-checkout no-shim refusal, profile-required app-hook obligation surfacing, the large ROCm source-delta execution gate, the generic same-process real-ROCm runtime-oracle/app-hook gate, structural negative-edit refusal gating, proof-hashed latest-attempt history, external visual deterministic-mode recomputation, report-level content-addressed external visual oracle hashes, explicit real-ROCm top-level verdict booleans, generic runtime evidence artifact-identity normalization, fresh real ROCm matrix-multiplication visual/refusal evidence, fresh hipBLASLt large-ML strict refusal evidence, the current ThreeJS WebGL shader-lava external visual-profile row, and non-final ROCm target-progression evidence retention as non-success rows were selected: 14 accepted full-runtime GPU HMR rows, 0 broad library-agnostic full-runtime GPU HMR rows, 14 scoped full-runtime GPU HMR rows, 2 deterministic generated-split fission verifier rows, 3 visual-profile rows, 29 structurally proven refusal rows, 7 cold split rows, 1 WebGPU typed runtime preflight-only row, and 0 unproven rows in the default included set. The matrix hash is:

```text
gpu-validation-matrix-ledger:sha256:9021cc8be6f4e5f65643be933368394843db710d6e010bc30834ad34b4383787
json: mcp/synthi-mcp/.gpu-hmr-test-logs/validation-matrix/gpu-hmr-validation-matrix-20260630T061201Z.json
latest rerun context: validation matrix rerun after realistic ROCm raytrace visual proof, strict runtime-proof-artifact authority was made mandatory for every accepted GPU HMR row, source-derived real ROCm oracle instrumentation was marked as no-shim source adaptation, the accepted-row no-shim source identity facet now requires content-addressed edit/source identity plus runtime artifact-chain closure, HIPRT real-ROCm probing became explicit env/profile config, real-ROCm proof obligations became matrix-recomputed from raw profile/target-progression evidence, profile-required app-hook obligations now surface in the real-ROCm app-hook and runtime-eligibility facets even before native launch evidence appears, target-progression ledger entries rederived mandatory proof gates, required visual proof requires before/after pixel recomputation instead of a lone decoded screenshot, content-addressed before/after/diff visual oracle artifacts are required for visual runtime rows, external visual proof artifacts recompute deterministic visual-mode gates from declared controls, WebGPU compute/readback and HIP module proofs emit accepted strict runtime proof artifacts backed by raw mapped GPU bytes/readback bytes, large ROCm ML refusals are retained as structured refusal rows, worker-repo transfer failures are structured refusal facets, real-ROCm same-process runtime-oracle gates require a generic app-hook contract plus artifact transport, epoch publication, dispatch, process identity, dispatch/output-oracle target continuity, post-dispatch timing, artifact/epoch hash continuity, and CPU/full-rebuild/restart firewall evidence, real-ROCm retained reports now expose top-level `gpu_hmr_success`, `accepted_for_gpu_hmr`, `full_runtime_proven`, and a strict failed-gate verdict, runtime evidence now normalizes `artifact:sha256:<digest>` and raw `sha256:<digest>` identity across dispatch/transport/output-oracle facets, the latest ROCm examples matrix-multiplication and hipBLASLt large-ML attempts were re-ingested as strict refusals, generic env-declared real-ROCm runtime output-oracle/app-hook/device-sidecar contract inputs are recorded evidence-only declarations, broad-readiness reports matrix-computed zero broad rows as a missing proof gap, per-target coverage rejects contradictory positive facets with blocking gaps, negative-edit refusal rows require structural typed evidence and explicit firewall/run-mode proof, default matrices proof-hash disabled/latest-attempt history metadata while history audits expose newest attempts, CUDA coverage is not-applicable for this ROCm/AMD-only matrix, large ROCm ML retained rows require runner-observed content-addressed hot-delta-2/negative-edit source-delta execution instead of fixture declarations alone, and non-final target-progression rows can be retained only as non-success evidence.
summary: 56 rows, 14 accepted full-runtime GPU HMR, 0 broad library-agnostic full-runtime GPU HMR, 14 scoped full-runtime GPU HMR, 14 all full-runtime rows, 29 refusals under the stricter structural gate, 7 cold splits, 2 deterministic fission, 3 visual profiles, 1 preflight-only row, 0 included unproven rows
broad readiness: accepted=false, authority=matrix_computed_not_row_declared, broadRuntimeRows=0, broadRuntimeRowsComputed=true, broadRuntimeRowsMissing=true, scopedRuntimeRows=14, distinctBackendCount=2, open gaps=matrix_level_broad_generalization_proof_not_present,broad_runtime_rows_missing,broad_acceptance_requires_more_backend_families
scope breakdown: generated_rocm_hip_preview_visual: 2, hip_module_declared_compute_readback: 2, webgpu_declared_compute_readback: 2, webgpu_declared_pipeline_visual: 8
self-check: validation-matrix smoke -> passed; node scripts/gpu-hmr-validation-matrix-ledger.mjs --self-check -> passed
per_target_run_modes status=accepted
per_target_run_modes open gap: none
history audit: npm --prefix mcp/synthi-mcp run proof:validation-matrix:history -> passed, gpu-validation-matrix-ledger:sha256:aa905942109909b5181c6236cb348a68710ebc667ac8f8dde7d572385c7e349c, 678 rows with 622 historical unproven rows included
history audit json: mcp/synthi-mcp/.gpu-hmr-test-logs/validation-matrix-unproven-audit/gpu-hmr-validation-matrix-20260629T113226Z.json
history scope breakdown: generated_rocm_hip_preview_visual: 2, hip_module_declared_compute_readback: 2, webgpu_declared_compute_readback: 2, webgpu_declared_pipeline_visual: 8
timing summary: npm --prefix mcp/synthi-mcp run proof:timing-metrics -> passed, count=21, json=mcp/synthi-mcp/.gpu-hmr-test-logs/timing-metrics/gpu-hmr-timing-metrics-20260624T093916Z.json; timing metrics are telemetry only, evidenceAuthority=timing_telemetry_only, proofVerdict=not_evaluated_by_timing_summary
```

Negative-edit refusal rows now require structural typed evidence, a content-addressed edit hash, accepted negative/different-edit run-mode evidence, explicit CPU/full-rebuild/restart firewall proof, and a typed blocker such as an executable static check, source occurrence proof, reject classification with blocking gaps, or a negative-edit proof object. Reasons-only and false-only rows are non-success/unproven and are omitted from the default included matrix.

CUDA coverage is `not_applicable` in this local matrix because the observed hardware evidence is ROCm/AMD (`hip`, `hiprt`, `oidn_hip`) and no CUDA rows exist. This is not CUDA proof and does not remove the need for a CUDA-machine validation run.

The global per-target run-mode coverage row is currently `accepted` for the enrolled scoped targets. The source-first realistic HIP target now carries cold split, hot delta 1, hot delta 2 with a different edit, and negative-edit refusal evidence, including a CAS-backed cold visual frame. This does not broaden the claim to arbitrary GPU projects, arbitrary HIP libraries, frameworks, or apps. Focused Flow/ray-light run-mode coverage remains historical evidence from the older focused matrix. SAXPY is not a current accepted full-runtime row in the latest default matrix; historical SAXPY rows remain unproven/not-full-runtime in the history audit.

Scoped WebGPU compute/readback artifacts for `webgpu-wgsl-runtime-compute-storage` and `webgpu-wgsl-runtime-compute-storage-hot2` now count as full-runtime GPU HMR rows because each proof carries an accepted strict `runtimeProofArtifact` plus recomputed ledger, native WebGPU compute API trace, raw mapped readback bytes, schema/hash verification, and expected float32 output verification. They remain scoped to the explicit storage/uniform float32 readback profile; they are not a blanket WebGPU compute, engine-cache, or arbitrary shader-app claim.

Scoped HIP module runtime/readback artifacts now count as two full-runtime GPU HMR rows for `hip-module-runtime-readback` hot delta 1 and hot delta 2 because the fresh ROCm worker rerun produced accepted strict `runtimeProofArtifact` records and the validation matrix normalized numeric oracle epochs before comparing publish/dispatch/output evidence. These artifacts carry explicit ABI, launch shape, stream, buffers, expected readback output, real HSACO, same-process native HIP module load, epoch publish, epoch-2 dispatch, raw D2H readback after dispatch, exact expected-output verification, data-derived proof cards, executable ABI-negative refusal, and unsupported-scope rejection. They are still not a broad HIP app/library claim and not a blanket HIP application claim. The runner implementation packs launch arguments from declared `abi.params`, typed buffers, typed scalars, and extracted before/after kernel signatures instead of the old fixed float32 `{output,input,scale,bias,n}` shape. A second `explicit-hip-module-declared-readback` uint32/reordered-ABI profile remains covered by `proof:hip-module:runtime:self-check`; it is self-check coverage, not an additional live accepted broad-runtime row.

The backend-specific `hiprt_run_modes` and `hiprt_visual_path` coverage rows are now `missing` for no-shim/full-runtime acceptance. HIPRT CameraRays and MegaKernel direct-light-gain still provide useful ray-traced visual proof artifacts, but the matrix classifies them as `visual_profile_accepted` because the runtime probe instrumentation discloses source-adapted profile hooks. They are evidence, not accepted GPU HMR rows, and they do not prove broad HIPRT acceptance.

Historical focused Flow/ray-light matrix:

```text
proof id: gpu-validation-matrix-ledger:sha256:0ad6ab6154848a2e87672df6f32d389f9d0250638bedf1a81c9d14bc1a52a534
json: mcp/synthi-mcp/.gpu-hmr-test-logs/validation-matrix/gpu-hmr-validation-matrix-focused-flow-ray-light-20260622T181300Z.json
rows: 9
outcomes: 4 full_runtime_gpu_hmr, 2 cold_split_proven, 2 refusal_proven, 1 deterministic_fission_proven
open gates: none
coverage accepted: scoped ROCm/HIP full-runtime profile rows, Flow visual GPU path, ray-light visual GPU path, per-target run modes, and ray-light `trace_light_rays` per-kernel/smallest-safe fission. Flow remains device-translation-unit HMR only for fission because its selected device role owns two kernels.
```

Latest live preview URLs checked HTTP 200 on 2026-06-26:

```text
Realistic raytrace: http://localhost:3000/workspace/source-first-cold-cas-realistic-20260629 -> created by source-first proof runner and verified through persisted visual artifacts on 2026-06-29
Ray-light: http://localhost:3000/workspace/gpu-agent-ray-light-20260626-live-container-rerun -> created by proof runner and verified through persisted visual artifacts on 2026-06-26
Flow:      http://localhost:3000/workspace/gpu-agent-flow-20260626-live-container-rerun -> created by proof runner and verified through persisted visual artifacts on 2026-06-26
Preview frontend: http://127.0.0.1:3000 -> HTTP 200
Worker/MCP/AI containers: vectant-ade-worker-1, vectant-ade-mcp-1, and vectant-ade-ai-engine-1 were up during the current proof refresh.
Workspace POST proof after `fix(preview): honor workspace auth bypass in API route`: `preview-auth-bypass-check-20260624T113807` created through `POST /api/workspace` with `NEXT_PUBLIC_SYNTHI_WORKSPACE_AUTH_BYPASS=1`, then `/workspace/preview-auth-bypass-check-20260624T113807` returned HTTP 200.
Container rebuild proof: `docker compose up -d --build --force-recreate frontend` with the auth-bypass env completed a Next.js production build on 2026-06-24.
```

Current live Flow/ray rerun status on 2026-06-26:

```text
Flow rerun slug: gpu-agent-flow-20260626-live-container-rerun
Ray-light rerun slug: gpu-agent-ray-light-20260626-live-container-rerun
Both reruns created preview workspaces, attached MCP, persisted 16 generated split files, executed cold split, hot delta 1, hot delta 2 with a different edit, and negative edit refusal, and emitted row-bound run-mode artifacts.
Flow remains device-translation-unit HMR for fission because the selected generated device role owns two kernels.
Ray-light proves per-kernel/smallest-safe fission for `trace_light_rays` through a deterministic verifier with 9 typed verifier evidence refs.
```

Latest realistic ROCm raytrace visual proof on 2026-06-29:

```text
workspace slug: source-first-cold-cas-realistic-20260629
workspace url: http://localhost:3000/workspace/source-first-cold-cas-realistic-20260629
artifact dir: mcp/synthi-mcp/.gpu-hmr-test-logs/agent-split-artifacts/source-first-cold-cas-realistic-20260629
profile: agent-realistic-raytrace-scene (`synthi.gpu_hmr.agent_split_visual_profile.v1`)
fixture: realistic-raytrace
kernel: render_realistic_raytrace
scene: deterministic faceted diamond and small stones on a glossy slab with fixed camera, no temporal accumulation, fixed 2x2 subpixel rays, bounded secondary reflection/refraction scene probes, ACES-style tone mapping, cafe string bulbs, an HMR-controlled studio light rig, wall/awning geometry, planter boxes, cafe table/chair geometry, lamp/bollard geometry, richer material shaders, floor reflections, and glossy car geometry
source-first proof id: agent-split-source-first-ingestion:sha256:dbef11d86091ba64402333b6598f208c619f231474ced92da53fed8d15e1920f
hot delta 1 run-mode proof: agent-split-run-mode-proof:sha256:29df6b1b91f01284ab71108c4f1edea8c797e0ddf8a2c9677c0a18f82fd9d3e2
hot delta 1 ledger: gpu-ledger-proof:sha256:b528a70627bc3152fc82a053a122c8c10118b0f330bffb72f4c8bbb42a4f765b
hot delta 1 runtime proof: gpu-runtime-proof:sha256:d545c64da1874fe605ed9462ff9b130d83b2ee272c4ae23c447fcfc3cc55c1b5
hot delta 2 run-mode proof: agent-split-run-mode-proof:sha256:fd1c143a4cc3efe5244ee689cc27641970855f3c40d1003fa076ff8be50df606
hot delta 2 ledger: gpu-ledger-proof:sha256:1c1b3e34b5e35372011426d966ddab89310c57b43ce9cd6261b9e6447adece8d
hot delta 2 runtime proof: gpu-runtime-proof:sha256:d87d8195217ea17b5c069a5a7ee8b4f1ddd233f0c5c641ff095b24887de870f9
hot1 matrix row id: historical-gpu-validation-matrix-row-sha256-df44f7e0790a508aac703b3746cb2f80be2ff907a753d16a2bf7d7083adcbdff in mcp/synthi-mcp/.gpu-hmr-test-logs/validation-matrix/gpu-hmr-validation-matrix-20260630T061201Z.json
hot2 matrix row id: historical-gpu-validation-matrix-row-sha256-be05fd92aaee4bc25fcdb00a3e061fd5e86c8f185078529c93493545f5f7d595 in mcp/synthi-mcp/.gpu-hmr-test-logs/validation-matrix/gpu-hmr-validation-matrix-20260630T061201Z.json
current matrix runtime proofs: gpu-runtime-proof:sha256:d545c64da1874fe605ed9462ff9b130d83b2ee272c4ae23c447fcfc3cc55c1b5, gpu-runtime-proof:sha256:d87d8195217ea17b5c069a5a7ee8b4f1ddd233f0c5c641ff095b24887de870f9
current matrix acceptance scope: generated_rocm_hip_preview_visual, claimScope=scoped_profile, broadLibraryAgnosticAccepted=false, arbitraryLibraryAccepted=false
visual artifacts: cold-split-frame.png, before-after-diff.png, hot-delta-2-diff.png
hot delta 1 visual delta: changed=82.64%, mean_abs=17.89, control_changed=0.00%, control_mean_abs=0.03
hot delta 2 visual delta: changed=99.87%, mean_abs=37.38, control_changed=0.00%, control_mean_abs=0.03
timings: cold total_validator_wall_time=10968567800ns, hot1 total_validator_wall_time=4814920300ns, hot2 total_validator_wall_time=4405518100ns
deterministic fission: accepted=true claim=per_kernel_hmr selected_island=.synthi/generated/gpu/device.hip kernel=render_realistic_raytrace row=historical-gpu-validation-matrix-row-sha256-ab0cb77eb89e7aa8061f3a10a7a3401f4288b0615d39b276cb9ba40ef45c767e, selected verifier evidence `evidence:fission-verifier-report:generated-split:sha256:b8c8fa5f69c6c24e7fa9c287fce4d423df516cc2a1b0c2813fb26e6eaec2b91e`
negative edit: ABI/layout-changing edit refused before GPU HMR
visual inspection: before/after/diff PNGs were opened with the local image tool on 2026-06-29; they were visibly nonblank. The refreshed scene shows stable floor reflections, cafe bulbs, a faceted diamond, small stones, a car body, and a real post-epoch diff. The proof is scoped to this generated/profiled deterministic visual path and is not broad arbitrary HIP application acceptance.
```

Latest ray-light visual proof:

```text
artifact dir: mcp/synthi-mcp/.gpu-hmr-test-logs/agent-split-artifacts/gpu-agent-ray-light-20260626-live-container-rerun
hot delta 1 run-mode proof: agent-split-run-mode-proof:sha256:3007aec01992564f2a85fe87aa94802b525b34a05221851a42a9f1b0d2a5af7a
hot delta 1 ledger: gpu-ledger-proof:sha256:5240c422d8c5e6e7fb14ab901b9d3ec3225433b4f6d8a0e2365b5f17a9d0fd90
hot delta 1 runtime proof: gpu-runtime-proof:sha256:6798ea24ace35aaff7995a4d1ca68cee1cb154935e66470104e170d88c4a817e
hot delta 2 run-mode proof: agent-split-run-mode-proof:sha256:ec97eea16e3e1d094e7108ed003f69d5e51dece4b79b34a02563523c642a6201
hot delta 2 ledger: gpu-ledger-proof:sha256:bb28828754c0c4774cb05084060c697b1110ddf9d068637da3ef8c6f2a3690ed
hot delta 2 runtime proof: gpu-runtime-proof:sha256:599424afc4867bd60e3254436ff71883f6e28cefb2568a47b61ce3430f4c94d3
visuals: before-after-diff.png, hot-delta-2-diff.png
hot delta 1 timings: device_compile_wall_time=9429200ns, runtime_probe_time=4420294500ns, total_validator_wall_time=4429787700ns
hot delta 2 timings: device_compile_wall_time=31387100ns, runtime_probe_time=4214150000ns, total_validator_wall_time=4245753000ns
visual metrics: hot1 changed_pixel_ratio=0.0589, perceptual_diff=9.913993055556022, control_changed=0; hot2 changed_pixel_ratio=0.04984583333333333, mean_abs=7.723018749999875, control_changed=0
fission: accepted per_kernel_hmr for trace_light_rays with selected verifier evidence `evidence:fission-verifier-report:generated-split:sha256:5edbd7bbb8b8b8acf2efb069bffb587af4c70d1ea6c692477428266e54cd1c25`, row `historical-gpu-validation-matrix-row-sha256-6eaec5921db4bf929b6a1726b7b1a9a2aab4358f9c0502c0dce8b85736c68f9c`, and 9 typed deterministic verifier refs
visual inspection: before/after and diff PNGs opened with the local image tool on 2026-06-27 and were visibly nonblank with changed ray-light geometry.
```

Latest Flow visual proof:

```text
artifact dir: mcp/synthi-mcp/.gpu-hmr-test-logs/agent-split-artifacts/gpu-agent-flow-20260626-live-container-rerun
hot delta 1 run-mode proof: agent-split-run-mode-proof:sha256:8057f7967939bf47c7946e88a8aa21269de0c22e6954578c58fb6ad468fe240e
hot delta 1 ledger: gpu-ledger-proof:sha256:40fdc37783eca73a1b0aac9264f1a4a0172912ef78f76d03d414841359cf09c1
hot delta 1 runtime proof: gpu-runtime-proof:sha256:9a3cb588a1defb397003537eb253dee9de1a554da1361dd8c45127289822afe3
hot delta 2 run-mode proof: agent-split-run-mode-proof:sha256:45889477878d10bf9d641e4ba4f96fadac481bccb851df30d1b94cb3319d182b
hot delta 2 ledger: gpu-ledger-proof:sha256:d0162226d4cca2c39dc4899ddb93a07fbd5176d5705530bf15053b5b93ac1687
hot delta 2 runtime proof: gpu-runtime-proof:sha256:b7690159342473b57f1530be31b7bbbb2b29d1f55469e36cc566fc5f0339a081
visuals: before-after-diff.png, hot-delta-2-diff.png
hot delta 1 timings: device_compile_wall_time=12028300ns, runtime_probe_time=3674696700ns, total_validator_wall_time=3687001400ns
hot delta 2 timings: device_compile_wall_time=16312000ns, runtime_probe_time=3299131200ns, total_validator_wall_time=3315493100ns
visual metrics: hot1 changed_pixel_ratio=0.025266666666666666, perceptual_diff=3.3798368055559345, control_changed=0; hot2 changed_pixel_ratio=0.025229166666666667, mean_abs=3.414575000000527, control_changed=0
fission: device_translation_unit_hmr only; per-kernel/smallest-safe fission remains refused
visual inspection: before/after and diff PNGs opened with the local image tool on 2026-06-27 and were visibly nonblank with a Flow particle-ring pattern.
```

Latest WebGPU explicit-empty run-mode visual proof:

```text
hot delta 1 proof id: webgpu-runtime-visual-proof:sha256:87272df5a648f3e8100b9fee3e5de06238bf517b4998bbec9b01845b790a4aab
hot delta 1 runtime proof artifact: gpu-runtime-proof:sha256:a59e894be860669380b0723a67177e3ff5b94a8824c51f0d68908a7792298a9b
hot delta 1 ledger: gpu-ledger-proof:sha256:8eb15f7a22156c14df0d947ed0c4ac4a1b14b52b45d3c2884e216a975b57e28b
hot delta 1 run-mode proof: runtime-run-mode-proof:sha256:176195d21868cc476531698aca6aa004a2eaa6f0177b5de03bf03f7669565196
hot delta 1 cold runtime proof: runtime-run-mode-proof:sha256:682324fcd59276545d18f56e3ae6785ea99e3070de0ab98fb52cd09d562c759a
hot delta 1 negative refusal: agent-split-negative-edit-refusal:sha256:db53d10719363bc9dacfb0518a2170745ba537ad3e6b7c79eb332a8854f72cfc
hot delta 1 total validator wall time: 1247829300ns
hot delta 1 trigger_to_visible_time: 70794700ns
hot delta 1 changed_pixel_ratio: 0.29389322916666666
hot delta 2 proof id: webgpu-runtime-visual-proof:sha256:893dba543fddb66ac2369a10ce89f8bc07518aa0ddb949cccb891b859c7ec3f0
hot delta 2 runtime proof artifact: gpu-runtime-proof:sha256:983e347e834c914d32c7b1478fe00d7515238274fe32a6a902f2c38e1b55f625
hot delta 2 ledger: gpu-ledger-proof:sha256:441ee9299dc073bfb86700af70342e42b06dce5fe970ff198a20667422c3ee90
hot delta 2 run-mode proof: runtime-run-mode-proof:sha256:b0e6dafa96d31ed5b196c6dfa37d76968e0f7b23fa800bcd2b1f9282f34c7fd1
hot delta 2 cold runtime proof: runtime-run-mode-proof:sha256:a60b981a40599d14d2bad985c94d3b433472232f2ab14b400d414049e251c758
hot delta 2 negative refusal: agent-split-negative-edit-refusal:sha256:7c69db3629fc77cd0a2de79b375b646834d66f5407177ee8a0ca10a00d6e0272
hot delta 2 total validator wall time: 613256000ns
hot delta 2 trigger_to_visible_time: 57775800ns
hot delta 2 changed_pixel_ratio: 0.32245225694444446
negative edit refusal reasons: bind_group_layouts_not_supported_by_runner, webgpu_pipeline_layout_or_binding_abi_changed, gpu_hmr_rejected_before_load
visuals inspected locally with the image tool: hot1 diff `webgpu-runtime-visual-20260625070636-webgpu-wgsl-runtime-triangle-diff.png` and hot2 diff `webgpu-runtime-visual-20260625070706-webgpu-wgsl-runtime-triangle-hot2-diff.png`
visual result: hot1 after yellow inverted triangle with nonblank diff; hot2 after green rotated triangle with nonblank diff
```

Latest WebGPU explicit-profiled bind-group/vertex-buffer visual proof:

```text
profile: webgpu-wgsl-runtime-profiled-layout
pipeline scope: explicit-profiled-layout-uniform-bindings-float32-vertex-buffers-triangle-list
resource state hash: sha256:febd60767177cf5ba103734735eba5e2f083a4b5131c5fab915567e9a843b2f3
runtime binding trace: bind_group_count=1, bind_group_binding=0, uniform_bytes=32, vertex_buffer_count=1, vertex_bytes=48
native WebGPU API gates: createBuffer, createBindGroupLayout, createBindGroup, createShaderModule, createRenderPipeline all accepted
hot delta 1 proof id: webgpu-runtime-visual-proof:sha256:4a437069aff6eb30cf898de6633c16e428f0d72688a8f67eb0152117d993c333
hot delta 1 runtime proof artifact: gpu-runtime-proof:sha256:327c5814b847eebb41aef8af3d202ba31835f95354515c455da82613ccfb8ca3
hot delta 1 ledger: gpu-ledger-proof:sha256:5b86d4fc2c7b403b3cb561e3f1b778da835462b2d50763e16539bcadeb95c1ee
hot delta 1 run-mode proof: runtime-run-mode-proof:sha256:614b7689891e2ebbdc87188ac9ff5e7515bfdd3e3bd38e5e9947d4eb119063e0
hot delta 1 cold runtime proof: runtime-run-mode-proof:sha256:140755d546ba7a5cc0dcf0a5a76ce9402b69f022dd1d46bf6ddfc9d391b21043
hot delta 1 negative refusal: agent-split-negative-edit-refusal:sha256:43c0eef8fed58418d27f44736a706064926dc4991d9ce5518e3a2da63136eac2
hot delta 1 total validator wall time: 1145767400ns
hot delta 1 trigger_to_visible_time: 70909600ns
hot delta 1 changed_pixel_ratio: 0.23291666666666666
hot delta 2 proof id: webgpu-runtime-visual-proof:sha256:de18b154e927f7f6afe0a6a5f8766539b87032dcdc2347a9821db5f2e95b28de
hot delta 2 runtime proof artifact: gpu-runtime-proof:sha256:7c1e65e0bf337b2c26ad8021f1c2da57c67fb66f9522dcda5b75ec40d284e982
hot delta 2 ledger: gpu-ledger-proof:sha256:62fd846d75844bab4c4b943613fd71b7412c3887b8f695678ce6f674e97725e1
hot delta 2 run-mode proof: runtime-run-mode-proof:sha256:e60a28a51e069e0856cf52972b8c693889a1ba19ae9da52d22c7a0c79e935f78
hot delta 2 cold runtime proof: runtime-run-mode-proof:sha256:15a3a586271ad18613deafebbfbb9b672185b44719f3d70820ba4f78cd992d06
hot delta 2 negative refusal: agent-split-negative-edit-refusal:sha256:77245a6d0819b9f5bf9394b23c49ce0969a5bcb8b566c2e5c5e1b88b7db909d8
hot delta 2 total validator wall time: 636983100ns
hot delta 2 trigger_to_visible_time: 58872800ns
hot delta 2 changed_pixel_ratio: 0.24441840277777777
negative edit refusal reasons: storage uniform binding or vertex attribute format changes reject before GPU HMR acceptance
visuals inspected locally with the image tool: profiled hot1 diff `webgpu-runtime-visual-20260625070636-webgpu-wgsl-runtime-profiled-layout-diff.png` and profiled hot2 diff `webgpu-runtime-visual-20260625070654-webgpu-wgsl-runtime-profiled-layout-hot2-diff.png`
visual result: hot1 and hot2 rendered nonblank profile-driven triangles with visible diffs derived from the post-epoch frame
```

Current 2026-06-29 large ROCm ML refresh:

```text
worker image prerequisites committed generically: ninja-build, Python dev/setuptools/venv, SQLite dev, BZip2/bzip2 tool, msgpack C/C++ dev, nlohmann JSON, gfortran, Boost filesystem/program-options/system development packages, zstd development headers, and the real native launch observer library in the worker Dockerfiles. These are build prerequisites, not HMR proof gates or project-specific success branches.
rebuilt image proof: active compose worker image `sha256:3974e9ec25d3ca9390cf6b15c3bfcb7dbe7c994098b65160fa6ea850a3ab3f18`; the running `vectant-ade-worker-1` container verified `/usr/bin/bzip2`, `libboost-filesystem-dev`, `libboost-program-options-dev`, `libboost-system-dev`, the Boost filesystem config package, ROCm `gfx1201`, and `hipcc`
MIOpen selected matrix row for this 2026-06-29 refresh: mcp/synthi-mcp/.gpu-hmr-test-logs/real-rocm-results.json, backed by retained standalone artifact mcp/synthi-mcp/.gpu-hmr-test-logs/real-rocm-results/gpu-real-rocm-MIOpen-20260629-checkpoint2.json
MIOpen matrix row id: historical-gpu-validation-matrix-row-sha256-16305e7aef533eb74ffd73e8fdda199da25aef72e27be2fbb6710b632d32b235
MIOpen proof ids: gpu-ledger-proof:sha256:d4276ec0e4eee3a406c823bb9e170890d0ebc1490fafa1cc5477f3e29eb4a770, gpu-runtime-proof:sha256:4539a61af192d16ed56006d79ce1306121df369cf29adc7d6f8b8ec07c4457fd, real-rocm-validation:sha256:265e1f9e6a9e96b2efa1bf92986a254457c78e41a807c3945579b9b6b6c58503
2026-06-29 retained standalone MIOpen attempt: mcp/synthi-mcp/.gpu-hmr-test-logs/real-rocm-results/gpu-real-rocm-MIOpen-20260629-checkpoint2.json, gpuHmrSuccess=false, acceptedForGpuHmr=false, fullRuntimeProven=false, runtime proof gpu-runtime-proof:sha256:4539a61af192d16ed56006d79ce1306121df369cf29adc7d6f8b8ec07c4457fd, ledger gpu-ledger-proof:sha256:d4276ec0e4eee3a406c823bb9e170890d0ebc1490fafa1cc5477f3e29eb4a770
MIOpen checkpoint behavior: retained two result checkpoints, including a fail-closed `pre-runtime-evidence` write before runtime evidence collection and a final write after runtime evidence collection; both keep `acceptedForGpuHmr=false` and `gpuHmrSuccess=false`
MIOpen 2026-06-29 source-delta execution: configured successfully, recovered upstream metadata, and executed first split, hot_delta_1, hot_delta_2, and negative-edit compile-projection phases, but none are accepted as GPU HMR because no accepted load-device bridge, device-sidecar runtime material, Synthi artifact transport, epoch publication, dispatch trace, host identity, post-dispatch output oracle, firewall proof, or strict runtime-proof closure was observed
MIOpen 2026-06-29 source-tree transport: status=source_tree_transport_evidence_accepted, transfer_operation=cas_shared_volume, transport_kind=cas_shared_volume, hot_path_optimized=true, shared_mount_count=4, worker_repo_path=/var/lib/synthi/artifact-cas/source-trees/MIOpen/06977176afd94476c18d5290f21cb40745bb73a9, worker_inspection=clean_matching_shared_source_tree, worker_file_count=7807, listing_hash=sha256:91d1b933061ae6b6005e7f7b5ec2b47936f4868bad1254da3bbf55dabd5d749c, cas_content_hash=sha256:5203d3f73980dcbdfe4b2a45cb7824af7a7f09d148af2920a0f7d4f2b35ed916; this is source-tree transport integrity evidence only and cannot satisfy runtime proof
MIOpen 2026-06-29 upstream/runtime blocker: upstream metadata was recovered, source-delta compile projections executed, and the external header prerequisite was materialized, but no app-hook runtime observation, Synthi artifact transport into the target process, epoch publication, dispatch trace using the published epoch, stable host identity, post-dispatch output/visual oracle proof, or accepted strict runtime proof was observed. Supplemental screenshots failed the frame gate for this compute/refusal profile and are not MIOpen post-epoch output proof.
MIOpen timeout cleanup finding: the checkpoint2 run exposed a non-happy-path orchestration issue where the host validator timeout could leave the worker-side MIOpen build running. The live build process tree was terminated by exact PIDs, leaving only defunct reaped-by-init entries. The runner now uses a worker-side lifecycle timeout wrapper plus a generic `SYNTHI_REAL_ROCM_LIFECYCLE_RUN_ID` marker cleanup path for all real ROCm profiles.
MIOpen 2026-06-29 external-header evidence: schema=synthi.real_rocm.external_header_prerequisites.v1, status=external_header_prerequisites_available, acceptedDependencyCount=1, prerequisiteCount=1, blockingGaps=[]; upstream `ROCm/half.git` was materialized at exact commit `10abd99e7815f0ca5d892f58dd7d15a23b7cf92c`, installed through declared `cmake_install`, and inspected for `half/half.hpp`. The facet is accepted dependency evidence only and remains acceptedForGpuHmr=false, gpuHmrSuccess=false, and canSatisfyRuntimeProof=false.
Composable Kernel selected matrix row: mcp/synthi-mcp/.gpu-hmr-test-logs/real-rocm-results/gpu-real-rocm-composable-kernel-20260629080933.json
Composable Kernel matrix row id: historical-gpu-validation-matrix-row-sha256-378ebb4fb4a2db179a838fc1372c17f0f652a4874cb918963f9d7a3dbe1091b6
Composable Kernel proof ids: gpu-ledger-proof:sha256:4100cafaffd17fd9894814164e1c519d2e151d68aabf217ced22634668b0025c, gpu-runtime-proof:sha256:6a3912707064ea366d7c95c91849edd3aba851d0b7002ff3127b3c60c387f259, real-rocm-validation:sha256:26e6710fedbf5ccd491749366efb01ff415d0035511fb4902b77029fb45577b9
Composable Kernel metadata recovery: attempted=true, accepted=false; compile_commands.json was unavailable after the upstream target failure, so no source-delta phase executed and GPU HMR stayed refused
hipBLASLt latest matrix row: mcp/synthi-mcp/.gpu-hmr-test-logs/real-rocm-results/gpu-real-rocm-hipBLASLt-20260629081428.json
hipBLASLt latest matrix row id: historical-gpu-validation-matrix-row-sha256-717f37a36c9dd6463096e60c0a5aa67bb64d4668a77dc94c263db0026677a591
hipBLASLt latest proof ids: gpu-ledger-proof:sha256:ecd9c8059af3249735326cbb160143259d2f299c43b169e7e17a8042fbf92d06, gpu-runtime-proof:sha256:9efe1c1abeed65028f44958aaa637bde151ee5076a21608f40bdb6d4eeac3b5b, real-rocm-validation:sha256:9260a19cd06c69297d525d4e728a69d84a820662b89fb490a0c8a88cc864b414
hipBLASLt latest target-progression ledger: target-progression-ledger evidence was not accepted because upstream configure failed before build metadata and source-delta execution could be recovered in `gpu-real-rocm-hipBLASLt-20260629081428`
hipBLASLt latest compile bridge: status=compile_bridge_missing, phase_count=1, device_sidecar_candidate.status=device_sidecar_contract_candidate_incomplete, known_rocm_backend=false, backend=unknown
hipBLASLt latest upstream/runtime blocker: CMake configure failed before build/run because Python development/module components were missing; no compile_commands/build metadata, accepted source-delta phase, Synthi artifact transport, epoch publication, dispatch trace, host identity, same-process app-hook contract, or post-dispatch output/visual oracle proof was observed
large ROCm matrix behavior: all real ROCm ML rows remain refusal_proven, not GPU HMR success; the retained MIOpen rows have source-delta compile-projection evidence, shared source-tree transport evidence, external-header dependency evidence, generic runtime-adapter execution evidence, and adapter-result transport evidence, but no accepted runtime bridge closure or visual/output oracle. hipBLASLt and Composable Kernel still lack accepted current source-delta execution. All still lack Synthi artifact transport into the target process, same-process epoch publication, dispatch trace, host identity, app-hook contract proof, and output-oracle observation.
historical matrix after this rerun: mcp/synthi-mcp/.gpu-hmr-test-logs/validation-matrix/gpu-hmr-validation-matrix-20260627T145309Z.json, gpu-validation-matrix-ledger:sha256:4c72bbb92788e13681d9f6fee77f15b8f85fd13dd3c3cb27c42ed5626c3369f4, with the then-current broad result of 67 rows, 22 scoped full-runtime rows, 0 broad library-agnostic rows, and MIOpen still `refusal_proven`

Fresh large-ML rerun sequence:

- `gpu-real-rocm-MIOpen-20260629-checkpoint2.json`: checkpointed profile-driven MIOpen run using shared CAS source-tree transport and external `half/half.hpp` prerequisite evidence. It reached the real upstream lifecycle, executed source-delta compile projections for hot delta 1, hot delta 2, and negative edit, wrote a fail-closed retained checkpoint before runtime evidence collection, then wrote the final retained artifact after runtime evidence collection. The matrix row is `historical-gpu-validation-matrix-row-sha256-16305e7aef533eb74ffd73e8fdda199da25aef72e27be2fbb6710b632d32b235`, runtime proof `gpu-runtime-proof:sha256:4539a61af192d16ed56006d79ce1306121df369cf29adc7d6f8b8ec07c4457fd`, ledger `gpu-ledger-proof:sha256:d4276ec0e4eee3a406c823bb9e170890d0ebc1490fafa1cc5477f3e29eb4a770`, `gpuHmrSuccess=false`, and `fullRuntimeProven=false`. It remains refused because no Synthi artifact transport, epoch publication, dispatch trace, host identity, app-hook runtime observation, output oracle, firewall proof, or strict runtime-proof closure was observed.
- `gpu-real-rocm-MIOpen-20260629163046.json`: after restoring the compose stack, the profile-driven MIOpen rerun reached the real upstream source tree, used shared CAS source-tree transport, materialized the external `ROCm/half.git` header prerequisite from exact commit `10abd99e7815f0ca5d892f58dd7d15a23b7cf92c`, seeded 8,344 files into the workspace, recovered metadata, executed hot_delta_1/hot_delta_2/negative_edit source-delta compile projections, ran the generic packaged runtime-adapter template, copied the adapter result manifest, and captured 4 native runtime boundary lines. It still failed closed with runtime proof `gpu-runtime-proof:sha256:549856b2d75a76af2dff51ea9fa1fa97664473eff4c1d1466b18dffb96fbf850`, ledger `gpu-ledger-proof:sha256:4803174dc4471e01f8ddb7248ef505c66b491a8218b325d6ae578a77738274c1`, historical row `historical-row-sha256:1833bfcd8d27d5a763e2ef86819e241f7ef75a07e1c916daf381f711245ca2af`, `gpuHmrSuccess=false`, and `fullRuntimeProven=false` because adapter result transport and native boundary lines are evidence only, not Synthi artifact transport, epoch publication, dispatch trace, host identity, app-hook runtime observation, output oracle, firewall proof, or strict runtime-proof closure.
- `gpu-real-rocm-MIOpen-20260629162905.json`: immediate preflight retry while the worker was restarting and `signaling-server` was unavailable. It emitted a structured strict refusal with `gpuHmrSuccess=false`; this is infrastructure refusal evidence only and is superseded by the richer `20260629163046` run for current MIOpen analysis.
- `gpu-real-rocm-MIOpen-20260628193652.json`: current shared-source-transport and missing-dependency-probe rerun configured successfully, recovered upstream metadata, staged the upstream source tree through the shared CAS mount with `transfer_operation=cas_shared_volume`, `hot_path_optimized=true`, worker-inspected commit `06977176afd94476c18d5290f21cb40745bb73a9`, `source_tree_listing_hash=sha256:91d1b933061ae6b6005e7f7b5ec2b47936f4868bad1254da3bbf55dabd5d749c`, and no transport blocking gaps; it still failed closed with runtime proof `gpu-runtime-proof:sha256:f5e78adb4ca5011aa8c003736976329fb22026d5ea6684f5e903f5d2980a508c` because the upstream build stopped on `half/half.hpp`, the generic missing-dependency probe recorded `missing_dependency:half_half.hpp`, and no Synthi artifact transport, epoch publication, dispatch trace, host identity, app-hook, or post-dispatch output-oracle evidence was observed.
- `gpu-real-rocm-MIOpen-20260628160523.json`: previous shared-source-transport rerun configured successfully, recovered upstream metadata, staged the upstream source tree through the shared CAS mount with `transfer_operation=cas_shared_volume`, `hot_path_optimized=true`, worker-inspected commit `06977176afd94476c18d5290f21cb40745bb73a9`, and no transport blocking gaps; it still failed closed with runtime proof `gpu-runtime-proof:sha256:d57e29064021bab3b5f17369479581ff46734e4aada200fba23f49971bee4bc2` because the upstream build stopped on `half/half.hpp` and no Synthi artifact transport, epoch publication, dispatch trace, host identity, app-hook, or post-dispatch output-oracle evidence was observed.
- `gpu-real-rocm-MIOpen-20260628111824.json`: earlier shared-source-transport rerun configured successfully, recovered upstream metadata, staged the upstream source tree through the shared CAS mount with `transfer_operation=cas_shared_volume`, `hot_path_optimized=true`, worker-inspected commit `06977176afd94476c18d5290f21cb40745bb73a9`, and `sourceTreeManifestHash=sha256:5fa84546a9023cd7f543ee7b2576ebbc3355ee29a2f6bd2a6d77e2b06caa11b6`; it still failed closed with runtime proof `gpu-runtime-proof:sha256:5b4fc3e7927af47396060d47ea8c6959f2cad18dc38e7614612bfcc183b1d831` because the upstream build stopped on `half/half.hpp` and no Synthi artifact transport, epoch publication, dispatch trace, host identity, app-hook, or post-dispatch output-oracle evidence was observed.
- `gpu-real-rocm-MIOpen-20260628100013.json`: repeated the profile-driven source-delta compile-projection path, emitted accepted source-tree transport evidence with unresolved hot-path gaps because shared mounts were not declared, captured four nonblank supplemental diagnostic screenshots, bounded impossible proof waits with `skip_async_runtime_waits=true`, and failed closed with runtime proof `gpu-runtime-proof:sha256:1a58715477f9c7f3291d004fd6f5b6a752462bd4739c896b13d2ba4127fdf8f8`.
- `gpu-real-rocm-MIOpen-20260627140744.json`: first live retry after timeout-intelligence hardening reached Docker daemon preflight but the worker container was restarting because `signaling-server` was absent, so ROCm arch detection could not run. The result failed closed with rejected runtime proof `gpu-runtime-proof:sha256:4c958a99f41197d370e23c08b40662b4f22fea7ee90d43dcd233a269c208ffea`, no visual or compute oracle, no artifact transport, no epoch, no dispatch, no host identity, and no output oracle.
- `gpu-real-rocm-MIOpen-20260627140846.json`: after `docker compose up -d signaling-server worker` restored `vectant-ade-signaling-server-1` and a running `vectant-ade-worker-1`, the same profile-driven MIOpen attempt reached the upstream repository path (`7869` files) and ROCm capability preflight, but CMake configure failed on `missing_dependencies=boost_filesystem` before metadata/source-delta/HMR proof could be collected. The result failed closed with rejected runtime proof `gpu-runtime-proof:sha256:f9a583d1be686238355729f2f45f34596771926c143fc859a9cfdf8cc492f465`; runtime stage obligations still report missing artifact transport, epoch publication, dispatch trace, host identity, and output oracle. This is serious large-ML refusal evidence only, not GPU HMR acceptance.
- `gpu-real-rocm-MIOpen-20260627143055.json`: after adding generic Boost prerequisites to the active worker image path, MIOpen progressed to the next upstream configure prerequisite and failed on `UNZIPPER` / `bzip2`; rejected runtime proof `gpu-runtime-proof:sha256:a947b3251da3229ab58a6ceb6303ca1cef500948fdff9e4c6f8c74436a44f1fd`, `gpuHmrSuccess=false`. The missing-dependency parser was generalized to classify CMake `find_program` failures such as this instead of special-casing MIOpen.
- `gpu-real-rocm-MIOpen-20260627144058.json`: after adding the real `bzip2` tool to the active worker image, MIOpen configured successfully, recovered metadata, executed hot_delta_1, hot_delta_2, and negative-edit source-delta compile projections, then failed the upstream build on `half/half.hpp`; rejected runtime proof `gpu-runtime-proof:sha256:351e1a51f6eb9fcdd5419d80392208fcded48da13cd7187594747faf468fd323`, ledger `gpu-ledger-proof:sha256:20e5c46a402616c491b3f86fd62a8bc7f913c7c76a4adf5e5968477b2e314b2b`, `gpuHmrSuccess=false`, `fullRuntimeProven=false`, no accepted visual proof, no artifact transport, no epoch, no dispatch, no host identity, and no output oracle.
- `gpu-real-rocm-MIOpen-20260625161446.json`: Docker daemon was available but the worker container was restarting; the generic runtime-evidence collector stayed total and emitted rejected runtime proof `gpu-runtime-proof:sha256:da5f31d58fb579894d5029ea59ea649bc15cd2fea638bffec14971011b329eb3`, `gpuHmrSuccess=false`.
- `gpu-real-rocm-MIOpen-20260625161658.json`: stable worker reached upstream CMake on ROCm `gfx1201` and refused on `missing_dependencies=nlohmann_json`; rejected runtime proof `gpu-runtime-proof:sha256:0a56bcdc5d0775b1a1d5b605097506eaf8dabf62145c380a0fbed87eb05ce085`, `gpuHmrSuccess=false`.
- `gpu-real-rocm-MIOpen-20260625162645.json`: after rebuilding/recreating the worker image and verifying the generic nlohmann/gfortran/native-observer packages, MIOpen reached upstream CMake and refused on `missing_dependencies=boost_filesystem`; rejected runtime proof `gpu-runtime-proof:sha256:4f0d1c08b0c86da2e039887ab7d788a3009b7f1957c16c784021261cf9adc743`, `gpuHmrSuccess=false`.
- `gpu-real-rocm-MIOpen-20260625190432.json`: after adding Boost prerequisites, MIOpen progressed further and refused on `missing_dependencies=zstd`; rejected runtime proof `gpu-runtime-proof:sha256:354eeb421de7800b1ac8fc4a5737bcafb92f9e85ffb07356d60ac1d239bbdcb8`, `gpuHmrSuccess=false`.
- `gpu-real-rocm-MIOpen-20260625192949.json`: after adding and verifying zstd prerequisites, MIOpen configured successfully, reached the upstream `MIOpenDriver` build, and refused on `missing_dependencies=half/half.hpp`; rejected runtime proof `gpu-runtime-proof:sha256:17a668d790c295372bbbe9d7a61d519e43b79b4ec1a2959001a8b36a1ed0dcd8`, `gpuHmrSuccess=false`.
- `gpu-real-rocm-MIOpen-20260626084106.json`: with Docker and `vectant-ade-worker-1` restored, the profile again configured successfully, reached the upstream `MIOpenDriver` build, and refused on `missing_dependencies=half/half.hpp`; rejected runtime proof `gpu-runtime-proof:sha256:58efab7c81ce89a6ba7fc772dbfb01a65b9cc83a4dd267db4f82c5de25881a17`, `gpuHmrSuccess=false`.
- Boost filesystem/program-options/system, bzip2, and zstd dependencies are committed as real image prerequisites, not installed into the running container and not used as one-off shims. They were verified in the rebuilt active worker image. The next MIOpen blocker is `half/half.hpp`; `libhalf-dev` was checked separately but does not provide that include path, so no symlink, vendored header, or compatibility shortcut was added. This remains prerequisite progress only, not GPU HMR acceptance.

Post-refresh large ROCm ML gate hardening: `large_rocm_ml_infrastructure` final-acceptance profiles must now declare `proofObligations.requiresRunModes=true` and `proofObligations.requiresNegativeEdit=true` and configured hot-delta-2/negative-edit source-delta fixture candidates in addition to full-runtime, output-oracle, and app-hook obligations. This is keyed by profile schema fields and `targetClass`, not repo names. Fixture declarations are configuration-only (`profile_configuration_only_not_runtime_proof`) until a rerun records the extra phases, and even declared phases cannot satisfy the gate unless the runner records source/write/compile-attempt evidence plus content-addressed before/after/edit hashes. The current retained MIOpen row records hot-delta-1, hot-delta-2, and negative-edit source-delta compile projections, but those phases are evidence-only because no load-device bridge, device-sidecar runtime material, artifact transport, epoch publication, dispatch trace, host identity, app-hook, output oracle, or accepted runtime proof was collected. Composable Kernel and the latest hipBLASLt selected rows still lack accepted current source-delta execution. This improves fail-closed auditability only; it does not convert retained large ROCm ML rows into accepted GPU HMR.

Latest bounded Docker preflight refusals: `npm --prefix mcp/synthi-mcp run proof:real-rocm:large-ml-miopen`, `proof:real-rocm:large-ml-composable-kernel`, and `proof:real-rocm:large-ml-hipblaslt` on 2026-06-25 wrote `mcp/synthi-mcp/.gpu-hmr-test-logs/real-rocm-results/gpu-real-rocm-MIOpen-20260625211218.json`, `mcp/synthi-mcp/.gpu-hmr-test-logs/real-rocm-results/gpu-real-rocm-composable-kernel-20260625212751.json`, and `mcp/synthi-mcp/.gpu-hmr-test-logs/real-rocm-results/gpu-real-rocm-hipBLASLt-20260625213127.json`, then refused before container resolution with `docker_daemon_unavailable_or_timeout`, `available=false`, `timeout_ms=8000`, `gpu_hmr_success=false`, and `full_runtime_proven=false`. A newer MIOpen rerun, `mcp/synthi-mcp/.gpu-hmr-test-logs/real-rocm-results/gpu-real-rocm-MIOpen-20260625231738.json`, also failed closed at the bounded Docker preflight and retained target-progression ledger `target-progression-ledger:sha256:146d2c6cc05d67f322aea0b1c898224660dd6603cba2d88b0825923dd52b0405`. The retained target-progression artifacts for those runs record `entryStatus=fail`, `failureCount=5`, and failed gates for missing prior small-oracle, prior partial-reload, prior original-host-path, full runtime, and compute oracle artifacts. These artifacts prove infrastructure failure is explicit and non-success; they are not large ROCm ML GPU HMR acceptance, and the matrix can still prefer older upstream-lifecycle refusal rows when they have stronger attempt-completeness evidence.
partial-run guard: matrix selection now scores real ROCm attempt completeness before freshness, so a newer strict-runtime refusal without upstream lifecycle evidence cannot replace a retained upstream-lifecycle refusal for the same target
```

Historical MIOpen large ROCm ML infrastructure validation (superseded by the current refresh above):

```text
profile: mcp/synthi-mcp/scripts/profiles/real-rocm-miopen-activation-large-ml.json
command: npm --prefix mcp/synthi-mcp run proof:real-rocm:large-ml-miopen
repo: https://github.com/ROCm/MIOpen.git @ 06977176afd94476c18d5290f21cb40745bb73a9
result slug: gpu-real-rocm-MIOpen-20260625082545
retained result path: mcp/synthi-mcp/.gpu-hmr-test-logs/real-rocm-results/gpu-real-rocm-MIOpen-20260625082545.json
latest alias at run time: mcp/synthi-mcp/.gpu-hmr-test-logs/real-rocm-results.json
manual log: mcp/synthi-mcp/.gpu-hmr-test-logs/manual-runs/miopen-large-ml-20260625T-retained-ledger.stdout.log
target: MIOpenDriver activ -n 1 -c 1 -H 8 -W 8 -F 1 -V 1 -t 1
entry file: src/kernels/MIOpenNeuron.cl
delta file: src/kernels/activation_functions.h
repo files: 7869 git files
worker status: `vectant-ade-worker-1` was running and reported ROCm/gfx1201 capability during this proof refresh
runtime device preflight: observed but not accepted for original-host-path proof; HIP array allocation matrix failed and `hipMallocArray` returned invalid argument
runtime capability preflight matrix facet: rejected, so the row remains refused
upstream configure/build/run: CMake configure failed, build was blocked by configure failure, and run was not started
upstream lifecycle refusal facet: accepted_as_refusal_evidence=true, reasons=cmake_configure_failed,missing_build_dependency,upstream_build_blocked_by_configure,upstream_run_not_started_after_configure_failure,upstream_lifecycle_command_failed, missing_dependencies=SQLite3,SQLite3_INCLUDE_DIR,SQLite3_LIBRARY
native runtime evidence: native launch observer was requested, but no readiness, launch, function-resolution, argument-provenance, runtime-session, artifact-transport, epoch, dispatch, output-oracle, host-identity, or original-host-path lines were captured before configure failure
split projection: no fresh AI split/delta calls in this rerun
delta projection: none accepted; configure failure occurred before compile/delta proof material was collected
compile bridge facet: status=compile_bridge_missing, phase_count=0, load_device=false, device_sidecar=false, artifact_reference=false, runtime_proof_material=false, gap=compile_response_device_sidecar_bridge_not_declared
device sidecar contract facet: no sidecar contract accepted; static candidate metadata is evidence-only and cannot satisfy runtime proof
hot path timings: total_validator_wall_time=24020.0527ms, metric_clock=monotonic_ns, evidenceAuthority=timing_telemetry_only
strict result: refused, gpu_hmr_success=false, runtime_proof_artifact=gpu-runtime-proof:sha256:d1f6d1a507eb4fade9bc3467028d678d22088a6808014c910487ff4c1aa332ef, proof_artifacts=[]
refusal reason: upstream configure/build/run did not produce usable metadata and the Synthi runtime proof chain is missing; strict runtime artifact gate failed with runtime_full_proof_not_proven, runtime_proof_artifact_gpu_hmr_success_false, runtime_proof_artifact_stage_failed, runtime_proof_artifact_limitations_present, proof ledger rejection, and acceptance contract rejection
oracle resolution: requested_profile=none, source_derived_candidates=0, selected_source=null, contract_present=false, runtime_profile_present=false, worker oracle profile cleared, syncSkippedReason=runtime_profile_absent
target progression: final-acceptance, required=true, target=MIOpenDriver, failed gates=prior small-oracle, prior partial-reload, prior original-host-path, full runtime, raw compute oracle artifacts
worker evidence: no synthi_gpu_launch dispatch lines, no artifact_transport lines, no dispatcher_epoch lines, no output_oracle lines, no host_identity lines, and no original_host_path attachment lines
native ROCm refusal facet: status=not_observed, can_satisfy_dispatch_proof=false, native_launch_observed=false, output_oracle_profile_absent=true
real ROCm app-hook contract facet: declared=false, can_satisfy_runtime_proof=false, stages missing artifact_transport, epoch_publication, dispatch_trace, host_identity, and output_oracle
real ROCm runtime eligibility facet: status=refused_missing_runtime_proof, backend_candidates=hip, gaps=artifact_transport_not_observed,same_process_epoch_missing,dispatch_epoch_missing,output_oracle_profile_absent,host_identity_not_observed
visual result: no MIOpen frame captured; matrix marks visual.required=false for this compute-only target and still refuses because strict runtime ledger and raw output-oracle proof are missing
matrix row: real_rocm_repo_validation, backend=hip, outcome=refusal_proven, proof_chain=real_rocm_strict_runtime_refusal
refusal proof ids: gpu-ledger-proof:sha256:00a7d7fad085eaeceb8b4c3f2f21770bd1dafe293f51da8a2bf47fcf91c4ccab, gpu-runtime-proof:sha256:d1f6d1a507eb4fade9bc3467028d678d22088a6808014c910487ff4c1aa332ef, real-rocm-validation:sha256:bc99a66ae4b08cebba28b990f79d906cb1474d127176345b1dfcc41e23b1b447
historical matrix row hash: sha256:ac0e20c7d37454df2f272747c99e76ab058a7557e25a6dd9da53f242646f7468 in mcp/synthi-mcp/.gpu-hmr-test-logs/validation-matrix/gpu-hmr-validation-matrix-20260625T082827Z.json; retained per-run result artifacts keep this MIOpen row queryable as historical refusal evidence
historical matrix open gaps: strict runtime proof artifact rejected, proof ledger success false, output or visual oracle proof missing, output oracle disabled/missing, app-hook contract/runtime observations missing, target-progression gates failed, runtime capability preflight missing, runtime chain missing, artifact transport not observed, same-process epoch missing, dispatch epoch missing, host identity not observed
plan coverage: large_real_rocm_repo=refused
```

Current retained real ROCm matrix multiplication compute-oracle validation:

```text
profile: mcp/synthi-mcp/scripts/profiles/real-rocm-matrix-multiplication.json
command: npm --prefix mcp/synthi-mcp run proof:real-rocm:matrix-multiplication
repo: https://github.com/ROCm/rocm-examples.git @ c121d6d2e6a21ce1d0a140e97b890ada635f7574
result slug: gpu-real-rocm-rocm-examples-20260626180604
retained result path: mcp/synthi-mcp/.gpu-hmr-test-logs/real-rocm-results/gpu-real-rocm-rocm-examples-20260626180604.json
latest alias path: mcp/synthi-mcp/.gpu-hmr-test-logs/real-rocm-results.json
manual log: mcp/synthi-mcp/.gpu-hmr-test-logs/manual-runs/rocm-matrix-multiplication-20260625T-retained-ledger.stdout.log
target: hip_matrix_multiplication
entry file: HIP-Basic/matrix_multiplication/main.hip
upstream build/run: configure_ms=2109, build_ms=2356, run_ms=273, run_exit_code=0
output oracle resolution: requested_profile=hip.matrix-multiplication.readback-c.v1, source_derived_candidates=1, selected_source=source_derived_profile, runtime_profile_present=true, runtime_profile_synced=true
output oracle contract: oracle=oracle:real-rocm:matrix-readback-c:b8f18aad760bfaf7, kind=buffer_checksum, output=HIP-Basic/matrix_multiplication/main.hip:C, baseline=sha256:aaedc7073c76880db6c8be81a91229d0073f1069e70791a7d028f575910c352c, expected=sha256:e7352404a601e877e39b4ae06181ce1597e93ccbbb2c9d654eb9df479bb9a858
candidate artifact entry point: matrix_multiplication_kernel
native runtime evidence: hipLaunchKernel observed through native launch observer; function_resolution_count=0
target progression: phase=small-oracle, required=true, final_acceptance_target=MIOpenDriver, gates=phase pass, non-final target pass, output oracle fail because runtime_dispatch_not_observed
compile bridge facet: status=compile_bridge_missing, phase_count=2, compile_response_status=compile_bridge_not_declared_by_compile_response, top_level_keys=ok/session_id/language/filename/dispatched_at/note, load_device=false, device_sidecar=false, artifact_reference=false, runtime_proof_material=false, gap=compile_response_device_sidecar_bridge_not_declared
hot path timings: device_compile_wall_time=30012ms, runtime_probe_time=273ms, total_validator_wall_time=111530.1157ms
strict result: refused, gpu_hmr_success=false, runtime_proof_artifact=gpu-runtime-proof:sha256:eb3142d64c24139e889ac88d133f9c1d32b5bb89c32b495a757c8ab92208353e
proof ledger: gpu-ledger-proof:sha256:082b9c2047b67d8c5ab02e576739ead14c145ab3c9433fb7d0af4c1df8fa7df2, gpu_hmr_success=false
refusal reason: native HIP launch evidence is evidence-only and cannot satisfy GPU HMR; no synthi_gpu_launch dispatch, artifact_transport, dispatcher_epoch, host_identity, or runtime output_oracle observation was collected
native ROCm refusal facet: status=refusal_evidence, can_satisfy_dispatch_proof=false, gaps=native_launch_boundary_observed,native_boundary_not_synthi_dispatch_proof,synthi_dispatch_not_observed,artifact_transport_not_observed,epoch_not_observed,output_oracle_not_observed,host_identity_not_observed,adapter_impossible_requires_app_hook
real ROCm app-hook contract facet: status=required_app_hook_contract_missing, declared=false, required=true, can_satisfy_runtime_proof=false, gaps=app_hook_contract_not_declared,app_hook_artifact_transport_evidence_missing,app_hook_artifact_transport_runtime_not_observed,app_hook_epoch_publication_evidence_missing,app_hook_epoch_publication_runtime_not_observed,app_hook_dispatch_trace_evidence_missing,app_hook_dispatch_trace_runtime_not_observed,app_hook_host_identity_evidence_missing,app_hook_host_identity_runtime_not_observed,app_hook_output_oracle_evidence_missing,app_hook_output_oracle_runtime_not_observed
current matrix row: real_rocm_repo_validation, backend=hip, outcome=refusal_proven, proof_chain=real_rocm_strict_runtime_refusal
current matrix proof ids: gpu-ledger-proof:sha256:dcdae848ef9e472b97bb5821fb4bf6217c416344eee7af8272a3fa9ccdf07094, gpu-runtime-proof:sha256:cfe0cee1c16ca66d1689c0188e987a608401e38dea80ca265b3482f6a7b477f6, real-rocm-validation:sha256:5be5c7e7314890567298b97e98a9c7ac3ec5915f31125c125aafaeebf6a4dbf7
current matrix row id: historical-gpu-validation-matrix-row-sha256-ab0cb77eb89e7aa8061f3a10a7a3401f4288b0615d39b276cb9ba40ef45c767e in mcp/synthi-mcp/.gpu-hmr-test-logs/validation-matrix/gpu-hmr-validation-matrix-20260630T061201Z.json
current matrix open gaps: strict_runtime_proof_artifact_required, proof_ledger_success_required, output_or_visual_oracle_proof_required, real_rocm_runtime_chain_required, real_rocm_app_hook_contract_required, target_progression_gates_failed, native_boundary_not_synthi_dispatch_proof, artifact_transport_not_observed, same_process_epoch_missing, dispatch_epoch_missing, output_oracle_missing, host_identity_not_observed
visual artifacts: first-compile screenshot sha256:fabb6d488f6cf82695a5ac6e7d9d47bbb5d4290e38675dd66dbae4ad18c459e0 and post-HMR screenshot sha256:109c3c9352ebcd082ead86e35714867ca6e054c1db2ff75b5e99661c8efdcdbd were opened with the local image tool on 2026-06-27; both render the same nonblank raytraced preview scene, but both have frame_capture_after_epoch_dispatch=false and are not accepted as GPU HMR output-oracle proof
visual result: compute-only target; no frame-gated visual proof is counted, and the run still refuses because the runtime ledger lacks post-epoch output-oracle observation
```

Current retained real ROCm Composable Kernel large-ML refusal:

```text
profile: mcp/synthi-mcp/scripts/profiles/real-rocm-composable-kernel-gemm-large-ml.json
command: npm --prefix mcp/synthi-mcp run proof:real-rocm:large-ml-composable-kernel
repo: https://github.com/ROCm/composable_kernel.git @ 713f1fbf46ae73755c06a0b115f01795cea9a4f9
result slug: gpu-real-rocm-composable-kernel-20260629080933
retained result path: mcp/synthi-mcp/.gpu-hmr-test-logs/real-rocm-results/gpu-real-rocm-composable-kernel-20260629080933.json
target: example_gemm_xdl_fp32_v3
entry file: example/01_gemm/gemm_xdl_fp32_v3.cpp
repo scale: 7,234 files
upstream build/run: configure completed but the requested target was not generated; build failed with "No rule to make target 'example_gemm_xdl_fp32_v3'", run was skipped, run_exit_code=not-run
metadata recovery: attempted=true, accepted=false; worker CMake File API recovery could not copy build/compile_commands.json after upstream lifecycle failure
source-delta execution: missing; because metadata recovery was rejected, no content-addressed hot_delta_1/hot_delta_2/negative_edit source-delta phase was accepted
output oracle resolution: requested_profile=none, mode=none, source_derived_candidates=0, selected_source=null, contract_present=false, runtime_profile_present=false, runtime_profile_synced=false
candidate artifact identity: artifact_kind=hip_source_bridge, entry_points=DeviceGemm_Xdl_CShuffleV3/GridwiseGemm, compile_target=gfx1201, compiler=/opt/rocm-7.2.1/llvm/bin/amdclang++
native runtime evidence: native launch observer was enabled, but no observer readiness, native launch, function-resolution, Synthi dispatch, artifact-transport, epoch, output-oracle, or host-identity lines were captured before the upstream lifecycle failed
target progression: phase=final-acceptance, required=true, final_acceptance_target=example_gemm_xdl_fp32_v3, gates failed for missing prior small-oracle, partial-reload, original-host-path, full runtime, and raw compute oracle artifacts
target progression ledger: target-progression-ledger:sha256:59ced8cb24a51da0d10cb0bfd35751b5b4f53e8cce7ae41909210779da2b918b
compile bridge facet: status=compile_bridge_missing, phase_count=0, load_device=false, device_sidecar=false, artifact_reference=false, runtime_proof_material=false, gap=compile_response_device_sidecar_bridge_not_declared
timings: total_validator_wall_time=62268.3436ms, duration_monotonic_ns=62268343600, metric_clock=monotonic_ns, metric_scope=hot_delta_1, cache_state=clean
strict result: refused, gpu_hmr_success=false, full_runtime_proven=false, runtime_proof_artifact=gpu-runtime-proof:sha256:e4b7490798b73ac22cb238481fb7140c17e69fc52fa4f0515ac880f5e42b8917
proof ledger: gpu-ledger-proof:sha256:47b87d7f99629443df636ab4feffda4d96e896b6693adc6908e6a7d966df437f, gpu_hmr_success=false
top-level verdict failed gates: full_runtime_ladder_not_proven, strict_runtime_proof_artifact_gpu_hmr_success_false, strict_runtime_proof_artifact_not_accepted, strict_proof_gates_failed, target_progression_gates_failed
refusal reason: serious ROCm ML source/build metadata is evidence-only; no Synthi artifact transport, epoch publication, dispatch trace, host identity, output-oracle observation, accepted app-hook contract, accepted sidecar/runtime consistency, or accepted runtime proof chain was collected
native ROCm refusal facet: status=not_observed, can_satisfy_dispatch_proof=false, native_launch_observed=false, output_oracle_profile_absent=true
real ROCm app-hook contract facet: status=not_required at the facet level because no native launch was observed, while profile proof obligations still require an app-hook contract before final acceptance; no stage evidence exists for artifact transport, epoch publication, dispatch trace, host identity, or output oracle
current matrix row: real_rocm_repo_validation, backend=hip, outcome=refusal_proven, proof_chain=real_rocm_strict_runtime_refusal
current matrix proof ids: gpu-ledger-proof:sha256:47b87d7f99629443df636ab4feffda4d96e896b6693adc6908e6a7d966df437f, gpu-runtime-proof:sha256:e4b7490798b73ac22cb238481fb7140c17e69fc52fa4f0515ac880f5e42b8917, real-rocm-validation:sha256:0ef6a766db88c27608969c3148dbb044397e9edd01b345abbddadcf4054bddb5
current matrix row id: historical-gpu-validation-matrix-row-sha256-378ebb4fb4a2db179a838fc1372c17f0f652a4874cb918963f9d7a3dbe1091b6 in mcp/synthi-mcp/.gpu-hmr-test-logs/validation-matrix/gpu-hmr-validation-matrix-20260630T061201Z.json
current matrix open gaps: strict runtime proof artifact rejected, proof ledger success false, output or visual oracle proof missing, output oracle disabled/missing, runtime chain missing, app-hook contract required by profile proof obligations, target-progression gates failed, runtime capability preflight failed, artifact transport not observed, same-process epoch missing, dispatch epoch missing, host identity not observed
visual artifacts: none; compute-only target with no frame-gated visual proof, and no raw readback/card output-oracle artifacts were produced after a Synthi epoch dispatch
```

Current real ROCm hipBLASLt fused GEMM/GELU/AUX/bias large-ML refusal:

```text
profile: mcp/synthi-mcp/scripts/profiles/real-rocm-hipblaslt-gelu-aux-bias-large-ml.json
command: npm --prefix mcp/synthi-mcp run proof:real-rocm:large-ml-hipblaslt
repo: https://github.com/ROCm/hipBLASLt.git @ 3a609b06926c8227e753b62087555e1f435bf2d4
result slug: gpu-real-rocm-hipBLASLt-20260629081428
retained result path: mcp/synthi-mcp/.gpu-hmr-test-logs/real-rocm-results/gpu-real-rocm-hipBLASLt-20260629081428.json
target: sample_hipblaslt_gemm_gelu_aux_bias
entry file: clients/samples/08_gemm_gelu_aux_bias/sample_hipblaslt_gemm_gelu_aux_bias.cpp
repo scale: 2,860 tracked files
upstream build/run: CMake configure failed before build/run because Python development/module components were missing; build was blocked by configure failure and run_exit_code=not-run
missing dependencies: Python, Python_EXECUTABLE, Python_INCLUDE_DIRS, Interpreter, Development.Module
output oracle resolution: requested_profile=none, mode=none, source_derived_candidates=0, selected_source=null, contract_present=false, runtime_profile_present=false, runtime_profile_synced=false
device sidecar candidate: status=device_sidecar_contract_candidate_incomplete, known_rocm_backend=false, backend=unknown, source_paths=0, artifact_kind=unknown, entry_points=hipblasLtMatmul/hipblasLtMatmulAlgoGetHeuristic/hipblasLtMatmulDescSetAttribute/rocblaslt_matmul, compile_target=gfx1201, compiler=/opt/rocm-7.2.1/llvm/bin/amdclang
native runtime evidence: native launch observer was enabled, but no observer readiness, native launch, function-resolution, Synthi dispatch, artifact-transport, epoch, output-oracle, or host-identity lines were captured before configure failure
target progression: phase=final-acceptance, required=true, final_acceptance_target=sample_hipblaslt_gemm_gelu_aux_bias, gates failed for missing prior small-oracle, partial-reload, original-host-path, full runtime, and raw compute oracle artifacts
target progression ledger: target-progression-ledger:sha256:e83fe7b59222bf0f328c3887a89159cff7d0d4f1352b57f707c551b988060bda
compile bridge facet: status=compile_bridge_missing, phase_count=1, load_device=false, device_sidecar=false, artifact_reference=false, runtime_proof_material=false, gap=compile_response_device_sidecar_bridge_not_declared
runtime capability preflight: observed RX 9070 XT/gfx1201, but HIP array allocation matrix and texture fallback probes were unavailable, so original-host-path proof remains blocked
timings: total_validator_wall_time=165.6s observed by command runner; retained report metric clock is monotonic_ns and the strict proof artifact remains rejected
strict result: refused, gpu_hmr_success=false, full_runtime_proven=false, runtime_proof_artifact=gpu-runtime-proof:sha256:21145f8138742b1b35e348caf7caf7ef1e84277b90ecda0fe03efeabac6f9b6c
proof ledger: gpu-ledger-proof:sha256:eb413fad4b352da430f6f6f6203d8016bd01ef42886b934b54e950ede1916108, gpu_hmr_success=false
current matrix proof ids: gpu-ledger-proof:sha256:eb413fad4b352da430f6f6f6203d8016bd01ef42886b934b54e950ede1916108, gpu-runtime-proof:sha256:21145f8138742b1b35e348caf7caf7ef1e84277b90ecda0fe03efeabac6f9b6c, real-rocm-validation:sha256:f39918ad2e18cd41c581860b9774970ea23a8a3b525e621f739085c0d5fc0541
current matrix row id: historical-gpu-validation-matrix-row-sha256-717f37a36c9dd6463096e60c0a5aa67bb64d4668a77dc94c263db0026677a591 in mcp/synthi-mcp/.gpu-hmr-test-logs/validation-matrix/gpu-hmr-validation-matrix-20260630T061201Z.json
refusal reason: serious ROCm ML library/sample metadata is evidence-only; no build metadata, Synthi artifact transport, epoch publication, dispatch trace, host identity, output-oracle observation, accepted app-hook contract, accepted sidecar/runtime consistency, or accepted runtime proof chain was collected
visual artifacts: none; compute-only target with no frame-gated visual proof, and no raw readback/card output-oracle artifacts were produced after a Synthi epoch dispatch
prior richer attempt retained for context: gpu-real-rocm-hipBLASLt-20260626142827 recovered CMake File API metadata and executed hot_delta_1/hot_delta_2/negative_edit source-delta phases, then still refused because there was no same-process runtime bridge proof or post-dispatch output oracle.
latest attempted rerun now selected by the matrix as latest-attempt refusal evidence: gpu-real-rocm-hipBLASLt-20260629081428 reached the upstream CMake configure path and failed closed before build metadata/source-delta proof; it produced rejected runtime proof gpu-runtime-proof:sha256:9efe1c1abeed65028f44958aaa637bde151ee5076a21608f40bdb6d4eeac3b5b. The app-hook facet reports `required_app_hook_contract_missing`, `profileRequiresAppHookContract=true`, and gaps including `app_hook_contract_required_by_profile_obligation`; `gpu_hmr_success=false`.
```

Historical real ROCm hipBLASLt fused GEMM/GELU/AUX/bias large-ML refusal (older retained attempt, not superseding the current latest run):

```text
profile: mcp/synthi-mcp/scripts/profiles/real-rocm-hipblaslt-gelu-aux-bias-large-ml.json
command: npm --prefix mcp/synthi-mcp run proof:real-rocm:large-ml-hipblaslt
repo: https://github.com/ROCm/hipBLASLt.git @ 3a609b06926c8227e753b62087555e1f435bf2d4
result slug: gpu-real-rocm-hipBLASLt-20260625090303
retained result path: mcp/synthi-mcp/.gpu-hmr-test-logs/real-rocm-results/gpu-real-rocm-hipBLASLt-20260625090303.json
latest alias path: mcp/synthi-mcp/.gpu-hmr-test-logs/real-rocm-results.json
manual log: mcp/synthi-mcp/.gpu-hmr-test-logs/manual-runs/hipblaslt-large-ml-rerun-20260625T-retained-ledger.stdout.log
target: sample_hipblaslt_gemm_gelu_aux_bias
entry file: clients/samples/08_gemm_gelu_aux_bias/sample_hipblaslt_gemm_gelu_aux_bias.cpp
repo scale: 2,860 tracked files; worker checkout copy measured 7.3G under /tmp/synthi-real-rocm/hipBLASLt during the run
upstream build/run: CMake configure failed before build/run because Python development/module components were missing; build was blocked by configure failure and run_exit_code=not-run
missing dependencies: Python, Python_EXECUTABLE, Python_INCLUDE_DIRS, Interpreter, Development.Module
output oracle resolution: requested_profile=none, mode=none, source_derived_candidates=0, selected_source=null, contract_present=false, runtime_profile_present=false, runtime_profile_synced=false
candidate artifact identity: artifact_kind=hip_source_bridge, source=clients/samples/08_gemm_gelu_aux_bias/sample_hipblaslt_gemm_gelu_aux_bias.cpp, entry_points=hipblasLtMatmul/hipblasLtMatmulAlgoGetHeuristic/hipblasLtMatmulDescSetAttribute/rocblaslt_matmul, compile_target=gfx1201, compiler=/opt/rocm-7.2.1/llvm/bin/amdclang
native runtime evidence: native launch observer was enabled, but no observer readiness, native launch, function-resolution, Synthi dispatch, artifact-transport, epoch, output-oracle, or host-identity lines were captured before configure failure
target progression: phase=final-acceptance, required=true, final_acceptance_target=sample_hipblaslt_gemm_gelu_aux_bias, gates failed for missing prior small-oracle, partial-reload, original-host-path, full runtime, and raw compute oracle artifacts
compile bridge facet: status=compile_bridge_missing, phase_count=0, load_device=false, device_sidecar=false, artifact_reference=false, runtime_proof_material=false, gap=compile_response_device_sidecar_bridge_not_declared
runtime capability preflight: observed RX 9070 XT/gfx1201, but HIP array allocation matrix and texture fallback probes were unavailable, so original-host-path proof remains blocked
timings: total_validator_wall_time=244406.8801ms, duration_monotonic_ns=244406880100, metric_clock=monotonic_ns, metric_scope=hot_delta_1, cache_state=clean
strict result: refused, gpu_hmr_success=false, runtime_proof_artifact=gpu-runtime-proof:sha256:d7f374724fe99e4b95518c5be6fea8793cb713c3ab3842b0bf14a061ed2627c6
proof ledger: gpu-ledger-proof:sha256:0df91a6edd201f0bf02ace0b4d46dc2b5d56f521f0566abe0b51162a42a3e611, gpu_hmr_success=false
refusal reason: serious ROCm ML library/sample metadata is evidence-only; no Synthi artifact transport, epoch publication, dispatch trace, host identity, output-oracle observation, accepted app-hook contract, accepted sidecar/runtime consistency, or accepted runtime proof chain was collected
native ROCm refusal facet: status=not_observed, can_satisfy_dispatch_proof=false, native_launch_observed=false, output_oracle_profile_absent=true
profile proof obligations: refusal_only=true, requires_full_runtime_proof=true, requires_output_oracle=true, requires_app_hook_contract=true, app_hook_contract_declared=false
historical matrix row: real_rocm_repo_validation, backend=hip, outcome=refusal_proven, proof_chain=real_rocm_strict_runtime_refusal
historical matrix proof ids: gpu-ledger-proof:sha256:0df91a6edd201f0bf02ace0b4d46dc2b5d56f521f0566abe0b51162a42a3e611, gpu-runtime-proof:sha256:d7f374724fe99e4b95518c5be6fea8793cb713c3ab3842b0bf14a061ed2627c6, real-rocm-validation:sha256:1ac7a9444ec44f2f7220e7ef3da18e85d89143ce76a23f9ba640a2bb237645f5
historical matrix row hash: sha256:05c51af0d3e67a4fccfa61bb5419b58baa7c5ec92a568645ef450c419675e07e in mcp/synthi-mcp/.gpu-hmr-test-logs/validation-matrix/gpu-hmr-validation-matrix-20260625T090839Z.json
historical matrix open gaps: strict runtime proof artifact rejected, proof ledger success false, output or visual oracle proof missing, output oracle disabled/missing, runtime chain missing, app-hook contract required by profile proof obligations, target-progression gates failed, runtime capability preflight failed, artifact transport not observed, same-process epoch missing, dispatch epoch missing, host identity not observed
visual artifacts: none; compute-only target with no frame-gated visual proof, and no raw readback/card output-oracle artifacts were produced after a Synthi epoch dispatch
```

This is not production-grade acceptance for every arbitrary GPU project. The current accepted full-runtime scope is scoped generated/profiled ROCm/HIP preview device-artifact rows, scoped HIP module/readback rows with accepted strict runtime proof artifacts, scoped OpenCL host-runtime compute/readback rows with accepted strict runtime proof artifacts, scoped Vulkan host-runtime pipeline/readback visual proof, and the explicitly proven scoped WebGPU visual and compute/readback profiles. HIPRT CameraRays and MegaKernel direct-light-gain are preserved as source-adapted visual-profile evidence only, not accepted no-shim full-runtime GPU HMR.

Still open or refused: MIOpen full-runtime GPU HMR, real ROCm matrix multiplication full-runtime GPU HMR, real ROCm Composable Kernel full-runtime GPU HMR, real ROCm hipBLASLt full-runtime GPU HMR, strict runtime closure for sampled unprofiled arbitrary cold projects beyond source-tree intake and fail-closed diagnostics, HIPRT MegaKernel direct-light-zero, OIDN HIP output proof, OpenCL arbitrary-project/container-worker acceptance beyond the scoped host-runtime readback probe, arbitrary Vulkan application/engine/cache/command-buffer acceptance beyond the scoped host-runtime pipeline visual probe, Bevy, WebGPU compute/resource forms beyond the proven explicit storage/uniform float32 readback profile, WebGPU engine-owned pipeline caches, and WebGPU resource layouts beyond the proven visual/compute subsets. CUDA is not applicable to this local AMD ROCm matrix and still needs a separate CUDA-machine run.

## Hard Rules Preserved

- No hardcoded proof success paths were added.
- No shims were added.
- MIOpen was added as a profile-driven large real ROCm project validation target. The runner reads repo, target, build, launch, and oracle settings from the profile/env path; there is no MIOpen-specific success branch.
- Composable Kernel was added as a second profile-driven large real ROCm ML validation target. The runner reads repo, target, build, launch, native symbol, oracle, and progression settings from the generic real ROCm profile path; there is no CK-specific success branch.
- hipBLASLt was added as a third profile-driven large real ROCm ML validation target. The runner reads repo, target, build, launch, native symbol, oracle, and progression settings from the generic real ROCm profile path; there is no hipBLASLt-specific success branch.
- Large real ROCm project validation rows are matrix-ingested through generic `real_rocm_profile` evidence and still fail closed unless a strict runtime proof artifact, recomputed proof ledger, and artifact-backed output oracle are present. Top-level `output_proof.accepted=true` flags are ignored for acceptance; visual-ledger outputs require readable visual artifact files.
- Large real ROCm compute-oracle rows now re-read `raw_readback_bin`, `readback_schema_json`, and `rendered_card_png` from disk and derive hash, byte-length, deterministic-slice, schema, and PNG-card proof from those files. Embedded `raw_readback_hash_verified` or `deterministic_slice_hash_verified` booleans are not authority, and compute-ledger rows cannot pass by attaching unrelated top-level visual files.
- Real ROCm runtime output-oracle profiles now sync by configured worker container instead of MCP transport. Local MCP validation can still deliver a profile into the real worker when a profile is declared; the selected retained MIOpen upstream-lifecycle profile declares `profile=none`, so the worker oracle file was cleared and the run correctly remained refused.
- Real ROCm checkout reuse now verifies that an existing local path is a git worktree root with a valid HEAD and the expected origin remote before it is used. Invalid checkouts under the validator-owned `tmp/real-rocm/*` tree are quarantined for evidence-preserving reruns; custom paths are not modified and fail loudly.
- The worker Dockerfiles now include generic large-project build prerequisites (`ninja-build`, Python development headers/tools, SQLite development files, BZip2 development files and `bzip2` tool, msgpack C/C++ development files, nlohmann JSON, gfortran, Boost filesystem/program-options/system development files, and zstd development files). `Dockerfile.gpu` also builds the real `/usr/local/lib/synthi-gpu-native-launch-observer.so` from `cpp_src/synthi_gpu_native_launch_observer.c`, matching the non-GPU worker image. This is not an HMR proof. The active compose worker was rebuilt as image `sha256:3974e9ec25d3ca9390cf6b15c3bfcb7dbe7c994098b65160fa6ea850a3ab3f18`, and the running worker verified the generic Boost and bzip2 prerequisites before the latest MIOpen rerun still refused on `half/half.hpp` and missing runtime proof.
- Real ROCm runtime evidence is now collected from the configured worker container even when the MCP transport is local. The selected retained MIOpen upstream-lifecycle run therefore records observed native launch-boundary evidence and the absence of Synthi dispatch, artifact transport, epoch swap, output oracle, and host-preservation proof instead of treating missing docker transport as missing evidence.
- Native ROCm/HIP launch-boundary evidence is now a first-class refusal facet in the runtime proof artifact and derived acceptance contract. It is explicitly marked `can_satisfy_dispatch_proof=false`; observed native function resolution cannot satisfy GPU HMR without Synthi artifact transport, epoch publication, dispatch, output oracle, and host-preservation proof.
- Large real ROCm app-hook contracts are now generic, profile-declared evidence inputs, not project branches. Matrix ingestion fails closed when native ROCm launch-boundary evidence requires an app hook but no contract/runtime observation proves artifact transport, epoch publication, dispatch trace, host identity, and output oracle stages. Profile `evidenceRefs` must resolve against collected runtime/proof evidence before they count as contract evidence.
- Large ROCm runtime eligibility is now a separate evidence-only facet. It can identify a HIP candidate, source dialects, candidate artifact identity, compiler, and missing proof gates for a serious project such as MIOpen, but it is explicitly `candidate_metadata_only_not_gpu_hmr_success` and cannot authorize backend, dispatch, epoch, or oracle proof.
- Real ROCm runtime capability preflight is now a separate evidence-only matrix facet. The collector reads generic `runtime_capability_preflight` / `runtimeCapabilityPreflight` data from top-level results, evidence containers, validation summaries, runtime proof artifacts, and original-host proof records; failed device/allocation preflight blocks accepted real ROCm rows but cannot satisfy GPU HMR success.
- Large real ROCm profiles can now declare generic runtime output-oracle profiles and target-progression defaults. The selected retained MIOpen upstream-lifecycle profile declares `outputOracle.profile=none` and required `targetProgression.phase=final-acceptance`, so the result explicitly reports no installed oracle and fails the missing prior-phase/full-runtime/raw-compute-oracle gates instead of implying hidden proof.
- Large real ROCm ML final-acceptance profiles now require configured hot-delta-2 and negative-edit source-delta fixture candidates in addition to `requiresRunModes=true` and `requiresNegativeEdit=true`, and the matrix now requires runner-observed source/write/compile-attempt evidence with content-addressed before/after/edit hashes before those phases can count. The retained MIOpen result now records those source-delta compile-projection phases, but they remain evidence-only because no runtime bridge, artifact transport, epoch, dispatch, host identity, app-hook, output oracle, or strict runtime proof closure was collected. Composable Kernel and the latest hipBLASLt selected rows still lack accepted current source-delta execution, and all large ROCm ML rows remain refused.
- Real ROCm matrix ingestion now hard-blocks explicit disabled output-oracle resolutions. A forged final-acceptance row with `requestedProfile=none`, `mode=none`, no selected source, no contract, no synced runtime profile, valid ledger-looking materials, and raw compute oracle files remains `unproven` with `real_rocm_output_oracle_resolution_not_accepted`.
- The selected retained MIOpen upstream-lifecycle rerun records the generic compile-bridge facet as `compile_bridge_missing`: the no-device run collected no compile phase proof material and no `load_device`, device-sidecar, artifact reference, or runtime-proof material.
- The real ROCm matrix multiplication profile declares `outputOracle.profile=hip.matrix-multiplication.readback-c.v1`; the runner derives the buffer checksum oracle from source constants and the edited `b_value`, syncs that profile to the worker, and still refuses because the runtime never emitted Synthi epoch/dispatch/output-oracle evidence.
- The real ROCm Composable Kernel profile declares `outputOracle.profile=none` and `proofObligations.acceptanceMode=refusal_only`; the matrix records a candidate HIP source-bridge artifact from profile/build metadata but refuses it because no upstream target binary, Synthi runtime chain, app-hook contract, epoch dispatch, host identity, or output oracle exists.
- The real ROCm hipBLASLt profile declares `outputOracle.profile=none` and `proofObligations.acceptanceMode=refusal_only`; the latest matrix records an incomplete device-sidecar candidate with `backend=unknown` and `known_rocm_backend=false`, then refuses because upstream CMake failed before build metadata/runtime proof and no Synthi runtime chain, app-hook contract, epoch dispatch, host identity, or output oracle exists.
- Real ROCm output-oracle profiles must now declare native launch symbols. The runtime eligibility contract filters native observer placeholders such as `unknown`, so the matrix candidate artifact records `matrix_multiplication_kernel` rather than accepting an unknown entry point.
- The real ROCm matrix multiplication profile is now a required `small-oracle` progression phase for the larger `MIOpenDriver` final-acceptance target. It still refuses because the small-oracle gate requires an epoch-bound runtime output proof, not a source-derived oracle contract or native HIP launch observation alone.
- Real ROCm compile phases now retain an evidence-only compile bridge facet. The latest tightened matrix run records two successful `synthi_compile` responses with only `ok/session_id/language/filename/dispatched_at/note` top-level fields and no `load_device`, device-sidecar, artifact-reference, runtime-proof material, or matching bridge signal strings, so the matrix row carries `real_rocm_compile_bridge:compile_response_device_sidecar_bridge_not_declared` as the next bridge gap.
- Real ROCm compile bridge candidates are explicitly non-authoritative until the runtime proof chain accepts. The validator and matrix smoke test keep compile-only bridge candidates blocked with `compile_response_bridge_candidate_not_runtime_proof`, and only convert them to linked evidence after accepted runtime proof artifacts are already present.
- Real ROCm device-sidecar contracts are now recomputed after runtime proof collection. A sidecar contract can satisfy the sidecar gate only when build/profile evidence is complete and runtime artifact transport, epoch publication, dispatch trace, output oracle, host identity, and full-runtime proof are all observed. The selected retained MIOpen upstream-lifecycle rerun still derives only a candidate rooted at `src/kernels/MIOpenNeuron.cl`, so it remains refused.
- Real ROCm final-acceptance profiles now get an explicit profile proof-obligation facet. A final-acceptance profile with no output-oracle profile is blocked unless it is explicitly refusal-only, and target progression marked `required=true` implies full-runtime proof is required.
- Real ROCm validation matrix rows now derive CPU HMR, full rebuild, and process restart firewall fields from recomputed ledger/runtime firewall evidence. Accepted rows must expose all three as explicit `false`; missing evidence or forged `true` values remain refusal/open-gap material. Smoke fixtures also prove old-artifact dispatch (`dispatch_artifact_hash_mismatch`) surfaces through ledger reasons instead of being accepted.
- Large real ROCm final-acceptance progression now verifies prior `small-oracle` ledger entries from artifact-backed compute or visual oracle evidence. Compute prior rows must carry re-readable raw readback/schema/card artifacts; visual prior rows must carry re-readable image artifacts with matching content hashes.
- Large real ROCm target-progression gate failures are now hard blockers in matrix acceptance; failed prior `partial-reload` or `original-host-path` gates cannot be hidden behind otherwise successful runtime/oracle rows.
- Real ROCm target-progression ledger artifacts now merge reported gate rows with freshly derived gate rows. If a fatal/preflight path skips normal gate construction, or if a row claims `pass` while proof fields are false, the retained ledger entry is written as `fail`.
- Large real ROCm app-hook requirements now fail closed when explicitly declared through profile proof obligations, profile declarations, native-boundary app-hook gaps, or the app-hook facet itself. Missing or unproven required app-hook facets cannot be accepted by default-open ingestion.
- Real ROCm profile proof obligations now surface explicit app-hook requirements and emit `proof_obligation_app_hook_contract_missing` when a required app-hook contract is not declared.
- The validation matrix now preserves each real ROCm row's `outputOracleResolution`, `targetProgression`, `targetProgressionGates`, `nativeRocmLaunchBoundary`, `realRocmRuntimeEligibility`, and `realRocmRuntimeCapabilityPreflight` metadata, so large-project refusal gaps are machine-auditable without relying on raw logs.
- Visual matrix acceptance now decodes PNG artifacts with `sharp`; PNG headers or existing files are not enough. Run-mode visual proofs cannot opt out with `visualRequired=false`, and Flow/ray-light coverage requires accepted visual evidence.
- Docker proof runners now require explicit runtime configuration instead of baked-in endpoint/container/entry defaults.
- Visual evidence must be readable image artifacts; invalid image placeholders are rejected.
- `wait_hmr` now returns embedded proof ledger and runtime proof artifact materials for full-runtime GPU proof waits; matrix acceptance recomputes ledger invariants from those materials instead of trusting supplied summaries.
- HIPRT matrix rows require the same embedded proof-ledger/runtime-artifact chain as other full-runtime GPU HMR rows plus matrix-recomputed nonblank oracle-region proof from the persisted PNG pixels; source-adapted profile hooks still demote the row to visual-profile evidence, older HIPRT artifacts without the chain are not accepted, and blank render-region outputs are structured refusals.
- Preflight refusal rows require explicit no-shim, no-symlink, and no-synthesized-runtime evidence.
- After `37f110451`, visual HMR success cannot be derived from screenshots or pixel diffs alone. If visual proof is required, the derived proof ledger record must contain `visual_oracle_artifacts`; screenshots remain evidence inputs.
- Compute proof cards are supplemental unless the accepted target is compute-only and backed by deterministic output-oracle proof.
- After `5e1ad07b6`, a placeholder `requiredOracleId` no longer satisfies fission output proof. Fission candidates require a verified inline proposal or resolved output-oracle contract.
- One generated `.hip` file is not proof by itself. The ray-light generated split now proves per-kernel/smallest-safe fission only because the deterministic verifier saw one selected device role, one kernel, full runtime proof, and a frame-gated visual oracle. Flow still refuses per-kernel/smallest-safe fission because the selected device role owns two kernels.

## Latest Hardening Checkpoint

Additional commits since the previous status pass:

```text
794e8148b fix(gpu-hmr): bind visual scene manifests
2d7c44937 fix(gpu-hmr): bind visual profile source hashes
83060b23d fix(gpu-hmr): emit required rocm app-hook templates
d4c6b1175 feat(gpu-hmr): add profile driven visual proof runner
1ab82200d fix(gpu-hmr): refresh rocm obligation facets before result write
fb8772753 fix(gpu-hmr): require explicit hiprt backend evidence
b9b4f5be7 fix(gpu-hmr): block auto oracles for rocm final acceptance
b3e7d6d1b fix(gpu-hmr): require explicit real rocm profile
e4f82cf48 fix(gpu-hmr): recompute large ml app hook obligation
d45425c0b fix(gpu-hmr): require app hooks for large rocm final targets
72f8269a2 fix(gpu-hmr): validate app-hook stage evidence
76cc2e542 fix(gpu-hmr): allow proven native rocm bridge gate
9364f76f2 docs(gpu-hmr): refresh realistic raytrace proof ledger
46248bb8d feat(gpu-hmr): enrich deterministic raytrace visual proof
9cb1a7faf feat(gpu-hmr): add generic native rocm runtime bridge gate
f819ed03d fix(gpu-hmr): require large rocm delta fixtures
7262aaa7d docs(gpu-hmr): clarify retained rocm evidence scope
d874b3d29 docs(gpu-hmr): record refreshed large rocm refusal
e699e9ec6 build(worker): isolate boost rocm image layer
4b8fc32ef fix(worker): add boost components for large rocm builds
23f3be60a fix(gpu-hmr): keep real rocm runtime refusal collection total
65b7bb824 fix(gpu-hmr): prefer complete rocm validation evidence
e01422bed fix(gpu-hmr): classify missing cmake compilers
df0530b1f fix(gpu-hmr): package native observer in gpu worker
0c5fbb7d0 fix(worker): add fortran rocm build prerequisite
3ef9bc93c fix(worker): add nlohmann json rocm build prerequisite
14c7ef824 fix(gpu-hmr): parse cmake config package dependencies
bbede61fd fix(worker): add msgpack rocm build prerequisites
649090052 fix(worker): add bzip2 rocm build prerequisite
c6ea90ac2 fix(worker): add gpu image rocm build prerequisites
76f0409c6 docs(gpu-hmr): note rocm worker prerequisites
d78b2275b fix(worker): add generic rocm build prerequisites
52cd7ae91 fix(gpu-hmr): quarantine invalid real rocm checkouts
6e3f7e759 test(gpu-hmr): add hipblaslt large rocm profile
9b5712ee8 docs(gpu-hmr): record composable kernel refusal proof
2bd609e29 test(gpu-hmr): add composable kernel real rocm profile
e4a526acb fix(gpu-hmr): enable long-path real rocm checkouts
9d0ae2fb9 docs(gpu-hmr): record retained rocm matrix evidence
99097a274 fix(gpu-hmr): retain real rocm validation reports
0f60de944 docs(gpu-hmr): record rocm matrix refusal rerun
9f6d25a8c fix(gpu-hmr): derive webgpu companion firewall proof
88fbe7204 docs(gpu-hmr): record current rocm proof ledger
37731524f fix(gpu-hmr): narrow rocm dependency parsing
084504ab5 fix(gpu-hmr): refine real rocm failure facets
fa23f9f88 fix(gpu-hmr): classify real rocm lifecycle failures
9cd1ab966 fix(gpu-hmr): emit generated fission evidence
94bdbcd26 fix(gpu-hmr): bind generated visual profile proofs
0a1fde26d fix(gpu-hmr): normalize generated split support
98c4dff5c fix(gpu-hmr): discover real rocm worker locally
c15aa5f59 docs(gpu-hmr): record webgpu run-mode proof links
43f91dc78 fix(gpu-hmr): link webgpu run-mode support
346ab5366 fix(gpu-hmr): normalize run-mode artifact hashes
13e3dc497 docs(gpu-hmr): refresh matrix proof status
0e261cfdf fix(gpu-hmr): require explicit runtime profiles
757503e1f fix(gpu-hmr): derive visual profile coverage
05dbbfcf5 fix(gpu-hmr): recompute visual proof artifacts
98f949bbf chore(gpu-hmr): add validation matrix history proof script
3e524e72e test(gpu-hmr): surface ROCm runtime preflight failures
56ab9db70 test(gpu-hmr): require explicit firewall safety fields
0a80f4db0 test(gpu-hmr): require phase-specific target progression proof
d93af9b6c test(gpu-hmr): gate real ROCm target progression failures
b7068a698 test(gpu-hmr): fail closed on required ROCm app hooks
95ddc87b6 test(gpu-hmr): surface ROCm app hook proof obligations
1004e5d39 test(gpu-hmr): expose ROCm sidecar contracts as non-authoritative
3ec61f494 fix(gpu-hmr): require ROCm oracle launch identity
2ce7bf864 feat(gpu-hmr): add ROCm matrix compute oracle
013e3f84c docs(gpu-hmr): record HIPRT light-gain proof
0cc266cc8 test(gpu-hmr): add HIPRT light-gain runtime profile
6a56a06cd fix(gpu-hmr): verify prior ROCm oracle evidence
17e61a8a6 fix(gpu-hmr): allow raw ROCm oracle progression
0a46e00cc fix(gpu-hmr): surface ROCm app hook proof limitations
c58afb2b5 docs(gpu-hmr): record real ROCm app hook gate proof
0ed24caf9 fix(gpu-hmr): gate real ROCm app hook contracts
7c35afef9 fix(gpu-hmr): emit WebGPU negative edit refusals
872e75007 fix(gpu-hmr): emit WebGPU runtime run-mode artifacts
811a67e5b fix(gpu-hmr): surface native ROCm refusal gaps
4e94059a2 fix(gpu-hmr): require MIOpen final progression proof
07872b21c docs(gpu-hmr): record HIPRT run-mode proof acceptance
5f076adca fix(gpu-hmr): emit HIPRT negative edit refusals
bdcd846f5 fix(gpu-hmr): emit HIPRT runtime run-mode artifacts
7636b171c docs(gpu-hmr): record HIPRT run-mode coverage gap
c6ab525a0 fix(gpu-hmr): track HIPRT run-mode coverage gaps
6afcd0d64 fix(gpu-hmr): generalize ROCm backend hints
a0c42543f fix(gpu-hmr): add ROCm runtime eligibility refusals
47c63a49e fix(gpu-hmr): expose native ROCm refusal boundary
452f2fc62 fix(gpu-hmr): collect real ROCm worker evidence by container
127aa1545 fix(gpu-hmr): sync real ROCm oracle profiles by worker
40d2436f5 fix(gpu-hmr): verify real ROCm compute oracle files
918ecf566 fix(gpu-hmr): decode visual evidence before acceptance
caeb106a1 fix(gpu-hmr): expose real ROCm oracle resolution in matrix
446c89ad4 fix(gpu-hmr): report real ROCm oracle resolution
1e69a82eb fix(gpu-hmr): scope run-mode coverage obligations
28ac530f0 fix(gpu-hmr): report partial run-mode coverage
3ce8c73be fix(gpu-hmr): require artifact-backed real ROCm oracle
84d9fde83 fix(gpu-hmr): ingest real ROCm validation rows
562864cac docs(gpu-hmr): record MIOpen large ML validation
31a081d6c feat(gpu-hmr): add MIOpen large ROCm ML profile
480fc456b fix(gpu-hmr): trace real ROCm build dependencies
c0a4f373c fix(gpu-hmr): recompute HIPRT oracle-region pixels
ae6bbce3b fix(gpu-hmr): require HIPRT oracle-region proof
ffe70a830 fix(gpu-hmr): ignore stale cold-only coverage targets
76b89062f test(gpu-hmr): refresh wait proof fixture
bddd1e7eb fix(gpu-hmr): require strict ledger materials in matrix
f3a25f5df fix(gpu-hmr): embed visual ledger proof in split runs
fd136a820 fix(gpu-hmr): expose wait runtime proof materials
03175dad5 fix(gpu-hmr): wait through intermediate proof states
9103998cb fix(gpu-hmr): refresh generated split sidecar between hot deltas
b0058cbdc fix(gpu-hmr): carry fission verifier metadata into runtime proof
511936571 fix(gpu-hmr): attach runtime output oracle proposal
21224766f feat(gpu-hmr): harden matrix evidence modes
78070f28e feat(gpu-hmr): prove generated split fission
1a5bfbafd feat(gpu-hmr): add validation matrix plan coverage
acdb1f84c feat(gpu-hmr): add validation matrix ledger
7dcbbb84c feat(gpu-hmr): normalize webgpu runtime timings
66c42458d feat(gpu-hmr): add webgpu runtime visual proof
b34a7e1a1 feat(gpu-hmr): add webgpu preflight proof
f2a02a83e feat(gpu-hmr): add vulkan preflight rejection proof
732d2bcfa fix(gpu-hmr): bind narrow fission to generated topology
35232abcd fix(gpu-hmr): reject generated split per-kernel overclaims
f47a45c25 feat(gpu-hmr): add opencl preflight rejection proof
97ee6b7cc fix(gpu-hmr): enforce visual runner proof waits
e13508d27 fix(gpu-hmr): use real visual fixtures in rocm self-check
f8559c672 docs(gpu-hmr): record visual ledger hardening status
37f110451 fix(gpu-hmr): bind visual proof to ledger oracle
5e1ad07b6 fix(gpu-hmr): require resolved fission output oracle
394f6ff32 fix(gpu-hmr): bind fission contract to verifier proof
e90fc49b3 fix(gpu-hmr): derive runtime profile self-check fixture
22f003d3b fix(gpu-hmr): require complete fission contract proof
```

Most recent runner hardening:

```text
Full-runtime wait_hmr responses now expose embedded proof ledger and runtime proof artifact materials.
The agent-split visual runner embeds MCP visual oracle artifacts into recomputed proof-ledger records for hot deltas.
Hot-delta-2 visual proof now captures a fresh pre-edit baseline instead of comparing against the previous hot-delta transition.
Validation matrix rows require embedded recomputable ledgers and strict runtime proof artifacts for run-mode GPU HMR acceptance.
HIPRT warm visual rows without embedded ledgers are downgraded instead of accepted.
Preflight refusals require explicit no-shim, no-symlink, and no-synthesized-runtime evidence.
MCP compile dispatch is no longer treated as proof when a required wait/proof gate fails.
Generated device edits now require synthi_wait_hmr to apply with the required GPU proof state.
The agent-split visual runner fails immediately when the initial GPU compile produces no device compile marker.
The runner fails immediately when GPU split endpoint evidence is missing after initial compile.
```

Earlier hardening in the same pass:

```text
7dcbbb84c feat(gpu-hmr): normalize webgpu runtime timings
66c42458d feat(gpu-hmr): add webgpu runtime visual proof
b34a7e1a1 feat(gpu-hmr): add webgpu preflight proof
f2a02a83e feat(gpu-hmr): add vulkan preflight rejection proof
732d2bcfa fix(gpu-hmr): bind narrow fission to generated topology
35232abcd fix(gpu-hmr): reject generated split per-kernel overclaims
f47a45c25 feat(gpu-hmr): add opencl preflight rejection proof
37f110451 fix(gpu-hmr): bind visual proof to ledger oracle
5e1ad07b6 fix(gpu-hmr): require resolved fission output oracle
394f6ff32 fix(gpu-hmr): bind fission contract to verifier proof
e90fc49b3 fix(gpu-hmr): derive runtime profile self-check fixture
22f003d3b fix(gpu-hmr): require complete fission contract proof
```

What changed:

```text
fission_report now carries deterministic verifier identity, selection decision hash, and output_oracle_contract.
fission acceptance rejects bare placeholder oracle ids.
runtime visual proof artifacts are blocked when the derived proof ledger record lacks visual_oracle_artifacts.
strict runtime artifact gates reject invented source-consistency modes and require deterministic visual-mode evaluation for visual ledgers.
OpenCL preflight now refuses missing runtime evidence and cannot count as dispatch/readback output proof.
Vulkan preflight now refuses missing ICD/tool evidence and cannot count as pipeline, command-buffer, or frame-output proof.
WebGPU preflight now records browser, launch flags, adapter, features, limits, and a diagnostic screenshot while still refusing shader/pipeline/frame HMR proof.
WebGPU runtime visual proof now accepts executed explicit-empty WGSL and explicit-profiled uniform-buffer/float32-vertex-buffer pipeline scopes, and derives success from shared ledger invariants, visual thresholds, process-continuity evidence, native WebGPU API evidence, and resource binding traces.
The timing metrics summary collector now normalizes WebGPU runtime visual proofs into the shared `synthi.gpu.hmr.timing_metrics.v1` schema.
The validation matrix ledger collector now scans proof artifacts and separates full-runtime GPU HMR, external visual-profile proof, preflight-only evidence, structured refusal, and unproven historical attempts.
The matrix self-check includes a forged WebGPU success flag with no ledger/images and verifies it remains unproven.
The validation matrix now derives plan-coverage rows for accepted, visual-profile-only, preflight-only, refused, and missing plan requirements.
Generated split topology now rejects per-kernel HMR unless a deterministic fission verifier proves it, even when a TU contains only one kernel.
Narrow generated fission candidates now require generated-topology evidence plus a binding from generated role path to the content-addressed selected partial artifact.
Generated split deterministic fission now emits all eight required fission evidence categories and is collected as a separate proof class that cannot count as GPU HMR success by itself.
Ray-light generated split fission is accepted for `trace_light_rays`; Flow generated split fission is rejected at `symbol_ownership` because the latest selected device role contains `particle_flow` and `synthi_generated_seed_buffers`.
The validation matrix now records run-mode evidence for accepted rows and derives a separate `per_target_run_modes` coverage row instead of hiding cold/hot-delta gaps.
The matrix now reports per-target run-mode coverage as accepted, partial, or missing and requires negative-edit refusal per accepted target instead of satisfying that gate globally.
Run-mode coverage obligations are now explicit row metadata: structured run-mode proof rows infer `validationTargetScope=run_mode_target`, while other accepted full-runtime evidence rows remain `evidence_row` unless an artifact declares a run-mode obligation.
Standalone external rejection proof artifacts, including Bevy refusals, are first-class matrix rows.
WebGPU full-runtime acceptance now requires an embedded recomputable proof ledger; a supplied query without the underlying ledger is rejected as unproven.
The MCP visual split runner now emits measured monotonic timing summaries for generated device edits.
```

Fresh verification after these commits:

```text
docker run ... cargo test --release --features gpu-hmr gpu_fission --lib
  result: 66 passed after topology gate hardening

docker run ... cargo test --release --features gpu-hmr gpu_prod_contracts --lib
  result: 36 passed

npx vitest run tests/unit/gpu_hmr_runtime_proof.test.ts
  result: 279 passed

npm --prefix mcp/synthi-mcp run build
npm --prefix mcp/synthi-mcp run proof:strict-gates:self-check
npm --prefix mcp/synthi-mcp run proof:adversarial-ledger:self-check
npm --prefix mcp/synthi-mcp run proof:acceptance-contract:self-check
npm --prefix mcp/synthi-mcp run proof:runtime-profile:self-check
npm --prefix mcp/synthi-mcp run proof:webgpu:preflight:self-check
$env:SLUG='webgpu-preflight-20260609'; npm --prefix mcp/synthi-mcp run proof:webgpu:preflight
npm --prefix mcp/synthi-mcp run proof:webgpu:runtime-visual:self-check
$env:SLUG='webgpu-runtime-visual-20260609'; npm --prefix mcp/synthi-mcp run proof:webgpu:runtime-visual
npm --prefix mcp/synthi-mcp run proof:webgpu:runtime-visual:profiled
npm --prefix mcp/synthi-mcp run proof:webgpu:runtime-visual:profiled-hot2
npm --prefix mcp/synthi-mcp run proof:timing-metrics:self-check
npm --prefix mcp/synthi-mcp run proof:timing-metrics
npm --prefix mcp/synthi-mcp run proof:validation-matrix:self-check
npm --prefix mcp/synthi-mcp run proof:validation-matrix
  result: passed
npm --prefix mcp/synthi-mcp run proof:validation-matrix:history
  result: passed
npm --prefix mcp/synthi-mcp run proof:hiprt:same-process:megakernel-light-gain
  historical result before fail-closed runner hardening: passed on ROCm/RX 9070 XT worker with visual image-tool inspection; current source-adapted reruns must set `SYNTHI_HIPRT_WARM_ALLOW_REJECTED=1` and remain diagnostic visual-profile evidence, not no-shim GPU HMR success
```

## Validation Matrix Ledger

Superseded June 25 matrix artifact retained for history:

```text
schema: synthi.gpu.hmr.validation_matrix_ledger.v1
proof id: gpu-validation-matrix-ledger:sha256:267836eb676af5caf730a7e8ad94cacd68a8dc6cc390f2760eff6f2d7b8207b6
json: mcp/synthi-mcp/.gpu-hmr-test-logs/validation-matrix/gpu-hmr-validation-matrix-20260625T070719Z.json
markdown: mcp/synthi-mcp/.gpu-hmr-test-logs/validation-matrix/gpu-hmr-validation-matrix-20260625T070719Z.md
```

Current superseding matrix artifact:

```text
schema: synthi.gpu.hmr.validation_matrix_ledger.v1
proof id: gpu-validation-matrix-ledger:sha256:425a5f02cc756ee518d41fdb8ce71398ed8660b34025eb65f41a92e9f7bd3b62
json: mcp/synthi-mcp/.gpu-hmr-test-logs/validation-matrix/gpu-hmr-validation-matrix-20260629T031244Z.json
```

Matrix result:

```text
row count: 56
accepted full-runtime GPU HMR rows: 14
broad library-agnostic full-runtime GPU HMR rows: 0
computed broad readiness: accepted=false, authority=matrix_computed_not_row_declared, broadRuntimeRowsComputed=true, broadRuntimeRowsMissing=true, open gaps=matrix_level_broad_generalization_proof_not_present,broad_runtime_rows_missing,broad_acceptance_requires_more_backend_families
scoped full-runtime GPU HMR rows: 14
  realistic-raytrace
  hip-module-runtime-readback
  webgpu-wgsl-runtime-compute-storage
  webgpu-wgsl-runtime-compute-storage-hot2
  webgpu-wgsl-runtime-triangle
  webgpu-wgsl-runtime-profiled-layout
strict cold split rows: 7
deterministic fission rows: 2
  render_realistic_raytrace
  trace_light_rays
visual-profile rows: 3
  hiprt-camera-rays-horizontal-mirror
  hiprt-megakernel-direct-light-gain
  threejs-webgl-shader-lava
structurally proven refusal rows: 29
  bevy-wgsl-shader-material typed bevy_wgsl manifest-backed refusal
  generated realistic-raytrace negative edit refusal
  generated Flow negative edit refusal
  generated ray-light negative edit refusal
  real-rocm-composable-kernel-gemm-large-ml
  real-rocm-hipblaslt-gelu-aux-bias-large-ml
  real-rocm-miopen-activation-large-ml
  real-rocm-matrix-multiplication
  hiprt-camera-rays-horizontal-mirror ABI-changing negative edit refusal
  hiprt-megakernel-direct-light-gain ABI-changing negative edit refusal
  hiprt-megakernel-direct-light-zero
  oidn-hiprt-rocm-preflight-20260622-real-checkout
  oidn-hiprt-rocm-preflight-20260626-after-apphook-refresh
  oidn-hiprt-rocm-preflight-20260626-live-rerun
  oidn-preflight-20260624090147
  oidn-preflight-20260624093615
  oidn-preflight-20260624093728
  oidn-preflight-20260624095704
  oidn-preflight-20260626-runtime-split
  opencl-rocm-preflight-20260609-after-output-gate
  opencl-rocm-preflight-20260609
  vulkan-rocm-preflight-20260609
  webgpu-wgsl-runtime-profiled-layout negative edit refusal
  webgpu-wgsl-runtime-triangle negative edit refusal
preflight-only rows: 1
  webgpu-preflight-20260625-typed-backend-evidence
not-applicable rows:
  cuda_runtime hardware_scope=rocm_amd_local_run observed_backends=hip,hiprt,oidn_hip
omitted stale/unproven historical attempts by default: 622
```

Derived plan coverage:

```text
accepted:
  rocm_hip_full_runtime
  hip_module_scoped_runtime_readback
  flow_visual_gpu_path
  ray_light_visual_gpu_path
  webgpu_scoped_runtime_visual
  webgpu_empty_layout_runtime_visual
  webgpu_profiled_layout_runtime_visual
  webgpu_compute_runtime_readback
  per_kernel_smallest_safe_fission
  per_target_run_modes
visual_profile_only:
  source_adapted_hiprt_camera_rays_and_megakernel_visual_profiles
  threejs_webgl_external_engine_visual_profile
refused:
  large_real_rocm_repo
  large_real_rocm_repo:real-rocm-composable-kernel-gemm-large-ml
  large_real_rocm_repo:real-rocm-hipblaslt-gelu-aux-bias-large-ml
  large_real_rocm_repo:real-rocm-matrix-multiplication
  large_real_rocm_repo:real-rocm-miopen-activation-large-ml
  hiprt-megakernel-direct-light-zero blank oracle-region output
  oidn_hip_output
  bevy_file_loaded_wgsl
  opencl_dispatch_readback
  vulkan_pipeline_frame
preflight_only:
  webgpu_runtime_preflight
not_applicable:
  cuda_runtime
missing:
  hiprt_visual_path
  hiprt_run_modes
current coverage note: current global coverage includes source-first/profile-backed realistic ROCm raytrace visual evidence, typed WebGPU runtime-capability preflight evidence with an image-inspected diagnostic frame, and a current ThreeJS WebGL shader-lava external visual-profile row. Older focused Flow/ray-light matrices remain historical evidence, while the current global matrix is the aggregate authority.
legacy external note: the Bevy legacy timeout report is rewrapped as a typed external rejection only by matching the report profile id to the packaged profile manifest. The recovered profile selection is marked recovered, not explicit, and conflict checks reject mismatched report fields.
```

Important interpretation:

```text
ThreeJS WebGL shader-lava is current typed external visual-profile evidence only. It is `visual_profile_accepted` under `external_engine_visual_profile`, `acceptedForGpuHmr=false`, and `gpuHmrSuccess=false`; it is not full-runtime GPU HMR because it lacks the same-process loader, epoch publication, dispatch trace, host identity, and strict full-runtime proof ledger required by the plan.
WebGPU preflight is typed runtime capability evidence only; the separate webgpu-wgsl-runtime-triangle row is the scoped full-runtime WebGPU proof. The preflight row is `preflight_only` with open gap `shader_pipeline_or_output_oracle_not_proven`; it does not set GPU HMR success.
OpenCL and Vulkan now have scoped host-local strict runtime rows, while worker-container preflight for those backends remains evidence-backed refusal because the worker lacks usable ICD/tooling. Bevy remains an evidence-backed refusal, not GPU HMR acceptance; the current Bevy typed row is `historical-gpu-validation-matrix-row-sha256-b1132a777685310f5feef00547a6c714ac8ed1901cc7412e3a0bd3b7f09f2fce` with proof `external-rejection-proof:543387dc31d8a1a92e79c58a0dcc137a3eede776be7f0ac5f03881e5f3feaeec`.
The large real ROCm/MIOpen row is an evidence-backed refusal. It is matrix-ingested as a generic real ROCm validation row and remains rejected because no accepted strict runtime proof artifact exists, proof-ledger success is false, same-process app-hook contract proof is not present, output/visual oracle proof is not present, and the latest worker-backed attempt materialized the external `ROCm/half` header prerequisite, configured successfully, entered the real upstream compile, then hit the bounded upstream command window without producing runtime bridge material, dispatch, or output proof. The latest matrix row carries `outputOracleResolution` with profile `none`, no selected source, no contract, and no runtime profile; `targetProgression` at phase `final-acceptance`; plus app-hook, profile proof-obligation, runtime-capability, runtime-chain, CPU/GPU firewall, compile-bridge, runtime-eligibility, and output-oracle gaps showing that diagnostic observer setup and any non-frame-gated diagnostic screenshots are not Synthi artifact transport, epoch publication, dispatch, host identity, oracle proof, or explicit no-CPU/no-full-rebuild/no-restart proof.
The large real ROCm/Composable Kernel row is also an evidence-backed refusal. It is matrix-ingested through the same generic real ROCm profile path, retains the serious-repo checkout and candidate HIP source-bridge metadata, and remains rejected because the upstream target binary was not generated, no accepted strict runtime proof artifact exists, proof ledger success is false, output-oracle profile is disabled, app-hook proof obligations are missing, runner-observed content-addressed hot-delta-2/negative-edit source-delta execution is missing, runtime capability preflight failed, and no artifact transport, epoch publication, dispatch, host identity, or output oracle was observed.
The large real ROCm/hipBLASLt row is an evidence-backed refusal for a third serious ML infrastructure path. It is matrix-ingested through the same generic real ROCm profile path, retains the fused GEMM/GELU/AUX/bias sample path and native launch symbols, and remains rejected because the latest upstream lifecycle artifact failed at CMake Python development/module discovery before build metadata or source-delta execution, no accepted strict runtime proof artifact exists, proof ledger success is false, output-oracle profile is disabled, app-hook proof obligations are missing, and no artifact transport, epoch publication, dispatch, host identity, or output oracle was observed. The prior richer `20260626142827` run remains useful context because it recovered CMake metadata and executed hot_delta_1/hot_delta_2/negative_edit phases, but it is still refusal evidence only.
Real ROCm validation acceptance requires artifact-backed oracle evidence. A recomputed ledger can satisfy compute-output proof, but visual ledger outputs must also have readable visual files; top-level oracle success booleans are not authority.
OIDN HIP is evidence-backed refusal, not output proof. The current June 26 live worker preflight row refused because the declared HIPRT checkout/tool path was unavailable; older real-checkout preflight artifacts remain as dependency diagnostics where CPU OIDN passed, HIP device creation/readback failed, and no shim/symlink/synthesized runtime was applied.
HIPRT CameraRays and MegaKernel direct-light-gain are source-adapted visual profiles, not accepted no-shim full-runtime GPU HMR rows. The matrix recomputes their oracle-region visual evidence from persisted before/after PNG pixels and keeps them as `visual_profile_accepted`, while `hiprt_visual_path` and `hiprt_run_modes` remain missing for no-shim acceptance. HIPRT MegaKernel direct-light-zero remains a proven blank oracle-region refusal.
HIPRT target-progression probing is now packaged and self-checked as support-only evidence. `npm --prefix mcp/synthi-mcp run proof:hiprt:target-progression:self-check` verifies byte-hashed visual evidence and explicit non-acceptance fields (`acceptedForGpuHmr=false`, `gpuHmrSuccess=false`, `canSatisfyRuntimeProof=false`) on target-progression proof and ledger records; this cannot satisfy HIPRT no-shim full-runtime acceptance without the strict runtime loader, epoch, dispatch, host-identity, visual-oracle, firewall, and ledger gates.
The per-kernel/smallest-safe fission row is a deterministic fission verifier proof, not a full-runtime GPU HMR row. Runtime acceptance remains ledger-gated.
The global `per_target_run_modes` plan row is accepted for 4 enrolled run-mode targets because generated Flow, generated ray-light, scoped WebGPU explicit-empty WGSL, and scoped WebGPU explicit-profiled WGSL carry the full cold/hot1/hot2-different-edit/negative-edit sequence. SAXPY is not a current accepted full-runtime row in the latest default matrix. HIPRT run-mode artifacts remain useful visual-profile evidence only because they disclose source-adapted profile hooks.
```

Formatting note: `git diff --check` passed for the Rust fission patch. `cargo fmt --check` could not be run in the available builder-test image because rustfmt is not installed, and `cargo` is not installed on the Windows host.

Fresh verification after `78070f28e`:

```text
node --check mcp/synthi-mcp/scripts/gpu-hmr-agent-split-workspace-test.mjs
npm --prefix mcp/synthi-mcp run proof:generated-split-granularity:self-check
npm --prefix mcp/synthi-mcp run proof:validation-matrix:self-check
npm --prefix mcp/synthi-mcp run proof:validation-matrix
npm --prefix mcp/synthi-mcp run proof:strict-gates:self-check
npm --prefix mcp/synthi-mcp run proof:adversarial-ledger:self-check
npm --prefix mcp/synthi-mcp run proof:acceptance-contract:self-check
  result: passed

ray-light live MCP visual proof plus fission verifier
  workspace: ray-light-gpu-hmr-proof-20260609-fission-verifier
  runtime proof id: gpu-runtime-proof:sha256:48b7684581b5ea856e0c3878a36e039521ecba1b5f7f3b3ab270cf197d98b22e
  ledger id: gpu-ledger-proof:sha256:c08098e6daa1b66f9f9c32c3fa55f77136a283e94515e25da374d08d8f2f52ae
  visual delta: changed=5.89% mean_abs=9.91 selected_delta_ms=1057
  deterministic fission: accepted=true claim=per_kernel_hmr kernel=trace_light_rays

Flow live MCP visual proof plus fission verifier
  workspace: flow-gpu-hmr-proof-20260609-fission-verifier
  runtime proof id: gpu-runtime-proof:sha256:cdba884f9c42cb437e394af3499e9da2a8d3321a320221960f9e3f59254b56cd
  ledger id: gpu-ledger-proof:sha256:905d12006882cda3af0e441fb0a4b7f949f4bc4897563d635493a2bd9cce4d64
  visual delta: changed=2.59% mean_abs=3.58 selected_delta_ms=2659
  deterministic fission: accepted=false failure=symbol_ownership reason=selected role contains two kernels

Fresh verification after `f819ed03d`:

node --check mcp/synthi-mcp/scripts/gpu-hmr-agent-split-workspace-test.mjs
node --check mcp/synthi-mcp/scripts/lib/gpu-hmr-validation-matrix-ledger.mjs
node --check mcp/synthi-mcp/scripts/tests/gpu-hmr-validation-matrix-ledger-smoke.mjs
node mcp/synthi-mcp/scripts/tests/gpu-hmr-validation-matrix-ledger-smoke.mjs
node --check mcp/synthi-mcp/scripts/gpu-hmr-real-rocm-repo-validation.mjs
node mcp/synthi-mcp/scripts/gpu-hmr-real-rocm-repo-validation.mjs --self-check
npm --prefix mcp/synthi-mcp run proof:validation-matrix:self-check
npm --prefix mcp/synthi-mcp run proof:validation-matrix
  historical result at that checkpoint: passed, matrix gpu-validation-matrix-ledger:sha256:063c3c86f5ca99115bc3ca20aacf560fc1e6585f395b19b5d2b6ec19ec9c9083
npm --prefix mcp/synthi-mcp run proof:validation-matrix:history
  historical history audit at that checkpoint: passed, matrix gpu-validation-matrix-ledger:sha256:609d2861e9d1205c5ab1acbe807c59a98b352afa84b3ec1fd5f2c16016cbe0b6
  smoke coverage: compute-only real ROCm oracle acceptance, forged missing raw/schema/card file refusal, forged large ROCm ML final-acceptance refusal when hot-delta-2/negative-edit fixtures are absent, and generic worker-repo transfer refusal scoring
node mcp/synthi-mcp/scripts/gpu-hmr-real-rocm-repo-validation.mjs --self-check
  latest result: passed; includes generic real ROCm profile loading, runtime-dispatch evidence, CMake missing package/config/compiler parsing, git-remote normalization, and safe invalid-checkout quarantine/refusal self-checks
docker buildx build --check -f backend/synthi-webrtc-compiler/worker/Dockerfile backend/synthi-webrtc-compiler/worker
  selected retained upstream-lifecycle result at that historical checkpoint: MIOpen attempt `gpu-real-rocm-MIOpen-20260627144058.json` configured successfully, recovered metadata, failed upstream build on `half/half.hpp`, ran source-delta compile projections, and still failed closed with strict `gpuHmrSuccess=false`, runtime proof `gpu-runtime-proof:sha256:351e1a51f6eb9fcdd5419d80392208fcded48da13cd7187594747faf468fd323`, ledger `gpu-ledger-proof:sha256:20e5c46a402616c491b3f86fd62a8bc7f913c7c76a4adf5e5968477b2e314b2b`, and target progression `target-progression-ledger:sha256:2dd5bc2de0f2c4ef50652d59b3239b7bec82cf2b0339048116b4808d3c1cc20c`; newer MIOpen attempts remain non-success refusal evidence under the current matrix.

ray-light live MCP visual proof with hot-delta timing
  workspace: ray-light-gpu-hmr-proof-20260609-timing-matrix
  runtime proof id: gpu-runtime-proof:sha256:fed37d01a7b988bfd5bc25c1adeb03d2c2a6cc8082aaa8324f64aaf6a894437b
  ledger id: gpu-ledger-proof:sha256:983d2c96e1a6bd58dc3094d31a8d24b245a4a24d88754a87208abea562ea61dc
  visual delta: changed=5.89% mean_abs=9.92 control_changed=0.00% control_mean_abs=0.03 selected_seq=8673 selected_delta_ms=1098
  timing: metric_scope=hot_delta_1 cache_state=compiler_cache_warm device_compile_wall_time=17027600ns runtime_probe_time=11284379700ns total_validator_wall_time=11301664400ns
  deterministic fission: accepted=true claim=per_kernel_hmr kernel=trace_light_rays

Flow live MCP visual proof with hot-delta timing
  workspace: flow-gpu-hmr-proof-20260609-timing-matrix
  runtime proof id: gpu-runtime-proof:sha256:d853e7a6c560d96b1cf4011dd24d67d69b81d026946070f12a745dde3fcecbdb
  ledger id: gpu-ledger-proof:sha256:f5ec4c6b608520221cfe7bf2ecd6344f3d37d37d3a262eafa4a1458c2dd8e54b
  visual delta: changed=2.59% mean_abs=3.58 control_changed=0.00% control_mean_abs=0.01 selected_seq=9230 selected_delta_ms=2755
  timing: metric_scope=hot_delta_1 cache_state=compiler_cache_warm device_compile_wall_time=24515900ns runtime_probe_time=3126806700ns total_validator_wall_time=3151554600ns
  deterministic fission: accepted=false failure=symbol_ownership reason=selected role contains two kernels
```

## Historical ROCm/HIP Runtime Ledger

Historical retained strict runtime artifact. This SAXPY-era artifact is not a current accepted full-runtime row in the latest validation matrix; it is retained as older compute/readback evidence:

```text
workspace: gpu-real-rocm-repo-20260609005300
gpu vendor: rocm
gpu arch: gfx1201
runtime proof id: gpu-runtime-proof:sha256:0eebb142e6f213a0794a4649b10ab172971a7f4552cc124ab37c5f95c7a1ebd2
ledger proof id: gpu-ledger-proof:sha256:1cfa9927c27d63b9eadf4c96021f7d9270051519d822bfb55eb7b7f08b64b9eb
artifact: mcp/synthi-mcp/.gpu-hmr-test-logs/runtime-proof-artifacts/gpu-real-rocm-repo-20260609005300-real-rocm-runtime-proof-0eebb142e6f213a0794a4649b10ab172971a7f4552cc124ab37c5f95c7a1ebd2.json
result state: gpu-hmr-full-runtime-proven
full runtime proven: true
runtime proof limitations: []
output oracle: gpu-hmr-output-oracle-proven
```

Supplemental compute-output proof card:

```text
mcp/synthi-mcp/.gpu-hmr-test-artifacts/gpu-real-rocm-repo-20260609005300-oracle-real-rocm-saxpy-readback-y-d6555ff7b9f8f753-compute-output-oracle.png
```

The compute-output card was inspected with the local image viewer. It is readable and shows `Runtime Compute Output Oracle`, target `HIP-Basic/saxpy/main.hip:y`, generation 3, `PASSED`, with matching expected and actual GPU readback hashes. This is not frame-gated runtime visual proof and is not counted as current full-runtime GPU HMR by the latest matrix.

Normalized timings from the accepted run:

```text
total validator wall: 235348.1968ms
AI contract synthesis: 73919.6076ms
model availability check: 1209.3515ms
device compile wall: 30372ms
runtime probe: 237ms
dispatch trace: 3ms
oracle analysis: 3ms
dispatch to output proof: 3ms
trigger to visible/output proof: 30001ms
```

After commit `92543192f`, the accepted runtime artifact was re-summarized through the patched summary builder:

```text
summary gpu_hmr_success: true
summary full_runtime_proven: true
summary limitations: []
summary ledger success: true
summary acceptance contract accepted: true
summary acceptance contract consistency accepted: true
```

Two later real-ROCm reruns were rejected, correctly:

- `gpu-real-rocm-repo-20260609010632`: worker runtime session was lost during hot delta.
- `gpu-real-rocm-repo-20260609011410`: first compile consumed the first-phase budget and no HMR proof was produced.

Those rejected attempts are not accepted proof.

## MCP Ray-Light Visual HMR

Historical accepted MCP proof from the June 9 timing-matrix hardening. The current accepted proof is the June 22 `embedded-ledger-10` block recorded in the executive status above:

```text
workspace slug: ray-light-gpu-hmr-proof-20260609-timing-matrix
workspace url: http://localhost:3000/workspace/ray-light-gpu-hmr-proof-20260609-timing-matrix
HTTP preview check: 200
fixture: ray-light
gpu vendor: rocm
gpu arch: gfx1201
generated device compile: hipcc
device edit: .synthi/generated/gpu/device.hip
strict wait gate: requireGpuFullRuntimeProof=true
ledger id: gpu-ledger-proof:sha256:983d2c96e1a6bd58dc3094d31a8d24b245a4a24d88754a87208abea562ea61dc
runtime proof id: gpu-runtime-proof:sha256:fed37d01a7b988bfd5bc25c1adeb03d2c2a6cc8082aaa8324f64aaf6a894437b
result state: gpu-hmr-full-runtime-proven
hmr observed: [gpu-reload] plan=device_only
runner stayed alive: true
metric scope: hot_delta_1
cache state: compiler_cache_warm
device compile wall time: 17027600ns
runtime probe time: 11284379700ns
total validator wall time: 11301664400ns
deterministic fission: accepted=true claim=per_kernel_hmr kernel=trace_light_rays
```

Latest visual artifacts:

```text
mcp/synthi-mcp/.gpu-hmr-test-logs/agent-split-artifacts/ray-light-gpu-hmr-proof-20260609-timing-matrix/before-hmr-first.png
mcp/synthi-mcp/.gpu-hmr-test-logs/agent-split-artifacts/ray-light-gpu-hmr-proof-20260609-timing-matrix/after-hmr-first.png
mcp/synthi-mcp/.gpu-hmr-test-logs/agent-split-artifacts/ray-light-gpu-hmr-proof-20260609-timing-matrix/before-after-diff.png
mcp/synthi-mcp/.gpu-hmr-test-logs/agent-split-artifacts/ray-light-gpu-hmr-proof-20260609-timing-matrix/before-hmr-metadata.json
mcp/synthi-mcp/.gpu-hmr-test-logs/agent-split-artifacts/ray-light-gpu-hmr-proof-20260609-timing-matrix/after-hmr-metadata.json
mcp/synthi-mcp/.gpu-hmr-test-logs/agent-split-artifacts/ray-light-gpu-hmr-proof-20260609-timing-matrix/generated-split-granularity.json
mcp/synthi-mcp/.gpu-hmr-test-logs/agent-split-artifacts/ray-light-gpu-hmr-proof-20260609-timing-matrix/generated-split-deterministic-fission.json
mcp/synthi-mcp/.gpu-hmr-test-logs/agent-split-artifacts/ray-light-gpu-hmr-proof-20260609-timing-matrix/agent-split-results.txt
```

Latest visual proof:

```text
changed=5.89%
mean_abs=9.92
control_changed=0.00%
control_mean_abs=0.03
selected_seq=8673
selected_delta_ms=1098
```

Local visual inspection with the image viewer confirmed a nonblank ray/light diff with the ray bundle and light path visibly changed.

Accepted fresh MCP proof:

```text
workspace slug: ray-light-gpu-hmr-proof-20260609-rerun2
workspace url: http://localhost:3000/workspace/ray-light-gpu-hmr-proof-20260609-rerun2
fixture: ray-light
gpu vendor: rocm
gpu arch: gfx1201
generated device compile: hipcc
device edit: .synthi/generated/gpu/device.hip
strict wait gate: requireGpuFullRuntimeProof=true
ledger id: gpu-ledger-proof:sha256:a4730f03c1b5da395ede415501e62b3152c2ea7d85394231739e2cd75a17d3c1
runtime proof id: gpu-runtime-proof:sha256:2f3ece89da76d997b47cebe0d65322234b59d49fbe61064fd10db9c84e17ce34
result state: gpu-hmr-full-runtime-proven
hmr observed: [gpu-reload] plan=device_only
```

Visual artifacts:

```text
mcp/synthi-mcp/.gpu-hmr-test-logs/agent-split-artifacts/ray-light-gpu-hmr-proof-20260609-rerun2/before-hmr-first.png
mcp/synthi-mcp/.gpu-hmr-test-logs/agent-split-artifacts/ray-light-gpu-hmr-proof-20260609-rerun2/after-hmr-first.png
mcp/synthi-mcp/.gpu-hmr-test-logs/agent-split-artifacts/ray-light-gpu-hmr-proof-20260609-rerun2/before-after-diff.png
mcp/synthi-mcp/.gpu-hmr-test-logs/agent-split-artifacts/ray-light-gpu-hmr-proof-20260609-rerun2/before-hmr-metadata.json
mcp/synthi-mcp/.gpu-hmr-test-logs/agent-split-artifacts/ray-light-gpu-hmr-proof-20260609-rerun2/after-hmr-metadata.json
mcp/synthi-mcp/.gpu-hmr-test-logs/agent-split-artifacts/ray-light-gpu-hmr-proof-20260609-rerun2/generated-split-granularity.json
```

Visual proof:

```text
changed=5.87%
mean_abs=10.01
control_changed=0.00%
control_mean_abs=0.32
selected_seq=993
selected_delta_ms=3734
```

Visual inspection confirmed a ray/light scene before HMR and a clearly changed light/ray bundle after HMR. The diff is nonblank and high-signal.

## MCP Flow Visual HMR

Historical accepted MCP proof from the June 9 timing-matrix hardening. The current accepted proof is the June 22 `embedded-ledger-10` block recorded in the executive status above:

```text
workspace slug: flow-gpu-hmr-proof-20260609-timing-matrix
workspace url: http://localhost:3000/workspace/flow-gpu-hmr-proof-20260609-timing-matrix
HTTP preview check: 200
fixture: flow
gpu vendor: rocm
gpu arch: gfx1201
generated device compile: hipcc
device edit: .synthi/generated/gpu/device.hip
strict wait gate: requireGpuFullRuntimeProof=true
ledger id: gpu-ledger-proof:sha256:f5ec4c6b608520221cfe7bf2ecd6344f3d37d37d3a262eafa4a1458c2dd8e54b
runtime proof id: gpu-runtime-proof:sha256:d853e7a6c560d96b1cf4011dd24d67d69b81d026946070f12a745dde3fcecbdb
result state: gpu-hmr-full-runtime-proven
hmr observed: [gpu-reload] plan=device_only
runner stayed alive: true
metric scope: hot_delta_1
cache state: compiler_cache_warm
device compile wall time: 24515900ns
runtime probe time: 3126806700ns
total validator wall time: 3151554600ns
deterministic fission: accepted=false failure=symbol_ownership because selected device role contains particle_init and particle_flow
```

Latest visual artifacts:

```text
mcp/synthi-mcp/.gpu-hmr-test-logs/agent-split-artifacts/flow-gpu-hmr-proof-20260609-timing-matrix/before-hmr-first.png
mcp/synthi-mcp/.gpu-hmr-test-logs/agent-split-artifacts/flow-gpu-hmr-proof-20260609-timing-matrix/after-hmr-first.png
mcp/synthi-mcp/.gpu-hmr-test-logs/agent-split-artifacts/flow-gpu-hmr-proof-20260609-timing-matrix/before-after-diff.png
mcp/synthi-mcp/.gpu-hmr-test-logs/agent-split-artifacts/flow-gpu-hmr-proof-20260609-timing-matrix/before-hmr-metadata.json
mcp/synthi-mcp/.gpu-hmr-test-logs/agent-split-artifacts/flow-gpu-hmr-proof-20260609-timing-matrix/after-hmr-metadata.json
mcp/synthi-mcp/.gpu-hmr-test-logs/agent-split-artifacts/flow-gpu-hmr-proof-20260609-timing-matrix/generated-split-granularity.json
mcp/synthi-mcp/.gpu-hmr-test-logs/agent-split-artifacts/flow-gpu-hmr-proof-20260609-timing-matrix/generated-split-deterministic-fission.json
mcp/synthi-mcp/.gpu-hmr-test-logs/agent-split-artifacts/flow-gpu-hmr-proof-20260609-timing-matrix/agent-split-results.txt
```

Latest visual proof:

```text
changed=2.59%
mean_abs=3.58
control_changed=0.00%
control_mean_abs=0.01
selected_seq=9230
selected_delta_ms=2755
```

Local visual inspection with the image viewer confirmed a nonblank particle-field diff with the expected field displacement.

Accepted fresh MCP proof:

```text
workspace slug: flow-gpu-hmr-proof-20260609-rerun2
workspace url: http://localhost:3000/workspace/flow-gpu-hmr-proof-20260609-rerun2
fixture: flow
gpu vendor: rocm
gpu arch: gfx1201
generated device compile: hipcc
device edit: .synthi/generated/gpu/device.hip
strict wait gate: requireGpuFullRuntimeProof=true
ledger id: gpu-ledger-proof:sha256:1de678f799fc420e489fbb4dcb5385d7f1621f47f2d78230cff3c60ed203800f
runtime proof id: gpu-runtime-proof:sha256:16d8756992bc28d03d8ed8dd1f5786b605b6c86cabc2ff2f6bc88681600ba6e9
result state: gpu-hmr-full-runtime-proven
hmr observed: [gpu-reload] plan=device_only
```

Visual artifacts:

```text
mcp/synthi-mcp/.gpu-hmr-test-logs/agent-split-artifacts/flow-gpu-hmr-proof-20260609-rerun2/before-hmr-first.png
mcp/synthi-mcp/.gpu-hmr-test-logs/agent-split-artifacts/flow-gpu-hmr-proof-20260609-rerun2/after-hmr-first.png
mcp/synthi-mcp/.gpu-hmr-test-logs/agent-split-artifacts/flow-gpu-hmr-proof-20260609-rerun2/before-after-diff.png
mcp/synthi-mcp/.gpu-hmr-test-logs/agent-split-artifacts/flow-gpu-hmr-proof-20260609-rerun2/before-hmr-metadata.json
mcp/synthi-mcp/.gpu-hmr-test-logs/agent-split-artifacts/flow-gpu-hmr-proof-20260609-rerun2/after-hmr-metadata.json
mcp/synthi-mcp/.gpu-hmr-test-logs/agent-split-artifacts/flow-gpu-hmr-proof-20260609-rerun2/generated-split-granularity.json
```

Visual proof:

```text
changed=2.59%
mean_abs=3.58
control_changed=0.00%
control_mean_abs=0.00
selected_seq=8038
selected_delta_ms=2098
```

Visual inspection confirmed a sparse particle ring before HMR and a gridded wave/field after HMR. The diff is nonblank and localized to the changed particle field.

## Generated Split Granularity And Fission

The accepted generated split runtime claim remains device translation unit HMR unless the deterministic fission verifier proves a smaller island. The fission verifier is a separate proof class and cannot count as full-runtime GPU HMR by itself.

Flow:

```text
accepted claim: device_translation_unit_hmr
device translation units: 1
device roles: 1
kernels: particle_init, particle_flow
rejected claims: smallest_safe_fission_island, per_kernel_hmr
reason: single generated translation unit contains multiple kernels
runtime proof id: gpu-runtime-proof:sha256:d853e7a6c560d96b1cf4011dd24d67d69b81d026946070f12a745dde3fcecbdb
ledger id: gpu-ledger-proof:sha256:f5ec4c6b608520221cfe7bf2ecd6344f3d37d37d3a262eafa4a1458c2dd8e54b
visual artifact: mcp/synthi-mcp/.gpu-hmr-test-logs/agent-split-artifacts/flow-gpu-hmr-proof-20260609-timing-matrix/before-after-diff.png
granularity artifact: mcp/synthi-mcp/.gpu-hmr-test-logs/agent-split-artifacts/flow-gpu-hmr-proof-20260609-timing-matrix/generated-split-granularity.json
deterministic fission artifact: mcp/synthi-mcp/.gpu-hmr-test-logs/agent-split-artifacts/flow-gpu-hmr-proof-20260609-timing-matrix/generated-split-deterministic-fission.json
deterministic fission result: accepted=false missing=symbol_ownership
```

Ray-light:

```text
accepted runtime claim: device_translation_unit_hmr
accepted fission claim: per_kernel_hmr
device translation units: 1
device roles: 1
kernels: trace_light_rays
runtime proof id: gpu-runtime-proof:sha256:fed37d01a7b988bfd5bc25c1adeb03d2c2a6cc8082aaa8324f64aaf6a894437b
ledger id: gpu-ledger-proof:sha256:983d2c96e1a6bd58dc3094d31a8d24b245a4a24d88754a87208abea562ea61dc
visual artifact: mcp/synthi-mcp/.gpu-hmr-test-logs/agent-split-artifacts/ray-light-gpu-hmr-proof-20260609-timing-matrix/before-after-diff.png
granularity artifact: mcp/synthi-mcp/.gpu-hmr-test-logs/agent-split-artifacts/ray-light-gpu-hmr-proof-20260609-timing-matrix/generated-split-granularity.json
deterministic fission artifact: mcp/synthi-mcp/.gpu-hmr-test-logs/agent-split-artifacts/ray-light-gpu-hmr-proof-20260609-timing-matrix/generated-split-deterministic-fission.json
deterministic fission result: accepted=true verifier=evidence:fission-verifier-report:generated-split:sha256:179ed4c796fc3b69157a49ec545e05aaec6310f3c0e08c1c40ccd2596ac35c43
required categories: source_mapping, include_closure, symbol_ownership, dependency_closure, abi_membrane, compile_recipe, loader_capability, output_oracle
```

This answers the one-`.hip` concern: one generated `.hip` file is insufficient by itself. Ray-light can claim per-kernel/smallest-safe fission because the selected generated device role contains exactly one kernel and the deterministic verifier is bound to full runtime proof plus frame-gated visual output. Flow cannot claim it because the selected generated device role contains two kernels.

After `732d2bcfa`, a fission candidate that is narrower than the generated device translation unit cannot pass from metadata alone. It must carry deterministic generated-topology evidence and a structured binding that ties:

```text
generated role path -> separately materialized partial artifact -> artifact:sha256 selected artifact identity
```

Missing topology evidence or a missing topology binding rejects with `fission.claim_narrower_than_generated_topology`.

## HIPRT Same-Process Visual Evidence

HIPRT proof is separate from the MCP browser preview path. The current HIPRT CameraRays and MegaKernel direct-light-gain artifacts are useful same-process ray-traced visual profiles, but they are source-adapted profile runs and are not accepted as no-shim full-runtime GPU HMR. The matrix now classifies them as `visual_profile_accepted` while leaving `hiprt_visual_path` and `hiprt_run_modes` missing for no-shim acceptance. This is deliberately not broad HIPRT application acceptance.

Some older persisted HIPRT proof JSON files still contain raw `gpuHmrSuccess=true` or strict-gate-pass fields from before source-adapted demotion. Those fields are not current authority. The validation matrix recomputes the claim boundary from the disclosed `runtimeProbeInstrumentation.sourceAdaptations` and sets `acceptedForGpuHmr=false` for those rows.

The MegaKernel direct-light-zero profile is intentionally not accepted as full-runtime GPU HMR after the oracle-region hardening. It produces a mostly black post-epoch render region, so the matrix records it as a proven blank-frame refusal instead of treating the pixel diff as success.

```text
worker repo path: /tmp/synthi-real-rocm/HIPRT-Path-Tracer
repo commit: d114ed0d4c1d4ff9ea4e2511841819ed9aa59e6e
scene: data/GLTFs/cornell_pbr.gltf
hdr: data/Skyspheres/evening_road_01_puresky_2k.hdr
```

Fresh CameraRays proof:

```text
profile: hiprt-camera-rays-horizontal-mirror
mode: same-process
proof id: hiprt-warm-runtime-proof:sha256:1d15cb417f082b7ed3602abaecf05d8983c6ac647d0076a510fe75e477c38aea
strict runtime proof id: gpu-runtime-proof:sha256:7ef274e6d60f3a17f66b02437ff9846073744ba3408f013430bdc0ed75283f25
proof ledger id: gpu-ledger-proof:sha256:c7345ddcd4b9ddf1ef1e56d0fadf8dffb56d2a688074c8337c3bdbca265a6037
strict gate: pass
proof json: mcp/synthi-mcp/.gpu-hmr-test-artifacts/hiprt-light-math-warm-proof/hiprt-camera-rays-strict-region-20260622-proof.json
before: mcp/synthi-mcp/.gpu-hmr-test-artifacts/hiprt-light-math-warm-proof/hiprt-camera-rays-strict-region-20260622-same-process-baseline-framebuffer.png
after: mcp/synthi-mcp/.gpu-hmr-test-artifacts/hiprt-light-math-warm-proof/hiprt-camera-rays-strict-region-20260622-same-process-changed-framebuffer.png
diff: mcp/synthi-mcp/.gpu-hmr-test-artifacts/hiprt-light-math-warm-proof/hiprt-camera-rays-strict-region-20260622-diff-amplified.png
changed pixels: 91.4019%
mean abs delta 8-bit: 53.1273
oracle-region nonblank: true
oracle-region changed visible ratio: 0.9574956597222222
adapter build: 20624ms
same-process live recompile: 87ms
trigger wait: 2537ms
edit to first visual: 8008ms
total validator wall: 32815.8128ms
```

CameraRays source-adapted run-mode visual evidence:

```text
matrix coverage rows: hiprt_run_modes=missing, hiprt_visual_path=missing
current matrix proof id: gpu-validation-matrix-ledger:sha256:425a5f02cc756ee518d41fdb8ce71398ed8660b34025eb65f41a92e9f7bd3b62
matrix classification: visual_profile_accepted, acceptedForGpuHmr=false, sourceAdaptedProfile=true

hot delta 1 proof id: hiprt-warm-runtime-proof:sha256:d0a8b4ca701d855e96ce0c6b812c668a4307901d13b232948e5c629fe7b0384b
hot delta 1 runtime proof: gpu-runtime-proof:sha256:41cfc3ac84b5d95ee667711bcbb52e76a6fc4c2be96905d95f3fac4e7ce4b355
hot delta 1 ledger: gpu-ledger-proof:sha256:7e6853bc6da3257e4b3002512b15098bdbe3380d287df8245f2b308976157523
hot delta 1 run-mode proof: runtime-run-mode-proof:sha256:70e3c22c877041ad50d93d81e9fda0832a1485e3b00f1fe038dda65f69be20c1
hot delta 1 visual diff: mcp/synthi-mcp/.gpu-hmr-test-artifacts/hiprt-light-math-warm-proof/hiprt-camera-rays-runmodes-20260623-hot1-diff-amplified.png
hot delta 1 metrics: changed_pixel_ratio=0.9140190972222222, mean_abs_delta_8bit=53.12725983796296, live_recompile=45ms, trigger_to_visible=8618ms, total_validator_wall=310330.826ms

hot delta 2 proof id: hiprt-warm-runtime-proof:sha256:5c2fadcac8b6b32a7c60b227cb88d167cb91488157d47bc3389ac555886d5542
hot delta 2 runtime proof: gpu-runtime-proof:sha256:444a57c35075550e3d229fe9b248bab36bef8c21b765f9d5981f0c9f64e5dfd0
hot delta 2 ledger: gpu-ledger-proof:sha256:847ca2295ee40cf6782f51f2d3411221437bde26f7bfbe5ffdbc3bb5a953d94f
hot delta 2 run-mode proof: runtime-run-mode-proof:sha256:995d4a60fb71c15cc6b0f73cc61575936f4c8736078d35e665396c52d42db661
hot delta 2 visual diff: mcp/synthi-mcp/.gpu-hmr-test-artifacts/hiprt-light-math-warm-proof/hiprt-camera-rays-runmodes-20260623-hot2-neg-diff-amplified.png
hot delta 2 metrics: changed_pixel_ratio=0.9486458333333333, mean_abs_delta_8bit=51.80200376157408, live_recompile=45ms, trigger_to_visible=2463ms, total_validator_wall=13840.4776ms

cold runtime visual run-mode proof: runtime-run-mode-proof:sha256:e889f9f87531a4f446bf6f4418d417edb1d5f92afc975594fbb0e358c5cec0fa
negative ABI edit refusal proof: agent-split-negative-edit-refusal:sha256:f44d46b50f0c36124535d1d348bc49b49b75073b56d0992a1d57ec1e273e7a01
negative refusal reasons: kernel_signature_changed, abi_layout_changed, hiprt_runtime_adapter_contract_rejects_layout_changed_abi
visual inspection: hot delta 1 and hot delta 2 diff PNGs were opened with the local image tool and were visibly nonblank, high-change ray-traced frame diffs; CameraRays baseline and changed framebuffers were re-opened on 2026-06-26 and both rendered nonblank ray-traced geometry with a visible before/after change.
```

MegaKernel direct-light-gain proof:

```text
profile: hiprt-megakernel-direct-light-gain
mode: same-process
visualProfileAccepted: true
fullRuntimeGpuHmrAccepted: false
matrix outcome: visual_profile_accepted
acceptedForGpuHmr: false
sourceAdaptedProfile: true
proof id: hiprt-warm-runtime-proof:sha256:bfc7237c96db6688d94410167ff705fb41c0a955c6dee01ccd43011f3537c102
strict runtime proof id: gpu-runtime-proof:sha256:2256732f63143775e7c15db599828ef1b6a32dbb82fef0cba0aaf0fcd946ddef
proof ledger id: gpu-ledger-proof:sha256:8ede8c7a1bcea38429eb855947e73150fa8d7b508ee6301a81d7cd521b94721b
acceptance contract hash: sha256:39a6c7d0d85bbd67385c5f9aca6e8c6e939212188d73ef5e9a01d272387369fa
strict gate: pass
proof json: mcp/synthi-mcp/.gpu-hmr-test-artifacts/hiprt-light-math-warm-proof/hiprt-megakernel-light-gain-20260623-proof.json
before: mcp/synthi-mcp/.gpu-hmr-test-artifacts/hiprt-light-math-warm-proof/hiprt-megakernel-light-gain-20260623-same-process-baseline-framebuffer.png
after: mcp/synthi-mcp/.gpu-hmr-test-artifacts/hiprt-light-math-warm-proof/hiprt-megakernel-light-gain-20260623-same-process-changed-framebuffer.png
diff: mcp/synthi-mcp/.gpu-hmr-test-artifacts/hiprt-light-math-warm-proof/hiprt-megakernel-light-gain-20260623-diff-amplified.png
changed pixels: 35.40494791666667%
mean abs delta 8-bit: 7.759528356481481
max channel delta 8-bit: 110
oracle-region nonblank: true
oracle-region changed visible ratio: 0.9197007248071077
adapter build: 71334ms
same-process live recompile: 32718ms
trigger wait: 748ms
edit to first visual: 37546ms
screenshot capture: 40501ms
total validator wall: 348533.3747ms
run-mode proof: runtime-run-mode-proof:sha256:b3024731a9269acf258397ad569f81fc9ab30826494ebf95105e3f1e6c2c10f8
negative ABI edit refusal: agent-split-negative-edit-refusal:sha256:7ad67b17ba2154822ae576208675c1f837485d4e1574a310c463f8875476b46b
negative refusal reasons: kernel_signature_changed, abi_layout_changed, hiprt_runtime_adapter_contract_rejects_layout_changed_abi
visual inspection: before, after, and amplified diff PNGs were opened with the local image tool; the scene remains the same Cornell-style ray-traced setup while direct lighting increases, and the diff is visibly nonblank.
```

Latest MegaKernel direct-light-gain rerun on 2026-06-24:

```text
proof id: hiprt-warm-runtime-proof:sha256:10abd06afa34694c16b744d62d052e76c3f5838bbf2d4bc1e7ef20d7b6ce95ad
proof json: mcp/synthi-mcp/.gpu-hmr-test-artifacts/hiprt-light-math-warm-proof/hiprt-warm-light-math-20260624075246-proof.json
before: mcp/synthi-mcp/.gpu-hmr-test-artifacts/hiprt-light-math-warm-proof/hiprt-warm-light-math-20260624075246-same-process-baseline-framebuffer.png
after: mcp/synthi-mcp/.gpu-hmr-test-artifacts/hiprt-light-math-warm-proof/hiprt-warm-light-math-20260624075246-same-process-changed-framebuffer.png
diff: mcp/synthi-mcp/.gpu-hmr-test-artifacts/hiprt-light-math-warm-proof/hiprt-warm-light-math-20260624075246-diff-amplified.png
metric scope: hot_delta_1
device arch: gfx1201
changed_pixel_ratio: 0.3540494791666667
mean_abs_delta_8bit: 7.759528356481481
adapter build: 79861ms
same-process live recompile: 54ms
trigger wait: 665ms
edit to first visual: 9894ms
screenshot capture: 17448ms
total validator wall: 326921.0508ms
visual inspection: baseline, changed, and amplified diff PNGs opened with the local image tool on 2026-06-24; the ray-traced scene is nonblank and the amplified diff shows localized direct-lighting change.
matrix authority: visual_profile_accepted only, not no-shim full-runtime HIPRT GPU HMR, because the runtime profile discloses source-adapted hooks.
```

MegaKernel direct-light-zero refusal:

```text
profile: hiprt-megakernel-direct-light-zero
mode: same-process
accepted: false
matrix outcome: refusal_proven
proof id: hiprt-warm-runtime-proof:sha256:ca0effaf57433ead4ef062c54a168537178f84f555425fbc87127f5caa516f9e
strict runtime proof id: gpu-runtime-proof:sha256:2be665516b31ddf724e6d793013f4a141db419e8259cccefdea4d10594dbafbe
proof ledger id: gpu-ledger-proof:sha256:32b1b8f456fa3b31984ac997ddc404e88cfa8e0c03117429e787677a983d937f
strict gate: fail
proof json: mcp/synthi-mcp/.gpu-hmr-test-artifacts/hiprt-light-math-warm-proof/hiprt-megakernel-blank-refusal-20260622-proof.json
before: mcp/synthi-mcp/.gpu-hmr-test-artifacts/hiprt-light-math-warm-proof/hiprt-megakernel-blank-refusal-20260622-same-process-baseline-framebuffer.png
after: mcp/synthi-mcp/.gpu-hmr-test-artifacts/hiprt-light-math-warm-proof/hiprt-megakernel-blank-refusal-20260622-same-process-changed-framebuffer.png
diff: mcp/synthi-mcp/.gpu-hmr-test-artifacts/hiprt-light-math-warm-proof/hiprt-megakernel-blank-refusal-20260622-diff-amplified.png
changed pixels: 41.8229%
mean abs delta 8-bit: 32.9462
oracle-region nonblank: false
oracle-region changed visible ratio: 0.007079728781856441
oracle-region changed mean luma: 1.3146592377834951
adapter build: 18942ms
same-process live recompile: 209ms
trigger wait: 2342ms
edit to first visual: 7623ms
total validator wall: 30637.1206ms
```

Visual inspection confirmed CameraRays before/after/diff images are readable and nonblank, with a mirrored/recomposed Cornell-style framebuffer. Visual inspection also confirmed the MegaKernel direct-light-gain rerun has nonblank baseline/changed frames and a visible amplified diff. MegaKernel direct-light-zero remains refused because the changed image has a mostly black render region despite a high-signal diff image.

## OIDN Status

OIDN was tested through structured HIP preflight artifacts, most recently on 2026-06-26 after splitting OIDN HIP runtime preflight from OIDN HIP output proof and rerunning a declared worker-checkout preflight. The latest live declared-checkout worker run remains a refusal: `oidnTest` and the HIP device library were absent in `vectant-ade-worker-1` at `/tmp/synthi-real-rocm/HIPRT-Path-Tracer`, so no HIP runtime preflight or output proof was accepted. Earlier real-checkout runs remain useful diagnostics: CPU OIDN diagnostics passed, but the installed HIP OIDN device library linked against `libamdhip64.so.5`, which is unavailable in the ROCm 7 worker environment. No compatibility shim, symlink, fake library, or synthesized runtime was added.

```text
latest proof id: oidn-preflight-proof:sha256:48ccd07dae1bb1e686418c0850879ccd310e4219de4c262305da27208f1c53f4
latest result state: oidn-hip-rejected
latest proof json: mcp/synthi-mcp/.gpu-hmr-test-artifacts/oidn-preflight/oidn-hiprt-rocm-preflight-20260626-after-apphook-refresh-proof.json
latest summary: mcp/synthi-mcp/.gpu-hmr-test-artifacts/oidn-preflight/oidn-hiprt-rocm-preflight-20260626-after-apphook-refresh-summary.txt
latest matrix row: historical-gpu-validation-matrix-row-sha256-88edda748c10b7da1a009ccc5b2a0516a4109e95116fafaf06ff913bd2ae0496
latest matrix outcome: refusal_proven
acceptedForOidnHipRuntimePreflight: false
acceptedForOidnHipOutputProof: false
gpuHmrSuccess: false
repo path: /tmp/synthi-real-rocm/HIPRT-Path-Tracer
previous proof id: oidn-preflight-proof:sha256:55a97051b6691b78f9caf40705969ca6fce106a294b7baf545a99cd2bbc95fbc
previous proof json: mcp/synthi-mcp/.gpu-hmr-test-artifacts/oidn-preflight/oidn-hiprt-rocm-preflight-20260626-live-rerun-proof.json
previous summary: mcp/synthi-mcp/.gpu-hmr-test-artifacts/oidn-preflight/oidn-hiprt-rocm-preflight-20260626-live-rerun-summary.txt
previous proof id: oidn-preflight-proof:sha256:25577fa64be579acb4bb512f3b1f2cb3652e48885b90f84e0d54e7aca3198ff4
previous proof json: mcp/synthi-mcp/.gpu-hmr-test-artifacts/oidn-preflight/oidn-preflight-20260624095704-proof.json
previous summary: mcp/synthi-mcp/.gpu-hmr-test-artifacts/oidn-preflight/oidn-preflight-20260624095704-summary.txt
previous proof id: oidn-preflight-proof:sha256:31440c66d50faa297208cdc81ff1d0c3c7803521480b58715224e6385b78a782
previous proof json: mcp/synthi-mcp/.gpu-hmr-test-artifacts/oidn-preflight/oidn-preflight-20260624093728-proof.json
previous summary: mcp/synthi-mcp/.gpu-hmr-test-artifacts/oidn-preflight/oidn-preflight-20260624093728-summary.txt
previous proof id: oidn-preflight-proof:sha256:ff9c8e5874689e0bba475ae9f7a9f2f6f70fcbe6b1bdc33fb77e54d799636492
previous proof json: mcp/synthi-mcp/.gpu-hmr-test-artifacts/oidn-preflight/oidn-preflight-20260624093615-proof.json
previous proof id: oidn-preflight-proof:sha256:c4d8a338351bd2f7c39e5c731147f5b4647ac30f144da1fc9aaf60377391405f
previous proof json: mcp/synthi-mcp/.gpu-hmr-test-artifacts/oidn-preflight/oidn-preflight-20260624090147-proof.json
previous summary: mcp/synthi-mcp/.gpu-hmr-test-artifacts/oidn-preflight/oidn-preflight-20260624090147-summary.txt
previous proof id: oidn-preflight-proof:sha256:5fc3136f57579a91c4be2475af7d1776d23e5c19696d7f76a1794413db5ec21a
previous proof json: mcp/synthi-mcp/.gpu-hmr-test-artifacts/oidn-preflight/oidn-hiprt-rocm-preflight-20260622-real-checkout-proof.json
previous summary: mcp/synthi-mcp/.gpu-hmr-test-artifacts/oidn-preflight/oidn-hiprt-rocm-preflight-20260622-real-checkout-summary.txt
proof id: oidn-preflight-proof:sha256:f5cf7bab766cfd7b13e1c0657818c20306e81cc9dda4267486771fc492e84f85
result state: oidn-hip-rejected
proof json: mcp/synthi-mcp/.gpu-hmr-test-artifacts/oidn-preflight/oidn-hiprt-rocm-preflight-20260609-proof.json
summary: mcp/synthi-mcp/.gpu-hmr-test-artifacts/oidn-preflight/oidn-hiprt-rocm-preflight-20260609-summary.txt
```

HIP device tests rejected:

```text
oidnTest 'device creation' --device hip --success --durations yes --rng-seed 12345
result: FAILED, REQUIRE(bool(device)) false

oidnTest 'buffer read/write' --device hip --success --durations yes --rng-seed 12345
result: FAILED, REQUIRE(bool(device)) false
```

Latest live declared-checkout worker refusal:

```text
oidnTool: missing
hipDeviceLibrary: missing
unsupported reasons: oidnTest_not_found
worker checkout probe: sh: 1: cd: can't cd to /tmp/synthi-real-rocm/HIPRT-Path-Tracer
noShimApplied: true
noSymlinkApplied: true
noSynthesizedRuntime: true
```

Previous runtime-split refusal retained in the matrix:

```text
proof id: oidn-preflight-proof:sha256:818110f978534f7b1574bc005bec74ca793a0813125b47aa5a3d7c21c5ce0356
matrix row: historical-gpu-validation-matrix-row-sha256-029dabc854c41eb72bdb127e4bf72475fd160235baf405688c84640b89110e2a
proof json: mcp/synthi-mcp/.gpu-hmr-test-artifacts/oidn-preflight/oidn-preflight-20260626-runtime-split-proof.json
summary: mcp/synthi-mcp/.gpu-hmr-test-artifacts/oidn-preflight/oidn-preflight-20260626-runtime-split-summary.txt
unsupported reasons: oidnTest_not_found, declared_worker_checkout_unavailable
```

Previous real-checkout dependency check:

```text
libOpenImageDenoise_device_hip.so.2.3.0 -> libamdhip64.so.5 => not found
unsupported reasons: missing_dependency:libamdhip64.so.5, oidn_hip_buffer_read_write_failed, oidn_hip_device_creation_failed
noShimApplied: true
noSymlinkApplied: true
noSynthesizedRuntime: true
```

Latest path-integrity evidence:

```text
oidnTest resolved path: /tmp/synthi-real-rocm/HIPRT-Path-Tracer/build/_deps/oidnbinaries-src/bin/oidnTest
oidnTest file type: ELF 64-bit LSB pie executable
oidnTest sha256: sha256:e1172cc0e6edf5af00493c922ea8a2a79159b928af6308e4a09df364bbca42cb
HIP device library resolved path: /tmp/synthi-real-rocm/HIPRT-Path-Tracer/build/_deps/oidnbinaries-src/lib/libOpenImageDenoise_device_hip.so.2.3.0
HIP device library file type: ELF 64-bit LSB shared object
HIP device library sha256: sha256:ec91d9544044b1f95074363c72e3706e065c835b2a5906d578a0afaf9c70d56f
symlinked paths: none
wrapper/shim paths: none
```

Previous real-checkout CPU OIDN diagnostics passed:

```text
device creation: all tests passed, 8 assertions
buffer read/write: all tests passed, 27 assertions
```

No symlink, ABI shim, or library compatibility shortcut was added. Do not claim OIDN HIP output proof on this ROCm 7 worker.

## OpenCL Status

OpenCL now has two distinct evidence paths: scoped host-local full-runtime compute/readback proof, and separate worker-container preflight refusal evidence.

Accepted scoped host-runtime proofs:

```text
hot delta 1 proof id: opencl-runtime-proof:sha256:73594daf0b31354da7eaea6f1487c9d51ad5cee5acc5c88384eb965411209e82
hot delta 1 runtime artifact: opencl-runtime-proof-artifact:dafde562ec2f1afe02f3c18ac275c9004b622fa56135702cb991000a31e92771
hot delta 1 ledger: gpu-ledger-proof:sha256:35d4a1e5a9c9408e5dd516bd32a1a3fdb8fa6350245e41f1251a20310f1f808c
hot delta 2 proof id: opencl-runtime-proof:sha256:4ffef3afdc58d5a8bab8623d451c98b7683f02efbbd950bdceb24ea53fed9fc7
hot delta 2 runtime artifact: opencl-runtime-proof-artifact:ec6dde15d1eca85866e24cd78f471d532aa4706b0bfdc8f7536a25f09c3ecbbf
hot delta 2 ledger: gpu-ledger-proof:sha256:983ba910d94009c28ddd1f70f46824c1a6b343ea1544eeae0bfa51d14be137c2
transport: local_windows_powershell_add_type
claim boundary: scoped OpenCL readback proof only, not arbitrary OpenCL project acceptance
```

The worker-container preflight artifact remains refusal-only:

```text
latest proof id: opencl-preflight-proof:sha256:98ec455f0f00cbe74c1716644124dd3cff7341cfd52d694427b80892da010875
latest result state: opencl-runtime-rejected
latest proof json: mcp/synthi-mcp/.gpu-hmr-test-artifacts/opencl-preflight/opencl-rocm-preflight-20260630113731-proof.json
latest summary: mcp/synthi-mcp/.gpu-hmr-test-artifacts/opencl-preflight/opencl-rocm-preflight-20260630113731-summary.txt
```

The live worker has an OpenCL loader but no usable vendor ICD/tooling evidence:

```text
libraries: libOpenCL.so.1 (libc6,x86-64) => /lib/x86_64-linux-gnu/libOpenCL.so.1
vendor ICDs: none
platform count: unknown
device counts: none
unsupported reasons: opencl_vendor_icd_missing, clinfo_missing
```

The preflight artifact explicitly does not accept OpenCL output proof or GPU HMR success. The host-local proof accepts only because it produced dispatch trace, raw readback bytes, data-derived proof card, expected-output verification, native API counts, same-process proof, and strict ledger closure.

```text
acceptedForOpenClRuntimePreflight: false
acceptedForOpenClOutputProof: false
gpuHmrSuccess: false
dispatchTraceRequired: true
outputOracleRequired: true
noShimApplied: true
noVendorIcdSynthesized: true
noSymlinkApplied: true
```

No vendor ICD was synthesized, no symlink was added, and no compatibility shim was used. Do not claim OpenCL HMR output proof on the worker container; do not generalize the scoped host-local OpenCL readback probe into arbitrary OpenCL project acceptance.

## Vulkan Status

Vulkan now has two distinct evidence paths: scoped host-local full-runtime pipeline/readback visual proof, and separate worker-container preflight refusal evidence.

Accepted scoped host-local runtime proof:

```text
proof id: vulkan-runtime-proof:sha256:de768ddd560863deac94f7740adf55af5a3fb59e730c9e0109fd383135bc8e84
runtime artifact: vulkan-runtime-proof-artifact:62fbf87f8551fdce10a33595c8c5a76d42683ac3522676a942c7f1a5c4a94134
ledger: gpu-ledger-proof:sha256:599ef0607b62dab245d7b29b9dae68ed6a30733520bb8aaaff7a54371ae03fb1
matrix row: gpu-validation-matrix-row:sha256:c0e9f8d1509334ae80200ee736df5050e585e12bb11ae7a8fd951248893342e8
artifact dir: mcp/synthi-mcp/.gpu-hmr-test-artifacts/vulkan-runtime-proof/vulkan-runtime-frame-20260630124806
visual threshold: changed_pixel_ratio=1.0, mean_abs_delta_8bit=132, visible_pixel_count=16384
```

The host-local proof is accepted only because it produced a real same-process Vulkan trace with epoch-1 output before epoch-2 shader-module load/pipeline publish, then epoch-2 dispatch/output, plus visual readback PNGs and native Vulkan API counts for shader-module creation, pipeline-layout creation, compute pipeline creation, command-buffer allocation/begin, pipeline bind, dispatch, queue submit, fence wait, and memory map. Missing trace arrays, missing counts, forged image hashes, or misordered epoch events fail closed.

Worker-container Vulkan was also tested through structured preflight artifacts and remains refusal-only:

```text
latest proof id: vulkan-preflight-proof:sha256:d904016a24c785659424bae3cc5381ae2a84b816fee87c1f13dd335709d7a528
latest result state: vulkan-runtime-rejected
latest proof json: mcp/synthi-mcp/.gpu-hmr-test-artifacts/vulkan-preflight/vulkan-rocm-preflight-20260609-proof.json
latest summary: mcp/synthi-mcp/.gpu-hmr-test-artifacts/vulkan-preflight/vulkan-rocm-preflight-20260609-summary.txt
```

The live worker has a Vulkan loader but no usable ICD/tooling evidence:

```text
libraries: libvulkan.so.1 (libc6,x86-64) => /lib/x86_64-linux-gnu/libvulkan.so.1
ICD files: none
ICD libraries: none
API version: unknown
physical device count: 0
device names: none
unsupported reasons: vulkan_icd_missing, vulkaninfo_missing
```

The preflight artifact explicitly does not accept Vulkan pipeline proof or GPU HMR success. Even on a machine where Vulkan preflight accepts, pipeline-layout proof, command-buffer trace proof, and frame-output oracle proof are still required before Vulkan GPU HMR can pass.

```text
acceptedForVulkanRuntimePreflight: false
acceptedForVulkanPipelineProof: false
gpuHmrSuccess: false
pipelineLayoutProofRequired: true
commandBufferTraceRequired: true
frameOutputOracleRequired: true
noShimApplied: true
noIcdSynthesized: true
noSymlinkApplied: true
```

No ICD was synthesized, no symlink was added, and no compatibility shim was used. Do not claim Vulkan HMR output proof on the worker container, and do not generalize the scoped host-local Vulkan probe into arbitrary Vulkan project or engine acceptance.

## WebGPU Status

WebGPU was tested through a structured Chrome/Playwright runtime preflight artifact:

```text
latest proof id: webgpu-preflight-proof:sha256:cf0b7bb1c6c1981398a055bcc2d19e81c9e3d7cf3ce519301ec7f721ae79f637
latest result state: webgpu-runtime-preflight-accepted
latest proof json: mcp/synthi-mcp/.gpu-hmr-test-artifacts/webgpu-preflight/webgpu-preflight-20260625-typed-backend-evidence-proof.json
latest summary: mcp/synthi-mcp/.gpu-hmr-test-artifacts/webgpu-preflight/webgpu-preflight-20260625-typed-backend-evidence-summary.txt
latest diagnostic screenshot: mcp/synthi-mcp/.gpu-hmr-test-artifacts/webgpu-preflight/webgpu-preflight-20260625-typed-backend-evidence-diagnostic.png
latest matrix row id: historical-gpu-validation-matrix-row-sha256-2d0795917875640de10c73dd6b03ac7f01de87118132b8fe7b35148e3ff41dca
```

The live browser accepted WebGPU runtime preflight:

```text
browser: C:\Program Files\Google\Chrome\Application\chrome.exe
browser launch args: --enable-unsafe-webgpu --ignore-gpu-blocklist --enable-features=Vulkan,WebGPU,UseSkiaRenderer --disable-gpu-sandbox
adapter: {"vendor":"amd","architecture":"rdna-4","device":"","description":""}
preferred canvas format: bgra8unorm
unsupported reasons: none
```

The diagnostic screenshot was visually inspected and is nonblank: it shows a rendered WebGPU triangle plus the runtime JSON (`navigator.gpu`, adapter, device, and render-submit true). This is typed backend/runtime-capability evidence only; the matrix row is `preflight_only`, not GPU HMR success.

The preflight artifact explicitly does not accept WebGPU shader/pipeline proof or GPU HMR success. Even when WebGPU runtime preflight accepts, WGSL hashes, shader-module epoch, bind-group/pipeline-layout proof, pipeline recreate proof, and frame-output oracle proof are still required before WebGPU GPU HMR can pass.

```text
acceptedForWebGpuRuntimePreflight: true
acceptedForWebGpuPipelineProof: false
gpuHmrSuccess: false
shaderModuleEpochRequired: true
bindGroupLayoutProofRequired: true
pipelineLayoutProofRequired: true
pipelineRecreateProofRequired: true
frameOutputOracleRequired: true
noShimApplied: true
noBrowserFlagClaimedAsHmr: true
```

No WebGPU shim was added. Browser enablement flags are recorded for transparency and are not counted as HMR proof.

Historical June 9 base explicit-empty WebGPU runtime visual proof. Current accepted WebGPU visual rows are the 2026-06-23 explicit-empty hot1/hot2 and explicit-profiled hot1/hot2 scoped rows recorded in the latest matrix above.

```text
historical runtime proof id: webgpu-runtime-visual-proof:sha256:e45b1d839607d694a744226228c0341dd6959eb336058bf733152a77f972e81d
historical runtime result state: webgpu-hmr-full-runtime-proven
historical runtime ledger id: gpu-ledger-proof:sha256:56994c1b29cef52e7b86ba4d3936031a3486123bb62da99ab1e554d779011a2e
historical runtime proof json: mcp/synthi-mcp/.gpu-hmr-test-artifacts/webgpu-runtime-visual-proof/webgpu-runtime-visual-20260609-webgpu-wgsl-runtime-triangle-proof.json
historical runtime summary: mcp/synthi-mcp/.gpu-hmr-test-artifacts/webgpu-runtime-visual-proof/webgpu-runtime-visual-20260609-webgpu-wgsl-runtime-triangle-summary.txt
```

Runtime visual artifacts were inspected:

```text
before: mcp/synthi-mcp/.gpu-hmr-test-artifacts/webgpu-runtime-visual-proof/webgpu-runtime-visual-20260609-webgpu-wgsl-runtime-triangle-before.png
after: mcp/synthi-mcp/.gpu-hmr-test-artifacts/webgpu-runtime-visual-proof/webgpu-runtime-visual-20260609-webgpu-wgsl-runtime-triangle-after.png
diff: mcp/synthi-mcp/.gpu-hmr-test-artifacts/webgpu-runtime-visual-proof/webgpu-runtime-visual-20260609-webgpu-wgsl-runtime-triangle-diff.png
changed pixel ratio: 29.3893%
mean abs delta 8-bit: 37.6426
visible pixel count: 67713
total validator wall time: 951597400ns
trigger to visible time: 67788100ns
```

The shared timing summary includes the scoped WebGPU rows:

```text
timing summary json: mcp/synthi-mcp/.gpu-hmr-test-logs/timing-metrics/gpu-hmr-timing-metrics-20260624T093916Z.json
sources: webgpu_runtime_visual, webgpu_runtime_compute
profiles: webgpu-wgsl-runtime-triangle, webgpu-wgsl-runtime-profiled-layout, webgpu-wgsl-runtime-compute-storage, webgpu-wgsl-runtime-compute-storage-hot2
reportedStatus: pass
proofVerdict: not_evaluated_by_timing_summary
timing authority: timing metrics are telemetry only; validation-matrix proof ledgers are the acceptance authority.
profiled hot1 total wall: 931.5372ms
profiled hot1 trigger to visible: 122.5624ms
profiled hot2 total wall: 923.1318ms
profiled hot2 trigger to visible: 123.5537ms
compute hot1 total wall: 703.6928ms
compute hot1 dispatch to output proof: 698.9754ms
compute hot2 total wall: 684.1210ms
compute hot2 dispatch to output proof: 681.8655ms
```

Latest WebGPU compute/readback proof:

```text
profile scope: explicit-compute-profiled-layout-storage-uniform-float32-readback
hot1 proof id: webgpu-runtime-compute-proof:5550fdf2044e56986e75183dc81ef679d78f966ef22b4c1bc1c8f278d2e12236
hot1 ledger: gpu-ledger-proof:sha256:fd67f29a4b1096d5ccd2b07e7a9eac7d2f2ccf8ff273dd5023305925a44a411e
hot1 runtime proof artifact: webgpu-compute-runtime-proof:3852ebc9e362e9bd3b0f46eb4200ce1b64a7fb015c0c9cb2148aeab77114f56f
hot1 run-mode proof: runtime-run-mode-proof:a8ca6cfad9c96af677432cad38224999a2dbd1e498a71de01152f3a19ec127a9
hot1 proof json: mcp/synthi-mcp/.gpu-hmr-test-artifacts/webgpu-runtime-compute-proof/webgpu-runtime-compute-20260625131945-webgpu-wgsl-runtime-compute-storage/webgpu-runtime-compute-20260625131945-webgpu-wgsl-runtime-compute-storage-proof.json
hot1 raw readback and expected hash: sha256:5b2915f7ad17941e9b1b457a6a276c362edaabb974da6af1daef06f267d77657
hot1 expected output verified: true, max_abs_delta=0
hot1 timing: total_validator_wall_time=703811600ns, dispatch_to_output_proof_time=701237300ns
hot1 card: mcp/synthi-mcp/.gpu-hmr-test-artifacts/webgpu-runtime-compute-proof/webgpu-runtime-compute-20260625131945-webgpu-wgsl-runtime-compute-storage/webgpu-wgsl-runtime-compute-storage-compute-card.png
hot2 proof id: webgpu-runtime-compute-proof:f1a068328b522bd1bba6997d442a78e0a9e86acf1716f6e0ad76363c5c636af1
hot2 ledger: gpu-ledger-proof:sha256:ef7ce371282952c00c4f8a0a2b47039417a9aae95e44eac9034b5f8d1bc1ca8d
hot2 runtime proof artifact: webgpu-compute-runtime-proof:03c025aa0cb9293cb97f41cac61515b16a3a48835fc9ea8bf415356c34be8832
hot2 run-mode proof: runtime-run-mode-proof:5b0942f6c0be03ac75cc0cc1c3feab40cc9875cbcd563db47d34b3d253049101
hot2 proof json: mcp/synthi-mcp/.gpu-hmr-test-artifacts/webgpu-runtime-compute-proof/webgpu-runtime-compute-20260625131953-webgpu-wgsl-runtime-compute-storage-hot2/webgpu-runtime-compute-20260625131953-webgpu-wgsl-runtime-compute-storage-hot2-proof.json
hot2 raw readback and expected hash: sha256:25e6442aa7b6a1c025719aaec529c2c815c3c0590618ade8607ab2e99f9ba5b5
hot2 expected output verified: true, max_abs_delta=0
hot2 timing: total_validator_wall_time=694453900ns, dispatch_to_output_proof_time=689318200ns
hot2 card: mcp/synthi-mcp/.gpu-hmr-test-artifacts/webgpu-runtime-compute-proof/webgpu-runtime-compute-20260625131953-webgpu-wgsl-runtime-compute-storage-hot2/webgpu-wgsl-runtime-compute-storage-hot2-compute-card.png
compute-card image inspection: both WebGPU compute cards were opened with the local image tool on 2026-06-25; each card shows mapped before/after values, the raw/slice hash, and `expected output verified: true`. These cards are human-readable compute/readback evidence, not runtime frame visual proof; matrix acceptance comes from the raw readback files, recomputed ledger, native WebGPU compute API trace, and accepted strict runtime proof artifact.
matrix rows: hot1 historical-gpu-validation-matrix-row-sha256-b56be0556aafb1c2a93518d05e6437a998d143b970f5721a57496bdd8a1da475, hot2 historical-gpu-validation-matrix-row-sha256-221b75d42cfed3828a1f4f5edf05ac4f395d79d4b6650565b4b1b7cd48cde549
negative refusals: incompatible WebGPU compute ABI edits still reject before GPU HMR acceptance for both compute profiles.
```

Latest HIP module runtime/readback proof:

```text
profile scope: explicit-hip-module-float32-readback
runtime transport: worker container vectant-ade-worker-1, hipcc=/opt/rocm/bin/hipcc, arch=gfx1201
native API chain: hipModuleLoadData -> hipModuleGetFunction -> hipModuleLaunchKernel -> D2H readback
claim boundary: scoped_native_hip_module_runtime_trace, standalone_hip_module_probe, arbitraryTargetRuntimeAccepted=false, arbitraryLibraryAccepted=false, broadHipApplicationAcceptance=false
hot1 proof id: hip-module-runtime-proof:a09825bbf201aa86de4db9f267e4d3a8c8362e6b06566f33ded820d599d9b954
hot1 ledger: gpu-ledger-proof:sha256:7b1dd4d81d6d2d2c8e4eaefb5a99d19898cefcc2ce22f08c0252fa1b4cb6b55a
hot1 runtime proof artifact: hip-module-runtime-proof-artifact:7a25b18cf27a0d1b4c0b01cdb969d563174dee447531e6cd49a174219d5a2610
hot1 proof json: mcp/synthi-mcp/.gpu-hmr-test-artifacts/hip-module-runtime-proof/hip-module-runtime-20260626130934-hip-module-runtime-readback/hip-module-runtime-20260626130934-hip-module-runtime-readback-proof.json
hot1 raw readback hash: sha256:56d8a8e6c6599b9aa0d1f0ecfdf3804592e9a717ddf680c755f096c5d92ed721
hot1 expected output verified: true, max_delta=0
hot1 timing: total_validator_wall_time=15231172600ns, dispatch_to_output_proof_time=86200441ns
hot1 card: mcp/synthi-mcp/.gpu-hmr-test-artifacts/hip-module-runtime-proof/hip-module-runtime-20260626130934-hip-module-runtime-readback/hip-module-runtime-readback-compute-card.png
hot2 proof id: hip-module-runtime-proof:2e06a9dd42757e0067c23a829262433e83b5f61a89be57102fa5d802b71464b1
hot2 ledger: gpu-ledger-proof:sha256:b5878196ad2e9778e960a8fa261645b0498c38fc6ffa961f43ce7f4eb166f0f0
hot2 runtime proof artifact: hip-module-runtime-proof-artifact:056bd851e77a99dcb0b754fa67373bc74b47fed6163033cf83391eae9820be0f
hot2 proof json: mcp/synthi-mcp/.gpu-hmr-test-artifacts/hip-module-runtime-proof/hip-module-runtime-20260626131105-hip-module-runtime-readback/hip-module-runtime-20260626131105-hip-module-runtime-readback-proof.json
hot2 raw readback hash: sha256:f2eb735a90c4a5ee34cc05d6f1422d550c5610662a51762e2b4dd4f884442446
hot2 expected output verified: true, max_delta=0
hot2 timing: total_validator_wall_time=13215770900ns, dispatch_to_output_proof_time=41727592ns
hot2 card: mcp/synthi-mcp/.gpu-hmr-test-artifacts/hip-module-runtime-proof/hip-module-runtime-20260626131105-hip-module-runtime-readback/hip-module-runtime-readback-compute-card.png
compute-card image inspection: both HIP module compute cards are data-derived PNG artifacts rendered from raw HIP readback bytes after the epoch-2 dispatch and show `expected output verified: true`. These cards are human-readable compute/readback evidence, not runtime frame visual proof; HIP module matrix acceptance comes from the raw readback files, strict runtime proof artifacts, proof ledger invariants, native HIP module API chain, and compute-oracle/runtime-chain epoch agreement.
current matrix rows: hot1 historical-gpu-validation-matrix-row-sha256-8f956aff7f5d9dc9fbb06e75830c971ac23a0acd0641e4a97b22d5871f0cca1d, hot2 historical-gpu-validation-matrix-row-sha256-2fdfda296b89236ae4bac2a21020c771fc0e6ec7e6caf00a82fc8115ff364e61
current matrix coverage: hip_module_scoped_runtime_readback is accepted only because the same scoped target has hot_delta_1, hot_delta_2 with a distinct edit hash, executable ABI-negative refusal, native runtime event timestamps, epoch-2 artifact hash continuity, raw readback proof, and accepted strict runtime proof artifacts. This remains a scoped module-boundary proof, not arbitrary HIP application, framework, or library HMR.
negative refusal: the paired ABI-layout negative edit rejects before GPU HMR acceptance; accepted signature hash sha256:e6916d59b50b110cd3613fcc53c0eb193175d2943796f56e885ebc1dc6212093 differs from negative signature hash sha256:05bd5ef8a4acf24fc29c4c229af54b31521b4fedc37858c9f7136d0e4f7a17a5.
```

The accepted WebGPU proof is deliberately narrow:

```text
profile: webgpu-wgsl-runtime-triangle
pipeline scope: explicit-empty-layout-no-bindings-no-vertex-buffers-triangle-list
wgsl hash before: sha256:46927f5ed8423e965306fb45cf698deab767e2582d9b745db3c064c092285582
wgsl hash after: sha256:63fac832718d56179ba8a043e55afe6b93f6af9608269c13aa174fb3e66a2e66
epoch: webgpu-epoch-2
dispatch id: webgpu-dispatch-2
pipeline id: webgpu-pipeline-2-4fb3e66a2e66
ledger failed invariants: none
visual thresholds accepted: true
process continuity accepted: true
native WebGPU API accepted: true
no shim applied: true
no browser flag claimed as HMR: true
```

Unsupported WebGPU profiles outside the implemented explicit-empty visual scope, explicit-profiled uniform-buffer/float32-vertex-buffer visual scope, and explicit profiled storage/uniform float32 compute-readback scope, including other bind group resource kinds, unsupported vertex formats, fixed color target formats outside the preferred canvas format, non-opaque alpha mode, undeclared expected compute output, or engine-owned pipeline caches, are rejected by the runner instead of being overclaimed.

## External Project Profiles

ThreeJS WebGL shader lava now has current typed external-contract visual-profile evidence in the latest default matrix. The runner emits report-level content-addressed before/after/diff visual oracle hashes for external visual profiles, and the matrix recomputes those PNGs through the async visual proof worker. This row remains external runtime screenshot proof only: `visual_profile_accepted`, `acceptedForGpuHmr=false`, `gpuHmrSuccess=false`, `proofChain=external_screenshot_visual_oracle`, and open gap `full_runtime_gpu_hmr_ledger_not_present`.

```text
profile: threejs-webgl-shader-lava
matrix row: historical-gpu-validation-matrix-row-sha256-e6ab8e0597707e0db2d8d87c3b95fc5c14251a25e78a4712c4152e57b30fcdcf
matrix proof: gpu-validation-matrix-ledger:sha256:c5b74ecb25b0eca0e39b6ff4540ae24282191685589c1cf3866622a6aad08127
matrix json: mcp/synthi-mcp/.gpu-hmr-test-logs/validation-matrix/gpu-hmr-validation-matrix-20260629T165451Z.json
latest report: mcp/synthi-mcp/.gpu-hmr-test-logs/external-projects/threejs-webgl-shader-lava-1782660694725-report.json
latest visual proof: mcp/synthi-mcp/.gpu-hmr-test-logs/external-projects/threejs-webgl-shader-lava-1782660694441-visual-proof.json
latest proof id: external-visual-proof:065da55a0849250968926125e2756025c38e17985bea6606f9bc7639778818f6
latest status: pass
backend: webgl
profile class: external_engine_visual_profile
latest total: 6397.4307ms
latest build: 1586ms
latest runtime ready: 267ms
latest source write: 5ms
latest edit to runtime signal: 1206ms
latest edit to screenshot: 2496ms
latest visual diff: 63ms
latest report changed pixel ratio: 28.3769%
latest report mean abs delta 8-bit: 12.9109
latest matrix-recomputed changed pixel ratio: 29.0619%
latest matrix-recomputed mean abs delta 8-bit: 9.6832
matrix async visual worker: node_worker_threads_visual_proof_worker, proof_ready=true, offMainThread=true, tile hashing accepted, full-frame diff computed
artifact hashes: before sha256:f7cf4f222eebdf4c5753a57b2925d68cebcdc48ba50a9fd195ca53ee2d138636; after sha256:e8cf61e3d591cb8c90fae9ac159e21b9f981a087adfbf6a473ce33e246feb6bf; diff sha256:8c24cc9224f1e1544b1d2e28b168b121d908844c08e3bee2ee1601e3161ee81b
visual inspection: before/after/diff images were opened locally; the before/after WebGL lava scene and the diff are nonblank with a visible shape/material change.
```

Visual artifacts:

```text
latest before: mcp/synthi-mcp/.gpu-hmr-test-artifacts/external-projects/threejs-webgl-shader-lava-before-1782660690302.png
latest after: mcp/synthi-mcp/.gpu-hmr-test-artifacts/external-projects/threejs-webgl-shader-lava-after-1782660693016.png
latest diff: mcp/synthi-mcp/.gpu-hmr-test-artifacts/external-projects/threejs-webgl-shader-lava-external-diff-1782660694302.png
```

Bevy/WGSL profile built with real Rust GNU/w64devkit toolchain but remains rejected, not accepted.

Fresh rejection artifact:

```text
profile: bevy-wgsl-shader-material
report: mcp/synthi-mcp/.gpu-hmr-test-logs/external-projects/bevy-wgsl-shader-material-1780972280020-report.json
rejection proof id: external-rejection-proof:543387dc31d8a1a92e79c58a0dcc137a3eede776be7f0ac5f03881e5f3feaeec
rejection proof: mcp/synthi-mcp/.gpu-hmr-test-logs/external-projects/bevy-wgsl-shader-material-1782388085464-rejection-proof.json
profile selection: recovered from report profile id and packaged profile manifest, explicit=false, recovered=true
profile manifest hash: sha256:e19f63445753b5c85a9ef59a1f4386f160cdd5866b4722e961f3db44e03cf33e
matrix row: historical-gpu-validation-matrix-row-sha256-b1132a777685310f5feef00547a6c714ac8ed1901cc7412e3a0bd3b7f09f2fce
status: fail
reasons: mcp_request_timeout, mcp_no_decoded_frames, visual_frame_missing, visual_oracle_not_accepted
visual evidence accepted: false
total validator wall: 1203518.9259ms
```

Earlier strict proof-state rejection:

```text
profile: bevy-wgsl-shader-material
report: mcp/synthi-mcp/.gpu-hmr-test-logs/external-projects/bevy-wgsl-shader-material-1780961693506-report.json
status: fail
reason: gpu_hmr_proof_insufficient
required state: gpu-hmr-full-runtime-proven
observed result state: missing
```

This is a correct refusal, not an accepted arbitrary-project proof.

## Runtime And Preview State

Current local service check:

```text
vectant-ade-worker-1 Up
vectant-ade-mcp-1 Up, 127.0.0.1:9464->9464
vectant-ade-frontend-1 Up, 127.0.0.1:3000->3000
```

Preview HTTP checks:

```text
http://localhost:3000/workspace/ray-light-gpu-hmr-proof-20260622-embedded-ledger-10 -> HTTP 200
http://localhost:3000/workspace/flow-gpu-hmr-proof-20260622-embedded-ledger-10 -> HTTP 200
```

The Codex in-app Browser connector failed to initialize in this session with a sandbox metadata error, so browser screenshots are not counted as proof. Visual proof in this checkpoint uses persisted MCP screenshots and the local image viewer.

## Recent Commits

Proof/fix commits are separate:

```text
e1e27913c fix(gpu-hmr): fast-fail terminal rocm lifecycle gaps
fb8772753 fix(gpu-hmr): require explicit hiprt backend evidence
b9b4f5be7 fix(gpu-hmr): block auto oracles for rocm final acceptance
b3e7d6d1b fix(gpu-hmr): require explicit real rocm profile
e4f82cf48 fix(gpu-hmr): recompute large ml app hook obligation
d45425c0b fix(gpu-hmr): require app hooks for large rocm final targets
72f8269a2 fix(gpu-hmr): validate app-hook stage evidence
76cc2e542 fix(gpu-hmr): allow proven native rocm bridge gate
9364f76f2 docs(gpu-hmr): refresh realistic raytrace proof ledger
46248bb8d feat(gpu-hmr): enrich deterministic raytrace visual proof
9cb1a7faf feat(gpu-hmr): add generic native rocm runtime bridge gate
512b46c66 feat(gpu-hmr): accept generic rocm runtime oracle contracts
c333fb739 fix(gpu-hmr): recover typed external rejection contracts
6fc133653 docs(gpu-hmr): note gpu worker observer packaging
df0530b1f fix(gpu-hmr): package native observer in gpu worker
22b819fc2 docs(gpu-hmr): record typed webgpu preflight proof
fd6e1fe0a fix(gpu-hmr): emit typed webgpu preflight evidence
155376381 docs(gpu-hmr): record real rocm sidecar proof bridge
8b90f5e8c fix(gpu-hmr): bind real rocm sidecars to runtime proof
97f098769 docs(gpu-hmr): correct current saxpy proof scope
37f110451 fix(gpu-hmr): bind visual proof to ledger oracle
5e1ad07b6 fix(gpu-hmr): require resolved fission output oracle
394f6ff32 fix(gpu-hmr): bind fission contract to verifier proof
e90fc49b3 fix(gpu-hmr): derive runtime profile self-check fixture
22f003d3b fix(gpu-hmr): require complete fission contract proof
f0db3c67e fix(gpu-hmr): classify external timeout rejections
b542e7390 docs(gpu-hmr): record Bevy rejection proof artifact
706c20799 fix(gpu-hmr): ledger external profile rejections
8b358451e docs(gpu-hmr): record structured OIDN preflight proof
fcff70032 feat(gpu-hmr): add structured OIDN HIP preflight proof
08f16a794 fix(gpu-hmr): archive agent split results per slug
f42e4d32e docs(gpu-hmr): update ROCm proof ledger demo status
92543192f fix(gpu-hmr): preserve derived contracts in proof summaries
302bbc238 fix(gpu-hmr): require explicit real rocm docker config
a12e654d8 fix(gpu-hmr): require explicit agent split docker config
529fce4e2 fix(gpu-hmr): keep external chrome gpu enabled
01a2759a1 fix(gpu-hmr): require explicit docker preview config
71e9e3dd4 fix(gpu-hmr): reject invalid visual evidence artifacts
ff20d2d77 docs(gpu-hmr): record current proof status
072986aaa fix(gpu-hmr): keep compute proof cards supplemental
d600c7df3 fix(gpu-hmr): derive hip launch contract from runtime evidence
f8c82024c fix(gpu-hmr): normalize real rocm proof ledger inputs
220d95755 fix(gpu-hmr): validate full runtime artifact summaries
39832df72 fix(gpu-hmr): preserve degraded dispatch identity
```

## Verification Commands

Passed after the latest code fix or latest verification rerun:

```text
npx vitest run mcp/synthi-mcp/tests/unit/gpu_hmr_runtime_proof.test.ts
node mcp/synthi-mcp/node_modules/vitest/vitest.mjs run mcp/synthi-mcp/tests/unit/gpu_hmr_runtime_proof.test.ts
npm --prefix mcp/synthi-mcp run build
npm --prefix mcp/synthi-mcp run proof:external-project:self-check
npm --prefix mcp/synthi-mcp run proof:visual-evidence:self-check
npm --prefix mcp/synthi-mcp run proof:timing-metrics:self-check
npm --prefix mcp/synthi-mcp run proof:generated-split-granularity:self-check
npm --prefix mcp/synthi-mcp run proof:strict-gates:self-check
npm --prefix mcp/synthi-mcp run proof:acceptance-contract:self-check
npm --prefix mcp/synthi-mcp run proof:adversarial-ledger:self-check
node --check mcp/synthi-mcp/scripts/gpu-hmr-external-project-profile.mjs
node --check mcp/synthi-mcp/scripts/gpu-hmr-real-rocm-repo-validation.mjs
node --check mcp/synthi-mcp/scripts/lib/gpu-hmr-validation-proof-artifact.mjs
npm --prefix mcp/synthi-mcp run proof:validation-matrix:self-check
npm --prefix mcp/synthi-mcp run proof:real-rocm:self-check
npm --prefix mcp/synthi-mcp run proof:validation-matrix
npm --prefix mcp/synthi-mcp run proof:validation-matrix:history
npm --prefix mcp/synthi-mcp run proof:runtime-profile:self-check
npx vitest run tests/unit/gpu_hmr_runtime_proof.test.ts
node mcp/synthi-mcp/scripts/gpu-hmr-real-rocm-repo-validation.mjs --self-check
docker run --rm -v "${PWD}\backend\synthi-webrtc-compiler\worker:/workspace" -w /workspace vectant-ade-worker-builder-test:latest cargo test --release --features gpu-hmr gpu_fission --lib
docker run --rm -v "${PWD}\backend\synthi-webrtc-compiler\worker:/workspace" -w /workspace vectant-ade-worker-builder-test:latest cargo test --release --features gpu-hmr gpu_prod_contracts --lib
$env:SYNTHI_GPU_HMR_EXTERNAL_PROJECT_DEFAULT_PROFILE_ID='threejs-webgl-shader-lava'; npm --prefix mcp/synthi-mcp run proof:external-project
node --check mcp/synthi-mcp/scripts/gpu-hmr-agent-split-workspace-test.mjs
SYNTHI_GPU_AGENT_MODE=seed-only SYNTHI_GPU_VENDOR=rocm SYNTHI_GPU_AGENT_FIXTURE=flow SLUG=agent-split-archive-smoke-20260609-pass SYNTHI_SYNC_TO_GCS=0 SYNTHI_VALIDATION_AUTHLESS_WORKSPACE=1 node scripts/gpu-hmr-agent-split-workspace-test.mjs
MCP_TRANSPORT=docker MCP_CONTAINER=vectant-ade-mcp-1 MCP_CONTAINER_ENTRY=/workspace/mcp/synthi-mcp/dist/index.js MCP_SIGNALING_URL=ws://signaling-server:9000 WORKER_CONTAINER=vectant-ade-worker-1 SYNTHI_GPU_AGENT_CAPTURE_ARTIFACTS=1 SYNTHI_GPU_VENDOR=rocm SYNTHI_GPU_ARCH=gfx1201 SYNTHI_GPU_AGENT_FIXTURE=ray-light SLUG=ray-light-gpu-hmr-proof-20260622-embedded-ledger-10 SYNTHI_SYNC_TO_GCS=0 SYNTHI_VALIDATION_AUTHLESS_WORKSPACE=1 node mcp/synthi-mcp/scripts/gpu-hmr-agent-split-workspace-test.mjs
MCP_TRANSPORT=docker MCP_CONTAINER=vectant-ade-mcp-1 MCP_CONTAINER_ENTRY=/workspace/mcp/synthi-mcp/dist/index.js MCP_SIGNALING_URL=ws://signaling-server:9000 WORKER_CONTAINER=vectant-ade-worker-1 SYNTHI_GPU_AGENT_CAPTURE_ARTIFACTS=1 SYNTHI_GPU_VENDOR=rocm SYNTHI_GPU_ARCH=gfx1201 SYNTHI_GPU_AGENT_FIXTURE=flow SLUG=flow-gpu-hmr-proof-20260622-embedded-ledger-10 SYNTHI_SYNC_TO_GCS=0 SYNTHI_VALIDATION_AUTHLESS_WORKSPACE=1 node mcp/synthi-mcp/scripts/gpu-hmr-agent-split-workspace-test.mjs
npm --prefix mcp/synthi-mcp run proof:oidn:preflight:self-check
npm --prefix mcp/synthi-mcp run proof:opencl:preflight:self-check
SYNTHI_OPENCL_WORKER_CONTAINER=vectant-ade-worker-1 SLUG=opencl-rocm-preflight-20260609-after-output-gate npm --prefix mcp/synthi-mcp run proof:opencl:preflight
npm --prefix mcp/synthi-mcp run proof:vulkan:preflight:self-check
SYNTHI_VULKAN_WORKER_CONTAINER=vectant-ade-worker-1 SLUG=vulkan-rocm-preflight-20260609 npm --prefix mcp/synthi-mcp run proof:vulkan:preflight
node mcp/synthi-mcp/scripts/gpu-hmr-external-project-profile.mjs --rejection-proof-from-report mcp/synthi-mcp/.gpu-hmr-test-logs/external-projects/bevy-wgsl-shader-material-1780972280020-report.json
```

Latest HIPRT/OIDN live proof commands:

```text
$env:SLUG='hiprt-camera-rays-strict-region-20260622'; $env:SYNTHI_HIPRT_WARM_ALLOW_REJECTED='1'; npm --prefix mcp/synthi-mcp run proof:hiprt:same-process:camera-rays
  current 2026-06-24 matrix status: source-adapted visual_profile_accepted only; no-shim full-runtime HIPRT acceptance remains missing

$env:SLUG='hiprt-camera-rays-runmodes-20260623-hot1'; $env:SYNTHI_HIPRT_WARM_ALLOW_REJECTED='1'; npm --prefix mcp/synthi-mcp run proof:hiprt:same-process:camera-rays
  current 2026-06-24 matrix status: source-adapted cold/hot visual evidence only

$env:SLUG='hiprt-camera-rays-runmodes-20260623-hot2-neg'; $env:SYNTHI_HIPRT_WARM_ALLOW_REJECTED='1'; $env:SYNTHI_HIPRT_WARM_METRIC_SCOPE='hot_delta_2'; $env:SYNTHI_HIPRT_WARM_DIFFERENT_EDIT='1'; $env:SYNTHI_HIPRT_WARM_EDIT_KIND='different_gpu_edit'; $env:SYNTHI_HIPRT_WARM_DELTA_AFTER='hiprtRay ray = render_data.current_camera.get_camera_ray(x_ray_point_direction, render_data.render_settings.render_resolution.y - y_ray_point_direction, render_data.render_settings.render_resolution);'; npm --prefix mcp/synthi-mcp run proof:hiprt:same-process:camera-rays
  current 2026-06-24 matrix status: source-adapted hot-delta-2 visual evidence plus ABI-changing negative-edit refusal artifact; no-shim full-runtime HIPRT acceptance remains missing

$env:SLUG='hiprt-megakernel-blank-refusal-20260622'; $env:SYNTHI_HIPRT_WARM_ALLOW_REJECTED='1'; npm --prefix mcp/synthi-mcp run proof:hiprt:same-process
  current 2026-06-22 status: refused as blank oracle-region output

$env:SYNTHI_OIDN_WORKER_CONTAINER='vectant-ade-worker-1'; $env:SYNTHI_OIDN_REPO_PATH='/tmp/synthi-real-rocm/HIPRT-Path-Tracer'; $env:SYNTHI_OIDN_ALLOW_REJECTED='1'; $env:SLUG='oidn-hiprt-rocm-preflight-20260622-real-checkout'; npm --prefix mcp/synthi-mcp run proof:oidn:preflight
  current accepted status: diagnostic rejection only. Without `SYNTHI_OIDN_ALLOW_REJECTED=1`, rejected HIP output proof exits nonzero. The 2026-06-22 artifact rejected OIDN HIP due libamdhip64.so.5 dependency mismatch with no shim or symlink fallback accepted; the latest diagnostic rerun refused earlier because the worker no longer had the HIPRT checkout at the declared path.
```

Expected rejection command:

```text
SYNTHI_GPU_HMR_EXTERNAL_MCP_TRANSPORT=docker SYNTHI_GPU_HMR_EXTERNAL_SIGNALING_URL=ws://signaling-server:9000 SYNTHI_GPU_HMR_EXTERNAL_MCP_CONTAINER=vectant-ade-mcp-1 SYNTHI_GPU_HMR_EXTERNAL_MCP_CONTAINER_ENTRY=/workspace/mcp/synthi-mcp/dist/index.js SYNTHI_GPU_HMR_EXTERNAL_MCP_REQUEST_TIMEOUT_MS=1200000 SYNTHI_GPU_HMR_EXTERNAL_MCP_ATTACH_TIMEOUT_MS=1200000 npm --prefix mcp/synthi-mcp run proof:external-project:bevy
```

## Remaining Work

| Plan Area | Current State | Remaining Work |
| --- | --- | --- |
| ROCm/HIP generated/profiled runtime | Accepted scoped full-runtime proof exists for generated/profiled device-artifact rows. | Keep rerun stability high; latest failed reruns must remain rejected. Do not present these rows as broad library-agnostic HIP acceptance. |
| ROCm/HIP module runtime | Scoped HIP module-load/readback rows now count as current full-runtime GPU HMR for hot delta 1 and hot delta 2 with a different edit, using real HSACO, native HIP module APIs, raw readback, data-derived proof cards, strict `runtimeProofArtifact` records, and ledger invariants. | Broaden only through additional declared profiles and ABI/output-oracle evidence. Do not infer arbitrary library, framework, or application HMR from module-boundary proof. |
| Ray-light/Flow visual MCP | Current June 25 global matrix carries row-bound visual/profile evidence for `gpu-agent-ray-light-20260625T104554-rocm-fission-evidence` and `gpu-agent-flow-20260625T103454-rocm-profile-bind`; the June 22 `embedded-ledger-10` slugs remain historical focused evidence for cold split, hot delta 1, hot delta 2 with different edit, and negative edit refusal. | Keep top-level result files as latest-run convenience outputs only and treat the global matrix as aggregate authority. |
| HIPRT | CameraRays and MegaKernel direct-light-gain are source-adapted ray-traced visual profiles classified as `visual_profile_accepted`, not no-shim full-runtime GPU HMR. MegaKernel direct-light-zero is refused as blank oracle-region output. | Prove a HIPRT path without source-adapted profile hooks before accepting `hiprt_visual_path` or `hiprt_run_modes` as GPU HMR. |
| OIDN | CPU diagnostics pass; HIP backend rejected due `libamdhip64.so.5` dependency mismatch. | Use a matching OIDN HIP build for ROCm 7 or keep OIDN out of accepted HIP proof. No shims. |
| OpenCL | Scoped host-local OpenCL runtime/readback proof is accepted for hot delta 1 and hot delta 2 through `OpenCL.dll`, native dispatch/readback API counts, raw byte-backed compute oracle artifacts, and strict ledger closure. The worker container still has `libOpenCL.so.1` but no vendor ICD or `clinfo`, so worker-container preflight remains refusal-only. | Broaden only through additional real OpenCL targets and/or a real worker-container ICD path with the same dispatch/event/readback ledger proof. No synthesized ICDs or shims; do not infer arbitrary OpenCL project acceptance from the scoped readback probe. |
| Vulkan | Worker has `libvulkan.so.1`, but no ICD files and no `vulkaninfo`; structured preflight rejected Vulkan runtime proof. | Provide a real Vulkan ICD/tooling, then add pipeline-layout, command-buffer, frame-boundary, and visual oracle ledger proof. No synthesized ICDs or shims. |
| WebGPU | Scoped Chrome/AMD WGSL runtime visual proof accepted for explicit-empty triangle-list and explicit-profiled uniform-bind-group/float32-vertex-buffer triangle-list profiles. Scoped compute/readback proof is also accepted for the explicit storage/uniform float32 readback profile after adding strict runtime proof artifacts. | Broaden only with executed evidence for additional bind group kinds, vertex formats, compute data types, pipeline-cache ownership, command/frame traces, engine integration, and output oracles. Browser flags must remain evidence-only. |
| External projects | ThreeJS WebGL shader-lava has current typed external contract v2 visual-profile evidence with content-addressed PNG before/after/diff proof in the latest default matrix, but it is not full-runtime GPU HMR. Bevy remains rejected by its visual/full-runtime proof gates. | Add backend-specific same-process loader, epoch, dispatch, host-identity, and oracle proof before accepting external projects as full-runtime HMR. |
| CUDA | Not applicable to this AMD ROCm matrix; not validated here. | Validate only on CUDA hardware. |
| Narrow fission | Deterministic generated-split fission verifier accepted `trace_light_rays` and refused Flow's multi-kernel device role. | Broaden only with verifier evidence for additional backends/projects; do not infer per-kernel fission from one-file output. |
| Browser proof | Preview URLs are live; MCP screenshots exist. | In-app Browser backend was unavailable in this session. |

## Accepted Statement

```text
On the local AMD ROCm machine, Synthi can split generated ROCm/HIP GPU workloads, compile the device artifact with hipcc, hot-reload a device-only edit in a running preview/runtime, and prove scoped generated/profiled ROCm/HIP device artifacts with strict runtime-ledger acceptance.

It provides pixel-backed visual evidence for Flow, ray-light, source-adapted HIPRT CameraRays/MegaKernel visual profiles, scoped WebGPU WGSL explicit-empty and explicit-profiled visual binding profiles, and current ThreeJS WebGL shader-lava external visual-profile proof. HIPRT and ThreeJS visual-profile evidence is not currently counted as no-shim full-runtime GPU HMR.

It also proves scoped WebGPU compute/readback for the explicit storage/uniform float32 profile with raw mapped GPU bytes, schema/hash verification, data-derived compute cards, and accepted strict runtime proof artifacts. HIP module compute/readback now has scoped accepted strict runtime proof artifacts for the declared HIP module readback profile. OpenCL now has scoped host-local compute/readback proof for the declared OpenCL readback profile with raw OpenCL output bytes, schema/hash verification, data-derived compute cards, native API counts, and accepted strict runtime proof artifacts. Blank HIPRT render-region output and ABI-changing HIPRT/WebGPU/HIP-module/OpenCL edits are refused instead of accepted.
```

Do not claim:

```text
CUDA runtime proof was validated here.
Every arbitrary GPU project is production accepted.
Generic HIP module-load proof means arbitrary HIP libraries, frameworks, or apps are accepted without app-hook/epoch/dispatch/oracle evidence.
Any current full-runtime row proves broad library-agnostic arbitrary GPU project acceptance.
The generated ray-light MCP fixture is HIPRT/OIDN.
HIPRT has no-shim strict-matrix full-runtime acceptance; current HIPRT proof is source-adapted visual-profile evidence only.
OIDN HIP produced or validated the accepted output.
OpenCL dispatch/readback output proof was validated in the worker container.
The scoped host-local OpenCL readback probe proves arbitrary OpenCL project acceptance.
Vulkan pipeline/command-buffer/frame output proof was validated on this worker.
General WebGPU bind-group kinds, vertex formats, engine-cache, compute beyond the explicit storage/uniform float32 readback profile, or arbitrary app shader HMR was validated on this worker.
A one-file generated .hip split proves per-kernel or smallest-island fission without deterministic verifier evidence.
Flow's one-file generated .hip split proves per-kernel or smallest-island fission.
Bevy has full-runtime proof-ledger acceptance.
```
