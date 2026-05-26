export const GPU_HMR_PROOF_SCHEMA_VERSION = 'synthi.gpu.hmr.proof.v1';

export const GPU_HMR_PROOF_STATES = [
  'gpu-hmr-compile-proven',
  'gpu-hmr-symbol-bound',
  'gpu-hmr-abi-proven',
  'gpu-hmr-dispatch-proven',
  'gpu-hmr-output-proven',
  'gpu-hmr-host-preservation-proven',
  'gpu-hmr-full-runtime-proven',
];

const GPU_HMR_PROOF_STATE_RANKS = new Map(
  GPU_HMR_PROOF_STATES.map((state, index) => [state, index + 1]),
);

const GPU_HMR_DEGRADED_STATE_RANK_CAPS = new Map([
  ['gpu-hmr-fake-launch-path', proofStateRank('gpu-hmr-symbol-bound')],
  ['gpu-hmr-unknown-arg-provenance', proofStateRank('gpu-hmr-abi-proven')],
  ['gpu-hmr-abi-unverified', proofStateRank('gpu-hmr-symbol-bound')],
  ['gpu-hmr-dispatch-unobserved', proofStateRank('gpu-hmr-abi-proven')],
  ['gpu-hmr-output-unobserved', proofStateRank('gpu-hmr-dispatch-proven')],
  ['gpu-hmr-host-replaced', proofStateRank('gpu-hmr-output-proven')],
  ['gpu-hmr-visual-only', proofStateRank('gpu-hmr-dispatch-proven')],
]);

function proofStateRank(state) {
  return typeof state === 'string' ? GPU_HMR_PROOF_STATE_RANKS.get(state) ?? 0 : 0;
}

function degradedStateRankCap(state) {
  if (state === null || state === undefined || state === '') return null;
  return typeof state === 'string' ? GPU_HMR_DEGRADED_STATE_RANK_CAPS.get(state) ?? 0 : 0;
}

function effectiveProofRank(proof) {
  const resultRank = proofStateRank(proof?.resultState);
  const cap = degradedStateRankCap(proof?.degradedState);
  return cap === null ? resultRank : Math.min(resultRank, cap);
}

function highestEffectiveProof(proofs) {
  let best = null;
  for (const proof of proofs) {
    const effectiveRank = effectiveProofRank(proof);
    if (effectiveRank > (best?.effectiveRank ?? 0)) {
      best = { proof, effectiveRank };
    }
  }
  return best ?? { proof: null, effectiveRank: 0 };
}

function stageResult(stageId, requiredState, evidenceRank, evidenceProof, degradedState, degradedReason) {
  const requiredRank = proofStateRank(requiredState);
  const passed = evidenceRank >= requiredRank;
  return {
    stageId,
    requiredState,
    status: passed ? 'passed' : 'blocked',
    observedState: evidenceProof?.resultState ?? null,
    effectiveRank: evidenceRank,
    degradedState: passed ? null : degradedState ?? evidenceProof?.degradedState ?? null,
    degradedReason: passed ? null : degradedReason ?? evidenceProof?.degradedReason ?? null,
  };
}

