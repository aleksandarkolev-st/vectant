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
