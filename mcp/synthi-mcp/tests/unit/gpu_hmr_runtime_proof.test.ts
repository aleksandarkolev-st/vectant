import { describe, expect, it } from "vitest";
import {
  classifyGpuHmrAbiProof,
  classifyGpuHmrDispatchProof,
  classifyGpuHmrEpochSwapProof,
  classifyGpuHmrFullRuntimeProof,
  classifyGpuHmrHostPreservationProof,
  classifyGpuHmrOutputProof,
  summarizeGpuHmrAbiProof,
  summarizeGpuHmrDispatchProof,
  summarizeGpuHmrEpochSwapProof,
  summarizeGpuHmrFullRuntimeProof,
  summarizeGpuHmrHostPreservationProof,
  summarizeGpuHmrOutputProof,
} from "../../scripts/lib/gpu-hmr-runtime-proof.mjs";
import { abiProofFromProofArtifacts } from "../../scripts/lib/gpu-hmr-proof-artifacts.mjs";
import {
  epochSwapProofFromRuntimeEvidence,
  hostPreservationProofFromRuntimeEvidence,
  runtimeOutputOracleEvidence,
} from "../../scripts/lib/gpu-hmr-runtime-evidence.mjs";

function acceptedAbiProof() {
  return classifyGpuHmrAbiProof({
    metadataObserved: true,
    layoutSizeAlignmentVerified: true,
    extractorProvenance: [{ kind: "clang_ast", evidenceId: "evidence:clang-ast:abc" }],
  });
}

function retiredEpochProof() {
  return classifyGpuHmrEpochSwapProof({
    published: true,
    generationLineageObserved: true,
    dispatchTableHashObserved: true,
    changedEntriesObserved: true,
    retirementTracked: true,
    oldGenerationRetired: true,
    evidenceRefs: ["evidence:epoch:abc"],
  });
}

function safeDispatchProof() {
  return classifyGpuHmrDispatchProof({
    dispatchObserved: true,
    sessionScoped: true,
    argProvenanceObserved: true,
    argProvenanceComplete: true,
    abiProof: acceptedAbiProof(),
    epochProof: retiredEpochProof(),
    streamOrderingProven: true,
    replacementScopeProven: true,
  });
}

