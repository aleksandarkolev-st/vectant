import assert from 'node:assert/strict';

import {
  COLD_PATH_CAPABILITY_EVIDENCE_AUTHORITY,
  COLD_PATH_CAPABILITY_EVIDENCE_SCHEMA,
  COLD_PATH_RUNNER_DECISION_AUTHORITY,
  COLD_PATH_RUNNER_DECISION_SCHEMA,
  COLD_PATH_RUNNER_DESCRIPTOR_SCHEMA,
  createColdPathCapabilityEvidence,
  resolveColdPathRunner,
  verifyColdPathCapabilityEvidence,
  verifyColdPathRunnerDecision,
} from '../lib/gpu-hmr-cold-path-capability-evidence.mjs';

const hash = (character) => `sha256:${character.repeat(64)}`;
const sourceIdentity = {
  treeHash: hash('1'),
  revisionHash: hash('2'),
};

function observation(capability, strength, evidenceKind, character) {
  return {
    capability,
    strength,
    evidenceKind,
    evidenceAuthority: `${evidenceKind}.evidence`,
    evidenceHash: hash(character),
    sourceTreeHash: sourceIdentity.treeHash,
  };
}

function runner(profileSchema, character, capability, minimumStrength = 'profile_schema') {
  return {
    schemaVersion: COLD_PATH_RUNNER_DESCRIPTOR_SCHEMA,
    profileSchema,
    profileHash: hash(character),
    requirements: [{ capability, minimumStrength }],
  };
}

function evidence(overrides = {}) {
  return createColdPathCapabilityEvidence({
    sourceIdentity,
    selectionStrata: ['large.workspace', 'visual.or.compute'],
    observations: [],
    runnerDescriptors: [],
    ...overrides,
  });
}

const pathOnly = evidence({
  observations: [observation('capability.alpha', 'path_hint', 'path_scan', '3')],
  runnerDescriptors: [runner('profile.schema.alpha', '4', 'capability.alpha')],
});
assert.equal(pathOnly.schemaVersion, COLD_PATH_CAPABILITY_EVIDENCE_SCHEMA);
assert.equal(pathOnly.proofAuthority, COLD_PATH_CAPABILITY_EVIDENCE_AUTHORITY);
assert.equal(pathOnly.acceptedForGpuHmr, false);
assert.equal(pathOnly.gpuHmrSuccess, false);
assert.equal(verifyColdPathCapabilityEvidence(pathOnly), pathOnly);
const pathDecision = resolveColdPathRunner(pathOnly);
assert.equal(pathDecision.schemaVersion, COLD_PATH_RUNNER_DECISION_SCHEMA);
assert.equal(pathDecision.proofAuthority, COLD_PATH_RUNNER_DECISION_AUTHORITY);
assert.equal(pathDecision.status, 'no_eligible_runner');
assert.equal(pathDecision.selectedRunnerDescriptorHash, null);
assert.equal(pathDecision.runnerAttempted, false);
assert.equal(pathDecision.acceptedForGpuHmr, false);
assert.equal(pathDecision.gpuHmrSuccess, false);
assert.equal(verifyColdPathRunnerDecision(pathDecision, pathOnly), pathDecision);

const metadataOnly = evidence({
  observations: [observation(
    'capability.alpha',
    'metadata_content',
    'metadata_parser',
    '5',
  )],
  runnerDescriptors: [runner('profile.schema.alpha', '4', 'capability.alpha')],
});
assert.equal(resolveColdPathRunner(metadataOnly).status, 'no_eligible_runner');

const profileBacked = evidence({
  observations: [observation(
    'capability.alpha',
    'profile_schema',
    'profile_validator',
    '6',
  )],
  runnerDescriptors: [runner('profile.schema.alpha', '4', 'capability.alpha')],
});
const selected = resolveColdPathRunner(profileBacked);
assert.equal(selected.status, 'runner_selected');
assert.match(selected.selectedRunnerDescriptorHash, /^sha256:[a-f0-9]{64}$/);
assert.equal(selected.eligibleRunnerDescriptorHashes.length, 1);
assert.equal(selected.runnerAttempted, false);
assert.equal(selected.acceptedAsColdBuildEvidence, false);
assert.equal(selected.acceptedForGpuHmr, false);
assert.equal(selected.gpuHmrSuccess, false);

