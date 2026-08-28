import { beforeEach, describe, expect, it, vi } from "vitest";
import { eventLog } from "../../src/events/index.js";
import { session } from "../../src/session.js";
import { waitHmrTool } from "../../src/tools/wait_hmr.js";
import type { GpuProofTrustInvalidation } from "../../src/hmr.js";
import { resolvePipelineBudgetMs } from "../../src/protocol/index.js";
import {
  classifyGpuHmrProofMessage,
  gpuHmrProofMatches,
  type GpuHmrProofMatchOpts,
  type GpuHmrProofTelemetry,
} from "../../src/gpu_proof.js";
import { queryGpuHmrLedgerInvariants } from "../../src/gpu_proof_ledger.js";
import { normalizeGpuHmrAcceptanceContract } from "../../scripts/lib/gpu-hmr-acceptance-contract.mjs";
import {
  GPU_PARENT_RUNTIME_PROOF_CONTROL_VERIFICATION_MATERIAL_SCHEMA_VERSION,
  type GpuParentRuntimeProofControlVerificationMaterial,
} from "../../src/gpu_parent_runtime_proof_admission.js";
import {
  gpuParentRuntimeProofAdmissionReceiptFixture,
} from "./gpu_parent_runtime_proof_admission_fixture.js";

const HASH_A = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const HASH_B = "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const HASH_C = "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";

function parentControlVerificationMaterialFixture():
  GpuParentRuntimeProofControlVerificationMaterial {
  return {
    schemaVersion:
      GPU_PARENT_RUNTIME_PROOF_CONTROL_VERIFICATION_MATERIAL_SCHEMA_VERSION,
    controlBinding: {
      type: "gpu_hmr_parent_runtime_proof_control_binding",
      signedEvidence: {
        algorithm: "ed25519",
        signature: "c2lnbmVkLXB1YmxpYy1ldmlkZW5jZQ",
      },
    },
    runtimeEvidenceTransportVerificationKey: {
      schemaVersion:
        "synthi.gpu_hmr.runtime_evidence_transport_verification_key.v1",
      algorithm: "ed25519",
      keyId: "runtime-evidence-key:fixture",
      producer: "synthi-webrtc-compiler-worker",
      workerInstanceId: "runtime-worker:fixture",
      workerProcessId: "877",
      publicKey: "cHVibGljLWV2aWRlbmNl",
      keyAnnouncementId: "runtime-evidence-key-announcement:fixture",
    },
    transportContext: {
      transportSessionId: "transport-session:fixture",
      compileRequestNonce: `gpu-proof-transport-request:${"8".repeat(32)}`,
      expectedWorkerProcessId: "877",
    },
    mcpAdmissionReceipt: gpuParentRuntimeProofAdmissionReceiptFixture(),
  };
}
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
  signal?: AbortSignal;
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
    schemaVersion: "synthi.gpu.hmr.proof_ledger.v1",
    project_id: "wait-generic-gpu-project",
    edit_id: "gpu-edit",
    runtime_session_id: "runtime-session-1",
    backend: "hip",
    classification: { project_kind: "gpu_project", edit_kind: "gpu_artifact_edit", route: "gpu_hmr" },
    contract_hash: HASH_C,
    artifact_before_hash: HASH_A,
    artifact_after_hash: HASH_B,
    loader_event: {
      id: "load-1",
      artifact_hash: HASH_B,
      process_id: "pid-1",
      runtime_session_id: "runtime-session-1",
      timestamp_monotonic_ns: 100,
    },
    epoch_publish_event: {
      id: "publish-1",
      epoch: "epoch-2",
      artifact_hash: HASH_B,
      process_id: "pid-1",
      runtime_session_id: "runtime-session-1",
      timestamp_monotonic_ns: 200,
    },
    dispatch_event: {
      id: "dispatch-1",
      epoch: "epoch-2",
      artifact_hash: HASH_B,
      process_id: "pid-1",
      runtime_session_id: "runtime-session-1",
      timestamp_monotonic_ns: 300,
    },
    output_event: {
      id: "output-1",
      kind: "buffer_checksum",
      epoch: "epoch-2",
      artifact_hash: HASH_B,
      process_id: "pid-1",
      runtime_session_id: "runtime-session-1",
      after_dispatch_id: "dispatch-1",
      passed: true,
      timestamp_monotonic_ns: 400,
    },
    retirement_event: { id: "retire-1", epoch: "epoch-1", proof: "stream_event_proven", timestamp_monotonic_ns: 500 },
    process_identity: { process_id: "pid-1", runtime_session_id: "runtime-session-1" },
    device_identity: { device_uuid: "device-1" },
    output_oracle_target: {
      id: "allocation-output",
      kind: "compute",
      compute_only_target_verified: true,
      evidence_refs: ["runtime:readback-oracle"],
    },
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
  return normalizeGpuHmrAcceptanceContract({
    contract_version: "synthi.gpu_hmr.contract.v1",
    project_id: record.project_id ?? "wait-generic-gpu-project",
    edit_id: record.edit_id ?? "gpu-edit",
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
    output_oracle_target: {
      kind: "compute",
      target_id: "allocation-output",
      compute_only_target_verified: true,
      evidence_refs: ["runtime:readback-oracle"],
    },
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
      changed_sources: ["src/gpu/kernel.hip"],
      included_dependencies: ["src/gpu/kernel.hip"],
      excluded_host_sources: ["src/main.cpp"],
      artifact_hash_before: artifactBeforeHash,
      artifact_hash_after: artifactAfterHash,
      abi_compatibility_class: "compatible",
      full_device_fallback: false,
      host_relinked: false,
      process_restarted: false,
      full_rebuild_used: false,
      unaffected_artifacts_hash_unchanged: true,
      evidence_refs: ["evidence:fission-verifier-report:wait-fixture"],
      selected_verifier_evidence_id: "evidence:fission-verifier-report:wait-fixture",
      deterministic_verifier_evidence_refs: ["evidence:fission-verifier-report:wait-fixture"],
      selection_decision_hash: HASH_C,
      output_oracle_contract: {
        kind: "compute",
        target_id: "allocation-output",
        readback: "runtime_readback_sample",
      },
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
  });
}

function passingRuntimeProofArtifact(ledger = passingProofLedger(), overrides: Record<string, unknown> = {}) {
  const contract = passingAcceptanceContract(ledger);
  const mutableLedgerRecord = ledger.records?.[0] as Record<string, any> | undefined;
  if (mutableLedgerRecord && mutableLedgerRecord.contract_hash !== contract.contract_hash) {
    mutableLedgerRecord.contract_hash = contract.contract_hash;
    refreshLedgerIdentity(ledger);
  }
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
      mode: "derived_only",
      failures: [],
      failedGates: [],
    },
    ...overrides,
  };
}