function deterministicOutputOracle() {
  return {
    kind: "runtime_readback",
    expected: "expected-sentinel",
    actual: "expected-sentinel",
    evidenceRefs: ["evidence:readback:abc"],
  };
}

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
    expect(proof.outputOracle.kind).toBe("runtime_readback");
  });

  it("can prove output from a structured runtime oracle line", () => {
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

    expect(evidence.total_count).toBe(1);
    expect(evidence.output_oracle?.actual).toBe("sha256:abc");
    expect(proof.resultState).toBe("gpu-hmr-output-oracle-proven");
    expect(proof.outputOracle.evidenceRefs).toEqual(["worker-log:output_oracle:probe.checksum"]);
  });

  it("only accepts runtime oracle records matching an explicit contract", () => {
    const evidence = runtimeOutputOracleEvidence([
      "[gpu-runtime-boundary] output_oracle id=probe.other kind=buffer_checksum expected=sha256:abc actual=sha256:abc passed=true generation=3 runtime_session=pid1",
      "[gpu-runtime-boundary] output_oracle id=probe.expected kind=buffer_checksum expected=sha256:def actual=sha256:def passed=true generation=3 runtime_session=pid1",
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
    expect(evidence.evidence_refs).toEqual(["worker-log:output_oracle:probe.expected"]);
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
      identityEvidenceRefs: ["identity-proof:1"],
    });

    expect(proof.resultState).toBe("gpu-hmr-host-preservation-proven");
    expect(proof.degradedState).toBeNull();
    expect(proof.identityEvidenceRefs).toEqual(["identity-proof:1"]);
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

  it("rejects extractor provenance explicitly rejected by the runtime correctness plan", () => {
    const proof = classifyGpuHmrAbiProof({
      metadataObserved: true,
      layoutSizeAlignmentVerified: true,
      extractorProvenance: [{
        extractorKind: "clang_ast",
        evidenceId: "evidence:clang-ast:abc",
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

  it("reports epoch-swap-proven only for generation lineage, table hash, changed entries, and retired old generation", () => {
    const proof = retiredEpochProof();

    expect(proof.resultState).toBe("gpu-hmr-epoch-swap-proven");
    expect(proof.degradedState).toBeNull();
    expect(summarizeGpuHmrEpochSwapProof(proof)).toContain("retired=yes");
  });

  it("keeps pending epoch retirement as a blocker for higher proof", () => {
    const proof = classifyGpuHmrEpochSwapProof({
      published: true,
      generationLineageObserved: true,
      dispatchTableHashObserved: true,
      changedEntriesObserved: true,
      retirementTracked: true,
      oldGenerationRetired: false,
    });

    expect(proof.resultState).toBe("gpu-hmr-epoch-swap-proven");
    expect(proof.degradedState).toBe("gpu-hmr-epoch-retirement-pending");
  });

  it("proves epoch swap from runtime publish and retire evidence", () => {
    const { evidence, proof } = epochSwapProofFromRuntimeEvidence([
      "[gpu-runtime-boundary] dispatcher_epoch event=published runtime_session=pid1 previous_generation=2 active_generation=3 dispatch_table_hash=0xabc changed_entries=1 retirement_tracked=true old_generation_retired=false stream_scope=context stream_ordering_proven=true drain_result=synced drain_elapsed_ms=1 drain_budget_ms=2000",
      "[gpu-runtime-boundary] dispatcher_epoch event=retired runtime_session=pid1 previous_generation=2 active_generation=3 retired_modules=1 old_generation_retired=true stream_scope=context stream_ordering_proven=true",
    ]);

    expect(evidence.stream_ordering_proven).toBe(true);
    expect(proof.resultState).toBe("gpu-hmr-epoch-swap-proven");
    expect(proof.degradedState).toBeNull();
    expect(proof.evidenceRefs).toEqual([
      "worker-log:dispatcher_epoch:published:2->3",
      "worker-log:dispatcher_epoch:retired:2->3",
    ]);
  });

  it("keeps runtime epoch evidence pending until matching retirement is observed", () => {
    const { evidence, proof } = epochSwapProofFromRuntimeEvidence([
      "[gpu-runtime-boundary] dispatcher_epoch event=published runtime_session=pid1 previous_generation=2 active_generation=3 dispatch_table_hash=0xabc changed_entries=1 retirement_tracked=true old_generation_retired=false stream_scope=context stream_ordering_proven=true drain_result=synced drain_elapsed_ms=1 drain_budget_ms=2000",
    ]);

    expect(evidence.old_generation_retired).toBe(false);
    expect(proof.resultState).toBe("gpu-hmr-epoch-swap-proven");
    expect(proof.degradedState).toBe("gpu-hmr-epoch-retirement-pending");
  });

  it("proves host preservation from matching runtime identity snapshots across generations", () => {
    const { evidence, proof } = hostPreservationProofFromRuntimeEvidence([
      "[gpu-runtime-boundary] host_identity role=core_state ptr=0x1000 aux=42 generation=2 runtime_session=pid1",
      "[gpu-runtime-boundary] host_identity role=core_state ptr=0x1000 aux=42 generation=3 runtime_session=pid1",
      "[gpu-runtime-boundary] host_identity role=renderer ptr=0x2000 aux=0 generation=2 runtime_session=pid1",
      "[gpu-runtime-boundary] host_identity role=renderer ptr=0x2000 aux=0 generation=3 runtime_session=pid1",
    ]);

    expect(evidence.identity_checks_passed).toBe(true);
    expect(evidence.preserved_roles).toEqual(["core_state", "renderer"]);
    expect(proof.resultState).toBe("gpu-hmr-host-preservation-proven");
    expect(proof.degradedState).toBeNull();
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

  it("requires session dispatch before dispatch proof can be considered", () => {
    const proof = classifyGpuHmrDispatchProof({});

    expect(proof.resultState).toBeNull();
    expect(proof.degradedState).toBe("gpu-hmr-dispatch-unobserved");
    expect(summarizeGpuHmrDispatchProof(proof)).toContain("dispatch=missing");
  });

  it("downgrades observed dispatch without argument provenance", () => {
    const proof = classifyGpuHmrDispatchProof({
      dispatchObserved: true,
      sessionScoped: true,
    });

    expect(proof.resultState).toBe("gpu-hmr-dispatch-observed");
    expect(proof.degradedState).toBe("gpu-hmr-unknown-arg-provenance");
    expect(proof.degradedReason).toBe("launch_argument_provenance_not_collected");
  });

  it("reports dispatch-observed but not safe when ABI proof is missing", () => {
    const proof = classifyGpuHmrDispatchProof({
      dispatchObserved: true,
      sessionScoped: true,
      argProvenanceObserved: true,
      argProvenanceComplete: true,
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

  it("blocks full runtime proof at ABI when source proof has not reached ABI", () => {
    const proof = classifyGpuHmrFullRuntimeProof({
      sourceProofs: [{ resultState: "gpu-hmr-symbol-bound" }],
      outputProof: classifyGpuHmrOutputProof({
        dispatchObserved: true,
        visualFrameObserved: true,
      }),
      hostPreservationProof: classifyGpuHmrHostPreservationProof({
        identityChecksPassed: true,
      }),
    });

    expect(proof.resultState).toBe("gpu-hmr-symbol-bound");
    expect(proof.degradedState).toBe("gpu-hmr-abi-unverified");
    expect(proof.fullRuntimeProven).toBe(false);
    expect(summarizeGpuHmrFullRuntimeProof(proof)).toContain("blocked=abi,epoch-swap,dispatch-observed,dispatch-safe,output");
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
      hostPreservationProof: classifyGpuHmrHostPreservationProof({
        identityChecksPassed: true,
      }),
    });

    expect(proof.resultState).toBe("gpu-hmr-symbol-bound");
    expect(proof.degradedState).toBe("gpu-hmr-abi-unverified");
    expect(proof.degradedReason).toBe("abi_layout_size_alignment_unverified");
    expect(proof.fullRuntimeProven).toBe(false);
  });

  it("blocks full runtime proof at dispatch when argument provenance is incomplete", () => {
    const proof = classifyGpuHmrFullRuntimeProof({
      sourceProofs: [{ resultState: "gpu-hmr-abi-proven" }],
      abiProof: acceptedAbiProof(),
      epochProof: retiredEpochProof(),
      dispatchProof: classifyGpuHmrDispatchProof({
        dispatchObserved: true,
        sessionScoped: true,
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
      hostPreservationProof: classifyGpuHmrHostPreservationProof({
        identityChecksPassed: true,
      }),
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
        identityChecksPassed: true,
      }),
    });

    expect(proof.resultState).toBe("gpu-hmr-full-runtime-proven");
    expect(proof.degradedState).toBeNull();
    expect(proof.fullRuntimeProven).toBe(true);
  });

  it("keeps host replacement as a full-runtime blocker after output proof", () => {
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
      hostPreservationProof: classifyGpuHmrHostPreservationProof({
        hostReplacementObserved: true,
      }),
    });

    expect(proof.resultState).toBe("gpu-hmr-output-oracle-proven");
    expect(proof.degradedState).toBe("gpu-hmr-host-replaced");
    expect(proof.fullRuntimeProven).toBe(false);
  });
});
