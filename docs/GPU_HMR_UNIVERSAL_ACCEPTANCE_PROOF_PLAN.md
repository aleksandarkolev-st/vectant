# GPU HMR Universal Acceptance And Proof Ledger Plan

Draft date: 2026-06-07

## 1. Purpose

This plan hardens GPU HMR from "validated on several friendly profiles" into a system that can safely accept broad real-world GPU projects without hardcoded project branches or false success.

The target is not universal success for every repository. CPU-only projects and host-only edits in GPU projects must continue through CPU/core HMR. The target is:

```text
arbitrary user project
  -> classify project and edit kind
  -> derive a typed GPU HMR contract when GPU HMR is plausible
  -> verify the contract with static and runtime probes
  -> accept only evidence-backed fields
  -> rebuild the smallest safe GPU fission island
  -> load the changed artifact into the same running process
  -> publish it through an epoch-graft path
  -> prove dispatch used the new epoch
  -> prove output came from the new epoch
  -> reject loudly when any required proof is missing
```

The system must be hostile to fake GPU HMR success. Logs, compile output, AI assertions, and screenshot existence are not authoritative proof. They are evidence inputs to a structured proof ledger.

Do not claim: Every arbitrary GPU project is production accepted.

### 1.1 Operational Diagnosis

The validation framework is strong as a proof system, but it is not yet good enough as an everyday development loop. It is currently optimized to be hostile to fake success, which is correct, but the proof path is too coupled to the interaction path.

The fast path must be:

```text
edit -> compile -> load -> epoch publish -> visible change
```

The proof-finalization path must be asynchronous:

```text
artifact hashing -> image decode -> pixel diff -> ledger recompute -> matrix ingestion -> docs/proof packaging
```

The UI should be able to report `HMR applied, proof pending` after epoch publication and lightweight oracle scheduling, while strict mode can still block until the full proof ledger closes. This is the same evidence model with different blocking behavior; it is not a weaker acceptance mode.

The timing evidence already shows the gap. Some edit-visible paths complete in tens to low hundreds of milliseconds, while total validator wall time can be seconds or minutes. When a real ROCm runner waits the full proof window for runtime stages that are structurally absent, the delay is orchestration and proof scheduling, not GPU execution.

Highest-leverage operational fixes:

1. Offload visual validation to worker threads or processes, preferably a Rust visual proof worker or Rust-backed N-API path for PNG decode, hashing, ROI diff, perceptual diff, and proof-card rendering.
2. Make visual proof incremental through deterministic oracle regions, tile hashes, changed ROIs, and full-frame escalation only when the incremental proof is missing or ambiguous.
3. Move heavy artifacts through shared content-addressable storage instead of synchronous `docker cp`, base64 WebSocket payloads, or stdout JSON blobs.
4. Separate interactive HMR from investor-grade proof packaging: dev mode can surface applied/pending state, while strict acceptance still waits for the ledger.
5. Add timeout intelligence so structurally impossible or absent runtime stages fail fast with precise gaps instead of burning a long proof window.

This performance work must not weaken proof gates. It makes the proof ledger asynchronous, content-addressed, incremental, and transport-aware while preserving fail-closed acceptance.

Current implementation note:

```text
2026-07-02 direct cold-result self-containment follow-up: random large arbitrary cold-path results now preserve support-only direct-source evidence on each selected result as well as on candidate records. Dry-run and unprofiled cold-intake results carry `candidateSource`, source URL or local repo path, immutable commit, and the same `directInputEvidence` object with `acceptedForGpuHmr=false`, `gpuHmrSuccess=false`, and `canSatisfyRuntimeProof=false`. Validation-matrix ingestion can now recover `candidateSource` from the result when candidate arrays are absent, recompute the direct-source identity hash against the result source fields, and keep the row source-identity keyed. Smoke coverage strips `candidates` / `selectedCandidates` from a cold manifest and proves result-only direct evidence remains accepted as support evidence while still refusing GPU HMR. Commit `08a1a2998` verified `proof:random-large-project:cold:self-check`, matrix smoke `gpu-validation-matrix-ledger:sha256:f8fc78f98e69ea5d040816bcd83ea8d1bbafdf8751d1f447c0bb07c83f394325`, and full validation-matrix self-check `gpu-validation-matrix-ledger:sha256:1b4b663527a3964ee80b92dcf6b8d687335e5f0138aade73cd1f892660d83605`. This is replay/audit hardening for arbitrary user projects, not a success shortcut: copied result records, direct-source evidence, source listings, build metadata, or runtime-boundary templates still cannot authorize GPU HMR without same-process loader, epoch publication, dispatch trace, host identity, visual/compute output oracle bytes, firewall, runtime chain, and strict proof-ledger closure.

2026-07-02 direct cold-source adversarial coverage follow-up: direct arbitrary cold-path evidence was audited by a subagent and confirmed to be source-identity based, not target-name based. The random cold runner self-check now asserts that CLI/env direct-source evidence is `targetNameIndependent=true`, has empty `projectNameWhitelist` and `specificTargetIdsAllowed`, carries a valid `sourceIdentityHash`, and keeps `evidenceHash == sourceIdentityHash`. Validation-matrix smoke coverage now includes forged direct cold-source rows for `targetNameIndependent=false`, nonempty project whitelist, nonempty target whitelist, and mutated source identity hash; each row is invalidated with the recomputed direct-input gates and cannot contribute to broad readiness or GPU HMR success. Commit `bca98b5d7` verified `proof:random-large-project:cold:self-check`, matrix smoke `gpu-validation-matrix-ledger:sha256:638835dddc246985a9dadabf7c8547725f17d20dc0389d9596f139c424a4de03`, and full validation-matrix self-check `gpu-validation-matrix-ledger:sha256:0ee47f3d7655253662ecd63f4a48527a30db5427847cccf3e33372589b5cba69`. A seven-repository direct cold dry-run selected PyTorch, TensorFlow, Godot, Bevy, Taichi, Open3D, and CUTLASS candidates by direct source evidence only; a bounded real Taichi cold intake inspected 1,244 source-relevant files, 48 GPU-source signals, accepted source-tree/build/runtime-boundary-template evidence, and still correctly refused GPU HMR because same-process loader, epoch publication, dispatch trace, host identity, output oracle, and strict ledger proof were absent. This is generic arbitrary-project user-path evidence and anti-hardcoding coverage, not acceptance by repository name, target ID, profile, scenario, log text, or cold-intake success.

2026-07-02 identity and random-cold source-listing hardening follow-up: validation-matrix coverage and row selection no longer allow retained artifact paths, profile labels, or lexicographic file paths to stand in for project identity. Large real ROCm coverage now requires explicit `targetId`; rows with only `profileId` or `artifactPath` are grouped under support-only `large_real_rocm_repo:unknown_target_identity` with `profileIdDiagnosticOnly=true`, `artifactPathDiagnosticOnly=true`, and `large_real_rocm_repo_target_identity_missing`. Row selection tie breaks now use explicit attempt sequence when present, otherwise a path-stripped content hash; smoke coverage proves a lexicographically larger artifact path cannot win equal-priority selection. Random large arbitrary cold-path readiness now requires a support-only `synthi.gpu_hmr.random_cold_source_listing_manifest.v1` with `proofAuthority=source_listing_entries_only_not_gpu_hmr_success`, source listing entries, recomputed listing hash, recomputed file/byte/source/build/GPU counts, and no GPU HMR/runtime/dispatch authority claims. The random cold-path runner emits that manifest from actual Git listing entries, and the matrix refuses inflated top-level source counts when the recomputed listing is small. Verification passed random cold-path self-check, validation-matrix smoke `gpu-validation-matrix-ledger:sha256:256c8bd1b4d31f6c8c872b44106d6782284e2a136e943e4ac2085fa9afc67128`, and full validation-matrix self-check `gpu-validation-matrix-ledger:sha256:940df05be7301e83d4f8f874b3ff839a1e6d540f5fbe4aec18abaca83e6ae8cf`. These changes are generic anti-hardcoding gates only: they do not whitelist repositories, profiles, paths, filenames, target IDs, or scenarios, and they cannot authorize GPU HMR without same-process loader, epoch publication, dispatch trace, host identity, visual/compute output oracle bytes, firewall, runtime chain, and strict proof-ledger closure.

2026-07-02 broad-readiness replay and source-provenance hardening follow-up: validation-matrix broad readiness now rejects freshly timestamped contributor rows when their artifact path identifies historical/default/audit replay roots or carries an artifact-path timestamp outside the current freshness window. The gate records support-only `synthi.gpu_hmr.broad_readiness_artifact_path_provenance.v1` / random-cold path provenance diagnostics and keeps those rows visible as refusal evidence while preventing them from counting as current arbitrary-project breadth. Random large cold-path broad readiness also no longer accepts `profileId` / `profile_id` as proof of `unprofiled_arbitrary_project_cold_intake`; the mode must come from the cold-path facet or row-level `profileMode`. Source-first visual broad readiness now requires `user_source_files` / `workspace_source_files` to carry support-only `synthi.gpu_hmr.source_first_workspace_source_provenance.v1` with an external source root, content-addressed source-tree snapshot, target-name-independent authority, and no GPU HMR/runtime/dispatch success claims. Direct URL/commit and direct local Git source paths continue through direct-input evidence and internal-root rejection. Smoke coverage refuses fresh-mtime historical rows, old dated artifact paths, profile-id-only cold-path rows, and workspace/user source rows without provenance, while accepting a valid support-only workspace provenance fixture. Verification passed random cold-path self-check and validation-matrix self-check with ledger `gpu-validation-matrix-ledger:sha256:7867a0dc2e223588bcccb0ca40ef0eff93ce53c7f4c74b81bacb2913991b446b`. These are generic replay and provenance gates only: they do not whitelist projects, target IDs, profile IDs, paths, or repository names, and they cannot authorize GPU HMR without same-process loader, epoch publication, dispatch trace, host identity, visual/compute output oracle bytes, firewall, runtime chain, and strict proof-ledger closure.

2026-07-02 broad-readiness contributor freshness follow-up: validation-matrix broad readiness now applies collector-mtime freshness to every broad contributor class, not only random large cold-path rows. Strict full-runtime rows, adversarial refusals, source-first visual rows, and random cold-path rows must all be current relative to the matrix `generatedAt` window before they can contribute to `synthi.gpu_hmr.broad_library_agnostic_matrix_proof.v1`. Stale retained JSON remains audit/refusal evidence, but it now produces explicit gaps such as `broad_acceptance_requires_fresh_full_runtime_rows`, `broad_acceptance_requires_fresh_adversarial_refusals`, and `broad_acceptance_requires_fresh_source_first_visual_full_runtime_row` instead of proving current arbitrary-project readiness. This is generic evidence hygiene only; it uses collector-owned timestamps, not project names, target IDs, profile IDs, backend labels, or fixture names, and cannot authorize GPU HMR without same-process loader, epoch, dispatch, host identity, output oracle, visual/compute bytes, firewall, runtime chain, and strict ledger closure.

2026-07-02 direct-local arbitrary cold-path fixture exclusion follow-up: random large arbitrary cold-path broad readiness now rejects `direct_local_git_repo_path` candidates whose normalized repo path points into Synthi-owned test/log/artifact/generated/dependency roots such as `.gpu-hmr-test-logs`, `.gpu-hmr-test-artifacts`, `tmp/validation-runs`, `tmp/real-rocm`, test fixture roots, `.synthi/generated`, or `node_modules`. Legitimate direct local user repos can still qualify when they are CLI/env-declared, content-addressed, commit-bound, large enough, source-derived, and support-only. Self-check/local fixture repos remain diagnostic refusal evidence and cannot stand in for arbitrary user-project cold paths.

2026-07-02 direct local cold-path spoof coverage follow-up: the random large-project cold-path runner self-check now covers configured candidate JSON that tries to declare `candidateSource=direct_local_git_repo_path` and attach forged direct-input evidence. Configured/sample-pool candidates continue to normalize to `configured_candidate_pool` with `directInputEvidence=null`; only actual CLI/env direct local repo input can mint support-only direct-source evidence. This prevents sample-pool metadata, profile JSON, fixture JSON, or repository labels from standing in for a user-supplied arbitrary local project.

2026-07-02 source-first visual direct-local fixture exclusion follow-up: source-first visual broad-readiness now applies the same direct-local path-origin rule used by random cold paths. Accepted source-first visual runtime rows can still prove scoped full-runtime GPU HMR, but they cannot contribute to broad arbitrary-project source-first visual coverage when `sourceAuthority=direct_local_git_repo_path` points into Synthi-owned log/artifact/test/generated/dependency roots. The `synthi.gpu_hmr.source_first_visual_broad_readiness_predicate.v1` predicate now records `direct_local_source_path_outside_matrix_fixture_roots` and the rejected root classes, and smoke coverage proves fixture-local visual rows keep `sourceFirstVisualRowCount=0`. This is a generic fixture/replay hardening gate, not a project-name branch.

2026-07-02 explicit generated-role and device-source routing hardening follow-up: the worker no longer promotes familiar split filenames such as `shared.h`, `core.cpp`, `gui.cpp`, `host_runner.cpp`, `device.hip`, or `device.cu` into semantic roles unless `compile_manifest.module_files` or an explicit role object declares that mapping. Proof-contract generated-role metadata likewise no longer synthesizes default role paths from missing manifests. The lower-level device compile path now refuses nonempty GPU source when no explicit generated source filename is supplied, so vendor choice alone cannot materialize `device.hip` or `device.cu`. Device fast-path routing now resolves generated device paths only through per-source mapping evidence, not global `generatedDevicePath` or `generatedRoles.device.path` fallbacks. Extension-based `.hip`/`.cu` deterministic pre-routing now requires explicit manifest device evidence through `module_files.device` or `gpu.device_roles[].source_files`, and SDK proof fingerprints no longer probe hardcoded `/opt/rocm` or `/usr/local/cuda` roots when environment/probe evidence is absent. These are generic fail-closed gates: they remove filename/vendor/path shortcuts without adding project-name branches, profile shortcuts, fixture shortcuts, or GPU HMR acceptance by declaration.

2026-07-02 external rejection ingestion hardening follow-up: validation-matrix ingestion no longer drops `synthi.gpu.hmr.external_project_rejection.v1` artifacts when a project/profile ID or retained file path contains `self-check`. External rejection rows are now governed by schema, failed status, explicit rejection reasons, and recomputed external-project contract evidence rather than name filters. Smoke coverage includes a `self-check`-named arbitrary external project that remains `refusal_proven`, `acceptedForGpuHmr=false`, and `gpuHmrSuccess=false` while preserving visual-oracle refusal reasons. This is arbitrary-project coverage hygiene only; it prevents name-shaped projects from disappearing from refusal history and cannot authorize GPU HMR without same-process loader, epoch publication, dispatch trace, host identity, visual/compute output bytes, firewall, runtime chain, and strict ledger closure.

2026-07-02 real ROCm sidecar backend evidence hardening follow-up: sidecar/runtime backend consistency can no longer be accepted from profile, CMake, compiler, or project-name-shaped backend hints. The real ROCm runner now records broad diagnostic backend candidates separately from `runtimeBoundBackendCandidates`, with accepted sidecar consistency requiring strict-runtime-proof backend authority and source `strict_runtime_proof_backend`. Validation-matrix ingestion rejects serialized sidecar facets that set `accepted=true`, `runtimeConsistencyAccepted=true`, `backendConsistent=true`, or `canSatisfyRuntimeProof=true` unless the sidecar backend matches runtime-bound backend candidates and the runtime backend evidence authority is `strict_runtime_proof_backend_evidence`. Smoke coverage includes a forged hint-only sidecar consistency facet that remains refused with `sidecar_runtime_backend_runtime_evidence_missing` and `sidecar_runtime_backend_evidence_not_runtime_bound`. This preserves diagnostic hints for arbitrary projects while preventing build/profile/backend strings from closing a runtime acceptance gate.

2026-07-01 run-mode coverage support row-binding follow-up: `synthi.gpu.hmr.run_mode_coverage_support.v1` is now bound to the current row's run-mode artifact instead of acting as a reusable parent-proof badge. Support generation records proof-ledger success, strict runtime-artifact success/full-runtime status, the recomputed ledger proof ID, and optional run-mode proof IDs; companion cold/negative artifacts bind the support to their own `metricScope` and `editHash` before writing. Validation-matrix ingestion recomputes the support facet, requires the support row's metric scope/edit hash to match the current row, requires any supplied run-mode proof IDs to overlap the current row IDs, and `rowHasLinkedRunModeCoverageSupport` refuses copied support even when parent IDs, contract hash, artifact hash, and success flags are truthy. Smoke coverage now includes a forged borrowed-support cold row that remains `cold_split_proven` at most but cannot satisfy `per_target_run_modes`, plus false-success and missing-parent support refusals. Verification passed matrix smoke `gpu-validation-matrix-ledger:sha256:5308f58c71a64a1699073438def3aa9a5789f64ff86a88abfa4fa7902700441b`, full validation-matrix self-check `gpu-validation-matrix-ledger:sha256:c5b795cbd8bf4d41ea45712177b7ccec364134fbe7960be2d6f060ed256f98bb`, `proof:agent-split:source-first:self-check`, and `proof:webgpu:runtime-visual:self-check`. This is generic row-identity hardening for Flow/WebGPU-style companion evidence and future arbitrary projects; it is not a project-name shortcut and cannot authorize GPU HMR without same-process loader, epoch publication, dispatch trace, host identity, visual/compute output oracle bytes, firewall, runtime chain, and strict ledger closure.

2026-07-01 runtime-profile adapter-result strict-gate boundary: runtime-profile adapter result manifests can no longer turn a serialized `runtimeProofArtifact.gpuHmrSuccess=true` / `fullRuntimeProven=true` claim into `strictRuntimeProofAccepted=true` by declaration. The profile wrapper now runs the generic `runtimeProofArtifactStrictGate` over any adapter-declared proof artifact, records the strict-gate status and failures, and emits `runtime_profile_adapter_strict_gate_rejected` when stage results, proof ledger query, acceptance contract, source consistency, visual/compute oracle bytes, or other strict gates are missing. The real ROCm adapter-result bridge and validation-matrix ingestion also require a passing strict-gate summary before an imported adapter result can carry strict-proof-accepted support; a bridge that declares strict proof without that gate now fails with `runtime_profile_adapter_strict_gate_not_accepted` / `real_rocm_runtime_profile_adapter_result_strict_gate_not_accepted`. Boundary events can still flow as support-only evidence when recomputed stage/provenance/runtime-chain gates pass, but adapter JSON, smoke fixtures, copied result files, profile IDs, or result hashes cannot mint GPU HMR runtime authority. This is project-agnostic proof-authority hardening, not a Flow/HIPRT/OpenCL/MIOpen shortcut and not arbitrary-project acceptance without same-process loader, epoch publication, dispatch trace, host identity, output oracle, firewall, and strict ledger closure.

2026-07-01 random large arbitrary cold-path source-breadth follow-up: random large cold-path rows no longer qualify for broad readiness from raw file count or byte volume alone. The matrix now requires a raw large-source signal plus a generic `sourceRelevantFileCount` / `source_relevant_file_count` style source-or-build-relevant breadth signal of at least 25 files before a cold row can count as a qualifying arbitrary-project cold path. Asset-heavy or binary-heavy repositories with only a few source/build-relevant files remain candidate-only and keep broad readiness refused with the existing large-source gaps. Smoke coverage adds five asset-heavy rows with 2500 files, 128 MiB of known bytes, and only three source-relevant files; they remain `candidate_only` with `randomColdPathRowCount=0`, `randomColdPathCandidateRowCount=5`, and no GPU HMR authority. Verification passed matrix smoke `gpu-validation-matrix-ledger:sha256:cd03ad1be26a0d1affe6101364b5611ad25dfc8db69a7d67043df9d4bb9bcbd9` and full validation-matrix self-check `gpu-validation-matrix-ledger:sha256:17f067dcb0fcc40b618fc4d0a0e09e45a2397dcdfd930dffd0e164b5086d3555`. This is arbitrary-project cold-intake hardening only; it does not accept any project without same-process loader, epoch, dispatch, host identity, output oracle, firewall, runtime chain, visual/compute bytes, and strict ledger closure.

2026-07-01 random large arbitrary cold-path runner source-breadth emission follow-up: the random large-project cold-path runner now emits uncapped generic source/build breadth from the actual source listing instead of letting consumers infer breadth from capped sample arrays. `classifySourceListing` records total `buildSignalCount`, `gpuSourceSignalCount`, `sourceRelevantFileCount`, and `sourceOrBuildRelevantFileCount` while keeping path samples capped for artifact size; the same totals are preserved in source-intake evidence, build-metadata discovery, unprofiled refusal results, matrix support facets, matrix source-intake summaries, and row-level fields. Fresh arbitrary-project cold rows can now satisfy the matrix source-breadth gate when their source tree genuinely has enough source/build-relevant files, while asset-heavy rows and old artifacts without total breadth stay candidate-only. Self-checks prove wide listings report totals beyond the 80-path sample cap, local git intake propagates the totals through result evidence, and matrix ingestion preserves the totals through JSON artifact collection. Verification passed `proof:random-large-project:cold:self-check`, matrix smoke `gpu-validation-matrix-ledger:sha256:342a1b90a4e988b90aa0fe3940718a34dda8f299c6b9976efa8305e4414cd8df`, and full validation-matrix self-check `gpu-validation-matrix-ledger:sha256:994723efe2582a0118eecc0661d9905ca0da5dd44e68e83a538f8d281e7da03f`. This is source-intake evidence plumbing only; it remains `acceptedForGpuHmr=false` / `gpuHmrSuccess=false` without loader, epoch, dispatch, host identity, output oracle, visual/compute bytes, firewall, runtime chain, and strict ledger closure.

2026-07-01 random large arbitrary cold-path source-intake/content-identity hardening follow-up: validation-matrix broad readiness now recomputes the random cold source-intake facet before it can count any arbitrary cold row. Qualifying rows must carry `synthi.gpu_hmr.unprofiled_cold_source_intake.v1`, authority `unprofiled_source_tree_intake_only_not_gpu_hmr_success`, accepted source-listing and facet hashes, no blocking gaps, and no GPU HMR/runtime/dispatch authority claims; stale top-level `sourceTreeIntakeAccepted=true` flags are ignored unless the typed facet passes. The broad cold-path predicate also requires a content-only distinctness hash derived from source listing and normalized build-file content bytes, excluding target ID, project/profile names, source URL/path labels, input channel, and commit label, so five relabeled copies of the same source tree cannot satisfy arbitrary-project breadth. Smoke coverage refuses a forged source-intake authority row and five different source labels with the same content-only identity; verification passed `proof:random-large-project:cold:self-check`, matrix smoke `gpu-validation-matrix-ledger:sha256:11d8004255b506cfde895f34a727ce707723296f388da0bd158ccf2689d1d2d4`, and full validation-matrix self-check `gpu-validation-matrix-ledger:sha256:557ac5621594264c7a43148c30f3e0e23146f5aa0d54bbab390673b526d0f6c1`. This is arbitrary-project cold-intake hardening only; it cannot authorize GPU HMR without same-process loader, epoch, dispatch, host identity, output oracle, visual/compute proof bytes, firewall, runtime chain, and strict ledger closure.

2026-07-02 random large arbitrary cold-path freshness follow-up: matrix-computed broad readiness now applies a generic collector-mtime freshness policy before random large cold-path rows can count toward arbitrary-project breadth. The policy binds the row `updatedAt`/collector file mtime to the current matrix `generatedAt`, rejects rows older than the seven-day window or suspiciously newer than the matrix generation time, records `synthi.gpu_hmr.random_cold_path_broad_readiness_freshness_policy.v1`, and adds precise gaps such as `random_cold_path_freshness_row_too_old_for_current_matrix` / `broad_acceptance_requires_fresh_random_large_project_cold_path`. Stale historical/default-root rows remain visible as diagnostic refusal evidence, but they no longer satisfy random-cold broad readiness, source distinctness, plan coverage, or matrix proof counts. Smoke coverage now proves five fresh direct arbitrary cold rows can satisfy the random-cold proof leg, five stale rows count as zero qualifying/candidate rows, and mixed stale/fresh rows count only the fresh subset. Verification passed `proof:random-large-project:cold:self-check`, matrix smoke `gpu-validation-matrix-ledger:sha256:0b638f3072a7e537246e7ecae55e63137e4c93565e45a0ebf6ca4cfb84ff0945`, and full validation-matrix self-check `gpu-validation-matrix-ledger:sha256:dd802764a04183540b9e683d60e0507737c2990c097665e539ae5ade83f45b54`. This is current-run evidence hygiene only: it uses collector-owned timestamps, not project names, target IDs, profile IDs, repository labels, or fixture names, and it cannot authorize GPU HMR without loader, epoch, dispatch, host identity, output oracle, visual/compute bytes, firewall, runtime chain, and strict ledger closure.

2026-07-01 random large arbitrary cold-path finalized-attempt follow-up: matrix-computed broad readiness now requires random large cold-path evidence to come from a finalized, non-dry-run `cold_path_complete` actual attempt before it can count as arbitrary-project cold coverage. Pending manifests, dry-run selections, and preflight-only summary rows can remain diagnostic candidates, but they no longer qualify even if they carry direct source input, immutable commit, source/build breadth, source-content identity, and build metadata evidence. Smoke coverage adds five forged large rows split across pending and dry-run shapes; they leave `randomColdPathRowCount=0`, `randomColdPathCandidateRowCount=0`, and keep broad readiness refused with `broad_acceptance_requires_random_large_project_cold_path`. Verification passed matrix smoke `gpu-validation-matrix-ledger:sha256:d883e2cd8e3a21a36d4530ce004e537324e3e3192f043d72dc5357e195ca2071` and `proof:random-large-project:cold:self-check`. This is user-like cold-intake hardening only; it does not authorize GPU HMR without same-process loader, epoch, dispatch, host identity, output oracle, firewall, runtime chain, visual/compute proof bytes, and strict ledger closure.

2026-07-01 source-first visual broad-readiness identity follow-up: matrix-computed broad readiness now requires at least two distinct source-first visual source identities before source-first visual coverage can support broad library-agnostic generalization. The gate is recomputed from accepted source-first ingestion evidence and direct source identity hashes, not target IDs, fixture names, source basenames, or profile labels. Two visual full-runtime rows that replay the same direct source URL/commit now remain `candidate_only` for source-first coverage and keep broad readiness refused with `broad_acceptance_requires_distinct_source_first_visual_full_runtime_sources`; the positive path still requires strict full-runtime proof, visual output-oracle closure, async visual CAS support, proof-ready worker evidence, native image dependency binding, and support facets with no GPU HMR authority claims. Verification passed matrix smoke `gpu-validation-matrix-ledger:sha256:2db70e5af708489145476c5d3d92b3aa40a33358641b9e466aa4730b890ebd51` and full validation-matrix self-check `gpu-validation-matrix-ledger:sha256:082d1eae8433af35a44ba522e84683e43db84d0426ae1d31bb06dd7d75e36f92`. This is a generic source-first replay-hardening gate, not a project, backend, profile, fixture, or scenario shortcut.

2026-07-01 worker device-role hardening follow-up: worker-side GPU device edit routing no longer treats vendor-default filenames such as `device.hip` or `device.cu` as implicit GPU HMR device roles. `CompileManifest::device_source_filename()` now returns only explicitly declared `module_files.device` paths, and adapted-project edit detection no longer adds magic device filename candidates. A GPU vendor block can still prove compiler/runtime intent, but it cannot prove source identity or authorize a device HMR path without a manifest-declared device role or separately observed device mapping evidence.

2026-07-01 warm-rebuild source-bridge hardening follow-up: deterministic warm rebuilds for generated-include header body edits now require a structural `source_include_bridge` mapping that binds the edited header path, kernel symbol, generated device artifact path, and symbol identity evidence. Device include-graph membership remains useful reachability diagnostics, but it cannot by itself satisfy source projection for GPU HMR acceptance. Missing, wrong-symbol, wrong-generated-path, or identity-free mappings fail closed with `source_include_bridge_symbol_mapping_missing`; qualified and mangled C++ symbol identities are normalized generically instead of relying on fixture names.

2026-07-01 explicit device compile-source follow-up: worker device compilation no longer reads a vendor-default workspace source path when a manifest has a GPU block but no explicit device source role. Split-provided device content must carry either `module_files.device` from the compile manifest or an explicit `device.filename` field, and runner-side dirty-unit metadata now uses observed proof metadata or the declared device role instead of vendor-default filenames. A GPU block with no explicit source identity now skips device compilation as refusal/support evidence rather than inventing `device.hip` or `device.cu`.

2026-07-01 full-runtime authority native-trace gate follow-up: validation-matrix full-runtime evidence authority no longer accepts a strict runtime proof artifact by itself. The matrix now recomputes authority from the accepted strict runtime artifact, recomputed strict ledger, accepted proof chain, explicit compute or visual output-oracle closure, and native/runtime-boundary trace evidence for loader, dispatch, output, and evidence refs. Runtime traces embedded in strict runtime proof artifacts are preserved as evidence input only; empty traces are not serialized into row summaries, and they still cannot authorize GPU HMR without the other strict gates. Smoke coverage adds an adversarial accepted-strict-artifact row with its native loader boundary scrubbed and keeps it refused with `full_runtime_authority_native_runtime_trace_missing` while not reporting a missing strict artifact. Verification passed matrix smoke `gpu-validation-matrix-ledger:sha256:107fdb2e55efd22598a9850e3a3e70fb81090b91c0b10a87b3e6bf9fcf46fa1d` and full validation-matrix self-check `gpu-validation-matrix-ledger:sha256:08f5c75eaa76d62376ada7583baf8c1247bc6314c42d010c67f410e6e29e554e`. This is generic proof-authority hardening, not a project, profile, backend, fixture, target, or scenario shortcut.

2026-07-01 ledger-only native-runtime authority follow-up: validation-matrix native runtime trace evidence now separates ledger boundary presence from independently observed target/runtime evidence. Loader, dispatch, and output boundaries may be proven by runtime traces, runtime-resource traces, backend-native API evidence, accepted target-process adapter/provenance evidence, and accepted compute/visual output-oracle closure; proof-ledger loader/dispatch/output events are used only for consistency checks and no longer count as the observed trace source. Accepted-looking rows that keep a complete strict ledger but remove all observed runtime/native evidence now fail with `native_runtime_trace_cannot_be_ledger_only`, and rows whose observed output boundary conflicts with the ledger fail with `native_runtime_trace_ledger_output_mismatch`. Matrix smoke passed with proof `gpu-validation-matrix-ledger:sha256:d56d7a9046f790c76451752b80aa8e821a64f8479345947ee9887e7ed97de565`. This keeps Flow/HIPRT/OIDN/OpenCL/Vulkan/WebGPU-style visual or compute proof from turning ledger-shaped events into runtime authority; it is not a project-specific success path and still requires same-process loader, epoch, dispatch, host identity, output oracle, firewall, runtime chain, and strict ledger closure.

2026-07-01 external visual state-binding follow-up: external visual-profile proof artifacts now require a matrix-recomputed `synthi.gpu_hmr.external_visual_state_binding.v1` support facet before the artifact can accept. The binding requires a content-addressed visual `camera_state_hash`, a deterministic-mode `seed_policy_hash`, matching camera hashes when both visual artifacts and deterministic mode declare them, and the three recomputed before/after/diff image hashes. The facet is explicitly `acceptedForGpuHmr=false`, `gpuHmrSuccess=false`, `canSatisfyRuntimeProof=false`, and `canSatisfyDispatchProof=false`; it can support external visual audit only, not runtime acceptance. The external-project self-check and matrix smoke now cover accepted binding plus seed/camera binding refusals. This closes another visual-proof shortcut without hardcoding project names, profile IDs, scenes, or target strings.

2026-07-01 visual convergence frame-evidence hardening follow-up: deterministic visual convergence proof now requires actual frame/image-hash evidence instead of accepting a declared `sample_count`. Convergence samples that carry `artifact_hash` are refused with `convergence_window_artifact_hash_not_frame_evidence`, and strict ledger plus matrix runtime visual rows pass the changed GPU artifact hash into deterministic-mode evaluation so a runtime artifact hash cannot masquerade as a frame hash. HIPRT warm visual proof now emits `frame_hash` samples and frame-hash lists only. Visual smoke passed with declared-count-only, artifact-hash, and runtime-artifact/frame-hash collision refusals; matrix smoke passed with proof `gpu-validation-matrix-ledger:sha256:b396ab7bc76de82cca8a298554640c74d4f9b729f62644a1485dbf4a53074d11`; `proof:hiprt:runtime-boundary:self-check` passed with runtime proof `gpu-runtime-proof:sha256:277098c003fc817c125a3f181b1e26b2ca52c0ce09420fd788e610f86d771617`. This is generic HIPRT/Flow/Vulkan/WebGPU-style visual-proof hardening, not a project-specific branch and not acceptance by visual declaration alone.

2026-07-01 generic visual/cold-path hardening follow-up: strict visual ledger evaluation now requires visual oracle artifacts to carry a valid SHA-256 `camera_state_hash`, and when a deterministic visual mode, state-preservation contract, or HIPRT contract declares a camera hash, the visual artifact hash must match it. Matrix smoke now includes a forged visual camera-state mismatch that fails closed with `visual_camera_state_hash_mismatch`, while valid visual-CAS fixtures derive their camera hash from the ledger record instead of a target string. Separately, source-first/Flow run-mode proof now merges deterministic visual profile defaults before observed MCP frame evidence, so profile-declared fields cannot override observed post-epoch frame-capture and frame-boundary facts; the agent-split self-check injects a forged profile override and proves observed frame evidence wins. These are generic visual-proof gates, not scenario shortcuts. Smoke proof: `gpu-validation-matrix-ledger:sha256:2c966f9416503a270bb10d1edf00f2414a2ca8840a204870f0011543f20120a5`; agent-split self-check passed.

2026-07-01 strict visual CAS locator hardening follow-up: strict runtime proof artifacts can now evaluate visual-only before/after/diff oracle bytes through role-bound `synthi.cas.artifact_locator.v1` manifests when direct image paths are absent. The strict gate resolves only readable bytes under allowed visual artifact/CAS roots or the hash-derived `sha256/<prefix>/<digest>` path, then verifies schema, role, media/kind, byte length, artifact ID, content hash, `synthi-cas://.../sha256/<digest>` URI binding, manifest hash, PNG structure/dimensions, and absence of GPU HMR authority claims before constructing a transport-only visual overlay for ledger recomputation. The artifact-level `proofLedgerQuery` must still match the overlay-aware recomputed query; stale, rejected, or forged supplied queries fail with the normal strict proof gates. Duplicate, wrong-schema, or success-claiming CAS-shaped locators under visual oracle artifacts are audited before dedupe so a valid locator cannot hide declaration-based success. CAS locators remain `acceptedForGpuHmr=false`, `gpuHmrSuccess=false`, and `proofAuthority=transport_integrity_only`; they cannot authorize GPU HMR without same-process loader, epoch, dispatch, host identity, output oracle, firewall, and strict ledger closure. Verification passed `proof:strict-gates:self-check`, random large-project cold-path self-check, matrix smoke `gpu-validation-matrix-ledger:sha256:0509c8b8a959b09f87269a13312785c07bbf33b8a8e08cf3eb7643830beed0b9`, and full validation-matrix self-check `gpu-validation-matrix-ledger:sha256:940ff7175d522e1a8a0b0d247cde0cdbf4f5f8f82e56c271f422adbe1a1d51f9`. This is generic visual oracle transport hardening, not a project, profile, backend, fixture, or scenario shortcut.