function installFakeAttached(
  waitForTerminal: (opts?: FakeWaitOpts) => Promise<{
    status: "applied";
    source: "hmr_status" | "gpu_proof";
    elapsedMs: number;
    observedAt?: number;
    retained?: boolean;
    sequence?: number;
  }>,
  latestGpuProof?: (opts?: GpuHmrProofMatchOpts) => GpuHmrProofTelemetry | null,
  frames?: {
    getFrame: () => Promise<{
      data: Buffer;
      width: number;
      height: number;
      ts: number;
      seq: number;
    }>;
    hasFrame?: () => boolean;
    dimensions?: () => { width: number; height: number };
  }
): {
  feedHmr: (
    msg: Record<string, unknown>,
    parentControlVerificationMaterial?:
      GpuParentRuntimeProofControlVerificationMaterial,
  ) => void;
  invalidateProofTrust: (
    reasonClass?: GpuProofTrustInvalidation["reasonClass"],
  ) => void;
} {
  const listeners: Array<(msg: Record<string, unknown>) => void> = [];
  const proofListeners: Array<{
    opts: GpuHmrProofMatchOpts;
    cb: (proof: GpuHmrProofTelemetry) => void;
  }> = [];
  const proofTrustInvalidationListeners: Array<
    (event: GpuProofTrustInvalidation) => void
  > = [];
  let proofTrustInvalidation: GpuProofTrustInvalidation | null = null;
  (session as unknown as { state: string }).state = "attached";
  (session as unknown as { attached: unknown }).attached = {
    sessionId: "fixture",
    signalingUrl: "ws://localhost:9000",
    resolution: { width: 200, height: 200 },
    frames: frames ?? {
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
        onGpuProof: (
          opts: GpuHmrProofMatchOpts,
          cb: (proof: GpuHmrProofTelemetry) => void
        ) => {
          const listener = { opts, cb };
          proofListeners.push(listener);
          return () => {
            const index = proofListeners.indexOf(listener);
            if (index >= 0) proofListeners.splice(index, 1);
          };
        },
        onGpuProofTrustInvalidated: (
          cb: (event: GpuProofTrustInvalidation) => void,
        ) => {
          if (proofTrustInvalidation !== null) {
            cb(proofTrustInvalidation);
            return () => undefined;
          }
          proofTrustInvalidationListeners.push(cb);
          return () => {
            const index = proofTrustInvalidationListeners.indexOf(cb);
            if (index >= 0) proofTrustInvalidationListeners.splice(index, 1);
          };
        },
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
    feedHmr: (msg, parentControlVerificationMaterial) => {
      const proof = classifyGpuHmrProofMessage(
        msg,
        Date.now(),
        parentControlVerificationMaterial ?? null,
      );
      if (proof !== null && proofTrustInvalidation !== null) return;
      for (const listener of [...proofListeners]) {
        if (gpuHmrProofMatches(proof, listener.opts)) listener.cb(proof);
      }
      for (const listener of [...listeners]) listener(msg);
    },
    invalidateProofTrust: (
      reasonClass = "runtime_evidence_transport_failed",
    ) => {
      if (proofTrustInvalidation !== null) return;
      proofTrustInvalidation = Object.freeze({
        schemaVersion: "synthi.gpu_hmr.proof_trust_invalidation.v1",
        proofAuthority: "proof_trust_invalidation_only_not_gpu_hmr_acceptance",
        reasonClass,
        invalidatedAt: Date.now(),
        acceptedForGpuHmr: false,
        gpuHmrSuccess: false,
        canSatisfyRuntimeProof: false,
      });
      for (const listener of [...proofTrustInvalidationListeners]) {
        listener(proofTrustInvalidation);
      }
      proofTrustInvalidationListeners.length = 0;
    },
  };
}

describe("synthi_wait_hmr", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    session._resetForTests();
    eventLog._resetForTests();
    delete process.env["SYNTHI_MCP_HMR_POST_APPLY_OBSERVE_MS"];
  });

  it("falls back to decoded frames when no frame_advance has ever been seen", async () => {
    installFakeAttached(async () => ({ status: "applied", source: "hmr_status", elapsedMs: 10 }));
    const res = await waitHmrTool({ timeoutMs: 500 });
    expect(res.isError).toBeUndefined();
    const body = res.structuredContent as {
      frame_gate: {
        status: string;
        session_id?: string;
        gate_token?: string;
        capture_binding_required?: boolean;
        capture_binding_source?: string;
        frame_advance_fallback_used?: boolean;
      };
      hmrElapsedMs: number;
    };
    expect(body.hmrElapsedMs).toBe(10);
    expect(body.frame_gate.status).toBe("satisfied");
    expect(body.frame_gate.session_id).toBe("fixture");
    expect(body.frame_gate.gate_token).toMatch(/^frame-gate:/);
    expect(body.frame_gate.capture_binding_required).toBe(true);
    expect(body.frame_gate.capture_binding_source).toBe("decoded_frame");
    expect(body.frame_gate.frame_advance_fallback_used).toBe(true);
  });

  it("times out when both frame_advance and decoded post-budget frames are unavailable", async () => {
    installFakeAttached(
      async () => ({ status: "applied", source: "hmr_status", elapsedMs: 10 }),
      undefined,
      {
        getFrame: async () => ({
          data: Buffer.alloc(0),
          width: 200,
          height: 200,
          ts: 1,
          seq: 1,
        }),
        hasFrame: () => true,
        dimensions: () => ({ width: 200, height: 200 }),
      }
    );
    const res = await waitHmrTool({ timeoutMs: 50 });
    expect(res.isError).toBeUndefined();
    const body = res.structuredContent as {
      frame_gate: {
        status: string;
        reason?: string;
      };
    };
    expect(body.frame_gate.status).toBe("timeout");
    expect(body.frame_gate.reason).toBe("decoded_frame_gate_timeout");
  });

  it("waits for a post-budget frame advance before returning", async () => {
    installFakeAttached(async () => ({ status: "applied", source: "hmr_status", elapsedMs: 10 }));
    session.setFrameAdvance(1, Date.now());
    const budget = resolvePipelineBudgetMs();
    setTimeout(() => session.setFrameAdvance(2, Date.now() + budget + 50), 10);
    const res = await waitHmrTool({ timeoutMs: 2_000 });
    expect(res.isError).toBeUndefined();
    const body = res.structuredContent as {
      frame_gate: {
        status: string;
        frame_seq: number;
        session_id?: string;
        gate_token?: string;
        capture_binding_required?: boolean;
      };
    };
    expect(body.frame_gate.status).toBe("satisfied");
    expect(body.frame_gate.frame_seq).toBe(2);
    expect(body.frame_gate.session_id).toBe("fixture");
    expect(body.frame_gate.gate_token).toMatch(/^frame-gate:/);
    expect(body.frame_gate.capture_binding_required).toBe(true);
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
      detail?: {
        schemaVersion?: string;
        reasonPresent?: boolean;
        reasonRef?: string;
        reason?: string;
      };
    };
    expect(body.status).toBe("rejected");
    expect(body.post_apply_terminal).toBe(true);
    expect(body.detail?.schemaVersion).toBe("synthi.hmr.public_terminal_diagnostic.v1");
    expect(body.detail?.reasonPresent).toBe(true);
    expect(body.detail?.reasonRef).toMatch(/^hmr-terminal-reason-ref:sha256:[a-f0-9]{64}$/);
    expect(body.detail?.reason).toBeUndefined();
    expect(JSON.stringify(body)).not.toContain("GPU kernel launch failed");
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
      detail?: {
        schemaVersion?: string;
        reasonPresent?: boolean;
        reasonRef?: string;
        reason?: string;
      };
    };
    expect(body.status).toBe("rejected");
    expect(body.post_apply_terminal).toBe(true);
    expect(body.detail?.schemaVersion).toBe("synthi.hmr.public_terminal_diagnostic.v1");
    expect(body.detail?.reasonPresent).toBe(true);
    expect(body.detail?.reasonRef).toMatch(/^hmr-terminal-reason-ref:sha256:[a-f0-9]{64}$/);
    expect(body.detail?.reason).toBeUndefined();
    expect(JSON.stringify(body)).not.toContain("post-reload device dispatch rejected");
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
        proofId: "gpu-proof:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        proofArtifactPath: ".synthi/gpu-hmr/proofs/gpu-proof_abc.json",
      });
      return { status: "applied", source: "hmr_status", elapsedMs: 10 };
    });

    const res = await waitHmrTool({ timeoutMs: 500 });

    expect(fake).toBeDefined();
    expect(res.isError).toBeUndefined();
    const body = res.structuredContent as {
      gpu_proof?: { resultState?: string };
      gpu_proof_telemetry?: {
        resultState?: string;
        degradedState?: string;
        proofRef?: string | null;
        proofIdPresent?: boolean;
        proofArtifactPresent?: boolean;
      };
      gpu_proof_validation?: { validated?: boolean; satisfied?: boolean; reason?: string };
      proof_pending?: boolean;
      proof_status?: string;
      gpu_hmr_dev_loop?: {
        mode?: string;
        proof_pending?: boolean;
        accepted_for_gpu_hmr?: boolean;
        gpu_hmr_success?: boolean;
        evidence_authority?: string;
        reason?: string;
        latest_proof_state?: string;
        latest_degraded_state?: string;
        next_strict_proof_state?: string;
      };
    };
    expect(body.gpu_proof).toBeUndefined();
    expect(body.gpu_proof_telemetry?.resultState).toBe("gpu-hmr-symbol-bound");
    expect(body.gpu_proof_telemetry?.degradedState).toBe("gpu-hmr-dispatch-unobserved");
    expect(body.gpu_proof_telemetry).not.toHaveProperty("proofId");
    expect(body.gpu_proof_telemetry?.proofRef).toMatch(
      /^gpu-proof-identity-ref:sha256:[a-f0-9]{64}$/
    );
    expect(body.gpu_proof_telemetry?.proofIdPresent).toBe(true);
    expect(body.gpu_proof_telemetry?.proofArtifactPresent).toBe(true);
    expect(body.gpu_proof_validation?.validated).toBe(false);
    expect(body.gpu_proof_validation?.satisfied).toBe(false);
    expect(body.gpu_proof_validation?.reason).toBe("proof_state_not_requested");
    expect(body.proof_pending).toBe(true);
    expect(body.proof_status).toBe("hmr_applied_proof_pending");
    expect(body.gpu_hmr_dev_loop?.mode).toBe("non_blocking_dev_loop");
    expect(body.gpu_hmr_dev_loop?.proof_pending).toBe(true);
    expect(body.gpu_hmr_dev_loop?.accepted_for_gpu_hmr).toBe(false);
    expect(body.gpu_hmr_dev_loop?.gpu_hmr_success).toBe(false);
    expect(body.gpu_hmr_dev_loop?.evidence_authority).toBe("hmr_fast_path_only_not_gpu_hmr_acceptance");
    expect(body.gpu_hmr_dev_loop?.reason).toBe("strict_proof_state_not_requested");
    expect(body.gpu_hmr_dev_loop?.latest_proof_state).toBe("gpu-hmr-symbol-bound");
    expect(body.gpu_hmr_dev_loop?.latest_degraded_state).toBe("gpu-hmr-dispatch-unobserved");
    expect(body.gpu_hmr_dev_loop?.next_strict_proof_state).toBe("gpu-hmr-full-runtime-proven");
  });

  it("returns applied with explicit proof-pending dev-loop status when proof telemetry is absent", async () => {
    installFakeAttached(async () => ({ status: "applied", source: "hmr_status", elapsedMs: 10 }));

    const res = await waitHmrTool({ timeoutMs: 500 });

    expect(res.isError).toBeUndefined();
    const body = res.structuredContent as {
      status?: string;
      proof_pending?: boolean;
      proof_status?: string;
      gpu_proof?: unknown;
      gpu_proof_telemetry?: unknown;
      gpu_hmr_dev_loop?: {
        proof_pending?: boolean;
        strict_ledger_validation_requested?: boolean;
        accepted_for_gpu_hmr?: boolean;
        gpu_hmr_success?: boolean;
        reason?: string;
        latest_proof_state?: string | null;
        next_strict_proof_state?: string;
      };
    };
    expect(body.status).toBe("applied");
    expect(body.gpu_proof).toBeUndefined();
    expect(body.gpu_proof_telemetry).toBeUndefined();
    expect(body.proof_pending).toBe(true);
    expect(body.proof_status).toBe("hmr_applied_proof_pending");
    expect(body.gpu_hmr_dev_loop?.proof_pending).toBe(true);
    expect(body.gpu_hmr_dev_loop?.strict_ledger_validation_requested).toBe(false);
    expect(body.gpu_hmr_dev_loop?.accepted_for_gpu_hmr).toBe(false);
    expect(body.gpu_hmr_dev_loop?.gpu_hmr_success).toBe(false);
    expect(body.gpu_hmr_dev_loop?.reason).toBe("proof_telemetry_missing");
    expect(body.gpu_hmr_dev_loop?.latest_proof_state).toBeNull();
    expect(body.gpu_hmr_dev_loop?.next_strict_proof_state).toBe("gpu-hmr-full-runtime-proven");
  });

  it("reports a prevalidated retained full-runtime proof as ready without granting acceptance", async () => {
    const partial = classifyGpuHmrProofMessage({
      status: "gpu-proof-state",
      resultState: "gpu-hmr-symbol-bound",
      proofArtifactPath: ".synthi/gpu-hmr/proofs/full-runtime-ready.json",
    }, Date.now());
    expect(partial).not.toBeNull();
    const proof = {
      ...partial!,
      resultState: "gpu-hmr-full-runtime-proven",
      decisions: {
        ...partial!.decisions,
        "gpu-hmr-full-runtime-proven": {
          ...partial!.decisions["gpu-hmr-full-runtime-proven"],
          resultState: "gpu-hmr-full-runtime-proven",
          resultRank: 9,
          effectiveResultRank: 9,
          satisfied: true,
          reason: undefined,
        },
      },
    } as GpuHmrProofTelemetry;
    installFakeAttached(
      async () => ({ status: "applied", source: "hmr_status", elapsedMs: 10 }),
      () => proof,
    );

    const res = await waitHmrTool({ timeoutMs: 500, sinceTs: 0 });

    expect(res.isError).toBeUndefined();
    const body = res.structuredContent as {
      status?: string;
      proof_pending?: boolean;
      proof_ready?: boolean;
      proof_status?: string;
      gpu_proof_validation?: {
        validated?: boolean;
        satisfied?: boolean;
        reason?: string;
      };
      gpu_hmr_dev_loop?: {
        proof_pending?: boolean;
        proof_ready?: boolean;
        strict_ledger_validation_requested?: boolean;
        accepted_for_gpu_hmr?: boolean;
        gpu_hmr_success?: boolean;
        reason?: string;
        latest_proof_state?: string | null;
      };
    };
    expect(body.status).toBe("applied");
    expect(body.proof_pending).toBe(false);
    expect(body.proof_ready).toBe(true);
    expect(body.proof_status).toBe("hmr_applied_proof_ready");
    expect(body.gpu_proof_validation).toMatchObject({
      validated: false,
      satisfied: false,
      reason: "proof_state_not_requested",
    });
    expect(body.gpu_hmr_dev_loop).toMatchObject({
      proof_pending: false,
      proof_ready: true,
      strict_ledger_validation_requested: false,
      accepted_for_gpu_hmr: false,
      gpu_hmr_success: false,
      reason: "strict_proof_state_available_not_requested",
      latest_proof_state: "gpu-hmr-full-runtime-proven",
    });
  });

  it("keeps an unvalidated full-runtime label pending", async () => {
    const proof = classifyGpuHmrProofMessage({
      status: "gpu-proof-state",
      resultState: "gpu-hmr-full-runtime-proven",
      proofArtifactPath: ".synthi/gpu-hmr/proofs/unvalidated-full-runtime.json",
    }, Date.now());
    expect(proof).not.toBeNull();
    expect(
      proof!.decisions["gpu-hmr-full-runtime-proven"].satisfied,
    ).toBe(false);
    installFakeAttached(
      async () => ({ status: "applied", source: "hmr_status", elapsedMs: 10 }),
      () => proof,
    );

    const res = await waitHmrTool({ timeoutMs: 500, sinceTs: 0 });

    expect(res.isError).toBeUndefined();
    const body = res.structuredContent as {
      proof_pending?: boolean;
      proof_ready?: boolean;
      proof_status?: string;
      gpu_hmr_dev_loop?: {
        proof_pending?: boolean;
        proof_ready?: boolean;
        accepted_for_gpu_hmr?: boolean;
        gpu_hmr_success?: boolean;
      };
    };
    expect(body.proof_pending).toBe(true);
    expect(body.proof_ready).toBe(false);
    expect(body.proof_status).toBe("hmr_applied_proof_pending");
    expect(body.gpu_hmr_dev_loop).toMatchObject({
      proof_pending: true,
      proof_ready: false,
      accepted_for_gpu_hmr: false,
      gpu_hmr_success: false,
    });
  });

  it("keeps a mismatched full-runtime decision pending", async () => {
    const partial = classifyGpuHmrProofMessage({
      status: "gpu-proof-state",
      resultState: "gpu-hmr-symbol-bound",
    }, Date.now());
    expect(partial).not.toBeNull();
    const proof = {
      ...partial!,
      decisions: {
        ...partial!.decisions,
        "gpu-hmr-full-runtime-proven": {
          ...partial!.decisions["gpu-hmr-full-runtime-proven"],
          satisfied: true,
        },
      },
    } as GpuHmrProofTelemetry;
    installFakeAttached(
      async () => ({ status: "applied", source: "hmr_status", elapsedMs: 10 }),
      () => proof,
    );

    const res = await waitHmrTool({ timeoutMs: 500, sinceTs: 0 });

    expect(res.isError).toBeUndefined();
    expect(res.structuredContent).toMatchObject({
      proof_pending: true,
      proof_ready: false,
      proof_status: "hmr_applied_proof_pending",
      gpu_hmr_dev_loop: {
        proof_pending: true,
        proof_ready: false,
        accepted_for_gpu_hmr: false,
        gpu_hmr_success: false,
      },
    });
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

  it("fails fast when proof trust is invalidated during a strict wait", async () => {
    const issueSpy = vi.spyOn(session, "issueFrameGateToken");
    let resolveTerminal: (() => void) | null = null;
    const fake = installFakeAttached(() => new Promise((resolve) => {
      resolveTerminal = () => resolve({
        status: "applied",
        source: "hmr_status",
        elapsedMs: 100,
      });
    }));
    setTimeout(() => fake.invalidateProofTrust(), 5);

    const started = Date.now();
    const res = await waitHmrTool({
      timeoutMs: 1_000,
      requireGpuFullRuntimeProof: true,
    });
    resolveTerminal?.();

    expect(Date.now() - started).toBeLessThan(500);
    expect(res.isError).toBe(true);
    const body = res.structuredContent as {
      error?: string;
      gpu_proof_wait?: { status?: string; reason?: string; invalidation_stage?: string };
      gpu_proof_trust_invalidation?: {
        evidence_authority?: string;
        reason_class?: string;
        accepted_for_gpu_hmr?: boolean;
        gpu_hmr_success?: boolean;
      };
    };
    expect(body.error).toBe("gpu_hmr_proof_insufficient");
    expect(body.gpu_proof_wait).toMatchObject({
      status: "failed_fast",
      reason: "gpu_proof_trust_invalidated",
      invalidation_stage: "terminal_or_proof_wait",
    });
    expect(body.gpu_proof_trust_invalidation).toMatchObject({
      evidence_authority: "proof_trust_invalidation_only_not_gpu_hmr_acceptance",
      reason_class: "runtime_evidence_transport_failed",
      accepted_for_gpu_hmr: false,
      gpu_hmr_success: false,
    });
    expect(issueSpy).not.toHaveBeenCalled();
  });

  it("revokes a strict wait during post-proof frame reacquisition", async () => {
    const ledger = passingProofLedger();
    const issueSpy = vi.spyOn(session, "issueFrameGateToken");
    const budget = resolvePipelineBudgetMs();
    const frameClockBase = Date.now();
    session.setFrameAdvance(1, frameClockBase);
    const fake = installFakeAttached(async () => {
      setTimeout(
        () => session.setFrameAdvance(2, frameClockBase + budget + 5),
        5,
      );
      setTimeout(() => fake.feedHmr({
        status: "gpu-proof-state",
        resultState: "gpu-hmr-full-runtime-proven",
        proofLedger: ledger,
        runtimeProofArtifact: passingRuntimeProofArtifact(ledger),
      }), budget + 20);
      setTimeout(() => fake.invalidateProofTrust(), budget + 30);
      return { status: "applied", source: "hmr_status", elapsedMs: 10 };
    });

    const res = await waitHmrTool({
      timeoutMs: Math.max(1_000, budget + 500),
      requireGpuFullRuntimeProof: true,
    });

    expect(res.isError).toBe(true);
    const body = res.structuredContent as {
      error?: string;
      gpu_proof_wait?: { reason?: string; invalidation_stage?: string };
    };
    expect(body.error).toBe("gpu_hmr_proof_insufficient");
    expect(body.gpu_proof_wait).toMatchObject({
      reason: "gpu_proof_trust_invalidated",
      invalidation_stage: "post_proof_frame_reacquisition",
    });
    expect(issueSpy).not.toHaveBeenCalled();
  });

  it("rechecks proof trust after a reentrant token-mint boundary", async () => {
    const ledger = passingProofLedger();
    const budget = resolvePipelineBudgetMs();
    const frameClockBase = Date.now();
    session.setFrameAdvance(1, frameClockBase);
    let fake: ReturnType<typeof installFakeAttached>;
    const issueSpy = vi.spyOn(session, "issueFrameGateToken").mockImplementation(() => {
      fake.invalidateProofTrust();
      return {
        token: "frame-gate:synthetic-reentrant-boundary",
        issued_at_ms: Date.now(),
        expires_at_ms: Date.now() + 1_000,
        evidence_binding_hash: HASH_C,
      };
    });
    fake = installFakeAttached(async () => {
      setTimeout(() => fake.feedHmr({
        status: "gpu-proof-state",
        resultState: "gpu-hmr-full-runtime-proven",
        proofLedger: ledger,
        runtimeProofArtifact: passingRuntimeProofArtifact(ledger),
      }), 5);
      setTimeout(
        () => session.setFrameAdvance(2, frameClockBase + budget + 100),
        15,
      );
      return {
        status: "applied",
        source: "hmr_status",
        elapsedMs: 10,
        observedAt: frameClockBase,
      };
    });

    const res = await waitHmrTool({
      timeoutMs: Math.max(1_000, budget + 500),
      requireGpuFullRuntimeProof: true,
    });

    expect(issueSpy).toHaveBeenCalledTimes(1);
    expect(res.isError).toBe(true);
    const body = res.structuredContent as {
      error?: string;
      gpu_proof_wait?: { reason?: string; invalidation_stage?: string };
    };
    expect(body.error).toBe("gpu_hmr_proof_insufficient");
    expect(body.gpu_proof_wait).toMatchObject({
      reason: "gpu_proof_trust_invalidated",
      invalidation_stage: "after_frame_token",
    });
  });

  it("waits for requested full runtime proof after applied terminal", async () => {
    const ledger = passingProofLedger();
    const budget = resolvePipelineBudgetMs();
    const issueInputs: Array<Parameters<typeof session.issueFrameGateToken>[0]> = [];
    const issueTimes: number[] = [];
    const issueFrameGateToken = session.issueFrameGateToken.bind(session);
    vi.spyOn(session, "issueFrameGateToken").mockImplementation((input) => {
      issueInputs.push(input);
      issueTimes.push(Date.now());
      return issueFrameGateToken(input);
    });
    const frameClockBase = Date.now();
    session.setFrameAdvance(1, frameClockBase);
    const fake = installFakeAttached(async () => {
      setTimeout(() => session.setFrameAdvance(2, frameClockBase + budget + 5), 5);
      setTimeout(
        () =>
          fake.feedHmr({
            status: "gpu-proof-state",
            resultState: "gpu-hmr-full-runtime-proven",
            proofLedger: ledger,
            runtimeProofArtifact: passingRuntimeProofArtifact(ledger),
          }),
        budget + 30
      );
      setTimeout(() => session.setFrameAdvance(3, Date.now()), budget + 50);
      return { status: "applied", source: "hmr_status", elapsedMs: 10 };
    });

    const started = Date.now();
    const res = await waitHmrTool({
      timeoutMs: 500,
      requireGpuFullRuntimeProof: true,
    });

    expect(Date.now() - started).toBeGreaterThanOrEqual(20);
    expect(res.isError).toBeUndefined();
    const body = res.structuredContent as {
      gpu_proof_validation?: {
        satisfied?: boolean;
        runtimeProofArtifactValidation?: { accepted?: boolean };
      };
      gpu_proof_telemetry?: { observedAt?: number };
      frame_gate: {
        status: string;
        frame_seq: number;
        ts_ms: number;
        gate_token?: string;
        gate_token_issued_at_ms?: number;
        runtime_binding_status?: string;
        capture_binding_ready?: boolean;
        evidence_binding_hash?: string;
        evidence_binding_schema_version?: string;
        runtime_proof_ref?: string;
        capture_reacquired_after_proof?: boolean;
        proof_observed_at_ms?: number;
      };
    };
    expect(body.gpu_proof_validation?.satisfied).toBe(true);
    expect(body.gpu_proof_validation?.runtimeProofArtifactValidation?.accepted).toBe(true);
    expect(issueInputs).toHaveLength(1);
    expect(issueInputs[0]?.evidence_binding).toMatchObject({
      schema_version: "synthi.gpu_hmr.frame_gate_runtime_binding.v1",
      runtime_proof_state: "gpu-hmr-full-runtime-proven",
      artifact_after_hash: HASH_B,
      dispatch_ref: expect.stringMatching(/^gpu-frame-dispatch-ref:sha256:[a-f0-9]{64}$/),
      output_after_dispatch_ref: expect.stringMatching(/^gpu-frame-dispatch-ref:sha256:[a-f0-9]{64}$/),
      runtime_session_ref: expect.stringMatching(/^gpu-frame-runtime-session-ref:sha256:[a-f0-9]{64}$/),
      device_ref: expect.stringMatching(/^gpu-frame-device-ref:sha256:[a-f0-9]{64}$/),
      frame_observed_at_ms: expect.any(Number),
      accepted_for_gpu_hmr: false,
      gpu_hmr_success: false,
    });
    expect(issueInputs[0]?.evidence_binding).not.toHaveProperty("dispatch_id");
    expect(issueInputs[0]?.evidence_binding).not.toHaveProperty("process_id");
    expect(issueInputs[0]?.evidence_binding).not.toHaveProperty("runtime_session_id");
    expect(issueInputs[0]?.evidence_binding).not.toHaveProperty("device_id");
    expect(issueInputs[0]?.frame_seq).toBe(3);
    expect(issueInputs[0]?.ts_ms).toBeGreaterThanOrEqual(
      body.gpu_proof_telemetry?.observedAt ?? Infinity
    );
    expect(issueTimes[0]).toBeGreaterThanOrEqual(body.gpu_proof_telemetry?.observedAt ?? Infinity);
    expect(body.frame_gate.status).toBe("satisfied");
    expect(body.frame_gate.runtime_binding_status).toBe("bound");
    expect(body.frame_gate.capture_binding_ready).toBe(true);
    expect(body.frame_gate.evidence_binding_schema_version).toBe(
      "synthi.gpu_hmr.frame_gate_runtime_binding.v1"
    );
    expect(body.frame_gate.evidence_binding_hash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(body.frame_gate.runtime_proof_ref).toMatch(
      /^gpu-frame-runtime-proof-ref:sha256:[a-f0-9]{64}$/
    );
    expect(body.frame_gate).not.toHaveProperty("runtime_proof_id");
    expect(body.frame_gate.capture_reacquired_after_proof).toBe(true);
    expect(body.frame_gate.proof_observed_at_ms).toBe(
      body.gpu_proof_telemetry?.observedAt
    );
    expect(body.frame_gate.gate_token).toMatch(/^frame-gate:/);
    const consumed = session.consumeFrameGateToken({
      token: body.frame_gate.gate_token!,
      session_id: "fixture",
      frame_seq: body.frame_gate.frame_seq,
      ts_ms: body.frame_gate.ts_ms,
    });
    expect(consumed.accepted).toBe(true);
    expect(consumed.evidence_binding).toEqual(issueInputs[0]?.evidence_binding);
    expect(consumed.evidence_binding_hash).toBe(body.frame_gate.evidence_binding_hash);
  });

  it("pins a satisfying strict proof while a lower proof arrives during the frame wait", async () => {
    const ledger = passingProofLedger();
    const parentControlVerificationMaterial =
      parentControlVerificationMaterialFixture();
    const budget = resolvePipelineBudgetMs();
    const frameClockBase = Date.now();
    session.setFrameAdvance(1, frameClockBase);

    const issueInputs: Array<Parameters<typeof session.issueFrameGateToken>[0]> = [];
    const issueFrameGateToken = session.issueFrameGateToken.bind(session);
    vi.spyOn(session, "issueFrameGateToken").mockImplementation((input) => {
      issueInputs.push(input);
      return issueFrameGateToken(input);
    });

    const awaitFrameAdvanceAtOrAfter =
      session.awaitFrameAdvanceAtOrAfter.bind(session);
    let resolveFrameWaitStarted!: () => void;
    const frameWaitStarted = new Promise<void>((resolve) => {
      resolveFrameWaitStarted = resolve;
    });
    vi.spyOn(session, "awaitFrameAdvanceAtOrAfter").mockImplementation(
      (minTsMs, timeoutMs, signal) => {
        resolveFrameWaitStarted();
        return awaitFrameAdvanceAtOrAfter(minTsMs, timeoutMs, signal);
      },
    );

    let lowerProofEmittedDuringFrameWait = false;
    const fake = installFakeAttached((opts) => {
      fake.feedHmr({
        status: "gpu-proof-state",
        resultState: "gpu-hmr-full-runtime-proven",
        proofId: `gpu-proof:${"a".repeat(64)}`,
        proofArtifactPath: ".synthi/gpu-hmr/proofs/full-runtime.json",
        proofLedger: ledger,
        runtimeProofArtifact: passingRuntimeProofArtifact(ledger),
      }, parentControlVerificationMaterial);
      void frameWaitStarted.then(() => {
        lowerProofEmittedDuringFrameWait = true;
        fake.feedHmr({
          status: "gpu-proof-state",
          resultState: "gpu-hmr-symbol-bound",
          proofId: `gpu-proof:${"b".repeat(64)}`,
          proofArtifactPath: ".synthi/gpu-hmr/proofs/symbol-bound.json",
        });
        session.setFrameAdvance(2, Date.now() + budget + 1);
      });
      return new Promise((resolve) => {
        opts?.signal?.addEventListener("abort", () => resolve({
          status: "applied",
          source: "hmr_status",
          elapsedMs: 250,
        }), { once: true });
      });
    });

    const res = await waitHmrTool({
      timeoutMs: Math.max(1_000, budget + 500),
      requireGpuFullRuntimeProof: true,
    });

    expect(lowerProofEmittedDuringFrameWait).toBe(true);
    expect(res.isError).toBeUndefined();
    const body = res.structuredContent as {
      detail?: { proofRef?: string | null; resultState?: string };
      gpu_proof_validation?: { satisfied?: boolean };
      gpu_proof_telemetry?: {
        proofRef?: string | null;
        resultState?: string;
        observedAt?: number;
        parentControlVerificationMaterial?:
          GpuParentRuntimeProofControlVerificationMaterial;
      };
      gpu_proof?: {
        proofRef?: string | null;
        resultState?: string;
        observedAt?: number;
        parentControlVerificationMaterial?:
          GpuParentRuntimeProofControlVerificationMaterial;
      };
      frame_gate: {
        runtime_binding_status?: string;
        runtime_proof_ref?: string;
      };
    };
    expect(body.gpu_proof_validation?.satisfied).toBe(true);
    expect(body.detail?.resultState).toBe("gpu-hmr-full-runtime-proven");
    expect(body.gpu_proof?.resultState).toBe("gpu-hmr-full-runtime-proven");
    expect(body.detail?.proofRef).toBe(body.gpu_proof?.proofRef);
    expect(body.gpu_proof_telemetry?.proofRef).toBe(body.gpu_proof?.proofRef);
    expect(body.gpu_proof?.parentControlVerificationMaterial)
      .toEqual(parentControlVerificationMaterial);
    expect(body.gpu_proof?.parentControlVerificationMaterial)
      .toBe(body.gpu_proof_telemetry?.parentControlVerificationMaterial);
    expect(issueInputs).toHaveLength(1);
    expect(issueInputs[0]?.evidence_binding).toMatchObject({
      runtime_proof_state: "gpu-hmr-full-runtime-proven",
      runtime_proof_observed_at_ms: body.gpu_proof?.observedAt,
    });
    expect(body.frame_gate.runtime_binding_status).toBe("bound");
    expect(body.frame_gate.runtime_proof_ref).toBe(
      issueInputs[0]?.evidence_binding?.runtime_proof_ref,
    );
  });

  it("does not mint a legacy token when accepted strict proof lacks runtime binding material", async () => {
    const ledger = passingProofLedger();
    delete ledger.records[0]!.output_event.runtime_session_id;
    refreshLedgerIdentity(ledger);
    const issueSpy = vi.spyOn(session, "issueFrameGateToken");
    const budget = resolvePipelineBudgetMs();
    session.setFrameAdvance(1, Date.now());
    const fake = installFakeAttached(async () => {
      setTimeout(() => session.setFrameAdvance(2, Date.now() + budget + 100), 5);
      setTimeout(
        () => fake.feedHmr({
          status: "gpu-proof-state",
          resultState: "gpu-hmr-full-runtime-proven",
          proofLedger: ledger,
          runtimeProofArtifact: passingRuntimeProofArtifact(ledger),
        }),
        15
      );
      return { status: "applied", source: "hmr_status", elapsedMs: 10 };
    });

    const res = await waitHmrTool({
      timeoutMs: Math.max(1_000, budget + 500),
      requireGpuFullRuntimeProof: true,
    });

    expect(res.isError).toBeUndefined();
    const body = res.structuredContent as {
      gpu_proof_validation?: { satisfied?: boolean };
      frame_gate: {
        gate_token?: string;
        runtime_binding_status?: string;
        capture_binding_ready?: boolean;
        runtime_binding_failure_codes?: string[];
      };
    };
    expect(body.gpu_proof_validation?.satisfied).toBe(true);
    expect(issueSpy).not.toHaveBeenCalled();
    expect(body.frame_gate.gate_token).toBeUndefined();
    expect(body.frame_gate.runtime_binding_status).toBe("unavailable");
    expect(body.frame_gate.capture_binding_ready).toBe(false);
    expect(body.frame_gate.runtime_binding_failure_codes).toContain(
      "runtime_session_identity_material_incomplete"
    );
  });

  it("rejects strict proof observed before the applied boundary without minting a token", async () => {
    const ledger = passingProofLedger();
    const issueSpy = vi.spyOn(session, "issueFrameGateToken");
    const budget = resolvePipelineBudgetMs();
    const terminalObservedAt = Date.now() + 1_000;
    session.setFrameAdvance(1, Date.now());
    const fake = installFakeAttached(async () => {
      setTimeout(
        () => session.setFrameAdvance(2, terminalObservedAt + budget + 1),
        5
      );
      setTimeout(
        () => fake.feedHmr({
          status: "gpu-proof-state",
          resultState: "gpu-hmr-full-runtime-proven",
          proofLedger: ledger,
          runtimeProofArtifact: passingRuntimeProofArtifact(ledger),
        }),
        10
      );
      return {
        status: "applied",
        source: "hmr_status",
        elapsedMs: 10,
        observedAt: terminalObservedAt,
      };
    });

    const res = await waitHmrTool({
      timeoutMs: 100,
      requireGpuFullRuntimeProof: true,
    });

    expect(res.isError).toBe(true);
    const body = res.structuredContent as {
      error?: string;
      gpu_proof_validation?: { satisfied?: boolean; reason?: string };
      frame_gate: {
        gate_token?: string;
        runtime_binding_status?: string;
        runtime_binding_failure_codes?: string[];
      };
    };
    expect(body.error).toBe("gpu_hmr_proof_insufficient");
    expect(body.gpu_proof_validation?.satisfied).toBe(false);
    expect(body.gpu_proof_validation?.reason).toBe(
      "proof_observed_before_required_boundary"
    );
    expect(issueSpy).not.toHaveBeenCalled();
    expect(body.frame_gate.gate_token).toBeUndefined();
    expect(body.frame_gate.runtime_binding_status).toBe("unavailable");
    expect(body.frame_gate.runtime_binding_failure_codes).toContain(
      "runtime_binding_proof_observation_order_invalid"
    );
  });

  it("does not fail fast for a partial proof when a later full runtime proof arrives", async () => {
    const ledger = passingProofLedger();
    const fake = installFakeAttached(async () => {
      fake.feedHmr({
        status: "gpu-proof-state",
        resultState: "gpu-hmr-symbol-bound",
        proofId: "gpu-proof:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        proofArtifactPath: ".synthi/gpu-hmr/proofs/symbol-bound.json",
      });
      setTimeout(
        () =>
          fake.feedHmr({
            status: "gpu-proof-state",
            resultState: "gpu-hmr-full-runtime-proven",
            proofLedger: ledger,
            runtimeProofArtifact: passingRuntimeProofArtifact(ledger),
          }),
        25
      );
      return { status: "applied", source: "hmr_status", elapsedMs: 10 };
    });

    const started = Date.now();
    const res = await waitHmrTool({
      timeoutMs: 500,
      requireGpuFullRuntimeProof: true,
    });

    expect(Date.now() - started).toBeGreaterThanOrEqual(20);
    expect(res.isError).toBeUndefined();
    const body = res.structuredContent as {
      proof_wait_timeout_intelligence?: unknown;
      gpu_proof_validation?: {
        satisfied?: boolean;
        runtimeProofArtifactValidation?: { accepted?: boolean };
      };
    };
    expect(body.proof_wait_timeout_intelligence).toBeUndefined();
    expect(body.gpu_proof_validation?.satisfied).toBe(true);
    expect(body.gpu_proof_validation?.runtimeProofArtifactValidation?.accepted).toBe(true);
  });

  it("treats a valid full runtime proof as terminal-equivalent when applied is missing", async () => {
    const ledger = passingProofLedger();
    let terminalResolved = false;
    let terminalTimer: ReturnType<typeof setTimeout> | undefined;
    const fake = installFakeAttached(async () =>
      new Promise((resolve) => {
        setTimeout(
          () =>
            fake.feedHmr({
              status: "gpu-proof-state",
              module: "device",
              resultState: "gpu-hmr-full-runtime-proven",
              proofLedger: ledger,
              runtimeProofArtifact: passingRuntimeProofArtifact(ledger),
            }),
          25
        );
        terminalTimer = setTimeout(
          () => {
            terminalResolved = true;
            resolve({ status: "applied", source: "hmr_status", elapsedMs: 250 });
          },
          250
        );
      })
    );

    try {
      const res = await waitHmrTool({
        timeoutMs: 500,
        module: "device",
        requireGpuFullRuntimeProof: true,
      });

      expect(terminalResolved).toBe(false);
      expect(res.isError).toBeUndefined();
      const body = res.structuredContent as {
        status?: string;
        source?: string;
        detail?: { terminal_equivalent?: string };
        gpu_proof_validation?: {
          satisfied?: boolean;
          runtimeProofArtifactValidation?: { accepted?: boolean };
        };
      };
      expect(body.status).toBe("applied");
      expect(body.source).toBe("gpu_proof");
      expect(body.detail?.terminal_equivalent).toBe("gpu_hmr_full_runtime_proof");
      expect(body.gpu_proof_validation?.satisfied).toBe(true);
      expect(body.gpu_proof_validation?.runtimeProofArtifactValidation?.accepted).toBe(true);
    } finally {
      if (terminalTimer) clearTimeout(terminalTimer);
    }
  });

  it("rejects full runtime proof telemetry without proof ledger", async () => {
    const fake = installFakeAttached(async () => {
      setTimeout(() => fake.feedHmr({
        status: "gpu-proof-state",
        resultState: "gpu-hmr-full-runtime-proven",
      }), 10);
      return { status: "applied", source: "hmr_status", elapsedMs: 10 };
    });

    const started = Date.now();
    const res = await waitHmrTool({ timeoutMs: 500, requireGpuFullRuntimeProof: true });

    expect(Date.now() - started).toBeLessThan(250);
    expect(res.isError).toBe(true);
    const body = res.structuredContent as {
      error?: string;
      gpu_proof_validation?: { reason?: string };
      gpu_proof_ledger_validation?: unknown;
      proof_wait_decision?: string;
      proof_wait_timeout_intelligence?: {
        decision?: string;
        reason?: string;
        evidence_authority?: string;
        accepted_for_gpu_hmr?: boolean;
        gpu_hmr_success?: boolean;
        result_state?: string | null;
        failed_ledger_invariants?: string[];
      };
    };
    expect(body.error).toBe("gpu_hmr_proof_insufficient");
    expect(body.gpu_proof_validation?.reason).toBe("proof_ledger_missing");
    expect(body.gpu_proof_ledger_validation).toBeNull();
    expect(body.proof_wait_decision).toBe("fail_fast_structural_gap");
    expect(body.proof_wait_timeout_intelligence?.decision).toBe("fail_fast_structural_gap");
    expect(body.proof_wait_timeout_intelligence?.reason).toBe("proof_ledger_missing");
    expect(body.proof_wait_timeout_intelligence?.evidence_authority)
      .toBe("strict_proof_wait_timeout_intelligence_not_gpu_hmr_acceptance");
    expect(body.proof_wait_timeout_intelligence?.accepted_for_gpu_hmr).toBe(false);
    expect(body.proof_wait_timeout_intelligence?.gpu_hmr_success).toBe(false);
    expect(body.proof_wait_timeout_intelligence?.result_state).toBe("gpu-hmr-full-runtime-proven");
    expect(body.proof_wait_timeout_intelligence?.failed_ledger_invariants).toEqual([]);
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
      setTimeout(() => fake.feedHmr({
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
        }), 10);
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
    const parentControlVerificationMaterial =
      parentControlVerificationMaterialFixture();
    const fake = installFakeAttached(async () => {
      setTimeout(
        () => fake.feedHmr({
          status: "gpu-proof-state",
          resultState: "gpu-hmr-full-runtime-proven",
          proofLedger: ledger,
          runtimeProofArtifact: passingRuntimeProofArtifact(ledger),
        }, parentControlVerificationMaterial),
        10
      );
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
      gpu_proof_telemetry?: {
        parentControlVerificationMaterial?:
          GpuParentRuntimeProofControlVerificationMaterial;
      };
      gpu_proof?: {
        parentControlVerificationMaterial?:
          GpuParentRuntimeProofControlVerificationMaterial;
      };
    };
    expect(body.gpu_proof_validation?.satisfied).toBe(true);
    expect(body.gpu_proof_ledger_validation?.gpuHmrSuccess).toBe(true);
    expect(body.gpu_proof_validation?.runtimeProofArtifactValidation?.accepted).toBe(true);
    expect(body.gpu_proof_telemetry?.parentControlVerificationMaterial)
      .toEqual(parentControlVerificationMaterial);
    expect(body.gpu_proof?.parentControlVerificationMaterial)
      .toBe(body.gpu_proof_telemetry?.parentControlVerificationMaterial);
    expect(body.gpu_proof?.parentControlVerificationMaterial)
      .not.toHaveProperty("verified");
    expect(body.gpu_proof?.parentControlVerificationMaterial)
      .not.toHaveProperty("accepted");
    expect(body.gpu_proof?.parentControlVerificationMaterial)
      .not.toHaveProperty("success");
    expect(body.gpu_proof?.parentControlVerificationMaterial)
      .not.toHaveProperty("authority");
    expect(body.gpu_proof?.parentControlVerificationMaterial)
      .not.toHaveProperty("acceptedForGpuHmr");
    expect(body.gpu_proof?.parentControlVerificationMaterial)
      .not.toHaveProperty("gpuHmrSuccess");
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
    const forgedArtifact = passingRuntimeProofArtifact(forgedArtifactLedger);
    forgedArtifact.proofLedgerQuery = {
      ...forgedArtifactLedger.query,
      gpuHmrSuccess: true,
      failedInvariants: [],
    };
    const fake = installFakeAttached(async () => {
      fake.feedHmr({
        status: "gpu-proof-state",
        resultState: "gpu-hmr-full-runtime-proven",
        proofLedger: ledger,
        runtimeProofArtifact: forgedArtifact,
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
