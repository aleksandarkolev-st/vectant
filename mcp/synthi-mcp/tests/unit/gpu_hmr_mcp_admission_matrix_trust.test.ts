import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  GpuParentRuntimeProofAdmissionAuthority,
  type GpuParentRuntimeProofAdmissionAuthorityContext,
} from '../../src/gpu_parent_runtime_proof_admission_authority.js';
import {
  createGpuHmrMcpAdmissionMatrixTrust,
  GPU_HMR_MCP_ADMISSION_TRUST_MATERIAL_AUTHORITY,
  GPU_HMR_MCP_ADMISSION_TRUST_MATERIAL_SCHEMA,
  loadGpuHmrMcpAdmissionMatrixTrust,
  parseGpuHmrMcpAdmissionTrustMaterial,
} from '../../scripts/lib/gpu-hmr-mcp-admission-matrix-trust.mjs';
import {
  GPU_HMR_MCP_ADMISSION_ONLINE_REPLAY_AUTHORITY_CLASS,
} from '../../scripts/lib/gpu-hmr-mcp-admission-online-replay-authority.mjs';

const CHALLENGE = Buffer.alloc(32, 0x37).toString('base64url');
const MAX_AGE_NS = 30_000_000_000n;
const MAX_FUTURE_SKEW_NS = 1_000_000_000n;
const authorities: GpuParentRuntimeProofAdmissionAuthority[] = [];
let directory = '';

async function material(
  overrides: Partial<GpuParentRuntimeProofAdmissionAuthorityContext> = {},
) {
  const authority = new GpuParentRuntimeProofAdmissionAuthority({
    validationRunChallenge: CHALLENGE,
    maxReceiptAgeNs: MAX_AGE_NS,
    maxFutureSkewNs: MAX_FUTURE_SKEW_NS,
    maxScopes: 16,
    maxReceiptsPerScope: 32,
    operationTimeoutMs: 1_000,
    ...overrides,
  });
  authorities.push(authority);
  return {
    authority,
    trustMaterial: await authority.trustMaterial(),
  };
}

beforeAll(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), 'synthi-mcp-trust-v3-'));
});

afterAll(async () => {
  await Promise.all(authorities.map((authority) => authority.dispose()));
  if (directory) await fs.rm(directory, { recursive: true, force: true });
});