2026-07-01 random large arbitrary cold-path immutable-source identity follow-up: broad readiness now de-duplicates random cold-path rows by a matrix-recomputed immutable source identity derived from accepted direct input evidence, source URL or local repo path, immutable commit, candidate source, and source kind. Direct-input identity remains channel-bound for tamper detection, while source-content identity from source listing hash, source-intake facet hash, and build-metadata content hash is retained as support detail only. Broad-readiness distinctness no longer inflates when the same repo and commit are submitted through different CLI/env channels or through forged varied listing/build-content hashes. Smoke coverage proves five rows for the same source with different supplied content identities keep `randomColdPathRowCount=5`, `randomColdPathDistinctSourceIdentityCount=1`, and `randomColdPathDistinctSourceContentIdentityCount=5`, then remain refused with `broad_acceptance_requires_distinct_random_large_project_cold_sources`. This is arbitrary-project intake hardening only; cold-path rows remain `gpuHmrSuccess=false` and `acceptedForGpuHmr=false` until same-process loader, epoch, dispatch, host identity, visual/compute output oracle, firewall, and strict ledger closure pass.

2026-07-01 random large arbitrary cold-path multi-result ingestion follow-up: validation-matrix ingestion now expands a retained `synthi.gpu_hmr.random_large_project_cold_path.v1` manifest into one row per selected result instead of silently preserving only the first matching result. Raw extra result entries whose candidate ID is not in the manifest selection are still surfaced in invalidated-row audit mode and fail with `random_large_project_cold_path_result_not_selected`, so malformed manifests cannot hide evidence and cannot help broad readiness. Smoke coverage writes a single multi-result arbitrary-project cold manifest, proves the default matrix retains all selected refusal-only rows, and proves the unselected extra row is visible only as safety-invalidated audit evidence. This is generic manifest ingestion hardening, not project-name acceptance and not GPU HMR proof without loader, epoch, dispatch, host identity, output oracle, firewall, and strict ledger closure.

2026-07-01 random large arbitrary cold-path direct-source entrypoint follow-up: the package-level `proof:random-large-project:cold` command now requires direct user source identity (`--source-url` or `--repo-path` plus `--commit`, or equivalent env) through the same `synthi.gpu_hmr.random_cold_path_direct_source_input.v1` evidence shape that broad readiness consumes. The configured pool remains available only through the explicit diagnostic `proof:random-large-project:cold:sample-pool` / sample-pool dry-run path. The runner self-check rejects missing direct-source input in readiness mode, proves sample-pool bypass remains explicit, proves multi-result manifests preserve one result per selected candidate, and the CLI now reports `sourceMode=direct_user_source` or `configured_sample_pool`. This prevents curated sample candidates from being mistaken for arbitrary-user cold-path evidence without hardcoding a repository, backend, target, or project name.

2026-07-01 random large arbitrary-project cold-path refresh: five additional direct source URL+commit cold-path runs were regenerated through the current generic runner identity contract, not through project-name branches. Fresh retained manifests are `direct-wgpu-current-identity-20260701` (`sha256:6bd00b1cc21e1761467e3d6c4739261e7b9212f2b518d98380633c29770effa8`, 2445 files, 35,885,065 bytes), `direct-bevy-current-identity-20260701` (`sha256:823962d9d61c179d3a17c26964cdac0f504e58e304ead693cc2a4e3d754ad2a1`, 2908 files, 86,666,816 bytes), `direct-llama-cpp-current-identity-20260701` (`sha256:0e9e4f3c7fa3e9592dbb99cc131e11bf36be77f52c2db3d5afff04a0605a4544`, 3011 files, 154,991,455 bytes), `direct-vulkan-samples-current-identity-20260701` (`sha256:08fa4583208afbebc44d0f58256affc2a85283f71ca3e040b521fb65b041630e`, 2226 files, 83,464,705 bytes), and `direct-filament-current-identity-20260701` (`sha256:0c72024679ffe56981f8ac68ba632367e4fe00de86be2b6aa258740724452799`, 29,701 files, 1,189,859,062 bytes). Together with the direct-local commit snapshot row, collected matrix recompute `gpu-validation-matrix-ledger:sha256:4f34a0e2d4eabfdddbde72acc43eec6ff1c00b2ee73e8eedb9040d6d5b54ee12` now reports `randomColdPathRowCount=6`, `randomColdPathDistinctSourceIdentityCount=6`, `randomColdPathCandidateRowCount=7`, and broad readiness still `accepted=false` with the remaining gaps `matrix_level_broad_generalization_proof_not_present`, `broad_runtime_rows_missing`, and `broad_acceptance_requires_more_backend_families`. Every refreshed cold-path row remains `unprofiled_arbitrary_project_cold_intake_refused`, `gpuHmrSuccess=false`, and `acceptedForGpuHmr=false`; source intake, build metadata content, and runtime-boundary template evidence are support-only and cannot satisfy loader, epoch, dispatch, host identity, output oracle, visual/compute proof, firewall, or strict ledger closure.

2026-07-01 direct-local arbitrary cold-path commit-snapshot follow-up: random large-project cold intake now treats a user-supplied local repo path plus immutable commit as a commit-tree source snapshot, even when the checkout has unrelated dirty/untracked files. The runner records `sourceSnapshotMode=immutable_git_commit_tree`, `dirtyWorktreeObserved=true`, `worktreeContentConsumed=false`, enumerates bytes through `git ls-tree <commit>`, and verifies build metadata through `git show <commit>:<path>` with transport `local_git_commit_snapshot_show`. Matrix direct-source identity recomputation now accepts `localRepoPath` / `local_repo_path` as the generic local-repo identity field and still requires the non-authoritative direct-input evidence authority `runner_cli_env_direct_source_input_only_not_gpu_hmr_success`, source-derived backend candidates, accepted source-tree intake, build metadata content hashes, runtime-boundary template support, and no GPU HMR/runtime/dispatch authority claims. The live direct-local run against commit `4ee95c72f269009114ad970bd103fd43e05fb23e` retained manifest `sha256:62ae9ff313b96e917db0b11dc0bff5d7de3f176779584da17afa5aa9f690e61d`, counted 3161 committed files and 90,486,992 known bytes, observed backend candidates `cuda`, `hip_rocm`, `opencl`, `vulkan`, and `webgpu_wgsl`, and correctly stayed `unprofiled_arbitrary_project_cold_intake_refused` with `gpuHmrSuccess=false` and `acceptedForGpuHmr=false`. The collected matrix recompute `gpu-validation-matrix-ledger:sha256:dfe85cee86a0ac92e64703e14957dac1904e67d6c7bdf8c1fbaad97e079fee1d` now retains one random direct-local cold-path row and keeps broad readiness false with `broad_acceptance_requires_more_backend_families` and `broad_acceptance_requires_more_random_large_project_cold_paths`. This is arbitrary-project cold-path intake coverage only, not project-name acceptance and not GPU HMR success without same-process loader, epoch publication, dispatch trace, host identity, output oracle, visual/compute proof, firewall, and strict ledger closure.

2026-07-01 collected-matrix stale-row invalidation follow-up: validation-matrix collection now omits safety-invalidated selected rows by default, while strict direct `queryGpuHmrValidationMatrixLedger` still rejects those rows when supplied and `includeUnproven` / `includeInvalidated` audit modes still expose them. The builder reports `omittedInvalidatedRows` / `omitted_invalidated_rows` so stale retained artifacts that predate newer direct-source identity or output-oracle gates cannot poison the current matrix and also cannot count as broad proof. Smoke coverage pairs a strict visual runtime row missing the required output-oracle facet with a random cold-path row carrying a forged direct-source identity role; direct query rejects both, while default matrix build omits them and remains accepted. Full collected self-check now passes with current retained artifacts, proof `gpu-validation-matrix-ledger:sha256:8f181295b61eb1b7d30dd6efcaced4fd93f6ca9d9f0b635e54c1ca14db2a4d64`, rowCount=96, accepted full-runtime rows=14, broad readiness still `accepted=false`, and omitted stale safety-invalid rows excluded from current proof. This is fail-closed stale-artifact handling, not a success shortcut.

2026-07-01 latest-attempt visibility follow-up: validation-matrix attempt history now recomputes latest-attempt counts even when detailed unproven-row history is disabled. Normal matrix summaries keep `attemptHistory.enabled=false` and omit detailed row refs, but still record `latestAttemptCount`, `latestUnselectedAttemptCount`, `latestUnselectedAttemptWarning=true`, and warning gap `latest_attempt_unselected_by_priority_selection` when priority/completeness selection keeps an older stronger row over a newer weaker artifact for the same attempt key. `includeUnproven` still exposes full latest/selected row refs for audit. This prevents real-user rerun regressions from being invisible in ordinary matrix output while preserving fail-closed proof semantics and not turning stale-selection warnings into GPU HMR acceptance.

2026-07-01 latest-attempt broad-readiness blocking follow-up: broad-library readiness now consumes the matrix attempt-history freshness counts and keeps readiness refused when `latestUnselectedAttemptWarning=true`, even if priority selection keeps an older stronger row for the same generic attempt key. The summary records `latestAttemptUnselectedBlocksReadiness=true`, carries `latestUnselectedAttemptCount`, and adds the open gap `latest_attempt_unselected_by_priority_selection`; the lower-level broad matrix proof remains audit/generalization evidence, but readiness cannot look current while a newer weak/refusal rerun is present. Smoke coverage exercises both the real ROCm completeness-selection fixture and a broad-readiness portfolio with a newer unproven rerun sharing the same attempt key, without depending on project names, target strings, fixture names, or repository identities. Verification passed matrix smoke `gpu-validation-matrix-ledger:sha256:7a328c603e94737179790a3431ce9509dd19a9538df34d7feee779d96472de47` and packaged full validation-matrix self-check `gpu-validation-matrix-ledger:sha256:ee27212a725bc3f1ab55b0f06afcd038b57b5a579fd68eefc27aef370b9ee6ae`. This closes a stale-rerun overclaim path without changing the required loader, epoch, dispatch, host identity, output oracle, firewall, runtime chain, visual/compute bytes, or strict ledger gates for any arbitrary user project.

2026-07-01 source-first direct-source identity hardening: validation-matrix source-first visual broad readiness now requires a direct-source identity facet whenever `sourceAuthority` claims `direct_source_url_commit` or `direct_local_git_repo_path`. The identity evidence reuses the generic `synthi.gpu_hmr.random_cold_path_direct_source_input.v1` shape, is recomputed against source URL or local repo path, immutable commit, candidate source/source kind, and CLI/env channels, and must remain target-name-independent with empty project/target whitelists and no GPU HMR/runtime authority. Workspace/user-file source-first rows remain bound by source content hash, source-purity manifest, and initial manifest hashes instead of being forced through a remote URL. Broad proof and readiness summaries now report `sourceFirstVisualSourceIdentityCount` and source identity hashes, and smoke coverage proves that a strict visual runtime row with a direct-source label but no identity facet no longer counts for `source_first_uncompiled_project_validation` or broad readiness. Smoke proof: `gpu-validation-matrix-ledger:sha256:d1e58c940b35e029f20ea002c8bce42b6e63f495a3e78f9b9d18ee1e24c78d44`. This prevents a declared direct-source label, target name, fixture, or scenario string from substituting for arbitrary user source evidence.

2026-07-01 source-first explicit-source coverage follow-up: `source_first_uncompiled_project_validation` plan coverage now uses the same explicit user-source selector as source-first visual broad readiness. The accepted source authorities are `direct_source_url_commit`, `direct_local_git_repo_path`, `user_source_files`, and `workspace_source_files`; `profile_source_files`, `builtin_fixture_source`, and the ambiguous default `cli_or_env_direct_source` no longer count for either source-first plan coverage or broad visual readiness. Direct URL/local-git rows still require recomputed immutable source identity evidence, while user/workspace file rows remain bound by source content, source-purity, initial manifest, generated artifact, sidecar, compile-manifest, visual/CAS, output-oracle, and strict runtime ledger evidence. Smoke proof: `gpu-validation-matrix-ledger:sha256:cc94e7866cf5db7d9b0614cf201bb73639fe79daf9cbac51740493fc5c51c0fe`; packaged self-check proof: `gpu-validation-matrix-ledger:sha256:84e7a25aafccb4c3eb33b3b472ea034d8a14fc8ae2c4260281b3be7bd5ac8fcb`. This prevents fixture/profile source rows or vague CLI/env source labels from making the user-facing source-first milestone look complete.

2026-07-01 random cold-path distinct-source hardening: validation-matrix broad readiness now requires the random large arbitrary-project cold lane to contain at least five distinct immutable source identity hashes, not merely five qualifying rows. The identity hash is recomputed from the direct source URL or local repo path, immutable commit, candidate source, and source kind, without target ID, profile ID, CLI/env channel, source listing hash, source-intake hash, or build-content hash. Broad proof and readiness summaries still report `randomColdPathDistinctSourceContentIdentity*` fields for audit, but only `randomColdPathDistinctSourceIdentityCount` gates distinct arbitrary sources. A smoke matrix with five target IDs replaying the same source URL and commit keeps `randomColdPathRowCount=5` but closes broad readiness with `randomColdPathDistinctSourceIdentityCount=1` and `broad_acceptance_requires_distinct_random_large_project_cold_sources`. This prevents repeated rows from one project, fixture, scenario, or forged content-identity variant from masquerading as broad arbitrary-user cold-path coverage.

2026-07-01 source-first coverage output-oracle closure follow-up: the `source_first_uncompiled_project_validation` plan coverage entry now uses the same output-oracle facet requirement as broad source-first visual readiness. Source-first rows no longer count for plan coverage merely because source-first ingestion, strict runtime proof, async visual/CAS support, and visual artifacts are accepted; they must also expose the normalized visual output-oracle facet derived from matrix-recomputed visual evidence. Smoke proof: `gpu-validation-matrix-ledger:sha256:2a5eb0642731a98a0f9cbfaa5a0924a1ef0037fbba9d3c9aa66f28dcb869c7f3`. This keeps the user-facing source-first milestone aligned with the arbitrary-project acceptance rule: output proof is a required closure gate, not an optional coverage decoration.

2026-07-01 full-runtime output-oracle row-safety boundary: validation-matrix row safety now rejects any accepted GPU HMR row that lacks an accepted, kind-correct output-oracle closure. Agent-split visual run-mode rows derive a normalized `outputOracleFacet.kind=visual_oracle` only from matrix-recomputed visual artifacts, with `acceptedForGpuHmr=false`, `gpuHmrSuccess=false`, and `canSatisfyRuntimeProof=false` on the facet itself. Removing that facet from otherwise accepted source-first visual rows now makes the matrix query invalid with `gpu_hmr_success_requires_accepted_output_oracle_facet`, instead of merely excluding the rows from broad readiness. Smoke proof: `gpu-validation-matrix-ledger:sha256:0fe5518698f5fd462127d9db7278ff3dd26afa5f1d44121cf708e070619fbbca`. This preserves the rule that visual/readback proof is mandatory ledger evidence, not a UI label or serialized success shortcut.

2026-07-01 source-first visual replay-input boundary: source-first visual broad-readiness now recomputes async visual/CAS support from replayable row inputs instead of trusting a serialized `asyncVisualCasBundle` claim. Agent-split run-mode matrix rows preserve the raw visual artifact set and async visual proof-job manifest as non-authoritative replay inputs, then broad readiness reruns the shared async visual support classifier against matrix visual evidence. A forged row that keeps an accepted-looking async visual support facet but strips the raw visual/CAS inputs now contributes zero source-first visual rows and leaves broad readiness refused with the normal source-first visual gap. Smoke proof: `gpu-validation-matrix-ledger:sha256:42e760c50da12e6d563542dead37ad3632d9ec2befc910f3553af706d815c00b`. This keeps visual proof project-agnostic: CAS locators, proof-ready events, worker identity, native image dependency binding, worker CAS input, tile/ROI bindings, and matrix-recomputed image hashes must remain recomputable before source-first visual coverage can support broad matrix generalization.

2026-07-01 broad-readiness row-scope boundary: validation-matrix broad readiness now separates aggregate generalization proof from row-local broad acceptance. Scoped strict runtime rows can contribute to `matrixGeneralizationRuntimeRows` in `synthi.gpu_hmr.broad_library_agnostic_matrix_proof.v1`, but they are no longer rewritten into broad full-runtime rows. The latest retained matrix is `gpu-validation-matrix-ledger:sha256:70a59fb470f0b433993ec70cc699a3cb47efdfda0cf3d81c1185df9e09225e59`, JSON `mcp/synthi-mcp/.gpu-hmr-test-logs/validation-matrix/gpu-hmr-validation-matrix-20260701T095015Z.json`, with 114 rows, 19 accepted full-runtime GPU HMR, 0 broad library-agnostic full-runtime GPU HMR, 19 scoped full-runtime GPU HMR, 19 all full-runtime, 74 refusals, 8 cold splits, 2 deterministic fission rows, 3 visual profiles, 8 preflight-only rows, and 0 included unproven rows. Scope breakdown remains `generated_rocm_hip_preview_visual: 4`, `hip_module_declared_compute_readback: 2`, `opencl_declared_compute_readback: 2`, `vulkan_declared_pipeline_visual: 1`, `webgpu_declared_compute_readback: 2`, and `webgpu_declared_pipeline_visual: 8`; `per_target_run_modes status=accepted`. At this historical checkpoint the aggregate broad proof accepted with proof `gpu-hmr-broad-library-agnostic-proof:sha256:c2c76ea4ef18f7a8c22b98b4740173c801a29589c51401d1d74b19edab554ea2`, `broadRuntimeRows=0`, `broadRuntimeRowsMissing=false`, `rowLocalBroadRuntimeRowsMissing=true`, `scopedRuntimeRows=19`, `matrixGeneralizationRuntimeRows=19`, five direct large arbitrary cold-path rows, two direct/user-owned source-first visual rows, and no aggregate open gaps; the follow-up row-local gate below now keeps readiness itself refused until a row-local broad full-runtime proof exists. The broad proof carries both target-name-independent selection predicates: random cold path `synthi.gpu_hmr.random_cold_path_broad_readiness_predicate.v1` / `sha256:a184d8c93a3ec1ec35957e7aa2982c536a346a15c16322955294da4660dcde89`, and source-first visual `synthi.gpu_hmr.source_first_visual_broad_readiness_predicate.v1` / `sha256:6b31a1b7e1d17ca9344e551f72d30441727398a424518f91aa5d6fb60c1b9165` with authority `matrix_static_source_first_visual_predicate_not_project_name_whitelist`, empty project/target whitelists, and ignored target/profile/fixture/project/source-basename fields. This is aggregate readiness evidence only; it does not mean Filament, Vulkan-Samples, wgpu, Bevy, llama.cpp, MIOpen, CK, hipBLASLt, HIPRT no-shim apps, CUDA, or any arbitrary user project is accepted without its own same-process loader, epoch, dispatch, host identity, output oracle, firewall, and strict proof-ledger closure.

2026-07-01 broad-readiness row-local proof follow-up: `synthi.gpu_hmr.broad_library_agnostic_readiness.v1` no longer reports `accepted=true` solely because the aggregate `broad_library_agnostic_matrix_proof` accepts over scoped strict rows. The readiness object now records `matrixGeneralizationAccepted=true` for that portfolio-level evidence but keeps `accepted=false`, `rowLocalBroadRuntimeProofRequired=true`, and open gap `row_local_broad_runtime_rows_missing` until at least one row-local broad-library full-runtime proof exists. Matrix smoke and collected self-checks now pass with aggregate proof accepted, row-local broad runtime rows still zero, and readiness refused. This prevents matrix-level generalization evidence from being misread as arbitrary-project GPU HMR acceptance.

2026-07-01 strict visual-proof byte authority follow-up: strict runtime proof artifacts now refuse visual-oracle ledgers that provide only descriptor paths or sha-shaped strings. The strict gate resolves before/after/diff visual artifacts only under allowed repo/MCP/artifact roots, reads the actual bytes, recomputes SHA-256 for each role, and fails closed with role-specific unreadable or hash-mismatch gates when bytes are missing or forged. Validation-matrix ingestion passes only generic artifact roots derived from the row file, repo root, and MCP root; no target, profile, backend, or project name can authorize the bytes. The strict-gate self-check now proves a byte-backed positive path, descriptor-only refusal, and readable-hash-mismatch refusal, and the validation-matrix smoke fixtures were updated so rows that claim visual proof carry real byte-backed artifacts. Verified commands: `node mcp/synthi-mcp/scripts/gpu-hmr-proof-strict-gates-self-check.mjs`, `node mcp/synthi-mcp/scripts/tests/gpu-hmr-validation-matrix-ledger-smoke.mjs`, `npm --prefix mcp/synthi-mcp run proof:random-large-project:cold:self-check`, and `npm --prefix mcp/synthi-mcp run proof:validation-matrix:self-check`. This keeps visual proof machine-verifiable and project-agnostic; it is still not GPU HMR acceptance without same-process loader, epoch publication, dispatch trace, host identity, output-oracle closure, firewall, and strict ledger success.

2026-07-01 strict visual-proof PNG structure follow-up: the byte-backed strict visual gate now also requires the matched before/after/diff artifacts to be PNG-structured images with a valid signature, IHDR chunk, positive dimensions, accepted bit depth/color type, and valid compression/filter/interlace fields. A readable file whose declared hash matches but whose bytes are not a PNG now fails with `visual_oracle_<role>_image_png_invalid`. The strict-gate self-check generates real PNGs for the positive path and adds a hash-matched invalid-image refusal. Verified commands: `node --check mcp/synthi-mcp/scripts/lib/gpu-hmr-proof-strict-gates.mjs`, `node --check mcp/synthi-mcp/scripts/gpu-hmr-proof-strict-gates-self-check.mjs`, `node mcp/synthi-mcp/scripts/gpu-hmr-proof-strict-gates-self-check.mjs`, `node mcp/synthi-mcp/scripts/tests/gpu-hmr-validation-matrix-ledger-smoke.mjs`, `npm --prefix mcp/synthi-mcp run proof:random-large-project:cold:self-check`, and `npm --prefix mcp/synthi-mcp run proof:validation-matrix:self-check`. This is generic image-shape hardening only; PNG validity still remains one gate inside the larger visual oracle and proof-ledger closure.

2026-07-01 strict visual-proof PNG chunk/dimension follow-up: the strict visual gate now scans the full PNG chunk stream for before/after/diff visual oracle artifacts, requires valid chunk bounds, valid CRCs, at least one IDAT, terminal IEND, and no trailing bytes after IEND, and binds declared `swapchain_size` / dimension metadata to the actual IHDR width and height. A hash-matched corrupt PNG fails with `visual_oracle_<role>_image_png_invalid`, and a byte-valid image with false declared dimensions fails with `visual_oracle_<role>_image_dimensions_mismatch`. Strict runtime artifact batch evaluation now preserves caller-provided visual artifact roots, so arbitrary project rows validate bytes from the row/repo/MCP evidence context instead of only module defaults. Matrix smoke visual fixtures now derive declared dimensions from actual PNG bytes rather than stale fixture constants. Verified commands: `node mcp/synthi-mcp/scripts/gpu-hmr-proof-strict-gates-self-check.mjs`, `node mcp/synthi-mcp/scripts/tests/gpu-hmr-validation-matrix-ledger-smoke.mjs` (`gpu-validation-matrix-ledger:sha256:b39df75118d3ccd36b569b2dff9ca421269f21a35df95ea0a118b9975896fe4d`, 68 rows inside the packaged run), `npm --prefix mcp/synthi-mcp run proof:random-large-project:cold:self-check`, and `npm --prefix mcp/synthi-mcp run proof:validation-matrix:self-check` (`gpu-validation-matrix-ledger:sha256:8a5f59d10a81a7b605e6e612a11984d1d05a23d1062a62f52e66b2ed37d466e5`, 101 rows, 10 scoped full-runtime rows, 6 random cold-path source identities, broad readiness still `accepted=false` because row-local broad runtime proof is still absent). This is generic visual byte/metadata integrity hardening, not project-name acceptance and not GPU HMR success without same-process loader, epoch, dispatch, host identity, output-oracle, firewall, and strict ledger closure.

