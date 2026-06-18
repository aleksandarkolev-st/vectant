import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
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
import type { DojoEvidenceClaim, DojoSkill } from "../../src/browser/dojo.js";
import { createSynthiServer } from "../../src/server.js";
import { validateDojoMcpSkillManifest, type DojoMcpSkillManifestV1 } from "../../src/dojo/mcp/manifest_signing.js";
import { generateEd25519DojoProofKeyPair } from "../../src/dojo/proof/signing.js";
import { dispatchBrowserTool } from "../../src/tools/browser.js";
import { dispatchDojoTool } from "../../src/tools/dojo.js";
import { buildDojoEvidenceLedgerRecord } from "../../src/dojo/evidence/ledger_record.js";
import {
  contextKeyForDojoGuardrailPredicate,
  normalizeDojoGuardrailPredicate,
} from "../../src/dojo/graph/guardrail_predicates.js";

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
    expect(scenarios).toHaveLength(21);
    expect(scenarios.map((scenario) => scenario.mutation_kind)).toEqual(expect.arrayContaining([
      "invalid_value",
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
    expect(skill.skill_card.practiced).toBe("21 synthetic cases");
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
      rehearsal_count: 21,
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
    const governanceReport = JSON.parse(artifacts.find((artifact) =>
      artifact.path === ".synthi/dojo/skills/save_invoice/governance.report.json"
    )?.content ?? "null") as {
      schema_version?: string;
      scheduled_jobs?: Array<{ kind?: string; status?: string }>;
    };
    const redactedEvidenceManifest = JSON.parse(artifacts.find((artifact) =>
      artifact.path === ".synthi/dojo/evidence/save_invoice.redacted-evidence-manifest.json"
    )?.content ?? "null") as {
      schema_version?: string;
      artifact_count?: number;
      artifacts?: Array<{ redaction_manifest_sha256?: string; original_artifact_sha256?: string }>;
      excluded?: string[];
    };
    expect(compatibilityEvidenceManifest.schema_version).toBe("synthi.dojo.evidenceManifest.v1");
    expect(governanceReport).toEqual(expect.objectContaining({
      schema_version: "synthi.dojo.governanceReport.v1",
      scheduled_jobs: expect.arrayContaining([
        expect.objectContaining({ kind: "recompute_registry_metrics", status: "ready" }),
      ]),
    }));
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
    const derivedWorkspaceClaim = issueDojoProofCapsule(skill, "run_workflow", {
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

    expect(derivedWorkspaceClaim.context_claims).toEqual(expect.objectContaining({ workspace_verified: true }));
    expect(validateDojoProofCapsule(skill, derivedWorkspaceClaim, "run_workflow", "2026-06-11T00:01:00.000Z")).toEqual(
      expect.objectContaining({ ok: true, status: "allowed" })
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

    const blockedCheckrideRole = await dispatchDojoTool("synthi_dojo_run_checkride", productionTenantContextArgs({
      actor_id: "checkride-tester",
      actor_type: "human",
      roles: ["agent"],
      request_id: "req-production-workflow-checkride-rbac-blocked",
      correlation_id: "corr-production-workflow-checkride-rbac-blocked",
      now: "2026-06-11T00:00:00.000Z",
    }));
    expect(blockedCheckrideRole?.isError).toBe(true);
    expect(blockedCheckrideRole?.structuredContent).toEqual(expect.objectContaining({
      error: "dojo_checkride_run_role_required",
      workflow_id: expect.any(String),
      workspace_id: "workspace-a",
      blocked_by: expect.arrayContaining(["governance_role_required:dojo:checkride:run"]),
      rbac_authorization: expect.objectContaining({
        action: "checkride_run",
        matched_roles: [],
        required_roles: ["dojo:checkride:run"],
      }),
    }));

    const checkride = await dispatchDojoTool("synthi_dojo_run_checkride", productionCheckrideRunnerContextArgs({
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
      rbac_authorization: expect.objectContaining({
        action: "checkride_run",
        matched_roles: ["dojo:checkride:run"],
      }),
    }));

    const publish = await dispatchDojoTool("synthi_dojo_publish_skill", publishArgsForDojoToolTest({
      ...productionSkillPublisherContextArgs({
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
    const practiceRunReportTools = new Set([
      "synthi_dojo_debug_counterfactual",
      "synthi_dojo_run_time_machine_debugger",
      "synthi_dojo_run_ghost_mode",
    ]);

    for (const toolName of skillReportTools) {
      const missingContext = await dispatchDojoTool(toolName, { skill_id: skillId });
      expect(missingContext?.isError, toolName).toBe(true);
      expect(missingContext?.structuredContent, toolName).toEqual(expect.objectContaining({
        error: "dojo_tenant_context_required",
        blocked_by: expect.arrayContaining(["tenant_context_workspace_id_missing"]),
      }));

      const authorized = await dispatchDojoTool(toolName, {
        skill_id: skillId,
        ...(practiceRunReportTools.has(toolName) ? productionPracticeRunnerContextArgs({
          request_id: `req-production-${toolName}`,
        }) : productionTenantContextArgs({
          ...(toolName === "synthi_dojo_get_governance_report" ? { roles: ["dojo:governance:view"] } : {}),
          request_id: `req-production-${toolName}`,
        })),
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

    const blockedMetricsRole = await dispatchDojoTool("synthi_dojo_get_metrics", productionTenantContextArgs({
      roles: ["agent"],
      request_id: "req-production-aggregate-metrics-rbac-blocked",
    }));
    expect(blockedMetricsRole?.isError).toBe(true);
    expect(blockedMetricsRole?.structuredContent).toEqual(expect.objectContaining({
      error: "dojo_metrics_view_role_required",
      blocked_by: expect.arrayContaining(["governance_role_required:dojo:metrics:view|dojo:governance:view|dojo:auditor"]),
      rbac_authorization: expect.objectContaining({
        action: "metrics_view",
        matched_roles: [],
        required_roles: ["dojo:metrics:view", "dojo:governance:view", "dojo:auditor"],
      }),
    }));

    const metrics = await dispatchDojoTool("synthi_dojo_get_metrics", productionMetricsViewerContextArgs({
      request_id: "req-production-aggregate-metrics",
    }));
    expect(metrics?.isError).toBeUndefined();
    expect(metrics?.structuredContent).toEqual(expect.objectContaining({
      rbac_authorization: expect.objectContaining({
        action: "metrics_view",
        matched_roles: ["dojo:metrics:view"],
      }),
      metrics: expect.objectContaining({
        skill_count: 1,
        business: expect.objectContaining({ reviewable_artifact_sets: 1 }),
      }),
    }));

    const blockedRegistryRole = await dispatchDojoTool("synthi_dojo_get_registry", productionTenantContextArgs({
      roles: ["agent"],
      request_id: "req-production-registry-rbac-blocked",
    }));
    expect(blockedRegistryRole?.isError).toBe(true);
    expect(blockedRegistryRole?.structuredContent).toEqual(expect.objectContaining({
      error: "dojo_registry_view_role_required",
      blocked_by: expect.arrayContaining(["governance_role_required:dojo:registry:view|dojo:governance:view|dojo:auditor"]),
      rbac_authorization: expect.objectContaining({
        action: "registry_view",
        matched_roles: [],
        required_roles: ["dojo:registry:view", "dojo:governance:view", "dojo:auditor"],
      }),
    }));

    const registry = await dispatchDojoTool("synthi_dojo_get_registry", productionRegistryViewerContextArgs({
      request_id: "req-production-registry",
    }));
    expect(registry?.isError).toBeUndefined();
    const registryContent = registry?.structuredContent as {
      rbac_authorization: { action: string; matched_roles: string[] };
      registry: { skill_count: number; competencies: Array<{ skill_id: string; workspace_id: string }> };
      governance_service: {
        skill_registry: Array<{ skill_id: string; workspace_id: string }>;
        approval_queue: Array<{ request_id?: string; skill_id: string }>;
      };
    };
    expect(registryContent.rbac_authorization).toEqual(expect.objectContaining({
      action: "registry_view",
      matched_roles: ["dojo:registry:view"],
    }));
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
      ...productionMetricsViewerContextArgs({ request_id: "req-production-hidden-metrics" }),
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
      ...productionTenantContextArgs({
        roles: ["dojo:governance:view"],
        request_id: "req-production-governance",
      }),
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

  it("enforces RBAC for production governance report through the MCP tool", async () => {
    const { visibleSkillId } = await publishTwoWorkspaceSkillsForDojoToolTest();
    process.env.SYNTHI_DOJO_PRODUCTION_ENFORCEMENT = "1";

    const blockedReport = await dispatchDojoTool("synthi_dojo_get_governance_report", {
      skill_id: visibleSkillId,
      ...productionTenantContextArgs({
        actor_id: "workspace-a-agent",
        actor_type: "agent",
        roles: ["agent"],
        request_id: "req-governance-report-rbac-blocked",
        correlation_id: "corr-governance-report-rbac-blocked",
      }),
    });
    expect(blockedReport?.isError).toBe(true);
    expect(blockedReport?.structuredContent).toEqual(expect.objectContaining({
      error: "dojo_governance_report_role_required",
      ok: false,
      skill_id: visibleSkillId,
      blocked_by: expect.arrayContaining(["governance_role_required:dojo:governance:view|dojo:auditor"]),
      rbac_authorization: expect.objectContaining({
        action: "governance_view",
        actor_id: "workspace-a-agent",
        required_roles: ["dojo:governance:view", "dojo:auditor"],
      }),
    }));

    const allowedReport = await dispatchDojoTool("synthi_dojo_get_governance_report", {
      skill_id: visibleSkillId,
      ...productionTenantContextArgs({
        actor_id: "workspace-a-auditor",
        actor_type: "human",
        roles: ["dojo:governance:view"],
        request_id: "req-governance-report-rbac-approved",
        correlation_id: "corr-governance-report-rbac-approved",
      }),
    });
    expect(allowedReport?.isError).toBeUndefined();
    expect(allowedReport?.structuredContent).toEqual(expect.objectContaining({
      ok: true,
      skill_id: visibleSkillId,
      rbac_authorization: expect.objectContaining({
        action: "governance_view",
        actor_id: "workspace-a-auditor",
        matched_roles: ["dojo:governance:view"],
      }),
      governance_service: expect.objectContaining({
        skill_registry: [
          expect.objectContaining({ skill_id: visibleSkillId }),
        ],
      }),
    }));
  });

  it("enforces RBAC for production case-law recording through the MCP tool", async () => {
    recordOpenDetailsWorkflowForDojoToolTest();
    const publish = await dispatchDojoTool("synthi_dojo_publish_skill", publishArgsForDojoToolTest());
    expect(publish?.isError).toBeUndefined();
    const skillId = (publish?.structuredContent as { skill: { skill_id: string } }).skill.skill_id;
    const originalCaseCount = dojoSkillRegistry.get(skillId)?.case_law.length ?? 0;
    process.env.SYNTHI_DOJO_PRODUCTION_ENFORCEMENT = "1";

    const blockedRecord = await dispatchDojoTool("synthi_dojo_record_case_law", {
      skill_id: skillId,
      finding: "An unauthorized actor tried to propose a precedent.",
      rule: "Only case-law authors may propose binding precedent.",
      applies_to: ["workflow_execution"],
      evidence_refs: ["evidence:case-law-rbac-blocked"],
      ...productionTenantContextArgs({
        actor_id: "case-law-viewer",
        actor_type: "human",
        roles: ["dojo:governance:view"],
        request_id: "req-case-law-record-rbac-blocked",
        correlation_id: "corr-case-law-record-rbac-blocked",
      }),
    });
    expect(blockedRecord?.isError).toBe(true);
    expect(blockedRecord?.structuredContent).toEqual(expect.objectContaining({
      ok: false,
      error: "dojo_case_law_record_role_required",
      skill_id: skillId,
      blocked_by: expect.arrayContaining(["governance_role_required:dojo:case-law:record"]),
      rbac_authorization: expect.objectContaining({
        action: "case_law_record",
        actor_id: "case-law-viewer",
        required_roles: ["dojo:case-law:record"],
        matched_roles: [],
      }),
    }));
    expect(dojoSkillRegistry.get(skillId)?.case_law.length).toBe(originalCaseCount);

    const allowedRecord = await dispatchDojoTool("synthi_dojo_record_case_law", {
      skill_id: skillId,
      finding: "A reviewed failure requires a stable workspace boundary.",
      rule: "Require verified workspace context before workflow execution.",
      applies_to: ["workflow_execution"],
      evidence_refs: ["evidence:case-law-rbac-allowed"],
      ...productionTenantContextArgs({
        actor_id: "case-law-author",
        actor_type: "human",
        roles: ["dojo:case-law:record"],
        request_id: "req-case-law-record-rbac-allowed",
        correlation_id: "corr-case-law-record-rbac-allowed",
      }),
    });
    expect(allowedRecord?.isError).toBeUndefined();
    expect(allowedRecord?.structuredContent).toEqual(expect.objectContaining({
      ok: true,
      skill_id: skillId,
      case_law_record: expect.objectContaining({ status: "proposed" }),
      guardrail_binding_status: "review_required",
      rbac_authorization: expect.objectContaining({
        action: "case_law_record",
        actor_id: "case-law-author",
        matched_roles: ["dojo:case-law:record"],
      }),
    }));
    expect(dojoSkillRegistry.get(skillId)?.case_law.length).toBe(originalCaseCount + 1);
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
      ...productionTenantContextArgs({
        roles: ["agent"],
        request_id: "req-production-visible-artifacts-rbac-blocked",
      }),
    });
    expect(visibleArtifacts?.isError).toBe(true);
    expect(visibleArtifacts?.structuredContent).toEqual(expect.objectContaining({
      error: "dojo_artifact_export_role_required",
      skill_id: visibleSkillId,
      workspace_id: "workspace-a",
      blocked_by: expect.arrayContaining(["governance_role_required:dojo:artifact:export|dojo:auditor"]),
      rbac_authorization: expect.objectContaining({
        action: "artifact_export",
        matched_roles: [],
        required_roles: ["dojo:artifact:export", "dojo:auditor"],
      }),
    }));

    const allowedArtifacts = await dispatchDojoTool("synthi_dojo_export_artifacts", {
      skill_id: visibleSkillId,
      ...productionArtifactExporterContextArgs({ request_id: "req-production-visible-artifacts" }),
    });
    expect(allowedArtifacts?.isError).toBeUndefined();
    expect(allowedArtifacts?.structuredContent).toEqual(expect.objectContaining({
      skill_id: visibleSkillId,
      artifact_count: expect.any(Number),
      rbac_authorization: expect.objectContaining({
        action: "artifact_export",
        matched_roles: ["dojo:artifact:export"],
      }),
    }));

    const blockedPracticeRun = await dispatchDojoTool("synthi_dojo_run_vivarium_scenario", {
      skill_id: visibleSkillId,
      mutation_kind: "duplicate_entity",
      ...productionTenantContextArgs({
        roles: ["agent"],
        request_id: "req-production-visible-vivarium-rbac-blocked",
      }),
    });
    expect(blockedPracticeRun?.isError).toBe(true);
    expect(blockedPracticeRun?.structuredContent).toEqual(expect.objectContaining({
      error: "dojo_practice_run_role_required",
      skill_id: visibleSkillId,
      workspace_id: "workspace-a",
      blocked_by: expect.arrayContaining(["governance_role_required:dojo:practice:run"]),
      rbac_authorization: expect.objectContaining({
        action: "practice_run",
        matched_roles: [],
        required_roles: ["dojo:practice:run"],
      }),
    }));

    const visibleVivarium = await dispatchDojoTool("synthi_dojo_run_vivarium_scenario", {
      skill_id: visibleSkillId,
      mutation_kind: "duplicate_entity",
      ...productionPracticeRunnerContextArgs({ request_id: "req-production-visible-vivarium" }),
    });
    expect(visibleVivarium?.isError).toBeUndefined();
    expect(visibleVivarium?.structuredContent).toEqual(expect.objectContaining({
      skill_id: visibleSkillId,
      rbac_authorization: expect.objectContaining({
        action: "practice_run",
        matched_roles: ["dojo:practice:run"],
      }),
      vivarium_run: expect.objectContaining({
        schema_version: "synthi.dojo.vivariumScenarioRun.v1",
        tenant_context: expect.objectContaining({ workspace_id: "workspace-a" }),
      }),
    }));

    const visibleCompliance = await dispatchDojoTool("synthi_dojo_export_compliance_pack", productionTenantContextArgs({
      roles: ["dojo:compliance:export"],
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
      roles: ["dojo:approval:review"],
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
        roles: ["dojo:approval:review"],
      }),
      request_id: "visible-upgrade-review-test",
      decision: "approved",
      reviewer_actor_id: "workspace-a-reviewer",
      reviewer_actor_type: "human",
      reason: "Workspace reviewer approved visible request.",
      evidence_refs: ["evidence:review-visible-upgrade"],
      promotion_evidence_claims: ["checkride_passed", "evidence_fresh"],
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
        approval_queue: expect.arrayContaining([
          expect.objectContaining({
            action: "commit_mutation",
            source: "license_gated_action",
            status: "pending",
          }),
          expect.objectContaining({
            action: "commit_mutation",
            source: "license_approval_requirement",
            status: "pending",
          }),
        ]),
      }),
    }));
  });

  it("enforces RBAC for production license revocation through the MCP tool", async () => {
    const { visibleSkillId } = await publishTwoWorkspaceSkillsForDojoToolTest();
    process.env.SYNTHI_DOJO_PRODUCTION_ENFORCEMENT = "1";

    const blockedRevocation = await dispatchDojoTool("synthi_dojo_revoke_license", {
      skill_id: visibleSkillId,
      reason: "production rbac revocation test",
      actor_id: "workspace-a-auditor",
      actor_type: "human",
      evidence_refs: ["evidence:revocation-rbac-blocked"],
      ...productionTenantContextArgs({
        actor_id: "workspace-a-auditor",
        actor_type: "human",
        roles: ["dojo:governance:view"],
        request_id: "req-revocation-rbac-blocked",
        correlation_id: "corr-revocation-rbac-blocked",
      }),
    });
    expect(blockedRevocation?.isError).toBe(true);
    expect(blockedRevocation?.structuredContent).toEqual(expect.objectContaining({
      error: "dojo_license_revocation_role_required",
      ok: false,
      skill_id: visibleSkillId,
      blocked_by: expect.arrayContaining(["governance_role_required:dojo:license:revoke"]),
    }));

    const allowedRevocation = await dispatchDojoTool("synthi_dojo_revoke_license", {
      skill_id: visibleSkillId,
      reason: "production rbac revocation test approved",
      actor_id: "workspace-a-license-operator",
      actor_type: "human",
      evidence_refs: ["evidence:revocation-rbac-approved"],
      ...productionTenantContextArgs({
        actor_id: "workspace-a-license-operator",
        actor_type: "human",
        roles: ["dojo:license:revoke"],
        request_id: "req-revocation-rbac-approved",
        correlation_id: "corr-revocation-rbac-approved",
      }),
    });
    expect(allowedRevocation?.isError).toBeUndefined();
    expect(allowedRevocation?.structuredContent).toEqual(expect.objectContaining({
      ok: true,
      skill_id: visibleSkillId,
      license: expect.objectContaining({ entrustment_level: "EX", autonomy_level: "blocked" }),
      revocation: expect.objectContaining({
        rbac_authorization: expect.objectContaining({
          action: "license_revocation",
          actor_id: "workspace-a-license-operator",
          matched_roles: ["dojo:license:revoke"],
        }),
      }),
    }));
  });

  it("enforces RBAC for production license recertification through the MCP tool", async () => {
    const { visibleSkillId } = await publishTwoWorkspaceSkillsForDojoToolTest();
    process.env.SYNTHI_DOJO_PRODUCTION_ENFORCEMENT = "1";

    const blockedRecertification = await dispatchDojoTool("synthi_dojo_recertify_skill", {
      skill_id: visibleSkillId,
      reason: "production rbac recertification test",
      actor_id: "workspace-a-auditor",
      actor_type: "human",
      evidence_refs: ["evidence:recertification-rbac-blocked"],
      ...productionTenantContextArgs({
        actor_id: "workspace-a-auditor",
        actor_type: "human",
        roles: ["dojo:governance:view"],
        request_id: "req-recertification-rbac-blocked",
        correlation_id: "corr-recertification-rbac-blocked",
      }),
    });
    expect(blockedRecertification?.isError).toBe(true);
    expect(blockedRecertification?.structuredContent).toEqual(expect.objectContaining({
      error: "dojo_license_recertification_role_required",
      ok: false,
      skill_id: visibleSkillId,
      blocked_by: expect.arrayContaining(["governance_role_required:dojo:license:recertify"]),
      rbac_authorization: expect.objectContaining({
        action: "license_recertification",
        actor_id: "workspace-a-auditor",
        required_roles: ["dojo:license:recertify"],
      }),
    }));

    const allowedRecertification = await dispatchDojoTool("synthi_dojo_recertify_skill", {
      skill_id: visibleSkillId,
      reason: "production rbac recertification test approved",
      actor_id: "workspace-a-license-operator",
      actor_type: "human",
      evidence_refs: ["evidence:recertification-rbac-approved"],
      now: "2026-06-11T00:04:40.000Z",
      ...productionTenantContextArgs({
        actor_id: "workspace-a-license-operator",
        actor_type: "human",
        roles: ["dojo:license:recertify"],
        request_id: "req-recertification-rbac-approved",
        correlation_id: "corr-recertification-rbac-approved",
      }),
    });
    expect(allowedRecertification?.isError).toBeUndefined();
    expect(allowedRecertification?.structuredContent).toEqual(expect.objectContaining({
      ok: true,
      skill: expect.objectContaining({ skill_id: visibleSkillId }),
      recertification: expect.objectContaining({
        ok: true,
        status: "applied",
        skill_id: visibleSkillId,
        rbac_authorization: expect.objectContaining({
          action: "license_recertification",
          actor_id: "workspace-a-license-operator",
          matched_roles: ["dojo:license:recertify"],
        }),
        audit_event: expect.objectContaining({
          event_type: "checkride_run_completed",
          tenant_context: expect.objectContaining({
            actor_id: "workspace-a-license-operator",
            roles: ["dojo:license:recertify"],
          }),
        }),
      }),
    }));
  });

  it("enforces RBAC for production compliance export through the MCP tool", async () => {
    const { visibleSkillId } = await publishTwoWorkspaceSkillsForDojoToolTest();
    process.env.SYNTHI_DOJO_PRODUCTION_ENFORCEMENT = "1";

    const blockedExport = await dispatchDojoTool("synthi_dojo_export_compliance_pack", {
      skill_id: visibleSkillId,
      ...productionTenantContextArgs({
        actor_id: "workspace-a-viewer",
        actor_type: "human",
        roles: ["dojo:governance:view"],
        request_id: "req-compliance-export-rbac-blocked",
        correlation_id: "corr-compliance-export-rbac-blocked",
      }),
    });
    expect(blockedExport?.isError).toBe(true);
    expect(blockedExport?.structuredContent).toEqual(expect.objectContaining({
      error: "dojo_compliance_export_role_required",
      ok: false,
      skill_ids: [visibleSkillId],
      blocked_by: expect.arrayContaining(["governance_role_required:dojo:compliance:export|dojo:auditor"]),
      rbac_authorization: expect.objectContaining({
        action: "compliance_export",
        actor_id: "workspace-a-viewer",
        required_roles: ["dojo:compliance:export", "dojo:auditor"],
      }),
    }));

    const allowedExport = await dispatchDojoTool("synthi_dojo_export_compliance_pack", {
      skill_id: visibleSkillId,
      ...productionTenantContextArgs({
        actor_id: "workspace-a-auditor",
        actor_type: "human",
        roles: ["dojo:compliance:export"],
        request_id: "req-compliance-export-rbac-approved",
        correlation_id: "corr-compliance-export-rbac-approved",
      }),
    });
    expect(allowedExport?.isError).toBeUndefined();
    expect(allowedExport?.structuredContent).toEqual(expect.objectContaining({
      ok: true,
      pack: expect.objectContaining({
        skill_ids: [visibleSkillId],
        workspace_ids: ["workspace-a"],
      }),
      rbac_authorization: expect.objectContaining({
        action: "compliance_export",
        actor_id: "workspace-a-auditor",
        matched_roles: ["dojo:compliance:export"],
      }),
    }));
  });

  it("runs scheduled governance jobs through RBAC, dry-run, archive manifests, and audit persistence", async () => {
    const { visibleSkillId } = await publishTwoWorkspaceSkillsForDojoToolTest();
    process.env.SYNTHI_DOJO_PRODUCTION_ENFORCEMENT = "1";

    const blocked = await dispatchDojoTool("synthi_dojo_run_scheduled_governance_jobs", {
      job_kinds: ["recompute_registry_metrics"],
      dry_run: true,
      now: "2026-06-11T00:05:00.000Z",
      ...productionTenantContextArgs({
        actor_id: "workspace-a-viewer",
        actor_type: "human",
        roles: ["dojo:governance:view"],
        request_id: "req-scheduled-governance-rbac-blocked",
        correlation_id: "corr-scheduled-governance-rbac-blocked",
      }),
    });
    expect(blocked?.isError).toBe(true);
    expect(blocked?.structuredContent).toEqual(expect.objectContaining({
      error: "dojo_scheduled_governance_job_role_required",
      ok: false,
      blocked_by: expect.arrayContaining(["governance_role_required:dojo:governance:schedule|dojo:operator"]),
      rbac_authorization: expect.objectContaining({
        action: "scheduled_job_run",
        actor_id: "workspace-a-viewer",
        required_roles: ["dojo:governance:schedule", "dojo:operator"],
      }),
    }));

    const dryRun = await dispatchDojoTool("synthi_dojo_run_scheduled_governance_jobs", {
      job_kinds: ["recompute_registry_metrics"],
      dry_run: true,
      now: "2026-06-11T00:05:10.000Z",
      ...productionScheduledJobRunnerContextArgs({
        actor_id: "workspace-a-scheduler",
        actor_type: "service",
        request_id: "req-scheduled-governance-dry-run",
        correlation_id: "corr-scheduled-governance-dry-run",
      }),
    });
    expect(dryRun?.isError).toBeUndefined();
    expect(dryRun?.structuredContent).toEqual(expect.objectContaining({
      ok: true,
      dry_run: true,
      implementation_status: "executable",
      selected_job_count: 1,
      selected_job_kinds: ["recompute_registry_metrics"],
      scheduled_job_run: expect.objectContaining({
        schema_version: "synthi.dojo.governanceScheduledJobRun.v1",
        job_count: 1,
        attempted_count: 1,
        skipped_count: 1,
        applied_count: 0,
        results: [
          expect.objectContaining({
            kind: "recompute_registry_metrics",
            status: "skipped",
            details: expect.objectContaining({ dry_run: true }),
          }),
        ],
      }),
    }));
    expect((dryRun?.structuredContent as Record<string, unknown>).scheduled_job_audit_persistence).toBeUndefined();

    const applied = await dispatchDojoTool("synthi_dojo_run_scheduled_governance_jobs", {
      job_kinds: ["recompute_registry_metrics"],
      dry_run: false,
      now: "2026-06-11T00:05:20.000Z",
      ...productionScheduledJobRunnerContextArgs({
        actor_id: "workspace-a-scheduler",
        actor_type: "service",
        request_id: "req-scheduled-governance-apply",
        correlation_id: "corr-scheduled-governance-apply",
      }),
    });
    expect(applied?.isError).toBeUndefined();
    expect(applied?.structuredContent).toEqual(expect.objectContaining({
      ok: true,
      dry_run: false,
      selected_job_count: 1,
      selected_job_kinds: ["recompute_registry_metrics"],
      scheduled_job_run: expect.objectContaining({
        attempted_count: 1,
        applied_count: 1,
        blocked_count: 0,
        results: [
          expect.objectContaining({
            kind: "recompute_registry_metrics",
            status: "applied",
            audit_event: expect.objectContaining({
              event_type: "governance_scheduled_job_completed",
              actor: { actor_id: "workspace-a-scheduler", actor_type: "service" },
            }),
          }),
        ],
      }),
      scheduled_job_audit_persistence: expect.objectContaining({
        persisted_count: 1,
        blocked_count: 0,
        results: [
          expect.objectContaining({
            status: "persisted",
            audit_event: expect.objectContaining({
              event_type: "governance_scheduled_job_completed",
              request_id: "req-scheduled-governance-apply",
              correlation_id: "corr-scheduled-governance-apply",
              entity_kind: "governance_scheduled_job",
            }),
          }),
        ],
      }),
    }));

    const archived = await dispatchDojoTool("synthi_dojo_run_scheduled_governance_jobs", {
      job_kinds: ["archive_compliance_evidence"],
      dry_run: false,
      now: "2026-06-11T00:05:30.000Z",
      ...productionScheduledJobRunnerContextArgs({
        actor_id: "workspace-a-scheduler",
        actor_type: "service",
        request_id: "req-scheduled-governance-archive",
        correlation_id: "corr-scheduled-governance-archive",
      }),
    });
    expect(archived?.isError).toBeUndefined();
    expect(archived?.structuredContent).toEqual(expect.objectContaining({
      ok: true,
      dry_run: false,
      selected_job_count: 1,
      selected_job_kinds: ["archive_compliance_evidence"],
      scheduled_job_run: expect.objectContaining({
        attempted_count: 1,
        applied_count: 1,
        blocked_count: 0,
        results: [
          expect.objectContaining({
            kind: "archive_compliance_evidence",
            status: "applied",
            evidence_refs: expect.arrayContaining([
              expect.stringMatching(/^compliance_archive:compliance_archive_[a-f0-9]{16}$/),
            ]),
            details: expect.objectContaining({
              archive_manifest: expect.objectContaining({
                schema_version: "synthi.dojo.complianceEvidenceArchive.v1",
                archive_id: expect.stringMatching(/^compliance_archive_[a-f0-9]{16}$/),
                tenant_id: "tenant-a",
                workspace_id: "workspace-a",
                artifact_count: expect.any(Number),
                manifest_sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
              }),
              archive_manifest_sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
            }),
            audit_event: expect.objectContaining({
              event_type: "governance_scheduled_job_completed",
              actor: { actor_id: "workspace-a-scheduler", actor_type: "service" },
            }),
          }),
        ],
      }),
      scheduled_job_audit_persistence: expect.objectContaining({
        persisted_count: 1,
        blocked_count: 0,
        results: [
          expect.objectContaining({
            status: "persisted",
            audit_event: expect.objectContaining({
              event_type: "governance_scheduled_job_completed",
              request_id: "req-scheduled-governance-archive",
              correlation_id: "corr-scheduled-governance-archive",
              entity_kind: "governance_scheduled_job",
            }),
          }),
        ],
      }),
    }));

    const governance = await dispatchDojoTool("synthi_dojo_get_governance_report", {
      skill_id: visibleSkillId,
      ...productionTenantContextArgs({
        roles: ["dojo:governance:view"],
        request_id: "req-scheduled-governance-report-after-apply",
        correlation_id: "corr-scheduled-governance-report-after-apply",
      }),
    });
    expect(governance?.structuredContent).toEqual(expect.objectContaining({
      governance_service: expect.objectContaining({
        audit_exports: expect.arrayContaining([
          expect.objectContaining({
            export_id: "control_plane_audit",
            event_type_counts: expect.objectContaining({
              governance_scheduled_job_completed: expect.any(Number),
            }),
          }),
        ]),
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
        expect.objectContaining({ name: "synthi_dojo_run_evil_twin" }),
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
        "synthi_dojo_capture_source_snapshot",
        "synthi_dojo_detect_source_drift",
        "synthi_dojo_get_source_affordance_pr_plan",
        "synthi_dojo_prepare_source_affordance_pr",
        "synthi_dojo_create_source_affordance_pr_branch",
        "synthi_dojo_prepare_api_backed_tool",
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
        "synthi_dojo_run_evil_twin",
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

  it("blocks production skill publication when executable checkride evidence cannot be ledger-backed", async () => {
    process.env.SYNTHI_DOJO_PRODUCTION_ENFORCEMENT = "1";
    process.env.SYNTHI_DOJO_REQUIRE_EVIDENCE_LEDGER = "1";

    recordOpenDetailsWorkflowForDojoToolTest();
    const blockedPublish = await dispatchDojoTool("synthi_dojo_publish_skill", publishArgsForDojoToolTest({
      ...productionTenantContextArgs({
        actor_id: "unit-publisher",
        actor_type: "human",
        roles: ["agent"],
        request_id: "req-production-proof-publish-rbac-blocked",
        correlation_id: "corr-production-proof-publish-rbac-blocked",
      }),
    }));
    expect(blockedPublish?.isError).toBe(true);
    expect(blockedPublish?.structuredContent).toEqual(expect.objectContaining({
      error: "dojo_skill_publication_role_required",
      ok: false,
      workflow_id: expect.any(String),
      workspace_id: "workspace-a",
      blocked_by: expect.arrayContaining(["governance_role_required:dojo:skill:publish"]),
      rbac_authorization: expect.objectContaining({
        action: "skill_publication",
        actor_id: "unit-publisher",
        required_roles: ["dojo:skill:publish"],
        matched_roles: [],
      }),
    }));
    expect(dojoSkillRegistry.list()).toHaveLength(0);

    const publish = await dispatchDojoTool("synthi_dojo_publish_skill", publishArgsForDojoToolTest({
      ...productionSkillPublisherContextArgs({
        actor_id: "unit-publisher",
        actor_type: "human",
        request_id: "req-production-proof-publish",
        correlation_id: "corr-production-proof-publish",
      }),
    }));
    expect(publish?.isError).toBe(true);
    expect(publish?.structuredContent).toEqual(expect.objectContaining({
      error: "dojo_publication_evidence_ledger_required",
      ok: false,
      operation: "synthi_dojo_publish_or_recertify_skill",
      enforcement_mode: "production",
      require_evidence_ledger: true,
      evidence_ledger_store_kind: "unconfigured",
      blocked_by: expect.arrayContaining([
        "evidence_ledger_store_unconfigured",
        "evidence_ledger_append_store_kind_unsupported:unconfigured",
      ]),
      error_codes: ["proof_evidence_claim_unverified"],
    }));
    expect(dojoSkillRegistry.list()).toHaveLength(0);
  });

  it("enforces RBAC before issuing production proof capsules through the MCP tool", async () => {
    recordOpenDetailsWorkflowForDojoToolTest();
    const publish = await dispatchDojoTool("synthi_dojo_publish_skill", publishArgsForDojoToolTest({
      ...productionTenantContextArgs({
        actor_id: "unit-publisher",
        actor_type: "human",
        request_id: "req-production-proof-rbac-publish",
        correlation_id: "corr-production-proof-rbac-publish",
      }),
    }));
    expect(publish?.isError).toBeUndefined();
    const skillId = (publish?.structuredContent as { skill: { skill_id: string } }).skill.skill_id;
    process.env.SYNTHI_DOJO_PRODUCTION_ENFORCEMENT = "1";
    process.env.SYNTHI_DOJO_REQUIRE_EVIDENCE_LEDGER = "1";

    const blockedIssue = await dispatchDojoTool("synthi_dojo_issue_proof_capsule", {
      skill_id: skillId,
      requested_action: "run_workflow",
      context_claims: { workspace_verified: true },
      ...productionTenantContextArgs({
        actor_id: "proof-viewer-a",
        roles: ["agent"],
        request_id: "req-proof-issue-rbac-blocked",
        correlation_id: "corr-proof-issue-rbac-blocked",
      }),
      now: "2026-06-11T00:05:00.000Z",
    });
    expect(blockedIssue?.isError).toBe(true);
    expect(blockedIssue?.structuredContent).toEqual(expect.objectContaining({
      ok: false,
      error: "dojo_proof_capsule_issue_role_required",
      skill_id: skillId,
      requested_action: "run_workflow",
      blocked_by: expect.arrayContaining(["governance_role_required:dojo:proof:issue"]),
      rbac_authorization: expect.objectContaining({
        action: "proof_capsule_issue",
        actor_id: "proof-viewer-a",
        required_roles: ["dojo:proof:issue"],
        matched_roles: [],
      }),
    }));
    expect(dojoSkillRegistry.listProofRecords()).toEqual([]);
  });

  it("enforces RBAC before revoking production proof capsules through the MCP tool", async () => {
    recordOpenDetailsWorkflowForDojoToolTest();
    const publish = await dispatchDojoTool("synthi_dojo_publish_skill", publishArgsForDojoToolTest());
    expect(publish?.isError).toBeUndefined();
    const skillId = (publish?.structuredContent as { skill: { skill_id: string } }).skill.skill_id;
    const proofIssue = await dispatchDojoTool("synthi_dojo_issue_proof_capsule", {
      skill_id: skillId,
      requested_action: "run_workflow",
      context_claims: { workspace_verified: true },
    });
    expect(proofIssue?.isError).toBeUndefined();
    const proofCapsule = (proofIssue?.structuredContent as {
      proof_capsule: { capsule_id: string };
    }).proof_capsule;
    process.env.SYNTHI_DOJO_PRODUCTION_ENFORCEMENT = "1";

    const blockedRevoke = await dispatchDojoTool("synthi_dojo_revoke_proof_capsule", {
      capsule_id: proofCapsule.capsule_id,
      reason: "proof lifecycle RBAC test",
      evidence_refs: ["evidence:proof-rbac-blocked"],
      ...productionTenantContextArgs({
        actor_id: "proof-viewer-a",
        actor_type: "human",
        roles: ["agent"],
        request_id: "req-proof-revoke-rbac-blocked",
        correlation_id: "corr-proof-revoke-rbac-blocked",
      }),
    });
    expect(blockedRevoke?.isError).toBe(true);
    expect(blockedRevoke?.structuredContent).toEqual(expect.objectContaining({
      ok: false,
      error: "dojo_proof_capsule_revocation_role_required",
      capsule_id: proofCapsule.capsule_id,
      skill_id: skillId,
      blocked_by: expect.arrayContaining(["governance_role_required:dojo:proof:revoke"]),
      rbac_authorization: expect.objectContaining({
        action: "proof_capsule_revoke",
        actor_id: "proof-viewer-a",
        required_roles: ["dojo:proof:revoke"],
        matched_roles: [],
      }),
    }));
    expect(dojoSkillRegistry.getProofRecord(proofCapsule.capsule_id)).toEqual(expect.objectContaining({
      status: "issued",
    }));

    const allowedRevoke = await dispatchDojoTool("synthi_dojo_revoke_proof_capsule", {
      capsule_id: proofCapsule.capsule_id,
      reason: "proof lifecycle RBAC test",
      evidence_refs: ["evidence:proof-rbac-approved"],
      ...productionProofRevokerContextArgs({
        actor_id: "proof-revoker-a",
        actor_type: "human",
        request_id: "req-proof-revoke-rbac-approved",
        correlation_id: "corr-proof-revoke-rbac-approved",
      }),
      now: "2026-06-11T00:07:00.000Z",
    });
    expect(allowedRevoke?.isError).toBeUndefined();
    expect(allowedRevoke?.structuredContent).toEqual(expect.objectContaining({
      ok: true,
      proof_record: expect.objectContaining({
        status: "revoked",
        revoked_at: "2026-06-11T00:07:00.000Z",
        revoked_by: { actor_id: "proof-revoker-a", actor_type: "human" },
      }),
      rbac_authorization: expect.objectContaining({
        action: "proof_capsule_revoke",
        actor_id: "proof-revoker-a",
        matched_roles: ["dojo:proof:revoke"],
      }),
    }));
  });

  it("requires ledger-backed evidence before issuing proof capsules in production enforcement", async () => {
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
    process.env.SYNTHI_DOJO_PRODUCTION_ENFORCEMENT = "1";
    process.env.SYNTHI_DOJO_REQUIRE_EVIDENCE_LEDGER = "1";

    const missingEvidence = await dispatchDojoTool("synthi_dojo_issue_proof_capsule", {
      skill_id: skillId,
      ...productionProofIssuerContextArgs({
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
      ...productionProofIssuerContextArgs({
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
    expect(wrongScope?.structuredContent).toEqual(expect.objectContaining({
      error: "dojo_proof_evidence_ledger_inline_records_forbidden",
      ok: false,
      enforcement_mode: "production",
      require_verified_evidence: true,
      evidence_record_count: 1,
      evidence_ledger_store_kind: "unconfigured",
      blocked_by: ["evidence_ledger_inline_records_forbidden_in_production"],
      error_codes: ["proof_evidence_claim_unverified"],
    }));

    const inlineEvidence = await dispatchDojoTool("synthi_dojo_issue_proof_capsule", {
      skill_id: skillId,
      ...productionProofIssuerContextArgs({
        actor_id: "proof-issuer-a",
        request_id: "req-proof-inline-evidence",
      }),
      requested_action: "run_workflow",
      context_claims: { workspace_verified: true },
      evidence_ledger_records: [evidenceRecord],
      now: "2026-06-11T00:05:00.000Z",
      expires_at: "2026-06-11T00:15:00.000Z",
    });
    expect(inlineEvidence?.isError).toBe(true);
    expect(inlineEvidence?.structuredContent).toEqual(expect.objectContaining({
      error: "dojo_proof_evidence_ledger_inline_records_forbidden",
      ok: false,
      enforcement_mode: "production",
      require_verified_evidence: true,
      evidence_record_count: 1,
      blocked_by: ["evidence_ledger_inline_records_forbidden_in_production"],
      message: expect.stringContaining("configured evidence ledger"),
    }));
  });

  it("fails production proof issuance by evidence record ID when the configured ledger cannot resolve records", async () => {
    recordOpenDetailsWorkflowForDojoToolTest();
    const publish = await dispatchDojoTool("synthi_dojo_publish_skill", publishArgsForDojoToolTest({
      ...productionTenantContextArgs({
        actor_id: "unit-publisher",
        actor_type: "human",
        request_id: "req-production-proof-id-publish",
        correlation_id: "corr-production-proof-id-publish",
      }),
    }));
    expect(publish?.isError).toBeUndefined();
    const skillId = (publish?.structuredContent as { skill: { skill_id: string } }).skill.skill_id;
    process.env.SYNTHI_DOJO_PRODUCTION_ENFORCEMENT = "1";
    process.env.SYNTHI_DOJO_REQUIRE_EVIDENCE_LEDGER = "1";
    process.env.SYNTHI_DOJO_EVIDENCE_LEDGER_STORE = "postgres";

    const response = await dispatchDojoTool("synthi_dojo_issue_proof_capsule", {
      skill_id: skillId,
      ...productionProofIssuerContextArgs({
        actor_id: "proof-issuer-a",
        request_id: "req-proof-id-resolution",
      }),
      requested_action: "run_workflow",
      context_claims: { workspace_verified: true },
      evidence_record_ids: ["evidence-production-proof-001"],
      ledger_checkpoint_hash: "a".repeat(64),
      now: "2026-06-11T00:05:00.000Z",
      expires_at: "2026-06-11T00:15:00.000Z",
    });

    expect(response?.isError).toBe(true);
    expect(response?.structuredContent).toEqual(expect.objectContaining({
      error: "dojo_proof_evidence_ledger_resolution_failed",
      ok: false,
      enforcement_mode: "production",
      require_verified_evidence: true,
      evidence_record_ids: ["evidence-production-proof-001"],
      evidence_ledger_store_kind: "postgres",
      blocked_by: expect.arrayContaining(["evidence_ledger_postgres_url_missing"]),
      error_codes: ["proof_evidence_claim_unverified"],
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

  it("prepares a generated source affordance PR bundle and dry-run branch plan from supplied source files", async () => {
    recordOpenDetailsWorkflowForDojoToolTest();
    const publish = await dispatchDojoTool("synthi_dojo_publish_skill", publishArgsForDojoToolTest());
    expect(publish?.isError).toBeUndefined();
    const skillId = (publish?.structuredContent as { skill: { skill_id: string } }).skill.skill_id;

    const prepared = await dispatchDojoTool("synthi_dojo_prepare_source_affordance_pr", {
      skill_id: skillId,
      source_files: [{
        path: "src/details.open.tsx",
        source: [
          "function assertDojoProof(affordanceId) {",
          "  return affordanceId;",
          "}",
          "export function DetailsOpen({ onOpen }) {",
          "  return <button onClick={onOpen}>Open details</button>;",
          "}",
        ].join("\n"),
      }],
      branch_prefix: "dojo/source-affordance",
      code_owner_rules: [{
        path_prefix: "src/",
        owners: ["@synthi/source-reviewers"],
        review_gate: "code_owner",
      }],
    });

    expect(prepared?.isError).toBeUndefined();
    expect(prepared?.structuredContent).toEqual(expect.objectContaining({
      ok: true,
      implementation_status: "executable",
      runtime_enforced: false,
      skill_id: skillId,
      source_file_count: 1,
      typed_patch_plan: expect.objectContaining({
        schema_version: "synthi.dojo.affordancePrPlan.v1",
        operations: expect.arrayContaining([
          expect.objectContaining({
            kind: "stable_locator",
            file_path: "src/details.open.tsx",
          }),
        ]),
      }),
      source_patch_bundle: expect.objectContaining({
        schema_version: "synthi.dojo.generatedSourcePatchBundle.v1",
        ok: true,
        modified_files: expect.arrayContaining([
          expect.objectContaining({
            path: "src/details.open.tsx",
            changed: true,
            applied_operations: expect.arrayContaining([expect.stringMatching(/^patch_stable_locator_/)]),
          }),
        ]),
        generated_tests: expect.arrayContaining([
          expect.objectContaining({
            path: expect.stringMatching(/dojo-affordance\.test\.ts$/),
          }),
        ]),
      }),
      generated_pr_metadata: expect.objectContaining({
        schema_version: "synthi.dojo.generatedSourcePrMetadata.v1",
        branch_name: expect.stringMatching(/^dojo\/source-affordance\//),
        review_requirements: expect.arrayContaining([
          expect.objectContaining({
            gate: "code_owner",
            owners: expect.arrayContaining(["@synthi/source-reviewers"]),
          }),
        ]),
      }),
      generated_pr_branch_plan: expect.objectContaining({
        schema_version: "synthi.dojo.generatedSourcePrBranchPlan.v1",
        ready_to_apply: true,
        promotion_blockers: [],
        file_writes: expect.arrayContaining([
          expect.objectContaining({
            kind: "source",
            path: "src/details.open.tsx",
          }),
          expect.objectContaining({
            kind: "contract_test",
            path: expect.stringMatching(/dojo-affordance\.test\.ts$/),
          }),
        ]),
      }),
      dry_run_apply: null,
      ready_for_review: true,
      promotion_blockers: [],
    }));
    const modified = (prepared?.structuredContent as {
      source_patch_bundle: { modified_files: Array<{ path: string; source: string }> };
    }).source_patch_bundle.modified_files.find((file) => file.path === "src/details.open.tsx");
    expect(modified?.source).toContain("data-agent-action=");
    expect(modified?.source).toContain("assertDojoProof(");
  });

  it("enforces RBAC for production source affordance PR tooling through the MCP tool", async () => {
    recordOpenDetailsWorkflowForDojoToolTest();
    const publish = await dispatchDojoTool("synthi_dojo_publish_skill", publishArgsForDojoToolTest());
    expect(publish?.isError).toBeUndefined();
    const skillId = (publish?.structuredContent as { skill: { skill_id: string } }).skill.skill_id;
    const sourceFiles = [{
      path: "src/details.open.tsx",
      source: detailsOpenSourceForDojoToolTest(),
    }];
    process.env.SYNTHI_DOJO_PRODUCTION_ENFORCEMENT = "1";

    const blockedPrepare = await dispatchDojoTool("synthi_dojo_prepare_source_affordance_pr", {
      skill_id: skillId,
      source_files: sourceFiles,
      ...productionTenantContextArgs({
        actor_id: "source-affordance-viewer",
        actor_type: "human",
        roles: ["dojo:governance:view"],
        request_id: "req-source-affordance-pr-prepare-blocked",
        correlation_id: "corr-source-affordance-pr-prepare-blocked",
      }),
    });
    expect(blockedPrepare?.isError).toBe(true);
    expect(blockedPrepare?.structuredContent).toEqual(expect.objectContaining({
      ok: false,
      error: "dojo_source_affordance_pr_prepare_role_required",
      skill_id: skillId,
      blocked_by: expect.arrayContaining(["governance_role_required:dojo:source:review|source-registry"]),
      rbac_authorization: expect.objectContaining({
        action: "source_affordance_pr_prepare",
        actor_id: "source-affordance-viewer",
        required_roles: ["dojo:source:review", "source-registry"],
        matched_roles: [],
      }),
    }));

    const allowedPrepare = await dispatchDojoTool("synthi_dojo_prepare_source_affordance_pr", {
      skill_id: skillId,
      source_files: sourceFiles,
      ...productionTenantContextArgs({
        actor_id: "source-affordance-reviewer",
        actor_type: "human",
        roles: ["dojo:source:review"],
        request_id: "req-source-affordance-pr-prepare-allowed",
        correlation_id: "corr-source-affordance-pr-prepare-allowed",
      }),
    });
    expect(allowedPrepare?.isError).toBeUndefined();
    expect(allowedPrepare?.structuredContent).toEqual(expect.objectContaining({
      ok: true,
      skill_id: skillId,
      ready_for_review: false,
      promotion_blockers: expect.arrayContaining(["generated_pr_code_owner_unresolved:src/details.open.tsx"]),
      rbac_authorization: expect.objectContaining({
        action: "source_affordance_pr_prepare",
        actor_id: "source-affordance-reviewer",
        matched_roles: ["dojo:source:review"],
      }),
    }));

    const blockedBranch = await dispatchDojoTool("synthi_dojo_create_source_affordance_pr_branch", {
      skill_id: skillId,
      source_files: sourceFiles,
      repository_root: path.join(tmpdir(), "dojo-source-affordance-rbac-not-used"),
      ...productionTenantContextArgs({
        actor_id: "source-affordance-reviewer",
        actor_type: "human",
        roles: ["dojo:source:review"],
        request_id: "req-source-affordance-pr-branch-blocked",
        correlation_id: "corr-source-affordance-pr-branch-blocked",
      }),
    });
    expect(blockedBranch?.isError).toBe(true);
    expect(blockedBranch?.structuredContent).toEqual(expect.objectContaining({
      ok: false,
      error: "dojo_source_affordance_pr_branch_role_required",
      skill_id: skillId,
      blocked_by: expect.arrayContaining(["governance_role_required:dojo:source:apply"]),
      rbac_authorization: expect.objectContaining({
        action: "source_affordance_pr_branch",
        actor_id: "source-affordance-reviewer",
        required_roles: ["dojo:source:apply"],
        matched_roles: [],
      }),
    }));

    const repoRoot = await initializedDetailsOpenSourceRepoForDojoToolTest();
    const allowedBranch = await dispatchDojoTool("synthi_dojo_create_source_affordance_pr_branch", {
      skill_id: skillId,
      source_files: sourceFiles,
      repository_root: repoRoot,
      dry_run: true,
      ...productionTenantContextArgs({
        actor_id: "source-affordance-applier",
        actor_type: "human",
        roles: ["dojo:source:apply"],
        request_id: "req-source-affordance-pr-branch-allowed",
        correlation_id: "corr-source-affordance-pr-branch-allowed",
      }),
    });
    expect(allowedBranch?.isError).toBeUndefined();
    expect(allowedBranch?.structuredContent).toEqual(expect.objectContaining({
      ok: true,
      skill_id: skillId,
      branch_created: false,
      ready_for_review: false,
      promotion_blockers: expect.arrayContaining([
        "generated_pr_code_owner_unresolved:src/details.open.tsx",
        "generated_pr_git_branch:generated_pr_branch_apply_preflight:generated_pr_branch_plan_not_ready",
      ]),
      rbac_authorization: expect.objectContaining({
        action: "source_affordance_pr_branch",
        actor_id: "source-affordance-applier",
        matched_roles: ["dojo:source:apply"],
      }),
      generated_pr_git_branch: expect.objectContaining({
        dry_run: true,
        ok: false,
        issues: expect.arrayContaining([
          expect.objectContaining({ issue_id: "generated_pr_branch_apply_preflight:generated_pr_branch_plan_not_ready" }),
        ]),
      }),
    }));
  });

  it("captures a signed release-scoped source snapshot without echoing the signing secret", async () => {
    const signingKey = "source-signing-secret-a";
    const captured = await dispatchDojoTool("synthi_dojo_capture_source_snapshot", {
      ...productionTenantContextArgs({
        actor_id: "source-snapshot-service",
        actor_type: "service",
        roles: ["source-registry"],
        request_id: "req-source-snapshot",
        correlation_id: "corr-source-snapshot",
      }),
      app_origin: "https://app.example.test",
      app_version: "2026.06.17",
      commit_sha: "commit-source-snapshot-a",
      source_root: "src",
      signer_key_id: "source-key-a",
      signing_key: signingKey,
      created_at: "2026-06-17T00:00:00.000Z",
      source_tokens: [
        {
          token_id: "submit-invoice",
          route: "/invoices/new",
          component: "InvoiceForm",
          action: "submitInvoice",
          source_locator: "src/routes/invoices/InvoiceForm.jsx:88",
          source_sha256: createHash("sha256").update("submitInvoice:v1").digest("hex"),
          risk: "mutation",
        },
        {
          token_id: "invoice-total",
          route: "/invoices/new",
          component: "InvoiceTotal",
          source_locator: "src/routes/invoices/InvoiceTotal.jsx:12",
          risk: "safe",
        },
      ],
    });

    expect(captured?.isError).toBeUndefined();
    expect(captured?.structuredContent).toEqual(expect.objectContaining({
      ok: true,
      implementation_status: "executable",
      runtime_enforced: false,
      tenant_id: "tenant-a",
      workspace_id: "workspace-a",
      app_origin: "https://app.example.test",
      app_version: "2026.06.17",
      source_token_count: 2,
      verification: expect.objectContaining({
        ok: true,
        blocked_by: [],
      }),
      source_snapshot: expect.objectContaining({
        schema_version: "synthi.dojo.sourceSnapshot.v1",
        tenant_id: "tenant-a",
        workspace_id: "workspace-a",
        commit_sha: "commit-source-snapshot-a",
        signer_key_id: "source-key-a",
        signature_algorithm: "hmac-sha256",
        snapshot_signature: expect.stringMatching(/^hmac-sha256:/),
        source_token_ids: ["invoice-total", "submit-invoice"],
      }),
      blocked_by: [],
    }));
    const body = JSON.stringify(captured?.structuredContent);
    expect(body).not.toContain(signingKey);
  });

  it("detects source drift from signed source snapshots and graph node bindings", async () => {
    const signingKey = "source-signing-secret-a";
    const previous = await dispatchDojoTool("synthi_dojo_capture_source_snapshot", {
      ...productionTenantContextArgs({
        actor_id: "source-drift-service",
        actor_type: "service",
        roles: ["source-registry"],
        request_id: "req-source-drift-prev",
        correlation_id: "corr-source-drift",
      }),
      app_origin: "https://app.example.test",
      app_version: "2026.06.16",
      commit_sha: "commit-source-drift-prev",
      source_root: "src",
      signer_key_id: "source-key-a",
      signing_key: signingKey,
      created_at: "2026-06-16T00:00:00.000Z",
      source_tokens: [
        {
          token_id: "submit-invoice",
          route: "/invoices/new",
          component: "InvoiceForm",
          action: "submitInvoice",
          source_locator: "src/routes/invoices/InvoiceForm.jsx:88",
          source_sha256: createHash("sha256").update("submitInvoice:v1").digest("hex"),
          risk: "mutation",
        },
      ],
    });
    const next = await dispatchDojoTool("synthi_dojo_capture_source_snapshot", {
      ...productionTenantContextArgs({
        actor_id: "source-drift-service",
        actor_type: "service",
        roles: ["source-registry"],
        request_id: "req-source-drift-next",
        correlation_id: "corr-source-drift",
      }),
      app_origin: "https://app.example.test",
      app_version: "2026.06.17",
      commit_sha: "commit-source-drift-next",
      source_root: "src",
      signer_key_id: "source-key-a",
      signing_key: signingKey,
      created_at: "2026-06-17T00:00:00.000Z",
      source_tokens: [
        {
          token_id: "submit-invoice",
          route: "/invoices/new",
          component: "InvoiceForm",
          action: "submitInvoice",
          source_locator: "src/routes/invoices/InvoiceForm.jsx:88",
          source_sha256: createHash("sha256").update("submitInvoice:v2").digest("hex"),
          risk: "mutation",
        },
        {
          token_id: "delete-invoice",
          route: "/invoices/new",
          component: "InvoiceForm",
          action: "deleteInvoice",
          source_locator: "src/routes/invoices/InvoiceForm.jsx:144",
          risk: "dangerous",
        },
      ],
    });
    expect(previous?.isError).toBeUndefined();
    expect(next?.isError).toBeUndefined();
    const previousSnapshot = (previous?.structuredContent as { source_snapshot: unknown }).source_snapshot;
    const nextSnapshot = (next?.structuredContent as { source_snapshot: unknown }).source_snapshot;

    const drift = await dispatchDojoTool("synthi_dojo_detect_source_drift", {
      ...productionTenantContextArgs({
        actor_id: "source-drift-service",
        actor_type: "service",
        roles: ["source-registry"],
        request_id: "req-source-drift-detect",
        correlation_id: "corr-source-drift",
      }),
      previous_snapshot: previousSnapshot,
      next_snapshot: nextSnapshot,
      source_snapshot_signing_keys_by_id: { "source-key-a": signingKey },
      node_bindings: [
        {
          node_id: "action-submit-invoice",
          source_token_ids: ["submit-invoice"],
          license_id: "license-submit-invoice",
        },
      ],
    });

    expect(drift?.isError).toBeUndefined();
    expect(drift?.structuredContent).toEqual(expect.objectContaining({
      ok: true,
      implementation_status: "executable",
      runtime_enforced: false,
      tenant_id: "tenant-a",
      workspace_id: "workspace-a",
      drifted_token_count: 2,
      affected_node_count: 1,
      license_expiry_trigger_count: 1,
      review_required_token_count: 1,
      source_drift_report: expect.objectContaining({
        schema_version: "synthi.dojo.sourceDriftReport.v1",
        app_origin: "https://app.example.test",
        previous_app_version: "2026.06.16",
        next_app_version: "2026.06.17",
        drifted_token_ids: ["delete-invoice", "submit-invoice"],
        added_token_ids: ["delete-invoice"],
        review_required_token_ids: ["delete-invoice"],
        affected_nodes: [
          expect.objectContaining({
            node_id: "action-submit-invoice",
            source_token_id: "submit-invoice",
            drift_kind: "changed",
            license_id: "license-submit-invoice",
          }),
        ],
        license_expiry_triggers: [
          expect.objectContaining({
            node_id: "action-submit-invoice",
            source_token_id: "submit-invoice",
            license_id: "license-submit-invoice",
          }),
        ],
      }),
      blocked_by: [],
    }));
  });

  it("applies source drift expiry triggers to matching licenses with recertification handoff after a dry-run", async () => {
    recordOpenDetailsWorkflowForDojoToolTest();
    const publish = await dispatchDojoTool("synthi_dojo_publish_skill", publishArgsForDojoToolTest());
    expect(publish?.isError).toBeUndefined();
    const skillId = (publish?.structuredContent as { skill: { skill_id: string } }).skill.skill_id;
    const publishedSkill = dojoSkillRegistry.get(skillId) as DojoSkill;
    const originalExpiry = publishedSkill.license_expires_at;
    const expiredAt = new Date(Date.now() - 60_000).toISOString();
    const signingKey = "source-signing-secret-expiry";
    const tenantArgs = productionTenantContextArgs({
      actor_id: "source-drift-expirer",
      actor_type: "service",
      roles: ["source-registry", "dojo:operator"],
      request_id: "req-source-drift-expire",
      correlation_id: "corr-source-drift-expire",
    });

    const previous = await dispatchDojoTool("synthi_dojo_capture_source_snapshot", {
      ...tenantArgs,
      app_origin: publishedSkill.app_origin,
      app_version: "2026.06.16",
      commit_sha: "commit-source-drift-expire-prev",
      source_root: "src",
      signer_key_id: "source-expiry-key",
      signing_key: signingKey,
      created_at: "2026-06-16T00:00:00.000Z",
      source_tokens: [
        {
          token_id: "details-open-action",
          route: "/settings",
          component: "DetailsPanel",
          action: "openDetails",
          source_locator: "src/routes/settings/DetailsPanel.jsx:20",
          source_sha256: createHash("sha256").update("openDetails:v1").digest("hex"),
          risk: "mutation",
        },
      ],
    });
    const next = await dispatchDojoTool("synthi_dojo_capture_source_snapshot", {
      ...tenantArgs,
      app_origin: publishedSkill.app_origin,
      app_version: "2026.06.17",
      commit_sha: "commit-source-drift-expire-next",
      source_root: "src",
      signer_key_id: "source-expiry-key",
      signing_key: signingKey,
      created_at: "2026-06-17T00:00:00.000Z",
      source_tokens: [
        {
          token_id: "details-open-action",
          route: "/settings",
          component: "DetailsPanel",
          action: "openDetails",
          source_locator: "src/routes/settings/DetailsPanel.jsx:20",
          source_sha256: createHash("sha256").update("openDetails:v2").digest("hex"),
          risk: "mutation",
        },
      ],
    });
    expect(previous?.isError).toBeUndefined();
    expect(next?.isError).toBeUndefined();

    const drift = await dispatchDojoTool("synthi_dojo_detect_source_drift", {
      ...tenantArgs,
      previous_snapshot: (previous?.structuredContent as { source_snapshot: unknown }).source_snapshot,
      next_snapshot: (next?.structuredContent as { source_snapshot: unknown }).source_snapshot,
      source_snapshot_signing_keys_by_id: { "source-expiry-key": signingKey },
      node_bindings: [
        {
          node_id: "action-open-details",
          source_token_ids: ["details-open-action"],
          license_id: publishedSkill.permission_license.license_id,
        },
      ],
    });
    expect(drift?.isError).toBeUndefined();
    const sourceDriftReport = (drift?.structuredContent as { source_drift_report: unknown }).source_drift_report;

    const dryRun = await dispatchDojoTool("synthi_dojo_apply_source_drift_expiry", {
      ...tenantArgs,
      source_drift_report: sourceDriftReport,
      now: expiredAt,
    });
    expect(dryRun?.isError).toBeUndefined();
    expect(dryRun?.structuredContent).toEqual(expect.objectContaining({
      ok: true,
      implementation_status: "executable",
      runtime_enforced: false,
      control_plane_source: "compatibility_registry",
      dry_run: true,
      expired_license_count: 0,
      would_expire_license_count: 1,
      source_drift_expiry_application: expect.objectContaining({
        schema_version: "synthi.dojo.sourceDriftExpiryApplication.v1",
        expired_license_count: 1,
        failed_expiration_count: 0,
        expired_licenses: [
          expect.objectContaining({
            license_id: publishedSkill.permission_license.license_id,
            node_ids: ["action-open-details"],
            source_token_ids: ["details-open-action"],
            record: expect.objectContaining({ status: "expired" }),
          }),
        ],
      }),
      source_drift_recertification_handoff: expect.objectContaining({
        schema_version: "synthi.dojo.sourceDriftRecertificationHandoff.v1",
        dry_run: true,
        required_tool: "synthi_dojo_recertify_skill",
        relicense_allowed_without_recertification: false,
        queue_count: 1,
        would_queue_count: 1,
        queued_count: 0,
        required_before_relicense: expect.arrayContaining([
          "run_synthi_dojo_recertify_skill",
          "provide_current_workflow_artifact",
          "provide_explicit_evidence_refs",
          "pass_executable_checkride",
          "satisfy_evidence_ledger_policy_when_enforced",
        ]),
        queue: [
          expect.objectContaining({
            status: "would_queue",
            skill_id: skillId,
            workflow_id: publishedSkill.workflow_id,
            license_id: publishedSkill.permission_license.license_id,
            required_tool: "synthi_dojo_recertify_skill",
            suggested_args: expect.objectContaining({
              skill_id: skillId,
              workflow_id: publishedSkill.workflow_id,
              evidence_refs: [],
              actor_id: null,
              actor_type: null,
            }),
            skipped_by: [],
          }),
        ],
        blocked_by: [],
      }),
      blocked_by: [],
    }));
    expect(dojoSkillRegistry.get(skillId)?.license_expires_at).toBe(originalExpiry);

    const applied = await dispatchDojoTool("synthi_dojo_apply_source_drift_expiry", {
      ...tenantArgs,
      source_drift_report: sourceDriftReport,
      dry_run: false,
      now: expiredAt,
    });
    expect(applied?.isError).toBeUndefined();
    expect(applied?.structuredContent).toEqual(expect.objectContaining({
      ok: true,
      control_plane_source: "compatibility_registry",
      dry_run: false,
      expired_license_count: 1,
      would_expire_license_count: 0,
      skill_updates: [expect.objectContaining({ skill_id: skillId, status: "expired" })],
      source_drift_expiry_application: expect.objectContaining({
        expired_license_count: 1,
        skipped_trigger_count: 0,
        failed_expiration_count: 0,
      }),
      source_drift_recertification_handoff: expect.objectContaining({
        dry_run: false,
        queue_count: 1,
        would_queue_count: 0,
        queued_count: 1,
        queue: [
          expect.objectContaining({
            status: "queued",
            skill_id: skillId,
            workflow_id: publishedSkill.workflow_id,
            license_id: publishedSkill.permission_license.license_id,
            required_tool: "synthi_dojo_recertify_skill",
          }),
        ],
      }),
      blocked_by: [],
    }));
    const expiredSkill = dojoSkillRegistry.get(skillId) as DojoSkill;
    expect(expiredSkill.license_expires_at).toBe(expiredAt);
    expect(expiredSkill.skill_card.status).toBe("Expired pending source-drift recertification");
    expect(expiredSkill.retrain_triggers).toEqual(expect.arrayContaining([
      expect.objectContaining({
        source: "app",
        condition: expect.stringContaining("source_drift:"),
      }),
    ]));
    const appliedHandoff = (applied?.structuredContent as {
      source_drift_recertification_handoff: {
        queue: Array<{ recertification_trigger: { trigger_id: string; condition: string } }>;
      };
    }).source_drift_recertification_handoff;
    expect(expiredSkill.retrain_triggers).toEqual(expect.arrayContaining([
      expect.objectContaining({
        trigger_id: appliedHandoff.queue[0].recertification_trigger.trigger_id,
        condition: appliedHandoff.queue[0].recertification_trigger.condition,
      }),
    ]));

    const health = await dispatchDojoTool("synthi_dojo_get_license_health", {
      ...tenantArgs,
      skill_id: skillId,
    });
    expect(health?.isError).toBeUndefined();
    expect(health?.structuredContent).toEqual(expect.objectContaining({
      ok: true,
      license_health: expect.objectContaining({
        status: "blocked",
        license_expires_at: expiredAt,
      }),
    }));
  });

  it("creates a generated source affordance PR branch in a temporary git repository", async () => {
    recordOpenDetailsWorkflowForDojoToolTest();
    const publish = await dispatchDojoTool("synthi_dojo_publish_skill", publishArgsForDojoToolTest());
    expect(publish?.isError).toBeUndefined();
    const skillId = (publish?.structuredContent as { skill: { skill_id: string } }).skill.skill_id;
    const repoRoot = await initializedDetailsOpenSourceRepoForDojoToolTest();

    const created = await dispatchDojoTool("synthi_dojo_create_source_affordance_pr_branch", {
      skill_id: skillId,
      source_files: [{
        path: "src/details.open.tsx",
        source: detailsOpenSourceForDojoToolTest(),
      }],
      repository_root: repoRoot,
      dry_run: false,
      branch_prefix: "dojo/source-affordance",
      code_owner_rules: [{
        path_prefix: "src/",
        owners: ["@synthi/source-reviewers"],
        review_gate: "code_owner",
      }],
    });

    expect(created?.isError).toBeUndefined();
    expect(created?.structuredContent).toEqual(expect.objectContaining({
      ok: true,
      implementation_status: "executable",
      runtime_enforced: false,
      skill_id: skillId,
      repository_root: path.resolve(repoRoot),
      branch_created: true,
      ready_for_review: true,
      promotion_blockers: [],
      generated_pr_git_branch: expect.objectContaining({
        schema_version: "synthi.dojo.generatedPrGitBranchResult.v1",
        dry_run: false,
        ok: true,
        issues: [],
        branch_name: expect.stringMatching(/^dojo\/source-affordance\//),
        apply_result: expect.objectContaining({
          ok: true,
          applied_files: expect.arrayContaining([
            expect.objectContaining({
              kind: "source",
              path: "src/details.open.tsx",
              written: true,
            }),
            expect.objectContaining({
              kind: "contract_test",
              path: expect.stringMatching(/dojo-affordance\.test\.ts$/),
              written: true,
            }),
          ]),
        }),
      }),
    }));
    const gitBranch = (created?.structuredContent as {
      generated_pr_git_branch: {
        branch_name: string;
        apply_result: { applied_files: Array<{ kind: "source" | "contract_test"; path: string }> };
      };
    }).generated_pr_git_branch;
    expect(currentGitBranchForDojoToolTest(repoRoot)).toBe(gitBranch.branch_name);
    const patchedSource = await readFile(path.join(repoRoot, "src/details.open.tsx"), "utf8");
    expect(patchedSource).toContain("data-agent-action=");
    expect(patchedSource).toContain("assertDojoProof(");
    const generatedTestPath = gitBranch.apply_result.applied_files.find((file) => file.kind === "contract_test")?.path;
    expect(generatedTestPath).toBeTruthy();
    const generatedTest = await readFile(path.join(repoRoot, generatedTestPath as string), "utf8");
    expect(generatedTest).toContain("Dojo affordance contract");
    expect(generatedTest).toContain("Open details");
  });

  it("prepares a reviewed API-backed MCP tool contract from network trace metadata", async () => {
    recordOpenDetailsWorkflowForDojoToolTest();
    const publish = await dispatchDojoTool("synthi_dojo_publish_skill", publishArgsForDojoToolTest());
    expect(publish?.isError).toBeUndefined();
    const skillId = (publish?.structuredContent as { skill: { skill_id: string } }).skill.skill_id;
    const publishedSkill = dojoSkillRegistry.get(skillId) as DojoSkill;
    const license = publishedSkill.permission_license;

    const proofCapsule = {
      capsule_id: "capsule-api-tool-a",
      nonce: "nonce-api-tool-a",
      skill_id: publishedSkill.skill_id,
      license_id: license.license_id,
      license_version: license.license_version,
      requested_action: "run_workflow",
      evidence_record_ids: ["evidence-workspace", "evidence-checkride"],
      ledger_checkpoint_hash: "sha256:checkpoint-api-tool-a",
      evidence_claims: [
        { claim: "workspace_verified", satisfied: true, evidence_refs: ["evidence-workspace"] },
        { claim: "checkride_passed", satisfied: true, evidence_refs: ["evidence-checkride"] },
      ],
    };

    const prepared = await dispatchDojoTool("synthi_dojo_prepare_api_backed_tool", {
      skill_id: publishedSkill.skill_id,
      network_trace: {
        method: "POST",
        url: "https://app.example.test/api/invoices?workspace=workspace-a",
        request_body: { client_id: "client-a", amount: 42 },
        response_body: { invoice: { status: "saved" } },
        source_ref: "trace:save-invoice-api",
      },
      candidate_overrides: {
        auth_scope: "invoice:write",
        idempotency_key_location: "header",
        rollback_strategy: "compensating_call",
        postcondition: "invoice.status == 'saved'",
        proof_claim_mapping: {
          workspace_verified: "tenant.workspace_id",
          checkride_passed: "dojo.checkride",
        },
        review_status: "approved",
      },
      requested_action: "run_workflow",
      tool_name: "synthi_api_save_invoice",
      auth_scopes: ["invoice:write"],
      sample_invocation_args: {
        proof_capsule: proofCapsule,
        request: { client_id: "client-a", amount: 42 },
        query: { workspace: "workspace-a" },
        idempotency_key: "idem-api-tool-a",
      },
    });

    expect(prepared?.isError).toBeUndefined();
    expect(prepared?.structuredContent).toEqual(expect.objectContaining({
      ok: true,
      implementation_status: "executable",
      runtime_enforced: false,
      skill_id: publishedSkill.skill_id,
      license_id: license.license_id,
      license_version: license.license_version,
      candidate_source: "network_trace",
      api_endpoint_candidate: expect.objectContaining({
        schema_version: "synthi.dojo.apiEndpointCandidate.v1",
        method: "POST",
        path: "/api/invoices",
        review_status: "approved",
        auth_scope: "invoice:write",
        idempotency_key_location: "header",
        rollback_strategy: "compensating_call",
        postcondition: "invoice.status == 'saved'",
        proof_claim_mapping: {
          checkride_passed: "dojo.checkride",
          workspace_verified: "tenant.workspace_id",
        },
      }),
      candidate_review: { ok_to_promote: true, issues: [] },
      api_tool_compile: expect.objectContaining({
        ok: true,
        issues: [],
        tool: expect.objectContaining({
          schema_version: "synthi.dojo.apiBackedMcpTool.v1",
          tool_name: "synthi_api_save_invoice",
          path: "/api/invoices",
          proof_required: true,
          schema_digest: expect.stringMatching(/^sha256:/),
          input_schema: expect.objectContaining({
            additionalProperties: false,
            required: expect.arrayContaining(["proof_capsule", "request", "query", "idempotency_key"]),
          }),
        }),
      }),
      api_backed_mcp_tool: expect.objectContaining({
        enforcement: expect.objectContaining({
          proof_capsule_required: true,
          license_kernel_required: true,
          evidence_write_required: true,
          postcondition_assertion_required: true,
          idempotency_required: true,
        }),
      }),
      sample_invocation_validation: { ok: true, blocked_by: [] },
      ready_for_promotion: true,
      promotion_blockers: [],
    }));
  });

  it("publishes a reviewed API-backed MCP tool into the skill manifest only with reviewer evidence", async () => {
    recordOpenDetailsWorkflowForDojoToolTest();
    const publish = await dispatchDojoTool("synthi_dojo_publish_skill", publishArgsForDojoToolTest());
    expect(publish?.isError).toBeUndefined();
    const skillId = (publish?.structuredContent as { skill: { skill_id: string } }).skill.skill_id;
    const publishedSkill = dojoSkillRegistry.get(skillId) as DojoSkill;
    const license = publishedSkill.permission_license;

    const proofCapsule = {
      capsule_id: "capsule-api-tool-publish",
      nonce: "nonce-api-tool-publish",
      skill_id: publishedSkill.skill_id,
      license_id: license.license_id,
      license_version: license.license_version,
      requested_action: "run_workflow",
      evidence_record_ids: ["evidence-workspace", "evidence-checkride"],
      ledger_checkpoint_hash: "sha256:checkpoint-api-tool-publish",
      evidence_claims: [
        { claim: "workspace_verified", satisfied: true, evidence_refs: ["evidence-workspace"] },
        { claim: "checkride_passed", satisfied: true, evidence_refs: ["evidence-checkride"] },
      ],
    };

    const apiToolPreparationArgs = {
      skill_id: publishedSkill.skill_id,
      network_trace: {
        method: "POST",
        url: "https://app.example.test/api/invoices?workspace=workspace-a",
        request_body: { client_id: "client-a", amount: 42 },
        response_body: { invoice: { status: "saved" } },
        source_ref: "trace:save-invoice-api",
      },
      candidate_overrides: {
        auth_scope: "invoice:write",
        idempotency_key_location: "header",
        rollback_strategy: "compensating_call",
        postcondition: "invoice.status == 'saved'",
        proof_claim_mapping: {
          workspace_verified: "tenant.workspace_id",
          checkride_passed: "dojo.checkride",
        },
        review_status: "approved",
      },
      requested_action: "run_workflow",
      tool_name: "synthi_api_save_invoice",
      auth_scopes: ["invoice:write"],
      publish_to_skill: true,
      sample_invocation_args: {
        proof_capsule: proofCapsule,
        request: { client_id: "client-a", amount: 42 },
        query: { workspace: "workspace-a" },
        idempotency_key: "idem-api-tool-publish",
      },
    };

    const unreviewedPublication = await dispatchDojoTool("synthi_dojo_prepare_api_backed_tool", {
      ...apiToolPreparationArgs,
      now: "2026-06-17T02:59:00.000Z",
    });
    expect(unreviewedPublication?.isError).toBeUndefined();
    expect(unreviewedPublication?.structuredContent).toEqual(expect.objectContaining({
      ready_for_promotion: false,
      promotion_blockers: expect.arrayContaining([
        "api_tool_publication_review:api_tool_publication_reviewer_required",
        "api_tool_publication_review:api_tool_publication_reviewer_actor_type_required",
        "api_tool_publication_review:api_tool_publication_review_evidence_required",
      ]),
      api_tool_publication: expect.objectContaining({
        requested: true,
        ok: false,
        status: "blocked",
      }),
      api_tool_publication_review: expect.objectContaining({
        requested: true,
        ok: false,
        status: "blocked",
      }),
    }));
    expect(dojoSkillRegistry.get(skillId)?.api_backed_mcp_tools ?? []).toEqual([]);

    const prepared = await dispatchDojoTool("synthi_dojo_prepare_api_backed_tool", {
      ...apiToolPreparationArgs,
      reviewer_actor_id: "api-reviewer-a",
      reviewer_actor_type: "human",
      review_reason: "Reviewed endpoint schema, auth scope, idempotency, rollback, and postcondition.",
      review_evidence_refs: ["api-review:evidence-save-invoice"],
      reviewed_at: "2026-06-17T02:59:30.000Z",
      now: "2026-06-17T03:00:00.000Z",
    });

    expect(prepared?.isError).toBeUndefined();
    const body = prepared?.structuredContent as {
      api_tool_publication: {
        status: string;
        ok: boolean;
        published_tool_name: string;
        skill: DojoSkill;
        mcp_skill_manifest: DojoMcpSkillManifestV1;
      };
      mcp_skill_manifest: DojoMcpSkillManifestV1;
    };
    expect(body).toEqual(expect.objectContaining({
      ready_for_promotion: true,
      promotion_blockers: [],
      api_tool_publication: expect.objectContaining({
        requested: true,
        ok: true,
        status: "published",
        published_tool_name: "synthi_api_save_invoice",
        published_tool_version: "1.0.0",
        review: expect.objectContaining({
          requested: true,
          ok: true,
          status: "approved",
          reviewer: { actor_id: "api-reviewer-a", actor_type: "human" },
          evidence_refs: ["api-review:evidence-save-invoice"],
        }),
      }),
      api_tool_publication_review: expect.objectContaining({
        requested: true,
        ok: true,
        status: "approved",
        reviewer: { actor_id: "api-reviewer-a", actor_type: "human" },
        evidence_refs: ["api-review:evidence-save-invoice"],
      }),
      mcp_skill_manifest: expect.objectContaining({
        tool: expect.objectContaining({
          name: "synthi_api_save_invoice",
          kind: "api_backed",
          api_backed_mcp_tool_digest: expect.stringMatching(/^sha256:/),
          backing_private_tool_manifest_digest: null,
        }),
      }),
    }));
    expect(validateDojoMcpSkillManifest(body.mcp_skill_manifest, {
      expected_skill_id: skillId,
      expected_tool_name: "synthi_api_save_invoice",
    })).toEqual(expect.objectContaining({
      ok: true,
      blocked_by: [],
      tool_name: "synthi_api_save_invoice",
    }));

    const updated = dojoSkillRegistry.get(skillId) as DojoSkill;
    expect(updated.published_tools).toContain("synthi_api_save_invoice");
    expect(updated.execution_substrates).toContain("api");
    expect(updated.preferred_substrate).toBe("api");
    expect(updated.api_backed_mcp_tools).toEqual([
      expect.objectContaining({
        tool_name: "synthi_api_save_invoice",
        action: "run_workflow",
        path: "/api/invoices",
        schema_digest: expect.stringMatching(/^sha256:/),
      }),
    ]);
    expect(updated.skill_passport.published_tools).toContain("synthi_api_save_invoice");
    expect(updated.assurance_case.evidence_refs).toEqual(expect.arrayContaining([
      "api_tool:synthi_api_save_invoice:1.0.0",
      "api-review:evidence-save-invoice",
    ]));
    expect(updated.training_report.evidence_refs).toEqual(expect.arrayContaining(["api-review:evidence-save-invoice"]));

    const listed = await dispatchDojoTool("synthi_dojo_list_competencies", {});
    expect(listed?.isError).toBeUndefined();
    const listedContent = listed?.structuredContent as {
      competencies: Array<{
        skill_id: string;
        execution_substrates: string[];
        api_backed_mcp_tools: Array<{ tool_name: string; schema_digest: string }>;
      }>;
    };
    const competency = listedContent.competencies.find((item) => item.skill_id === skillId);
    expect(competency).toEqual(expect.objectContaining({
      execution_substrates: expect.arrayContaining(["api"]),
      api_backed_mcp_tools: [
        expect.objectContaining({
          tool_name: "synthi_api_save_invoice",
          schema_digest: expect.stringMatching(/^sha256:/),
        }),
      ],
    }));
  });

  it("requires RBAC for production API-backed tool preparation and publication", async () => {
    recordOpenDetailsWorkflowForDojoToolTest();
    const publish = await dispatchDojoTool("synthi_dojo_publish_skill", publishArgsForDojoToolTest());
    expect(publish?.isError).toBeUndefined();
    const skillId = (publish?.structuredContent as { skill: { skill_id: string } }).skill.skill_id;

    const apiToolPreparationArgs = {
      skill_id: skillId,
      network_trace: {
        method: "POST",
        url: "https://app.example.test/api/invoices?workspace=workspace-a",
        request_body: { client_id: "client-a", amount: 42 },
        response_body: { invoice: { status: "saved" } },
        source_ref: "trace:production-rbac-api-tool",
      },
      candidate_overrides: {
        auth_scope: "invoice:write",
        idempotency_key_location: "header",
        rollback_strategy: "compensating_call",
        postcondition: "invoice.status == 'saved'",
        proof_claim_mapping: {
          workspace_verified: "tenant.workspace_id",
          checkride_passed: "dojo.checkride",
        },
        review_status: "approved",
      },
      requested_action: "run_workflow",
      tool_name: "synthi_api_save_invoice",
      auth_scopes: ["invoice:write"],
      now: "2026-06-17T04:00:00.000Z",
    };

    process.env.SYNTHI_DOJO_PRODUCTION_ENFORCEMENT = "1";

    const blockedPrepare = await dispatchDojoTool("synthi_dojo_prepare_api_backed_tool", {
      ...apiToolPreparationArgs,
      ...productionTenantContextArgs({
        roles: ["agent"],
        request_id: "req-api-tool-prepare-rbac-blocked",
        correlation_id: "corr-api-tool-prepare-rbac-blocked",
      }),
    });
    expect(blockedPrepare?.isError).toBe(true);
    expect(blockedPrepare?.structuredContent).toEqual(expect.objectContaining({
      ok: false,
      error: "dojo_api_tool_prepare_role_required",
      skill_id: skillId,
      workspace_id: "workspace-a",
      blocked_by: expect.arrayContaining(["governance_role_required:dojo:api-tool:prepare|dojo:source:review|source-registry"]),
      rbac_authorization: expect.objectContaining({
        action: "api_tool_prepare",
        matched_roles: [],
        required_roles: ["dojo:api-tool:prepare", "dojo:source:review", "source-registry"],
      }),
    }));

    const prepared = await dispatchDojoTool("synthi_dojo_prepare_api_backed_tool", {
      ...apiToolPreparationArgs,
      ...productionApiToolPreparerContextArgs({
        request_id: "req-api-tool-prepare-rbac-approved",
        correlation_id: "corr-api-tool-prepare-rbac-approved",
      }),
    });
    expect(prepared?.isError).toBeUndefined();
    expect(prepared?.structuredContent).toEqual(expect.objectContaining({
      ready_for_promotion: true,
      rbac_authorization: expect.objectContaining({
        action: "api_tool_prepare",
        matched_roles: ["dojo:api-tool:prepare"],
      }),
      api_tool_publication: expect.objectContaining({
        requested: false,
        status: "not_requested",
      }),
    }));

    const blockedPublish = await dispatchDojoTool("synthi_dojo_prepare_api_backed_tool", {
      ...apiToolPreparationArgs,
      publish_to_skill: true,
      reviewer_actor_id: "api-tool-reviewer",
      reviewer_actor_type: "human",
      review_reason: "Reviewed production API-backed tool contract.",
      review_evidence_refs: ["api-review:evidence-production-rbac"],
      reviewed_at: "2026-06-17T04:00:30.000Z",
      ...productionApiToolPreparerContextArgs({
        request_id: "req-api-tool-publish-rbac-blocked",
        correlation_id: "corr-api-tool-publish-rbac-blocked",
      }),
    });
    expect(blockedPublish?.isError).toBeUndefined();
    expect(blockedPublish?.structuredContent).toEqual(expect.objectContaining({
      ready_for_promotion: false,
      promotion_blockers: expect.arrayContaining([
        "api_tool_publication_review:api_tool_publication_review_governance_role_required:dojo:api-tool:publish|dojo:source:apply",
      ]),
      api_tool_publication_review: expect.objectContaining({
        requested: true,
        ok: false,
        rbac_authorization: expect.objectContaining({
          action: "api_tool_publish",
          matched_roles: [],
          required_roles: ["dojo:api-tool:publish", "dojo:source:apply"],
        }),
      }),
      api_tool_publication: expect.objectContaining({
        requested: true,
        ok: false,
        status: "blocked",
      }),
    }));

    const published = await dispatchDojoTool("synthi_dojo_prepare_api_backed_tool", {
      ...apiToolPreparationArgs,
      publish_to_skill: true,
      reviewer_actor_id: "api-tool-reviewer",
      reviewer_actor_type: "human",
      review_reason: "Reviewed production API-backed tool contract.",
      review_evidence_refs: ["api-review:evidence-production-rbac"],
      reviewed_at: "2026-06-17T04:01:30.000Z",
      now: "2026-06-17T04:02:00.000Z",
      ...productionApiToolPublisherContextArgs({
        request_id: "req-api-tool-publish-rbac-approved",
        correlation_id: "corr-api-tool-publish-rbac-approved",
      }),
    });
    expect(published?.isError).toBeUndefined();
    expect(published?.structuredContent).toEqual(expect.objectContaining({
      ready_for_promotion: true,
      promotion_blockers: [],
      rbac_authorization: expect.objectContaining({
        action: "api_tool_prepare",
        matched_roles: ["dojo:api-tool:prepare"],
      }),
      api_tool_publication_review: expect.objectContaining({
        requested: true,
        ok: true,
        rbac_authorization: expect.objectContaining({
          action: "api_tool_publish",
          matched_roles: ["dojo:api-tool:publish"],
        }),
      }),
      api_tool_publication: expect.objectContaining({
        requested: true,
        ok: true,
        status: "published",
        published_tool_name: "synthi_api_save_invoice",
      }),
      mcp_skill_manifest: expect.objectContaining({
        tool: expect.objectContaining({
          name: "synthi_api_save_invoice",
          kind: "api_backed",
        }),
      }),
    }));
  });

  it("runs a published API-backed MCP tool by tool name through skill-bus dispatch", async () => {
    recordOpenDetailsWorkflowForDojoToolTest();
    const publish = await dispatchDojoTool("synthi_dojo_publish_skill", publishArgsForDojoToolTest());
    expect(publish?.isError).toBeUndefined();
    const skillId = (publish?.structuredContent as { skill: { skill_id: string } }).skill.skill_id;
    const publishedSkill = dojoSkillRegistry.get(skillId) as DojoSkill;

    const prepared = await dispatchDojoTool("synthi_dojo_prepare_api_backed_tool", {
      skill_id: publishedSkill.skill_id,
      network_trace: {
        method: "POST",
        url: "https://app.example.test/api/invoices?workspace=workspace-a",
        request_body: { client_id: "client-a", amount: 42 },
        response_body: { invoice: { status: "saved" } },
        source_ref: "trace:save-invoice-api",
      },
      candidate_overrides: {
        auth_scope: "invoice:write",
        idempotency_key_location: "header",
        rollback_strategy: "compensating_call",
        postcondition: "invoice.status == 'saved'",
        proof_claim_mapping: {
          checkride_passed: "dojo.checkride",
          workspace_verified: "tenant.workspace_id",
        },
        review_status: "approved",
      },
      requested_action: "run_workflow",
      tool_name: "synthi_api_save_invoice",
      auth_scopes: ["invoice:write"],
      publish_to_skill: true,
      reviewer_actor_id: "api-reviewer-b",
      reviewer_actor_type: "human",
      review_reason: "Reviewed API-backed tool before skill-bus publication.",
      review_evidence_refs: ["api-review:evidence-skill-bus"],
      reviewed_at: "2026-06-17T03:09:30.000Z",
      now: "2026-06-17T03:10:00.000Z",
      sample_invocation_args: {
        proof_capsule: {
          capsule_id: "capsule-api-tool-name-sample",
          nonce: "nonce-api-tool-name-sample",
          skill_id: publishedSkill.skill_id,
          license_id: publishedSkill.permission_license.license_id,
          license_version: publishedSkill.permission_license.license_version,
          requested_action: "run_workflow",
          evidence_record_ids: ["evidence-workspace", "evidence-checkride"],
          ledger_checkpoint_hash: "sha256:checkpoint-api-tool-name-sample",
          evidence_claims: [
            { claim: "workspace_verified", satisfied: true, evidence_refs: ["evidence-workspace"] },
            { claim: "checkride_passed", satisfied: true, evidence_refs: ["evidence-checkride"] },
          ],
        },
        request: { client_id: "client-a", amount: 42 },
        query: { workspace: "workspace-a" },
        idempotency_key: "idem-api-tool-name-sample",
      },
    });
    expect(prepared?.isError).toBeUndefined();
    const updatedSkill = dojoSkillRegistry.get(skillId) as DojoSkill;
    expect(updatedSkill.api_backed_mcp_tools?.[0]).toEqual(expect.objectContaining({
      tool_name: "synthi_api_save_invoice",
      tool_version: "1.0.0",
    }));

    const tenantContext = productionTenantContextArgs({
      workspace_id: "workspace-a",
      request_id: "req-api-backed-tool-name",
      correlation_id: "corr-api-backed-tool-name",
    });
    const proofIssue = await dispatchDojoTool("synthi_dojo_issue_proof_capsule", {
      ...tenantContext,
      skill_id: skillId,
      requested_action: "run_workflow",
      context_claims: { workspace_verified: true },
      evidence_ledger_records: evidenceLedgerRecordsForProof(updatedSkill, { tenant_id: "tenant-a" }),
      require_verified_evidence: true,
      substrate_claim: "api",
      now: "2026-06-17T03:11:00.000Z",
      expires_at: "2026-06-17T03:26:00.000Z",
    });
    expect(proofIssue?.isError).toBeUndefined();
    const proofCapsule = (proofIssue?.structuredContent as {
      proof_capsule: DojoProofCarryingSkillCapsule;
    }).proof_capsule;
    const toolArgs = {
      proof_capsule: proofCapsule,
      request: { client_id: "client-a", amount: 42 },
      query: { workspace: "workspace-a" },
      idempotency_key: "idem-api-tool-name-run",
    };

    const dryRun = await dispatchDojoTool("synthi_dojo_run_api_backed_tool", {
      ...tenantContext,
      tool_name: "synthi_api_save_invoice",
      tool_version: "1.0.0",
      tool_args: toolArgs,
      auth_scopes: ["invoice:write"],
      dry_run: true,
      now: "2026-06-17T03:12:00.000Z",
    });
    expect(dryRun?.isError).toBeUndefined();
    expect(dryRun?.structuredContent).toEqual(expect.objectContaining({
      ok: true,
      dry_run: true,
      tool_name: "synthi_api_save_invoice",
      tool_version: "1.0.0",
      api_backed_mcp_tool: expect.objectContaining({
        tool_name: "synthi_api_save_invoice",
        schema_digest: expect.stringMatching(/^sha256:/),
      }),
      mcp_skill_bus_resolution: expect.objectContaining({
        ok: true,
        status: "resolved",
        tool_name: "synthi_api_save_invoice",
        tool_version: "1.0.0",
        resolved_tool: expect.objectContaining({ kind: "api_backed" }),
        mcp_skill_manifest: expect.objectContaining({
          tool: expect.objectContaining({ kind: "api_backed" }),
        }),
      }),
      mcp_skill_bus_preflight: expect.objectContaining({
        ok: true,
        status: "allowed",
        dry_run: true,
        blocked_by: [],
        tool_name: "synthi_api_save_invoice",
        validation: expect.objectContaining({ ok: true, status: "allowed" }),
        resolution: expect.objectContaining({
          resolved_tool: expect.objectContaining({ kind: "api_backed" }),
        }),
      }),
      proof_consume: null,
      blocked_by: [],
    }));
    expect(dojoSkillRegistry.getProofRecord(proofCapsule.capsule_id)).toEqual(expect.objectContaining({
      status: "issued",
    }));

    const executed = await dispatchDojoTool("synthi_dojo_run_api_backed_tool", {
      ...tenantContext,
      tool_name: "synthi_api_save_invoice",
      tool_version: "1.0.0",
      tool_args: toolArgs,
      auth_scopes: ["invoice:write"],
      dry_run: false,
      run_id: "api-backed-tool-name-run",
      now: "2026-06-17T03:12:00.000Z",
      mock_response: {
        status: 201,
        body: { invoice: { status: "saved" } },
      },
    });
    expect(executed?.isError).toBeUndefined();
    expect(executed?.structuredContent).toEqual(expect.objectContaining({
      ok: true,
      dry_run: false,
      tool_name: "synthi_api_save_invoice",
      mcp_skill_bus_resolution: expect.objectContaining({
        resolved_tool: expect.objectContaining({ kind: "api_backed" }),
      }),
      mcp_skill_bus_preflight: expect.objectContaining({
        ok: true,
        status: "allowed",
        dry_run: true,
        blocked_by: [],
        validation: expect.objectContaining({ ok: true, status: "allowed" }),
      }),
      mcp_skill_bus_dispatch: expect.objectContaining({
        ok: true,
        status: "allowed",
        dry_run: false,
        blocked_by: [],
        tool_name: "synthi_api_save_invoice",
        validation: expect.objectContaining({ ok: true, status: "allowed" }),
        resolution: expect.objectContaining({
          resolved_tool: expect.objectContaining({ kind: "api_backed" }),
        }),
        result: expect.objectContaining({
          proof_consume: expect.objectContaining({ ok: true, status: "used" }),
          api_tool_execution: expect.objectContaining({
            ok: true,
            status: "executed",
          }),
        }),
      }),
      proof_consume: expect.objectContaining({ ok: true, status: "used" }),
      api_tool_execution: expect.objectContaining({
        ok: true,
        status: "executed",
        postcondition: expect.objectContaining({ ok: true }),
      }),
      blocked_by: [],
    }));
  });

  it("blocks production API-backed MCP tool execution with caller-supplied mock responses before consuming proof", async () => {
    recordOpenDetailsWorkflowForDojoToolTest();
    const publish = await dispatchDojoTool("synthi_dojo_publish_skill", publishArgsForDojoToolTest());
    expect(publish?.isError).toBeUndefined();
    const skillId = (publish?.structuredContent as { skill: { skill_id: string } }).skill.skill_id;
    const publishedSkill = dojoSkillRegistry.get(skillId) as DojoSkill;

    const prepared = await dispatchDojoTool("synthi_dojo_prepare_api_backed_tool", {
      skill_id: publishedSkill.skill_id,
      network_trace: {
        method: "POST",
        url: "https://app.example.test/api/invoices?workspace=workspace-a",
        request_body: { client_id: "client-a", amount: 42 },
        response_body: { invoice: { status: "saved" } },
        source_ref: "trace:production-mock-response-block",
      },
      candidate_overrides: {
        auth_scope: "invoice:write",
        idempotency_key_location: "header",
        rollback_strategy: "compensating_call",
        postcondition: "invoice.status == 'saved'",
        proof_claim_mapping: {
          workspace_verified: "tenant.workspace_id",
          checkride_passed: "dojo.checkride",
        },
        review_status: "approved",
      },
      requested_action: "run_workflow",
      tool_name: "synthi_api_save_invoice",
      auth_scopes: ["invoice:write"],
      publish_to_skill: true,
      reviewer_actor_id: "api-tool-reviewer",
      reviewer_actor_type: "human",
      review_reason: "Reviewed API-backed tool before production mock-response block coverage.",
      review_evidence_refs: ["api-review:production-mock-response-block"],
      reviewed_at: "2026-06-17T03:20:30.000Z",
    });
    expect(prepared?.isError).toBeUndefined();
    const updatedSkill = dojoSkillRegistry.get(skillId) as DojoSkill;
    const tenantContext = productionTenantContextArgs({
      workspace_id: "workspace-a",
      request_id: "req-api-backed-mock-production-block",
      correlation_id: "corr-api-backed-mock-production-block",
    });
    const proofIssue = await dispatchDojoTool("synthi_dojo_issue_proof_capsule", {
      ...tenantContext,
      skill_id: skillId,
      requested_action: "run_workflow",
      context_claims: { workspace_verified: true },
      evidence_ledger_records: evidenceLedgerRecordsForProof(updatedSkill, { tenant_id: "tenant-a" }),
      require_verified_evidence: true,
      substrate_claim: "api",
      now: "2026-06-17T03:20:00.000Z",
      expires_at: "2026-06-17T03:35:00.000Z",
    });
    expect(proofIssue?.isError).toBeUndefined();
    const proofCapsule = (proofIssue?.structuredContent as {
      proof_capsule: DojoProofCarryingSkillCapsule;
    }).proof_capsule;

    process.env.SYNTHI_DOJO_PRODUCTION_ENFORCEMENT = "1";
    const blocked = await dispatchDojoTool("synthi_dojo_run_api_backed_tool", {
      ...tenantContext,
      tool_name: "synthi_api_save_invoice",
      tool_version: "1.0.0",
      tool_args: {
        proof_capsule: proofCapsule,
        request: { client_id: "client-a", amount: 42 },
        query: { workspace: "workspace-a" },
        idempotency_key: "idem-api-production-mock-block",
      },
      auth_scopes: ["invoice:write"],
      dry_run: false,
      run_id: "api-backed-production-mock-block",
      now: "2026-06-17T03:21:00.000Z",
      mock_response: {
        status: 201,
        body: { invoice: { status: "saved" } },
      },
    });

    expect(blocked?.isError).toBe(true);
    expect(blocked?.structuredContent).toEqual(expect.objectContaining({
      ok: false,
      error: "api_tool_mock_response_forbidden_in_production",
      dry_run: false,
      run_id: "api-backed-production-mock-block",
      proof_consume: null,
      api_tool_execution: null,
      api_tool_execution_evidence: [],
      blocked_by: ["api_tool_mock_response_forbidden_in_production"],
      error_codes: ["dojo_execution_policy_blocked"],
    }));
    const proofRecord = dojoSkillRegistry.getProofRecord(proofCapsule.capsule_id);
    expect(proofRecord).toEqual(expect.objectContaining({ status: "issued" }));
    expect(proofRecord).not.toHaveProperty("used_at");
    expect(proofRecord).not.toHaveProperty("first_used_at");
  });

  it("runs a compiled API-backed MCP tool with proof validation, postcondition, and evidence", async () => {
    recordOpenDetailsWorkflowForDojoToolTest();
    const publish = await dispatchDojoTool("synthi_dojo_publish_skill", publishArgsForDojoToolTest());
    expect(publish?.isError).toBeUndefined();
    const skillId = (publish?.structuredContent as { skill: { skill_id: string } }).skill.skill_id;
    const publishedSkill = dojoSkillRegistry.get(skillId) as DojoSkill;
    const proofIssue = await dispatchDojoTool("synthi_dojo_issue_proof_capsule", {
      skill_id: skillId,
      requested_action: "run_workflow",
      context_claims: { workspace_verified: true },
      evidence_ledger_records: evidenceLedgerRecordsForProof(publishedSkill),
      require_verified_evidence: true,
      substrate_claim: "api",
      now: "2026-06-17T02:00:00.000Z",
      expires_at: "2026-06-17T02:15:00.000Z",
    });
    expect(proofIssue?.isError).toBeUndefined();
    const proofCapsule = (proofIssue?.structuredContent as {
      proof_capsule: DojoProofCarryingSkillCapsule;
    }).proof_capsule;
    expect(proofCapsule).toEqual(expect.objectContaining({
      license_id: publishedSkill.permission_license.license_id,
      substrate_claim: "api",
    }));

    const prepared = await dispatchDojoTool("synthi_dojo_prepare_api_backed_tool", {
      skill_id: publishedSkill.skill_id,
      network_trace: {
        method: "POST",
        url: "https://app.example.test/api/invoices?workspace=workspace-a",
        request_body: { client_id: "client-a", amount: 42 },
        response_body: { invoice: { status: "saved" } },
        source_ref: "trace:save-invoice-api",
      },
      candidate_overrides: {
        auth_scope: "invoice:write",
        idempotency_key_location: "header",
        rollback_strategy: "compensating_call",
        postcondition: "invoice.status == 'saved'",
        proof_claim_mapping: {
          checkride_passed: "dojo.checkride",
          workspace_verified: "tenant.workspace_id",
        },
        review_status: "approved",
      },
      requested_action: "run_workflow",
      tool_name: "synthi_api_save_invoice",
      sample_invocation_args: {
        proof_capsule: proofCapsule,
        request: { client_id: "client-a", amount: 42 },
        query: { workspace: "workspace-a" },
        idempotency_key: "idem-api-run-a",
      },
      auth_scopes: ["invoice:write"],
    });
    expect(prepared?.isError).toBeUndefined();
    const apiTool = (prepared?.structuredContent as { api_backed_mcp_tool: unknown }).api_backed_mcp_tool;
    const toolArgs = {
      proof_capsule: proofCapsule,
      request: { client_id: "client-a", amount: 42 },
      query: { workspace: "workspace-a" },
      idempotency_key: "idem-api-run-a",
    };

    const dryRun = await dispatchDojoTool("synthi_dojo_run_api_backed_tool", {
      api_backed_mcp_tool: apiTool,
      tool_args: toolArgs,
      auth_scopes: ["invoice:write"],
      now: "2026-06-17T02:01:00.000Z",
    });
    expect(dryRun?.isError).toBeUndefined();
    expect(dryRun?.structuredContent).toEqual(expect.objectContaining({
      ok: true,
      implementation_status: "executable",
      runtime_enforced: true,
      dry_run: true,
      skill_id: publishedSkill.skill_id,
      run_id: expect.stringMatching(/^dojo_api_run_/),
      api_tool_invocation_validation: { ok: true, blocked_by: [] },
      proof_validation: { ok: true, blocked_by: [] },
      license_kernel: expect.objectContaining({
        ok: true,
        status: "allowed",
        proof_record: expect.objectContaining({
          status: "issued",
          capsule_id: proofCapsule.capsule_id,
        }),
      }),
      proof_consume: null,
      api_tool_execution: null,
      api_tool_execution_evidence: [],
      blocked_by: [],
    }));
    expect(dojoSkillRegistry.getProofRecord(proofCapsule.capsule_id)).toEqual(expect.objectContaining({
      status: "issued",
    }));

    const executed = await dispatchDojoTool("synthi_dojo_run_api_backed_tool", {
      api_backed_mcp_tool: apiTool,
      tool_args: toolArgs,
      auth_scopes: ["invoice:write"],
      dry_run: false,
      run_id: "api-backed-run-a",
      now: "2026-06-17T02:01:00.000Z",
      mock_response: {
        status: 201,
        body: { invoice: { status: "saved" } },
      },
    });
    expect(executed?.isError).toBeUndefined();
    expect(executed?.structuredContent).toEqual(expect.objectContaining({
      ok: true,
      dry_run: false,
      transport_mode: "mock",
      proof_consume: expect.objectContaining({
        ok: true,
        status: "used",
        record: expect.objectContaining({
          capsule_id: proofCapsule.capsule_id,
          status: "used",
          first_used_at: "2026-06-17T02:01:00.000Z",
          last_validated_at: "2026-06-17T02:01:00.000Z",
        }),
      }),
      license_kernel: expect.objectContaining({
        ok: true,
        proof_record: expect.objectContaining({
          capsule_id: proofCapsule.capsule_id,
          status: "used",
        }),
      }),
      api_tool_execution: expect.objectContaining({
        ok: true,
        status: "executed",
        blocked_by: [],
        request: expect.objectContaining({
          method: "POST",
          path: "/api/invoices",
          headers: { "Idempotency-Key": "idem-api-run-a" },
          query: { workspace: "workspace-a" },
          body: { client_id: "client-a", amount: 42 },
        }),
        response: { status: 201, body: { invoice: { status: "saved" } } },
        postcondition: expect.objectContaining({
          ok: true,
          predicate: "invoice.status == 'saved'",
          actual: "saved",
        }),
        evidence_record_id: expect.stringMatching(/^evidence:api_tool_/),
      }),
      api_tool_execution_evidence: [
        expect.objectContaining({
          schema_version: "synthi.dojo.apiToolExecutionEvidence.v1",
          tool_name: "synthi_api_save_invoice",
          proof_capsule_id: proofCapsule.capsule_id,
          postcondition_ok: true,
          blocked_by: [],
        }),
      ],
      blocked_by: [],
    }));
    expect(dojoSkillRegistry.getProofRecord(proofCapsule.capsule_id)).toEqual(expect.objectContaining({
      status: "used",
      first_used_at: "2026-06-17T02:01:00.000Z",
      last_validated_at: "2026-06-17T02:01:00.000Z",
    }));

    const replay = await dispatchDojoTool("synthi_dojo_run_api_backed_tool", {
      api_backed_mcp_tool: apiTool,
      tool_args: toolArgs,
      auth_scopes: ["invoice:write"],
      dry_run: false,
      run_id: "api-backed-run-replay",
      now: "2026-06-17T02:02:00.000Z",
      mock_response: {
        status: 201,
        body: { invoice: { status: "saved" } },
      },
    });
    expect(replay?.isError).toBe(true);
    expect(replay?.structuredContent).toEqual(expect.objectContaining({
      ok: false,
      dry_run: false,
      run_id: "api-backed-run-replay",
      proof_consume: null,
      blocked_by: expect.arrayContaining(["proof_capsule_replay_detected"]),
      license_kernel: expect.objectContaining({
        ok: false,
        proof_record: expect.objectContaining({
          capsule_id: proofCapsule.capsule_id,
          status: "used",
          first_used_at: "2026-06-17T02:01:00.000Z",
        }),
      }),
    }));
  });

  it("blocks direct compiled API-backed tool execution in production until it is published through the skill bus", async () => {
    recordOpenDetailsWorkflowForDojoToolTest();
    const publish = await dispatchDojoTool("synthi_dojo_publish_skill", publishArgsForDojoToolTest());
    expect(publish?.isError).toBeUndefined();
    const skillId = (publish?.structuredContent as { skill: { skill_id: string } }).skill.skill_id;
    const publishedSkill = dojoSkillRegistry.get(skillId) as DojoSkill;
    const proofIssue = await dispatchDojoTool("synthi_dojo_issue_proof_capsule", {
      skill_id: skillId,
      requested_action: "run_workflow",
      context_claims: { workspace_verified: true },
      evidence_ledger_records: evidenceLedgerRecordsForProof(publishedSkill),
      require_verified_evidence: true,
      substrate_claim: "api",
      now: "2026-06-17T02:30:00.000Z",
      expires_at: "2026-06-17T02:45:00.000Z",
    });
    expect(proofIssue?.isError).toBeUndefined();
    const proofCapsule = (proofIssue?.structuredContent as {
      proof_capsule: DojoProofCarryingSkillCapsule;
    }).proof_capsule;
    const prepared = await dispatchDojoTool("synthi_dojo_prepare_api_backed_tool", {
      skill_id: publishedSkill.skill_id,
      network_trace: {
        method: "POST",
        url: "https://app.example.test/api/invoices?workspace=workspace-a",
        request_body: { client_id: "client-a", amount: 42 },
        response_body: { invoice: { status: "saved" } },
        source_ref: "trace:save-invoice-api",
      },
      candidate_overrides: {
        auth_scope: "invoice:write",
        idempotency_key_location: "header",
        rollback_strategy: "compensating_call",
        postcondition: "invoice.status == 'saved'",
        proof_claim_mapping: {
          checkride_passed: "dojo.checkride",
          workspace_verified: "tenant.workspace_id",
        },
        review_status: "approved",
      },
      requested_action: "run_workflow",
      tool_name: "synthi_api_save_invoice",
      auth_scopes: ["invoice:write"],
    });
    expect(prepared?.isError).toBeUndefined();
    const apiTool = (prepared?.structuredContent as { api_backed_mcp_tool: unknown }).api_backed_mcp_tool;

    process.env.SYNTHI_DOJO_PRODUCTION_ENFORCEMENT = "1";
    const blocked = await dispatchDojoTool("synthi_dojo_run_api_backed_tool", {
      ...productionTenantContextArgs({
        workspace_id: "workspace-a",
        request_id: "req-api-backed-direct-production-block",
        correlation_id: "corr-api-backed-direct-production-block",
      }),
      api_backed_mcp_tool: apiTool,
      tool_args: {
        proof_capsule: proofCapsule,
        request: { client_id: "client-a", amount: 42 },
        query: { workspace: "workspace-a" },
        idempotency_key: "idem-api-production-direct-block",
      },
      auth_scopes: ["invoice:write"],
      dry_run: false,
      run_id: "api-backed-production-direct-block",
      now: "2026-06-17T02:31:00.000Z",
      mock_response: {
        status: 201,
        body: { invoice: { status: "saved" } },
      },
    });
    expect(blocked?.isError).toBe(true);
    expect(blocked?.structuredContent).toEqual(expect.objectContaining({
      ok: false,
      error: "dojo_api_backed_tool_skill_bus_publication_required",
      dry_run: false,
      run_id: "api-backed-production-direct-block",
      required_path: expect.stringContaining("execute by tool_name through the MCP Skill Bus"),
      blocked_by: ["api_backed_compiled_tool_requires_skill_bus_publication"],
      error_codes: ["api_backed_compiled_tool_requires_skill_bus_publication"],
    }));
    expect(dojoSkillRegistry.getProofRecord(proofCapsule.capsule_id)).toEqual(expect.objectContaining({
      status: "issued",
    }));
  });

  it("keeps API-backed tool preparation blocked until endpoint review gates pass", async () => {
    recordOpenDetailsWorkflowForDojoToolTest();
    const publish = await dispatchDojoTool("synthi_dojo_publish_skill", publishArgsForDojoToolTest());
    expect(publish?.isError).toBeUndefined();
    const skillId = (publish?.structuredContent as { skill: { skill_id: string } }).skill.skill_id;

    const prepared = await dispatchDojoTool("synthi_dojo_prepare_api_backed_tool", {
      skill_id: skillId,
      network_trace: {
        method: "POST",
        url: "https://app.example.test/api/invoices",
        request_body: { amount: 42 },
        response_body: { status: "saved" },
      },
    });

    expect(prepared?.isError).toBeUndefined();
    expect(prepared?.structuredContent).toEqual(expect.objectContaining({
      ok: true,
      skill_id: skillId,
      candidate_source: "network_trace",
      api_endpoint_candidate: expect.objectContaining({
        review_status: "candidate",
        method: "POST",
        path: "/api/invoices",
      }),
      candidate_review: expect.objectContaining({
        ok_to_promote: false,
        issues: expect.arrayContaining([
          expect.objectContaining({ issue_id: "api_candidate_review_approval_required" }),
          expect.objectContaining({ issue_id: "api_candidate_auth_scope_required" }),
          expect.objectContaining({ issue_id: "api_candidate_idempotency_required" }),
          expect.objectContaining({ issue_id: "api_candidate_rollback_required" }),
          expect.objectContaining({ issue_id: "api_candidate_postcondition_required" }),
          expect.objectContaining({ issue_id: "api_candidate_proof_claim_mapping_required" }),
        ]),
      }),
      api_tool_compile: expect.objectContaining({
        ok: false,
        issues: expect.arrayContaining([
          expect.objectContaining({ issue_id: "api_candidate_review_approval_required" }),
        ]),
      }),
      api_backed_mcp_tool: null,
      sample_invocation_validation: null,
      ready_for_promotion: false,
      promotion_blockers: expect.arrayContaining([
        "api_candidate_review:api_candidate_review_approval_required",
        "api_tool_compile:api_candidate_review_approval_required",
      ]),
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
    expect((scenarios?.structuredContent as { organoid: { scenarios: unknown[] } }).organoid.scenarios).toHaveLength(21);

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
        scenario_count: 21,
        failed_scenarios: 0,
        critical_failures: 0,
        production_recommendation: "constrained",
        graph_id: expect.stringContaining("graph_dojo_open_details"),
        evidence_refs: expect.arrayContaining([expect.stringMatching(/^evidence:evidence_oracle_/)]),
        results: expect.arrayContaining([
          expect.objectContaining({
            mutation_kind: "duplicate_entity",
            status: "blocked",
            graph_status: "blocked",
          }),
          expect.objectContaining({
            mutation_kind: "fake_success",
            status: "passed",
            graph_status: "completed",
          }),
          expect.objectContaining({
            mutation_kind: "partial_write",
            status: "passed",
            graph_status: "completed",
          }),
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
    const publication = (publish?.structuredContent as {
      publication: {
        executable_checkride: {
          license_constraints: Array<{ constraint_kind: string; mutation_kind: string }>;
          production_recommendation: string;
          failed_scenarios: number;
          critical_failures: number;
        };
        entrustment_decision: { level: string; production_recommendation: string };
        readiness_decision: { level: number };
      };
    }).publication;
    expect(publication.executable_checkride).toEqual(expect.objectContaining({
      production_recommendation: "constrained",
      failed_scenarios: 0,
      critical_failures: 0,
    }));
    expect(publication.entrustment_decision).toEqual(expect.objectContaining({
      level: "E3",
      production_recommendation: "constrained",
    }));
    expect(publication.readiness_decision).toEqual(expect.objectContaining({ level: 5 }));
    expect(publishedSkill).toEqual(expect.objectContaining({
      entrustment_level: "E3",
      skill_readiness_level: 5,
      executable_entrustment: expect.objectContaining({
        schema_version: "synthi.dojo.executableEntrustmentSnapshot.v1",
        source: "publish",
        checkride_id: expect.any(String),
        scenario_count: expect.any(Number),
        production_recommendation: "constrained",
        entrustment_decision: expect.objectContaining({
          level: "E3",
          production_recommendation: "constrained",
          evidence_refs: expect.any(Array),
        }),
        readiness_decision: expect.objectContaining({
          level: 5,
          blocked_by: expect.any(Array),
          next_required: expect.any(Array),
        }),
      }),
      permission_license: expect.objectContaining({
        entrustment_level: "E3",
        autonomy_level: "submit_limited",
      }),
    }));
    const runWorkflowAction = publishedSkill!.permission_license.allowed_actions.find((action) => action.action === "run_workflow");
    expect(runWorkflowAction).toBeTruthy();
    expect(publication.executable_checkride.license_constraints.length).toBeGreaterThan(0);
    expect(runWorkflowAction?.constraints).toContain("executable_checkride_constrained");
    for (const constraint of publication.executable_checkride.license_constraints) {
      expect(runWorkflowAction?.constraints).toContain(`${constraint.constraint_kind}:${constraint.mutation_kind}`);
    }
    const exportedSkillArtifact = exportDojoRepoArtifacts(publishedSkill!)
      .find((artifact) => artifact.path.endsWith("/skill.json"));
    expect(exportedSkillArtifact).toBeTruthy();
    expect(JSON.parse(exportedSkillArtifact!.content)).toEqual(expect.objectContaining({
      executable_entrustment: expect.objectContaining({
        schema_version: "synthi.dojo.executableEntrustmentSnapshot.v1",
        source: "publish",
        checkride_id: publication.executable_checkride.checkride_id,
      }),
    }));
    const entrustment = await dispatchDojoTool("synthi_dojo_get_entrustment_level", {
      skill_id: published.skill.skill_id,
      workspace_id: "workspace-a",
    });
    expect(entrustment?.structuredContent).toEqual(expect.objectContaining({
      ok: true,
      skill_id: published.skill.skill_id,
      entrustment_level: "E3",
      skill_readiness_level: 5,
      entrustment_source: "executable_checkride",
      executable_entrustment: expect.objectContaining({
        schema_version: "synthi.dojo.executableEntrustmentSnapshot.v1",
        source: "publish",
        checkride_id: publication.executable_checkride.checkride_id,
        production_recommendation: "constrained",
      }),
      license_scope: expect.objectContaining({
        allowed_actions: expect.arrayContaining([
          expect.objectContaining({
            action: "run_workflow",
            constraints: expect.arrayContaining(["executable_checkride_constrained"]),
          }),
        ]),
      }),
      evidence_refs: expect.any(Array),
    }));
    const entrustmentContent = entrustment?.structuredContent as {
      executable_entrustment: { evidence_refs: string[] };
      evidence_refs: string[];
    };
    expect(entrustmentContent.executable_entrustment.evidence_refs.length).toBeGreaterThan(0);
    expect(entrustmentContent.evidence_refs.length).toBeGreaterThan(0);
    const assurance = await dispatchDojoTool("synthi_dojo_get_skill_assurance_case", {
      skill_id: published.skill.skill_id,
      workspace_id: "workspace-a",
    });
    expect(assurance?.structuredContent).toEqual(expect.objectContaining({
      ok: true,
      skill_id: published.skill.skill_id,
      assurance_case: expect.objectContaining({
        assurance_case_id: publishedSkill!.assurance_case.assurance_case_id,
      }),
      assurance_artifact: expect.objectContaining({
        schema_version: "synthi.dojo.skillAssuranceArtifact.v1",
        entrustment_source: "executable_checkride",
        executable_entrustment: expect.objectContaining({
          schema_version: "synthi.dojo.executableEntrustmentSnapshot.v1",
          source: "publish",
          checkride_id: publication.executable_checkride.checkride_id,
          evidence_refs: expect.any(Array),
        }),
        license_scope: expect.objectContaining({
          allowed_actions: publishedSkill!.permission_license.allowed_actions,
          gated_actions: publishedSkill!.permission_license.gated_actions,
          blocked_actions: publishedSkill!.permission_license.blocked_actions,
        }),
        evidence_refs: expect.any(Array),
        ledger_checkpoint_hashes: expect.any(Array),
      }),
      entrustment_source: "executable_checkride",
      executable_entrustment: expect.objectContaining({
        checkride_id: publication.executable_checkride.checkride_id,
      }),
      evidence_refs: expect.any(Array),
    }));
    const assuranceContent = assurance?.structuredContent as {
      assurance_artifact: {
        executable_entrustment: { evidence_refs: string[] };
        evidence_refs: string[];
      };
    };
    expect(assuranceContent.assurance_artifact.executable_entrustment.evidence_refs.length).toBeGreaterThan(0);
    expect(assuranceContent.assurance_artifact.evidence_refs.length).toBeGreaterThan(0);
    expect(publishedSkill!.permission_license.approval_requirements).not.toContain("run_workflow");
    expect(publishedSkill!.permission_license.gated_actions).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ action: "run_workflow" })])
    );
    const graphRuntimeClaims = runtimeClaimsForSkillGuardrails(publishedSkill!);
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
      context_claims: { workspace_verified: true, ...graphRuntimeClaims },
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
      context_claims: { workspace_verified: true, ...graphRuntimeClaims },
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
      context_claims: { workspace_verified: true, ...graphRuntimeClaims },
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
        evidence_ledger: expect.objectContaining({
          schema_version: "synthi.dojo.evidenceLedger.v1",
          retention_policy: expect.objectContaining({
            append_only_records_preserved: true,
            legal_hold_blocks_artifact_disposal: true,
          }),
          retention_plan: expect.objectContaining({
            schema_version: "synthi.dojo.evidenceRetentionPlan.v1",
            record_count: expect.any(Number),
            decisions: expect.arrayContaining([
              expect.objectContaining({
                ledger_record_action: "preserve_append_only_record",
                artifact_action: expect.stringMatching(/^(retain|redact|purge)$/),
              }),
            ]),
          }),
        }),
      }),
    }));
    const universeWithPackageReadiness = await dispatchDojoTool("synthi_dojo_get_universe_dossier", {
      skill_id: published.skill.skill_id,
      package_readiness_evidence_path: "tmp/dojo-package-readiness/dojo-package-readiness.evidence.json",
      package_readiness_evidence: packageReadinessEvidenceForDojoToolTest({
        export_entry_paths: ["dist/index.js", "dist/index.d.ts"],
        script_referenced_paths: [
          "scripts/dojo-package-readiness-self-check.mjs",
          "scripts/dojo-release-gate-verify.mjs",
        ],
        npm_pack: {
          exit_code: 0,
          integrity_present: true,
          packed_file_count: 512,
          unpacked_size: 4096,
        },
      }),
    });
    expect(universeWithPackageReadiness?.structuredContent).toEqual(expect.objectContaining({
      universe_dossier: expect.objectContaining({
        package_readiness: expect.objectContaining({
          release_gate: expect.objectContaining({
            status: "ready",
            evidence_path: "tmp/dojo-package-readiness/dojo-package-readiness.evidence.json",
            packed_file_count: 512,
            export_entry_path_count: 2,
            release_harness_path_count: 2,
            gaps: [],
          }),
          enterprise: expect.arrayContaining([
            expect.objectContaining({
              package: "Dojo Package Readiness",
              status: "ready",
            }),
          ]),
        }),
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
      governance_report: expect.objectContaining({
        schema_version: "synthi.dojo.governanceReport.v1",
        scheduled_jobs: expect.arrayContaining([
          expect.objectContaining({ kind: "recompute_registry_metrics", status: "ready" }),
        ]),
      }),
      governance_service: expect.objectContaining({
        schema_version: "synthi.dojo.governanceService.v1",
        policy_gates: expect.any(Array),
        recertification_queue: expect.any(Array),
        scheduled_jobs: expect.any(Array),
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
    const preUpgradeSkill = dojoSkillRegistry.get(published.skill.skill_id);
    expect(preUpgradeSkill?.permission_license.allowed_actions.map((action) => action.action)).not.toContain("commit_mutation");
    expect(preUpgradeSkill?.permission_license.gated_actions.map((action) => action.action)).not.toContain("commit_mutation");
    const reviewMissingPromotionPolicy = await dispatchDojoTool("synthi_dojo_review_permission_upgrade", {
      request_id: "upgrade-test-request",
      decision: "approved",
      reviewer_actor_id: "reviewer-b",
      reviewer_actor_type: "human",
      reason: "Generic review evidence should not promote scope.",
      evidence_refs: ["evidence:unit-review"],
      decided_at: "2026-06-11T00:04:00.000Z",
    });
    expect(reviewMissingPromotionPolicy?.isError).toBe(true);
    expect(reviewMissingPromotionPolicy?.structuredContent).toEqual(expect.objectContaining({
      error: "dojo_permission_upgrade_promotion_evidence_policy_failed",
      blocked_by: expect.arrayContaining([
        "promotion_evidence_claim_missing:checkride_passed",
        "promotion_evidence_claim_missing:evidence_fresh",
      ]),
      promotion_evidence_policy: expect.objectContaining({
        ok: false,
        required_claims: expect.arrayContaining(["checkride_passed", "evidence_fresh"]),
        verification_source: "caller_asserted",
        authoritative: false,
      }),
    }));
    const reviewedUpgrade = await dispatchDojoTool("synthi_dojo_review_permission_upgrade", {
      request_id: "upgrade-test-request",
      decision: "approved",
      reviewer_actor_id: "reviewer-b",
      reviewer_actor_type: "human",
      reason: "Unit test reviewed evidence.",
      evidence_refs: ["evidence:unit-review"],
      promotion_evidence_claims: ["checkride_passed", "evidence_fresh"],
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
      permission_upgrade_license_promotion: expect.objectContaining({
        ok: true,
        applied: true,
        status: "applied",
        requested_action: "commit_mutation",
        license_action_status: "gated",
        previous_license_version: preUpgradeSkill?.permission_license.license_version,
        approval_required: true,
        constraints: expect.arrayContaining([
          "permission_upgrade_approved",
          "permission_upgrade_request:upgrade-test-request",
          "required_step:rerun_checkride_for_requested_action",
          "promotion_claim:checkride_passed",
          "promotion_claim:evidence_fresh",
          "review_evidence:evidence:unit-review",
        ]),
        promotion_evidence_policy: expect.objectContaining({
          required_claims: expect.arrayContaining(["checkride_passed", "evidence_fresh"]),
        }),
      }),
      control_plane_persistence: expect.objectContaining({
        ok: true,
        store_kind: "compatibility_registry",
        license_promotion_status: "applied",
        requested_action: "commit_mutation",
        license_action_status: "gated",
      }),
      license: expect.objectContaining({
        license_id: preUpgradeSkill?.permission_license.license_id,
        gated_actions: expect.arrayContaining([
          expect.objectContaining({
            action: "commit_mutation",
            constraints: expect.arrayContaining([
              "permission_upgrade_approved",
              "permission_upgrade_request:upgrade-test-request",
              "promotion_claim:checkride_passed",
              "promotion_claim:evidence_fresh",
            ]),
          }),
        ]),
        approval_requirements: expect.arrayContaining(["commit_mutation"]),
      }),
      promotion_evidence_policy: expect.objectContaining({
        ok: true,
        required_claims: expect.arrayContaining(["checkride_passed", "evidence_fresh"]),
        verification_source: "caller_asserted",
        authoritative: false,
      }),
      review: expect.objectContaining({
        ok: true,
        audit_event: expect.objectContaining({ event_type: "approval_granted" }),
      }),
      governance_service: expect.objectContaining({
        approval_queue: expect.arrayContaining([
          expect.objectContaining({
            action: "commit_mutation",
            source: "license_gated_action",
            status: "pending",
          }),
          expect.objectContaining({
            action: "commit_mutation",
            source: "license_approval_requirement",
            status: "pending",
          }),
        ]),
      }),
    }));
    const upgradedSkill = dojoSkillRegistry.get(published.skill.skill_id);
    expect(upgradedSkill?.permission_license.license_version).not.toBe(preUpgradeSkill?.permission_license.license_version);
    expect(upgradedSkill?.permission_license.gated_actions).toEqual(expect.arrayContaining([
      expect.objectContaining({ action: "commit_mutation" }),
    ]));
    expect(upgradedSkill?.permission_license.blocked_actions.map((action) => action.action)).not.toContain("commit_mutation");
    expect(upgradedSkill?.skill_card.will_ask_before).toContain("commit_mutation");
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
    const evilTwin = await dispatchDojoTool("synthi_dojo_run_evil_twin", {
      skill_id: published.skill.skill_id,
      max_attacks: 2,
      harden: true,
      tenant_id: "tenant-vivarium",
      organization_id: "org-vivarium",
      workspace_id: "workspace-a",
      actor_id: "evil-twin-tester",
      actor_type: "agent",
      request_id: "evil-twin-tool-test",
      correlation_id: "evil-twin-tool-test-correlation",
    });
    expect(evilTwin?.structuredContent).toEqual(expect.objectContaining({
      implementation_status: "executable",
      runtime_enforced: true,
      runtime_scope: "synthetic_fixture_runtime",
      production_runtime: false,
      simulation_backing: "materialized_synthetic_fixture",
      evil_twin_runtime: expect.objectContaining({
        schema_version: "synthi.dojo.evilTwinRuntimeReport.v1",
        skill_id: published.skill.skill_id,
        attack_count: 2,
        attacks: expect.arrayContaining([
          expect.objectContaining({
            scenario_run: expect.objectContaining({
              schema_version: "synthi.dojo.scenarioRunResult.v1",
              observed_evidence: expect.arrayContaining(["graph_run_result", "graph_node_evidence", "oracle_result"]),
            }),
          }),
        ]),
      }),
      hardening: expect.objectContaining({
        schema_version: "synthi.dojo.evilTwinHardeningReport.v1",
      }),
      license_health: expect.objectContaining({ schema_version: "synthi.dojo.licenseHealth.v1" }),
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
      skill: expect.objectContaining({
        skill_id: published.skill.skill_id,
        executable_entrustment: expect.objectContaining({
          schema_version: "synthi.dojo.executableEntrustmentSnapshot.v1",
          source: "recertification",
          checkride_id: expect.any(String),
          entrustment_decision: expect.objectContaining({
            level: expect.any(String),
            production_recommendation: expect.any(String),
          }),
          readiness_decision: expect.objectContaining({
            level: expect.any(Number),
          }),
        }),
      }),
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
        executable_checkride: expect.objectContaining({
          schema_version: "synthi.dojo.executableCheckrideReport.v1",
          scenario_count: expect.any(Number),
          evidence_refs: expect.any(Array),
        }),
        entrustment_decision: expect.objectContaining({
          level: expect.any(String),
          production_recommendation: expect.any(String),
          evidence_refs: expect.any(Array),
        }),
        readiness_decision: expect.objectContaining({
          level: expect.any(Number),
          blocked_by: expect.any(Array),
          next_required: expect.any(Array),
        }),
      }),
      license: expect.objectContaining({
        allowed_actions: expect.arrayContaining([
          expect.objectContaining({
            action: "run_workflow",
            constraints: expect.arrayContaining(["executable_checkride_constrained"]),
          }),
        ]),
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
    const reviewedCaseGenericActorOnly = await dispatchDojoTool("synthi_dojo_review_case_law", {
      case_id: recordedCaseId,
      skill_id: published.skill.skill_id,
      decision: "approved",
      actor_id: "case-reviewer-a",
      actor_type: "human",
      evidence_refs: ["evidence:case-approval"],
      decided_at: "2026-06-11T00:04:45.000Z",
    });
    expect(reviewedCaseGenericActorOnly?.isError).toBe(true);
    expect(reviewedCaseGenericActorOnly?.structuredContent).toEqual(expect.objectContaining({
      error: "dojo_case_law_reviewer_required",
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
    const exportedAssuranceArtifact = exportedArtifacts.find((artifact) =>
      artifact.path === ".synthi/dojo/skills/open_details/assurance.case.md"
    );
    const exportedSkill = dojoSkillRegistry.get(published.skill.skill_id);
    expect(exportedAssuranceArtifact?.content).toContain("Artifact schema: synthi.dojo.skillAssuranceArtifact.v1");
    expect(exportedAssuranceArtifact?.content).toContain("## Executable Entrustment");
    expect(exportedAssuranceArtifact?.content).toContain(exportedSkill?.executable_entrustment?.checkride_id);
    expect(exportedAssuranceArtifact?.content).toContain("## Runtime Evidence");
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
            expect.objectContaining({ artifact_id: "executable_entrustment_provenance", status: "available" }),
            expect.objectContaining({ artifact_id: "case_law_registry", status: "available" }),
          ]),
        }),
      }),
    }));
    expect(complianceContent.artifact_count).toBe(complianceContent.artifacts.length);
    expect(complianceContent.artifacts.every((artifact) => artifact.sensitive === false)).toBe(true);
    expect(complianceContent.artifacts.map((artifact) => artifact.path)).toEqual(expect.arrayContaining([
      expect.stringContaining("skill.json"),
      expect.stringContaining("assurance.case.md"),
      expect.stringContaining("license.json"),
      expect.stringContaining("case-law.md"),
    ]));
    const complianceSkillArtifact = JSON.parse(
      complianceContent.artifacts.find((artifact) => artifact.path.endsWith("/skill.json"))?.content ?? "null"
    ) as { executable_entrustment?: { schema_version: string; evidence_refs: string[] } };
    expect(complianceSkillArtifact.executable_entrustment).toEqual(expect.objectContaining({
      schema_version: "synthi.dojo.executableEntrustmentSnapshot.v1",
      evidence_refs: expect.any(Array),
    }));
    expect(complianceSkillArtifact.executable_entrustment?.evidence_refs.length).toBeGreaterThan(0);
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
      implementation_status: "executable",
      runtime_enforced: true,
      explanation: expect.stringContaining("Duplicate display entity"),
      guardrails: expect.any(Array),
      runtime_failure_evidence: expect.objectContaining({
        schema_version: "synthi.dojo.failureExplanationRuntimeEvidence.v1",
        runtime_basis: "materialized_vivarium_graph_oracle",
        scenario_id: expect.stringMatching(/scenario_\d+_duplicate_entity$/),
        mutation_kind: "duplicate_entity",
        run_id: expect.stringMatching(/^scenario_run_/),
        status: expect.stringMatching(/^(passed|failed|blocked)$/),
        evidence_refs: expect.arrayContaining([
          `workflow:${published.skill.workflow_id}`,
          expect.stringMatching(/^scenario:.+scenario_\d+_duplicate_entity$/),
        ]),
        materialized_fixture: expect.objectContaining({
          synthetic_data_only: true,
        }),
      }),
      runtime_failure_execution: expect.objectContaining({
        schema_version: "synthi.dojo.vivariumScenarioRun.v1",
        scenario: expect.objectContaining({
          scenario_id: expect.stringMatching(/scenario_\d+_duplicate_entity$/),
          mutation_kind: "duplicate_entity",
        }),
        result: expect.objectContaining({
          status: expect.stringMatching(/^(passed|failed|blocked)$/),
        }),
        run: expect.objectContaining({
          run_id: expect.stringMatching(/^scenario_run_/),
        }),
      }),
      persisted_skill: expect.objectContaining({
        skill_id: published.skill.skill_id,
      }),
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
    const graphRuntimeClaims = runtimeClaimsForSkillGuardrails(publishedSkill!);
    const capsuleResponse = await dispatchDojoTool("synthi_dojo_issue_proof_capsule", {
      skill_id: skillId,
      requested_action: "run_workflow",
      context_claims: { workspace_verified: true, ...graphRuntimeClaims },
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

  it("blocks proof issuance when external proof signing is required but only the local signer is configured", async () => {
    recordOpenDetailsWorkflowForDojoToolTest();
    const publish = await dispatchDojoTool("synthi_dojo_publish_skill", publishArgsForDojoToolTest());
    expect(publish?.isError).toBeUndefined();
    const skillId = (publish?.structuredContent as { skill: { skill_id: string } }).skill.skill_id;
    const publishedSkill = dojoSkillRegistry.get(skillId);
    expect(publishedSkill).toBeTruthy();
    process.env.SYNTHI_DOJO_REQUIRE_EXTERNAL_SIGNING = "1";
    delete process.env.SYNTHI_DOJO_PROOF_SIGNING_PROVIDER;
    delete process.env.SYNTHI_DOJO_PROOF_SIGNING_PRIVATE_KEY_PEM;
    delete process.env.SYNTHI_DOJO_PROOF_SIGNING_COMMAND;

    const response = await dispatchDojoTool("synthi_dojo_issue_proof_capsule", {
      skill_id: skillId,
      requested_action: "run_workflow",
      context_claims: { workspace_verified: true },
      evidence_ledger_records: evidenceLedgerRecordsForProof(publishedSkill!, {
        record_id: "evidence-external-signer-required",
      }),
      require_verified_evidence: true,
      now: "2026-06-11T00:00:00.000Z",
      expires_at: "2026-06-11T00:15:00.000Z",
    });

    expect(response?.isError).toBe(true);
    expect(response?.structuredContent).toEqual(expect.objectContaining({
      error: "dojo_proof_signer_not_production_ready",
      ok: false,
      skill_id: skillId,
      requested_action: "run_workflow",
      require_external_signing: true,
      blocked_by: ["dojo_proof_signer_not_production_ready"],
      error_codes: ["proof_capsule_invalid"],
    }));
    expect(dojoSkillRegistry.listProofRecords()).toEqual([]);
  });

  it("blocks proof issuance when external proof signing is required but signer custody is local Ed25519", async () => {
    recordOpenDetailsWorkflowForDojoToolTest();
    const publish = await dispatchDojoTool("synthi_dojo_publish_skill", publishArgsForDojoToolTest());
    expect(publish?.isError).toBeUndefined();
    const skillId = (publish?.structuredContent as { skill: { skill_id: string } }).skill.skill_id;
    const publishedSkill = dojoSkillRegistry.get(skillId);
    expect(publishedSkill).toBeTruthy();
    const keyPair = generateEd25519DojoProofKeyPair("local-ed25519-external-required");
    process.env.SYNTHI_DOJO_REQUIRE_EXTERNAL_SIGNING = "1";
    process.env.SYNTHI_DOJO_PROOF_SIGNING_PROVIDER = "ed25519-local";
    process.env.SYNTHI_DOJO_PROOF_SIGNING_KEY_ID = keyPair.key_id;
    process.env.SYNTHI_DOJO_PROOF_SIGNING_PRIVATE_KEY_PEM = keyPair.private_key_pem;
    delete process.env.SYNTHI_DOJO_PROOF_SIGNING_COMMAND;
    delete process.env.SYNTHI_DOJO_PROOF_SIGNING_MANAGED_KEY_URI;

    const response = await dispatchDojoTool("synthi_dojo_issue_proof_capsule", {
      skill_id: skillId,
      requested_action: "run_workflow",
      context_claims: { workspace_verified: true },
      evidence_ledger_records: evidenceLedgerRecordsForProof(publishedSkill!, {
        record_id: "evidence-external-custody-required",
      }),
      require_verified_evidence: true,
      now: "2026-06-11T00:00:00.000Z",
      expires_at: "2026-06-11T00:15:00.000Z",
    });

    expect(response?.isError).toBe(true);
    expect(response?.structuredContent).toEqual(expect.objectContaining({
      error: "dojo_proof_signer_external_required",
      ok: false,
      skill_id: skillId,
      requested_action: "run_workflow",
      require_external_signing: true,
      blocked_by: ["dojo_proof_signer_external_required"],
      error_codes: ["proof_capsule_invalid"],
    }));
    expect(dojoSkillRegistry.listProofRecords()).toEqual([]);
  });

  it("enforces hosted runtime session RBAC before consuming production proof capsules", async () => {
    recordOpenDetailsWorkflowForDojoToolTest();
    const publish = await dispatchDojoTool("synthi_dojo_publish_skill", publishArgsForDojoToolTest());
    expect(publish?.isError).toBeUndefined();
    const skillId = (publish?.structuredContent as { skill: { skill_id: string } }).skill.skill_id;
    const publishedSkill = dojoSkillRegistry.get(skillId);
    expect(publishedSkill).toBeTruthy();
    const graphRuntimeClaims = runtimeClaimsForSkillGuardrails(publishedSkill!);
    const capsuleResponse = await dispatchDojoTool("synthi_dojo_issue_proof_capsule", {
      skill_id: skillId,
      requested_action: "run_prefix_validation",
      context_claims: { workspace_verified: true, ...graphRuntimeClaims },
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

    const blockedSessionResponse = await dispatchDojoTool("synthi_dojo_create_hosted_runtime_session", {
      skill_id: skillId,
      run_id: "hosted-runtime-run-unauthorized-session",
      workspace_url: "https://app.example.test/settings",
      origin_allowlist: ["https://app.example.test"],
      ttl_ms: 600_000,
      credential_ttl_ms: 300_000,
      now: "2026-06-11T00:01:20.000Z",
      ...productionTenantContextArgs({
        actor_id: "hosted-runtime-agent-a",
        roles: ["agent"],
        request_id: "req-hosted-runtime-session-blocked",
        correlation_id: "corr-hosted-runtime-session-blocked",
      }),
    });
    expect(blockedSessionResponse?.isError).toBe(true);
    expect(blockedSessionResponse?.structuredContent).toEqual(expect.objectContaining({
      ok: false,
      error: "dojo_hosted_runtime_session_role_required",
      skill_id: skillId,
      run_id: "hosted-runtime-run-unauthorized-session",
      blocked_by: expect.arrayContaining(["governance_role_required:dojo:runtime:create"]),
      rbac_authorization: expect.objectContaining({
        action: "hosted_runtime_session_create",
        actor_id: "hosted-runtime-agent-a",
        required_roles: ["dojo:runtime:create"],
        matched_roles: [],
      }),
    }));
    expect(blockedSessionResponse?.structuredContent).not.toHaveProperty("credentials");

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
        roles: ["dojo:runtime:create"],
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
      rbac_authorization: expect.objectContaining({
        action: "hosted_runtime_session_create",
        actor_id: "hosted-runtime-agent-a",
        matched_roles: ["dojo:runtime:create"],
      }),
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

    const workflowCapsuleResponse = await dispatchDojoTool("synthi_dojo_issue_proof_capsule", {
      skill_id: skillId,
      requested_action: "run_workflow",
      context_claims: { workspace_verified: true, ...graphRuntimeClaims },
      evidence_ledger_records: evidenceLedgerRecordsForProof(publishedSkill!, {
        record_id: "evidence-hosted-runtime-workflow-proof",
        tenant_id: "tenant-a",
      }),
      require_verified_evidence: true,
      ...productionProofIssuerContextArgs({
        actor_id: "hosted-runtime-agent-a",
        request_id: "req-hosted-runtime-workflow-proof-issue",
        correlation_id: "corr-hosted-runtime-workflow-proof-issue",
      }),
      now: "2026-06-11T00:01:40.000Z",
      expires_at: "2026-06-11T00:15:00.000Z",
    });
    expect(workflowCapsuleResponse?.isError).toBeUndefined();
    const workflowCapsule = (workflowCapsuleResponse?.structuredContent as {
      proof_capsule: { capsule_id: string };
    }).proof_capsule;
    browserBroker.setRuntimeAttachment({
      kind: "hosted",
      tenant_id: "tenant-a",
      workspace_id: "workspace-a",
      actor_id: "hosted-runtime-agent-a",
      runtime_id: "runtime-a",
      session_id: "different-attached-session",
      workspace_url: "https://app.example.test/settings",
      adapter: "unit-hosted-runtime",
      expires_at: Date.parse("2026-06-11T00:10:00.000Z"),
      origin_allowlist: ["https://app.example.test"],
      egress_policy: { local_network_allowed: false },
      redaction_policy: { screenshots: true },
    });
    const mismatchedRuntimeRun = await dispatchDojoTool("synthi_dojo_run_with_proof_capsule", {
      skill_id: skillId,
      requested_action: "run_workflow",
      proof_capsule: workflowCapsule,
      run_id: "hosted-runtime-run-authorized",
      runtime_session_id: runtimeSession.session_id,
      runtime_credential_id: credentials.credential_id,
      runtime_credential_secret: credentials.credential_secret,
      runtime_action_url: "https://app.example.test/settings",
      now: "2026-06-11T00:02:00.000Z",
      ...productionTenantContextArgs({
        actor_id: "hosted-runtime-agent-a",
        request_id: "req-hosted-runtime-mismatch-run",
        correlation_id: "corr-hosted-runtime-mismatch-run",
      }),
    });
    expect(mismatchedRuntimeRun?.isError).toBe(true);
    expect(mismatchedRuntimeRun?.structuredContent).toEqual(expect.objectContaining({
      proof_consume: null,
      runtime_authorization: expect.objectContaining({
        ok: true,
        session_id: runtimeSession.session_id,
      }),
      skill_bus: expect.objectContaining({
        ok: false,
        blocked_by: expect.arrayContaining(["runtime_session_attachment_mismatch"]),
      }),
      validation: expect.objectContaining({
        blocked_by: expect.arrayContaining(["runtime_session_attachment_mismatch"]),
      }),
    }));
    expect(dojoSkillRegistry.getProofRecord(workflowCapsule.capsule_id)).toEqual(expect.objectContaining({
      status: "issued",
    }));

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

  it("blocks hosted runtime session creation when production requires a durable control plane but none is configured", async () => {
    recordOpenDetailsWorkflowForDojoToolTest();
    const publish = await dispatchDojoTool("synthi_dojo_publish_skill", publishArgsForDojoToolTest());
    expect(publish?.isError).toBeUndefined();
    const skillId = (publish?.structuredContent as { skill: { skill_id: string } }).skill.skill_id;

    process.env.SYNTHI_DOJO_PRODUCTION_ENFORCEMENT = "1";
    process.env.SYNTHI_DOJO_REQUIRE_DURABLE_STORE = "1";
    delete process.env.SYNTHI_DOJO_CONTROL_PLANE_STORE;
    delete process.env.SYNTHI_DOJO_CONTROL_PLANE_POSTGRES_URL;
    delete process.env.SYNTHI_DOJO_STORE_FILE;
    delete process.env.SYNTHI_DOJO_STORE_KEY;
    delete process.env.SYNTHI_DOJO_STORE_SCOPE;

    const response = await dispatchDojoTool("synthi_dojo_create_hosted_runtime_session", {
      skill_id: skillId,
      run_id: "hosted-runtime-run-requires-store",
      workspace_url: "https://app.example.test/settings",
      origin_allowlist: ["https://app.example.test"],
      ...productionTenantContextArgs({
        actor_id: "hosted-runtime-agent-a",
        request_id: "req-hosted-runtime-missing-store",
        correlation_id: "corr-hosted-runtime-missing-store",
      }),
    });

    expect(response?.isError).toBe(true);
    expect(response?.structuredContent).toEqual(expect.objectContaining({
      error: "dojo_hosted_runtime_control_plane_store_required",
      ok: false,
      skill_id: skillId,
      store_kind: "unconfigured",
      production_capable: false,
      blocked_by: expect.arrayContaining([
        "hosted_runtime_control_plane_store_not_production_capable",
        "control_plane_store_unconfigured",
      ]),
    }));
  });

  it("blocks skill publication when production requires a durable control plane but none is configured", async () => {
    recordOpenDetailsWorkflowForDojoToolTest();
    process.env.SYNTHI_DOJO_PRODUCTION_ENFORCEMENT = "1";
    process.env.SYNTHI_DOJO_REQUIRE_DURABLE_STORE = "1";
    delete process.env.SYNTHI_DOJO_CONTROL_PLANE_STORE;
    delete process.env.SYNTHI_DOJO_CONTROL_PLANE_POSTGRES_URL;
    delete process.env.SYNTHI_DOJO_STORE_FILE;
    delete process.env.SYNTHI_DOJO_STORE_KEY;
    delete process.env.SYNTHI_DOJO_STORE_SCOPE;

    const publish = await dispatchDojoTool("synthi_dojo_publish_skill", publishArgsForDojoToolTest({
      ...productionSkillPublisherContextArgs({
        actor_id: "durable-publisher",
        actor_type: "human",
        request_id: "req-production-durable-publish",
        correlation_id: "corr-production-durable-publish",
      }),
    }));

    expect(publish?.isError).toBe(true);
    expect(publish?.structuredContent).toEqual(expect.objectContaining({
      error: "dojo_control_plane_store_not_runtime_wired",
      ok: false,
      operation: "synthi_dojo_publish_skill",
      enforcement_mode: "production",
      store_kind: "unconfigured",
      configured: false,
      durable: false,
      production_capable: false,
      blocked_by: expect.arrayContaining([
        "dojo_control_plane_store_not_production_capable",
        "control_plane_store_unconfigured",
      ]),
      error_codes: ["dojo_control_plane_store_not_runtime_wired"],
    }));
    expect(dojoSkillRegistry.list()).toHaveLength(0);
  });

  it("does not expose a backing private tool when durable skill persistence fails", async () => {
    recordOpenDetailsWorkflowForDojoToolTest();
    process.env.SYNTHI_DOJO_PRODUCTION_ENFORCEMENT = "1";
    process.env.SYNTHI_DOJO_REQUIRE_DURABLE_STORE = "1";
    process.env.SYNTHI_DOJO_CONTROL_PLANE_STORE = "postgres";
    process.env.SYNTHI_DOJO_CONTROL_PLANE_POSTGRES_URL = "postgres://synthi:password@127.0.0.1:1/synthi?connect_timeout=1";

    const publish = await dispatchDojoTool("synthi_dojo_publish_skill", publishArgsForDojoToolTest({
      ...productionSkillPublisherContextArgs({
        actor_id: "durable-publisher",
        actor_type: "human",
        request_id: "req-production-durable-publish-failure",
        correlation_id: "corr-production-durable-publish-failure",
      }),
    }));

    expect(publish?.isError).toBe(true);
    expect(publish?.structuredContent).toEqual(expect.objectContaining({
      error: "dojo_control_plane_persistence_failed",
      ok: false,
      operation: "synthi_dojo_publish_skill",
      skill_id: "dojo_open_details",
      workflow_id: expect.any(String),
      blocked_by: ["dojo_control_plane_postgres_persistence_failed"],
      error_codes: ["dojo_control_plane_persistence_failed"],
    }));
    expect(dojoSkillRegistry.list()).toHaveLength(0);
    expect(privateWorkflowToolRegistry.get("synthi_app_open_details")).toBeNull();
    expect(await dispatchBrowserTool("synthi_app_open_details", {})).toBeNull();
  });

  it("blocks proof execution before consuming proof when production requires a durable control plane but none is configured", async () => {
    recordOpenDetailsWorkflowForDojoToolTest();
    const publish = await dispatchDojoTool("synthi_dojo_publish_skill", publishArgsForDojoToolTest());
    expect(publish?.isError).toBeUndefined();
    const skillId = (publish?.structuredContent as { skill: { skill_id: string } }).skill.skill_id;
    const skill = dojoSkillRegistry.get(skillId);
    expect(skill).toBeTruthy();
    const capsuleResponse = await dispatchDojoTool("synthi_dojo_issue_proof_capsule", {
      skill_id: skillId,
      requested_action: "run_workflow",
      context_claims: { workspace_verified: true },
      evidence_ledger_records: evidenceLedgerRecordsForProof(skill!, { record_id: "evidence-durable-run-proof" }),
      require_verified_evidence: true,
      now: "2026-06-11T00:00:00.000Z",
      expires_at: "2026-06-11T00:15:00.000Z",
    });
    expect(capsuleResponse?.isError).toBeUndefined();
    const capsule = (capsuleResponse?.structuredContent as { proof_capsule: { capsule_id: string } }).proof_capsule;
    expect(dojoSkillRegistry.getProofRecord(capsule.capsule_id)?.status).toBe("issued");

    process.env.SYNTHI_DOJO_PRODUCTION_ENFORCEMENT = "1";
    process.env.SYNTHI_DOJO_REQUIRE_DURABLE_STORE = "1";
    delete process.env.SYNTHI_DOJO_CONTROL_PLANE_STORE;
    delete process.env.SYNTHI_DOJO_CONTROL_PLANE_POSTGRES_URL;
    delete process.env.SYNTHI_DOJO_STORE_FILE;
    delete process.env.SYNTHI_DOJO_STORE_KEY;
    delete process.env.SYNTHI_DOJO_STORE_SCOPE;

    const run = await dispatchDojoTool("synthi_dojo_run_with_proof_capsule", {
      skill_id: skillId,
      requested_action: "run_workflow",
      proof_capsule: capsule,
      tool_args: { client_id: "client-a" },
      ...productionTenantContextArgs({
        actor_id: "durable-proof-agent",
        request_id: "req-production-durable-proof-run",
        correlation_id: "corr-production-durable-proof-run",
      }),
    });

    expect(run?.isError).toBe(true);
    expect(run?.structuredContent).toEqual(expect.objectContaining({
      error: "dojo_control_plane_store_not_runtime_wired",
      ok: false,
      operation: "synthi_dojo_run_with_proof_capsule",
      enforcement_mode: "production",
      store_kind: "unconfigured",
      production_capable: false,
      blocked_by: expect.arrayContaining([
        "dojo_control_plane_store_not_production_capable",
        "control_plane_store_unconfigured",
      ]),
      error_codes: ["dojo_control_plane_store_not_runtime_wired"],
    }));
    expect(dojoSkillRegistry.getProofRecord(capsule.capsule_id)?.status).toBe("issued");
    expect(dojoSkillRegistry.getProofRecord(capsule.capsule_id)?.used_at).toBeUndefined();
  });

  it("uses top-level approval and actor context for license validation without duplicating workflow args", async () => {
    recordOpenDetailsWorkflowForDojoToolTest();
    const publish = await dispatchDojoTool("synthi_dojo_publish_skill", publishArgsForDojoToolTest());
    expect(publish?.isError).toBeUndefined();
    const skillId = (publish?.structuredContent as { skill: { skill_id: string } }).skill.skill_id;
    const skill = dojoSkillRegistry.get(skillId);
    expect(skill).toBeTruthy();
    const graphRuntimeClaims = runtimeClaimsForSkillGuardrails(skill!);
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
      context_claims: { workspace_verified: true, ...graphRuntimeClaims },
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
      graph_validation: expect.objectContaining({
        ok: true,
      }),
      graph_runtime_preflight: expect.objectContaining({
        ok: true,
        status: "completed",
        mode: "production",
        node_results: expect.arrayContaining([
          expect.objectContaining({
            kind: "Action",
            status: "skipped",
            control_flow: { skipped_by: ["graph_preflight_only"] },
          }),
        ]),
        evidence_refs: expect.arrayContaining([
          expect.stringMatching(/^evidence:dojo_graph_preflight_/),
        ]),
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

  it("blocks proof-gated runs at graph preflight before consuming proof", async () => {
    recordOpenDetailsWorkflowForDojoToolTest();
    const publish = await dispatchDojoTool("synthi_dojo_publish_skill", publishArgsForDojoToolTest());
    expect(publish?.isError).toBeUndefined();
    const skillId = (publish?.structuredContent as { skill: { skill_id: string } }).skill.skill_id;
    const skill = dojoSkillRegistry.get(skillId);
    expect(skill).toBeTruthy();
    const guardrailId = "guard_client_id_verified";
    dojoSkillRegistry.publish({
      ...skill!,
      guardrails: [
        {
          guardrail_id: guardrailId,
          title: "Client identity is verified",
          rule: "client_id_verified == true",
          source_case_id: "case_client_id_verified",
          blocks_actions: ["run_workflow"],
        },
      ],
      permission_license: {
        ...skill!.permission_license,
        proof_requirements: {
          ...skill!.permission_license.proof_requirements,
          required_guardrails: [guardrailId],
        },
      },
    });
    const updatedSkill = dojoSkillRegistry.get(skillId);
    expect(updatedSkill).toBeTruthy();
    const capsuleResponse = await dispatchDojoTool("synthi_dojo_issue_proof_capsule", {
      skill_id: skillId,
      requested_action: "run_workflow",
      context_claims: { workspace_verified: true },
      evidence_ledger_records: evidenceLedgerRecordsForProof(updatedSkill!, { record_id: "evidence-graph-preflight-proof" }),
      require_verified_evidence: true,
      now: "2026-06-11T00:00:00.000Z",
      expires_at: "2026-06-11T00:15:00.000Z",
    });
    expect(capsuleResponse?.isError).toBeUndefined();
    const capsule = (capsuleResponse?.structuredContent as { proof_capsule: unknown }).proof_capsule;
    const capsuleId = (capsule as { capsule_id: string }).capsule_id;

    const blocked = await dispatchDojoTool("synthi_dojo_run_with_proof_capsule", {
      skill_id: skillId,
      requested_action: "run_workflow",
      proof_capsule: capsule,
      tool_args: {
        prefix: "preview",
        text: "preview draft",
      },
      run_id: "run-graph-preflight-blocked",
      now: "2026-06-11T00:01:00.000Z",
    });

    expect(blocked?.isError).toBe(true);
    expect(blocked?.structuredContent).toEqual(expect.objectContaining({
      ok: false,
      skill_id: skillId,
      requested_action: "run_workflow",
      proof_not_consumed: true,
      validation: expect.objectContaining({
        ok: false,
        status: "blocked",
        blocked_by: expect.arrayContaining(["guardrail_failed:guard_client_id_verified"]),
      }),
      graph_validation: expect.objectContaining({ ok: true }),
      graph_runtime_preflight: expect.objectContaining({
        ok: false,
        status: "blocked",
        run_id: "run-graph-preflight-blocked_graph_preflight",
        blocked_by: expect.arrayContaining(["guardrail_failed:guard_client_id_verified"]),
        node_results: expect.arrayContaining([
          expect.objectContaining({
            status: "blocked",
            blocked_by: expect.arrayContaining(["guardrail_failed:guard_client_id_verified"]),
          }),
        ]),
      }),
    }));
    expect(dojoSkillRegistry.getProofRecord(capsuleId)?.status).toBe("issued");
    expect(dojoSkillRegistry.getProofRecord(capsuleId)?.used_at).toBeUndefined();
  });

  it("requires explicit durable evidence claims for graph runtime preflight", async () => {
    recordOpenDetailsWorkflowForDojoToolTest();
    const publish = await dispatchDojoTool("synthi_dojo_publish_skill", publishArgsForDojoToolTest());
    expect(publish?.isError).toBeUndefined();
    const skillId = (publish?.structuredContent as { skill: { skill_id: string } }).skill.skill_id;
    const skill = dojoSkillRegistry.get(skillId);
    expect(skill).toBeTruthy();
    expect(skill!.permission_license.proof_requirements.required_evidence_claims).toContain("durable_state_evidence");

    const legacyRequiredClaims = skill!.permission_license.proof_requirements.required_evidence_claims
      .filter((claim) => claim !== "durable_state_evidence");
    dojoSkillRegistry.publish({
      ...skill!,
      permission_license: {
        ...skill!.permission_license,
        evidence_requirements: skill!.permission_license.evidence_requirements
          .filter((requirement) => requirement.claim !== "durable_state_evidence"),
        proof_requirements: {
          ...skill!.permission_license.proof_requirements,
          required_evidence_claims: legacyRequiredClaims,
        },
      },
    });
    const legacySkill = dojoSkillRegistry.get(skillId);
    expect(legacySkill).toBeTruthy();
    const capsuleResponse = await dispatchDojoTool("synthi_dojo_issue_proof_capsule", {
      skill_id: skillId,
      requested_action: "run_workflow",
      context_claims: { workspace_verified: true, ...runtimeClaimsForSkillGuardrails(legacySkill!) },
      evidence_ledger_records: evidenceLedgerRecordsForProof(legacySkill!, { record_id: "evidence-legacy-no-durable-proof" }),
      require_verified_evidence: true,
      now: "2026-06-11T00:00:00.000Z",
      expires_at: "2026-06-11T00:15:00.000Z",
    });
    expect(capsuleResponse?.isError).toBeUndefined();
    const capsule = (capsuleResponse?.structuredContent as { proof_capsule: { capsule_id: string; evidence_claims: DojoEvidenceClaim[] } }).proof_capsule;
    expect(capsule.evidence_claims).toEqual(expect.arrayContaining([
      expect.objectContaining({ claim: "success_assertions_defined", satisfied: true }),
    ]));
    expect(capsule.evidence_claims).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ claim: "durable_state_evidence", satisfied: true }),
    ]));

    const blocked = await dispatchDojoTool("synthi_dojo_run_with_proof_capsule", {
      skill_id: skillId,
      requested_action: "run_workflow",
      proof_capsule: capsule,
      tool_args: {
        durable_state_evidence: true,
        proof_capsule_valid: true,
        client_name: "Acme",
      },
      dry_run: true,
      run_id: "run-legacy-no-durable-proof",
      now: "2026-06-11T00:01:00.000Z",
    });

    expect(blocked?.isError).toBe(true);
    expect(blocked?.structuredContent).toEqual(expect.objectContaining({
      ok: false,
      skill_id: skillId,
      requested_action: "run_workflow",
      proof_not_consumed: true,
      validation: expect.objectContaining({
        ok: false,
        status: "blocked",
        blocked_by: expect.arrayContaining(["guardrail_failed:guard_durable_postcondition_evidence"]),
      }),
      graph_runtime_preflight: expect.objectContaining({
        ok: false,
        status: "blocked",
        blocked_by: expect.arrayContaining(["guardrail_failed:guard_durable_postcondition_evidence"]),
      }),
    }));
    expect(dojoSkillRegistry.getProofRecord(capsule.capsule_id)?.status).toBe("issued");
    expect(dojoSkillRegistry.getProofRecord(capsule.capsule_id)?.used_at).toBeUndefined();
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

async function initializedDetailsOpenSourceRepoForDojoToolTest(): Promise<string> {
  const repoRoot = await mkdtemp(path.join(tmpdir(), "dojo-source-affordance-tool-"));
  await mkdir(path.join(repoRoot, "src"), { recursive: true });
  await writeFile(path.join(repoRoot, "src/details.open.tsx"), detailsOpenSourceForDojoToolTest());
  runGitForDojoToolTest(repoRoot, ["init"]);
  runGitForDojoToolTest(repoRoot, ["config", "user.email", "dojo-tool-test@example.test"]);
  runGitForDojoToolTest(repoRoot, ["config", "user.name", "Dojo Tool Test"]);
  runGitForDojoToolTest(repoRoot, ["add", "src/details.open.tsx"]);
  runGitForDojoToolTest(repoRoot, ["commit", "-m", "seed details affordance fixture"]);
  return repoRoot;
}

function detailsOpenSourceForDojoToolTest(): string {
  return [
    "function assertDojoProof(affordanceId) {",
    "  return affordanceId;",
    "}",
    "",
    "export function DetailsOpen({ onOpen }) {",
    "  return <button onClick={onOpen}>Open details</button>;",
    "}",
    "",
  ].join("\n");
}

function runGitForDojoToolTest(repoRoot: string, args: string[]) {
  const result = spawnSync("git", args, {
    cwd: repoRoot,
    encoding: "utf8",
  });
  expect(result.status, result.stdout + result.stderr).toBe(0);
  return result;
}

function currentGitBranchForDojoToolTest(repoRoot: string): string {
  return runGitForDojoToolTest(repoRoot, ["branch", "--show-current"]).stdout.trim();
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

function productionSkillPublisherContextArgs(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return productionTenantContextArgs({
    ...overrides,
    roles: mergeRoleOverrides(["agent", "dojo:skill:publish"], overrides["roles"]),
  });
}

function productionCheckrideRunnerContextArgs(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return productionTenantContextArgs({
    ...overrides,
    roles: mergeRoleOverrides(["agent", "dojo:checkride:run"], overrides["roles"]),
  });
}

function productionPracticeRunnerContextArgs(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return productionTenantContextArgs({
    ...overrides,
    roles: mergeRoleOverrides(["agent", "dojo:practice:run"], overrides["roles"]),
  });
}

function productionRegistryViewerContextArgs(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return productionTenantContextArgs({
    ...overrides,
    roles: mergeRoleOverrides(["agent", "dojo:registry:view"], overrides["roles"]),
  });
}

function productionMetricsViewerContextArgs(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return productionTenantContextArgs({
    ...overrides,
    roles: mergeRoleOverrides(["agent", "dojo:metrics:view"], overrides["roles"]),
  });
}

function productionArtifactExporterContextArgs(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return productionTenantContextArgs({
    ...overrides,
    roles: mergeRoleOverrides(["agent", "dojo:artifact:export"], overrides["roles"]),
  });
}

function productionApiToolPreparerContextArgs(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return productionTenantContextArgs({
    ...overrides,
    roles: mergeRoleOverrides(["agent", "dojo:api-tool:prepare"], overrides["roles"]),
  });
}

function productionApiToolPublisherContextArgs(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return productionTenantContextArgs({
    ...overrides,
    roles: mergeRoleOverrides(["agent", "dojo:api-tool:prepare", "dojo:api-tool:publish"], overrides["roles"]),
  });
}

function productionScheduledJobRunnerContextArgs(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return productionTenantContextArgs({
    ...overrides,
    roles: mergeRoleOverrides(["agent", "dojo:governance:schedule"], overrides["roles"]),
  });
}

function productionProofIssuerContextArgs(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return productionTenantContextArgs({
    ...overrides,
    roles: mergeRoleOverrides(["agent", "dojo:proof:issue"], overrides["roles"]),
  });
}

function productionProofRevokerContextArgs(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return productionTenantContextArgs({
    ...overrides,
    roles: mergeRoleOverrides(["agent", "dojo:proof:revoke"], overrides["roles"]),
  });
}

function mergeRoleOverrides(defaultRoles: string[], overrideRoles: unknown): string[] {
  if (!Array.isArray(overrideRoles)) return defaultRoles;
  return [...new Set([...defaultRoles, ...overrideRoles.map((role) => String(role))])];
}

function runtimeClaimsForSkillGuardrails(skill: DojoSkill): Record<string, unknown> {
  const claims: Record<string, unknown> = {};
  for (const guardrail of skill.guardrails) {
    const normalized = normalizeDojoGuardrailPredicate({
      rule: guardrail.rule,
      title: guardrail.title,
      guardrail_id: guardrail.guardrail_id,
    });
    const contextKey = normalized.generated_context_key ?? contextKeyForDojoGuardrailPredicate(normalized.predicate);
    if (contextKey) {
      claims[contextKey] = true;
    }
  }
  return claims;
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
  const claimIds = [...new Set([
    ...skill.permission_license.proof_requirements.required_evidence_claims,
    ...skill.permission_license.proof_requirements.required_context_claims,
  ])];
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

function packageReadinessEvidenceForDojoToolTest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema_version: "synthi.dojo.packageReadinessEvidence.v1",
    generated_at: "2026-06-11T00:00:00.000Z",
    ok: true,
    errors: [],
    package_name: "@synthi-inc/mcp-server",
    package_version: "0.1.0",
    package_private: false,
    required_package_scripts: ["build", "typecheck", "proof:dojo:package-readiness:self-check"],
    required_package_files_entries: ["dist", "scripts/dojo-package-readiness-self-check.mjs"],
    export_entry_paths: ["dist/index.js"],
    script_referenced_paths: ["scripts/dojo-package-readiness-self-check.mjs"],
    validation: {
      ok: true,
      errors: [],
    },
    npm_pack: {
      exit_code: 0,
      integrity_present: true,
      packed_file_count: 1,
      unpacked_size: 1024,
    },
    ...overrides,
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
