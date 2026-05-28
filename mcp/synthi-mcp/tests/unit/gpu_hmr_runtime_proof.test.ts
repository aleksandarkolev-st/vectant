import { describe, expect, it } from "vitest";
import {
  classifyGpuHmrAbiProof,
  classifyGpuHmrDispatchProof,
  classifyGpuHmrEpochSwapProof,
  classifyGpuHmrFissionProof,
  classifyGpuHmrFullRuntimeProof,
  classifyGpuHmrHostPreservationProof,
  classifyGpuHmrOriginalHostPathProof,
  classifyGpuHmrOutputProof,
  summarizeGpuHmrAbiProof,
  summarizeGpuHmrDispatchProof,
  summarizeGpuHmrEpochSwapProof,
  summarizeGpuHmrFissionProof,
  summarizeGpuHmrFullRuntimeProof,
  summarizeGpuHmrHostPreservationProof,
  summarizeGpuHmrOriginalHostPathProof,
  summarizeGpuHmrOutputProof,
} from "../../scripts/lib/gpu-hmr-runtime-proof.mjs";
import {
  abiProofFromProofArtifacts,
  artifactTransportProofFromProofArtifacts,
  fissionProofFromProofArtifacts,
  summarizeGpuHmrArtifactTransportProof,
} from "../../scripts/lib/gpu-hmr-proof-artifacts.mjs";
import {
  epochSwapProofFromRuntimeEvidence,
  hostPreservationProofFromRuntimeEvidence,
  originalHostPathProofFromRuntimeEvidence,
  runtimeArtifactTransportEvidence,
  runtimeHostIdentityEvidence,
  runtimeOriginalHostPathEvidence,
  runtimeOutputOracleEvidence,
} from "../../scripts/lib/gpu-hmr-runtime-evidence.mjs";
import {
  dockerSnapshotFromInspect,
  validationCommandMetadata,
} from "../../scripts/lib/docker-validation-metadata.mjs";
import {
  buildValidationRuntimeProofArtifact,
} from "../../scripts/lib/gpu-hmr-validation-proof-artifact.mjs";

function acceptedAbiProof() {
  return classifyGpuHmrAbiProof({
    metadataObserved: true,
    layoutSizeAlignmentVerified: true,
    extractorProvenance: [{
      kind: "clang_ast",
      evidenceId: "evidence:clang-ast:abc",
      extractorName: "test_clang_ast",
      extractorVersion: "v1",
      inputHash: "sha256:abc",
    }],
  });
}

function epochGenerationGraph({
  previousGeneration = 2,
  activeGeneration = 3,
  runtimeSession = "runtime-session:test",
  retirementState = "retired",
} = {}) {
  const runtimeSessionFields = runtimeSession ? { runtimeSession } : {};
  return {
    schemaVersion: "synthi.gpu.epoch_graph.v1",
    runtimeSessionIds: runtimeSession ? [runtimeSession] : [],
    latestPublication: { previousGeneration, activeGeneration },
    retirementState,
    retirementRequired: retirementState !== "not-required",
    matchingRetirementObserved: retirementState === "retired",
    nodes: [
      {
        id: `generation:${previousGeneration}`,
        generation: previousGeneration,
        state: retirementState === "retired" ? "retired" : "pending-retirement",
      },
      {
        id: `generation:${activeGeneration}`,
        generation: activeGeneration,
        state: "published",
      },
    ],
    edges: [
      {
        kind: "publish",
        from: `generation:${previousGeneration}`,
        to: `generation:${activeGeneration}`,
        previousGeneration,
        activeGeneration,
        ...runtimeSessionFields,
      },
      ...(retirementState === "retired"
        ? [{
            kind: "retire",
            from: `generation:${previousGeneration}`,
            to: `generation:${activeGeneration}`,
            previousGeneration,
            activeGeneration,
            ...runtimeSessionFields,
          }]
        : []),
    ],
  };
}

function retiredEpochProof() {
  return classifyGpuHmrEpochSwapProof({
    published: true,
    runtimeSessionIds: ["runtime-session:test"],
    epochGenerationGraph: epochGenerationGraph(),
    dispatchTableHashObserved: true,
    dispatchTableHashBeforeObserved: true,
    dispatchTableHashAfterObserved: true,
    dispatchTableHashChanged: true,
    changedEntriesObserved: true,
    streamOrderingProven: true,
    streamScope: "affected",
    streamIds: ["default"],
    retirementTracked: true,
    oldGenerationRetired: true,
    evidenceRefs: ["evidence:epoch:abc"],
  });
}

function safeDispatchProof() {
  return classifyGpuHmrDispatchProof({
    dispatchObserved: true,
    sessionScoped: true,
    runtimeSessionIds: ["runtime-session:test"],
    argProvenanceObserved: true,
    argProvenanceComplete: true,
    argProvenanceEvidenceRefs: [
      "worker-log:launch_arg_provenance:test:runtime-session.test:2",
    ],
    abiProof: acceptedAbiProof(),
    epochProof: retiredEpochProof(),
    streamOrderingProven: true,
    replacementScopeProven: true,
  });
}

function deterministicOutputOracle() {
  return {
    kind: "sentinel_buffer_value",
    producer: "deterministic_probe",
    expected: "expected-sentinel",
    actual: "expected-sentinel",
    outputTargetId: "output:sentinel",
    readbackTimestamp: "1779980000000",
    artifactId: "artifact:sentinel",
    evidenceRefs: ["evidence:readback:abc"],
  };
}

function preservedHostProof() {
  return classifyGpuHmrHostPreservationProof({
    identityChecksPassed: true,
    identitySnapshotObserved: true,
    identitySnapshotLineageObserved: true,
    requiredIdentityRolesObserved: true,
    identityEvidenceRefs: [
      "worker-log:host_identity:runner_process",
      "worker-log:host_identity:core_state",
      "worker-log:host_identity:stream",
    ],
  });
}

function attachedOriginalHostPathProof() {
  return classifyGpuHmrOriginalHostPathProof({
    required: true,
    attachedToOriginalHostPath: true,
    runtimeEvidenceObserved: true,
    dispatchBoundaryObserved: true,
    sessionScoped: true,
    runtimeSessionIds: ["runtime-session:test"],
    evidenceRefs: ["worker-log:original_host_path:host-path:3"],
  });
}

function acceptedFissionProof() {
  return classifyGpuHmrFissionProof({
    required: true,
    observed: true,
    passed: true,
    evidenceRefs: ["evidence:fission-verifier-report:abc"],
  });
}

function acceptedArtifactTransportProof() {
  return {
    schemaVersion: "synthi.gpu.hmr.artifact_transport_proof.v1",
    transportEvidenceObserved: true,
    ramTransportProven: true,
    ramArtifactReferenceProvided: true,
    loaderTransports: ["ram_bytes"],
    reloadRequestTransports: ["ram_blob"],
    evidenceRefs: ["worker-log:artifact_transport:sha256:abc"],
    degradedState: null,
    degradedReason: null,
  };
}

describe("validation runtime metadata", () => {
  it("normalizes docker inspect identity and compose state", () => {
    const snapshot = dockerSnapshotFromInspect(
      JSON.stringify([
        {
          Id: "container-id",
          Name: "/project-worker-1",
          Image: "sha256:image-id",
          Config: {
            Image: "project-worker:latest",
            Labels: {
              "com.docker.compose.project": "project",
              "com.docker.compose.service": "worker",
              "com.docker.compose.container-number": "1",
            },
          },
          State: {
            Status: "running",
            Pid: 123,
            StartedAt: "2026-05-27T10:00:00Z",
            FinishedAt: "0001-01-01T00:00:00Z",
            OOMKilled: false,
            ExitCode: 0,
          },
          RestartCount: 2,
        },
      ]),
      "worker-container"
    );

    expect(snapshot.available).toBe(true);
    expect(snapshot.name).toBe("project-worker-1");
    expect(snapshot.image_id).toBe("sha256:image-id");
    expect(snapshot.config_image).toBe("project-worker:latest");
    expect(snapshot.compose_project).toBe("project");
    expect(snapshot.compose_service).toBe("worker");
    expect(snapshot.status).toBe("running");
    expect(snapshot.restart_count).toBe(2);
  });

  it("records only requested validation command env keys", () => {
    const metadata = validationCommandMetadata({
      cwd: "/repo",
      argv: ["node", "script.mjs"],
      env: {
        SYNTHI_GPU_VENDOR: "rocm",
        SECRET_TOKEN: "hidden",
      },
      envKeys: ["SYNTHI_GPU_VENDOR", "SYNTHI_GPU_ARCH"],
    });

    expect(metadata.cwd).toBe("/repo");
    expect(metadata.argv).toEqual(["node", "script.mjs"]);
    expect(metadata.env).toEqual({
      SYNTHI_GPU_VENDOR: "rocm",
      SYNTHI_GPU_ARCH: "",
    });
    expect(Object.prototype.hasOwnProperty.call(metadata.env, "SECRET_TOKEN")).toBe(false);
  });
});

