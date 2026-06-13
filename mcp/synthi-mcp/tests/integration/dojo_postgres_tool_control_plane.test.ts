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

  it("uses Postgres skill and proof records for production validation, consumption, and replay after local process loss", async () => {
    const tenantId = `tenant_proof_${Date.now()}_${Math.random().toString(16).slice(2)}`;
    const workspaceId = `workspace_proof_${Math.random().toString(16).slice(2)}`;
    process.env.SYNTHI_DOJO_PRODUCTION_ENFORCEMENT = "1";
    process.env.SYNTHI_DOJO_REQUIRE_DURABLE_STORE = "1";
    process.env.SYNTHI_DOJO_CONTROL_PLANE_STORE = "postgres";
    process.env.SYNTHI_DOJO_CONTROL_PLANE_POSTGRES_URL = postgresUrl;

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
      proof_capsule: { capsule_id: string };
      proof_record: { status: string };
    };
    expect(issued.control_plane_source).toBe("postgres");
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
    }));

    const skillStore = new PostgresDojoSkillStore({
      tenant_id: tenantId,
      workspace_id: workspaceId,
      queryable: pool,
    });
    const savedSkill = await skillStore.getSkill(published.skill.skill_id);
    expect(savedSkill).toBeTruthy();
    dojoSkillRegistry.useStoreForTests(new InMemoryDojoSkillStore());
    dojoSkillRegistry.resetForTests();
    expect(dojoSkillRegistry.get(published.skill.skill_id)).toBeNull();
    expect(dojoSkillRegistry.getProofRecord(issued.proof_capsule.capsule_id)).toBeNull();

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
      }),
    }));
    expect(dojoSkillRegistry.get(published.skill.skill_id)).toBeNull();

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
      proof_record: expect.objectContaining({
        capsule_id: issued.proof_capsule.capsule_id,
        status: "issued",
        last_validated_at: "2026-06-11T00:01:00.000Z",
      }),
    }));
    expect(dojoSkillRegistry.getProofRecord(issued.proof_capsule.capsule_id)).toBeNull();

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
  const claimIds = skill.permission_license.proof_requirements.required_evidence_claims;
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
