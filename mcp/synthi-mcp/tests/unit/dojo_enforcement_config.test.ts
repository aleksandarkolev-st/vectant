import { describe, expect, it } from "vitest";
import {
  DOJO_DEFAULT_LOCAL_PROOF_SIGNING_KEY,
  isDojoDefaultLocalProofSigningKey,
  resolveDojoEnforcementConfig,
} from "../../src/dojo/config/enforcement.js";

describe("Dojo production enforcement config", () => {
  it("defaults to development compatibility semantics", () => {
    expect(resolveDojoEnforcementConfig({})).toEqual(expect.objectContaining({
      schema_version: "synthi.dojo.enforcementConfig.v1",
      enforcement_mode: "development",
      production_enforcement: false,
      require_durable_store: false,
      require_external_signing: false,
      require_evidence_ledger: false,
      configured_env: [],
      invalid_env: [],
    }));
  });

  it("parses explicit production flags", () => {
    expect(resolveDojoEnforcementConfig({
      SYNTHI_DOJO_PRODUCTION_ENFORCEMENT: "1",
      SYNTHI_DOJO_REQUIRE_DURABLE_STORE: "true",
      SYNTHI_DOJO_REQUIRE_EXTERNAL_SIGNING: "yes",
      SYNTHI_DOJO_REQUIRE_EVIDENCE_LEDGER: "on",
    })).toEqual(expect.objectContaining({
      enforcement_mode: "production",
      production_enforcement: true,
      require_durable_store: true,
      require_external_signing: true,
      require_evidence_ledger: true,
      invalid_env: [],
    }));
  });

  it("reports invalid boolean values without silently enabling production", () => {
    const config = resolveDojoEnforcementConfig({
      SYNTHI_DOJO_PRODUCTION_ENFORCEMENT: "definitely",
    });

    expect(config.production_enforcement).toBe(false);
    expect(config.enforcement_mode).toBe("development");
    expect(config.invalid_env).toEqual([
      expect.objectContaining({
        name: "SYNTHI_DOJO_PRODUCTION_ENFORCEMENT",
        value: "definitely",
        accepted_values: expect.arrayContaining(["1", "0", "true", "false"]),
      }),
    ]);
  });

  it("detects the default local proof signing key", () => {
    expect(isDojoDefaultLocalProofSigningKey({})).toBe(true);
    expect(isDojoDefaultLocalProofSigningKey({
      SYNTHI_DOJO_PROOF_SIGNING_KEY: DOJO_DEFAULT_LOCAL_PROOF_SIGNING_KEY,
    })).toBe(true);
    expect(isDojoDefaultLocalProofSigningKey({
      SYNTHI_DOJO_PROOF_SIGNING_KEY: "prod-specific-signing-secret",
    })).toBe(false);
  });
});
