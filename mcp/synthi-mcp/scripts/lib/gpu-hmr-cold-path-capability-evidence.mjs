import { createHash } from 'node:crypto';

export const COLD_PATH_CAPABILITY_EVIDENCE_SCHEMA =
  'synthi.gpu_hmr.cold_path_capability_evidence.v1';
export const COLD_PATH_CAPABILITY_EVIDENCE_AUTHORITY =
  'capability_scheduling_input_only_not_runner_or_gpu_hmr_success';
export const COLD_PATH_RUNNER_DESCRIPTOR_SCHEMA =
  'synthi.gpu_hmr.cold_path_runner_descriptor.v1';
export const COLD_PATH_RUNNER_DECISION_SCHEMA =
  'synthi.gpu_hmr.cold_path_runner_decision.v1';
export const COLD_PATH_RUNNER_DECISION_AUTHORITY =
  'runner_scheduling_decision_only_not_cold_build_or_gpu_hmr_success';

export const COLD_PATH_EVIDENCE_STRENGTHS = Object.freeze({
  declaration: 0,
  path_hint: 1,
  metadata_content: 2,
  profile_schema: 3,
  observed_build: 4,
  observed_runtime: 5,
});

const EVIDENCE_KIND_MAX_STRENGTH = Object.freeze({
  declaration: 'declaration',
  path_scan: 'path_hint',
  metadata_parser: 'metadata_content',
  profile_validator: 'profile_schema',
  build_observer: 'observed_build',
  runtime_observer: 'observed_runtime',
});
const MINIMUM_RUNNER_STRENGTH = COLD_PATH_EVIDENCE_STRENGTHS.profile_schema;
const HASH_PATTERN = /^sha256:[a-f0-9]{64}$/;
const IDENTIFIER_PATTERN = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/;
const PINNED_EVIDENCE = new WeakMap();
const PINNED_DECISIONS = new WeakMap();

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => (
      `${JSON.stringify(key)}:${stableJson(value[key])}`
    )).join(',')}}`;
  }
  return JSON.stringify(value);
}

function contentHash(value) {
  return `sha256:${createHash('sha256').update(String(value)).digest('hex')}`;
}

function recomputeEvidenceHash(value) {
  const projection = { ...value };
  delete projection.evidenceHash;
  return contentHash(stableJson(projection));
}

function exactKeys(value, keys) {
  return value
    && typeof value === 'object'
    && !Array.isArray(value)
    && stableJson(Object.keys(value).sort()) === stableJson([...keys].sort());
}

function normalizeIdentifier(value, name) {
  if (
    typeof value !== 'string'
    || value.length < 1
    || value.length > 256
    || !IDENTIFIER_PATTERN.test(value)
  ) {
    throw new Error(`cold_path_capability_${name}_invalid`);
  }
  return value;
}

function requireHash(value, name) {
  if (!HASH_PATTERN.test(value ?? '')) {
    throw new Error(`cold_path_capability_${name}_invalid`);
  }
  return value;
}

function normalizeSourceIdentity(value) {
  if (!exactKeys(value, ['treeHash', 'revisionHash'])) {
    throw new Error('cold_path_capability_source_identity_invalid');
  }
  return Object.freeze({
    treeHash: requireHash(value.treeHash, 'source_tree_hash'),
    revisionHash: value.revisionHash === null
      ? null
      : requireHash(value.revisionHash, 'source_revision_hash'),
  });
}

function normalizeSelectionStrata(value) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 64) {
    throw new Error('cold_path_capability_selection_strata_invalid');
  }
  const normalized = value.map((entry) => normalizeIdentifier(entry, 'selection_stratum'))
    .sort((left, right) => left.localeCompare(right));
  if (new Set(normalized).size !== normalized.length) {
    throw new Error('cold_path_capability_selection_strata_invalid');
  }
  return Object.freeze(normalized);
}

function normalizeObservation(value, sourceTreeHash) {
  if (!exactKeys(value, [
    'capability',
    'strength',
    'evidenceKind',
    'evidenceAuthority',
    'evidenceHash',
    'sourceTreeHash',
  ])) {
    throw new Error('cold_path_capability_observation_shape_invalid');
  }
  const capability = normalizeIdentifier(value.capability, 'observation_capability');
  const strength = normalizeIdentifier(value.strength, 'observation_strength');
  const evidenceKind = normalizeIdentifier(value.evidenceKind, 'observation_kind');
  const evidenceAuthority = normalizeIdentifier(
    value.evidenceAuthority,
    'observation_authority',
  );
  if (
    !Object.hasOwn(COLD_PATH_EVIDENCE_STRENGTHS, strength)
    || !Object.hasOwn(EVIDENCE_KIND_MAX_STRENGTH, evidenceKind)
    || COLD_PATH_EVIDENCE_STRENGTHS[strength]
      > COLD_PATH_EVIDENCE_STRENGTHS[EVIDENCE_KIND_MAX_STRENGTH[evidenceKind]]
    || value.sourceTreeHash !== sourceTreeHash
  ) {
    throw new Error('cold_path_capability_observation_strength_invalid');
  }
  const observation = {
    capability,
    strength,
    evidenceKind,
    evidenceAuthority,
    evidenceHash: requireHash(value.evidenceHash, 'observation_evidence_hash'),
    sourceTreeHash,
    acceptedForGpuHmr: false,
    gpuHmrSuccess: false,
    canSatisfyRuntimeProof: false,
    canSatisfyDispatchProof: false,
  };
  observation.observationHash = contentHash(stableJson(observation));
  return Object.freeze(observation);
}

function normalizeRequirement(value) {
  if (!exactKeys(value, ['capability', 'minimumStrength'])) {
    throw new Error('cold_path_capability_runner_requirement_shape_invalid');
  }
  const capability = normalizeIdentifier(value.capability, 'runner_capability');
  const minimumStrength = normalizeIdentifier(
    value.minimumStrength,
    'runner_minimum_strength',
  );
  if (
    !Object.hasOwn(COLD_PATH_EVIDENCE_STRENGTHS, minimumStrength)
    || COLD_PATH_EVIDENCE_STRENGTHS[minimumStrength] < MINIMUM_RUNNER_STRENGTH
  ) {
    throw new Error('cold_path_capability_runner_minimum_strength_invalid');
  }
  return Object.freeze({ capability, minimumStrength });
}

function normalizeRunnerDescriptor(value) {
  if (!exactKeys(value, ['schemaVersion', 'profileSchema', 'profileHash', 'requirements'])) {
    throw new Error('cold_path_capability_runner_shape_invalid');
  }
  if (value.schemaVersion !== COLD_PATH_RUNNER_DESCRIPTOR_SCHEMA) {
    throw new Error('cold_path_capability_runner_schema_invalid');
  }
  if (!Array.isArray(value.requirements) || value.requirements.length < 1 || value.requirements.length > 64) {
    throw new Error('cold_path_capability_runner_requirements_invalid');
  }
  const requirements = value.requirements.map(normalizeRequirement).sort((left, right) => (
    left.capability.localeCompare(right.capability)
      || COLD_PATH_EVIDENCE_STRENGTHS[left.minimumStrength]
        - COLD_PATH_EVIDENCE_STRENGTHS[right.minimumStrength]
  ));
  if (new Set(requirements.map((entry) => entry.capability)).size !== requirements.length) {
    throw new Error('cold_path_capability_runner_requirements_invalid');
  }
  const descriptor = {
    schemaVersion: COLD_PATH_RUNNER_DESCRIPTOR_SCHEMA,
    profileSchema: normalizeIdentifier(value.profileSchema, 'runner_profile_schema'),
    profileHash: requireHash(value.profileHash, 'runner_profile_hash'),
    requirements,
    acceptedForGpuHmr: false,
    gpuHmrSuccess: false,
    canSatisfyRuntimeProof: false,
    canSatisfyDispatchProof: false,
  };
  descriptor.runnerDescriptorHash = contentHash(stableJson(descriptor));
  return Object.freeze(descriptor);
}

function strongestObservationByCapability(observations) {
  const strongest = new Map();
  for (const observation of observations) {
    const previous = strongest.get(observation.capability);
    if (
      !previous
      || COLD_PATH_EVIDENCE_STRENGTHS[observation.strength]
        > COLD_PATH_EVIDENCE_STRENGTHS[previous.strength]
      || (
        observation.strength === previous.strength
        && observation.observationHash.localeCompare(previous.observationHash) < 0
      )
    ) {
      strongest.set(observation.capability, observation);
    }
  }
  return strongest;
}

export function createColdPathCapabilityEvidence(input) {
  if (!exactKeys(input, [
    'sourceIdentity',
    'selectionStrata',
    'observations',
    'runnerDescriptors',
  ])) {
    throw new Error('cold_path_capability_input_shape_invalid');
  }
  const sourceIdentity = normalizeSourceIdentity(input.sourceIdentity);
  const sourceIdentityHash = contentHash(stableJson(sourceIdentity));
  const selectionStrata = normalizeSelectionStrata(input.selectionStrata);
  if (!Array.isArray(input.observations) || input.observations.length > 4096) {
    throw new Error('cold_path_capability_observations_invalid');
  }
  const observations = input.observations.map((observation) => (
    normalizeObservation(observation, sourceIdentity.treeHash)
  )).sort((left, right) => (
    left.capability.localeCompare(right.capability)
      || COLD_PATH_EVIDENCE_STRENGTHS[left.strength]
        - COLD_PATH_EVIDENCE_STRENGTHS[right.strength]
      || left.observationHash.localeCompare(right.observationHash)
  ));
  if (new Set(observations.map((entry) => entry.observationHash)).size !== observations.length) {
    throw new Error('cold_path_capability_observations_duplicate');
  }
  if (!Array.isArray(input.runnerDescriptors) || input.runnerDescriptors.length > 256) {
    throw new Error('cold_path_capability_runners_invalid');
  }
  const runnerDescriptors = input.runnerDescriptors.map(normalizeRunnerDescriptor)
    .sort((left, right) => left.runnerDescriptorHash.localeCompare(right.runnerDescriptorHash));
  if (
    new Set(runnerDescriptors.map((entry) => entry.runnerDescriptorHash)).size
      !== runnerDescriptors.length
  ) {
    throw new Error('cold_path_capability_runners_duplicate');
  }
  const evidence = {
    schemaVersion: COLD_PATH_CAPABILITY_EVIDENCE_SCHEMA,
    proofAuthority: COLD_PATH_CAPABILITY_EVIDENCE_AUTHORITY,
    sourceIdentity,
    sourceIdentityHash,
    selectionStrata,
    selectionStrataHash: contentHash(stableJson(selectionStrata)),
    observations,
    observationSetHash: contentHash(stableJson(
      observations.map((entry) => entry.observationHash),
    )),
    runnerDescriptors,
    runnerDescriptorSetHash: contentHash(stableJson(
      runnerDescriptors.map((entry) => entry.runnerDescriptorHash),
    )),
    normalizedAsSchedulingInput: true,
    acceptedForGpuHmr: false,
    gpuHmrSuccess: false,
    canSatisfyRuntimeProof: false,
    canSatisfyDispatchProof: false,
  };
  evidence.evidenceHash = recomputeEvidenceHash(evidence);
  PINNED_EVIDENCE.set(evidence, Object.freeze({
    sourceIdentityHash,
    evidenceHash: evidence.evidenceHash,
  }));
  return evidence;
}

export function verifyColdPathCapabilityEvidence(evidence) {
  const pinned = PINNED_EVIDENCE.get(evidence);
  if (
    !pinned
    || evidence?.schemaVersion !== COLD_PATH_CAPABILITY_EVIDENCE_SCHEMA
    || evidence?.proofAuthority !== COLD_PATH_CAPABILITY_EVIDENCE_AUTHORITY
    || evidence?.sourceIdentityHash !== pinned.sourceIdentityHash
    || evidence?.normalizedAsSchedulingInput !== true
    || evidence?.acceptedForGpuHmr !== false
    || evidence?.gpuHmrSuccess !== false
    || evidence?.canSatisfyRuntimeProof !== false
    || evidence?.canSatisfyDispatchProof !== false
    || recomputeEvidenceHash(evidence) !== pinned.evidenceHash
    || evidence?.evidenceHash !== pinned.evidenceHash
  ) {
    throw new Error('cold_path_capability_evidence_invalid');
  }
  return evidence;
}

export function resolveColdPathRunner(evidence) {
  verifyColdPathCapabilityEvidence(evidence);
  const strongest = strongestObservationByCapability(evidence.observations);
  const evaluated = evidence.runnerDescriptors.map((runner) => {
    const requirements = runner.requirements.map((requirement) => {
      const observation = strongest.get(requirement.capability) ?? null;
      return {
        capability: requirement.capability,
        minimumStrength: requirement.minimumStrength,
        observedStrength: observation?.strength ?? null,
        observationHash: observation?.observationHash ?? null,
        satisfied: Boolean(observation)
          && COLD_PATH_EVIDENCE_STRENGTHS[observation.strength]
            >= COLD_PATH_EVIDENCE_STRENGTHS[requirement.minimumStrength],
      };
    });
    return {
      runnerDescriptorHash: runner.runnerDescriptorHash,
      profileSchema: runner.profileSchema,
      profileHash: runner.profileHash,
      requirements,
      eligible: requirements.every((requirement) => requirement.satisfied),
    };
  }).sort((left, right) => (
    left.runnerDescriptorHash.localeCompare(right.runnerDescriptorHash)
  ));
  const eligibleRunnerDescriptorHashes = evaluated
    .filter((runner) => runner.eligible)
    .map((runner) => runner.runnerDescriptorHash);
  const status = eligibleRunnerDescriptorHashes.length === 1
    ? 'runner_selected'
    : eligibleRunnerDescriptorHashes.length > 1
      ? 'ambiguous_runner_capabilities'
      : 'no_eligible_runner';
  const decision = {
    schemaVersion: COLD_PATH_RUNNER_DECISION_SCHEMA,
    proofAuthority: COLD_PATH_RUNNER_DECISION_AUTHORITY,
    capabilityEvidenceHash: evidence.evidenceHash,
    sourceIdentityHash: evidence.sourceIdentityHash,
    selectionStrataHash: evidence.selectionStrataHash,
    observationSetHash: evidence.observationSetHash,
    runnerDescriptorSetHash: evidence.runnerDescriptorSetHash,
    status,
    selectedRunnerDescriptorHash: status === 'runner_selected'
      ? eligibleRunnerDescriptorHashes[0]
      : null,
    eligibleRunnerDescriptorHashes,
    evaluatedRunners: evaluated,
    runnerAttempted: false,
    acceptedAsColdBuildEvidence: false,
    acceptedForGpuHmr: false,
    gpuHmrSuccess: false,
    canSatisfyRuntimeProof: false,
    canSatisfyDispatchProof: false,
  };
  decision.evidenceHash = recomputeEvidenceHash(decision);
  PINNED_DECISIONS.set(decision, Object.freeze({
    capabilityEvidenceHash: evidence.evidenceHash,
    evidenceHash: decision.evidenceHash,
  }));
  return decision;
}

export function verifyColdPathRunnerDecision(decision, evidence) {
  verifyColdPathCapabilityEvidence(evidence);
  const pinned = PINNED_DECISIONS.get(decision);
  if (
    !pinned
    || decision?.schemaVersion !== COLD_PATH_RUNNER_DECISION_SCHEMA
    || decision?.proofAuthority !== COLD_PATH_RUNNER_DECISION_AUTHORITY
    || decision?.capabilityEvidenceHash !== pinned.capabilityEvidenceHash
    || decision?.capabilityEvidenceHash !== evidence.evidenceHash
    || !['runner_selected', 'ambiguous_runner_capabilities', 'no_eligible_runner']
      .includes(decision?.status)
    || decision?.runnerAttempted !== false
    || decision?.acceptedAsColdBuildEvidence !== false
    || decision?.acceptedForGpuHmr !== false
    || decision?.gpuHmrSuccess !== false
    || decision?.canSatisfyRuntimeProof !== false
    || decision?.canSatisfyDispatchProof !== false
    || recomputeEvidenceHash(decision) !== pinned.evidenceHash
    || decision?.evidenceHash !== pinned.evidenceHash
  ) {
    throw new Error('cold_path_runner_decision_invalid');
  }
  return decision;
}
