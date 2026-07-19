import { describe, expect, it } from "vitest";
import {
  COMPUTE_EXPECTED_OUTPUT_SEMANTICS_SCHEMA_VERSION,
  computeExpectedOutputSemanticsHash,
  computeExpectedOutputValuesHash,
  validateComputeExpectedOutputSemantics,
  type ComputeExpectedOutputSemanticsMaterial,
} from "../../src/compute_expected_output_semantics.js";

function exactMaterial(): ComputeExpectedOutputSemanticsMaterial {
  return {
    schemaVersion: COMPUTE_EXPECTED_OUTPUT_SEMANTICS_SCHEMA_VERSION,
    comparisonMode: "exact_bytes",
    outputTargetId: "output:tensor:0",
    byteOffset: 64,
    byteLength: 16,
    dtype: "u32",
    shape: [2, 2],
    elementCount: 4,
    byteOrder: "little_endian",
    toleranceDecimal: "0",
    expectedValuesDecimal: null,
    expectedValuesHash: null,
    expectedRawHash: `sha256:${"a".repeat(64)}`,
  };
}

function numericMaterial(): ComputeExpectedOutputSemanticsMaterial {
  const values = ["0.125", "-3.5", "12", "0"];
  return {
    schemaVersion: COMPUTE_EXPECTED_OUTPUT_SEMANTICS_SCHEMA_VERSION,
    comparisonMode: "numeric_tolerance",
    outputTargetId: "output:activation:final",
    byteOffset: 0,
    byteLength: 16,
    dtype: "f32",
    shape: [4],
    elementCount: 4,
    byteOrder: "little_endian",
    toleranceDecimal: "0.001",
    expectedValuesDecimal: values,
    expectedValuesHash: computeExpectedOutputValuesHash(values),
    expectedRawHash: null,
  };
}

function contract(material: ComputeExpectedOutputSemanticsMaterial) {
  return {
    ...material,
    semanticsHash: computeExpectedOutputSemanticsHash(material),
  };
}

const F32_DOUBLE_ROUNDING_UNDERFLOW =
  "0.00000000000000000000000000000000000000000000070064923216240857435571027827709373529053130706403438956761";

describe("compute expected-output semantic commitments", () => {
  it("accepts and freezes an exact-byte semantic preimage", () => {
    const result = validateComputeExpectedOutputSemantics(contract(exactMaterial()));

    expect(result.accepted).toBe(true);
    if (!result.accepted) return;
    expect(result.value.semanticsHash).toBe(
      "sha256:cd7074de01fc4bc0fb0eab922f457e4499c886128cadff30232b7e5f6df3bdde",
    );
    expect(Object.isFrozen(result.value)).toBe(true);
    expect(Object.isFrozen(result.value.shape)).toBe(true);
  });

  it("accepts canonical decimal numeric semantics without JSON float hashing", () => {
    const material = numericMaterial();
    const result = validateComputeExpectedOutputSemantics(contract(material));

    expect(result.accepted).toBe(true);
    if (!result.accepted) return;
    expect(result.value.expectedValuesHash).toBe(
      "sha256:e793fbfcf7ce664e5632eaeee3e79cfd1fde4ee4a9db0ff6556647076f036450",
    );
    expect(result.value.semanticsHash).toBe(
      "sha256:c35711fc5f51ee39096b85a00b41df7a83d07dac706fc132dfe93719fba58c32",
    );
    expect(Object.isFrozen(result.value.expectedValuesDecimal)).toBe(true);
  });

  it.each([
    "0.000000000000000000000000000000000000000000001",
    "340282346638528859811704183484516925440",
  ])("accepts a binary64-to-binary32 boundary value (%s)", (boundaryValue) => {
    const values = [boundaryValue, "-3.5", "12", "0"];
    const material: ComputeExpectedOutputSemanticsMaterial = {
      ...numericMaterial(),
      expectedValuesDecimal: values,
      expectedValuesHash: computeExpectedOutputValuesHash(values),
    };

    expect(validateComputeExpectedOutputSemantics(contract(material)).accepted)
      .toBe(true);
  });

  it("accepts rank-zero scalar output selections", () => {
    const material: ComputeExpectedOutputSemanticsMaterial = {
      ...exactMaterial(),
      byteOffset: 0,
      byteLength: 4,
      shape: [],
      elementCount: 1,
    };

    const result = validateComputeExpectedOutputSemantics(contract(material));

    expect(result.accepted).toBe(true);
  });

  it.each([
    ["noncanonical decimal", { expectedValuesDecimal: ["0.1250", "-3.5", "12", "0"] }],
    ["dtype overflow", { dtype: "u8", expectedValuesDecimal: ["256", "1", "2", "3"] }],
    [
      "binary64-to-binary32 underflow",
      { expectedValuesDecimal: [F32_DOUBLE_ROUNDING_UNDERFLOW, "1", "2", "3"] },
    ],
    [
      "binary32 overflow",
      {
        expectedValuesDecimal: [
          "340282356779733661637539395458142568448",
          "1",
          "2",
          "3",
        ],
      },
    ],
    ["shape mismatch", { shape: [2, 3] }],
    ["unaligned byte selection", { byteOffset: 2 }],
    ["overflowing byte selection", { byteOffset: Number.MAX_SAFE_INTEGER - 15 }],
    ["unexpected field", { acceptedForGpuHmr: true }],
  ])("rejects %s even after the outer hash is recomputed", (_label, mutation) => {
    const mutated = { ...numericMaterial(), ...mutation };
    const material = {
      ...mutated,
      expectedValuesHash: Array.isArray(mutated.expectedValuesDecimal)
        ? computeExpectedOutputValuesHash(mutated.expectedValuesDecimal)
        : mutated.expectedValuesHash,
    } as ComputeExpectedOutputSemanticsMaterial;
    const result = validateComputeExpectedOutputSemantics({
      ...material,
      semanticsHash: computeExpectedOutputSemanticsHash(material),
    });
    expect(result.accepted).toBe(false);
  });

  it("rejects accessor fields before reading attacker-controlled values", () => {
    let getterCalled = false;
    const value = contract(exactMaterial()) as Record<string, unknown>;
    Object.defineProperty(value, "outputTargetId", {
      enumerable: true,
      get() {
        getterCalled = true;
        return "output:forged";
      },
    });

    expect(validateComputeExpectedOutputSemantics(value).accepted).toBe(false);
    expect(getterCalled).toBe(false);
  });

  it("rejects an own enumerable prototype key as an extra field", () => {
    const value = contract(exactMaterial()) as Record<string, unknown>;
    Object.defineProperty(value, "__proto__", {
      enumerable: true,
      configurable: true,
      writable: true,
      value: { acceptedForGpuHmr: true },
    });

    expect(Object.prototype.hasOwnProperty.call(value, "__proto__")).toBe(true);
    expect(validateComputeExpectedOutputSemantics(value)).toEqual({
      accepted: false,
      reason: "expected exact semantic-contract fields",
    });
  });
});
