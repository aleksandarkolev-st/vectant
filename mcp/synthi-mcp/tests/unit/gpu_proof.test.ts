import { describe, expect, it } from "vitest";
import {
  classifyGpuHmrProofMessage,
  gpuHmrDegradedStateRankCap,
  gpuHmrProofStateRank,
  validateGpuHmrProofState,
} from "../../src/gpu_proof.js";
import { queryGpuHmrLedgerInvariants } from "../../src/gpu_proof_ledger.js";

const HASH_A = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const HASH_B = "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const HASH_C = "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";
const HIP_FIELD_EVIDENCE_REFS = {
  kernel_name: ["runtime:dispatch-kernel"],
  launch_api: ["runtime:dispatch-launch-api"],
  grid_dim: ["runtime:dispatch-grid"],
  block_dim: ["runtime:dispatch-block"],
  shared_mem_bytes: ["runtime:dispatch-shared-mem"],
  stream: ["runtime:dispatch-stream"],
  kernel_params: ["runtime:dispatch-params"],
  code_object_metadata: ["code-object:metadata"],
  output_buffers: ["runtime:output-buffer"],
  readback_oracle: ["runtime:readback-oracle"],
};

function timingMetrics() {
  return {
    metric_clock: "monotonic_ns",
    metric_scope: "hot_delta_1",
    cache_state: "compiler_cache_warm",
    static_discovery_time: 1,
    ai_contract_synthesis_time: 2,
    model_availability_check_time: 3,
    artifact_hash_time: 4,
    adapter_generation_time: 5,
    device_compile_wall_time: 6,
    artifact_load_time: 7,
    epoch_publish_time: 8,
    dispatch_trace_time: 9,
    runtime_probe_time: 10,
    oracle_analysis_time: 11,
    trigger_to_visible_time: 12,
    screenshot_capture_time: 13,
    dispatch_to_output_proof_time: 14,
    total_validator_wall_time: 15,
  };
}

function proofLedger(overrides: Record<string, unknown> = {}) {
  const record = {
    project_id: "generic-gpu-project",
    edit_id: "gpu-edit",
    backend: "hip",
    classification: {
      project_kind: "gpu_project",
      edit_kind: "gpu_artifact_edit",
      route: "gpu_hmr",
    },
    contract_hash: HASH_C,
    artifact_before_hash: HASH_A,
    artifact_after_hash: HASH_B,
    loader_event: { id: "load-1", artifact_hash: HASH_B, process_id: "pid-1", timestamp_monotonic_ns: 100 },
    epoch_publish_event: { id: "publish-1", epoch: "epoch-2", artifact_hash: HASH_B, process_id: "pid-1", timestamp_monotonic_ns: 200 },
    dispatch_event: { id: "dispatch-1", epoch: "epoch-2", artifact_hash: HASH_B, process_id: "pid-1", timestamp_monotonic_ns: 300 },
    output_event: {
      id: "output-1",
      kind: "buffer_checksum",
      epoch: "epoch-2",
      artifact_hash: HASH_B,
      process_id: "pid-1",
      after_dispatch_id: "dispatch-1",
      passed: true,
      timestamp_monotonic_ns: 400,
    },
    retirement_event: { id: "retire-1", epoch: "epoch-1", proof: "stream_event_proven", timestamp_monotonic_ns: 500 },
    process_identity: { process_id: "pid-1" },
    device_identity: { device_uuid: "device-1" },
    cpu_hmr_used: false,
    full_rebuild_used: false,
    process_restarted: false,
    oracle_artifacts: {
      compute_oracle_artifacts: {
        raw_readback_bin: "memory://readback.bin",
        readback_schema_json: "memory://schema.json",
        checksum_before: HASH_A,
        checksum_after: HASH_B,
        deterministic_slice: { offset: 0, length: 32, hash: HASH_C },
        raw_readback_hash: HASH_B,
        raw_readback_hash_verified: true,
        raw_readback_byte_length: 64,
        raw_readback_source: "runtime_readback_sample",
        deterministic_slice_hash: HASH_C,
        deterministic_slice_hash_verified: true,
        raw_readback_verification: {
          hash_verified: true,
          byte_length: 64,
          deterministic_slice_hash: HASH_C,
          deterministic_slice_hash_verified: true,
          slice_bounds_verified: true,
        },
        oracle_code_hash: HASH_C,
        rendered_card_png: "memory://card.png",
        producer: "gpu_proof.test",
        timestamp_after_dispatch: 400,
        epoch: "epoch-2",
      },
    },
    metric_clock: "monotonic_ns",
    metric_scope: "hot_delta_1",
    cache_state: "compiler_cache_warm",
    timings: timingMetrics(),
    model_provenance: {
      split: {
        provider: "google_gemini",
        requested_model: "gemini-3.5-flash",
        provider_model_status: "available",
        provider_model_alias_resolved_to: null,
        provider_shutdown_or_deprecation_detected: false,
        model_availability_checked_at: "2026-06-07T00:00:00.000Z",
        model_availability_source: "https://ai.google.dev/gemini-api/docs/deprecations",
        model_availability_basis: "static_registry",
        model_availability_check_time_ms: 0,
        actual_model: "gemini-3.5-flash",
        fallback_model: null,
        fallback_used: false,
        request_mode: "split",
        hard_infra_failure: false,
      },
      gpu_delta: {
        provider: "google_gemini",
        requested_model: "gemini-3.1-flash-lite",
        provider_model_status: "deprecated",
        provider_model_alias_resolved_to: null,
        provider_shutdown_or_deprecation_detected: true,
        model_availability_checked_at: "2026-06-07T00:00:00.000Z",
        model_availability_source: "https://ai.google.dev/gemini-api/docs/deprecations",
        model_availability_basis: "static_registry",
        model_availability_check_time_ms: 0,
        actual_model: "gemini-3.1-flash-lite",
        fallback_model: null,
        fallback_used: false,
        request_mode: "gpu_delta",
        hard_infra_failure: false,
      },
    },
    evidence_refs: ["runtime:load", "runtime:dispatch", "runtime:output"],
    ...overrides,
  };
  const ledger = {
    schemaVersion: "synthi.gpu.hmr.proof_ledger.v1",
    records: [record],
    gpuHmrSuccess: true,
  };
  const query = queryGpuHmrLedgerInvariants(ledger);
  return {
    ...ledger,
    proofId: query.proofId,
    gpuHmrSuccess: query.gpuHmrSuccess,
    query,
  };
}

