#!/usr/bin/env node
import assert from 'node:assert/strict';
import {
  eventLogAppliedRecoveryAllowed,
  waitRequiresFullRuntimeProof,
} from '../lib/gpu-hmr-wait-contract.mjs';

assert.equal(waitRequiresFullRuntimeProof({}, {}), false);
assert.equal(eventLogAppliedRecoveryAllowed({}, {}), true);

assert.equal(
  waitRequiresFullRuntimeProof({ requireGpuFullRuntimeProof: true }, {}),
  true,
);
assert.equal(
  eventLogAppliedRecoveryAllowed({ requireGpuFullRuntimeProof: true }, {}),
  false,
);

assert.equal(
  waitRequiresFullRuntimeProof({}, { require_gpu_full_runtime_proof: true }),
  true,
);
assert.equal(
  eventLogAppliedRecoveryAllowed({}, { require_gpu_full_runtime_proof: true }),
  false,
);

assert.equal(
  waitRequiresFullRuntimeProof({ requiredGpuProofState: 'gpu-hmr-full-runtime-proven' }, {}),
  true,
);
assert.equal(
  eventLogAppliedRecoveryAllowed(
    {},
    { required_gpu_proof_state: 'gpu-hmr-full-runtime-proven' },
  ),
  false,
);

assert.equal(
  waitRequiresFullRuntimeProof({ requiredGpuProofState: 'gpu-hmr-dispatch-observed' }, {}),
  false,
);

console.log(JSON.stringify({
  ok: true,
  checked: [
    'non_strict_event_log_recovery_allowed',
    'camel_full_runtime_recovery_rejected',
    'snake_full_runtime_recovery_rejected',
    'full_runtime_state_recovery_rejected',
    'weaker_state_recovery_allowed',
  ],
}, null, 2));
