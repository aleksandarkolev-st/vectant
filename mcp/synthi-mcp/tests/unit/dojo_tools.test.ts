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
import { InMemoryDojoSkillStore } from "../../src/browser/dojo_store.js";
import { InMemoryPrivateWorkflowToolStore, privateWorkflowToolRegistry } from "../../src/browser/private_tool_registry.js";
import { sourceIdentityRegistry } from "../../src/browser/source_identity.js";
import { compileWorkflowContract } from "../../src/browser/workflow.js";
import type { BrowserTraceEvent } from "../../src/browser/types.js";
import { createSynthiServer } from "../../src/server.js";
import { validateDojoMcpSkillManifest, type DojoMcpSkillManifestV1 } from "../../src/dojo/mcp/manifest_signing.js";
import { dispatchBrowserTool } from "../../src/tools/browser.js";
import { dispatchDojoTool } from "../../src/tools/dojo.js";

beforeEach(() => {
  browserBroker.resetForTests();
  sourceIdentityRegistry.resetForTests();
  privateWorkflowToolRegistry.useStoreForTests(new InMemoryPrivateWorkflowToolStore());
  privateWorkflowToolRegistry.resetForTests();
  dojoSkillRegistry.useStoreForTests(new InMemoryDojoSkillStore());
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
  it("adds implementation-status metadata to Dojo tool responses", async () => {
    const listed = await dispatchDojoTool("synthi_dojo_list_competencies", {});

    expect(listed?.structuredContent).toEqual(expect.objectContaining({
      implementation_status: "executable",
      runtime_enforced: true,
      evidence_backing: "runtime_validation",
      simulation_backing: "none",
      dojo_implementation: expect.objectContaining({
        implementation_status: "executable",
        runtime_enforced: true,
      }),
    }));
    expect(JSON.parse((listed?.content[0] as { type: "text"; text: string }).text)).toEqual(
      expect.objectContaining({ implementation_status: "executable" })
    );
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
    });
    expect(capsuleResponse?.isError).toBeUndefined();
    const capsule = (capsuleResponse?.structuredContent as { proof_capsule: unknown }).proof_capsule;

    const validate = await dispatchDojoTool("synthi_dojo_validate_proof_capsule", {
      skill_id: published.skill.skill_id,
      requested_action: "run_workflow",
      proof_capsule: capsule,
    });
    expect(validate?.isError).toBeUndefined();
    expect(validate?.structuredContent).toEqual(expect.objectContaining({
      license_kernel: expect.objectContaining({ ok: true, status: "allowed" }),
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
      validation: expect.objectContaining({ ok: true, status: "allowed" }),
      skill_bus: expect.objectContaining({
        ok: true,
        status: "allowed",
        dry_run: true,
        resolution: expect.objectContaining({ status: "resolved" }),
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
    });
    const secondCapsule = (secondCapsuleResponse?.structuredContent as { proof_capsule: { capsule_id: string } }).proof_capsule;
    const revokedProof = await dispatchDojoTool("synthi_dojo_revoke_proof_capsule", {
      capsule_id: secondCapsule.capsule_id,
      reason: "unit_test_revocation",
    });
    expect(revokedProof?.structuredContent).toEqual(expect.objectContaining({
      proof_record: expect.objectContaining({ status: "revoked" }),
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
      implementation_status: "report_only",
      ghost_run: expect.objectContaining({
        mode: "ghost",
        status: "mismatch",
        would_execute: false,
        production_mutations_executed: false,
        shadow_evidence_id: expect.stringMatching(/^ghost_evidence_/),
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
        production_mutations_executed: false,
        action_matches: false,
        observed_label: "open details",
        planned_label: "delete details",
        entrustment_impact: expect.objectContaining({
          reason: expect.stringContaining("prevents entrustment upgrade"),
        }),
      }),
    }));
    const upgradeRequest = await dispatchDojoTool("synthi_dojo_request_permission_upgrade", {
      skill_id: published.skill.skill_id,
      requested_action: "commit_mutation",
      actor_id: "reviewer-a",
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
    });
    expect(scenarioRun?.structuredContent).toEqual(expect.objectContaining({
      implementation_status: "executable",
      runtime_enforced: true,
      simulation_backing: "materialized_synthetic_fixture",
      vivarium_run: expect.objectContaining({
        schema_version: "synthi.dojo.vivariumScenarioRun.v1",
        materialized_fixture: expect.objectContaining({ synthetic_data_only: true }),
      }),
      license_health: expect.objectContaining({ schema_version: "synthi.dojo.licenseHealth.v1" }),
    }));
    const windTunnel = await dispatchDojoTool("synthi_dojo_run_wind_tunnel", {
      skill_id: published.skill.skill_id,
      max_scenarios: 3,
    });
    expect(windTunnel?.structuredContent).toEqual(expect.objectContaining({
      wind_tunnel_execution: expect.objectContaining({
        schema_version: "synthi.dojo.windTunnelExecution.v1",
        run_count: 3,
      }),
    }));
    const health = await dispatchDojoTool("synthi_dojo_get_license_health", { skill_id: published.skill.skill_id });
    expect(health?.structuredContent).toEqual(expect.objectContaining({
      license_health: expect.objectContaining({
        proof_records: expect.objectContaining({ used: 1, revoked: 1 }),
      }),
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
    });
    expect(recordedCase?.structuredContent).toEqual(expect.objectContaining({
      case_law: expect.objectContaining({ status: "binding" }),
      case_law_record: expect.objectContaining({ status: "approved" }),
      guardrail: expect.objectContaining({ blocks_actions: ["run_workflow"] }),
    }));
    const recordedCaseId = (recordedCase?.structuredContent as {
      case_law_record: { case_id: string };
    }).case_law_record.case_id;
    const listedCaseLaw = await dispatchDojoTool("synthi_dojo_get_case_law", { skill_id: published.skill.skill_id });
    expect(listedCaseLaw?.structuredContent).toEqual(expect.objectContaining({
      case_law_records: expect.arrayContaining([
        expect.objectContaining({ case_id: recordedCaseId, status: "approved" }),
      ]),
    }));
    const reviewedCaseAgain = await dispatchDojoTool("synthi_dojo_review_case_law", {
      case_id: recordedCaseId,
      skill_id: published.skill.skill_id,
      decision: "approved",
      reviewer_actor_id: "case-reviewer-a",
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

    const cortex = await dispatchDojoTool("synthi_dojo_get_skill_cortex", { skill_id: published.skill.skill_id });
    expect(cortex?.structuredContent).toEqual(expect.objectContaining({
      skill_cortex: expect.objectContaining({
        nodes: expect.arrayContaining([expect.objectContaining({ kind: "Proof" })]),
      }),
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
    });
    expect(revoke?.structuredContent).toEqual(expect.objectContaining({
      license: expect.objectContaining({ entrustment_level: "EX", autonomy_level: "blocked" }),
    }));
    const revokedHealth = await dispatchDojoTool("synthi_dojo_get_license_health", { skill_id: published.skill.skill_id });
    expect(revokedHealth?.structuredContent).toEqual(expect.objectContaining({
      license_health: expect.objectContaining({ status: "blocked", entrustment_level: "EX" }),
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
