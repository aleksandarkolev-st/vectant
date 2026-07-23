import { describe, expect, it } from "vitest";
import {
  GPU_HMR_PROOF_LEDGER_SCHEMA_VERSION,
  GPU_HMR_PROOF_LEDGER_PORTABLE_CANONICAL_PROFILE,
  queryGpuHmrLedgerInvariants,
} from "../../src/gpu_proof_ledger.js";
import {
  evaluateGpuHmrProofLedger as evaluateScriptGpuHmrProofLedger,
} from "../../scripts/lib/gpu-hmr-proof-ledger.mjs";

const HASH_A = `sha256:${"a".repeat(64)}`;
const HASH_B = `sha256:${"b".repeat(64)}`;
const HASH_C = `sha256:${"c".repeat(64)}`;

function timingMetrics(): Record<string, unknown> {
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

function modelRecord(model: string, requestMode: "split" | "gpu_delta") {
  return {
    provider: "google_gemini",
    requested_model: model,
    provider_model_status: "available",
    provider_model_alias_resolved_to: null,
    provider_shutdown_or_deprecation_detected: false,
    model_availability_checked_at: "2026-07-16T00:00:00.000Z",
    model_availability_source: "provider-model-list",
    model_availability_basis: "live_model_list",
    model_availability_check_time_ms: 0,
    actual_model: model,
    fallback_model: null,
    fallback_used: false,
    request_mode: requestMode,
    hard_infra_failure: false,
  };
}

function portableCanonicalFixture(): {
  [key: string]: unknown;
  epoch_publish_event: Record<string, unknown>;
  epoch_commit_event: Record<string, unknown>;
  dispatch_event: Record<string, unknown>;
} {
  return {
    schemaVersion: GPU_HMR_PROOF_LEDGER_SCHEMA_VERSION,
    proof_canonical_profile: GPU_HMR_PROOF_LEDGER_PORTABLE_CANONICAL_PROFILE,
    project_id: "project",
    edit_id: "edit",
    backend: "hip",
    classification: {},
    contract_hash: "contract",
    artifact_before_hash: "before",
    artifact_after_hash: "after",
    loader_event: {},
    epoch_publish_event: {},
    epoch_commit_event: {
      id: "commit",
      safe_integer: Number.MAX_SAFE_INTEGER,
      decimal_fraction: "1.25",
    },
    dispatch_event: {},
    output_event: {},
    retirement_event: {},
    process_identity: {},
    device_identity: {},
    oracle_artifacts: {},
    deterministic_visual_mode: {},
    output_oracle_target: {},
    metric_clock: null,
    metric_scope: null,
    cache_state: null,
    timings: {},
    timing_metrics: {},
    model_provenance: {},
    evidence_refs: [],
    cpu_hmr_used: false,
    full_rebuild_used: false,
    process_restarted: false,
    firewall_evidence: {
      cpu_hmr_used: false,
      full_rebuild_used: false,
      process_restarted: false,
    },
  };
}

function portableStrictFixture(
  previousEpoch = "1",
  candidateEpoch = "2"
): Record<string, unknown> {
  const timings = timingMetrics();
  return {
    schemaVersion: GPU_HMR_PROOF_LEDGER_SCHEMA_VERSION,
    proof_canonical_profile: GPU_HMR_PROOF_LEDGER_PORTABLE_CANONICAL_PROFILE,
    project_id: "arbitrary-project",
    edit_id: "edit-1",
    backend: "hip",
    classification: {
      project_kind: "gpu_project",
      edit_kind: "gpu_artifact_edit",
      route: "gpu_hmr",
    },
    contract_hash: HASH_C,
    artifact_before_hash: HASH_A,
    artifact_after_hash: HASH_B,
    loader_event: {
      id: "loader-1",
      artifact_hash: HASH_B,
      process_id: "pid-1",
      timestamp_monotonic_ns: 10,
    },
    epoch_publish_event: {
      id: "publish-1",
      event: "provisional_install",
      publication_id: "publication-1",
      candidate_registration_id: "registration-1",
      epoch: candidateEpoch,
      previous_epoch: previousEpoch,
      artifact_hash: HASH_B,
      process_id: "pid-1",
      timestamp_monotonic_ns: 20,
    },
    epoch_commit_event: {
      id: "commit-1",
      event: "unrestricted_visibility_commit",
      publication_id: "publication-1",
      candidate_registration_id: "registration-1",
      epoch: candidateEpoch,
      previous_epoch: previousEpoch,
      artifact_hash: HASH_B,
      process_id: "pid-1",
      timestamp_monotonic_ns: 50,
    },
    dispatch_event: {
      id: "dispatch-1",
      publication_id: "publication-1",
      dispatcher_registration_id: "registration-1",
      epoch: candidateEpoch,
      artifact_hash: HASH_B,
      process_id: "pid-1",
      timestamp_monotonic_ns: 30,
    },
    output_event: {
      id: "output-1",
      kind: "buffer_checksum",
      passed: true,
      after_dispatch_id: "dispatch-1",
      output_target_id: "readback-target-1",
      epoch: candidateEpoch,
      artifact_hash: HASH_B,
      process_id: "pid-1",
      timestamp_monotonic_ns: 40,
    },
    retirement_event: {
      id: "retirement-1",
      epoch: previousEpoch,
      artifact_hash: HASH_A,
      status: "retired_after_quiescent",
      retirement_proof: "stream_event_proven",
      process_id: "pid-1",
      timestamp_monotonic_ns: 60,
    },
    process_identity: { process_id: "pid-1" },
    device_identity: { device_uuid: "device-1" },
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
        producer: "gpu_proof_ledger.test",
        timestamp_after_dispatch: 40,
        epoch: candidateEpoch,
      },
    },
    output_oracle_target: {
      kind: "compute",
      target_id: "readback-target-1",
      evidence_refs: ["runtime:readback"],
    },
    metric_clock: "monotonic_ns",
    metric_scope: "hot_delta_1",
    cache_state: "compiler_cache_warm",
    timings,
    timing_metrics: timings,
    model_provenance: {
      split: modelRecord("gemini-3.5-flash", "split"),
      gpu_delta: modelRecord("gemini-3.1-flash-lite", "gpu_delta"),
    },
    evidence_refs: [
      "runtime:loader",
      "runtime:dispatch",
      "runtime:output",
      "runtime:readback",
      "dispatcher-publication:publication-1",
      "dispatcher-registration:registration-1",
    ],
    cpu_hmr_used: false,
    full_rebuild_used: false,
    process_restarted: false,
    firewall_evidence: {
      cpu_hmr_used: false,
      full_rebuild_used: false,
      process_restarted: false,
      process_id_before: "pid-1",
      process_id_after: "pid-1",
    },
  };
}

