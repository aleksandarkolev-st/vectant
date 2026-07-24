import { createHash } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import {
  claimGpuMcpOutputEvaluatorExecutorCapability,
  createGpuMcpOutputEvaluatorBoundary,
  gpuMcpOutputEvaluatorMaterial,
  releaseGpuMcpOutputEvaluatorExecutorClaim,
  snapshotGpuMcpOutputEvaluatorMaterialBytes,
  type GpuMcpOutputEvaluator,
} from "../../src/gpu_mcp_output_evaluation.js";
import {
  executeGpuMcpOutputEvaluatorInFreshProcess,
  executeReopenedGpuMcpOutputEvaluatorMaterialInFreshProcess,
  GPU_MCP_OUTPUT_EVALUATOR_FRESH_PROCESS_EXECUTION_AUTHORITY,
  GPU_MCP_OUTPUT_EVALUATOR_FRESH_PROCESS_EXECUTION_SCHEMA,
} from "../../src/gpu_mcp_output_evaluator_fresh_process.js";

const evaluatorRegistrars = new Set<Readonly<{ dispose(): boolean }>>();

function hash(digit: string): string {
  return `sha256:${digit.repeat(64)}`;
}

function fixture(
  evaluate: GpuMcpOutputEvaluator,
  output = Uint8Array.from([17, 19, 23, 29]),
) {
  const evaluatorBoundary = createGpuMcpOutputEvaluatorBoundary();
  evaluatorRegistrars.add(evaluatorBoundary.registrar);
  const evaluator = evaluatorBoundary.registrar.register({
    outputContractSha256: hash("a"),
    outputSemanticsSha256: hash("b"),
    evaluate,
  });
  return {
    evaluator,
    executor: evaluatorBoundary.executor,
    output,
  };
}

afterEach(() => {
  for (const registrar of evaluatorRegistrars) registrar.dispose();
  evaluatorRegistrars.clear();
});