const reordered = evidence({
  sourceIdentity: { ...sourceIdentity },
  selectionStrata: ['visual.or.compute', 'large.workspace'],
  observations: [
    observation('capability.support', 'declaration', 'declaration', '7'),
    observation('capability.alpha', 'profile_schema', 'profile_validator', '6'),
  ],
  runnerDescriptors: [runner('profile.schema.alpha', '4', 'capability.alpha')],
});
const canonical = evidence({
  sourceIdentity: { ...sourceIdentity },
  selectionStrata: ['large.workspace', 'visual.or.compute'],
  observations: [
    observation('capability.alpha', 'profile_schema', 'profile_validator', '6'),
    observation('capability.support', 'declaration', 'declaration', '7'),
  ],
  runnerDescriptors: [runner('profile.schema.alpha', '4', 'capability.alpha')],
});
assert.equal(reordered.evidenceHash, canonical.evidenceHash);
assert.equal(
  resolveColdPathRunner(reordered).evidenceHash,
  resolveColdPathRunner(canonical).evidenceHash,
);

const ambiguous = evidence({
  observations: [
    observation('capability.alpha', 'observed_build', 'build_observer', '8'),
    observation('capability.beta', 'observed_runtime', 'runtime_observer', '9'),
  ],
  runnerDescriptors: [
    runner('profile.schema.alpha', 'a', 'capability.alpha'),
    runner('profile.schema.beta', 'b', 'capability.beta'),
  ],
});
const ambiguousDecision = resolveColdPathRunner(ambiguous);
assert.equal(ambiguousDecision.status, 'ambiguous_runner_capabilities');
assert.equal(ambiguousDecision.selectedRunnerDescriptorHash, null);
assert.equal(ambiguousDecision.eligibleRunnerDescriptorHashes.length, 2);
assert.equal(ambiguousDecision.runnerAttempted, false);

const resolvedSet = evidence({
  observations: [
    observation('capability.alpha', 'observed_build', 'build_observer', '8'),
    observation('capability.beta', 'path_hint', 'path_scan', '9'),
  ],
  runnerDescriptors: [
    runner('profile.schema.alpha', 'a', 'capability.alpha'),
    runner('profile.schema.beta', 'b', 'capability.beta'),
  ],
});
assert.equal(resolveColdPathRunner(resolvedSet).status, 'runner_selected');

assert.throws(
  () => createColdPathCapabilityEvidence({
    sourceIdentity,
    selectionStrata: ['large.workspace'],
    observations: [observation(
      'capability.alpha',
      'profile_schema',
      'path_scan',
      '3',
    )],
    runnerDescriptors: [],
  }),
  /observation_strength_invalid/,
);
assert.throws(
  () => evidence({
    runnerDescriptors: [runner(
      'profile.schema.alpha',
      '4',
      'capability.alpha',
      'path_hint',
    )],
  }),
  /runner_minimum_strength_invalid/,
);
assert.throws(
  () => createColdPathCapabilityEvidence({
    sourceIdentity,
    selectionStrata: ['large.workspace'],
    observations: [],
    runnerDescriptors: [],
    projectName: 'forbidden-decision-input',
  }),
  /input_shape_invalid/,
);
assert.throws(
  () => createColdPathCapabilityEvidence({
    sourceIdentity: { ...sourceIdentity, sourcePath: '/forbidden/path' },
    selectionStrata: ['large.workspace'],
    observations: [],
    runnerDescriptors: [],
  }),
  /source_identity_invalid/,
);
assert.throws(
  () => createColdPathCapabilityEvidence({
    sourceIdentity,
    selectionStrata: ['large.workspace'],
    observations: [],
    runnerDescriptors: [{
      ...runner('profile.schema.alpha', '4', 'capability.alpha'),
      runnerName: 'forbidden-label',
    }],
  }),
  /runner_shape_invalid/,
);

const clonedEvidence = structuredClone(profileBacked);
assert.throws(
  () => verifyColdPathCapabilityEvidence(clonedEvidence),
  /capability_evidence_invalid/,
);
const clonedDecision = structuredClone(selected);
assert.throws(
  () => verifyColdPathRunnerDecision(clonedDecision, profileBacked),
  /runner_decision_invalid/,
);
selected.acceptedForGpuHmr = true;
assert.throws(
  () => verifyColdPathRunnerDecision(selected, profileBacked),
  /runner_decision_invalid/,
);

process.stdout.write(`${JSON.stringify({
  status: 'self_check_passed',
  pathOnlyStatus: pathDecision.status,
  profileBackedStatus: resolveColdPathRunner(profileBacked).status,
  ambiguousStatus: ambiguousDecision.status,
  decisionHash: resolveColdPathRunner(profileBacked).evidenceHash,
  acceptedForGpuHmr: false,
  gpuHmrSuccess: false,
}, null, 2)}\n`);
