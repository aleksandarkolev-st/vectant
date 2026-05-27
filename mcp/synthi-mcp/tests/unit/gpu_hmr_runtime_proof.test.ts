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
      visualFrameObserved: true,
    });

    expect(proof.resultState).toBe("gpu-hmr-output-oracle-proven");
    expect(proof.degradedState).toBeNull();
    expect(proof.outputOracle.passed).toBe(true);
  });

  it("reports host replacement only from explicit restart or replacement evidence", () => {
    const proof = classifyGpuHmrHostPreservationProof({
      hostRestartObserved: true,
    });

    expect(proof.resultState).toBe("gpu-hmr-output-oracle-proven");
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
