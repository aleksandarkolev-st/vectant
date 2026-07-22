import { describe, expect, it } from "vitest";
import {
  GPU_HMR_COMPUTE_OUTPUT_ORACLE_KINDS as SCRIPT_COMPUTE_KINDS,
  GPU_HMR_OUTPUT_ORACLE_MODALITIES as SCRIPT_MODALITIES,
  GPU_HMR_VISUAL_OUTPUT_ORACLE_KINDS as SCRIPT_VISUAL_KINDS,
  classifyGpuHmrOutputOracleKind as classifyScriptKind,
  isGpuHmrComputeOutputOracleKind as isScriptComputeKind,
  isGpuHmrVisualOutputOracleKind as isScriptVisualKind,
} from "../../scripts/lib/gpu-hmr-output-oracle-kind.mjs";
import {
  GPU_HMR_COMPUTE_OUTPUT_ORACLE_KINDS,
  GPU_HMR_OUTPUT_ORACLE_MODALITIES,
  GPU_HMR_VISUAL_OUTPUT_ORACLE_KINDS,
  classifyGpuHmrOutputOracleKind,
  isGpuHmrComputeOutputOracleKind,
  isGpuHmrVisualOutputOracleKind,
} from "../../src/gpu_output_oracle_kind.js";

describe("GPU HMR output oracle kind registry", () => {
  it("stays identical across TypeScript and script validators", () => {
    expect(GPU_HMR_COMPUTE_OUTPUT_ORACLE_KINDS).toEqual(SCRIPT_COMPUTE_KINDS);
    expect(GPU_HMR_VISUAL_OUTPUT_ORACLE_KINDS).toEqual(SCRIPT_VISUAL_KINDS);

    for (const kind of [
      ...GPU_HMR_COMPUTE_OUTPUT_ORACLE_KINDS,
      ...GPU_HMR_VISUAL_OUTPUT_ORACLE_KINDS,
      "unknown_oracle_mechanism",
      "",
      null,
      undefined,
      42,
      {},
    ]) {
      expect(classifyGpuHmrOutputOracleKind(kind)).toEqual(classifyScriptKind(kind));
      expect(isGpuHmrComputeOutputOracleKind(kind)).toBe(isScriptComputeKind(kind));
      expect(isGpuHmrVisualOutputOracleKind(kind)).toBe(isScriptVisualKind(kind));
    }
  });

  it("keeps exported registry data immutable at runtime", () => {
    expect(GPU_HMR_OUTPUT_ORACLE_MODALITIES).toEqual(SCRIPT_MODALITIES);
    expect(Object.isFrozen(GPU_HMR_OUTPUT_ORACLE_MODALITIES)).toBe(true);
    expect(Object.isFrozen(GPU_HMR_COMPUTE_OUTPUT_ORACLE_KINDS)).toBe(true);
    expect(Object.isFrozen(GPU_HMR_VISUAL_OUTPUT_ORACLE_KINDS)).toBe(true);
    expect(Reflect.set(GPU_HMR_OUTPUT_ORACLE_MODALITIES, "compute", "forged")).toBe(false);
    expect(GPU_HMR_OUTPUT_ORACLE_MODALITIES.compute).toBe("compute_oracle");
  });

  it("does not infer proof modality from architecture-like words", () => {
    for (const kind of [
      "project_visual",
      "profile_render",
      "fixture_frame",
      "vendor_compute",
      "pipeline_pixel_output",
    ]) {
      expect(classifyGpuHmrOutputOracleKind(kind)).toMatchObject({
        accepted: false,
        modality: null,
        failureCode: "output_oracle_kind_unknown",
      });
    }
  });
});
