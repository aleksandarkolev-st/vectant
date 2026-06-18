import { Pool } from "pg";
import {
  DOJO_EVIDENCE_LEDGER_POSTGRES_URL_ENV,
  DOJO_EVIDENCE_LEDGER_STORE_ENV,
  resolveDojoEvidenceLedgerStoreConfig,
} from "../config/enforcement.js";
import type { DojoTenantContext } from "../mcp/execution_policy_gate.js";
import { ensureDojoTenantWorkspace } from "../store/control_plane_resolver.js";
import type { DojoPostgresQueryable } from "../store/postgres_proof_store.js";
import { PostgresDojoEvidenceLedgerStore } from "./ledger_store.js";
import type { DojoEvidenceLedgerRecord, DojoEvidenceRecordInput, DojoLedgerVerification } from "./types.js";

export interface DojoEvidenceLedgerRecordResolutionInput {
  tenant_id: string;
  workspace_id: string;
  record_ids: string[];
  ledger_checkpoint_hash?: string;
  checked_at?: string;
  env?: NodeJS.ProcessEnv;
}

export interface DojoEvidenceLedgerRecordResolution {
  ok: boolean;
  store_kind: string;
  configured_env: string[];
  records: DojoEvidenceLedgerRecord[];
  verification?: DojoLedgerVerification;
  ledger_checkpoint_hash?: string;
  missing_record_ids: string[];
  blocked_by: string[];
}

export interface DojoEvidenceLedgerAppendStore {
  append(input: Omit<DojoEvidenceRecordInput, "tenant_id" | "workspace_id" | "previous_hash">): Promise<DojoEvidenceLedgerRecord>;
}

export interface DojoEvidenceLedgerAppendStoreResolution {
  ok: boolean;
  store_kind: string;
  configured_env: string[];
  blocked_by: string[];
  evidence_ledger?: DojoEvidenceLedgerAppendStore;
  queryable?: DojoPostgresQueryable;
  close?: () => Promise<void>;
}

export async function resolveDojoEvidenceLedgerRecords(
  input: DojoEvidenceLedgerRecordResolutionInput
): Promise<DojoEvidenceLedgerRecordResolution> {
  const env = input.env ?? process.env;
  const storeConfig = resolveDojoEvidenceLedgerStoreConfig(env);
  const requestedRecordIds = uniqueNonEmpty(input.record_ids);
  if (requestedRecordIds.length === 0) {
    return blockedResolution(storeConfig, ["evidence_record_ids_missing"], []);
  }
  if (storeConfig.store_kind !== "postgres") {
    return blockedResolution(storeConfig, [`evidence_ledger_store_kind_unsupported:${storeConfig.store_kind}`], requestedRecordIds);
  }

  const connectionString = postgresConnectionStringFromEnv(env);
  if (!connectionString) {
    return blockedResolution(storeConfig, ["evidence_ledger_postgres_url_missing"], requestedRecordIds);
  }

  const pool = new Pool({ connectionString });
  try {
    const store = new PostgresDojoEvidenceLedgerStore({
      tenant_id: input.tenant_id,
      workspace_id: input.workspace_id,
      queryable: pool,
    });
    const verification = await store.verifyRecordChain(input.checked_at);
    if (!verification.ok) {
      return {
        ok: false,
        store_kind: storeConfig.store_kind,
        configured_env: storeConfig.configured_env,
        records: [],
        verification,
        ledger_checkpoint_hash: verification.ledger_head_hash,
        missing_record_ids: [],
        blocked_by: verification.blocked_by,
      };
    }
    const records = await store.listRecords();
    let checkpointRecordCount = records.length;
    let checkpointHash = verification.ledger_head_hash;
    if (input.ledger_checkpoint_hash) {
      const checkpoint = await store.checkpointForHeadHash(input.ledger_checkpoint_hash);
      const checkpointRecord = checkpoint && checkpoint.record_count > 0
        ? records[checkpoint.record_count - 1]
        : undefined;
      if (
        !checkpoint
        || checkpoint.record_count > records.length
        || checkpointRecord?.ledger_head_hash !== input.ledger_checkpoint_hash
      ) {
        return {
          ok: false,
          store_kind: storeConfig.store_kind,
          configured_env: storeConfig.configured_env,
          records: [],
          verification,
          ledger_checkpoint_hash: verification.ledger_head_hash,
          missing_record_ids: [],
          blocked_by: ["evidence_ledger_checkpoint_mismatch"],
        };
      }
      checkpointRecordCount = checkpoint.record_count;
      checkpointHash = checkpoint.ledger_head_hash;
    }
    const checkpointRecords = records.slice(0, checkpointRecordCount);
    const selected = checkpointRecords.filter((record) => requestedRecordIds.includes(record.record_id));
    const selectedIds = new Set(selected.map((record) => record.record_id));
    const missing = requestedRecordIds.filter((recordId) => !selectedIds.has(recordId));
    if (missing.length > 0) {
      return {
        ok: false,
        store_kind: storeConfig.store_kind,
        configured_env: storeConfig.configured_env,
        records: selected,
        verification,
        ledger_checkpoint_hash: checkpointHash,
        missing_record_ids: missing,
        blocked_by: missing.map((recordId) => `evidence_record_missing:${recordId}`),
      };
    }
    return {
      ok: true,
      store_kind: storeConfig.store_kind,
      configured_env: storeConfig.configured_env,
      records: selected,
      verification,
      ledger_checkpoint_hash: checkpointHash,
      missing_record_ids: [],
      blocked_by: [],
    };
  } catch {
    return {
      ok: false,
      store_kind: storeConfig.store_kind,
      configured_env: storeConfig.configured_env,
      records: [],
      missing_record_ids: requestedRecordIds,
      blocked_by: ["evidence_ledger_resolve_failed"],
    };
  } finally {
    await pool.end().catch(() => undefined);
  }
}

