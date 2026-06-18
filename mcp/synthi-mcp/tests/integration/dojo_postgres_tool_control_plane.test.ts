import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { createHash } from "node:crypto";
import { browserBroker } from "../../src/browser/broker.js";
import {
  buildDojoSkill,
  dojoSkillRegistry,
  type DojoSkill,
} from "../../src/browser/dojo.js";
import { InMemoryDojoSkillStore } from "../../src/browser/dojo_store.js";
import { InMemoryPrivateWorkflowToolStore, privateWorkflowToolRegistry } from "../../src/browser/private_tool_registry.js";
import { sourceIdentityRegistry } from "../../src/browser/source_identity.js";
import { PostgresDojoLicenseStore } from "../../src/dojo/store/postgres_license_store.js";
import { PostgresDojoEvidenceLedgerStore } from "../../src/dojo/evidence/ledger_store.js";
import { applyDojoPostgresMigrations } from "../../src/dojo/store/postgres_proof_store.js";
import { PostgresDojoProofStore } from "../../src/dojo/store/postgres_proof_store.js";
import { generateEd25519DojoProofKeyPair } from "../../src/dojo/proof/signing.js";
import { PostgresDojoAuditStore } from "../../src/dojo/store/audit_store.js";
import { ensureDojoTenantWorkspace } from "../../src/dojo/store/control_plane_resolver.js";
import { PostgresDojoGhostShadowEvidenceStore } from "../../src/dojo/store/postgres_ghost_shadow_evidence_store.js";
import { PostgresDojoGovernanceStore } from "../../src/dojo/store/postgres_governance_store.js";
import { PostgresDojoGraphRunStore } from "../../src/dojo/store/postgres_graph_run_store.js";
import { PostgresDojoProofKeyRegistry } from "../../src/dojo/store/postgres_proof_key_registry.js";
import { PostgresDojoSkillStore } from "../../src/dojo/store/postgres_skill_store.js";
import { PostgresDojoHostedRuntimeSessionStore } from "../../src/dojo/runtime/postgres_hosted_runtime_store.js";
import { dispatchBrowserTool } from "../../src/tools/browser.js";
import { dispatchDojoTool } from "../../src/tools/dojo.js";

const postgresUrl = process.env["SYNTHI_DOJO_POSTGRES_TEST_URL"];
const describeWithPostgres = postgresUrl ? describe : describe.skip;
const originalEnv = { ...process.env };