2026-07-01 strict visual-proof role-separation follow-up: strict visual ledger evaluation now records the byte-verified hash for each accepted before/after/diff role and refuses duplicate role content after individual readability, hash, PNG, and dimension checks pass. Reusing the before image as the after image fails with `visual_oracle_before_after_image_hashes_not_distinct`, and reusing either frame as the diff image fails with `visual_oracle_diff_image_hash_not_distinct`. This closes a fake visual-proof path where one valid PNG or CAS-resolved byte object could be assigned to multiple oracle roles while still satisfying per-role hash checks. Verification passed `node mcp/synthi-mcp/scripts/gpu-hmr-proof-strict-gates-self-check.mjs`, matrix smoke `gpu-validation-matrix-ledger:sha256:271fad41a2fe87559f4b60895bdfef11f3ab25b848fec7c9a32a5b66c69e5aa6`, and packaged full validation-matrix self-check `gpu-validation-matrix-ledger:sha256:ee27212a725bc3f1ab55b0f06afcd038b57b5a579fd68eefc27aef370b9ee6ae`. This is project-agnostic visual oracle byte-role hardening only; it cannot authorize GPU HMR without the usual loader, epoch, dispatch, host identity, output oracle, firewall, runtime chain, and strict ledger closure.

2026-07-01 source-first visual support-authority boundary: source-first visual broad-readiness selection now rejects support evidence that tries to claim GPU HMR success, runtime proof authority, or dispatch proof authority. The async visual/CAS support facet emits explicit `canSatisfyRuntimeProof=false` and `canSatisfyDispatchProof=false`, and broad-readiness selection requires both source-first ingestion and async visual support to remain authority-neutral. Matrix smoke coverage forges runtime/dispatch authority on async visual support; the matrix query remains valid as an audit artifact, but broad readiness closes with `sourceFirstVisualRowCount=0` and `broad_acceptance_requires_source_first_visual_full_runtime_row`. Smoke proof: `gpu-validation-matrix-ledger:sha256:be52ea90a57d057410b29225e95a71c2c825e5738ac29f4b5084e20da758040b`. This keeps visual proof support from becoming an undeclared runtime-proof shortcut.

2026-07-01 source-first visual output-oracle boundary: source-first visual broad-readiness selection now requires an accepted `outputOracleFacet` with `kind=visual_oracle`; accepted visual pixels, async visual/CAS support, and strict runtime visual authority are not enough when the output-oracle facet is absent. Matrix smoke coverage removes the output-oracle facet from otherwise accepted source-first visual rows; broad readiness closes with `sourceFirstVisualRowCount=0` and `broad_acceptance_requires_source_first_visual_full_runtime_row`. Smoke proof: `gpu-validation-matrix-ledger:sha256:11e4b1b306b99c676b6355596e3775bbbe302bff8430d8f6f15b2df31249520e`. This keeps screenshots, frame diffs, and runtime visual flags from bypassing ledger-bound output-oracle closure.

2026-07-01 source-first visual schema boundary: source-first visual broad-readiness selection now requires the typed `synthi.gpu.hmr.agent_split_source_first_ingestion.v1` schema directly, matching the retained predicate's `requiredSourceFirstEvidenceSchema`. Matrix smoke coverage forges a success-shaped source-first object under a wrong schema; broad readiness closes with `sourceFirstVisualRowCount=0` and `broad_acceptance_requires_source_first_visual_full_runtime_row`. Smoke proof: `gpu-validation-matrix-ledger:sha256:3e32c47b1f25057ad10055b975cfdb51393cb120d55ad6db1eab9f057a927d06`. This prevents accepted-looking serialized source-first fields from satisfying broad readiness outside the typed source-first contract.

2026-07-01 source-first visual full-runtime authority boundary: validation-matrix recomputation now emits `fullRuntimeEvidenceAuthority` with schema `synthi.gpu_hmr.full_runtime_evidence_authority.v1` and proof authority `matrix_recomputed_full_runtime_evidence_authority_not_row_declared`. Source-first visual broad-readiness selection and source-first coverage require that schema, proof authority, and `authority=strict_runtime_proof_artifact` before a row can count toward aggregate arbitrary-user visual readiness. The retained predicate records `requiredFullRuntimeEvidenceAuthoritySchema`, `requiredFullRuntimeEvidenceAuthority`, `requiredFullRuntimeAuthoritySource`, and `full_runtime_evidence_authority_schema_accepted`. Smoke proof: `gpu-validation-matrix-ledger:sha256:ad34ad8676ad3831e197aa1264ac8d9d36299bdabc7d5036c5450ecf0fda695a`; post-patch source-first visual predicate hash for new recomputes is `sha256:ef2698dcccb9fd4d1a52dd7a15bb22672dc238e6140e276a6f2da5d6cee8467a`. This prevents a success-shaped boolean runtime-authority facet from becoming a hidden broad-readiness shortcut.

2026-07-01 source-first visual selector recomputation boundary: source-first visual broad-readiness selection now recomputes the typed `synthi.gpu.hmr.agent_split_source_first_ingestion.v1` facet instead of trusting serialized `row.sourceFirstIngestion.accepted` fields. A row must recompute its source-first proof id, source/manifest/purity hashes, generated artifact namespace, sidecar and compile-manifest hashes, target binding, and support-only authority before it can count toward arbitrary-user visual readiness. Smoke coverage forges only the source-first proof id on otherwise accepted-looking visual rows; broad readiness stays closed with `sourceFirstVisualRowCount=0` and `broad_acceptance_requires_source_first_visual_full_runtime_row`. Latest observed smoke proof: `gpu-validation-matrix-ledger:sha256:410899a8fc164edb5fad30c250dc0050270d93215c811095105e8588556052d5`. This blocks declaration-only source-first visual broad proof.

2026-07-01 source-first visual coverage boundary: the `source_first_uncompiled_project_validation` plan coverage entry now reuses the hardened source-first visual selector family instead of a looser compute/output fallback or profile/fixture inventory path. Coverage requires explicit user-source authority, typed source-first ingestion, support-only async visual/CAS evidence, accepted visual artifacts, schema-bound matrix-recomputed full-runtime authority, `authority=strict_runtime_proof_artifact`, accepted visual output-oracle closure, and strict runtime visual authority. Latest observed smoke proof before the explicit-source tightening was `gpu-validation-matrix-ledger:sha256:07cedbe5bf03bd91a747a0b47388012966dc72d9be207c85049a60b032dbf954`; the current explicit-source smoke proof is `gpu-validation-matrix-ledger:sha256:cc94e7866cf5db7d9b0614cf201bb73639fe79daf9cbac51740493fc5c51c0fe`. This prevents plan coverage/status docs from overcounting source-first validation through a non-visual, boolean-only, fixture-backed, profile-backed, or ambiguous CLI/env source path.

2026-07-01 random cold-path coverage boundary: the `random_large_arbitrary_project_cold_path` plan coverage entry now reports `refused` only for rows that satisfy the same direct large arbitrary-project cold selector used by broad readiness. Sub-threshold direct rows report `candidate_only`; configured-pool, profile-backed, or otherwise non-qualifying refusals report `diagnostic_only`; preflight-only rows remain `preflight_only`. The entry now records `qualifyingRowCount` and `candidateRowCount` separately from total refusal/preflight counts. Latest observed smoke proof: `gpu-validation-matrix-ledger:sha256:a57bfada39801c07ce1f4ca2fe43bc04e8aa6138a5335ee2398d562a8ae40d47`. This keeps plan coverage from presenting configured-pool or project-profile cold failures as arbitrary-user large-project cold-path validation.

2026-07-01 random cold direct-source identity binding: `synthi.gpu_hmr.random_cold_path_direct_source_input.v1` evidence now uses `sourceIdentityRole=source_identity_hash_bound_to_direct_input_not_whitelist`. The random cold-path runner hashes the direct source URL or local repo path, immutable commit, candidate source, source kind, and CLI/env input channels. Validation-matrix ingestion and broad-readiness selection recompute that hash from the row's own source identity; replayed direct-input evidence from a different arbitrary project now fails with `random_cold_direct_input_source_identity_hash_mismatch` and contributes zero random cold-path rows. Latest observed smoke proof: `gpu-validation-matrix-ledger:sha256:d070b083d0f5c606fa8f93b18504f5354708b11e106ae8ef2f1715c46434fe77`. This binds user-style cold-path evidence to the current arbitrary source without adding a project-name whitelist.

2026-07-01 broad proof oracle-kind boundary: broad-readiness compute coverage now requires `outputOracleFacet.kind=compute_oracle` or an explicit compute-card proof flag backed by accepted `computeCardEvidence` and `visual.evidenceKind=compute_card_not_runtime_visual_oracle`. Accepted visual output-oracle facets and standalone serialized `computeCardOnlyProofAccepted=true` flags no longer satisfy compute coverage. Smoke coverage builds a visual-only HIP/WebGPU/OpenCL/Vulkan matrix that otherwise satisfies the broad proof shape; broad readiness stays closed with `computeOracleTargetCount=0` and `broad_acceptance_requires_compute_oracle_rows`, including when the visual rows forge the compute-card-only flag without accepted compute-card evidence. Latest observed smoke proof: `gpu-validation-matrix-ledger:sha256:fa36006432a4e4b829f97f4c0705fd62a8f877877fbbd80336d8e8843102eecf`. This prevents visual proof or forged compute-card booleans from being double-counted as compute proof in the aggregate library-agnostic readiness claim.

2026-07-01 HIPRT/OIDN plan-coverage diagnostic boundary: validation-matrix plan coverage now separates "evidence exists but is not acceptance" from "missing evidence" for source-adapted HIPRT visual profiles and OIDN/HIP runtime preflights. HIPRT source-adapted visual rows may report `hiprt_visual_path=visual_profile_only` and `hiprt_run_modes=visual_profile_partial`, and schema-correct OIDN/HIP runtime-preflight failures may report `oidn_hip_runtime_preflight=refused`. These statuses are diagnostic only: the entries keep `acceptedForGpuHmr=false`, `gpuHmrSuccess=false`, and cannot satisfy broad/full-runtime proof without observed no-shim same-process loader, epoch publication, dispatch trace, host identity, visual or compute output oracle, firewall, and accepted strict proof-ledger closure.

2026-06-28: `synthi_wait_hmr` now exposes a generic proof-pending dev-loop contract for non-strict applied HMR responses. The response can carry `proof_pending=true` and `gpu_hmr_dev_loop.evidence_authority=hmr_fast_path_only_not_gpu_hmr_acceptance`, with `accepted_for_gpu_hmr=false` and `gpu_hmr_success=false`. Strict callers still request `requiredGpuProofState` or `requireGpuFullRuntimeProof` and still fail closed with `gpu_hmr_proof_insufficient` when the proof ladder is missing or insufficient.

2026-06-28: strict `synthi_wait_hmr` now has generic post-apply timeout intelligence. After HMR reaches `applied`, an observed matching proof slice that is structurally incapable of satisfying the requested strict proof state can return immediately with `gpu_hmr_proof_insufficient`, `gpu_proof_wait.status=failed_fast`, and `proof_wait_timeout_intelligence.evidence_authority=strict_proof_wait_timeout_intelligence_not_gpu_hmr_acceptance`. Missing proof or lower-rank partial proof still waits for a later valid strict proof. This reduces dead wait windows without turning refusal evidence into GPU HMR acceptance.

2026-06-28: the real ROCm proof scheduler can now skip async runtime waits only when generic upstream lifecycle evidence already proves runtime stages are absent and the row is already fast-failed as refusal-only proof-scheduling evidence. The emitted `real_rocm_proof_scheduling` and `timeout_intelligence_failure` facets set `skip_async_runtime_waits=true`, `acceptedForGpuHmr=false`, `gpuHmrSuccess=false`, and `canSatisfyRuntimeProof=false`; the validation matrix rejects forged skip flags unless they are tied to fast-fail scheduling plus `proof_scheduling_upstream_lifecycle_runtime_absent`. This is an orchestration optimization, not a success path.

2026-06-28: the large real ROCm path now emits a generic plan-only `real_rocm_app_hook_materialization` facet. It is derived from profile proof obligations, runner-observed source-delta execution, device-sidecar candidates, compile-bridge evidence, output-oracle materialization, and per-stage app-hook plans for `artifact_transport`, `epoch_publication`, `dispatch_trace`, `host_identity`, and `output_oracle`. The facet is recorded in retained reports, runtime proof artifacts, proof summaries, matrix rows, and per-target coverage, but it explicitly remains `acceptedForGpuHmr=false`, `gpuHmrSuccess=false`, and `canSatisfyRuntimeProof=false`. The matrix rejects forged materialization facets that claim runtime, dispatch, or GPU HMR authority.

2026-06-28: runtime-profile adapters can now emit a content-addressed `synthi.gpu_hmr.runtime_profile_adapter_result.v1` result manifest. Real ROCm profiles may declare that manifest path through generic runtime-profile fields or `SYNTHI_REAL_ROCM_RUNTIME_PROFILE_ADAPTER_RESULT_PATH` / `SYNTHI_GPU_HMR_RUNTIME_PROFILE_ADAPTER_RESULT_PATH`; the runner imports it as `synthi.real_rocm.runtime_profile_adapter_result_bridge.v1` evidence only after repo-bound path checks, JSON schema checks, byte hashing, and strict-proof summary extraction. The bridge is deliberately `acceptedForGpuHmr=false`, `gpuHmrSuccess=false`, and `canSatisfyRuntimeProof=false`: it can connect an external/profile-driven runtime adapter result to the retained proof ledger, but it cannot authorize broad GPU HMR without observed artifact transport, epoch publication, dispatch trace, host identity, output oracle, firewall proof, and accepted strict runtime proof closure.

2026-06-29: validation-matrix ingestion now recomputes the runtime-profile adapter-result bridge facet for real ROCm rows and accepted-row safety. A present bridge facet must have schema `synthi.real_rocm.runtime_profile_adapter_result_bridge.v1`, authority `declared_adapter_result_import_not_runtime_authority`, explicit strict proof/runtime-artifact/proof-ledger presence, strict proof/ledger IDs, content-addressed adapter result hash, evidence refs, and no blocking gaps. The matrix rejects forged bridge facets that claim GPU HMR acceptance, GPU HMR success, runtime authority, or dispatch authority, including when those claims are attached to an otherwise accepted row. This is a generic safety backstop, not an acceptance shortcut.

2026-06-29 runtime-adapter execution follow-up: real ROCm profiles and env can now declare a generic `runtimeAdapter` command through `SYNTHI_REAL_ROCM_RUNTIME_ADAPTER_JSON` / `SYNTHI_GPU_HMR_RUNTIME_ADAPTER_JSON`. The runner executes the command in the configured worker context after output-oracle profile sync, captures `[synthi-runtime-adapter]` / `[gpu-runtime-boundary]` lines, imports adapter app-hook contract material into the existing runtime evidence classifiers, and records `synthi.real_rocm.runtime_adapter_execution.v1`. The facet is deliberately `acceptedForGpuHmr=false`, `gpuHmrSuccess=false`, and `canSatisfyRuntimeProof=false`; it can expose arbitrary-project app-hook/runtime boundary evidence, but it cannot satisfy artifact transport, epoch publication, dispatch trace, host identity, output oracle, firewall, or strict runtime proof closure by declaration.

2026-06-29 runtime-adapter execution normalization follow-up: `synthi.real_rocm.runtime_adapter_execution.v1` now preserves its captured `[gpu-runtime-boundary]` lines as explicit `runtimeBoundaryLines` / `runtime_boundary_lines`, and runtime evidence collection merges those lines into the same `workerEvidence` stream used by the existing artifact-transport, epoch, dispatch, host-identity, output-oracle, firewall, and strict proof classifiers. This removes dependence on retained log text for live adapter output while keeping the facet evidence-only. The real-ROCm self-check verifies an adapter execution boundary line feeds `runtimeArtifactTransportEvidence` and still does not authorize GPU HMR by itself.

2026-06-29 runtime-adapter file-backed output-oracle follow-up: adapter-emitted `[gpu-runtime-boundary] output_oracle` lines can now carry generic file-backed compute artifacts: `raw_readback_bin`, `readback_schema_json`, `rendered_card_png`, `raw_readback_hash`, `checksum_before`, `checksum_after`, deterministic slice offset/length/hash, and advisory `expected_output_verified`. The real-ROCm runner normalizes those fields into the existing `compute_oracle_artifacts` shape and then sends them through the shared `computeOracleArtifactsFromFiles` verifier before any compute-oracle gate can pass. The fields can also point to `synthi.cas.artifact_locator.v1` manifest files through `raw_readback_cas_manifest`, `readback_schema_cas_manifest`, and `rendered_card_cas_manifest`; every CAS locator is validated with readable-byte SHA-256 checks under allowed artifact/CAS roots before it is resolved to a local file. Direct paths must realpath inside approved artifact roots or they stay explicit non-proof metadata. The self-check covers a valid adapter-declared raw readback/schema/proof-card triplet, a CAS-manifest-backed triplet, a forged raw-readback hash that remains refused, and a direct path escape that remains refused. This is generic arbitrary-project adapter plumbing, not a classifier shortcut and not GPU HMR acceptance by declaration.

2026-06-30 runtime-adapter visual output-oracle follow-up: adapter-emitted `[gpu-runtime-boundary] output_oracle` lines can now carry generic visual oracle artifacts through `before_image`, `after_image`, `diff_image`, role-bound CAS manifest variants, declared SHA-256 hashes, `camera_state_hash`, `swapchain_size`, `capture_backend`, and `frame_number`. The real-ROCm runner resolves those paths or CAS locators only under approved artifact/CAS roots, verifies readable bytes and declared hashes, decodes the PNGs through the same visual evidence thresholds used elsewhere, rejects blank/same-frame/low-quality diffs, validates swapchain dimensions when declared, and passes accepted `visual_oracle_artifacts` plus visual evidence refs into the normal output-proof classifier. The self-check covers a CAS-backed positive path that still requires dispatch, epoch, deterministic probe-contract, and output-oracle closure, plus forged image-hash and path-escape refusals. Validation-matrix smoke coverage now also carries a real-ROCm visual-oracle row through strict ledger classification and refuses a forged role-bound visual CAS hash with the normal output-or-visual-proof gap. The visual artifact facet remains `acceptedForGpuHmr=false` and `gpuHmrSuccess=false`; it is output-oracle byte evidence only, not runtime authority or broad project acceptance.

2026-06-30 strict-ledger visual-CAS follow-up: strict proof-ledger recomputation can now evaluate visual-only CAS oracle ledgers through a resolved visual artifact overlay. The overlay is derived only from matrix-validated role-bound visual CAS locators for before/after/diff PNGs, and it is used for strict artifact-readability/hash invariants without mutating the canonical proof ledger record or proof ID. Stale supplied query/success summaries are ignored only when all visual CAS locators for that visual artifact set validate cleanly; forged role-bound visual hashes now fail at the ledger layer before output-oracle classification. This gives visual adapter proof the same CAS-backed strict-ledger treatment as compute/readback proof while keeping CAS resolution support-only (`acceptedForGpuHmr=false`, `gpuHmrSuccess=false`).

2026-06-29 validation-matrix compute-CAS follow-up: matrix compute-oracle file integrity now understands role-bound `synthi.cas.artifact_locator.v1` entries embedded in `compute_oracle_artifacts` for `raw_readback`, `readback_schema`, and `rendered_card`. The matrix validates readable bytes, byte length, content hash, allowed artifact/CAS roots, and role binding before using the resolved local file for raw readback/schema/card verification. A forged role-specific locator blocks direct-path fallback and keeps the row refused with `compute_oracle_artifact_cas_locator_validation_failed` and the normal output-oracle gaps. The CAS resolution facet is support/transport evidence only (`acceptedForGpuHmr=false`, `gpuHmrSuccess=false`) and cannot authorize GPU HMR.

2026-06-29 strict-ledger compute-CAS follow-up: strict proof-ledger recomputation can now evaluate CAS-only compute oracle ledgers through a resolved artifact overlay. The overlay is derived only from validated role-bound CAS locators and is used for artifact-readability invariants without mutating the canonical ledger record or proof ID. Stale supplied query/success summaries are ignored only when all CAS locators for that compute artifact set validate cleanly; proof IDs, record contents, epoch, dispatch, host identity, firewall, output oracle, and strict runtime proof gates remain authoritative. Smoke coverage accepts a CAS-only compute ledger backed by a separately accepted strict runtime proof artifact and refuses a forged role-specific locator at the ledger layer.

2026-06-29 runtime-adapter scheduling follow-up: real ROCm `runtimeAdapter.runWhen` is now a generic lifecycle enum instead of a single post-run slot. Profiles/env may select `after_upstream_run`, `after_configure_success`, `after_build_attempt`, or `after_lifecycle_attempt`; unknown/project-named shortcuts are rejected, and explicit `requiresSuccessfulBuild` / `requiresSuccessfulRun` still gate execution. The execution facet records `runWhen`, and profile proof obligations now recompute against profile-declared, env-declared, or adapter-imported app-hook contracts so a valid generic contract removes only the stale configuration gap. Runtime acceptance still requires observed app-hook stages, artifact transport, epoch publication, dispatch trace, host identity, output oracle, firewall proof, and accepted strict runtime proof closure.

2026-06-29 large-ROCm runtime closure target: the next generic implementation gap is an adapter-produced runtime proof bridge, not another repository-specific branch. A real ROCm runtime adapter must be able to emit content-addressed runtime boundary events for the five app-hook stages `artifact_transport`, `epoch_publication`, `dispatch_trace`, `host_identity`, and `output_oracle`, plus file-backed output oracle artifacts that include CAS-backed raw readback or structured result bytes, schema, expected/actual hashes, dispatch ID, output target, epoch, and a rendered proof card. These records must feed the existing runtime classifiers before strict proof classification and must close gaps only when the same matrix file-integrity, epoch, dispatch, host-identity, firewall, and strict runtime-proof gates pass. This is the path for arbitrary large projects such as MIOpen, Composable Kernel, and hipBLASLt; it is explicitly not a project-name shortcut and not acceptance by declaration.

2026-06-29 adapter-boundary fixture follow-up: validation-matrix runtime-chain classification now preserves accepted adapter boundary lines from both project-neutral `synthi.real_rocm.runtime_profile_adapter_result_bridge.v1` evidence and direct `synthi.real_rocm.runtime_adapter_execution.v1` evidence. Either channel can supply a conservative missing-field runtime-chain overlay, but conflicts between ledger, imported adapter-result, and direct execution observations become runtime-chain failures. The real ROCm runner also treats `runtimeAdapter.resultPath` / runtime-profile adapter result path as an execution contract: it exports a worker-side result path, creates the parent directory for configured commands, and copies the result file back to the repo-bound host path before bridge import. The validation matrix now independently ingests `synthi.real_rocm.runtime_adapter_result_transport.v1` as a transport-only facet, requires the evidence-only authority `runtime_adapter_result_transport_only_not_gpu_hmr_success`, and rejects missing, forged, or success-claiming transport records on otherwise positive rows. The complete smoke row accepts only when the normal strict ledger, runtime-chain, same-process oracle, app-hook materialization, sidecar consistency, output-oracle, firewall, and runtime-proof gates all close; adapter result, adapter execution, and adapter result transport facets remain `acceptedForGpuHmr=false` and `gpuHmrSuccess=false`. The paired negative fixture leaves the strict ledger successful but mismatches the direct runtime-adapter execution output oracle's `after_dispatch_id` and forges transport authority, so the row remains `unproven` with `real_rocm_runtime_chain_adapter_output_dispatch_mismatch` plus transport-authority refusal reasons. This hardens the arbitrary-project bridge target without accepting a serialized success flag, repository name, kernel name, declared adapter result, copied result file, or adapter command success by itself.

2026-06-30 runtime-adapter Synthi launch-boundary follow-up: validation-matrix runtime-chain overlay parsing now treats `[gpu-runtime-boundary] synthi_gpu_launch ...` as the same generic dispatch-boundary source as `[gpu-runtime-boundary] native_runtime_dispatch ...`. Adapter boundary coverage already accepted either event kind, so the runtime-chain overlay must also extract dispatch ID, epoch, generation, artifact ID, output target, dispatch table entry, and timestamp from either shape. The complete adapter-boundary bridge smoke fixture now uses `synthi_gpu_launch` for the positive path, while the existing mismatch fixture still exercises `native_runtime_dispatch`; this keeps the gate project-agnostic and prevents a coverage/runtime-chain split-brain where a generic Synthi adapter proves dispatch coverage but cannot close the runtime chain.

2026-06-30 runtime-adapter host-identity proof-shape follow-up: adapter boundary coverage no longer treats a generic `[gpu-runtime-boundary] host_identity ...` event-family line as enough. When host identity is observed, the matrix recomputes proof-shaped host preservation evidence through the shared `runtimeHostIdentityEvidence` classifier, requires numeric before/after identity lineage from generic boundary fields such as `host_identity_previous_generation` / `host_identity_active_generation`, and requires preserved runner-process, host-state, and runtime-resource roles with stable non-null pointers across that lineage. The runtime generation token used by the strict ledger remains separate from the numeric host-identity snapshot lineage, so row/ledger generation binding is not weakened. Smoke coverage keeps all five adapter boundary event families present but collapses host identity to a weak role-less event; the row stays `unproven` with `real_rocm_runtime_adapter_boundary_host_identity_fields_incomplete`.

2026-06-30 runtime-adapter stage-events normalization follow-up: the real ROCm runner now derives `synthi.real_rocm.runtime_adapter_stage_events.v1` from generic `[gpu-runtime-boundary]` lines for the five app-hook stages `artifact_transport`, `epoch_publication`, `dispatch_trace`, `host_identity`, and `output_oracle`. The facet records per-stage boundary-line hashes, field checks, missing proof kinds, evidence refs, and a facet hash, but it is explicitly support-only with `acceptedForGpuHmr=false`, `gpuHmrSuccess=false`, `canSatisfyRuntimeProof=false`, and `canSatisfyDispatchProof=false`. Validation-matrix ingestion recomputes the stage proof-kind requirements from the field checks, rejects forged stage-event facets that claim GPU HMR or runtime authority, and keeps missing or weak stage evidence as precise refusal/support diagnostics. This is generic arbitrary-project adapter audit plumbing, not acceptance by adapter output.

2026-06-30 matrix-derived stage-events diagnostics follow-up: validation-matrix ingestion can now derive a support-only runtime-adapter stage-events facet from retained raw `[gpu-runtime-boundary]` lines when a serialized stage-events facet is absent. Derivation is intentionally narrower than target-process provenance: stage diagnostics use only neutral evidence carriers with the expected evidence-only authority and no GPU HMR/runtime/dispatch success claims. A serialized app-hook contract that claims derivation from stage events still requires the matching serialized or otherwise accepted source stage-events facet; the matrix refuses a forged derived contract instead of reconstructing it from loose boundary text. Large ROCm rows such as MIOpen can now retain precise missing-stage diagnostics from native breadcrumbs while remaining `refusal_proven` until artifact transport, epoch publication, dispatch trace, host identity, output oracle, firewall, strict runtime proof, and ledger/runtime-chain closure all pass.

2026-06-30 runtime-adapter stage-events app-hook derivation follow-up: complete support-only runtime-adapter stage events can now derive the real ROCm app-hook contract when an explicit contract is absent. The runner and validation matrix both derive from the same generic five-stage evidence, source facet hash, boundary-line hashes, and stage evidence refs. A derived contract can remove only the stale missing-contract configuration gap; it cannot authorize GPU HMR without strict runtime proof, ledger/runtime-chain closure, output oracle, same-process identity, sidecar, and firewall gates. Matrix smoke coverage accepts a stage-events-derived contract only in an otherwise complete strict fixture and refuses a serialized derived contract when the matching stage-event facet is absent.

2026-06-30 runtime-adapter bridge-only final-support follow-up: the real ROCm runner no longer requires a direct `runtime_adapter_execution` facet when an imported adapter-result manifest already supplies strict-proof-accepted or boundary-import-accepted bridge evidence, complete runtime-adapter stage events, accepted target-process provenance, and accepted declared result transport. This is only a final-support consistency fix for external/profile-driven adapter result manifests; a present failed execution facet, bad bridge, missing provenance, incomplete stage evidence, or bad transport still blocks, and full GPU HMR acceptance still depends on strict runtime proof, ledger/runtime-chain, oracle, firewall, sidecar, and row-safety gates.

2026-06-30 runtime-adapter boundary-only runtime-chain overlay follow-up: validation-matrix runtime-chain overlay now accepts support-only adapter-result bridge facets with `acceptedAsBoundaryEvidence=true` as an overlay source even when the facet's strict-result `accepted` flag is false. The overlay still rejects any GPU HMR/runtime/dispatch authority claims, and smoke coverage removes every adapter-execution facet from a boundary-only bridge fixture to prove the manifest path itself feeds runtime-chain consistency. This is a generic result-manifest bridge fix, not project-specific acceptance and not proof by manifest.

2026-06-30 structured adapter-event materialization follow-up: runtime-profile adapter result manifests can now provide typed `synthi.gpu_hmr.runtime_boundary_event.v1` objects through generic `runtimeBoundaryEvents` / `adapterRuntimeBoundaryEvents` fields. The runner materializes only recognized event kinds into canonical `[gpu-runtime-boundary]` lines, with scalar no-whitespace key/value fields, then feeds those lines through the existing artifact-transport, epoch, dispatch, host-identity, output-oracle, stage-events, and matrix bridge parsers. This gives arbitrary project adapters a structured JSON emission path while keeping the same proof model: the structured events are not accepted by themselves, cannot claim GPU HMR success, and must still close the strict ledger/runtime-chain/oracle/firewall gates through recomputed evidence.

2026-06-30 runtime-adapter event-manifest template follow-up: real ROCm `runtimeAdapter` declarations now support a repo-relative `eventManifestPath`, exported to worker commands as `SYNTHI_REAL_ROCM_RUNTIME_ADAPTER_EVENT_MANIFEST_PATH` / `SYNTHI_GPU_HMR_RUNTIME_ADAPTER_EVENT_MANIFEST_PATH`, and a packaged generic `runtime_boundary_event_manifest_v1` template. The template can publish a structured adapter result manifest without inline project-specific shell commands, while unsafe path traversal is rejected by the same relative-path gate used for adapter result paths. The copied manifest remains evidence-only: bridge import, structured event materialization, stage-events, runtime chain, output oracle, firewall, and strict proof-ledger gates still recompute everything and reject any success-authority claims.

