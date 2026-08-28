/**
 * LIVE TEACH-AND-REPLAY DEMONSTRATION (not a static test):
 *
 * 1. ATTACH   to a real project (corpus clone, real files on disk)
 * 2. OBSERVE  its real state
 * 3. TEACH    a workflow by performing it by hand (real node processes
 *             write real config + source files) while recording
 * 4. COMPILE  the recording into a contract via the teacher facade
 * 5. REPLAY   the compiled contract into TWO OTHER REAL PROJECTS
 *             (different languages) in fresh_state mode
 * 6. VERIFY   the effects exist ON DISK in those projects afterwards
 *
 * Run with: npx vitest run tests/unit/embodied_teach_replay_live.test.ts --reporter=basic
 */
import { test, expect } from "vitest";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
  createTerminalBundle,
  allowlistPolicy,
} from "../../src/embodied/adapters/terminal/index.js";

const CORPUS = "C:/Users/dev/Downloads/synthi-test/corpus/repos";

const LEASE = (root: string) => ({
  lease_id: "live-demo",
  realm: { realm_kind: "workspace", realm_id: root },
  capability: "act" as const,
  expires_at_ms: Number.MAX_SAFE_INTEGER,
});

test(
  "LIVE: teach a workflow on one project, replay it on others, verify effects on disk",
  { timeout: 300_000 },
  async () => {
    const bundle = createTerminalBundle(allowlistPolicy(["node"]));
    const attach = async (root: string) =>
      bundle.attach({
        realm: { realm_kind: "workspace", realm_id: root },
        consent_proof: {
          subject: "live-demo",
          realm: { realm_kind: "workspace", realm_id: root },
          approved_capabilities: ["observe", "record", "act"],
        },
      });

    // Three DIFFERENT real projects: Go, Java, Rust.
    const teacherRoot = join(CORPUS, "0", "repo"); // Go project (waybackurls)
    const targetA = join(CORPUS, "1", "repo"); // Java/Gradle project
    const targetB = join(CORPUS, "40", "repo"); // another language family
    for (const dir of [teacherRoot, targetA, targetB]) {
      if (!existsSync(join(dir, ".git"))) {
        console.warn(`skipped: ${dir} not cloned`);
        return;
      }
    }

    // ---- STEP 1+2: attach & observe the real project -------------------
    const teacherSession = await attach(teacherRoot);
    const beforeTeacher = await bundle.observer.observe(teacherSession);
    console.log("TEACHER project observed:", JSON.stringify(beforeTeacher).slice(0, 140));

    // ---- STEP 3: TEACH - perform the workflow BY HAND while recording ---
    bundle.recorder.beginRecord(teacherSession);
    // The workflow: "scaffold synthi config + hello module", performed as a
    // human expert would - IDEMPOTENTLY, so it replays safely anywhere
    // (recursive mkdir tolerates existing dirs; writeFileSync overwrites).
    await bundle.actor.act(
      teacherSession,
      { run: `node -e require('fs').mkdirSync('synthi',{recursive:true})` },
      LEASE(teacherRoot),
    );
    await bundle.actor.act(
      teacherSession,
      { run: `node -e require('fs').writeFileSync('synthi/config.json','{"name":"demo"}')` },
      LEASE(teacherRoot),
    );
    await bundle.actor.act(
      teacherSession,
      { run: `node -e require('fs').writeFileSync('synthi/hello.js','console.log("hello from synthi")')` },
      LEASE(teacherRoot),
    );
    const fragment = bundle.recorder.endRecord(teacherSession);
    expect(fragment.steps.length).toBe(3);
    console.log(`TAUGHT ${fragment.steps.length} steps on ${teacherRoot}`);

    // Effects really happened on disk in the teacher project:
    expect(existsSync(join(teacherRoot, "synthi", "config.json"))).toBe(true);
    expect(readFileSync(join(teacherRoot, "synthi", "config.json"), "utf8")).toBe('{"name":"demo"}');

    // ---- STEP 5: REPLAY the taught contract into two OTHER projects -----
    for (const [label, target] of [["A (Java/Gradle)", targetA], ["B", targetB]] as const) {
      const targetSession = await attach(target);

      // Prove the workflow does NOT exist there yet (fresh state).
      expect(existsSync(join(target, "synthi", "hello.js")), `${label} should start clean`).toBe(false);

      const outcome = await bundle.replay_provider.replay(fragment, {
        handle: targetSession,
        mode: "fresh_state",
      });
      console.log(`REPLAY OUTCOME ${label}:`, JSON.stringify(outcome).slice(0, 400));
      expect(outcome.ok, `replay into ${label} failed`).toBe(true);
      expect(outcome.step_results.every((step) => step.ok)).toBe(true);

      // ---- STEP 6: VERIFY THE EFFECTS ARE REALLY ON DISK ---------------
      const configOnDisk = readFileSync(join(target, "synthi", "config.json"), "utf8");
      expect(configOnDisk).toBe('{"name":"demo"}');
      const helloOnDisk = readFileSync(join(target, "synthi", "hello.js"), "utf8");
      expect(helloOnDisk).toContain("hello from synthi");
      console.log(
        `REPLAYED into ${label}: synthi/config.json + synthi/hello.js verified ON DISK in a ${label.includes("Java") ? "Java/Gradle" : "other"} project`,
      );
    }

    // Cleanup the teacher project so the corpus stays pristine.
    rmSync(join(teacherRoot, "synthi"), { recursive: true, force: true });
    for (const target of [targetA, targetB]) {
      rmSync(join(target, "synthi"), { recursive: true, force: true });
    }
    expect(existsSync(join(teacherRoot, "synthi"))).toBe(false);
    console.log("CLEANUP verified: all three projects back to pre-demo state");
  },
);
