import { randomUUID } from "node:crypto";
import type { QueryResultRow } from "pg";
import type { DojoPostgresClient, DojoPostgresConnectable } from "../store/postgres_proof_store.js";
import {
  buildDojoEvidenceLedgerRecord,
  buildDojoLedgerCheckpoint,
} from "./ledger_record.js";
import type {
  DojoEvidenceArtifactKind,
  DojoEvidenceLedgerRecord,
  DojoEvidenceRecordInput,
  DojoEvidenceRetentionClass,
  DojoLedgerCheckpoint,
  DojoLedgerVerification,
} from "./types.js";

const ZERO_HASH = "0".repeat(64);

export interface PostgresDojoEvidenceLedgerStoreOptions {
  tenant_id: string;
  workspace_id: string;
  queryable: DojoPostgresConnectable;
}

interface EvidenceRecordRow extends QueryResultRow {
  record_id: string;
  tenant_id: string;
  workspace_id: string;
  skill_id: string;
  run_id: string;
  kind: DojoEvidenceArtifactKind;
  artifact_uri: string;
  artifact_sha256: string;
  redaction_manifest_sha256: string | null;
  claim_ids: string[];
  previous_hash: string;
  record_hash: string;
  ledger_head_hash: string;
  signer_key_id: string | null;
  signature: string | null;
  created_at: Date | string;
  created_by: string;
  retention_class: DojoEvidenceRetentionClass;
  legal_hold: boolean;
  source_refs: string[];
}

interface CheckpointRow extends QueryResultRow {
  ledger_head_hash: string;
  record_count: number;
  created_at: Date | string;
}

export class PostgresDojoEvidenceLedgerStore {
  private readonly tenantId: string;
  private readonly workspaceId: string;
  private readonly queryable: DojoPostgresConnectable;

  constructor(options: PostgresDojoEvidenceLedgerStoreOptions) {
    this.tenantId = requiredId(options.tenant_id, "tenant_id");
    this.workspaceId = requiredId(options.workspace_id, "workspace_id");
    this.queryable = options.queryable;
  }

