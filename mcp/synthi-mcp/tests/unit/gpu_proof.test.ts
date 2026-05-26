import { describe, expect, it } from "vitest";
import {
  classifyGpuHmrProofMessage,
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
    });

    expect(proof?.schemaVersion).toBe("synthi.gpu.hmr.proof.v1");
    expect(proof?.source).toBe("gpu-proof-state");
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
    expect(gpuHmrProofStateRank("gpu-hmr-dispatch-proven")).toBeGreaterThan(
      gpuHmrProofStateRank("gpu-hmr-abi-proven")
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
});
