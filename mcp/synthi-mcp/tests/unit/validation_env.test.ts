import { describe, expect, it } from "vitest";
import { positiveIntegerFromEnv } from "../../scripts/lib/validation-env.mjs";

describe("validation env helpers", () => {
  it("returns the default for missing or blank values", () => {
    expect(positiveIntegerFromEnv({}, "TIMEOUT_MS", 30_000)).toBe(30_000);
    expect(positiveIntegerFromEnv({ TIMEOUT_MS: " " }, "TIMEOUT_MS", 30_000)).toBe(30_000);
  });

  it("parses explicit positive integer values", () => {
    expect(positiveIntegerFromEnv({ TIMEOUT_MS: "1200000" }, "TIMEOUT_MS", 30_000)).toBe(1_200_000);
  });

  it("rejects invalid configured values", () => {
    expect(() => positiveIntegerFromEnv({ TIMEOUT_MS: "0" }, "TIMEOUT_MS", 30_000)).toThrow(/TIMEOUT_MS/);
    expect(() => positiveIntegerFromEnv({ TIMEOUT_MS: "12.5" }, "TIMEOUT_MS", 30_000)).toThrow(/TIMEOUT_MS/);
    expect(() => positiveIntegerFromEnv({ TIMEOUT_MS: "abc" }, "TIMEOUT_MS", 30_000)).toThrow(/TIMEOUT_MS/);
  });

  it("rejects invalid defaults", () => {
    expect(() => positiveIntegerFromEnv({}, "TIMEOUT_MS", 0)).toThrow(/invalid default/);
  });
});
