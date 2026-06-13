import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
import { InMemoryDojoSkillStore } from "../../src/browser/dojo_store.js";
import { InMemoryPrivateWorkflowToolStore, privateWorkflowToolRegistry } from "../../src/browser/private_tool_registry.js";
import { sourceIdentityRegistry } from "../../src/browser/source_identity.js";
import { compileWorkflowContract } from "../../src/browser/workflow.js";
import type { BrowserTraceEvent } from "../../src/browser/types.js";
import type { DojoSkill } from "../../src/browser/dojo.js";
import { createSynthiServer } from "../../src/server.js";
import { validateDojoMcpSkillManifest, type DojoMcpSkillManifestV1 } from "../../src/dojo/mcp/manifest_signing.js";
import { dispatchBrowserTool } from "../../src/tools/browser.js";
import { dispatchDojoTool } from "../../src/tools/dojo.js";
import { buildDojoEvidenceLedgerRecord } from "../../src/dojo/evidence/ledger_record.js";

const originalEnv = { ...process.env };

beforeEach(() => {
  process.env = { ...originalEnv };
  browserBroker.resetForTests();
  sourceIdentityRegistry.resetForTests();
  privateWorkflowToolRegistry.useStoreForTests(new InMemoryPrivateWorkflowToolStore());
  privateWorkflowToolRegistry.resetForTests();
  dojoSkillRegistry.useStoreForTests(new InMemoryDojoSkillStore());
  dojoSkillRegistry.resetForTests();
  vi.restoreAllMocks();
});

