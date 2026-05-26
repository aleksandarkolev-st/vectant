import { describe, expect, it } from "vitest";
import {
  classifyGpuHmrAbiProof,
  classifyGpuHmrDispatchProof,
  classifyGpuHmrFullRuntimeProof,
  classifyGpuHmrHostPreservationProof,
  classifyGpuHmrOutputProof,
  summarizeGpuHmrAbiProof,
  summarizeGpuHmrDispatchProof,
  summarizeGpuHmrFullRuntimeProof,
  summarizeGpuHmrHostPreservationProof,
  summarizeGpuHmrOutputProof,
} from "../../scripts/lib/gpu-hmr-runtime-proof.mjs";

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
      dispatchObserved: true,
      visualFrameObserved: true,
    });

    expect(proof.resultState).toBe("gpu-hmr-dispatch-proven");
    expect(proof.degradedState).toBe("gpu-hmr-visual-only");
    expect(summarizeGpuHmrOutputProof(proof)).toContain("gpu-hmr-visual-only");
  });

  it("reports output-unobserved when dispatch has no output evidence", () => {
    const proof = classifyGpuHmrOutputProof({
      dispatchObserved: true,
      visualFrameObserved: false,
    });

    expect(proof.resultState).toBe("gpu-hmr-dispatch-proven");
    expect(proof.degradedState).toBe("gpu-hmr-output-unobserved");
  });

  it("reports output-proven only for a passing deterministic oracle", () => {
    const proof = classifyGpuHmrOutputProof({
      dispatchObserved: true,
      deterministicOutputObserved: true,
      deterministicOracleProvided: true,
      deterministicOraclePassed: true,
      visualFrameObserved: true,
    });

    expect(proof.resultState).toBe("gpu-hmr-output-proven");
    expect(proof.degradedState).toBeNull();
    expect(proof.outputOracle.passed).toBe(true);
  });

  it("reports host replacement only from explicit restart or replacement evidence", () => {
    const proof = classifyGpuHmrHostPreservationProof({
      hostRestartObserved: true,
    });

    expect(proof.resultState).toBe("gpu-hmr-output-proven");
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
    const proof = classifyGpuHmrAbiProof({
      metadataObserved: true,
      layoutSizeAlignmentVerified: true,
      evidenceRefs: ["evidence:device-abi-layout:abc"],
    });

    expect(proof.resultState).toBe("gpu-hmr-abi-proven");
    expect(proof.degradedState).toBeNull();
    expect(proof.layoutSizeAlignmentVerified).toBe(true);
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
    });

    expect(proof.resultState).toBe("gpu-hmr-dispatch-proven");
    expect(proof.degradedState).toBe("gpu-hmr-unknown-arg-provenance");
    expect(proof.degradedReason).toBe("launch_argument_provenance_not_collected");
  });

  it("reports dispatch-proven only with complete argument provenance", () => {
    const proof = classifyGpuHmrDispatchProof({
      dispatchObserved: true,
      argProvenanceObserved: true,
      argProvenanceComplete: true,
      unknownArgCount: 0,
    });

    expect(proof.resultState).toBe("gpu-hmr-dispatch-proven");
    expect(proof.degradedState).toBeNull();
    expect(summarizeGpuHmrDispatchProof(proof)).toContain("provenance=complete");
  });

  it("blocks output proof when dispatch argument provenance is incomplete", () => {
    const proof = classifyGpuHmrOutputProof({
      dispatchProof: classifyGpuHmrDispatchProof({
        dispatchObserved: true,
        argProvenanceObserved: true,
        argProvenanceComplete: false,
        unknownArgCount: 1,
      }),
      deterministicOutputObserved: true,
      deterministicOracleProvided: true,
      deterministicOraclePassed: true,
    });

    expect(proof.resultState).toBe("gpu-hmr-dispatch-proven");
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
    expect(summarizeGpuHmrFullRuntimeProof(proof)).toContain("blocked=abi,output");
  });

  it("blocks full runtime proof when ABI evidence is metadata-only", () => {
    const proof = classifyGpuHmrFullRuntimeProof({
      sourceProofs: [{ resultState: "gpu-hmr-symbol-bound" }],
      abiProof: classifyGpuHmrAbiProof({
        metadataObserved: true,
        evidenceRefs: ["evidence:device-abi-metadata:abc"],
      }),
      outputProof: classifyGpuHmrOutputProof({
        dispatchObserved: true,
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
      abiProof: classifyGpuHmrAbiProof({
        metadataObserved: true,
        layoutSizeAlignmentVerified: true,
      }),
      dispatchProof: classifyGpuHmrDispatchProof({
        dispatchObserved: true,
        argProvenanceObserved: true,
        argProvenanceComplete: false,
        unknownArgCount: 1,
      }),
      outputProof: classifyGpuHmrOutputProof({
        dispatchObserved: true,
        deterministicOutputObserved: true,
        deterministicOracleProvided: true,
        deterministicOraclePassed: true,
      }),
      hostPreservationProof: classifyGpuHmrHostPreservationProof({
        identityChecksPassed: true,
      }),
    });

    expect(proof.resultState).toBe("gpu-hmr-abi-proven");
    expect(proof.degradedState).toBe("gpu-hmr-unknown-arg-provenance");
    expect(proof.fullRuntimeProven).toBe(false);
    expect(summarizeGpuHmrFullRuntimeProof(proof)).toContain("blocked=dispatch");
  });

  it("reports full-runtime-proven only when every required component passes", () => {
    const proof = classifyGpuHmrFullRuntimeProof({
      sourceProofs: [{ resultState: "gpu-hmr-abi-proven" }],
      abiProof: classifyGpuHmrAbiProof({
        metadataObserved: true,
        layoutSizeAlignmentVerified: true,
      }),
      dispatchProof: classifyGpuHmrDispatchProof({
        dispatchObserved: true,
        argProvenanceObserved: true,
        argProvenanceComplete: true,
      }),
      outputProof: classifyGpuHmrOutputProof({
        dispatchObserved: true,
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
      abiProof: classifyGpuHmrAbiProof({
        metadataObserved: true,
        layoutSizeAlignmentVerified: true,
      }),
      dispatchProof: classifyGpuHmrDispatchProof({
        dispatchObserved: true,
        argProvenanceObserved: true,
        argProvenanceComplete: true,
      }),
      outputProof: classifyGpuHmrOutputProof({
        dispatchObserved: true,
        deterministicOutputObserved: true,
        deterministicOracleProvided: true,
        deterministicOraclePassed: true,
      }),
      hostPreservationProof: classifyGpuHmrHostPreservationProof({
        hostReplacementObserved: true,
      }),
    });

    expect(proof.resultState).toBe("gpu-hmr-output-proven");
    expect(proof.degradedState).toBe("gpu-hmr-host-replaced");
    expect(proof.fullRuntimeProven).toBe(false);
  });
});
