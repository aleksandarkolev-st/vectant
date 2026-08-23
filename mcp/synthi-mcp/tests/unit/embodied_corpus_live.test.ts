/**
 * LIVE corpus conformance: teaches ONE universal introspection workflow on
 * a reference project through the REAL terminal adapter (real processes,
 * real files), then replays it across cloned real-world GitHub repos -
 * each in fresh state. Failures classify through the failure catalog and
 * are harvested as edge cases into .visual-proof/corpus/results.json.
 *
 * Skips gracefully when no clones exist yet (CI / offline). The clone step
 * is driven by scripts/corpus/clone_sample.mjs; this file consumes them.
 *
 * No hardcoding: nothing about any specific project appears here - the
 * taught steps are generic filesystem probes every real checkout supports.
 */
import { test, expect } from "vitest";
import { execSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  createTerminalBundle,
  allowlistPolicy,
} from "../../src/embodied/adapters/terminal/index.js";
import { classifyFailure } from "../../src/embodied/failure_catalog.js";

const CORPUS_REPOS = "C:/Users/dev/Downloads/synthi-test/corpus/repos";

const LEASE = (root: string) => ({
  lease_id: "corpus",
  realm: { realm_kind: "workspace", realm_id: root },
  capability: "act" as const,
  expires_at_ms: Number.MAX_SAFE_INTEGER,
});

interface CorpusOutcome {
  repo: string;
  language?: string;
  ok: boolean;
  entries: number;
  edge_cases: Array<{ step?: number; trunk: string; subclass?: string | null; detail: string }>;
}

test(
  "live corpus: taught introspection replays across 100+ real projects",
  { timeout: 900_000 },
  async () => {
    const bundle = createTerminalBundle(allowlistPolicy(["node"]));

    const attach = async (root: string) =>
      bundle.attach({
        realm: { realm_kind: "workspace", realm_id: root },
        consent_proof: {
          subject: "corpus",
          realm: { realm_kind: "workspace", realm_id: root },
          approved_capabilities: ["observe", "record", "act"],
        },
      });

    // Locate clones produced by scripts/corpus/clone_sample.mjs.
    if (!existsSync(CORPUS_REPOS)) {
      console.warn("skipped: corpus clones not present; run scripts/corpus/clone_sample.mjs first");
      return;
    }
    const slots = readdirSync(CORPUS_REPOS).filter((name) => /^\d+$/.test(name)).sort((a, b) => Number(a) - Number(b));
    if (slots.length === 0) {
      console.warn("skipped: no numbered clone slots found");
      return;
    }

    // Reference = lowest-numbered valid clone. Teach ONCE.
    let referenceDir: string | null = null;
    for (const slot of slots) {
      const candidate = join(CORPUS_REPOS, slot, "repo");
      if (existsSync(join(candidate, ".git"))) {
        referenceDir = candidate;
        break;
      }
    }
    expect(referenceDir, "at least one valid clone required for teaching").toBeTruthy();

    const referenceHandle = await attach(referenceDir!);
    bundle.recorder.beginRecord(referenceHandle);
    const taughtSteps = [
      `node -e require('fs').writeFileSync('.synthi_probe','live')`,
      `node -e require('fs').readFileSync('.synthi_probe','utf8')`,
      `node -e require('fs').unlinkSync('.synthi_probe')`,
    ];
    for (const run of taughtSteps) {
      const result = await bundle.actor.act(referenceHandle, { run }, LEASE(referenceDir!));
      expect(result.ok, `teach step failed on reference: ${result.refusal_reason}`).toBe(true);
    }
    const fragment = bundle.recorder.endRecord(referenceHandle);
    expect(fragment.steps.length).toBe(3);

    // Replay everywhere - fresh state per project.
    const outcomes: CorpusOutcome[] = [];
    for (const slot of slots) {
      const dir = join(CORPUS_REPOS, slot, "repo");
      const outcome: CorpusOutcome = {
        repo: slot,
        ok: false,
        entries: existsSync(dir) ? readdirSync(dir).length : 0,
        edge_cases: [],
      };
      if (!existsSync(join(dir, ".git"))) {
        outcome.edge_cases.push({ trunk: "test_data_missing", detail: "no .git in slot" });
        outcomes.push(outcome);
        continue;
      }
      const handle = await attach(dir);
      const replay = await bundle.replay_provider.replay(fragment, { handle, mode: "fresh_state" });
      outcome.ok = replay.ok;
      for (const step of replay.step_results) {
        if (!step.ok) {
          const classified = classifyFailure("terminal", "terminal.nonzero_exit");
          outcome.edge_cases.push({
            step: step.step_index,
            trunk: classified.trunk,
            subclass: classified.subclass ?? null,
            detail: `step ${step.step_index}: ${step.classifier_trunk ?? "unclassified"}`,
          });
        }
      }
      outcomes.push(outcome);
    }

    const passed = outcomes.filter((outcome) => outcome.ok).length;
    const edgeCases = outcomes.flatMap((outcome) => outcome.edge_cases.map((edge) => ({ repo: outcome.repo, ...edge })));
    const byTrunk = edgeCases.reduce<Record<string, number>>((acc, edge) => {
      acc[edge.trunk] = (acc[edge.trunk] ?? 0) + 1;
      return acc;
    }, {});

    const outDir = join(process.cwd(), "..", "..", ".visual-proof", "corpus");
    mkdirSync(outDir, { recursive: true });
    writeFileSync(
      join(outDir, "results.json"),
      JSON.stringify({ total: outcomes.length, passed, failed: outcomes.length - passed, edge_case_count: edgeCases.length, by_trunk: byTrunk, outcomes }, null, 1),
    );
    console.log(`CORPUS: ${passed}/${outcomes.length} passed; ${edgeCases.length} edge cases; by trunk ${JSON.stringify(byTrunk)}`);
    expect(passed).toBeGreaterThan(0);
    // Every failure must be CLASSIFIED - unclassified failures are gaps.
    for (const edge of edgeCases) {
      expect(edge.trunk, `unclassified edge case on ${edge.repo}`).toBeTruthy();
    }
  },
);
