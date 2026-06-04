import { describe, expect, it } from "vitest";
import {
  classifyGpuHmrProofMessage,
  gpuHmrDegradedStateRankCap,
  gpuHmrProofStateRank,
  validateGpuHmrProofState,
} from "../../src/gpu_proof.js";

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
});
