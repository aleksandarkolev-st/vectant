export const GPU_HMR_PROOF_SCHEMA_VERSION = 'synthi.gpu.hmr.proof.v1';

export function classifyGpuHmrOutputProof(observation = {}) {
  const dispatchObserved = observation.dispatchObserved === true;
  const deterministicOutputObserved = observation.deterministicOutputObserved === true;
  const deterministicOracleProvided = observation.deterministicOracleProvided === true;
  const deterministicOraclePassed =
    deterministicOutputObserved && deterministicOracleProvided && observation.deterministicOraclePassed === true;
  const visualFrameObserved = observation.visualFrameObserved === true;
  const evidenceRefs = Array.isArray(observation.evidenceRefs)
    ? observation.evidenceRefs.filter((ref) => typeof ref === 'string' && ref.trim())
    : [];
  const visualEvidenceRefs = Array.isArray(observation.visualEvidenceRefs)
    ? observation.visualEvidenceRefs.filter((ref) => typeof ref === 'string' && ref.trim())
    : [];

  if (!dispatchObserved) {
    return {
      schemaVersion: GPU_HMR_PROOF_SCHEMA_VERSION,
      resultState: null,
      degradedState: 'gpu-hmr-dispatch-unobserved',
      degradedReason: 'runtime_dispatch_not_observed',
      outputOracle: {
        provided: deterministicOracleProvided,
        observed: deterministicOutputObserved,
        passed: false,
      },
      visualFrameObserved,
      evidenceRefs,
      visualEvidenceRefs,
    };
  }

  if (deterministicOraclePassed) {
    return {
      schemaVersion: GPU_HMR_PROOF_SCHEMA_VERSION,
      resultState: 'gpu-hmr-output-proven',
      degradedState: null,
      degradedReason: null,
      outputOracle: {
        provided: true,
        observed: true,
        passed: true,
      },
      visualFrameObserved,
      evidenceRefs,
      visualEvidenceRefs,
    };
  }

  const degradedState = visualFrameObserved
    ? 'gpu-hmr-visual-only'
    : 'gpu-hmr-output-unobserved';
  const degradedReason = visualFrameObserved
    ? 'visual_frame_without_deterministic_output_oracle'
    : 'output_oracle_not_collected';

  return {
    schemaVersion: GPU_HMR_PROOF_SCHEMA_VERSION,
    resultState: 'gpu-hmr-dispatch-proven',
    degradedState,
    degradedReason,
    outputOracle: {
      provided: deterministicOracleProvided,
      observed: deterministicOutputObserved,
      passed: false,
    },
    visualFrameObserved,
    evidenceRefs,
    visualEvidenceRefs,
  };
}

export function summarizeGpuHmrOutputProof(proof) {
  if (!proof || typeof proof !== 'object') return 'gpu_output_proof=missing';
  const result = proof.resultState ? proof.resultState : 'missing';
  const degraded = proof.degradedState ? ` degraded=${proof.degradedState}` : '';
  const reason = proof.degradedReason ? ` reason=${proof.degradedReason}` : '';
  const oracle = proof.outputOracle
    ? ` oracle=${proof.outputOracle.passed ? 'passed' : proof.outputOracle.provided ? 'failed' : 'missing'}`
    : '';
  const visual = proof.visualFrameObserved ? ' visual=fresh-frame' : ' visual=none';
  return `gpu_output_proof=${result}${degraded}${reason}${oracle}${visual}`;
}

export function classifyGpuHmrHostPreservationProof(observation = {}) {
  const hostReplacementObserved =
    observation.hostReplacementObserved === true || observation.hostRestartObserved === true;
  const identityChecksPassed = observation.identityChecksPassed === true;
  const identityEvidenceRefs = Array.isArray(observation.identityEvidenceRefs)
    ? observation.identityEvidenceRefs.filter((ref) => typeof ref === 'string' && ref.trim())
    : [];

  if (hostReplacementObserved) {
    return {
      schemaVersion: GPU_HMR_PROOF_SCHEMA_VERSION,
      resultState: 'gpu-hmr-output-proven',
      degradedState: 'gpu-hmr-host-replaced',
      degradedReason: 'host_runtime_replaced_or_restarted',
      identityChecksPassed: false,
      identityEvidenceRefs,
    };
  }

  if (identityChecksPassed) {
    return {
      schemaVersion: GPU_HMR_PROOF_SCHEMA_VERSION,
      resultState: 'gpu-hmr-host-preservation-proven',
      degradedState: null,
      degradedReason: null,
      identityChecksPassed: true,
      identityEvidenceRefs,
    };
  }

  return {
    schemaVersion: GPU_HMR_PROOF_SCHEMA_VERSION,
    resultState: null,
    degradedState: null,
    degradedReason: 'host_identity_checks_not_collected',
    identityChecksPassed: false,
    identityEvidenceRefs,
  };
}

export function summarizeGpuHmrHostPreservationProof(proof) {
  if (!proof || typeof proof !== 'object') return 'gpu_host_preservation_proof=missing';
  const result = proof.resultState ? proof.resultState : 'missing';
  const degraded = proof.degradedState ? ` degraded=${proof.degradedState}` : '';
  const reason = proof.degradedReason ? ` reason=${proof.degradedReason}` : '';
  const identity = proof.identityChecksPassed ? ' identity=passed' : ' identity=missing';
  return `gpu_host_preservation_proof=${result}${degraded}${reason}${identity}`;
}
