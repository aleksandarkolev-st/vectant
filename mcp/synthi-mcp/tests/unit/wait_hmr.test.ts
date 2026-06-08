import { beforeEach, describe, expect, it } from "vitest";
import { eventLog } from "../../src/events/index.js";
import { session } from "../../src/session.js";
import { waitHmrTool } from "../../src/tools/wait_hmr.js";
import { resolvePipelineBudgetMs } from "../../src/protocol/index.js";
import {
  classifyGpuHmrProofMessage,
  type GpuHmrProofMatchOpts,
  type GpuHmrProofTelemetry,
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

type FakeWaitOpts = {
  timeoutMs?: number;
  module?: string;
  sinceTs?: number;
  previewId?: string;
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

function passingProofLedger() {
  const record = {
    project_id: "wait-generic-gpu-project",
    edit_id: "gpu-edit",
    backend: "hip",
    classification: { project_kind: "gpu_project", edit_kind: "gpu_artifact_edit", route: "gpu_hmr" },
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
        deterministic_slice: { offset: 0, length: 32 },
        raw_readback_hash: HASH_B,
        raw_readback_source: "runtime_readback_sample",
        oracle_code_hash: HASH_C,
        rendered_card_png: "memory://card.png",
        producer: "wait_hmr.test",
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

function refreshLedgerIdentity(ledger: Record<string, any>) {
  const query = queryGpuHmrLedgerInvariants({
    schemaVersion: ledger.schemaVersion,
    records: ledger.records,
  });
  ledger.proofId = query.proofId;
  ledger.gpuHmrSuccess = query.gpuHmrSuccess;
  ledger.query = query;
}

function passingAcceptanceContract(ledger = passingProofLedger(), overrides: Record<string, unknown> = {}) {
  const record = ledger.records[0] as Record<string, any>;
  const artifactBeforeHash = record.artifact_before_hash ?? HASH_A;
  const artifactAfterHash = record.artifact_after_hash ?? HASH_B;
  const contractHash = record.contract_hash ?? HASH_C;
  return {
    contract_version: "synthi.gpu_hmr.contract.v1",
    project_id: record.project_id ?? "wait-generic-gpu-project",
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

function passingRuntimeProofArtifact(ledger = passingProofLedger(), overrides: Record<string, unknown> = {}) {
  const contract = passingAcceptanceContract(ledger);
  const ledgerRecord = (ledger.records as unknown[] | undefined)?.[0] as Record<string, unknown> | undefined;
  return {
    schemaVersion: "synthi.gpu.hmr.validation-proof.v1",
    proofId: "gpu-runtime-proof:wait-fixture",
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

function installFakeAttached(
  waitForTerminal: (opts?: FakeWaitOpts) => Promise<{
    status: "applied";
    source: "hmr_status";
    elapsedMs: number;
    observedAt?: number;
    retained?: boolean;
    sequence?: number;
  }>,
  latestGpuProof?: (opts?: GpuHmrProofMatchOpts) => GpuHmrProofTelemetry | null
): { feedHmr: (msg: Record<string, unknown>) => void } {
  const listeners: Array<(msg: Record<string, unknown>) => void> = [];
  (session as unknown as { state: string }).state = "attached";
  (session as unknown as { attached: unknown }).attached = {
    sessionId: "fixture",
    signalingUrl: "ws://localhost:9000",
    resolution: { width: 200, height: 200 },
    frames: {
      getFrame: async () => ({
        data: Buffer.alloc(0),
        width: 200,
        height: 200,
        ts: Date.now(),
        seq: 1,
      }),
      hasFrame: () => true,
      dimensions: () => ({ width: 200, height: 200 }),
    },
    channels: {
      hmr: {
        onMessage: (cb: (msg: Record<string, unknown>) => void) => {
          listeners.push(cb);
          return () => {
            const index = listeners.indexOf(cb);
            if (index >= 0) listeners.splice(index, 1);
          };
        },
        waitForTerminal,
        latestGpuProof,
      },
    },
  };
  return {
    feedHmr: (msg: Record<string, unknown>) => {
      for (const listener of [...listeners]) listener(msg);
    },
  };
}

describe("synthi_wait_hmr", () => {
  beforeEach(() => {
    session._resetForTests();
    eventLog._resetForTests();
    delete process.env["SYNTHI_MCP_HMR_POST_APPLY_OBSERVE_MS"];
  });

  it("reports frame_gate:disabled when no frame_advance has ever been seen", async () => {
    installFakeAttached(async () => ({ status: "applied", source: "hmr_status", elapsedMs: 10 }));
    const res = await waitHmrTool({ timeoutMs: 500 });
    expect(res.isError).toBeUndefined();
    const body = res.structuredContent as { frame_gate: { status: string }; hmrElapsedMs: number };
    expect(body.hmrElapsedMs).toBe(10);
    expect(body.frame_gate.status).toBe("disabled");
  });

  it("waits for a post-budget frame advance before returning", async () => {
    installFakeAttached(async () => ({ status: "applied", source: "hmr_status", elapsedMs: 10 }));
    session.setFrameAdvance(1, Date.now());
    const budget = resolvePipelineBudgetMs();
    setTimeout(() => session.setFrameAdvance(2, Date.now() + budget + 50), 10);
    const res = await waitHmrTool({ timeoutMs: 2_000 });
    expect(res.isError).toBeUndefined();
    const body = res.structuredContent as { frame_gate: { status: string; frame_seq: number } };
    expect(body.frame_gate.status).toBe("satisfied");
    expect(body.frame_gate.frame_seq).toBe(2);
  });

  it("reports frame_gate:timeout when no post-budget frame arrives", async () => {
    installFakeAttached(async () => ({ status: "applied", source: "hmr_status", elapsedMs: 10 }));
    session.setFrameAdvance(1, Date.now());
    const res = await waitHmrTool({ timeoutMs: 50 });
    expect(res.isError).toBeUndefined();
    const body = res.structuredContent as { frame_gate: { status: string } };
    expect(body.frame_gate.status).toBe("timeout");
  });

  it("returns a post-apply runtime rejection instead of applied", async () => {
    process.env["SYNTHI_MCP_HMR_POST_APPLY_OBSERVE_MS"] = "100";
    const fake = installFakeAttached(async () => {
      fake.feedHmr({ status: "applied", module: "device", state_preserved: true });
      setTimeout(
        () =>
          fake.feedHmr({
            status: "rejected",
            module: "device",
            reason: "GPU kernel launch failed after sidecar reload",
            fallback: "Keep runtime running but mark GPU HMR degraded until the launch succeeds",
          }),
        10
      );
      return { status: "applied", source: "hmr_status", elapsedMs: 10 };
    });

    const res = await waitHmrTool({ timeoutMs: 500 });
    expect(res.isError).toBeUndefined();
    const body = res.structuredContent as {
      status: string;
      post_apply_terminal?: boolean;
      detail?: { reason?: string };
    };
    expect(body.status).toBe("rejected");
    expect(body.post_apply_terminal).toBe(true);
    expect(body.detail?.reason).toContain("GPU kernel launch failed");
  });

  it("returns a post-apply runtime rejection while waiting for frame evidence", async () => {
    session.setFrameAdvance(1, Date.now());
    const fake = installFakeAttached(async () => {
      fake.feedHmr({ status: "applied", module: "device", state_preserved: true });
      setTimeout(
        () =>
          fake.feedHmr({
            status: "rejected",
            module: "device",
            reason: "post-reload device dispatch rejected",
            fallback: "Keep runtime running but mark GPU HMR degraded until the launch succeeds",
          }),
        10
      );
      return { status: "applied", source: "hmr_status", elapsedMs: 10 };
    });

    const res = await waitHmrTool({ timeoutMs: 500 });
    expect(res.isError).toBeUndefined();
    const body = res.structuredContent as {
      status: string;
      post_apply_terminal?: boolean;
      detail?: { reason?: string };
    };
    expect(body.status).toBe("rejected");
    expect(body.post_apply_terminal).toBe(true);
    expect(body.detail?.reason).toContain("post-reload device dispatch rejected");
  });

  it("returns unvalidated GPU proof telemetry with wait_hmr when no proof state is requested", async () => {
    const fake = installFakeAttached(async () => {
      fake.feedHmr({
        status: "gpu-proof-state",
        schemaVersion: "synthi.gpu.hmr.proof.v1",
        resultState: "gpu-hmr-symbol-bound",
        degradedState: "gpu-hmr-dispatch-unobserved",
        degradedReason: "runtime_dispatch_not_observed",
        label: "gpu-hmr-partial",
        proofId: "gpu-proof:abc",
        proofArtifactPath: ".synthi/gpu-hmr/proofs/gpu-proof_abc.json",
      });
      return { status: "applied", source: "hmr_status", elapsedMs: 10 };
    });

    const res = await waitHmrTool({ timeoutMs: 500 });

    expect(fake).toBeDefined();
    expect(res.isError).toBeUndefined();
    const body = res.structuredContent as {
      gpu_proof?: { resultState?: string };
      gpu_proof_telemetry?: { resultState?: string; degradedState?: string; proofId?: string };
      gpu_proof_validation?: { validated?: boolean; satisfied?: boolean; reason?: string };
    };
    expect(body.gpu_proof).toBeUndefined();
    expect(body.gpu_proof_telemetry?.resultState).toBe("gpu-hmr-symbol-bound");
    expect(body.gpu_proof_telemetry?.degradedState).toBe("gpu-hmr-dispatch-unobserved");
    expect(body.gpu_proof_telemetry?.proofId).toBe("gpu-proof:abc");
    expect(body.gpu_proof_validation?.validated).toBe(false);
    expect(body.gpu_proof_validation?.satisfied).toBe(false);
    expect(body.gpu_proof_validation?.reason).toBe("proof_state_not_requested");
  });

  it("fails wait_hmr when requested GPU proof is stronger than observed", async () => {
    installFakeAttached(async () => ({ status: "applied", source: "hmr_status", elapsedMs: 10 }));

    const res = await waitHmrTool({
      timeoutMs: 500,
      requireGpuFullRuntimeProof: true,
    });

    expect(res.isError).toBe(true);
    const body = res.structuredContent as {
      error?: string;
      gpu_proof_validation?: { reason?: string };
    };
    expect(body.error).toBe("gpu_hmr_proof_insufficient");
    expect(body.gpu_proof_validation?.reason).toBe("proof_state_missing");
  });

  it("rejects full runtime proof telemetry without proof ledger", async () => {
    const fake = installFakeAttached(async () => {
      fake.feedHmr({
        status: "gpu-proof-state",
        resultState: "gpu-hmr-full-runtime-proven",
      });
      return { status: "applied", source: "hmr_status", elapsedMs: 10 };
    });

    const res = await waitHmrTool({ timeoutMs: 500, requireGpuFullRuntimeProof: true });

    expect(res.isError).toBe(true);
    const body = res.structuredContent as {
      error?: string;
      gpu_proof_validation?: { reason?: string };
      gpu_proof_ledger_validation?: unknown;
    };
    expect(body.error).toBe("gpu_hmr_proof_insufficient");
    expect(body.gpu_proof_validation?.reason).toBe("proof_ledger_missing");
    expect(body.gpu_proof_ledger_validation).toBeNull();
  });

  it("rejects output oracle proof telemetry without proof ledger", async () => {
    const fake = installFakeAttached(async () => {
      fake.feedHmr({
        status: "gpu-proof-state",
        resultState: "gpu-hmr-output-oracle-proven",
      });
      return { status: "applied", source: "hmr_status", elapsedMs: 10 };
    });

    const res = await waitHmrTool({
      timeoutMs: 500,
      requiredGpuProofState: "gpu-hmr-output-oracle-proven",
    });

    expect(res.isError).toBe(true);
    const body = res.structuredContent as {
      error?: string;
      gpu_proof_validation?: { reason?: string };
      gpu_proof_ledger_validation?: unknown;
    };
    expect(body.error).toBe("gpu_hmr_proof_insufficient");
    expect(body.gpu_proof_validation?.reason).toBe("proof_ledger_missing");
    expect(body.gpu_proof_ledger_validation).toBeNull();
  });

  it("rejects output oracle proof telemetry with an accepted proof ledger but no runtime artifact", async () => {
    const ledger = passingProofLedger();
    const fake = installFakeAttached(async () => {
      fake.feedHmr({
        status: "gpu-proof-state",
        resultState: "gpu-hmr-output-oracle-proven",
        proofLedger: ledger,
      });
      return { status: "applied", source: "hmr_status", elapsedMs: 10 };
    });

    const res = await waitHmrTool({
      timeoutMs: 500,
      requiredGpuProofState: "gpu-hmr-output-oracle-proven",
    });

    expect(fake).toBeDefined();
    expect(res.isError).toBe(true);
    const body = res.structuredContent as {
      error?: string;
      gpu_proof_validation?: {
        reason?: string;
        satisfied?: boolean;
        runtimeProofArtifactValidation?: { failedGates?: Array<{ code?: string }> };
      };
      gpu_proof_ledger_validation?: { gpuHmrSuccess?: boolean };
    };
    expect(body.error).toBe("gpu_hmr_proof_insufficient");
    expect(body.gpu_proof_validation?.satisfied).toBe(false);
    expect(body.gpu_proof_validation?.reason).toBe("runtime_proof_artifact_missing");
    expect(body.gpu_proof_validation?.runtimeProofArtifactValidation?.failedGates?.map((gate) => gate.code)).toContain(
      "runtime_proof_artifact_missing"
    );
    expect(body.gpu_proof_ledger_validation?.gpuHmrSuccess).toBe(true);
  });

  it("accepts output oracle proof telemetry with an accepted ledger and source-consistent runtime artifact", async () => {
    const ledger = passingProofLedger();
    const fake = installFakeAttached(async () => {
      fake.feedHmr({
        status: "gpu-proof-state",
        resultState: "gpu-hmr-output-oracle-proven",
        proofLedger: ledger,
        runtimeProofArtifact: passingRuntimeProofArtifact(ledger, {
          resultState: "gpu-hmr-output-oracle-proven",
          fullRuntimeProven: false,
          gpuHmrSuccess: false,
          limitations: [{
            stageId: "full-runtime",
            status: "blocked",
            requiredState: "gpu-hmr-full-runtime-proven",
            observedState: "gpu-hmr-output-oracle-proven",
            degradedReason: "full_runtime_proof_not_proven",
          }],
        }),
      });
      return { status: "applied", source: "hmr_status", elapsedMs: 10 };
    });

    const res = await waitHmrTool({
      timeoutMs: 500,
      requiredGpuProofState: "gpu-hmr-output-oracle-proven",
    });

    expect(fake).toBeDefined();
    expect(res.isError).toBeUndefined();
    const body = res.structuredContent as {
      gpu_proof_validation?: { satisfied?: boolean; runtimeProofArtifactValidation?: { accepted?: boolean } };
      gpu_proof_ledger_validation?: { gpuHmrSuccess?: boolean };
    };
    expect(body.gpu_proof_validation?.satisfied).toBe(true);
    expect(body.gpu_proof_validation?.runtimeProofArtifactValidation?.accepted).toBe(true);
    expect(body.gpu_proof_ledger_validation?.gpuHmrSuccess).toBe(true);
  });

  it("rejects flat full runtime artifact fields without an explicit runtime artifact object", async () => {
    const ledger = passingProofLedger();
    const artifact = passingRuntimeProofArtifact(ledger);
    const fake = installFakeAttached(async () => {
      fake.feedHmr({
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
      return { status: "applied", source: "hmr_status", elapsedMs: 10 };
    });

    const res = await waitHmrTool({ timeoutMs: 500, requireGpuFullRuntimeProof: true });

    expect(fake).toBeDefined();
    expect(res.isError).toBe(true);
    const body = res.structuredContent as {
      error?: string;
      gpu_proof_validation?: { reason?: string };
    };
    expect(body.error).toBe("gpu_hmr_proof_insufficient");
    expect(body.gpu_proof_validation?.reason).toBe("runtime_proof_artifact_missing");
  });

  it("accepts full runtime proof only with recomputed ledger and runtime artifact success", async () => {
    const ledger = passingProofLedger();
    const fake = installFakeAttached(async () => {
      fake.feedHmr({
        status: "gpu-proof-state",
        resultState: "gpu-hmr-full-runtime-proven",
        proofLedger: ledger,
        runtimeProofArtifact: passingRuntimeProofArtifact(ledger),
      });
      return { status: "applied", source: "hmr_status", elapsedMs: 10 };
    });

    const res = await waitHmrTool({ timeoutMs: 500, requireGpuFullRuntimeProof: true });

    expect(res.isError).toBeUndefined();
    const body = res.structuredContent as {
      gpu_proof_validation?: {
        satisfied?: boolean;
        runtimeProofArtifactValidation?: { accepted?: boolean };
      };
      gpu_proof_ledger_validation?: { gpuHmrSuccess?: boolean };
    };
    expect(body.gpu_proof_validation?.satisfied).toBe(true);
    expect(body.gpu_proof_ledger_validation?.gpuHmrSuccess).toBe(true);
    expect(body.gpu_proof_validation?.runtimeProofArtifactValidation?.accepted).toBe(true);
  });

  it("rejects full runtime proof when compute readback is digest-derived", async () => {
    const ledger = passingProofLedger();
    const record = ledger.records[0] as Record<string, any>;
    const artifacts = record.oracle_artifacts.compute_oracle_artifacts as Record<string, any>;
    artifacts.raw_readback_source = "runtime_checksum_digest";
    artifacts.deterministic_slice = {
      ...artifacts.deterministic_slice,
      source: "runtime_checksum_digest",
    };
    const fake = installFakeAttached(async () => {
      fake.feedHmr({
        status: "gpu-proof-state",
        resultState: "gpu-hmr-full-runtime-proven",
        proofLedger: ledger,
        runtimeProofArtifact: passingRuntimeProofArtifact(ledger),
      });
      return { status: "applied", source: "hmr_status", elapsedMs: 10 };
    });

    const res = await waitHmrTool({ timeoutMs: 500, requireGpuFullRuntimeProof: true });

    expect(fake).toBeDefined();
    expect(res.isError).toBe(true);
    const body = res.structuredContent as {
      error?: string;
      gpu_proof_validation?: { reason?: string };
      gpu_proof_ledger_validation?: { failedInvariants?: Array<{ code?: string }> };
    };
    expect(body.error).toBe("gpu_hmr_proof_insufficient");
    expect(body.gpu_proof_validation?.reason).toBe("proof_ledger_rejected");
    expect(body.gpu_proof_ledger_validation?.failedInvariants?.map((failure) => failure.code)).toContain(
      "compute_oracle_raw_readback_digest_derived"
    );
  });

  it("rejects full runtime proof when split provenance is not Gemini", async () => {
    const ledger = passingProofLedger();
    const record = ledger.records[0] as Record<string, any>;
    record.model_provenance.split.provider = "anthropic";
    const fake = installFakeAttached(async () => {
      fake.feedHmr({
        status: "gpu-proof-state",
        resultState: "gpu-hmr-full-runtime-proven",
        proofLedger: ledger,
        runtimeProofArtifact: passingRuntimeProofArtifact(ledger),
      });
      return { status: "applied", source: "hmr_status", elapsedMs: 10 };
    });

    const res = await waitHmrTool({ timeoutMs: 500, requireGpuFullRuntimeProof: true });

    expect(fake).toBeDefined();
    expect(res.isError).toBe(true);
    const body = res.structuredContent as {
      error?: string;
      gpu_proof_validation?: { reason?: string };
      gpu_proof_ledger_validation?: { failedInvariants?: Array<{ code?: string }> };
    };
    expect(body.error).toBe("gpu_hmr_proof_insufficient");
    expect(body.gpu_proof_validation?.reason).toBe("proof_ledger_rejected");
    expect(body.gpu_proof_ledger_validation?.failedInvariants?.map((failure) => failure.code)).toContain(
      "model_provider_not_allowed"
    );
  });

  it("rejects full runtime proof when the runtime artifact ledger query is forged", async () => {
    const ledger = passingProofLedger();
    const forgedArtifactLedger = passingProofLedger();
    const forgedRecord = forgedArtifactLedger.records[0] as Record<string, unknown>;
    forgedRecord.cpu_hmr_used = true;
    forgedArtifactLedger.query = {
      ...forgedArtifactLedger.query,
      gpuHmrSuccess: true,
      failedInvariants: [],
    };
    const fake = installFakeAttached(async () => {
      fake.feedHmr({
        status: "gpu-proof-state",
        resultState: "gpu-hmr-full-runtime-proven",
        proofLedger: ledger,
        runtimeProofArtifact: passingRuntimeProofArtifact(forgedArtifactLedger),
      });
      return { status: "applied", source: "hmr_status", elapsedMs: 10 };
    });

    const res = await waitHmrTool({ timeoutMs: 500, requireGpuFullRuntimeProof: true });

    expect(fake).toBeDefined();
    expect(res.isError).toBe(true);
    const body = res.structuredContent as {
      error?: string;
      gpu_proof_validation?: {
        reason?: string;
        runtimeProofArtifactValidation?: { failedGates?: Array<{ code?: string }> };
      };
    };
    expect(body.error).toBe("gpu_hmr_proof_insufficient");
    expect(body.gpu_proof_validation?.reason).toBe("runtime_proof_artifact_rejected");
    expect(
      body.gpu_proof_validation?.runtimeProofArtifactValidation?.failedGates?.map((gate) => gate.code)
    ).toEqual(expect.arrayContaining(["proof_ledger_recomputed_query_rejected", "proof_ledger_query_mismatch"]));
  });

  it("rejects full runtime proof when acceptance contract evaluation is forged", async () => {
    const ledger = passingProofLedger();
    const fake = installFakeAttached(async () => {
      fake.feedHmr({
        status: "gpu-proof-state",
        resultState: "gpu-hmr-full-runtime-proven",
        proofLedger: ledger,
        runtimeProofArtifact: passingRuntimeProofArtifact(ledger, {
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
      return { status: "applied", source: "hmr_status", elapsedMs: 10 };
    });

    const res = await waitHmrTool({ timeoutMs: 500, requireGpuFullRuntimeProof: true });

    expect(fake).toBeDefined();
    expect(res.isError).toBe(true);
    const body = res.structuredContent as {
      error?: string;
      gpu_proof_validation?: {
        reason?: string;
        runtimeProofArtifactValidation?: { failedGates?: Array<{ code?: string }> };
      };
    };
    expect(body.error).toBe("gpu_hmr_proof_insufficient");
    expect(body.gpu_proof_validation?.reason).toBe("runtime_proof_artifact_rejected");
    expect(
      body.gpu_proof_validation?.runtimeProofArtifactValidation?.failedGates?.map((gate) => gate.code)
    ).toEqual(expect.arrayContaining([
      "acceptance_contract_recomputed_rejected",
      "acceptance_contract_evaluation_mismatch",
    ]));
  });

  it("rejects full runtime proof when the runtime artifact is bound to another ledger", async () => {
    const ledger = passingProofLedger();
    const otherLedger = passingProofLedger();
    const otherRecord = otherLedger.records[0] as Record<string, any>;
    otherRecord.project_id = "wait-other-gpu-project";
    otherRecord.edit_id = "wait-other-edit";
    otherRecord.contract_hash = "sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd";
    otherRecord.dispatch_event = {
      ...otherRecord.dispatch_event,
      id: "dispatch-other",
    };
    otherRecord.output_event = {
      ...otherRecord.output_event,
      id: "output-other",
      after_dispatch_id: "dispatch-other",
    };
    const fake = installFakeAttached(async () => {
      fake.feedHmr({
        status: "gpu-proof-state",
        resultState: "gpu-hmr-full-runtime-proven",
        proofLedger: ledger,
        runtimeProofArtifact: passingRuntimeProofArtifact(otherLedger),
      });
      return { status: "applied", source: "hmr_status", elapsedMs: 10 };
    });

    const res = await waitHmrTool({ timeoutMs: 500, requireGpuFullRuntimeProof: true });

    expect(fake).toBeDefined();
    expect(res.isError).toBe(true);
    const body = res.structuredContent as {
      error?: string;
      gpu_proof_validation?: {
        reason?: string;
        runtimeProofArtifactValidation?: { failedGates?: Array<{ code?: string }> };
      };
    };
    expect(body.error).toBe("gpu_hmr_proof_insufficient");
    expect(body.gpu_proof_validation?.reason).toBe("runtime_proof_artifact_rejected");
    expect(
      body.gpu_proof_validation?.runtimeProofArtifactValidation?.failedGates?.map((gate) => gate.code)
    ).toEqual(expect.arrayContaining([
      "runtime_artifact_ledger_project_id_mismatch",
      "runtime_artifact_ledger_edit_id_mismatch",
      "runtime_artifact_ledger_contract_hash_mismatch",
      "runtime_artifact_ledger_dispatch_event_id_mismatch",
      "runtime_artifact_ledger_output_event_id_mismatch",
    ]));
  });

  it("rejects full runtime proof when the runtime artifact ledger changes backend", async () => {
    const ledger = passingProofLedger();
    const record = ledger.records[0] as Record<string, any>;
    record.backend = "hip";
    const otherLedger = passingProofLedger();
    const otherRecord = otherLedger.records[0] as Record<string, any>;
    otherRecord.backend = "opencl";
    const fake = installFakeAttached(async () => {
      fake.feedHmr({
        status: "gpu-proof-state",
        resultState: "gpu-hmr-full-runtime-proven",
        proofLedger: ledger,
        runtimeProofArtifact: passingRuntimeProofArtifact(otherLedger),
      });
      return { status: "applied", source: "hmr_status", elapsedMs: 10 };
    });

    const res = await waitHmrTool({ timeoutMs: 500, requireGpuFullRuntimeProof: true });

    expect(fake).toBeDefined();
    expect(res.isError).toBe(true);
    const body = res.structuredContent as {
      error?: string;
      gpu_proof_validation?: {
        reason?: string;
        runtimeProofArtifactValidation?: { failedGates?: Array<{ code?: string }> };
      };
    };
    expect(body.error).toBe("gpu_hmr_proof_insufficient");
    expect(body.gpu_proof_validation?.reason).toBe("runtime_proof_artifact_rejected");
    expect(
      body.gpu_proof_validation?.runtimeProofArtifactValidation?.failedGates?.map((gate) => gate.code)
    ).toContain("runtime_artifact_ledger_backend_mismatch");
  });

  it("rejects full runtime proof when the runtime artifact ledger changes output oracle target", async () => {
    const ledger = passingProofLedger();
    const record = ledger.records[0] as Record<string, any>;
    record.output_oracle_target = {
      kind: "compute",
      target_id: "compute-target:a",
      compute_only_target_verified: true,
      evidence_refs: ["oracle-target:compute:a"],
    };
    refreshLedgerIdentity(ledger);
    const otherLedger = passingProofLedger();
    const otherRecord = otherLedger.records[0] as Record<string, any>;
    otherRecord.output_oracle_target = {
      kind: "compute",
      target_id: "compute-target:b",
      compute_only_target_verified: true,
      evidence_refs: ["oracle-target:compute:b"],
    };
    refreshLedgerIdentity(otherLedger);
    const fake = installFakeAttached(async () => {
      fake.feedHmr({
        status: "gpu-proof-state",
        resultState: "gpu-hmr-full-runtime-proven",
        proofLedger: ledger,
        runtimeProofArtifact: passingRuntimeProofArtifact(otherLedger),
      });
      return { status: "applied", source: "hmr_status", elapsedMs: 10 };
    });

    const res = await waitHmrTool({ timeoutMs: 500, requireGpuFullRuntimeProof: true });

    expect(fake).toBeDefined();
    expect(res.isError).toBe(true);
    const body = res.structuredContent as {
      error?: string;
      gpu_proof_validation?: {
        reason?: string;
        runtimeProofArtifactValidation?: { failedGates?: Array<{ code?: string }> };
      };
    };
    expect(body.error).toBe("gpu_hmr_proof_insufficient");
    expect(body.gpu_proof_validation?.reason).toBe("runtime_proof_artifact_rejected");
    expect(
      body.gpu_proof_validation?.runtimeProofArtifactValidation?.failedGates?.map((gate) => gate.code)
    ).toContain("runtime_artifact_ledger_output_oracle_target_mismatch");
  });

  it("rejects a retained GPU proof that predates since_ts", async () => {
    const staleProof = classifyGpuHmrProofMessage({
      status: "gpu-proof-state",
      module: "device",
      resultState: "gpu-hmr-full-runtime-proven",
    }, Date.now() - 1000);
    const sinceTs = Date.now();
    installFakeAttached(
      async () => ({ status: "applied", source: "hmr_status", elapsedMs: 10, observedAt: sinceTs + 10 }),
      () => staleProof
    );

    const res = await waitHmrTool({
      timeoutMs: 500,
      module: "device",
      since_ts: sinceTs,
      requireGpuFullRuntimeProof: true,
    });

    expect(res.isError).toBe(true);
    const body = res.structuredContent as {
      error?: string;
      gpu_proof_validation?: { reason?: string };
    };
    expect(body.error).toBe("gpu_hmr_proof_insufficient");
    expect(body.gpu_proof_validation?.reason).toBe("proof_state_missing");
  });

  it("rejects a retained GPU proof that predates an unanchored proof wait", async () => {
    const staleProof = classifyGpuHmrProofMessage({
      status: "gpu-proof-state",
      resultState: "gpu-hmr-full-runtime-proven",
      proofLedger: passingProofLedger(),
      runtimeProofArtifact: passingRuntimeProofArtifact(),
    }, Date.now() - 1000);
    installFakeAttached(
      async () => ({ status: "applied", source: "hmr_status", elapsedMs: 10, observedAt: Date.now() }),
      () => staleProof
    );

    const res = await waitHmrTool({
      timeoutMs: 500,
      requireGpuFullRuntimeProof: true,
    });

    expect(res.isError).toBe(true);
    const body = res.structuredContent as {
      error?: string;
      gpu_proof_telemetry?: unknown;
      gpu_proof_validation?: { reason?: string };
      wait_contract?: { proof_since_ts?: number };
    };
    expect(body.error).toBe("gpu_hmr_proof_insufficient");
    expect(body.gpu_proof_telemetry).toBeUndefined();
    expect(body.gpu_proof_validation?.reason).toBe("proof_state_missing");
    expect(typeof body.wait_contract?.proof_since_ts).toBe("number");
  });

  it("rejects a fresh full GPU proof from the wrong module during a device wait", async () => {
    const sinceTs = Date.now();
    const fake = installFakeAttached(async () => {
      fake.feedHmr({
        status: "gpu-proof-state",
        module: "core",
        resultState: "gpu-hmr-full-runtime-proven",
      });
      return { status: "applied", source: "hmr_status", elapsedMs: 10, observedAt: sinceTs + 10 };
    });

    const res = await waitHmrTool({
      timeoutMs: 500,
      module: "device",
      since_ts: sinceTs,
      requireGpuFullRuntimeProof: true,
    });

    expect(res.isError).toBe(true);
    const body = res.structuredContent as {
      error?: string;
      gpu_proof_validation?: { reason?: string };
    };
    expect(body.error).toBe("gpu_hmr_proof_insufficient");
    expect(body.gpu_proof_validation?.reason).toBe("proof_state_missing");
  });

  it("passes the compile dispatch timestamp through for retained terminal recovery", async () => {
    const sinceTs = Date.now() - 100;
    let observedOpts: FakeWaitOpts | undefined;
    installFakeAttached(async (opts) => {
      observedOpts = opts;
      return {
        status: "applied",
        source: "hmr_status",
        elapsedMs: 25,
        observedAt: sinceTs + 25,
        retained: true,
        sequence: 7,
      };
    });

    const res = await waitHmrTool({
      timeoutMs: 500,
      module: "device",
      since_ts: sinceTs,
    });

    expect(res.isError).toBeUndefined();
    expect(observedOpts?.module).toBe("device");
    expect(observedOpts?.sinceTs).toBe(sinceTs);
    const body = res.structuredContent as {
      terminal_recovered_from?: string;
      terminal_sequence?: number;
      hmrObservedAt?: number;
    };
    expect(body.terminal_recovered_from).toBe("hmr_terminal_history");
    expect(body.terminal_sequence).toBe(7);
    expect(body.hmrObservedAt).toBe(sinceTs + 25);
  });

  it("rejects malformed since_ts instead of treating it as a default wait", async () => {
    installFakeAttached(async () => ({ status: "applied", source: "hmr_status", elapsedMs: 10 }));

    const res = await waitHmrTool({ since_ts: "yesterday" });

    expect(res.isError).toBe(true);
    const body = res.structuredContent as { error?: string; field?: string };
    expect(body.error).toBe("invalid_args");
    expect(body.field).toBe("since_ts");
  });
});
