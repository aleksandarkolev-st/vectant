import {
  createEd25519DojoProofVerifier,
  type DojoProofSigningAlgorithm,
  type DojoProofVerifier,
} from "./signing.js";

export type DojoProofKeyStatus = "active" | "retired" | "revoked";

export interface DojoProofKeyRecord {
  schema_version: "synthi.dojo.proofKey.v1";
  tenant_id: string;
  key_id: string;
  issuer: string;
  algorithm: DojoProofSigningAlgorithm;
  public_key_pem: string;
  status: DojoProofKeyStatus;
  created_at: string;
  rotated_at?: string;
  revoked_at?: string;
  retain_for_forensic_verification: boolean;
}

export interface DojoProofKeyResolution {
  ok: boolean;
  status: "resolved" | "blocked" | "not_found";
  key?: DojoProofKeyRecord;
  verifier?: DojoProofVerifier;
  blocked_by: string[];
}

export class InMemoryDojoProofKeyRegistry {
  private readonly records = new Map<string, DojoProofKeyRecord>();

  upsert(record: DojoProofKeyRecord): DojoProofKeyRecord {
    const normalized = normalizeKeyRecord(record);
    this.records.set(recordKey(normalized.tenant_id, normalized.key_id), normalized);
    return clone(normalized);
  }

  get(input: { tenant_id: string; key_id: string }): DojoProofKeyRecord | null {
    const record = this.records.get(recordKey(input.tenant_id, input.key_id));
    return record ? clone(record) : null;
  }

  list(tenantId: string): DojoProofKeyRecord[] {
    return [...this.records.values()]
      .filter((record) => record.tenant_id === tenantId)
      .sort((left, right) => left.created_at.localeCompare(right.created_at) || left.key_id.localeCompare(right.key_id))
      .map(clone);
  }

  active(input: {
    tenant_id: string;
    issuer?: string;
    algorithm?: DojoProofSigningAlgorithm;
  }): DojoProofKeyRecord | null {
    const candidates = this.list(input.tenant_id)
      .filter((record) => record.status === "active")
      .filter((record) => !input.issuer || record.issuer === input.issuer)
      .filter((record) => !input.algorithm || record.algorithm === input.algorithm)
      .sort((left, right) => right.created_at.localeCompare(left.created_at) || right.key_id.localeCompare(left.key_id));
    return candidates[0] ?? null;
  }

  rotate(input: { tenant_id: string; key_id: string; rotated_at: string }): DojoProofKeyRecord {
    const record = this.requireKey(input.tenant_id, input.key_id);
    if (record.status === "revoked") throw new Error("dojo_proof_key_revoked");
    const next = {
      ...record,
      status: "retired" as const,
      rotated_at: input.rotated_at,
    };
    this.records.set(recordKey(next.tenant_id, next.key_id), next);
    return clone(next);
  }

  revoke(input: {
    tenant_id: string;
    key_id: string;
    revoked_at: string;
    retain_for_forensic_verification?: boolean;
  }): DojoProofKeyRecord {
    const record = this.requireKey(input.tenant_id, input.key_id);
    const next = {
      ...record,
      status: "revoked" as const,
      revoked_at: input.revoked_at,
      retain_for_forensic_verification: input.retain_for_forensic_verification === true,
    };
    this.records.set(recordKey(next.tenant_id, next.key_id), next);
    return clone(next);
  }

  resolveVerifier(input: {
    tenant_id: string;
    key_id: string;
    allow_forensic_verification?: boolean;
  }): DojoProofKeyResolution {
    const key = this.get(input);
    if (!key) {
      return {
        ok: false,
        status: "not_found",
        blocked_by: ["proof_key_not_found"],
      };
    }
    if (key.status === "revoked" && !(input.allow_forensic_verification && key.retain_for_forensic_verification)) {
      return {
        ok: false,
        status: "blocked",
        key,
        blocked_by: ["proof_key_revoked"],
      };
    }
    if (key.algorithm !== "ed25519") {
      return {
        ok: false,
        status: "blocked",
        key,
        blocked_by: ["proof_key_public_verifier_unavailable"],
      };
    }
    return {
      ok: true,
      status: "resolved",
      key,
      verifier: createEd25519DojoProofVerifier({
        key_id: key.key_id,
        public_key_pem: key.public_key_pem,
      }),
      blocked_by: [],
    };
  }

  clear(): void {
    this.records.clear();
  }

  private requireKey(tenantId: string, keyId: string): DojoProofKeyRecord {
    const record = this.get({ tenant_id: tenantId, key_id: keyId });
    if (!record) throw new Error("dojo_proof_key_not_found");
    return record;
  }
}

export function buildDojoProofKeyRecord(input: Omit<DojoProofKeyRecord, "schema_version" | "retain_for_forensic_verification"> & {
  retain_for_forensic_verification?: boolean;
}): DojoProofKeyRecord {
  return normalizeKeyRecord({
    schema_version: "synthi.dojo.proofKey.v1",
    ...input,
    retain_for_forensic_verification: input.retain_for_forensic_verification === true,
  });
}

function normalizeKeyRecord(record: DojoProofKeyRecord): DojoProofKeyRecord {
  if (record.schema_version !== "synthi.dojo.proofKey.v1") throw new Error("dojo_proof_key_schema_mismatch");
  requireNonEmpty(record.tenant_id, "tenant_id");
  requireNonEmpty(record.key_id, "key_id");
  requireNonEmpty(record.issuer, "issuer");
  if (record.algorithm !== "ed25519" && record.algorithm !== "hmac-sha256") throw new Error("dojo_proof_key_algorithm_invalid");
  requireNonEmpty(record.public_key_pem, "public_key_pem");
  if (record.status !== "active" && record.status !== "retired" && record.status !== "revoked") throw new Error("dojo_proof_key_status_invalid");
  requireTimestamp(record.created_at, "created_at");
  if (record.rotated_at !== undefined) requireTimestamp(record.rotated_at, "rotated_at");
  if (record.revoked_at !== undefined) requireTimestamp(record.revoked_at, "revoked_at");
  return {
    ...record,
    retain_for_forensic_verification: record.retain_for_forensic_verification === true,
  };
}

function recordKey(tenantId: string, keyId: string): string {
  return `${tenantId}\0${keyId}`;
}

function requireNonEmpty(value: string, field: string): void {
  if (!value.trim()) throw new Error(`dojo_proof_key_${field}_required`);
}

function requireTimestamp(value: string, field: string): void {
  if (!Number.isFinite(Date.parse(value))) throw new Error(`dojo_proof_key_${field}_invalid`);
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
