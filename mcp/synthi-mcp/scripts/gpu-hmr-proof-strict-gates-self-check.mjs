#!/usr/bin/env node
import assert from 'node:assert/strict';
import {
  adversarialPreflightStrictGate,
  runtimeProofArtifactStrictGate,
  runtimeProofArtifactStrictGates,
  strictProofGateFailures,
} from './lib/gpu-hmr-proof-strict-gates.mjs';

const passingPreflight = {
  ok: true,
  skipped: false,
  exitCode: 0,
  scriptPath: '/tmp/gpu-hmr-adversarial-proof-ledger-self-check.mjs',
  elapsedMs: 12.3,
  stdoutHash: 'sha256:0'.padEnd(71, '0'),
  stderrHash: 'sha256:0'.padEnd(71, '0'),
  error: null,
};

const passingArtifact = {
  proofId: 'proof-pass',
  fullRuntimeProven: true,
  gpuHmrSuccess: true,
  proofLedgerQuery: { gpuHmrSuccess: true },
  acceptanceContractEvaluation: { accepted: true },
  acceptanceContractConsistency: { accepted: true },
};

assert.equal(adversarialPreflightStrictGate(passingPreflight).status, 'pass');
assert.equal(runtimeProofArtifactStrictGate(passingArtifact).status, 'pass');
assert.equal(strictProofGateFailures([
  adversarialPreflightStrictGate(passingPreflight),
  runtimeProofArtifactStrictGate(passingArtifact),
]).length, 0);

assert.match(
  adversarialPreflightStrictGate({ ...passingPreflight, skipped: true, ok: false }).detail,
  /adversarial_preflight_skipped/,
);
assert.match(
  adversarialPreflightStrictGate({ ...passingPreflight, stdoutHash: '' }).detail,
  /adversarial_preflight_stdout_hash_missing/,
);
assert.match(
  runtimeProofArtifactStrictGate({ ...passingArtifact, proofLedgerQuery: { gpuHmrSuccess: false } }).detail,
  /proof_ledger_query_rejected/,
);
assert.match(
  runtimeProofArtifactStrictGate({ ...passingArtifact, acceptanceContractConsistency: null }).detail,
  /acceptance_contract_consistency_missing/,
);
assert.match(
  runtimeProofArtifactStrictGates([], { requireAtLeastOne: true })[0].detail,
  /runtime_proof_artifact_missing/,
);
assert.equal(runtimeProofArtifactStrictGates([], { requireAtLeastOne: false }).length, 0);

console.log('gpu-hmr proof strict gates self-check passed');
