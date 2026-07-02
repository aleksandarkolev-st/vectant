import { generateKeyPairSync, sign as nodeSign } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { verifyDojoProofCapsulePublicWithKeyRecord } from '../dojoPublicVerifier';

function signedProofFixture(overrides = {}) {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const unsignedCapsule = {
    schema_version: 'synthi.dojo.proofCapsule.v1',
    capsule_id: 'pcap-codesite-local-verifier',
    skill_id: 'codesite.schema',
    skill_version: '2026-06-25.1',
    requested_action: 'codesite.mutation.clearance',
    license_version: 'schema.level_2@2026-06-25',
    issuer: 'dojo-local-verifier-test',
    key_id: 'dojo-local-verifier-key',
    nonce: 'nonce-local-verifier-1',
    ledger_checkpoint_hash: 'b'.repeat(64),
    evidence_claims: [{
      claim: 'codesite.restricted_mutation',
      satisfied: true,
      evidence_refs: ['evidence:ev-local-verifier-1'],
    }],
    evidence_record_ids: ['ev-local-verifier-1'],
    issued_at: '2026-06-29T00:00:00.000Z',
    expires_at: '2026-07-02T00:00:00.000Z',
    signature_algorithm: 'ed25519',
    ...overrides,
  };
  const signature = nodeSign(null, Buffer.from(canonicalDojoProofPayload(unsignedCapsule), 'utf8'), privateKey).toString('base64url');
  return {
    capsule: {
      ...unsignedCapsule,
      signature: `ed25519:${signature}`,
    },
    proof_key: {
      schema_version: 'synthi.dojo.proofKey.v1',
      tenant_id: 'acme',
      key_id: unsignedCapsule.key_id,
      issuer: unsignedCapsule.issuer,
      algorithm: 'ed25519',
      signing_provider: 'ed25519-local',
      key_custody: 'local',
      public_key_pem: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
      status: 'active',
      created_at: '2026-06-29T00:00:00.000Z',
      retain_for_forensic_verification: false,
    },
  };
}

describe('CodeSite local Dojo public verifier', () => {
  it('verifies a signed proof capsule without MCP dist output', () => {
    const fixture = signedProofFixture();
    const result = verifyDojoProofCapsulePublicWithKeyRecord({
      ...fixture,
      expected: {
        requested_action: 'codesite.mutation.clearance',
        required_evidence_claims: ['codesite.restricted_mutation'],
      },
      require_ledger_checkpoint: true,
      now: '2026-06-30T00:00:00.000Z',
    });

    expect(result).toMatchObject({
      ok: true,
      status: 'verified',
      signature_verified: true,
      capsule_id: 'pcap-codesite-local-verifier',
      key_id: 'dojo-local-verifier-key',
      blocked_by: [],
    });
  });

  it('blocks tampered or mismatched clearance claims', () => {
    const fixture = signedProofFixture({ requested_action: 'codesite.readonly.audit' });
    const result = verifyDojoProofCapsulePublicWithKeyRecord({
      ...fixture,
      expected: {
        requested_action: 'codesite.mutation.clearance',
        required_evidence_claims: ['codesite.restricted_mutation'],
      },
      require_ledger_checkpoint: true,
      now: '2026-06-30T00:00:00.000Z',
    });

    expect(result.ok).toBe(false);
    expect(result.blocked_by).toContain('proof_capsule_action_mismatch');
  });
});

function canonicalDojoProofPayload(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalDojoProofPayload).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalDojoProofPayload(value[key])}`).join(',')}}`;
}