2026-06-30 runtime-boundary target-environment follow-up: the real ROCm upstream target run now receives a generic support-only runtime-boundary environment only when a runtime adapter is explicitly declared and enabled. The runner validates repo-relative result/event-manifest paths, creates parent directories inside the worker namespace, exports generic aliases such as `SYNTHI_REAL_ROCM_RUNTIME_BOUNDARY_EVENT_MANIFEST_PATH`, `SYNTHI_GPU_HMR_RUNTIME_BOUNDARY_EVENT_MANIFEST_PATH`, `SYNTHI_REAL_ROCM_RUNTIME_ADAPTER_EVENT_MANIFEST_PATH`, and `SYNTHI_REAL_ROCM_RUNTIME_ADAPTER_RESULT_PATH`, and records `synthi.real_rocm.runtime_boundary_target_environment.v1` with `proofAuthority=target_environment_exposure_only_not_gpu_hmr_success`. The facet is preserved in retained reports and runtime evidence but remains `acceptedForGpuHmr=false`, `gpuHmrSuccess=false`, and `canSatisfyRuntimeProof=false`; it only gives arbitrary upstream projects a project-neutral place to write structured runtime-boundary events. Undeclared adapters export nothing, disabled upstream runs are a support gap, and strict acceptance still requires observed artifact transport, epoch publication, dispatch trace, host identity, output oracle, firewall, runtime chain, and accepted strict proof-ledger closure.

2026-06-30 runtime-boundary target-environment consumer hardening follow-up: validation-matrix ingestion now normalizes `synthi.real_rocm.runtime_boundary_target_environment.v1` from reports, summaries, runtime proof artifacts, and evidence blocks; accepted real-ROCm rows fail safety if the facet has the wrong schema/authority, claims GPU HMR/runtime/dispatch authority, exports adapter env without a declared/enabled adapter, omits required event/result aliases, or carries blocking gaps. Runtime proof artifacts also snapshot the facet and turn any forged authority or shape failure into a strict limitation even when the embedded proof ledger invariants are otherwise successful. This keeps target environment export as generic arbitrary-project plumbing, not proof authority.

2026-06-30 runtime-adapter event-manifest bridge follow-up: real ROCm log-harvest adapters can now expose a structured runtime-boundary event manifest path independently of the adapter result manifest. When a profile declares `runtimeAdapter.eventManifestPath`, or when an enabled adapter has a safe result path from which a support-only event path can be derived, the runner exports generic `SYNTHI_REAL_ROCM_RUNTIME_BOUNDARY_EVENT_MANIFEST_PATH` / `SYNTHI_GPU_HMR_RUNTIME_BOUNDARY_EVENT_MANIFEST_PATH` and adapter aliases to the upstream target, copies any written manifest back as `synthi.real_rocm.runtime_adapter_event_manifest_transport.v1`, and merges its typed `runtimeBoundaryEvents` into the existing adapter-result bridge before stage-event, runtime-chain, and proof-ledger classification. The bridge rejects event manifests that claim GPU HMR/runtime/dispatch authority, deduplicates camel/snake structured event arrays, and keeps all transport facets support-only (`acceptedForGpuHmr=false`, `gpuHmrSuccess=false`, `canSatisfyRuntimeProof=false`). The MIOpen, Composable Kernel, and hipBLASLt large-ML profiles now declare the same generic event-manifest support path alongside their log-harvest adapter result path. This is arbitrary-project adapter plumbing only: it gives serious upstream projects a neutral place to emit artifact-transport, epoch, dispatch, host-identity, and output-oracle events, but it cannot satisfy GPU HMR acceptance without same-process runtime proof, output/visual oracle bytes, firewall proof, and strict ledger closure.

2026-06-30 runtime-boundary target-process provenance follow-up: runtime adapter boundary support now requires a generic `synthi.real_rocm.runtime_boundary_target_process_provenance.v1` facet before adapter boundary events can support final real-ROCm acceptance. Native observer `[gpu-runtime-boundary]` lines carry a runtime session from `SYNTHI_REAL_ROCM_RUNTIME_SESSION` / `SYNTHI_GPU_HMR_RUNTIME_SESSION` plus `process_id=pid:<pid>`. The runner, strict runtime proof artifact builder, and validation matrix require adapter boundary lines that claim support to bind to exactly one runtime session, exactly one explicit process identity, accepted target-environment exposure, matching target-environment session, complete five-stage boundary coverage, and no GPU HMR/runtime/dispatch authority claims. The matrix recomputes provenance from raw adapter-result or adapter-execution boundary lines and refuses serialized-only provenance, missing source boundary lines, missing explicit process IDs, missing target-environment session, and declared-but-not-copied result transport. A full-runtime proof that otherwise looks successful is degraded if adapter boundary events are present but target-process provenance is missing or failed. This is generic arbitrary-project runtime-adapter hardening only; the facet remains `acceptedForGpuHmr=false`, `gpuHmrSuccess=false`, and cannot authorize GPU HMR without artifact transport, epoch publication, dispatch trace, host identity, output oracle, firewall, strict runtime proof artifact, and recomputed ledger closure. Smoke coverage includes a complete adapter-boundary fixture plus forged target-process authority, serialized-only provenance, missing identity, and session-mismatch refusals.

2026-06-30 runtime-adapter result-bridge hardening follow-up: runtime evidence collection and execution-facet refresh now consume adapter-result boundary lines only from a usable bridge: schema-correct imported status, declared/present result, exact evidence-only authority, accepted strict proof summary, zero bridge blocking gaps, matching runtime profile id when a profile is active, no GPU HMR/runtime/dispatch authority claims, and copied result transport when transport was declared. A refused bridge with complete boundary lines, a mismatched profile id, or a copied=false transport facet cannot feed `workerEvidence`, cannot refresh `runtime_adapter_execution`, and remains a strict proof artifact limitation. The real-ROCm final verdict also records adapter final-support gaps for configured adapter/result paths before any report-level `gpu_hmr_success=true` can be written. These checks are generic support-gate hardening, not a success shortcut and not a project-name branch.

2026-06-30 runtime-adapter event-manifest-only bridge follow-up: fail-closed real ROCm runtime evidence collection now copies declared adapter result and runtime-boundary event manifest paths from the worker before bridge import, even when the later adapter command phase is skipped or never reached. A copied `synthi.gpu_hmr.runtime_boundary_event_manifest.v1` can feed boundary-only bridge evidence without a readable adapter-result manifest only when profile identity, no-authority checks, recomputed boundary coverage, support-only event-manifest transport, target-process provenance, stage-event completeness, and a separate accepted strict runtime proof artifact all pass. Missing adapter-result bytes remain an explicit refusal gap for strict-result import, and event-manifest transport remains `acceptedForGpuHmr=false`, `gpuHmrSuccess=false`, and `canSatisfyRuntimeProof=false`. This captures arbitrary upstream target-written structured events without converting copied manifests, profile IDs, native observer breadcrumbs, or serialized event objects into GPU HMR acceptance.

2026-06-30 matrix event-manifest-only adapter-boundary transport follow-up: validation-matrix ingestion now treats copied runtime-adapter event manifests as first-class boundary-source transport, separate from adapter-result bytes. The matrix preserves `resultPresent=false`, recomputes boundary payload from event-manifest boundary lines, treats `runtime_profile_adapter_result_unreadable` as neutral only for boundary import when event-manifest bytes are present and clean, recomputes target-process provenance with `eventManifestTransportCopied` and `boundarySourceTransportCopied`, and rejects forged or missing event-transport schema/authority/copy/hash evidence. Copied event manifests may satisfy boundary-source transport only for boundary-only adapter-result evidence when the event-manifest transport facet is accepted and the adapter-result transport failure is limited to missing result bytes; forged result-transport authority or success claims remain blockers. Event-manifest transport remains support-only (`acceptedForGpuHmr=false`, `gpuHmrSuccess=false`) and cannot authorize GPU HMR without strict ledger, runtime-chain, output-oracle, firewall, same-process, and row-safety closure.

2026-06-30 runtime-adapter lifecycle-finalizer follow-up: the real ROCm runner now executes a declared/enabled `runtimeAdapter.runWhen=after_lifecycle_attempt` adapter from the finalizer before runtime evidence collection when no execution facet was produced on the normal path. This covers early configure/build/metadata failures where the harness still needs fail-closed adapter/result/event-manifest evidence. The eligibility check is project-neutral: undeclared adapters, non-finalizer lifecycle slots, and any existing execution facet do not run. The resulting `runtime_adapter_execution`, adapter-result transport, and event-manifest transport records remain support/refusal evidence only (`acceptedForGpuHmr=false`, `gpuHmrSuccess=false`) and cannot satisfy runtime proof without artifact transport, epoch publication, dispatch trace, host identity, output oracle, firewall, runtime chain, and strict ledger closure.

2026-06-30 runtime-boundary event-manifest materializer follow-up: the real ROCm runner can now materialize a declared runtime-adapter event manifest from actual observed `[gpu-runtime-boundary]` lines in the upstream run log when a declared/enabled adapter has a safe repo-relative event-manifest path and no worker manifest already exists. The materializer preserves exact boundary lines as `runtimeBoundaryLines` / `adapterRuntimeBoundaryLines`, records line hashes, coverage, missing-stage gaps, and support-only authority `observed_runtime_boundary_run_log_materialization_only_not_gpu_hmr_success`, and writes only `acceptedForGpuHmr=false`, `gpuHmrSuccess=false`, and `canSatisfyRuntimeProof=false`. If no real boundary lines are observed, it does not fabricate an empty proof artifact; the event-manifest transport remains refused with the normal missing-worker-file gap. The bounded MIOpen rerun `gpu-real-rocm-MIOpen-20260630132711` exercised this path and correctly stayed refused with `runtime_boundary_event_manifest_materialization_no_boundary_lines`, zero lines, missing event-manifest transport, no artifact transport, no epoch, no dispatch, no host identity, no output oracle, and rejected strict runtime proof `gpu-runtime-proof:sha256:fc7ae97d93b58e06f034a97b7d8f44037d1da8ed16f22bed499a3e249b25e02a`.

2026-06-30 real ROCm lifecycle-status classifier follow-up: upstream lifecycle failure classification now recovers `configure_status`, `post_configure_status`, `build_status`, and `run_status` only from wrapper-owned skip lines such as `upstream run skipped after ...`, not arbitrary project log text. Unknown timeout-fallback status fields no longer override a recovered successful configure status, post-configure failures have explicit failure/blocking reasons, and project logs that print success-shaped `*_status=0` tokens without the wrapper prefix remain non-authoritative. These fields can reduce strict proof wait windows only as refusal evidence; they cannot authorize GPU HMR success, runtime authority, dispatch authority, app-hook closure, or output proof.

2026-06-30 matrix real ROCm lifecycle-status recompute follow-up: validation-matrix ingestion now recomputes the upstream lifecycle failure facet from retained timing text plus configure/build/run log tails when those bytes are present. Wrapper-owned skip lines remain the only source of recovered lifecycle status, so stale serialized `cmake_configure_failed` classifications are corrected to build/post-configure/run blockers when logs prove that shape, while arbitrary project log text such as `build_status=0` remains ignored. The recomputed facet is still refusal diagnostics only and cannot satisfy runtime proof, dispatch proof, app-hook closure, or output-oracle proof.

2026-06-30 run-id lifecycle-status recovery follow-up: real ROCm lifecycle attempts now write a worker-side `synthi.real_rocm.worker_lifecycle_status_recovery.v1` status file bound to a fresh `SYNTHI_REAL_ROCM_LIFECYCLE_RUN_ID`, truncate configure/build/run logs before each attempt, and copy CMake configure metadata into a run-local snapshot only after configure succeeds. If a bounded lifecycle timeout kills configure before it returns, the recovered status remains `configure_exit_code=unknown`, `metadata_snapshot_status=unknown`, and the classifier emits `upstream_configure_status_incomplete_after_lifecycle_failure` as refusal-only evidence instead of reading stale wrapper-owned skip lines from an older attempt. Metadata recovery tries only the current run's snapshot and current build tree; stale `compile_commands.json` files cannot satisfy source-delta, app-hook, runtime, dispatch, output-oracle, or ledger gates.

2026-06-30 random large-project cold-path sampler follow-up: `gpu-hmr-random-large-project-cold-path.mjs` now provides a replayable seeded sampler for serious arbitrary cold-path attempts. It records `synthi.gpu_hmr.random_large_project_cold_path.v1` manifests with selection seed, candidate repo URL, immutable commit, size signals, selected profile path, timeout, result status, and explicit evidence-only authority `random_large_project_cold_path_selection_only_not_gpu_hmr_success`. The sampler can dry-run selection or invoke the normal real ROCm runner for a cold checkout with reuse disabled; either way it writes `acceptedForGpuHmr=false`, `gpuHmrSuccess=false`, and `canSatisfyRuntimeProof=false` until the selected project independently closes the strict loader, epoch, dispatch, host-identity, output-oracle, firewall, and ledger gates.

2026-06-30 random large-project cold-path retention follow-up: actual sampled cold-path execution now writes a pending manifest before launching the long real ROCm runner, applies a separate outer runner timeout, converts spawn errors and timeouts into structured fail-closed result rows, and records pending/final manifest hashes. The bounded actual run selected `real-rocm-hipblaslt-gelu-aux-bias-large-ml`, reached Docker and a real `ROCm/hipBLASLt` checkout at commit `3a609b06926c8227e753b62087555e1f435bf2d4` with `files=2860`, then stopped at the sampler's 15 second outer timeout with `runner_timeout_failed_closed`. Final manifest `sha256:fb806f1d9a0a6e09e48b854b26d71acb7196e156de2b3afbb9c64c44405f1d03` references pending manifest `sha256:1f6767f3f96a49b3d7b4f0766050834405533ef6e821bf9682bd5d76602efcf3`; both remain `acceptedForGpuHmr=false`, `gpuHmrSuccess=false`, and `canSatisfyRuntimeProof=false`. This proves the user-like random cold-path lane retains evidence even when a large arbitrary project cannot complete inside the interactive budget; it is not hipBLASLt GPU HMR acceptance.

2026-06-30 unprofiled arbitrary cold-intake follow-up: the random large-project sampler no longer requires every candidate to have a packaged profile. Candidates without `profilePath` are normalized as `profileMode=unprofiled_arbitrary_project_cold_intake`, retain repo URL, immutable commit, size signals, build-system hints, runtime-boundary hints, and oracle hints, and then refuse with generic missing-proof gaps instead of inventing a profile or launching a project-specific runner. A non-profiled public-project check resolved `https://github.com/ggerganov/llama.cpp.git` to commit `4f31eedb0ccf546b7e8d6bb243b170f12522f54d` and retained final manifest `sha256:458e284f1861792ec270b96f3ef8842e108a46a4c45d0a5eb107a43a0c35cb4c`, accepted source listing `sha256:8fa51e93e94b52ea3248e2e3e00c0ef0ed401d17e6d23d35336f3adfaaccd4f3`, source-intake facet `sha256:6cef63952038b3d7cd6c4e9be642dc841ddf691ea6209c4e9d4cbad138cfbee2`, 3,011 files, 154,991,455 known bytes, and detected `cuda`, `hip_rocm`, `metal`, `opencl`, `sycl`, `vulkan`, and `webgpu_wgsl` backend candidates. It correctly stayed `unprofiled_arbitrary_project_cold_intake_refused` with missing local backend runner, runtime profile contract, build metadata verification, same-process loader, epoch, dispatch trace, host identity, output oracle, and strict runtime ledger proof. This expands random cold-path testing toward real user projects without converting repo identity, build hints, or arbitrary project selection into GPU HMR proof.

2026-06-30 default arbitrary cold-pool follow-up: the sampler's built-in default pool now includes unprofiled arbitrary projects alongside the enrolled large-ROCm profiles: `llama.cpp`, `wgpu`, `dawn`, and `godot`, each pinned to an immutable commit with only support/refusal hints. The default seeded dry-run selected `unprofiled-dawn-webgpu-stack` with manifest `sha256:7419645ca7eb374749bbdd77ad1f3a6b4fc8a1208cf2d5e60e25b9b5c4dcd626`; the actual cold run retained manifest `sha256:746456bb431c40655427a38539f5c8f7d3a94476347180933229933e07e3e89a` and failed closed because GitHub's recursive tree response was truncated, leaving `source_tree_intake_missing`. The retained source-intake facet `sha256:ac4be2b42b318a52d650411df9fe43b910ddc45c9052f3f3d80fb744fbf37f79` records a non-authoritative fallback plan with `fallback_plan_only_not_source_intake_or_gpu_hmr_success` and explicit opt-in `SYNTHI_GPU_HMR_UNPROFILED_GIT_FALLBACK=1` for a live blobless git listing. A second actual unprofiled run selected `unprofiled-wgpu-rust-graphics-stack`, retained manifest `sha256:3f20a4e8c622e20e14943ac10240de7949d676ac129ff896e9d72bfa08616512`, accepted source-intake facet `sha256:1a80affe42c6e0b50d8781a3be2dc34ff3fb4f0cb1b9f4c6948d01a1c5559f07`, listing hash `sha256:637cc42807a851a8a27f5d9ff4b27d02ee4e1f2fae3707bb064be20e3e7131b7`, 2,445 files, 35,885,065 known bytes, 34 build metadata signals, 80 sampled GPU source signals, and `metal`, `vulkan`, and `webgpu_wgsl` backend candidates. Both rows remain `acceptedForGpuHmr=false`, `gpuHmrSuccess=false`, and `canSatisfyRuntimeProof=false`; this is real-user cold intake and refusal proof, not arbitrary-project runtime acceptance.

2026-06-30 direct arbitrary cold-input follow-up: `gpu-hmr-random-large-project-cold-path.mjs` now accepts a direct user-style `--source-url` plus immutable `--commit` input, with optional `--source-id` and `--backend-family`, instead of requiring a prewritten candidate JSON file or a built-in sample-pool entry. Direct candidates are normalized as `candidateSource=direct_source_url_commit`, `profileMode=unprofiled_arbitrary_project_cold_intake`, and support-only cold-intake evidence. A direct wgpu run (`--source-url https://github.com/gfx-rs/wgpu.git --commit 22c6cb18d4b73254b0d62511e6a9d68e06dea70f --source-id direct-wgpu-user-path`) retained manifest `sha256:0c43d180417d4d8f25ba52f6de87b67d7f6c5a91ec4738269526bdf6d0578303`, accepted the same source listing hash `sha256:637cc42807a851a8a27f5d9ff4e1f2fae3707bb064be20e3e7131b7` with 2,445 files, and still refused GPU HMR with the normal gaps for missing local backend runner, runtime profile contract, build metadata verification, same-process loader, epoch publication, dispatch trace, host identity, output oracle, and strict runtime ledger. This is the intended arbitrary user-project cold path: easy to invoke, evidence-rich, and fail-closed.

2026-06-30 local arbitrary cold-input follow-up: the same cold-path runner now accepts `--repo-path` for a local user checkout. Local candidates are recorded as `candidateSource=direct_local_git_repo_path`; source intake uses `git ls-tree` only after proving the requested commit exists and the worktree is clean. Dirty local worktrees fail closed with `source_intake_local_git_dirty` instead of hashing a stale commit as if it represented the user's current files. The current workspace-local run (`--repo-path . --commit 430db98de60aaecef3ef0be53dc1e9ecf4b6aec5 --source-id direct-local-workspace`) retained manifest `sha256:96eef09f737c4d49a7a844c0ec133cee8fe2229b1a449b148102f0a874b45178` and refused because this checkout contains unrelated dirty/untracked files; GPU HMR success stayed false with the normal missing loader, epoch, dispatch, host-identity, output-oracle, and strict-ledger gaps.

2026-07-01 direct cold-path broad-readiness gate follow-up: validation-matrix broad readiness now requires the random large arbitrary-project cold lane to be a direct user-style intake row, not merely a packaged profile or configured sample-pool candidate. A qualifying cold row must have `profileMode=unprofiled_arbitrary_project_cold_intake`, `candidateSource=direct_source_url_commit` or `candidateSource=direct_local_git_repo_path`, immutable source identity from URL or local repo path plus commit, accepted source-tree intake, accepted build metadata evidence, and validated support-only runtime-boundary event-template evidence. Profile-backed large ROCm cold runs and configured-pool unprofiled samples still remain useful refusal artifacts, but they cannot satisfy the broad arbitrary-project cold-path requirement by themselves. Broad readiness remains aggregate validation evidence, not per-project GPU HMR acceptance.

2026-07-01 large cold-path size-gate hardening: validation-matrix broad readiness no longer counts tiny direct/local cold-path fixtures as random large arbitrary projects. A qualifying random cold-path row must now meet the direct user-style gate above and also prove source-tree scale through at least 1000 files or 10 MiB of known source bytes. Rows below that threshold are retained as `randomColdPathCandidateRows` diagnostics but do not count toward the five-row broad-readiness floor. The current retained matrix `gpu-validation-matrix-ledger:sha256:70a59fb470f0b433993ec70cc699a3cb47efdfda0cf3d81c1185df9e09225e59` has five qualifying large cold-path rows and therefore reopens aggregate broad readiness with matrix-computed proof `gpu-hmr-broad-library-agnostic-proof:sha256:c2c76ea4ef18f7a8c22b98b4740173c801a29589c51401d1d74b19edab554ea2`, `broadRuntimeRows=0`, `broadRuntimeRowsMissing=false`, `rowLocalBroadRuntimeRowsMissing=true`, and `matrixGeneralizationRuntimeRows=19`. The qualifying cold targets are `direct-llama-cpp-current-template`, `direct-filament-user-path-current-template`, `direct-vulkan-samples-user-path-current-template`, `direct-bevy-user-path-current-template`, and `direct-wgpu-user-path-current-template`; all remain support/refusal evidence until their own runtime loader, epoch, dispatch, host identity, output oracle, firewall, and strict ledger gates close. The direct Iced row is retained as a candidate-only user path because it is below the large-project threshold.

2026-07-01 random cold-path non-whitelist predicate audit: broad-readiness cold-path selection is now itself recorded in the broad proof as `synthi.gpu_hmr.random_cold_path_broad_readiness_predicate.v1`, with authority `matrix_static_predicate_not_project_name_whitelist`, `targetNameIndependent=true`, empty `projectNameWhitelist` and `specificTargetIdsAllowed`, and source identity role `source_identity_hash_bound_to_direct_input_not_whitelist`. The earlier predicate hash `sha256:a184d8c93a3ec1ec35957e7aa2982c536a346a15c16322955294da4660dcde89` is historical for pre-binding retained matrices; new recomputes include the source-identity hash binding. The predicate counts evidence shape, accepted `synthi.gpu_hmr.random_cold_path_direct_source_input.v1` evidence with authority `runner_cli_env_direct_source_input_only_not_gpu_hmr_success`, runner-derived direct input mode `direct_cli_or_env_input_mode_observed`, immutable source identity, direct candidate source, source-tree scale, source intake, source-derived backend candidates, candidate backend declarations as diagnostic-only metadata, build metadata discovery, schema/authority-checked `synthi.gpu_hmr.cold_build_metadata_content.v1` evidence, build-file byte hashes, a recomputed build metadata content hash, support-only runtime-boundary template validation, and absence of GPU HMR/runtime/dispatch authority claims; it explicitly ignores repository names, target IDs, profile IDs, and sample-pool membership as whitelists, while URL or local path values are used only through content hashes that must match the current row context. This moves "do not hardcode it to these projects" into the retained proof object, not just docs or a smoke-test comment.

2026-07-01 candidate-source provenance hardening: `gpu-hmr-random-large-project-cold-path.mjs` no longer trusts `candidateSource` / `candidate_source` supplied by a candidate JSON file or the built-in sample pool. Pool candidates are normalized to `configured_candidate_pool` even when the JSON tries to declare `direct_source_url_commit`. Only direct CLI/env source input through `--source-url` / `--repo-path` plus immutable commit can produce `direct_source_url_commit` or `direct_local_git_repo_path`. The cold-path self-check now injects a spoofed direct candidate JSON and requires it to be downgraded before any manifest can be written. This closes the gap where a prewritten project list could masquerade as direct arbitrary-user intake.

2026-07-01 random cold-path oracle-hint hardening: random large-project cold intake now treats candidate oracle hints as diagnostic-only fields. Runtime-boundary expectations derive acceptable oracle kinds only from source-detected backend candidates and build metadata evidence; candidate-declared oracle kinds are recorded separately with `candidateOracleHintsUsedForAcceptance=false`. A candidate JSON or built-in pool entry that claims `oracleHints.acceptedByDeclaration=true` now fails the support expectation with `candidate_oracle_hint_acceptance_claim_rejected`. Fresh cold runtime-boundary event templates carry the same source-derived/candidate-declared split, and validation-matrix ingestion rejects templates that claim candidate hints were used, claim oracle authority, or include non-source-derived acceptable oracle kinds. This prevents project lists, profile hints, or candidate manifests from upgrading visual/compute oracle support or broad-readiness evidence.

2026-07-01 random cold-path backend-declaration hardening: validation-matrix rows for random large arbitrary cold paths now derive the row backend only from source-intake backend candidates, not from candidate-declared `backend`, `backendFamily`, or `backendCandidates` fields. Those candidate declarations are retained in `randomColdBackendEvidence` as diagnostic-only metadata with `candidateBackendUsedForAcceptance=false`. The broad-readiness cold-path predicate now requires `source_derived_backend_candidates_observed` and records `candidate_backend_declarations_diagnostic_only`. Matrix smoke coverage forges a direct arbitrary cold-path candidate that declares HIP/ROCm while its source intake proves Vulkan/WebGPU; the row stays source-derived and GPU HMR remains false. This prevents repository profiles or candidate JSON from steering backend identity.

2026-07-01 random cold-path build-metadata content hardening: broad-readiness cold-path rows now require content-backed build metadata evidence, not filename discovery alone. The row must have accepted build metadata discovery, schema/authority-correct `synthi.gpu_hmr.cold_build_metadata_content.v1` evidence, at least one build-file path plus SHA-256 content hash, and a recomputed build metadata content SHA-256. A smoke matrix with five direct large arbitrary cold rows that only discover build metadata now leaves `randomColdPathRowCount=0` and broad readiness closed; a declared-only adversarial set with accepted/hash fields but no content facet also counts as zero. Fresh direct source-url probes against Filament and Vulkan-Samples restored the five-row large cold-path floor under the stricter predicate, while the direct Iced probe remained candidate-only because its source tree is below the large-project threshold. This keeps real-user cold testing from becoming a project-name list, a build-file-name shortcut, or a serialized success shortcut.

2026-07-01 random cold-path build-metadata byte-evidence follow-up: validation-matrix ingestion now requires accepted `synthi.gpu_hmr.cold_build_metadata_content.v1` build files to carry a positive observed byte length and an explicit content transport in addition to path and SHA-256. Hash-only serialized build metadata no longer counts for `random_large_arbitrary_project_cold_path` or broad-readiness cold-path rows, and smoke coverage proves five otherwise valid direct large arbitrary cold rows with hash-only build files keep `randomColdPathRowCount=0`. The accepted transport remains support-only (`build_metadata_content_bytes_only_not_gpu_hmr_success`) and cannot satisfy same-process loader, epoch, dispatch, host identity, output oracle, firewall, or strict runtime-ledger acceptance.

2026-07-01 random cold-path build-metadata path-shape follow-up: validation-matrix ingestion now requires accepted cold build-metadata content to include at least one content-hashed, transported path recognized as build metadata by generic build-system conventions such as CMake, Cargo, npm, Make, Ninja, Meson, Bazel, Gradle, Maven, Autotools, Python packaging, SCons, Xmake, Premake, Conan, vcpkg, MSBuild, or Xcode project metadata. Arbitrary content bytes such as `README.md` can no longer count as build metadata for broad arbitrary-project cold-path readiness even when they carry a SHA-256, byte length, transport, and serialized accepted flag; the row remains support/refusal evidence with `random_cold_build_metadata_content_build_file_path_unrecognized`. The broad cold-path predicate now records `build_metadata_content_build_file_path_recognized` as a required signal and still keeps project names, target IDs, fixture names, and sample-pool membership out of the acceptance predicate. Verification passed matrix smoke `gpu-validation-matrix-ledger:sha256:ce47b53a73a62714123a11c2d7b52b6cfa68b6a6321c065597cf4ed6ec20c43b` and full validation-matrix self-check `gpu-validation-matrix-ledger:sha256:b4348b9af56da1f7cd538cdf62bd657f1181fb394f70534fd5c15224469a2931`. This is arbitrary-project cold-intake hardening only; it does not satisfy same-process loader, epoch publication, dispatch trace, host identity, visual/compute output oracle, firewall, runtime chain, or strict ledger closure.

2026-07-01 broad visual-oracle coverage hardening follow-up: matrix-level broad-library readiness now counts visual coverage only from full-runtime rows whose normalized output-oracle facet is accepted with `kind=visual_oracle`; accepted visual artifacts or decoded image evidence attached to a compute-only row no longer satisfy `broad_acceptance_requires_visual_oracle_rows`. Smoke coverage now builds a four-backend portfolio whose rows retain accepted visual artifacts but declare accepted `compute_oracle` output facets, and broad readiness correctly reports `visualOracleTargetCount=0`, empty `visualTargets`, and the visual-oracle open gap. Verification passed matrix smoke `gpu-validation-matrix-ledger:sha256:86dabc7fc20456c291a0138a1ce431d924531b5a6d9fda994682f310efffcbb7` and full validation-matrix self-check `gpu-validation-matrix-ledger:sha256:b4348b9af56da1f7cd538cdf62bd657f1181fb394f70534fd5c15224469a2931`. This is generic visual-proof hardening; it does not turn screenshots, artifact presence, target names, profile IDs, or compute proof cards into visual GPU HMR acceptance.

