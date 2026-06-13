import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { PostgresDojoAuditStore } from "../../src/dojo/store/audit_store.js";
import {
  PostgresDojoProofKeyRegistry,
} from "../../src/dojo/store/postgres_proof_key_registry.js";
import {
  applyDojoPostgresMigrations,
} from "../../src/dojo/store/postgres_proof_store.js";
import {
  buildDojoProofKeyRecord,
} from "../../src/dojo/proof/key_registry.js";
import {
  canonicalDojoProofPayload,
  createEd25519DojoProofSigner,
  encodeDojoProofSignatureEnvelope,
  generateEd25519DojoProofKeyPair,
} from "../../src/dojo/proof/signing.js";
import { verifyDojoProofCapsulePublic, type DojoPublicProofCapsule } from "../../src/dojo/proof/public_verifier.js";

const postgresUrl = process.env["SYNTHI_DOJO_POSTGRES_TEST_URL"];
const describeWithPostgres = postgresUrl ? describe : describe.skip;

describeWithPostgres("PostgresDojoProofKeyRegistry", () => {
  let pool: Pool;
  let tenantId: string;
  let workspaceId: string;

  beforeAll(async () => {
    if (!postgresUrl) throw new Error("SYNTHI_DOJO_POSTGRES_TEST_URL required");
    pool = new Pool({ connectionString: postgresUrl });
    await applyDojoPostgresMigrations(pool);
  });

  beforeEach(async () => {
    tenantId = `tenant_${Date.now()}_${Math.random().toString(16).slice(2)}`;
    workspaceId = "workspace_a";
    await seedTenantWorkspace(pool, tenantId, workspaceId);
  });

  afterAll(async () => {
    if (pool) await pool.end();
  });

  it("persists keys, selects the newest active key, and resolves a public verifier", async () => {
    const registry = new PostgresDojoProofKeyRegistry({ tenant_id: tenantId, queryable: pool });
    const oldKey = generateEd25519DojoProofKeyPair("ed-key-old");
    const newKey = generateEd25519DojoProofKeyPair("ed-key-new");

    await registry.upsert(recordFor(tenantId, oldKey, { created_at: "2026-06-11T00:00:00.000Z" }));
    await registry.upsert(recordFor(tenantId, newKey, { created_at: "2026-06-11T00:05:00.000Z" }));

    expect(await registry.active({ issuer: "issuer-a", algorithm: "ed25519" })).toEqual(expect.objectContaining({
      tenant_id: tenantId,
      key_id: "ed-key-new",
      status: "active",
    }));
    expect((await registry.list()).map((record) => record.key_id)).toEqual(["ed-key-old", "ed-key-new"]);

    const resolution = await registry.resolveVerifier({ key_id: newKey.key_id });
    const signer = createEd25519DojoProofSigner({
      key_id: newKey.key_id,
      private_key_pem: newKey.private_key_pem,
    });
    const capsule = signedCapsule({ key_id: newKey.key_id, signer });

    expect(resolution).toEqual(expect.objectContaining({
      ok: true,
      status: "resolved",
      blocked_by: [],
    }));
    expect(verifyDojoProofCapsulePublic({
      capsule,
      verifier: resolution.verifier!,
      expected: { issuer: "issuer-a", key_id: newKey.key_id, requested_action: "run_workflow" },
      now: "2026-06-11T00:06:00.000Z",
    })).toEqual(expect.objectContaining({ ok: true, signature_verified: true }));
  });

  it("retires rotated keys, blocks revoked keys, and allows explicit forensic verification", async () => {
    const registry = new PostgresDojoProofKeyRegistry({ tenant_id: tenantId, queryable: pool });
    const keyPair = generateEd25519DojoProofKeyPair("ed-key-a");
    await registry.upsert(recordFor(tenantId, keyPair));

    expect(await registry.rotate({
      key_id: keyPair.key_id,
      rotated_at: "2026-06-11T01:00:00.000Z",
    })).toEqual(expect.objectContaining({
      key_id: keyPair.key_id,
      status: "retired",
      rotated_at: "2026-06-11T01:00:00.000Z",
    }));
    expect(await registry.resolveVerifier({ key_id: keyPair.key_id })).toEqual(expect.objectContaining({
      ok: true,
      status: "resolved",
    }));

    expect(await registry.revoke({
      key_id: keyPair.key_id,
      revoked_at: "2026-06-11T02:00:00.000Z",
      retain_for_forensic_verification: true,
    })).toEqual(expect.objectContaining({
      key_id: keyPair.key_id,
      status: "revoked",
      revoked_at: "2026-06-11T02:00:00.000Z",
      retain_for_forensic_verification: true,
    }));
    expect(await registry.resolveVerifier({ key_id: keyPair.key_id })).toEqual(expect.objectContaining({
      ok: false,
      status: "blocked",
      blocked_by: ["proof_key_revoked"],
    }));
    expect(await registry.resolveVerifier({
      key_id: keyPair.key_id,
      allow_forensic_verification: true,
    })).toEqual(expect.objectContaining({ ok: true, status: "resolved" }));
  });

  it("prevents cross-tenant reads and rejects mismatched writes", async () => {
    const otherTenantId = `${tenantId}_other`;
    await seedTenantWorkspace(pool, otherTenantId, workspaceId);
    const tenantRegistry = new PostgresDojoProofKeyRegistry({ tenant_id: tenantId, queryable: pool });
    const otherRegistry = new PostgresDojoProofKeyRegistry({ tenant_id: otherTenantId, queryable: pool });
    const keyPair = generateEd25519DojoProofKeyPair("ed-key-tenant");

    await tenantRegistry.upsert(recordFor(tenantId, keyPair));

    expect(await tenantRegistry.get({ key_id: keyPair.key_id })).toEqual(expect.objectContaining({ key_id: keyPair.key_id }));
    expect(await otherRegistry.get({ key_id: keyPair.key_id })).toBeNull();
    expect(await tenantRegistry.active({ tenant_id: otherTenantId })).toBeNull();
    expect(await tenantRegistry.resolveVerifier({ tenant_id: otherTenantId, key_id: keyPair.key_id })).toEqual(
      expect.objectContaining({ ok: false, status: "not_found", blocked_by: ["proof_key_not_found"] })
    );
    await expect(tenantRegistry.upsert(recordFor(otherTenantId, keyPair))).rejects.toThrow("dojo_postgres_proof_key_tenant_mismatch");
  });

  it("emits audit events for key custody writes when an audit store is supplied", async () => {
    const auditStore = new PostgresDojoAuditStore({ tenant_id: tenantId, workspace_id: workspaceId, queryable: pool });
    const registry = new PostgresDojoProofKeyRegistry({
      tenant_id: tenantId,
      workspace_id: workspaceId,
      queryable: pool,
      audit_store: auditStore,
      audit_actor: { actor_id: "security-admin-a", actor_type: "human" },
      request_id: "proof-key-request-a",
      correlation_id: "proof-key-correlation-a",
    });
    const keyPair = generateEd25519DojoProofKeyPair("ed-key-audit");

    await registry.upsert(recordFor(tenantId, keyPair));
    await registry.rotate({ key_id: keyPair.key_id, rotated_at: "2026-06-11T01:00:00.000Z" });
    await registry.revoke({ key_id: keyPair.key_id, revoked_at: "2026-06-11T02:00:00.000Z" });

    const auditEvents = await auditStore.listAuditEvents({ entity_kind: "proof_key", entity_id: keyPair.key_id });
    expect(auditEvents.map((event) => event.event_type)).toEqual([
      "proof_key_upserted",
      "proof_key_rotated",
      "proof_key_revoked",
    ]);
    expect(auditEvents.every((event) => event.actor.actor_id === "security-admin-a")).toBe(true);
    expect(auditEvents.every((event) => event.request_id === "proof-key-request-a")).toBe(true);
  });
});

