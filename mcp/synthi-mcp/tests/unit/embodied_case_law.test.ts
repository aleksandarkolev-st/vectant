import { describe, expect, it } from "vitest";
import {
  CaseLaw,
  authorizeRunWithCaseLaw,
  dialEntrustment,
  validateProofCapsule,
  type CompetencyLicense,
  type ProofCapsule,
} from "../../src/embodied/case_law.js";
import type { EntrustmentLevel } from "../../src/embodied/governance.js";

const NOW = 1_000_000;

function license(overrides: Partial<CompetencyLicense> = {}): CompetencyLicense {
  return {
    license_id: "lic-1",
    competency_id: "comp.multi",
    substrate_scope: ["terminal", "kernel"],
    realm_scopes: [
      { realm_kind: "workspace", realm_id: "w1" },
      { realm_kind: "container", realm_id: "c1" },
    ],
    entrustment: "E2_supervised",
    issued_at_ms: 0,
    expires_at_ms: NOW + 10_000,
    ...overrides,
  };
}

function capsule(overrides: Partial<ProofCapsule> = {}): ProofCapsule {
  return {
    competency_id: "comp.multi",
    evidence: [
      { substrate_kind: "terminal", realm_id: "w1", same_state_passes: 3, fresh_state_passes: 2, discrimination_proven: true },
      { substrate_kind: "kernel", realm_id: "c1", same_state_passes: 3, fresh_state_passes: 2, discrimination_proven: true },
    ],
    ...overrides,
  };
}

describe("governance unification (P5)", () => {
  it("mixed-substrate capsule validates against a single license", () => {
    const validation = validateProofCapsule(capsule(), license(), NOW);
    expect(validation.valid).toBe(true);
    if (validation.valid) {
      expect(validation.covers_all_licensed_substrates).toBe(true);
      expect(validation.promotion_eligible).toBe(true);
    }
    // Missing kernel evidence: covers nothing about promotion.
    const partial = validateProofCapsule(
      capsule({ evidence: [capsule().evidence[0]!] }),
      license(),
    );
    if (partial.valid) {
      expect(partial.covers_all_licensed_substrates).toBe(false);
      expect(partial.promotion_eligible).toBe(false);
    }
    // Wrong competency is rejected outright.
    const mismatch = validateProofCapsule(capsule({ competency_id: "other" }), license());
    expect(mismatch.valid).toBe(false);
  });

  it("entrustment dial promotes only with full evidence; demotion is immediate", () => {
    const base = license();
    const promoted = dialEntrustment(base, capsule(), "promote", NOW);
    expect(promoted.entrustment).toBe("E3_sandboxed_action");
    // Demote immediately back.
    const demoted = dialEntrustment(promoted, capsule(), "demote");
    expect(demoted.entrustment).toBe("E2_supervised");
    // Incomplete capsule blocks promotion.
    const blocked = dialEntrustment(base, capsule({ evidence: [] }), "promote");
    expect(blocked.entrustment).toBe("E2_supervised");
    // E4 is the ceiling.
    let current = base;
    for (let i = 0; i < 5; i += 1) current = dialEntrustment(current, capsule(), "promote", NOW);
    expect(current.entrustment).toBe<EntrustmentLevel>("E4_autonomous_action");
  });

  it("case law caps violated substrates at observe-only until re-verified", async () => {
    const caseLaw = new CaseLaw();
    const licenses = [license()];
    const request = {
      competency_id: "comp.multi",
      substrate_kind: "kernel",
      realm: { realm_kind: "container", realm_id: "c1" },
      required_level: "E2_supervised" as const,
      now: NOW,
    };

    // Before violation: authorized.
    expect(authorizeRunWithCaseLaw(licenses, caseLaw, request).authorized).toBe(true);

    // The licensed behavior later contradicted its scope on kernel.
    caseLaw.record({
      competency_id: "comp.multi",
      substrate_kind: "kernel",
      contradiction: "mutated outside the licensed namespace",
      detected_at_ms: NOW + 100,
    });

    // After the violation, the same request is refused with a human reason.
    const decision = authorizeRunWithCaseLaw(licenses, caseLaw, request);
    expect(decision.authorized).toBe(false);
    if (!decision.authorized) {
      expect(decision.human_reason).toContain("re-verified");
    }

    // Terminal substrate is untouched by the kernel violation.
    const terminalRequest = { ...request, substrate_kind: "terminal", realm: { realm_kind: "workspace", realm_id: "w1" } };
    expect(authorizeRunWithCaseLaw(licenses, caseLaw, terminalRequest).authorized).toBe(true);

    // Observe-only still works even on the violated substrate.
    const observe = { ...request, required_level: "E1_observe_only" as const };
    expect(authorizeRunWithCaseLaw(licenses, caseLaw, observe).authorized).toBe(true);
  });
});