2026-07-01 explicit output-oracle closure hardening follow-up: validation-matrix row safety now fails closed when the normalized output-oracle facet is absent or has an unknown kind instead of falling back to compute evidence. A compute proof card or `computeCardOnlyProofAccepted` flag can support scoped coverage diagnostics, but it cannot satisfy `gpu_hmr_success_requires_accepted_output_oracle_facet` without an explicit accepted `kind=compute_oracle` or `kind=visual_oracle` facet. Smoke coverage forges a full-runtime OpenCL row with compute-card-only evidence and no output-oracle facet; the row remains rejected with the output-oracle safety gate. Verification passed matrix smoke `gpu-validation-matrix-ledger:sha256:d7bef4c1eaa3ad420dc2e2c2bb65b4c4f0acc8b722213a09b2c7ad0d9c28aa7e` and full validation-matrix self-check `gpu-validation-matrix-ledger:sha256:b4348b9af56da1f7cd538cdf62bd657f1181fb394f70534fd5c15224469a2931`. This keeps rendered cards, screenshots, serialized flags, and unknown oracle declarations from substituting for post-epoch output proof.

2026-07-01 source-first visual broad-readiness gate follow-up: validation-matrix broad readiness now also requires at least one accepted source-first visual full-runtime row. The row must bind accepted typed `synthi.gpu.hmr.agent_split_source_first_ingestion.v1` provenance, support-only async visual/CAS evidence with `proof_ready=true`, CAS worker input acceptance, native image dependency binding, accepted visual artifacts, accepted `visual_oracle` output facet, and strict runtime visual authority on a row that already passed full-runtime ledger and safety checks. The selection is retained as `synthi.gpu_hmr.source_first_visual_broad_readiness_predicate.v1`, with authority `matrix_static_source_first_visual_predicate_not_project_name_whitelist`, `targetNameIndependent=true`, empty `projectNameWhitelist` and `specificTargetIdsAllowed`, predicate hash `sha256:6b31a1b7e1d17ca9344e551f72d30441727398a424518f91aa5d6fb60c1b9165`, and explicit rejection of support facets that claim GPU HMR, runtime, or dispatch authority. A matrix with strict HIP/OpenCL/Vulkan/WebGPU rows, adversarial refusals, and direct arbitrary cold-path intake still remains closed without this source-first visual proof.

2026-07-01 user-owned source-first visual broad-readiness hardening: the source-first visual broad gate now also requires explicit direct/user-owned source authority: `direct_source_url_commit`, `direct_local_git_repo_path`, `user_source_files`, or `workspace_source_files`. The previously accepted realistic raytrace rows used `profile_source_files`, so they remained scoped generated/profiled ROCm/HIP visual proof and did not satisfy broad arbitrary-user readiness; the ambiguous default `cli_or_env_direct_source` is also excluded until normalized into a URL/local-git identity or user/workspace file manifest. Retained matrix recompute `gpu-validation-matrix-ledger:sha256:b43f8f422ca3572d0ea9d137688598a1b1b5fc7adef13604c933507494df52b1` had 96 rows, direct random cold-path targets `local-user-project` and `direct-wgpu-materialized-event-template`, `sourceFirstVisualRowCount=0`, and broad readiness `accepted=false` with gaps `matrix_level_broad_generalization_proof_not_present`, `broad_runtime_rows_missing`, and `broad_acceptance_requires_source_first_visual_full_runtime_row`. This refusal state is superseded by the direct user-owned source-first visual run below and the later explicit-source coverage gate above.

2026-07-01 direct user-owned source-first visual follow-up: `proof:agent-split:source-first` can now consume an explicit direct source manifest through `SYNTHI_GPU_AGENT_SOURCE_MANIFEST_PATH` / `SYNTHI_GPU_AGENT_DIRECT_SOURCE_MANIFEST_PATH`, with optional `SYNTHI_GPU_AGENT_SOURCE_ROOT` and source authority supplied by `SYNTHI_GPU_AGENT_SOURCE_AUTHORITY` or the manifest itself. The runner can ingest generic direct-source authority labels, but broad readiness and source-first plan coverage now count only explicit `direct_source_url_commit`, `direct_local_git_repo_path`, `user_source_files`, or `workspace_source_files`; unsupported or ambiguous authorities such as `profile_source_files` and `cli_or_env_direct_source` are refused for those gates. The live run `gpu-agent-split-1782857972436` used `sourceAuthority=user_source_files`, seeded `src/main.cpp` plus `src/scene_config.h` from the direct manifest, preserved the quoted include closure, generated explicit module files/device roles, and closed strict visual runtime proof for two hot deltas. It produced source-first ingestion proof `agent-split-source-first-ingestion:sha256:0ae316fea86ed97fca27833d76158cdb8d7da5bbc2b4809f37bfc3ccf9b31a1d`, cold compile proof `gpu-proof:832beee637c93a2ac9be011db2775791e4df29bd1dc53ca98538cb1a3cca71c5`, hot delta 1 runtime proof `gpu-runtime-proof:sha256:78c905b5fee0a02c0e99d15e32cb90c6cd13eb315d28b87d5c59ace5e6d7783e`, and hot delta 2 runtime proof `gpu-runtime-proof:sha256:edea80e28b4c7e844e0b2e0a088afa2dcda1e71001434faf9ced4114ac02ccb5`. Visual proof stayed byte-backed and deterministic: hot delta 1 changed `73.75%` with `mean_abs=18.37`, hot delta 2 changed `99.50%` with `mean_abs=37.27`, while control deltas stayed effectively unchanged. The negative ABI edit still refused before GPU HMR acceptance. The latest large-cold-path size-gate matrix now uses these rows as the required direct/user-owned source-first visual lane for broad readiness. This is not a production acceptance claim for every arbitrary GPU project; each project still needs same-process loader, epoch, dispatch, host identity, visual or compute output oracle, CPU/full-rebuild/restart firewall, and strict proof-ledger closure.

2026-07-01 saved validation-matrix refresh after direct arbitrary cold-path probes, the non-whitelist direct-input evidence audit, source-derived backend declaration hardening, content-backed build metadata hardening, and row-local broad/scope separation: `gpu-validation-matrix-ledger:sha256:70a59fb470f0b433993ec70cc699a3cb47efdfda0cf3d81c1185df9e09225e59`, JSON `mcp/synthi-mcp/.gpu-hmr-test-logs/validation-matrix/gpu-hmr-validation-matrix-20260701T095015Z.json`, 114 rows, 19 accepted full-runtime GPU HMR, 0 broad library-agnostic full-runtime GPU HMR, 19 scoped full-runtime GPU HMR, 19 all full-runtime, 74 refusals, 8 cold splits, 8 preflight-only rows, 2 deterministic fission rows, 3 visual-profile rows, and 0 included unproven rows. Scope breakdown: `generated_rocm_hip_preview_visual: 4`, `hip_module_declared_compute_readback: 2`, `opencl_declared_compute_readback: 2`, `vulkan_declared_pipeline_visual: 1`, `webgpu_declared_compute_readback: 2`, and `webgpu_declared_pipeline_visual: 8`. The current Flow visual rerun contributes two strict visual full-runtime rows for `generated-gpu-split:3e2e1e99e0bfca5a804d336c`, but those rows carry `sourceAuthority=builtin_fixture_source`; they are regression/visual coverage, not the arbitrary-user source-first broad gate. Aggregate broad readiness includes two direct `user_source_files` visual rows and five large direct arbitrary cold-path rows selected by the recorded non-whitelist/content-backed predicates, while accepted runtime rows remain scoped and contribute as `matrixGeneralizationRuntimeRows=19` rather than row-local broad rows; the aggregate guard reports `broadRuntimeRowsMissing=false`, and the row-local guard reports `rowLocalBroadRuntimeRowsMissing=true`. The cold predicate requires accepted `synthi.gpu_hmr.random_cold_path_direct_source_input.v1` evidence, `direct_cli_or_env_input_mode_observed`, `source_derived_backend_candidates_observed`, `candidate_backend_declarations_diagnostic_only`, `build_metadata_discovery_accepted`, `build_metadata_content_evidence_accepted`, `build_metadata_content_schema_authority_accepted`, `build_metadata_content_byte_hashes_observed`, and `build_metadata_content_hash_observed`. The source-first visual predicate requires direct/user-owned source authority, accepted source-first ingestion, async visual proof-ready/CAS worker input acceptance, native image dependency binding, accepted visual artifacts, strict runtime visual authority, visual output-oracle acceptance, and no success claims from support facets; it explicitly ignores target ID, profile ID, fixture name, project name, source basename, and visual scene name. The qualifying cold rows are `direct-llama-cpp-current-template`, `direct-filament-user-path-current-template`, `direct-vulkan-samples-user-path-current-template`, `direct-bevy-user-path-current-template`, and `direct-wgpu-user-path-current-template`. This is aggregate matrix readiness, not a claim that Filament, Vulkan-Samples, wgpu, Bevy, llama.cpp, MIOpen, CK, hipBLASLt, HIPRT no-shim apps, or any arbitrary app is accepted without its own runtime proof gates.

2026-06-30 arbitrary cold build-metadata discovery follow-up: accepted unprofiled source intake now emits a support-only `synthi.gpu_hmr.cold_build_metadata_discovery.v1` facet with detected build-system families, root build files, source-file counts, backend candidates, and a discovery hash. The facet authority is `build_metadata_discovery_only_not_gpu_hmr_success`; it can refine a refusal from `build_metadata_unverified` to `semantic_build_metadata_verification_missing`, but it cannot satisfy a runtime profile contract, compile database verification, loader, epoch, dispatch, host identity, output oracle, or strict ledger proof. The direct wgpu run retained manifest `sha256:1632b2625ab0522639fddf5027fb81216bf9636c26c03b57d4fc50ab0fbf7b6d`, accepted source intake, detected `cargo` and `npm_or_node` build systems across 34 build signals, detected `metal`, `vulkan`, and `webgpu_wgsl` backend candidates, emitted discovery hash `sha256:0a595a95d5df5ab88d9e8ac165b43f24e25a4802e41629c588f8d900a7062eaf`, and still refused GPU HMR with all strict runtime gates missing.

2026-06-30 arbitrary cold build-metadata content follow-up: cold arbitrary source intake now reads a bounded set of detected build files from the immutable source tree and records support-only `synthi.gpu_hmr.cold_build_metadata_content.v1` evidence. GitHub-hosted immutable commits use the GitHub blob API; clean local git checkouts use `git show <commit>:<path>`. Each selected build file is byte-counted, SHA-256 hashed, family-classified, and summarized without executing build commands or trusting project names. The facet authority is `build_metadata_content_bytes_only_not_gpu_hmr_success`; it can refine a refusal to `semantic_build_metadata_execution_missing`, but it cannot satisfy compile database verification, a runtime profile contract, same-process loader, epoch publication, dispatch trace, host identity, output oracle, firewall, or strict ledger closure. Fresh direct arbitrary runs exercised two large user-style projects: wgpu retained manifest `sha256:3fcfee8fd5769eba8c9108649c9ec27dbdfc146c0bec7f6c51fea55e5a84a032` with content evidence `sha256:1aa362d604b10f49da4cd2b79a2242c9a4710dd011a8c4e60620e8e07e922b07`, and Bevy retained manifest `sha256:cf805567cdf23e2967a7bff3e384c256609f0d0e5d7b85f9b27ac499572c4c97` with content evidence `sha256:7d7447b71c4952b5e7957e585c7a9dd60acf11f946261b04d1da118c5dd7faa4`. Both read and hashed 12 build files, detected `cargo` and `npm_or_node`, and correctly stayed `unprofiled_arbitrary_project_cold_intake_refused` with `acceptedForGpuHmr=false` and `gpuHmrSuccess=false`.

2026-06-30 arbitrary cold git-fallback cleanup follow-up: the cold-path runner can now explicitly force the materialized `git_fetch_depth_1_blobless` source-intake path through `SYNTHI_GPU_HMR_UNPROFILED_FORCE_GIT_FALLBACK=1`, and build-file content evidence can read from that materialized git repo with the same pinned `git show <commit>:<path>` mechanism used for clean local checkouts. Long git fetch/listing attempts now fail closed through bounded timeout finalization, destroy child pipes, release process handles, and run a path-targeted Windows cleanup facet with authority `source_intake_timeout_cleanup_only_not_gpu_hmr_success`. A bounded forced-fallback wgpu run retained final manifest `sha256:bb51164348974cf42630416f71289f72045ca5a837b15f62a6a38946debacd00` instead of leaving only a pending artifact; it failed closed at `source_intake_listing_failed`, recorded source-intake facet `sha256:8ea019ed7b01ca11e69c65a7c1b2a3478a805d9f2612c275cadfba6ef0b6e37b`, `timeout-forced-finalize`, `timeoutKillAttempted=true`, cleanup of git PID `34712`, and no leftover git processes. This is operational refusal evidence only: timed-out git fallback, cleanup, partial listing stdout, and forced fallback flags cannot satisfy source-tree intake, build metadata verification, runtime profile, loader, epoch, dispatch, host identity, output oracle, firewall, or strict ledger proof.

2026-06-30 arbitrary cold size-free tree follow-up: materialized/blobless git source intake now uses size-free `git ls-tree -r --full-tree` for fallback listings instead of `git ls-tree -l`, so tree identity can be collected without forcing blob-size lazy fetches. The parser accepts both size-bearing and size-free `ls-tree` rows and records `byteLengthMode=unknown_avoids_blob_fetch` when sizes are intentionally absent. Local materialized checkouts can opt into the same path with `SYNTHI_GPU_HMR_LOCAL_GIT_NO_SIZE=1`, and blob content reads set `GIT_NO_LAZY_FETCH=1` unless `SYNTHI_GPU_HMR_BLOBLESS_CONTENT_FETCH=1` is explicitly supplied. A no-network materialized wgpu run retained manifest `sha256:a722a52c95c753a43ffd592f7303703b3a720e4cce603e5c1a0b64f82302bbc6`, accepted source intake for 2,445 files with transport `local_git_ls_tree_no_size_clean_worktree`, `totalKnownBytes=0`, detected `cargo` and `npm_or_node` plus `metal`, `vulkan`, and `webgpu_wgsl`, and refused content proof because all 12 selected build-file blobs were unavailable without lazy fetch. The result stayed `acceptedForGpuHmr=false` and `gpuHmrSuccess=false` with the normal runtime-profile, loader, epoch, dispatch, host-identity, output-oracle, and strict-ledger gaps.

2026-06-30 arbitrary cold runtime-boundary expectation follow-up: accepted cold source intake now derives a support-only `synthi.gpu_hmr.cold_runtime_boundary_expectation.v1` facet from backend candidates, build metadata discovery, runtime-boundary hints, and oracle hints. The facet enumerates required boundary stages, expected runtime event families, acceptable oracle kinds, per-backend obligations, and missing runtime evidence gaps, with authority `runtime_boundary_expectation_only_not_gpu_hmr_success`. It remains `acceptedForGpuHmr=false`, `gpuHmrSuccess=false`, and `canSatisfyRuntimeProof=false`; it tells an arbitrary project which runtime events it must expose, but it cannot satisfy loader, epoch, dispatch, host identity, output oracle, firewall, or strict ledger proof. A no-network materialized wgpu run retained manifest `sha256:32af5c871c225599ff8a5cd3b10e812cde3338b9b1a229206bde389354b163b2` and expectation hash `sha256:4f954bd649c9b2e9575b1901210869102e97beaeb63e725e8c3aa7c378fc90c8`; it accepted source intake and runtime-boundary expectation for `metal`, `vulkan`, and `webgpu_wgsl`, required stages including artifact transport, pipeline binding/recreate, epoch publication, dispatch trace, host identity, output oracle, CPU/full-rebuild/restart firewall, and strict ledger, and still refused GPU HMR with the normal strict runtime gaps.

2026-06-30 unprofiled source-tree intake follow-up: unprofiled arbitrary candidates now run support-only source-tree intake before refusal. GitHub-hosted candidates use the generic recursive Git tree API for an immutable commit, falling back to shallow `git fetch --depth=1 --filter=blob:none` for non-GitHub remotes. The retained `llama.cpp` run inspected commit `4f31eedb0ccf546b7e8d6bb243b170f12522f54d` through `github_git_tree_api_recursive`, counted 3,011 files and 154,991,455 known bytes, detected build files plus GPU/backend path signals for `cuda`, `hip_rocm`, `metal`, `opencl`, `sycl`, `vulkan`, and `webgpu_wgsl`, and produced listing hash `sha256:8fa51e93e94b52ea3248e2e3e00c0ef0ed401d17e6d23d35336f3adfaaccd4f3` with source-intake facet `sha256:6cef63952038b3d7cd6c4e9be642dc841ddf691ea6209c4e9d4cbad138cfbee2`. Final random cold-path manifest `sha256:458e284f1861792ec270b96f3ef8842e108a46a4c45d0a5eb107a43a0c35cb4c` references pending manifest `sha256:8e8a3cc1c7fed69e73d2c0dacac95e3efcce33ea29911e81c5f640df34094ca2` and still refuses acceptance because build metadata is not semantically verified and no same-process loader, epoch, dispatch, host identity, output oracle, or strict runtime ledger exists.

2026-06-30 real ROCm timeout-source audit follow-up: large real ROCm ML package scripts now label whether `SYNTHI_REAL_ROCM_UPSTREAM_TIMEOUT_MS` came from the caller or the package default before applying the default. The runner records `timeoutSource`, `timeoutEnvValue`, `timeoutMs`, `timeoutSeconds`, and `killAfterSeconds` in the worker lifecycle timeout-control facet, and validation-matrix ingestion recomputes the timeout math/source consistency. A caller-env timeout whose retained value silently becomes the two-hour default now fails closed with `real_rocm_worker_lifecycle_timeout_control_env_value_mismatch` instead of looking like ordinary long-run orchestration. This is audit/refusal evidence only: timeout source and cleanup evidence cannot satisfy artifact transport, epoch publication, dispatch trace, host identity, output oracle, firewall, strict runtime proof, or proof-ledger success.

2026-06-30 adapter-overlay runtime-chain closure follow-up: accepted runtime-adapter boundary events can now close generic runtime-chain fields after they are merged with the proof-ledger record, instead of requiring the base ledger record to already contain the same adapter-supplied artifact transport, epoch, dispatch-table, output-target, and host-identity details. The matrix still rejects overlay conflicts against ledger-native fields, weak host identity, missing target-process provenance, forged adapter/result/transport authority, missing app-hook stages, output-oracle byte failures, firewall gaps, missing strict runtime proof artifacts, and missing ledger success. Adapter events therefore remain evidence inputs, not authority shortcuts, but arbitrary-project adapters can now bridge the runtime boundary they were designed to expose.

2026-06-30 runtime output-oracle evidence resolution follow-up: real ROCm runtime `output_oracle` boundary evidence can now resolve the output-oracle contract/profile gate through `selectedSource=runtime_output_oracle_evidence`, but only after the same file-backed compute or visual artifact verifier accepts the bytes. Compute evidence must pass raw readback, schema, deterministic slice, checksum, and proof-card verification; visual evidence must pass accepted visual artifact validation. The generated contract/profile records are evidence-only (`runtime_output_oracle_evidence_not_declaration`, `acceptedForGpuHmr=false`, `gpuHmrSuccess=false`, `canSatisfyRuntimeProof=false`) and cannot authorize GPU HMR without strict runtime proof, ledger, runtime-chain, app-hook, firewall, and output-oracle closure. Runner self-checks cover accepted file-backed compute evidence plus forged-hash refusal; matrix smoke covers the new selected source and rejects unsupported serialized success sources.

2026-06-30 native observer host-identity breadcrumb follow-up: the real ROCm native launch observer now emits generic `[gpu-runtime-boundary] host_identity` breadcrumbs with explicit `process_id`, runner-process identity, and stream/context/queue identity around observer-ready, native launch attempt, and native launch observed events. The shared runtime host-identity parser consumes explicit `process_id`, `device_uuid`, `context_id`, and `queue_id` fields instead of depending only on runtime-session naming conventions. Same-process and native-runtime bridge gates were tightened so a host-identity line or PID alone cannot satisfy `host_identity`: preservation now requires the host-preservation proof or explicit stable identity evidence. The self-check proves native observer breadcrumbs close only the diagnostic `host_identity_not_observed` gap while still refusing without device identity, generation/role preservation, artifact transport, epoch publication, dispatch, output oracle, firewall, strict runtime proof, and ledger closure.

2026-06-30 native runtime trace facet follow-up: the real ROCm runner now derives a support-only `synthi.real_rocm.native_runtime_trace.v1` facet from observed native launch, artifact transport, and output-oracle runtime evidence, and the validation matrix passes that row-level `runtime_trace` through the existing native runtime trace gate. A native launch observation can now become a canonical dispatch-boundary event for diagnostics, but the facet remains `acceptedForGpuHmr=false`, `gpuHmrSuccess=false`, and `canSatisfyRuntimeProof=false`; missing loader or output boundaries remain explicit `native_runtime_*_missing` gaps, and full-runtime authority still requires an accepted strict runtime proof artifact, recomputed ledger, artifact transport, epoch, same-process identity, output oracle, firewall, and runtime-chain closure.

2026-06-29 packaged large-ROCm runtime-adapter template follow-up: the MIOpen, Composable Kernel, and hipBLASLt large-ML profiles now declare the same generic `runtimeAdapter.template=runtime_boundary_log_harvest_v1` instead of inline project-specific adapter commands. The runner expands that built-in POSIX template, exports the profile ID, upstream run command, native observer path, run-log path, and worker-side adapter result path, then writes a refusal-only `synthi.gpu_hmr.runtime_profile_adapter_result.v1` manifest that can harvest real `[gpu-runtime-boundary]` lines if the upstream lifecycle naturally emits them. The template emits `acceptedForGpuHmr=false`, `gpuHmrSuccess=false`, `canSatisfyRuntimeProof=false`, and either missing-boundary or strict-runtime-proof blocking gaps; profile IDs are required to be stable safe identifiers. Package and runner self-checks reject inline packaged adapter commands, unsafe result paths, unknown templates, missing command/template declarations, unsafe profile IDs, and any adapter-profile success authority fields. This is generic large-project evidence plumbing only, not MIOpen/CK/hipBLASLt acceptance and not arbitrary-project acceptance by template.

2026-06-29 packaged adapter-result self-containment follow-up: `runtime_boundary_log_harvest_v1` now writes harvested `[gpu-runtime-boundary]` lines into the refusal-only adapter result manifest as `runtimeBoundaryLines` / `runtime_boundary_lines` and `adapterRuntimeBoundaryLines` / `adapter_runtime_boundary_lines`, in addition to echoing them for direct runtime-adapter execution evidence. The bridge import already consumes those fields, and the real-ROCm self-check now verifies imported boundary lines preserve exact line content. A POSIX-template execution self-check runs where `sh` is available and is allowed to skip only when the host blocks or lacks POSIX shell execution. This makes adapter results self-contained enough for arbitrary-project audit and replay while still leaving every success flag false until strict runtime proof, app-hook stages, runtime chain, firewall, and output oracle close.

2026-06-29 adapter identity binding follow-up: runtime-adapter execution and worker-result transport facets now preserve `adapterTemplate` and content-addressed `adapterCommandHash` fields, and validation-matrix ingestion carries those fields into row evidence. Imported runtime-profile adapter results are also row-bound: the bridge `strictRuntimeProofId` and `proofLedgerId` must match the strict runtime proof artifact and recomputed proof ledger used by the row, or the matrix adds `real_rocm_runtime_profile_adapter_result_runtime_proof_id_mismatch` / `real_rocm_runtime_profile_adapter_result_proof_ledger_id_mismatch` and refuses acceptance. The adapter-boundary smoke fixture asserts that both direct execution and copied adapter-result transport retain the same `runtime_boundary_log_harvest_v1` identity and command hash while staying non-authoritative, then proves a replayed adapter result with mismatched proof IDs remains `unproven`. This makes large-project adapter evidence auditable by template/hash and row proof identity instead of repository name, without converting template identity, command success, copied result files, or result transport into GPU HMR proof.

2026-06-30 runtime-adapter boundary import hardening follow-up: boundary-only runtime-profile adapter results can now feed generic `[gpu-runtime-boundary]` stage lines into the runtime evidence stream even when their own strict-proof summary is still refusal-only, but only as support evidence and only when the matrix independently recomputes complete coverage for all five stages `artifact_transport`, `epoch_publication`, `dispatch_trace`, `host_identity`, and `output_oracle`. The matrix no longer trusts serialized `acceptedAsBoundaryEvidence=true` or a supplied empty `boundaryImportBlockingGaps` list; it recomputes line hashes, coverage, non-strict gaps, and failed gates from the actual boundary lines. A partial boundary-only bridge that omits `output_oracle` now remains `unproven` even with a separate successful strict ledger. Runtime boundary parsing also accepts quoted whitespace paths and common adapter aliases for artifact hashes, checksum fields, sessions, and output targets while recording rejected candidate reasons. This removes a circular adapter-result proof dependency without creating a declaration-based success path.

2026-06-30 full-runtime row identity binding follow-up: validation-matrix row safety now recomputes a generic full-runtime row/ledger identity binding for accepted GPU HMR rows. The matrix requires the ledger record project identity and acceptance-contract project identity to agree when both exist, and requires the matrix row target to be either directly bound to the ledger project/edit identity or explicitly bound as a source-first/profile alias through accepted source-first provenance plus validation-profile evidence that references the row target and the same strict ledger/runtime proof IDs. Serialized `fullRuntimeRowIdentityBinding` data is diagnostic only; row safety recomputes the binding instead of trusting it. Smoke coverage rejects a coherently retargeted source-first replay that recomputes the source-first provenance target but reuses the old strict runtime ledger without row-target evidence. This is generic replay hardening, not a target-name branch.

2026-06-30 matrix-derived same-process oracle follow-up: validation-matrix ingestion can now derive a `synthi.gpu_hmr.same_process_runtime_oracle_contract.v1` same-process oracle only when the serialized contract is absent and accepted generic adapter boundary evidence is present. The derived contract is computed from accepted app-hook stage events, accepted target-process provenance, accepted runtime-chain closure, strict runtime proof artifact closure, firewall evidence, and a recomputed `synthi.gpu_hmr.output_oracle_binding.v1` proof-ledger binding that must match dispatch ID and output target across dispatch and output events. Serialized same-process contracts, when present, are still validated and can fail. The smoke matrix now covers both a positive derived same-process adapter-boundary row and a forged derived row with a mismatched proof-ledger output target; the forged row remains `unproven`. This is generic matrix reconciliation for arbitrary-project adapter evidence, not a declaration shortcut, project-name branch, or broad ROCm acceptance.

2026-06-30 runtime-boundary support selection follow-up: validation-matrix row selection now uses a non-authoritative `runtimeBoundarySupportScore` after outcome priority and attempt-completeness, before file timestamp. The score preserves richer real-ROCm refusal attempts that contain schema-correct, evidence-only runtime-adapter boundary lines, including incomplete but diagnostic `[gpu-runtime-boundary]` coverage, without converting that support into GPU HMR success. Accepted execution support requires `status=runtime_adapter_executed` plus real boundary lines; incomplete diagnostic support is lower priority and only counts when the adapter/result/coverage facets do not claim GPU HMR, runtime, or dispatch authority. Zero-line `runtime_adapter_not_declared` facets and forged success-claiming adapter evidence score zero. The current MIOpen retained row selection now keeps the richer boundary-line refusal artifact while preserving `acceptedForGpuHmr=false`, `gpuHmrSuccess=false`, and the incomplete-coverage gate.

2026-06-29 native-boundary stage-candidate follow-up: real ROCm native launch observations now surface per-stage candidate rows for `dispatch_trace` and `host_identity` when the native observer sees function resolution, launch attempts, launch observations, runtime sessions, or observer-ready process context. These candidates are explicitly `candidate_native_boundary_evidence_only_not_runtime_proof`, keep `runtimeObserved=false`, keep all required proof kinds missing, and feed app-hook materialization only as authoring breadcrumbs. They cannot satisfy `real_rocm_runtime_stage_obligations`, same-process runtime oracle, or broad acceptance without the normal artifact transport, epoch publication, dispatch trace, host identity, output oracle, firewall, runtime chain, strict runtime proof artifact, and ledger closure.

2026-06-29 HIPRT contract-facet follow-up: HIPRT warm visual and HIPRT run-mode rows now derive a first-class `synthi.gpu_hmr.hiprt_contract_evidence.v1` facet from the row or strict runtime artifact acceptance contract. The facet requires the plan-required `kernel_entry`, `scene_or_bvh_handles`, `framebuffer_handle`, `material_or_geometry_buffers`, `camera_state_hash`, `same_process_reload_hook`, and `visual_oracle` fields plus field-level evidence refs before a HIPRT visual profile can remain `visual_profile_accepted`. The facet is evidence-only (`acceptedForGpuHmr=false`, `gpuHmrSuccess=false`), and complete HIPRT contract evidence does not bypass `source_adapted_profile_not_no_shim_gpu_hmr`; missing contract fields keep the row unproven with `hiprt_contract_required`. This makes realistic HIPRT evidence auditable without accepting source-adapted profile hooks or project-name-specific rows.

2026-06-30 HIPRT runtime-boundary app-hook bridge follow-up: HIPRT runtime profiles can now carry generic `adapter.runtimeBoundaryEvents` or a runtime-boundary event manifest path. The warm HIPRT proof runner recomputes a support-only `synthi.gpu_hmr.hiprt_runtime_boundary_app_hook.v1` facet from the five app-hook stages `artifact_transport`, `epoch_publication`, `dispatch_trace`, `host_identity`, and `output_oracle`, requiring exact artifact hash, epoch, dispatch ID, process identity, stream/device identity, and visual image-hash matches before the facet can support a non-source-adapted strict runtime proof. Validation-matrix ingestion recognizes this app-hook disclosure separately from the older source-adapted profile probe disclosure, rejects authority-claiming or incomplete app-hook evidence, and still recomputes visual bytes, ledger invariants, runtime artifact strict gates, HIPRT contract fields, CPU/full-rebuild/process-restart firewall fields, and source-adaptation status. The self-check accepts only a non-source-adapted app-hook fixture with real PNG visual proof and refuses both a source-adapted fixture and a missing-output-oracle fixture. Existing live HIPRT source-adapted visual profiles remain `visual_profile_accepted` or refused, not broad HIPRT app acceptance.

