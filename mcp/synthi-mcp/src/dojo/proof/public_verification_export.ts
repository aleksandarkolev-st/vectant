import { createHash } from "node:crypto";
import type { DojoTenantContext } from "../mcp/execution_policy_gate.js";
import type { DojoProofKeyRecord } from "./key_registry.js";

export const DOJO_PUBLIC_PROOF_VERIFIER_PACKAGE_EXPORT = "@synthi-inc/mcp-server/dojo/proof/public-verifier";
export const DOJO_PUBLIC_PROOF_VERIFIER_FUNCTION = "verifyDojoProofCapsulePublicWithKeyRecord";

export interface DojoProofPublicVerificationKeyExport {
  schema_version: "synthi.dojo.proofPublicKeyExport.v1";
  tenant_id: string;
  key_id: string;
  issuer: string;
  algorithm: DojoProofKeyRecord["algorithm"];
  signing_provider: DojoProofKeyRecord["signing_provider"];
  key_custody: DojoProofKeyRecord["key_custody"];
  key_uri?: string;
  status: DojoProofKeyRecord["status"];
  created_at: string;
  rotated_at?: string;
  revoked_at?: string;
  retain_for_forensic_verification: boolean;
  public_key_pem_sha256: string | null;
  public_key_pem_available: boolean;
  public_key_pem?: string;
  verification_available: boolean;
  blocked_by: string[];
}

export interface DojoProofPublicVerificationBundle {
  schema_version: "synthi.dojo.proofPublicVerificationBundle.v1";
  generated_at: string;
  tenant_id: string;
  organization_id: string;
  workspace_id: string;
  key_count: number;
  active_key_count: number;
  verifier: {
    package_export: typeof DOJO_PUBLIC_PROOF_VERIFIER_PACKAGE_EXPORT;
    function_name: typeof DOJO_PUBLIC_PROOF_VERIFIER_FUNCTION;
    capsule_key_lookup: "match proof_capsule.key_id to proof_keys[].key_id";
    supported_algorithms: ["ed25519"];
  };
  proof_keys: DojoProofPublicVerificationKeyExport[];
  secret_policy: "public_keys_only_no_private_or_hmac_secrets";
}

export function buildDojoProofPublicVerificationBundle(input: {
  tenant: DojoTenantContext;
  proof_keys: DojoProofKeyRecord[];
  generated_at?: string;
}): DojoProofPublicVerificationBundle {
  const generatedAt = input.generated_at ?? new Date().toISOString();
  const proofKeys = [...input.proof_keys]
    .filter((record) => record.tenant_id === input.tenant.tenant_id)
    .sort((left, right) => left.created_at.localeCompare(right.created_at) || left.key_id.localeCompare(right.key_id))
    .map(proofKeyPublicVerificationExport);
  return {
    schema_version: "synthi.dojo.proofPublicVerificationBundle.v1",
    generated_at: generatedAt,
    tenant_id: input.tenant.tenant_id,
    organization_id: input.tenant.organization_id,
    workspace_id: input.tenant.workspace_id,
    key_count: proofKeys.length,
    active_key_count: proofKeys.filter((record) => record.status === "active").length,
    verifier: {
      package_export: DOJO_PUBLIC_PROOF_VERIFIER_PACKAGE_EXPORT,
      function_name: DOJO_PUBLIC_PROOF_VERIFIER_FUNCTION,
      capsule_key_lookup: "match proof_capsule.key_id to proof_keys[].key_id",
      supported_algorithms: ["ed25519"],
    },
    proof_keys: proofKeys,
    secret_policy: "public_keys_only_no_private_or_hmac_secrets",
  };
}

export function proofKeyPublicVerificationExport(record: DojoProofKeyRecord): DojoProofPublicVerificationKeyExport {
  const isEd25519 = record.algorithm === "ed25519";
  const blockedBy: string[] = [];
  if (!isEd25519) blockedBy.push("proof_key_public_verifier_unavailable");
  if (record.status === "revoked" && !record.retain_for_forensic_verification) blockedBy.push("proof_key_revoked");
  return {
    schema_version: "synthi.dojo.proofPublicKeyExport.v1",
    tenant_id: record.tenant_id,
    key_id: record.key_id,
    issuer: record.issuer,
    algorithm: record.algorithm,
    signing_provider: record.signing_provider,
    key_custody: record.key_custody,
    ...(record.key_uri ? { key_uri: record.key_uri } : {}),
    status: record.status,
    created_at: record.created_at,
    ...(record.rotated_at ? { rotated_at: record.rotated_at } : {}),
    ...(record.revoked_at ? { revoked_at: record.revoked_at } : {}),
    retain_for_forensic_verification: record.retain_for_forensic_verification,
    public_key_pem_sha256: isEd25519 ? sha256(record.public_key_pem) : null,
    public_key_pem_available: isEd25519,
    ...(isEd25519 ? { public_key_pem: record.public_key_pem } : {}),
    verification_available: blockedBy.length === 0,
    blocked_by: blockedBy,
  };
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