afterEach(() => {
  process.env = { ...originalEnv };
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
    expect(skill.skill_cortex.nodes.map((node) => node.kind)).toEqual(expect.arrayContaining([
      "Trigger",
      "Input",
      "Action",
      "Guardrail",
      "Proof",
      "Expiry",
    ]));
    expect(skill.skill_cortex.nodes[0]?.memory).toEqual(expect.objectContaining({
      confidence: expect.any(Number),
      rehearsal_count: 20,
      expiry_triggers: expect.arrayContaining(["app_release", "policy_change"]),
    }));
    expect(skill.workspace_organoid.tissues).toEqual(expect.objectContaining({
      ui: expect.any(Object),
      data: expect.any(Object),
      policy: expect.any(Object),
      adversary: expect.any(Object),
    }));
    expect(skill.wind_tunnel.runs).toHaveLength(scenarios.length);
    expect(skill.counterfactual_twin.variants.length).toBeGreaterThan(0);
    expect(skill.evil_twin.attack_success_rate).toEqual(expect.any(Number));
    expect(skill.antibodies.length).toBeGreaterThan(0);
    expect(skill.skill_genome.shared_without).toEqual(expect.arrayContaining(["secrets", "workspace_data", "raw_screenshots"]));
    expect(skill.agent_ready_ui_contract.actions.length).toBeGreaterThan(0);
    expect(skill.cost_control_policy.stop_conditions).toContain("critical_failure_requires_guardrail");
    const artifacts = exportDojoRepoArtifacts(skill);
    expect(artifacts.map((artifact) => artifact.path)).toEqual(expect.arrayContaining([
      ".synthi/dojo/skills/save_invoice/seed.json",
      ".synthi/dojo/skills/save_invoice/skill.graph.json",
      ".synthi/dojo/skills/save_invoice/vivarium.manifest.json",
      ".synthi/dojo/skills/save_invoice/wind-tunnel.report.json",
      ".synthi/dojo/skills/save_invoice/counterfactual-twin.report.json",
      ".synthi/dojo/skills/save_invoice/evil-twin.report.json",
      ".synthi/dojo/skills/save_invoice/checkride.report.md",
      ".synthi/dojo/skills/save_invoice/assurance.case.md",
      ".synthi/dojo/skills/save_invoice/license.json",
      ".synthi/dojo/skills/save_invoice/proof-capsule.schema.json",
      ".synthi/dojo/skills/save_invoice/guardrails.json",
      ".synthi/dojo/skills/save_invoice/antibodies.json",
      ".synthi/dojo/skills/save_invoice/case-law.md",
      ".synthi/dojo/skills/save_invoice/skill-passport.json",
      ".synthi/dojo/skills/save_invoice/skill-genome.json",
      ".synthi/dojo/skills/save_invoice/agent-ready-ui-contract.json",
      ".synthi/dojo/skills/save_invoice/cost-control.policy.json",
      ".synthi/dojo/skills/save_invoice/training-report.md",
      ".synthi/dojo/skills/save_invoice/universe.dossier.json",
      ".synthi/dojo/skills/save_invoice/lifecycle.report.json",
      ".synthi/dojo/skills/save_invoice/governance.report.json",
      ".synthi/dojo/skills/save_invoice/source-affordance-pr-plan.json",
      ".synthi/dojo/skills/save_invoice/metrics.json",
      ".synthi/dojo/skills/save_invoice/evidence-ledger.json",
      ".synthi/dojo/skills/save_invoice/time-machine-debugger.json",
      ".synthi/dojo/skills/save_invoice/evidence-manifest.json",
      ".synthi/dojo/skills/save_invoice/playwright.spec.ts",
      ".synthi/dojo/skills/save_invoice/mcp.manifest.json",
      ".synthi/dojo/workflows/save_invoice.graph.json",
      ".synthi/dojo/guardrails/save_invoice.guardrails.json",
      ".synthi/dojo/licenses/save_invoice.license.json",
      ".synthi/dojo/antibodies/save_invoice.antibodies.json",
      ".synthi/dojo/reports/save_invoice.training-report.md",
      ".synthi/dojo/evidence/save_invoice.redacted-evidence-manifest.json",
      ".synthi/dojo/evidence/save_invoice.ledger.json",
      ".synthi/dojo/governance/save_invoice.governance-report.json",
      ".synthi/dojo/source/save_invoice.affordance-pr-plan.json",
      ".synthi/dojo/registry/save_invoice.universe-dossier.json",
      ".synthi/dojo/registry/organization-registry.json",
      ".synthi/dojo/playwright/save_invoice.spec.ts",
      ".synthi/dojo/mcp/save_invoice.manifest.json",
    ]));
    expect(JSON.stringify(artifacts)).not.toMatch(/password|token-value/i);
    const compatibilityEvidenceManifest = JSON.parse(artifacts.find((artifact) =>
      artifact.path === ".synthi/dojo/skills/save_invoice/evidence-manifest.json"
    )?.content ?? "null") as { schema_version?: string };
    const redactedEvidenceManifest = JSON.parse(artifacts.find((artifact) =>
      artifact.path === ".synthi/dojo/evidence/save_invoice.redacted-evidence-manifest.json"
    )?.content ?? "null") as {
      schema_version?: string;
      artifact_count?: number;
      artifacts?: Array<{ redaction_manifest_sha256?: string; original_artifact_sha256?: string }>;
      excluded?: string[];
    };
    expect(compatibilityEvidenceManifest.schema_version).toBe("synthi.dojo.evidenceManifest.v1");
    expect(redactedEvidenceManifest).toEqual(expect.objectContaining({
      schema_version: "synthi.dojo.redactedEvidenceExport.v1",
      artifact_count: expect.any(Number),
      excluded: expect.arrayContaining(["raw_artifact_content", "secrets", "tokens"]),
    }));
    expect(redactedEvidenceManifest.artifacts?.[0]).toEqual(expect.objectContaining({
      original_artifact_sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      redaction_manifest_sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
    }));
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
      evidence_ledger_records: evidenceLedgerRecordsForProof(skill),
      require_verified_evidence: true,
      now: "2026-06-11T00:00:00.000Z",
      expires_at: "2026-06-11T00:15:00.000Z",
    });
    const valid = issueDojoProofCapsule(skill, "run_workflow", {
      context_claims: { workspace_verified: true },
      evidence_ledger_records: evidenceLedgerRecordsForProof(skill),
      require_verified_evidence: true,
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
  it("adds implementation-status metadata to Dojo tool responses", async () => {
    const listed = await dispatchDojoTool("synthi_dojo_list_competencies", {});

    expect(listed?.structuredContent).toEqual(expect.objectContaining({
      implementation_status: "executable",
      runtime_enforced: true,
      runtime_scope: "registry_operation",
      production_runtime: false,
      evidence_backing: "runtime_validation",
      simulation_backing: "none",
      dojo_implementation: expect.objectContaining({
        implementation_status: "executable",
        runtime_enforced: true,
        runtime_scope: "registry_operation",
        production_runtime: false,
      }),
    }));
    expect(JSON.parse((listed?.content[0] as { type: "text"; text: string }).text)).toEqual(
      expect.objectContaining({ implementation_status: "executable" })
    );
  });

  it("requires complete tenant context before listing production competencies", async () => {
    recordOpenDetailsWorkflowForDojoToolTest();
    const publish = await dispatchDojoTool("synthi_dojo_publish_skill", publishArgsForDojoToolTest());
    expect(publish?.isError).toBeUndefined();
    const skillId = (publish?.structuredContent as { skill: { skill_id: string } }).skill.skill_id;
    process.env.SYNTHI_DOJO_PRODUCTION_ENFORCEMENT = "1";

    const missingContext = await dispatchDojoTool("synthi_dojo_list_competencies", {});
    expect(missingContext?.isError).toBe(true);
    expect(missingContext?.structuredContent).toEqual(expect.objectContaining({
      error: "dojo_tenant_context_required",
      enforcement_mode: "production",
      missing_fields: expect.arrayContaining([
        "tenant_id",
        "organization_id",
        "workspace_id",
        "actor_id",
        "actor_type",
        "roles",
        "request_id",
        "correlation_id",
      ]),
      blocked_by: expect.arrayContaining([
        "tenant_context_tenant_id_missing",
        "tenant_context_actor_id_missing",
      ]),
    }));

    const listed = await dispatchDojoTool("synthi_dojo_list_competencies", productionTenantContextArgs({
      request_id: "req-production-list",
    }));
    expect(listed?.isError).toBeUndefined();
    const listedContent = listed?.structuredContent as {
      count: number;
      competencies: Array<{ skill_id: string; mcp_skill_manifest: DojoMcpSkillManifestV1 }>;
    };
    expect(listedContent).toEqual(expect.objectContaining({ ok: true, count: 1 }));
    expect(listedContent.competencies).toHaveLength(1);
    const competency = listedContent.competencies[0]!;
    expect(competency.skill_id).toBe(skillId);
    expect(competency.mcp_skill_manifest.skill.workspace_id).toBe("workspace-a");
    expect(competency.mcp_skill_manifest.manifest_digest).toMatch(/^sha256:/);
  });

  it("authorizes production skill detail reads by tenant context", async () => {
    recordOpenDetailsWorkflowForDojoToolTest();
    const publish = await dispatchDojoTool("synthi_dojo_publish_skill", publishArgsForDojoToolTest());
    expect(publish?.isError).toBeUndefined();
    const skillId = (publish?.structuredContent as { skill: { skill_id: string } }).skill.skill_id;
    process.env.SYNTHI_DOJO_PRODUCTION_ENFORCEMENT = "1";

    const missingContext = await dispatchDojoTool("synthi_dojo_get_skill", { skill_id: skillId });
    expect(missingContext?.isError).toBe(true);
    expect(missingContext?.structuredContent).toEqual(expect.objectContaining({
      error: "dojo_tenant_context_required",
      blocked_by: expect.arrayContaining(["tenant_context_workspace_id_missing"]),
    }));

    const crossWorkspace = await dispatchDojoTool("synthi_dojo_get_skill", {
      skill_id: skillId,
      ...productionTenantContextArgs({
        workspace_id: "workspace-b",
        request_id: "req-production-get-skill-cross-workspace",
      }),
    });
    expect(crossWorkspace?.isError).toBe(true);
    expect(crossWorkspace?.structuredContent).toEqual(expect.objectContaining({
      error: "dojo_skill_not_authorized",
      ok: false,
      skill_id: skillId,
      workspace_id: "workspace-a",
      tenant_workspace_id: "workspace-b",
      blocked_by: ["dojo_skill_workspace_mismatch"],
    }));

    const sameWorkspace = await dispatchDojoTool("synthi_dojo_get_skill", {
      skill_id: skillId,
      ...productionTenantContextArgs({ request_id: "req-production-get-skill-same-workspace" }),
    });
    expect(sameWorkspace?.isError).toBeUndefined();
    expect(sameWorkspace?.structuredContent).toEqual(expect.objectContaining({
      ok: true,
      skill: expect.objectContaining({ skill_id: skillId, workspace_id: "workspace-a" }),
    }));

    const adminRead = await dispatchDojoTool("synthi_dojo_get_skill", {
      skill_id: skillId,
      ...productionTenantContextArgs({
        workspace_id: "workspace-b",
        roles: ["dojo:admin"],
        request_id: "req-production-get-skill-admin",
      }),
    });
    expect(adminRead?.isError).toBeUndefined();
    expect(adminRead?.structuredContent).toEqual(expect.objectContaining({
      ok: true,
      skill: expect.objectContaining({ skill_id: skillId, workspace_id: "workspace-a" }),
    }));
  });

  it("requires tenant authorization for production workflow certification tools", async () => {
    recordOpenDetailsWorkflowForDojoToolTest();
    process.env.SYNTHI_DOJO_PRODUCTION_ENFORCEMENT = "1";

    const missingScenarioContext = await dispatchDojoTool("synthi_dojo_generate_vivarium_scenarios", {
      workspace_id: "workspace-a",
      reason: "production_scenario_projection",
      actor_id: "scenario-author",
      actor_type: "human",
      evidence_refs: ["evidence:scenario-projection"],
    });
    expect(missingScenarioContext?.isError).toBe(true);
    expect(missingScenarioContext?.structuredContent).toEqual(expect.objectContaining({
      error: "dojo_tenant_context_required",
      blocked_by: expect.arrayContaining(["tenant_context_tenant_id_missing"]),
    }));

    const missingCheckrideContext = await dispatchDojoTool("synthi_dojo_run_checkride", {
      workspace_id: "workspace-a",
    });
    expect(missingCheckrideContext?.isError).toBe(true);
    expect(missingCheckrideContext?.structuredContent).toEqual(expect.objectContaining({
      error: "dojo_tenant_context_required",
      blocked_by: expect.arrayContaining(["tenant_context_actor_id_missing"]),
    }));

    const missingPublishContext = await dispatchDojoTool("synthi_dojo_publish_skill", publishArgsForDojoToolTest());
    expect(missingPublishContext?.isError).toBe(true);
    expect(missingPublishContext?.structuredContent).toEqual(expect.objectContaining({
      error: "dojo_tenant_context_required",
      blocked_by: expect.arrayContaining(["tenant_context_roles_missing"]),
    }));

    const workspaceMismatch = await dispatchDojoTool("synthi_dojo_publish_skill", publishArgsForDojoToolTest({
      ...productionTenantContextArgs({
        workspace_id: "workspace-b",
        request_id: "req-production-publish-source-mismatch",
        correlation_id: "corr-production-publish-source-mismatch",
      }),
    }));
    expect(workspaceMismatch?.isError).toBe(true);
    expect(workspaceMismatch?.structuredContent).toEqual(expect.objectContaining({
      error: "dojo_workflow_workspace_mismatch",
      source_workspace_id: "workspace-a",
      requested_workspace_id: "workspace-b",
      tenant_workspace_id: "workspace-b",
      blocked_by: ["dojo_workflow_source_workspace_mismatch"],
    }));

    const scenarioProjection = await dispatchDojoTool("synthi_dojo_generate_vivarium_scenarios", {
      reason: "production_scenario_projection",
      evidence_refs: ["evidence:scenario-projection"],
      ...productionTenantContextArgs({
        actor_id: "scenario-author",
        actor_type: "human",
        request_id: "req-production-scenario-projection",
        correlation_id: "corr-production-scenario-projection",
      }),
    });
    expect(scenarioProjection?.isError).toBeUndefined();
    expect(scenarioProjection?.structuredContent).toEqual(expect.objectContaining({
      ok: true,
      tenant_context: expect.objectContaining({
        tenant_id: "tenant-a",
        workspace_id: "workspace-a",
        actor_id: "scenario-author",
      }),
      skill_seed: expect.objectContaining({ workspace_id: "workspace-a" }),
    }));

    const checkride = await dispatchDojoTool("synthi_dojo_run_checkride", productionTenantContextArgs({
      actor_id: "checkride-tester",
      actor_type: "human",
      request_id: "req-production-workflow-checkride",
      correlation_id: "corr-production-workflow-checkride",
      now: "2026-06-11T00:00:00.000Z",
    }));
    expect(checkride?.isError).toBeUndefined();
    expect(checkride?.structuredContent).toEqual(expect.objectContaining({
      ok: true,
      tenant_context: expect.objectContaining({
        tenant_id: "tenant-a",
        workspace_id: "workspace-a",
        actor_id: "checkride-tester",
      }),
      executable_checkride: expect.objectContaining({
        results: expect.arrayContaining([
          expect.objectContaining({
            evidence_record: expect.objectContaining({
              tenant_id: "tenant-a",
              workspace_id: "workspace-a",
              created_by: "checkride-tester",
            }),
          }),
        ]),
      }),
    }));

    const publish = await dispatchDojoTool("synthi_dojo_publish_skill", publishArgsForDojoToolTest({
      ...productionTenantContextArgs({
        actor_id: "unit-publisher",
        actor_type: "human",
        request_id: "req-production-publish-workflow",
        correlation_id: "corr-production-publish-workflow",
      }),
    }));
    expect(publish?.isError).toBeUndefined();
    expect(publish?.structuredContent).toEqual(expect.objectContaining({
      ok: true,
      mcp_skill_manifest: expect.objectContaining({
        skill: expect.objectContaining({ workspace_id: "workspace-a" }),
      }),
      publication: expect.objectContaining({
        audit_event: expect.objectContaining({
          tenant_context: expect.objectContaining({
            tenant_id: "tenant-a",
            workspace_id: "workspace-a",
            actor_id: "unit-publisher",
          }),
        }),
      }),
    }));
  });

  it("requires tenant authorization for production skill report surfaces", async () => {
    recordOpenDetailsWorkflowForDojoToolTest();
    const publish = await dispatchDojoTool("synthi_dojo_publish_skill", publishArgsForDojoToolTest());
    expect(publish?.isError).toBeUndefined();
    const skillId = (publish?.structuredContent as { skill: { skill_id: string } }).skill.skill_id;
    process.env.SYNTHI_DOJO_PRODUCTION_ENFORCEMENT = "1";

    const skillReportTools = [
      "synthi_dojo_get_skill_cortex",
      "synthi_dojo_get_workspace_organoid",
      "synthi_dojo_get_wind_tunnel_report",
      "synthi_dojo_get_counterfactual_twin",
      "synthi_dojo_get_evil_twin_report",
      "synthi_dojo_get_training_report",
      "synthi_dojo_get_skill_passport",
      "synthi_dojo_get_skill_genome",
      "synthi_dojo_get_antibodies",
      "synthi_dojo_get_agent_ready_ui_contract",
      "synthi_dojo_get_cost_policy",
      "synthi_dojo_get_universe_dossier",
      "synthi_dojo_get_lifecycle",
      "synthi_dojo_get_governance_report",
      "synthi_dojo_get_source_affordance_pr_plan",
      "synthi_dojo_get_skill_assurance_case",
      "synthi_dojo_get_entrustment_level",
      "synthi_dojo_get_license",
      "synthi_dojo_get_guardrails",
      "synthi_dojo_get_case_law",
      "synthi_dojo_explain_block",
      "synthi_dojo_explain_failure",
      "synthi_dojo_debug_counterfactual",
      "synthi_dojo_run_time_machine_debugger",
      "synthi_dojo_run_ghost_mode",
    ];

    for (const toolName of skillReportTools) {
      const missingContext = await dispatchDojoTool(toolName, { skill_id: skillId });
      expect(missingContext?.isError, toolName).toBe(true);
      expect(missingContext?.structuredContent, toolName).toEqual(expect.objectContaining({
        error: "dojo_tenant_context_required",
        blocked_by: expect.arrayContaining(["tenant_context_workspace_id_missing"]),
      }));

      const authorized = await dispatchDojoTool(toolName, {
        skill_id: skillId,
        ...productionTenantContextArgs({ request_id: `req-production-${toolName}` }),
      });
      expect(authorized?.isError, toolName).toBeUndefined();
      expect(authorized?.structuredContent, toolName).not.toEqual(expect.objectContaining({
        error: "dojo_tenant_context_required",
      }));
    }
  });

  it("filters production aggregate reads by tenant context", async () => {
    const { visibleSkillId, hiddenSkill } = await publishTwoWorkspaceSkillsForDojoToolTest();

    const visibleUpgrade = await dispatchDojoTool("synthi_dojo_request_permission_upgrade", {
      skill_id: visibleSkillId,
      requested_action: "commit_mutation",
      actor_id: "visible-requester",
      actor_type: "agent",
      request_id: "visible-upgrade-request",
      correlation_id: "visible-upgrade-correlation",
      now: "2026-06-11T00:03:00.000Z",
    });
    expect(visibleUpgrade?.isError).toBeUndefined();
    const hiddenUpgrade = await dispatchDojoTool("synthi_dojo_request_permission_upgrade", {
      skill_id: hiddenSkill.skill_id,
      requested_action: "commit_mutation",
      actor_id: "hidden-requester",
      actor_type: "agent",
      request_id: "hidden-upgrade-request",
      correlation_id: "hidden-upgrade-correlation",
      now: "2026-06-11T00:03:00.000Z",
    });
    expect(hiddenUpgrade?.isError).toBeUndefined();

    process.env.SYNTHI_DOJO_PRODUCTION_ENFORCEMENT = "1";

    const missingMetricsContext = await dispatchDojoTool("synthi_dojo_get_metrics", {});
    expect(missingMetricsContext?.isError).toBe(true);
    expect(missingMetricsContext?.structuredContent).toEqual(expect.objectContaining({
      error: "dojo_tenant_context_required",
      blocked_by: expect.arrayContaining(["tenant_context_workspace_id_missing"]),
    }));

    const metrics = await dispatchDojoTool("synthi_dojo_get_metrics", productionTenantContextArgs({
      request_id: "req-production-aggregate-metrics",
    }));
    expect(metrics?.isError).toBeUndefined();
    expect(metrics?.structuredContent).toEqual(expect.objectContaining({
      metrics: expect.objectContaining({
        skill_count: 1,
        business: expect.objectContaining({ reviewable_artifact_sets: 1 }),
      }),
    }));

    const registry = await dispatchDojoTool("synthi_dojo_get_registry", productionTenantContextArgs({
      request_id: "req-production-registry",
    }));
    expect(registry?.isError).toBeUndefined();
    const registryContent = registry?.structuredContent as {
      registry: { skill_count: number; competencies: Array<{ skill_id: string; workspace_id: string }> };
      governance_service: {
        skill_registry: Array<{ skill_id: string; workspace_id: string }>;
        approval_queue: Array<{ request_id?: string; skill_id: string }>;
      };
    };
    expect(registryContent.registry.skill_count).toBe(1);
    expect(registryContent.registry.competencies).toEqual([
      expect.objectContaining({ skill_id: visibleSkillId, workspace_id: "workspace-a" }),
    ]);
    expect(registryContent.governance_service.skill_registry).toEqual([
      expect.objectContaining({ skill_id: visibleSkillId, workspace_id: "workspace-a" }),
    ]);
    expect(registryContent.governance_service.approval_queue).toEqual(expect.arrayContaining([
      expect.objectContaining({ request_id: "visible-upgrade-request", skill_id: visibleSkillId }),
    ]));
    expect(registryContent.governance_service.approval_queue).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ request_id: "hidden-upgrade-request", skill_id: hiddenSkill.skill_id }),
    ]));

    const selectedHiddenMetrics = await dispatchDojoTool("synthi_dojo_get_metrics", {
      skill_id: hiddenSkill.skill_id,
      ...productionTenantContextArgs({ request_id: "req-production-hidden-metrics" }),
    });
    expect(selectedHiddenMetrics?.isError).toBe(true);
    expect(selectedHiddenMetrics?.structuredContent).toEqual(expect.objectContaining({
      error: "dojo_skill_not_authorized",
      skill_id: hiddenSkill.skill_id,
      tenant_workspace_id: "workspace-a",
    }));

    const adminMetrics = await dispatchDojoTool("synthi_dojo_get_metrics", productionTenantContextArgs({
      roles: ["dojo:admin"],
      request_id: "req-production-admin-metrics",
    }));
    expect(adminMetrics?.isError).toBeUndefined();
    expect(adminMetrics?.structuredContent).toEqual(expect.objectContaining({
      metrics: expect.objectContaining({ skill_count: 2 }),
    }));

    const universe = await dispatchDojoTool("synthi_dojo_get_universe_dossier", {
      skill_id: visibleSkillId,
      ...productionTenantContextArgs({ request_id: "req-production-universe" }),
    });
    expect(universe?.isError).toBeUndefined();
    expect(universe?.structuredContent).toEqual(expect.objectContaining({
      universe_dossier: expect.objectContaining({
        metrics: expect.objectContaining({ skill_count: 1 }),
      }),
    }));

    const governance = await dispatchDojoTool("synthi_dojo_get_governance_report", {
      skill_id: visibleSkillId,
      ...productionTenantContextArgs({ request_id: "req-production-governance" }),
    });
    expect(governance?.isError).toBeUndefined();
    const governanceService = (governance?.structuredContent as {
      governance_service: {
        skill_registry: Array<{ skill_id: string }>;
        approval_queue: Array<{ request_id?: string }>;
      };
    }).governance_service;
    expect(governanceService.skill_registry).toEqual([
      expect.objectContaining({ skill_id: visibleSkillId }),
    ]);
    expect(governanceService.approval_queue).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ request_id: "hidden-upgrade-request" }),
    ]));
  });

  it("requires tenant authorization for production skill operations and exports", async () => {
    const { visibleSkillId, hiddenSkill } = await publishTwoWorkspaceSkillsForDojoToolTest();
    process.env.SYNTHI_DOJO_PRODUCTION_ENFORCEMENT = "1";

    const protectedToolCalls = [
      {
        tool_name: "synthi_dojo_run_vivarium_scenario",
        args: { skill_id: hiddenSkill.skill_id, mutation_kind: "duplicate_entity" },
      },
      {
        tool_name: "synthi_dojo_run_wind_tunnel",
        args: { skill_id: hiddenSkill.skill_id, max_scenarios: 1 },
      },
      {
        tool_name: "synthi_dojo_get_license_health",
        args: { skill_id: hiddenSkill.skill_id },
      },
      {
        tool_name: "synthi_dojo_revoke_license",
        args: {
          skill_id: hiddenSkill.skill_id,
          reason: "production cross-workspace test",
          actor_id: "unit-reviewer",
          actor_type: "human",
          evidence_refs: ["evidence:cross-workspace"],
        },
      },
      {
        tool_name: "synthi_dojo_record_case_law",
        args: {
          skill_id: hiddenSkill.skill_id,
          finding: "Cross-workspace case law mutation attempt",
          rule: "Only authorized workspace actors may propose binding runtime rules.",
          evidence_refs: ["evidence:cross-workspace"],
        },
      },
      {
        tool_name: "synthi_dojo_export_artifacts",
        args: { skill_id: hiddenSkill.skill_id },
      },
      {
        tool_name: "synthi_dojo_export_compliance_pack",
        args: { skill_id: hiddenSkill.skill_id },
      },
      {
        tool_name: "synthi_dojo_request_permission_upgrade",
        args: {
          skill_id: hiddenSkill.skill_id,
          requested_action: "commit_mutation",
          actor_id: "unit-reviewer",
          actor_type: "agent",
        },
      },
      {
        tool_name: "synthi_dojo_recertify_skill",
        args: {
          skill_id: hiddenSkill.skill_id,
          reason: "production cross-workspace test",
          actor_id: "unit-reviewer",
          actor_type: "human",
          evidence_refs: ["evidence:cross-workspace"],
        },
      },
    ];

    for (const call of protectedToolCalls) {
      const blocked = await dispatchDojoTool(call.tool_name, {
        ...call.args,
        ...productionTenantContextArgs({ request_id: `req-${call.tool_name}-cross-workspace` }),
      });
      expect(blocked?.isError, call.tool_name).toBe(true);
      expect(blocked?.structuredContent, call.tool_name).toEqual(expect.objectContaining({
        error: "dojo_skill_not_authorized",
        skill_id: hiddenSkill.skill_id,
        workspace_id: "workspace-b",
        tenant_workspace_id: "workspace-a",
      }));
    }

    const missingComplianceContext = await dispatchDojoTool("synthi_dojo_export_compliance_pack", {});
    expect(missingComplianceContext?.isError).toBe(true);
    expect(missingComplianceContext?.structuredContent).toEqual(expect.objectContaining({
      error: "dojo_tenant_context_required",
      blocked_by: expect.arrayContaining(["tenant_context_workspace_id_missing"]),
    }));

    const visibleHealth = await dispatchDojoTool("synthi_dojo_get_license_health", {
      skill_id: visibleSkillId,
      ...productionTenantContextArgs({ request_id: "req-production-visible-health" }),
    });
    expect(visibleHealth?.isError).toBeUndefined();
    expect(visibleHealth?.structuredContent).toEqual(expect.objectContaining({
      license_health: expect.objectContaining({
        skill_id: visibleSkillId,
        governance: expect.objectContaining({ workspace_id: "workspace-a" }),
      }),
    }));

    const visibleArtifacts = await dispatchDojoTool("synthi_dojo_export_artifacts", {
      skill_id: visibleSkillId,
      ...productionTenantContextArgs({ request_id: "req-production-visible-artifacts" }),
    });
    expect(visibleArtifacts?.isError).toBeUndefined();
    expect(visibleArtifacts?.structuredContent).toEqual(expect.objectContaining({
      skill_id: visibleSkillId,
      artifact_count: expect.any(Number),
    }));

    const visibleVivarium = await dispatchDojoTool("synthi_dojo_run_vivarium_scenario", {
      skill_id: visibleSkillId,
      mutation_kind: "duplicate_entity",
      ...productionTenantContextArgs({ request_id: "req-production-visible-vivarium" }),
    });
    expect(visibleVivarium?.isError).toBeUndefined();
    expect(visibleVivarium?.structuredContent).toEqual(expect.objectContaining({
      skill_id: visibleSkillId,
      vivarium_run: expect.objectContaining({
        schema_version: "synthi.dojo.vivariumScenarioRun.v1",
        tenant_context: expect.objectContaining({ workspace_id: "workspace-a" }),
      }),
    }));

    const visibleCompliance = await dispatchDojoTool("synthi_dojo_export_compliance_pack", productionTenantContextArgs({
      request_id: "req-production-visible-compliance",
    }));
    expect(visibleCompliance?.isError).toBeUndefined();
    expect(visibleCompliance?.structuredContent).toEqual(expect.objectContaining({
      pack: expect.objectContaining({
        skill_ids: [visibleSkillId],
        workspace_ids: ["workspace-a"],
      }),
    }));
  });

  it("requires tenant authorization for production governance reviews", async () => {
    const { visibleSkillId, hiddenSkill } = await publishTwoWorkspaceSkillsForDojoToolTest();
    const hiddenUpgrade = await dispatchDojoTool("synthi_dojo_request_permission_upgrade", {
      skill_id: hiddenSkill.skill_id,
      requested_action: "commit_mutation",
      actor_id: "hidden-requester",
      actor_type: "agent",
      request_id: "hidden-upgrade-review-test",
      correlation_id: "hidden-upgrade-review-test-correlation",
    });
    expect(hiddenUpgrade?.isError).toBeUndefined();

    const hiddenCase = await dispatchDojoTool("synthi_dojo_record_case_law", {
      skill_id: hiddenSkill.skill_id,
      title: "Hidden workspace case",
      finding: "Hidden workspace case-law review should stay scoped.",
      rule: "Only authorized workspace actors may review case law.",
      applies_to: ["commit_mutation"],
      evidence_refs: ["evidence:hidden-case"],
    });
    expect(hiddenCase?.isError).toBeUndefined();
    const hiddenCaseId = (hiddenCase?.structuredContent as {
      case_law_record: { case_id: string };
    }).case_law_record.case_id;

    process.env.SYNTHI_DOJO_PRODUCTION_ENFORCEMENT = "1";
    const workspaceAReviewer = productionTenantContextArgs({
      request_id: "req-review-hidden-workspace",
      correlation_id: "corr-review-hidden-workspace",
      actor_id: "workspace-a-reviewer",
      roles: ["dojo:reviewer"],
    });

    const blockedUpgradeReview = await dispatchDojoTool("synthi_dojo_review_permission_upgrade", {
      ...workspaceAReviewer,
      request_id: "hidden-upgrade-review-test",
      decision: "approved",
      reviewer_actor_id: "workspace-a-reviewer",
      reviewer_actor_type: "human",
      reason: "Attempted cross-workspace permission approval.",
      evidence_refs: ["evidence:review-hidden-upgrade"],
    });
    expect(blockedUpgradeReview?.isError).toBe(true);
    expect(blockedUpgradeReview?.structuredContent).toEqual(expect.objectContaining({
      error: "dojo_skill_not_authorized",
      skill_id: hiddenSkill.skill_id,
      workspace_id: "workspace-b",
      tenant_workspace_id: "workspace-a",
    }));

    const blockedCaseReviewById = await dispatchDojoTool("synthi_dojo_review_case_law", {
      case_id: hiddenCaseId,
      decision: "approved",
      reviewer_actor_id: "workspace-a-reviewer",
      reviewer_actor_type: "human",
      reason: "Attempted cross-workspace case-law approval.",
      evidence_refs: ["evidence:review-hidden-case"],
      ...workspaceAReviewer,
    });
    expect(blockedCaseReviewById?.isError).toBe(true);
    expect(blockedCaseReviewById?.structuredContent).toEqual(expect.objectContaining({
      error: "dojo_case_law_not_authorized",
      case_id: hiddenCaseId,
      tenant_workspace_id: "workspace-a",
      blocked_by: ["dojo_case_law_scope_mismatch"],
    }));

    const blockedCaseReviewWithSkill = await dispatchDojoTool("synthi_dojo_review_case_law", {
      skill_id: hiddenSkill.skill_id,
      case_id: hiddenCaseId,
      decision: "approved",
      reviewer_actor_id: "workspace-a-reviewer",
      reviewer_actor_type: "human",
      reason: "Attempted cross-workspace case-law approval.",
      evidence_refs: ["evidence:review-hidden-case"],
      ...workspaceAReviewer,
    });
    expect(blockedCaseReviewWithSkill?.isError).toBe(true);
    expect(blockedCaseReviewWithSkill?.structuredContent).toEqual(expect.objectContaining({
      error: "dojo_skill_not_authorized",
      skill_id: hiddenSkill.skill_id,
      workspace_id: "workspace-b",
      tenant_workspace_id: "workspace-a",
    }));

    const visibleUpgrade = await dispatchDojoTool("synthi_dojo_request_permission_upgrade", {
      skill_id: visibleSkillId,
      requested_action: "commit_mutation",
      ...productionTenantContextArgs({
        actor_id: "workspace-a-requester",
        request_id: "visible-upgrade-review-test",
        correlation_id: "visible-upgrade-review-test-correlation",
        roles: ["dojo:reviewer"],
      }),
    });
    expect(visibleUpgrade?.isError).toBeUndefined();

    const visibleReview = await dispatchDojoTool("synthi_dojo_review_permission_upgrade", {
      ...productionTenantContextArgs({
        request_id: "req-review-visible-upgrade",
        correlation_id: "corr-review-visible-upgrade",
        actor_id: "workspace-a-reviewer",
        roles: ["dojo:reviewer"],
      }),
      request_id: "visible-upgrade-review-test",
      decision: "approved",
      reviewer_actor_id: "workspace-a-reviewer",
      reviewer_actor_type: "human",
      reason: "Workspace reviewer approved visible request.",
      evidence_refs: ["evidence:review-visible-upgrade"],
    });
    expect(visibleReview?.isError).toBeUndefined();
    expect(visibleReview?.structuredContent).toEqual(expect.objectContaining({
      ok: true,
      request_id: "visible-upgrade-review-test",
      permission_upgrade_request: expect.objectContaining({
        skill_id: visibleSkillId,
        workspace_id: "workspace-a",
        status: "approved",
      }),
      governance_service: expect.objectContaining({
        skill_registry: [
          expect.objectContaining({ skill_id: visibleSkillId }),
        ],
        approval_queue: [],
      }),
    }));
  });

  it("requires tenant authorization for production proof lifecycle tools", async () => {
    const { hiddenSkill } = await publishTwoWorkspaceSkillsForDojoToolTest();
    const issuedHiddenProof = await dispatchDojoTool("synthi_dojo_issue_proof_capsule", {
      skill_id: hiddenSkill.skill_id,
      requested_action: "run_workflow",
      context_claims: { workspace_verified: true },
    });
    expect(issuedHiddenProof?.isError).toBeUndefined();
    const hiddenProofCapsule = (issuedHiddenProof?.structuredContent as {
      proof_capsule: { capsule_id: string };
    }).proof_capsule;

    process.env.SYNTHI_DOJO_PRODUCTION_ENFORCEMENT = "1";
    const protectedProofCalls = [
      {
        tool_name: "synthi_dojo_issue_proof_capsule",
        args: {
          skill_id: hiddenSkill.skill_id,
          requested_action: "run_workflow",
          context_claims: { workspace_verified: true },
        },
      },
      {
        tool_name: "synthi_dojo_validate_proof_capsule",
        args: {
          skill_id: hiddenSkill.skill_id,
          requested_action: "run_workflow",
          proof_capsule: hiddenProofCapsule,
        },
      },
      {
        tool_name: "synthi_dojo_run_with_proof_capsule",
        args: {
          skill_id: hiddenSkill.skill_id,
          requested_action: "run_workflow",
          proof_capsule: hiddenProofCapsule,
          dry_run: true,
        },
      },
      {
        tool_name: "synthi_dojo_revoke_proof_capsule",
        args: {
          capsule_id: hiddenProofCapsule.capsule_id,
          reason: "cross-workspace proof lifecycle test",
          actor_id: "workspace-a-proof-operator",
          actor_type: "human",
          evidence_refs: ["evidence:proof-revocation-review"],
        },
      },
    ];

    for (const call of protectedProofCalls) {
      const blocked = await dispatchDojoTool(call.tool_name, {
        ...productionTenantContextArgs({
          request_id: `req-${call.tool_name}-hidden-proof`,
          correlation_id: `corr-${call.tool_name}-hidden-proof`,
          actor_id: "workspace-a-proof-operator",
          roles: ["dojo:reviewer"],
        }),
        ...call.args,
      });
      expect(blocked?.isError, call.tool_name).toBe(true);
      expect(blocked?.structuredContent, call.tool_name).toEqual(expect.objectContaining({
        error: "dojo_skill_not_authorized",
        skill_id: hiddenSkill.skill_id,
        workspace_id: "workspace-b",
        tenant_workspace_id: "workspace-a",
      }));
    }
  });

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
        expect.objectContaining({ name: "synthi_dojo_get_skill_cortex" }),
        expect.objectContaining({ name: "synthi_dojo_get_workspace_organoid" }),
        expect.objectContaining({ name: "synthi_dojo_get_evil_twin_report" }),
        expect.objectContaining({ name: "synthi_dojo_get_universe_dossier" }),
        expect.objectContaining({ name: "synthi_dojo_run_vivarium_scenario" }),
        expect.objectContaining({ name: "synthi_dojo_run_wind_tunnel" }),
        expect.objectContaining({ name: "synthi_dojo_get_agent_ready_ui_contract" }),
        expect.objectContaining({ name: "synthi_dojo_explain_failure" }),
        expect.objectContaining({ name: "synthi_dojo_publish_skill" }),
        expect.objectContaining({ name: "synthi_dojo_review_permission_upgrade" }),
        expect.objectContaining({ name: "synthi_dojo_review_case_law" }),
        expect.objectContaining({ name: "synthi_dojo_get_license_health" }),
        expect.objectContaining({ name: "synthi_dojo_record_case_law" }),
        expect.objectContaining({ name: "synthi_dojo_revoke_license" }),
        expect.objectContaining({ name: "synthi_dojo_export_artifacts" }),
        expect.objectContaining({ name: "synthi_dojo_export_compliance_pack" }),
        expect.objectContaining({ name: "synthi_dojo_create_hosted_runtime_session" }),
        expect.objectContaining({ name: "synthi_dojo_run_with_proof_capsule" }),
      ]));
      const reviewPermissionUpgrade = listed.tools.find((tool) => tool.name === "synthi_dojo_review_permission_upgrade");
      const reviewCaseLaw = listed.tools.find((tool) => tool.name === "synthi_dojo_review_case_law");
      expect(reviewPermissionUpgrade?.inputSchema).toEqual(expect.objectContaining({
        required: expect.arrayContaining(["evidence_refs"]),
      }));
      expect(reviewCaseLaw?.inputSchema).toEqual(expect.objectContaining({
        required: expect.arrayContaining(["evidence_refs"]),
      }));
      const tenantScopedToolNames = [
        "synthi_dojo_get_skill",
        "synthi_dojo_get_skill_cortex",
        "synthi_dojo_get_workspace_organoid",
        "synthi_dojo_get_wind_tunnel_report",
        "synthi_dojo_get_counterfactual_twin",
        "synthi_dojo_get_evil_twin_report",
        "synthi_dojo_get_training_report",
        "synthi_dojo_get_skill_passport",
        "synthi_dojo_get_skill_genome",
        "synthi_dojo_get_antibodies",
        "synthi_dojo_get_agent_ready_ui_contract",
        "synthi_dojo_get_cost_policy",
        "synthi_dojo_get_universe_dossier",
        "synthi_dojo_get_lifecycle",
        "synthi_dojo_get_governance_report",
        "synthi_dojo_get_source_affordance_pr_plan",
        "synthi_dojo_get_skill_assurance_case",
        "synthi_dojo_get_entrustment_level",
        "synthi_dojo_get_license",
        "synthi_dojo_get_guardrails",
        "synthi_dojo_get_case_law",
        "synthi_dojo_explain_block",
        "synthi_dojo_explain_failure",
        "synthi_dojo_debug_counterfactual",
        "synthi_dojo_run_time_machine_debugger",
        "synthi_dojo_run_ghost_mode",
        "synthi_dojo_request_permission_upgrade",
        "synthi_dojo_review_permission_upgrade",
        "synthi_dojo_review_case_law",
        "synthi_dojo_generate_vivarium_scenarios",
        "synthi_dojo_run_vivarium_scenario",
        "synthi_dojo_run_wind_tunnel",
        "synthi_dojo_run_checkride",
        "synthi_dojo_publish_skill",
        "synthi_dojo_recertify_skill",
        "synthi_dojo_get_license_health",
        "synthi_dojo_revoke_license",
        "synthi_dojo_record_case_law",
        "synthi_dojo_export_artifacts",
        "synthi_dojo_export_compliance_pack",
        "synthi_dojo_issue_proof_capsule",
        "synthi_dojo_validate_proof_capsule",
        "synthi_dojo_revoke_proof_capsule",
        "synthi_dojo_create_hosted_runtime_session",
        "synthi_dojo_run_with_proof_capsule",
      ];
      for (const toolName of tenantScopedToolNames) {
        const tool = listed.tools.find((candidate) => candidate.name === toolName);
        const schema = tool?.inputSchema as { properties?: Record<string, unknown> } | undefined;
        expect(schema?.properties, toolName).toEqual(expect.objectContaining({
          tenant_id: { type: "string" },
          organization_id: { type: "string" },
          workspace_id: { type: "string" },
          actor_id: { type: "string" },
          actor_type: { type: "string", enum: ["human", "agent", "service"] },
          roles: { type: "array", items: { type: "string" } },
          request_id: { type: "string" },
          correlation_id: { type: "string" },
        }));
      }
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("requires ledger-backed evidence before issuing proof capsules in production enforcement", async () => {
    process.env.SYNTHI_DOJO_PRODUCTION_ENFORCEMENT = "1";
    process.env.SYNTHI_DOJO_REQUIRE_EVIDENCE_LEDGER = "1";

    recordOpenDetailsWorkflowForDojoToolTest();
    const publish = await dispatchDojoTool("synthi_dojo_publish_skill", publishArgsForDojoToolTest({
      ...productionTenantContextArgs({
        actor_id: "unit-publisher",
        actor_type: "human",
        request_id: "req-production-proof-publish",
        correlation_id: "corr-production-proof-publish",
      }),
    }));
    expect(publish?.isError).toBeUndefined();
    const skillId = (publish?.structuredContent as { skill: { skill_id: string } }).skill.skill_id;

    const missingEvidence = await dispatchDojoTool("synthi_dojo_issue_proof_capsule", {
      skill_id: skillId,
      ...productionTenantContextArgs({
        actor_id: "proof-issuer-a",
        request_id: "req-proof-missing-evidence",
      }),
      requested_action: "run_workflow",
      context_claims: { workspace_verified: true },
      now: "2026-06-11T00:05:00.000Z",
    });
    expect(missingEvidence?.isError).toBe(true);
    expect(missingEvidence?.structuredContent).toEqual(expect.objectContaining({
      error: "dojo_proof_evidence_claim_unverified",
      ok: false,
      enforcement_mode: "production",
      require_verified_evidence: true,
      evidence_record_count: 0,
      failed_evidence_claims: expect.arrayContaining(["checkride_passed", "success_assertions_defined", "guardrails_active"]),
      error_codes: ["proof_evidence_claim_unverified"],
    }));

    const storedSkill = dojoSkillRegistry.get(skillId);
    expect(storedSkill).toBeTruthy();
    const evidenceRecord = buildDojoEvidenceLedgerRecord({
      record_id: "evidence-production-proof-001",
      tenant_id: "tenant-a",
      workspace_id: "workspace-a",
      skill_id: skillId,
      run_id: "checkride-run-a",
      kind: "checkride",
      artifact_uri: "dojo-artifact://proof/checkride.report.md",
      artifact_sha256: "a".repeat(64),
      redaction_manifest_sha256: "b".repeat(64),
      claim_ids: storedSkill?.permission_license.proof_requirements.required_evidence_claims ?? [],
      previous_hash: "0".repeat(64),
      created_at: "2026-06-11T00:00:00.000Z",
      created_by: "dojo-tool-production-test",
      retention_class: "standard",
    });

    const missingTenantContext = await dispatchDojoTool("synthi_dojo_issue_proof_capsule", {
      skill_id: skillId,
      tenant_id: "tenant-a",
      requested_action: "run_workflow",
      context_claims: { workspace_verified: true },
      evidence_ledger_records: [evidenceRecord],
      now: "2026-06-11T00:05:00.000Z",
      expires_at: "2026-06-11T00:15:00.000Z",
    });
    expect(missingTenantContext?.isError).toBe(true);
    expect(missingTenantContext?.structuredContent).toEqual(expect.objectContaining({
      error: "dojo_tenant_context_required",
      ok: false,
      enforcement_mode: "production",
      missing_fields: expect.arrayContaining([
        "organization_id",
        "workspace_id",
        "actor_id",
        "actor_type",
        "roles",
        "request_id",
        "correlation_id",
      ]),
      blocked_by: expect.arrayContaining([
        "tenant_context_actor_id_missing",
        "tenant_context_actor_type_missing",
        "tenant_context_roles_missing",
      ]),
    }));

    const wrongWorkspaceEvidence = buildDojoEvidenceLedgerRecord({
      record_id: "evidence-production-proof-wrong-workspace",
      tenant_id: "tenant-a",
      workspace_id: "workspace-other",
      skill_id: skillId,
      run_id: "checkride-run-b",
      kind: "checkride",
      artifact_uri: "dojo-artifact://proof/checkride-wrong-workspace.report.md",
      artifact_sha256: "c".repeat(64),
      redaction_manifest_sha256: "d".repeat(64),
      claim_ids: storedSkill?.permission_license.proof_requirements.required_evidence_claims ?? [],
      previous_hash: "0".repeat(64),
      created_at: "2026-06-11T00:00:00.000Z",
      created_by: "dojo-tool-production-test",
      retention_class: "standard",
    });
    const wrongScope = await dispatchDojoTool("synthi_dojo_issue_proof_capsule", {
      skill_id: skillId,
      ...productionTenantContextArgs({
        actor_id: "proof-issuer-a",
        request_id: "req-proof-wrong-scope",
      }),
      requested_action: "run_workflow",
      context_claims: { workspace_verified: true },
      evidence_ledger_records: [wrongWorkspaceEvidence],
      now: "2026-06-11T00:05:00.000Z",
      expires_at: "2026-06-11T00:15:00.000Z",
    });
    expect(wrongScope?.isError).toBe(true);
    const requiredClaims = storedSkill?.permission_license.proof_requirements.required_evidence_claims ?? [];
    expect(requiredClaims.length).toBeGreaterThan(0);
    const expectedClaim = requiredClaims[0]!;
    expect(wrongScope?.structuredContent).toEqual(expect.objectContaining({
      error: "dojo_proof_evidence_claim_unverified",
      ok: false,
      failed_evidence_claims: expect.arrayContaining(requiredClaims),
      blocked_by: expect.arrayContaining([`evidence_claim_scope_mismatch:${expectedClaim}`]),
      failed_evidence_claim_results: expect.arrayContaining([
        expect.objectContaining({
          claim_id: expectedClaim,
          ok: false,
          status: "failed",
          evidence_record_ids: ["evidence-production-proof-wrong-workspace"],
          blocked_by: expect.arrayContaining([`evidence_claim_scope_mismatch:${expectedClaim}`]),
        }),
      ]),
    }));

    const issued = await dispatchDojoTool("synthi_dojo_issue_proof_capsule", {
      skill_id: skillId,
      ...productionTenantContextArgs({
        actor_id: "proof-issuer-a",
        request_id: "req-proof-issued",
      }),
      requested_action: "run_workflow",
      context_claims: { workspace_verified: true },
      evidence_ledger_records: [evidenceRecord],
      now: "2026-06-11T00:05:00.000Z",
      expires_at: "2026-06-11T00:15:00.000Z",
    });
    expect(issued?.isError).toBeUndefined();
    expect(issued?.structuredContent).toEqual(expect.objectContaining({
      ok: true,
      enforcement_mode: "production",
      require_verified_evidence: true,
      proof_capsule: expect.objectContaining({
        evidence_record_ids: ["evidence-production-proof-001"],
        ledger_checkpoint_hash: evidenceRecord.ledger_head_hash,
        evidence_claims: storedSkill?.permission_license.proof_requirements.required_evidence_claims.map((claim) => ({
          claim,
          satisfied: true,
          evidence_refs: ["evidence:evidence-production-proof-001"],
        })),
      }),
      proof_record: expect.objectContaining({
        tenant_id: "tenant-a",
        workspace_id: "workspace-a",
        skill_id: skillId,
        license_id: storedSkill?.permission_license.license_id,
        license_version: storedSkill?.permission_license.license_version,
        key_id: expect.any(String),
        signature_algorithm: expect.any(String),
        substrate_claim: storedSkill?.preferred_substrate,
        evidence_record_ids: ["evidence-production-proof-001"],
        ledger_checkpoint_hash: evidenceRecord.ledger_head_hash,
        issued_by: { actor_id: "proof-issuer-a", actor_type: "agent" },
        status: "issued",
      }),
    }));
  });

  it("returns structured proof errors when proof issuance receives invalid timestamps", async () => {
    recordOpenDetailsWorkflowForDojoToolTest();
    const publish = await dispatchDojoTool("synthi_dojo_publish_skill", publishArgsForDojoToolTest());
    expect(publish?.isError).toBeUndefined();
    const skillId = (publish?.structuredContent as { skill: { skill_id: string } }).skill.skill_id;

    const invalidExpiry = await dispatchDojoTool("synthi_dojo_issue_proof_capsule", {
      skill_id: skillId,
      requested_action: "run_workflow",
      context_claims: { workspace_verified: true },
      now: "2026-06-11T00:00:00.000Z",
      expires_at: "not-a-date",
    });

    expect(invalidExpiry?.isError).toBe(true);
    expect(invalidExpiry?.structuredContent).toEqual(expect.objectContaining({
      error: "dojo_proof_capsule_invalid",
      ok: false,
      skill_id: skillId,
      requested_action: "run_workflow",
      blocked_by: ["proof_capsule_expires_at_invalid"],
      error_codes: ["proof_capsule_invalid"],
    }));
  });

  it("reports malformed license expiry metadata as blocked license health", async () => {
    recordOpenDetailsWorkflowForDojoToolTest();
    const publish = await dispatchDojoTool("synthi_dojo_publish_skill", publishArgsForDojoToolTest());
    expect(publish?.isError).toBeUndefined();
    const skillId = (publish?.structuredContent as { skill: { skill_id: string } }).skill.skill_id;
    const storedSkill = dojoSkillRegistry.get(skillId);
    expect(storedSkill).toBeTruthy();
    dojoSkillRegistry.publish({
      ...storedSkill!,
      license_expires_at: "not-a-date",
    });

    const health = await dispatchDojoTool("synthi_dojo_get_license_health", { skill_id: skillId });
    expect(health?.isError).toBeUndefined();
    expect(health?.structuredContent).toEqual(expect.objectContaining({
      license_health: expect.objectContaining({
        status: "blocked",
        days_until_expiry: null,
        lifecycle: expect.objectContaining({
          status: "blocked",
          recertification: expect.objectContaining({
            required: true,
            downgrade_to: "EX",
            triggers: expect.arrayContaining(["license_expiry_invalid"]),
          }),
        }),
      }),
    }));

    const metrics = await dispatchDojoTool("synthi_dojo_get_metrics", { skill_id: skillId });
    expect(metrics?.isError).toBeUndefined();
    expect(metrics?.structuredContent).toEqual(expect.objectContaining({
      metrics: expect.objectContaining({
        technical: expect.objectContaining({
          recertification_due_count: 1,
        }),
        trust: expect.objectContaining({
          stale_or_expired_license_count: 1,
        }),
      }),
    }));
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
    expect(scenarios?.structuredContent).toEqual(expect.objectContaining({
      implementation_status: "deterministic_projection",
      runtime_enforced: false,
      simulation_backing: "scenario_catalog",
    }));
    expect((scenarios?.structuredContent as { organoid: { scenarios: unknown[] } }).organoid.scenarios).toHaveLength(20);

    const checkrideRun = await dispatchDojoTool("synthi_dojo_run_checkride", {
      workspace_id: "workspace-a",
      tenant_id: "tenant-a",
      actor_id: "checkride-tester",
      now: "2026-06-11T00:00:00.000Z",
    });
    expect(checkrideRun?.isError).toBeUndefined();
    expect(checkrideRun?.structuredContent).toEqual(expect.objectContaining({
      implementation_status: "executable",
      runtime_enforced: true,
      runtime_scope: "synthetic_fixture_runtime",
      production_runtime: false,
      simulation_backing: "materialized_synthetic_fixture",
      checkride: expect.objectContaining({ schema_version: "synthi.dojo.checkrideReport.v1" }),
      executable_checkride: expect.objectContaining({
        schema_version: "synthi.dojo.executableCheckrideReport.v1",
        scenario_count: 20,
        graph_id: expect.stringContaining("graph_dojo_open_details"),
        evidence_refs: expect.arrayContaining([expect.stringMatching(/^evidence:evidence_oracle_/)]),
        results: expect.arrayContaining([
          expect.objectContaining({
            scenario_run: expect.objectContaining({ schema_version: "synthi.dojo.scenarioRunResult.v1" }),
            oracle: expect.objectContaining({ schema_version: "synthi.dojo.scenarioOracleResult.v1" }),
            evidence_record: expect.objectContaining({
              kind: "scenario",
              tenant_id: "tenant-a",
              workspace_id: "workspace-a",
            }),
          }),
        ]),
      }),
      graph_runtime: expect.objectContaining({
        graph_mode: "checkride",
        validation: { ok: true, issues: [] },
        executable_node_kinds: expect.arrayContaining(["Trigger", "Action", "Assertion"]),
      }),
      scenario_definitions: expect.arrayContaining([
        expect.objectContaining({ schema_version: "synthi.dojo.scenarioDefinition.v1" }),
      ]),
      scenario_definition_validation: expect.arrayContaining([
        expect.objectContaining({ validation: expect.objectContaining({ ok: true }) }),
      ]),
      runtime_guardrails: expect.any(Array),
    }));

    const publishMissingReason = await dispatchDojoTool("synthi_dojo_publish_skill", {
      workspace_id: "workspace-a",
      actor_id: "unit-publisher",
      actor_type: "human",
      evidence_refs: ["evidence:unit-publish"],
    });
    expect(publishMissingReason?.isError).toBe(true);
    expect(publishMissingReason?.structuredContent).toEqual(expect.objectContaining({
      error: "dojo_skill_publication_reason_required",
    }));
    const publishMissingEvidence = await dispatchDojoTool("synthi_dojo_publish_skill", {
      workspace_id: "workspace-a",
      reason: "unit_test_publish",
      actor_id: "unit-publisher",
      actor_type: "human",
    });
    expect(publishMissingEvidence?.isError).toBe(true);
    expect(publishMissingEvidence?.structuredContent).toEqual(expect.objectContaining({
      error: "dojo_skill_publication_evidence_required",
    }));
    const publishMissingActor = await dispatchDojoTool("synthi_dojo_publish_skill", {
      workspace_id: "workspace-a",
      reason: "unit_test_publish",
      actor_type: "human",
      evidence_refs: ["evidence:unit-publish"],
    });
    expect(publishMissingActor?.isError).toBe(true);
    expect(publishMissingActor?.structuredContent).toEqual(expect.objectContaining({
      error: "dojo_skill_publication_actor_required",
    }));
    const publishInvalidActorType = await dispatchDojoTool("synthi_dojo_publish_skill", {
      workspace_id: "workspace-a",
      reason: "unit_test_publish",
      actor_id: "unit-publisher",
      actor_type: "robot",
      evidence_refs: ["evidence:unit-publish"],
    });
    expect(publishInvalidActorType?.isError).toBe(true);
    expect(publishInvalidActorType?.structuredContent).toEqual(expect.objectContaining({
      error: "dojo_skill_publication_actor_type_required",
    }));
    const publish = await dispatchDojoTool("synthi_dojo_publish_skill", publishArgsForDojoToolTest());
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
    expect(publish?.structuredContent).toEqual(expect.objectContaining({
      publication: expect.objectContaining({
        ok: true,
        status: "applied",
        reason: "unit_test_publish",
        evidence_refs: ["evidence:unit-publish"],
        audit_event: expect.objectContaining({
          event_type: "skill_version_created",
          actor: { actor_id: "unit-publisher", actor_type: "human" },
          evidence_refs: ["evidence:unit-publish"],
        }),
      }),
    }));
    const publishedSkill = dojoSkillRegistry.get(published.skill.skill_id);
    expect(publishedSkill).toBeTruthy();
    const publishedManifest = (publish?.structuredContent as {
      mcp_skill_manifest: DojoMcpSkillManifestV1;
    }).mcp_skill_manifest;
    expect(publishedManifest).toEqual(expect.objectContaining({
      kind: "dojoMcpSkillManifest",
      schema_version: "synthi.dojo.mcpSkillManifest.v1",
      manifest_digest: expect.stringMatching(/^sha256:/),
      signature: expect.stringMatching(/^hmac-sha256:/),
    }));
    expect(validateDojoMcpSkillManifest(publishedManifest, {
      expected_skill_id: published.skill.skill_id,
      expected_tool_name: "synthi_app_open_details",
    })).toEqual(expect.objectContaining({ ok: true, blocked_by: [] }));
    expect((publish?.structuredContent as { repo_artifacts: Array<{ path: string }> }).repo_artifacts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: ".synthi/dojo/skills/open_details/license.json" }),
        expect.objectContaining({ path: ".synthi/dojo/skills/open_details/proof-capsule.schema.json" }),
      ])
    );
    expect(privateWorkflowToolRegistry.get("synthi_app_open_details")).toBeTruthy();
    const direct = await dispatchBrowserTool("synthi_app_open_details", {});
    expect(direct?.isError).toBe(true);
    expect(direct?.structuredContent).toEqual(expect.objectContaining({
      error: "dojo_proof_capsule_required",
      required_tool: "synthi_dojo_run_with_proof_capsule",
    }));
    const explainBlock = await dispatchDojoTool("synthi_dojo_explain_block", {
      skill_id: published.skill.skill_id,
      requested_action: "run_workflow",
    });
    expect(explainBlock?.structuredContent).toEqual(expect.objectContaining({
      ok: false,
      refusal: expect.stringContaining("I will not run"),
      refusal_explanation: expect.objectContaining({
        schema_version: "synthi.dojo.runtimeRefusalExplanation.v1",
        blocked_action: "run_workflow",
        blocked_by: expect.arrayContaining(["proof_capsule_missing"]),
        case_law_citations: [],
        smallest_allowed_next_step: "Provide the missing proof, approval, or runtime condition before run_workflow.",
      }),
    }));

    const capsuleResponse = await dispatchDojoTool("synthi_dojo_issue_proof_capsule", {
      skill_id: published.skill.skill_id,
      requested_action: "run_workflow",
      context_claims: { workspace_verified: true },
      evidence_ledger_records: evidenceLedgerRecordsForProof(publishedSkill!),
      require_verified_evidence: true,
    });
    expect(capsuleResponse?.isError).toBeUndefined();
    const capsule = (capsuleResponse?.structuredContent as { proof_capsule: unknown }).proof_capsule;
    const capsuleRecord = capsule as { capsule_id: string; issued_at: string };
    const validationTime = new Date(Date.parse(capsuleRecord.issued_at) + 1000).toISOString();

    const validate = await dispatchDojoTool("synthi_dojo_validate_proof_capsule", {
      skill_id: published.skill.skill_id,
      requested_action: "run_workflow",
      proof_capsule: capsule,
      now: validationTime,
    });
    expect(validate?.isError).toBeUndefined();
    expect(validate?.structuredContent).toEqual(expect.objectContaining({
      proof_record: expect.objectContaining({
        capsule_id: capsuleRecord.capsule_id,
        last_validated_at: validationTime,
        status: "issued",
      }),
      license_kernel: expect.objectContaining({ ok: true, status: "allowed" }),
    }));
    expect(dojoSkillRegistry.getProofRecord(capsuleRecord.capsule_id)).toEqual(expect.objectContaining({
      last_validated_at: validationTime,
      status: "issued",
    }));

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
      implementation_status: "executable",
      runtime_enforced: true,
      runtime_scope: "proof_gated_dispatch",
      production_runtime: false,
      validation: expect.objectContaining({ ok: true, status: "allowed" }),
      skill_bus: expect.objectContaining({
        ok: true,
        status: "allowed",
        dry_run: true,
        resolution: expect.objectContaining({ status: "resolved" }),
      }),
    }));

    const prefixCapsuleResponse = await dispatchDojoTool("synthi_dojo_issue_proof_capsule", {
      skill_id: published.skill.skill_id,
      requested_action: "run_prefix_validation",
      context_claims: { workspace_verified: true },
      evidence_ledger_records: evidenceLedgerRecordsForProof(publishedSkill!, { record_id: "evidence-prefix-proof" }),
      require_verified_evidence: true,
      now: "2026-06-11T00:00:00.000Z",
      expires_at: "2026-06-11T00:15:00.000Z",
    });
    expect(prefixCapsuleResponse?.isError).toBeUndefined();
    const prefixCapsule = (prefixCapsuleResponse?.structuredContent as { proof_capsule: unknown }).proof_capsule;
    const prefixDryRun = await dispatchDojoTool("synthi_dojo_run_with_proof_capsule", {
      skill_id: published.skill.skill_id,
      requested_action: "run_prefix_validation",
      proof_capsule: prefixCapsule,
      dry_run: true,
      run_id: "unit-prefix-run-dry",
      now: "2026-06-11T00:01:00.000Z",
    });
    expect(prefixDryRun?.structuredContent).toEqual(expect.objectContaining({
      ok: true,
      dry_run: true,
      skill_bus: expect.objectContaining({ dry_run: true }),
    }));
    expect(dojoSkillRegistry.getProofRecord((prefixCapsule as { capsule_id: string }).capsule_id)).toEqual(
      expect.objectContaining({
        workspace_id: publishedSkill?.workspace_id,
        license_id: publishedSkill?.permission_license.license_id,
        license_version: publishedSkill?.permission_license.license_version,
        status: "issued",
      })
    );
    const prefixRun = await dispatchDojoTool("synthi_dojo_run_with_proof_capsule", {
      skill_id: published.skill.skill_id,
      requested_action: "run_prefix_validation",
      proof_capsule: prefixCapsule,
      run_id: "unit-prefix-run-1",
      now: "2026-06-11T00:02:00.000Z",
    });
    expect(prefixRun?.isError).toBeUndefined();
    expect(prefixRun?.structuredContent).toEqual(expect.objectContaining({
      ok: true,
      run_id: "unit-prefix-run-1",
      proof_consume: expect.objectContaining({
        ok: true,
        status: "used",
        blocked_by: [],
      }),
      proof_record: expect.objectContaining({
        status: "used",
        first_used_at: "2026-06-11T00:02:00.000Z",
      }),
      skill_bus: expect.objectContaining({
        ok: true,
        status: "allowed",
        dry_run: false,
      }),
      result: expect.objectContaining({
        ok: true,
        validation: expect.objectContaining({ status: expect.any(String) }),
      }),
    }));
    const prefixReplay = await dispatchDojoTool("synthi_dojo_run_with_proof_capsule", {
      skill_id: published.skill.skill_id,
      requested_action: "run_prefix_validation",
      proof_capsule: prefixCapsule,
      run_id: "unit-prefix-run-2",
      now: "2026-06-11T00:03:00.000Z",
    });
    expect(prefixReplay?.isError).toBe(true);
    expect(prefixReplay?.structuredContent).toEqual(expect.objectContaining({
      validation: expect.objectContaining({
        blocked_by: expect.arrayContaining(["proof_capsule_replay_detected"]),
      }),
      license_kernel: expect.objectContaining({
        blocked_by: expect.arrayContaining(["proof_capsule_replay_detected"]),
      }),
    }));

    dojoSkillRegistry.markProofCapsuleUsed((capsule as { capsule_id: string }).capsule_id, "2026-06-11T00:01:00.000Z");
    const replay = await dispatchDojoTool("synthi_dojo_run_with_proof_capsule", {
      skill_id: published.skill.skill_id,
      requested_action: "run_workflow",
      proof_capsule: capsule,
      dry_run: false,
    });
    expect(replay?.isError).toBe(true);
    expect(replay?.structuredContent).toEqual(expect.objectContaining({
      license_kernel: expect.objectContaining({
        blocked_by: expect.arrayContaining(["proof_capsule_replay_detected"]),
      }),
    }));

    const secondCapsuleResponse = await dispatchDojoTool("synthi_dojo_issue_proof_capsule", {
      skill_id: published.skill.skill_id,
      requested_action: "run_workflow",
      context_claims: { workspace_verified: true },
      evidence_ledger_records: evidenceLedgerRecordsForProof(publishedSkill!, { record_id: "evidence-second-proof" }),
      require_verified_evidence: true,
    });
    const secondCapsule = (secondCapsuleResponse?.structuredContent as { proof_capsule: { capsule_id: string } }).proof_capsule;
    const revokedProofMissingReason = await dispatchDojoTool("synthi_dojo_revoke_proof_capsule", {
      capsule_id: secondCapsule.capsule_id,
      actor_id: "proof-reviewer-a",
      actor_type: "human",
    });
    expect(revokedProofMissingReason?.isError).toBe(true);
    expect(revokedProofMissingReason?.structuredContent).toEqual(expect.objectContaining({
      error: "dojo_proof_capsule_revocation_reason_required",
    }));
    const revokedProofMissingActor = await dispatchDojoTool("synthi_dojo_revoke_proof_capsule", {
      capsule_id: secondCapsule.capsule_id,
      reason: "unit_test_revocation",
      actor_type: "human",
    });
    expect(revokedProofMissingActor?.isError).toBe(true);
    expect(revokedProofMissingActor?.structuredContent).toEqual(expect.objectContaining({
      error: "dojo_proof_capsule_revocation_actor_required",
    }));
    const revokedProofMissingActorType = await dispatchDojoTool("synthi_dojo_revoke_proof_capsule", {
      capsule_id: secondCapsule.capsule_id,
      reason: "unit_test_revocation",
      actor_id: "proof-reviewer-a",
    });
    expect(revokedProofMissingActorType?.isError).toBe(true);
    expect(revokedProofMissingActorType?.structuredContent).toEqual(expect.objectContaining({
      error: "dojo_proof_capsule_revocation_actor_type_required",
    }));
    const revokedProofMissingEvidence = await dispatchDojoTool("synthi_dojo_revoke_proof_capsule", {
      capsule_id: secondCapsule.capsule_id,
      reason: "unit_test_revocation",
      actor_id: "proof-reviewer-a",
      actor_type: "human",
    });
    expect(revokedProofMissingEvidence?.isError).toBe(true);
    expect(revokedProofMissingEvidence?.structuredContent).toEqual(expect.objectContaining({
      error: "dojo_proof_capsule_revocation_evidence_required",
    }));
    const revokedProof = await dispatchDojoTool("synthi_dojo_revoke_proof_capsule", {
      capsule_id: secondCapsule.capsule_id,
      reason: "unit_test_revocation",
      actor_id: "proof-reviewer-a",
      actor_type: "human",
      evidence_refs: ["evidence:proof-revocation"],
      now: "2026-06-11T00:01:30.000Z",
    });
    expect(revokedProof?.structuredContent).toEqual(expect.objectContaining({
      proof_record: expect.objectContaining({
        status: "revoked",
        revoked_at: "2026-06-11T00:01:30.000Z",
        revoked_reason: "unit_test_revocation",
        revoked_by: { actor_id: "proof-reviewer-a", actor_type: "human" },
        revocation_evidence_refs: ["evidence:proof-revocation"],
      }),
    }));
    const revokedProofValidation = await dispatchDojoTool("synthi_dojo_validate_proof_capsule", {
      skill_id: published.skill.skill_id,
      requested_action: "run_workflow",
      proof_capsule: secondCapsule,
    });
    expect(revokedProofValidation?.isError).toBeUndefined();
    expect(revokedProofValidation?.structuredContent).toEqual(expect.objectContaining({
      ok: false,
      license_kernel: expect.objectContaining({
        blocked_by: expect.arrayContaining(["proof_capsule_revoked"]),
      }),
    }));

    const universe = await dispatchDojoTool("synthi_dojo_get_universe_dossier", { skill_id: published.skill.skill_id });
    expect(universe?.structuredContent).toEqual(expect.objectContaining({
      implementation_status: "report_only",
      runtime_enforced: false,
      universe_dossier: expect.objectContaining({
        lifecycle: expect.objectContaining({ schema_version: "synthi.dojo.lifecycleReport.v1" }),
        evidence_ledger: expect.objectContaining({ schema_version: "synthi.dojo.evidenceLedger.v1" }),
      }),
    }));
    const sourcePlan = await dispatchDojoTool("synthi_dojo_get_source_affordance_pr_plan", { skill_id: published.skill.skill_id });
    expect(sourcePlan?.structuredContent).toEqual(expect.objectContaining({
      source_affordance_pr_plan: expect.objectContaining({
        patch_count: expect.any(Number),
        files: expect.any(Array),
        typed_patch_plan: expect.objectContaining({
          schema_version: "synthi.dojo.affordancePrPlan.v1",
          operations: expect.arrayContaining([
            expect.objectContaining({
              kind: "stable_locator",
              target_match: expect.objectContaining({ role: "action" }),
            }),
          ]),
          required_tests: expect.arrayContaining([
            "npm --prefix mcp/synthi-mcp run proof:dojo:affordance-codemod:self-check",
          ]),
        }),
        generated_pr_metadata: expect.objectContaining({
          schema_version: "synthi.dojo.generatedSourcePrMetadata.v1",
          branch_name: expect.stringMatching(/^dojo\/source-affordance\/typed-source-pr-[a-z0-9-]+-[a-f0-9]{12}$/),
          review_requirements: expect.arrayContaining([
            expect.objectContaining({
              gate: "code_owner",
              status: "pending",
              owners: [],
              paths: expect.arrayContaining([expect.stringMatching(/^src\//)]),
            }),
            expect.objectContaining({
              gate: "security_for_risky_action",
              operation_ids: expect.arrayContaining([expect.stringMatching(/^patch_proof_hook_/)]),
            }),
          ]),
          promotion_blockers: expect.arrayContaining([expect.stringMatching(/^generated_pr_code_owner_unresolved:/)]),
          artifact_refs: expect.arrayContaining([
            expect.objectContaining({ kind: "patch_plan" }),
            expect.objectContaining({ kind: "contract_test" }),
            expect.objectContaining({ kind: "training_report" }),
          ]),
        }),
      }),
    }));
    const registry = await dispatchDojoTool("synthi_dojo_get_registry", {});
    expect(registry?.structuredContent).toEqual(expect.objectContaining({
      registry: expect.objectContaining({
        skill_count: 1,
        competencies: expect.arrayContaining([expect.objectContaining({ skill_id: published.skill.skill_id })]),
      }),
      governance_service: expect.objectContaining({
        schema_version: "synthi.dojo.governanceService.v1",
        skill_registry: expect.arrayContaining([expect.objectContaining({ skill_id: published.skill.skill_id })]),
        compliance_evidence_pack: expect.objectContaining({
          artifacts: expect.any(Array),
        }),
      }),
    }));
    const governance = await dispatchDojoTool("synthi_dojo_get_governance_report", { skill_id: published.skill.skill_id });
    expect(governance?.structuredContent).toEqual(expect.objectContaining({
      governance_report: expect.objectContaining({ schema_version: "synthi.dojo.governanceReport.v1" }),
      governance_service: expect.objectContaining({
        schema_version: "synthi.dojo.governanceService.v1",
        policy_gates: expect.any(Array),
        recertification_queue: expect.any(Array),
      }),
    }));
    const timeMachine = await dispatchDojoTool("synthi_dojo_run_time_machine_debugger", {
      skill_id: published.skill.skill_id,
      mutation_kind: "duplicate_entity",
      question: "What if the entity were unique?",
    });
    expect(timeMachine?.structuredContent).toEqual(expect.objectContaining({
      time_machine_debugger: expect.objectContaining({
        baseline: expect.any(Object),
        counterfactual: expect.any(Object),
      }),
    }));
    const ghostMode = await dispatchDojoTool("synthi_dojo_run_ghost_mode", {
      skill_id: published.skill.skill_id,
      observed_human_action: { label: "Open details", action: "click" },
      agent_planned_action: { label: "Delete details", action: "click" },
      now: "2026-06-11T00:02:00.000Z",
    });
    expect(ghostMode?.structuredContent).toEqual(expect.objectContaining({
      implementation_status: "executable",
      ghost_run: expect.objectContaining({
        mode: "ghost",
        status: "mismatch",
        would_execute: false,
        production_mutations_executed: false,
        shadow_evidence_id: expect.stringMatching(/^ghost_evidence_/),
        shadow_evidence_audit_event_id: expect.stringMatching(/^audit_/),
        evidence_refs: expect.arrayContaining([
          `skill:${published.skill.skill_id}`,
          expect.stringMatching(/^ghost:ghost_/),
        ]),
        entrustment_impact: expect.objectContaining({
          upgrade_allowed: false,
          recommended_entrustment: "EX",
        }),
      }),
      shadow_evidence: expect.objectContaining({
        schema_version: "synthi.dojo.ghostShadowEvidence.v1",
        tenant_id: expect.any(String),
        workspace_id: expect.any(String),
        production_mutations_executed: false,
        action_matches: false,
        observed_label: "open details",
        planned_label: "delete details",
        entrustment_impact: expect.objectContaining({
          reason: expect.stringContaining("prevents entrustment upgrade"),
        }),
        created_by: expect.objectContaining({
          actor_id: expect.any(String),
          actor_type: expect.any(String),
        }),
        request_context: expect.objectContaining({
          request_id: expect.any(String),
          correlation_id: expect.any(String),
        }),
      }),
      shadow_evidence_recorded: true,
      shadow_evidence_audit_event: expect.objectContaining({
        audit_event_id: expect.stringMatching(/^audit_/),
        event_type: "ghost_shadow_evidence_recorded",
        entity_kind: "ghost_shadow_evidence",
        entity_id: expect.stringMatching(/^ghost_evidence_/),
        details: expect.objectContaining({
          skill_id: published.skill.skill_id,
          workflow_id: published.skill.workflow_id,
          action_matches: false,
          observed_label: "open details",
          planned_label: "delete details",
          production_mutations_executed: false,
          recommended_entrustment: "EX",
        }),
      }),
    }));
    const shadowEvidence = (ghostMode?.structuredContent as { shadow_evidence: { evidence_id: string } } | undefined)?.shadow_evidence;
    const shadowEvidenceAuditEvent = (ghostMode?.structuredContent as { shadow_evidence_audit_event: { audit_event_id: string } } | undefined)?.shadow_evidence_audit_event;
    expect(dojoSkillRegistry.listGhostShadowEvidence({ evidence_id: shadowEvidence?.evidence_id })).toEqual([
      expect.objectContaining({
        evidence_id: shadowEvidence?.evidence_id,
        skill_id: published.skill.skill_id,
        workflow_id: published.skill.workflow_id,
        production_mutations_executed: false,
        action_matches: false,
      }),
    ]);
    expect(dojoSkillRegistry.listAuditEvents({
      event_type: "ghost_shadow_evidence_recorded",
      entity_kind: "ghost_shadow_evidence",
      entity_id: shadowEvidence?.evidence_id,
    })).toEqual([
      expect.objectContaining({
        audit_event_id: shadowEvidenceAuditEvent?.audit_event_id,
        actor: expect.objectContaining({ actor_type: "agent" }),
        details: expect.objectContaining({
          skill_id: published.skill.skill_id,
          run_id: expect.stringMatching(/^ghost_/),
          production_mutations_executed: false,
        }),
      }),
    ]);
    const complianceAfterGhost = await dispatchDojoTool("synthi_dojo_export_compliance_pack", {
      skill_id: published.skill.skill_id,
      now: "2026-06-11T00:02:30.000Z",
    });
    expect(complianceAfterGhost?.structuredContent).toEqual(expect.objectContaining({
      pack: expect.objectContaining({
        audit_exports: expect.arrayContaining([
          expect.objectContaining({
            export_id: "control_plane_audit",
            status: "available",
            record_count: 3,
            audit_event_refs: expect.arrayContaining([expect.stringMatching(/^audit:audit_/)]),
            event_type_counts: expect.objectContaining({
              ghost_shadow_evidence_recorded: 1,
              proof_used: 2,
            }),
          }),
        ]),
        compliance_evidence_pack: expect.objectContaining({
          artifacts: expect.arrayContaining([
            expect.objectContaining({
              artifact_id: "control_plane_audit",
              status: "available",
              evidence_refs: expect.arrayContaining([expect.stringMatching(/^audit:audit_/)]),
            }),
          ]),
        }),
      }),
      governance_service: expect.objectContaining({
        audit_exports: expect.arrayContaining([
          expect.objectContaining({ export_id: "control_plane_audit", record_count: 3 }),
        ]),
      }),
    }));
    const upgradeMissingActor = await dispatchDojoTool("synthi_dojo_request_permission_upgrade", {
      skill_id: published.skill.skill_id,
      requested_action: "commit_mutation",
      actor_type: "agent",
    });
    expect(upgradeMissingActor?.isError).toBe(true);
    expect(upgradeMissingActor?.structuredContent).toEqual(expect.objectContaining({
      error: "dojo_permission_upgrade_actor_required",
    }));
    const upgradeMissingActorType = await dispatchDojoTool("synthi_dojo_request_permission_upgrade", {
      skill_id: published.skill.skill_id,
      requested_action: "commit_mutation",
      actor_id: "reviewer-a",
    });
    expect(upgradeMissingActorType?.isError).toBe(true);
    expect(upgradeMissingActorType?.structuredContent).toEqual(expect.objectContaining({
      error: "dojo_permission_upgrade_actor_type_required",
    }));
    const upgradeRequest = await dispatchDojoTool("synthi_dojo_request_permission_upgrade", {
      skill_id: published.skill.skill_id,
      requested_action: "commit_mutation",
      actor_id: "reviewer-a",
      actor_type: "agent",
      request_id: "upgrade-test-request",
      correlation_id: "upgrade-test-correlation",
      now: "2026-06-11T00:03:00.000Z",
    });
    expect(upgradeRequest?.structuredContent).toEqual(expect.objectContaining({
      implementation_status: "executable",
      requested_action: "commit_mutation",
      permission_upgrade_request: expect.objectContaining({
        schema_version: "synthi.dojo.permissionUpgradeRequest.v1",
        request_id: "upgrade-test-request",
        skill_id: published.skill.skill_id,
        requested_action: "commit_mutation",
        status: "pending",
        requested_by: { actor_id: "reviewer-a", actor_type: "agent" },
        required_steps: expect.arrayContaining(["rerun_checkride_for_requested_action"]),
      }),
      matching_approval_queue: [
        expect.objectContaining({
          request_id: "upgrade-test-request",
          source: "permission_upgrade_request",
          action: "commit_mutation",
          status: "pending",
        }),
      ],
    }));
    const governanceAfterUpgrade = await dispatchDojoTool("synthi_dojo_get_governance_report", { skill_id: published.skill.skill_id });
    expect(governanceAfterUpgrade?.structuredContent).toEqual(expect.objectContaining({
      governance_service: expect.objectContaining({
        approval_queue: expect.arrayContaining([
          expect.objectContaining({
            request_id: "upgrade-test-request",
            source: "permission_upgrade_request",
          }),
        ]),
      }),
    }));
    const reviewMissingReviewer = await dispatchDojoTool("synthi_dojo_review_permission_upgrade", {
      request_id: "upgrade-test-request",
      decision: "approved",
      reviewer_actor_type: "human",
    });
    expect(reviewMissingReviewer?.isError).toBe(true);
    expect(reviewMissingReviewer?.structuredContent).toEqual(expect.objectContaining({
      error: "dojo_permission_upgrade_reviewer_required",
    }));
    const reviewMissingReviewerType = await dispatchDojoTool("synthi_dojo_review_permission_upgrade", {
      request_id: "upgrade-test-request",
      decision: "approved",
      reviewer_actor_id: "reviewer-b",
    });
    expect(reviewMissingReviewerType?.isError).toBe(true);
    expect(reviewMissingReviewerType?.structuredContent).toEqual(expect.objectContaining({
      error: "dojo_permission_upgrade_reviewer_actor_type_required",
    }));
    const reviewMissingEvidence = await dispatchDojoTool("synthi_dojo_review_permission_upgrade", {
      request_id: "upgrade-test-request",
      decision: "approved",
      reviewer_actor_id: "reviewer-b",
      reviewer_actor_type: "human",
      decided_at: "2026-06-11T00:04:00.000Z",
    });
    expect(reviewMissingEvidence?.isError).toBe(true);
    expect(reviewMissingEvidence?.structuredContent).toEqual(expect.objectContaining({
      error: "permission_upgrade_review_evidence_required",
      review: expect.objectContaining({
        ok: false,
        blocked_by: ["review_evidence_missing"],
      }),
    }));
    const reviewedUpgrade = await dispatchDojoTool("synthi_dojo_review_permission_upgrade", {
      request_id: "upgrade-test-request",
      decision: "approved",
      reviewer_actor_id: "reviewer-b",
      reviewer_actor_type: "human",
      reason: "Unit test reviewed evidence.",
      evidence_refs: ["evidence:unit-review"],
      decided_at: "2026-06-11T00:04:00.000Z",
    });
    expect(reviewedUpgrade?.structuredContent).toEqual(expect.objectContaining({
      ok: true,
      request_id: "upgrade-test-request",
      decision: "approved",
      permission_upgrade_request: expect.objectContaining({
        status: "approved",
        reviewed_at: "2026-06-11T00:04:00.000Z",
        reviewed_by: { actor_id: "reviewer-b", actor_type: "human" },
        review_reason: "Unit test reviewed evidence.",
        decision_evidence_refs: ["evidence:unit-review"],
        evidence_refs: expect.arrayContaining(["evidence:unit-review"]),
      }),
      review: expect.objectContaining({
        ok: true,
        audit_event: expect.objectContaining({ event_type: "approval_granted" }),
      }),
      governance_service: expect.objectContaining({
        approval_queue: [],
      }),
    }));
    const reviewedAgain = await dispatchDojoTool("synthi_dojo_review_permission_upgrade", {
      request_id: "upgrade-test-request",
      decision: "denied",
      reviewer_actor_id: "reviewer-c",
      reviewer_actor_type: "human",
    });
    expect(reviewedAgain?.isError).toBe(true);
    expect(reviewedAgain?.structuredContent).toEqual(expect.objectContaining({
      error: "permission_upgrade_request_not_pending",
      review: expect.objectContaining({
        ok: false,
        blocked_by: ["request_status:approved"],
      }),
    }));
    const scenarioRun = await dispatchDojoTool("synthi_dojo_run_vivarium_scenario", {
      skill_id: published.skill.skill_id,
      mutation_kind: "duplicate_entity",
      tenant_id: "tenant-vivarium",
      organization_id: "org-vivarium",
      workspace_id: "workspace-a",
      actor_id: "vivarium-tester",
      actor_type: "agent",
      request_id: "vivarium-tool-test",
      correlation_id: "vivarium-tool-test-correlation",
    });
    expect(scenarioRun?.structuredContent).toEqual(expect.objectContaining({
      implementation_status: "executable",
      runtime_enforced: true,
      runtime_scope: "synthetic_fixture_runtime",
      production_runtime: false,
      simulation_backing: "materialized_synthetic_fixture",
      vivarium_run: expect.objectContaining({
        schema_version: "synthi.dojo.vivariumScenarioRun.v1",
        tenant_context: expect.objectContaining({
          tenant_id: "tenant-vivarium",
          workspace_id: "workspace-a",
          request_id: "vivarium-tool-test",
        }),
        materialized_fixture: expect.objectContaining({ synthetic_data_only: true }),
      }),
      license_health: expect.objectContaining({ schema_version: "synthi.dojo.licenseHealth.v1" }),
    }));
    const windTunnel = await dispatchDojoTool("synthi_dojo_run_wind_tunnel", {
      skill_id: published.skill.skill_id,
      max_scenarios: 3,
      tenant_id: "tenant-vivarium",
      organization_id: "org-vivarium",
      workspace_id: "workspace-a",
      actor_id: "vivarium-tester",
      actor_type: "agent",
      request_id: "wind-tool-test",
      correlation_id: "wind-tool-test-correlation",
    });
    expect(windTunnel?.structuredContent).toEqual(expect.objectContaining({
      wind_tunnel_execution: expect.objectContaining({
        schema_version: "synthi.dojo.windTunnelExecution.v1",
        tenant_context: expect.objectContaining({
          tenant_id: "tenant-vivarium",
          workspace_id: "workspace-a",
          request_id: "wind-tool-test",
        }),
        run_count: 3,
        runs: expect.arrayContaining([
          expect.objectContaining({
            tenant_context: expect.objectContaining({
              correlation_id: "wind-tool-test-correlation",
            }),
          }),
        ]),
      }),
    }));
    const health = await dispatchDojoTool("synthi_dojo_get_license_health", { skill_id: published.skill.skill_id });
    expect(health?.structuredContent).toEqual(expect.objectContaining({
      license_health: expect.objectContaining({
        proof_records: expect.objectContaining({ used: 2, revoked: 1 }),
      }),
    }));
    const recertMissingReason = await dispatchDojoTool("synthi_dojo_recertify_skill", {
      skill_id: published.skill.skill_id,
      actor_id: "recertifier-a",
      actor_type: "human",
      evidence_refs: ["evidence:recertification"],
    });
    expect(recertMissingReason?.isError).toBe(true);
    expect(recertMissingReason?.structuredContent).toEqual(expect.objectContaining({
      error: "dojo_recertification_reason_required",
    }));
    const recertMissingEvidence = await dispatchDojoTool("synthi_dojo_recertify_skill", {
      skill_id: published.skill.skill_id,
      actor_id: "recertifier-a",
      actor_type: "human",
      reason: "unit_test_recertification",
    });
    expect(recertMissingEvidence?.isError).toBe(true);
    expect(recertMissingEvidence?.structuredContent).toEqual(expect.objectContaining({
      error: "dojo_recertification_evidence_required",
    }));
    const recertMissingActor = await dispatchDojoTool("synthi_dojo_recertify_skill", {
      skill_id: published.skill.skill_id,
      actor_type: "human",
      reason: "unit_test_recertification",
      evidence_refs: ["evidence:recertification"],
    });
    expect(recertMissingActor?.isError).toBe(true);
    expect(recertMissingActor?.structuredContent).toEqual(expect.objectContaining({
      error: "dojo_recertification_actor_required",
    }));
    const recertInvalidActorType = await dispatchDojoTool("synthi_dojo_recertify_skill", {
      skill_id: published.skill.skill_id,
      actor_id: "recertifier-a",
      actor_type: "robot",
      reason: "unit_test_recertification",
      evidence_refs: ["evidence:recertification"],
    });
    expect(recertInvalidActorType?.isError).toBe(true);
    expect(recertInvalidActorType?.structuredContent).toEqual(expect.objectContaining({
      error: "dojo_recertification_actor_type_required",
    }));
    const recertified = await dispatchDojoTool("synthi_dojo_recertify_skill", {
      skill_id: published.skill.skill_id,
      actor_id: "recertifier-a",
      actor_type: "human",
      reason: "unit_test_recertification",
      evidence_refs: ["evidence:recertification"],
      now: "2026-06-11T00:04:30.000Z",
    });
    expect(recertified?.structuredContent).toEqual(expect.objectContaining({
      ok: true,
      skill: expect.objectContaining({ skill_id: published.skill.skill_id }),
      recertification: expect.objectContaining({
        ok: true,
        status: "applied",
        skill_id: published.skill.skill_id,
        reason: "unit_test_recertification",
        evidence_refs: ["evidence:recertification"],
        audit_event: expect.objectContaining({
          event_type: "checkride_run_completed",
          actor: { actor_id: "recertifier-a", actor_type: "human" },
          tenant_context: expect.objectContaining({
            workspace_id: "workspace-a",
            actor_id: "recertifier-a",
          }),
          evidence_refs: ["evidence:recertification"],
        }),
      }),
      license_health: expect.objectContaining({ schema_version: "synthi.dojo.licenseHealth.v1" }),
      governance_service: expect.objectContaining({
        skill_registry: expect.arrayContaining([
          expect.objectContaining({ skill_id: published.skill.skill_id }),
        ]),
      }),
    }));
    const recordedCase = await dispatchDojoTool("synthi_dojo_record_case_law", {
      skill_id: published.skill.skill_id,
      finding: "A unit test discovered an unsafe action boundary",
      rule: "Require a verified context boundary before workflow execution",
      applies_to: ["workflow_execution"],
      evidence_refs: ["evidence:recorded-case"],
    });
    expect(recordedCase?.structuredContent).toEqual(expect.objectContaining({
      case_law: expect.objectContaining({ status: "proposed" }),
      case_law_record: expect.objectContaining({ status: "proposed" }),
      guardrail_binding_status: "review_required",
      guardrail_proposal: expect.objectContaining({ blocks_actions: ["workflow_execution"] }),
    }));
    const recordedCaseId = (recordedCase?.structuredContent as {
      case_law_record: { case_id: string };
    }).case_law_record.case_id;
    const listedCaseLaw = await dispatchDojoTool("synthi_dojo_get_case_law", { skill_id: published.skill.skill_id });
    expect(listedCaseLaw?.structuredContent).toEqual(expect.objectContaining({
      case_law_records: expect.arrayContaining([
        expect.objectContaining({ case_id: recordedCaseId, status: "proposed" }),
      ]),
    }));
    const reviewedCaseMissingActorType = await dispatchDojoTool("synthi_dojo_review_case_law", {
      case_id: recordedCaseId,
      skill_id: published.skill.skill_id,
      decision: "approved",
      reviewer_actor_id: "case-reviewer-a",
    });
    expect(reviewedCaseMissingActorType?.isError).toBe(true);
    expect(reviewedCaseMissingActorType?.structuredContent).toEqual(expect.objectContaining({
      error: "dojo_case_law_reviewer_actor_type_required",
    }));
    const reviewedCaseMissingEvidence = await dispatchDojoTool("synthi_dojo_review_case_law", {
      case_id: recordedCaseId,
      skill_id: published.skill.skill_id,
      decision: "approved",
      reviewer_actor_id: "case-reviewer-a",
      reviewer_actor_type: "human",
      decided_at: "2026-06-11T00:04:50.000Z",
    });
    expect(reviewedCaseMissingEvidence?.isError).toBe(true);
    expect(reviewedCaseMissingEvidence?.structuredContent).toEqual(expect.objectContaining({
      error: "case_law_review_evidence_required",
      review: expect.objectContaining({ blocked_by: ["review_evidence_missing"] }),
    }));
    const reviewedCase = await dispatchDojoTool("synthi_dojo_review_case_law", {
      case_id: recordedCaseId,
      skill_id: published.skill.skill_id,
      decision: "approved",
      reviewer_actor_id: "case-reviewer-a",
      reviewer_actor_type: "human",
      evidence_refs: ["evidence:case-approval"],
      decided_at: "2026-06-11T00:04:55.000Z",
    });
    expect(reviewedCase?.structuredContent).toEqual(expect.objectContaining({
      ok: true,
      case_law_record: expect.objectContaining({
        case_id: recordedCaseId,
        status: "approved",
        reviewer: "case-reviewer-a",
        evidence_refs: expect.arrayContaining(["evidence:case-approval", "evidence:recorded-case"]),
      }),
      skill: expect.objectContaining({ skill_id: published.skill.skill_id }),
    }));
    const reviewedCaseAgain = await dispatchDojoTool("synthi_dojo_review_case_law", {
      case_id: recordedCaseId,
      skill_id: published.skill.skill_id,
      decision: "approved",
      reviewer_actor_id: "case-reviewer-a",
      reviewer_actor_type: "human",
    });
    expect(reviewedCaseAgain?.isError).toBe(true);
    expect(reviewedCaseAgain?.structuredContent).toEqual(expect.objectContaining({
      error: "case_law_review_not_pending",
      review: expect.objectContaining({
        ok: false,
        blocked_by: ["case_law_status:approved"],
      }),
    }));
    const deprecatedCase = await dispatchDojoTool("synthi_dojo_review_case_law", {
      case_id: recordedCaseId,
      skill_id: published.skill.skill_id,
      decision: "deprecated",
      reviewer_actor_id: "case-reviewer-b",
      reviewer_actor_type: "human",
      reason: "Superseded by narrower rule.",
      evidence_refs: ["evidence:case-review"],
      superseded_by: "case-narrower",
      decided_at: "2026-06-11T00:05:00.000Z",
    });
    expect(deprecatedCase?.structuredContent).toEqual(expect.objectContaining({
      ok: true,
      case_law_record: expect.objectContaining({
        case_id: recordedCaseId,
        status: "deprecated",
        reviewer: "case-reviewer-b",
        superseded_by: "case-narrower",
        evidence_refs: expect.arrayContaining(["evidence:case-review"]),
      }),
      review: expect.objectContaining({
        audit_event: expect.objectContaining({ event_type: "case_law_deprecated" }),
      }),
      governance_service: expect.objectContaining({
        case_law_review_queue: [],
      }),
    }));
    const listedAfterDeprecation = await dispatchDojoTool("synthi_dojo_get_case_law", { skill_id: published.skill.skill_id });
    expect(listedAfterDeprecation?.structuredContent).toEqual(expect.objectContaining({
      case_law: expect.arrayContaining([
        expect.objectContaining({ case_id: recordedCaseId, status: "deprecated" }),
      ]),
      case_law_records: expect.arrayContaining([
        expect.objectContaining({ case_id: recordedCaseId, status: "deprecated" }),
      ]),
    }));

    const listed = await dispatchDojoTool("synthi_dojo_list_competencies", {});
    const listedCompetencies = (listed?.structuredContent as {
      competencies: Array<{ skill_id: string; mcp_skill_manifest: DojoMcpSkillManifestV1 }>;
    }).competencies;
    expect(listedCompetencies).toEqual([
      expect.objectContaining({
        skill_id: "dojo_open_details",
        mcp_skill_manifest: expect.objectContaining({ manifest_digest: expect.stringMatching(/^sha256:/) }),
      }),
    ]);
    expect(validateDojoMcpSkillManifest(listedCompetencies[0]!.mcp_skill_manifest, {
      expected_skill_id: published.skill.skill_id,
      expected_tool_name: "synthi_app_open_details",
    })).toEqual(expect.objectContaining({ ok: true, blocked_by: [] }));
    const crossWorkspaceList = await dispatchDojoTool("synthi_dojo_list_competencies", {
      tenant_id: "tenant-a",
      organization_id: "org-a",
      workspace_id: "workspace-b",
      actor_id: "agent-a",
      roles: ["agent"],
    });
    expect(crossWorkspaceList?.structuredContent).toEqual(expect.objectContaining({
      count: 0,
      competencies: [],
    }));

    const exported = await dispatchDojoTool("synthi_dojo_export_artifacts", { skill_id: published.skill.skill_id });
    expect(exported?.isError).toBeUndefined();
    const exportedArtifacts = (exported?.structuredContent as {
      artifacts: Array<{ path: string; content: string }>;
    }).artifacts;
    const exportedManifest = JSON.parse(exportedArtifacts.find((artifact) =>
      artifact.path === ".synthi/dojo/skills/open_details/mcp.manifest.json"
    )?.content ?? "null") as DojoMcpSkillManifestV1;
    expect(validateDojoMcpSkillManifest(exportedManifest, {
      expected_skill_id: published.skill.skill_id,
      expected_tool_name: "synthi_app_open_details",
    })).toEqual(expect.objectContaining({ ok: true, blocked_by: [] }));
    expect(exported?.structuredContent).toEqual(expect.objectContaining({
      ok: true,
      skill_id: "dojo_open_details",
      artifact_count: expect.any(Number),
      artifacts: expect.arrayContaining([
        expect.objectContaining({
          path: ".synthi/dojo/skills/open_details/assurance.case.md",
          content: expect.stringContaining("Skill Assurance Case"),
          sensitive: false,
        }),
        expect.objectContaining({
          path: ".synthi/dojo/skills/open_details/training-report.md",
          content: expect.stringContaining("Dojo Training Report"),
          sensitive: false,
        }),
        expect.objectContaining({
          path: ".synthi/dojo/skills/open_details/playwright.spec.ts",
          content: expect.stringContaining("Dojo proof harness"),
          sensitive: false,
        }),
      ]),
    }));
    expect((exported?.structuredContent as { artifact_count: number }).artifact_count).toBeGreaterThan(20);
    const complianceExport = await dispatchDojoTool("synthi_dojo_export_compliance_pack", {
      skill_id: published.skill.skill_id,
      now: "2026-06-11T00:06:00.000Z",
    });
    const complianceContent = complianceExport?.structuredContent as {
      pack: {
        schema_version: string;
        artifact_count: number;
        compliance_evidence_pack: { artifacts: Array<{ artifact_id: string; status: string }> };
        missing_artifacts: string[];
      };
      artifacts: Array<{ path: string; content: string; content_type: string; sensitive: false }>;
      artifact_count: number;
    };
    expect(complianceContent).toEqual(expect.objectContaining({
      ok: true,
      export_id: expect.stringMatching(/^compliance_export_/),
      pack: expect.objectContaining({
        schema_version: "synthi.dojo.complianceEvidencePackExport.v1",
        compliance_evidence_pack: expect.objectContaining({
          artifacts: expect.arrayContaining([
            expect.objectContaining({ artifact_id: "skill_assurance_case", status: "available" }),
            expect.objectContaining({ artifact_id: "license_and_proof_audit", status: "available" }),
            expect.objectContaining({ artifact_id: "case_law_registry", status: "available" }),
          ]),
        }),
      }),
    }));
    expect(complianceContent.artifact_count).toBe(complianceContent.artifacts.length);
    expect(complianceContent.artifacts.every((artifact) => artifact.sensitive === false)).toBe(true);
    expect(complianceContent.artifacts.map((artifact) => artifact.path)).toEqual(expect.arrayContaining([
      expect.stringContaining("assurance.case.md"),
      expect.stringContaining("license.json"),
      expect.stringContaining("case-law.md"),
    ]));
    const complianceManifest = JSON.parse(
      complianceContent.artifacts.find((artifact) => artifact.path.endsWith(".manifest.json"))?.content ?? "null"
    ) as { artifact_count: number; artifacts: Array<{ path: string }> };
    expect(complianceManifest.artifact_count).toBe(complianceContent.artifacts.length - 1);
    expect(complianceManifest.artifacts).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: expect.stringContaining("assurance.case.md") }),
    ]));

    const revokeMissingReason = await dispatchDojoTool("synthi_dojo_revoke_license", {
      skill_id: published.skill.skill_id,
      actor_id: "unit-reviewer",
      actor_type: "human",
    });
    expect(revokeMissingReason?.isError).toBe(true);
    expect(revokeMissingReason?.structuredContent).toEqual(expect.objectContaining({
      error: "dojo_license_revocation_reason_required",
    }));
    const revokeMissingActor = await dispatchDojoTool("synthi_dojo_revoke_license", {
      skill_id: published.skill.skill_id,
      reason: "unit_test_policy_change",
      actor_type: "human",
    });
    expect(revokeMissingActor?.isError).toBe(true);
    expect(revokeMissingActor?.structuredContent).toEqual(expect.objectContaining({
      error: "dojo_license_revocation_actor_required",
    }));
    const revokeMissingEvidence = await dispatchDojoTool("synthi_dojo_revoke_license", {
      skill_id: published.skill.skill_id,
      reason: "unit_test_policy_change",
      actor_id: "unit-reviewer",
      actor_type: "human",
    });
    expect(revokeMissingEvidence?.isError).toBe(true);
    expect(revokeMissingEvidence?.structuredContent).toEqual(expect.objectContaining({
      error: "dojo_license_revocation_evidence_required",
    }));

    const proposedRuntimeCase = await dispatchDojoTool("synthi_dojo_record_case_law", {
      skill_id: published.skill.skill_id,
      title: "External duplicate-client case",
      finding: "Duplicate display name caused unsafe selection.",
      impact: "Wrong client record may be mutated.",
      rule: "Require stable entity identity before mutation.",
      applies_to: ["run_workflow"],
      binding_scope: "workspace",
      status: "proposed",
      evidence_refs: ["evidence:external-case"],
    });
    const runtimeCaseId = (proposedRuntimeCase?.structuredContent as { case_law_record?: { case_id?: string } } | undefined)
      ?.case_law_record?.case_id;
    expect(runtimeCaseId).toMatch(/^case_/);
    const reviewedRuntimeCaseMissingEvidence = await dispatchDojoTool("synthi_dojo_review_case_law", {
      skill_id: published.skill.skill_id,
      case_id: runtimeCaseId,
      decision: "approved",
      reviewer_actor_id: "case-reviewer-a",
      reviewer_actor_type: "human",
      reason: "Runtime guardrail binding reviewed.",
      decided_at: "2026-06-11T00:06:00.000Z",
    });
    expect(reviewedRuntimeCaseMissingEvidence?.isError).toBe(true);
    expect(reviewedRuntimeCaseMissingEvidence?.structuredContent).toEqual(expect.objectContaining({
      error: "case_law_review_evidence_required",
      review: expect.objectContaining({
        ok: false,
        blocked_by: ["review_evidence_missing"],
      }),
    }));
    const reviewedRuntimeCase = await dispatchDojoTool("synthi_dojo_review_case_law", {
      skill_id: published.skill.skill_id,
      case_id: runtimeCaseId,
      decision: "approved",
      reviewer_actor_id: "case-reviewer-a",
      reviewer_actor_type: "human",
      reason: "Runtime guardrail binding reviewed.",
      evidence_refs: ["evidence:external-case-review"],
      decided_at: "2026-06-11T00:06:00.000Z",
    });
    expect(reviewedRuntimeCase?.structuredContent).toEqual(expect.objectContaining({
      ok: true,
      case_law_record: expect.objectContaining({
        case_id: runtimeCaseId,
        status: "approved",
      }),
    }));
    const cortex = await dispatchDojoTool("synthi_dojo_get_skill_cortex", { skill_id: published.skill.skill_id });
    const executableGraph = cortex?.structuredContent?.executable_graph as { nodes?: Array<{ node_id?: string; guardrails?: Array<{ guardrail_id: string; predicate: string }>; case_law_refs?: string[] }> };
    const actionNode = executableGraph.nodes?.find((node) => node.node_id === "action");
    const runtimeCaseGuardrailId = `case_guard_${runtimeCaseId}`;
    expect(cortex?.structuredContent).toEqual(expect.objectContaining({
      skill_cortex: expect.objectContaining({ schema_version: "synthi.dojo.skillCortex.v1" }),
      executable_graph: expect.objectContaining({
        schema_version: "synthi.dojo.skillGraph.v1",
        skill_id: published.skill.skill_id,
      }),
      executable_graph_validation: { ok: true, issues: [] },
      case_law_runtime_bindings: expect.objectContaining({
        approved_case_law_record_count: expect.any(Number),
        bound_case_law_refs: expect.arrayContaining([runtimeCaseId]),
        bound_case_law_guardrail_ids: expect.arrayContaining([runtimeCaseGuardrailId]),
      }),
    }));
    expect(actionNode).toEqual(expect.objectContaining({
      guardrails: expect.arrayContaining([
        expect.objectContaining({
          guardrail_id: runtimeCaseGuardrailId,
          predicate: "stable_entity_identity == true",
        }),
      ]),
      case_law_refs: expect.arrayContaining([runtimeCaseId]),
    }));
    const failure = await dispatchDojoTool("synthi_dojo_explain_failure", {
      skill_id: published.skill.skill_id,
      mutation_kind: "duplicate_entity",
    });
    expect(failure?.structuredContent).toEqual(expect.objectContaining({
      ok: true,
      explanation: expect.stringContaining("Duplicate display entity"),
      guardrails: expect.any(Array),
    }));

    const revoke = await dispatchDojoTool("synthi_dojo_revoke_license", {
      skill_id: published.skill.skill_id,
      reason: "unit_test_policy_change",
      actor_id: "unit-reviewer",
      actor_type: "human",
      evidence_refs: ["unit-test-evidence"],
    });
    expect(revoke?.structuredContent).toEqual(expect.objectContaining({
      license: expect.objectContaining({ entrustment_level: "EX", autonomy_level: "blocked" }),
      revocation: expect.objectContaining({
        audit_event: expect.objectContaining({
          actor: { actor_id: "unit-reviewer", actor_type: "human" },
          reason: "unit_test_policy_change",
          evidence_refs: ["unit-test-evidence"],
        }),
      }),
    }));
    const revokedHealth = await dispatchDojoTool("synthi_dojo_get_license_health", { skill_id: published.skill.skill_id });
    expect(revokedHealth?.structuredContent).toEqual(expect.objectContaining({
      license_health: expect.objectContaining({ status: "blocked", entrustment_level: "EX" }),
    }));
  });

  it("requires complete tenant context for production proof validation and execution", async () => {
    recordOpenDetailsWorkflowForDojoToolTest();
    const publish = await dispatchDojoTool("synthi_dojo_publish_skill", publishArgsForDojoToolTest());
    expect(publish?.isError).toBeUndefined();
    const skillId = (publish?.structuredContent as { skill: { skill_id: string } }).skill.skill_id;
    const publishedSkill = dojoSkillRegistry.get(skillId);
    expect(publishedSkill).toBeTruthy();
    const capsuleResponse = await dispatchDojoTool("synthi_dojo_issue_proof_capsule", {
      skill_id: skillId,
      requested_action: "run_workflow",
      context_claims: { workspace_verified: true },
      evidence_ledger_records: evidenceLedgerRecordsForProof(publishedSkill!, {
        record_id: "evidence-production-proof-context",
        tenant_id: "tenant-a",
      }),
      require_verified_evidence: true,
      ...productionTenantContextArgs({
        actor_id: "production-agent-a",
        request_id: "req-production-issue",
        correlation_id: "corr-production-issue",
      }),
      now: "2026-06-11T00:00:00.000Z",
      expires_at: "2026-06-11T00:15:00.000Z",
    });
    expect(capsuleResponse?.isError).toBeUndefined();
    const capsule = (capsuleResponse?.structuredContent as { proof_capsule: unknown }).proof_capsule;
    process.env.SYNTHI_DOJO_PRODUCTION_ENFORCEMENT = "1";

    const missingContextValidation = await dispatchDojoTool("synthi_dojo_validate_proof_capsule", {
      skill_id: skillId,
      requested_action: "run_workflow",
      proof_capsule: capsule,
      now: "2026-06-11T00:01:00.000Z",
    });
    expect(missingContextValidation?.isError).toBe(true);
    expect(missingContextValidation?.structuredContent).toEqual(expect.objectContaining({
      error: "dojo_tenant_context_required",
      enforcement_mode: "production",
      missing_fields: expect.arrayContaining([
        "tenant_id",
        "organization_id",
        "workspace_id",
        "actor_id",
        "actor_type",
        "roles",
        "request_id",
        "correlation_id",
      ]),
      blocked_by: expect.arrayContaining([
        "tenant_context_tenant_id_missing",
        "tenant_context_actor_id_missing",
        "tenant_context_request_id_missing",
      ]),
    }));

    const invalidActorContext = await dispatchDojoTool("synthi_dojo_run_with_proof_capsule", {
      skill_id: skillId,
      requested_action: "run_workflow",
      proof_capsule: capsule,
      ...productionTenantContextArgs({ actor_type: "robot" }),
      dry_run: true,
      now: "2026-06-11T00:01:00.000Z",
    });
    expect(invalidActorContext?.isError).toBe(true);
    expect(invalidActorContext?.structuredContent).toEqual(expect.objectContaining({
      error: "dojo_tenant_context_actor_type_invalid",
      enforcement_mode: "production",
      blocked_by: ["tenant_context_actor_type_invalid"],
    }));

    const validContextValidation = await dispatchDojoTool("synthi_dojo_validate_proof_capsule", {
      skill_id: skillId,
      requested_action: "run_workflow",
      proof_capsule: capsule,
      ...productionTenantContextArgs({ request_id: "req-production-validate" }),
      now: "2026-06-11T00:01:00.000Z",
    });
    expect(validContextValidation?.isError).toBeUndefined();
    expect(validContextValidation?.structuredContent).toEqual(expect.objectContaining({
      ok: true,
      license_kernel: expect.objectContaining({
        ok: true,
        runtime_claims: expect.objectContaining({
          tenant_id: "tenant-a",
          organization_id: "org-a",
          workspace_id: "workspace-a",
          actor_id: "production-agent-a",
          actor_type: "agent",
        }),
      }),
    }));

    const missingContextRun = await dispatchDojoTool("synthi_dojo_run_with_proof_capsule", {
      skill_id: skillId,
      requested_action: "run_workflow",
      proof_capsule: capsule,
      dry_run: true,
      now: "2026-06-11T00:02:00.000Z",
    });
    expect(missingContextRun?.isError).toBe(true);
    expect(missingContextRun?.structuredContent).toEqual(expect.objectContaining({
      error: "dojo_tenant_context_required",
      blocked_by: expect.arrayContaining(["tenant_context_correlation_id_missing"]),
    }));

    const validContextRun = await dispatchDojoTool("synthi_dojo_run_with_proof_capsule", {
      skill_id: skillId,
      requested_action: "run_workflow",
      proof_capsule: capsule,
      ...productionTenantContextArgs({ request_id: "req-production-run" }),
      dry_run: true,
      now: "2026-06-11T00:02:00.000Z",
    });
    expect(validContextRun?.isError).toBeUndefined();
    expect(validContextRun?.structuredContent).toEqual(expect.objectContaining({
      ok: true,
      dry_run: true,
      license_kernel: expect.objectContaining({ ok: true, status: "allowed" }),
      skill_bus: expect.objectContaining({ ok: true, status: "allowed" }),
    }));
  });

  it("authorizes hosted runtime sessions before consuming production proof capsules", async () => {
    recordOpenDetailsWorkflowForDojoToolTest();
    const publish = await dispatchDojoTool("synthi_dojo_publish_skill", publishArgsForDojoToolTest());
    expect(publish?.isError).toBeUndefined();
    const skillId = (publish?.structuredContent as { skill: { skill_id: string } }).skill.skill_id;
    const publishedSkill = dojoSkillRegistry.get(skillId);
    expect(publishedSkill).toBeTruthy();
    const capsuleResponse = await dispatchDojoTool("synthi_dojo_issue_proof_capsule", {
      skill_id: skillId,
      requested_action: "run_prefix_validation",
      context_claims: { workspace_verified: true },
      evidence_ledger_records: evidenceLedgerRecordsForProof(publishedSkill!, {
        record_id: "evidence-hosted-runtime-proof",
        tenant_id: "tenant-a",
      }),
      require_verified_evidence: true,
      ...productionTenantContextArgs({
        actor_id: "hosted-runtime-agent-a",
        request_id: "req-hosted-runtime-proof-issue",
        correlation_id: "corr-hosted-runtime-proof-issue",
      }),
      now: "2026-06-11T00:00:00.000Z",
      expires_at: "2026-06-11T00:15:00.000Z",
    });
    expect(capsuleResponse?.isError).toBeUndefined();
    const capsule = (capsuleResponse?.structuredContent as { proof_capsule: { capsule_id: string } }).proof_capsule;

    process.env.SYNTHI_DOJO_PRODUCTION_ENFORCEMENT = "1";
    const productionTenant = productionTenantContextArgs({
      actor_id: "hosted-runtime-agent-a",
      request_id: "req-hosted-runtime-proof",
      correlation_id: "corr-hosted-runtime-proof",
    });
    const missingRuntimeSession = await dispatchDojoTool("synthi_dojo_run_with_proof_capsule", {
      skill_id: skillId,
      requested_action: "run_prefix_validation",
      proof_capsule: capsule,
      run_id: "hosted-runtime-run-missing",
      now: "2026-06-11T00:01:00.000Z",
      ...productionTenant,
    });
    expect(missingRuntimeSession?.isError).toBe(true);
    expect(missingRuntimeSession?.structuredContent).toEqual(expect.objectContaining({
      error: "dojo_hosted_runtime_authorization_failed",
      proof_not_consumed: true,
      runtime_authorization: expect.objectContaining({
        ok: false,
        blocked_by: expect.arrayContaining(["runtime_session_not_found"]),
      }),
      license_kernel: expect.objectContaining({
        blocked_by: expect.arrayContaining(["runtime_session_not_found"]),
      }),
    }));
    const proofAfterBlockedRuntime = dojoSkillRegistry.getProofRecord(capsule.capsule_id);
    expect(proofAfterBlockedRuntime).toEqual(expect.objectContaining({
      status: "issued",
    }));
    expect(proofAfterBlockedRuntime).not.toHaveProperty("first_used_at");

    const sessionResponse = await dispatchDojoTool("synthi_dojo_create_hosted_runtime_session", {
      skill_id: skillId,
      run_id: "hosted-runtime-run-authorized",
      workspace_url: "https://app.example.test/settings",
      origin_allowlist: ["https://app.example.test"],
      ttl_ms: 600_000,
      credential_ttl_ms: 300_000,
      now: "2026-06-11T00:01:30.000Z",
      ...productionTenantContextArgs({
        actor_id: "hosted-runtime-agent-a",
        request_id: "req-hosted-runtime-session",
        correlation_id: "corr-hosted-runtime-session",
      }),
    });
    expect(sessionResponse?.isError).toBeUndefined();
    expect(sessionResponse?.structuredContent).toEqual(expect.objectContaining({
      ok: true,
      implementation_status: "executable",
      runtime_scope: "hosted_runtime_gateway",
      production_runtime: false,
      runtime_session: expect.objectContaining({
        schema_version: "synthi.dojo.hostedRuntimeSession.v1",
        skill_id: skillId,
        run_id: "hosted-runtime-run-authorized",
        workspace_origin: "https://app.example.test",
        status: "active",
      }),
      credentials: expect.objectContaining({
        credential_id: expect.stringMatching(/^runtime_cred_/),
        credential_secret: expect.any(String),
      }),
    }));
    const runtimeSession = (sessionResponse?.structuredContent as {
      runtime_session: { session_id: string; credential_id: string };
      credentials: { credential_id: string; credential_secret: string };
    }).runtime_session;
    const credentials = (sessionResponse?.structuredContent as {
      credentials: { credential_id: string; credential_secret: string };
    }).credentials;

    const authorizedRun = await dispatchDojoTool("synthi_dojo_run_with_proof_capsule", {
      skill_id: skillId,
      requested_action: "run_prefix_validation",
      proof_capsule: capsule,
      run_id: "hosted-runtime-run-authorized",
      runtime_session_id: runtimeSession.session_id,
      runtime_credential_id: credentials.credential_id,
      runtime_credential_secret: credentials.credential_secret,
      runtime_action_url: "https://app.example.test/settings",
      now: "2026-06-11T00:02:00.000Z",
      ...productionTenantContextArgs({
        actor_id: "hosted-runtime-agent-a",
        request_id: "req-hosted-runtime-authorized-run",
        correlation_id: "corr-hosted-runtime-authorized-run",
      }),
    });
    expect(authorizedRun?.isError).toBeUndefined();
    expect(authorizedRun?.structuredContent).toEqual(expect.objectContaining({
      ok: true,
      run_id: "hosted-runtime-run-authorized",
      runtime_authorization: expect.objectContaining({
        ok: true,
        status: "authorized",
        session_id: runtimeSession.session_id,
        action_kind: "proof_gated_tool",
        evidence_record_ids: [expect.stringMatching(/^evidence:dojo_runtime_action_evidence_[a-f0-9]{12}$/)],
      }),
      proof_consume: expect.objectContaining({ ok: true, status: "used" }),
      proof_record: expect.objectContaining({
        status: "used",
        first_used_at: "2026-06-11T00:02:00.000Z",
      }),
      result: expect.objectContaining({
        ok: true,
        validation: expect.objectContaining({ status: expect.any(String) }),
      }),
    }));
    expect(dojoSkillRegistry.listAuditEvents().map((eventRecord) => eventRecord.event_type)).toEqual(
      expect.arrayContaining([
        "runtime_action_blocked",
        "runtime_session_created",
        "runtime_action_authorized",
        "proof_used",
      ])
    );
  });

  it("uses top-level approval and actor context for license validation without duplicating workflow args", async () => {
    recordOpenDetailsWorkflowForDojoToolTest();
    const publish = await dispatchDojoTool("synthi_dojo_publish_skill", publishArgsForDojoToolTest());
    expect(publish?.isError).toBeUndefined();
    const skillId = (publish?.structuredContent as { skill: { skill_id: string } }).skill.skill_id;
    const skill = dojoSkillRegistry.get(skillId);
    expect(skill).toBeTruthy();
    const currentGatedRun = skill!.permission_license.gated_actions.find((action) => action.action === "run_workflow");
    dojoSkillRegistry.publish({
      ...skill!,
      permission_license: {
        ...skill!.permission_license,
        gated_actions: [
          ...skill!.permission_license.gated_actions.filter((action) => action.action !== "run_workflow"),
          {
            action: "run_workflow",
            constraints: [...new Set([...(currentGatedRun?.constraints ?? []), "human_confirmation_required"])],
          },
        ],
        approval_requirements: [...new Set([...skill!.permission_license.approval_requirements, "run_workflow"])],
      },
    });

    const capsuleResponse = await dispatchDojoTool("synthi_dojo_issue_proof_capsule", {
      skill_id: skillId,
      requested_action: "run_workflow",
      context_claims: { workspace_verified: true },
      evidence_ledger_records: evidenceLedgerRecordsForProof(skill!, { record_id: "evidence-approval-proof" }),
      require_verified_evidence: true,
      now: "2026-06-11T00:00:00.000Z",
      expires_at: "2026-06-11T00:15:00.000Z",
    });
    expect(capsuleResponse?.isError).toBeUndefined();
    const capsule = (capsuleResponse?.structuredContent as { proof_capsule: unknown }).proof_capsule;
    const workflowArgs = { client_id: "client-a" };
    const missingApproval = await dispatchDojoTool("synthi_dojo_run_with_proof_capsule", {
      skill_id: skillId,
      requested_action: "run_workflow",
      proof_capsule: capsule,
      tool_args: workflowArgs,
      dry_run: true,
      now: "2026-06-11T00:01:00.000Z",
    });
    expect(missingApproval?.isError).toBe(true);
    expect(missingApproval?.structuredContent).toEqual(expect.objectContaining({
      license_kernel: expect.objectContaining({
        ok: false,
        status: "approval_required",
        blocked_by: expect.arrayContaining([
          "approval_constraint:human_confirmation_required",
          "approval_required",
          "approval_not_granted",
          "approval_evidence_required",
        ]),
      }),
    }));

    const approvedRun = await dispatchDojoTool("synthi_dojo_run_with_proof_capsule", {
      skill_id: skillId,
      requested_action: "run_workflow",
      proof_capsule: capsule,
      tool_args: workflowArgs,
      approval_id: "approval-a",
      approval_status: "approved",
      approval_evidence_ref: "evidence:approval-a",
      actor_id: "reviewer-a",
      actor_type: "human",
      dry_run: true,
      now: "2026-06-11T00:02:00.000Z",
    });
    expect(approvedRun?.isError).toBeUndefined();
    expect(approvedRun?.structuredContent).toEqual(expect.objectContaining({
      ok: true,
      dry_run: true,
      license_kernel: expect.objectContaining({
        ok: true,
        status: "allowed",
        runtime_claims: expect.objectContaining({
          actor_id: "reviewer-a",
          actor_type: "human",
          approval_id: "approval-a",
          approval_evidence_ref: "evidence:approval-a",
        }),
      }),
      skill_bus: expect.objectContaining({
        ok: true,
        validation: expect.objectContaining({ ok: true, status: "allowed" }),
      }),
    }));
    expect(workflowArgs).toEqual({ client_id: "client-a" });

    const approvedValidation = await dispatchDojoTool("synthi_dojo_validate_proof_capsule", {
      skill_id: skillId,
      requested_action: "run_workflow",
      proof_capsule: capsule,
      tool_args: workflowArgs,
      approval_id: "approval-a",
      approval_status: "approved",
      approval_evidence_ref: "evidence:approval-a",
      actor_id: "reviewer-a",
      actor_type: "human",
      now: "2026-06-11T00:03:00.000Z",
    });
    expect(approvedValidation?.isError).toBeUndefined();
    expect(approvedValidation?.structuredContent).toEqual(expect.objectContaining({
      ok: true,
      license_kernel: expect.objectContaining({
        ok: true,
        status: "allowed",
        runtime_claims: expect.objectContaining({
          actor_id: "reviewer-a",
          actor_type: "human",
          approval_id: "approval-a",
          approval_evidence_ref: "evidence:approval-a",
        }),
      }),
      proof_record: expect.objectContaining({
        last_validated_at: "2026-06-11T00:03:00.000Z",
      }),
    }));
  });
});

