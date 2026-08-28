import { describe, expect, it } from "vitest";
import { errorFromException } from "../../src/tools/shared.js";

describe("public MCP exception projection", () => {
  it.each([
    [new Error("https://user:password@provider.invalid/resource?token=secret"), "runtime_error"],
    [new TypeError("Bearer synthetic.secret.value"), "type_error"],
    [new RangeError("C:\\sensitive\\project\\artifact.bin"), "range_error"],
    ["session=synthetic-cookie", "non_error_throwable"],
  ] as const)("retains only a safe class and reference", (thrown, expectedClass) => {
    const response = errorFromException("synthetic_failure", thrown);
    const body = response.structuredContent as Record<string, unknown>;
    expect(body).toMatchObject({
      error: "synthetic_failure",
      schemaVersion: "synthi.mcp.public_error_diagnostic.v1",
      evidenceAuthority: "exception_class_only_not_runtime_or_gpu_hmr_proof",
      acceptedForGpuHmr: false,
      gpuHmrSuccess: false,
      exceptionClass: expectedClass,
      messagePresent: true,
    });
    expect(body.messageRef).toMatch(/^mcp-error-message-ref:sha256:[a-f0-9]{64}$/);
    expect(body).not.toHaveProperty("message");
    expect(JSON.stringify(response)).not.toContain(
      thrown instanceof Error ? thrown.message : thrown
    );
  });

  it("does not stringify arbitrary thrown objects", () => {
    const thrown = {
      toString(): string {
        throw new Error("must not execute attacker-controlled stringification");
      },
    };
    const body = errorFromException("synthetic_failure", thrown)
      .structuredContent as Record<string, unknown>;
    expect(body.exceptionClass).toBe("non_error_throwable");
    expect(body.messagePresent).toBe(false);
    expect(body).not.toHaveProperty("messageRef");
  });
});