function acceptanceContract(ledger = proofLedger(), overrides: Record<string, unknown> = {}) {
  const record = ledger.records[0] as Record<string, any>;
  const artifactBeforeHash = record.artifact_before_hash ?? HASH_A;
  const artifactAfterHash = record.artifact_after_hash ?? HASH_B;
  const contractHash = record.contract_hash ?? HASH_C;
  return {
    contract_version: "synthi.gpu_hmr.contract.v1",
    project_id: record.project_id ?? "generic-gpu-project",
    edit_id: record.edit_id ?? "gpu-edit",
    contract_hash: contractHash,
    backend: "hip",
    confidence: 0.95,
    evidence_refs: ["static:hip-launch", "runtime:module-load"],
    classification: {
      project_kind: "gpu_project",
      edit_kind: "gpu_artifact_edit",
      route: "gpu_hmr",
      confidence: 0.95,
      blocking_gaps: [],
    },
    artifact_identity: {
      source_paths: ["src/gpu/kernel.hip"],
      artifact_kind: "hsaco",
      entry_points: ["kernel_main"],
      compile_target: "gfx1201",
      compiler: "hipcc",
      compiler_args_hash: HASH_C,
    },
    artifact_hash_before: artifactBeforeHash,
    artifact_hash_after: artifactAfterHash,
    unaffected_artifacts_hash_unchanged: true,
    abi_compatibility_class: {
      value: "compatible",
      evidence_refs: ["code-object:metadata"],
    },
    abi_metadata: {
      args: [{
        name: "output",
        type: "float*",
        size: 8,
        offset: 0,
        value_kind: "device_pointer",
        access: "write",
        address_space: "global",
        source: "code_object",
      }],
      workgroup_or_launch_shape: {
        grid_dim: [64, 1, 1],
        block_dim: [256, 1, 1],
        shared_mem_bytes: 0,
      },
      stream_or_queue_requirements: { stream: "stream-1" },
      extractor_sources: ["clang_ast"],
    },
    reload_mechanism: "generated_adapter",
    adapter_outcome: "adapter_generated",
    reload_evidence_refs: ["runtime:module-load"],
    firewall_evidence: {
      route: "gpu_device_sidecar_reload",
      evidence_source: "test:gpu-route-classifier",
      evidence_refs: ["test:gpu-route-classifier"],
      cpu_hmr_used: false,
      full_rebuild_used: false,
      process_restarted: false,
      process_id_before: "pid-1",
      process_id_after: "pid-1",
    },
    dispatch_trace_required: true,
    oracle_trace_required: true,
    state_preservation_checks: {
      process_id: "pid-1",
      device_uuid: "device-1",
      context_or_device_handle: "hip-context-1",
      queue_or_stream_handle: "stream-1",
      persistent_gpu_allocations: ["allocation-output"],
    },
    epoch_policy: {
      publish_mechanism: "runtime_epoch_publish",
      dispatch_binding: "dispatch_table_epoch_binding",
      retirement_mechanism: "stream_event",
    },
    epoch_retirement_proof: {
      value: "stream_event_proven",
      evidence_refs: ["runtime:stream-event"],
    },
    fission_report: {
      selected_island: "device-kernel",
      selected_reason: "verified_fission_contract",
      artifact_hash_before: artifactBeforeHash,
      artifact_hash_after: artifactAfterHash,
      full_device_fallback: false,
      host_relinked: false,
      process_restarted: false,
      full_rebuild_used: false,
    },
    hip_contract: {
      kernel_name: "kernel_main",
      launch_api: "hipModuleLaunchKernel",
      grid_dim: [64, 1, 1],
      block_dim: [256, 1, 1],
      shared_mem_bytes: 0,
      stream: "stream-1",
      kernel_params: [{ name: "output", kind: "device_pointer" }],
      code_object_metadata: {
        source: "amd_code_object_metadata",
        args_hash: HASH_C,
      },
      output_buffers: ["allocation-output"],
      readback_oracle: {
        kind: "raw_readback",
        schema_hash: HASH_C,
      },
      field_evidence_refs: HIP_FIELD_EVIDENCE_REFS,
    },
    ...overrides,
  };
}

function runtimeProofArtifact(ledger = proofLedger(), overrides: Record<string, unknown> = {}) {
  const contract = acceptanceContract(ledger);
  const ledgerRecord = (ledger.records as unknown[] | undefined)?.[0] as Record<string, unknown> | undefined;
  return {
    schemaVersion: "synthi.gpu.hmr.validation-proof.v1",
    proofId: "gpu-runtime-proof:fixture",
    resultState: "gpu-hmr-full-runtime-proven",
    fullRuntimeProven: true,
    gpuHmrSuccess: true,
    stageResults: [
      { stageId: "fission-candidate-verification", status: "passed" },
      { stageId: "compile", status: "passed" },
      { stageId: "symbol-binding", status: "passed" },
      { stageId: "abi", status: "passed" },
      { stageId: "artifact-transport", status: "passed" },
      { stageId: "epoch-swap", status: "passed" },
      { stageId: "dispatch-safe", status: "passed" },
      { stageId: "output", status: "passed" },
      { stageId: "artifact-identity", status: "passed" },
      { stageId: "host-preservation", status: "passed" },
    ],
    limitations: [],
    proofLedger: ledger,
    proofLedgerQuery: ledger.query,
    acceptanceContract: contract,
    acceptanceContractEvaluation: {
      accepted: true,
      failedGates: [],
    },
    derivedAcceptanceContract: contract,
    derivedAcceptanceContractEvaluation: {
      accepted: true,
      failedGates: [],
    },
    acceptanceContractConsistency: {
      accepted: true,
      failedGates: [],
    },
    explicitProofLedgerRecord: null,
    derivedProofLedgerRecord: ledgerRecord,
    proofLedgerSourceConsistency: {
      accepted: true,
      failures: [],
      failedGates: [],
    },
    ...overrides,
  };
}

function outputOracleRuntimeProofArtifact(
  ledger = proofLedger(),
  overrides: Record<string, unknown> = {}
) {
  return runtimeProofArtifact(ledger, {
    resultState: "gpu-hmr-output-oracle-proven",
    fullRuntimeProven: false,
    gpuHmrSuccess: false,
    stageResults: [
      { stageId: "fission-candidate-verification", requiredState: "gpu-hmr-full-runtime-proven", status: "passed" },
      { stageId: "compile", requiredState: "gpu-hmr-compile-proven", status: "passed" },
      { stageId: "symbol-binding", requiredState: "gpu-hmr-symbol-bound", status: "passed" },
      { stageId: "abi", requiredState: "gpu-hmr-abi-proven", status: "passed" },
      { stageId: "artifact-transport", requiredState: "gpu-hmr-epoch-swap-proven", status: "passed" },
      { stageId: "epoch-swap", requiredState: "gpu-hmr-epoch-swap-proven", status: "passed" },
      { stageId: "dispatch-safe", requiredState: "gpu-hmr-dispatch-safe-proven", status: "passed" },
      { stageId: "output", requiredState: "gpu-hmr-output-oracle-proven", status: "passed" },
      { stageId: "artifact-identity", requiredState: "gpu-hmr-full-runtime-proven", status: "passed" },
      { stageId: "host-preservation", requiredState: "gpu-hmr-host-preservation-proven", status: "blocked" },
    ],
    limitations: [{
      stageId: "full-runtime",
      status: "blocked",
      requiredState: "gpu-hmr-full-runtime-proven",
      observedState: "gpu-hmr-output-oracle-proven",
      degradedReason: "full_runtime_proof_not_proven",
    }],
    ...overrides,
  });
}