  async append(input: Omit<DojoEvidenceRecordInput, "tenant_id" | "workspace_id" | "previous_hash">): Promise<DojoEvidenceLedgerRecord> {
    return this.withTransaction(async (client) => {
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`dojo-evidence-ledger:${this.tenantId}:${this.workspaceId}`]);
      const checkpoint = await this.latestCheckpoint(client);
      const record = buildDojoEvidenceLedgerRecord({
        ...input,
        tenant_id: this.tenantId,
        workspace_id: this.workspaceId,
        previous_hash: checkpoint?.ledger_head_hash ?? ZERO_HASH,
      });
      await client.query(
        `INSERT INTO dojo_evidence_records (
          tenant_id,
          workspace_id,
          record_id,
          skill_id,
          run_id,
          kind,
          artifact_uri,
          artifact_sha256,
          redaction_manifest_sha256,
          claim_ids,
          previous_hash,
          record_hash,
          ledger_head_hash,
          signer_key_id,
          signature,
          created_at,
          created_by,
          retention_class,
          legal_hold,
          source_refs,
          record_json
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::text[], $11, $12, $13, $14, $15, $16::timestamptz, $17, $18, $19, $20::text[], $21::jsonb)`,
        [
          record.tenant_id,
          record.workspace_id,
          record.record_id,
          record.skill_id,
          record.run_id,
          record.kind,
          record.artifact_uri,
          record.artifact_sha256,
          record.redaction_manifest_sha256,
          record.claim_ids,
          record.previous_hash,
          record.record_hash,
          record.ledger_head_hash,
          record.signer_key_id,
          record.signature,
          record.created_at,
          record.created_by,
          record.retention_class,
          record.legal_hold,
          record.source_refs,
          JSON.stringify(record),
        ]
      );
      await this.insertCheckpoint(client, buildDojoLedgerCheckpoint({
        tenant_id: this.tenantId,
        workspace_id: this.workspaceId,
        ledger_head_hash: record.ledger_head_hash,
        record_count: (checkpoint?.record_count ?? 0) + 1,
        created_at: record.created_at,
      }));
      return record;
    });
  }

  async listRecords(): Promise<DojoEvidenceLedgerRecord[]> {
    const result = await this.queryable.query<EvidenceRecordRow>(
      `SELECT record_id, tenant_id, workspace_id, skill_id, run_id, kind, artifact_uri, artifact_sha256,
        redaction_manifest_sha256, claim_ids, previous_hash, record_hash, ledger_head_hash, signer_key_id,
        signature, created_at, created_by, retention_class, legal_hold, source_refs
      FROM dojo_evidence_records
      WHERE tenant_id = $1 AND workspace_id = $2
      ORDER BY created_at ASC, record_id ASC`,
      [this.tenantId, this.workspaceId]
    );
    return result.rows.map(rowToEvidenceRecord);
  }

  async latestCheckpoint(): Promise<DojoLedgerCheckpoint | null>;
  async latestCheckpoint(queryable: DojoPostgresClient): Promise<DojoLedgerCheckpoint | null>;
  async latestCheckpoint(queryable: DojoPostgresConnectable = this.queryable): Promise<DojoLedgerCheckpoint | null> {
    const result = await queryable.query<CheckpointRow>(
      `SELECT ledger_head_hash, record_count, created_at
      FROM dojo_ledger_checkpoints
      WHERE tenant_id = $1 AND workspace_id = $2
      ORDER BY created_at DESC, checkpoint_id DESC
      LIMIT 1`,
      [this.tenantId, this.workspaceId]
    );
    const row = result.rows[0];
    if (!row) return null;
    return buildDojoLedgerCheckpoint({
      tenant_id: this.tenantId,
      workspace_id: this.workspaceId,
      ledger_head_hash: row.ledger_head_hash,
      record_count: Number(row.record_count),
      created_at: iso(row.created_at),
    });
  }

  async verifyRecordChain(checkedAt: string = new Date().toISOString()): Promise<DojoLedgerVerification> {
    if (!Number.isFinite(Date.parse(checkedAt))) {
      return {
        ok: false,
        checked_at: checkedAt,
        blocked_by: ["evidence_ledger_checked_at_invalid"],
      };
    }
    const records = await this.listRecords();
    let previousHash = ZERO_HASH;
    let headHash: string | undefined;
    for (const record of records) {
      const rebuilt = buildDojoEvidenceLedgerRecord(recordToInput(record));
      if (record.previous_hash !== previousHash) {
        return {
          ok: false,
          checked_at: checkedAt,
          ledger_head_hash: headHash,
          failed_record_id: record.record_id,
          blocked_by: ["evidence_previous_hash_mismatch"],
        };
      }
      if (rebuilt.record_hash !== record.record_hash) {
        return {
          ok: false,
          checked_at: checkedAt,
          ledger_head_hash: headHash,
          failed_record_id: record.record_id,
          blocked_by: ["evidence_record_hash_mismatch"],
        };
      }
      previousHash = record.record_hash;
      headHash = record.ledger_head_hash;
    }
    const checkpoint = await this.latestCheckpoint();
    if (checkpoint && checkpoint.record_count !== records.length) {
      return {
        ok: false,
        checked_at: checkedAt,
        ledger_head_hash: checkpoint.ledger_head_hash,
        failed_record_id: records.at(-1)?.record_id,
        blocked_by: ["evidence_checkpoint_record_count_mismatch"],
      };
    }
    if (checkpoint && checkpoint.ledger_head_hash !== (headHash ?? ZERO_HASH)) {
      return {
        ok: false,
        checked_at: checkedAt,
        ledger_head_hash: checkpoint.ledger_head_hash,
        failed_record_id: records.at(-1)?.record_id,
        blocked_by: ["evidence_checkpoint_head_mismatch"],
      };
    }
    return {
      ok: true,
      checked_at: checkedAt,
      ledger_head_hash: headHash ?? ZERO_HASH,
      blocked_by: [],
    };
  }

  private async insertCheckpoint(client: DojoPostgresClient, checkpoint: DojoLedgerCheckpoint): Promise<void> {
    await client.query(
      `INSERT INTO dojo_ledger_checkpoints (
        tenant_id,
        workspace_id,
        checkpoint_id,
        ledger_head_hash,
        record_count,
        created_at
      ) VALUES ($1, $2, $3, $4, $5, $6::timestamptz)`,
      [
        checkpoint.tenant_id,
        checkpoint.workspace_id,
        randomUUID(),
        checkpoint.ledger_head_hash,
        checkpoint.record_count,
        checkpoint.created_at,
      ]
    );
  }

  private async withTransaction<T>(operation: (client: DojoPostgresClient) => Promise<T>): Promise<T> {
    const client: DojoPostgresClient = this.queryable.connect ? await this.queryable.connect() : this.queryable;
    await client.query("BEGIN");
    try {
      const result = await operation(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release?.();
    }
  }
}

function rowToEvidenceRecord(row: EvidenceRecordRow): DojoEvidenceLedgerRecord {
  return {
    schema_version: "synthi.dojo.evidenceRecord.v1",
    record_id: row.record_id,
    tenant_id: row.tenant_id,
    workspace_id: row.workspace_id,
    skill_id: row.skill_id,
    run_id: row.run_id,
    kind: row.kind,
    artifact_uri: row.artifact_uri,
    artifact_sha256: row.artifact_sha256,
    redaction_manifest_sha256: row.redaction_manifest_sha256,
    claim_ids: row.claim_ids,
    previous_hash: row.previous_hash,
    record_hash: row.record_hash,
    ledger_head_hash: row.ledger_head_hash,
    signer_key_id: row.signer_key_id,
    signature: row.signature,
    created_at: iso(row.created_at),
    created_by: row.created_by,
    retention_class: row.retention_class,
    legal_hold: row.legal_hold,
    source_refs: row.source_refs,
  };
}

function recordToInput(record: DojoEvidenceLedgerRecord): DojoEvidenceRecordInput {
  return {
    record_id: record.record_id,
    tenant_id: record.tenant_id,
    workspace_id: record.workspace_id,
    skill_id: record.skill_id,
    run_id: record.run_id,
    kind: record.kind,
    artifact_uri: record.artifact_uri,
    artifact_sha256: record.artifact_sha256,
    redaction_manifest_sha256: record.redaction_manifest_sha256 ?? undefined,
    claim_ids: record.claim_ids,
    previous_hash: record.previous_hash,
    signer_key_id: record.signer_key_id ?? undefined,
    created_at: record.created_at,
    created_by: record.created_by,
    retention_class: record.retention_class,
    legal_hold: record.legal_hold,
    source_refs: record.source_refs,
  };
}

function requiredId(value: string, field: string): string {
  const trimmed = value.trim();
  if (!trimmed) throw new Error(`dojo_evidence_${field}_required`);
  return trimmed;
}

function iso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}
