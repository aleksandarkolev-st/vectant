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

2026-06-30 unprofiled arbitrary cold-intake follow-up: the random large-project sampler no longer requires every candidate to have a packaged profile. Candidates without `profilePath` are normalized as `profileMode=unprofiled_arbitrary_project_cold_intake`, retain repo URL, immutable commit, size signals, build-system hints, runtime-boundary hints, and oracle hints, and then refuse with generic missing-proof gaps instead of inventing a profile or launching a project-specific runner. A non-profiled public-project check resolved `https://github.com/ggerganov/llama.cpp.git` to commit `4f31eedb0ccf546b7e8d6bb243b170f12522f54d` and retained final manifest `sha256:14b3264161ccb3287169b53bf57ce952dfa037be3c8623e0242f968e6ee7b177` plus pending manifest `sha256:1df6b36feb42287741016189037af9a17ed2177ea3d97451f43ffe9efd9d266d`. It correctly stayed `unprofiled_arbitrary_project_cold_intake_refused` with missing local backend runner, runtime profile contract, build metadata verification, same-process loader, epoch, dispatch trace, host identity, output oracle, and strict runtime ledger proof. This expands random cold-path testing toward real user projects without converting repo identity, build hints, or arbitrary project selection into GPU HMR proof.

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

2026-06-30 latest matrix after the stricter Vulkan host-runtime proof, OpenCL host-runtime proof, source-first explicit-role hardening, runtime-adapter boundary-import hardening, runtime-boundary event-manifest materializer, matrix-level broad-proof scaffold, include-closure rerun, and fresh bounded large-ROCm MIOpen refresh: `gpu-validation-matrix-ledger:sha256:e9ee4aaa7c6386b325780c2ddc0261df7e42337c3e9c1ac6b3b9b0c6ac634bd2`, JSON `mcp/synthi-mcp/.gpu-hmr-test-logs/validation-matrix/gpu-hmr-validation-matrix-20260630T133648Z.json`, 63 rows, 17 accepted full-runtime GPU HMR rows, 17 broad library-agnostic full-runtime GPU HMR rows by matrix-computed proof, 0 scoped full-runtime GPU HMR rows after broad matrix classification, 17 all full-runtime rows, 33 refusals, 7 cold splits, 2 deterministic fission rows, 3 visual-profile rows, 1 preflight-only row, and 0 included unproven rows. Current strict full-runtime backend families are `hip`, `opencl`, `vulkan`, and `webgpu`; current full-runtime scope breakdown is `generated_rocm_hip_preview_visual: 2`, `hip_module_declared_compute_readback: 2`, `opencl_declared_compute_readback: 2`, `vulkan_declared_pipeline_visual: 1`, `webgpu_declared_compute_readback: 2`, and `webgpu_declared_pipeline_visual: 8`. `per_target_run_modes status=accepted`; `per_target_run_modes open gap: none`. Broad readiness is now `accepted=true` with broad proof `gpu-hmr-broad-library-agnostic-proof:sha256:ceecc271c663a3d21619119e1c80eb171f317dabe4deebc6d837c40ef65a7ea3`. This is a validation-matrix generalization proof across strict accepted rows and adversarial refusals, not a claim that every arbitrary GPU project, framework, or large ROCm library is production accepted without its own same-process loader, epoch, dispatch, host-identity, output-oracle, firewall, and strict ledger proof.

2026-06-30 matrix-level broad-proof scaffold follow-up: validation-matrix coverage now emits a recomputed `synthi.gpu_hmr.broad_library_agnostic_matrix_proof.v1` object from strict accepted full-runtime rows only. Broad rows require the matrix proof to accept, not a row-declared broad claim. The proof requires at least four backend families, four acceptance scopes, visual and compute oracle coverage, and eight adversarial refusal rows; forged row-level broad declarations still fail closed. The current local matrix now satisfies that scaffold through HIP, OpenCL, Vulkan, and WebGPU strict rows, while real project acceptance still remains per-target and fail-closed.

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