function rendererNeutralVisualArtifactFixture(): Record<string, unknown> {
  const record = portableStrictFixture();
  record.output_event = {
    id: "output-1",
    kind: "visual_oracle",
    passed: true,
    after_dispatch_id: "dispatch-1",
    output_target_id: "opaque-output-resource-1",
    epoch: "2",
    artifact_hash: HASH_B,
    process_id: "pid-1",
    timestamp_monotonic_ns: 40,
  };
  record.output_oracle_target = {
    kind: "visual",
    target_id: "opaque-output-resource-1",
    evidence_refs: ["runtime:output"],
  };
  record.oracle_artifacts = {
    visual_oracle_artifacts: {
      before_image: "memory://visual-before.png",
      after_image: "memory://visual-after.png",
      diff_image: "memory://visual-diff.png",
      blank_frame_rejection: true,
      same_frame_rejection: true,
      new_epoch_watermark_or_trace: "dispatch-1:2",
      timestamp_after_dispatch: 40,
      perceptual_diff: 0.42,
      changed_pixel_ratio: 0.25,
      visible_pixel_count: 1024,
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
        changed_pixel_ratio_recomputed: 0.25,
        perceptual_diff_recomputed: 0.42,
        visible_pixel_count_recomputed: 1024,
      },
    },
  };
  record.deterministic_visual_mode = {
    output_observation_after_dispatch: true,
    output_observation_ordering_proven: true,
  };
  return record;
}

function normalizedPortableRecordForTransport(): Record<string, unknown> {
  const wire = portableStrictFixture();
  const normalized: Record<string, unknown> = {
    schemaVersion: wire.schemaVersion,
    proofCanonicalProfile: wire.proof_canonical_profile,
    projectId: wire.project_id,
    editId: wire.edit_id,
    backend: wire.backend,
    classification: wire.classification,
    contractHash: wire.contract_hash,
    artifactBeforeHash: wire.artifact_before_hash,
    artifactAfterHash: wire.artifact_after_hash,
    loaderEvent: wire.loader_event,
    epochPublishEvent: wire.epoch_publish_event,
    epochCommitEvent: wire.epoch_commit_event,
    dispatchEvent: wire.dispatch_event,
    outputEvent: wire.output_event,
    retirementEvent: wire.retirement_event,
    processIdentity: wire.process_identity,
    deviceIdentity: wire.device_identity,
    oracleArtifacts: wire.oracle_artifacts,
    deterministicVisualMode: {},
    outputOracleTarget: wire.output_oracle_target,
    metricClock: wire.metric_clock,
    metricScope: wire.metric_scope,
    cacheState: wire.cache_state,
    timings: wire.timings,
    timingMetrics: wire.timing_metrics,
    modelProvenance: wire.model_provenance,
    evidenceRefs: wire.evidence_refs,
    cpuHmrUsed: wire.cpu_hmr_used,
    fullRebuildUsed: wire.full_rebuild_used,
    processRestarted: wire.process_restarted,
    firewallEvidence: wire.firewall_evidence,
  };
  normalized.proofId = queryGpuHmrLedgerInvariants(normalized).proofId;
  return normalized;
}

