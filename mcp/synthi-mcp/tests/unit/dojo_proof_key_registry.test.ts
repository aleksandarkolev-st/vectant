import { describe, expect, it } from "vitest";
import {
  buildDojoProofKeyRecord,
  InMemoryDojoProofKeyRegistry,
} from "../../src/dojo/proof/key_registry.js";
import {
  canonicalDojoProofPayload,
  createEd25519DojoProofSigner,
  encodeDojoProofSignatureEnvelope,
  generateEd25519DojoProofKeyPair,
} from "../../src/dojo/proof/signing.js";
import { verifyDojoProofCapsulePublic, type DojoPublicProofCapsule } from "../../src/dojo/proof/public_verifier.js";

describe("Dojo proof key registry", () => {
  it("resolves active Ed25519 keys to public verifiers", () => {
    const registry = new InMemoryDojoProofKeyRegistry();
    const keyPair = generateEd25519DojoProofKeyPair("ed-key-a");
    registry.upsert(buildDojoProofKeyRecord({
      tenant_id: "tenant-a",
      key_id: keyPair.key_id,
      issuer: "issuer-a",
      algorithm: "ed25519",
      public_key_pem: keyPair.public_key_pem,
      status: "active",
      created_at: "2026-06-11T00:00:00.000Z",
    }));
    const signer = createEd25519DojoProofSigner({
      key_id: keyPair.key_id,
      private_key_pem: keyPair.private_key_pem,
    });
    const capsule = signedCapsule({ key_id: keyPair.key_id, signer });
    const resolution = registry.resolveVerifier({ tenant_id: "tenant-a", key_id: keyPair.key_id });

    expect(resolution).toEqual(expect.objectContaining({
      ok: true,
      status: "resolved",
      blocked_by: [],
    }));
    expect(verifyDojoProofCapsulePublic({
      capsule,
      verifier: resolution.verifier!,
      expected: { issuer: "issuer-a", key_id: keyPair.key_id, requested_action: "run_workflow" },
      now: "2026-06-11T00:01:00.000Z",
    })).toEqual(expect.objectContaining({ ok: true, signature_verified: true }));
  });

  it("selects the newest active key and isolates tenant lookups", () => {
    const registry = new InMemoryDojoProofKeyRegistry();
    const oldKey = generateEd25519DojoProofKeyPair("ed-key-old");
    const newKey = generateEd25519DojoProofKeyPair("ed-key-new");
    registry.upsert(recordFor(oldKey, { created_at: "2026-06-11T00:00:00.000Z" }));
    registry.upsert(recordFor(newKey, { created_at: "2026-06-11T00:05:00.000Z" }));
    registry.upsert(recordFor(generateEd25519DojoProofKeyPair("ed-key-other-tenant"), {
      tenant_id: "tenant-b",
      created_at: "2026-06-11T00:10:00.000Z",
    }));

    expect(registry.active({ tenant_id: "tenant-a", issuer: "issuer-a", algorithm: "ed25519" })?.key_id).toBe("ed-key-new");
    expect(registry.resolveVerifier({ tenant_id: "tenant-a", key_id: "ed-key-other-tenant" })).toEqual(
      expect.objectContaining({ ok: false, status: "not_found", blocked_by: ["proof_key_not_found"] })
    );
  });

  it("retires old keys during rotation but keeps them usable for historical verification", () => {
    const registry = new InMemoryDojoProofKeyRegistry();
    const keyPair = generateEd25519DojoProofKeyPair("ed-key-a");
    registry.upsert(recordFor(keyPair));

    expect(registry.rotate({
      tenant_id: "tenant-a",
      key_id: keyPair.key_id,
      rotated_at: "2026-06-11T01:00:00.000Z",
    })).toEqual(expect.objectContaining({
      status: "retired",
      rotated_at: "2026-06-11T01:00:00.000Z",
    }));
    expect(registry.resolveVerifier({ tenant_id: "tenant-a", key_id: keyPair.key_id })).toEqual(
      expect.objectContaining({ ok: true, status: "resolved" })
    );
  });

  it("blocks revoked keys unless forensic verification is explicitly allowed", () => {
    const registry = new InMemoryDojoProofKeyRegistry();
    const keyPair = generateEd25519DojoProofKeyPair("ed-key-a");
    registry.upsert(recordFor(keyPair));
    registry.revoke({
      tenant_id: "tenant-a",
      key_id: keyPair.key_id,
      revoked_at: "2026-06-11T01:00:00.000Z",
      retain_for_forensic_verification: true,
    });

    expect(registry.resolveVerifier({ tenant_id: "tenant-a", key_id: keyPair.key_id })).toEqual(
      expect.objectContaining({ ok: false, status: "blocked", blocked_by: ["proof_key_revoked"] })
    );
    expect(registry.resolveVerifier({
      tenant_id: "tenant-a",
      key_id: keyPair.key_id,
      allow_forensic_verification: true,
    })).toEqual(expect.objectContaining({ ok: true, status: "resolved" }));
  });

  it("rejects malformed key records", () => {
    expect(() => buildDojoProofKeyRecord({
      tenant_id: "",
      key_id: "key-a",
      issuer: "issuer-a",
      algorithm: "ed25519",
      public_key_pem: "public",
      status: "active",
      created_at: "2026-06-11T00:00:00.000Z",
    })).toThrow("dojo_proof_key_tenant_id_required");
    expect(() => buildDojoProofKeyRecord({
      tenant_id: "tenant-a",
      key_id: "key-a",
      issuer: "issuer-a",
      algorithm: "ed25519",
      public_key_pem: "public",
      status: "active",
      created_at: "not-a-date",
    })).toThrow("dojo_proof_key_created_at_invalid");
  });
});

function recordFor(keyPair: { key_id: string; public_key_pem: string }, overrides: Partial<Parameters<typeof buildDojoProofKeyRecord>[0]> = {}) {
  return buildDojoProofKeyRecord({
    tenant_id: "tenant-a",
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
