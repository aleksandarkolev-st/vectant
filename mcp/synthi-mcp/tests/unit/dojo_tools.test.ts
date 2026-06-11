import { describe, expect, it, beforeEach, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { browserBroker } from "../../src/browser/broker.js";
import {
  buildDojoSkill,
  dojoSkillRegistry,
  exportDojoRepoArtifacts,
  extractDojoSkillSeed,
  generateDojoVivariumScenarios,
  issueDojoProofCapsule,
  runDojoCheckride,
  validateDojoProofCapsule,
} from "../../src/browser/dojo.js";
import { InMemoryPrivateWorkflowToolStore, privateWorkflowToolRegistry } from "../../src/browser/private_tool_registry.js";
import { sourceIdentityRegistry } from "../../src/browser/source_identity.js";
import { compileWorkflowContract } from "../../src/browser/workflow.js";
import type { BrowserTraceEvent } from "../../src/browser/types.js";
import { createSynthiServer } from "../../src/server.js";
import { dispatchDojoTool } from "../../src/tools/dojo.js";

beforeEach(() => {
  browserBroker.resetForTests();
  sourceIdentityRegistry.resetForTests();
  privateWorkflowToolRegistry.useStoreForTests(new InMemoryPrivateWorkflowToolStore());
  privateWorkflowToolRegistry.resetForTests();
  dojoSkillRegistry.resetForTests();
  vi.restoreAllMocks();
});

describe("Agent Dojo core", () => {
  it("turns a workflow contract into a seed, synthetic scenarios, checkride, case law, guardrails, and a scoped license", () => {
    const workflow = compileWorkflowContract([
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
    ]);

    const seed = extractDojoSkillSeed(workflow.contract, { workspace_id: "workspace-a", now: "2026-06-11T00:00:00.000Z" });
    const scenarios = generateDojoVivariumScenarios(seed);
    const checkride = runDojoCheckride(seed, scenarios, workflow.contract, { now: "2026-06-11T00:00:00.000Z" });
    const skill = buildDojoSkill(workflow.contract, { workspace_id: "workspace-a", now: "2026-06-11T00:00:00.000Z" });

    expect(seed.schema_version).toBe("synthi.dojo.skillSeed.v1");
    expect(seed.workspace_id).toBe("workspace-a");
    expect(seed.input_schema).toContainEqual(expect.objectContaining({ name: "client_name", required: true }));
    expect(scenarios).toHaveLength(20);
    expect(scenarios.map((scenario) => scenario.mutation_kind)).toEqual(expect.arrayContaining([
      "duplicate_entity",
      "fake_success",
      "auth_expiry",
      "destructive_adjacency",
    ]));
    expect(checkride.results).toEqual(expect.arrayContaining([
      expect.objectContaining({
        status: "failed",
        guardrail_suggestion: expect.stringContaining("stable entity id"),
      }),
    ]));
    expect(skill.case_law.length).toBeGreaterThan(0);
    expect(skill.guardrails.length).toBeGreaterThan(0);
    expect(skill.permission_license.entrustment_level).toBe("E2");
    expect(skill.permission_license.blocked_actions.map((action) => action.action)).toContain("run_workflow");
    expect(skill.skill_card.practiced).toBe("20 synthetic cases");
    const artifacts = exportDojoRepoArtifacts(skill);
    expect(artifacts.map((artifact) => artifact.path)).toEqual(expect.arrayContaining([
      ".synthi/dojo/skills/save_invoice/seed.json",
      ".synthi/dojo/skills/save_invoice/skill.graph.json",
      ".synthi/dojo/skills/save_invoice/vivarium.manifest.json",
      ".synthi/dojo/skills/save_invoice/checkride.report.md",
      ".synthi/dojo/skills/save_invoice/assurance.case.md",
      ".synthi/dojo/skills/save_invoice/license.json",
      ".synthi/dojo/skills/save_invoice/proof-capsule.schema.json",
      ".synthi/dojo/skills/save_invoice/guardrails.json",
      ".synthi/dojo/skills/save_invoice/case-law.md",
      ".synthi/dojo/skills/save_invoice/mcp.manifest.json",
    ]));
    expect(JSON.stringify(artifacts)).not.toMatch(/password|token-value/i);
  });

  it("validates proof capsules against action scope, context claims, evidence claims, guardrails, and signature", () => {
    const workflow = compileWorkflowContract([
      event({
        event_id: "open",
        action: "click",
        detail: { element: { role: "button", name: "Open details", source_id: "details.open" } },
        locator_candidates: [
          { kind: "role", locator: "page.getByRole(\"button\", { name: \"Open details\" })", confidence: 0.98, reason: "role" },
        ],
      }),
    ]);
    const skill = buildDojoSkill(workflow.contract, { workspace_id: "workspace-a", now: "2026-06-11T00:00:00.000Z" });
    const missingWorkspaceClaim = issueDojoProofCapsule(skill, "run_workflow", {
      context_claims: {},
      now: "2026-06-11T00:00:00.000Z",
      expires_at: "2026-06-11T00:15:00.000Z",
    });
    const valid = issueDojoProofCapsule(skill, "run_workflow", {
      context_claims: { workspace_verified: true },
      now: "2026-06-11T00:00:00.000Z",
      expires_at: "2026-06-11T00:15:00.000Z",
    });
    const tampered = { ...valid, context_claims: { workspace_verified: false } };

    expect(validateDojoProofCapsule(skill, missingWorkspaceClaim, "run_workflow", "2026-06-11T00:01:00.000Z")).toEqual(
      expect.objectContaining({
        ok: false,
        blocked_by: expect.arrayContaining(["missing_context_claim:workspace_verified"]),
      })
    );
    expect(validateDojoProofCapsule(skill, valid, "run_workflow", "2026-06-11T00:01:00.000Z")).toEqual(
      expect.objectContaining({ ok: true, status: "allowed" })
    );
    expect(validateDojoProofCapsule(skill, tampered, "run_workflow", "2026-06-11T00:01:00.000Z")).toEqual(
      expect.objectContaining({
        ok: false,
        blocked_by: expect.arrayContaining(["proof_capsule_signature_invalid", "missing_context_claim:workspace_verified"]),
      })
    );
  });
});

describe("Agent Dojo MCP tools", () => {
  it("advertises the static Dojo tool surface to strict MCP clients", async () => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = createSynthiServer({ defaultSignalingUrl: "ws://localhost:9000" });
    const client = new Client({ name: "dojo-tool-list-test", version: "0.0.0" });

    await server.connect(serverTransport);
    await client.connect(clientTransport);
    try {
      const listed = await client.listTools();
      expect(listed.tools).toEqual(expect.arrayContaining([
        expect.objectContaining({ name: "synthi_dojo_list_competencies" }),
        expect.objectContaining({ name: "synthi_dojo_publish_skill" }),
        expect.objectContaining({ name: "synthi_dojo_export_artifacts" }),
        expect.objectContaining({ name: "synthi_dojo_run_with_proof_capsule" }),
      ]));
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("publishes a licensed skill before exposing the backing private workflow tool and validates proof-gated dry runs", async () => {
    const url = "https://app.example.test/settings";
    browserBroker.requestConsent(url);
    browserBroker.registerTabs([{ tab_id: "tab-a", url, active: true }]);
    browserBroker.selectTab("tab-a");
    expect(browserBroker.startTeachMode("tab-a").ok).toBe(true);
    registerSourceToken("details.open");
    browserBroker.recordHumanAction({
      tab_id: "tab-a",
      url,
      origin: "https://app.example.test",
      action: "click",
      element: { role: "button", name: "Open details", source_id: "details.open" },
      locator_candidates: [
        { kind: "role", locator: "page.getByRole(\"button\", { name: \"Open details\" })", confidence: 0.98, reason: "role" },
      ],
    });

    const scenarios = await dispatchDojoTool("synthi_dojo_generate_vivarium_scenarios", { workspace_id: "workspace-a" });
    expect(scenarios?.isError).toBeUndefined();
    expect((scenarios?.structuredContent as { organoid: { scenarios: unknown[] } }).organoid.scenarios).toHaveLength(20);

    const publish = await dispatchDojoTool("synthi_dojo_publish_skill", { workspace_id: "workspace-a" });
    expect(publish?.isError).toBeUndefined();
    const published = publish?.structuredContent as {
      skill: { skill_id: string; published_tool_name: string };
      private_tool: { ok: boolean; tool_name: string };
    };
    expect(published.skill.skill_id).toBe("dojo_open_details");
    expect(published.private_tool).toEqual(expect.objectContaining({
      ok: true,
      tool_name: "synthi_app_open_details",
    }));
    expect((publish?.structuredContent as { tool_name: string }).tool_name).toBe("synthi_app_open_details");
    expect((publish?.structuredContent as { repo_artifacts: Array<{ path: string }> }).repo_artifacts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: ".synthi/dojo/skills/open_details/license.json" }),
        expect.objectContaining({ path: ".synthi/dojo/skills/open_details/proof-capsule.schema.json" }),
      ])
    );
    expect(privateWorkflowToolRegistry.get("synthi_app_open_details")).toBeTruthy();

    const capsuleResponse = await dispatchDojoTool("synthi_dojo_issue_proof_capsule", {
      skill_id: published.skill.skill_id,
      requested_action: "run_workflow",
      context_claims: { workspace_verified: true },
    });
    expect(capsuleResponse?.isError).toBeUndefined();
    const capsule = (capsuleResponse?.structuredContent as { proof_capsule: unknown }).proof_capsule;

    const dryRun = await dispatchDojoTool("synthi_dojo_run_with_proof_capsule", {
      skill_id: published.skill.skill_id,
      requested_action: "run_workflow",
      proof_capsule: capsule,
      dry_run: true,
    });
    expect(dryRun?.isError).toBeUndefined();
    expect(dryRun?.structuredContent).toEqual(expect.objectContaining({
      ok: true,
      dry_run: true,
      requested_action: "run_workflow",
      validation: expect.objectContaining({ ok: true, status: "allowed" }),
    }));

    const listed = await dispatchDojoTool("synthi_dojo_list_competencies", {});
    expect((listed?.structuredContent as { competencies: Array<{ skill_id: string }> }).competencies).toEqual([
      expect.objectContaining({ skill_id: "dojo_open_details" }),
    ]);

    const exported = await dispatchDojoTool("synthi_dojo_export_artifacts", { skill_id: published.skill.skill_id });
    expect(exported?.isError).toBeUndefined();
    expect(exported?.structuredContent).toEqual(expect.objectContaining({
      ok: true,
      skill_id: "dojo_open_details",
      artifact_count: 11,
      artifacts: expect.arrayContaining([
        expect.objectContaining({
          path: ".synthi/dojo/skills/open_details/assurance.case.md",
          content: expect.stringContaining("Skill Assurance Case"),
          sensitive: false,
        }),
      ]),
    }));
  });
});

function event(overrides: Partial<BrowserTraceEvent>): BrowserTraceEvent {
  return {
    event_id: "evt",
    trace_id: "trace",
    trace_version: 1,
    event_seq: 1,
    ts: 1,
    tab_id: "tab",
    origin: "https://app.example.test",
    url: "https://app.example.test/settings",
    kind: "human_action",
    ...overrides,
  };
}

function registerSourceToken(token: string): void {
  const filePath = `src/${token}.tsx`;
  sourceIdentityRegistry.register({
    workspaceId: "workspace-a",
    filePath,
    adapter: "unit-test",
    transformVersion: "unit_source_identity_v1",
    tokens: [{ token, file: filePath, tag: "button", line: 1, column: 1 }],
  });
}
