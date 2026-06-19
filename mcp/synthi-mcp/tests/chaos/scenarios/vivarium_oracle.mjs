import { runVitestEvidenceScenario } from "../lib/vitest_scenario.mjs";

export default {
  name: "vivarium_oracle",
  description: "Exercises deterministic synthetic fixtures and oracle classification for duplicate entities, prompt injection, and fake success.",

  async run(ctx) {
    return runVitestEvidenceScenario(ctx, {
      scenarioName: this.name,
      testFiles: [
        "tests/unit/dojo_fixture_materializer.test.ts",
        "tests/integration/dojo_vivarium_runner.test.ts",
        "tests/integration/dojo_checkride_runner.test.ts",
        "tests/integration/dojo_evil_twin_runner.test.ts",
      ],
      evidenceMatchers: [
        { id: "duplicate_entity_fixture", aliases: ["duplicate entity", "same display name"] },
        { id: "prompt_injection_fixture", aliases: ["prompt injection", "quarantined synthetic tissue"] },
        { id: "runtime_oracle_classification", aliases: ["oracle", "classifies"] },
        { id: "evil_twin_attack_hardening", aliases: ["evil twin", "attack hardening", "hardening"] },
        { id: "fake_success_ui", aliases: ["fake visual success", "fake success"] },
      ],
    });
  },
};