function recordOpenDetailsWorkflowForDojoToolTest(): void {
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
}

async function publishTwoWorkspaceSkillsForDojoToolTest(): Promise<{
  visibleSkillId: string;
  hiddenSkill: ReturnType<typeof buildDojoSkill>;
}> {
  recordOpenDetailsWorkflowForDojoToolTest();
  const publish = await dispatchDojoTool("synthi_dojo_publish_skill", publishArgsForDojoToolTest());
  expect(publish?.isError).toBeUndefined();
  const visibleSkillId = (publish?.structuredContent as { skill: { skill_id: string } }).skill.skill_id;
  const hiddenWorkflow = compileWorkflowContract([
    event({
      event_id: "archive-record",
      event_seq: 1,
      action: "click",
      detail: { element: { role: "button", name: "Archive record" } },
      locator_candidates: [
        { kind: "role", locator: "page.getByRole(\"button\", { name: \"Archive record\" })", confidence: 0.97, reason: "role" },
      ],
    }),
  ]);
  const hiddenSkill = dojoSkillRegistry.publish(buildDojoSkill(hiddenWorkflow.contract, {
    workspace_id: "workspace-b",
    now: "2026-06-11T00:00:00.000Z",
  }));
  expect(hiddenSkill.skill_id).not.toBe(visibleSkillId);
  return { visibleSkillId, hiddenSkill };
}