describe('MCP admission matrix trust', () => {
  it('accepts exact authority-produced v3 material after a signed live probe', async () => {
    const { trustMaterial } = await material();
    const direct = parseGpuHmrMcpAdmissionTrustMaterial(trustMaterial);
    const wrapped = parseGpuHmrMcpAdmissionTrustMaterial({
      ok: true,
      gpu_parent_runtime_proof_admission_trust: trustMaterial,
    });

    expect(direct).not.toBeNull();
    expect(wrapped).toEqual(direct);
    expect(direct).toMatchObject({
      schemaVersion: GPU_HMR_MCP_ADMISSION_TRUST_MATERIAL_SCHEMA,
      proofAuthority: GPU_HMR_MCP_ADMISSION_TRUST_MATERIAL_AUTHORITY,
      onlineReplayAuthority: {
        authorityId: trustMaterial.onlineReplayAuthority.authorityId,
        authorityGenerationId:
          trustMaterial.onlineReplayAuthority.authorityGenerationId,
      },
      acceptedForGpuHmr: false,
      gpuHmrSuccess: false,
      canSatisfyRuntimeProof: false,
    });

    const trust = await createGpuHmrMcpAdmissionMatrixTrust(wrapped);
    expect(trust).toMatchObject({
      requireReceiptForCompute: true,
      validationRunChallenge: CHALLENGE,
      maxAgeNs: MAX_AGE_NS,
      maxFutureSkewNs: MAX_FUTURE_SKEW_NS,
      replayAuthorityId: trustMaterial.onlineReplayAuthority.authorityId,
      replayAuthorityClass:
        GPU_HMR_MCP_ADMISSION_ONLINE_REPLAY_AUTHORITY_CLASS,
      replayAuthorityDurable: false,
      replayOnlineRequired: true,
      replayOnlineVerified: true,
      replayRollbackProtected: true,
      replaySignedProbeVerified: true,
      replayRegistry: {
        testOnly: false,
        replayAuthorityId: trustMaterial.onlineReplayAuthority.authorityId,
        replayAuthorityClass:
          GPU_HMR_MCP_ADMISSION_ONLINE_REPLAY_AUTHORITY_CLASS,
        replayAuthorityDurable: false,
        replayOnlineRequired: true,
        replayOnlineVerified: true,
        replayRollbackProtected: true,
        replaySignedProbeVerified: true,
      },
      acceptedForGpuHmr: false,
      gpuHmrSuccess: false,
      canSatisfyRuntimeProof: false,
    });
    expect(trust.replayProbeRevision).toBe('0');
    expect(trust.replayProbeCommitHash).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(trust.replayResponseKeyId).toBe(
      trustMaterial.onlineReplayAuthority.responseVerificationKey.keyId,
    );

    const serialized = JSON.stringify(
      trust,
      (_key, value) => typeof value === 'bigint' ? value.toString() : value,
    );
    expect(serialized).not.toMatch(
      /authenticationKey|privateKey|claimant|registryInstance|replayStateRoot|replayAnchorRoot|checkpoint/i,
    );
  });

  it('uses signed parent freshness policy unless an explicit override matches', async () => {
    const { trustMaterial } = await material();
    await expect(createGpuHmrMcpAdmissionMatrixTrust(
      trustMaterial,
      {},
    )).resolves.toMatchObject({
      maxAgeNs: MAX_AGE_NS,
      maxFutureSkewNs: MAX_FUTURE_SKEW_NS,
    });
    await expect(createGpuHmrMcpAdmissionMatrixTrust(
      trustMaterial,
      { nowUnixNs: 1n },
    )).rejects.toThrow('gpu_hmr_mcp_admission_trust_policy_invalid');
    await expect(createGpuHmrMcpAdmissionMatrixTrust(trustMaterial, {
      maxAgeNs: MAX_AGE_NS,
      maxFutureSkewNs: MAX_FUTURE_SKEW_NS,
    })).resolves.toMatchObject({ replayOnlineVerified: true });
    await expect(createGpuHmrMcpAdmissionMatrixTrust(trustMaterial, {
      maxAgeNs: MAX_AGE_NS + 1n,
    })).rejects.toThrow('gpu_hmr_mcp_admission_trust_policy_mismatch');
    await expect(createGpuHmrMcpAdmissionMatrixTrust(trustMaterial, {
      maxFutureSkewNs: MAX_FUTURE_SKEW_NS + 1n,
    })).rejects.toThrow('gpu_hmr_mcp_admission_trust_policy_mismatch');
    await expect(createGpuHmrMcpAdmissionMatrixTrust(trustMaterial, {
      maxAgeNs: 0n,
    })).rejects.toThrow('gpu_hmr_mcp_admission_trust_policy_invalid');
  });

  it('rejects authority claims, malformed keys, extras, and accessors', async () => {
    const { trustMaterial } = await material();
    expect(parseGpuHmrMcpAdmissionTrustMaterial({
      ...trustMaterial,
      gpuHmrSuccess: true,
    })).toBeNull();
    expect(parseGpuHmrMcpAdmissionTrustMaterial({
      ...trustMaterial,
      checkpointRoot: directory,
    })).toBeNull();
    expect(parseGpuHmrMcpAdmissionTrustMaterial({
      ...trustMaterial,
      verificationKey: {
        ...trustMaterial.verificationKey,
        keyId: `gpu-hmr-mcp-admission-key:sha256:${'0'.repeat(64)}`,
      },
    })).toBeNull();
    expect(parseGpuHmrMcpAdmissionTrustMaterial({
      ...trustMaterial,
      onlineReplayAuthority: {
        ...trustMaterial.onlineReplayAuthority,
        durable: true,
      },
    })).toBeNull();

    let getterCalls = 0;
    const onlineWithAccessor = {
      ...trustMaterial.onlineReplayAuthority,
    } as Record<string, unknown>;
    Object.defineProperty(onlineWithAccessor, 'endpoint', {
      enumerable: true,
      get() {
        getterCalls += 1;
        return trustMaterial.onlineReplayAuthority.endpoint;
      },
    });
    expect(parseGpuHmrMcpAdmissionTrustMaterial({
      ...trustMaterial,
      onlineReplayAuthority: onlineWithAccessor,
    })).toBeNull();
    expect(getterCalls).toBe(0);
  });

  it('rejects proxies without invoking their traps', async () => {
    const { trustMaterial } = await material();
    let traps = 0;
    const trap = () => {
      traps += 1;
      throw new Error('proxy trap invoked');
    };
    expect(parseGpuHmrMcpAdmissionTrustMaterial(
      new Proxy(trustMaterial, { get: trap, ownKeys: trap }),
    )).toBeNull();
    expect(parseGpuHmrMcpAdmissionTrustMaterial({
      ...trustMaterial,
      onlineReplayAuthority: new Proxy(
        trustMaterial.onlineReplayAuthority,
        { get: trap, ownKeys: trap },
      ),
    })).toBeNull();
    expect(traps).toBe(0);
  });

  it('fails closed when the signed parent authority is no longer online', async () => {
    const { authority, trustMaterial } = await material();
    await authority.dispose();
    await expect(createGpuHmrMcpAdmissionMatrixTrust(trustMaterial)).rejects
      .toThrow('gpu_hmr_mcp_admission_online_replay_authority_probe_failed');
  });

  it('rejects malformed nested policy metadata before opening an endpoint', async () => {
    const { trustMaterial } = await material();
    expect(parseGpuHmrMcpAdmissionTrustMaterial({
      ...trustMaterial,
      onlineReplayAuthority: {
        ...trustMaterial.onlineReplayAuthority,
        maxScopes: trustMaterial.onlineReplayAuthority.maxScopes + 1,
      },
    })).toBeNull();
    expect(parseGpuHmrMcpAdmissionTrustMaterial({
      ...trustMaterial,
      onlineReplayAuthority: {
        ...trustMaterial.onlineReplayAuthority,
        responseVerificationKey: {
          ...trustMaterial.onlineReplayAuthority.responseVerificationKey,
          publicKey: 'not-a-key',
        },
      },
    })).toBeNull();
  });

  it('never treats a file as live authority and does not read it', async () => {
    const trustPath = path.join(directory, 'attach-trust.json');
    await expect(loadGpuHmrMcpAdmissionMatrixTrust(trustPath)).rejects.toThrow(
      'gpu_hmr_mcp_admission_trust_file_not_live_authority',
    );
    expect(await fs.stat(trustPath).then(() => true, () => false)).toBe(false);
    await expect(loadGpuHmrMcpAdmissionMatrixTrust('')).rejects.toThrow(
      'gpu_hmr_mcp_admission_trust_path_invalid',
    );
  });
});
