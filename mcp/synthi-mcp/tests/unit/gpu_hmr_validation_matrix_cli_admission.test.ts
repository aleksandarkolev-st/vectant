import { generateKeyPairSync } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { GpuParentRuntimeProofAdmissionReceiptSigner } from
  '../../src/gpu_parent_runtime_proof_admission_receipt.js';
import {
  GPU_HMR_MCP_ADMISSION_TRUST_MATERIAL_AUTHORITY,
  GPU_HMR_MCP_ADMISSION_TRUST_MATERIAL_SCHEMA,
} from '../../scripts/lib/gpu-hmr-mcp-admission-matrix-trust.mjs';

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const mcpRoot = path.resolve(testDirectory, '..', '..');
const cliPath = path.join(mcpRoot, 'scripts', 'gpu-hmr-validation-matrix-ledger.mjs');
const trustJsonEnv = 'SYNTHI_GPU_HMR_MCP_ADMISSION_TRUST_JSON';
let root = '';

function cleanEnvironment() {
  const env = { ...process.env };
  delete env[trustJsonEnv];
  delete env.SYNTHI_GPU_HMR_MCP_ADMISSION_MAX_AGE_MS;
  delete env.SYNTHI_GPU_HMR_MCP_ADMISSION_MAX_FUTURE_SKEW_MS;
  return env;
}

function validTrustJson() {
  const challenge = Buffer.alloc(32, 0x47).toString('base64url');
  const signer = new GpuParentRuntimeProofAdmissionReceiptSigner({
    privateKey: generateKeyPairSync('ed25519').privateKey,
    validationRunChallenge: challenge,
  });
  return JSON.stringify({
    gpu_parent_runtime_proof_admission_trust: {
      schemaVersion: GPU_HMR_MCP_ADMISSION_TRUST_MATERIAL_SCHEMA,
      proofAuthority: GPU_HMR_MCP_ADMISSION_TRUST_MATERIAL_AUTHORITY,
      verificationKey: signer.exportVerificationKey(),
      validationRunChallenge: challenge,
      replayPolicyRequired: true,
      freshnessPolicyRequired: true,
      acceptedForGpuHmr: false,
      gpuHmrSuccess: false,
      canSatisfyRuntimeProof: false,
    },
  });
}

function runCli(args: string[], env = cleanEnvironment()) {
  return spawnSync(process.execPath, [cliPath, ...args], {
    cwd: mcpRoot,
    env,
    encoding: 'utf8',
    timeout: 30_000,
  });
}

beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'synthi-matrix-cli-'));
});

afterAll(async () => {
  if (root) await fs.rm(root, { recursive: true, force: true });
});

describe('validation matrix CLI admission policy', () => {
  it('fails before collection when live trust is missing', () => {
    const result = runCli(['--root', root, '--self-check']);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('live matrix acceptance requires');
  });

  it('accepts atomic inherited trust as the live source', () => {
    const env = cleanEnvironment();
    env[trustJsonEnv] = validTrustJson();
    const result = runCli(['--root', root, '--self-check'], env);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('GPU HMR validation matrix rejected collected rows');
    expect(result.stderr).not.toContain('trust_material_invalid');
  });

  it('persists historical audit policy and never reports current acceptance', () => {
    const outputDirectory = path.join(root, 'historical-output');
    const result = runCli([
      '--root', root,
      '--historical-admission-audit',
      '--format', 'json',
      '--output-dir', outputDirectory,
    ]);
    expect(result.status).toBe(0);
    const output = JSON.parse(result.stdout);
    expect(output).toMatchObject({
      ok: false,
      historicalAdmissionAudit: true,
      currentGpuHmrAcceptance: false,
      mcpAdmissionReceiptPolicy: {
        mode: 'historical-audit',
        requireReceiptForCompute: true,
        historicalAdmissionAudit: true,
      },
    });
    return fs.readFile(output.jsonPath, 'utf8').then((serialized) => {
      const persisted = JSON.parse(serialized);
      expect(persisted.mcpAdmissionReceiptPolicy).toMatchObject({
        mode: 'historical-audit',
        historicalAdmissionAudit: true,
      });
      expect(persisted.query.accepted).toBe(false);
    });
  });

  it('does not let historical self-checks exit successfully when rejected', () => {
    const result = runCli([
      '--root', root,
      '--historical-admission-audit',
      '--self-check',
    ]);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('GPU HMR validation matrix rejected collected rows');
  });

  it('rejects ambiguous file and inherited trust sources', () => {
    const env = cleanEnvironment();
    env[trustJsonEnv] = validTrustJson();
    const result = runCli([
      '--root', root,
      '--mcp-admission-trust', path.join(root, 'trust.json'),
      '--self-check',
    ], env);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('gpu_hmr_mcp_admission_trust_sources_ambiguous');
  });

  it('rejects trust files inside the workspace or scanned artifact roots', async () => {
    const scannedTrustPath = path.join(root, 'trust.json');
    await fs.writeFile(scannedTrustPath, validTrustJson());
    const scanned = runCli([
      '--root', root,
      '--mcp-admission-trust', scannedTrustPath,
      '--self-check',
    ]);
    expect(scanned.status).not.toBe(0);
    expect(scanned.stderr).toContain(
      'gpu_hmr_mcp_admission_trust_file_inside_artifact_root',
    );

    const workspace = runCli([
      '--root', root,
      '--mcp-admission-trust', path.join(mcpRoot, 'package.json'),
      '--self-check',
    ]);
    expect(workspace.status).not.toBe(0);
    expect(workspace.stderr).toContain(
      'gpu_hmr_mcp_admission_trust_file_inside_artifact_root',
    );
  });
});