describe("GPU HMR proof-state validation", () => {
  it("parses worker proof-state status telemetry", () => {
    const proof = classifyGpuHmrProofMessage({
      status: "gpu-proof-state",
      schemaVersion: "synthi.gpu.hmr.proof.v1",
      resultState: "gpu-hmr-symbol-bound",
      degradedState: "gpu-hmr-dispatch-unobserved",
      degradedReason: "runtime_dispatch_not_observed",
      label: "gpu-hmr-partial",
      proofId: "gpu-proof:abc",
      proofArtifactPath: ".synthi/gpu-hmr/proofs/gpu-proof_abc.json",
    });

    expect(proof?.schemaVersion).toBe("synthi.gpu.hmr.proof.v1");
    expect(proof?.source).toBe("gpu-proof-state");
    expect(proof?.proofId).toBe("gpu-proof:abc");
    expect(proof?.proofArtifactPath).toBe(".synthi/gpu-hmr/proofs/gpu-proof_abc.json");
    expect(proof?.resultState).toBe("gpu-hmr-symbol-bound");
  });

  it("parses JSON proof log telemetry", () => {
    const proof = classifyGpuHmrProofMessage({
      type: "gpu_hmr_proof",
      schemaVersion: "synthi.gpu.hmr.proof.v1",
      resultState: "gpu-hmr-compile-proven",
    });

    expect(proof?.source).toBe("gpu_hmr_proof");
    expect(proof?.resultState).toBe("gpu-hmr-compile-proven");
  });

  it("orders proof states by the declared proof ladder", () => {
    expect(gpuHmrProofStateRank("gpu-hmr-full-runtime-proven")).toBeGreaterThan(
      gpuHmrProofStateRank("gpu-hmr-symbol-bound")
    );
    expect(gpuHmrProofStateRank("gpu-hmr-dispatch-safe-proven")).toBeGreaterThan(
      gpuHmrProofStateRank("gpu-hmr-abi-proven")
    );
    expect(gpuHmrDegradedStateRankCap("gpu-hmr-output-unobserved")).toBe(
      gpuHmrProofStateRank("gpu-hmr-dispatch-safe-proven")
    );
  });

  it("rejects weaker proof than the caller requested", () => {
    const proof = classifyGpuHmrProofMessage({
      status: "gpu-proof-state",
      resultState: "gpu-hmr-symbol-bound",
    });

    const validation = validateGpuHmrProofState(proof, "gpu-hmr-full-runtime-proven");

    expect(validation.satisfied).toBe(false);
    expect(validation.reason).toBe("proof_state_below_required");
    expect(validation.resultState).toBe("gpu-hmr-symbol-bound");
  });

  it("caps overclaimed proof by degraded state", () => {
    const proof = classifyGpuHmrProofMessage({
      status: "gpu-proof-state",
      resultState: "gpu-hmr-full-runtime-proven",
      degradedState: "gpu-hmr-output-unobserved",
      stageResults: [{ stageId: "dispatch-safe", status: "passed" }],
    });

    const dispatchValidation = validateGpuHmrProofState(proof, "gpu-hmr-dispatch-safe-proven");
    expect(dispatchValidation.satisfied).toBe(true);
    expect(dispatchValidation.effectiveResultRank).toBe(
      gpuHmrProofStateRank("gpu-hmr-dispatch-safe-proven")
    );

    const fullValidation = validateGpuHmrProofState(proof, "gpu-hmr-full-runtime-proven");
    expect(fullValidation.satisfied).toBe(false);
    expect(fullValidation.reason).toBe("degraded_state_blocks_required_proof");
    expect(fullValidation.degradedStateRankCap).toBe(
      gpuHmrProofStateRank("gpu-hmr-dispatch-safe-proven")
    );
  });

  it("blocks dispatch proof when dispatch was unobserved", () => {
    const proof = classifyGpuHmrProofMessage({
      status: "gpu-proof-state",
      resultState: "gpu-hmr-full-runtime-proven",
      degradedState: "gpu-hmr-dispatch-unobserved",
    });

    const validation = validateGpuHmrProofState(proof, "gpu-hmr-dispatch-observed");

    expect(validation.satisfied).toBe(false);
    expect(validation.reason).toBe("degraded_state_blocks_required_proof");
    expect(validation.effectiveResultRank).toBe(gpuHmrProofStateRank("gpu-hmr-epoch-swap-proven"));
  });

  it("caps render proof when required visual evidence is missing", () => {
    const proof = classifyGpuHmrProofMessage({
      status: "gpu-proof-state",
      resultState: "gpu-hmr-output-oracle-proven",
      degradedState: "gpu-hmr-visual-evidence-missing",
      stageResults: [{ stageId: "dispatch-safe", status: "passed" }],
    });

    const dispatchValidation = validateGpuHmrProofState(proof, "gpu-hmr-dispatch-safe-proven");
    expect(dispatchValidation.satisfied).toBe(true);
    expect(dispatchValidation.effectiveResultRank).toBe(
      gpuHmrProofStateRank("gpu-hmr-dispatch-safe-proven")
    );

    const outputValidation = validateGpuHmrProofState(proof, "gpu-hmr-output-oracle-proven");
    expect(outputValidation.satisfied).toBe(false);
    expect(outputValidation.reason).toBe("degraded_state_blocks_required_proof");
    expect(outputValidation.degradedStateRankCap).toBe(
      gpuHmrProofStateRank("gpu-hmr-dispatch-safe-proven")
    );
  });

  it("requires a proof ledger for output oracle proof validation", () => {
    const proof = classifyGpuHmrProofMessage({
      status: "gpu-proof-state",
      resultState: "gpu-hmr-output-oracle-proven",
    });

    const validation = validateGpuHmrProofState(proof, "gpu-hmr-output-oracle-proven");

    expect(validation.satisfied).toBe(false);
    expect(validation.reason).toBe("proof_ledger_missing");
    expect(validation.proofLedgerValidation).toBeNull();
    expect(validation.runtimeProofArtifactValidation).toBeUndefined();
  });

  it("rejects output oracle proof when the embedded ledger rejects", () => {
    const ledger = proofLedger({ cpu_hmr_used: true });
    const proof = classifyGpuHmrProofMessage({
      status: "gpu-proof-state",
      resultState: "gpu-hmr-output-oracle-proven",
      proofLedger: ledger,
    });

    const validation = validateGpuHmrProofState(proof, "gpu-hmr-output-oracle-proven");

    expect(validation.satisfied).toBe(false);
    expect(validation.reason).toBe("proof_ledger_rejected");
    expect(validation.proofLedgerValidation?.gpuHmrSuccess).toBe(false);
    expect(validation.proofLedgerValidation?.failedInvariants.map((failure) => failure.code)).toContain(
      "cpu_hmr_used"
    );
    expect(validation.runtimeProofArtifactValidation).toBeUndefined();
  });

  it("rejects output oracle proof when firewall process identity contradicts no-restart evidence", () => {
    const ledger = proofLedger({
      firewall_evidence: {
        cpu_hmr_used: false,
        full_rebuild_used: false,
        process_restarted: false,
        process_id_before: "pid-1",
        process_id_after: "pid-2",
      },
    });
    const proof = classifyGpuHmrProofMessage({
      status: "gpu-proof-state",
      resultState: "gpu-hmr-output-oracle-proven",
      proofLedger: ledger,
    });

    const validation = validateGpuHmrProofState(proof, "gpu-hmr-output-oracle-proven");

    expect(validation.satisfied).toBe(false);
    expect(validation.reason).toBe("proof_ledger_rejected");
    expect(validation.proofLedgerValidation?.failedInvariants.map((failure) => failure.code)).toEqual(
      expect.arrayContaining([
        "firewall_process_identity_contradiction",
        "firewall_process_identity_after_mismatch",
      ])
    );
  });

  it("rejects output oracle proof when numeric firewall process identity changes", () => {
    const ledger = proofLedger({
      process_identity: {
        process_id: 100,
      },
      loader_event: { id: "load-1", artifact_hash: HASH_B, process_id: 100, timestamp_monotonic_ns: 100 },
      epoch_publish_event: {
        id: "publish-1",
        epoch: "epoch-2",
        artifact_hash: HASH_B,
        process_id: 100,
        timestamp_monotonic_ns: 200,
      },
      dispatch_event: {
        id: "dispatch-1",
        epoch: "epoch-2",
        artifact_hash: HASH_B,
        process_id: 100,
        timestamp_monotonic_ns: 300,
      },
      output_event: {
        id: "output-1",
        kind: "buffer_checksum",
        epoch: "epoch-2",
        artifact_hash: HASH_B,
        process_id: 100,
        after_dispatch_id: "dispatch-1",
        passed: true,
        timestamp_monotonic_ns: 400,
      },
      firewall_evidence: {
        cpu_hmr_used: false,
        full_rebuild_used: false,
        process_restarted: false,
        processIdBefore: 100,
        processIdAfter: 101,
      },
    });
    const proof = classifyGpuHmrProofMessage({
      status: "gpu-proof-state",
      resultState: "gpu-hmr-output-oracle-proven",
      proofLedger: ledger,
    });

    const validation = validateGpuHmrProofState(proof, "gpu-hmr-output-oracle-proven");

    expect(validation.satisfied).toBe(false);
    expect(validation.reason).toBe("proof_ledger_rejected");
    expect(validation.proofLedgerValidation?.failedInvariants.map((failure) => failure.code)).toEqual(
      expect.arrayContaining([
        "firewall_process_identity_contradiction",
        "firewall_process_identity_after_mismatch",
      ])
    );
  });

  it("rejects output oracle proof when the ledger proof id is not content-addressed", () => {
    const ledger = proofLedger();
    const record = ledger.records[0] as Record<string, unknown>;
    const forgedProofId = "gpu-ledger-proof:not-content-addressed";
    record.proofId = forgedProofId;
    ledger.proofId = forgedProofId;
    ledger.query = {
      ...ledger.query,
      proofId: forgedProofId,
    };
    const proof = classifyGpuHmrProofMessage({
      status: "gpu-proof-state",
      resultState: "gpu-hmr-output-oracle-proven",
      proofLedger: ledger,
    });

    const validation = validateGpuHmrProofState(proof, "gpu-hmr-output-oracle-proven");

    expect(validation.satisfied).toBe(false);
    expect(validation.reason).toBe("proof_ledger_rejected");
    expect(validation.proofLedgerValidation?.failedInvariants.map((failure) => failure.code)).toEqual(
      expect.arrayContaining(["record_proof_id_mismatch", "ledger_proof_id_mismatch"])
    );
  });

  it("rejects output oracle proof when a content-addressed ledger field is tampered", () => {
    const ledger = proofLedger();
    const record = ledger.records[0] as Record<string, any>;
    record.proofId = ledger.proofId;
    record.model_provenance.gpu_delta.actual_model = "gemini-3.1-flash-lite-tampered";

    const proof = classifyGpuHmrProofMessage({
      status: "gpu-proof-state",
      resultState: "gpu-hmr-output-oracle-proven",
      proofLedger: ledger,
    });

    const validation = validateGpuHmrProofState(proof, "gpu-hmr-output-oracle-proven");

    expect(validation.satisfied).toBe(false);
    expect(validation.reason).toBe("proof_ledger_rejected");
    expect(validation.proofLedgerValidation?.failedInvariants.map((failure) => failure.code)).toEqual(
      expect.arrayContaining([
        "record_proof_id_mismatch",
        "ledger_proof_id_mismatch",
        "supplied_ledger_query_mismatch",
      ])
    );
  });

  it("rejects a multi-record ledger when an earlier record fails", () => {
    const rejectedLedger = proofLedger({ cpu_hmr_used: true });
    const acceptedLedger = proofLedger({ edit_id: "gpu-edit-2" });
    const ledger = {
      schemaVersion: "synthi.gpu.hmr.proof_ledger.v1",
      records: [rejectedLedger.records[0], acceptedLedger.records[0]],
      gpuHmrSuccess: true,
    };

    const validation = queryGpuHmrLedgerInvariants(ledger);

    expect(validation.gpuHmrSuccess).toBe(false);
    expect(validation.failedInvariants).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "cpu_hmr_used", record_index: 0 }),
        expect.objectContaining({ code: "ledger_success_flag_mismatch" }),
      ])
    );
  });

  it("rejects a multi-record ledger whose top proof id only names the last record", () => {
    const firstLedger = proofLedger();
    const lastLedger = proofLedger({ edit_id: "gpu-edit-2" });
    const ledger = {
      schemaVersion: "synthi.gpu.hmr.proof_ledger.v1",
      proofId: lastLedger.proofId,
      records: [firstLedger.records[0], lastLedger.records[0]],
      gpuHmrSuccess: true,
    };

    const validation = queryGpuHmrLedgerInvariants(ledger);

    expect(validation.gpuHmrSuccess).toBe(false);
    expect(validation.failedInvariants.map((failure) => failure.code)).toContain(
      "ledger_proof_id_mismatch"
    );
  });

  it("rejects output oracle proof when event chronology is invalid", () => {
    const cases = [
      {
        name: "epoch publish before load",
        ledger: proofLedger({
          epoch_publish_event: {
            id: "publish-1",
            epoch: "epoch-2",
            artifact_hash: HASH_B,
            process_id: "pid-1",
            timestamp_monotonic_ns: 50,
          },
        }),
        expectedCode: "epoch_publish_precedes_loader",
      },
      {
        name: "dispatch before epoch publish",
        ledger: proofLedger({
          dispatch_event: {
            id: "dispatch-1",
            epoch: "epoch-2",
            artifact_hash: HASH_B,
            process_id: "pid-1",
            timestamp_monotonic_ns: 150,
          },
        }),
        expectedCode: "dispatch_precedes_epoch_publish",
      },
      {
        name: "retirement before output",
        ledger: proofLedger({
          retirement_event: {
            id: "retire-1",
            epoch: "epoch-1",
            proof: "stream_event_proven",
            timestamp_monotonic_ns: 350,
          },
        }),
        expectedCode: "retirement_precedes_output",
      },
      {
        name: "retirement timestamp missing",
        ledger: proofLedger({
          retirement_event: {
            id: "retire-1",
            epoch: "epoch-1",
            proof: "stream_event_proven",
          },
        }),
        expectedCode: "retirement_timestamp_missing",
      },
    ];

    for (const testCase of cases) {
      const proof = classifyGpuHmrProofMessage({
        status: "gpu-proof-state",
        resultState: "gpu-hmr-output-oracle-proven",
        proofLedger: testCase.ledger,
      });

      const validation = validateGpuHmrProofState(proof, "gpu-hmr-output-oracle-proven");

      expect(validation.satisfied, testCase.name).toBe(false);
      expect(validation.reason, testCase.name).toBe("proof_ledger_rejected");
      expect(
        validation.proofLedgerValidation?.failedInvariants.map((failure) => failure.code),
        testCase.name
      ).toContain(testCase.expectedCode);
    }
  });

  it("rejects output oracle proof with a recomputed accepted ledger and no runtime artifact", () => {
    const ledger = proofLedger();
    const proof = classifyGpuHmrProofMessage({
      status: "gpu-proof-state",
      resultState: "gpu-hmr-output-oracle-proven",
      proofLedger: ledger,
    });

    const validation = validateGpuHmrProofState(proof, "gpu-hmr-output-oracle-proven");

    expect(validation.satisfied).toBe(false);
    expect(validation.reason).toBe("runtime_proof_artifact_missing");
    expect(validation.proofLedgerValidation?.gpuHmrSuccess).toBe(true);
    expect(validation.runtimeProofArtifactValidation?.accepted).toBe(false);
    expect(validation.runtimeProofArtifactValidation?.failedGates.map((gate) => gate.code)).toContain(
      "runtime_proof_artifact_missing"
    );
  });

  it("accepts output oracle proof with a source-consistent runtime artifact before full runtime proof", () => {
    const ledger = proofLedger();
    const proof = classifyGpuHmrProofMessage({
      status: "gpu-proof-state",
      resultState: "gpu-hmr-output-oracle-proven",
      proofLedger: ledger,
      runtimeProofArtifact: outputOracleRuntimeProofArtifact(ledger),
    });

    const validation = validateGpuHmrProofState(proof, "gpu-hmr-output-oracle-proven");

    expect(validation.satisfied).toBe(true);
    expect(validation.proofLedgerValidation?.gpuHmrSuccess).toBe(true);
    expect(validation.runtimeProofArtifactValidation?.accepted).toBe(true);
  });

  it("rejects lower proof states without stage material or an artifact reference", () => {
    const proof = classifyGpuHmrProofMessage({
      status: "gpu-proof-state",
      resultState: "gpu-hmr-symbol-bound",
    });

    const validation = validateGpuHmrProofState(proof, "gpu-hmr-symbol-bound");

    expect(validation.satisfied).toBe(false);
    expect(validation.reason).toBe("proof_material_missing");
    expect(validation.proofLedgerValidation).toBeUndefined();
    expect(validation.runtimeProofArtifactValidation).toBeUndefined();
  });

  it("allows lower proof states with a proof artifact reference", () => {
    const proof = classifyGpuHmrProofMessage({
      status: "gpu-proof-state",
      resultState: "gpu-hmr-symbol-bound",
      proofId: "gpu-proof:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      proofArtifactPath: ".synthi/gpu-hmr/proofs/gpu-proof_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.json",
    });

    const validation = validateGpuHmrProofState(proof, "gpu-hmr-symbol-bound");

    expect(validation.satisfied).toBe(true);
    expect(validation.proofLedgerValidation).toBeUndefined();
    expect(validation.runtimeProofArtifactValidation).toBeUndefined();
  });

  it("rejects lower proof artifact references with unverifiable identity", () => {
    const proof = classifyGpuHmrProofMessage({
      status: "gpu-proof-state",
      resultState: "gpu-hmr-symbol-bound",
      proofId: "gpu-proof:not-a-hash",
      proofArtifactPath: ".synthi/gpu-hmr/proofs/gpu-proof_not-a-hash.json",
    });

    const validation = validateGpuHmrProofState(proof, "gpu-hmr-symbol-bound");

    expect(validation.satisfied).toBe(false);
    expect(validation.reason).toBe("proof_material_identity_unverifiable");
  });

  it("rejects lower proof states when embedded stage material is not passed", () => {
    const proof = classifyGpuHmrProofMessage({
      status: "gpu-proof-state",
      resultState: "gpu-hmr-symbol-bound",
      proofId: "gpu-proof:blocked-stage-artifact",
      proofArtifactPath: ".synthi/gpu-hmr/proofs/gpu-proof_blocked-stage-artifact.json",
      stageResults: [{ stageId: "symbol-binding", status: "blocked" }],
    });

    const validation = validateGpuHmrProofState(proof, "gpu-hmr-symbol-bound");

    expect(validation.satisfied).toBe(false);
    expect(validation.reason).toBe("proof_stage_not_passed");
  });

  it("accepts lower proof states when embedded stage material passed", () => {
    const proof = classifyGpuHmrProofMessage({
      status: "gpu-proof-state",
      resultState: "gpu-hmr-symbol-bound",
      stageResults: [{ stageId: "symbol-binding", status: "passed" }],
    });

    const validation = validateGpuHmrProofState(proof, "gpu-hmr-symbol-bound");

    expect(validation.satisfied).toBe(true);
  });

  it("treats unknown degraded states as proof blockers", () => {
    const proof = classifyGpuHmrProofMessage({
      status: "gpu-proof-state",
      resultState: "gpu-hmr-full-runtime-proven",
      degradedState: "gpu-hmr-new-unknown-degradation",
    });

    const validation = validateGpuHmrProofState(proof, "gpu-hmr-compile-proven");

    expect(validation.satisfied).toBe(false);
    expect(validation.reason).toBe("unknown_degraded_proof_state");
    expect(validation.effectiveResultRank).toBe(0);
  });

  it("requires ledger-backed runtime artifact success for full runtime proof validation", () => {
    const ledger = proofLedger();
    const proof = classifyGpuHmrProofMessage({
      status: "gpu-proof-state",
      resultState: "gpu-hmr-full-runtime-proven",
      proofLedger: ledger,
      runtimeProofArtifact: runtimeProofArtifact(ledger),
    });

    const validation = validateGpuHmrProofState(proof, "gpu-hmr-full-runtime-proven");

    expect(validation.satisfied).toBe(true);
    expect(validation.proofLedgerValidation?.gpuHmrSuccess).toBe(true);
    expect(validation.runtimeProofArtifactValidation?.accepted).toBe(true);
  });

  it("accepts runtime proof telemetry when the runtime artifact proof id matches", () => {
    const ledger = proofLedger();
    const proof = classifyGpuHmrProofMessage({
      status: "gpu-proof-state",
      resultState: "gpu-hmr-full-runtime-proven",
      proofId: "gpu-runtime-proof:fixture",
      proofLedger: ledger,
      runtimeProofArtifact: runtimeProofArtifact(ledger),
    });

    const validation = validateGpuHmrProofState(proof, "gpu-hmr-full-runtime-proven");

    expect(validation.satisfied).toBe(true);
    expect(validation.runtimeProofArtifactValidation?.accepted).toBe(true);
  });

  it("rejects runtime proof telemetry whose artifact proof id is missing", () => {
    const ledger = proofLedger();
    const proof = classifyGpuHmrProofMessage({
      status: "gpu-proof-state",
      resultState: "gpu-hmr-full-runtime-proven",
      proofId: "gpu-runtime-proof:fixture",
      proofLedger: ledger,
      runtimeProofArtifact: runtimeProofArtifact(ledger, {
        proofId: undefined,
      }),
    });

    const validation = validateGpuHmrProofState(proof, "gpu-hmr-full-runtime-proven");

    expect(validation.satisfied).toBe(false);
    expect(validation.reason).toBe("runtime_proof_artifact_rejected");
    expect(validation.runtimeProofArtifactValidation?.failedGates.map((gate) => gate.code)).toContain(
      "runtime_proof_artifact_proof_id_missing"
    );
  });

  it("rejects runtime proof telemetry whose artifact proof id does not match", () => {
    const ledger = proofLedger();
    const proof = classifyGpuHmrProofMessage({
      status: "gpu-proof-state",
      resultState: "gpu-hmr-full-runtime-proven",
      proofId: "gpu-runtime-proof:fixture",
      proofLedger: ledger,
      runtimeProofArtifact: runtimeProofArtifact(ledger, {
        proofId: "gpu-runtime-proof:other",
      }),
    });

    const validation = validateGpuHmrProofState(proof, "gpu-hmr-full-runtime-proven");

    expect(validation.satisfied).toBe(false);
    expect(validation.reason).toBe("runtime_proof_artifact_rejected");
    expect(validation.runtimeProofArtifactValidation?.failedGates.map((gate) => gate.code)).toContain(
      "runtime_proof_artifact_proof_id_mismatch"
    );
  });

  it("rejects ledger-only full runtime proof telemetry", () => {
    const proof = classifyGpuHmrProofMessage({
      status: "gpu-proof-state",
      resultState: "gpu-hmr-full-runtime-proven",
      proofLedger: proofLedger(),
    });

    const validation = validateGpuHmrProofState(proof, "gpu-hmr-full-runtime-proven");

    expect(validation.satisfied).toBe(false);
    expect(validation.reason).toBe("runtime_proof_artifact_missing");
    expect(validation.proofLedgerValidation?.gpuHmrSuccess).toBe(true);
    expect(validation.runtimeProofArtifactValidation?.failedGates.map((gate) => gate.code)).toContain(
      "runtime_proof_artifact_missing"
    );
  });

  it("rejects flat telemetry masquerading as a runtime proof artifact", () => {
    const ledger = proofLedger();
    const artifact = runtimeProofArtifact(ledger);
    const proof = classifyGpuHmrProofMessage({
      status: "gpu-proof-state",
      resultState: "gpu-hmr-full-runtime-proven",
      proofLedger: ledger,
      fullRuntimeProven: true,
      gpuHmrSuccess: true,
      stageResults: artifact.stageResults,
      limitations: [],
      proofLedgerQuery: ledger.query,
      acceptanceContract: artifact.acceptanceContract,
      acceptanceContractEvaluation: artifact.acceptanceContractEvaluation,
      acceptanceContractConsistency: artifact.acceptanceContractConsistency,
      proofLedgerSourceConsistency: artifact.proofLedgerSourceConsistency,
    });

    const validation = validateGpuHmrProofState(proof, "gpu-hmr-full-runtime-proven");

    expect(validation.satisfied).toBe(false);
    expect(validation.reason).toBe("runtime_proof_artifact_missing");
    expect(validation.runtimeProofArtifactValidation?.failedGates.map((gate) => gate.code)).toContain(
      "runtime_proof_artifact_missing"
    );
  });

  it("rejects full runtime artifact whose embedded ledger query is forged", () => {
    const ledger = proofLedger();
    const forgedArtifactLedger = proofLedger();
    const forgedRecord = forgedArtifactLedger.records[0] as Record<string, unknown>;
    forgedRecord.cpu_hmr_used = true;
    forgedArtifactLedger.query = {
      ...forgedArtifactLedger.query,
      gpuHmrSuccess: true,
      failedInvariants: [],
    };
    const proof = classifyGpuHmrProofMessage({
      status: "gpu-proof-state",
      resultState: "gpu-hmr-full-runtime-proven",
      proofLedger: ledger,
      runtimeProofArtifact: runtimeProofArtifact(forgedArtifactLedger),
    });

    const validation = validateGpuHmrProofState(proof, "gpu-hmr-full-runtime-proven");

    expect(validation.satisfied).toBe(false);
    expect(validation.reason).toBe("runtime_proof_artifact_rejected");
    expect(validation.runtimeProofArtifactValidation?.failedGates.map((gate) => gate.code)).toEqual(
      expect.arrayContaining(["proof_ledger_recomputed_query_rejected", "proof_ledger_query_mismatch"])
    );
  });

  it("rejects full runtime artifact with forged acceptance contract evaluation", () => {
    const ledger = proofLedger();
    const proof = classifyGpuHmrProofMessage({
      status: "gpu-proof-state",
      resultState: "gpu-hmr-full-runtime-proven",
      proofLedger: ledger,
      runtimeProofArtifact: runtimeProofArtifact(ledger, {
        acceptanceContract: {
          contract_version: "synthi.gpu_hmr.contract.v1",
          contract_hash: HASH_C,
        },
        acceptanceContractEvaluation: {
          accepted: true,
          failedGates: [],
        },
      }),
    });

    const validation = validateGpuHmrProofState(proof, "gpu-hmr-full-runtime-proven");

    expect(validation.satisfied).toBe(false);
    expect(validation.reason).toBe("runtime_proof_artifact_rejected");
    expect(validation.runtimeProofArtifactValidation?.failedGates.map((gate) => gate.code)).toEqual(
      expect.arrayContaining([
        "acceptance_contract_recomputed_rejected",
        "acceptance_contract_evaluation_mismatch",
      ])
    );
  });

  it("rejects full runtime artifact with forged acceptance contract consistency", () => {
    const ledger = proofLedger();
    const derivedContract = acceptanceContract(ledger);
    const proof = classifyGpuHmrProofMessage({
      status: "gpu-proof-state",
      resultState: "gpu-hmr-full-runtime-proven",
      proofLedger: ledger,
      runtimeProofArtifact: runtimeProofArtifact(ledger, {
        acceptanceContract: acceptanceContract(ledger, {
          project_id: "forged-gpu-project",
        }),
        acceptanceContractEvaluation: {
          accepted: true,
          failedGates: [],
        },
        derivedAcceptanceContract: derivedContract,
        derivedAcceptanceContractEvaluation: {
          accepted: true,
          failedGates: [],
        },
        acceptanceContractConsistency: {
          accepted: true,
          failedGates: [],
        },
      }),
    });

    const validation = validateGpuHmrProofState(proof, "gpu-hmr-full-runtime-proven");

    expect(validation.satisfied).toBe(false);
    expect(validation.reason).toBe("runtime_proof_artifact_rejected");
    expect(validation.runtimeProofArtifactValidation?.failedGates.map((gate) => gate.code)).toContain(
      "acceptance_contract_consistency_recomputed_rejected"
    );
  });

  it("rejects full runtime artifact with forged proof ledger source consistency", () => {
    const ledger = proofLedger();
    const explicitRecord = {
      ...(ledger.records[0] as Record<string, unknown>),
      dispatch_event: {
        ...(ledger.records[0] as Record<string, any>).dispatch_event,
        id: "forged-dispatch",
      },
    };
    const proof = classifyGpuHmrProofMessage({
      status: "gpu-proof-state",
      resultState: "gpu-hmr-full-runtime-proven",
      proofLedger: ledger,
      runtimeProofArtifact: runtimeProofArtifact(ledger, {
        explicitProofLedgerRecord: explicitRecord,
        proofLedgerSourceConsistency: {
          accepted: true,
          failures: [],
          failedGates: [],
        },
      }),
    });

    const validation = validateGpuHmrProofState(proof, "gpu-hmr-full-runtime-proven");

    expect(validation.satisfied).toBe(false);
    expect(validation.reason).toBe("runtime_proof_artifact_rejected");
    expect(validation.runtimeProofArtifactValidation?.failedGates.map((gate) => gate.code)).toContain(
      "proof_ledger_source_consistency_recomputed_rejected"
    );
  });

  it("rejects full runtime artifact bound to a different ledger identity", () => {
    const ledger = proofLedger();
    const otherLedger = proofLedger({
      project_id: "different-gpu-project",
      edit_id: "different-edit",
      contract_hash: "sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
      dispatch_event: {
        id: "dispatch-other",
        epoch: "epoch-2",
        artifact_hash: HASH_B,
        process_id: "pid-1",
        timestamp_monotonic_ns: 300,
      },
      output_event: {
        id: "output-other",
        kind: "buffer_checksum",
        epoch: "epoch-2",
        artifact_hash: HASH_B,
        process_id: "pid-1",
        after_dispatch_id: "dispatch-other",
        passed: true,
        timestamp_monotonic_ns: 400,
      },
    });
    const proof = classifyGpuHmrProofMessage({
      status: "gpu-proof-state",
      resultState: "gpu-hmr-full-runtime-proven",
      proofLedger: ledger,
      runtimeProofArtifact: runtimeProofArtifact(otherLedger),
    });

    const validation = validateGpuHmrProofState(proof, "gpu-hmr-full-runtime-proven");

    expect(validation.satisfied).toBe(false);
    expect(validation.reason).toBe("runtime_proof_artifact_rejected");
    expect(validation.runtimeProofArtifactValidation?.failedGates.map((gate) => gate.code)).toEqual(
      expect.arrayContaining([
        "runtime_artifact_ledger_project_id_mismatch",
        "runtime_artifact_ledger_edit_id_mismatch",
        "runtime_artifact_ledger_contract_hash_mismatch",
        "runtime_artifact_ledger_dispatch_event_id_mismatch",
        "runtime_artifact_ledger_output_event_id_mismatch",
      ])
    );
  });

  it("rejects full runtime artifact bound to a different backend", () => {
    const ledger = proofLedger({ backend: "hip" });
    const otherLedger = proofLedger({ backend: "opencl" });
    const proof = classifyGpuHmrProofMessage({
      status: "gpu-proof-state",
      resultState: "gpu-hmr-full-runtime-proven",
      proofLedger: ledger,
      runtimeProofArtifact: runtimeProofArtifact(otherLedger),
    });

    const validation = validateGpuHmrProofState(proof, "gpu-hmr-full-runtime-proven");

    expect(validation.satisfied).toBe(false);
    expect(validation.reason).toBe("runtime_proof_artifact_rejected");
    expect(validation.runtimeProofArtifactValidation?.failedGates.map((gate) => gate.code)).toContain(
      "runtime_artifact_ledger_backend_mismatch"
    );
  });

  it("rejects full runtime artifact with missing expected ledger identity", () => {
    const ledger = proofLedger();
    const underSpecifiedLedger = proofLedger();
    const record = underSpecifiedLedger.records[0] as Record<string, any>;
    record.dispatch_event = {
      epoch: "epoch-2",
      artifact_hash: HASH_B,
      process_id: "pid-1",
      timestamp_monotonic_ns: 300,
    };
    const proof = classifyGpuHmrProofMessage({
      status: "gpu-proof-state",
      resultState: "gpu-hmr-full-runtime-proven",
      proofLedger: ledger,
      runtimeProofArtifact: runtimeProofArtifact(underSpecifiedLedger),
    });

    const validation = validateGpuHmrProofState(proof, "gpu-hmr-full-runtime-proven");

    expect(validation.satisfied).toBe(false);
    expect(validation.reason).toBe("runtime_proof_artifact_rejected");
    expect(validation.runtimeProofArtifactValidation?.failedGates.map((gate) => gate.code)).toContain(
      "runtime_artifact_ledger_dispatch_event_id_missing"
    );
  });

  it("rejects full runtime artifact bound to a different output oracle target", () => {
    const ledger = proofLedger({
      output_oracle_target: {
        kind: "compute",
        target_id: "compute-target:a",
        compute_only_target_verified: true,
        evidence_refs: ["oracle-target:compute:a"],
      },
    });
    const otherLedger = proofLedger({
      output_oracle_target: {
        kind: "compute",
        target_id: "compute-target:b",
        compute_only_target_verified: true,
        evidence_refs: ["oracle-target:compute:b"],
      },
    });
    const proof = classifyGpuHmrProofMessage({
      status: "gpu-proof-state",
      resultState: "gpu-hmr-full-runtime-proven",
      proofLedger: ledger,
      runtimeProofArtifact: runtimeProofArtifact(otherLedger),
    });

    const validation = validateGpuHmrProofState(proof, "gpu-hmr-full-runtime-proven");

    expect(validation.satisfied).toBe(false);
    expect(validation.reason).toBe("runtime_proof_artifact_rejected");
    expect(validation.runtimeProofArtifactValidation?.failedGates.map((gate) => gate.code)).toContain(
      "runtime_artifact_ledger_output_oracle_target_mismatch"
    );
  });

  it("rejects full runtime proof when delta model provenance is shutdown", () => {
    const ledger = proofLedger();
    const record = ledger.records[0] as Record<string, any>;
    record.model_provenance.gpu_delta = {
      ...record.model_provenance.gpu_delta,
      requested_model: "gemini-3.1-flash-lite-preview",
      provider_model_status: "shutdown",
      provider_recommended_replacement: "gemini-3.1-flash-lite",
      hard_infra_failure: true,
    };
    const proof = classifyGpuHmrProofMessage({
      status: "gpu-proof-state",
      resultState: "gpu-hmr-full-runtime-proven",
      proofLedger: ledger,
    });

    const validation = validateGpuHmrProofState(proof, "gpu-hmr-full-runtime-proven");

    expect(validation.satisfied).toBe(false);
    expect(validation.reason).toBe("proof_ledger_rejected");
    expect(validation.proofLedgerValidation?.failedInvariants.map((failure) => failure.code)).toContain(
      "model_provider_status_shutdown"
    );
  });

  it("rejects full runtime proof when delta model falls back", () => {
    const ledger = proofLedger();
    const record = ledger.records[0] as Record<string, any>;
    record.model_provenance.gpu_delta = {
      ...record.model_provenance.gpu_delta,
      actual_model: "gemini-3.5-flash",
      fallback_model: "gemini-3.5-flash",
      fallback_used: true,
      actual_provider_model_status: "available",
      actual_model_availability_checked_at: "2026-06-07T00:00:00.000Z",
      fallback_provider_model_status: "available",
      fallback_model_availability_checked_at: "2026-06-07T00:00:00.000Z",
    };
    const proof = classifyGpuHmrProofMessage({
      status: "gpu-proof-state",
      resultState: "gpu-hmr-full-runtime-proven",
      proofLedger: ledger,
    });

    const validation = validateGpuHmrProofState(proof, "gpu-hmr-full-runtime-proven");

    expect(validation.satisfied).toBe(false);
    expect(validation.proofLedgerValidation?.failedInvariants.map((failure) => failure.code)).toContain(
      "gpu_delta_model_fallback_used"
    );
  });

  it("rejects full runtime proof with non-Gemini or unresolved GPU model provenance", () => {
    const cases = [
      {
        name: "non-Gemini split provider",
        mutate(record: Record<string, any>) {
          record.model_provenance.split.provider = "anthropic";
        },
        expectedCode: "model_provider_not_allowed",
      },
      {
        name: "unexpected split model",
        mutate(record: Record<string, any>) {
          record.model_provenance.split.requested_model = "gpt-image-2";
          record.model_provenance.split.actual_model = "gpt-image-2";
        },
        expectedCode: "model_requested_model_unexpected",
      },
      {
        name: "unexpected delta model",
        mutate(record: Record<string, any>) {
          record.model_provenance.gpu_delta.requested_model = "gemini-3.5-flash";
          record.model_provenance.gpu_delta.actual_model = "gemini-3.5-flash";
        },
        expectedCode: "model_requested_model_unexpected",
      },
      {
        name: "unresolved private delta alias",
        mutate(record: Record<string, any>) {
          record.model_provenance.gpu_delta.requested_model = "internal-fast-delta";
          record.model_provenance.gpu_delta.actual_model = "internal-fast-delta";
          record.model_provenance.gpu_delta.provider_model_status = "private_alias";
          record.model_provenance.gpu_delta.provider_model_alias_resolved_to = null;
        },
        expectedCode: "model_private_alias_unresolved",
      },
      {
        name: "untrusted model availability source",
        mutate(record: Record<string, any>) {
          record.model_provenance.gpu_delta.model_availability_source = "provider_not_checked";
        },
        expectedCode: "model_availability_source_untrusted",
      },
      {
        name: "private alias without provider-backed basis",
        mutate(record: Record<string, any>) {
          record.model_provenance.gpu_delta.requested_model = "internal-fast-delta";
          record.model_provenance.gpu_delta.actual_model = "internal-fast-delta";
          record.model_provenance.gpu_delta.provider_model_status = "private_alias";
          record.model_provenance.gpu_delta.provider_model_alias_resolved_to = "gemini-3.1-flash-lite";
          record.model_provenance.gpu_delta.model_availability_basis = "static_registry";
        },
        expectedCode: "model_private_alias_basis_unproven",
      },
    ];

    for (const testCase of cases) {
      const ledger = proofLedger();
      const record = ledger.records[0] as Record<string, any>;
      testCase.mutate(record);
      const proof = classifyGpuHmrProofMessage({
        status: "gpu-proof-state",
        resultState: "gpu-hmr-full-runtime-proven",
        proofLedger: ledger,
      });

      const validation = validateGpuHmrProofState(proof, "gpu-hmr-full-runtime-proven");

      expect(validation.satisfied, testCase.name).toBe(false);
      expect(validation.reason, testCase.name).toBe("proof_ledger_rejected");
      expect(
        validation.proofLedgerValidation?.failedInvariants.map((failure) => failure.code),
        testCase.name
      ).toContain(testCase.expectedCode);
    }
  });

  it("rejects full runtime proof without compute oracle artifacts", () => {
    const ledger = proofLedger();
    const record = ledger.records[0] as Record<string, unknown>;
    delete record.oracle_artifacts;
    const proof = classifyGpuHmrProofMessage({
      status: "gpu-proof-state",
      resultState: "gpu-hmr-full-runtime-proven",
      proofLedger: ledger,
    });

    const validation = validateGpuHmrProofState(proof, "gpu-hmr-full-runtime-proven");

    expect(validation.satisfied).toBe(false);
    expect(validation.proofLedgerValidation?.failedInvariants.map((failure) => failure.code)).toContain(
      "compute_oracle_artifacts_missing"
    );
  });

  it("rejects full runtime compute proof without raw readback provenance", () => {
    const ledger = proofLedger();
    const record = ledger.records[0] as Record<string, any>;
    const artifacts = record.oracle_artifacts.compute_oracle_artifacts as Record<string, unknown>;
    delete artifacts.raw_readback_hash;
    delete artifacts.raw_readback_source;
    const proof = classifyGpuHmrProofMessage({
      status: "gpu-proof-state",
      resultState: "gpu-hmr-full-runtime-proven",
      proofLedger: ledger,
    });

    const validation = validateGpuHmrProofState(proof, "gpu-hmr-full-runtime-proven");

    expect(validation.satisfied).toBe(false);
    expect(validation.proofLedgerValidation?.failedInvariants.map((failure) => failure.code)).toContain(
      "compute_oracle_raw_readback_unproven"
    );
  });

  it("rejects full runtime compute proof when raw readback bytes were not hash-verified", () => {
    const ledger = proofLedger();
    const record = ledger.records[0] as Record<string, any>;
    const artifacts = record.oracle_artifacts.compute_oracle_artifacts as Record<string, any>;
    delete artifacts.raw_readback_hash_verified;
    delete artifacts.raw_readback_verification;
    const proof = classifyGpuHmrProofMessage({
      status: "gpu-proof-state",
      resultState: "gpu-hmr-full-runtime-proven",
      proofLedger: ledger,
    });

    const validation = validateGpuHmrProofState(proof, "gpu-hmr-full-runtime-proven");

    expect(validation.satisfied).toBe(false);
    expect(validation.proofLedgerValidation?.failedInvariants.map((failure) => failure.code)).toContain(
      "compute_oracle_raw_readback_hash_unverified"
    );
  });

  it("rejects full runtime compute proof when the deterministic slice is not byte-backed", () => {
    const ledger = proofLedger();
    const record = ledger.records[0] as Record<string, any>;
    const artifacts = record.oracle_artifacts.compute_oracle_artifacts as Record<string, any>;
    artifacts.deterministic_slice = { offset: 48, length: 32, hash: HASH_C };
    const proof = classifyGpuHmrProofMessage({
      status: "gpu-proof-state",
      resultState: "gpu-hmr-full-runtime-proven",
      proofLedger: ledger,
    });

    const validation = validateGpuHmrProofState(proof, "gpu-hmr-full-runtime-proven");

    expect(validation.satisfied).toBe(false);
    expect(validation.proofLedgerValidation?.failedInvariants.map((failure) => failure.code)).toContain(
      "compute_oracle_deterministic_slice_out_of_bounds"
    );
  });

  it("rejects full runtime compute proof derived from a checksum digest", () => {
    const ledger = proofLedger();
    const record = ledger.records[0] as Record<string, any>;
    const artifacts = record.oracle_artifacts.compute_oracle_artifacts as Record<string, any>;
    artifacts.raw_readback_source = "runtime_checksum_digest";
    artifacts.deterministic_slice = {
      ...artifacts.deterministic_slice,
      source: "runtime_checksum_digest",
    };
    const proof = classifyGpuHmrProofMessage({
      status: "gpu-proof-state",
      resultState: "gpu-hmr-full-runtime-proven",
      proofLedger: ledger,
    });

    const validation = validateGpuHmrProofState(proof, "gpu-hmr-full-runtime-proven");

    expect(validation.satisfied).toBe(false);
    expect(validation.proofLedgerValidation?.failedInvariants.map((failure) => failure.code)).toContain(
      "compute_oracle_raw_readback_digest_derived"
    );
  });

  it("rejects full runtime compute proof with an unaccepted raw readback source", () => {
    const ledger = proofLedger();
    const record = ledger.records[0] as Record<string, any>;
    const artifacts = record.oracle_artifacts.compute_oracle_artifacts as Record<string, unknown>;
    artifacts.raw_readback_source = "unit_test_fixture";
    const proof = classifyGpuHmrProofMessage({
      status: "gpu-proof-state",
      resultState: "gpu-hmr-full-runtime-proven",
      proofLedger: ledger,
    });

    const validation = validateGpuHmrProofState(proof, "gpu-hmr-full-runtime-proven");

    expect(validation.satisfied).toBe(false);
    expect(validation.proofLedgerValidation?.failedInvariants.map((failure) => failure.code)).toContain(
      "compute_oracle_raw_readback_source_unaccepted"
    );
  });

  it("rejects full runtime visual proof without deterministic visual mode", () => {
    const ledger = proofLedger();
    const record = ledger.records[0] as Record<string, unknown>;
    record.output_event = {
      id: "output-1",
      kind: "visual_frame",
      epoch: "epoch-2",
      artifact_hash: HASH_B,
      process_id: "pid-1",
      after_dispatch_id: "dispatch-1",
      passed: true,
      timestamp_monotonic_ns: 400,
    };
    record.oracle_artifacts = {
      visual_oracle_artifacts: {
        before_image: "memory://before.png",
        after_image: "memory://after.png",
        diff_image: "memory://diff.png",
        blank_frame_rejection: true,
        same_frame_rejection: true,
        new_epoch_watermark_or_trace: "epoch-2 dispatch-1",
        camera_state_hash: HASH_A,
        swapchain_size: [640, 480],
        capture_backend: "mcp",
        frame_number: 8,
        timestamp_after_dispatch: 400,
        perceptual_diff: 2,
        changed_pixel_ratio: 0.2,
        visible_pixel_count: 1000,
        before_image_hash: HASH_A,
        after_image_hash: HASH_B,
        diff_image_hash: HASH_C,
        before_image_hash_verified: true,
        after_image_hash_verified: true,
        diff_image_hash_verified: true,
        pixel_metrics_verified: true,
        visual_pixel_verification: {
          before_image_hash: HASH_A,
          after_image_hash: HASH_B,
          diff_image_hash: HASH_C,
          before_image_hash_verified: true,
          after_image_hash_verified: true,
          diff_image_hash_verified: true,
          metrics_verified: true,
          changed_pixel_ratio_recomputed: 0.2,
          perceptual_diff_recomputed: 2,
          visible_pixel_count_recomputed: 1000,
        },
      },
    };
    const proof = classifyGpuHmrProofMessage({
      status: "gpu-proof-state",
      resultState: "gpu-hmr-full-runtime-proven",
      proofLedger: ledger,
    });

    const validation = validateGpuHmrProofState(proof, "gpu-hmr-full-runtime-proven");

    expect(validation.satisfied).toBe(false);
    expect(validation.proofLedgerValidation?.failedInvariants.map((failure) => failure.code)).toContain(
      "visual_output_without_deterministic_mode"
    );
  });

  it("rejects full runtime proof telemetry without proof ledger", () => {
    const proof = classifyGpuHmrProofMessage({
      status: "gpu-proof-state",
      resultState: "gpu-hmr-full-runtime-proven",
    });

    const validation = validateGpuHmrProofState(proof, "gpu-hmr-full-runtime-proven");

    expect(validation.satisfied).toBe(false);
    expect(validation.reason).toBe("proof_ledger_missing");
  });

  it("rejects forged supplied proof ledger query", () => {
    const ledger = proofLedger({
      output_event: {
        kind: "buffer_checksum",
        epoch: "epoch-2",
        artifact_hash: HASH_B,
        process_id: "pid-1",
        after_dispatch_id: "dispatch-old",
        passed: true,
        timestamp_monotonic_ns: 400,
      },
    });
    ledger.query = {
      schemaVersion: "synthi.gpu.hmr.proof_ledger.v1",
      proofId: "gpu-ledger-proof:fixture",
      gpuHmrSuccess: true,
      failedInvariants: [],
    };
    const proof = classifyGpuHmrProofMessage({
      status: "gpu-proof-state",
      resultState: "gpu-hmr-full-runtime-proven",
      proofLedger: ledger,
    });

    const validation = validateGpuHmrProofState(proof, "gpu-hmr-full-runtime-proven");

    expect(validation.satisfied).toBe(false);
    expect(validation.reason).toBe("proof_ledger_rejected");
    expect(validation.proofLedgerValidation?.failedInvariants.map((failure) => failure.code)).toContain(
      "supplied_ledger_query_mismatch"
    );
  });

  it("rejects proof id mismatch between telemetry and proof ledger", () => {
    const proof = classifyGpuHmrProofMessage({
      status: "gpu-proof-state",
      resultState: "gpu-hmr-full-runtime-proven",
      proofId: "gpu-ledger-proof:wrong",
      proofLedger: proofLedger(),
    });

    const validation = validateGpuHmrProofState(proof, "gpu-hmr-full-runtime-proven");

    expect(validation.satisfied).toBe(false);
    expect(validation.reason).toBe("proof_ledger_rejected");
    expect(validation.proofLedgerValidation?.failedInvariants.map((failure) => failure.code)).toContain(
      "telemetry_proof_id_ledger_mismatch"
    );
  });
});