2026-07-01 OIDN output-oracle support follow-up: the OIDN/HIP preflight runner can now consume a generic file-backed `synthi.gpu_hmr.oidn_output_oracle.v1` manifest through env or CLI. The verifier reads noisy input, denoised output, and optional expected-output bytes only under approved roots, checks byte length and SHA-256, requires denoised output to differ from noisy input, requires expected-output hash agreement, and rejects any GPU HMR/runtime authority claims. Validation-matrix ingestion recomputes the OIDN output-oracle facet shape before honoring a serialized OIDN output-proof flag. Even an accepted OIDN output oracle remains `preflight_only` with `acceptedForGpuHmr=false`, `gpuHmrSuccess=false`, and strict runtime-ledger gaps; it cannot satisfy GPU HMR acceptance without same-process loader, epoch, dispatch, host identity, firewall, and proof-ledger closure.

2026-07-01 OIDN output-oracle matrix hardening follow-up: validation-matrix ingestion now reopens the OIDN oracle manifest and referenced noisy/denoised/expected output files under the repo/artifact roots, recomputes readable byte lengths and SHA-256 hashes, rejects serialized accepted facets with mismatched file or manifest hashes, and preserves the expected-output hash as a first-class field. A new `oidn_hip_output_oracle_support` coverage entry reports byte-verified output evidence as `preflight_only` with authority `oidn_output_oracle_support_only_not_gpu_hmr_acceptance`, while the existing `oidn_hip_output` coverage remains missing or refused until strict same-process runtime proof, epoch, dispatch, host identity, firewall, output oracle, and proof-ledger closure all pass. Forged serialized output-oracle success now stays runtime-preflight-only with explicit recomputed-hash refusal gaps.

2026-06-30 HIPRT target-progression support-only hardening follow-up: `gpu-hmr-hiprt-target-progression-probe.mjs` now emits explicit support-only authority on both its proof record and target-progression ledger records: `acceptedForGpuHmr=false`, `gpuHmrSuccess=false`, `canSatisfyRuntimeProof=false`, and `targetProgressionEvidenceOnly=true`. The packaged self-check verifies that retained visual evidence hashes come from actual image bytes and that the ledger cannot masquerade as final GPU HMR acceptance. The npm package dry-run includes the generic probe and HIPRT host/kernel support files, but this remains target-progression audit plumbing only; HIPRT no-shim acceptance still requires application scene/BVH/framebuffer reload-hook proof, same-process artifact load, epoch publication, dispatch trace, host identity, visual oracle bytes, firewall closure, and a strict runtime proof ledger.

2026-06-29 source-first exact-manifest follow-up: source-first/no-precompiled ingestion now scans every submitted initial seed file for Synthi ABI markers instead of scanning only the entry source string. The runner emits a per-file `sourcePurityManifestHash` plus a projected `sourcePurityInitialManifestHash`, and validation-matrix ingestion requires that projected hash to equal the initial compile manifest hash. Missing, incomplete, dirty, or extra scanned files reject with source-first purity gates; this is generic manifest binding, not a project branch. Fresh source-first rows must be rerun with this evidence before they can count under the stricter matrix.

2026-06-29: large real ROCm ML npm proof scripts now keep their exhaustive two-hour upstream timeout as a default instead of a forced assignment. Caller-provided `SYNTHI_REAL_ROCM_UPSTREAM_TIMEOUT_MS` values survive the script wrapper, so interactive bounded proof runs can use the same profile-driven scripts without bypassing the runner. The package-script smoke check verifies the default remains overridable while strict runtime proof and native observer gates stay enabled. Real ROCm proof-scheduling self-checks also cover the bounded-wait case where a user-requested timeout below the diagnostic fast-fail budget must stay bounded instead of being inflated.

2026-06-29: large real ROCm profiles can now declare generic external header prerequisites through `externalHeaderPrerequisites`. Each prerequisite is content-addressed by source repo URL plus exact commit, materialized under the shared CAS root, optionally built/installed through a declared `cmake_install` recipe, inspected for required headers, and exposed to CMake only through `${REAL_ROCM_EXTERNAL_INCLUDE:<id>}` after the header evidence is accepted. The facet authority is `external_header_dependency_evidence_only_not_gpu_hmr_success`: it can unblock a real upstream build prerequisite without adding a shim, symlink, vendored success branch, or project-specific acceptance path. It remains `acceptedForGpuHmr=false`, `gpuHmrSuccess=false`, and `canSatisfyRuntimeProof=false` until the normal artifact transport, epoch publication, dispatch trace, host identity, output-oracle, firewall, and strict runtime proof gates close.

2026-06-29 matrix follow-up: validation-matrix ingestion now normalizes `real_rocm_external_header_prerequisites` / `externalHeaderPrerequisites` from top-level real ROCm reports, summaries, runtime proof artifacts, and evidence blocks. A present facet must keep dependency-only authority, schema-correct aggregate and child records, exact immutable commits, accepted materialization/install/header inspection evidence, content-addressed header-set hashes, and no blocking gaps. The matrix rejects forged aggregate or child prerequisite records that claim GPU HMR acceptance, GPU HMR success, runtime authority, or dispatch authority, including when attached to an otherwise accepted row. This preserves the arbitrary-project dependency mechanism without converting build prerequisite resolution into runtime proof.

2026-06-29 matrix single-frame visual offload follow-up: cold/single-frame visual proof and diff-frame visibility recomputation now use the async visual proof worker by default with `recomputeEngine=matrix_async_visual_worker_rgba`, instead of running a local matrix-process `sharp` raw loop. The local path remains only an explicit fallback for callers that disable async metrics. Smoke coverage asserts accepted worker-backed single-frame cold proof, off-main-thread worker identity, and fail-closed worker results. This is a performance/orchestration change only; single-frame proof remains cold/run-mode evidence and cannot authorize GPU HMR without strict runtime-ledger closure.

2026-06-29 async visual proof job follow-up: visual proof scheduling now has a generic two-phase API. `createAsyncVisualProofJob` writes before/after frames into CAS, emits a content-addressed `synthi.gpu_hmr.async_visual_proof_job.v1` manifest with `eventType=proof_pending`, and marks the job `acceptedForGpuHmr=false`, `gpuHmrSuccess=false`, and `proofAuthority=async_visual_job_manifest_only_not_gpu_hmr_acceptance`. `completeAsyncVisualProofJob` consumes that manifest and runs the existing async visual worker to produce `proof_ready` metrics. The agent-split visual runner records the pending job before awaiting completion, while strict proof still throws if the completed worker proof is not accepted. Pending manifests are scheduling/support evidence only and cannot satisfy async metrics, visual CAS support, or GPU HMR acceptance; validation-matrix smoke coverage includes a pending-only row that stays `unproven` with `async_visual_proof_pending_not_ready`.

2026-06-29 source-first include-closure follow-up: the deterministic/source-owned splitter now walks the submitted source tree's local quoted-include closure, extracts scalar `constexpr`/guarded constant blocks from included headers, and emits those constants into generated `shared.h` before compile. This fixed the source-first realistic raytrace split where `src/main.cpp` depended on `src/scene_config.h` constants such as `PIXEL_COUNT`, without hardcoding a profile name, constant name, or scenario. The same path records `constantSourcePaths` in the split report and is covered by a Python unit slice; local `py_compile` passed, while pytest was unavailable in this environment.

2026-06-30 source-first explicit-role follow-up: the source-first runner no longer invents default generated split roles such as `shared.h`, `core.cpp`, `gui.cpp`, `host_runner.cpp`, or vendor-default `device.hip` / `device.cu`. `manifestRolePaths` now requires explicit `compile_manifest.module_files` plus explicit `compile_manifest.gpu.device_roles`, and every device-role path must also be a declared generated module file. Generated split validation checks declared files and generic device entrypoint evidence through the manifest-derived granularity assessment, while fission host-source exclusions derive from declared non-device module files. The shared granularity library also stopped inferring a device translation unit from the vendor when no device role or explicit `module_files.device` exists. Self-checks reject the old default-file shortcut and undeclared device-role paths. This is source-first hardening only; it does not broaden scoped visual/runtime rows into arbitrary HIP app or library acceptance.

2026-06-30 source-first realistic raytrace visual refresh: the source-owned realistic raytrace profile now uses a closer deterministic camera, narrower lens, reduced fog washout, and updated content-addressed source/scene hashes (`source=sha256:20f72849bfe5ac1328a3bec28c39501eb78fe48cff6ecd48a86af81129bce96e`, `visualSceneManifestHash=sha256:bf1393aa93f4df9c8fe350f7d33be2a95b29d2748c2d6013a02e0d047eabbdf2`). The first rerun refused visual proof when post-HMR screenshots repeated the same frame sequence/hash, so `assertMcpScreenshot` now keeps sampling until it has distinct visible post-gate frame sequences instead of stopping on two stale visible samples. The accepted rerun `gpu-agent-split-1782807395401` started from source files without a precompiled project, produced source-first ingestion proof `agent-split-source-first-ingestion:sha256:78289c8b4fd60c317dd83e133945abd94d98ce1083434bf8986ef96e80b215b2`, accepted hot delta 1 proof `agent-split-run-mode-proof:sha256:2819ddc2e29fc656052e57b8e174c25a01036266aadd9c2dd02727010afc0f5a` with runtime proof `gpu-runtime-proof:sha256:9d773a0efd70c77ecbd9999f952b2649d236b5b5c658125b551c88ead7491295`, accepted hot delta 2 proof `agent-split-run-mode-proof:sha256:d81957ee16813624e0c0e7f2e3b3c454ae7d54189839f737c0ee47ee34a07ebe` with runtime proof `gpu-runtime-proof:sha256:6e547d5ee153ae48f16e856e07374014b048ae920c07f80d4ac019008af5b4ef`, visual deltas `changed=73.73%, mean_abs=18.37` and `changed=99.50%, mean_abs=37.25`, and negative edit refusal `agent-split-negative-edit-refusal:sha256:75c823f47ab4b28bf4d5d0631a3c6ea179746c7429c0705ca53633a0d75f69b2`. Local image inspection opened the fresh before, after, and diff PNGs; the scene is nonblank, closer, and visibly raytraced with foreground gems, reflections, shadows, storefront geometry, and a vehicle. This remains scoped generated/profiled ROCm/HIP visual GPU HMR proof, not arbitrary HIP application/library acceptance and not broad project acceptance.

2026-06-30 latest accepted source-first realistic raytrace no-precompiled rerun: `proof:agent-split:source-first:realistic-raytrace` now passes on the default runner path without `SYNTHI_GPU_WAIT_HMR_TIMEOUT_MS`. Workspace `gpu-agent-split-1782837775261` seeded `src/main.cpp` plus `src/scene_config.h`, preserved the quoted include closure, generated explicit module files/device roles under `.synthi/generated/gpu/`, and accepted strict visual runtime proof for two hot deltas. The run produced source-first ingestion proof `agent-split-source-first-ingestion:sha256:4cbb37a7b248720dbd5dc7e3b3be8d3f96f5af23b315a48d4ca7bd0408d4f660`, cold compile proof `gpu-proof:df58b9ddafc02401487992d5dcad3da10e6466174dafbcafc70f9c558456dac5`, hot delta 1 runtime proof `gpu-runtime-proof:sha256:95b7118d8dc6576fce67f86d7544ffc4aab49dcc1ebb71923d7b2b5ac5d01cab` with ledger `gpu-ledger-proof:sha256:878693032ed737890a166adeb4012ace13af23967b3f535362dc32474731cfa6`, and hot delta 2 runtime proof `gpu-runtime-proof:sha256:8fd173b95924f8bfc3e1e1268d4e2c36ea0bf9245059f0164227fcc540199be3` with ledger `gpu-ledger-proof:sha256:be57c47e3d978d5aeb6b59cbb0d7f4ca35de8bb18fcaff14a485c8550aeb6570`. Visual deltas were `changed=73.73%, mean_abs=18.40` and `changed=99.50%, mean_abs=37.25`; total validator wall times were `4.997s` and `3.951s` for the two hot deltas, with device compile times `14.46ms` and `30.95ms`. Local image inspection opened the before/after/diff PNGs and confirmed a nonblank realistic raytraced scene with foreground gems, reflective surfaces, storefront geometry, shadows, and vehicle geometry. This proves the no-precompiled source-first path for the scoped generated/profiled ROCm/HIP visual workload; it does not prove arbitrary HIP application/library acceptance without the same loader, epoch, dispatch, host-identity, output-oracle, firewall, and strict ledger closure.

2026-06-30 agent-split proof-wait retry, compile-proof gate, and cleanup follow-up: the source-first runner now retries strict `synthi_wait_hmr` only for bounded proof-finalization gaps such as `proof_state_missing`, `proof_ledger_missing`, or `runtime_proof_artifact_missing`, and records support-only `synthi.gpu_hmr.strict_proof_wait_retry.v1` evidence with `acceptedForGpuHmr=false`, `gpuHmrSuccess=false`, and `canSatisfyRuntimeProof=false`. The retry preserves the same compile dispatch timestamp, `since_ts`, module, selected generated path, edit id/hash, and strict proof contract; terminal rejections and `failed_fast` proof insufficiency still fail closed. The runner also records `synthi.gpu_hmr.requested_proof_state_gate.v1` so a top-level rejected wait can satisfy only the cold `gpu-hmr-compile-proven` boundary when structured validation, rank, immutable proof id, and proof artifact path all pass; rejected waits still cannot satisfy full-runtime, visual, output-oracle, or hot-device HMR gates. MCP startup cleanup now kills the spawned MCP process if `initialize` fails before `mcpState` exists, and startup waits use the generic MCP request timeout instead of a fixed 20 second cap. Self-checks cover proof-finalization retry, compile-proof gate adversarial cases, and MCP startup cleanup.

2026-06-30 superseded matrix after the stricter Vulkan host-runtime proof, OpenCL host-runtime proof, source-first explicit-role hardening, runtime-adapter boundary-import hardening, runtime-boundary event-manifest materializer, matrix-level broad-proof scaffold, include-closure rerun, and fresh bounded large-ROCm MIOpen refresh: `gpu-validation-matrix-ledger:sha256:e9ee4aaa7c6386b325780c2ddc0261df7e42337c3e9c1ac6b3b9b0c6ac634bd2`, JSON `mcp/synthi-mcp/.gpu-hmr-test-logs/validation-matrix/gpu-hmr-validation-matrix-20260630T133648Z.json`, 63 rows, 17 accepted full-runtime GPU HMR rows, 17 broad library-agnostic full-runtime GPU HMR rows by the then-current matrix-computed proof, 0 scoped full-runtime GPU HMR rows after broad matrix classification, 17 all full-runtime rows, 33 refusals, 7 cold splits, 2 deterministic fission rows, 3 visual-profile rows, 1 preflight-only row, and 0 included unproven rows. Current strict full-runtime backend families were `hip`, `opencl`, `vulkan`, and `webgpu`; full-runtime scope breakdown was `generated_rocm_hip_preview_visual: 2`, `hip_module_declared_compute_readback: 2`, `opencl_declared_compute_readback: 2`, `vulkan_declared_pipeline_visual: 1`, `webgpu_declared_compute_readback: 2`, and `webgpu_declared_pipeline_visual: 8`. That broad readiness result is superseded by the 2026-07-01 user-owned source-first visual gate above; profile-owned visual rows remain scoped proof, not arbitrary-user broad readiness.

2026-06-30 matrix-level broad-proof scaffold follow-up: validation-matrix coverage now emits a recomputed `synthi.gpu_hmr.broad_library_agnostic_matrix_proof.v1` object from strict accepted full-runtime rows only. Broad rows require the matrix proof to accept, not a row-declared broad claim. The proof requires at least four backend families, four acceptance scopes, visual and compute oracle coverage, and eight adversarial refusal rows; forged row-level broad declarations still fail closed. The current local matrix now satisfies that scaffold through HIP, OpenCL, Vulkan, and WebGPU strict rows, while real project acceptance still remains per-target and fail-closed.

2026-07-01 output-oracle binding hardening follow-up: validation-matrix output-oracle acceptance now requires a recomputed `synthi.gpu_hmr.output_oracle_binding.v1` match between dispatch ID, post-dispatch output event, and output target before compute or visual oracle bytes can satisfy strict runtime proof. Visual oracle rows also require ledger-declared before/after/diff artifact hashes to match matrix-decoded visual artifacts, and visual-pair recomputation now rejects blank before frames instead of accepting a nonblank after/diff pair by itself. Accepted runtime-chain adapter overlays may supplement missing base-ledger output-target fields only after the runtime chain itself has recomputed as accepted; copied manifests, adapter text, and serialized success flags still cannot authorize output proof. Vulkan and OpenCL runtime proofs now emit backend-neutral output targets in dispatch/output ledger events (`vulkan-frame-readback`, `opencl-buffer:output`), and OpenCL contract/fission/oracle target IDs are bound to the same target. Fresh checks passed `gpu-hmr-validation-matrix-ledger-smoke`, `proof:vulkan:runtime:self-check`, `proof:opencl:runtime:self-check`, a live Vulkan proof, and a host-local OpenCL proof with the worker container disabled after the worker DNS/restart loop blocked container execution. The refreshed local matrix proof is `gpu-validation-matrix-ledger:sha256:75b92e22d2c8e3c190adbf6cac88fbcdb92025b9d47b76c9822c1832d0cf22eb`, with 101 rows, 10 accepted strict full-runtime rows, backend families `hip`, `opencl`, `vulkan`, and `webgpu`, five visual oracle targets, one compute oracle target, six random large cold-path source identities, `broadLibraryAgnosticReadiness.accepted=true`, and no broad-readiness open gaps. This is still a matrix generalization proof and cold-intake exercise, not production acceptance for every arbitrary GPU project; each user project still needs its own same-process loader, epoch publication, dispatch trace, host identity, output oracle, firewall, runtime chain, deterministic visual or compute bytes, and strict ledger closure.

2026-07-01 source-derived real ROCm oracle authority follow-up: validation-matrix output-oracle resolution no longer accepts `source_derived_profile` as a runtime-authoritative selected source. A source-derived profile can remain useful for profile instrumentation, source-adapted diagnostics, and refusal/support evidence, but it now fails the runtime output-oracle resolution gate with `real_rocm_output_oracle_source_derived_profile_not_runtime_authority`; only runtime evidence or profile-runtime evidence can feed that gate before the normal same-process loader, epoch, dispatch, host identity, output bytes, firewall, runtime chain, and strict proof-ledger checks close. Matrix smoke adds a forged `source_derived_profile` output-resolution row and keeps it refused. Verification passed matrix smoke `gpu-validation-matrix-ledger:sha256:571f18673be93640968edc4e8048e5d89057e3bb284d1355348f8fbadcaf7b81` and full validation-matrix self-check `gpu-validation-matrix-ledger:sha256:6ca56d2185e647ebf7f7784fdeac9306062ae8be8ef5db391b358d38f1f2ced9`. This is generic source-adaptation hardening, not a project, profile, backend, target, fixture, or scenario branch.

2026-06-30 arbitrary cold runtime-boundary event-template follow-up: accepted random large-project cold intake now emits `synthi.gpu_hmr.cold_runtime_boundary_event_manifest_template.v1` after the backend/build-derived runtime-boundary expectation accepts. The facet derives five project-neutral `synthi.gpu_hmr.runtime_boundary_event.v1` object templates for `artifact_transport`, `epoch_publication`, `dispatch_trace`, `host_identity`, and `output_oracle`, with backend-specific field hints for HIP/ROCm, OpenCL, Vulkan, WebGPU, Metal, CUDA, and SYCL. It intentionally omits a populated `runtimeBoundaryEvents` array, sets `acceptedForGpuHmr=false`, `gpuHmrSuccess=false`, and `canSatisfyRuntimeProof=false`, and can only tell an arbitrary project what observed boundary evidence to write. The materialized wgpu cold-input run retained manifest `sha256:152be8457623c5ca7b1e3a07b25c54c64d7e1e084b93360719ca426ccef136f8` and template hash `sha256:f49030222a1390e3cc972c78bf66b170d4da0b1e53932f7400e03ceeb8981aa5`; it still refused GPU HMR because same-process loader, epoch, dispatch, host identity, output oracle, firewall, runtime chain, and strict ledger proof were not observed.

2026-06-30 matrix cold-template audit follow-up: validation-matrix support code now recomputes and validates cold runtime-boundary event-manifest templates independently of the producer. `coldRuntimeBoundaryEventManifestTemplateFacet` requires the support-only schema/authority, recomputes the top-level and per-event template hashes, requires the five app-hook event kinds, refuses missing output-oracle or required identity/dispatch fields, rejects any GPU HMR/runtime/dispatch authority claim, and fails templates that include populated `runtimeBoundaryEvents`. Smoke coverage proves accepted support-only templates remain non-authoritative and forged success/populated-event/hash-mismatch templates are refused before they can be treated as runtime proof.

2026-06-30 random cold-path matrix-ingestion follow-up: validation-matrix ingestion now classifies `synthi.gpu_hmr.random_large_project_cold_path.v1` manifests as first-class refusal/preflight rows. The row builder recomputes a support-only random cold-path facet from the result, candidate, and source-intake evidence; summarizes large source listings instead of copying them into row data; recomputes the cold runtime-boundary event-manifest template when present; and emits `random_large_arbitrary_project_cold_path` plan coverage. Row safety refuses random cold-path rows that claim GPU HMR acceptance, GPU HMR success, runtime authority, dispatch authority, full-runtime outcome, or a validated cold template without recomputation. Smoke coverage accepts a support-only cold-path row and refuses a forged populated-runtime-event template with `random_large_project_cold_template_not_validated`. This turns random large arbitrary project cold testing into matrix-audited user-path evidence without making project selection, repo identity, build hints, or event templates into GPU HMR proof.

2026-06-30 broad-readiness random cold-path requirement follow-up, tightened 2026-07-01: `synthi.gpu_hmr.broad_library_agnostic_matrix_proof.v1` now requires at least five matrix-valid random large arbitrary-project cold-path refusals with accepted source-tree intake, build metadata evidence, validated support-only runtime-boundary event templates, and source-tree scale of at least 1000 files or 10 MiB of known source bytes before broad readiness can accept. Random cold-path rows are tracked as `randomColdPathRows` / `randomColdPathTargets`; sub-threshold direct rows are tracked as `randomColdPathCandidateRows` diagnostics and do not count toward the five-row floor. A matrix with strict HIP/OpenCL/Vulkan/WebGPU full-runtime rows but no arbitrary cold-path lane remains internally valid as scoped proof, but broad readiness stays closed with `broad_acceptance_requires_random_large_project_cold_path`; one to four qualifying large rows stay closed with `broad_acceptance_requires_more_random_large_project_cold_paths`; only small direct rows close with `broad_acceptance_requires_large_random_project_cold_paths`. The retained matrix now has five qualifying large cold-path rows and accepts broad readiness only as matrix-level generalization evidence, not as per-project runtime acceptance.

2026-07-01 broad-readiness user-style cold-intake hardening: the random cold-path broad-readiness requirement now accepts only unprofiled arbitrary cold intake. The qualifying row must have `profileMode=unprofiled_arbitrary_project_cold_intake`, an immutable commit, a source URL or local repo path, accepted source-tree intake, accepted build metadata evidence, a validated support-only runtime-boundary event template, and no GPU HMR/runtime/dispatch authority claims. A profile-backed large ROCm cold attempt remains useful refusal evidence, but it no longer satisfies the arbitrary user-project cold-path requirement. Smoke coverage proves a profiled cold row leaves broad readiness closed while an unprofiled/direct arbitrary cold row opens only that support gate.

2026-06-30 OpenCL host-runtime/readback proof follow-up: `proof:opencl:runtime` now has a generic Windows host-local execution transport for environments where the worker container has only the OpenCL loader but no ICD/platform. The runner still tries the container path first; it falls back only for structural runtime absence such as missing platform/device/loader/compiler/container, records `runtimeProbeExecution.evidenceAuthority=runtime_probe_execution_transport_only_not_gpu_hmr_success`, and never treats transport or preflight as GPU HMR authority. The Windows path compiles a temporary PowerShell `Add-Type` probe, binds `OpenCL.dll` through explicit P/Invoke declarations, builds before/after OpenCL C programs, dispatches the same kernel entry through `clEnqueueNDRangeKernel`, reads raw output bytes through `clEnqueueReadBuffer`, emits the same runtime trace shape as the POSIX probe, renders a compute proof card from raw bytes, and then uses the existing strict contract, proof ledger, ABI, fission, firewall, native API count, timestamp, expected-output, and negative ABI-edit refusal gates. Fresh live host-runtime proofs accepted hot delta 1 with proof `opencl-runtime-proof:sha256:73594daf0b31354da7eaea6f1487c9d51ad5cee5acc5c88384eb965411209e82`, runtime artifact `opencl-runtime-proof-artifact:dafde562ec2f1afe02f3c18ac275c9004b622fa56135702cb991000a31e92771`, ledger `gpu-ledger-proof:sha256:35d4a1e5a9c9408e5dd516bd32a1a3fdb8fa6350245e41f1251a20310f1f808c`, and hot delta 2 with proof `opencl-runtime-proof:sha256:4ffef3afdc58d5a8bab8623d451c98b7683f02efbbd950bdceb24ea53fed9fc7`, runtime artifact `opencl-runtime-proof-artifact:ec6dde15d1eca85866e24cd78f471d532aa4706b0bfdc8f7536a25f09c3ecbbf`, ledger `gpu-ledger-proof:sha256:983ba910d94009c28ddd1f70f46824c1a6b343ea1544eeae0bfa51d14be137c2`. `proof:opencl:runtime:self-check` now also verifies the Windows probe source shape and still rejects forged raw readback. The separate worker-container preflight remains refusal-only with proof `opencl-preflight-proof:sha256:98ec455f0f00cbe74c1716644124dd3cff7341cfd52d694427b80892da010875`, `opencl_accepted=false`, and unsupported reasons `opencl_vendor_icd_missing,clinfo_missing`. This adds scoped OpenCL full-runtime compute proof for this host without claiming arbitrary OpenCL project acceptance or broad library-agnostic GPU HMR.

2026-06-30 large-ROCm MIOpen bounded rerun follow-up: `gpu-real-rocm-MIOpen-20260630113345` retained fail-closed results at `mcp/synthi-mcp/.gpu-hmr-test-logs/real-rocm-results/gpu-real-rocm-MIOpen-20260630113345.json` / `.txt`. The runner proved source-tree CAS transport, external header prerequisite evidence, and runtime-boundary target environment export, but upstream configure/build failed without usable cached metadata, no adapter result or event manifest was copied, no native launch/runtime boundary lines were captured, and no artifact transport, epoch publication, dispatch trace, host identity, output oracle, firewall, or strict runtime proof closure was observed. The strict runtime proof artifact `gpu-runtime-proof:sha256:c2693e5f9ab7930ea7d2899fc9e19c7c2053fb803ff21adef1418acb0144c9f0` remains rejected with `gpuHmrSuccess=false` and `fullRuntimeProven=false`. This is large-project refusal evidence only, not MIOpen hot-reload acceptance.

2026-06-30 latest large-ROCm MIOpen bounded rerun follow-up: after Docker and compose services were started, `proof:real-rocm:large-ml-miopen` was rerun with `SYNTHI_REAL_ROCM_UPSTREAM_TIMEOUT_MS=120000` and retained `gpu-real-rocm-MIOpen-20260630155225`. The runner reached the real MIOpen source tree, staged it through shared CAS, accepted the external header prerequisite, exported the generic runtime-boundary target environment, executed the lifecycle-finalizer adapter, and copied adapter-result transport. It still refused GPU HMR because upstream configure/build failed without usable metadata, event-manifest materialization observed zero boundary lines, event-manifest transport was missing, no native launch/runtime boundary lines were captured, and no artifact transport, epoch publication, dispatch trace, host identity, output oracle, firewall, runtime chain, or strict proof-ledger closure was observed. Rejected strict runtime proof `gpu-runtime-proof:sha256:617a811ee630e9389693778ea1584aca3ba3cb1679ea282ff3bb5a1708d9df84` and pre-collection rejected strict proof `gpu-runtime-proof:sha256:823563285b721c5fcf4f7fceafb48453c80d714301e4e1d265a70bba1a88ec19` are refusal evidence only. No visual or compute MIOpen output oracle was produced, so no large-project hot-reload acceptance is claimed.

2026-06-30 latest run-id-bound MIOpen bounded rerun follow-up: `gpu-real-rocm-MIOpen-20260630171112` exercised the run-id lifecycle status path under `SYNTHI_REAL_ROCM_UPSTREAM_TIMEOUT_MS=120000`. The worker status file matched the current lifecycle run id and proved configure was killed before it returned (`configure_exit_code=unknown`, `run_exit_code=not-run`, no metadata snapshot). The retained report therefore stayed fail-closed with `upstream_configure_status_incomplete_after_lifecycle_failure`, `cmake_configure_failed`, missing current-run metadata, zero runtime-boundary lines, no event-manifest transport, no artifact transport, no epoch, no dispatch, no host identity, no output oracle, no firewall, and rejected strict runtime proof `gpu-runtime-proof:sha256:7092e5e2b9ecb63442d8db218268caba18f82ef4939d3568edb0121b8ed81ad0`. This supersedes the older stale-log diagnosis but remains large-project refusal evidence only.

