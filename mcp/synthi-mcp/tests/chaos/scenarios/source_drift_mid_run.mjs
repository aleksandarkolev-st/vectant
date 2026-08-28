import { runVitestEvidenceScenario } from "../lib/vitest_scenario.mjs";

export default {
  name: "source_drift_mid_run",
  description: "Verifies source contract drift expires affected licenses and blocks graph execution through active expiry triggers.",

  async run(ctx) {
    return runVitestEvidenceScenario(ctx, {
      scenarioName: this.name,
      testFiles: [
        "tests/unit/dojo_source_drift.test.ts",
        "tests/unit/dojo_graph_runtime.test.ts",
      ],
      evidenceMatchers: [
        { id: "source_drift_license_expiry", aliases: ["source drift expiry", "expires graph nodes mapped to changed source tokens"] },
        { id: "source_drift_graph_block", aliases: ["one of its expiry triggers is active", "expiry trigger active source drift"] },
        { id: "source_drift_unverified_snapshot_rejected", aliases: ["tampered or unverifiable source snapshots"] },
      ],
    });
  },
};
