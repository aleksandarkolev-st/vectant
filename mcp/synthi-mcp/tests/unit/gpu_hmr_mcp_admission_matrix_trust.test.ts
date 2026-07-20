import { generateKeyPairSync } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { GpuParentRuntimeProofAdmissionReceiptSigner } from
  '../../src/gpu_parent_runtime_proof_admission_receipt.js';
import {
  createGpuHmrMcpAdmissionMatrixTrust,
  GPU_HMR_MCP_ADMISSION_TRUST_MATERIAL_AUTHORITY,
  GPU_HMR_MCP_ADMISSION_TRUST_MATERIAL_SCHEMA,
  loadGpuHmrMcpAdmissionMatrixTrust,
  parseGpuHmrMcpAdmissionTrustMaterial,
} from '../../scripts/lib/gpu-hmr-mcp-admission-matrix-trust.mjs';

const CHALLENGE = Buffer.alloc(32, 0x37).toString('base64url');

function material() {
  const signer = new GpuParentRuntimeProofAdmissionReceiptSigner({
    privateKey: generateKeyPairSync('ed25519').privateKey,
    validationRunChallenge: CHALLENGE,
  });
  return {
    schemaVersion: GPU_HMR_MCP_ADMISSION_TRUST_MATERIAL_SCHEMA,
    proofAuthority: GPU_HMR_MCP_ADMISSION_TRUST_MATERIAL_AUTHORITY,
    verificationKey: signer.exportVerificationKey(),
    validationRunChallenge: CHALLENGE,
    replayPolicyRequired: true,
    freshnessPolicyRequired: true,
    acceptedForGpuHmr: false,
    gpuHmrSuccess: false,
    canSatisfyRuntimeProof: false,
  };
}

describe('MCP admission matrix trust', () => {
  it('accepts exact control-channel material directly or from attach output', () => {
    const controlMaterial = material();
    const direct = parseGpuHmrMcpAdmissionTrustMaterial(controlMaterial);
    const wrapped = parseGpuHmrMcpAdmissionTrustMaterial({
      ok: true,
      gpu_parent_runtime_proof_admission_trust: controlMaterial,
    });
    expect(direct).not.toBeNull();
    expect(wrapped).toEqual(direct);

    const trust = createGpuHmrMcpAdmissionMatrixTrust(wrapped, {
      nowUnixNs: 1_784_500_000_123_456_789n,
      maxAgeNs: 30_000_000_000n,
      maxFutureSkewNs: 1_000_000_000n,
    });
    expect(trust).toMatchObject({
      requireReceiptForCompute: true,
      validationRunChallenge: CHALLENGE,
    });
  });

  it('rejects authority claims, malformed keys, and invalid freshness policy', () => {
    expect(parseGpuHmrMcpAdmissionTrustMaterial({
      ...material(),
      gpuHmrSuccess: true,
    })).toBeNull();
    expect(parseGpuHmrMcpAdmissionTrustMaterial({
      ...material(),
      verificationKey: {
        ...material().verificationKey,
        keyId: `gpu-hmr-mcp-admission-key:sha256:${'0'.repeat(64)}`,
      },
    })).toBeNull();
    expect(() => createGpuHmrMcpAdmissionMatrixTrust(material(), {
      nowUnixNs: 1n,
      maxAgeNs: 0n,
      maxFutureSkewNs: 0n,
    })).toThrow('gpu_hmr_mcp_admission_trust_policy_invalid');
  });

  it('loads an explicitly selected attach response without trusting artifact fields', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'synthi-mcp-trust-'));
    const trustPath = path.join(directory, 'attach-trust.json');
    try {
      await fs.writeFile(trustPath, JSON.stringify({
        ok: true,
        gpu_parent_runtime_proof_admission_trust: material(),
        acceptedForGpuHmr: true,
      }));
      const trust = await loadGpuHmrMcpAdmissionMatrixTrust(trustPath, {
        nowUnixNs: 1_784_500_000_123_456_789n,
        maxAgeNs: 30_000_000_000n,
        maxFutureSkewNs: 1_000_000_000n,
      });
      expect(trust).toMatchObject({
        requireReceiptForCompute: true,
        validationRunChallenge: CHALLENGE,
      });
      await fs.writeFile(trustPath, '{not-json');
      await expect(loadGpuHmrMcpAdmissionMatrixTrust(trustPath, {
        nowUnixNs: 1n,
        maxAgeNs: 1n,
        maxFutureSkewNs: 0n,
      })).rejects.toThrow('gpu_hmr_mcp_admission_trust_file_invalid');
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  });
});
