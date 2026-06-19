import { runVitestEvidenceScenario } from "../lib/vitest_scenario.mjs";

export default {
  name: "runtime_preflight_fail_closed",
  description: "Verifies production proof-gated dispatch fails closed before consuming proof when hosted runtime preflight is missing.",

  async run(ctx) {
    return runVitestEvidenceScenario(ctx, {
      scenarioName: this.name,
      testFiles: ["tests/unit/dojo_tools.test.ts"],
      evidenceMatchers: [
        {
          id: "hosted_runtime_preflight_fail_closed",
          aliases: ["hosted runtime session", "before consuming production proof capsules", "runtime session not found"],
        },
        {
          id: "proof_not_consumed_on_failed_preflight",
          aliases: ["before consuming production proof capsules", "proof not consumed"],
        },
      ],
    });
  },
};
