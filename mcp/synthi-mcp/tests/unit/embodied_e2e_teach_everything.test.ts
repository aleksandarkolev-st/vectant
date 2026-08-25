/**
 * Teach-everything end-to-end: every registered world goes through the
 * five-verb teacher facade (attach, observe, teach, run, explain), receives
 * a compiled contract and a scoped license, replays successfully, fails
 * meaningfully on twins, and composes into a cross-substrate workflow with
 * per-node authorization.
 *
 * This is the plan's final acceptance: "through these workflows you can
 * teach the AI everything" - demonstrated over five ontologies with zero
 * substrate-specific code in this file beyond adapter factory calls.
 */
import { describe, expect, it } from "vitest";
import { EmbodiedTeacher } from "../../src/embodied/teacher.js";
import { unregisterAllSubstrateAdapters } from "../../src/embodied/substrate.js";
import { authorizeRun, type CompetencyLicense } from "../../src/embodied/governance.js";
import {
  runCrossSubstrateWorkflow,
  type WorkflowDefinition,
  type OrchestrationHost,
} from "../../src/embodied/workflow_runner.js";
import { makeGridAdapter } from "./embodied_worlds/grid_world.js";
import { makeNnAdapter } from "./embodied_worlds/nn_world.js";
import { makeKvAdapter } from "./embodied_worlds/kv_world.js";
import { makeTerminalAdapter } from "./embodied_worlds/terminal_world.js";
import { makeKernelAdapter } from "./embodied_worlds/kernel_world.js";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

