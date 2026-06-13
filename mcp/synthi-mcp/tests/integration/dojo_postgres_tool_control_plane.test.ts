import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { createHash } from "node:crypto";
import { browserBroker } from "../../src/browser/broker.js";
import {
  dojoSkillRegistry,
  type DojoSkill,
} from "../../src/browser/dojo.js";
import { InMemoryDojoSkillStore } from "../../src/browser/dojo_store.js";
import { InMemoryPrivateWorkflowToolStore, privateWorkflowToolRegistry } from "../../src/browser/private_tool_registry.js";
import { sourceIdentityRegistry } from "../../src/browser/source_identity.js";
import { PostgresDojoLicenseStore } from "../../src/dojo/store/postgres_license_store.js";
import { applyDojoPostgresMigrations } from "../../src/dojo/store/postgres_proof_store.js";
import { PostgresDojoProofStore } from "../../src/dojo/store/postgres_proof_store.js";
import { buildDojoEvidenceLedgerRecord } from "../../src/dojo/evidence/ledger_record.js";
import { generateEd25519DojoProofKeyPair } from "../../src/dojo/proof/signing.js";
import { PostgresDojoAuditStore } from "../../src/dojo/store/audit_store.js";
import { PostgresDojoGhostShadowEvidenceStore } from "../../src/dojo/store/postgres_ghost_shadow_evidence_store.js";
import { PostgresDojoGovernanceStore } from "../../src/dojo/store/postgres_governance_store.js";
import { PostgresDojoGraphRunStore } from "../../src/dojo/store/postgres_graph_run_store.js";
import { PostgresDojoProofKeyRegistry } from "../../src/dojo/store/postgres_proof_key_registry.js";
import { PostgresDojoSkillStore } from "../../src/dojo/store/postgres_skill_store.js";
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
      skill: expect.objectContaining({ skill_id: published.skill.skill_id }),
      recertification: expect.objectContaining({
        status: "applied",
        reason: "integration_postgres_recertification",
        evidence_refs: ["evidence:integration-postgres-recertification"],
        previous_license_version: published.license.license_version,
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
      recertification: { control_plane_persistence: { audit_event_id: string } };
    };

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

  it("persists permission upgrade request and review through Postgres after local reset", async () => {
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

    const review = await dispatchDojoTool("synthi_dojo_review_permission_upgrade", {
      ...tenant,
      request_id: requestContent.permission_upgrade_request.request_id,
      decision: "approved",
      reviewer_actor_id: "postgres-upgrade-reviewer",
      reviewer_actor_type: "human",
      reason: "Evidence reviewed in durable control plane.",
      evidence_refs: ["evidence:integration-postgres-upgrade-review"],
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
    }));
    await expect(governanceStore.listPermissionUpgradeRequests({ request_id: requestContent.permission_upgrade_request.request_id })).resolves.toEqual([
      expect.objectContaining({
        request_id: requestContent.permission_upgrade_request.request_id,
        status: "approved",
        reviewed_by: { actor_id: "postgres-upgrade-reviewer", actor_type: "human" },
      }),
    ]);
    expect(dojoSkillRegistry.get(published.skill.skill_id)).toBeNull();
    expect(dojoSkillRegistry.listPermissionUpgradeRequests({ request_id: requestContent.permission_upgrade_request.request_id })).toEqual([]);
  });

  it("persists case law proposal and review through Postgres after local reset", async () => {
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
      roles: ["agent"],
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
      roles: ["agent"],
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
      roles: ["agent"],
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
    process.env.SYNTHI_DOJO_CONTROL_PLANE_STORE = "postgres";
    process.env.SYNTHI_DOJO_CONTROL_PLANE_POSTGRES_URL = postgresUrl;
    process.env.SYNTHI_DOJO_PROOF_SIGNING_PROVIDER = "ed25519-local";
    process.env.SYNTHI_DOJO_PROOF_SIGNING_KEY_ID = proofKeyPair.key_id;
    process.env.SYNTHI_DOJO_PROOF_SIGNING_PRIVATE_KEY_PEM = proofKeyPair.private_key_pem;
    process.env.SYNTHI_DOJO_PROOF_SIGNING_PUBLIC_KEY_PEM = proofKeyPair.public_key_pem;

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
    const publish = await dispatchDojoTool("synthi_dojo_publish_skill", {
      workspace_id: workspaceId,
      reason: "integration_postgres_proof_publish",
      evidence_refs: ["evidence:integration-postgres-proof-publish"],
      ...tenant,
    });
    expect(publish?.isError).toBeUndefined();
    const published = publish?.structuredContent as {
      skill: { skill_id: string; workflow_id: string };
    };
    const skill = dojoSkillRegistry.get(published.skill.skill_id);
    expect(skill).toBeTruthy();

    const issue = await dispatchDojoTool("synthi_dojo_issue_proof_capsule", {
      skill_id: published.skill.skill_id,
      requested_action: "run_prefix_validation",
      context_claims: { workspace_verified: true },
      evidence_ledger_records: evidenceLedgerRecordsForProof(skill!, {
        record_id: `evidence-${published.skill.skill_id}-postgres-proof`,
        tenant_id: tenantId,
      }),
      require_verified_evidence: true,
      ...tenant,
      actor_id: "postgres-proof-agent",
      actor_type: "agent",
      roles: ["agent"],
      request_id: "req-postgres-proof-issue",
      correlation_id: "corr-postgres-proof-issue",
      now: "2026-06-11T00:00:00.000Z",
      expires_at: "2026-06-11T00:15:00.000Z",
    });
    expect(issue?.isError).toBeUndefined();
    const issued = issue?.structuredContent as {
      control_plane_source: string;
      proof_key: { key_id: string; issuer: string; algorithm: string; status: string };
      proof_capsule: { capsule_id: string; key_id: string; signature_algorithm: string };
      proof_record: { status: string };
    };
    expect(issued.control_plane_source).toBe("postgres");
    expect(issued.proof_key).toEqual(expect.objectContaining({
      key_id: proofKeyPair.key_id,
      algorithm: "ed25519",
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
    delete process.env.SYNTHI_DOJO_PROOF_SIGNING_PRIVATE_KEY_PEM;
    delete process.env.SYNTHI_DOJO_PROOF_SIGNING_PUBLIC_KEY_PEM;
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
    const publicVerificationBundle = JSON.parse(publicVerificationArtifact?.content ?? "null") as {
      schema_version: string;
      key_count: number;
      verifier: { package_export: string; function_name: string };
      proof_keys: Array<{
        key_id: string;
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
      roles: ["agent"],
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
        status: "active",
      }),
      proof_consume: expect.objectContaining({ ok: true, status: "used" }),
      proof_record: expect.objectContaining({
        capsule_id: issued.proof_capsule.capsule_id,
        status: "used",
        first_used_at: "2026-06-11T00:02:00.000Z",
      }),
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
    record_id: string;
    tenant_id: string;
    created_at?: string;
  }
): ReturnType<typeof buildDojoEvidenceLedgerRecord>[] {
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
  return [
    buildDojoEvidenceLedgerRecord({
      record_id: options.record_id,
      tenant_id: options.tenant_id,
      workspace_id: skill.workspace_id,
      skill_id: skill.skill_id,
      run_id: `checkride-${skill.skill_id}`,
      kind: "checkride",
      artifact_uri: `memory://dojo/tests/${skill.skill_id}/checkride`,
      artifact_sha256: createHash("sha256").update(artifactPayload, "utf8").digest("hex"),
      claim_ids: claimIds,
      created_at: createdAt,
      created_by: "dojo-postgres-tool-control-plane-test",
      retention_class: "ephemeral",
    }),
  ];
}