describe("GPU HMR runtime output proof classification", () => {
  it("requires dispatch before output proof can be considered", () => {
    const proof = classifyGpuHmrOutputProof({
      dispatchObserved: false,
      visualFrameObserved: true,
    });

    expect(proof.resultState).toBeNull();
    expect(proof.degradedState).toBe("gpu-hmr-dispatch-unobserved");
  });

  it("reports visual-only when a frame exists without a deterministic oracle", () => {
    const proof = classifyGpuHmrOutputProof({
      dispatchProof: safeDispatchProof(),
      visualFrameObserved: true,
    });

    expect(proof.resultState).toBe("gpu-hmr-dispatch-safe-proven");
    expect(proof.degradedState).toBe("gpu-hmr-visual-only");
    expect(summarizeGpuHmrOutputProof(proof)).toContain("gpu-hmr-visual-only");
  });

  it("reports output-unobserved when dispatch has no output evidence", () => {
    const proof = classifyGpuHmrOutputProof({
      dispatchProof: safeDispatchProof(),
      visualFrameObserved: false,
    });

    expect(proof.resultState).toBe("gpu-hmr-dispatch-safe-proven");
    expect(proof.degradedState).toBe("gpu-hmr-output-unobserved");
  });

  it("reports output-proven only for a passing deterministic oracle", () => {
    const proof = classifyGpuHmrOutputProof({
      dispatchProof: safeDispatchProof(),
      deterministicOutputObserved: true,
      deterministicOracleProvided: true,
      deterministicOraclePassed: true,
      outputOracle: deterministicOutputOracle(),
      visualFrameObserved: true,
    });

    expect(proof.resultState).toBe("gpu-hmr-output-oracle-proven");
    expect(proof.degradedState).toBeNull();
    expect(proof.outputOracle.passed).toBe(true);
    expect(proof.outputOracle.kind).toBe("sentinel_buffer_value");
  });

  it("can prove output from a structured runtime oracle line", () => {
    const evidence = runtimeOutputOracleEvidence([
      "[gpu-runtime-boundary] output_oracle id=probe.checksum kind=buffer_checksum producer=runtime_probe expected=sha256:abc actual=sha256:abc passed=true generation=3 runtime_session=pid1 output_target_id=target:main readback_timestamp=1779980000000 artifact_id=artifact:abc",
    ]);
    const proof = classifyGpuHmrOutputProof({
      dispatchProof: safeDispatchProof(),
      deterministicOutputObserved: evidence.deterministic_output_observed,
      deterministicOracleProvided: evidence.deterministic_oracle_provided,
      deterministicOraclePassed: evidence.deterministic_oracle_passed,
      outputOracle: evidence.output_oracle,
      evidenceRefs: evidence.evidence_refs,
    });

    expect(evidence.total_count).toBe(1);
    expect(evidence.output_oracle?.actual).toBe("sha256:abc");
    expect(evidence.output_oracle?.runtimeSession).toBe("pid1");
    expect(evidence.output_oracle?.outputTargetId).toBe("target:main");
    expect(proof.resultState).toBe("gpu-hmr-output-oracle-proven");
    expect(proof.outputOracle.evidenceRefs).toEqual(["worker-log:output_oracle:probe.checksum"]);
  });

  it("does not prove output from a runtime oracle missing provenance fields", () => {
    const evidence = runtimeOutputOracleEvidence([
      "[gpu-runtime-boundary] output_oracle id=probe.checksum kind=buffer_checksum expected=sha256:abc actual=sha256:abc passed=true generation=3 runtime_session=pid1",
    ]);
    const proof = classifyGpuHmrOutputProof({
      dispatchProof: safeDispatchProof(),
      deterministicOutputObserved: evidence.deterministic_output_observed,
      deterministicOracleProvided: evidence.deterministic_oracle_provided,
      deterministicOraclePassed: evidence.deterministic_oracle_passed,
      outputOracle: evidence.output_oracle,
      evidenceRefs: evidence.evidence_refs,
    });

    expect(evidence.deterministic_oracle_passed).toBe(true);
    expect(proof.resultState).toBe("gpu-hmr-dispatch-safe-proven");
    expect(proof.degradedReason).toBe("output_oracle_provenance_incomplete");
    expect(proof.outputOracle.provenanceComplete).toBe(false);
  });

  it("only accepts runtime oracle records matching an explicit contract", () => {
    const evidence = runtimeOutputOracleEvidence([
      "[gpu-runtime-boundary] output_oracle id=probe.other kind=buffer_checksum expected=sha256:abc actual=sha256:abc passed=true generation=3 runtime_session=pid1",
      "[gpu-runtime-boundary] output_oracle id=probe.expected kind=buffer_checksum producer=runtime_probe expected=sha256:def actual=sha256:def passed=true generation=3 runtime_session=pid1 output_target_id=target:main readback_timestamp=1779980000000 artifact_id=artifact:def",
    ], {
      expectedOracle: {
        id: "probe.expected",
        kind: "buffer_checksum",
        expected: "sha256:def",
      },
    });

    expect(evidence.total_count).toBe(2);
    expect(evidence.matched_count).toBe(1);
    expect(evidence.output_oracle?.actual).toBe("sha256:def");
    expect(evidence.output_oracle?.runtimeSession).toBe("pid1");
    expect(evidence.evidence_refs).toEqual(["worker-log:output_oracle:probe.expected"]);
  });

  it("only accepts runtime oracle records from the expected runtime session", () => {
    const evidence = runtimeOutputOracleEvidence([
      "[gpu-runtime-boundary] output_oracle id=probe.expected kind=buffer_checksum expected=sha256:def actual=sha256:def passed=true generation=3 runtime_session=old-session",
      "[gpu-runtime-boundary] output_oracle id=probe.expected kind=buffer_checksum expected=sha256:def actual=sha256:bad passed=false generation=3 runtime_session=current-session",
    ], {
      expectedOracle: {
        id: "probe.expected",
        kind: "buffer_checksum",
        expected: "sha256:def",
      },
      runtimeSessionIds: ["current-session"],
    });

    expect(evidence.total_count).toBe(2);
    expect(evidence.matched_count).toBe(1);
    expect(evidence.output_oracle?.runtimeSession).toBe("current-session");
    expect(evidence.deterministic_oracle_passed).toBe(false);
  });

  it("does not accept exact runtime oracle records whose expected and actual values differ", () => {
    const evidence = runtimeOutputOracleEvidence([
      "[gpu-runtime-boundary] output_oracle id=probe.expected kind=buffer_checksum expected=sha256:def actual=sha256:bad passed=true generation=3 runtime_session=pid1",
    ]);

    expect(evidence.expected_actual_match).toBe(false);
    expect(evidence.deterministic_output_observed).toBe(true);
    expect(evidence.deterministic_oracle_provided).toBe(true);
    expect(evidence.deterministic_oracle_passed).toBe(false);
  });

  it("does not mark runtime oracle evidence as passed for unaccepted oracle kinds", () => {
    const evidence = runtimeOutputOracleEvidence([
      "[gpu-runtime-boundary] output_oracle id=probe.visual kind=visual_change_only expected=changed actual=changed passed=true generation=3 runtime_session=pid1",
    ]);

    expect(evidence.total_count).toBe(1);
    expect(evidence.oracle_kind_accepted).toBe(false);
    expect(evidence.deterministic_output_observed).toBe(true);
    expect(evidence.deterministic_oracle_provided).toBe(false);
    expect(evidence.deterministic_oracle_passed).toBe(false);
    expect(evidence.output_oracle?.kindAccepted).toBe(false);
  });

  it("accepts tolerant numeric runtime oracle records only inside tolerance", () => {
    const evidence = runtimeOutputOracleEvidence([
      "[gpu-runtime-boundary] output_oracle id=probe.scalar kind=sentinel_buffer_value producer=runtime_probe expected=1.0 actual=1.005 tolerance=0.01 passed=true generation=3 runtime_session=pid1 output_target_id=target:scalar readback_timestamp=1779980000000 artifact_id=artifact:scalar",
    ]);
    const proof = classifyGpuHmrOutputProof({
      dispatchProof: safeDispatchProof(),
      deterministicOutputObserved: evidence.deterministic_output_observed,
      deterministicOracleProvided: evidence.deterministic_oracle_provided,
      deterministicOraclePassed: evidence.deterministic_oracle_passed,
      outputOracle: evidence.output_oracle,
      evidenceRefs: evidence.evidence_refs,
    });

    expect(evidence.expected_actual_match).toBe(false);
    expect(evidence.expected_actual_compatible).toBe(true);
    expect(evidence.tolerance_applied).toBe(true);
    expect(proof.resultState).toBe("gpu-hmr-output-oracle-proven");
    expect(proof.outputOracle.toleranceApplied).toBe(true);
  });

  it("rejects tolerant numeric runtime oracle records outside tolerance", () => {
    const evidence = runtimeOutputOracleEvidence([
      "[gpu-runtime-boundary] output_oracle id=probe.scalar kind=sentinel_buffer_value expected=1.0 actual=1.05 tolerance=0.01 passed=true generation=3 runtime_session=pid1",
    ]);
    const proof = classifyGpuHmrOutputProof({
      dispatchProof: safeDispatchProof(),
      deterministicOutputObserved: evidence.deterministic_output_observed,
      deterministicOracleProvided: evidence.deterministic_oracle_provided,
      deterministicOraclePassed: evidence.deterministic_oracle_passed,
      outputOracle: evidence.output_oracle,
      evidenceRefs: evidence.evidence_refs,
    });

    expect(evidence.expected_actual_compatible).toBe(false);
    expect(evidence.deterministic_oracle_passed).toBe(false);
    expect(proof.resultState).toBe("gpu-hmr-dispatch-safe-proven");
    expect(proof.outputOracle.passed).toBe(false);
  });

  it("does not treat a nonnumeric tolerance as proof for mismatched oracle values", () => {
    const proof = classifyGpuHmrOutputProof({
      dispatchProof: safeDispatchProof(),
      deterministicOutputObserved: true,
      deterministicOracleProvided: true,
      deterministicOraclePassed: true,
      outputOracle: {
        kind: "sentinel_buffer_value",
        expected: "expected-sentinel",
        actual: "other-sentinel",
        tolerance: "loose",
        evidenceRefs: ["worker-log:output_oracle:probe.expected"],
      },
    });

    expect(proof.resultState).toBe("gpu-hmr-dispatch-safe-proven");
    expect(proof.outputOracle.valuesCompatible).toBe(false);
    expect(proof.outputOracle.toleranceValid).toBe(false);
    expect(proof.outputOracle.passed).toBe(false);
  });

  it("does not accept runtime oracle records without session provenance", () => {
    const evidence = runtimeOutputOracleEvidence([
      "[gpu-runtime-boundary] output_oracle id=probe.expected kind=buffer_checksum expected=sha256:def actual=sha256:def passed=true generation=3",
    ]);

    expect(evidence.total_count).toBe(0);
    expect(evidence.deterministic_output_observed).toBe(false);
    expect(evidence.output_oracle).toBeNull();
  });

  it("does not prove output when runtime oracle records miss the contract", () => {
    const evidence = runtimeOutputOracleEvidence([
      "[gpu-runtime-boundary] output_oracle id=probe.other kind=buffer_checksum expected=sha256:abc actual=sha256:abc passed=true generation=3 runtime_session=pid1",
    ], {
      expectedOracle: {
        id: "probe.expected",
      },
    });

    expect(evidence.total_count).toBe(1);
    expect(evidence.matched_count).toBe(0);
    expect(evidence.deterministic_oracle_passed).toBe(false);
    expect(evidence.output_oracle).toBeNull();
  });

  it("does not mark missing runtime oracle evidence as observed", () => {
    const evidence = runtimeOutputOracleEvidence([]);

    expect(evidence.total_count).toBe(0);
    expect(evidence.deterministic_output_observed).toBe(false);
    expect(evidence.deterministic_oracle_provided).toBe(false);
    expect(evidence.deterministic_oracle_passed).toBe(false);
    expect(evidence.output_oracle).toBeNull();
  });

  it("does not prove output from oracle booleans without a concrete oracle record", () => {
    const proof = classifyGpuHmrOutputProof({
      dispatchProof: safeDispatchProof(),
      deterministicOutputObserved: true,
      deterministicOracleProvided: true,
      deterministicOraclePassed: true,
      visualFrameObserved: true,
    });

    expect(proof.resultState).toBe("gpu-hmr-dispatch-safe-proven");
    expect(proof.degradedState).toBe("gpu-hmr-visual-only");
    expect(proof.outputOracle.provided).toBe(false);
    expect(proof.outputOracle.observed).toBe(false);
  });

  it("does not prove output from an oracle payload without concrete evidence refs", () => {
    const proof = classifyGpuHmrOutputProof({
      dispatchProof: safeDispatchProof(),
      deterministicOutputObserved: true,
      deterministicOracleProvided: true,
      deterministicOraclePassed: true,
      outputOracle: {
        kind: "sentinel_buffer_value",
        expected: "expected-sentinel",
        actual: "expected-sentinel",
      },
      visualFrameObserved: false,
    });

    expect(proof.resultState).toBe("gpu-hmr-dispatch-safe-proven");
    expect(proof.degradedState).toBe("gpu-hmr-output-unobserved");
    expect(proof.outputOracle.provided).toBe(true);
    expect(proof.outputOracle.observed).toBe(true);
    expect(proof.outputOracle.evidenceObserved).toBe(false);
    expect(proof.outputOracle.passed).toBe(false);
  });

  it("does not prove exact output when expected and actual oracle values differ", () => {
    const proof = classifyGpuHmrOutputProof({
      dispatchProof: safeDispatchProof(),
      deterministicOutputObserved: true,
      deterministicOracleProvided: true,
      deterministicOraclePassed: true,
      outputOracle: {
        kind: "sentinel_buffer_value",
        expected: "expected-sentinel",
        actual: "other-sentinel",
        evidenceRefs: ["worker-log:output_oracle:probe.expected"],
      },
      visualFrameObserved: false,
    });

    expect(proof.resultState).toBe("gpu-hmr-dispatch-safe-proven");
    expect(proof.degradedState).toBe("gpu-hmr-output-unobserved");
    expect(proof.outputOracle.valuesCompatible).toBe(false);
    expect(proof.outputOracle.passed).toBe(false);
  });

  it("reports host replacement only from explicit restart or replacement evidence", () => {
    const proof = classifyGpuHmrHostPreservationProof({
      hostRestartObserved: true,
    });

    expect(proof.resultState).toBeNull();
    expect(proof.degradedState).toBe("gpu-hmr-host-replaced");
    expect(summarizeGpuHmrHostPreservationProof(proof)).toContain("gpu-hmr-host-replaced");
  });

  it("does not prove host preservation without identity checks", () => {
    const proof = classifyGpuHmrHostPreservationProof({
      hostRestartObserved: false,
      identityChecksPassed: false,
    });

    expect(proof.resultState).toBeNull();
    expect(proof.degradedState).toBeNull();
    expect(proof.degradedReason).toBe("host_identity_checks_not_collected");
  });

  it("reports host-preservation-proven only when identity checks pass", () => {
    const proof = classifyGpuHmrHostPreservationProof({
      identityChecksPassed: true,
      identitySnapshotObserved: true,
      identitySnapshotLineageObserved: true,
      requiredIdentityRolesObserved: true,
      identityEvidenceRefs: [
        "worker-log:host_identity:runner_process",
        "worker-log:host_identity:core_state",
        "worker-log:host_identity:stream",
      ],
    });

    expect(proof.resultState).toBe("gpu-hmr-host-preservation-proven");
    expect(proof.degradedState).toBeNull();
    expect(proof.runtimeIdentityEvidenceRefs).toEqual([
      "worker-log:host_identity:runner_process",
      "worker-log:host_identity:core_state",
      "worker-log:host_identity:stream",
    ]);
  });

  it("does not prove host preservation from identity booleans without evidence refs", () => {
    const proof = classifyGpuHmrHostPreservationProof({
      identityChecksPassed: true,
      identitySnapshotObserved: true,
      requiredIdentityRolesObserved: true,
    });

    expect(proof.resultState).toBeNull();
    expect(proof.degradedReason).toBe("host_identity_evidence_refs_not_collected");
    expect(proof.identityEvidenceObserved).toBe(false);
  });

  it("does not prove host preservation from asserted checks without runtime snapshots", () => {
    const proof = classifyGpuHmrHostPreservationProof({
      identityChecksPassed: true,
      identityEvidenceRefs: ["worker-log:host_identity:core_state"],
    });

    expect(proof.resultState).toBeNull();
    expect(proof.degradedReason).toBe("host_identity_snapshots_not_collected");
    expect(proof.identitySnapshotObserved).toBe(false);
  });

  it("does not prove host preservation from snapshots without epoch lineage", () => {
    const proof = classifyGpuHmrHostPreservationProof({
      identityChecksPassed: true,
      identitySnapshotObserved: true,
      requiredIdentityRolesObserved: true,
      identityEvidenceRefs: [
        "worker-log:host_identity:runner_process",
        "worker-log:host_identity:core_state",
        "worker-log:host_identity:stream",
      ],
    });

    expect(proof.resultState).toBeNull();
    expect(proof.degradedReason).toBe("host_identity_epoch_lineage_not_collected");
    expect(proof.identitySnapshotLineageObserved).toBe(false);
  });

  it("does not prove host preservation from non-runtime identity evidence refs", () => {
    const proof = classifyGpuHmrHostPreservationProof({
      identityChecksPassed: true,
      identitySnapshotObserved: true,
      requiredIdentityRolesObserved: true,
      identityEvidenceRefs: ["identity-proof:1"],
    });

    expect(proof.resultState).toBeNull();
    expect(proof.degradedReason).toBe("host_identity_evidence_refs_not_collected");
    expect(proof.runtimeIdentityEvidenceRefs).toEqual([]);
  });

  it("does not prove ABI without collected metadata evidence", () => {
    const proof = classifyGpuHmrAbiProof({});

    expect(proof.resultState).toBeNull();
    expect(proof.degradedState).toBe("gpu-hmr-abi-unverified");
    expect(proof.degradedReason).toBe("abi_evidence_not_collected");
    expect(summarizeGpuHmrAbiProof(proof)).toContain("metadata=missing");
  });

  it("treats metadata-only ABI evidence as symbol-bound but unverified", () => {
    const proof = classifyGpuHmrAbiProof({
      metadataObserved: true,
      evidenceRefs: ["evidence:device-abi-metadata:abc"],
    });

    expect(proof.resultState).toBe("gpu-hmr-symbol-bound");
    expect(proof.degradedState).toBe("gpu-hmr-abi-unverified");
    expect(proof.degradedReason).toBe("abi_layout_size_alignment_unverified");
    expect(proof.evidenceRefs).toEqual(["evidence:device-abi-metadata:abc"]);
    expect(summarizeGpuHmrAbiProof(proof)).toContain("layout=unverified");
  });

  it("reports ABI-proven only when layout, size, and alignment were verified", () => {
    const proof = acceptedAbiProof();

    expect(proof.resultState).toBe("gpu-hmr-abi-proven");
    expect(proof.degradedState).toBeNull();
    expect(proof.layoutSizeAlignmentVerified).toBe(true);
    expect(proof.acceptedExtractorProvenanceObserved).toBe(true);
  });

  it("does not prove ABI when accepted extractor provenance is missing", () => {
    const proof = classifyGpuHmrAbiProof({
      metadataObserved: true,
      layoutSizeAlignmentVerified: true,
      evidenceRefs: ["evidence:device-abi-layout:abc"],
    });

    expect(proof.resultState).toBe("gpu-hmr-symbol-bound");
    expect(proof.degradedState).toBe("gpu-hmr-abi-unverified");
    expect(proof.degradedReason).toBe("abi_extractor_provenance_unverified");
    expect(summarizeGpuHmrAbiProof(proof)).toContain("extractor=unverified");
  });

  it("does not prove ABI from accepted extractor refs without concrete provenance", () => {
    const proof = classifyGpuHmrAbiProof({
      metadataObserved: true,
      layoutSizeAlignmentVerified: true,
      acceptedExtractorEvidenceRefs: ["evidence:clang-ast:abc"],
      acceptedExtractorSources: ["clang_ast"],
    });

    expect(proof.resultState).toBe("gpu-hmr-symbol-bound");
    expect(proof.degradedState).toBe("gpu-hmr-abi-unverified");
    expect(proof.degradedReason).toBe("abi_extractor_provenance_unverified");
    expect(proof.acceptedExtractorProvenanceObserved).toBe(false);
  });

  it("rejects extractor provenance explicitly rejected by the runtime correctness plan", () => {
    const proof = classifyGpuHmrAbiProof({
      metadataObserved: true,
      layoutSizeAlignmentVerified: true,
      extractorProvenance: [{
        extractorKind: "clang_ast",
        evidenceId: "evidence:clang-ast:abc",
        extractorName: "test_clang_ast",
        extractorVersion: "v1",
        inputHash: "sha256:abc",
        acceptedByRuntimeCorrectnessPlan: false,
      }],
    });

    expect(proof.resultState).toBe("gpu-hmr-symbol-bound");
    expect(proof.degradedState).toBe("gpu-hmr-abi-unverified");
    expect(proof.degradedReason).toBe("abi_extractor_provenance_unverified");
    expect(proof.acceptedExtractorEvidenceRefs).toEqual([]);
  });

  it("keeps ABI proof unverified when artifact metadata only has rejected source-scan provenance", () => {
    const proof = abiProofFromProofArtifacts([{
      proofArtifactPath: "/tmp/gpu-hmr-proof.json",
      artifact: {
        proofId: "proof:gpu-hmr:1",
        evidenceRefs: [{
          kind: "device-abi-metadata",
          evidenceId: "evidence:device-abi-metadata:abc",
          metadata: {
            schemaVersion: "synthi.gpu.hmr.abi_metadata.v1",
            layoutSizeAlignmentVerified: false,
            acceptedExtractorEvidenceRefs: [],
            extractorProvenance: [{
              extractorKind: "source_text_scan",
              acceptedByRuntimeCorrectnessPlan: false,
            }],
          },
        }],
        stageResults: [{
          stageId: "abi-compatibility",
          status: "blocked",
          degradedReason: "abi_layout_size_alignment_unverified",
        }],
      },
    }]);

    expect(proof.resultState).toBe("gpu-hmr-symbol-bound");
    expect(proof.degradedState).toBe("gpu-hmr-abi-unverified");
    expect(proof.layoutSizeAlignmentVerified).toBe(false);
    expect(proof.acceptedExtractorProvenanceObserved).toBe(false);
    expect(proof.evidenceRefs).toEqual(["evidence:device-abi-metadata:abc"]);
  });

  it("proves ABI from artifact metadata only with layout proof and accepted extractor evidence", () => {
    const proof = abiProofFromProofArtifacts([{
      proofArtifactPath: "/tmp/gpu-hmr-proof.json",
      artifact: {
        proofId: "proof:gpu-hmr:1",
        evidenceRefs: [{
          kind: "device-abi-metadata",
          evidenceId: "evidence:device-abi-metadata:def",
          metadata: {
            schemaVersion: "synthi.gpu.hmr.abi_metadata.v1",
            layoutSizeAlignmentVerified: true,
            acceptedExtractorEvidenceRefs: ["evidence:clang-record-layout:def"],
            acceptedExtractorSources: ["clang_record_layout"],
            extractorProvenance: [{
              extractorKind: "clang_record_layout",
              evidenceId: "evidence:clang-record-layout:def",
              extractorName: "test_clang_record_layout",
              extractorVersion: "v1",
              inputHash: "sha256:def",
            }],
          },
        }],
        stageResults: [{
          stageId: "abi-compatibility",
          status: "passed",
        }],
      },
    }]);

    expect(proof.resultState).toBe("gpu-hmr-abi-proven");
    expect(proof.degradedState).toBeNull();
    expect(proof.acceptedExtractorEvidenceRefs).toEqual(["evidence:clang-record-layout:def"]);
  });

  it("proves fission only from verifier stages with evidence", () => {
    const proof = fissionProofFromProofArtifacts([{
      proofArtifactPath: "/tmp/gpu-hmr-proof.json",
      artifact: {
        proofId: "proof:gpu-hmr:1",
        evidenceRefs: [{
          kind: "fission-verifier-report",
          evidenceId: "evidence:fission-verifier-report:abc",
          metadata: {
            status: "pass",
            selectedIslandId: "island:sha256:abc",
          },
        }],
        stageResults: [{
          stageId: "fission-candidate-verification",
          status: "passed",
          evidenceRefs: ["evidence:fission-verifier-report:abc"],
        }],
      },
    }]);

    expect(proof.fissionProven).toBe(true);
    expect(proof.required).toBe(true);
    expect(proof.degradedState).toBeNull();
    expect(proof.evidenceRefs).toEqual(["evidence:fission-verifier-report:abc"]);
    expect(summarizeGpuHmrFissionProof(proof)).toContain("gpu_fission_proof=proven");
  });

  it("blocks fission proof when a verifier stage rejects the candidate", () => {
    const proof = fissionProofFromProofArtifacts([{
      proofArtifactPath: "/tmp/gpu-hmr-proof.json",
      artifact: {
        proofId: "proof:gpu-hmr:1",
        evidenceRefs: [{
          kind: "fission-verifier-report",
          evidenceId: "evidence:fission-verifier-report:def",
          metadata: {
            status: "reject",
            reasonCodes: ["fission.abi_membrane_unverified"],
          },
        }],
        stageResults: [{
          stageId: "fission-candidate-verification",
          status: "blocked",
          evidenceRefs: ["evidence:fission-verifier-report:def"],
          degradedReason: "fission.abi_membrane_unverified",
        }],
      },
    }]);

    expect(proof.fissionProven).toBe(false);
    expect(proof.required).toBe(true);
    expect(proof.degradedState).toBe("gpu-hmr-fission-unverified");
    expect(proof.degradedReason).toBe("fission.abi_membrane_unverified");
  });

  it("uses candidate-level fission rejection reasons over generic no-accepted summary", () => {
    const proof = fissionProofFromProofArtifacts([{
      proofArtifactPath: "/tmp/gpu-hmr-proof.json",
      artifact: {
        proofId: "proof:gpu-hmr:1",
        evidenceRefs: [{
          kind: "fission-verifier-report",
          evidenceId: "evidence:fission-verifier-report:ghi",
          metadata: {
            status: "reject",
            reasonCodes: ["fission.no_accepted_candidate"],
            candidates: [{
              status: "reject",
              reasonCodes: ["fission.output_oracle_missing", "fission.abi_membrane_evidence_missing"],
            }],
          },
        }],
        stageResults: [{
          stageId: "fission-candidate-verification",
          status: "blocked",
          evidenceRefs: ["evidence:fission-verifier-report:ghi"],
        }],
      },
    }]);

    expect(proof.fissionProven).toBe(false);
    expect(proof.required).toBe(true);
    expect(proof.degradedReason).toBe("fission.output_oracle_missing");
  });

  it("reports path-only artifact transport as degraded RAM I/O evidence", () => {
    const proof = artifactTransportProofFromProofArtifacts([{
      proofArtifactPath: "/tmp/gpu-hmr-proof.json",
      artifact: {
        proofId: "proof:gpu-hmr:1",
        evidenceRefs: [{
          kind: "device-artifact-transport",
          evidenceId: "evidence:device-artifact-transport:abc",
          metadata: {
            schemaVersion: "synthi.gpu.hmr.artifact_transport.v1",
            selectedLoaderTransport: null,
            reloadRequestTransports: ["filesystem_path"],
            ramArtifactReferenceProvided: false,
            degradedState: "gpu-hmr-ram-io-unavailable",
            degradedReason: "reload_request_contains_filesystem_path_only",
          },
        }],
        stageResults: [{
          stageId: "artifact-transport",
          status: "blocked",
          degradedState: "gpu-hmr-ram-io-unavailable",
        }],
      },
    }]);

    expect(proof.transportEvidenceObserved).toBe(true);
    expect(proof.ramTransportProven).toBe(false);
    expect(proof.degradedState).toBe("gpu-hmr-ram-io-unavailable");
    expect(proof.degradedReason).toBe("reload_request_contains_filesystem_path_only");
    expect(proof.loaderTransports).toEqual([]);
    expect(proof.reloadRequestTransports).toEqual(["filesystem_path"]);
    expect(proof.evidenceRefs).toEqual(["evidence:device-artifact-transport:abc"]);
    expect(summarizeGpuHmrArtifactTransportProof(proof)).toContain("ram-unproven");
  });

  it("merges runtime RAM references without proving RAM transport through filesystem loaders", () => {
    const runtimeTransport = runtimeArtifactTransportEvidence([
      "[gpu-runtime-boundary] artifact_transport runtime_session=pid1 generation=3 artifact_hash=sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa artifact_bytes=10 reload_request_transport=filesystem_path,ram_blob selected_loader_transport=filesystem_path loader_api=module_load_path ram_reference=true ram_blob_id=artifact:sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa ram_transport_proven=false degraded_state=gpu-hmr-ram-io-unavailable degraded_reason=selected_loader_uses_filesystem_path load_result=ok",
    ], { runtimeSessionIds: ["pid1"] });
    const proof = artifactTransportProofFromProofArtifacts([{
      proofArtifactPath: "/tmp/gpu-hmr-proof.json",
      artifact: {
        proofId: "proof:gpu-hmr:1",
        evidenceRefs: [{
          kind: "device-artifact-transport",
          evidenceId: "evidence:device-artifact-transport:abc",
          metadata: {
            schemaVersion: "synthi.gpu.hmr.artifact_transport.v1",
            selectedLoaderTransport: null,
            reloadRequestTransports: ["filesystem_path", "ram_blob"],
            ramArtifactReferenceProvided: true,
            degradedState: "gpu-hmr-ram-io-unavailable",
            degradedReason: "selected_loader_transport_not_observed",
          },
        }],
      },
    }], runtimeTransport);

    expect(runtimeTransport.transport_evidence_observed).toBe(true);
    expect(runtimeTransport.ram_transport_proven).toBe(false);
    expect(runtimeTransport.loader_transports).toEqual(["filesystem_path"]);
    expect(runtimeTransport.reload_request_transports).toEqual(["filesystem_path", "ram_blob"]);
    expect(proof.transportEvidenceObserved).toBe(true);
    expect(proof.ramArtifactReferenceProvided).toBe(true);
    expect(proof.ramTransportProven).toBe(false);
    expect(proof.loaderTransports).toEqual(["filesystem_path"]);
    expect(proof.reloadRequestTransports).toEqual(["filesystem_path", "ram_blob"]);
    expect(proof.degradedReason).toBe("selected_loader_uses_filesystem_path");
    expect(proof.evidenceRefs).toEqual([
      "evidence:device-artifact-transport:abc",
      "worker-log:artifact_transport:sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    ]);
  });

  it("ignores artifact transport lines from unexpected runtime sessions", () => {
    const runtimeTransport = runtimeArtifactTransportEvidence([
      "[gpu-runtime-boundary] artifact_transport runtime_session=old generation=3 artifact_hash=sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa artifact_bytes=10 reload_request_transport=ram_blob selected_loader_transport=ram_bytes loader_api=module_load_data ram_reference=true ram_transport_proven=true load_result=ok",
    ], { runtimeSessionIds: ["current"] });

    expect(runtimeTransport.total_count).toBe(1);
    expect(runtimeTransport.matched_count).toBe(0);
    expect(runtimeTransport.transport_evidence_observed).toBe(false);
    expect(runtimeTransport.ram_transport_proven).toBe(false);
  });

  it("proves RAM artifact transport only when a RAM reference reaches a RAM loader", () => {
    const runtimeTransport = runtimeArtifactTransportEvidence([
      "[gpu-runtime-boundary] artifact_transport runtime_session=pid1 generation=3 artifact_hash=sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb artifact_bytes=10 reload_request_transport=ram_blob selected_loader_transport=ram_bytes loader_api=module_load_data ram_reference=true ram_blob_id=artifact:sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb ram_transport_proven=true degraded_state=none degraded_reason=none load_result=ok",
    ], { runtimeSessionIds: ["pid1"] });
    const proof = artifactTransportProofFromProofArtifacts([], runtimeTransport);

    expect(runtimeTransport.ram_transport_proven).toBe(true);
    expect(proof.ramArtifactReferenceProvided).toBe(true);
    expect(proof.ramTransportProven).toBe(true);
    expect(proof.degradedState).toBeNull();
    expect(proof.loaderTransports).toEqual(["ram_bytes"]);
  });

  it("does not infer RAM artifact transport without transport evidence", () => {
    const proof = artifactTransportProofFromProofArtifacts([{
      proofArtifactPath: "/tmp/gpu-hmr-proof.json",
      artifact: { proofId: "proof:gpu-hmr:1", evidenceRefs: [], stageResults: [] },
    }]);

    expect(proof.transportEvidenceObserved).toBe(false);
    expect(proof.ramTransportProven).toBe(false);
    expect(proof.degradedState).toBe("gpu-hmr-ram-io-unavailable");
    expect(proof.degradedReason).toBe("artifact_transport_evidence_not_collected");
  });

  it("reports epoch-swap-proven only for session, stream ordering, generation lineage, table hash, changed entries, and retired old generation", () => {
    const proof = retiredEpochProof();

    expect(proof.resultState).toBe("gpu-hmr-epoch-swap-proven");
    expect(proof.degradedState).toBeNull();
    expect(proof.runtimeSessionObserved).toBe(true);
    expect(proof.generationGraphValid).toBe(true);
    expect(proof.streamOrderingProven).toBe(true);
    expect(summarizeGpuHmrEpochSwapProof(proof)).toContain("retired=yes");
  });

  it("does not prove epoch swap from a lineage boolean without a generation graph", () => {
    const proof = classifyGpuHmrEpochSwapProof({
      published: true,
      runtimeSessionIds: ["runtime-session:test"],
      generationLineageObserved: true,
      dispatchTableHashObserved: true,
      dispatchTableHashBeforeObserved: true,
      dispatchTableHashAfterObserved: true,
      dispatchTableHashChanged: true,
      changedEntriesObserved: true,
      streamOrderingProven: true,
      streamScope: "affected",
      streamIds: ["default"],
      retirementTracked: true,
      oldGenerationRetired: true,
      evidenceRefs: ["evidence:epoch:no-graph"],
    });

    expect(proof.resultState).toBe("gpu-hmr-abi-proven");
    expect(proof.generationGraphObserved).toBe(false);
    expect(proof.degradedState).toBe("gpu-hmr-epoch-swap-unverified");
    expect(proof.degradedReason).toBe("epoch_generation_graph_not_collected");
  });

  it("keeps pending epoch retirement as a blocker for higher proof", () => {
    const proof = classifyGpuHmrEpochSwapProof({
      published: true,
      runtimeSessionIds: ["runtime-session:test"],
      epochGenerationGraph: epochGenerationGraph({ retirementState: "pending" }),
      dispatchTableHashObserved: true,
      dispatchTableHashBeforeObserved: true,
      dispatchTableHashAfterObserved: true,
      dispatchTableHashChanged: true,
      changedEntriesObserved: true,
      streamOrderingProven: true,
      streamScope: "affected",
      streamIds: ["default"],
      retirementTracked: true,
      oldGenerationRetired: false,
      evidenceRefs: ["evidence:epoch:pending"],
    });

    expect(proof.resultState).toBe("gpu-hmr-epoch-swap-proven");
    expect(proof.degradedState).toBe("gpu-hmr-epoch-retirement-pending");
  });

  it("does not accept a retired epoch graph without a matching retirement edge", () => {
    const graph = epochGenerationGraph();
    graph.edges = graph.edges.filter((edge) => edge.kind !== "retire");
    const proof = classifyGpuHmrEpochSwapProof({
      published: true,
      runtimeSessionIds: ["runtime-session:test"],
      epochGenerationGraph: graph,
      dispatchTableHashObserved: true,
      dispatchTableHashBeforeObserved: true,
      dispatchTableHashAfterObserved: true,
      dispatchTableHashChanged: true,
      changedEntriesObserved: true,
      streamOrderingProven: true,
      streamScope: "affected",
      streamIds: ["default"],
      retirementTracked: true,
      oldGenerationRetired: true,
      evidenceRefs: ["evidence:epoch:missing-retire-edge"],
    });

    expect(proof.resultState).toBe("gpu-hmr-abi-proven");
    expect(proof.degradedState).toBe("gpu-hmr-epoch-swap-unverified");
    expect(proof.degradedReason).toBe("epoch_generation_graph_retirement_edge_missing");
  });

  it("does not prove epoch swap without runtime session evidence", () => {
    const proof = classifyGpuHmrEpochSwapProof({
      published: true,
      epochGenerationGraph: epochGenerationGraph({ runtimeSession: null }),
      dispatchTableHashObserved: true,
      dispatchTableHashBeforeObserved: true,
      dispatchTableHashAfterObserved: true,
      dispatchTableHashChanged: true,
      changedEntriesObserved: true,
      streamOrderingProven: true,
      streamScope: "affected",
      streamIds: ["default"],
      retirementTracked: true,
      oldGenerationRetired: true,
      evidenceRefs: ["evidence:epoch:no-session"],
    });

    expect(proof.resultState).toBe("gpu-hmr-abi-proven");
    expect(proof.degradedState).toBe("gpu-hmr-epoch-swap-unverified");
    expect(proof.degradedReason).toBe("epoch_runtime_session_not_collected");
  });

  it("does not prove epoch swap without stream ordering evidence", () => {
    const proof = classifyGpuHmrEpochSwapProof({
      published: true,
      runtimeSessionIds: ["runtime-session:test"],
      epochGenerationGraph: epochGenerationGraph(),
      dispatchTableHashObserved: true,
      dispatchTableHashBeforeObserved: true,
      dispatchTableHashAfterObserved: true,
      dispatchTableHashChanged: true,
      changedEntriesObserved: true,
      retirementTracked: true,
      oldGenerationRetired: true,
      evidenceRefs: ["evidence:epoch:no-stream"],
    });

    expect(proof.resultState).toBe("gpu-hmr-abi-proven");
    expect(proof.degradedState).toBe("gpu-hmr-epoch-swap-unverified");
    expect(proof.degradedReason).toBe("epoch_stream_ordering_not_collected");
  });

  it("proves epoch swap from runtime publish and retire evidence", () => {
    const { evidence, proof } = epochSwapProofFromRuntimeEvidence([
      "[gpu-runtime-boundary] dispatcher_epoch event=published runtime_session=pid1 previous_generation=2 active_generation=3 dispatch_table_hash_before=0xaaa dispatch_table_hash_after=0xabc dispatch_table_hash=0xabc changed_entries=1 retirement_tracked=true old_generation_retired=false stream_scope=affected stream_ids=default stream_ordering_proven=true drain_result=synced drain_elapsed_ms=1 drain_budget_ms=2000",
      "[gpu-runtime-boundary] dispatcher_epoch event=retired runtime_session=pid1 previous_generation=2 active_generation=3 retired_modules=1 old_generation_retired=true stream_scope=affected stream_ids=default stream_ordering_proven=true",
    ]);

    expect(evidence.stream_ordering_proven).toBe(true);
    expect(evidence.stream_ids).toEqual(["default"]);
    expect(evidence.runtime_session_ids).toEqual(["pid1"]);
    expect(evidence.epoch_generation_graph?.schemaVersion).toBe("synthi.gpu.epoch_graph.v1");
    expect(evidence.epoch_generation_graph?.nodes.map((node) => node.id)).toEqual([
      "generation:2",
      "generation:3",
    ]);
    expect(evidence.epoch_generation_graph?.retirementState).toBe("retired");
    expect(evidence.dispatch_table_hash_before_observed).toBe(true);
    expect(evidence.dispatch_table_hash_after_observed).toBe(true);
    expect(proof.resultState).toBe("gpu-hmr-epoch-swap-proven");
    expect(proof.degradedState).toBeNull();
    expect(proof.generationGraphValid).toBe(true);
    expect(proof.evidenceRefs).toEqual([
      "worker-log:dispatcher_epoch:published:2->3",
      "worker-log:dispatcher_epoch:retired:2->3",
    ]);
  });

  it("keeps runtime epoch evidence pending until matching retirement is observed", () => {
    const { evidence, proof } = epochSwapProofFromRuntimeEvidence([
      "[gpu-runtime-boundary] dispatcher_epoch event=published runtime_session=pid1 previous_generation=2 active_generation=3 dispatch_table_hash_before=0xaaa dispatch_table_hash_after=0xabc dispatch_table_hash=0xabc changed_entries=1 retirement_tracked=true old_generation_retired=false stream_scope=affected stream_ids=default stream_ordering_proven=true drain_result=synced drain_elapsed_ms=1 drain_budget_ms=2000",
    ]);

    expect(evidence.old_generation_retired).toBe(false);
    expect(proof.resultState).toBe("gpu-hmr-epoch-swap-proven");
    expect(proof.degradedState).toBe("gpu-hmr-epoch-retirement-pending");
  });

  it("does not prove runtime epoch swap from legacy single dispatch table hash only", () => {
    const { evidence, proof } = epochSwapProofFromRuntimeEvidence([
      "[gpu-runtime-boundary] dispatcher_epoch event=published runtime_session=pid1 previous_generation=2 active_generation=3 dispatch_table_hash=0xabc changed_entries=1 retirement_tracked=true retired_modules=0 old_generation_retired=true stream_scope=affected stream_ids=default stream_ordering_proven=true drain_result=synced drain_elapsed_ms=1 drain_budget_ms=2000",
    ]);

    expect(evidence.dispatch_table_hash_observed).toBe(false);
    expect(evidence.dispatch_table_hash_before_observed).toBe(false);
    expect(evidence.dispatch_table_hash_after_observed).toBe(false);
    expect(proof.resultState).toBe("gpu-hmr-abi-proven");
    expect(proof.degradedState).toBe("gpu-hmr-epoch-swap-unverified");
    expect(proof.degradedReason).toBe("epoch_dispatch_table_hash_not_collected");
  });

  it("does not prove runtime epoch swap when before and after dispatch table hashes are identical", () => {
    const { evidence, proof } = epochSwapProofFromRuntimeEvidence([
      "[gpu-runtime-boundary] dispatcher_epoch event=published runtime_session=pid1 previous_generation=2 active_generation=3 dispatch_table_hash_before=0xabc dispatch_table_hash_after=0xabc dispatch_table_hash=0xabc changed_entries=1 retirement_tracked=true retired_modules=0 old_generation_retired=true stream_scope=affected stream_ids=default stream_ordering_proven=true drain_result=synced drain_elapsed_ms=1 drain_budget_ms=2000",
    ]);

    expect(evidence.dispatch_table_hash_before_observed).toBe(true);
    expect(evidence.dispatch_table_hash_after_observed).toBe(true);
    expect(evidence.dispatch_table_hash_changed).toBe(false);
    expect(evidence.dispatch_table_hash_observed).toBe(false);
    expect(proof.resultState).toBe("gpu-hmr-abi-proven");
    expect(proof.degradedState).toBe("gpu-hmr-epoch-swap-unverified");
    expect(proof.degradedReason).toBe("epoch_dispatch_table_hash_unchanged");
  });

  it("does not prove runtime epoch swap when no dispatch entries changed", () => {
    const { evidence, proof } = epochSwapProofFromRuntimeEvidence([
      "[gpu-runtime-boundary] dispatcher_epoch event=published runtime_session=pid1 previous_generation=2 active_generation=3 dispatch_table_hash_before=0xaaa dispatch_table_hash_after=0xabc dispatch_table_hash=0xabc changed_entries=0 retirement_tracked=true retired_modules=0 old_generation_retired=true stream_scope=affected stream_ids=default stream_ordering_proven=true drain_result=synced drain_elapsed_ms=1 drain_budget_ms=2000",
    ]);

    expect(evidence.dispatch_table_hash_changed).toBe(true);
    expect(evidence.changed_entries_observed).toBe(false);
    expect(proof.resultState).toBe("gpu-hmr-abi-proven");
    expect(proof.degradedState).toBe("gpu-hmr-epoch-swap-unverified");
    expect(proof.degradedReason).toBe("epoch_changed_entries_not_collected");
  });

  it("keeps publication-only retirement pending without explicit zero retired modules", () => {
    const { evidence, proof } = epochSwapProofFromRuntimeEvidence([
      "[gpu-runtime-boundary] dispatcher_epoch event=published runtime_session=pid1 previous_generation=2 active_generation=3 dispatch_table_hash_before=0xaaa dispatch_table_hash_after=0xabc dispatch_table_hash=0xabc changed_entries=1 retirement_tracked=true old_generation_retired=true stream_scope=affected stream_ids=default stream_ordering_proven=true drain_result=synced drain_elapsed_ms=1 drain_budget_ms=2000",
    ]);

    expect(evidence.retirement_not_required).toBe(false);
    expect(evidence.old_generation_retired).toBe(false);
    expect(proof.resultState).toBe("gpu-hmr-epoch-swap-proven");
    expect(proof.degradedState).toBe("gpu-hmr-epoch-retirement-pending");
  });

  it("accepts publication-only retirement when zero retired modules is explicit", () => {
    const { evidence, proof } = epochSwapProofFromRuntimeEvidence([
      "[gpu-runtime-boundary] dispatcher_epoch event=published runtime_session=pid1 previous_generation=2 active_generation=3 dispatch_table_hash_before=0xaaa dispatch_table_hash_after=0xabc dispatch_table_hash=0xabc changed_entries=1 retirement_tracked=true retired_modules=0 old_generation_retired=true stream_scope=affected stream_ids=default stream_ordering_proven=true drain_result=synced drain_elapsed_ms=1 drain_budget_ms=2000",
    ]);

    expect(evidence.retirement_not_required).toBe(true);
    expect(evidence.old_generation_retired).toBe(true);
    expect(proof.resultState).toBe("gpu-hmr-epoch-swap-proven");
    expect(proof.degradedState).toBeNull();
  });

  it("accepts no-stream epoch ordering only when no affected streams are explicitly recorded", () => {
    const { evidence, proof } = epochSwapProofFromRuntimeEvidence([
      "[gpu-runtime-boundary] dispatcher_epoch event=published runtime_session=pid1 previous_generation=2 active_generation=3 dispatch_table_hash_before=0xaaa dispatch_table_hash_after=0xabc dispatch_table_hash=0xabc changed_entries=1 retirement_tracked=true retired_modules=0 old_generation_retired=true stream_scope=none stream_ids=none stream_ordering_proven=true drain_result=synced drain_elapsed_ms=0 drain_budget_ms=2000",
    ]);

    expect(evidence.stream_scope_supported).toBe(true);
    expect(evidence.stream_ids).toEqual(["none"]);
    expect(proof.resultState).toBe("gpu-hmr-epoch-swap-proven");
    expect(proof.degradedState).toBeNull();
  });

  it("does not prove no-stream epoch ordering when the no-stream assertion is omitted", () => {
    const { evidence, proof } = epochSwapProofFromRuntimeEvidence([
      "[gpu-runtime-boundary] dispatcher_epoch event=published runtime_session=pid1 previous_generation=2 active_generation=3 dispatch_table_hash_before=0xaaa dispatch_table_hash_after=0xabc dispatch_table_hash=0xabc changed_entries=1 retirement_tracked=true retired_modules=0 old_generation_retired=true stream_scope=none stream_ordering_proven=true drain_result=synced drain_elapsed_ms=0 drain_budget_ms=2000",
    ]);

    expect(evidence.stream_scope_supported).toBe(false);
    expect(evidence.stream_ordering_proven).toBe(false);
    expect(proof.resultState).toBe("gpu-hmr-abi-proven");
    expect(proof.degradedState).toBe("gpu-hmr-epoch-swap-unverified");
    expect(proof.degradedReason).toBe("epoch_stream_scope_not_collected");
  });

  it("does not prove no-stream epoch ordering when stream ids contradict the scope", () => {
    const { evidence, proof } = epochSwapProofFromRuntimeEvidence([
      "[gpu-runtime-boundary] dispatcher_epoch event=published runtime_session=pid1 previous_generation=2 active_generation=3 dispatch_table_hash_before=0xaaa dispatch_table_hash_after=0xabc dispatch_table_hash=0xabc changed_entries=1 retirement_tracked=true retired_modules=0 old_generation_retired=true stream_scope=none stream_ids=default stream_ordering_proven=true drain_result=synced drain_elapsed_ms=0 drain_budget_ms=2000",
    ]);

    expect(evidence.stream_scope_supported).toBe(false);
    expect(evidence.stream_ordering_proven).toBe(false);
    expect(proof.resultState).toBe("gpu-hmr-abi-proven");
    expect(proof.degradedState).toBe("gpu-hmr-epoch-swap-unverified");
    expect(proof.degradedReason).toBe("epoch_stream_scope_not_collected");
  });

  it("downgrades runtime epoch evidence when stream ordering is missing from the publication", () => {
    const { evidence, proof } = epochSwapProofFromRuntimeEvidence([
      "[gpu-runtime-boundary] dispatcher_epoch event=published runtime_session=pid1 previous_generation=2 active_generation=3 dispatch_table_hash_before=0xaaa dispatch_table_hash_after=0xabc dispatch_table_hash=0xabc changed_entries=1 retirement_tracked=true old_generation_retired=true stream_scope=context",
    ]);

    expect(evidence.stream_ordering_proven).toBe(false);
    expect(proof.resultState).toBe("gpu-hmr-abi-proven");
    expect(proof.degradedState).toBe("gpu-hmr-epoch-swap-unverified");
    expect(proof.degradedReason).toBe("epoch_stream_ordering_not_collected");
  });

  it("does not accept context-wide drain as epoch stream ordering proof", () => {
    const { evidence, proof } = epochSwapProofFromRuntimeEvidence([
      "[gpu-runtime-boundary] dispatcher_epoch event=published runtime_session=pid1 previous_generation=2 active_generation=3 dispatch_table_hash_before=0xaaa dispatch_table_hash_after=0xabc dispatch_table_hash=0xabc changed_entries=1 retirement_tracked=true old_generation_retired=true stream_scope=context stream_ordering_proven=true drain_result=synced drain_elapsed_ms=1 drain_budget_ms=2000",
    ]);

    expect(evidence.stream_ordering_proven).toBe(false);
    expect(evidence.stream_scope_supported).toBe(false);
    expect(proof.resultState).toBe("gpu-hmr-abi-proven");
    expect(proof.degradedState).toBe("gpu-hmr-epoch-swap-unverified");
    expect(proof.degradedReason).toBe("epoch_stream_scope_not_collected");
  });

  it("does not prove epoch swap from boolean stream ordering without evidence refs", () => {
    const proof = classifyGpuHmrEpochSwapProof({
      published: true,
      runtimeSessionIds: ["runtime-session:test"],
      epochGenerationGraph: epochGenerationGraph(),
      dispatchTableHashObserved: true,
      dispatchTableHashBeforeObserved: true,
      dispatchTableHashAfterObserved: true,
      dispatchTableHashChanged: true,
      changedEntriesObserved: true,
      streamOrderingProven: true,
      streamScope: "affected",
      streamIds: ["default"],
      retirementTracked: true,
      oldGenerationRetired: true,
    });

    expect(proof.resultState).toBe("gpu-hmr-abi-proven");
    expect(proof.degradedState).toBe("gpu-hmr-epoch-swap-unverified");
    expect(proof.degradedReason).toBe("epoch_evidence_refs_not_collected");
  });

  it("proves host preservation from matching runtime identity snapshots across the expected epoch lineage", () => {
    const { evidence, proof } = hostPreservationProofFromRuntimeEvidence([
      "[gpu-runtime-boundary] host_identity role=runner_process ptr=0x900 aux=1 generation=2 runtime_session=pid1",
      "[gpu-runtime-boundary] host_identity role=runner_process ptr=0x900 aux=1 generation=3 runtime_session=pid1",
      "[gpu-runtime-boundary] host_identity role=core_state ptr=0x1000 aux=42 generation=2 runtime_session=pid1",
      "[gpu-runtime-boundary] host_identity role=core_state ptr=0x1000 aux=42 generation=3 runtime_session=pid1",
      "[gpu-runtime-boundary] host_identity role=renderer ptr=0x2000 aux=0 generation=2 runtime_session=pid1",
      "[gpu-runtime-boundary] host_identity role=renderer ptr=0x2000 aux=0 generation=3 runtime_session=pid1",
      "[gpu-runtime-boundary] host_identity role=stream ptr=0x3000 aux=0 generation=2 runtime_session=pid1",
      "[gpu-runtime-boundary] host_identity role=stream ptr=0x3000 aux=0 generation=3 runtime_session=pid1",
    ], {
      expectedGenerationLineage: { previousGeneration: 2, activeGeneration: 3 },
    });

    expect(evidence.identity_checks_passed).toBe(true);
    expect(evidence.identity_snapshot_observed).toBe(true);
    expect(evidence.identity_snapshot_lineage_observed).toBe(true);
    expect(evidence.preserved_roles).toEqual(["core_state", "renderer", "runner_process", "stream"]);
    expect(evidence.preserved_role_categories).toEqual(["host_state", "runner_process", "runtime_resource"]);
    expect(proof.resultState).toBe("gpu-hmr-host-preservation-proven");
    expect(proof.degradedState).toBeNull();
    expect(proof.runtimeIdentityEvidenceRefs).toEqual([
      "worker-log:host_identity:core_state",
      "worker-log:host_identity:renderer",
      "worker-log:host_identity:runner_process",
      "worker-log:host_identity:stream",
    ]);
  });

  it("does not prove host preservation from runtime identities without expected epoch lineage", () => {
    const { evidence, proof } = hostPreservationProofFromRuntimeEvidence([
      "[gpu-runtime-boundary] host_identity role=runner_process ptr=0x900 aux=1 generation=2 runtime_session=pid1",
      "[gpu-runtime-boundary] host_identity role=runner_process ptr=0x900 aux=1 generation=3 runtime_session=pid1",
      "[gpu-runtime-boundary] host_identity role=core_state ptr=0x1000 aux=42 generation=2 runtime_session=pid1",
      "[gpu-runtime-boundary] host_identity role=core_state ptr=0x1000 aux=42 generation=3 runtime_session=pid1",
      "[gpu-runtime-boundary] host_identity role=stream ptr=0x3000 aux=0 generation=2 runtime_session=pid1",
      "[gpu-runtime-boundary] host_identity role=stream ptr=0x3000 aux=0 generation=3 runtime_session=pid1",
    ]);

    expect(evidence.identity_snapshot_observed).toBe(true);
    expect(evidence.identity_snapshot_lineage_required).toBe(true);
    expect(evidence.identity_snapshot_lineage_observed).toBe(false);
    expect(evidence.identity_checks_passed).toBe(false);
    expect(proof.resultState).toBeNull();
    expect(proof.degradedReason).toBe("host_identity_checks_not_collected");
  });

  it("proves host preservation only for snapshots spanning the expected epoch lineage", () => {
    const { evidence, proof } = hostPreservationProofFromRuntimeEvidence([
      "[gpu-runtime-boundary] host_identity role=runner_process ptr=0x900 aux=1 generation=2 runtime_session=pid1",
      "[gpu-runtime-boundary] host_identity role=runner_process ptr=0x900 aux=1 generation=3 runtime_session=pid1",
      "[gpu-runtime-boundary] host_identity role=core_state ptr=0x1000 aux=42 generation=2 runtime_session=pid1",
      "[gpu-runtime-boundary] host_identity role=core_state ptr=0x1000 aux=42 generation=3 runtime_session=pid1",
      "[gpu-runtime-boundary] host_identity role=stream ptr=0x3000 aux=0 generation=2 runtime_session=pid1",
      "[gpu-runtime-boundary] host_identity role=stream ptr=0x3000 aux=0 generation=3 runtime_session=pid1",
    ], {
      epochProof: retiredEpochProof(),
    });

    expect(evidence.expected_generation_lineage).toEqual({
      previousGeneration: 2,
      activeGeneration: 3,
    });
    expect(evidence.expected_generation_lineage_observed).toBe(true);
    expect(evidence.lineage_identity_roles_observed).toEqual([
      "core_state",
      "runner_process",
      "stream",
    ]);
    expect(evidence.identity_checks_passed).toBe(true);
    expect(proof.resultState).toBe("gpu-hmr-host-preservation-proven");
  });

  it("does not prove host preservation from snapshots outside the expected epoch lineage", () => {
    const { evidence, proof } = hostPreservationProofFromRuntimeEvidence([
      "[gpu-runtime-boundary] host_identity role=runner_process ptr=0x900 aux=1 generation=1 runtime_session=pid1",
      "[gpu-runtime-boundary] host_identity role=runner_process ptr=0x900 aux=1 generation=2 runtime_session=pid1",
      "[gpu-runtime-boundary] host_identity role=core_state ptr=0x1000 aux=42 generation=1 runtime_session=pid1",
      "[gpu-runtime-boundary] host_identity role=core_state ptr=0x1000 aux=42 generation=2 runtime_session=pid1",
      "[gpu-runtime-boundary] host_identity role=stream ptr=0x3000 aux=0 generation=1 runtime_session=pid1",
      "[gpu-runtime-boundary] host_identity role=stream ptr=0x3000 aux=0 generation=2 runtime_session=pid1",
    ], {
      expectedGenerationLineage: { previousGeneration: 2, activeGeneration: 3 },
    });

    expect(evidence.expected_generation_lineage_observed).toBe(false);
    expect(evidence.lineage_identity_roles_missing).toEqual([
      "core_state",
      "runner_process",
      "stream",
    ]);
    expect(evidence.identity_checks_passed).toBe(false);
    expect(proof.resultState).toBeNull();
    expect(proof.degradedReason).toBe("host_identity_checks_not_collected");
  });

  it("scopes host preservation identity snapshots to the expected runtime session", () => {
    const evidence = runtimeHostIdentityEvidence([
      "[gpu-runtime-boundary] host_identity role=core_state ptr=0x1000 aux=42 generation=2 runtime_session=old-session",
      "[gpu-runtime-boundary] host_identity role=core_state ptr=0x1000 aux=42 generation=3 runtime_session=old-session",
      "[gpu-runtime-boundary] host_identity role=runner_process ptr=0x800 aux=1 generation=2 runtime_session=current-session",
      "[gpu-runtime-boundary] host_identity role=runner_process ptr=0x800 aux=1 generation=3 runtime_session=current-session",
      "[gpu-runtime-boundary] host_identity role=core_state ptr=0x2000 aux=42 generation=2 runtime_session=current-session",
      "[gpu-runtime-boundary] host_identity role=core_state ptr=0x2000 aux=42 generation=3 runtime_session=current-session",
      "[gpu-runtime-boundary] host_identity role=stream ptr=0x3000 aux=0 generation=2 runtime_session=current-session",
      "[gpu-runtime-boundary] host_identity role=stream ptr=0x3000 aux=0 generation=3 runtime_session=current-session",
    ], {
      runtimeSessionIds: ["current-session"],
      expectedGenerationLineage: { previousGeneration: 2, activeGeneration: 3 },
    });

    expect(evidence.raw_count).toBe(8);
    expect(evidence.total_count).toBe(6);
    expect(evidence.rejected_count).toBe(2);
    expect(evidence.rejected_reasons).toEqual(["runtime_session_unexpected"]);
    expect(evidence.runtime_session_ids).toEqual(["current-session"]);
    expect(evidence.identity_checks_passed).toBe(true);
    expect(evidence.preserved_roles).toEqual(["core_state", "runner_process", "stream"]);
    expect(evidence.required_roles_observed).toBe(true);
  });

  it("does not prove host preservation without runner process identity", () => {
    const { evidence, proof } = hostPreservationProofFromRuntimeEvidence([
      "[gpu-runtime-boundary] host_identity role=core_state ptr=0x1000 aux=42 generation=2 runtime_session=pid1",
      "[gpu-runtime-boundary] host_identity role=core_state ptr=0x1000 aux=42 generation=3 runtime_session=pid1",
      "[gpu-runtime-boundary] host_identity role=stream ptr=0x3000 aux=0 generation=2 runtime_session=pid1",
      "[gpu-runtime-boundary] host_identity role=stream ptr=0x3000 aux=0 generation=3 runtime_session=pid1",
    ]);

    expect(evidence.preserved_role_categories).toEqual(["host_state", "runtime_resource"]);
    expect(evidence.required_roles_observed).toBe(false);
    expect(evidence.identity_checks_passed).toBe(false);
    expect(proof.resultState).toBeNull();
    expect(proof.degradedReason).toBe("host_identity_checks_not_collected");
  });

  it("does not prove host preservation from runtime-only identities", () => {
    const { evidence, proof } = hostPreservationProofFromRuntimeEvidence([
      "[gpu-runtime-boundary] host_identity role=runtime_context ptr=0x1000 aux=0 generation=2 runtime_session=pid1",
      "[gpu-runtime-boundary] host_identity role=runtime_context ptr=0x1000 aux=0 generation=3 runtime_session=pid1",
      "[gpu-runtime-boundary] host_identity role=launch_stream ptr=0x2000 aux=0 generation=2 runtime_session=pid1",
      "[gpu-runtime-boundary] host_identity role=launch_stream ptr=0x2000 aux=0 generation=3 runtime_session=pid1",
    ]);

    expect(evidence.preserved_roles).toEqual(["launch_stream", "runtime_context"]);
    expect(evidence.preserved_role_categories).toEqual(["runtime_resource"]);
    expect(evidence.identity_checks_passed).toBe(false);
    expect(proof.resultState).toBeNull();
  });

  it("does not accept host identity snapshots without session provenance", () => {
    const { evidence, proof } = hostPreservationProofFromRuntimeEvidence([
      "[gpu-runtime-boundary] host_identity role=core_state ptr=0x1000 aux=42 generation=2",
      "[gpu-runtime-boundary] host_identity role=core_state ptr=0x1000 aux=42 generation=3",
    ]);

    expect(evidence.raw_count).toBe(2);
    expect(evidence.total_count).toBe(0);
    expect(evidence.rejected_count).toBe(2);
    expect(evidence.rejected_reasons).toEqual(["runtime_session_missing"]);
    expect(proof.resultState).toBeNull();
    expect(proof.degradedReason).toBe("host_identity_checks_not_collected");
  });

  it("reports rejected host identity evidence reasons without using it as proof", () => {
    const evidence = runtimeHostIdentityEvidence([
      "[gpu-runtime-boundary] host_identity role=core_state ptr=0x0 aux=42 generation=2 runtime_session=pid1",
      "[gpu-runtime-boundary] host_identity role=core_state ptr=not-a-ptr aux=42 generation=2 runtime_session=pid1",
      "[gpu-runtime-boundary] host_identity role=stream ptr=0x3000 aux=0 runtime_session=pid1",
      "[gpu-runtime-boundary] host_identity role=stream ptr=0x3000 aux=0 generation=2 runtime_session=other",
    ], {
      runtimeSessionIds: ["pid1"],
    });

    expect(evidence.raw_count).toBe(4);
    expect(evidence.total_count).toBe(0);
    expect(evidence.rejected_count).toBe(4);
    expect(evidence.rejected_reasons).toEqual([
      "ptr_null",
      "ptr_invalid",
      "generation_missing",
      "runtime_session_unexpected",
    ]);
    expect(evidence.identity_checks_passed).toBe(false);
  });

  it("does not prove host preservation when a runtime identity changes", () => {
    const { evidence, proof } = hostPreservationProofFromRuntimeEvidence([
      "[gpu-runtime-boundary] host_identity role=core_state ptr=0x1000 aux=42 generation=2 runtime_session=pid1",
      "[gpu-runtime-boundary] host_identity role=core_state ptr=0x1010 aux=42 generation=3 runtime_session=pid1",
    ]);

    expect(evidence.identity_checks_passed).toBe(false);
    expect(evidence.changed_roles).toEqual(["core_state"]);
    expect(proof.resultState).toBeNull();
    expect(proof.degradedReason).toBe("host_identity_checks_not_collected");
  });

  it("treats validation runtime identity changes as host replacement evidence", () => {
    const { proof } = hostPreservationProofFromRuntimeEvidence([], {
      hostRestartObserved: true,
      identityEvidenceRefs: ["validation:runtime_identity:first_compile"],
    });

    expect(proof.resultState).toBeNull();
    expect(proof.degradedState).toBe("gpu-hmr-host-replaced");
    expect(proof.identityEvidenceRefs).toEqual(["validation:runtime_identity:first_compile"]);
  });

  it("proves original host path attachment only from runtime-scoped attachment evidence", () => {
    const { evidence, proof } = originalHostPathProofFromRuntimeEvidence([
      "[gpu-runtime-boundary] original_host_path event=attached attached=true dispatch_boundary_observed=true attachment_provenance=runtime_explicit host_path_id=host-main dispatch_table_entry_id=entry-1 generation=3 runtime_session=pid1",
      "[gpu-runtime-boundary] launch_arg_provenance kernel=render generation=3 runtime_session=pid1 complete=true known_args=1 unknown_args=0",
    ], {
      required: true,
      runtimeSessionIds: ["pid1"],
    });

    expect(evidence.total_count).toBe(1);
    expect(evidence.matching_launch_boundary_observed).toBe(true);
    expect(evidence.attached_to_original_host_path).toBe(true);
    expect(evidence.evidence_refs).toEqual([
      "worker-log:original_host_path:host-main:3",
      "worker-log:launch_arg_provenance:pid1:3",
    ]);
    expect(proof.attachmentProven).toBe(true);
    expect(proof.degradedState).toBeNull();
    expect(summarizeGpuHmrOriginalHostPathProof(proof)).toContain("gpu_original_host_path_proof=attached");
  });

  it("does not prove original host path attachment without matching launch boundary provenance", () => {
    const { evidence, proof } = originalHostPathProofFromRuntimeEvidence([
      "[gpu-runtime-boundary] original_host_path event=attached attached=true dispatch_boundary_observed=true attachment_provenance=runtime_explicit host_path_id=host-main dispatch_table_entry_id=entry-1 generation=3 runtime_session=pid1",
      "[gpu-runtime-boundary] launch_arg_provenance kernel=render generation=4 runtime_session=pid1 complete=true known_args=1 unknown_args=0",
    ], {
      required: true,
      runtimeSessionIds: ["pid1"],
    });

    expect(evidence.raw_count).toBe(1);
    expect(evidence.total_count).toBe(0);
    expect(evidence.launch_boundary_count).toBe(1);
    expect(evidence.matching_launch_boundary_observed).toBe(false);
    expect(proof.attachmentProven).toBe(false);
    expect(proof.degradedState).toBe("gpu-hmr-original-host-path-unattached");
    expect(proof.degradedReason).toBe("original_host_path_attachment_not_observed");
  });

  it("does not prove original host path attachment from launch-wrapper auto evidence", () => {
    const { evidence, proof } = originalHostPathProofFromRuntimeEvidence([
      "[gpu-runtime-boundary] original_host_path event=attached attached=true dispatch_boundary_observed=true attachment_provenance=launch_boundary_auto host_path_id=synthi-gpu-launch-1 dispatch_table_entry_id=entry-1 generation=3 runtime_session=pid1",
      "[gpu-runtime-boundary] launch_arg_provenance kernel=render generation=3 runtime_session=pid1 complete=true known_args=1 unknown_args=0",
    ], {
      required: true,
      runtimeSessionIds: ["pid1"],
    });

    expect(evidence.raw_count).toBe(1);
    expect(evidence.total_count).toBe(0);
    expect(proof.attachmentProven).toBe(false);
    expect(proof.degradedState).toBe("gpu-hmr-original-host-path-unattached");
  });

  it("does not prove original host path attachment from static metadata", () => {
    const proof = classifyGpuHmrOriginalHostPathProof({
      required: true,
      attachedToOriginalHostPath: true,
      runtimeEvidenceObserved: true,
      dispatchBoundaryObserved: true,
      sessionScoped: true,
      runtimeSessionIds: ["pid1"],
      evidenceRefs: ["metadata:host_path:static"],
    });

    expect(proof.attachmentProven).toBe(false);
    expect(proof.degradedState).toBe("gpu-hmr-original-host-path-unattached");
    expect(proof.degradedReason).toBe("original_host_path_runtime_evidence_not_collected");
  });

  it("scopes original host path attachment to the expected runtime session", () => {
    const evidence = runtimeOriginalHostPathEvidence([
      "[gpu-runtime-boundary] original_host_path event=attached attached=true dispatch_boundary_observed=true attachment_provenance=runtime_explicit host_path_id=old-host dispatch_table_entry_id=entry-1 generation=3 runtime_session=old-session",
      "[gpu-runtime-boundary] launch_arg_provenance kernel=render generation=3 runtime_session=old-session complete=true known_args=1 unknown_args=0",
      "[gpu-runtime-boundary] original_host_path event=attached attached=true dispatch_boundary_observed=true attachment_provenance=runtime_explicit host_path_id=current-host dispatch_table_entry_id=entry-2 generation=4 runtime_session=current-session",
      "[gpu-runtime-boundary] launch_arg_provenance kernel=render generation=4 runtime_session=current-session complete=true known_args=1 unknown_args=0",
    ], {
      runtimeSessionIds: ["current-session"],
    });

    expect(evidence.raw_count).toBe(2);
    expect(evidence.total_count).toBe(1);
    expect(evidence.runtime_session_ids).toEqual(["current-session"]);
    expect(evidence.evidence_refs).toEqual([
      "worker-log:original_host_path:current-host:4",
      "worker-log:launch_arg_provenance:current-session:4",
    ]);
  });

  it("requires session dispatch before dispatch proof can be considered", () => {
    const proof = classifyGpuHmrDispatchProof({});

    expect(proof.resultState).toBeNull();
    expect(proof.degradedState).toBe("gpu-hmr-dispatch-unobserved");
    expect(summarizeGpuHmrDispatchProof(proof)).toContain("dispatch=missing");
  });

  it("requires concrete runtime session identity for dispatch proof", () => {
    const proof = classifyGpuHmrDispatchProof({
      dispatchObserved: true,
      sessionScoped: true,
      argProvenanceObserved: true,
      argProvenanceComplete: true,
      abiProof: acceptedAbiProof(),
      epochProof: retiredEpochProof(),
      streamOrderingProven: true,
      replacementScopeProven: true,
    });

    expect(proof.resultState).toBeNull();
    expect(proof.degradedState).toBe("gpu-hmr-dispatch-unobserved");
    expect(proof.degradedReason).toBe("runtime_session_identity_not_collected");
  });

  it("downgrades observed dispatch without argument provenance", () => {
    const proof = classifyGpuHmrDispatchProof({
      dispatchObserved: true,
      sessionScoped: true,
      runtimeSessionIds: ["runtime-session:test"],
    });

    expect(proof.resultState).toBe("gpu-hmr-dispatch-observed");
    expect(proof.degradedState).toBe("gpu-hmr-unknown-arg-provenance");
    expect(proof.degradedReason).toBe("launch_argument_provenance_not_collected");
  });

  it("does not prove dispatch safety from argument provenance booleans without runtime evidence refs", () => {
    const proof = classifyGpuHmrDispatchProof({
      dispatchObserved: true,
      sessionScoped: true,
      runtimeSessionIds: ["runtime-session:test"],
      argProvenanceObserved: true,
      argProvenanceComplete: true,
      unknownArgCount: 0,
      abiProof: acceptedAbiProof(),
      epochProof: retiredEpochProof(),
      streamOrderingProven: true,
      replacementScopeProven: true,
    });

    expect(proof.resultState).toBe("gpu-hmr-dispatch-observed");
    expect(proof.degradedState).toBe("gpu-hmr-unknown-arg-provenance");
    expect(proof.degradedReason).toBe("launch_argument_provenance_evidence_refs_not_collected");
    expect(proof.argProvenanceEvidenceObserved).toBe(false);
  });

  it("does not accept non-runtime argument provenance evidence refs", () => {
    const proof = classifyGpuHmrDispatchProof({
      dispatchObserved: true,
      sessionScoped: true,
      runtimeSessionIds: ["runtime-session:test"],
      argProvenanceObserved: true,
      argProvenanceComplete: true,
      unknownArgCount: 0,
      argProvenanceEvidenceRefs: ["validation:launch_arg_provenance:test"],
      abiProof: acceptedAbiProof(),
      epochProof: retiredEpochProof(),
      streamOrderingProven: true,
      replacementScopeProven: true,
    });

    expect(proof.resultState).toBe("gpu-hmr-dispatch-observed");
    expect(proof.degradedReason).toBe("launch_argument_provenance_evidence_refs_not_collected");
    expect(proof.argProvenanceEvidenceRefs).toEqual([]);
  });

  it("reports dispatch-observed but not safe when ABI proof is missing", () => {
    const proof = classifyGpuHmrDispatchProof({
      dispatchObserved: true,
      sessionScoped: true,
      runtimeSessionIds: ["runtime-session:test"],
      argProvenanceObserved: true,
      argProvenanceComplete: true,
      argProvenanceEvidenceRefs: [
        "worker-log:launch_arg_provenance:test:runtime-session.test:2",
      ],
      unknownArgCount: 0,
    });

    expect(proof.resultState).toBe("gpu-hmr-dispatch-observed");
    expect(proof.degradedState).toBe("gpu-hmr-abi-unverified");
  });

  it("reports dispatch-safe-proven only with complete ABI, epoch, stream, scope, and argument gates", () => {
    const proof = safeDispatchProof();

    expect(proof.resultState).toBe("gpu-hmr-dispatch-safe-proven");
    expect(proof.degradedState).toBeNull();
    expect(summarizeGpuHmrDispatchProof(proof)).toContain("provenance=complete");
    expect(summarizeGpuHmrDispatchProof(proof)).toContain("safety=passed");
  });

  it("blocks output proof when dispatch argument provenance is incomplete", () => {
    const proof = classifyGpuHmrOutputProof({
      dispatchProof: classifyGpuHmrDispatchProof({
        dispatchObserved: true,
        sessionScoped: true,
        runtimeSessionIds: ["runtime-session:test"],
        argProvenanceObserved: true,
        argProvenanceComplete: false,
        unknownArgCount: 1,
      }),
      deterministicOutputObserved: true,
      deterministicOracleProvided: true,
      deterministicOraclePassed: true,
      outputOracle: deterministicOutputOracle(),
    });

    expect(proof.resultState).toBe("gpu-hmr-dispatch-observed");
    expect(proof.degradedState).toBe("gpu-hmr-unknown-arg-provenance");
    expect(proof.degradedReason).toBe("launch_argument_provenance_incomplete");
  });

  it("rejects deterministic output oracles with unaccepted oracle kinds", () => {
    const proof = classifyGpuHmrOutputProof({
      dispatchProof: safeDispatchProof(),
      deterministicOutputObserved: true,
      deterministicOracleProvided: true,
      deterministicOraclePassed: true,
      outputOracle: {
        ...deterministicOutputOracle(),
        kind: "visual_change_only",
      },
    });

    expect(proof.resultState).toBe("gpu-hmr-dispatch-safe-proven");
    expect(proof.degradedState).toBe("gpu-hmr-output-unobserved");
    expect(proof.degradedReason).toBe("output_oracle_kind_unaccepted");
    expect(proof.outputOracle.kindAccepted).toBe(false);
  });

  it("blocks full runtime proof at ABI when source proof has not reached ABI", () => {
    const proof = classifyGpuHmrFullRuntimeProof({
      sourceProofs: [{ resultState: "gpu-hmr-symbol-bound" }],
      outputProof: classifyGpuHmrOutputProof({
        dispatchObserved: true,
        visualFrameObserved: true,
      }),
      hostPreservationProof: preservedHostProof(),
    });

    expect(proof.resultState).toBe("gpu-hmr-symbol-bound");
    expect(proof.degradedState).toBe("gpu-hmr-abi-unverified");
    expect(proof.fullRuntimeProven).toBe(false);
    expect(summarizeGpuHmrFullRuntimeProof(proof)).toContain("blocked=abi,artifact-transport,epoch-swap,dispatch-observed,dispatch-safe,output");
  });

  it("blocks full runtime proof when ABI evidence is metadata-only", () => {
    const proof = classifyGpuHmrFullRuntimeProof({
      sourceProofs: [{ resultState: "gpu-hmr-symbol-bound" }],
      abiProof: classifyGpuHmrAbiProof({
        metadataObserved: true,
        evidenceRefs: ["evidence:device-abi-metadata:abc"],
      }),
      outputProof: classifyGpuHmrOutputProof({
        dispatchProof: safeDispatchProof(),
        deterministicOutputObserved: true,
        deterministicOracleProvided: true,
        deterministicOraclePassed: true,
        outputOracle: deterministicOutputOracle(),
      }),
      hostPreservationProof: preservedHostProof(),
    });

    expect(proof.resultState).toBe("gpu-hmr-symbol-bound");
    expect(proof.degradedState).toBe("gpu-hmr-abi-unverified");
    expect(proof.degradedReason).toBe("abi_layout_size_alignment_unverified");
    expect(proof.fullRuntimeProven).toBe(false);
    expect(proof.postPublicationDecision.disposition).toBe("not-published-or-unverified");
    expect(proof.postPublicationDecision.quarantineRequired).toBe(false);
  });

  it("blocks full runtime proof when artifact transport evidence is missing", () => {
    const proof = classifyGpuHmrFullRuntimeProof({
      sourceProofs: [{ resultState: "gpu-hmr-abi-proven" }],
      abiProof: acceptedAbiProof(),
      epochProof: retiredEpochProof(),
      dispatchProof: safeDispatchProof(),
      outputProof: classifyGpuHmrOutputProof({
        dispatchProof: safeDispatchProof(),
        deterministicOutputObserved: true,
        deterministicOracleProvided: true,
        deterministicOraclePassed: true,
        outputOracle: deterministicOutputOracle(),
      }),
      hostPreservationProof: preservedHostProof(),
    });

    expect(proof.resultState).toBe("gpu-hmr-abi-proven");
    expect(proof.degradedState).toBe("gpu-hmr-ram-io-unavailable");
    expect(proof.degradedReason).toBe("artifact_transport_evidence_not_collected");
    expect(proof.fullRuntimeProven).toBe(false);
    expect(proof.componentStates.artifactTransportProven).toBe(false);
    expect(summarizeGpuHmrFullRuntimeProof(proof)).toContain("blocked=artifact-transport");
  });

  it("blocks full runtime proof at dispatch when argument provenance is incomplete", () => {
    const proof = classifyGpuHmrFullRuntimeProof({
      sourceProofs: [{ resultState: "gpu-hmr-abi-proven" }],
      abiProof: acceptedAbiProof(),
      artifactTransportProof: acceptedArtifactTransportProof(),
      epochProof: retiredEpochProof(),
      dispatchProof: classifyGpuHmrDispatchProof({
        dispatchObserved: true,
        sessionScoped: true,
        runtimeSessionIds: ["runtime-session:test"],
        argProvenanceObserved: true,
        argProvenanceComplete: false,
        unknownArgCount: 1,
      }),
      outputProof: classifyGpuHmrOutputProof({
        dispatchProof: safeDispatchProof(),
        deterministicOutputObserved: true,
        deterministicOracleProvided: true,
        deterministicOraclePassed: true,
        outputOracle: deterministicOutputOracle(),
      }),
      hostPreservationProof: preservedHostProof(),
    });

    expect(proof.resultState).toBe("gpu-hmr-dispatch-observed");
    expect(proof.degradedState).toBe("gpu-hmr-unknown-arg-provenance");
    expect(proof.fullRuntimeProven).toBe(false);
    expect(summarizeGpuHmrFullRuntimeProof(proof)).toContain("blocked=dispatch-safe");
  });

  it("reports full-runtime-proven only when every required component passes", () => {
    const proof = classifyGpuHmrFullRuntimeProof({
      sourceProofs: [{ resultState: "gpu-hmr-abi-proven" }],
      abiProof: acceptedAbiProof(),
      artifactTransportProof: acceptedArtifactTransportProof(),
      epochProof: retiredEpochProof(),
      dispatchProof: safeDispatchProof(),
      outputProof: classifyGpuHmrOutputProof({
        dispatchProof: safeDispatchProof(),
        deterministicOutputObserved: true,
        deterministicOracleProvided: true,
        deterministicOraclePassed: true,
        outputOracle: deterministicOutputOracle(),
      }),
      hostPreservationProof: preservedHostProof(),
    });

    expect(proof.resultState).toBe("gpu-hmr-full-runtime-proven");
    expect(proof.degradedState).toBeNull();
    expect(proof.fullRuntimeProven).toBe(true);
    expect(proof.postPublicationDecision.disposition).toBe("accepted");
    expect(proof.postPublicationDecision.aiBlessingAllowed).toBe(true);
  });

  it("blocks full runtime proof when required fission verifier evidence is missing", () => {
    const proof = classifyGpuHmrFullRuntimeProof({
      sourceProofs: [{ resultState: "gpu-hmr-abi-proven" }],
      fissionProofRequired: true,
      abiProof: acceptedAbiProof(),
      artifactTransportProof: acceptedArtifactTransportProof(),
      epochProof: retiredEpochProof(),
      dispatchProof: safeDispatchProof(),
      outputProof: classifyGpuHmrOutputProof({
        dispatchProof: safeDispatchProof(),
        deterministicOutputObserved: true,
        deterministicOracleProvided: true,
        deterministicOraclePassed: true,
        outputOracle: deterministicOutputOracle(),
      }),
      hostPreservationProof: preservedHostProof(),
    });

    expect(proof.resultState).toBeNull();
    expect(proof.degradedState).toBe("gpu-hmr-fission-unverified");
    expect(proof.degradedReason).toBe("fission_candidate_verification_not_observed");
    expect(proof.fullRuntimeProven).toBe(false);
    expect(proof.componentStates.fissionProofRequired).toBe(true);
    expect(proof.componentStates.fissionProofProven).toBe(false);
    expect(summarizeGpuHmrFullRuntimeProof(proof)).toContain("blocked=fission-candidate-verification");
  });

  it("allows full runtime proof when required fission verifier evidence passes", () => {
    const proof = classifyGpuHmrFullRuntimeProof({
      sourceProofs: [{ resultState: "gpu-hmr-abi-proven" }],
      fissionProof: acceptedFissionProof(),
      abiProof: acceptedAbiProof(),
      artifactTransportProof: acceptedArtifactTransportProof(),
      epochProof: retiredEpochProof(),
      dispatchProof: safeDispatchProof(),
      outputProof: classifyGpuHmrOutputProof({
        dispatchProof: safeDispatchProof(),
        deterministicOutputObserved: true,
        deterministicOracleProvided: true,
        deterministicOraclePassed: true,
        outputOracle: deterministicOutputOracle(),
      }),
      hostPreservationProof: preservedHostProof(),
    });

    expect(proof.resultState).toBe("gpu-hmr-full-runtime-proven");
    expect(proof.degradedState).toBeNull();
    expect(proof.fullRuntimeProven).toBe(true);
    expect(proof.componentStates.fissionProofRequired).toBe(true);
    expect(proof.componentStates.fissionProofProven).toBe(true);
  });

  it("quarantines a published capsule when post-publication gates fail", () => {
    const proof = classifyGpuHmrFullRuntimeProof({
      sourceProofs: [{ resultState: "gpu-hmr-abi-proven" }],
      abiProof: acceptedAbiProof(),
      artifactTransportProof: acceptedArtifactTransportProof(),
      epochProof: retiredEpochProof(),
      dispatchProof: safeDispatchProof(),
      outputProof: classifyGpuHmrOutputProof({
        dispatchProof: safeDispatchProof(),
        visualFrameObserved: true,
      }),
      hostPreservationProof: preservedHostProof(),
    });

    expect(proof.resultState).toBe("gpu-hmr-dispatch-safe-proven");
    expect(proof.fullRuntimeProven).toBe(false);
    expect(proof.postPublicationDecision.disposition).toBe("quarantined");
    expect(proof.postPublicationDecision.epochPublished).toBe(true);
    expect(proof.postPublicationDecision.rollbackRequired).toBe(true);
    expect(proof.postPublicationDecision.aiBlessingAllowed).toBe(false);
    expect(proof.postPublicationDecision.blockedStageIds).toEqual(["output"]);
    expect(summarizeGpuHmrFullRuntimeProof(proof)).toContain("capsule=quarantined");
  });

  it("blocks full runtime proof when original host path attachment is required but missing", () => {
    const proof = classifyGpuHmrFullRuntimeProof({
      sourceProofs: [{ resultState: "gpu-hmr-abi-proven" }],
      abiProof: acceptedAbiProof(),
      artifactTransportProof: acceptedArtifactTransportProof(),
      epochProof: retiredEpochProof(),
      dispatchProof: safeDispatchProof(),
      outputProof: classifyGpuHmrOutputProof({
        dispatchProof: safeDispatchProof(),
        deterministicOutputObserved: true,
        deterministicOracleProvided: true,
        deterministicOraclePassed: true,
        outputOracle: deterministicOutputOracle(),
      }),
      hostPreservationProof: preservedHostProof(),
      originalHostPathRequired: true,
    });

    expect(proof.resultState).toBe("gpu-hmr-host-preservation-proven");
    expect(proof.degradedState).toBe("gpu-hmr-original-host-path-unattached");
    expect(proof.degradedReason).toBe("original_host_path_attachment_not_observed");
    expect(proof.fullRuntimeProven).toBe(false);
    expect(summarizeGpuHmrFullRuntimeProof(proof)).toContain("blocked=original-host-path");
  });

  it("reports full runtime proof with required original host path only when attachment proof is runtime-backed", () => {
    const proof = classifyGpuHmrFullRuntimeProof({
      sourceProofs: [{ resultState: "gpu-hmr-abi-proven" }],
      abiProof: acceptedAbiProof(),
      artifactTransportProof: acceptedArtifactTransportProof(),
      epochProof: retiredEpochProof(),
      dispatchProof: safeDispatchProof(),
      outputProof: classifyGpuHmrOutputProof({
        dispatchProof: safeDispatchProof(),
        deterministicOutputObserved: true,
        deterministicOracleProvided: true,
        deterministicOraclePassed: true,
        outputOracle: deterministicOutputOracle(),
      }),
      hostPreservationProof: preservedHostProof(),
      originalHostPathProof: attachedOriginalHostPathProof(),
    });

    expect(proof.resultState).toBe("gpu-hmr-full-runtime-proven");
    expect(proof.degradedState).toBeNull();
    expect(proof.fullRuntimeProven).toBe(true);
    expect(proof.componentStates.originalHostPathRequired).toBe(true);
    expect(proof.componentStates.originalHostPathProven).toBe(true);
  });

  it("materializes runtime proof ladder as a structured validation artifact", () => {
    const dispatchProof = safeDispatchProof();
    const sourceProof = {
      resultState: "gpu-hmr-abi-proven",
      proofArtifactPath: ".synthi/gpu-hmr/proofs/source.json",
    };
    const outputProof = classifyGpuHmrOutputProof({
      dispatchProof,
      deterministicOutputObserved: true,
      deterministicOracleProvided: true,
      deterministicOraclePassed: true,
      outputOracle: deterministicOutputOracle(),
      visualFrameObserved: true,
      visualEvidenceRefs: ["artifacts/frame.png"],
    });
    const fullRuntimeProof = classifyGpuHmrFullRuntimeProof({
      sourceProofs: [sourceProof],
      fissionProof: acceptedFissionProof(),
      abiProof: acceptedAbiProof(),
      artifactTransportProof: acceptedArtifactTransportProof(),
      epochProof: retiredEpochProof(),
      dispatchProof,
      outputProof,
      hostPreservationProof: preservedHostProof(),
      originalHostPathProof: attachedOriginalHostPathProof(),
    });

    const artifact = buildValidationRuntimeProofArtifact({
      workspaceSlug: "workspace",
      runtimeSessionIds: ["runtime-session:test"],
      sourceProofs: [sourceProof],
      fissionProof: acceptedFissionProof(),
      abiProof: acceptedAbiProof(),
      artifactTransportProof: acceptedArtifactTransportProof(),
      epochProof: retiredEpochProof(),
      dispatchProof,
      outputProof,
      hostPreservationProof: preservedHostProof(),
      originalHostPathProof: attachedOriginalHostPathProof(),
      fullRuntimeProof,
      visualEvidenceRefs: ["artifacts/frame.png"],
      createdAt: "2026-05-28T00:00:00.000Z",
    });

    expect(artifact.schemaVersion).toBe("synthi.gpu.hmr.proof.v1");
    expect(artifact.proofId).toMatch(/^gpu-runtime-proof:sha256:/);
    expect(artifact.resultState).toBe("gpu-hmr-full-runtime-proven");
    expect(artifact.stageResults.map((stage) => stage.stageId)).toContain("artifact-transport");
    expect(artifact.stageResults.map((stage) => stage.stageId)).toContain("host-preservation");
    expect(artifact.stageResults.every((stage) => Array.isArray(stage.evidenceRefs))).toBe(true);
    expect(artifact.evidenceRefs.map((ref) => ref.evidenceId)).toContain("worker-log:artifact_transport:sha256:abc");
    expect(artifact.evidenceRefs.map((ref) => ref.evidenceId)).toContain("worker-log:host_identity:core_state");
    expect(artifact.visualEvidenceRefs).toEqual(["artifacts/frame.png"]);
    expect(artifact.proofMaterial.fullRuntimeProof.fullRuntimeProven).toBe(true);
  });

  it("does not reconstruct dispatch proof from output state alone", () => {
    const proof = classifyGpuHmrFullRuntimeProof({
      sourceProofs: [{ resultState: "gpu-hmr-abi-proven" }],
      abiProof: acceptedAbiProof(),
      artifactTransportProof: acceptedArtifactTransportProof(),
      epochProof: retiredEpochProof(),
      outputProof: { resultState: "gpu-hmr-output-oracle-proven" },
      hostPreservationProof: preservedHostProof(),
    });

    expect(proof.resultState).toBe("gpu-hmr-epoch-swap-proven");
    expect(proof.degradedState).toBe("gpu-hmr-dispatch-unobserved");
    expect(proof.fullRuntimeProven).toBe(false);
  });

  it("uses dispatch proof embedded in output proof for the full ladder", () => {
    const proof = classifyGpuHmrFullRuntimeProof({
      sourceProofs: [{ resultState: "gpu-hmr-abi-proven" }],
      abiProof: acceptedAbiProof(),
      artifactTransportProof: acceptedArtifactTransportProof(),
      epochProof: retiredEpochProof(),
      outputProof: classifyGpuHmrOutputProof({
        dispatchProof: safeDispatchProof(),
        deterministicOutputObserved: true,
        deterministicOracleProvided: true,
        deterministicOraclePassed: true,
        outputOracle: deterministicOutputOracle(),
      }),
      hostPreservationProof: preservedHostProof(),
    });

    expect(proof.resultState).toBe("gpu-hmr-full-runtime-proven");
    expect(proof.fullRuntimeProven).toBe(true);
  });

  it("does not accept claimed host preservation without runtime identity snapshot provenance", () => {
    const proof = classifyGpuHmrFullRuntimeProof({
      sourceProofs: [{ resultState: "gpu-hmr-abi-proven" }],
      abiProof: acceptedAbiProof(),
      artifactTransportProof: acceptedArtifactTransportProof(),
      epochProof: retiredEpochProof(),
      dispatchProof: safeDispatchProof(),
      outputProof: classifyGpuHmrOutputProof({
        dispatchProof: safeDispatchProof(),
        deterministicOutputObserved: true,
        deterministicOracleProvided: true,
        deterministicOraclePassed: true,
        outputOracle: deterministicOutputOracle(),
      }),
      hostPreservationProof: { resultState: "gpu-hmr-host-preservation-proven" },
    });

    expect(proof.resultState).toBe("gpu-hmr-output-oracle-proven");
    expect(proof.degradedReason).toBe("host_identity_snapshot_provenance_unverified");
    expect(proof.fullRuntimeProven).toBe(false);
  });

  it("keeps host replacement as a full-runtime blocker after output proof", () => {
    const proof = classifyGpuHmrFullRuntimeProof({
      sourceProofs: [{ resultState: "gpu-hmr-abi-proven" }],
      abiProof: acceptedAbiProof(),
      artifactTransportProof: acceptedArtifactTransportProof(),
      epochProof: retiredEpochProof(),
      dispatchProof: safeDispatchProof(),
      outputProof: classifyGpuHmrOutputProof({
        dispatchProof: safeDispatchProof(),
        deterministicOutputObserved: true,
        deterministicOracleProvided: true,
        deterministicOraclePassed: true,
        outputOracle: deterministicOutputOracle(),
      }),
      hostPreservationProof: classifyGpuHmrHostPreservationProof({
        hostReplacementObserved: true,
      }),
    });

    expect(proof.resultState).toBe("gpu-hmr-output-oracle-proven");
    expect(proof.degradedState).toBe("gpu-hmr-host-replaced");
    expect(proof.fullRuntimeProven).toBe(false);
  });
});