function failureCodes(record: unknown): string[] {
  return queryGpuHmrLedgerInvariants(record).failedInvariants.map(({ code }) => code);
}

describe("GPU HMR proof ledger canonical profiles", () => {
  it("matches the portable Rust/MJS golden proof id", () => {
    expect(queryGpuHmrLedgerInvariants(portableCanonicalFixture()).proofId).toBe(
      "gpu-ledger-proof:sha256:6b7c1a2fe57042594e099b136b20ddb54fc529b9e55638bde4d089fc689f4f4e"
    );
  });

  it("rejects conflicting event aliases", () => {
    const record = portableCanonicalFixture();
    Object.assign(record, {
      epoch_publish_event: { id: "publish-a" },
      epochPublishEvent: { id: "publish-b" },
      dispatch_event: { id: "dispatch-a" },
      dispatchEvent: { id: "dispatch-b" },
    });
    expect(failureCodes(record)).toEqual(expect.arrayContaining([
      "epoch_publish_event_alias_mismatch",
      "dispatch_event_alias_mismatch",
    ]));

    const camelOnly = portableStrictFixture();
    camelOnly.epochPublishEvent = camelOnly.epoch_publish_event;
    delete (camelOnly as { epoch_publish_event?: unknown }).epoch_publish_event;
    const camelOnlyResult = queryGpuHmrLedgerInvariants(camelOnly);
    expect(camelOnlyResult.gpuHmrSuccess, camelOnlyResult.failedInvariants).toBe(true);
  });

  it("rejects nested identifier alias conflicts", () => {
    const record = portableCanonicalFixture();
    record.epoch_publish_event = {
      event: "provisional_install",
      publication_id: "publication-a",
      publicationId: "publication-b",
      epoch: "2",
      previous_epoch: "1",
    };
    expect(failureCodes(record)).toContain("epoch_publish_event_field_alias_mismatch");

    const artifactAlias = portableCanonicalFixture();
    artifactAlias.epoch_publish_event = {
      event: "provisional_install",
      artifact_hash: "artifact-a",
      publishedArtifactId: "artifact-b",
    };
    expect(failureCodes(artifactAlias)).toContain("epoch_publish_event_field_alias_mismatch");

    const outputAlias = portableCanonicalFixture();
    outputAlias.output_event = {
      id: "output",
      after_dispatch_id: "dispatch-a",
      afterDispatchId: "dispatch-b",
    };
    expect(failureCodes(outputAlias)).toContain("output_event_field_alias_mismatch");
  });

  it("rejects publication without a generation transition", () => {
    const record = portableCanonicalFixture();
    record.epoch_publish_event = {
      event: "provisional_install",
      epoch: "2",
      previous_epoch: "2",
    };
    expect(failureCodes(record)).toContain("epoch_generation_transition_not_forward");
  });

  it("rejects non-portable numeric values", () => {
    const unsafeInteger = portableCanonicalFixture();
    unsafeInteger.epoch_commit_event.unsafe_integer = Number.MAX_SAFE_INTEGER + 1;
    expect(failureCodes(unsafeInteger)).toContain("portable_canonical_number_unsupported");

    const float = portableCanonicalFixture();
    float.epoch_commit_event.decimal_fraction = 1.25;
    expect(failureCodes(float)).toContain("portable_canonical_number_unsupported");

    const ignoredUnsafeInteger = portableCanonicalFixture();
    ignoredUnsafeInteger.ignored_unsafe_integer = Number.MAX_SAFE_INTEGER + 1;
    expect(failureCodes(ignoredUnsafeInteger)).toContain("portable_canonical_number_unsupported");
  });

  it("rejects imprecise timestamp and proof-id aliases", () => {
    const impreciseTimestamp = portableCanonicalFixture();
    impreciseTimestamp.epoch_publish_event = {
      event: "provisional_install",
      epoch: "2",
      previous_epoch: "1",
      timestamp_monotonic_ns: "9007199254740993",
    };
    expect(failureCodes(impreciseTimestamp)).toContain("portable_event_timestamp_invalid");

    const proofIdAliases = portableCanonicalFixture();
    proofIdAliases.proof_id = `gpu-ledger-proof:sha256:${"1".repeat(64)}`;
    proofIdAliases.proofId = `gpu-ledger-proof:sha256:${"2".repeat(64)}`;
    expect(failureCodes(proofIdAliases)).toContain("record_proof_id_alias_mismatch");
  });

  it("accepts strict canonical wire records and skipped candidate generations", () => {
    const ordinary = queryGpuHmrLedgerInvariants(portableStrictFixture());
    expect(ordinary.gpuHmrSuccess, ordinary.failedInvariants).toBe(true);

    const skipped = queryGpuHmrLedgerInvariants(portableStrictFixture("1", "4"));
    expect(skipped.gpuHmrSuccess, skipped.failedInvariants).toBe(true);
  });

  it("uses observed output mechanics instead of a closed backend allowlist", () => {
    const record = portableStrictFixture();
    record.backend = "future.vendor/runtime@v99";

    const result = queryGpuHmrLedgerInvariants(record);

    expect(result.gpuHmrSuccess, result.failedInvariants).toBe(true);
    expect(result.failedInvariants.map(({ code }) => code)).not.toContain("backend_unsupported");
  });

  it("does not require renderer-specific visual artifact metadata", () => {
    const record = rendererNeutralVisualArtifactFixture();
    const typedResult = queryGpuHmrLedgerInvariants(record);
    const typedFailureCodes = typedResult.failedInvariants.map(({ code }) => code);
    const scriptCompatibilityResult = evaluateScriptGpuHmrProofLedger(record);
    const scriptCompatibilityFailureCodes = scriptCompatibilityResult.failedInvariants.map(
      ({ code }: { code: string }) => code
    );

    expect(typedFailureCodes).not.toEqual(expect.arrayContaining([
      "visual_oracle_artifacts_incomplete",
      "visual_swapchain_size_invalid",
    ]));
    expect(typedFailureCodes).toContain(
      "verifier_owned_visual_output_state_receipt_missing"
    );
    expect(scriptCompatibilityFailureCodes).toEqual(typedFailureCodes);

    const scriptResult = evaluateScriptGpuHmrProofLedger(record, {
      requireVerifierOwnedVisualOutputState: true,
    });
    const scriptFailureCodes = scriptResult.failedInvariants.map(
      ({ code }: { code: string }) => code
    );

    expect(scriptResult.gpuHmrSuccess).toBe(false);
    expect(scriptFailureCodes).toContain("verifier_owned_visual_output_state_receipt_missing");
    expect(scriptFailureCodes).not.toEqual(expect.arrayContaining([
      "visual_oracle_artifacts_incomplete",
      "visual_camera_state_hash_invalid",
      "visual_swapchain_size_invalid",
    ]));

    const malformedLegacyMetadata = rendererNeutralVisualArtifactFixture();
    const malformedArtifacts = (
      malformedLegacyMetadata.oracle_artifacts as Record<string, Record<string, unknown>>
    ).visual_oracle_artifacts;
    malformedArtifacts.camera_state_hash = "caller-text-is-not-a-content-hash";
    malformedArtifacts.swapchain_size = [640, 0];

    const typedMalformedCodes = failureCodes(malformedLegacyMetadata);
    const scriptMalformedCodes = evaluateScriptGpuHmrProofLedger(
      malformedLegacyMetadata
    ).failedInvariants.map(({ code }: { code: string }) => code);
    for (const rendererMetadataCode of [
      "visual_camera_state_hash_invalid",
      "visual_swapchain_size_invalid",
    ]) {
      expect(typedMalformedCodes).not.toContain(rendererMetadataCode);
      expect(scriptMalformedCodes).not.toContain(rendererMetadataCode);
    }
    expect(typedMalformedCodes).toContain(
      "verifier_owned_visual_output_state_receipt_missing"
    );
    expect(scriptMalformedCodes).toEqual(typedMalformedCodes);
  });

  it("does not accept serialized visual output-state receipt claims", () => {
    const record = rendererNeutralVisualArtifactFixture();
    record.verifier_owned_visual_output_state_receipt = {
      accepted: true,
      proof_authority: "caller_serialized_claim",
    };

    expect(failureCodes(record)).toContain(
      "verifier_owned_visual_output_state_receipt_missing"
    );
    expect(
      evaluateScriptGpuHmrProofLedger(record, {
        verifierOwnedVisualOutputStateReceipt: {
          accepted: true,
          proofAuthority: "caller_option_claim",
        },
      }).failedInvariants.map(({ code }: { code: string }) => code)
    ).toContain("verifier_owned_visual_output_state_receipt_missing");
  });

  it("keeps script and typed convergence diagnostics fail-closed", () => {
    const record = rendererNeutralVisualArtifactFixture();
    record.deterministic_visual_mode = {
      output_observation_after_dispatch: true,
      output_observation_ordering_proven: true,
      convergence_window: {
        sample_start: 1,
        sample_end: 2,
        sample_count: 2,
        metric: { value: "open-domain-metric@v1" },
        metric_delta: 1,
        convergence_proven: true,
        evidence_refs: ["diagnostic:count-only"],
      },
    };

    const typedCodes = failureCodes(record);
    const scriptCodes = evaluateScriptGpuHmrProofLedger(record).failedInvariants.map(
      ({ code }: { code: string }) => code
    );

    expect(scriptCodes).toEqual(typedCodes);
    expect(typedCodes).toEqual(expect.arrayContaining([
      "convergence_sample_evidence_missing",
      "convergence_sample_count_mismatch",
      "convergence_post_dispatch_sample_evidence_missing",
      "verifier_owned_visual_output_state_receipt_missing",
    ]));
  });

  it("rejects contradictory generic observation aliases", () => {
    const record = rendererNeutralVisualArtifactFixture();
    record.deterministic_visual_mode = {
      output_observation_after_dispatch: true,
      output_capture_after_dispatch: false,
      output_observation_ordering_proven: true,
    };

    const typedCodes = failureCodes(record);
    const scriptCodes = evaluateScriptGpuHmrProofLedger(record).failedInvariants.map(
      ({ code }: { code: string }) => code
    );

    expect(scriptCodes).toEqual(typedCodes);
    expect(typedCodes).toEqual(expect.arrayContaining([
      "output_observation_alias_conflict",
      "output_observation_after_dispatch_unproven",
    ]));
  });

  it("does not promote renderer controls into generic output observations", () => {
    const genericRecord = rendererNeutralVisualArtifactFixture();
    genericRecord.deterministic_visual_mode = {
      output_observation_after_dispatch: true,
      output_observation_ordering_proven: true,
      frame_capture_after_epoch_dispatch: false,
      presentation_fence_or_frame_boundary: false,
    };
    const genericTypedCodes = failureCodes(genericRecord);
    const genericScriptCodes = evaluateScriptGpuHmrProofLedger(
      genericRecord
    ).failedInvariants.map(({ code }: { code: string }) => code);
    expect(genericTypedCodes).not.toEqual(expect.arrayContaining([
      "output_observation_alias_conflict",
      "output_observation_after_dispatch_unproven",
      "output_observation_ordering_unproven",
    ]));
    expect(genericScriptCodes).toEqual(genericTypedCodes);

    const legacyOnlyRecord = rendererNeutralVisualArtifactFixture();
    legacyOnlyRecord.deterministic_visual_mode = {
      frame_capture_after_epoch_dispatch: true,
      presentation_fence_or_frame_boundary: true,
    };
    const legacyTypedCodes = failureCodes(legacyOnlyRecord);
    const legacyScriptCodes = evaluateScriptGpuHmrProofLedger(
      legacyOnlyRecord
    ).failedInvariants.map(({ code }: { code: string }) => code);
    expect(legacyTypedCodes).toEqual(expect.arrayContaining([
      "output_observation_after_dispatch_unproven",
      "output_observation_ordering_unproven",
    ]));
    expect(legacyScriptCodes).toEqual(legacyTypedCodes);
  });

  it("keeps generic convergence diagnostics in script and typed parity", () => {
    const sampleA = "sha256:1111111111111111111111111111111111111111111111111111111111111111";
    const sampleB = "sha256:2222222222222222222222222222222222222222222222222222222222222222";
    const common = {
      sample_start: 1,
      sample_end: 2,
      sample_count: 2,
      metric: { value: "open-domain-metric@v1" },
      convergence_proven: true,
      evidence_refs: ["diagnostic:convergence"],
    };
    const cases = [
      {
        name: "invalid hash",
        window: {
          ...common,
          post_dispatch_sample_hashes: ["not-a-digest", sampleB],
          metric_delta: 1,
        },
        expected: ["convergence_sample_hash_invalid"],
      },
      {
        name: "duplicate hash",
        window: {
          ...common,
          post_dispatch_sample_hashes: [sampleA, sampleA],
          metric_delta: 1,
        },
        expected: ["convergence_sample_hash_duplicate"],
      },
      {
        name: "pre-dispatch sample",
        window: {
          ...common,
          samples: [
            { sample_hash: sampleA, metric_value: 1, after_dispatch: false },
            { sample_hash: sampleB, metric_value: 2, after_dispatch: true },
          ],
        },
        expected: [
          "convergence_sample_ordering_unproven",
          "convergence_post_dispatch_sample_evidence_missing",
        ],
      },
      {
        name: "legacy sample aliases",
        window: {
          ...common,
          samples: [
            { source_frame_hash: sampleA, value: 1, after_epoch_dispatch: true },
            { source_frame_hash: sampleB, value: 2, after_epoch_dispatch: true },
          ],
        },
        expected: [],
      },
    ];

    for (const scenario of cases) {
      const record = rendererNeutralVisualArtifactFixture();
      record.deterministic_visual_mode = {
        output_observation_after_dispatch: true,
        output_observation_ordering_proven: true,
        convergence_window: scenario.window,
      };
      const typedCodes = failureCodes(record);
      const scriptCodes = evaluateScriptGpuHmrProofLedger(record).failedInvariants.map(
        ({ code }: { code: string }) => code
      );

      expect(scriptCodes, scenario.name).toEqual(typedCodes);
      expect(typedCodes, scenario.name).toEqual(expect.arrayContaining(scenario.expected));
      if (scenario.expected.length === 0) {
        expect(typedCodes.filter((code) => code.startsWith("convergence_")), scenario.name)
          .toEqual([]);
      }
    }

    const extensionOnly = rendererNeutralVisualArtifactFixture();
    extensionOnly.deterministic_visual_mode = {
      output_observation_after_dispatch: true,
      output_observation_ordering_proven: true,
      convergence_window: {
        future_vendor_extension: { revision: 7 },
      },
    };
    const typedExtensionCodes = failureCodes(extensionOnly);
    const scriptExtensionCodes = evaluateScriptGpuHmrProofLedger(
      extensionOnly
    ).failedInvariants.map(({ code }: { code: string }) => code);

    expect(scriptExtensionCodes).toEqual(typedExtensionCodes);
    expect(typedExtensionCodes.filter((code) => code.startsWith("convergence_"))).toEqual([]);
  });

  it("rejects output-target relabeling, stale bindings, and unresolved evidence", () => {
    const visualDowngrade = portableStrictFixture();
    visualDowngrade.output_oracle_target = {
      kind: "visual",
      target_id: "readback-target-1",
      evidence_refs: ["runtime:readback"],
    };
    expect(failureCodes(visualDowngrade)).toEqual(expect.arrayContaining([
      "visual_output_target_requires_visual_oracle",
    ]));

    const staleTarget = portableStrictFixture();
    (staleTarget.output_event as Record<string, unknown>).output_target_id = "stale-target";
    expect(failureCodes(staleTarget)).toContain("output_oracle_target_id_mismatch");

    const unresolvedEvidence = portableStrictFixture();
    (unresolvedEvidence.output_oracle_target as Record<string, unknown>).evidence_refs = [
      "runtime:unresolved-target",
    ];
    expect(failureCodes(unresolvedEvidence)).toContain(
      "output_oracle_target_evidence_refs_unresolved"
    );

    const conflictingDeclaration = portableStrictFixture();
    (conflictingDeclaration.output_event as Record<string, unknown>).output_oracle_target = {
      kind: "visual",
      target_id: "readback-target-1",
      evidence_refs: ["runtime:readback"],
    };
    expect(failureCodes(conflictingDeclaration)).toContain(
      "output_oracle_target_declaration_mismatch"
    );

    const conflictingEventTarget = portableStrictFixture();
    (conflictingEventTarget.output_event as Record<string, unknown>).outputTarget = {
      id: "different-target",
    };
    expect(failureCodes(conflictingEventTarget)).toContain(
      "output_event_field_alias_mismatch"
    );

    const internallyConflictingEventTarget = portableStrictFixture();
    (internallyConflictingEventTarget.output_event as Record<string, unknown>).output_target = {
      id: "readback-target-1",
      target_id: "different-target",
    };
    expect(failureCodes(internallyConflictingEventTarget)).toContain(
      "output_event_field_alias_mismatch"
    );

    const internallyConflictingTarget = portableStrictFixture();
    internallyConflictingTarget.output_oracle_target = {
      kind: "compute",
      target_kind: "visual",
      id: "readback-target-1",
      target_id: "different-target",
      evidence_refs: ["runtime:readback"],
    };
    expect(failureCodes(internallyConflictingTarget)).toContain(
      "output_oracle_target_declaration_mismatch"
    );

    const conflictingEvidenceRefs = portableStrictFixture();
    conflictingEvidenceRefs.outputOracleTarget = {
      kind: "compute",
      target_id: "readback-target-1",
      evidence_refs: ["runtime:other-readback"],
    };
    expect(failureCodes(conflictingEvidenceRefs)).toContain(
      "output_oracle_target_declaration_mismatch"
    );

    const arbitraryOracle = portableStrictFixture();
    (arbitraryOracle.output_event as Record<string, unknown>).kind = "vendor_special_output";
    const arbitraryResult = queryGpuHmrLedgerInvariants(arbitraryOracle);
    expect(arbitraryResult.gpuHmrSuccess, arbitraryResult.failedInvariants).toBe(true);

    const unknownVerifier = portableStrictFixture();
    (unknownVerifier.output_oracle_target as Record<string, unknown>).kind = "opaque-output";
    expect(failureCodes(unknownVerifier)).toContain("output_oracle_target_verifier_missing");
  });

  it("rejects noncanonical or non-forward commit-era generations", () => {
    const leadingZero = queryGpuHmrLedgerInvariants(portableStrictFixture("1", "01"));
    expect(leadingZero.failedInvariants.map(({ code }) => code)).toContain(
      "epoch_generation_not_canonical_decimal"
    );

    const equal = queryGpuHmrLedgerInvariants(portableStrictFixture("7", "7"));
    expect(equal.failedInvariants.map(({ code }) => code)).toContain(
      "epoch_generation_transition_not_forward"
    );

    const signed = queryGpuHmrLedgerInvariants(portableStrictFixture("+1", "2"));
    expect(signed.failedInvariants.map(({ code }) => code)).toContain(
      "epoch_generation_not_canonical_decimal"
    );
  });

  it("validates exact record, ledger, and query schemas through aliases", () => {
    const missingRecord = portableStrictFixture();
    delete missingRecord.schemaVersion;
    expect(failureCodes(missingRecord)).toContain("record_schema_version_missing");

    const invalidRecord = portableStrictFixture();
    invalidRecord.schemaVersion = "synthi.gpu.hmr.proof_ledger.v0";
    expect(failureCodes(invalidRecord)).toContain("record_schema_version_mismatch");

    const conflictingRecord = portableStrictFixture();
    conflictingRecord.schema_version = "synthi.gpu.hmr.proof_ledger.v0";
    expect(failureCodes(conflictingRecord)).toContain("record_schema_alias_mismatch");

    const matchingRecord = portableStrictFixture();
    matchingRecord.schema_version = GPU_HMR_PROOF_LEDGER_SCHEMA_VERSION;
    const matchingRecordResult = queryGpuHmrLedgerInvariants(matchingRecord);
    expect(matchingRecordResult.gpuHmrSuccess, matchingRecordResult.failedInvariants).toBe(true);

    const record = portableStrictFixture();
    const recordProofId = queryGpuHmrLedgerInvariants(record).proofId;
    const ledger = {
      schemaVersion: GPU_HMR_PROOF_LEDGER_SCHEMA_VERSION,
      schema_version: "synthi.gpu.hmr.proof_ledger.v0",
      proofId: recordProofId,
      records: [record],
      gpuHmrSuccess: true,
      query: {
        schemaVersion: GPU_HMR_PROOF_LEDGER_SCHEMA_VERSION,
        schema_version: "synthi.gpu.hmr.proof_ledger.v0",
        proofId: recordProofId,
        gpuHmrSuccess: true,
        failedInvariants: [],
      },
    };
    expect(failureCodes(ledger)).toEqual(expect.arrayContaining([
      "ledger_schema_alias_mismatch",
      "supplied_ledger_query_schema_alias_mismatch",
    ]));

    const invalidLedger = {
      schemaVersion: "synthi.gpu.hmr.proof_ledger.v0",
      records: [portableStrictFixture()],
    };
    expect(failureCodes(invalidLedger)).toContain("ledger_schema_version_mismatch");

    const missingLedger = { records: [portableStrictFixture()] };
    expect(failureCodes(missingLedger)).toContain("ledger_schema_version_missing");
  });

  it("rejects semantic top-level, event-kind, and success alias conflicts", () => {
    const record = portableStrictFixture();
    record.gpu_backend = "opencl";
    record.changed_gpu_artifact_hash = HASH_A;
    (record.epoch_publish_event as Record<string, unknown>).kind = "committed";
    (record.output_event as Record<string, unknown>).success = false;
    expect(failureCodes(record)).toEqual(expect.arrayContaining([
      "backend_alias_mismatch",
      "artifact_after_hash_alias_mismatch",
      "epoch_publish_event_field_alias_mismatch",
      "output_event_field_alias_mismatch",
    ]));

    const nestedSuccess = portableStrictFixture();
    (nestedSuccess.output_event as Record<string, unknown>).output_oracle = { passed: false };
    expect(failureCodes(nestedSuccess)).toContain("output_event_success_contradiction");

    const ledger = {
      schemaVersion: GPU_HMR_PROOF_LEDGER_SCHEMA_VERSION,
      records: [portableStrictFixture()],
      gpuHmrSuccess: true,
      gpu_hmr_success: false,
    };
    expect(failureCodes(ledger)).toContain("ledger_success_flag_alias_mismatch");
  });

  it("rejects top-level and nested firewall contradictions", () => {
    const topVsNested = portableStrictFixture();
    (topVsNested.firewall_evidence as Record<string, unknown>).cpu_hmr_used = true;
    expect(failureCodes(topVsNested)).toContain("firewall_cpu_hmr_used_contradiction");

    const nestedAliases = portableStrictFixture();
    (nestedAliases.firewall_evidence as Record<string, unknown>).process_restarted = false;
    (nestedAliases.firewall_evidence as Record<string, unknown>).processRestarted = true;
    expect(failureCodes(nestedAliases)).toContain("firewall_process_restarted_alias_mismatch");

    const invalidType = portableStrictFixture();
    invalidType.full_rebuild_used = "false";
    expect(failureCodes(invalidType)).toContain("full_rebuild_firewall_evidence_invalid");
  });

  it("uses only the top-level metric clock for portable canonicalization", () => {
    const nestedFallback = portableStrictFixture();
    delete nestedFallback.metric_clock;
    expect(failureCodes(nestedFallback)).toContain("metric_clock_missing");

    const contradiction = portableStrictFixture();
    contradiction.metric_clock = "wall_clock";
    expect(failureCodes(contradiction)).toEqual(expect.arrayContaining([
      "metric_clock_nested_contradiction",
      "metric_clock_not_monotonic_ns",
    ]));
  });

  it("binds retirement to the previous artifact and a recognized success", () => {
    const staleArtifact = portableStrictFixture();
    (staleArtifact.retirement_event as Record<string, unknown>).artifact_hash = HASH_B;
    expect(failureCodes(staleArtifact)).toContain("retirement_artifact_hash_mismatch");

    const failedRetirement = portableStrictFixture();
    Object.assign(failedRetirement.retirement_event as Record<string, unknown>, {
      status: "retirement_failed",
      retirement_proof: "unproven",
    });
    expect(failureCodes(failedRetirement)).toEqual(expect.arrayContaining([
      "retirement_result_not_successful",
      "retirement_proof_not_successful",
    ]));
  });

  it("rejects duplicate record proof ids", () => {
    const duplicate = portableStrictFixture();
    const ledger = {
      schemaVersion: GPU_HMR_PROOF_LEDGER_SCHEMA_VERSION,
      records: [duplicate, structuredClone(duplicate)],
    };
    expect(failureCodes(ledger)).toContain("ledger_record_proof_ids_duplicate");
  });

  it("validates normalized built ledgers before and after JSON transport", () => {
    const normalized = normalizedPortableRecordForTransport();
    const recordQuery = queryGpuHmrLedgerInvariants(normalized);
    expect(recordQuery.gpuHmrSuccess, recordQuery.failedInvariants).toBe(true);
    const ledger = {
      schemaVersion: GPU_HMR_PROOF_LEDGER_SCHEMA_VERSION,
      proofId: recordQuery.proofId,
      records: [normalized],
      gpuHmrSuccess: true,
      gpu_hmr_success: true,
      query: {
        schemaVersion: GPU_HMR_PROOF_LEDGER_SCHEMA_VERSION,
        proofId: recordQuery.proofId,
        gpuHmrSuccess: true,
        failedInvariants: [],
      },
    };
    const before = queryGpuHmrLedgerInvariants(ledger);
    const after = queryGpuHmrLedgerInvariants(JSON.parse(JSON.stringify(ledger)));
    expect(before.gpuHmrSuccess, before.failedInvariants).toBe(true);
    expect(after).toEqual(before);
  });

  it("recomputes transport safety without trusting public metadata fields", () => {
    const normalized = normalizedPortableRecordForTransport();
    Object.assign(normalized, {
      epochPublishEventAliasMismatch: true,
      epochCommitEventAliasMismatch: true,
      dispatchEventAliasMismatch: true,
      proofCanonicalProfileAliasMismatch: true,
      portableCanonicalAliasMismatch: true,
      portableCanonicalNumbersSupported: false,
      portableCanonicalSourceShapeSupported: false,
    });
    const accepted = queryGpuHmrLedgerInvariants(normalized);
    expect(accepted.gpuHmrSuccess, accepted.failedInvariants).toBe(true);

    const forged = normalizedPortableRecordForTransport();
    forged.gpu_backend = "opencl";
    forged.portableCanonicalAliasMismatch = false;
    expect(failureCodes(forged)).toContain("backend_alias_mismatch");
  });

  it("preserves the legacy canonical proof id", () => {
    const legacy = portableCanonicalFixture();
    delete legacy.proof_canonical_profile;
    delete (legacy as { epoch_commit_event?: unknown }).epoch_commit_event;
    expect(queryGpuHmrLedgerInvariants(legacy).proofId).toBe(
      "gpu-ledger-proof:sha256:ec39ae02d6be29b5ca7991acffa3643cb0e1ef98b960aef3dacd628e1a15e92c"
    );
  });
});
