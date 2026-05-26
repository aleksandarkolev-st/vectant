import { describe, expect, it } from "vitest";
import {
  classifyGpuHmrHostPreservationProof,
  classifyGpuHmrOutputProof,
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
});