describeWithPostgres("Dojo tool Postgres control-plane wiring", () => {
  let pool: Pool;

  beforeAll(async () => {
    if (!postgresUrl) throw new Error("SYNTHI_DOJO_POSTGRES_TEST_URL required");
    pool = new Pool({ connectionString: postgresUrl });
    await applyDojoPostgresMigrations(pool);
  });

  beforeEach(() => {
    process.env = { ...originalEnv };
    browserBroker.resetForTests();
    sourceIdentityRegistry.resetForTests();
    privateWorkflowToolRegistry.useStoreForTests(new InMemoryPrivateWorkflowToolStore());
    privateWorkflowToolRegistry.resetForTests();
    dojoSkillRegistry.useStoreForTests(new InMemoryDojoSkillStore());
    dojoSkillRegistry.resetForTests();
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  afterAll(async () => {
    if (pool) await pool.end();
  });

  it("persists production durable skill publication and lists competencies from Postgres after local reset", async () => {
    const tenantId = `tenant_tool_${Date.now()}_${Math.random().toString(16).slice(2)}`;
    const workspaceId = `workspace_tool_${Math.random().toString(16).slice(2)}`;
    process.env.SYNTHI_DOJO_PRODUCTION_ENFORCEMENT = "1";
    process.env.SYNTHI_DOJO_REQUIRE_DURABLE_STORE = "1";
    process.env.SYNTHI_DOJO_CONTROL_PLANE_STORE = "postgres";
    process.env.SYNTHI_DOJO_CONTROL_PLANE_POSTGRES_URL = postgresUrl;

    recordOpenDetailsWorkflowForToolTest(workspaceId);
    const tenant = productionTenantContextArgs({
      tenant_id: tenantId,
      workspace_id: workspaceId,
      request_id: "req-postgres-publish",
      correlation_id: "corr-postgres-publish",
      actor_id: "postgres-publisher",
      actor_type: "human",
      roles: ["dojo:operator"],
    });
    const publish = await dispatchDojoTool("synthi_dojo_publish_skill", {
      workspace_id: workspaceId,
      reason: "integration_postgres_publish",
      evidence_refs: ["evidence:integration-postgres-publish"],
      ...tenant,
    });

    expect(publish?.isError).toBeUndefined();
    const publishContent = publish?.structuredContent as {
      skill: { skill_id: string; workflow_id: string };
      publication: { control_plane_persistence: Record<string, unknown> };
    };
    expect(publishContent.publication.control_plane_persistence).toEqual(expect.objectContaining({
      ok: true,
      store_kind: "postgres",
      skill_id: publishContent.skill.skill_id,
      workflow_id: publishContent.skill.workflow_id,
      workspace_id: workspaceId,
      status: "published",
    }));

    const skillStore = new PostgresDojoSkillStore({
      tenant_id: tenantId,
      workspace_id: workspaceId,
      queryable: pool,
    });
    const licenseStore = new PostgresDojoLicenseStore({
      tenant_id: tenantId,
      workspace_id: workspaceId,
      queryable: pool,
    });
    const savedSkill = await skillStore.getSkill(publishContent.skill.skill_id);
    expect(savedSkill).toEqual(expect.objectContaining({
      skill_id: publishContent.skill.skill_id,
      workflow_id: publishContent.skill.workflow_id,
      workspace_id: workspaceId,
    }));
    expect(await licenseStore.listLicenses({ skill_id: publishContent.skill.skill_id })).toEqual([
      expect.objectContaining({
        skill_id: publishContent.skill.skill_id,
        status: "active",
        readiness_level: savedSkill?.skill_readiness_level,
      }),
    ]);

    dojoSkillRegistry.useStoreForTests(new InMemoryDojoSkillStore());
    dojoSkillRegistry.resetForTests();
    const listed = await dispatchDojoTool("synthi_dojo_list_competencies", {
      ...tenant,
      actor_id: "postgres-reader",
      actor_type: "agent",
      roles: ["agent"],
      request_id: "req-postgres-list",
      correlation_id: "corr-postgres-list",
    });

    expect(listed?.isError).toBeUndefined();
    expect(listed?.structuredContent).toEqual(expect.objectContaining({
      ok: true,
      control_plane_source: "postgres",
      count: 1,
      competencies: [
        expect.objectContaining({
          skill_id: publishContent.skill.skill_id,
          workflow_id: publishContent.skill.workflow_id,
        }),
      ],
    }));
  });

  it("requires ledger-backed publication evidence when production evidence ledger is enforced", async () => {
    const tenantId = `tenant_publication_ledger_${Date.now()}_${Math.random().toString(16).slice(2)}`;
    const workspaceId = `workspace_publication_ledger_${Math.random().toString(16).slice(2)}`;
    process.env.SYNTHI_DOJO_PRODUCTION_ENFORCEMENT = "1";
    process.env.SYNTHI_DOJO_REQUIRE_DURABLE_STORE = "1";
    process.env.SYNTHI_DOJO_REQUIRE_EVIDENCE_LEDGER = "1";
    process.env.SYNTHI_DOJO_CONTROL_PLANE_STORE = "postgres";
    process.env.SYNTHI_DOJO_CONTROL_PLANE_POSTGRES_URL = postgresUrl;
    process.env.SYNTHI_DOJO_EVIDENCE_LEDGER_STORE = "postgres";
    process.env.SYNTHI_DOJO_EVIDENCE_LEDGER_POSTGRES_URL = postgresUrl;

    recordOpenDetailsWorkflowForToolTest(workspaceId);
    const workflowArtifact = browserBroker.workflowArtifact();
    expect(workflowArtifact.ok).toBe(true);
    if (!workflowArtifact.ok) throw new Error(workflowArtifact.error);
    const candidateSkill = buildDojoSkill(workflowArtifact.artifact.workflow.contract, {
      workspace_id: workspaceId,
      now: "2026-06-11T00:00:00.000Z",
    });
    const tenant = productionTenantContextArgs({
      tenant_id: tenantId,
      workspace_id: workspaceId,
      request_id: "req-postgres-publication-ledger",
      correlation_id: "corr-postgres-publication-ledger",
      actor_id: "postgres-publication-ledger-publisher",
      actor_type: "human",
      roles: ["dojo:operator"],
    });
    const unbackedPublish = await dispatchDojoTool("synthi_dojo_publish_skill", {
      workspace_id: workspaceId,
      reason: "unbacked_publication_review",
      evidence_refs: ["evidence:unbacked-publication"],
      now: "2026-06-11T00:04:00.000Z",
      ...tenant,
    });
    expect(unbackedPublish?.isError).toBe(true);
    expect(unbackedPublish?.structuredContent).toEqual(expect.objectContaining({
      error: "dojo_skill_publication_evidence_ledger_resolution_failed",
      missing_evidence_record_ids: ["evidence:unbacked-publication"],
      blocked_by: ["evidence_record_missing:evidence:unbacked-publication"],
    }));

    const mismatchedSkillId = `${candidateSkill.skill_id}_other_${createHash("sha256").update(`${tenantId}:${workspaceId}:other-publication-skill`, "utf8").digest("hex").slice(0, 8)}`;
    await seedSkillForPublicationEvidenceScopeMismatch(pool, {
      tenant_id: tenantId,
      organization_id: "org-a",
      workspace_id: workspaceId,
      skill: {
        ...candidateSkill,
        skill_id: mismatchedSkillId,
        workflow_id: `${candidateSkill.workflow_id}_other_${createHash("sha256").update(`${tenantId}:${workspaceId}:other-publication-workflow`, "utf8").digest("hex").slice(0, 8)}`,
      },
    });
    const mismatchedEvidence = await appendPublicationEvidenceRecordForToolTest(pool, {
      tenant_id: tenantId,
      workspace_id: workspaceId,
      skill_id: mismatchedSkillId,
      record_id: `publication_${createHash("sha256").update(`${tenantId}:${workspaceId}:${mismatchedSkillId}:publish`, "utf8").digest("hex").slice(0, 16)}`,
      created_at: "2026-06-11T00:04:20.000Z",
      created_by: "postgres-publication-ledger-publisher",
      source_ref: "publication:wrong-skill-review",
    });
    const mismatchedPublish = await dispatchDojoTool("synthi_dojo_publish_skill", {
      workspace_id: workspaceId,
      reason: "wrong_skill_publication_review",
      evidence_refs: [mismatchedEvidence.record_id],
      now: "2026-06-11T00:04:40.000Z",
      ...tenant,
      request_id: "req-postgres-publication-ledger-mismatch",
      correlation_id: "corr-postgres-publication-ledger-mismatch",
    });
    expect(mismatchedPublish?.isError).toBe(true);
    expect(mismatchedPublish?.structuredContent).toEqual(expect.objectContaining({
      error: "dojo_skill_publication_evidence_ledger_scope_mismatch",
      mismatched_evidence_record_ids: [mismatchedEvidence.record_id],
      blocked_by: [`skill_publication_evidence_skill_mismatch:${mismatchedEvidence.record_id}`],
    }));

    const publicationEvidence = await appendPublicationEvidenceRecordForToolTest(pool, {
      tenant_id: tenantId,
      workspace_id: workspaceId,
      skill_id: candidateSkill.skill_id,
      record_id: `publication_${createHash("sha256").update(`${tenantId}:${workspaceId}:${candidateSkill.skill_id}:publish`, "utf8").digest("hex").slice(0, 16)}`,
      created_at: "2026-06-11T00:04:30.000Z",
      created_by: "postgres-publication-ledger-publisher",
      source_ref: "publication:operator-review",
    });
    const publish = await dispatchDojoTool("synthi_dojo_publish_skill", {
      workspace_id: workspaceId,
      reason: "integration_postgres_publication_ledger",
      evidence_refs: [publicationEvidence.record_id],
      now: "2026-06-11T00:05:00.000Z",
      ...tenant,
      request_id: "req-postgres-publication-ledger-backed",
      correlation_id: "corr-postgres-publication-ledger-backed",
    });
    expect(publish?.isError).toBeUndefined();
    const published = publish?.structuredContent as {
      skill: { skill_id: string; workflow_id: string };
      publication: {
        evidence_ledger_validation: {
          ok: boolean;
          store_kind: string;
          evidence_record_ids: string[];
          record_count: number;
        };
      };
    };
    expect(published.skill.skill_id).toBe(candidateSkill.skill_id);
    expect(published.publication.evidence_ledger_validation).toEqual(expect.objectContaining({
      store_kind: "postgres",
      record_count: 1,
      evidence_record_ids: [publicationEvidence.record_id],
    }));
    const [publicationEvidenceRecordId] = published.publication.evidence_ledger_validation.evidence_record_ids;
    expect(publicationEvidenceRecordId).toBe(publicationEvidence.record_id);

    const ledgerStore = new PostgresDojoEvidenceLedgerStore({
      tenant_id: tenantId,
      workspace_id: workspaceId,
      queryable: pool,
    });
    const records = await ledgerStore.listRecords();
    expect(records).toEqual(expect.arrayContaining([
      expect.objectContaining({
        record_id: publicationEvidenceRecordId,
        skill_id: candidateSkill.skill_id,
        workspace_id: workspaceId,
        kind: "audit",
        claim_ids: expect.arrayContaining(["skill_publication_reviewed", "publication_evidence_refs_recorded"]),
        source_refs: ["publication:operator-review"],
      }),
    ]));
  });

  it("reads aggregate production views from Postgres after local registry loss", async () => {
    const tenantId = `tenant_aggregate_${Date.now()}_${Math.random().toString(16).slice(2)}`;
    const workspaceId = `workspace_aggregate_${Math.random().toString(16).slice(2)}`;
    process.env.SYNTHI_DOJO_PRODUCTION_ENFORCEMENT = "1";
    process.env.SYNTHI_DOJO_REQUIRE_DURABLE_STORE = "1";
    process.env.SYNTHI_DOJO_CONTROL_PLANE_STORE = "postgres";
    process.env.SYNTHI_DOJO_CONTROL_PLANE_POSTGRES_URL = postgresUrl;

    recordOpenDetailsWorkflowForToolTest(workspaceId);
    const tenant = productionTenantContextArgs({
      tenant_id: tenantId,
      workspace_id: workspaceId,
      request_id: "req-postgres-aggregate-publish",
      correlation_id: "corr-postgres-aggregate-publish",
      actor_id: "postgres-aggregate-publisher",
      actor_type: "human",
      roles: ["dojo:operator"],
    });
    const publish = await dispatchDojoTool("synthi_dojo_publish_skill", {
      workspace_id: workspaceId,
      reason: "integration_postgres_aggregate_publish",
      evidence_refs: ["evidence:integration-postgres-aggregate-publish"],
      ...tenant,
    });
    expect(publish?.isError).toBeUndefined();
    const published = publish?.structuredContent as {
      skill: { skill_id: string; workflow_id: string };
    };

    dojoSkillRegistry.useStoreForTests(new InMemoryDojoSkillStore());
    dojoSkillRegistry.resetForTests();
    expect(dojoSkillRegistry.get(published.skill.skill_id)).toBeNull();

    const readerTenant = {
      ...tenant,
      actor_id: "postgres-aggregate-reader",
      actor_type: "agent",
      roles: ["agent", "dojo:governance:view"],
      request_id: "req-postgres-aggregate-read",
      correlation_id: "corr-postgres-aggregate-read",
    };

    const registry = await dispatchDojoTool("synthi_dojo_get_registry", readerTenant);
    expect(registry?.isError).toBeUndefined();
    expect(registry?.structuredContent).toEqual(expect.objectContaining({
      ok: true,
      control_plane_source: "postgres",
      registry: expect.objectContaining({
        skill_count: 1,
        competencies: [
          expect.objectContaining({
            skill_id: published.skill.skill_id,
            workspace_id: workspaceId,
          }),
        ],
      }),
      governance_service: expect.objectContaining({
        skill_registry: [
          expect.objectContaining({
            skill_id: published.skill.skill_id,
            workspace_id: workspaceId,
          }),
        ],
      }),
    }));

    const metrics = await dispatchDojoTool("synthi_dojo_get_metrics", {
      ...readerTenant,
      request_id: "req-postgres-aggregate-metrics",
      correlation_id: "corr-postgres-aggregate-metrics",
    });
    expect(metrics?.isError).toBeUndefined();
    expect(metrics?.structuredContent).toEqual(expect.objectContaining({
      ok: true,
      control_plane_source: "postgres",
      metrics: expect.objectContaining({
        skill_count: 1,
        business: expect.objectContaining({ published_skill_count: 1 }),
      }),
    }));

    const governance = await dispatchDojoTool("synthi_dojo_get_governance_report", {
      ...readerTenant,
      skill_id: published.skill.skill_id,
      request_id: "req-postgres-aggregate-governance",
      correlation_id: "corr-postgres-aggregate-governance",
    });
    expect(governance?.isError).toBeUndefined();
    expect(governance?.structuredContent).toEqual(expect.objectContaining({
      ok: true,
      control_plane_source: "postgres",
      skill_id: published.skill.skill_id,
      governance_service: expect.objectContaining({
        skill_registry: [
          expect.objectContaining({ skill_id: published.skill.skill_id }),
        ],
      }),
    }));

    const universe = await dispatchDojoTool("synthi_dojo_get_universe_dossier", {
      ...readerTenant,
      skill_id: published.skill.skill_id,
      request_id: "req-postgres-aggregate-universe",
      correlation_id: "corr-postgres-aggregate-universe",
    });
    expect(universe?.isError).toBeUndefined();
    expect(universe?.structuredContent).toEqual(expect.objectContaining({
      ok: true,
      control_plane_source: "postgres",
      skill_id: published.skill.skill_id,
      universe_dossier: expect.objectContaining({
        metrics: expect.objectContaining({ skill_count: 1 }),
      }),
    }));

    const durableReportTools = [
      ["synthi_dojo_get_skill_cortex", "skill_cortex"],
      ["synthi_dojo_get_workspace_organoid", "workspace_organoid"],
      ["synthi_dojo_get_wind_tunnel_report", "wind_tunnel"],
      ["synthi_dojo_get_counterfactual_twin", "counterfactual_twin"],
      ["synthi_dojo_get_evil_twin_report", "evil_twin"],
      ["synthi_dojo_get_training_report", "training_report"],
      ["synthi_dojo_get_skill_passport", "skill_passport"],
      ["synthi_dojo_get_skill_genome", "skill_genome"],
      ["synthi_dojo_get_antibodies", "antibodies"],
      ["synthi_dojo_get_agent_ready_ui_contract", "agent_ready_ui_contract"],
      ["synthi_dojo_get_cost_policy", "cost_control_policy"],
      ["synthi_dojo_get_lifecycle", "lifecycle"],
      ["synthi_dojo_get_source_affordance_pr_plan", "source_affordance_pr_plan"],
      ["synthi_dojo_get_skill_assurance_case", "assurance_case"],
      ["synthi_dojo_get_entrustment_level", "entrustment_level"],
      ["synthi_dojo_get_license", "license"],
      ["synthi_dojo_get_guardrails", "guardrails"],
      ["synthi_dojo_get_case_law", "case_law"],
    ] as const;
    for (const [toolName, expectedField] of durableReportTools) {
      const report = await dispatchDojoTool(toolName, {
        ...readerTenant,
        skill_id: published.skill.skill_id,
        request_id: `req-postgres-aggregate-${toolName}`,
        correlation_id: `corr-postgres-aggregate-${toolName}`,
      });
      expect(report?.isError, toolName).toBeUndefined();
      const structured = report?.structuredContent as Record<string, unknown>;
      expect(structured, toolName).toEqual(expect.objectContaining({
        ok: true,
        control_plane_source: "postgres",
        skill_id: published.skill.skill_id,
      }));
      expect(structured[expectedField], `${toolName} payload`).toBeDefined();
    }

    const explainBlock = await dispatchDojoTool("synthi_dojo_explain_block", {
      ...readerTenant,
      skill_id: published.skill.skill_id,
      requested_action: "open_details",
      request_id: "req-postgres-aggregate-explain-block",
      correlation_id: "corr-postgres-aggregate-explain-block",
    });
    expect(explainBlock?.isError).toBeUndefined();
    expect(explainBlock?.structuredContent).toEqual(expect.objectContaining({
      ok: false,
      control_plane_source: "postgres",
      requested_action: "open_details",
      validation: expect.objectContaining({
        error_codes: expect.arrayContaining(["proof_capsule_missing"]),
      }),
    }));

    const artifacts = await dispatchDojoTool("synthi_dojo_export_artifacts", {
      ...readerTenant,
      roles: ["agent", "dojo:artifact:export"],
      skill_id: published.skill.skill_id,
      request_id: "req-postgres-aggregate-artifacts",
      correlation_id: "corr-postgres-aggregate-artifacts",
    });
    expect(artifacts?.isError).toBeUndefined();
    expect(artifacts?.structuredContent).toEqual(expect.objectContaining({
      ok: true,
      control_plane_source: "postgres",
      skill_id: published.skill.skill_id,
      artifact_count: expect.any(Number),
      rbac_authorization: expect.objectContaining({
        action: "artifact_export",
        matched_roles: ["dojo:artifact:export"],
      }),
    }));

    const compliance = await dispatchDojoTool("synthi_dojo_export_compliance_pack", {
      ...readerTenant,
      roles: ["agent", "dojo:compliance:export"],
      request_id: "req-postgres-aggregate-compliance",
      correlation_id: "corr-postgres-aggregate-compliance",
      now: "2026-06-11T02:00:00.000Z",
    });
    expect(compliance?.isError).toBeUndefined();
    expect(compliance?.structuredContent).toEqual(expect.objectContaining({
      ok: true,
      pack: expect.objectContaining({
        skill_ids: [published.skill.skill_id],
        workspace_ids: [workspaceId],
      }),
      governance_service: expect.objectContaining({
        skill_registry: [
          expect.objectContaining({ skill_id: published.skill.skill_id }),
        ],
      }),
      artifact_count: expect.any(Number),
    }));
  });

  it("blocks raw browser workflow replay using durable published bindings after local registry loss", async () => {
    const tenantId = `tenant_raw_gate_${Date.now()}_${Math.random().toString(16).slice(2)}`;
    const workspaceId = `workspace_raw_gate_${Math.random().toString(16).slice(2)}`;
    process.env.SYNTHI_DOJO_PRODUCTION_ENFORCEMENT = "1";
    process.env.SYNTHI_DOJO_REQUIRE_DURABLE_STORE = "1";
    process.env.SYNTHI_DOJO_CONTROL_PLANE_STORE = "postgres";
    process.env.SYNTHI_DOJO_CONTROL_PLANE_POSTGRES_URL = postgresUrl;

    recordOpenDetailsWorkflowForToolTest(workspaceId);
    const tenant = productionTenantContextArgs({
      tenant_id: tenantId,
      workspace_id: workspaceId,
      request_id: "req-postgres-raw-gate-publish",
      correlation_id: "corr-postgres-raw-gate-publish",
      actor_id: "postgres-raw-gate-publisher",
      actor_type: "human",
      roles: ["dojo:operator"],
    });
    const publish = await dispatchDojoTool("synthi_dojo_publish_skill", {
      workspace_id: workspaceId,
      reason: "integration_postgres_raw_gate_publish",
      evidence_refs: ["evidence:integration-postgres-raw-gate-publish"],
      ...tenant,
    });
    expect(publish?.isError).toBeUndefined();
    const published = publish?.structuredContent as {
      skill: { skill_id: string; workflow_id: string };
    };

    dojoSkillRegistry.useStoreForTests(new InMemoryDojoSkillStore());
    dojoSkillRegistry.resetForTests();
    expect(dojoSkillRegistry.getPublishedWorkflowBindingByWorkflowId(published.skill.workflow_id)).toBeNull();

    const lease = browserBroker.acquireLease("postgres-raw-gate-agent", 5000, "dojo-postgres-raw-workflow-gate");
    const rawReplay = await dispatchBrowserTool("synthi_browser_run_workflow", {
      ...tenant,
      actor_id: "postgres-raw-gate-agent",
      actor_type: "agent",
      roles: ["agent"],
      request_id: "req-postgres-raw-gate-run",
      correlation_id: "corr-postgres-raw-gate-run",
      lease_id: lease.lease_id,
      tab_id: "tab-a",
      workflow_id: published.skill.workflow_id,
      mode: "sameSession",
    });
    browserBroker.releaseLease(lease.lease_id, "dojo-postgres-raw-workflow-gate:complete");

    expect(rawReplay?.isError).toBe(true);
    expect(rawReplay?.structuredContent).toEqual(expect.objectContaining({
      error: "dojo_proof_capsule_required",
      workflow_id: published.skill.workflow_id,
      blocked_by: ["direct_entrypoint_for_published_skill", "dojo_proof_capsule_required"],
      dojo_execution_policy: expect.objectContaining({
        ok: false,
        enforcement_mode: "production",
        entrypoint: "browser_workflow",
        skill_id: published.skill.skill_id,
      }),
      dojo_binding_resolution: expect.objectContaining({
        status: "published",
        source: "postgres",
        skill_id: published.skill.skill_id,
        workflow_id: published.skill.workflow_id,
      }),
    }));

    const generatedScript = await dispatchBrowserTool("synthi_browser_generate_script", {
      ...tenant,
      actor_id: "postgres-raw-gate-agent",
      actor_type: "agent",
      roles: ["agent"],
      request_id: "req-postgres-raw-gate-script",
      correlation_id: "corr-postgres-raw-gate-script",
      workflow_id: published.skill.workflow_id,
    });
    expect(generatedScript?.isError).toBeUndefined();
    expect(generatedScript?.structuredContent).toEqual(expect.objectContaining({
      artifact_execution_policy: expect.objectContaining({
        source: "postgres",
        status: "practice_only",
        skill_id: published.skill.skill_id,
        workflow_id: published.skill.workflow_id,
      }),
    }));
  });

  it("revokes production licenses through Postgres and reads revoked license health after local reset", async () => {
    const tenantId = `tenant_revoke_${Date.now()}_${Math.random().toString(16).slice(2)}`;
    const workspaceId = `workspace_revoke_${Math.random().toString(16).slice(2)}`;
    process.env.SYNTHI_DOJO_PRODUCTION_ENFORCEMENT = "1";
    process.env.SYNTHI_DOJO_REQUIRE_DURABLE_STORE = "1";
    process.env.SYNTHI_DOJO_CONTROL_PLANE_STORE = "postgres";
    process.env.SYNTHI_DOJO_CONTROL_PLANE_POSTGRES_URL = postgresUrl;

    recordOpenDetailsWorkflowForToolTest(workspaceId);
    const tenant = productionTenantContextArgs({
      tenant_id: tenantId,
      workspace_id: workspaceId,
      request_id: "req-postgres-revoke-publish",
      correlation_id: "corr-postgres-revoke-publish",
      actor_id: "postgres-revoke-publisher",
      actor_type: "human",
      roles: ["dojo:operator"],
    });
    const publish = await dispatchDojoTool("synthi_dojo_publish_skill", {
      workspace_id: workspaceId,
      reason: "integration_postgres_revoke_publish",
      evidence_refs: ["evidence:integration-postgres-revoke-publish"],
      ...tenant,
    });
    expect(publish?.isError).toBeUndefined();
    const published = publish?.structuredContent as {
      skill: { skill_id: string; workflow_id: string };
      license: { license_id: string; license_version: string };
    };

    const revoke = await dispatchDojoTool("synthi_dojo_revoke_license", {
      skill_id: published.skill.skill_id,
      reason: "integration_policy_change",
      actor_id: "postgres-license-reviewer",
      actor_type: "human",
      evidence_refs: ["evidence:integration-postgres-license-revocation"],
      ...tenant,
      request_id: "req-postgres-revoke-license",
      correlation_id: "corr-postgres-revoke-license",
      now: "2026-06-11T01:00:00.000Z",
    });
    expect(revoke?.isError).toBeUndefined();
    expect(revoke?.structuredContent).toEqual(expect.objectContaining({
      ok: true,
      control_plane_source: "postgres",
      control_plane_persistence: expect.objectContaining({
        ok: true,
        store_kind: "postgres",
        skill_id: published.skill.skill_id,
        skill_status: "revoked",
        license_status: "revoked",
        revoked_at: "2026-06-11T01:00:00.000Z",
      }),
      license: expect.objectContaining({
        license_id: published.license.license_id,
        entrustment_level: "EX",
        autonomy_level: "blocked",
      }),
      revocation: expect.objectContaining({
        previous_license_version: published.license.license_version,
        audit_event: expect.objectContaining({
          reason: "integration_policy_change",
          evidence_refs: ["evidence:integration-postgres-license-revocation"],
        }),
      }),
    }));
    const revokedContent = revoke?.structuredContent as {
      license: { license_id: string; license_version: string; autonomy_level: string };
    };

    const licenseStore = new PostgresDojoLicenseStore({
      tenant_id: tenantId,
      workspace_id: workspaceId,
      queryable: pool,
    });
    await expect(licenseStore.getLicense(published.license.license_id)).resolves.toEqual(expect.objectContaining({
      status: "revoked",
      license_version: revokedContent.license.license_version,
      revoked_at: "2026-06-11T01:00:00.000Z",
      revoked_reason: "integration_policy_change",
      license_json: expect.objectContaining({
        autonomy_level: "blocked",
        entrustment_level: "EX",
      }),
    }));

    const skillStore = new PostgresDojoSkillStore({
      tenant_id: tenantId,
      workspace_id: workspaceId,
      queryable: pool,
    });
    await expect(skillStore.getSkill(published.skill.skill_id)).resolves.toEqual(expect.objectContaining({
      skill_id: published.skill.skill_id,
      entrustment_level: "EX",
      permission_license: expect.objectContaining({
        autonomy_level: "blocked",
        license_version: revokedContent.license.license_version,
      }),
    }));

    dojoSkillRegistry.useStoreForTests(new InMemoryDojoSkillStore());
    dojoSkillRegistry.resetForTests();
    expect(dojoSkillRegistry.get(published.skill.skill_id)).toBeNull();

    const health = await dispatchDojoTool("synthi_dojo_get_license_health", {
      skill_id: published.skill.skill_id,
      ...tenant,
      actor_id: "postgres-revoke-reader",
      actor_type: "agent",
      roles: ["agent"],
      request_id: "req-postgres-revoked-health",
      correlation_id: "corr-postgres-revoked-health",
    });
    expect(health?.isError).toBeUndefined();
    expect(health?.structuredContent).toEqual(expect.objectContaining({
      ok: true,
      control_plane_source: "postgres",
      skill_id: published.skill.skill_id,
      license_health: expect.objectContaining({
        status: "blocked",
        entrustment_level: "EX",
      }),
    }));
    expect(dojoSkillRegistry.get(published.skill.skill_id)).toBeNull();
  });

  it("requires ledger-backed license revocation evidence when production evidence ledger is enforced", async () => {
    const tenantId = `tenant_revoke_ledger_${Date.now()}_${Math.random().toString(16).slice(2)}`;
    const workspaceId = `workspace_revoke_ledger_${Math.random().toString(16).slice(2)}`;
    process.env.SYNTHI_DOJO_PRODUCTION_ENFORCEMENT = "1";
    process.env.SYNTHI_DOJO_REQUIRE_DURABLE_STORE = "1";
    process.env.SYNTHI_DOJO_REQUIRE_EVIDENCE_LEDGER = "1";
    process.env.SYNTHI_DOJO_CONTROL_PLANE_STORE = "postgres";
    process.env.SYNTHI_DOJO_CONTROL_PLANE_POSTGRES_URL = postgresUrl;
    process.env.SYNTHI_DOJO_EVIDENCE_LEDGER_STORE = "postgres";
    process.env.SYNTHI_DOJO_EVIDENCE_LEDGER_POSTGRES_URL = postgresUrl;

    recordOpenDetailsWorkflowForToolTest(workspaceId);
    const tenant = productionTenantContextArgs({
      tenant_id: tenantId,
      workspace_id: workspaceId,
      request_id: "req-postgres-revoke-ledger-publish",
      correlation_id: "corr-postgres-revoke-ledger-publish",
      actor_id: "postgres-revoke-ledger-publisher",
      actor_type: "human",
      roles: ["dojo:operator"],
    });
    const publicationEvidence = await appendPublicationEvidenceForCurrentWorkflowForToolTest(pool, {
      tenant_id: tenantId,
      workspace_id: workspaceId,
      record_id: `publication_${createHash("sha256").update(`${tenantId}:${workspaceId}:license-revocation-publish`, "utf8").digest("hex").slice(0, 16)}`,
      created_at: "2026-06-11T01:19:00.000Z",
      created_by: "postgres-revoke-ledger-publisher",
      source_ref: "publication:license-revocation-setup",
    });
    const publish = await dispatchDojoTool("synthi_dojo_publish_skill", {
      workspace_id: workspaceId,
      reason: "integration_postgres_revoke_ledger_publish",
      evidence_refs: [publicationEvidence.record.record_id],
      ...tenant,
    });
    expect(publish?.isError).toBeUndefined();
    const published = publish?.structuredContent as {
      skill: { skill_id: string; workflow_id: string };
      license: { license_id: string; license_version: string };
      publication: {
        evidence_policy: {
          require_evidence_ledger: boolean;
          evidence_backed: boolean;
          evidence_ledger_store_kind: string;
        };
      };
    };
    expect(published.publication.evidence_policy).toEqual(expect.objectContaining({
      require_evidence_ledger: true,
      evidence_backed: true,
      evidence_ledger_store_kind: "postgres",
    }));

    dojoSkillRegistry.useStoreForTests(new InMemoryDojoSkillStore());
    dojoSkillRegistry.resetForTests();
    expect(dojoSkillRegistry.get(published.skill.skill_id)).toBeNull();

    const unbackedRevoke = await dispatchDojoTool("synthi_dojo_revoke_license", {
      ...tenant,
      skill_id: published.skill.skill_id,
      reason: "unbacked_policy_change",
      actor_id: "postgres-revoke-ledger-reviewer",
      actor_type: "human",
      evidence_refs: ["evidence:unbacked-license-revocation"],
      request_id: "req-postgres-revoke-ledger-unbacked",
      correlation_id: "corr-postgres-revoke-ledger-unbacked",
      now: "2026-06-11T01:20:00.000Z",
    });
    expect(unbackedRevoke?.isError).toBe(true);
    expect(unbackedRevoke?.structuredContent).toEqual(expect.objectContaining({
      error: "dojo_license_revocation_evidence_ledger_resolution_failed",
      missing_evidence_record_ids: ["evidence:unbacked-license-revocation"],
      blocked_by: ["evidence_record_missing:evidence:unbacked-license-revocation"],
    }));

    const licenseStore = new PostgresDojoLicenseStore({
      tenant_id: tenantId,
      workspace_id: workspaceId,
      queryable: pool,
    });
    await expect(licenseStore.getLicense(published.license.license_id)).resolves.toEqual(expect.objectContaining({
      status: "active",
      license_version: published.license.license_version,
    }));

    const revocationEvidence = await appendGovernanceEvidenceRecordForToolTest(pool, {
      tenant_id: tenantId,
      workspace_id: workspaceId,
      skill_id: published.skill.skill_id,
      record_id: `license_revocation_${createHash("sha256").update(`${tenantId}:${workspaceId}:${published.skill.skill_id}:revocation`, "utf8").digest("hex").slice(0, 16)}`,
      created_at: "2026-06-11T01:21:00.000Z",
      created_by: "postgres-revoke-ledger-reviewer",
      source_ref: "license:revocation",
      kind: "license",
      run_id_prefix: "license_revocation",
      claim_ids: ["license_revocation_reviewed"],
    });

    const revoke = await dispatchDojoTool("synthi_dojo_revoke_license", {
      ...tenant,
      skill_id: published.skill.skill_id,
      reason: "ledger_backed_policy_change",
      actor_id: "postgres-revoke-ledger-reviewer",
      actor_type: "human",
      evidence_refs: [revocationEvidence.record_id],
      request_id: "req-postgres-revoke-ledger",
      correlation_id: "corr-postgres-revoke-ledger",
      now: "2026-06-11T01:25:00.000Z",
    });
    expect(revoke?.isError).toBeUndefined();
    expect(revoke?.structuredContent).toEqual(expect.objectContaining({
      ok: true,
      control_plane_source: "postgres",
      evidence_ledger_validation: expect.objectContaining({
        store_kind: "postgres",
        evidence_record_ids: [revocationEvidence.record_id],
        record_count: 1,
      }),
      license: expect.objectContaining({
        license_id: published.license.license_id,
        entrustment_level: "EX",
        autonomy_level: "blocked",
      }),
      revocation: expect.objectContaining({
        audit_event: expect.objectContaining({
          reason: "ledger_backed_policy_change",
          evidence_refs: [revocationEvidence.record_id],
        }),
      }),
    }));
    await expect(licenseStore.getLicense(published.license.license_id)).resolves.toEqual(expect.objectContaining({
      status: "revoked",
      revoked_reason: "ledger_backed_policy_change",
      license_json: expect.objectContaining({
        autonomy_level: "blocked",
        entrustment_level: "EX",
      }),
    }));
  });

  it("requires ledger-backed proof capsule revocation evidence when production evidence ledger is enforced", async () => {
    const tenantId = `tenant_proof_revoke_ledger_${Date.now()}_${Math.random().toString(16).slice(2)}`;
    const workspaceId = `workspace_proof_revoke_ledger_${Math.random().toString(16).slice(2)}`;
    process.env.SYNTHI_DOJO_PRODUCTION_ENFORCEMENT = "1";
    process.env.SYNTHI_DOJO_REQUIRE_DURABLE_STORE = "1";
    process.env.SYNTHI_DOJO_REQUIRE_EVIDENCE_LEDGER = "1";
    process.env.SYNTHI_DOJO_CONTROL_PLANE_STORE = "postgres";
    process.env.SYNTHI_DOJO_CONTROL_PLANE_POSTGRES_URL = postgresUrl;
    process.env.SYNTHI_DOJO_EVIDENCE_LEDGER_STORE = "postgres";
    process.env.SYNTHI_DOJO_EVIDENCE_LEDGER_POSTGRES_URL = postgresUrl;

    recordOpenDetailsWorkflowForToolTest(workspaceId);
    const tenant = productionTenantContextArgs({
      tenant_id: tenantId,
      workspace_id: workspaceId,
      request_id: "req-postgres-proof-revoke-ledger-publish",
      correlation_id: "corr-postgres-proof-revoke-ledger-publish",
      actor_id: "postgres-proof-revoke-ledger-publisher",
      actor_type: "human",
      roles: ["dojo:operator"],
    });
    const publicationEvidence = await appendPublicationEvidenceForCurrentWorkflowForToolTest(pool, {
      tenant_id: tenantId,
      workspace_id: workspaceId,
      record_id: `publication_${createHash("sha256").update(`${tenantId}:${workspaceId}:proof-revocation-publish`, "utf8").digest("hex").slice(0, 16)}`,
      created_at: "2026-06-11T01:28:00.000Z",
      created_by: "postgres-proof-revoke-ledger-publisher",
      source_ref: "publication:proof-revocation-setup",
    });
    const publish = await dispatchDojoTool("synthi_dojo_publish_skill", {
      workspace_id: workspaceId,
      reason: "integration_postgres_proof_revoke_ledger_publish",
      evidence_refs: [publicationEvidence.record.record_id],
      ...tenant,
    });
    expect(publish?.isError).toBeUndefined();
    const published = publish?.structuredContent as {
      skill: { skill_id: string; workflow_id: string };
    };
    const skill = dojoSkillRegistry.get(published.skill.skill_id);
    expect(skill).toBeTruthy();

    const proofClaimIds = [...new Set([
      ...skill!.permission_license.proof_requirements.required_evidence_claims,
      ...skill!.permission_license.proof_requirements.required_context_claims,
    ])];
    const proofEvidence = await appendGovernanceEvidenceRecordForToolTest(pool, {
      tenant_id: tenantId,
      workspace_id: workspaceId,
      skill_id: published.skill.skill_id,
      record_id: `proof_issue_${createHash("sha256").update(`${tenantId}:${workspaceId}:${published.skill.skill_id}:proof-issue`, "utf8").digest("hex").slice(0, 16)}`,
      created_at: "2026-06-11T01:29:00.000Z",
      created_by: "postgres-proof-revoke-ledger-agent",
      source_ref: "proof:issue",
      kind: "checkride",
      run_id_prefix: "proof_issue",
      claim_ids: proofClaimIds,
    });
    const issue = await dispatchDojoTool("synthi_dojo_issue_proof_capsule", {
      skill_id: published.skill.skill_id,
      requested_action: "run_prefix_validation",
      context_claims: { workspace_verified: true },
      evidence_record_ids: [proofEvidence.record_id],
      ledger_checkpoint_hash: proofEvidence.ledger_head_hash,
      ...tenant,
      actor_id: "postgres-proof-revoke-ledger-agent",
      actor_type: "agent",
      roles: ["agent", "dojo:proof:issue"],
      request_id: "req-postgres-proof-revoke-ledger-issue",
      correlation_id: "corr-postgres-proof-revoke-ledger-issue",
      now: "2026-06-11T01:30:00.000Z",
      expires_at: "2026-06-11T01:45:00.000Z",
    });
    expect(issue?.isError).toBeUndefined();
    const issued = issue?.structuredContent as {
      proof_capsule: { capsule_id: string };
      proof_record: { status: string };
    };
    expect(issued.proof_record).toEqual(expect.objectContaining({ status: "issued" }));

    const proofStore = new PostgresDojoProofStore({
      tenant_id: tenantId,
      workspace_id: workspaceId,
      queryable: pool,
    });
    await expect(proofStore.getProofRecord(issued.proof_capsule.capsule_id)).resolves.toEqual(expect.objectContaining({
      capsule_id: issued.proof_capsule.capsule_id,
      status: "issued",
      skill_id: published.skill.skill_id,
    }));

    dojoSkillRegistry.useStoreForTests(new InMemoryDojoSkillStore());
    dojoSkillRegistry.resetForTests();
    expect(dojoSkillRegistry.get(published.skill.skill_id)).toBeNull();
    expect(dojoSkillRegistry.getProofRecord(issued.proof_capsule.capsule_id)).toBeNull();

    const unbackedRevoke = await dispatchDojoTool("synthi_dojo_revoke_proof_capsule", {
      ...tenant,
      capsule_id: issued.proof_capsule.capsule_id,
      reason: "unbacked_proof_policy_change",
      actor_id: "postgres-proof-revoke-ledger-reviewer",
      actor_type: "human",
      evidence_refs: ["evidence:unbacked-proof-revocation"],
      request_id: "req-postgres-proof-revoke-ledger-unbacked",
      correlation_id: "corr-postgres-proof-revoke-ledger-unbacked",
      now: "2026-06-11T01:31:00.000Z",
    });
    expect(unbackedRevoke?.isError).toBe(true);
    expect(unbackedRevoke?.structuredContent).toEqual(expect.objectContaining({
      error: "dojo_proof_capsule_revocation_evidence_ledger_resolution_failed",
      missing_evidence_record_ids: ["evidence:unbacked-proof-revocation"],
      blocked_by: ["evidence_record_missing:evidence:unbacked-proof-revocation"],
    }));
    await expect(proofStore.getProofRecord(issued.proof_capsule.capsule_id)).resolves.toEqual(expect.objectContaining({
      status: "issued",
    }));

    const revocationEvidence = await appendGovernanceEvidenceRecordForToolTest(pool, {
      tenant_id: tenantId,
      workspace_id: workspaceId,
      skill_id: published.skill.skill_id,
      record_id: `proof_revocation_${createHash("sha256").update(`${tenantId}:${workspaceId}:${published.skill.skill_id}:proof-revocation`, "utf8").digest("hex").slice(0, 16)}`,
      created_at: "2026-06-11T01:32:00.000Z",
      created_by: "postgres-proof-revoke-ledger-reviewer",
      source_ref: "proof:revocation",
      kind: "proof",
      run_id_prefix: "proof_revocation",
      claim_ids: ["proof_revocation_reviewed"],
    });

    const revoke = await dispatchDojoTool("synthi_dojo_revoke_proof_capsule", {
      ...tenant,
      capsule_id: issued.proof_capsule.capsule_id,
      reason: "ledger_backed_proof_policy_change",
      actor_id: "postgres-proof-revoke-ledger-reviewer",
      actor_type: "human",
      evidence_refs: [revocationEvidence.record_id],
      request_id: "req-postgres-proof-revoke-ledger",
      correlation_id: "corr-postgres-proof-revoke-ledger",
      now: "2026-06-11T01:35:00.000Z",
    });
    expect(revoke?.isError).toBeUndefined();
    expect(revoke?.structuredContent).toEqual(expect.objectContaining({
      ok: true,
      control_plane_source: "postgres",
      evidence_ledger_validation: expect.objectContaining({
        store_kind: "postgres",
        evidence_record_ids: [revocationEvidence.record_id],
        record_count: 1,
      }),
      proof_record: expect.objectContaining({
        capsule_id: issued.proof_capsule.capsule_id,
        status: "revoked",
        revoked_at: "2026-06-11T01:35:00.000Z",
        revoked_reason: "ledger_backed_proof_policy_change",
        revocation_evidence_refs: [revocationEvidence.record_id],
      }),
    }));
    await expect(proofStore.getProofRecord(issued.proof_capsule.capsule_id)).resolves.toEqual(expect.objectContaining({
      status: "revoked",
      revoked_at: "2026-06-11T01:35:00.000Z",
      revoked_reason: "ledger_backed_proof_policy_change",
      revocation_evidence_refs: [revocationEvidence.record_id],
    }));
  });

  it("recertifies a production skill through Postgres after local reset", async () => {
    const tenantId = `tenant_recert_${Date.now()}_${Math.random().toString(16).slice(2)}`;
    const workspaceId = `workspace_recert_${Math.random().toString(16).slice(2)}`;
    process.env.SYNTHI_DOJO_PRODUCTION_ENFORCEMENT = "1";
    process.env.SYNTHI_DOJO_REQUIRE_DURABLE_STORE = "1";
    process.env.SYNTHI_DOJO_CONTROL_PLANE_STORE = "postgres";
    process.env.SYNTHI_DOJO_CONTROL_PLANE_POSTGRES_URL = postgresUrl;

    recordOpenDetailsWorkflowForToolTest(workspaceId);
    const tenant = productionTenantContextArgs({
      tenant_id: tenantId,
      workspace_id: workspaceId,
      request_id: "req-postgres-recert-publish",
      correlation_id: "corr-postgres-recert-publish",
      actor_id: "postgres-recert-publisher",
      actor_type: "human",
      roles: ["dojo:operator"],
    });
    const publish = await dispatchDojoTool("synthi_dojo_publish_skill", {
      workspace_id: workspaceId,
      reason: "integration_postgres_recert_publish",
      evidence_refs: ["evidence:integration-postgres-recert-publish"],
      ...tenant,
    });
    expect(publish?.isError).toBeUndefined();
    const published = publish?.structuredContent as {
      skill: { skill_id: string; workflow_id: string };
      license: { license_id: string; license_version: string };
    };

    dojoSkillRegistry.useStoreForTests(new InMemoryDojoSkillStore());
    dojoSkillRegistry.resetForTests();
    expect(dojoSkillRegistry.get(published.skill.skill_id)).toBeNull();

    const recertified = await dispatchDojoTool("synthi_dojo_recertify_skill", {
      ...tenant,
      skill_id: published.skill.skill_id,
      reason: "integration_postgres_recertification",
      evidence_refs: ["evidence:integration-postgres-recertification"],
      actor_id: "postgres-recertifier",
      actor_type: "human",
      roles: ["dojo:operator"],
      request_id: "req-postgres-recertify",
      correlation_id: "corr-postgres-recertify",
      now: "2026-06-11T01:30:00.000Z",
    });
    expect(recertified?.isError).toBeUndefined();
    expect(recertified?.structuredContent).toEqual(expect.objectContaining({
      ok: true,
      control_plane_source: "postgres",
      skill: expect.objectContaining({
        skill_id: published.skill.skill_id,
        executable_entrustment: expect.objectContaining({
          schema_version: "synthi.dojo.executableEntrustmentSnapshot.v1",
          source: "recertification",
          checkride_id: expect.any(String),
          evidence_refs: expect.any(Array),
        }),
      }),
      recertification: expect.objectContaining({
        status: "applied",
        reason: "integration_postgres_recertification",
        evidence_refs: ["evidence:integration-postgres-recertification"],
        previous_license_version: published.license.license_version,
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
        control_plane_persistence: expect.objectContaining({
          ok: true,
          store_kind: "postgres",
          skill_id: published.skill.skill_id,
          workflow_id: published.skill.workflow_id,
          audit_event_id: expect.any(String),
        }),
      }),
    }));
    const recertContent = recertified?.structuredContent as {
      license: {
        license_id: string;
        license_version: string;
        allowed_actions: Array<{ action: string; constraints: string[] }>;
      };
      recertification: { control_plane_persistence: { audit_event_id: string } };
    };
    expect(recertContent.license.allowed_actions).toEqual(expect.arrayContaining([
      expect.objectContaining({
        action: "run_workflow",
        constraints: expect.arrayContaining(["executable_checkride_constrained"]),
      }),
    ]));

    const skillStore = new PostgresDojoSkillStore({
      tenant_id: tenantId,
      workspace_id: workspaceId,
      queryable: pool,
    });
    await expect(skillStore.getSkill(published.skill.skill_id)).resolves.toEqual(expect.objectContaining({
      skill_id: published.skill.skill_id,
      workflow_id: published.skill.workflow_id,
      checkride: expect.objectContaining({
        started_at: "2026-06-11T01:30:00.000Z",
      }),
      permission_license: expect.objectContaining({
        license_id: recertContent.license.license_id,
        license_version: recertContent.license.license_version,
      }),
    }));

    const licenseStore = new PostgresDojoLicenseStore({
      tenant_id: tenantId,
      workspace_id: workspaceId,
      queryable: pool,
    });
    await expect(licenseStore.getLicense(recertContent.license.license_id)).resolves.toEqual(expect.objectContaining({
      skill_id: published.skill.skill_id,
      status: "active",
      license_version: recertContent.license.license_version,
    }));

    const auditStore = new PostgresDojoAuditStore({
      tenant_id: tenantId,
      workspace_id: workspaceId,
      queryable: pool,
    });
    await expect(auditStore.listAuditEvents({ entity_id: published.skill.skill_id })).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({
        audit_event_id: recertContent.recertification.control_plane_persistence.audit_event_id,
        event_type: "checkride_run_completed",
        correlation_id: "corr-postgres-recertify",
        details: expect.objectContaining({
          reason: "integration_postgres_recertification",
          evidence_refs: ["evidence:integration-postgres-recertification"],
        }),
      }),
    ]));
    expect(dojoSkillRegistry.get(published.skill.skill_id)).toBeNull();
  });

  it("requires ledger-backed recertification evidence when production evidence ledger is enforced", async () => {
    const tenantId = `tenant_recert_ledger_${Date.now()}_${Math.random().toString(16).slice(2)}`;
    const workspaceId = `workspace_recert_ledger_${Math.random().toString(16).slice(2)}`;
    process.env.SYNTHI_DOJO_PRODUCTION_ENFORCEMENT = "1";
    process.env.SYNTHI_DOJO_REQUIRE_DURABLE_STORE = "1";
    process.env.SYNTHI_DOJO_REQUIRE_EVIDENCE_LEDGER = "1";
    process.env.SYNTHI_DOJO_CONTROL_PLANE_STORE = "postgres";
    process.env.SYNTHI_DOJO_CONTROL_PLANE_POSTGRES_URL = postgresUrl;
    process.env.SYNTHI_DOJO_EVIDENCE_LEDGER_STORE = "postgres";
    process.env.SYNTHI_DOJO_EVIDENCE_LEDGER_POSTGRES_URL = postgresUrl;

    recordOpenDetailsWorkflowForToolTest(workspaceId);
    const tenant = productionTenantContextArgs({
      tenant_id: tenantId,
      workspace_id: workspaceId,
      request_id: "req-postgres-recert-ledger-publish",
      correlation_id: "corr-postgres-recert-ledger-publish",
      actor_id: "postgres-recert-ledger-publisher",
      actor_type: "human",
      roles: ["dojo:operator"],
    });
    const publicationEvidence = await appendPublicationEvidenceForCurrentWorkflowForToolTest(pool, {
      tenant_id: tenantId,
      workspace_id: workspaceId,
      record_id: `publication_${createHash("sha256").update(`${tenantId}:${workspaceId}:recertification-publish`, "utf8").digest("hex").slice(0, 16)}`,
      created_at: "2026-06-11T01:38:00.000Z",
      created_by: "postgres-recert-ledger-publisher",
      source_ref: "publication:recertification-setup",
    });
    const publish = await dispatchDojoTool("synthi_dojo_publish_skill", {
      workspace_id: workspaceId,
      reason: "integration_postgres_recert_ledger_publish",
      evidence_refs: [publicationEvidence.record.record_id],
      ...tenant,
    });
    expect(publish?.isError).toBeUndefined();
    const published = publish?.structuredContent as {
      skill: { skill_id: string; workflow_id: string };
      license: { license_id: string; license_version: string };
      publication: {
        evidence_policy: {
          require_evidence_ledger: boolean;
          evidence_backed: boolean;
          evidence_ledger_store_kind: string;
        };
      };
    };
    expect(published.publication.evidence_policy).toEqual(expect.objectContaining({
      require_evidence_ledger: true,
      evidence_backed: true,
      evidence_ledger_store_kind: "postgres",
    }));

    dojoSkillRegistry.useStoreForTests(new InMemoryDojoSkillStore());
    dojoSkillRegistry.resetForTests();
    expect(dojoSkillRegistry.get(published.skill.skill_id)).toBeNull();

    const unbackedRecertification = await dispatchDojoTool("synthi_dojo_recertify_skill", {
      ...tenant,
      skill_id: published.skill.skill_id,
      reason: "unbacked_recertification_review",
      evidence_refs: ["evidence:unbacked-recertification"],
      actor_id: "postgres-recert-ledger-reviewer",
      actor_type: "human",
      roles: ["dojo:operator"],
      request_id: "req-postgres-recert-ledger-unbacked",
      correlation_id: "corr-postgres-recert-ledger-unbacked",
      now: "2026-06-11T01:40:00.000Z",
    });
    expect(unbackedRecertification?.isError).toBe(true);
    expect(unbackedRecertification?.structuredContent).toEqual(expect.objectContaining({
      error: "dojo_recertification_evidence_ledger_resolution_failed",
      missing_evidence_record_ids: ["evidence:unbacked-recertification"],
      blocked_by: ["evidence_record_missing:evidence:unbacked-recertification"],
    }));

    const licenseStore = new PostgresDojoLicenseStore({
      tenant_id: tenantId,
      workspace_id: workspaceId,
      queryable: pool,
    });
    await expect(licenseStore.getLicense(published.license.license_id)).resolves.toEqual(expect.objectContaining({
      status: "active",
      license_version: published.license.license_version,
    }));

    const recertificationEvidence = await appendGovernanceEvidenceRecordForToolTest(pool, {
      tenant_id: tenantId,
      workspace_id: workspaceId,
      skill_id: published.skill.skill_id,
      record_id: `recertification_${createHash("sha256").update(`${tenantId}:${workspaceId}:${published.skill.skill_id}:recertification`, "utf8").digest("hex").slice(0, 16)}`,
      created_at: "2026-06-11T01:41:00.000Z",
      created_by: "postgres-recert-ledger-reviewer",
      source_ref: "recertification:review",
      kind: "checkride",
      run_id_prefix: "recertification",
      claim_ids: ["recertification_reviewed"],
    });

    const recertified = await dispatchDojoTool("synthi_dojo_recertify_skill", {
      ...tenant,
      skill_id: published.skill.skill_id,
      reason: "ledger_backed_recertification_review",
      evidence_refs: [recertificationEvidence.record_id],
      actor_id: "postgres-recert-ledger-reviewer",
      actor_type: "human",
      roles: ["dojo:operator"],
      request_id: "req-postgres-recert-ledger",
      correlation_id: "corr-postgres-recert-ledger",
      now: "2026-06-11T01:45:00.000Z",
    });
    expect(recertified?.isError).toBeUndefined();
    expect(recertified?.structuredContent).toEqual(expect.objectContaining({
      ok: true,
      control_plane_source: "postgres",
      recertification: expect.objectContaining({
        status: "applied",
        reason: "ledger_backed_recertification_review",
        evidence_refs: [recertificationEvidence.record_id],
        previous_license_version: published.license.license_version,
        evidence_ledger_validation: expect.objectContaining({
          store_kind: "postgres",
          evidence_record_ids: [recertificationEvidence.record_id],
          record_count: 1,
        }),
        control_plane_persistence: expect.objectContaining({
          ok: true,
          store_kind: "postgres",
          skill_id: published.skill.skill_id,
          workflow_id: published.skill.workflow_id,
          audit_event_id: expect.any(String),
        }),
      }),
    }));
    const recertContent = recertified?.structuredContent as {
      license: { license_id: string; license_version: string };
    };
    expect(recertContent.license.license_version).not.toBe(published.license.license_version);
    await expect(licenseStore.getLicense(recertContent.license.license_id)).resolves.toEqual(expect.objectContaining({
      status: "active",
      license_version: recertContent.license.license_version,
    }));
  });

  it("persists permission upgrade request and review through Postgres after local reset and rejects unauthorized reviewers", async () => {
    const tenantId = `tenant_upgrade_${Date.now()}_${Math.random().toString(16).slice(2)}`;
    const workspaceId = `workspace_upgrade_${Math.random().toString(16).slice(2)}`;
    process.env.SYNTHI_DOJO_PRODUCTION_ENFORCEMENT = "1";
    process.env.SYNTHI_DOJO_REQUIRE_DURABLE_STORE = "1";
    process.env.SYNTHI_DOJO_CONTROL_PLANE_STORE = "postgres";
    process.env.SYNTHI_DOJO_CONTROL_PLANE_POSTGRES_URL = postgresUrl;

    recordOpenDetailsWorkflowForToolTest(workspaceId);
    const tenant = productionTenantContextArgs({
      tenant_id: tenantId,
      workspace_id: workspaceId,
      request_id: "req-postgres-upgrade-publish",
      correlation_id: "corr-postgres-upgrade-publish",
      actor_id: "postgres-upgrade-publisher",
      actor_type: "human",
      roles: ["dojo:operator"],
    });
    const publish = await dispatchDojoTool("synthi_dojo_publish_skill", {
      workspace_id: workspaceId,
      reason: "integration_postgres_upgrade_publish",
      evidence_refs: ["evidence:integration-postgres-upgrade-publish"],
      ...tenant,
    });
    expect(publish?.isError).toBeUndefined();
    const published = publish?.structuredContent as {
      skill: { skill_id: string; workflow_id: string };
    };

    const request = await dispatchDojoTool("synthi_dojo_request_permission_upgrade", {
      ...tenant,
      skill_id: published.skill.skill_id,
      requested_action: "delete_record",
      actor_id: "postgres-upgrade-agent",
      actor_type: "agent",
      roles: ["agent"],
      request_id: "req-postgres-upgrade-request",
      correlation_id: "corr-postgres-upgrade-request",
      now: "2026-06-11T02:00:00.000Z",
    });
    expect(request?.isError).toBeUndefined();
    expect(request?.structuredContent).toEqual(expect.objectContaining({
      ok: true,
      control_plane_source: "postgres",
      permission_upgrade_request: expect.objectContaining({
        requested_action: "delete_record",
        status: "pending",
        required_steps: expect.arrayContaining(["rerun_checkride_for_requested_action"]),
      }),
    }));
    const requestContent = request?.structuredContent as {
      permission_upgrade_request: { request_id: string };
    };

    const governanceStore = new PostgresDojoGovernanceStore({
      tenant_id: tenantId,
      workspace_id: workspaceId,
      queryable: pool,
    });
    const skillStore = new PostgresDojoSkillStore({
      tenant_id: tenantId,
      workspace_id: workspaceId,
      queryable: pool,
    });
    const licenseStore = new PostgresDojoLicenseStore({
      tenant_id: tenantId,
      workspace_id: workspaceId,
      queryable: pool,
    });
    const preUpgradeSkill = await skillStore.getSkill(published.skill.skill_id);
    expect(preUpgradeSkill).toBeTruthy();
    expect(preUpgradeSkill?.permission_license.gated_actions.map((action) => action.action)).not.toContain("delete_record");
    await expect(governanceStore.listPermissionUpgradeRequests({ request_id: requestContent.permission_upgrade_request.request_id })).resolves.toEqual([
      expect.objectContaining({
        request_id: requestContent.permission_upgrade_request.request_id,
        status: "pending",
        requested_action: "delete_record",
      }),
    ]);

    dojoSkillRegistry.useStoreForTests(new InMemoryDojoSkillStore());
    dojoSkillRegistry.resetForTests();
    expect(dojoSkillRegistry.get(published.skill.skill_id)).toBeNull();
    expect(dojoSkillRegistry.listPermissionUpgradeRequests({ request_id: requestContent.permission_upgrade_request.request_id })).toEqual([]);

    const unauthorizedReview = await dispatchDojoTool("synthi_dojo_review_permission_upgrade", {
      ...tenant,
      request_id: requestContent.permission_upgrade_request.request_id,
      decision: "approved",
      reviewer_actor_id: "postgres-upgrade-agent-reviewer",
      reviewer_actor_type: "agent",
      reason: "Agent role should not be able to approve permission upgrades.",
      evidence_refs: ["evidence:integration-postgres-upgrade-unauthorized-review"],
      actor_id: "postgres-upgrade-agent-reviewer",
      actor_type: "agent",
      roles: ["agent"],
      correlation_id: "corr-postgres-upgrade-unauthorized-review",
      decided_at: "2026-06-11T02:04:00.000Z",
    });
    expect(unauthorizedReview?.isError).toBe(true);
    expect(unauthorizedReview?.structuredContent).toEqual(expect.objectContaining({
      error: "permission_upgrade_reviewer_role_required",
      review: expect.objectContaining({
        ok: false,
        blocked_by: ["governance_role_required:dojo:approval:review|dojo:license:review"],
      }),
    }));
    await expect(governanceStore.listPermissionUpgradeRequests({ request_id: requestContent.permission_upgrade_request.request_id })).resolves.toEqual([
      expect.objectContaining({
        request_id: requestContent.permission_upgrade_request.request_id,
        status: "pending",
      }),
    ]);

    const review = await dispatchDojoTool("synthi_dojo_review_permission_upgrade", {
      ...tenant,
      request_id: requestContent.permission_upgrade_request.request_id,
      decision: "approved",
      reviewer_actor_id: "postgres-upgrade-reviewer",
      reviewer_actor_type: "human",
      reason: "Evidence reviewed in durable control plane.",
      evidence_refs: ["evidence:integration-postgres-upgrade-review"],
      promotion_evidence_claims: ["checkride_passed", "evidence_fresh"],
      actor_id: "postgres-upgrade-reviewer",
      actor_type: "human",
      roles: ["dojo:operator"],
      correlation_id: "corr-postgres-upgrade-review",
      decided_at: "2026-06-11T02:05:00.000Z",
    });
    expect(review?.isError).toBeUndefined();
    expect(review?.structuredContent).toEqual(expect.objectContaining({
      ok: true,
      control_plane_source: "postgres",
      permission_upgrade_request: expect.objectContaining({
        status: "approved",
        reviewed_at: "2026-06-11T02:05:00.000Z",
        decision_evidence_refs: ["evidence:integration-postgres-upgrade-review"],
      }),
      permission_upgrade_license_promotion: expect.objectContaining({
        ok: true,
        applied: true,
        status: "applied",
        requested_action: "delete_record",
        license_action_status: "gated",
        previous_license_version: preUpgradeSkill?.permission_license.license_version,
        approval_required: true,
      }),
      control_plane_persistence: expect.objectContaining({
        ok: true,
        store_kind: "postgres",
        license_promotion_status: "applied",
        requested_action: "delete_record",
        license_action_status: "gated",
      }),
      license: expect.objectContaining({
        license_id: preUpgradeSkill?.permission_license.license_id,
        gated_actions: expect.arrayContaining([
          expect.objectContaining({ action: "delete_record" }),
        ]),
        approval_requirements: expect.arrayContaining(["delete_record"]),
      }),
    }));
    await expect(governanceStore.listPermissionUpgradeRequests({ request_id: requestContent.permission_upgrade_request.request_id })).resolves.toEqual([
      expect.objectContaining({
        request_id: requestContent.permission_upgrade_request.request_id,
        status: "approved",
        reviewed_by: { actor_id: "postgres-upgrade-reviewer", actor_type: "human" },
      }),
    ]);
    const upgradedSkill = await skillStore.getSkill(published.skill.skill_id);
    expect(upgradedSkill?.permission_license.license_version).not.toBe(preUpgradeSkill?.permission_license.license_version);
    expect(upgradedSkill?.permission_license.gated_actions).toEqual(expect.arrayContaining([
      expect.objectContaining({
        action: "delete_record",
        constraints: expect.arrayContaining([
          "permission_upgrade_approved",
          `permission_upgrade_request:${requestContent.permission_upgrade_request.request_id}`,
          "promotion_claim:checkride_passed",
          "promotion_claim:evidence_fresh",
        ]),
      }),
    ]));
    expect(upgradedSkill?.permission_license.blocked_actions.map((action) => action.action)).not.toContain("delete_record");
    expect(upgradedSkill?.skill_card.will_ask_before).toContain("delete_record");
    await expect(licenseStore.getLicense(upgradedSkill!.permission_license.license_id)).resolves.toEqual(expect.objectContaining({
      status: "active",
      license_version: upgradedSkill?.permission_license.license_version,
      license_json: expect.objectContaining({
        gated_actions: expect.arrayContaining([
          expect.objectContaining({ action: "delete_record" }),
        ]),
        approval_requirements: expect.arrayContaining(["delete_record"]),
      }),
    }));
    await expect(licenseStore.getLicenseVersion(
      upgradedSkill!.permission_license.license_id,
      upgradedSkill!.permission_license.license_version
    )).resolves.toEqual(expect.objectContaining({
      license_version: upgradedSkill?.permission_license.license_version,
      status: "active",
      created_by: "postgres-upgrade-reviewer",
    }));
    expect(dojoSkillRegistry.get(published.skill.skill_id)).toBeNull();
    expect(dojoSkillRegistry.listPermissionUpgradeRequests({ request_id: requestContent.permission_upgrade_request.request_id })).toEqual([]);
  });

  it("requires ledger-backed permission upgrade review evidence and promotion claims when production evidence ledger is enforced", async () => {
    const tenantId = `tenant_upgrade_ledger_${Date.now()}_${Math.random().toString(16).slice(2)}`;
    const workspaceId = `workspace_upgrade_ledger_${Math.random().toString(16).slice(2)}`;
    process.env.SYNTHI_DOJO_PRODUCTION_ENFORCEMENT = "1";
    process.env.SYNTHI_DOJO_REQUIRE_DURABLE_STORE = "1";
    process.env.SYNTHI_DOJO_REQUIRE_EVIDENCE_LEDGER = "1";
    process.env.SYNTHI_DOJO_CONTROL_PLANE_STORE = "postgres";
    process.env.SYNTHI_DOJO_CONTROL_PLANE_POSTGRES_URL = postgresUrl;
    process.env.SYNTHI_DOJO_EVIDENCE_LEDGER_STORE = "postgres";
    process.env.SYNTHI_DOJO_EVIDENCE_LEDGER_POSTGRES_URL = postgresUrl;

    recordOpenDetailsWorkflowForToolTest(workspaceId);
    const tenant = productionTenantContextArgs({
      tenant_id: tenantId,
      workspace_id: workspaceId,
      request_id: "req-postgres-upgrade-ledger-publish",
      correlation_id: "corr-postgres-upgrade-ledger-publish",
      actor_id: "postgres-upgrade-ledger-publisher",
      actor_type: "human",
      roles: ["dojo:operator"],
    });
    const publicationEvidence = await appendPublicationEvidenceForCurrentWorkflowForToolTest(pool, {
      tenant_id: tenantId,
      workspace_id: workspaceId,
      record_id: `publication_${createHash("sha256").update(`${tenantId}:${workspaceId}:permission-upgrade-publish`, "utf8").digest("hex").slice(0, 16)}`,
      created_at: "2026-06-11T02:18:00.000Z",
      created_by: "postgres-upgrade-ledger-publisher",
      source_ref: "publication:permission-upgrade-setup",
    });
    const publish = await dispatchDojoTool("synthi_dojo_publish_skill", {
      workspace_id: workspaceId,
      reason: "integration_postgres_upgrade_ledger_publish",
      evidence_refs: [publicationEvidence.record.record_id],
      ...tenant,
    });
    expect(publish?.isError).toBeUndefined();
    const published = publish?.structuredContent as {
      skill: { skill_id: string; workflow_id: string };
      publication: {
        evidence_policy: {
          require_evidence_ledger: boolean;
          evidence_backed: boolean;
          evidence_ledger_store_kind: string;
        };
      };
    };
    expect(published.publication.evidence_policy).toEqual(expect.objectContaining({
      require_evidence_ledger: true,
      evidence_backed: true,
      evidence_ledger_store_kind: "postgres",
    }));

    const request = await dispatchDojoTool("synthi_dojo_request_permission_upgrade", {
      ...tenant,
      skill_id: published.skill.skill_id,
      requested_action: "delete_record",
      actor_id: "postgres-upgrade-ledger-agent",
      actor_type: "agent",
      roles: ["agent"],
      request_id: "req-postgres-upgrade-ledger-request",
      correlation_id: "corr-postgres-upgrade-ledger-request",
      now: "2026-06-11T02:40:00.000Z",
    });
    expect(request?.isError).toBeUndefined();
    const requestContent = request?.structuredContent as {
      permission_upgrade_request: { request_id: string };
    };

    const governanceStore = new PostgresDojoGovernanceStore({
      tenant_id: tenantId,
      workspace_id: workspaceId,
      queryable: pool,
    });
    const skillStore = new PostgresDojoSkillStore({
      tenant_id: tenantId,
      workspace_id: workspaceId,
      queryable: pool,
    });
    const preUpgradeSkill = await skillStore.getSkill(published.skill.skill_id);
    expect(preUpgradeSkill).toBeTruthy();

    dojoSkillRegistry.useStoreForTests(new InMemoryDojoSkillStore());
    dojoSkillRegistry.resetForTests();
    expect(dojoSkillRegistry.get(published.skill.skill_id)).toBeNull();

    const unbackedReview = await dispatchDojoTool("synthi_dojo_review_permission_upgrade", {
      ...tenant,
      request_id: requestContent.permission_upgrade_request.request_id,
      decision: "approved",
      reviewer_actor_id: "postgres-upgrade-ledger-reviewer",
      reviewer_actor_type: "human",
      reason: "Reject review because evidence is not in the ledger.",
      evidence_refs: ["evidence:unbacked-permission-upgrade-review"],
      actor_id: "postgres-upgrade-ledger-reviewer",
      actor_type: "human",
      roles: ["dojo:operator"],
      correlation_id: "corr-postgres-upgrade-ledger-review-unbacked",
      decided_at: "2026-06-11T02:45:00.000Z",
    });
    expect(unbackedReview?.isError).toBe(true);
    expect(unbackedReview?.structuredContent).toEqual(expect.objectContaining({
      error: "dojo_permission_upgrade_evidence_ledger_resolution_failed",
      missing_evidence_record_ids: ["evidence:unbacked-permission-upgrade-review"],
      blocked_by: ["evidence_record_missing:evidence:unbacked-permission-upgrade-review"],
    }));
    await expect(governanceStore.listPermissionUpgradeRequests({
      request_id: requestContent.permission_upgrade_request.request_id,
    })).resolves.toEqual([
      expect.objectContaining({
        request_id: requestContent.permission_upgrade_request.request_id,
        status: "pending",
      }),
    ]);

    const genericReviewEvidence = await appendGovernanceEvidenceRecordForToolTest(pool, {
      tenant_id: tenantId,
      workspace_id: workspaceId,
      skill_id: published.skill.skill_id,
      record_id: `permission_upgrade_generic_review_${createHash("sha256").update(`${tenantId}:${workspaceId}:${published.skill.skill_id}:generic-review`, "utf8").digest("hex").slice(0, 16)}`,
      created_at: "2026-06-11T02:44:30.000Z",
      created_by: "postgres-upgrade-ledger-reviewer",
      source_ref: "permission-upgrade:generic-review",
      kind: "license",
      run_id_prefix: "permission_upgrade",
      claim_ids: ["permission_upgrade_reviewed"],
    });
    const genericLedgerReview = await dispatchDojoTool("synthi_dojo_review_permission_upgrade", {
      ...tenant,
      request_id: requestContent.permission_upgrade_request.request_id,
      decision: "approved",
      reviewer_actor_id: "postgres-upgrade-ledger-reviewer",
      reviewer_actor_type: "human",
      reason: "Reject review because ledger evidence lacks promotion claims.",
      evidence_refs: [genericReviewEvidence.record_id],
      actor_id: "postgres-upgrade-ledger-reviewer",
      actor_type: "human",
      roles: ["dojo:operator"],
      correlation_id: "corr-postgres-upgrade-ledger-review-generic",
      decided_at: "2026-06-11T02:46:00.000Z",
    });
    expect(genericLedgerReview?.isError).toBe(true);
    expect(genericLedgerReview?.structuredContent).toEqual(expect.objectContaining({
      error: "dojo_permission_upgrade_promotion_evidence_policy_failed",
      failed_evidence_claims: ["checkride_passed"],
      blocked_by: ["evidence_claim_missing:checkride_passed"],
    }));
    await expect(governanceStore.listPermissionUpgradeRequests({
      request_id: requestContent.permission_upgrade_request.request_id,
    })).resolves.toEqual([
      expect.objectContaining({
        request_id: requestContent.permission_upgrade_request.request_id,
        status: "pending",
      }),
    ]);

    const reviewEvidence = await appendGovernanceEvidenceRecordForToolTest(pool, {
      tenant_id: tenantId,
      workspace_id: workspaceId,
      skill_id: published.skill.skill_id,
      record_id: `permission_upgrade_review_${createHash("sha256").update(`${tenantId}:${workspaceId}:${published.skill.skill_id}:review`, "utf8").digest("hex").slice(0, 16)}`,
      created_at: "2026-06-11T02:44:00.000Z",
      created_by: "postgres-upgrade-ledger-reviewer",
      source_ref: "permission-upgrade:review",
      kind: "checkride",
      run_id_prefix: "permission_upgrade",
      claim_ids: ["checkride_passed"],
    });

    const reviewed = await dispatchDojoTool("synthi_dojo_review_permission_upgrade", {
      ...tenant,
      request_id: requestContent.permission_upgrade_request.request_id,
      decision: "approved",
      reviewer_actor_id: "postgres-upgrade-ledger-reviewer",
      reviewer_actor_type: "human",
      reason: "Ledger records prove the permission upgrade review evidence.",
      evidence_refs: [reviewEvidence.record_id],
      actor_id: "postgres-upgrade-ledger-reviewer",
      actor_type: "human",
      roles: ["dojo:operator"],
      correlation_id: "corr-postgres-upgrade-ledger-review",
      decided_at: "2026-06-11T02:50:00.000Z",
    });
    expect(reviewed?.isError).toBeUndefined();
    expect(reviewed?.structuredContent).toEqual(expect.objectContaining({
      ok: true,
      control_plane_source: "postgres",
      evidence_ledger_validation: expect.objectContaining({
        store_kind: "postgres",
        evidence_record_ids: [reviewEvidence.record_id],
        record_count: 1,
        required_evidence_claims: expect.arrayContaining(["checkride_passed", "evidence_fresh"]),
        evidence_claim_results: expect.arrayContaining([
          expect.objectContaining({ claim_id: "checkride_passed", ok: true }),
          expect.objectContaining({ claim_id: "evidence_fresh", ok: true }),
        ]),
      }),
      promotion_evidence_policy: expect.objectContaining({
        ok: true,
        verification_source: "ledger",
        authoritative: true,
        required_claims: expect.arrayContaining(["checkride_passed", "evidence_fresh"]),
      }),
      permission_upgrade_request: expect.objectContaining({
        status: "approved",
        decision_evidence_refs: [reviewEvidence.record_id],
      }),
      permission_upgrade_license_promotion: expect.objectContaining({
        applied: true,
        license_action_status: "gated",
        previous_license_version: preUpgradeSkill?.permission_license.license_version,
      }),
    }));
    const upgradedSkill = await skillStore.getSkill(published.skill.skill_id);
    expect(upgradedSkill?.permission_license.license_version).not.toBe(preUpgradeSkill?.permission_license.license_version);
    expect(upgradedSkill?.permission_license.gated_actions).toEqual(expect.arrayContaining([
      expect.objectContaining({
        action: "delete_record",
        constraints: expect.arrayContaining([
          `review_evidence:${reviewEvidence.record_id}`,
          `permission_upgrade_request:${requestContent.permission_upgrade_request.request_id}`,
        ]),
      }),
    ]));
  });

  it("persists case law proposal and review with audit through Postgres after local reset and rejects unauthorized reviewers", async () => {
    const tenantId = `tenant_case_${Date.now()}_${Math.random().toString(16).slice(2)}`;
    const workspaceId = `workspace_case_${Math.random().toString(16).slice(2)}`;
    process.env.SYNTHI_DOJO_PRODUCTION_ENFORCEMENT = "1";
    process.env.SYNTHI_DOJO_REQUIRE_DURABLE_STORE = "1";
    process.env.SYNTHI_DOJO_CONTROL_PLANE_STORE = "postgres";
    process.env.SYNTHI_DOJO_CONTROL_PLANE_POSTGRES_URL = postgresUrl;

    recordOpenDetailsWorkflowForToolTest(workspaceId);
    const tenant = productionTenantContextArgs({
      tenant_id: tenantId,
      workspace_id: workspaceId,
      request_id: "req-postgres-case-publish",
      correlation_id: "corr-postgres-case-publish",
      actor_id: "postgres-case-publisher",
      actor_type: "human",
      roles: ["dojo:operator"],
    });
    const publish = await dispatchDojoTool("synthi_dojo_publish_skill", {
      workspace_id: workspaceId,
      reason: "integration_postgres_case_publish",
      evidence_refs: ["evidence:integration-postgres-case-publish"],
      ...tenant,
    });
    expect(publish?.isError).toBeUndefined();
    const published = publish?.structuredContent as {
      skill: { skill_id: string; workflow_id: string };
    };

    const recorded = await dispatchDojoTool("synthi_dojo_record_case_law", {
      ...tenant,
      skill_id: published.skill.skill_id,
      title: "Duplicate entity stable identifier",
      finding: "A duplicate display name can make the skill choose the wrong entity.",
      rule: "Require a stable identifier match before committing entity mutations.",
      applies_to: ["commit_mutation"],
      evidence_refs: ["evidence:integration-postgres-case-proposal"],
      actor_id: "postgres-case-author",
      actor_type: "human",
      roles: ["dojo:operator"],
      request_id: "req-postgres-case-record",
      correlation_id: "corr-postgres-case-record",
    });
    expect(recorded?.isError).toBeUndefined();
    expect(recorded?.structuredContent).toEqual(expect.objectContaining({
      ok: true,
      control_plane_source: "postgres",
      case_law_record: expect.objectContaining({
        status: "proposed",
        binding_scope: { kind: "skill", id: published.skill.skill_id },
        applies_to: ["commit_mutation"],
      }),
      guardrail_binding_status: "review_required",
    }));
    const caseId = (recorded?.structuredContent as {
      case_law_record: { case_id: string };
    }).case_law_record.case_id;

    const governanceStore = new PostgresDojoGovernanceStore({
      tenant_id: tenantId,
      workspace_id: workspaceId,
      queryable: pool,
    });
    await expect(governanceStore.getCaseLawRecord(caseId)).resolves.toEqual(expect.objectContaining({
      case_id: caseId,
      status: "proposed",
      binding_scope: { kind: "skill", id: published.skill.skill_id },
      evidence_refs: ["evidence:integration-postgres-case-proposal"],
    }));

    dojoSkillRegistry.useStoreForTests(new InMemoryDojoSkillStore());
    dojoSkillRegistry.resetForTests();
    expect(dojoSkillRegistry.get(published.skill.skill_id)).toBeNull();
    expect(dojoSkillRegistry.getCaseLawRecord(caseId)).toBeNull();

    const unauthorizedReview = await dispatchDojoTool("synthi_dojo_review_case_law", {
      ...tenant,
      skill_id: published.skill.skill_id,
      case_id: caseId,
      decision: "approved",
      reviewer_actor_id: "postgres-case-agent-reviewer",
      reviewer_actor_type: "agent",
      reason: "Agent role should not approve binding case law.",
      evidence_refs: ["evidence:integration-postgres-case-unauthorized-review"],
      actor_id: "postgres-case-agent-reviewer",
      actor_type: "agent",
      roles: ["agent"],
      request_id: "req-postgres-case-unauthorized-review",
      correlation_id: "corr-postgres-case-unauthorized-review",
      decided_at: "2026-06-11T02:59:00.000Z",
    });
    expect(unauthorizedReview?.isError).toBe(true);
    expect(unauthorizedReview?.structuredContent).toEqual(expect.objectContaining({
      error: "case_law_reviewer_role_required",
      review: expect.objectContaining({
        ok: false,
        blocked_by: ["governance_role_required:dojo:case-law:review"],
      }),
    }));
    await expect(governanceStore.getCaseLawRecord(caseId)).resolves.toEqual(expect.objectContaining({
      case_id: caseId,
      status: "proposed",
    }));

    const reviewed = await dispatchDojoTool("synthi_dojo_review_case_law", {
      ...tenant,
      skill_id: published.skill.skill_id,
      case_id: caseId,
      decision: "approved",
      reviewer_actor_id: "postgres-case-reviewer",
      reviewer_actor_type: "human",
      reason: "Evidence proves the stable identifier guardrail is required.",
      evidence_refs: ["evidence:integration-postgres-case-review"],
      actor_id: "postgres-case-reviewer",
      actor_type: "human",
      roles: ["dojo:operator"],
      request_id: "req-postgres-case-review",
      correlation_id: "corr-postgres-case-review",
      decided_at: "2026-06-11T03:00:00.000Z",
    });
    expect(reviewed?.isError).toBeUndefined();
    expect(reviewed?.structuredContent).toEqual(expect.objectContaining({
      ok: true,
      control_plane_source: "postgres",
      case_law_record: expect.objectContaining({
        case_id: caseId,
        status: "approved",
        reviewer: "postgres-case-reviewer",
        evidence_refs: expect.arrayContaining([
          "evidence:integration-postgres-case-proposal",
          "evidence:integration-postgres-case-review",
        ]),
      }),
      skill: expect.objectContaining({ skill_id: published.skill.skill_id }),
    }));

    await expect(governanceStore.getCaseLawRecord(caseId)).resolves.toEqual(expect.objectContaining({
      case_id: caseId,
      status: "approved",
      reviewer: "postgres-case-reviewer",
    }));
    const auditStore = new PostgresDojoAuditStore({
      tenant_id: tenantId,
      workspace_id: workspaceId,
      queryable: pool,
    });
    await expect(auditStore.listAuditEvents({ entity_kind: "case_law", entity_id: caseId })).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({
        event_type: "case_law_proposed",
        entity_id: caseId,
        actor: { actor_id: "postgres-case-author", actor_type: "human" },
        request_id: "req-postgres-case-record",
        correlation_id: "corr-postgres-case-record",
      }),
      expect.objectContaining({
        event_type: "case_law_approved",
        entity_id: caseId,
        actor: { actor_id: "postgres-case-reviewer", actor_type: "human" },
        request_id: "req-postgres-case-review",
        correlation_id: "corr-postgres-case-review",
      }),
    ]));
    const skillStore = new PostgresDojoSkillStore({
      tenant_id: tenantId,
      workspace_id: workspaceId,
      queryable: pool,
    });
    await expect(skillStore.getSkill(published.skill.skill_id)).resolves.toEqual(expect.objectContaining({
      skill_id: published.skill.skill_id,
      case_law: expect.arrayContaining([
        expect.objectContaining({
          case_id: caseId,
          status: "binding",
        }),
      ]),
      case_law_refs: expect.arrayContaining([caseId]),
      guardrails: expect.arrayContaining([
        expect.objectContaining({
          source_case_id: caseId,
          blocks_actions: ["commit_mutation"],
        }),
      ]),
    }));
    expect(dojoSkillRegistry.get(published.skill.skill_id)).toBeNull();
    expect(dojoSkillRegistry.getCaseLawRecord(caseId)).toBeNull();
  });

  it("requires ledger-backed case law evidence when production evidence ledger is enforced", async () => {
    const tenantId = `tenant_case_ledger_${Date.now()}_${Math.random().toString(16).slice(2)}`;
    const workspaceId = `workspace_case_ledger_${Math.random().toString(16).slice(2)}`;
    process.env.SYNTHI_DOJO_PRODUCTION_ENFORCEMENT = "1";
    process.env.SYNTHI_DOJO_REQUIRE_DURABLE_STORE = "1";
    process.env.SYNTHI_DOJO_REQUIRE_EVIDENCE_LEDGER = "1";
    process.env.SYNTHI_DOJO_CONTROL_PLANE_STORE = "postgres";
    process.env.SYNTHI_DOJO_CONTROL_PLANE_POSTGRES_URL = postgresUrl;
    process.env.SYNTHI_DOJO_EVIDENCE_LEDGER_STORE = "postgres";
    process.env.SYNTHI_DOJO_EVIDENCE_LEDGER_POSTGRES_URL = postgresUrl;

    recordOpenDetailsWorkflowForToolTest(workspaceId);
    const tenant = productionTenantContextArgs({
      tenant_id: tenantId,
      workspace_id: workspaceId,
      request_id: "req-postgres-case-ledger-publish",
      correlation_id: "corr-postgres-case-ledger-publish",
      actor_id: "postgres-case-ledger-publisher",
      actor_type: "human",
      roles: ["dojo:operator"],
    });
    const publicationEvidence = await appendPublicationEvidenceForCurrentWorkflowForToolTest(pool, {
      tenant_id: tenantId,
      workspace_id: workspaceId,
      record_id: `publication_${createHash("sha256").update(`${tenantId}:${workspaceId}:case-law-publish`, "utf8").digest("hex").slice(0, 16)}`,
      created_at: "2026-06-11T01:58:00.000Z",
      created_by: "postgres-case-ledger-publisher",
      source_ref: "publication:case-law-setup",
    });
    const publish = await dispatchDojoTool("synthi_dojo_publish_skill", {
      workspace_id: workspaceId,
      reason: "integration_postgres_case_ledger_publish",
      evidence_refs: [publicationEvidence.record.record_id],
      ...tenant,
    });
    expect(publish?.isError).toBeUndefined();
    const published = publish?.structuredContent as {
      skill: { skill_id: string; workflow_id: string };
      publication: {
        executable_checkride: {
          scenario_count: number;
          ledger_record_count: number;
          evidence_refs: string[];
        };
        entrustment_decision: {
          level: string;
          blocked_by: string[];
        };
        evidence_policy: {
          require_evidence_ledger: boolean;
          evidence_backed: boolean;
          evidence_backing: string;
          evidence_ledger_store_kind: string;
          ledger_record_count: number;
          scenario_count: number;
        };
      };
    };
    expect(published.publication.executable_checkride.scenario_count).toBeGreaterThan(0);
    expect(published.publication.executable_checkride.ledger_record_count).toBe(
      published.publication.executable_checkride.scenario_count
    );
    expect(published.publication.executable_checkride.evidence_refs.every((ref) => ref.startsWith("ledger:"))).toBe(true);
    expect(published.publication.evidence_policy).toEqual(expect.objectContaining({
      require_evidence_ledger: true,
      evidence_backed: true,
      evidence_backing: "ledger",
      evidence_ledger_store_kind: "postgres",
      ledger_record_count: published.publication.executable_checkride.scenario_count,
      scenario_count: published.publication.executable_checkride.scenario_count,
    }));
    expect(published.publication.entrustment_decision.blocked_by).not.toContain("entrustment_evidence_missing");
    const skill = dojoSkillRegistry.get(published.skill.skill_id);
    expect(skill).toBeTruthy();

    const unbackedRecord = await dispatchDojoTool("synthi_dojo_record_case_law", {
      ...tenant,
      skill_id: published.skill.skill_id,
      title: "Unbacked case law evidence",
      finding: "This proposal intentionally references evidence that is not in the ledger.",
      rule: "Reject unbacked case-law proposal evidence in production.",
      applies_to: ["commit_mutation"],
      evidence_refs: ["evidence:unbacked-case-law-proposal"],
      actor_id: "postgres-case-ledger-author",
      actor_type: "human",
      roles: ["dojo:operator"],
      request_id: "req-postgres-case-ledger-record-unbacked",
      correlation_id: "corr-postgres-case-ledger-record-unbacked",
      now: "2026-06-11T02:05:00.000Z",
    });
    expect(unbackedRecord?.isError).toBe(true);
    expect(unbackedRecord?.structuredContent).toEqual(expect.objectContaining({
      error: "dojo_case_law_evidence_ledger_resolution_failed",
      missing_evidence_record_ids: ["evidence:unbacked-case-law-proposal"],
      blocked_by: ["evidence_record_missing:evidence:unbacked-case-law-proposal"],
    }));

    const proposalEvidence = await appendCaseLawEvidenceRecordForToolTest(pool, {
      tenant_id: tenantId,
      workspace_id: workspaceId,
      skill_id: published.skill.skill_id,
      record_id: `case_law_proposal_${createHash("sha256").update(`${tenantId}:${workspaceId}:${published.skill.skill_id}:proposal`, "utf8").digest("hex").slice(0, 16)}`,
      created_at: "2026-06-11T02:00:00.000Z",
      created_by: "postgres-case-ledger-author",
      source_ref: "case-law:proposal",
    });

    const recorded = await dispatchDojoTool("synthi_dojo_record_case_law", {
      ...tenant,
      skill_id: published.skill.skill_id,
      title: "Ledger backed stable identifier case",
      finding: "A duplicate display name can make the skill choose the wrong entity.",
      rule: "Require stable identifier evidence before entity mutation.",
      applies_to: ["commit_mutation"],
      evidence_refs: [proposalEvidence.record_id],
      actor_id: "postgres-case-ledger-author",
      actor_type: "human",
      roles: ["dojo:operator"],
      request_id: "req-postgres-case-ledger-record",
      correlation_id: "corr-postgres-case-ledger-record",
      now: "2026-06-11T02:10:00.000Z",
    });
    expect(recorded?.isError).toBeUndefined();
    expect(recorded?.structuredContent).toEqual(expect.objectContaining({
      ok: true,
      control_plane_source: "postgres",
      evidence_ledger_validation: expect.objectContaining({
        store_kind: "postgres",
        evidence_record_ids: [proposalEvidence.record_id],
        record_count: 1,
      }),
      case_law_record: expect.objectContaining({
        status: "proposed",
        evidence_refs: [proposalEvidence.record_id],
      }),
    }));
    const caseId = (recorded?.structuredContent as {
      case_law_record: { case_id: string };
    }).case_law_record.case_id;

    const reviewEvidence = await appendCaseLawEvidenceRecordForToolTest(pool, {
      tenant_id: tenantId,
      workspace_id: workspaceId,
      skill_id: published.skill.skill_id,
      record_id: `case_law_review_${createHash("sha256").update(`${tenantId}:${workspaceId}:${published.skill.skill_id}:review`, "utf8").digest("hex").slice(0, 16)}`,
      created_at: "2026-06-11T02:20:00.000Z",
      created_by: "postgres-case-ledger-reviewer",
      source_ref: "case-law:review",
    });

    dojoSkillRegistry.useStoreForTests(new InMemoryDojoSkillStore());
    dojoSkillRegistry.resetForTests();
    expect(dojoSkillRegistry.get(published.skill.skill_id)).toBeNull();

    const unbackedReview = await dispatchDojoTool("synthi_dojo_review_case_law", {
      ...tenant,
      skill_id: published.skill.skill_id,
      case_id: caseId,
      decision: "approved",
      reviewer_actor_id: "postgres-case-ledger-reviewer",
      reviewer_actor_type: "human",
      reason: "Reject review because one evidence ref is not in the ledger.",
      evidence_refs: ["evidence:unbacked-case-law-review"],
      actor_id: "postgres-case-ledger-reviewer",
      actor_type: "human",
      roles: ["dojo:operator"],
      request_id: "req-postgres-case-ledger-review-unbacked",
      correlation_id: "corr-postgres-case-ledger-review-unbacked",
      decided_at: "2026-06-11T02:30:00.000Z",
    });
    expect(unbackedReview?.isError).toBe(true);
    expect(unbackedReview?.structuredContent).toEqual(expect.objectContaining({
      error: "dojo_case_law_evidence_ledger_resolution_failed",
      missing_evidence_record_ids: ["evidence:unbacked-case-law-review"],
      blocked_by: ["evidence_record_missing:evidence:unbacked-case-law-review"],
    }));

    const reviewed = await dispatchDojoTool("synthi_dojo_review_case_law", {
      ...tenant,
      skill_id: published.skill.skill_id,
      case_id: caseId,
      decision: "approved",
      reviewer_actor_id: "postgres-case-ledger-reviewer",
      reviewer_actor_type: "human",
      reason: "Ledger records prove the stable identifier guardrail is required.",
      evidence_refs: [reviewEvidence.record_id],
      actor_id: "postgres-case-ledger-reviewer",
      actor_type: "human",
      roles: ["dojo:operator"],
      request_id: "req-postgres-case-ledger-review",
      correlation_id: "corr-postgres-case-ledger-review",
      decided_at: "2026-06-11T02:30:00.000Z",
    });
    expect(reviewed?.isError).toBeUndefined();
    expect(reviewed?.structuredContent).toEqual(expect.objectContaining({
      ok: true,
      control_plane_source: "postgres",
      evidence_ledger_validation: expect.objectContaining({
        store_kind: "postgres",
        evidence_record_ids: expect.arrayContaining([proposalEvidence.record_id, reviewEvidence.record_id]),
        record_count: 2,
      }),
      case_law_record: expect.objectContaining({
        case_id: caseId,
        status: "approved",
        evidence_refs: expect.arrayContaining([proposalEvidence.record_id, reviewEvidence.record_id]),
      }),
      skill: expect.objectContaining({ skill_id: published.skill.skill_id }),
    }));

    const governanceStore = new PostgresDojoGovernanceStore({
      tenant_id: tenantId,
      workspace_id: workspaceId,
      queryable: pool,
    });
    await expect(governanceStore.getCaseLawRecord(caseId)).resolves.toEqual(expect.objectContaining({
      case_id: caseId,
      status: "approved",
      evidence_refs: expect.arrayContaining([proposalEvidence.record_id, reviewEvidence.record_id]),
    }));
  });

  it("records Ghost Mode shadow evidence through Postgres after local reset", async () => {
    const tenantId = `tenant_ghost_tool_${Date.now()}_${Math.random().toString(16).slice(2)}`;
    const workspaceId = `workspace_ghost_tool_${Math.random().toString(16).slice(2)}`;
    process.env.SYNTHI_DOJO_PRODUCTION_ENFORCEMENT = "1";
    process.env.SYNTHI_DOJO_REQUIRE_DURABLE_STORE = "1";
    process.env.SYNTHI_DOJO_CONTROL_PLANE_STORE = "postgres";
    process.env.SYNTHI_DOJO_CONTROL_PLANE_POSTGRES_URL = postgresUrl;

    recordOpenDetailsWorkflowForToolTest(workspaceId);
    const tenant = productionTenantContextArgs({
      tenant_id: tenantId,
      workspace_id: workspaceId,
      request_id: "req-postgres-ghost-publish",
      correlation_id: "corr-postgres-ghost-publish",
      actor_id: "postgres-ghost-publisher",
      actor_type: "human",
      roles: ["dojo:operator"],
    });
    const publish = await dispatchDojoTool("synthi_dojo_publish_skill", {
      workspace_id: workspaceId,
      reason: "integration_postgres_ghost_publish",
      evidence_refs: ["evidence:integration-postgres-ghost-publish"],
      ...tenant,
    });
    expect(publish?.isError).toBeUndefined();
    const published = publish?.structuredContent as {
      skill: { skill_id: string; workflow_id: string };
      license: { license_id: string };
    };

    dojoSkillRegistry.useStoreForTests(new InMemoryDojoSkillStore());
    dojoSkillRegistry.resetForTests();
    expect(dojoSkillRegistry.get(published.skill.skill_id)).toBeNull();

    const ghost = await dispatchDojoTool("synthi_dojo_run_ghost_mode", {
      ...tenant,
      skill_id: published.skill.skill_id,
      observed_human_action: { action: "click", name: "Open details" },
      agent_planned_action: { action: "click", name: "Open details" },
      actor_id: "postgres-ghost-agent",
      actor_type: "agent",
      roles: ["agent", "dojo:practice:run"],
      request_id: "req-postgres-ghost-run",
      correlation_id: "corr-postgres-ghost-run",
      now: "2026-06-11T03:30:00.000Z",
    });
    expect(ghost?.isError).toBeUndefined();
    expect(ghost?.structuredContent).toEqual(expect.objectContaining({
      ok: true,
      control_plane_source: "postgres",
      skill_id: published.skill.skill_id,
      shadow_evidence_recorded: true,
      shadow_evidence: expect.objectContaining({
        tenant_id: tenantId,
        workspace_id: workspaceId,
        skill_id: published.skill.skill_id,
        workflow_id: published.skill.workflow_id,
        license_id: published.license.license_id,
        evidence_kind: "shadow",
        production_mutations_executed: false,
        action_matches: true,
      }),
      shadow_evidence_audit_event: expect.objectContaining({
        event_type: "ghost_shadow_evidence_recorded",
        correlation_id: "corr-postgres-ghost-run",
        entity_kind: "ghost_shadow_evidence",
      }),
      rbac_authorization: expect.objectContaining({
        action: "practice_run",
        matched_roles: ["dojo:practice:run"],
      }),
      ghost_run: expect.objectContaining({
        status: "matched",
        would_execute: false,
        production_mutations_executed: false,
      }),
    }));
    const ghostContent = ghost?.structuredContent as {
      shadow_evidence: { evidence_id: string; run_id: string };
      shadow_evidence_audit_event: { audit_event_id: string };
    };

    const ghostEvidenceStore = new PostgresDojoGhostShadowEvidenceStore({
      tenant_id: tenantId,
      workspace_id: workspaceId,
      queryable: pool,
    });
    await expect(ghostEvidenceStore.listGhostShadowEvidence({
      evidence_id: ghostContent.shadow_evidence.evidence_id,
    })).resolves.toEqual([
      expect.objectContaining({
        evidence_id: ghostContent.shadow_evidence.evidence_id,
        run_id: ghostContent.shadow_evidence.run_id,
        skill_id: published.skill.skill_id,
        action_matches: true,
        production_mutations_executed: false,
      }),
    ]);
    const auditStore = new PostgresDojoAuditStore({
      tenant_id: tenantId,
      workspace_id: workspaceId,
      queryable: pool,
    });
    await expect(auditStore.listAuditEvents({ entity_id: ghostContent.shadow_evidence.evidence_id })).resolves.toEqual([
      expect.objectContaining({
        audit_event_id: ghostContent.shadow_evidence_audit_event.audit_event_id,
        event_type: "ghost_shadow_evidence_recorded",
        details: expect.objectContaining({
          skill_id: published.skill.skill_id,
          action_matches: true,
          production_mutations_executed: false,
        }),
      }),
    ]);
    expect(dojoSkillRegistry.get(published.skill.skill_id)).toBeNull();
    expect(dojoSkillRegistry.listGhostShadowEvidence({ evidence_id: ghostContent.shadow_evidence.evidence_id })).toEqual([]);
  });

  it("persists Vivarium scenario runs through Postgres after local reset", async () => {
    const tenantId = `tenant_vivarium_tool_${Date.now()}_${Math.random().toString(16).slice(2)}`;
    const workspaceId = `workspace_vivarium_tool_${Math.random().toString(16).slice(2)}`;
    process.env.SYNTHI_DOJO_PRODUCTION_ENFORCEMENT = "1";
    process.env.SYNTHI_DOJO_REQUIRE_DURABLE_STORE = "1";
    process.env.SYNTHI_DOJO_CONTROL_PLANE_STORE = "postgres";
    process.env.SYNTHI_DOJO_CONTROL_PLANE_POSTGRES_URL = postgresUrl;

    recordOpenDetailsWorkflowForToolTest(workspaceId);
    const tenant = productionTenantContextArgs({
      tenant_id: tenantId,
      workspace_id: workspaceId,
      request_id: "req-postgres-vivarium-publish",
      correlation_id: "corr-postgres-vivarium-publish",
      actor_id: "postgres-vivarium-publisher",
      actor_type: "human",
      roles: ["dojo:operator"],
    });
    const publish = await dispatchDojoTool("synthi_dojo_publish_skill", {
      workspace_id: workspaceId,
      reason: "integration_postgres_vivarium_publish",
      evidence_refs: ["evidence:integration-postgres-vivarium-publish"],
      ...tenant,
    });
    expect(publish?.isError).toBeUndefined();
    const published = publish?.structuredContent as {
      skill: { skill_id: string; workflow_id: string };
    };

    dojoSkillRegistry.useStoreForTests(new InMemoryDojoSkillStore());
    dojoSkillRegistry.resetForTests();
    expect(dojoSkillRegistry.get(published.skill.skill_id)).toBeNull();

    const vivarium = await dispatchDojoTool("synthi_dojo_run_vivarium_scenario", {
      ...tenant,
      skill_id: published.skill.skill_id,
      actor_id: "postgres-vivarium-agent",
      actor_type: "agent",
      roles: ["agent", "dojo:practice:run"],
      request_id: "req-postgres-vivarium-run",
      correlation_id: "corr-postgres-vivarium-run",
      now: "2026-06-11T04:00:00.000Z",
    });
    expect(vivarium?.isError).toBeUndefined();
    expect(vivarium?.structuredContent).toEqual(expect.objectContaining({
      ok: true,
      control_plane_source: "postgres",
      skill_id: published.skill.skill_id,
      control_plane_persistence: expect.objectContaining({
        ok: true,
        store_kind: "postgres",
        operation: "synthi_dojo_run_vivarium_scenario",
        persisted_run_count: 1,
      }),
      rbac_authorization: expect.objectContaining({
        action: "practice_run",
        matched_roles: ["dojo:practice:run"],
      }),
      vivarium_run: expect.objectContaining({
        skill_id: published.skill.skill_id,
        workflow_id: published.skill.workflow_id,
        materialized_fixture: expect.objectContaining({ synthetic_data_only: true }),
      }),
    }));
    const vivariumContent = vivarium?.structuredContent as {
      vivarium_run: { run: { run_id: string }; scenario: { scenario_id: string } };
    };

    const graphRunStore = new PostgresDojoGraphRunStore({
      tenant_id: tenantId,
      workspace_id: workspaceId,
      queryable: pool,
    });
    await expect(graphRunStore.getScenarioRun(vivariumContent.vivarium_run.run.run_id)).resolves.toEqual(expect.objectContaining({
      scenario_run_id: vivariumContent.vivarium_run.run.run_id,
      scenario_id: vivariumContent.vivarium_run.scenario.scenario_id,
      skill_id: published.skill.skill_id,
      result: expect.objectContaining({
        schema_version: "synthi.dojo.vivariumScenarioRun.v1",
        run: expect.objectContaining({ run_id: vivariumContent.vivarium_run.run.run_id }),
      }),
    }));
    const skillStore = new PostgresDojoSkillStore({
      tenant_id: tenantId,
      workspace_id: workspaceId,
      queryable: pool,
    });
    await expect(skillStore.getSkill(published.skill.skill_id)).resolves.toEqual(expect.objectContaining({
      skill_id: published.skill.skill_id,
      training_runs: expect.arrayContaining([
        expect.objectContaining({ run_id: vivariumContent.vivarium_run.run.run_id }),
      ]),
    }));
    expect(dojoSkillRegistry.get(published.skill.skill_id)).toBeNull();
  });

  it("persists Wind Tunnel scenario runs through Postgres after local reset", async () => {
    const tenantId = `tenant_wind_tool_${Date.now()}_${Math.random().toString(16).slice(2)}`;
    const workspaceId = `workspace_wind_tool_${Math.random().toString(16).slice(2)}`;
    process.env.SYNTHI_DOJO_PRODUCTION_ENFORCEMENT = "1";
    process.env.SYNTHI_DOJO_REQUIRE_DURABLE_STORE = "1";
    process.env.SYNTHI_DOJO_CONTROL_PLANE_STORE = "postgres";
    process.env.SYNTHI_DOJO_CONTROL_PLANE_POSTGRES_URL = postgresUrl;

    recordOpenDetailsWorkflowForToolTest(workspaceId);
    const tenant = productionTenantContextArgs({
      tenant_id: tenantId,
      workspace_id: workspaceId,
      request_id: "req-postgres-wind-publish",
      correlation_id: "corr-postgres-wind-publish",
      actor_id: "postgres-wind-publisher",
      actor_type: "human",
      roles: ["dojo:operator"],
    });
    const publish = await dispatchDojoTool("synthi_dojo_publish_skill", {
      workspace_id: workspaceId,
      reason: "integration_postgres_wind_publish",
      evidence_refs: ["evidence:integration-postgres-wind-publish"],
      ...tenant,
    });
    expect(publish?.isError).toBeUndefined();
    const published = publish?.structuredContent as {
      skill: { skill_id: string; workflow_id: string };
    };

    dojoSkillRegistry.useStoreForTests(new InMemoryDojoSkillStore());
    dojoSkillRegistry.resetForTests();
    expect(dojoSkillRegistry.get(published.skill.skill_id)).toBeNull();

    const windTunnel = await dispatchDojoTool("synthi_dojo_run_wind_tunnel", {
      ...tenant,
      skill_id: published.skill.skill_id,
      max_scenarios: 2,
      actor_id: "postgres-wind-agent",
      actor_type: "agent",
      roles: ["agent", "dojo:practice:run"],
      request_id: "req-postgres-wind-run",
      correlation_id: "corr-postgres-wind-run",
      now: "2026-06-11T04:30:00.000Z",
    });
    expect(windTunnel?.isError).toBeUndefined();
    expect(windTunnel?.structuredContent).toEqual(expect.objectContaining({
      ok: true,
      control_plane_source: "postgres",
      skill_id: published.skill.skill_id,
      control_plane_persistence: expect.objectContaining({
        ok: true,
        store_kind: "postgres",
        operation: "synthi_dojo_run_wind_tunnel",
        persisted_run_count: 2,
      }),
      rbac_authorization: expect.objectContaining({
        action: "practice_run",
        matched_roles: ["dojo:practice:run"],
      }),
      wind_tunnel_execution: expect.objectContaining({
        skill_id: published.skill.skill_id,
        workflow_id: published.skill.workflow_id,
        run_count: 2,
      }),
    }));
    const windContent = windTunnel?.structuredContent as {
      wind_tunnel_execution: { runs: { run: { run_id: string } }[] };
      control_plane_persistence: { scenario_run_ids: string[] };
    };
    expect(windContent.control_plane_persistence.scenario_run_ids).toHaveLength(2);

    const graphRunStore = new PostgresDojoGraphRunStore({
      tenant_id: tenantId,
      workspace_id: workspaceId,
      queryable: pool,
    });
    for (const runId of windContent.control_plane_persistence.scenario_run_ids) {
      await expect(graphRunStore.getScenarioRun(runId)).resolves.toEqual(expect.objectContaining({
        scenario_run_id: runId,
        skill_id: published.skill.skill_id,
        result: expect.objectContaining({
          schema_version: "synthi.dojo.vivariumScenarioRun.v1",
        }),
      }));
    }
    const skillStore = new PostgresDojoSkillStore({
      tenant_id: tenantId,
      workspace_id: workspaceId,
      queryable: pool,
    });
    await expect(skillStore.getSkill(published.skill.skill_id)).resolves.toEqual(expect.objectContaining({
      skill_id: published.skill.skill_id,
      training_runs: expect.arrayContaining(
        windContent.wind_tunnel_execution.runs.map((run) => expect.objectContaining({ run_id: run.run.run_id }))
      ),
      wind_tunnel: expect.objectContaining({
        run_count: 2,
        runs: expect.arrayContaining(
          windContent.wind_tunnel_execution.runs.map((run) => expect.objectContaining({ run_id: run.run.run_id }))
        ),
      }),
    }));
    expect(dojoSkillRegistry.get(published.skill.skill_id)).toBeNull();
  });

  it("uses Postgres skill, proof, and proof-key records for production validation, consumption, and replay after local process loss", async () => {
    const tenantId = `tenant_proof_${Date.now()}_${Math.random().toString(16).slice(2)}`;
    const workspaceId = `workspace_proof_${Math.random().toString(16).slice(2)}`;
    const proofKeyPair = generateEd25519DojoProofKeyPair(`ed25519-postgres-proof-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    process.env.SYNTHI_DOJO_PRODUCTION_ENFORCEMENT = "1";
    process.env.SYNTHI_DOJO_REQUIRE_DURABLE_STORE = "1";
    process.env.SYNTHI_DOJO_REQUIRE_EXTERNAL_SIGNING = "1";
    process.env.SYNTHI_DOJO_REQUIRE_EVIDENCE_LEDGER = "1";
    process.env.SYNTHI_DOJO_CONTROL_PLANE_STORE = "postgres";
    process.env.SYNTHI_DOJO_CONTROL_PLANE_POSTGRES_URL = postgresUrl;
    process.env.SYNTHI_DOJO_EVIDENCE_LEDGER_STORE = "postgres";
    process.env.SYNTHI_DOJO_EVIDENCE_LEDGER_POSTGRES_URL = postgresUrl;
    process.env.SYNTHI_DOJO_PROOF_SIGNING_PROVIDER = "external-command";
    process.env.SYNTHI_DOJO_PROOF_SIGNING_KEY_ID = proofKeyPair.key_id;
    process.env.SYNTHI_DOJO_PROOF_SIGNING_PUBLIC_KEY_PEM = proofKeyPair.public_key_pem;
    process.env.SYNTHI_DOJO_PROOF_SIGNING_COMMAND = process.execPath;
    process.env.SYNTHI_DOJO_PROOF_SIGNING_COMMAND_ARGS = JSON.stringify(["-e", externalCommandProofSignerSource()]);
    process.env.DOJO_TEST_PRIVATE_KEY_PEM = proofKeyPair.private_key_pem;

    recordOpenDetailsWorkflowForToolTest(workspaceId);
    const tenant = productionTenantContextArgs({
      tenant_id: tenantId,
      workspace_id: workspaceId,
      request_id: "req-postgres-proof-publish",
      correlation_id: "corr-postgres-proof-publish",
      actor_id: "postgres-proof-publisher",
      actor_type: "human",
      roles: ["dojo:operator"],
    });
    const publicationEvidence = await appendPublicationEvidenceForCurrentWorkflowForToolTest(pool, {
      tenant_id: tenantId,
      workspace_id: workspaceId,
      record_id: `publication_${createHash("sha256").update(`${tenantId}:${workspaceId}:postgres-proof-publish`, "utf8").digest("hex").slice(0, 16)}`,
      created_at: "2026-06-11T00:00:00.000Z",
      created_by: "postgres-proof-publisher",
      source_ref: "publication:postgres-proof-setup",
    });
    const publish = await dispatchDojoTool("synthi_dojo_publish_skill", {
      workspace_id: workspaceId,
      reason: "integration_postgres_proof_publish",
      evidence_refs: [publicationEvidence.record.record_id],
      ...tenant,
    });
    expect(publish?.isError).toBeUndefined();
    const published = publish?.structuredContent as {
      skill: { skill_id: string; workflow_id: string };
    };
    const skill = dojoSkillRegistry.get(published.skill.skill_id);
    expect(skill).toBeTruthy();
    const proofEvidence = await appendProofEvidenceRecordForToolTest(pool, skill!, {
      tenant_id: tenantId,
      record_id: `proof_${createHash("sha256").update(`${tenantId}:${workspaceId}:${published.skill.skill_id}:issue`, "utf8").digest("hex").slice(0, 16)}`,
      created_at: "2026-06-11T00:00:00.000Z",
      created_by: "postgres-proof-agent",
      source_ref: "proof:postgres-proof-issue",
    });

    const issue = await dispatchDojoTool("synthi_dojo_issue_proof_capsule", {
      skill_id: published.skill.skill_id,
      requested_action: "run_prefix_validation",
      context_claims: { workspace_verified: true },
      evidence_record_ids: [proofEvidence.record_id],
      require_verified_evidence: true,
      ...tenant,
      actor_id: "postgres-proof-agent",
      actor_type: "agent",
      roles: ["agent", "dojo:proof:issue"],
      request_id: "req-postgres-proof-issue",
      correlation_id: "corr-postgres-proof-issue",
      now: "2026-06-11T00:00:00.000Z",
      expires_at: "2026-06-11T00:15:00.000Z",
    });
    expect(issue?.isError).toBeUndefined();
    const issued = issue?.structuredContent as {
      control_plane_source: string;
      proof_key: {
        key_id: string;
        issuer: string;
        algorithm: string;
        signing_provider: string;
        key_custody: string;
        status: string;
      };
      proof_capsule: { capsule_id: string; key_id: string; signature_algorithm: string };
      proof_record: { status: string };
    };
    expect(issued.control_plane_source).toBe("postgres");
    expect(issued.proof_key).toEqual(expect.objectContaining({
      key_id: proofKeyPair.key_id,
      algorithm: "ed25519",
      signing_provider: "external-command",
      key_custody: "external",
      status: "active",
    }));
    expect(issued.proof_capsule).toEqual(expect.objectContaining({
      key_id: proofKeyPair.key_id,
      signature_algorithm: "ed25519",
    }));
    expect(issued.proof_record).toEqual(expect.objectContaining({ status: "issued" }));

    const proofStore = new PostgresDojoProofStore({
      tenant_id: tenantId,
      workspace_id: workspaceId,
      queryable: pool,
    });
    expect(await proofStore.getProofRecord(issued.proof_capsule.capsule_id)).toEqual(expect.objectContaining({
      capsule_id: issued.proof_capsule.capsule_id,
      status: "issued",
      skill_id: published.skill.skill_id,
      key_id: proofKeyPair.key_id,
      signature_algorithm: "ed25519",
    }));
    const proofKeyRegistry = new PostgresDojoProofKeyRegistry({
      tenant_id: tenantId,
      workspace_id: workspaceId,
      queryable: pool,
    });
    await expect(proofKeyRegistry.get({
      tenant_id: tenantId,
      key_id: proofKeyPair.key_id,
    })).resolves.toEqual(expect.objectContaining({
      key_id: proofKeyPair.key_id,
      issuer: issued.proof_key.issuer,
      algorithm: "ed25519",
      signing_provider: "external-command",
      key_custody: "external",
      public_key_pem: proofKeyPair.public_key_pem.trim(),
      status: "active",
    }));
    const proofKeyAuditStore = new PostgresDojoAuditStore({
      tenant_id: tenantId,
      workspace_id: workspaceId,
      queryable: pool,
    });
    await expect(proofKeyAuditStore.listAuditEvents({
      event_type: "proof_key_upserted",
      entity_kind: "proof_key",
      entity_id: proofKeyPair.key_id,
    })).resolves.toEqual([
      expect.objectContaining({
        event_type: "proof_key_upserted",
        entity_kind: "proof_key",
        entity_id: proofKeyPair.key_id,
        details: expect.objectContaining({
          signing_provider: "external-command",
          key_custody: "external",
          proof_key_status: "active",
        }),
      }),
    ]);

    const skillStore = new PostgresDojoSkillStore({
      tenant_id: tenantId,
      workspace_id: workspaceId,
      queryable: pool,
    });
    const savedSkill = await skillStore.getSkill(published.skill.skill_id);
    expect(savedSkill).toBeTruthy();
    dojoSkillRegistry.useStoreForTests(new InMemoryDojoSkillStore());
    dojoSkillRegistry.resetForTests();
    delete process.env.SYNTHI_DOJO_PROOF_SIGNING_PUBLIC_KEY_PEM;
    delete process.env.DOJO_TEST_PRIVATE_KEY_PEM;
    process.env.SYNTHI_DOJO_PROOF_SIGNING_KEY_ID = `lost-local-key-${proofKeyPair.key_id}`;
    expect(dojoSkillRegistry.get(published.skill.skill_id)).toBeNull();
    expect(dojoSkillRegistry.getProofRecord(issued.proof_capsule.capsule_id)).toBeNull();
    dojoSkillRegistry.publish({
      ...savedSkill!,
      name: "stale local skill should not satisfy production reads",
    });
    expect(dojoSkillRegistry.get(published.skill.skill_id)?.name).toBe("stale local skill should not satisfy production reads");

    const readSkill = await dispatchDojoTool("synthi_dojo_get_skill", {
      skill_id: published.skill.skill_id,
      ...tenant,
      actor_id: "postgres-proof-agent",
      actor_type: "agent",
      roles: ["agent"],
      request_id: "req-postgres-skill-readthrough",
      correlation_id: "corr-postgres-skill-readthrough",
    });
    expect(readSkill?.isError).toBeUndefined();
    expect(readSkill?.structuredContent).toEqual(expect.objectContaining({
      ok: true,
      control_plane_source: "postgres",
      skill: expect.objectContaining({
        skill_id: published.skill.skill_id,
        workflow_id: published.skill.workflow_id,
        name: published.skill.name,
      }),
    }));
    expect(dojoSkillRegistry.get(published.skill.skill_id)?.name).toBe("stale local skill should not satisfy production reads");

    const validate = await dispatchDojoTool("synthi_dojo_validate_proof_capsule", {
      skill_id: published.skill.skill_id,
      requested_action: "run_prefix_validation",
      proof_capsule: issued.proof_capsule,
      ...tenant,
      actor_id: "postgres-proof-agent",
      actor_type: "agent",
      roles: ["agent"],
      request_id: "req-postgres-proof-validate",
      correlation_id: "corr-postgres-proof-validate",
      now: "2026-06-11T00:01:00.000Z",
    });
    expect(validate?.isError).toBeUndefined();
    expect(validate?.structuredContent).toEqual(expect.objectContaining({
      ok: true,
      control_plane_source: "postgres",
      proof_key: expect.objectContaining({
        key_id: proofKeyPair.key_id,
        algorithm: "ed25519",
        signing_provider: "external-command",
        key_custody: "external",
        status: "active",
      }),
      proof_record: expect.objectContaining({
        capsule_id: issued.proof_capsule.capsule_id,
        status: "issued",
        last_validated_at: "2026-06-11T00:01:00.000Z",
      }),
    }));
    expect(dojoSkillRegistry.getProofRecord(issued.proof_capsule.capsule_id)).toBeNull();

    const healthAfterValidation = await dispatchDojoTool("synthi_dojo_get_license_health", {
      skill_id: published.skill.skill_id,
      ...tenant,
      actor_id: "postgres-proof-auditor",
      actor_type: "human",
      roles: ["dojo:operator"],
      request_id: "req-postgres-proof-health-after-validation",
      correlation_id: "corr-postgres-proof-health-after-validation",
    });
    expect(healthAfterValidation?.isError).toBeUndefined();
    expect(healthAfterValidation?.structuredContent).toEqual(expect.objectContaining({
      ok: true,
      control_plane_source: "postgres",
      license_health: expect.objectContaining({
        proof_record_source: "postgres",
        proof_record_count: 1,
        proof_records: expect.objectContaining({ issued: 1 }),
      }),
    }));
    expect(dojoSkillRegistry.getProofRecord(issued.proof_capsule.capsule_id)).toBeNull();

    const complianceExport = await dispatchDojoTool("synthi_dojo_export_compliance_pack", {
      skill_id: published.skill.skill_id,
      ...tenant,
      actor_id: "postgres-proof-auditor",
      actor_type: "human",
      roles: ["dojo:operator"],
      request_id: "req-postgres-proof-compliance-export",
      correlation_id: "corr-postgres-proof-compliance-export",
      now: "2026-06-11T00:01:30.000Z",
    });
    expect(complianceExport?.isError).toBeUndefined();
    const complianceContent = complianceExport?.structuredContent as {
      pack: {
        compliance_evidence_pack: { artifacts: Array<{ artifact_id: string; status: string }> };
        audit_exports: Array<{
          export_id: string;
          status: string;
          record_count: number;
          event_type_counts?: Record<string, number>;
        }>;
      };
      artifacts: Array<{ path: string; content: string; sensitive: boolean }>;
    };
    expect(complianceContent.pack.compliance_evidence_pack.artifacts).toEqual(expect.arrayContaining([
      expect.objectContaining({
        artifact_id: "proof_public_verification",
        status: "available",
      }),
      expect.objectContaining({
        artifact_id: "control_plane_audit",
        status: "available",
      }),
      expect.objectContaining({
        artifact_id: "executable_entrustment_provenance",
        status: "available",
      }),
    ]));
    expect(complianceContent.pack.audit_exports).toEqual(expect.arrayContaining([
      expect.objectContaining({
        export_id: "control_plane_audit",
        status: "available",
        record_count: expect.any(Number),
        event_type_counts: expect.objectContaining({
          license_issued: expect.any(Number),
          proof_issued: expect.any(Number),
          proof_validated: expect.any(Number),
          proof_key_upserted: expect.any(Number),
        }),
      }),
    ]));
    const publicVerificationArtifact = complianceContent.artifacts.find((artifact) =>
      artifact.path.includes("proof-public-verification")
    );
    expect(publicVerificationArtifact).toEqual(expect.objectContaining({
      sensitive: false,
    }));
    const complianceSkillArtifact = complianceContent.artifacts.find((artifact) => artifact.path.endsWith("/skill.json"));
    expect(complianceSkillArtifact).toEqual(expect.objectContaining({
      sensitive: false,
    }));
    const complianceSkill = JSON.parse(complianceSkillArtifact?.content ?? "null") as {
      executable_entrustment?: { schema_version: string; evidence_refs: string[] };
    };
    expect(complianceSkill.executable_entrustment).toEqual(expect.objectContaining({
      schema_version: "synthi.dojo.executableEntrustmentSnapshot.v1",
      evidence_refs: expect.any(Array),
    }));
    expect(complianceSkill.executable_entrustment?.evidence_refs.length).toBeGreaterThan(0);
    const publicVerificationBundle = JSON.parse(publicVerificationArtifact?.content ?? "null") as {
      schema_version: string;
      key_count: number;
      verifier: { package_export: string; function_name: string };
      proof_keys: Array<{
        key_id: string;
        signing_provider: string;
        key_custody: string;
        key_uri?: string;
        public_key_pem: string;
        public_key_pem_sha256: string;
        verification_available: boolean;
      }>;
      secret_policy: string;
    };
    expect(publicVerificationBundle).toEqual(expect.objectContaining({
      schema_version: "synthi.dojo.proofPublicVerificationBundle.v1",
      key_count: 1,
      verifier: expect.objectContaining({
        package_export: "@synthi-inc/mcp-server/dojo/proof/public-verifier",
        function_name: "verifyDojoProofCapsulePublicWithKeyRecord",
      }),
      secret_policy: "public_keys_only_no_private_or_hmac_secrets",
    }));
    expect(publicVerificationBundle.proof_keys).toEqual([
      expect.objectContaining({
        key_id: proofKeyPair.key_id,
        signing_provider: "external-command",
        key_custody: "external",
        public_key_pem: proofKeyPair.public_key_pem.trim(),
        public_key_pem_sha256: createHash("sha256").update(proofKeyPair.public_key_pem.trim(), "utf8").digest("hex"),
        verification_available: true,
      }),
    ]);
    expect(JSON.stringify(publicVerificationBundle)).not.toContain(proofKeyPair.private_key_pem);

    const session = await dispatchDojoTool("synthi_dojo_create_hosted_runtime_session", {
      skill_id: published.skill.skill_id,
      run_id: "postgres-proof-run-1",
      workspace_url: "https://app.example.test/settings",
      origin_allowlist: ["https://app.example.test"],
      ttl_ms: 600_000,
      credential_ttl_ms: 300_000,
      ...tenant,
      actor_id: "postgres-proof-agent",
      actor_type: "agent",
      roles: ["agent", "dojo:runtime:create"],
      request_id: "req-postgres-proof-session",
      correlation_id: "corr-postgres-proof-session",
      now: "2026-06-11T00:01:30.000Z",
    });
    expect(session?.isError).toBeUndefined();
    expect(session?.structuredContent).toEqual(expect.objectContaining({
      ok: true,
      control_plane_source: "postgres",
      skill_id: published.skill.skill_id,
    }));
    const sessionContent = session?.structuredContent as {
      runtime_session: { session_id: string; credential_id: string };
      credentials: { credential_id: string; credential_secret: string };
    };

    const run = await dispatchDojoTool("synthi_dojo_run_with_proof_capsule", {
      skill_id: published.skill.skill_id,
      requested_action: "run_prefix_validation",
      proof_capsule: issued.proof_capsule,
      run_id: "postgres-proof-run-1",
      runtime_session_id: sessionContent.runtime_session.session_id,
      runtime_credential_id: sessionContent.credentials.credential_id,
      runtime_credential_secret: sessionContent.credentials.credential_secret,
      runtime_action_url: "https://app.example.test/settings",
      ...tenant,
      actor_id: "postgres-proof-agent",
      actor_type: "agent",
      roles: ["agent"],
      request_id: "req-postgres-proof-run",
      correlation_id: "corr-postgres-proof-run",
      now: "2026-06-11T00:02:00.000Z",
    });
    expect(run?.isError).toBeUndefined();
    expect(run?.structuredContent).toEqual(expect.objectContaining({
      ok: true,
      control_plane_source: "postgres",
      proof_key: expect.objectContaining({
        key_id: proofKeyPair.key_id,
        algorithm: "ed25519",
        signing_provider: "external-command",
        key_custody: "external",
        status: "active",
      }),
      proof_consume: expect.objectContaining({ ok: true, status: "used" }),
      graph_runtime_preflight: expect.objectContaining({
        ok: true,
        status: "completed",
        node_results: [],
        evidence_refs: expect.arrayContaining([
          expect.stringMatching(/^evidence:dojo_graph_preflight_support_action_/),
        ]),
      }),
      graph_runtime_persistence: expect.objectContaining({
        ok: true,
        persisted: true,
        store_kind: "postgres",
        operation: "synthi_dojo_run_with_proof_capsule",
        graph_run_id: "postgres-proof-run-1_graph_preflight",
        graph_run_status: "completed",
        graph_status: "licensed",
        evidence_refs: expect.arrayContaining([
          expect.stringMatching(/^evidence:dojo_graph_preflight_support_action_/),
        ]),
      }),
      proof_record: expect.objectContaining({
        capsule_id: issued.proof_capsule.capsule_id,
        status: "used",
        first_used_at: "2026-06-11T00:02:00.000Z",
      }),
    }));
    const runContent = run?.structuredContent as {
      graph_runtime_persistence: {
        graph_id: string;
        graph_run_id: string;
        evidence_refs: string[];
      };
      runtime_authorization: {
        evidence_record_ids: string[];
      };
    };
    const runtimeAuthorizationEvidenceRefs = runContent.runtime_authorization.evidence_record_ids;
    expect(runtimeAuthorizationEvidenceRefs).toEqual([
      expect.stringMatching(/^evidence:dojo_runtime_action_evidence_[a-f0-9]{12}$/),
    ]);
    const runtimeAuthorizationRecordId = runtimeAuthorizationEvidenceRefs[0]!.replace(/^evidence:/, "");
    const evidenceLedgerStore = new PostgresDojoEvidenceLedgerStore({
      tenant_id: tenantId,
      workspace_id: workspaceId,
      queryable: pool,
    });
    const runtimeEvidenceRecords = await evidenceLedgerStore.listRecords();
    expect(runtimeEvidenceRecords).toEqual(expect.arrayContaining([
      expect.objectContaining({
        record_id: runtimeAuthorizationRecordId,
        skill_id: published.skill.skill_id,
        run_id: "postgres-proof-run-1",
        kind: "artifact",
        claim_ids: expect.arrayContaining([
          "runtime_action_authorized",
          "runtime_session_bound",
          "workspace_verified",
        ]),
        source_refs: expect.arrayContaining([
          `runtime_session:${sessionContent.runtime_session.session_id}`,
          "runtime_action:proof_gated_tool",
          "workspace_origin:https://app.example.test",
          "url_origin:https://app.example.test",
        ]),
      }),
    ]));
    const hostedRuntimeSessionStore = new PostgresDojoHostedRuntimeSessionStore({
      tenant_id: tenantId,
      workspace_id: workspaceId,
      queryable: pool,
    });
    await expect(hostedRuntimeSessionStore.getSession({
      tenant_id: tenantId,
      workspace_id: workspaceId,
      session_id: sessionContent.runtime_session.session_id,
    })).resolves.toEqual(expect.objectContaining({
      session_id: sessionContent.runtime_session.session_id,
      evidence_refs: expect.arrayContaining(runtimeAuthorizationEvidenceRefs),
    }));
    const graphRunStore = new PostgresDojoGraphRunStore({
      tenant_id: tenantId,
      workspace_id: workspaceId,
      queryable: pool,
    });
    await expect(graphRunStore.getSkillGraph(runContent.graph_runtime_persistence.graph_id)).resolves.toEqual(expect.objectContaining({
      graph_id: runContent.graph_runtime_persistence.graph_id,
      skill_id: published.skill.skill_id,
      status: "licensed",
      validation: expect.objectContaining({ ok: true }),
    }));
    await expect(graphRunStore.getGraphRun(runContent.graph_runtime_persistence.graph_run_id)).resolves.toEqual(expect.objectContaining({
      graph_run_id: runContent.graph_runtime_persistence.graph_run_id,
      graph_id: runContent.graph_runtime_persistence.graph_id,
      skill_id: published.skill.skill_id,
      mode: "production",
      status: "completed",
      evidence_refs: runContent.graph_runtime_persistence.evidence_refs,
      result: expect.objectContaining({
        run_id: "postgres-proof-run-1_graph_preflight",
        status: "completed",
      }),
      started_at: "2026-06-11T00:02:00.000Z",
      completed_at: "2026-06-11T00:02:00.000Z",
      created_by: "postgres-proof-agent",
    }));
    expect(await proofStore.getProofRecord(issued.proof_capsule.capsule_id)).toEqual(expect.objectContaining({
      status: "used",
      first_used_at: "2026-06-11T00:02:00.000Z",
    }));
    expect(dojoSkillRegistry.getProofRecord(issued.proof_capsule.capsule_id)).toBeNull();

    const replay = await dispatchDojoTool("synthi_dojo_run_with_proof_capsule", {
      skill_id: published.skill.skill_id,
      requested_action: "run_prefix_validation",
      proof_capsule: issued.proof_capsule,
      run_id: "postgres-proof-run-2",
      ...tenant,
      actor_id: "postgres-proof-agent",
      actor_type: "agent",
      roles: ["agent"],
      request_id: "req-postgres-proof-replay",
      correlation_id: "corr-postgres-proof-replay",
      now: "2026-06-11T00:03:00.000Z",
    });
    expect(replay?.isError).toBe(true);
    expect(replay?.structuredContent).toEqual(expect.objectContaining({
      validation: expect.objectContaining({
        blocked_by: expect.arrayContaining(["proof_capsule_replay_detected"]),
      }),
      license_kernel: expect.objectContaining({
        proof_record: expect.objectContaining({ status: "used" }),
      }),
    }));
  });
});

function recordOpenDetailsWorkflowForToolTest(workspaceId: string): void {
  const url = "https://app.example.test/settings";
  browserBroker.requestConsent(url);
  browserBroker.registerTabs([{ tab_id: "tab-a", url, active: true }]);
  browserBroker.selectTab("tab-a");
  expect(browserBroker.startTeachMode("tab-a").ok).toBe(true);
  sourceIdentityRegistry.register({
    workspaceId,
    filePath: "src/SettingsPanel.jsx",
    tokens: [{
      token: "details.open",
      file: "src/SettingsPanel.jsx",
      line: 12,
      column: 6,
      tag: "button",
    }],
  });
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

async function appendCaseLawEvidenceRecordForToolTest(
  pool: Pool,
  input: {
    tenant_id: string;
    workspace_id: string;
    skill_id: string;
    record_id: string;
    created_at: string;
    created_by: string;
    source_ref: string;
  }
) {
  return appendGovernanceEvidenceRecordForToolTest(pool, {
    ...input,
    kind: "case_law",
    run_id_prefix: "case_law",
    claim_ids: ["case_law_reviewed"],
  });
}

async function appendPublicationEvidenceRecordForToolTest(
  pool: Pool,
  input: {
    tenant_id: string;
    workspace_id: string;
    skill_id: string;
    record_id: string;
    created_at: string;
    created_by: string;
    source_ref: string;
  }
) {
  return appendGovernanceEvidenceRecordForToolTest(pool, {
    ...input,
    kind: "audit",
    run_id_prefix: "publication",
    claim_ids: ["skill_publication_reviewed", "publication_evidence_refs_recorded"],
  });
}

async function appendPublicationEvidenceForCurrentWorkflowForToolTest(
  pool: Pool,
  input: {
    tenant_id: string;
    workspace_id: string;
    record_id: string;
    created_at: string;
    created_by: string;
    source_ref: string;
  }
) {
  const workflowArtifact = browserBroker.workflowArtifact();
  expect(workflowArtifact.ok).toBe(true);
  if (!workflowArtifact.ok) throw new Error(workflowArtifact.error);
  const skill = buildDojoSkill(workflowArtifact.artifact.workflow.contract, {
    workspace_id: input.workspace_id,
    now: input.created_at,
  });
  await ensureDojoTenantWorkspace({
    queryable: pool,
    tenant: {
      tenant_id: input.tenant_id,
      organization_id: "org-a",
      workspace_id: input.workspace_id,
      actor_id: input.created_by,
      actor_type: "human",
      roles: ["dojo:operator"],
      request_id: `req-${input.record_id}`,
      correlation_id: `corr-${input.record_id}`,
    },
    app_origin: skill.app_origin,
  });
  const skillStore = new PostgresDojoSkillStore({
    tenant_id: input.tenant_id,
    workspace_id: input.workspace_id,
    queryable: pool,
  });
  await skillStore.saveSkill(skill, {
    status: "draft",
    created_by: {
      actor_id: input.created_by,
      actor_type: "human",
    },
    now: input.created_at,
  });
  const record = await appendPublicationEvidenceRecordForToolTest(pool, {
    ...input,
    skill_id: skill.skill_id,
  });
  return { skill, record };
}

async function seedSkillForPublicationEvidenceScopeMismatch(
  pool: Pool,
  input: {
    tenant_id: string;
    organization_id: string;
    workspace_id: string;
    skill: DojoSkill;
  }
): Promise<void> {
  await ensureDojoTenantWorkspace({
    queryable: pool,
    tenant: {
      tenant_id: input.tenant_id,
      organization_id: input.organization_id,
      workspace_id: input.workspace_id,
      actor_id: "dojo-publication-evidence-scope-test",
      actor_type: "human",
      roles: ["dojo:operator"],
      request_id: `req-${input.skill.skill_id}`,
      correlation_id: `corr-${input.skill.skill_id}`,
    },
    app_origin: input.skill.app_origin,
  });
  const skillStore = new PostgresDojoSkillStore({
    tenant_id: input.tenant_id,
    workspace_id: input.workspace_id,
    queryable: pool,
  });
  await skillStore.saveSkill(input.skill, {
    status: "draft",
    created_by: {
      actor_id: "dojo-publication-evidence-scope-test",
      actor_type: "human",
    },
    now: "2026-06-11T00:04:10.000Z",
  });
}

async function appendGovernanceEvidenceRecordForToolTest(
  pool: Pool,
  input: {
    tenant_id: string;
    workspace_id: string;
    skill_id: string;
    record_id: string;
    created_at: string;
    created_by: string;
    source_ref: string;
    kind: "case_law" | "checkride" | "license" | "proof" | "audit";
    run_id_prefix: string;
    claim_ids: string[];
  }
) {
  const payload = JSON.stringify({
    tenant_id: input.tenant_id,
    workspace_id: input.workspace_id,
    skill_id: input.skill_id,
    record_id: input.record_id,
    created_at: input.created_at,
    source_ref: input.source_ref,
  });
  const artifactSha256 = createHash("sha256").update(payload, "utf8").digest("hex");
  const redactionManifestSha256 = createHash("sha256").update(JSON.stringify({
    artifact_sha256: artifactSha256,
    redaction_policy: "metadata_only",
  }), "utf8").digest("hex");
  const ledgerStore = new PostgresDojoEvidenceLedgerStore({
    tenant_id: input.tenant_id,
    workspace_id: input.workspace_id,
    queryable: pool,
  });
  return ledgerStore.append({
    record_id: input.record_id,
    skill_id: input.skill_id,
    run_id: `${input.run_id_prefix}_${input.record_id}`,
    kind: input.kind,
    artifact_uri: `sha256://${artifactSha256}`,
    artifact_sha256: artifactSha256,
    redaction_manifest_sha256: redactionManifestSha256,
    claim_ids: input.claim_ids,
    created_at: input.created_at,
    created_by: input.created_by,
    retention_class: "standard",
    source_refs: [input.source_ref],
  });
}