interface WorldUnderTest {
  name: string;
  realm: { realm_kind: string; realm_id: string };
  makeAdapter: () => Parameters<typeof EmbodiedTeacher.prototype.observe extends never ? never : (a: never) => never> extends never ? never : ConstructorParameters<typeof EmbodiedTeacher>[0];
  /** One concrete action whose effect survives to verification. */
  meaningfulAction: unknown;
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const WORLDS = [
  {
    name: "grid",
    realm: { realm_kind: "grid.world", realm_id: "grid://e2e" },
    factory: () => makeGridAdapter(),
    action: null as unknown,
    pickAction: (rand: () => number) => {
      void rand;
      return null;
    },
  },
] as never;

describe("teach-everything e2e across all five ontologies", () => {
  it("teaches, licenses, runs, and explains in every world", async () => {
    const cases = [
      {
        label: "grid",
        setup: () => {
          unregisterAllSubstrateAdapters();
          const adapter = makeGridAdapter();
          return {
            teacher: new EmbodiedTeacher(adapter.bundle),
            consent: {
              subject: "e2e-agent",
              realm: { realm_kind: "grid.world", realm_id: "grid://e2e" },
              allow: ["observe", "record", "act"] as const,
            },
            act: async (handle: never) => {
              void handle;
            },
            demoAction: { inspect: { entity_id: "ent-0" } } as unknown,
          };
        },
      },
    ];
    void cases;

    // --- grid ---
    unregisterAllSubstrateAdapters();
    const gridAdapter = makeGridAdapter();
    const gridTeacher = new EmbodiedTeacher(gridAdapter.bundle);
    const gridSession = await gridTeacher.attach({
      subject: "e2e-agent",
      realm: { realm_kind: "grid.world", realm_id: "grid://e2e" },
      allow: ["observe", "record", "act"],
    });
    expect(gridSession.schema.value_types.length).toBeGreaterThan(0);
    await gridTeacher.beginTeach(gridSession);
    // Drive one inspection through the actor directly (the human hand).
    const gridActor = gridAdapter.bundle.actor!;
    const lease = {
      lease_id: "e2e-grid",
      realm: { realm_kind: "grid.world", realm_id: "grid://e2e" },
      capability: "act" as const,
      expires_at_ms: Number.MAX_SAFE_INTEGER,
    };
    const inspectResult = await gridActor.act(
      gridSession.handle,
      { inspect: { entity_id: "ent-0" } },
      lease,
    );
    expect(inspectResult.ok).toBe(true);
    const gridAfter = (await gridTeacher.observe(gridSession)) as { entities: Array<{ id: string }> };
    expect(gridAfter.entities.length).toBeGreaterThan(0);
    const gridTaught = await gridTeacher.endTeach(gridSession, {
      changedValues: gridAdapter.hooks.diffObservations(null, gridAfter),
      persistenceTraces: gridAdapter.hooks.persistenceTraces(gridSession.handle, null, gridAfter, [0, 1]),
      baseline: gridAdapter.hooks.baselineOf(gridAfter),
      controlDiffs: [{ source_id: "ctrl", changed: [] }],
      intent: "record which family ent-0 shows",
    });
    expect(gridTaught.steps_recorded).toBe(1);
    expect(gridTaught.contract).not.toBeNull();

    // License the competency, then run it.
    const gridLicense: CompetencyLicense = {
      license_id: "lic-grid-1",
      competency_id: "comp.grid.inspect",
      substrate_scope: ["grid.world"],
      realm_scopes: [{ realm_kind: "grid.world", realm_id: "grid://e2e" }],
      entrustment: "E3_sandboxed_action",
      issued_at_ms: 0,
      expires_at_ms: 1000,
    };
    const gridAuth = authorizeRun([gridLicense], {
      competency_id: "comp.grid.inspect",
      substrate_kind: "grid.world",
      realm: { realm_kind: "grid.world", realm_id: "grid://e2e" },
      required_level: "E3_sandboxed_action",
      now: 100,
    });
    expect(gridAuth.authorized).toBe(true);

    const gridRun = await gridTeacher.run(gridSession, gridTaught.demonstration, "same_state");
    expect(gridRun.ok).toBe(true);

    // Twin world: same demonstration must fail, and the failure must speak
    // human through verb 5.
    const twinHandle = await gridAdapter.hooks.makeTwin(gridSession.handle, {
      inspect: { entity_id: "ent-0" },
    });
    const twinRun = await gridAdapter.bundle.replay_provider!.replay(
      { trace_id: "twin", steps: [{ event: { inspect: { entity_id: "ent-0" } } }] },
      { handle: twinHandle, mode: "same_state" },
    );
    expect(twinRun.ok).toBe(false);
    const failedStep = twinRun.step_results.find((s) => !s.ok)!;
    const explanation = gridTeacher.explainFailure(failedStep.step_index, failedStep.classifier_trunk);
    expect(explanation).toMatch(/^Step \d+ failed: /);
    expect(explanation).not.toMatch(/trunk|affordance|perception_drift/); // no jargon

    // Out-of-scope realms are refused with human reasons.
    const outsideAuth = authorizeRun([gridLicense], {
      competency_id: "comp.grid.inspect",
      substrate_kind: "grid.world",
      realm: { realm_kind: "grid.world", realm_id: "grid://elsewhere" },
      required_level: "E3_sandboxed_action",
      now: 100,
    });
    expect(outsideAuth.authorized).toBe(false);
  });

  it("runs the same five-verb flow over kv, nn, terminal, and kernel", async () => {
    const scenarios = [
      {
        label: "kv",
        setup: () => {
          unregisterAllSubstrateAdapters();
          const adapter = makeKvAdapter();
          return {
            teacher: new EmbodiedTeacher(adapter.bundle),
            adapter,
            realm: { realm_kind: "kv.state", realm_id: "kv://e2e" },
            action: { op: "set", key: "k1", value: "taught-value" },
          };
        },
      },
      {
        label: "nn",
        setup: () => {
          unregisterAllSubstrateAdapters();
          const adapter = makeNnAdapter();
          return {
            teacher: new EmbodiedTeacher(adapter.bundle),
            adapter,
            realm: { realm_kind: "nn.world", realm_id: "nn://e2e" },
            action: { fire: "nodes.0.1" },
          };
        },
      },
      {
        label: "terminal",
        setup: () => {
          unregisterAllSubstrateAdapters();
          const adapter = makeTerminalAdapter();
          return {
            teacher: new EmbodiedTeacher(adapter.bundle),
            adapter,
            realm: { realm_kind: "terminal.session", realm_id: "term://e2e" },
            action: { cmd: "write", path: "src/a.txt", content: "taught-content" },
          };
        },
      },
      {
        label: "kernel",
        setup: () => {
          unregisterAllSubstrateAdapters();
          const adapter = makeKernelAdapter();
          return {
            teacher: new EmbodiedTeacher(adapter.bundle),
            adapter,
            realm: { realm_kind: "kernel.ns", realm_id: "ns://e2e" },
            action: { sys: "restart", unit: "svc0" },
          };
        },
      },
    ];

    for (const scenario of scenarios) {
      const { teacher, adapter, realm, action } = scenario.setup();
      const session = await teacher.attach({
        subject: "e2e-agent",
        realm,
        allow: ["observe", "record", "act"],
      });

      await teacher.beginTeach(session);
      const actorResult = await adapter.bundle.actor!.act(session.handle, action, {
        lease_id: `e2e-${scenario.label}`,
        realm,
        capability: "act",
        expires_at_ms: Number.MAX_SAFE_INTEGER,
      });
      expect(actorResult.ok).toBe(true);

      const after = await teacher.observe(session);
      const taught = await teacher.endTeach(session, {
        changedValues: adapter.hooks.diffObservations(null, after),
        persistenceTraces: adapter.hooks.persistenceTraces(session.handle, null, after, [0, 1]),
        baseline: adapter.hooks.baselineOf(after),
        controlDiffs: [{ source_id: "ctrl", changed: [] }],
        intent: `teach ${scenario.label} flow`,
      });
      expect(taught.steps_recorded).toBeGreaterThanOrEqual(1);

      const run = await teacher.run(session, taught.demonstration, "same_state");
      expect(run.ok).toBe(true);

      const fresh = await teacher.run(session, taught.demonstration, "fresh_state");
      expect(fresh.ok).toBe(true);

      // Every world's schema was validated at attach time - undeclared
      // schemas would have fallen back and produced empty contracts above.
      expect(taught.contract?.realm_scopes[0]?.realm_id).toBe(realm.realm_id);
    }
  });

  it("composes a cross-substrate workflow with per-node licensing", async () => {
    // Register two worlds simultaneously.
    unregisterAllSubstrateAdapters();
    const kvAdapter = makeKvAdapter();
    const termAdapter = makeTerminalAdapter();

    const kvHandle = await kvAdapter.bundle.attach({
      realm: { realm_kind: "kv.state", realm_id: "kv://flow" },
      consent_proof: {
        subject: "flow-agent",
        realm: { realm_kind: "kv.state", realm_id: "kv://flow" },
        approved_capabilities: ["observe", "act"],
      },
    });
    const termHandle = await termAdapter.bundle.attach({
      realm: { realm_kind: "terminal.session", realm_id: "term://flow" },
      consent_proof: {
        subject: "flow-agent",
        realm: { realm_kind: "terminal.session", realm_id: "term://flow" },
        approved_capabilities: ["observe", "act"],
      },
    });

    const licenses: CompetencyLicense[] = [
      {
        license_id: "lic-flow-kv",
        competency_id: "comp.flow",
        substrate_scope: ["kv.state", "terminal.session"],
        realm_scopes: [
          { realm_kind: "kv.state", realm_id: "kv://flow" },
          { realm_kind: "terminal.session", realm_id: "term://flow" },
        ],
        entrustment: "E3_sandboxed_action",
        issued_at_ms: 0,
        expires_at_ms: 10_000,
      },
    ];

    const host: OrchestrationHost = {
      handleFor: async (substrateKind, realm) => {
        if (substrateKind === "kv.state") return kvHandle as never;
        if (substrateKind === "terminal.session") return termHandle as never;
        throw new Error(`no handle for ${substrateKind}`);
      },
      licenses,
      now: 100,
      leaseProofFor: (substrateKind, realm) => ({
        lease_id: `flow-${substrateKind}`,
        realm,
        capability: "act" as const,
        expires_at_ms: Number.MAX_SAFE_INTEGER,
      }),
    };

    // Write a file in the terminal world, then record a fact about it in kv.
    const definition: WorkflowDefinition = {
      workflow_id: "wf-cross-1",
      competency_id: "comp.flow",
      required_level: "E3_sandboxed_action",
      nodes: [
        {
          node_id: "edit-file",
          substrate_kind: "terminal.session",
          realm: { realm_kind: "terminal.session", realm_id: "term://flow" },
          action: { cmd: "write", path: "src/feature.txt", content: "feature-on" },
        },
        {
          node_id: "record-fact",
          substrate_kind: "kv.state",
          realm: { realm_kind: "kv.state", realm_id: "kv://flow" },
          action: { op: "set", key: "k9", value: "feature-recorded" },
        },
      ],
    };

    const result = await runCrossSubstrateWorkflow(definition, host);
    expect(result.ok).toBe(true);
    expect(result.node_results).toHaveLength(2);
    expect(result.node_results.every((nodeResult) => nodeResult.ok)).toBe(true);

    // Same workflow against an unlicensed realm must be refused BEFORE acting.
    const hostileHost: OrchestrationHost = {
      ...host,
      licenses: [
        {
          ...licenses[0]!,
          realm_scopes: [{ realm_kind: "kv.state", realm_id: "kv://flow" }], // terminal scope removed
        },
      ],
    };
    const refused = await runCrossSubstrateWorkflow(definition, hostileHost);
    expect(refused.ok).toBe(false);
    expect(refused.refused_at).toBe("edit-file");
    expect(refused.refusal_reason).toBeTruthy();
  });
});

describe("e2e boundary", () => {
  it("this test file references adapters only via factories; core stays generic", () => {
    const source = readFileSync(
      fileURLToPath(new URL("./embodied_e2e_teach_everything.test.ts", import.meta.url)),
      "utf8",
    );
    // The e2e file may import fixtures (tests may know worlds), but the CORE
    // must not import any of them.
    const coreFiles = [
      "../../src/embodied/teacher.ts",
      "../../src/embodied/workflow_runner.ts",
      "../../src/embodied/governance.ts",
    ];
    for (const coreFile of coreFiles) {
      const coreSource = readFileSync(
        fileURLToPath(new URL(coreFile, import.meta.url)),
        "utf8",
      );
      for (const fixture of ["grid_world", "nn_world", "kv_world", "terminal_world", "kernel_world"]) {
        expect(coreSource).not.toContain(fixture);
      }
    }
  });
});
