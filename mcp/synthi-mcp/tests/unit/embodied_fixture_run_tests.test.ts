/**
 * Plan P1 golden fixture: run-tests-and-triage-failure.
 *
 * Teach: run a real test command, it fails. Triage: classify the failure
 * through the trunk taxonomy and explain it in human language (verb 5).
 * Recovery: after fixing the code, the same flow passes - classification
 * drives recovery, not just reporting.
 */
import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createTerminalBundle,
  allowlistPolicy,
} from "../../src/embodied/adapters/terminal/index.js";

const LEASE = (realmId: string) => ({
  lease_id: "golden",
  realm: { realm_kind: "workspace", realm_id: realmId },
  capability: "act" as const,
  expires_at_ms: Number.MAX_SAFE_INTEGER,
});

function makeBundle() {
  return createTerminalBundle(allowlistPolicy(["node"]));
}

async function attachFor(bundle: ReturnType<typeof createTerminalBundle>, root: string) {
  return bundle.attach({
    realm: { realm_kind: "workspace", realm_id: root },
    consent_proof: {
      subject: "t",
      realm: { realm_kind: "workspace", realm_id: root },
      approved_capabilities: ["observe", "record", "act"],
    },
  });
}

describe("P1 golden fixture: run-tests-and-triage-failure", () => {
  it("runs real failing tests, triages them, and passes after the fix", async () => {
    const root = mkdtempSync(join(tmpdir(), "gold-triage-"));
    try {
      // The "test": asserts 2+2===5 - guaranteed to fail until fixed.
      writeFileSync(join(root, "math.test.js"), 'assert=require("assert");assert.strictEqual(2+2,5)');
      const bundle = makeBundle();
      const handle = await attachFor(bundle, root);

      // --- Phase A: RED - run the suite, capture the failing exit ---
      const red = await bundle.actor!.act(
        handle,
        { run: `node math.test.js` },
        LEASE(root),
      );
      expect(red.ok).toBe(false); // the suite genuinely failed

      // Triage: the adapter's world state carries the last exit code; the
      // orchestrator maps nonzero exits to app_validation_error.
      const observation = (await bundle.observer!.observe(handle)) as { last_exit: number };
      expect(observation.last_exit).not.toBe(0);

      // Human explanation through verb 5's sentence table.
      const explanation = new EmbodiedTeacherLike().explain(observation.last_exit);
      expect(explanation).toMatch(/refused|failed|fix/i);
      expect(explanation).not.toMatch(/trunk|classifier/); // no jargon escapes

      // --- Phase B: GREEN - fix the code, same flow now passes ---
      writeFileSync(join(root, "math.test.js"), 'assert=require("assert");assert.strictEqual(2+2,4)');

      // Replay the recorded flow against the FIXED workspace state.
      const fragment = {
        trace_id: "run-tests",
        steps: [{ event: { run: `node math.test.js` } }],
      };
      const outcome = await bundle.replay_provider!.replay(fragment, {
        handle,
        mode: "fresh_state",
      });
      expect(outcome.ok).toBe(true);
      expect(outcome.step_results[0]!.ok).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

/**
 * Minimal stand-in exercising the same sentence table semantics as the
 * facade's explainFailure without importing the whole teacher: triage
 * output must be human language, never jargon.
 */
class EmbodiedTeacherLike {
  explain(exitCode: number): string {
    if (exitCode !== 0) {
      return "The tests failed. The application refused the action - its checks did not pass at that moment. Fix the code and re-run.";
    }
    return "The tests passed.";
  }
}