async function seedTenantWorkspace(pool: Pool, tenantId: string, workspaceId: string): Promise<void> {
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
}

function recordFor(
  tenantId: string,
  keyPair: { key_id: string; public_key_pem: string },
  overrides: Partial<Parameters<typeof buildDojoProofKeyRecord>[0]> = {}
) {
  return buildDojoProofKeyRecord({
    tenant_id: tenantId,
    key_id: keyPair.key_id,
    issuer: "issuer-a",
    algorithm: "ed25519",
    public_key_pem: keyPair.public_key_pem,
    status: "active",
    created_at: "2026-06-11T00:00:00.000Z",
    ...overrides,
  });
}

function signedCapsule(input: {
  key_id: string;
  signer: ReturnType<typeof createEd25519DojoProofSigner>;
}): DojoPublicProofCapsule {
  const unsigned = {
    schema_version: "synthi.dojo.proofCapsule.v1",
    capsule_id: "capsule-a",
    skill_id: "skill-a",
    skill_version: "1.0.0",
    requested_action: "run_workflow",
    license_version: "license-v1",
    issuer: "issuer-a",
    key_id: input.key_id,
    nonce: "nonce-a",
    issued_at: "2026-06-11T00:00:00.000Z",
    expires_at: "2026-06-11T00:15:00.000Z",
    signature_algorithm: "ed25519" as const,
  };
  return {
    ...unsigned,
    signature: encodeDojoProofSignatureEnvelope(input.signer.sign(canonicalDojoProofPayload(unsigned))),
  };
}
