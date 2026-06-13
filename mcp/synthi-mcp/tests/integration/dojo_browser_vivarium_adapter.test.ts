import { describe, expect, it } from "vitest";
import { buildDojoSkill } from "../../src/browser/dojo.js";
import { runDojoVivariumScenario } from "../../src/browser/dojo_vivarium.js";
import type { BrowserTraceEvent } from "../../src/browser/types.js";
import { compileWorkflowContract } from "../../src/browser/workflow.js";

describe("browser Dojo Vivarium adapter", () => {
  it("drives graph guardrails from materialized duplicate-entity fixture state", async () => {
    const skill = skillFixture();

    const run = await runDojoVivariumScenario(skill, {
      mutation_kind: "duplicate_entity",
      now: "2026-06-11T00:00:00.000Z",
      tenant_context: tenantContext(),
    });

    const fixture = run.materialized_fixture.tissues.fixture as {
      graph_inputs: Record<string, unknown>;
      records: Array<{ stable_id: string; display_name: string }>;
      observed_evidence: string[];
    };

    expect(fixture.records).toHaveLength(2);
    expect(new Set(fixture.records.map((record) => record.stable_id)).size).toBe(2);
    expect(new Set(fixture.records.map((record) => record.display_name)).size).toBe(1);
    expect(fixture.graph_inputs).toEqual(expect.objectContaining({
      client_id_verified: false,
      workspace_verified: true,
      durable_state_evidence: true,
    }));
    expect(fixture.observed_evidence).not.toContain("stable_entity_identity");
    expect(run.result).toEqual(expect.objectContaining({
      status: "blocked",
      critical: false,
    }));
    expect(run.run.license_checks).toEqual([expect.objectContaining({
      status: "blocked",
      blocked_by: expect.arrayContaining([
        expect.stringMatching(/^guardrail_failed:/),
      ]),
    })]);
  });

  it("keeps fake-success fixtures from self-attesting durable state evidence", async () => {
    const skill = skillFixture();

    const run = await runDojoVivariumScenario(skill, {
      mutation_kind: "fake_success",
      now: "2026-06-11T00:00:00.000Z",
      tenant_context: tenantContext(),
    });

    const fixture = run.materialized_fixture.tissues.fixture as {
      api_state: { fake_success: boolean };
      api_fault: {
        behavior: string;
        request_count: number;
        durable_state: { fake_success: boolean; committed: boolean };
      };
      graph_inputs: Record<string, unknown>;
      observed_evidence: string[];
    };

    expect(fixture.api_state.fake_success).toBe(true);
    expect(fixture.api_fault).toEqual(expect.objectContaining({
      behavior: "fake_success",
      request_count: 1,
      durable_state: expect.objectContaining({
        committed: false,
        fake_success: true,
      }),
    }));
    expect(fixture.graph_inputs).toEqual(expect.objectContaining({
      durable_state_evidence: false,
      client_id_verified: true,
    }));
    expect(fixture.observed_evidence).toContain("api_fault_server_executed");
    expect(fixture.observed_evidence).toContain("fake_success_visual_only");
    expect(fixture.observed_evidence).not.toContain("durable_state_evidence");
    expect(run.result.status).not.toBe("passed");
  });

  it("uses deterministic core runner IDs when a run clock is supplied", async () => {
    const skill = skillFixture();
    const input = {
      mutation_kind: "baseline",
      now: "2026-06-11T00:00:00.000Z",
      tenant_context: tenantContext(),
    };

    const first = await runDojoVivariumScenario(skill, input);
    const second = await runDojoVivariumScenario(skill, input);

    expect(first.run.run_id).toBe(second.run.run_id);
    expect(first.run.started_at).toBe("2026-06-11T00:00:00.000Z");
    expect(second.run.finished_at).toBe("2026-06-11T00:00:00.000Z");
  });
});

function skillFixture() {
  return buildDojoSkill(compileWorkflowContract([
    event({
      event_id: "client",
      event_seq: 1,
      action: "fill",
      value: "Acme",
      detail: { element: { role: "textbox", label: "Client name" } },
      locator_candidates: [
        { kind: "label", locator: "page.getByLabel(\"Client name\")", confidence: 0.94, reason: "form_label" },
      ],
    }),
    event({
      event_id: "save",
      event_seq: 2,
      action: "click",
      detail: { element: { role: "button", name: "Save invoice" } },
      locator_candidates: [
        { kind: "role", locator: "page.getByRole(\"button\", { name: \"Save invoice\" })", confidence: 0.96, reason: "role" },
      ],
    }),
  ]).contract, {
    workspace_id: "workspace-a",
    now: "2026-06-11T00:00:00.000Z",
  });
}

function tenantContext() {
  return {
    tenant_id: "tenant-vivarium-adapter",
    organization_id: "org-vivarium-adapter",
    workspace_id: "workspace-a",
    actor_id: "vivarium-adapter-test",
    actor_type: "agent" as const,
    roles: ["dojo:test"],
    request_id: "vivarium-adapter-test",
    correlation_id: "vivarium-adapter-test-correlation",
  };
}

function event(overrides: Partial<BrowserTraceEvent>): BrowserTraceEvent {
  return {
    event_id: "evt",
    trace_id: "trace",
    trace_version: 1,
    event_seq: 1,
    ts: 1,
    tab_id: "tab",
    origin: "https://app.example.test",
    url: "https://app.example.test/invoices",
    kind: "human_action",
    action: "click",
    target: "button",
    selectors: [],
    locator_candidates: [],
    confidence: 0.99,
    ...overrides,
  };
}
