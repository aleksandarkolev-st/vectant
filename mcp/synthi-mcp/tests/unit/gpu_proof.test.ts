import { describe, expect, it } from "vitest";
import {
  classifyGpuHmrProofMessage,
  gpuHmrDegradedStateRankCap,
  gpuHmrProofStateRank,
  validateGpuHmrProofState,
} from "../../src/gpu_proof.js";

const HASH_A = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const HASH_B = "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const HASH_C = "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";

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
    proofId: "gpu-ledger-proof:fixture",
    project_id: "generic-gpu-project",
    edit_id: "gpu-edit",
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
    retirement_event: { id: "retire-1", epoch: "epoch-1", proof: "stream_event_proven" },
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
        deterministic_slice: { offset: 0, length: 32 },
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
  return {
    schemaVersion: "synthi.gpu.hmr.proof_ledger.v1",
    proofId: "gpu-ledger-proof:fixture",
    records: [record],
    gpuHmrSuccess: true,
    query: {
      schemaVersion: "synthi.gpu.hmr.proof_ledger.v1",
      proofId: "gpu-ledger-proof:fixture",
      gpuHmrSuccess: true,
      failedInvariants: [],
    },
  };
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

  it("requires ledger-backed success for full runtime proof validation", () => {
    const proof = classifyGpuHmrProofMessage({
      status: "gpu-proof-state",
      resultState: "gpu-hmr-full-runtime-proven",
      proofLedger: proofLedger(),
    });

    const validation = validateGpuHmrProofState(proof, "gpu-hmr-full-runtime-proven");

    expect(validation.satisfied).toBe(true);
    expect(validation.proofLedgerValidation?.gpuHmrSuccess).toBe(true);
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
