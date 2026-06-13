import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { resolveDojoEvidenceLedgerRecords } from "../../src/dojo/evidence/ledger_resolver.js";
import { PostgresDojoEvidenceLedgerStore } from "../../src/dojo/evidence/ledger_store.js";
import { applyDojoPostgresMigrations } from "../../src/dojo/store/postgres_proof_store.js";

const postgresUrl = process.env["SYNTHI_DOJO_POSTGRES_TEST_URL"];
const describeWithPostgres = postgresUrl ? describe : describe.skip;

describeWithPostgres("PostgresDojoEvidenceLedgerStore", () => {
  let pool: Pool;
  let tenantId: string;
  let workspaceId: string;
  let skillId: string;

  beforeAll(async () => {
    if (!postgresUrl) throw new Error("SYNTHI_DOJO_POSTGRES_TEST_URL required");
    pool = new Pool({ connectionString: postgresUrl });
    await applyDojoPostgresMigrations(pool);
  });

  beforeEach(async () => {
    tenantId = `tenant_evidence_${Date.now()}_${Math.random().toString(16).slice(2)}`;
    workspaceId = "workspace_a";
    skillId = "skill_a";
    await seedSkill(pool, tenantId, workspaceId, skillId);
  });

  afterAll(async () => {
    if (pool) await pool.end();
  });

  it("appends evidence records, advances checkpoints, and verifies the chain", async () => {
    const store = new PostgresDojoEvidenceLedgerStore({ tenant_id: tenantId, workspace_id: workspaceId, queryable: pool });

    const first = await store.append(evidenceInput("evidence_a", skillId, "run_a", "a".repeat(64), "2026-06-11T00:01:00.000Z"));
    const second = await store.append(evidenceInput("evidence_b", skillId, "run_b", "b".repeat(64), "2026-06-11T00:02:00.000Z"));

    expect(first.previous_hash).toBe("0".repeat(64));
    expect(second.previous_hash).toBe(first.record_hash);
    expect(await store.listRecords()).toEqual([
      expect.objectContaining({ record_id: "evidence_a", ledger_head_hash: first.record_hash }),
      expect.objectContaining({ record_id: "evidence_b", ledger_head_hash: second.record_hash }),
    ]);
    expect(await store.latestCheckpoint()).toEqual(expect.objectContaining({
      ledger_head_hash: second.record_hash,
      record_count: 2,
    }));
    expect(await store.verifyRecordChain("2026-06-11T00:03:00.000Z")).toEqual({
      ok: true,
      checked_at: "2026-06-11T00:03:00.000Z",
      ledger_head_hash: second.record_hash,
      blocked_by: [],
    });

    await expect(resolveDojoEvidenceLedgerRecords({
      tenant_id: tenantId,
      workspace_id: workspaceId,
      record_ids: ["evidence_b"],
      ledger_checkpoint_hash: second.record_hash,
      checked_at: "2026-06-11T00:03:00.000Z",
      env: {
        SYNTHI_DOJO_EVIDENCE_LEDGER_STORE: "postgres",
        SYNTHI_DOJO_EVIDENCE_LEDGER_POSTGRES_URL: postgresUrl,
      },
    })).resolves.toEqual(expect.objectContaining({
      ok: true,
      store_kind: "postgres",
      ledger_checkpoint_hash: second.record_hash,
      missing_record_ids: [],
      blocked_by: [],
      records: [expect.objectContaining({ record_id: "evidence_b" })],
    }));
  });

  it("detects tampered evidence records", async () => {
    const store = new PostgresDojoEvidenceLedgerStore({ tenant_id: tenantId, workspace_id: workspaceId, queryable: pool });
    await store.append(evidenceInput("evidence_tamper", skillId, "run_a", "c".repeat(64), "2026-06-11T00:01:00.000Z"));

    await pool.query(
      `UPDATE dojo_evidence_records
      SET artifact_sha256 = $4
      WHERE tenant_id = $1 AND workspace_id = $2 AND record_id = $3`,
      [tenantId, workspaceId, "evidence_tamper", "d".repeat(64)]
    );

    expect(await store.verifyRecordChain("2026-06-11T00:04:00.000Z")).toEqual(expect.objectContaining({
      ok: false,
      failed_record_id: "evidence_tamper",
      blocked_by: ["evidence_record_hash_mismatch"],
    }));
  });

  it("fails chain verification when the verification timestamp is malformed", async () => {
    const store = new PostgresDojoEvidenceLedgerStore({ tenant_id: tenantId, workspace_id: workspaceId, queryable: pool });
    await store.append(evidenceInput("evidence_checked_at", skillId, "run_a", "1".repeat(64), "2026-06-11T00:01:00.000Z"));

    expect(await store.verifyRecordChain("not-a-date")).toEqual({
      ok: false,
      checked_at: "not-a-date",
      blocked_by: ["evidence_ledger_checked_at_invalid"],
    });
  });

  it("detects tampered ledger checkpoint record counts", async () => {
    const store = new PostgresDojoEvidenceLedgerStore({ tenant_id: tenantId, workspace_id: workspaceId, queryable: pool });
    const record = await store.append(evidenceInput("evidence_checkpoint_count", skillId, "run_a", "2".repeat(64), "2026-06-11T00:01:00.000Z"));

    await pool.query(
      `UPDATE dojo_ledger_checkpoints
      SET record_count = $4
      WHERE tenant_id = $1 AND workspace_id = $2 AND ledger_head_hash = $3`,
      [tenantId, workspaceId, record.record_hash, 3]
    );

    expect(await store.verifyRecordChain("2026-06-11T00:04:00.000Z")).toEqual(expect.objectContaining({
      ok: false,
      failed_record_id: "evidence_checkpoint_count",
      ledger_head_hash: record.record_hash,
      blocked_by: ["evidence_checkpoint_record_count_mismatch"],
    }));
  });

  it("isolates ledger reads by tenant", async () => {
    const otherTenantId = `${tenantId}_other`;
    await seedSkill(pool, otherTenantId, workspaceId, skillId);
    const tenantStore = new PostgresDojoEvidenceLedgerStore({ tenant_id: tenantId, workspace_id: workspaceId, queryable: pool });
    const otherStore = new PostgresDojoEvidenceLedgerStore({ tenant_id: otherTenantId, workspace_id: workspaceId, queryable: pool });

    await tenantStore.append(evidenceInput("evidence_isolated", skillId, "run_a", "e".repeat(64), "2026-06-11T00:01:00.000Z"));

    expect(await tenantStore.listRecords()).toHaveLength(1);
    expect(await otherStore.listRecords()).toEqual([]);
    expect(await otherStore.latestCheckpoint()).toBeNull();
  });
});

