import { describe, expect, it } from "vitest";
import { buildDojoSkill, exportDojoRepoArtifacts } from "../../src/browser/dojo.js";
import { compileDojoSkillGraphForSkill } from "../../src/dojo/graph/compiler.js";
import { compileWorkflowContract } from "../../src/browser/workflow.js";
import type { BrowserTraceEvent } from "../../src/browser/types.js";

describe("Dojo graph compiler", () => {
  it("compiles a Dojo skill into a validated graph IR", () => {
    const skill = skillFixture();
    const compiled = compileDojoSkillGraphForSkill(skill, { created_at: "2026-06-11T00:00:00.000Z" });

    expect(compiled.validation).toEqual({ ok: true, issues: [] });
    expect(compiled.graph).toEqual(expect.objectContaining({
      schema_version: "synthi.dojo.skillGraph.v1",
      skill_id: skill.skill_id,
      skill_version: skill.skill_version,
      mode: "production",
    }));
    expect(compiled.graph.nodes.map((node) => node.kind)).toEqual(expect.arrayContaining([
      "Trigger",
      "Input",
      "Permission",
      "Guardrail",
      "Proof",
      "Action",
      "Assertion",
    ]));
  });

  it("inserts permission, guardrail, proof, and assertion semantics for risky actions", () => {
    const skill = skillFixture();
    const graph = compileDojoSkillGraphForSkill(skill).graph;
    const action = graph.nodes.find((node) => node.node_id === "action");

    expect(graph.nodes.find((node) => node.kind === "Permission")).toEqual(expect.objectContaining({
      evidence_policy: ["license_scope_checked"],
    }));
    expect(graph.nodes.filter((node) => node.kind === "Guardrail").length).toBeGreaterThan(0);
    expect(action).toEqual(expect.objectContaining({
      kind: "Action",
      proof: expect.objectContaining({
        required: true,
        required_claims: skill.permission_license.proof_requirements.required_evidence_claims,
      }),
      assertions: expect.arrayContaining([
        expect.objectContaining({ required: true }),
      ]),
      guardrails: expect.arrayContaining([
        expect.objectContaining({ severity: "block" }),
      ]),
    }));
  });

  it("adapts existing repo graph artifacts to the compiled IR", () => {
    const skill = skillFixture();
    const graphArtifact = exportDojoRepoArtifacts(skill)
      .find((artifact) => artifact.path.endsWith("/skill.graph.json"));

    expect(graphArtifact).toBeTruthy();
    const graph = JSON.parse(graphArtifact!.content) as Record<string, unknown>;
    expect(graph).toEqual(expect.objectContaining({
      schema_version: "synthi.dojo.skillGraph.v1",
      workflow_id: skill.workflow_id,
      validation: { ok: true, issues: [] },
    }));
    expect(graph).toHaveProperty("nodes");
    expect(graph).toHaveProperty("edges");
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
