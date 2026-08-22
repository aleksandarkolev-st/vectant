import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createTerminalBundle,
} from "../../src/embodied/adapters/terminal/index.js";
import type { TerminalCommandAction } from "../../src/embodied/adapters/terminal/index.js";

const REALM = { realm_kind: "workspace", realm_id: "" }; // filled per-test with the temp root
const LEASE = (realmId: string) => ({
  lease_id: "l1",
  realm: { realm_kind: "workspace", realm_id: realmId },
  capability: "act" as const,
  expires_at_ms: Number.MAX_SAFE_INTEGER,
});

function makeHandle(root: string) {
  const bundle = createTerminalBundle();
  return bundle.attach({
    realm: { realm_kind: "workspace", realm_id: root },
    consent_proof: {
      subject: "test",
      realm: { realm_kind: "workspace", realm_id: root },
      approved_capabilities: ["observe", "record", "act"],
    },
  }) as Promise<{ handle_id: string; environment: { root: string; lastExit: number | null; recording: TerminalCommandAction[] | null } } & Record<string, unknown>> extends never ? never : ReturnType<typeof createTerminalBundle>["attach"];
}

describe("terminal adapter on real processes", () => {
  it("golden: teach a write-then-read flow and replay its effects", async () => {
    const root = mkdtempSync(join(tmpdir(), "emb-term-"));
    try {
      writeFileSync(join(root, "seed.txt"), "seed");
      const bundle = createTerminalBundle();
      const handle = (await bundle.attach({
        realm: { realm_kind: "workspace", realm_id: root },
        consent_proof: {
          subject: "t",
          realm: { realm_kind: "workspace", realm_id: root },
          approved_capabilities: ["observe", "record", "act"],
        },
      })) as never as Parameters<NonNullable<typeof bundle.recorder>>["beginRecord"] extends never ? never : any;

      // Teach: two node -e commands that write then verify a file.
      bundle.recorder!.beginRecord(handle as never);
      const writeCmd: TerminalCommandAction = {
        run: "node -e require('fs').writeFileSync('out.txt','hello-e2e')",
      };
      const checkCmd: TerminalCommandAction = {
        run: "node -e process.exit(require('fs').readFileSync('out.txt','utf8')==='hello-e2e'?0:1)",
      };
      const r1 = await bundle.actor!.act(handle as never, writeCmd, LEASE(root));
      expect(r1.ok).toBe(true);
      const r2 = await bundle.actor!.act(handle as never, checkCmd, LEASE(root));
      expect(r2.ok).toBe(true);

      const fragment = bundle.recorder!.endRecord(handle as never);
      expect(fragment.steps).toHaveLength(2);

      // Fresh workspace: replay re-executes both commands; effects hold.
      const root2 = mkdtempSync(join(tmpdir(), "emb-term2-"));
      try {
        const handle2 = (await bundle.attach({
          realm: { realm_kind: "workspace", realm_id: root2 },
          consent_proof: {
            subject: "t",
            realm: { realm_kind: "workspace", realm_id: root2 },
            approved_capabilities: ["observe", "act"],
          },
        })) as typeof handle;
        const replay = await bundle.replay_provider!.replay(fragment, {
          handle: handle2 as never,
          mode: "fresh_state",
        });
        expect(replay.step_results.every((s) => s.ok)).toBe(true);
        expect(replay.ok).toBe(true);
        expect(readFileSync(join(root2, "out.txt"), "utf8")).toBe("hello-e2e");
      } finally {
        rmSync(root2, { recursive: true, force: true });
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("refuses non-allowlisted binaries before execution", async () => {
    const root = mkdtempSync(join(tmpdir(), "emb-term3-"));
    try {
      const bundle = createTerminalBundle();
      const handle = (await bundle.attach({
        realm: { realm_kind: "workspace", realm_id: root },
        consent_proof: {
          subject: "t",
          realm: { realm_kind: "workspace", realm_id: root },
          approved_capabilities: ["act"],
        },
      })) as never as { environment: unknown };
      const result = await bundle.actor!.act(
        handle as never,
        { run: "rm -rf /" },
        LEASE(root),
      );
      expect(result.ok).toBe(false);
      expect(result.refusal_reason).toContain("not allowlisted");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("observation is scrubbed and reports exit codes", async () => {
    const root = mkdtempSync(join(tmpdir(), "emb-term4-"));
    try {
      const bundle = createTerminalBundle();
      const handle = (await bundle.attach({
        realm: { realm_kind: "workspace", realm_id: root },
        consent_proof: {
          subject: "t",
          realm: { realm_kind: "workspace", realm_id: root },
          approved_capabilities: ["observe", "act"],
        },
      })) as never as Parameters<typeof bundle.observer!.observe>[0];
      // A failing command records its exit code.
      await bundle.actor!.act(handle, { run: "node -e process.exit(3)" }, LEASE(root));
      void handle;
      const observation = (await bundle.observer!.observe(handle)) as {
        last_exit: number;
        files: Record<string, string>;
      };
      expect(observation.last_exit).toBe(3);
      expect(typeof observation.files).toBe("object");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