function externalCommandProofSignerSource(): string {
  return `
    const { sign } = require("node:crypto");
    let body = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => { body += chunk; });
    process.stdin.on("end", () => {
      const request = JSON.parse(body);
      if (request.schema_version !== "synthi.dojo.externalSignerRequest.v1") {
        process.stderr.write("invalid external signer request schema");
        process.exit(8);
      }
      if (request.algorithm !== "ed25519") {
        process.stderr.write("invalid external signer request algorithm");
        process.exit(9);
      }
      if (!process.env.DOJO_TEST_PRIVATE_KEY_PEM) {
        process.stderr.write("missing test private key");
        process.exit(10);
      }
      const signature = sign(null, Buffer.from(request.payload, "utf8"), process.env.DOJO_TEST_PRIVATE_KEY_PEM).toString("base64url");
      process.stdout.write(JSON.stringify({
        schema_version: "synthi.dojo.externalSignerResponse.v1",
        algorithm: "ed25519",
        key_id: request.key_id,
        signature
      }));
    });
  `;
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

async function appendProofEvidenceRecordForToolTest(
  pool: Pool,
  skill: DojoSkill,
  options: {
    record_id: string;
    tenant_id: string;
    created_at?: string;
    created_by: string;
    source_ref: string;
  }
) {
  const createdAt = options.created_at ?? "2026-06-11T00:00:00.000Z";
  const claimIds = [...new Set([
    ...skill.permission_license.proof_requirements.required_evidence_claims,
    ...skill.permission_license.proof_requirements.required_context_claims,
  ])];
  const artifactPayload = JSON.stringify({
    claim_ids: claimIds,
    created_at: createdAt,
    record_id: options.record_id,
    skill_id: skill.skill_id,
  });
  const artifactSha256 = createHash("sha256").update(artifactPayload, "utf8").digest("hex");
  const redactionManifestSha256 = createHash("sha256").update(JSON.stringify({
    artifact_sha256: artifactSha256,
    redaction_policy: "metadata_only",
  }), "utf8").digest("hex");
  const ledgerStore = new PostgresDojoEvidenceLedgerStore({
    tenant_id: options.tenant_id,
    workspace_id: skill.workspace_id,
    queryable: pool,
  });
  return ledgerStore.append({
    record_id: options.record_id,
    skill_id: skill.skill_id,
    run_id: `checkride-${skill.skill_id}`,
    kind: "checkride",
    artifact_uri: `memory://dojo/tests/${skill.skill_id}/checkride`,
    artifact_sha256: artifactSha256,
    redaction_manifest_sha256: redactionManifestSha256,
    claim_ids: claimIds,
    created_at: createdAt,
    created_by: options.created_by,
    retention_class: "ephemeral",
    source_refs: [options.source_ref],
  });
}