export function classifyGpuHmrOutputProof(observation = {}) {
  const dispatchProof = observation.dispatchProof && typeof observation.dispatchProof === 'object'
    ? observation.dispatchProof
    : null;
  const dispatchUsable = dispatchProof
    ? effectiveProofRank(dispatchProof) >= proofStateRank('gpu-hmr-dispatch-proven')
    : observation.dispatchObserved === true;
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

  if (!dispatchUsable) {
    return {
      schemaVersion: GPU_HMR_PROOF_SCHEMA_VERSION,
      resultState: dispatchProof?.resultState ?? null,
      degradedState: dispatchProof?.degradedState ?? 'gpu-hmr-dispatch-unobserved',
      degradedReason: dispatchProof?.degradedReason ?? 'runtime_dispatch_not_observed',
      outputOracle: {
        provided: deterministicOracleProvided,
        observed: deterministicOutputObserved,
        passed: false,
      },
      visualFrameObserved,
      evidenceRefs,
      visualEvidenceRefs,
      dispatchProof,
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
      dispatchProof,
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
    dispatchProof,
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

export function classifyGpuHmrDispatchProof(observation = {}) {
  const dispatchObserved = observation.dispatchObserved === true;
  const argProvenanceObserved = observation.argProvenanceObserved === true;
  const argProvenanceComplete = observation.argProvenanceComplete === true;
  const unknownArgCount = Number.isFinite(observation.unknownArgCount)
    ? Math.max(0, Number(observation.unknownArgCount))
    : 0;

  if (!dispatchObserved) {
    return {
      schemaVersion: GPU_HMR_PROOF_SCHEMA_VERSION,
      resultState: null,
      degradedState: 'gpu-hmr-dispatch-unobserved',
      degradedReason: 'runtime_dispatch_not_observed',
      dispatchObserved: false,
      argProvenanceObserved,
      argProvenanceComplete: false,
      unknownArgCount,
    };
  }

  if (!argProvenanceObserved || !argProvenanceComplete || unknownArgCount > 0) {
    return {
      schemaVersion: GPU_HMR_PROOF_SCHEMA_VERSION,
      resultState: 'gpu-hmr-dispatch-proven',
      degradedState: 'gpu-hmr-unknown-arg-provenance',
      degradedReason: argProvenanceObserved
        ? 'launch_argument_provenance_incomplete'
        : 'launch_argument_provenance_not_collected',
      dispatchObserved: true,
      argProvenanceObserved,
      argProvenanceComplete: false,
      unknownArgCount,
    };
  }

  return {
    schemaVersion: GPU_HMR_PROOF_SCHEMA_VERSION,
    resultState: 'gpu-hmr-dispatch-proven',
    degradedState: null,
    degradedReason: null,
    dispatchObserved: true,
    argProvenanceObserved: true,
    argProvenanceComplete: true,
    unknownArgCount: 0,
  };
}

export function summarizeGpuHmrDispatchProof(proof) {
  if (!proof || typeof proof !== 'object') return 'gpu_dispatch_proof=missing';
  const result = proof.resultState ? proof.resultState : 'missing';
  const degraded = proof.degradedState ? ` degraded=${proof.degradedState}` : '';
  const reason = proof.degradedReason ? ` reason=${proof.degradedReason}` : '';
  const dispatch = proof.dispatchObserved ? ' dispatch=observed' : ' dispatch=missing';
  const provenance = proof.argProvenanceObserved
    ? ` provenance=${proof.argProvenanceComplete ? 'complete' : 'incomplete'}`
    : ' provenance=missing';
  const unknown = Number.isFinite(proof.unknownArgCount) ? ` unknown_args=${proof.unknownArgCount}` : '';
  return `gpu_dispatch_proof=${result}${degraded}${reason}${dispatch}${provenance}${unknown}`;
}

export function classifyGpuHmrAbiProof(observation = {}) {
  const evidenceRefs = Array.isArray(observation.evidenceRefs)
    ? observation.evidenceRefs.filter((ref) => typeof ref === 'string' && ref.trim())
    : [];
  const metadataObserved = observation.metadataObserved === true || evidenceRefs.length > 0;
  const layoutSizeAlignmentVerified = observation.layoutSizeAlignmentVerified === true;

  if (layoutSizeAlignmentVerified) {
    return {
      schemaVersion: GPU_HMR_PROOF_SCHEMA_VERSION,
      resultState: 'gpu-hmr-abi-proven',
      degradedState: null,
      degradedReason: null,
      layoutSizeAlignmentVerified: true,
      metadataObserved,
      evidenceRefs,
    };
  }

  return {
    schemaVersion: GPU_HMR_PROOF_SCHEMA_VERSION,
    resultState: metadataObserved ? 'gpu-hmr-symbol-bound' : null,
    degradedState: 'gpu-hmr-abi-unverified',
    degradedReason: metadataObserved
      ? (typeof observation.degradedReason === 'string' && observation.degradedReason.trim()
        ? observation.degradedReason.trim()
        : 'abi_layout_size_alignment_unverified')
      : 'abi_evidence_not_collected',
    layoutSizeAlignmentVerified: false,
    metadataObserved,
    evidenceRefs,
  };
}

export function summarizeGpuHmrAbiProof(proof) {
  if (!proof || typeof proof !== 'object') return 'gpu_abi_proof=missing';
  const result = proof.resultState ? proof.resultState : 'missing';
  const degraded = proof.degradedState ? ` degraded=${proof.degradedState}` : '';
  const reason = proof.degradedReason ? ` reason=${proof.degradedReason}` : '';
  const metadata = proof.metadataObserved ? ' metadata=observed' : ' metadata=missing';
  const layout = proof.layoutSizeAlignmentVerified ? ' layout=verified' : ' layout=unverified';
  return `gpu_abi_proof=${result}${degraded}${reason}${metadata}${layout}`;
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

export function classifyGpuHmrFullRuntimeProof(observation = {}) {
  const sourceProofs = Array.isArray(observation.sourceProofs)
    ? observation.sourceProofs.filter((proof) => proof && typeof proof === 'object')
    : observation.sourceProof && typeof observation.sourceProof === 'object'
      ? [observation.sourceProof]
      : [];
  const source = highestEffectiveProof(sourceProofs);
  const outputProof = observation.outputProof && typeof observation.outputProof === 'object'
    ? observation.outputProof
    : null;
  const hostPreservationProof =
    observation.hostPreservationProof && typeof observation.hostPreservationProof === 'object'
      ? observation.hostPreservationProof
      : null;
  const abiProof = observation.abiProof && typeof observation.abiProof === 'object'
    ? observation.abiProof
    : classifyGpuHmrAbiProof({});
  const outputRank = effectiveProofRank(outputProof);
  const hostRank = effectiveProofRank(hostPreservationProof);
  const abiRank = effectiveProofRank(abiProof);
  const dispatchProof = observation.dispatchProof && typeof observation.dispatchProof === 'object'
    ? observation.dispatchProof
    : outputRank >= proofStateRank('gpu-hmr-dispatch-proven')
      ? classifyGpuHmrDispatchProof({
          dispatchObserved: true,
          argProvenanceObserved: true,
          argProvenanceComplete: true,
        })
      : classifyGpuHmrDispatchProof({});
  const dispatchRank = effectiveProofRank(dispatchProof);
  const stages = [
    stageResult(
      'compile',
      'gpu-hmr-compile-proven',
      source.effectiveRank,
      source.proof,
      null,
      'compile_evidence_not_collected',
    ),
    stageResult(
      'symbol-binding',
      'gpu-hmr-symbol-bound',
      source.effectiveRank,
      source.proof,
      null,
      'symbol_binding_evidence_not_collected',
    ),
    stageResult(
      'abi',
      'gpu-hmr-abi-proven',
      abiRank,
      abiProof,
      abiProof?.degradedState ?? 'gpu-hmr-abi-unverified',
      abiProof?.degradedReason ?? 'abi_evidence_not_collected',
    ),
    stageResult(
      'dispatch',
      'gpu-hmr-dispatch-proven',
      dispatchRank,
      dispatchProof,
      dispatchProof?.degradedState ?? 'gpu-hmr-dispatch-unobserved',
      dispatchProof?.degradedReason ?? 'runtime_dispatch_not_observed',
    ),
    stageResult(
      'output',
      'gpu-hmr-output-proven',
      outputRank,
      outputProof,
      'gpu-hmr-output-unobserved',
      'output_oracle_not_collected',
    ),
    stageResult(
      'host-preservation',
      'gpu-hmr-host-preservation-proven',
      hostRank,
      hostPreservationProof,
      null,
      'host_identity_checks_not_collected',
    ),
  ];

  let resultState = null;
  for (const stage of stages) {
    if (stage.status !== 'passed') break;
    resultState = stage.requiredState;
  }
  const firstBlocked = stages.find((stage) => stage.status !== 'passed') ?? null;
  const fullRuntimeProven = firstBlocked === null;
  return {
    schemaVersion: GPU_HMR_PROOF_SCHEMA_VERSION,
    resultState: fullRuntimeProven ? 'gpu-hmr-full-runtime-proven' : resultState,
    degradedState: firstBlocked?.degradedState ?? null,
    degradedReason: firstBlocked?.degradedReason ?? null,
    fullRuntimeProven,
    stages,
    componentStates: {
      sourceEffectiveRank: source.effectiveRank,
      sourceResultState: source.proof?.resultState ?? null,
      abiEffectiveRank: abiRank,
      abiResultState: abiProof?.resultState ?? null,
      dispatchEffectiveRank: dispatchRank,
      dispatchResultState: dispatchProof?.resultState ?? null,
      outputEffectiveRank: outputRank,
      outputResultState: outputProof?.resultState ?? null,
      hostEffectiveRank: hostRank,
      hostResultState: hostPreservationProof?.resultState ?? null,
    },
  };
}

export function summarizeGpuHmrFullRuntimeProof(proof) {
  if (!proof || typeof proof !== 'object') return 'gpu_full_runtime_proof=missing';
  const result = proof.resultState ? proof.resultState : 'missing';
  const degraded = proof.degradedState ? ` degraded=${proof.degradedState}` : '';
  const reason = proof.degradedReason ? ` reason=${proof.degradedReason}` : '';
  const blocked = Array.isArray(proof.stages)
    ? proof.stages.filter((stage) => stage.status !== 'passed').map((stage) => stage.stageId)
    : [];
  const blockedSummary = blocked.length ? ` blocked=${blocked.join(',')}` : '';
  return `gpu_full_runtime_proof=${result}${degraded}${reason} full_runtime=${proof.fullRuntimeProven ? 'proven' : 'unproven'}${blockedSummary}`;
}
