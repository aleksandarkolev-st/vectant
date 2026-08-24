/**
 * LIVE corpus harness: teaches ONE generic "project introspection" workflow
 * on a reference project via the real terminal adapter, then replays it
 * across 100+ cloned real-world repos - each in fresh state. Every failure
 * is classified through the failure catalog and harvested as an edge case.
 *
 * The taught workflow (universal by construction - zero project nouns):
 *   1. write probe file            -> filesystem is writable
 *   2. read it back                -> round-trip integrity
 *   3. remove it                   -> cleanup works
 *   4. count entries at top level  -> structure observable
 * No hardcoding: nothing about any specific project appears here.
 */
import { execSync } from "node:child_process";
import { mkdirSync, rmSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  createTerminalBundle,
  allowlistPolicy,
} from "../../src/embodied/adapters/terminal/index.js";
import { classifyFailure } from "../../src/embodied/failure_catalog.js";

const CORPUS = "C:/Users/dev/Downloads/synthi-test/corpus/repos";
const LEASE = (root) => ({
  lease_id: "corpus",
  realm: { realm_kind: "workspace", realm_id: root },
  capability: "act",
  expires_at_ms: Number.MAX_SAFE_INTEGER,
});

const bundle = createTerminalBundle(allowlistPolicy(["node"]));

async function attach(root) {
  return bundle.attach({
    realm: { realm_kind: "workspace", realm_id: root },
    consent_proof: {
      subject: "corpus",
      realm: { realm_kind: "workspace", realm_id: root },
      approved_capabilities: ["observe", "record", "act"],
    },
  });
}

/** Teach once on the reference: returns the recorded fragment + expected hash. */
export async function teachIntrospection(referenceRoot) {
  const handle = await attach(referenceRoot);
  bundle.recorder.beginRecord(handle);
  const steps = [
    `node -e require('fs').writeFileSync('.synthi_probe','live')`,
    `node -e require('fs').readFileSync('.synthi_probe','utf8')`,
    `node -e require('fs').unlinkSync('.synthi_probe')`,
  ];
  for (const run of steps) {
    const result = await bundle.actor.act(handle, { run }, LEASE(referenceRoot));
    if (!result.ok) throw new Error(`teach failed on reference: ${run}: ${result.refusal_reason}`);
  }
  const fragment = bundle.recorder.endRecord(handle);
  return { fragment };
}

/** Replay the taught flow into one project (fresh state), classify outcomes. */
export async function replayOnProject(repoDir, fragment) {
  const outcome = {
    repo: repoDir,
    ok: false,
    step_results: [],
    edge_cases: [],
    top_level_entries: 0,
  };
  let handle;
  try {
    handle = await attach(repoDir);
    if (!existsSync(join(repoDir, ".git"))) {
      outcome.edge_cases.push({ repo: repoDir, trunk: "test_data_missing", detail: "no .git directory" });
      return outcome;
    }
    outcome.top_level_entries = readdirSync(repoDir).length;

    // The taught fragment's steps run through the adapter's replay provider:
    // fresh_state mode executes each recorded step against this project.
    const replay = await bundle.replay_provider.replay(fragment, { handle, mode: "fresh_state" });
    outcome.step_results = replay.step_results.map((step) => ({
      index: step.step_index,
      ok: step.ok,
      trunk: step.classifier_trunk ?? null,
    }));
    for (const step of replay.step_results) {
      if (!step.ok) {
        const classified = classifyFailure("terminal", step.classifier_trunk === "load_delay" ? "terminal.prompt_desync" : "terminal.nonzero_exit");
        outcome.edge_cases.push({
          repo: repoDir,
          step: step.step_index,
          trunk: classified.trunk,
          subclass: classified.subclass ?? null,
          detail: step.detail ? JSON.stringify(step.detail).slice(0, 200) : "replay step failed",
        });
      }
    }
    outcome.ok = replay.ok;
  } catch (error) {
    const classified = classifyFailure("terminal", "terminal.nonzero_exit");
    outcome.edge_cases.push({ repo: repoDir, trunk: classified.trunk, detail: String(error).slice(0, 200) });
  } finally {
    if (handle?.environment?.root && existsSync(join(handle.environment.root, ".synthi_probe"))) {
      rmSync(join(handle.environment.root, ".synthi_probe"));
    }
  }
  return outcome;
}