async function seedSkill(pool: Pool, tenantId: string, workspaceId: string, skillId: string): Promise<void> {
  await pool.query(
    `INSERT INTO dojo_tenants (tenant_id, organization_id, display_name)
    VALUES ($1, $2, $3)
    ON CONFLICT (tenant_id) DO NOTHING`,
    [tenantId, "org_a", tenantId]
  );
  await pool.query(
    `INSERT INTO dojo_workspaces (tenant_id, workspace_id, organization_id, app_origin)
    VALUES ($1, $2, $3, $4)
    ON CONFLICT (tenant_id, workspace_id) DO NOTHING`,
    [tenantId, workspaceId, "org_a", "https://app.example.test"]
  );
  await pool.query(
    `INSERT INTO dojo_skills (tenant_id, workspace_id, skill_id, workflow_id, name, current_skill_version, skill_json)
    VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)
    ON CONFLICT (tenant_id, skill_id) DO NOTHING`,
    [tenantId, workspaceId, skillId, `workflow_${skillId}`, "Evidence Test Skill", "skill_v1", JSON.stringify({ skill_id: skillId })]
  );
}

function evidenceInput(recordId: string, skillId: string, runId: string, artifactSha: string, createdAt: string) {
  return {
    record_id: recordId,
    skill_id: skillId,
    run_id: runId,
    kind: "checkride" as const,
    artifact_uri: `sha256://${artifactSha}`,
    artifact_sha256: artifactSha,
    redaction_manifest_sha256: "f".repeat(64),
    claim_ids: ["checkride_passed", "workspace_verified"],
    signer_key_id: "key_a",
    created_at: createdAt,
    created_by: "dojo-checkride",
    retention_class: "standard" as const,
    source_refs: ["trace:trace-a"],
  };
}
