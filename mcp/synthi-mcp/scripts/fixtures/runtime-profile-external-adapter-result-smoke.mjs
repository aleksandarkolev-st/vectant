#!/usr/bin/env node
import { promises as fs } from 'node:fs';
import path from 'node:path';

const profile = JSON.parse(process.env.SYNTHI_GPU_HMR_RUNTIME_PROFILE_JSON ?? '{}');
const proofPath = process.env.SYNTHI_GPU_HMR_RUNTIME_RESULT_SMOKE_PROOF_PATH;

if (!profile.id || !profile.adapter?.family) {
  throw new Error('missing SYNTHI_GPU_HMR_RUNTIME_PROFILE_JSON');
}
if (!proofPath) {
  throw new Error('missing SYNTHI_GPU_HMR_RUNTIME_RESULT_SMOKE_PROOF_PATH');
}

const proof = {
  schemaVersion: 'synthi.gpu_hmr.runtime_profile_external_adapter_smoke_proof.v1',
  profileId: profile.id,
  adapterFamily: profile.adapter.family,
  runtimeProofArtifact: {
    proofId: `gpu-runtime-proof:sha256:${'a'.repeat(64)}`,
    gpuHmrSuccess: true,
    fullRuntimeProven: true,
    limitations: [],
  },
  proofLedger: {
    proofId: `gpu-ledger-proof:sha256:${'b'.repeat(64)}`,
    gpuHmrSuccess: true,
  },
};

await fs.mkdir(path.dirname(proofPath), { recursive: true });
await fs.writeFile(proofPath, `${JSON.stringify(proof, null, 2)}\n`);
console.log(`proof_json=${proofPath}`);