export async function resolveDojoEvidenceLedgerAppendStore(input: {
  tenant_id: string;
  workspace_id: string;
  tenant_context?: DojoTenantContext;
  app_origin?: string;
  env?: NodeJS.ProcessEnv;
}): Promise<DojoEvidenceLedgerAppendStoreResolution> {
  const env = input.env ?? process.env;
  const storeConfig = resolveDojoEvidenceLedgerStoreConfig(env);
  if (storeConfig.store_kind !== "postgres") {
    return {
      ok: false,
      store_kind: storeConfig.store_kind,
      configured_env: storeConfig.configured_env,
      blocked_by: [
        ...storeConfig.blocked_by,
        `evidence_ledger_append_store_kind_unsupported:${storeConfig.store_kind}`,
      ],
    };
  }

  const connectionString = postgresConnectionStringFromEnv(env);
  if (!connectionString) {
    return {
      ok: false,
      store_kind: storeConfig.store_kind,
      configured_env: storeConfig.configured_env,
      blocked_by: [...storeConfig.blocked_by, "evidence_ledger_postgres_url_missing"],
    };
  }

  const pool = new Pool({ connectionString });
  if (input.tenant_context) {
    try {
      await ensureDojoTenantWorkspace({
        queryable: pool,
        tenant: input.tenant_context,
        app_origin: input.app_origin,
      });
    } catch {
      await pool.end().catch(() => undefined);
      return {
        ok: false,
        store_kind: storeConfig.store_kind,
        configured_env: storeConfig.configured_env,
        blocked_by: ["evidence_ledger_scope_initialization_failed"],
      };
    }
  }
  return {
    ok: true,
    store_kind: storeConfig.store_kind,
    configured_env: storeConfig.configured_env,
    blocked_by: [],
    evidence_ledger: new PostgresDojoEvidenceLedgerStore({
      tenant_id: input.tenant_id,
      workspace_id: input.workspace_id,
      queryable: pool,
    }),
    queryable: pool,
    close: async () => {
      await pool.end().catch(() => undefined);
    },
  };
}

function postgresConnectionStringFromEnv(env: NodeJS.ProcessEnv): string | undefined {
  const explicit = nonEmpty(env[DOJO_EVIDENCE_LEDGER_POSTGRES_URL_ENV]);
  if (explicit) return explicit;
  const store = nonEmpty(env[DOJO_EVIDENCE_LEDGER_STORE_ENV]);
  if (store && (store.startsWith("postgres://") || store.startsWith("postgresql://"))) return store;
  return undefined;
}

function blockedResolution(
  storeConfig: ReturnType<typeof resolveDojoEvidenceLedgerStoreConfig>,
  blockedBy: string[],
  missingRecordIds: string[]
): DojoEvidenceLedgerRecordResolution {
  return {
    ok: false,
    store_kind: storeConfig.store_kind,
    configured_env: storeConfig.configured_env,
    records: [],
    missing_record_ids: missingRecordIds,
    blocked_by: [...storeConfig.blocked_by, ...blockedBy],
  };
}

function uniqueNonEmpty(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function nonEmpty(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}
