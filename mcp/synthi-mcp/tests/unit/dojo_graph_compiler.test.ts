import { beforeEach, describe, expect, it } from "vitest";
import { buildDojoSkill, exportDojoRepoArtifacts } from "../../src/browser/dojo.js";
import { compileDojoSkillGraphForSkill, compileDojoSkillGraphFromContract } from "../../src/dojo/graph/compiler.js";
import { isParseableDojoGuardrailPredicate } from "../../src/dojo/graph/guardrail_predicates.js";
import { compileWorkflowContract } from "../../src/browser/workflow.js";
import type { BrowserTraceEvent } from "../../src/browser/types.js";
import { sourceIdentityRegistry } from "../../src/browser/source_identity.js";

describe("Dojo graph compiler", () => {
  beforeEach(() => {
    sourceIdentityRegistry.resetForTests();
  });

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
      preconditions: [],
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
    expect(
      graph.nodes.flatMap((node) => node.guardrails).every((guardrail) =>
        isParseableDojoGuardrailPredicate(guardrail.predicate)
      )
    ).toBe(true);
    expect(action?.metadata).toEqual(expect.objectContaining({
      guardrail_predicates: expect.arrayContaining([
        expect.objectContaining({
          predicate: expect.stringMatching(/^(client_id_verified|source_anchor_current|durable_state_evidence|human_review_ready|guardrail_[a-f0-9]{12})/),
        }),
      ]),
    }));
  });

  it("preserves source and API bindings on compiled action nodes", () => {
    sourceIdentityRegistry.register({
      workspaceId: "workspace-a",
      filePath: "src/features/invoices/SaveInvoiceButton.tsx",
      adapter: "unit-test",
      transformVersion: "unit_source_identity_v1",
      tokens: [{
        token: "invoice.save",
        file: "src/features/invoices/SaveInvoiceButton.tsx",
        line: 42,
        column: 7,
        tag: "button",
      }],
    });
    const skill = skillFixture({
      saveSourceId: "invoice.save",
      saveNetwork: {
        method: "POST",
        url: "https://app.example.test/api/invoices?include=summary",
      },
    });
    const apiAnchor = skill.skill_seed.source_or_api_anchors.find((anchor) => anchor.kind === "api");

    const graph = compileDojoSkillGraphForSkill(skill).graph;
    const action = graph.nodes.find((node) => node.node_id === "action");

    expect(apiAnchor).toEqual(expect.objectContaining({
      source_step_id: "save",
      method: "POST",
      path: "/api/invoices",
      api_candidate_id: expect.stringMatching(/^api_candidate_/),
    }));
    expect(action).toEqual(expect.objectContaining({
      source_bindings: expect.arrayContaining([
        expect.objectContaining({
          anchor_id: expect.stringMatching(/^source_/),
          kind: "source",
          source_step_id: "save",
          source_id: "invoice.save",
          file_path: "src/features/invoices/SaveInvoiceButton.tsx",
          line: 42,
        }),
      ]),
      api_bindings: [
        expect.objectContaining({
          anchor_id: apiAnchor?.anchor_id,
          kind: "api",
          source_step_id: "save",
          api_candidate_id: apiAnchor?.api_candidate_id,
          method: "POST",
          path: "/api/invoices",
          proof_claim_mapping: {},
        }),
      ],
      metadata: expect.objectContaining({
        source_anchor_ids: expect.arrayContaining([expect.stringMatching(/^source_/)]),
        api_anchor_ids: [apiAnchor?.anchor_id],
        api_candidate_id: apiAnchor?.api_candidate_id,
        api_candidate_ids: [apiAnchor?.api_candidate_id],
      }),
    }));
  });

  it("compiles workflow contract steps into per-step action nodes with ordered bindings", () => {
    sourceIdentityRegistry.register({
      workspaceId: "workspace-a",
      filePath: "src/features/invoices/SaveInvoiceButton.tsx",
      adapter: "unit-test",
      transformVersion: "unit_source_identity_v1",
      tokens: [{
        token: "invoice.save",
        file: "src/features/invoices/SaveInvoiceButton.tsx",
        line: 42,
        column: 7,
        tag: "button",
      }],
    });
    const { contract, skill } = workflowFixture({
      saveSourceId: "invoice.save",
      saveNetwork: {
        method: "POST",
        url: "https://app.example.test/api/invoices?include=summary",
      },
    });
    const compiled = compileDojoSkillGraphFromContract(contract, skill);
    const actionNodes = compiled.graph.nodes.filter((node) => node.kind === "Action");
    const clientNode = compiled.graph.nodes.find((node) => node.node_id === "action_client");
    const saveNode = compiled.graph.nodes.find((node) => node.node_id === "action_save");
    const apiAnchor = skill.skill_seed.source_or_api_anchors.find((anchor) => anchor.kind === "api");

    expect(compiled.validation).toEqual({ ok: true, issues: [] });
    expect(actionNodes.map((node) => node.node_id)).toEqual(["action_client", "action_save"]);
    expect(clientNode).toEqual(expect.objectContaining({
      action: "fill",
      risk: "safe",
      proof: expect.objectContaining({ required: true }),
      metadata: expect.objectContaining({
        workflow_id: contract.workflowId,
        workflow_step_id: "client",
        event_seq: 1,
        action_kind: "fill",
      }),
      source_bindings: [],
      api_bindings: [],
    }));
    expect(saveNode).toEqual(expect.objectContaining({
      action: "click",
      risk: "dangerous",
      assertions: expect.arrayContaining([expect.objectContaining({ required: true })]),
      guardrails: expect.arrayContaining([expect.objectContaining({ severity: "block" })]),
      source_bindings: [
        expect.objectContaining({
          source_step_id: "save",
          source_id: "invoice.save",
          file_path: "src/features/invoices/SaveInvoiceButton.tsx",
        }),
      ],
      api_bindings: [
        expect.objectContaining({
          source_step_id: "save",
          api_candidate_id: apiAnchor?.api_candidate_id,
          method: "POST",
          path: "/api/invoices",
        }),
      ],
      metadata: expect.objectContaining({
        workflow_step_id: "save",
        api_anchor_ids: [apiAnchor?.anchor_id],
        api_candidate_ids: [apiAnchor?.api_candidate_id],
      }),
    }));
    expect(compiled.graph.edges).toEqual(expect.arrayContaining([
      expect.objectContaining({
        edge_id: "edge_proof_action_client",
        from_node_id: "proof",
        to_node_id: "action_client",
      }),
      expect.objectContaining({
        edge_id: "edge_action_client_action_save",
        from_node_id: "action_client",
        to_node_id: "action_save",
      }),
      expect.objectContaining({
        edge_id: "edge_action_save_assertion",
        from_node_id: "action_save",
        to_node_id: "assertion",
      }),
    ]));
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

function skillFixture(input: {
  clientSourceId?: string;
  saveSourceId?: string;
  saveNetwork?: { method: string; url: string };
} = {}) {
  return workflowFixture(input).skill;
}

function workflowFixture(input: {
  clientSourceId?: string;
  saveSourceId?: string;
  saveNetwork?: { method: string; url: string };
} = {}) {
  const contract = compileWorkflowContract([
    event({
      event_id: "client",
      event_seq: 1,
      action: "fill",
      value: "Acme",
      detail: { element: { role: "textbox", label: "Client name", ...(input.clientSourceId ? { source_id: input.clientSourceId } : {}) } },
      locator_candidates: [
        { kind: "label", locator: "page.getByLabel(\"Client name\")", confidence: 0.94, reason: "form_label" },
      ],
    }),
    event({
      event_id: "save",
      event_seq: 2,
      action: "click",
      detail: {
        element: { role: "button", name: "Save invoice", ...(input.saveSourceId ? { source_id: input.saveSourceId } : {}) },
        ...(input.saveNetwork ? {
          network_method: input.saveNetwork.method,
          network_url: input.saveNetwork.url,
          network_url_redacted: false,
          resource_type: "fetch",
        } : {}),
      },
      locator_candidates: [
        { kind: "role", locator: "page.getByRole(\"button\", { name: \"Save invoice\" })", confidence: 0.96, reason: "role" },
      ],
    }),
  ]).contract;
  return {
    contract,
    skill: buildDojoSkill(contract, {
    workspace_id: "workspace-a",
    now: "2026-06-11T00:00:00.000Z",
    }),
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
