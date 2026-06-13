import { createHash } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { browserBroker } from "../../src/browser/broker.js";
import { InMemoryDojoSkillStore } from "../../src/browser/dojo_store.js";
import { dojoSkillRegistry } from "../../src/browser/dojo.js";
import { InMemoryPrivateWorkflowToolStore, privateWorkflowToolRegistry } from "../../src/browser/private_tool_registry.js";
import { sourceIdentityRegistry } from "../../src/browser/source_identity.js";
import { PostgresDojoEvidenceLedgerStore } from "../../src/dojo/evidence/ledger_store.js";
import { applyDojoPostgresMigrations } from "../../src/dojo/store/postgres_proof_store.js";
import { dispatchDojoTool } from "../../src/tools/dojo.js";

const postgresUrl = process.env["SYNTHI_DOJO_POSTGRES_TEST_URL"];
const describeWithPostgres = postgresUrl ? describe : describe.skip;
const originalEnv = { ...process.env };

describeWithPostgres("Dojo proof issuance from Postgres evidence ledger", () => {
  let pool: Pool;
  let tenantId: string;
  let workspaceId: string;
  let organizationId: string;

  beforeAll(async () => {
    if (!postgresUrl) throw new Error("SYNTHI_DOJO_POSTGRES_TEST_URL required");
    pool = new Pool({ connectionString: postgresUrl });
    await applyDojoPostgresMigrations(pool);
  });

  beforeEach(() => {
    process.env = { ...originalEnv };
    tenantId = uniqueId("tenant_tool_ledger");
    workspaceId = "workspace-a";
    organizationId = "org-a";
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

  it("issues a production proof capsule from evidence record IDs resolved through Postgres", async () => {
    process.env.SYNTHI_DOJO_PRODUCTION_ENFORCEMENT = "1";
    process.env.SYNTHI_DOJO_REQUIRE_EVIDENCE_LEDGER = "1";
    process.env.SYNTHI_DOJO_EVIDENCE_LEDGER_STORE = "postgres";
    process.env.SYNTHI_DOJO_EVIDENCE_LEDGER_POSTGRES_URL = postgresUrl;

    recordOpenDetailsWorkflow();
    const publish = await dispatchDojoTool("synthi_dojo_publish_skill", {
      workspace_id: workspaceId,
      reason: "postgres_evidence_ledger_tool_test",
      evidence_refs: ["evidence:publish-integration"],
      ...tenantContext({
        actor_id: "integration-publisher",
        actor_type: "human",
        request_id: "req-postgres-proof-publish",
        correlation_id: "corr-postgres-proof-publish",
      }),
    });
    expect(publish?.isError).toBeUndefined();
    const skillId = (publish?.structuredContent as { skill: { skill_id: string } }).skill.skill_id;
    const skill = dojoSkillRegistry.get(skillId);
    expect(skill).toBeTruthy();

    await seedSkillRow(pool, {
      tenant_id: tenantId,
      organization_id: organizationId,
      workspace_id: workspaceId,
      skill_id: skillId,
      workflow_id: skill!.workflow_id,
      skill_name: skill!.name,
      skill_json: skill!,
    });

    const requiredClaims = skill!.permission_license.proof_requirements.required_evidence_claims;
    expect(requiredClaims.length).toBeGreaterThan(0);
    const createdAt = "2026-06-11T00:00:00.000Z";
    const checkedAt = "2026-06-11T00:05:00.000Z";
    const artifactPayload = JSON.stringify({
      tenant_id: tenantId,
      workspace_id: workspaceId,
      skill_id: skillId,
      claim_ids: requiredClaims,
      created_at: createdAt,
    });
    const artifactSha = sha256(artifactPayload);
    const redactionSha = sha256(JSON.stringify({
      artifact_sha256: artifactSha,
      redacted_fields: [],
    }));
    const recordId = `evidence_${sha256(`${tenantId}:${workspaceId}:${skillId}:checkride`).slice(0, 24)}`;
    const ledgerStore = new PostgresDojoEvidenceLedgerStore({
      tenant_id: tenantId,
      workspace_id: workspaceId,
      queryable: pool,
    });
    const evidenceRecord = await ledgerStore.append({
      record_id: recordId,
      skill_id: skillId,
      run_id: `checkride_${skillId}`,
      kind: "checkride",
      artifact_uri: `sha256://${artifactSha}`,
      artifact_sha256: artifactSha,
      redaction_manifest_sha256: redactionSha,
      claim_ids: requiredClaims,
      signer_key_id: "integration-ledger-key",
      created_at: createdAt,
      created_by: "dojo-proof-ledger-tool-test",
      retention_class: "standard",
      source_refs: ["trace:open-details"],
    });

    const response = await dispatchDojoTool("synthi_dojo_issue_proof_capsule", {
      skill_id: skillId,
      ...tenantContext({
        actor_id: "integration-proof-issuer",
        request_id: "req-postgres-proof-issue",
        correlation_id: "corr-postgres-proof-issue",
      }),
      requested_action: "run_workflow",
      context_claims: { workspace_verified: true },
      evidence_record_ids: [evidenceRecord.record_id],
      ledger_checkpoint_hash: evidenceRecord.ledger_head_hash,
      now: checkedAt,
      expires_at: "2026-06-11T00:15:00.000Z",
    });

    expect(response?.isError).toBeUndefined();
    expect(response?.structuredContent).toEqual(expect.objectContaining({
      ok: true,
      skill_id: skillId,
      requested_action: "run_workflow",
      enforcement_mode: "production",
      require_verified_evidence: true,
      proof_capsule: expect.objectContaining({
        skill_id: skillId,
        evidence_record_ids: [evidenceRecord.record_id],
        ledger_checkpoint_hash: evidenceRecord.ledger_head_hash,
      }),
      proof_record: expect.objectContaining({
        skill_id: skillId,
        tenant_id: tenantId,
        workspace_id: workspaceId,
        evidence_record_ids: [evidenceRecord.record_id],
        ledger_checkpoint_hash: evidenceRecord.ledger_head_hash,
      }),
      validation: expect.objectContaining({
        ok: true,
        blocked_by: [],
      }),
    }));
  });

  function tenantContext(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      tenant_id: tenantId,
      organization_id: organizationId,
      workspace_id: workspaceId,
      actor_id: "integration-agent",
      actor_type: "agent",
      roles: ["agent"],
      request_id: "req-postgres-proof",
      correlation_id: "corr-postgres-proof",
      ...overrides,
    };
  }
});

function recordOpenDetailsWorkflow(): void {
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

async function seedSkillRow(
  pool: Pool,
  input: {
    tenant_id: string;
    organization_id: string;
    workspace_id: string;
    skill_id: string;
    workflow_id: string;
    skill_name: string;
    skill_json: unknown;
  }
): Promise<void> {
  await pool.query(
    `INSERT INTO dojo_tenants (tenant_id, organization_id, display_name)
    VALUES ($1, $2, $3)
    ON CONFLICT (tenant_id) DO NOTHING`,
    [input.tenant_id, input.organization_id, input.tenant_id]
  );
  await pool.query(
    `INSERT INTO dojo_workspaces (tenant_id, workspace_id, organization_id, app_origin)
    VALUES ($1, $2, $3, $4)
    ON CONFLICT (tenant_id, workspace_id) DO NOTHING`,
    [input.tenant_id, input.workspace_id, input.organization_id, "https://app.example.test"]
  );
  await pool.query(
    `INSERT INTO dojo_skills (tenant_id, workspace_id, skill_id, workflow_id, name, status, current_skill_version, skill_json)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)
    ON CONFLICT (tenant_id, skill_id) DO UPDATE SET
      workspace_id = EXCLUDED.workspace_id,
      workflow_id = EXCLUDED.workflow_id,
      name = EXCLUDED.name,
      status = EXCLUDED.status,
      current_skill_version = EXCLUDED.current_skill_version,
      skill_json = EXCLUDED.skill_json,
      updated_at = now()`,
    [
      input.tenant_id,
      input.workspace_id,
      input.skill_id,
      input.workflow_id,
      input.skill_name,
      "published",
      "skill_v1",
      JSON.stringify(input.skill_json),
    ]
  );
}

function registerSourceToken(token: string): void {
  const filePath = `src/${token}.tsx`;
  sourceIdentityRegistry.register({
    workspaceId: "workspace-a",
    filePath,
    adapter: "integration-test",
    transformVersion: "integration_source_identity_v1",
    tokens: [{ token, file: filePath, tag: "button", line: 1, column: 1 }],
  });
}

function uniqueId(prefix: string): string {
  return `${prefix}_${Date.now()}_${Math.random().toString(16).slice(2)}`;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