2026-06-30 Vulkan host-runtime/pipeline visual proof follow-up: `proof:vulkan:runtime` now emits a generic Vulkan runtime proof schema instead of only relying on preflight evidence. The live path still records worker-container preflight as refusal-only support when the worker lacks ICD/tooling, then uses a host-local PowerShell `Add-Type` probe only as transport support (`runtime_probe_execution_transport_only_not_gpu_hmr_success`) on Windows Vulkan hosts. The host probe creates a real Vulkan instance, physical device, logical device, queue, descriptor set, pipeline layouts, shader modules, compute pipelines, command buffers, fences, and host-visible readback buffer in one process. It dispatches epoch 1 first, reads output, then creates/loads/publishes the epoch 2 shader module and pipeline, dispatches epoch 2, reads output, and writes a trace that must prove loader, epoch, dispatch, output, and retirement ordering. Missing native API counts, missing trace arrays, misordered timestamps, or mismatched dispatch/output IDs now fail closed instead of synthesizing ledger success. The accepted live proof `vulkan-runtime-proof:sha256:de768ddd560863deac94f7740adf55af5a3fb59e730c9e0109fd383135bc8e84` carries strict runtime artifact `vulkan-runtime-proof-artifact:62fbf87f8551fdce10a33595c8c5a76d42683ac3522676a942c7f1a5c4a94134`, ledger `gpu-ledger-proof:sha256:599ef0607b62dab245d7b29b9dae68ed6a30733520bb8aaaff7a54371ae03fb1`, visual threshold `changed=100%, mean_abs=132, visible_pixels=16384`, and row `gpu-validation-matrix-row:sha256:c0e9f8d1509334ae80200ee736df5050e585e12bb11ae7a8fd951248893342e8`. Local image inspection opened the before, after, and diff PNGs under `mcp/synthi-mcp/.gpu-hmr-test-artifacts/vulkan-runtime-proof/vulkan-runtime-frame-20260630124806/`; the frames are nonblank readback artifacts. This is scoped `vulkan_declared_pipeline_visual` proof, not arbitrary Vulkan engine/cache/command-buffer acceptance without the same strict proof gates.

2026-06-29 source-first realistic visual rerun: `source-first-cold-cas-realistic-20260629` started from profile-declared source files rather than a precompiled project, selected worker-detected ROCm arch `gfx1201`, produced source-first ingestion proof `agent-split-source-first-ingestion:sha256:a898e9bca1c7fee46d7e375c631a51d25b346f7676e2af5eb2fdce25247eb687`, and accepted hot-delta rows `historical-gpu-validation-matrix-row-sha256-df44f7e0790a508aac703b3746cb2f80be2ff907a753d16a2bf7d7083adcbdff` and `historical-gpu-validation-matrix-row-sha256-be05fd92aaee4bc25fcdb00a3e061fd5e86c8f185078529c93493545f5f7d595`. Hot delta 1 carried runtime proof `gpu-runtime-proof:sha256:43a005919819b67ccb6ef994338fff641acbd422c159eb34c2a116dab2a0c1d9`, ledger `gpu-ledger-proof:sha256:93284ff0e2db5c5b14e103f2a19841a13805f6db7be7ba45efff0fa8cc343e68`, and visual delta changed=82.64%, mean_abs=17.89. Hot delta 2 carried runtime proof `gpu-runtime-proof:sha256:357e9f62e03699eb198c9ccb3bbe315f026634f5218ec93d87bd9dfd820593d9`, ledger `gpu-ledger-proof:sha256:1de246b3324e16f14862c21d2351ec7c0fa40bc457b9b4895cf370599cdd24a5`, and visual delta changed=99.87%, mean_abs=37.38. The negative ABI edit refusal row is `historical-gpu-validation-matrix-row-sha256-84347a9a017de043fc6a0abec4fffd786a0e7aa84aeca62525b2210c769ac26e` with proof `agent-split-negative-edit-refusal:sha256:70207e3fd1ba9f0206b35bb2dd24da8ae143f0d12ce582f153b86fe3cbafd27f`. Local image inspection opened `before-hmr-second.png`, `after-hmr-second.png`, `before-after-diff.png`, and `hot-delta-2-diff.png`; the scene is nonblank and contains the realistic raytrace visual elements requested, but the accepted claim remains scoped generated/profiled ROCm/HIP visual GPU HMR, not arbitrary HIP app acceptance.

2026-06-29 latest large-ROCm reruns: `gpu-real-rocm-MIOpen-20260629-checkpoint2`, `gpu-real-rocm-composable-kernel-20260629080933`, and `gpu-real-rocm-hipBLASLt-20260629081428` were run through the profile-driven large ROCm ML harness with bounded upstream windows. MIOpen retained source-tree CAS evidence, recovered upstream metadata, executed hot-delta-1, hot-delta-2, and negative-edit source-delta compile projections, retained external-header prerequisite evidence for `half/half.hpp`, ran the generic packaged runtime-adapter template, copied the adapter result manifest, and captured native runtime candidate lines. Those records are support evidence only; they are not post-dispatch MIOpen oracle proof or runtime authority. Composable Kernel configured but the requested target/metadata path did not produce accepted runtime proof material. hipBLASLt refused before build metadata/source-delta proof. The current matrix rows are `historical-gpu-validation-matrix-row-sha256-16305e7aef533eb74ffd73e8fdda199da25aef72e27be2fbb6710b632d32b235`, `historical-gpu-validation-matrix-row-sha256-378ebb4fb4a2db179a838fc1372c17f0f652a4874cb918963f9d7a3dbe1091b6`, and `historical-gpu-validation-matrix-row-sha256-717f37a36c9dd6463096e60c0a5aa67bb64d4668a77dc94c263db0026677a591`. All remain `refusal_proven`, with `gpuHmrSuccess=false`, `acceptedForGpuHmr=false`, and missing Synthi artifact transport into the target process, epoch publication, dispatch trace, host identity, app-hook runtime observation, output oracle, firewall, and accepted strict runtime proof closure.

2026-06-29 large-ROCm checkpoint/timeout follow-up: the MIOpen checkpoint run `gpu-real-rocm-MIOpen-20260629-checkpoint2` proved another non-happy path. The runner now writes a fail-closed retained result before runtime evidence collection and a final retained result after collection, so a long proof-finalization path cannot leave only an in-memory verdict. The same run exposed that host-side Docker command timeouts can leave worker-side upstream builds alive, so real ROCm lifecycle commands now run under a worker-side timeout wrapper with a generic `SYNTHI_REAL_ROCM_LIFECYCLE_RUN_ID` marker and marker-based cleanup. These checkpoint and cleanup facets are orchestration evidence only (`acceptedForGpuHmr=false`, `gpuHmrSuccess=false`) and cannot satisfy artifact transport, epoch publication, dispatch trace, host identity, output oracle, firewall, app-hook, or strict runtime proof gates.

2026-06-29 runtime-adapter-check MIOpen attempt: the sandboxed direct script run wrote `mcp/synthi-mcp/.gpu-hmr-test-logs/real-rocm-results/gpu-real-rocm-MIOpen-20260629-runtime-adapter-check.json` and correctly failed closed before Docker/container evidence with `runtimeAdapterDeclared=false`, `runtimeAdapterExecution=null`, `gpuHmrSuccess=false`, `fullRuntimeProven=false`, and target-progression/runtime-stage gaps. The approved unsandboxed rerun reached the real MIOpen upstream build, configured successfully, and progressed deep into the native compile before the host validator shell timeout; because the validator process no longer existed to collect proof, the detached build was stopped and no accepted runtime ledger or output-oracle artifact was produced. This is serious-project execution progress only, not GPU HMR acceptance and not a claim that MIOpen executed a runtime adapter.

2026-06-30 bounded MIOpen event-manifest refresh: `proof:real-rocm:large-ml-miopen` was rerun with `SYNTHI_REAL_ROCM_UPSTREAM_TIMEOUT_MS=120000` after the generic runtime-adapter event-manifest bridge was added. The sandboxed attempt failed at Docker preflight with `spawn EPERM`; the approved rerun reached Docker, retained `mcp/synthi-mcp/.gpu-hmr-test-logs/real-rocm-results/gpu-real-rocm-MIOpen-20260630090958.txt`, exported the runtime-boundary target environment with 17 variables including the generic event-manifest aliases, and then failed closed during upstream configure/build metadata collection before adapter execution. The retained verdict remains `gpu_hmr_success=false`, `fullRuntimeProven=false`, and strict runtime proof rejected; runtime adapter final support gaps include missing adapter-result bridge, adapter execution, stage events, and target-process provenance. No visual or compute output oracle was produced, no MIOpen post-dispatch output was proven, and no large-project GPU HMR acceptance is claimed.

2026-06-28: CAS artifact locators now support portable content-addressed consumption across container mount namespaces. A producer can omit its absolute `storage.localPath`; a consumer can resolve `sha256/<prefix>/<digest>` under its own allowed CAS root and still verify byte length plus SHA-256 before transport evidence accepts. Optional shared mount metadata records generic roles such as worker/MCP/frontend without becoming proof authority. CAS/shared-addressing evidence remains `acceptedForGpuHmr=false` and `gpuHmrSuccess=false`.

2026-06-28: large real ROCm source-tree transport now emits a generic `synthi.real_rocm.source_tree_transport.v1` facet with Git tree/listing identity, source-tree manifest hash, optional CAS artifact locator validation, and explicit hot-path transport gaps. The facet is source transport integrity evidence only. It cannot satisfy runtime proof, dispatch proof, epoch publication, host identity, app-hook, or output-oracle acceptance; the matrix rejects forged source-tree transport facets that claim GPU HMR, runtime, or dispatch authority.

2026-06-28: frontend, MCP, and worker compose services now share a generic bind-mounted artifact CAS root at `/var/lib/synthi/artifact-cas`, and the large real ROCm runner can stage source trees through declared shared-mount metadata instead of falling back to `docker cp`. When no explicit mount JSON is supplied, the runner derives the compose-default local root `mcp/synthi-mcp/.gpu-hmr-shared-cas` plus worker/MCP/frontend roots under `/var/lib/synthi/artifact-cas`; explicit env remains the override for other deployments. The current MIOpen run `gpu-real-rocm-MIOpen-20260628193652` recorded `transfer_operation=cas_shared_volume`, `hotPathOptimized=true`, four shared roles, a worker-inspected matching Git commit, and no transport blocking gaps. This remains transport integrity evidence only: `acceptedForGpuHmr=false`, `gpuHmrSuccess=false`, and `canSatisfyRuntimeProof=false`.

2026-06-28 previous transport checkpoint: the large real ROCm source-tree transport facet now resolves its CAS artifact root from the same generic shared-source-tree producer mount used to stage the repo. This prevents a split-brain result where the repo is staged through `cas_shared_volume` but the transport facet falls back to `serialized_fallback` because no separate CAS-root env var was set. The MIOpen rerun `gpu-real-rocm-MIOpen-20260628-cas-transport-rerun` recorded `transferOperation=cas_shared_volume`, `transportKind=cas_shared_volume`, `hotPathOptimized=true`, `acceptedAsTransportEvidence=true`, `sharedMountCount=4`, `sharedStorageAccepted=true`, `sourceTreeCasRootSource=resolved_source_tree_mount_producer_root`, `blockingGaps=[]`, and `failedGates=[]`. It still correctly refused GPU HMR because runtime artifact transport, epoch publication, dispatch trace, host identity, app-hook/runtime-oracle proof, and post-dispatch output/visual oracle proof were absent.

2026-06-28 large-ROCm rerun superseded by the 2026-06-29 external-header matrix: subagent audit confirmed that the next generic MIOpen blocker was the real upstream `half/half.hpp` prerequisite, not a Synthi proof gate. The run `gpu-real-rocm-MIOpen-20260628193652` used `cas_shared_volume` source-tree transport with `hotPathOptimized=true`, `acceptedAsTransportEvidence=true`, `sharedMountCount=4`, and no transport blocking gaps, then failed closed on `missing_build_dependency=half/half.hpp`, the generic missing-dependency probe gap `missing_dependency:half_half.hpp`, and missing runtime artifact transport, epoch publication, dispatch trace, host identity, app-hook contract, and output-oracle proof. Its superseded matrix row was `sha256:1412f486d31f4f6bcf7f9f9850a37ac0859f5be1605f9e03809a5d24a5f82f0b` with runtime proof `gpu-runtime-proof:sha256:f5e78adb4ca5011aa8c003736976329fb22026d5ea6684f5e903f5d2980a508c`, ledger `gpu-ledger-proof:sha256:d46f7e2837b3ca0f6bfbcb5e3bee20836dbea96851204635180c9f76c1fe1f0c`, validation proof `real-rocm-validation:sha256:369c0c2aec2cbdd1f093cc79d9c7ddef854b515c0508cc1f5b967b748e422d34`, and target-progression ledger `target-progression-ledger:sha256:7b52dfda8ef860ed877bcc2a049fd42c3885724f45496fb3cbfd755ee9bbe226`. No visual proof is claimed for this compute/upstream-lifecycle profile because no frame-gated visual oracle exists and screenshot attempts captured no frame.

2026-06-28 missing-dependency probe hardening: large real ROCm retained reports now carry a generic read-only `synthi.real_rocm.missing_dependency_probe.v1` facet when upstream lifecycle evidence reports missing headers/tools/packages. The worker probe only inspects declared/recovered include roots and generic system include roots; it does not install packages, add symlinks, vendor headers, or branch on project names for success. The facet is recorded in runtime proof artifacts, proof summaries, top-level real ROCm verdicts, and matrix rows as refusal evidence only. Any present missing-dependency probe blocks `gpuHmrSuccess` at the runtime-artifact, summary, real-ROCm verdict, and validation-matrix layers, and forged probes that claim GPU HMR/runtime authority are rejected.

2026-06-28: the source-first agent-split proof runner MCP client sends newline-delimited JSON for the installed Node MCP SDK and can parse either newline-delimited or Content-Length-framed MCP responses. A direct docker MCP initialize probe passed on the newline path. This is generic stdio transport compatibility only; it cannot satisfy artifact transport, epoch, dispatch, oracle, or ledger acceptance gates.

2026-06-28: the source-first agent-split proof runner now exposes first-class npm scripts (`proof:agent-split:source-first`, `proof:agent-split:source-first:self-check`, `proof:agent-split:source-first:seed-only`, and `proof:agent-split:source-first:realistic-raytrace`). The runner-level source-first provenance gate now requires generated artifacts to live in the generated artifact namespace before it can emit accepted provenance-only evidence, and the self-check covers both a valid multi-file source tree and a forged ordinary source path such as `src/generated-device.hip`. This remains provenance-only evidence; strict GPU HMR acceptance still requires the runtime ledger and output oracle.

2026-06-28: the realistic raytrace source-first profile now declares a multi-file source tree (`src/main.cpp` plus `src/scene_config.h`) with explicit sha256 hashes. This is a generic source-tree manifest exercise, not a profile-name shortcut. The profile self-check passed again, source-first seed-only created workspace `gpu-agent-split-1782675324866` from source without a precompiled project, and an earlier two-file realistic rerun created workspace `gpu-agent-split-1782675331957` before failing at the provider-preflight gate because the configured model provider returned `ai_provider_account_suspended`. That failure is infrastructure evidence only and does not supersede the previous accepted source-first visual proof.

2026-06-28 follow-up: provider availability is now preflighted immediately before provider-backed source-first AI split calls, after deterministic/source-owned split paths. Provider/account/auth/rate/timeout failures are emitted as typed diagnostic-only reason codes such as `ai_provider_account_suspended`, redacted before JSON/TXT artifact writes, and cannot satisfy AI split, runtime epoch, visual proof, or GPU HMR ledger gates. The latest two-file realistic source-first rerun `gpu-agent-split-1782704006982` failed closed in the provider-preflight path with `source-first-provider-diagnostic:sha256:dec0f1aa6adfa3903bac78832b4ce974095b4b6bdce72f69df61e8bad54e002a`, `reasonCodes=["ai_provider_account_suspended"]`, `acceptedForGpuHmr=false`, and `gpuHmrSuccess=false`. It produced no visual HMR artifact because the AI split did not complete.

2026-06-29 latest source-first user-path check: `proof:agent-split:source-first:realistic-raytrace` created `source-first-cold-cas-realistic-20260629` from `src/main.cpp` plus `src/scene_config.h`, preserved quoted-include constants through the generic deterministic splitter, compiled the generated ROCm/HIP device artifact on worker-detected `gfx1201`, published strict hot-delta runtime proof, and emitted CAS-backed cold visual evidence. Matrix rows now include cold split `historical-gpu-validation-matrix-row-sha256-87f740bc751d0fc8be062127e0a22cd02d733ddea36c02c86b2e105c1bde9615`, hot delta 1 `historical-gpu-validation-matrix-row-sha256-df44f7e0790a508aac703b3746cb2f80be2ff907a753d16a2bf7d7083adcbdff`, hot delta 2 `historical-gpu-validation-matrix-row-sha256-be05fd92aaee4bc25fcdb00a3e061fd5e86c8f185078529c93493545f5f7d595`, negative edit refusal `historical-gpu-validation-matrix-row-sha256-84347a9a017de043fc6a0abec4fffd786a0e7aa84aeca62525b2210c769ac26e`, and deterministic fission row `historical-gpu-validation-matrix-row-sha256-ab0cb77eb89e7aa8061f3a10a7a3401f4288b0615d39b276cb9ba40ef45c767e`. This is scoped generated/profiled visual proof only, not arbitrary HIP app/library acceptance.

2026-06-29 latest seed-only user-path check: `proof:agent-split:source-first:seed-only` created `gpu-agent-split-1782741683475` from source without a precompiled project and recorded worker-detected ROCm arch `gfx1201`. This verifies the user entry point and workspace seed path only; it still requires AI split, compile/load, epoch publication, visual/output oracle proof, and strict ledger closure before any GPU HMR acceptance.

2026-06-29 source-first/no-precompiled rerun detail: source-first ingestion proof `agent-split-source-first-ingestion:sha256:dbef11d86091ba64402333b6598f208c619f231474ced92da53fed8d15e1920f` binds source hash `sha256:057c83a0a2af53eea19ba3f189836978c804a0048dfd2436bb2cc41bc882662e`, initial source-tree manifest `sha256:52c54da7c6757bf109bec206a56a847e991bf1e7f14ade2d5ac1acb0145bb952`, generated artifact hashes, sidecar hash, compile manifest hash, worker arch evidence, and source-purity scan. `cold-split-frame.png`, `before-after-diff.png`, and `hot-delta-2-diff.png` were opened locally and visibly nonblank; hot1 changed=82.64% mean_abs=17.89, hot2 changed=99.87% mean_abs=37.38. Earlier provider/account failure runs remain historical refusal evidence only and do not satisfy AI split, runtime epoch, visual proof, or GPU HMR ledger gates.

2026-06-28 visual CAS validation follow-up: the validation matrix no longer accepts visual CAS locators by shape alone. Visual artifact evidence validates each `synthi.cas.artifact_locator.v1` manifest with readable-byte SHA-256 checks under allowed repo/log/CAS roots, can decode before/after/diff PNGs from CAS-only `sha256/<prefix>/<digest>` paths when local artifact paths are absent, and refuses forged relative paths or hash mismatches with `visual_artifact_cas_locator_validation_failed` / `visual_artifact_cas_locator_hash_mismatch`. The `asyncVisualCasBundle` support facet now derives its accepted transport hashes from matrix-validated CAS locators. This is generic transport/oracle-byte validation only; CAS locators, worker metrics, tile evidence, and support facets remain `acceptedForGpuHmr=false` and `gpuHmrSuccess=false` without strict runtime-ledger closure.

2026-06-29 visual CAS replay hardening: validation-matrix visual recomputation now prefers validated CAS artifact locators as the async worker input for before/after frames, records requested worker input transport, and requires `workerCasInputAccepted=true` before `asyncVisualCasBundle` support can accept. If the worker only consumed direct local paths, serialized bytes, or an unvalidated locator, the support facet fails with `async_visual_worker_cas_input_missing` even if the full visual proof still recomputes by fallback. This keeps direct-path/base64 replay as diagnostic fallback while preventing it from being overcounted as optimized shared-CAS proof.

2026-06-28 external visual-profile follow-up: external runtime and MCP preview profile producers now emit report-level content-addressed `before_image_hash`, `after_image_hash`, and `diff_image_hash` fields alongside the visual artifact paths. The matrix still recomputes PNG bytes through the async visual proof worker and refuses path-only or forged-hash reports. The current ThreeJS WebGL shader-lava rerun is therefore `external_engine_visual_profile` coverage only: `visual_profile_accepted`, `acceptedForGpuHmr=false`, `gpuHmrSuccess=false`, proof `external-visual-proof:065da55a0849250968926125e2756025c38e17985bea6606f9bc7639778818f6`, and latest matrix `gpu-validation-matrix-ledger:sha256:9021cc8be6f4e5f65643be933368394843db710d6e010bc30834ad34b4383787`. This is not a target-name shortcut and not full-runtime GPU HMR; strict acceptance still requires the same loader, epoch, dispatch, host-identity, output-oracle, and runtime proof ledger gates.

2026-06-28 superseded matrix after CAS-validated visual locator ingestion, source-first, and MIOpen missing-dependency rerun: `gpu-validation-matrix-ledger:sha256:d1f938f28a9ad22d8939934684d133fcec53340be09aac0c34c1d549f840af38`, JSON `mcp/synthi-mcp/.gpu-hmr-test-logs/validation-matrix/gpu-hmr-validation-matrix-20260628T195143Z.json`, 56 rows, 14 accepted full-runtime GPU HMR rows, 0 broad library-agnostic full-runtime GPU HMR rows, 14 scoped full-runtime GPU HMR rows, 14 all full-runtime rows, 29 refusals, 7 cold splits, 2 deterministic fission rows, 3 visual-profile rows, 1 preflight-only row, and 0 included unproven rows. Scope breakdown: generated_rocm_hip_preview_visual: 2, hip_module_declared_compute_readback: 2, webgpu_declared_compute_readback: 2, webgpu_declared_pipeline_visual: 8. `per_target_run_modes status=accepted`. Broad readiness remains `accepted=false`.

2026-06-29 latest history audit: `gpu-validation-matrix-ledger:sha256:aa905942109909b5181c6236cb348a68710ebc667ac8f8dde7d572385c7e349c`, JSON `mcp/synthi-mcp/.gpu-hmr-test-logs/validation-matrix-unproven-audit/gpu-hmr-validation-matrix-20260629T113226Z.json`, 678 rows, 622 historical unproven rows, 14 accepted full-runtime GPU HMR rows, 0 broad library-agnostic full-runtime GPU HMR rows, 14 scoped full-runtime GPU HMR rows, 14 all full-runtime rows, 29 refusals, 7 cold splits, 2 deterministic fission rows, 3 visual-profile rows, and 1 preflight-only row. History scope breakdown: generated_rocm_hip_preview_visual: 2, hip_module_declared_compute_readback: 2, webgpu_declared_compute_readback: 2, webgpu_declared_pipeline_visual: 8.

2026-06-28 latest timing telemetry: `mcp/synthi-mcp/.gpu-hmr-test-logs/timing-metrics/gpu-hmr-timing-metrics-20260624T093916Z.json`, count=21. The timing metrics are telemetry only, `evidenceAuthority=timing_telemetry_only`, and `proofVerdict=not_evaluated_by_timing_summary`.
```

## 2. Immediate Corrections To The Previous Plan

### 2.1 Delta model requirement

The previous plan treated `gemini-3.1-flash-lite-preview` as non-negotiable for GPU delta edits. That is no longer a valid public requirement.

Provider status check:

- Source: Google AI Gemini API deprecations page, `https://ai.google.dev/gemini-api/docs/deprecations`.
- Checked by Codex on 2026-06-07.
- `gemini-3.1-flash-lite-preview` is listed as shut down on 2026-05-25 with replacement `gemini-3.1-flash-lite`.
- `gemini-3.5-flash` is listed with no shutdown date announced.

Correct model policy:

```text
default split model: gemini-3.5-flash
default GPU delta model: gemini-3.1-flash-lite
preview delta model: forbidden unless provider availability check proves it is live in this environment
```

Every AI call and every timing report must record more than requested/actual/fallback. Required fields:

```yaml
model_provenance:
  provider: google_gemini
  requested_model:
  provider_model_status:
    value: available | deprecated | shutdown | unknown | private_alias
  provider_model_alias_resolved_to:
  provider_shutdown_or_deprecation_detected: true | false
  model_availability_checked_at:
  actual_model:
  fallback_model:
  fallback_used: true | false
  request_mode:
    value: split | gpu_delta | heal | contract_hint | oracle_hint
  hard_infra_failure: true | false
```

Acceptance rule:

```text
If the configured delta model is shutdown and no private alias is proven, GPU HMR validation must fail as an infrastructure failure. It must not silently fall back and still claim the requested model path was tested.
```

### 2.2 AI is not an authority

AI may propose a contract. AI may propose a fission island. AI may propose an oracle. AI may propose adapter code.

AI must not authorize any GPU HMR contract field.

Correct authority order:

1. Runtime traces.
2. Compiler and code-object metadata.
3. Build-system metadata.
4. AST or structured source analysis.
5. Naming conventions.
6. AI inference as a hint only.

Only verified fields may enter acceptance. Unverified AI fields stay in `ai_hints` and cannot satisfy proof gates.

### 2.3 CPU HMR versus GPU HMR firewall

GPU HMR success must be impossible if CPU/core HMR handled the edit.

Proof invariant:

```yaml
gpu_hmr_success: true
requires:
  cpu_hmr_used: false
  process_restarted: false
  full_rebuild_used: false
  changed_gpu_artifact_hash_loaded: true
  loaded_artifact_hash_published_as_epoch: true
  dispatch_used_published_epoch: true
  output_oracle_observed_after_epoch_dispatch: true
```

Host-only edit inside a GPU project must be represented as:

```yaml
project_kind: gpu_project
edit_kind: host_only
route: cpu_hmr_or_host_reload
gpu_hmr_success: false
gpu_runtime_unchanged: true
```

This distinction is mandatory in UI, logs, proof artifacts, and metrics.

## 3. Acceptance Contract Schema

The acceptance contract must describe both the project and why GPU HMR is safe. It is not enough to say "there is a GPU artifact."

Required top-level fields:

```yaml
contract_version: synthi.gpu_hmr.contract.v1
contract_id:
contract_hash:
project_id:
edit_id:
backend:
  value: hip | hiprt | opencl | vulkan | webgpu | bevy_wgsl | cuda | sycl | unknown
confidence:
evidence_refs: []
ai_hints: []
unsupported_reasons: []
failure_mode:
  value: reject | gpu_hmr_unsupported | full_rebuild_required
classification:
  project_kind:
    value: cpu_project | gpu_project | mixed_project | unknown
  edit_kind:
    value: gpu_artifact_edit | host_only | mixed_host_gpu | build_system | config | unknown
  route:
    value: gpu_hmr | cpu_hmr_or_host_reload | full_rebuild_required | reject
  confidence:
  blocking_gaps: []
```

Required artifact fields:

```yaml
artifact_identity:
  source_paths: []
  artifact_kind:
    value: hsaco | hip_source_bridge | spirv | wgsl | glsl | opencl_program | cuda_cubin | cuda_ptx | sycl_bundle | unknown
  entry_points: []
  compile_target:
  compiler:
  compiler_args_hash:
artifact_hash_before:
artifact_hash_after:
unaffected_artifacts_hash_unchanged: true | false
```

Required ABI fields:

```yaml
abi_compatibility_class:
  value: compatible | additive | layout_changed | unknown
  evidence_refs: []
  notes:
abi_metadata:
  args:
    - name:
      type:
      size:
      offset:
      value_kind:
      access:
      address_space:
      source: code_object | compiler_metadata | ast | runtime_trace | ai_hint
  descriptor_or_binding_layout:
  workgroup_or_launch_shape:
  stream_or_queue_requirements:
```

Important ABI warning:

HIP and AMDGPU code objects can expose argument metadata such as name, type, size, offset, value kind, and access fields. Those fields are useful evidence, but they do not prove semantic compatibility by themselves. Alias behavior, wrapper allocators, hidden layout dependencies, and framework handles can still make a syntactically compatible change unsafe.

ABI gate:

```text
compatible or additive ABI can proceed only when runtime dispatch and output oracle proof also pass.
layout_changed or unknown ABI must reject GPU HMR unless a backend-specific adapter and runtime probe explicitly prove safety.
```

Required reload fields:

```yaml
reload_mechanism:
  value: built_in | generated_adapter | api_interpose | engine_asset_reload | unsupported
adapter_outcome:
  value: adapter_generated | adapter_not_needed_builtin_reload | adapter_impossible_requires_app_hook
reload_evidence_refs: []
dispatch_trace_required: true
oracle_trace_required: true
```

Required state-preservation fields:

```yaml
state_preservation_checks:
  process_id:
  device_uuid:
  context_or_device_handle:
  queue_or_stream_handle:
  persistent_gpu_allocations:
  engine_scene_handles:
  camera_state_hash:
  swapchain_or_framebuffer_identity:
```

Required epoch fields:

```yaml
epoch_policy:
  publish_mechanism:
  dispatch_binding:
  retirement_mechanism:
epoch_retirement_proof:
  value: stream_event_proven | queue_idle_proven | frame_boundary_proven | no_retirement_required | unproven
  evidence_refs: []
```

## 4. Backend-Specific Contract Requirements

### 4.1 HIP and ROCm

HIP direct launch discovery is plausible because the APIs expose concrete launch boundaries:

- `hipLaunchKernelGGL`
- `hipModuleLoad`
- `hipModuleGetFunction`
- `hipModuleLaunchKernel`

Required HIP evidence:

```yaml
hip_contract:
  kernel_name:
  launch_api:
  grid_dim:
  block_dim:
  shared_mem_bytes:
  stream:
  kernel_params:
  code_object_metadata:
  output_buffers:
  readback_oracle:
```

Buffer direction inference order:

1. Runtime trace of allocations, copies, maps, dispatches, and readbacks.
2. Compiler and code-object metadata.
3. AST evidence.
4. Naming conventions.
5. AI inference, never authoritative.

Static analysis alone must not claim reliable read/write direction in C++ with aliasing, templates, wrapper allocators, custom memory pools, or opaque framework handles.

### 4.2 HIPRT

HIPRT is intentionally low-level. Applications own scene representation, BVH lifecycle, material buffers, camera state, and framebuffer ownership. The system must not pretend those are generically inferable.

Required HIPRT evidence:

```yaml
hiprt_contract:
  kernel_entry:
  scene_or_bvh_handles:
  framebuffer_handle:
  material_or_geometry_buffers:
  camera_state_hash:
  same_process_reload_hook:
  visual_oracle:
```

