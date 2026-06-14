import { runVitestEvidenceScenario } from "../lib/vitest_scenario.mjs";

export default {
  name: "api_fault_server",
  description: "Exercises synthetic API timeout, partial write, fake success, validation error, and downstream failure paths.",

  async run(ctx) {
    return runVitestEvidenceScenario(ctx, {
      scenarioName: this.name,
      testFiles: ["tests/integration/dojo_api_fault_server.test.ts"],
      evidenceMatchers: [
        { id: "api_timeout", aliases: ["timeout"] },
        { id: "partial_write", aliases: ["partial write"] },
        { id: "fake_success_ui", aliases: ["fake visual success", "fake success"] },
        { id: "validation_error", aliases: ["validation error"] },
        { id: "downstream_failure", aliases: ["downstream failure"] },
      ],
    });
  },
};