function publishArgsForDojoToolTest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    workspace_id: "workspace-a",
    reason: "unit_test_publish",
    actor_id: "unit-publisher",
    actor_type: "human",
    evidence_refs: ["evidence:unit-publish"],
    ...overrides,
  };
}

function productionTenantContextArgs(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    tenant_id: "tenant-a",
    organization_id: "org-a",
    workspace_id: "workspace-a",
    actor_id: "production-agent-a",
    actor_type: "agent",
    roles: ["agent"],
    request_id: "req-production-a",
    correlation_id: "corr-production-a",
    ...overrides,
  };
}

function evidenceLedgerRecordsForProof(
  skill: DojoSkill,
  options: {
    record_id?: string;
    tenant_id?: string;
    created_at?: string;
  } = {}
): ReturnType<typeof buildDojoEvidenceLedgerRecord>[] {
  const recordId = options.record_id ?? `evidence-${skill.skill_id}`;
  const createdAt = options.created_at ?? "2026-06-11T00:00:00.000Z";
  const claimIds = skill.permission_license.proof_requirements.required_evidence_claims;
  const artifactPayload = JSON.stringify({
    claim_ids: claimIds,
    created_at: createdAt,
    record_id: recordId,
    skill_id: skill.skill_id,
  });
  return [
    buildDojoEvidenceLedgerRecord({
      record_id: recordId,
      tenant_id: options.tenant_id ?? "local-tenant",
      workspace_id: skill.workspace_id,
      skill_id: skill.skill_id,
      run_id: `checkride-${skill.skill_id}`,
      kind: "checkride",
      artifact_uri: `memory://dojo/tests/${skill.skill_id}/checkride`,
      artifact_sha256: createHash("sha256").update(artifactPayload, "utf8").digest("hex"),
      claim_ids: claimIds,
      created_at: createdAt,
      created_by: "dojo-tool-test",
      retention_class: "ephemeral",
    }),
  ];
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