If scene/BVH/framebuffer handles cannot be observed or declared through an app hook, acceptance must fail with `adapter_impossible_requires_app_hook`.

### 4.3 Vulkan

Vulkan cannot be modeled as "replace shader module" only. Pipeline use depends on:

- SPIR-V module.
- Entry points.
- Descriptor set layouts.
- Pipeline layout.
- Linked shader stages.
- Vertex input state.
- Render pass or dynamic rendering state.
- Pipeline cache behavior.
- Command buffer recording.

Required Vulkan evidence:

```yaml
vulkan_contract:
  shader_module_hash_before:
  shader_module_hash_after:
  entry_point:
  descriptor_set_layout_hash:
  pipeline_layout_hash:
  pipeline_state_hash:
  command_buffer_re_record_required: true | false | unknown
  command_buffer_re_record_proven: true | false
  frame_used_new_pipeline_trace:
```

Epoch publication of a new pipeline handle is not sufficient when pre-recorded command buffers may reference the old pipeline. Dispatch proof must show the frame used a command buffer or dynamic state path bound to the new epoch.

### 4.4 WebGPU and Bevy WGSL

WebGPU reload is not just "replace WGSL." `createShaderModule()` creates a module from WGSL, but `createRenderPipeline()` binds stages, entry points, layouts, vertex buffers, targets, and render state.

Required WebGPU evidence:

```yaml
webgpu_contract:
  wgsl_hash_before:
  wgsl_hash_after:
  shader_module_epoch:
  entry_points:
  bind_group_layout_hash:
  pipeline_layout_hash:
  vertex_buffer_layout_hash:
  color_target_state_hash:
  pipeline_recreate_required: true | false | unknown
  pipeline_recreate_proven: true | false
  frame_used_new_pipeline_trace:
```

Bevy-specific rule:

```text
Bevy file-loaded WGSL shader assets can be candidates for engine asset reload.
Shaders embedded as static Rust strings, include_bytes, or non-watched embedded assets are not automatically reloadable.
```

Unsupported embedded shader paths must report `adapter_impossible_requires_app_hook`; they must not silently fall back to CPU HMR or full rebuild and still claim GPU HMR.

### 4.5 OpenCL

OpenCL is a useful validator because enqueue success only proves the kernel command was queued. It does not prove useful output.

Required OpenCL evidence:

```yaml
opencl_contract:
  program_hash_before:
  program_hash_after:
  kernel_name:
  command_queue:
  work_dim:
  global_work_size:
  local_work_size:
  event_trace:
  output_buffer_readback:
```

The oracle must observe output after an event associated with the new kernel epoch.

## 5. Classifier Plan

Classifier output must include confidence and hard blockers:

```yaml
classification: gpu_artifact_edit
confidence: 0.82
blocking_gaps:
  - no_runtime_loader
  - no_output_oracle
```

Classifier stages:

1. File and edit scan.
2. Build metadata scan.
3. GPU API and shader API scan.
4. Static source extraction.
5. Runtime probe availability check.
6. AI hint generation if static evidence is incomplete.
7. Contract field verification.

Hard rules:

- A host-only edit in a GPU project is not GPU HMR.
- A compile-only GPU artifact without same-process load proof is not GPU HMR.
- A loaded artifact without epoch dispatch proof is not GPU HMR.
- A dispatch without output proof is not GPU HMR.
- Any CPU fallback must set `gpu_hmr_success=false`.

## 6. Grand Fission Engine Plan

The fission engine must operate on the verified contract, not project names.

Responsibilities:

1. Select the smallest safe GPU rebuild unit.
2. Track dependency closure from build metadata and compiler inputs.
3. Verify ABI compatibility class.
4. Preserve unaffected artifacts.
5. Emit positive and negative proof.
6. Reject when the safe fission island is ambiguous.

Required fission report:

```yaml
fission_report:
  selected_island:
  selected_reason:
  changed_sources:
  included_dependencies:
  excluded_host_sources:
  artifact_hash_before:
  artifact_hash_after:
  abi_compatibility_class:
  full_device_fallback: false
  host_relinked: false
  process_restarted: false
  full_rebuild_used: false
  unaffected_artifacts_hash_unchanged: true
  selected_verifier_evidence_id:
  deterministic_verifier_evidence_refs: []
  selection_decision_hash:
  output_oracle_contract:
  evidence_refs: []
```

Friendly success cases are not enough. The fission engine must also pass hostile tests:

- Kernel argument added.
- Kernel argument reordered.
- Kernel renamed through C++ template mangling.
- Shader bind group layout changed.
- Vulkan pipeline layout changed.
- Pre-recorded command buffer uses old pipeline.
- Output buffer not copied back.
- Visual frame is blank.
- CPU fallback path exists.
- Process silently restarted.
- Full rebuild disguised as partial.

## 7. Epoch-Graft Runtime Plan

Epoch grafting must be API-specific. An atomic pointer swap is not enough.

Common proof sequence:

```text
artifact_after_hash compiled
artifact_after_hash loaded in same process
epoch N published
dispatch trace uses epoch N
output oracle observes data after epoch N dispatch
old epoch retired after backend-specific safety proof
```

HIP retirement:

- `hipModuleUnload` releases module resources and destroys associated code objects.
- Retirement must be protected by stream/event proof or an equivalent synchronization proof.
- The proof must identify the stream and event or state why no retirement is required.

Vulkan retirement:

- Old pipelines may be referenced by pre-recorded command buffers.
- Retirement must prove command buffers using old pipeline handles are no longer in flight or were re-recorded.
- Publishing a new pipeline object is not enough.

WebGPU and Bevy retirement:

- Proof must show the frame used the new shader module or pipeline.
- Asset-system file-change observation is not enough.
- The frame trace must link render output to the new epoch.

## 8. Adapter Synthesis Plan

"Generate or wrap one" is overclaimed unless the launch boundary is interposable.

Common impossible cases:

- Static linked host launch path with no reload hook.
- Engine-internal pipeline cache.
- Opaque render graph.
- Pre-recorded command buffers.
- JIT-managed kernels.
- Framework-generated shaders.
- Shader embedded as Rust `include_str!`, `include_bytes!`, C++ string literal, or generated resource.

Adapter synthesis outcomes:

```yaml
adapter_outcome:
  value: adapter_generated | adapter_not_needed_builtin_reload | adapter_impossible_requires_app_hook
reason:
required_app_hooks: []
evidence_refs: []
```

No silent fallback is allowed. If the adapter cannot be generated and no built-in reload exists, route to `gpu_hmr_unsupported` or `full_rebuild_required`.

## 9. Output Oracle Plan

### 9.1 Compute oracle

The compute proof card is for humans. Machine proof must be raw-data-backed.

Required artifacts:

```yaml
compute_oracle_artifacts:
  raw_readback_bin:
  readback_schema_json:
  checksum_before:
  checksum_after:
  deterministic_slice:
  oracle_code_hash:
  rendered_card_png:
  producer:
  timestamp_after_dispatch:
  epoch:
```

The rendered card must be derived from the raw readback data, not generated independently.

### 9.2 Visual oracle

Required visual proof fields:

```yaml
visual_oracle_artifacts:
  before_image:
  after_image:
  diff_image:
  blank_frame_rejection:
  same_frame_rejection:
  new_epoch_watermark_or_trace:
  camera_state_hash:
  swapchain_size:
  capture_backend:
  frame_number:
  timestamp_after_dispatch:
  perceptual_diff:
  changed_pixel_ratio:
  visible_pixel_count:
```

Pixel diffs are weak by themselves, especially for path tracing, temporal accumulation, TAA, denoisers, camera jitter, swapchain timing, and async presentation. Visual proof must therefore run in a deterministic validation mode whenever the backend can expose one.

Required deterministic validation controls:

```yaml
deterministic_visual_mode:
  fixed_seed:
  frozen_camera:
  temporal_accumulation_disabled:
  taa_disabled:
  denoiser_disabled:
  fixed_resolution:
  fixed_swapchain_image_count:
  frame_capture_after_epoch_dispatch:
  presentation_fence_or_frame_boundary:
  warmup_frames:
  convergence_window:
    frame_start:
    frame_end:
    metric:
      value: per_frame_delta | window_mean_delta | stable_histogram_delta | oracle_region_delta
```

For path tracing and temporally accumulated renderers, a single-frame diff is not enough unless the validation mode disables temporal behavior and fixes the random seed. If temporal behavior cannot be disabled, the proof must use a multi-frame convergence window and show that the post-epoch frames converge toward the expected changed output while the camera, seed policy, and scene state remain fixed.

Expected visual direction is useful but not always available. Acceptable proof modes:

```text
declared_expected_direction
or nonzero perceptual diff plus epoch-tagged dispatch trace
or test-specific visual oracle
```

Screenshot existence alone is not proof. Pixel diff alone is not enough when camera jitter, temporal accumulation, denoising, stale buffers, async presentation, or old frame capture can explain the difference.

## 10. Proof Ledger

The system needs an immutable proof ledger. GPU HMR success must be a query over ledger records, not a boolean returned by a script.

Required ledger record:

```yaml
proof_id:
project_id:
edit_id:
classification:
contract_hash:
artifact_before_hash:
artifact_after_hash:
loader_event:
epoch_publish_event:
dispatch_event:
output_event:
retirement_event:
process_identity:
device_identity:
cpu_hmr_used:
full_rebuild_used:
process_restarted:
oracle_artifacts:
timings:
model_provenance:
evidence_refs:
```

Ledger invariants:

```text
loader_event.artifact_hash == artifact_after_hash
epoch_publish_event.artifact_hash == artifact_after_hash
dispatch_event.epoch == epoch_publish_event.epoch
output_event.after_dispatch_id == dispatch_event.id
cpu_hmr_used == false
full_rebuild_used == false
process_restarted == false
```

If any invariant fails, `gpu_hmr_success=false`.

## 11. Metrics Schema

Use one timing schema across Flow, HIPRT, ROCm, Bevy, OpenCL, Vulkan, and future projects.

Required clock discipline:

```yaml
metric_clock: monotonic_ns
metric_scope:
  value: cold | warm | hot_delta_1 | hot_delta_2
cache_state:
  value: clean | compiler_cache_warm | pipeline_cache_warm
```

Separate wall-clock time from GPU event time. HIP event timing can omit system-scope release and cache flush work, so GPU events must not be reported as total HMR time.

Required timing fields:

```yaml
timings:
  static_discovery_time:
  ai_contract_synthesis_time:
  model_availability_check_time:
  artifact_hash_time:
  adapter_generation_time:
  device_compile_wall_time:
  artifact_load_time:
  epoch_publish_time:
  dispatch_trace_time:
  runtime_probe_time:
  oracle_analysis_time:
  trigger_to_visible_time:
  screenshot_capture_time:
  dispatch_to_output_proof_time:
  total_validator_wall_time:
```

Model provenance fields from section 2.1 must be included in the same ledger entry as the timings.

### 11.1 Validator Fast-Path Performance Plan

The validation framework must distinguish the user-facing HMR fast path from the proof-finalization path:

```text
edit -> compile -> artifact load -> epoch publish -> visible/output-ready signal
```

must not wait on full-frame image decoding, full-matrix proof collection, cross-container binary copies, or archival artifact rendering unless those steps are required before a specific acceptance decision can be emitted. The proof system must still fail closed: a fast visible signal is not GPU HMR acceptance until the strict ledger, dispatch, and output oracle gates pass.

Required performance architecture:

```yaml
validator_fast_path:
  visual_analysis_executor:
    value: rust_worker | napi_rust_worker | node_worker_thread | unavailable
    proof_ready_event_required: true
    executor_identity:
    executable_hash:
    schema_version:
    evidence_refs: []
  incremental_visual_proof:
    roi_or_tile_manifest_required: true
    deterministic_oracle_region_hash_before:
    deterministic_oracle_region_hash_after:
    tile_hash_grid:
      tile_size:
      changed_tile_count:
      total_tile_count:
      changed_tile_hashes: []
    full_frame_diff_required_when:
      - oracle_region_hash_changed_but_bounds_unknown
      - roi_or_tile_manifest_missing
      - deterministic_visual_mode_unproven
      - visual_threshold_result_ambiguous
  artifact_transport:
    value: cas_shared_volume | cas_tmpfs | direct_worker_path | serialized_fallback
    content_address:
    manifest_hash:
    shared_volume_identity:
    producer_container:
    consumer_container:
    byte_length:
    no_docker_cp_required_for_fast_path: true | false
    no_base64_frame_transport_required_for_fast_path: true | false
```

Visual analysis should move out of the main validator event loop. The preferred implementation is a Rust proof worker, either as a standalone binary reached through a durable manifest/proof-ready event, or as a Rust-backed N-API module when embedding is clearly safer. A Node `worker_threads` implementation is acceptable only as an interim executor or compatibility fallback, and it must record that executor identity in proof metadata. Worker execution is a performance mechanism, not an authority shortcut.

Incremental visual proof must be project-agnostic. A profile may declare an ROI only as a typed oracle region with hashes, dimensions, capture backend, deterministic visual controls, and evidence refs. If the ROI or tile manifest is absent, stale, out of bounds, mismatched to the frame hash, or disconnected from the post-epoch capture, the validator must fall back to the stricter full-frame visual proof or reject. It must not infer success from project names, target names, fixture names, or hand-picked pixel regions.

Artifact transport should use content-addressable storage wherever possible. Worker, MCP, and frontend containers should share a bind mount or tmpfs CAS root for heavy proof artifacts such as frames, raw readback bytes, code objects, and rendered proof cards. The fast path should pass only a compact manifest with content addresses, hashes, byte lengths, producer identity, and allowed reader identities. `docker cp`, base64 screenshots over WebSocket, stdout JSON blobs containing binary data, and repeated re-materialization are allowed only as explicit fallback paths and must be recorded as transport limitations in timing/proof metadata.

Acceptance rules:

```text
CAS presence is not proof by itself.
ROI hash change is not proof by itself.
Worker proof-ready event is not proof by itself.
Serialized fallback transport must not be hidden from total validator wall time.
Any missing or mismatched content address, byte length, frame hash, ROI manifest, worker executable hash, or proof-ready event fails closed.
```

Implementation checkpoint, 2026-06-27:

- A reusable async visual proof bundle now writes before/after/diff image artifacts through generic CAS manifests, runs visual decode/diff work in the existing visual proof worker, records tile/ROI-capable async metrics, and emits visual transport evidence as non-authoritative support metadata.
- The WebGPU runtime visual proof runner uses that bundle for real browser-captured frame proof instead of doing the full image diff in the runner path. The strict ledger still accepts only the existing visual oracle artifacts, epoch/dispatch proof, deterministic visual controls, process continuity, and runtime proof artifact gates.
- The async visual proof worker now records a content-addressed worker executable hash and executor identity. The parent runner rejects accepted-looking worker results when the worker proof-ready event is missing, the worker is not proven off the main thread, or the worker executable hash is missing or mismatched.
- The worker executable hash is now a local module-graph hash over the worker entry, parent wrapper, and artifact-CAS helper rather than a single-file hash. Matrix summaries retain the non-volatile executor identity, executable manifest hash, schema, and module count while stripping volatile thread IDs.
- The worker executable identity now also binds the native image backend identity. The matrix requires a `synthi.gpu_hmr.visual_worker_native_dependency_manifest.v1` record for `sharp`/libvips runtime versions before async visual support evidence can accept.
- ROI early exit is guarded by tile evidence. An unchanged ROI can skip full-frame diff only when tile hashes show no changed tiles; if changed tiles appear outside or ambiguously around the ROI, or if tile hashing is disabled, the worker falls back to full-frame visual proof instead of treating the ROI hash as sufficient.
- Tile grids and ROI hashes now carry typed `synthi.gpu_hmr.visual_incremental_evidence_binding.v1` records bound to before/after encoded hashes, raw frame hashes, dimensions, tile-list hash, ROI hashes, and optional deterministic visual-mode hash. The matrix recomputes the binding hash and fails closed on stale or mismatched incremental evidence.
- Direct worker paths and diff output paths require explicit allowed roots, and readable CAS local paths are resolved through realpath checks before bytes are consumed. CAS manifests that claim GPU HMR success through camelCase or snake_case fields are rejected as transport-only evidence.
- The agent-split visual proof runner now schedules candidate post-HMR frame comparisons through bounded concurrent worker-thread visual proof tasks instead of awaiting every candidate serially. The generic `SYNTHI_GPU_HMR_VISUAL_WORKER_PARALLELISM` / profile `visualProof.workerParallelism` knob is recorded as `synthi.gpu_hmr.visual_delta_worker_scheduling.v1` support evidence with `acceptedForGpuHmr=false` and `gpuHmrSuccess=false`; strict visual proof still requires the selected before/after/diff artifacts and runtime ledger closure.
- The validation matrix now recomputes before/after visual-pair metrics from async visual-worker output (`matrix_async_visual_worker_rgba`) instead of duplicating the full pair RGBA diff in the matrix process. Worker timeout/failure, dimension mismatch, zero delta, blank after frames, or blank diff images still fail closed; this is generic matrix infrastructure and not a target-specific success path.
- Source-first agent-split proof results now redact key/token/authorization-shaped provider diagnostics before writing console output, latest-result JSON/TXT, or archived result artifacts. Provider failure remains fail-closed and cannot satisfy AI split, runtime epoch, visual proof, or GPU HMR ledger gates.
- Real ROCm proof scheduling now consumes generic upstream lifecycle refusal evidence. Configure/build failures, missing build dependencies, and not-started runs can reduce strict wait windows only as refusal-only `real_rocm_proof_scheduling` evidence; plain upstream run failure does not prove runtime-stage absence, and no timeout-intelligence facet can authorize GPU HMR success. When upstream lifecycle evidence proves runtime stages cannot appear, the runner may skip async runtime waits and emit an explicit `proof_scheduling_skipped_async_runtime_wait` result; the matrix accepts that only as refusal evidence.
- Frontend, MCP, and worker compose services now expose a shared artifact CAS root at `/var/lib/synthi/artifact-cas`, including the NVIDIA override path. The real ROCm runner can derive generic source-tree shared-mount plans from environment-declared roles or from the compose-default shared root, stage a repository under `source-trees/<repo>/<commit>`, inspect the matching Git commit inside the worker, and record `cas_shared_volume` transport evidence. This is a transport optimization and audit facet only; runtime proof gates still require artifact transport into the target process, epoch publication, dispatch trace, host identity, and output-oracle closure.
- CAS transport evidence, native worker identity, ROI/tile bindings, and worker proof-ready events remain `acceptedForGpuHmr=false` support evidence by themselves. They can reduce hot-path blocking and improve auditability, but cannot authorize GPU HMR success without the strict proof ledger.

## 12. Validation Matrix

The matrix must include positive, negative, and ambiguous cases.

Negative and adversarial cases must run before broad success cases. The first validation milestone is not "SAXPY passed"; it is "the system refuses fake GPU HMR."

Phase 1 negative targets:

- Host-only edit in GPU project.
- Mixed host+GPU edit.
- ABI-changing kernel edit.
- Kernel argument added.
- Kernel argument reordered.
- Shader layout-changing edit.
- Vulkan pipeline layout changed.
- Unsupported embedded shader.
- No readback path.
- Process restart.
- Full rebuild.
- CPU fallback.
- Compile success but no dispatch.
- Dispatch success but no output change.
- Visual frame is blank.
- Same frame recaptured after edit.
- Camera jitter creates fake visual diff.
- Temporal accumulation creates nondeterministic diff.
- Old artifact dispatched.
- Readback from stale buffer.
- Async presentation captures pre-epoch frame.

Phase 2 positive targets:

- HIP direct launch.
- HIP module launch.
- OpenCL source rebuild.
- WebGPU WGSL compute.
- WebGPU or wgpu render shader.
- Bevy file-loaded WGSL.
- HIPRT visual path.
- Flow visual GPU path.
- At least one larger engine-style repo.

Per-target required run modes:

```text
adversarial refusal cases first
cold split
hot delta 1
hot delta 2 with a different edit
negative edit
visual or compute oracle proof
ledger invariant query
consistent timing report
```

Random large-project cold-path lane:

```text
selection_seed recorded
repo_url and immutable commit recorded
large-project size signals recorded
cold source-tree intake from an unmodified checkout
build metadata discovery from the project's real build system
GPU/runtime boundary classification without project-name success branches
visual or compute oracle contract derived only when evidence exists
strict acceptance only through the same loader, epoch, dispatch, host-identity, output-oracle, firewall, and ledger gates
otherwise fail closed with precise unsupported/missing-proof gaps
```

This lane must periodically sample serious user-scale projects outside the hand-maintained fixture set. A sampled project does not need to accept GPU HMR to be useful; a correct cold refusal with source-tree transport, build/runtime diagnostics, and no fake visual proof is part of the proof system. The sample set must be reproducible through the recorded seed, repo URL, commit, profile/adaptor declarations, and retained artifacts.

Passing only friendly targets such as SAXPY, matrix multiply, histogram, prefix sum, HIPRT, Flow, and Bevy is not enough to prove generality.

## 13. Subagent Workstreams

Subagents can be used, but the main thread owns final architecture and code decisions.

Suggested workstreams:

- Subagent A: CPU HMR versus GPU HMR routing audit.
- Subagent B: real project research and backend boundary discovery.
- Subagent C: fission and epoch proof schema review.
- Subagent D: validation matrix runner and artifact collector.
- Subagent E: adversarial validator that attempts false GPU HMR passes.
- Subagent F: validator fast-path performance audit for Rust visual workers, ROI/tile proof, and CAS/shared-volume artifact transport.

Subagent E should explicitly try to create fake successes:

- Compile log counted as proof.
- Old artifact dispatched.
- CPU fallback used.
- Visual diff from camera jitter.
- Readback from stale buffer.
- Process restarted.
- Full rebuild hidden in timing.

Subagent F should explicitly review performance without weakening proof gates:

- Main-thread image decode, full-frame diff, and PNG encode hotspots.
- Base64, `docker cp`, stdout JSON, and repeated file materialization bottlenecks.
- Generic CAS manifest schemas that do not encode project, fixture, backend, or library names.
- ROI/tile visual proof failure cases where stale bounds, camera jitter, blank frames, or pre-epoch captures could fake success.
- Evidence needed to prove that the proof worker itself did not become an untracked oracle.

## 14. Implementation Order

### Step 1: Adversarial refusal harness

Build the negative validator before celebrating additional positive profiles. The harness must prove that fake GPU HMR is rejected when CPU HMR is used, the process restarts, a full rebuild is hidden, an old artifact dispatches, no output is produced after the new epoch, visual frames are blank or stale, or temporal/camera jitter explains the diff.

### Step 2: Deterministic visual oracle modes

Add fixed seed, frozen camera, temporal accumulation disablement, TAA/denoiser disablement where available, presentation-fence capture, and multi-frame convergence windows for path tracing and temporal renderers.

### Step 3: Model availability gate

Replace dead preview delta-model defaults with `gemini-3.1-flash-lite`, add provider model status fields, and fail loudly when a configured model is shutdown.

### Step 4: Contract schema and classifier output

Introduce the full acceptance contract schema, classification confidence, hard blockers, unsupported reasons, and CPU/GPU routing firewall.

### Step 5: Proof ledger

Emit immutable proof records and derive `gpu_hmr_success` from ledger invariants.

### Step 6: ABI compatibility class

Add ABI metadata extraction and classify edits as `compatible`, `additive`, `layout_changed`, or `unknown`.

### Step 7: Runtime dispatch and oracle gates

Require dispatch trace and oracle trace for GPU HMR acceptance. Move screenshot/readback artifacts into the ledger.

### Step 8: Backend-specific compatibility

Implement HIP/HIPRT first, then OpenCL, then WebGPU/Bevy, then Vulkan. Vulkan requires the strongest pipeline-layout and command-buffer proof.

### Step 9: Positive validation matrix expansion

Only after the adversarial refusal harness passes should the matrix broaden scoped positive candidates across HIP, HIPRT, OpenCL, WebGPU, Bevy, Flow, Vulkan, and larger engine-style projects.

### Step 10: Timing normalization

Unify all validation scripts under the monotonic metric schema.

### Step 11: Validator fast-path performance

Move heavy visual validation and binary artifact transport off the main validator path without changing acceptance semantics.

Implementation order:

1. Introduce executor metadata and proof-ready event schemas for visual analysis.
2. Add a background visual proof worker path, preferably Rust or Rust-backed N-API, with a Node worker fallback only when recorded explicitly.
3. Add typed ROI/tile manifests and deterministic oracle-region hashes.
4. Add CAS/shared-volume manifests for frames, raw readbacks, code objects, and proof cards.
5. Keep serialized base64 and `docker cp` paths as measured fallbacks, not the preferred fast path.
6. Require validation matrix self-checks for forged ROI hashes, stale tiles, missing CAS bytes, mismatched byte lengths, wrong worker executable hashes, and proof-ready events without ledger output.

### Step 12: Source-first uncompiled project validation

After the scoped profile/runtime rows and fast-path proof worker gates are stable, test the user-facing path from source/project input instead of precompiled device artifacts.

Required behavior:

1. Ingest an uncompiled project or workspace source tree without assuming a pre-existing generated `.hip`, WGSL, HSACO, shader module, or code object.
2. Let the AI split/proposal path derive GPU candidates, but keep every AI field as a hint until verified by compiler, build metadata, runtime trace, and output oracle evidence.
3. Compile the proposed smallest safe GPU artifact through the normal backend toolchain.
4. Publish a real runtime epoch and prove post-epoch output with visual or compute oracle artifacts.
5. Preserve generic failure modes when the source tree lacks enough GPU evidence, build metadata, backend runtime, app hook, or output oracle proof.
6. Record visual proof when the source-first path produces a visual target; logs alone cannot satisfy this milestone.
7. Run cold-path intake on randomly sampled large arbitrary projects, recording the selection seed, immutable commit, build-system metadata, runtime-boundary evidence, and fail-closed gaps when the project lacks a same-process loader, app hook, dispatch trace, host identity, output oracle, or deterministic visual/compute proof.

This step must remain project-agnostic. Fixture-backed tests may be used as smoke coverage only when they exercise the same source-first ingestion, split, compile, runtime, and oracle machinery that an arbitrary user project would use. A fixture name, profile ID, or target string must never satisfy acceptance gates.

Current source-first gate requirements:

1. Agent-split run-mode rows must carry `synthi.gpu.hmr.agent_split_source_first_ingestion.v1` provenance before they can count as generated/profiled visual runtime evidence.
2. That provenance is explicitly non-authoritative: `proofAuthority=source_first_ingestion_provenance_only_not_runtime_proof`, `acceptedForGpuHmr=false`, `gpuHmrSuccess=false`, and `canSatisfyRuntimeProof=false`.
3. The matrix recomputes the source-first proof id from the seed source hash, entry path, target id, initial source manifest hash, generated artifact hashes, sidecar hash, and compile manifest hash.
4. The initial compile manifest must contain the seeded source path and a content hash matching the source profile; an empty manifest, stale proof id, or pre-existing Synthi generated artifact/metadata path fails closed.
5. Multi-file source-first profiles may declare a typed `source.files` source-tree manifest. Every declared source-tree file must carry an explicit sha256 content hash, must be seeded into the initial compile payload, and the matrix recomputes `sourceTreeManifestHash` from the actual initial compile manifest. A profile-declared tree that omits headers, build files, or any other declared source input from the initial compile must fail closed with `source_first_source_tree_manifest_mismatch`.
6. Generated artifact paths must resolve to the generated artifact namespace, and the initial manifest must not contain a file whose content hash overlaps the later generated artifact, sidecar, or compile-manifest hash. Ordinary-looking paths such as build caches cannot bypass this content-addressed boundary.
7. Worker log text about AI split activity is corroborating evidence only. The accepted source-first boundary requires structured split/sidecar evidence, generated artifact hashes, and later runtime ledger closure.
8. The gate must not depend on a fixed split file count, target name, fixture id, source-tree shape, or project-specific success branch.
9. Runner-level source-first provenance must fail before matrix ingestion when generated artifacts are not in the generated artifact namespace. Matrix recomputation remains the aggregate authority and repeats the same namespace, manifest, hash-overlap, proof-id, and target-binding checks.
10. Source-first visual coverage also requires support-only async visual/CAS evidence: `proof_ready` off-main-thread visual metrics, a content-addressed worker executable hash, bound native image dependency identity, typed tile/ROI incremental evidence binding, manifest-only CAS locators for before/after/diff visual artifacts, `workerCasInputAccepted=true`, and CAS hashes matching the matrix-recomputed image hashes. This facet is `proofAuthority=async_visual_metrics_and_transport_only`, `acceptedForGpuHmr=false`, and `gpuHmrSuccess=false`; it can support dev-loop viability evidence but cannot authorize GPU HMR acceptance without strict runtime-ledger closure.

## 15. Stronger Definition Of Done

GPU HMR is accepted only when:

1. A typed backend contract is derived from static and runtime evidence.
2. AI-proposed fields are verified before acceptance.
3. The changed GPU artifact is rebuilt as the smallest safe fission island.
4. The ABI compatibility class is known and accepted for the backend.
5. The new artifact hash is loaded into the same running process.
6. The runtime publishes a new epoch without process restart.
7. A dispatch trace proves epoch N was used.
8. Old epochs retire only after backend-specific stream, queue, or frame safety proof.
9. A compute or deterministic visual oracle observes output produced after epoch N dispatch.
10. CPU HMR, full rebuild, and process restart are explicitly false.
11. All timings follow the same monotonic schema.
12. Unknown projects fail with specific missing contract fields.

## 16. Highest-Priority Fixes

1. Build the adversarial refusal harness before broad positive validation.
2. Add deterministic visual oracle modes and multi-frame convergence windows.
3. Replace the dead delta model requirement.
4. Add provider model availability and deprecation fields to provenance.
5. Add ABI compatibility class to the contract.
6. Add the proof ledger.
7. Make adapter synthesis fail loudly when launch boundaries are not interposable.
8. Treat visual and readback proof as mandatory ledger artifacts, not validator logs.
