import { runVitestEvidenceScenario } from "../lib/vitest_scenario.mjs";

export default {
  name: "proof_signing_outage",
  description: "Verifies proof signing service and managed-key custody failures fail closed.",

  async run(ctx) {
    return runVitestEvidenceScenario(ctx, {
      scenarioName: this.name,
      testFiles: ["tests/unit/dojo_proof_signing.test.ts"],
      evidenceMatchers: [
        { id: "proof_signing_service_unavailable", aliases: ["external command signer exits", "kms unavailable"] },
        { id: "managed_key_custody_mismatch", aliases: ["managed key service returns mismatched custody metadata"] },
      ],
    });
  },
};
