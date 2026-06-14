import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { buildDojoProofKeyRecord } from "../../src/dojo/proof/key_registry.js";
import {
  buildDojoProofPublicVerificationBundle,
  DOJO_PUBLIC_PROOF_VERIFIER_FUNCTION,
  DOJO_PUBLIC_PROOF_VERIFIER_PACKAGE_EXPORT,
  proofKeyPublicVerificationExport,
} from "../../src/dojo/proof/public_verification_export.js";
import { generateEd25519DojoProofKeyPair } from "../../src/dojo/proof/signing.js";

describe("Dojo proof public verification export", () => {
  it("builds a tenant-scoped public verification bundle with custody metadata and without private material", () => {
    const keyPair = generateEd25519DojoProofKeyPair("ed25519-compliance-export");
    const keyRecord = buildDojoProofKeyRecord({
      tenant_id: "tenant-a",
      key_id: keyPair.key_id,
      issuer: "dojo-proof-service",
      algorithm: "ed25519",
      signing_provider: "managed-key-service",
      key_custody: "managed",
      key_uri: "kms://tenant-a/proof/ed25519-compliance-export",
      public_key_pem: keyPair.public_key_pem,
      status: "active",
      created_at: "2026-06-11T00:00:00.000Z",
    });
    const bundle = buildDojoProofPublicVerificationBundle({
      tenant: {
        tenant_id: "tenant-a",
        organization_id: "org-a",
        workspace_id: "workspace-a",
        actor_id: "auditor-a",
        actor_type: "human",
        roles: ["dojo:operator"],
        request_id: "req-proof-public-export",
        correlation_id: "corr-proof-public-export",
      },
      proof_keys: [
        buildDojoProofKeyRecord({
          ...keyRecord,
          tenant_id: "tenant-b",
          key_id: "other-tenant-key",
        }),
        keyRecord,
      ],
      generated_at: "2026-06-11T00:10:00.000Z",
    });

    expect(bundle).toEqual(expect.objectContaining({
      schema_version: "synthi.dojo.proofPublicVerificationBundle.v1",
      tenant_id: "tenant-a",
      workspace_id: "workspace-a",
      key_count: 1,
      active_key_count: 1,
      verifier: {
        package_export: DOJO_PUBLIC_PROOF_VERIFIER_PACKAGE_EXPORT,
        function_name: DOJO_PUBLIC_PROOF_VERIFIER_FUNCTION,
        capsule_key_lookup: "match proof_capsule.key_id to proof_keys[].key_id",
        supported_algorithms: ["ed25519"],
      },
      secret_policy: "public_keys_only_no_private_or_hmac_secrets",
    }));
    expect(bundle.proof_keys).toEqual([
      expect.objectContaining({
        schema_version: "synthi.dojo.proofPublicKeyExport.v1",
        tenant_id: "tenant-a",
        key_id: keyPair.key_id,
        signing_provider: "managed-key-service",
        key_custody: "managed",
        key_uri: "kms://tenant-a/proof/ed25519-compliance-export",
        public_key_pem: keyPair.public_key_pem,
        public_key_pem_sha256: sha256(keyPair.public_key_pem),
        public_key_pem_available: true,
        verification_available: true,
        blocked_by: [],
      }),
    ]);
    expect(JSON.stringify(bundle)).not.toContain(keyPair.private_key_pem);
  });

  it("marks non-public or revoked key records unavailable for normal public verification", () => {
    const hmacExport = proofKeyPublicVerificationExport(buildDojoProofKeyRecord({
      tenant_id: "tenant-a",
      key_id: "hmac-key",
      issuer: "dojo-proof-service",
      algorithm: "hmac-sha256",
      signing_provider: "hmac-local",
      key_custody: "local",
      public_key_pem: "hmac-shared-secret-placeholder",
      status: "active",
      created_at: "2026-06-11T00:00:00.000Z",
    }));
    const revokedExport = proofKeyPublicVerificationExport(buildDojoProofKeyRecord({
      tenant_id: "tenant-a",
      key_id: "revoked-key",
      issuer: "dojo-proof-service",
      algorithm: "ed25519",
      signing_provider: "external-command",
      key_custody: "external",
      public_key_pem: generateEd25519DojoProofKeyPair("revoked-key").public_key_pem,
      status: "revoked",
      created_at: "2026-06-11T00:00:00.000Z",
      revoked_at: "2026-06-11T00:05:00.000Z",
    }));

    expect(hmacExport).toEqual(expect.objectContaining({
      public_key_pem_available: false,
      public_key_pem_sha256: null,
      verification_available: false,
      blocked_by: ["proof_key_public_verifier_unavailable"],
    }));
    expect(hmacExport).not.toHaveProperty("public_key_pem");
    expect(revokedExport).toEqual(expect.objectContaining({
      verification_available: false,
      blocked_by: ["proof_key_revoked"],
    }));
  });
});

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
