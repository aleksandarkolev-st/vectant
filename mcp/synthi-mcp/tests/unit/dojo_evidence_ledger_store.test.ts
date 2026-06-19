import { describe, expect, it } from "vitest";
import { buildDojoEvidenceLedgerRecord } from "../../src/dojo/evidence/ledger_record.js";
import { PostgresDojoEvidenceLedgerStore } from "../../src/dojo/evidence/ledger_store.js";
import type { DojoEvidenceLedgerRecord } from "../../src/dojo/evidence/types.js";

describe("PostgresDojoEvidenceLedgerStore verification", () => {
  it("detects tampered row head hashes even when the checkpoint is changed to match", async () => {
    const tenantId = "tenant-ledger-unit";
    const workspaceId = "workspace-ledger-unit";
    const record = evidenceRecord(tenantId, workspaceId);
    const tamperedHeadHash = "f".repeat(64);
    const store = new PostgresDojoEvidenceLedgerStore({
      tenant_id: tenantId,
      workspace_id: workspaceId,
      queryable: fakeLedgerQueryable({
        records: [{ ...record, ledger_head_hash: tamperedHeadHash }],
        checkpoint: {
          ledger_head_hash: tamperedHeadHash,
          record_count: 1,
          created_at: "2026-06-11T00:01:00.000Z",
        },
      }),
    });

    await expect(store.verifyRecordChain("2026-06-11T00:02:00.000Z")).resolves.toEqual({
      ok: false,
      checked_at: "2026-06-11T00:02:00.000Z",
      ledger_head_hash: tamperedHeadHash,
      failed_record_id: record.record_id,
      blocked_by: ["evidence_record_head_hash_mismatch"],
    });
  });
});

function evidenceRecord(tenantId: string, workspaceId: string): DojoEvidenceLedgerRecord {
  return buildDojoEvidenceLedgerRecord({
    record_id: "evidence-ledger-head",
    tenant_id: tenantId,
    workspace_id: workspaceId,
    skill_id: "skill-ledger-head",
    run_id: "run-ledger-head",
    kind: "checkride",
    artifact_uri: "sha256://ledger-head",
    artifact_sha256: "a".repeat(64),
    redaction_manifest_sha256: "b".repeat(64),
    claim_ids: ["checkride_passed", "workspace_verified"],
    signer_key_id: "ledger-key-unit",
    created_at: "2026-06-11T00:01:00.000Z",
    created_by: "dojo-ledger-unit",
    retention_class: "standard",
    source_refs: ["trace:ledger-head"],
  });
}

function fakeLedgerQueryable(input: {
  records: DojoEvidenceLedgerRecord[];
  checkpoint: { ledger_head_hash: string; record_count: number; created_at: string } | null;
}) {
  return {
    async query(sql: string) {
      if (sql.includes("FROM dojo_evidence_records")) {
        return { rows: input.records };
      }
      if (sql.includes("FROM dojo_ledger_checkpoints")) {
        return { rows: input.checkpoint ? [input.checkpoint] : [] };
      }
      throw new Error(`unexpected_query:${sql}`);
    },
  };
}
