function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function field(obj, ...keys) {
  if (!isObject(obj)) return undefined;
  for (const key of keys) {
    if (obj[key] !== undefined) return obj[key];
  }
  return undefined;
}

export function waitRequiresFullRuntimeProof(waitArgs = null, waitContract = null) {
  const requireFullRuntimeProof =
    field(waitArgs, 'requireGpuFullRuntimeProof', 'require_gpu_full_runtime_proof')
    ?? field(waitContract, 'requireGpuFullRuntimeProof', 'require_gpu_full_runtime_proof');
  const requiredState =
    field(waitArgs, 'requiredGpuProofState', 'required_gpu_proof_state')
    ?? field(waitContract, 'requiredGpuProofState', 'required_gpu_proof_state');
  return requireFullRuntimeProof === true
    || requiredState === 'gpu-hmr-full-runtime-proven';
}

export function eventLogAppliedRecoveryAllowed(waitArgs = null, waitContract = null) {
  return !waitRequiresFullRuntimeProof(waitArgs, waitContract);
}