describe("fresh-process GPU MCP output evaluator", () => {
  it("re-executes exact evaluator material without parent closure authority", async () => {
    const {
      evaluator,
      output,
    } = fixture(
      (bytes) => bytes[0] === 17 && bytes[3] === 29,
    );

    const execution = await executeGpuMcpOutputEvaluatorInFreshProcess(
      evaluator,
      output,
    );

    expect(execution).toMatchObject({
      schemaVersion:
        GPU_MCP_OUTPUT_EVALUATOR_FRESH_PROCESS_EXECUTION_SCHEMA,
      proofAuthority:
        GPU_MCP_OUTPUT_EVALUATOR_FRESH_PROCESS_EXECUTION_AUTHORITY,
      outputContentSha256:
        `sha256:${createHash("sha256").update(output).digest("hex")}`,
      outputByteLength: "4",
      executionEntrypointSha256:
        expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
      executionGraphHash:
        expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
      processObservationHash:
        expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
      resultContentSha256:
        expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
      outputContractPassed: true,
      freshProcessExecutionObserved: true,
      parentClosureUnavailable: true,
      staticExecutionGraphVerified: true,
      loadedGraphIdentityAttested: false,
      loadedGraphIdentityGap:
        "runtime_loaded_graph_identity_attestation_missing",
      isolatedExecutionVerified: false,
      containerAttestationVerified: false,
      acceptedForGpuHmr: false,
      gpuHmrSuccess: false,
      canSatisfyRuntimeProof: false,
    });
    expect(Object.isFrozen(execution)).toBe(true);
    expect(execution).not.toHaveProperty("receiptId");
    expect(execution).not.toHaveProperty("admissionReceiptId");
    expect(execution).not.toHaveProperty("outputObservationReceiptId");
    expect(JSON.stringify(execution)).not.toMatch(
      /project|fixture|scenario|backend|camera|image|tensor|media/i,
    );
  });

  it("re-executes independently reopened evaluator material bytes", async () => {
    const {
      evaluator,
      executor,
      output,
    } = fixture(
      (bytes) => bytes[0] === 17 && bytes[2] === 23,
    );
    const material = gpuMcpOutputEvaluatorMaterial(evaluator);
    const materialBytes =
      snapshotGpuMcpOutputEvaluatorMaterialBytes(evaluator);
    expect(material).not.toBeNull();
    expect(materialBytes).not.toBeNull();
    if (material === null || materialBytes === null) {
      throw new Error("test_evaluator_material_missing");
    }
    const executorClaim =
      claimGpuMcpOutputEvaluatorExecutorCapability(executor);
    expect(executorClaim).not.toBeNull();
    if (executorClaim === null) {
      throw new Error("test_evaluator_executor_claim_missing");
    }

    const execution = await (
      executeReopenedGpuMcpOutputEvaluatorMaterialInFreshProcess(
        executorClaim,
        evaluator,
        materialBytes,
        output,
      )
    ).finally(() => {
      releaseGpuMcpOutputEvaluatorExecutorClaim(executorClaim);
    });

    expect(execution).toMatchObject({
      evaluatorMaterialSha256: material.materialSha256,
      evaluatorMaterialByteLength: material.materialByteLength,
      evaluatorFunctionSourceSha256:
        material.evaluatorFunctionSourceSha256,
      evaluatorSourceSha256: material.evaluatorSourceSha256,
      outputContractSha256: material.outputContractSha256,
      outputSemanticsSha256: material.outputSemanticsSha256,
      outputContractPassed: true,
      acceptedForGpuHmr: false,
      gpuHmrSuccess: false,
      canSatisfyRuntimeProof: false,
    });
    expect(
      `sha256:${createHash("sha256").update(materialBytes).digest("hex")}`,
    ).toBe(material.materialSha256);
  });

  it("rejects altered reopened evaluator material bytes", async () => {
    const {
      evaluator,
      executor,
      output,
    } = fixture(() => true);
    const materialBytes =
      snapshotGpuMcpOutputEvaluatorMaterialBytes(evaluator);
    expect(materialBytes).not.toBeNull();
    if (materialBytes === null) {
      throw new Error("test_evaluator_material_missing");
    }
    const altered = materialBytes.slice();
    altered[altered.byteLength - 1] ^= 1;
    const executorClaim =
      claimGpuMcpOutputEvaluatorExecutorCapability(executor);
    expect(executorClaim).not.toBeNull();
    if (executorClaim === null) {
      throw new Error("test_evaluator_executor_claim_missing");
    }

    await expect((
      executeReopenedGpuMcpOutputEvaluatorMaterialInFreshProcess(
        executorClaim,
        evaluator,
        altered,
        output,
      )
    ).finally(() => {
      releaseGpuMcpOutputEvaluatorExecutorClaim(executorClaim);
    }),
    ).rejects.toThrow(
      "gpu_mcp_output_evaluator_fresh_process_material_invalid",
    );
  });

  it("rejects self-consistent material from another evaluator boundary", async () => {
    const original = fixture(() => true);
    const foreign = fixture(() => false);
    const foreignMaterialBytes =
      snapshotGpuMcpOutputEvaluatorMaterialBytes(foreign.evaluator);
    expect(foreignMaterialBytes).not.toBeNull();
    if (foreignMaterialBytes === null) {
      throw new Error("test_evaluator_material_missing");
    }
    const executorClaim =
      claimGpuMcpOutputEvaluatorExecutorCapability(original.executor);
    expect(executorClaim).not.toBeNull();
    if (executorClaim === null) {
      throw new Error("test_evaluator_executor_claim_missing");
    }

    await expect((
      executeReopenedGpuMcpOutputEvaluatorMaterialInFreshProcess(
        executorClaim,
        original.evaluator,
        foreignMaterialBytes,
        original.output,
      )
    ).finally(() => {
      releaseGpuMcpOutputEvaluatorExecutorClaim(executorClaim);
    }),
    ).rejects.toThrow(
      "gpu_mcp_output_evaluator_fresh_process_material_binding_mismatch",
    );
  });

  it("retains a false evaluator verdict as support-only evidence", async () => {
    const {
      evaluator,
      output,
    } = fixture(() => false);

    const execution = await executeGpuMcpOutputEvaluatorInFreshProcess(
      evaluator,
      output,
      {},
    );

    expect(execution.outputContractPassed).toBe(false);
    expect(execution.acceptedForGpuHmr).toBe(false);
    expect(execution.gpuHmrSuccess).toBe(false);
  });

  it("refuses evaluator closures that are absent in the fresh process", async () => {
    const expectedFirstByte = 17;
    const {
      evaluator,
      output,
    } = fixture(
      (bytes) => bytes[0] === expectedFirstByte,
    );

    await expect(executeGpuMcpOutputEvaluatorInFreshProcess(
      evaluator,
      output,
    )).rejects.toThrow(
      "gpu_mcp_output_evaluator_fresh_process_failed",
    );
  });

  it("refuses prohibited runtime-loader mechanics", async () => {
    const evaluate = (0, eval)(
      "(async () => { await import('node:child_process'); return true; })",
    ) as GpuMcpOutputEvaluator;
    const {
      evaluator,
      output,
    } = fixture(evaluate);

    await expect(executeGpuMcpOutputEvaluatorInFreshProcess(
      evaluator,
      output,
    )).rejects.toThrow(/controlled_graph_alternate_loader_refused/);
  });

  it("refuses evaluator mutation of the observed byte snapshot", async () => {
    const {
      evaluator,
      output,
    } = fixture((bytes) => {
      bytes[0] = 0;
      return true;
    });

    await expect(executeGpuMcpOutputEvaluatorInFreshProcess(
      evaluator,
      output,
    )).rejects.toThrow(
      "gpu_mcp_output_evaluator_fresh_process_failed",
    );
    expect([...output]).toEqual([17, 19, 23, 29]);
  });

  it("retains mutation detection after typed-array prototype poisoning", async () => {
    const {
      evaluator,
      output,
    } = fixture((bytes) => {
      Object.defineProperty(Uint8Array.prototype, "every", {
        configurable: true,
        value: () => true,
      });
      Object.defineProperty(Uint8Array.prototype, "at", {
        configurable: true,
        value: () => bytes[0],
      });
      bytes[0] = 0;
      return true;
    });

    await expect(executeGpuMcpOutputEvaluatorInFreshProcess(
      evaluator,
      output,
    )).rejects.toThrow(
      "gpu_mcp_output_evaluator_fresh_process_failed",
    );
  });

  it("terminates an evaluator that exceeds the bounded process lifetime", async () => {
    const {
      evaluator,
      output,
    } = fixture(() => {
      for (;;) {
        // Deliberately never settles.
      }
    });

    await expect(executeGpuMcpOutputEvaluatorInFreshProcess(
      evaluator,
      output,
      { timeoutMs: 100 },
    )).rejects.toThrow(
      "gpu_mcp_output_evaluator_fresh_process_timed_out",
    );
  });

  it("does not permit process preload injection from the parent environment", async () => {
    const previousNodeOptions = process.env.NODE_OPTIONS;
    process.env.NODE_OPTIONS = "--require=definitely-not-a-real-module";
    try {
      const {
        evaluator,
        output,
      } = fixture(() => true);

      const execution = await executeGpuMcpOutputEvaluatorInFreshProcess(
        evaluator,
        output,
      );

      expect(execution.outputContractPassed).toBe(true);
      expect(execution.isolatedExecutionVerified).toBe(false);
    } finally {
      if (previousNodeOptions === undefined) {
        delete process.env.NODE_OPTIONS;
      } else {
        process.env.NODE_OPTIONS = previousNodeOptions;
      }
    }
  });

});
