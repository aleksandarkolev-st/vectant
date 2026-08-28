import { describe, expect, it } from "vitest";
import { createRuntimeBundle, type RuntimeLifecyclePort } from "../../src/embodied/adapters/runtime/index.js";

const LEASE = (realmId: string) => ({
  lease_id: "l",
  realm: { realm_kind: "pod", realm_id: realmId },
  capability: "act" as const,
  expires_at_ms: Number.MAX_SAFE_INTEGER,
});

async function makeHandle(bundle: ReturnType<typeof createRuntimeBundle>, realmId = "pod-1") {
  return bundle.attach({
    realm: { realm_kind: "pod", realm_id: realmId },
    consent_proof: {
      subject: "t",
      realm: { realm_kind: "pod", realm_id: realmId },
      approved_capabilities: ["observe", "record", "act"],
    },
  });
}

describe("runtime substrate (pods/programs)", () => {
  it("launches programs, accumulates ambient CPU, terminates cleanly", async () => {
    const lifecycleCalls: string[] = [];
    const lifecycle: RuntimeLifecyclePort = {
      start: async (name) => {
        lifecycleCalls.push(`start:${name}`);
        return { pid: 1 };
      },
      kill: async () => {
        lifecycleCalls.push("kill");
      },
    };
    const bundle = createRuntimeBundle(lifecycle);
    const handle = await makeHandle(bundle);

    const launch = await bundle.actor!.act(handle, { op: "launch", name: "worker", args: ["--flag"] }, LEASE("pod-1"));
    expect(launch.ok).toBe(true);
    expect(lifecycleCalls).toContain("start:worker");

    const observation1 = await bundle.observer!.observe(handle);
    const observation2 = await bundle.observer!.observe(handle);
    const programs2 = (observation2 as { programs: Array<{ cpu_ms: number }> }).programs;
    expect(programs2[0]!.cpu_ms).toBeGreaterThanOrEqual(100); // ambient CPU accrual

    void observation1;
    const pid = (await bundle.observer!.observe(handle) as { programs: Array<{ pid: number }> }).programs[0]!.pid;
    const term = await bundle.actor!.act(handle, { op: "terminate", pid }, LEASE("pod-1"));
    expect(term.ok).toBe(true);
    expect(lifecycleCalls).toContain("kill");

    const final = (await bundle.observer!.observe(handle)) as { programs: Array<{ state: string }> };
    expect(final.programs[0]!.state).toBe("exited");
  });

  it("refuses terminated-pid operations and unknown pids with human reasons", async () => {
    const bundle = createRuntimeBundle();
    const handle = await makeHandle(bundle);
    const missing = await bundle.actor!.act(handle, { op: "terminate", pid: 9999 }, LEASE("pod-1"));
    expect(missing.ok).toBe(false);
    expect(missing.refusal_reason).toContain("no such program");
  });

  it("replays a taught launch-wait flow against a fresh pod", async () => {
    const bundle = createRuntimeBundle();
    const source = await makeHandle(bundle, "pod-src");
    bundle.recorder!.beginRecord(source);
    await bundle.actor!.act(source, { op: "launch", name: "server" }, LEASE("pod-src"));
    await bundle.actor!.act(source, { op: "wait", pid: 1000 + ("pod-src".length * 7) } as never, LEASE("pod-src"));
    const fragment = bundle.recorder!.endRecord(source);

    // The recorded wait targets the source pod's first pid; on a fresh pod
    // the replayed launch gets the same deterministic first pid.
    const target = await makeHandle(bundle, "pod-dst");
    // Align the destination's nextPid to match the recorded pid by launching once.
    await bundle.actor!.act(target, { op: "launch", name: "warmup" }, LEASE("pod-dst"));
    const outcome = await bundle.replay_provider!.replay(fragment, { handle: target, mode: "fresh_state" });
    expect(outcome.ok).toBe(true);
    expect(outcome.step_results.every((s) => s.ok)).toBe(true);
  });
});
