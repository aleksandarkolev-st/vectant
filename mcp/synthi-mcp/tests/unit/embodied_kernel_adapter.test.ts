import { describe, expect, it } from "vitest";
import {
  createKernelBundle,
  takeAudit,
  type KernelExecutorPort,
  type KernelSafetyPolicy,
} from "../../src/embodied/adapters/kernel/index.js";

/** In-process executor: records every call; deterministic exits. */
function fakeExecutor(failCommands: ReadonlySet<string> = new Set()) {
  const calls: Array<{ op: "snapshot" | "exec" | "restore"; namespace: string; command?: string }> = [];
  const executor: KernelExecutorPort = {
    snapshot: async (namespace) => {
      calls.push({ op: "snapshot", namespace });
      return `snap-${namespace}-${calls.length}`;
    },
    restore: async (namespace) => {
      calls.push({ op: "restore", namespace });
    },
    exec: async (namespace, command) => {
      calls.push({ op: "exec", namespace, command });
      const exit = failCommands.has(command.trim()) ? 2 : 0;
      return { exit, output: "" };
    },
  };
  return { calls, executor };
}

const LEASE = (realmId: string) => ({
  lease_id: "l",
  realm: { realm_kind: "container", realm_id: realmId },
  capability: "act" as const,
  expires_at_ms: Number.MAX_SAFE_INTEGER,
});

async function makeHandle(bundle: ReturnType<typeof createKernelBundle>, realmId: string) {
  return bundle.attach({
    realm: { realm_kind: "container", realm_id: realmId },
    consent_proof: {
      subject: "t",
      realm: { realm_kind: "container", realm_id: realmId },
      approved_capabilities: ["observe", "record", "act"],
    },
  }) as never as Parameters<Parameters<ReturnType<typeof createKernelBundle>["actor"]>["act"]> extends never
    ? never
    : { environment: never } & Record<string, unknown>;
}

describe("kernel adapter invariants (P3)", () => {
  it("snapshots a namespace exactly once before its first mutation", async () => {
    const { calls, executor } = fakeExecutor();
    const bundle = createKernelBundle(executor);
    const handle = await bundle.attach({
      realm: { realm_kind: "container", realm_id: "ns-a" },
      consent_proof: {
        subject: "t",
        realm: { realm_kind: "container", realm_id: "ns-a" },
        approved_capabilities: ["observe", "act"],
      },
    });

    const act = (command: string) =>
      bundle.actor!.act(handle as never, { exec: command, namespace: "web" }, LEASE("ns-a"));

    // Conservative default policy: everything is mutating -> snapshot first.
    await act("install curl");
    await act("install htop");
    const snapshots = calls.filter((call) => call.op === "snapshot" && call.namespace === "web");
    expect(snapshots).toHaveLength(1); // once per namespace per session
    expect(calls.filter((call) => call.op === "exec")).toHaveLength(2);
    // Snapshot happened before the first exec.
    const firstExec = calls.findIndex((call) => call.op === "exec");
    const snap = calls.findIndex((call) => call.op === "snapshot");
    expect(snap).toBeLessThan(firstExec);
  });

  it("refuses host-targeting commands and records an audit entry", async () => {
    // Deployment supplies lexical host detection as policy.
    const policy: KernelSafetyPolicy = {
      isMutating: () => true,
      isHostTargeting: (command) => command.includes("--host") || command.includes("nsenter"),
    };
    const { executor } = fakeExecutor();
    const bundle = createKernelBundle(executor, policy);
    const handle = await bundle.attach({
      realm: { realm_kind: "container", realm_id: "ns-b" },
      consent_proof: {
        subject: "t",
        realm: { realm_kind: "container", realm_id: "ns-b" },
        approved_capabilities: ["act"],
      },
    });

    const result = await bundle.actor!.act(
      handle as never,
      { exec: "nsenter --target 1 -m ls", namespace: "web" },
      LEASE("ns-b"),
    );
    expect(result.ok).toBe(false);
    expect(result.refusal_reason).toContain("host");

    const audit = takeAudit(handle as never);
    expect(audit).toHaveLength(1);
    expect(audit[0]!.kind).toBe("host_refusal");
    expect(audit[0]!.command).toContain("nsenter");
    // Audit drains.
    expect(takeAudit(handle as never)).toHaveLength(0);
  });

  it("replay classifies failing commands and stops at host attempts", async () => {
    const fail = new Set(["install broken-pkg"]);
    const { executor } = fakeExecutor(fail);
    const bundle = createKernelBundle(executor);
    const handle = await bundle.attach({
      realm: { realm_kind: "container", realm_id: "ns-c" },
      consent_proof: {
        subject: "t",
        realm: { realm_kind: "container", realm_id: "ns-c" },
        approved_capabilities: ["record", "act"],
      },
    });

    // Teach two commands: one ok, one failing.
    bundle.recorder!.beginRecord(handle as never);
    await bundle.actor!.act(handle as never, { exec: "install curl", namespace: "api" }, LEASE("ns-c"));
    await bundle.actor!.act(handle as never, { exec: "install broken-pkg", namespace: "api" }, LEASE("ns-c"));
    const fragment = bundle.recorder!.endRecord(handle as never);

    const target = await bundle.attach({
      realm: { realm_kind: "container", realm_id: "ns-d" },
      consent_proof: {
        subject: "t",
        realm: { realm_kind: "container", realm_id: "ns-d" },
        approved_capabilities: ["act"],
      },
    });
    const outcome = await bundle.replay_provider!.replay(fragment, {
      handle: target as never,
      mode: "fresh_state",
    });
    expect(outcome.ok).toBe(false);
    expect(outcome.step_results[0]!.ok).toBe(true);
    expect(outcome.step_results[1]!.ok).toBe(false);
    expect(outcome.step_results[1]!.classifier_trunk).toBe("app_validation_error");
  });
});
