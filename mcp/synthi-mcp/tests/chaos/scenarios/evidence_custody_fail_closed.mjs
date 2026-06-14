import { runVitestEvidenceScenario } from "../lib/vitest_scenario.mjs";

export default {
  name: "evidence_custody_fail_closed",
  description: "Verifies evidence writer, ledger-backed checkride, and signature custody failures block unsafe Dojo execution.",

  async run(ctx) {
    return runVitestEvidenceScenario(ctx, {
      scenarioName: this.name,
      testFiles: [
        "tests/unit/dojo_evidence_record.test.ts",
        "tests/unit/dojo_graph_runtime.test.ts",
        "tests/integration/dojo_checkride_runner.test.ts",
      ],
      evidenceMatchers: [
        { id: "evidence_signature_unavailable", aliases: ["required evidence signature is unavailable"] },
        { id: "graph_evidence_store_unavailable", aliases: ["evidence writing fails"] },
        { id: "graph_evidence_ref_unbacked", aliases: ["evidence writer does not return a ledger-backed ref"] },
        { id: "checkride_ledger_unavailable", aliases: ["ledger-backed checkride evidence is required but unavailable"] },
      ],
    });
  },
};
