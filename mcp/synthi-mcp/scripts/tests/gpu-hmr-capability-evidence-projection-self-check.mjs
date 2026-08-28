#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

import {
  GPU_HMR_CAPABILITY_EVIDENCE_PROJECTION_AUTHORITY,
  GPU_HMR_CAPABILITY_EVIDENCE_PROJECTION_INTEGRITY_AUTHORITY,
  GPU_HMR_CAPABILITY_EVIDENCE_PROJECTION_INTEGRITY_SCHEMA_VERSION,
  GPU_HMR_CAPABILITY_EVIDENCE_PROJECTION_SCHEMA_VERSION,
  GPU_HMR_CAPABILITY_VERIFIER_OUTCOME_FIELDS,
  deriveGpuHmrCapabilityVerifierOutcomeBindingHash,
  evaluateGpuHmrCapabilityEvidenceProjectionIntegrity,
  projectGpuHmrCapabilityEvidence,
} from '../lib/gpu-hmr-capability-evidence-projection.mjs';
import {
  GPU_HMR_RUNTIME_ADAPTER_ARTIFACT_FORMATS,
  GPU_HMR_RUNTIME_ADAPTER_CAPABILITY_FACT_FIELDS,
  GPU_HMR_RUNTIME_ADAPTER_CAPABILITY_OBLIGATIONS,
  GPU_HMR_RUNTIME_ADAPTER_COMMAND_RECORDING_MODELS,
  GPU_HMR_RUNTIME_ADAPTER_OUTPUT_MODALITIES,
  GPU_HMR_RUNTIME_ADAPTER_PIPELINE_CACHE_OBLIGATIONS,
  GPU_HMR_RUNTIME_ADAPTER_PIPELINE_CACHE_OWNERS,
  GPU_HMR_RUNTIME_ADAPTER_PUBLICATION_MODELS,
  createGpuHmrRuntimeAdapterCapabilities,
  deriveGpuHmrRuntimeAdapterCapabilityObligations,
} from '../lib/gpu-hmr-runtime-adapter-capabilities.mjs';

const SHA256_PATTERN = /^sha256:[0-9a-f]{64}$/;
const FORBIDDEN_IDENTITY_FIELDS = Object.freeze([
  'project',
  'projectName',
  'target',
  'targetName',
  'backend',
  'backendName',
  'profile',
  'profileName',
  'fixture',
  'fixtureName',
  'library',
  'libraryName',
  'family',
  'familyName',
  'scenario',
  'scenarioName',
]);

function hash(label) {
  return `sha256:${createHash('sha256').update(label).digest('hex')}`;
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function reverseRecord(value) {
  return Object.fromEntries(Object.entries(value).reverse());
}

function factsFromFacet(facet) {
  return Object.fromEntries(
    GPU_HMR_RUNTIME_ADAPTER_CAPABILITY_FACT_FIELDS.map(
      (field) => [field, facet[field]],
    ),
  );
}

function makeFacet(overrides = {}) {
  const outputModality = overrides.outputModality ?? 'compute';
  return createGpuHmrRuntimeAdapterCapabilities({
    artifactFormat: 'native_binary',
    outputModality,
    oracleKind: outputModality === 'visual'
      ? 'visual_frame_readback'
      : 'compute_readback',
    publicationModel: 'dispatch_table_epoch',
    commandRecordingModel: 'late_bound_dispatch',
    pipelineCacheOwner: 'adapter',
    evidenceRefs: ['facet:evidence'],
    ...overrides,
  });
}

function makeOutcome(facet, obligation, index, overrides = {}) {
  const satisfied = overrides.satisfied ?? true;
  const evidenceRefs = overrides.evidenceRefs
    ?? (satisfied ? [`evidence:${String(index).padStart(2, '0')}:${obligation}`] : []);
  const verifierSchemaHash = overrides.verifierSchemaHash ?? hash('verifier-schema:v1');
  const verifierId = overrides.verifierId ?? hash(`verifier:${obligation}`);
  const bindingInput = {
    capabilityBindingHash: facet.bindingHash,
    obligation,
    satisfied,
    evidenceRefs,
    verifierSchemaHash,
    verifierId,
  };
  return {
    obligation,
    satisfied,
    evidenceRefs,
    verifierSchemaHash,
    verifierId,
    verifierBindingHash: overrides.verifierBindingHash
      ?? deriveGpuHmrCapabilityVerifierOutcomeBindingHash(bindingInput),
  };
}

function makeOutcomes(facet, options = {}) {
  const obligations = deriveGpuHmrRuntimeAdapterCapabilityObligations(
    factsFromFacet(facet),
  );
  return obligations.map((obligation, index) => makeOutcome(
    facet,
    obligation,
    index,
    options.outcome?.(obligation, index) ?? {},
  ));
}

function makeInput(facet = makeFacet(), options = {}) {
  return {
    capabilityFacet: clone(facet),
    verifierOutcomes: makeOutcomes(facet, options),
  };
}

function assertAuditOnly(result) {
  assert.equal(result.valid, true);
  assert.equal(result.acceptedAsSupportEvidence, false);
  assert.equal(result.acceptedForGpuHmr, false);
  assert.equal(result.gpuHmrSuccess, false);
  assert.equal(result.canSatisfyRuntimeProof, false);
  assert.equal(result.canSatisfyDispatchProof, false);
}

function assertIntegrityRejected(candidate) {
  const integrity = evaluateGpuHmrCapabilityEvidenceProjectionIntegrity(candidate);
  assert.equal(integrity.valid, false, JSON.stringify(integrity));
  assert.equal(integrity.acceptedAsSupportEvidence, false);
  assert.equal(integrity.acceptedForGpuHmr, false);
  assert.equal(integrity.gpuHmrSuccess, false);
  assert.equal(integrity.canSatisfyRuntimeProof, false);
  assert.equal(integrity.canSatisfyDispatchProof, false);
  assert.equal(integrity.recomputedProjection, null);
  assert.ok(integrity.failures.length > 0);
}

function assertDeepFrozen(value, seen = new Set()) {
  if (value === null || typeof value !== 'object' || seen.has(value)) return;
  seen.add(value);
  assert.equal(Object.isFrozen(value), true);
  for (const child of Object.values(value)) assertDeepFrozen(child, seen);
}

function collectKeys(value, keys = new Set()) {
  if (Array.isArray(value)) {
    for (const entry of value) collectKeys(entry, keys);
  } else if (value !== null && typeof value === 'object') {
    for (const [key, entry] of Object.entries(value)) {
      keys.add(key);
      collectKeys(entry, keys);
    }
  }
  return keys;
}

const baselineFacet = makeFacet();
const baselineInput = makeInput(baselineFacet);
const baseline = projectGpuHmrCapabilityEvidence(baselineInput);

assert.equal(
  baseline.schemaVersion,
  GPU_HMR_CAPABILITY_EVIDENCE_PROJECTION_SCHEMA_VERSION,
);
assert.equal(baseline.authority, GPU_HMR_CAPABILITY_EVIDENCE_PROJECTION_AUTHORITY);
assertAuditOnly(baseline);
assert.equal(baseline.allDeclaredVerifierOutcomesSatisfied, true);
assert.deepEqual(
  baseline.obligations,
  deriveGpuHmrRuntimeAdapterCapabilityObligations(factsFromFacet(baselineFacet)),
);
assert.equal(baseline.verifierOutcomes.length, baseline.obligations.length);
for (let index = 0; index < baseline.obligations.length; index += 1) {
  const outcome = baseline.verifierOutcomes[index];
  assert.deepEqual(Object.keys(outcome), GPU_HMR_CAPABILITY_VERIFIER_OUTCOME_FIELDS);
  assert.equal(outcome.obligation, baseline.obligations[index]);
  assert.equal(outcome.satisfied, true);
  assert.ok(outcome.evidenceRefs.length > 0);
  assert.match(outcome.verifierSchemaHash, SHA256_PATTERN);
  assert.match(outcome.verifierId, SHA256_PATTERN);
  assert.match(outcome.verifierBindingHash, SHA256_PATTERN);
}
assert.match(baseline.capabilityBindingHash, SHA256_PATTERN);
assert.match(baseline.outcomesHash, SHA256_PATTERN);
assert.match(baseline.projectionHash, SHA256_PATTERN);
assert.equal(
  baseline.proofId,
  `capability-evidence-projection:${baseline.projectionHash}`,
);
assertDeepFrozen(baseline);

const serializedIntegrity = evaluateGpuHmrCapabilityEvidenceProjectionIntegrity(
  clone(baseline),
);
assert.equal(
  serializedIntegrity.schemaVersion,
  GPU_HMR_CAPABILITY_EVIDENCE_PROJECTION_INTEGRITY_SCHEMA_VERSION,
);
assert.equal(
  serializedIntegrity.authority,
  GPU_HMR_CAPABILITY_EVIDENCE_PROJECTION_INTEGRITY_AUTHORITY,
);
assert.equal(serializedIntegrity.valid, true);
assert.equal(serializedIntegrity.acceptedAsSupportEvidence, false);
assert.deepEqual(serializedIntegrity.recomputedProjection, baseline);
assertDeepFrozen(serializedIntegrity);

// Callers can manufacture every declaration and binding hash. Structural validity
// therefore remains audit-only and cannot become authenticated support evidence.
const callerDeclaredAllTrueFacet = makeFacet();
const callerDeclaredAllTrue = projectGpuHmrCapabilityEvidence(makeInput(
  callerDeclaredAllTrueFacet,
  {
    outcome: (obligation) => ({
      satisfied: true,
      verifierSchemaHash: hash('caller-invented-verifier-schema'),
      verifierId: hash(`caller-invented-verifier:${obligation}`),
    }),
  },
));
assert.equal(
  callerDeclaredAllTrue.verifierOutcomes.every((outcome) => outcome.satisfied),
  true,
);
assert.equal(callerDeclaredAllTrue.allDeclaredVerifierOutcomesSatisfied, true);
assertAuditOnly(callerDeclaredAllTrue);
const callerDeclaredAllTrueIntegrity =
  evaluateGpuHmrCapabilityEvidenceProjectionIntegrity(clone(callerDeclaredAllTrue));
assert.equal(callerDeclaredAllTrueIntegrity.valid, true);
assert.equal(callerDeclaredAllTrueIntegrity.acceptedAsSupportEvidence, false);
assert.ok(callerDeclaredAllTrueIntegrity.recomputedProjection);

// Every capability combination must use the generic facet's exact obligation order.
const coveredObligations = new Set();
let combinationCount = 0;
for (const artifactFormat of GPU_HMR_RUNTIME_ADAPTER_ARTIFACT_FORMATS) {
  for (const outputModality of GPU_HMR_RUNTIME_ADAPTER_OUTPUT_MODALITIES) {
    for (const publicationModel of GPU_HMR_RUNTIME_ADAPTER_PUBLICATION_MODELS) {
      for (const commandRecordingModel of GPU_HMR_RUNTIME_ADAPTER_COMMAND_RECORDING_MODELS) {
        for (const pipelineCacheOwner of GPU_HMR_RUNTIME_ADAPTER_PIPELINE_CACHE_OWNERS) {
          const facet = makeFacet({
            artifactFormat,
            outputModality,
            publicationModel,
            commandRecordingModel,
            pipelineCacheOwner,
          });
          const expected = deriveGpuHmrRuntimeAdapterCapabilityObligations(
            factsFromFacet(facet),
          );
          const projection = projectGpuHmrCapabilityEvidence(makeInput(facet));
          assert.deepEqual(projection.obligations, expected);
          assert.deepEqual(
            projection.verifierOutcomes.map((outcome) => outcome.obligation),
            expected,
          );
          expected.forEach((obligation) => coveredObligations.add(obligation));
          combinationCount += 1;
        }
      }
    }
  }
}
assert.equal(combinationCount, 5 * 2 * 4 * 4 * 6);
const everyDefinedObligation = new Set([
  ...Object.values(GPU_HMR_RUNTIME_ADAPTER_CAPABILITY_OBLIGATIONS),
  ...Object.values(GPU_HMR_RUNTIME_ADAPTER_PIPELINE_CACHE_OBLIGATIONS).flat(),
]);
assert.equal(everyDefinedObligation.size, 52);
assert.deepEqual([...coveredObligations].sort(), [...everyDefinedObligation].sort());

const opaqueFacet = makeFacet({
  artifactFormat: 'opaque_payload',
  outputModality: 'visual',
  publicationModel: 'opaque_callback_epoch',
  commandRecordingModel: 'opaque_engine_managed',
  pipelineCacheOwner: 'opaque_external',
});
const opaqueProjection = projectGpuHmrCapabilityEvidence(makeInput(opaqueFacet));
for (const obligation of [
  'explicit_app_hook_contract',
  'runtime_boundary_evidence',
  'visual_verified_before_bytes',
  ...GPU_HMR_RUNTIME_ADAPTER_PIPELINE_CACHE_OBLIGATIONS.opaque_external,
]) {
  assert.ok(opaqueProjection.obligations.includes(obligation), obligation);
}
assert.equal(
  opaqueProjection.verifierOutcomes.length,
  opaqueProjection.obligations.length,
);

const cacheNoneFacet = makeFacet({ pipelineCacheOwner: 'none' });
const cacheNoneProjection = projectGpuHmrCapabilityEvidence(makeInput(cacheNoneFacet));
for (const obligation of GPU_HMR_RUNTIME_ADAPTER_PIPELINE_CACHE_OBLIGATIONS.none) {
  assert.ok(cacheNoneProjection.obligations.includes(obligation), obligation);
  assert.ok(cacheNoneProjection.verifierOutcomes.some(
    (outcome) => outcome.obligation === obligation,
  ));
}

// Canonical ordering is mandatory; the projector does not sort caller claims.
const shuffled = clone(baselineInput);
[shuffled.verifierOutcomes[0], shuffled.verifierOutcomes[1]] = [
  shuffled.verifierOutcomes[1],
  shuffled.verifierOutcomes[0],
];
assert.throws(
  () => projectGpuHmrCapabilityEvidence(shuffled),
  /verifier_outcomes_not_canonical/,
);
const duplicate = clone(baselineInput);
duplicate.verifierOutcomes[1] = clone(duplicate.verifierOutcomes[0]);
assert.throws(
  () => projectGpuHmrCapabilityEvidence(duplicate),
  /verifier_outcomes_not_canonical/,
);
const missing = clone(baselineInput);
missing.verifierOutcomes.pop();
assert.throws(
  () => projectGpuHmrCapabilityEvidence(missing),
  /verifier_outcomes_cardinality_mismatch/,
);
const extra = clone(baselineInput);
extra.verifierOutcomes.push(clone(extra.verifierOutcomes.at(-1)));
assert.throws(
  () => projectGpuHmrCapabilityEvidence(extra),
  /verifier_outcomes_cardinality_mismatch/,
);

for (const evidenceRefs of [
  ['evidence:z', 'evidence:a'],
  ['evidence:a', 'evidence:a'],
  [],
]) {
  const malformed = clone(baselineInput);
  malformed.verifierOutcomes[0].evidenceRefs = evidenceRefs;
  malformed.verifierOutcomes[0].verifierBindingHash = hash('placeholder');
  assert.throws(() => projectGpuHmrCapabilityEvidence(malformed), /evidence_refs/);
}
const unsatisfiedInput = makeInput(baselineFacet, {
  outcome: (_obligation, index) => index === 0
    ? { satisfied: false, evidenceRefs: [] }
    : {},
});
const unsatisfied = projectGpuHmrCapabilityEvidence(unsatisfiedInput);
assert.equal(unsatisfied.allDeclaredVerifierOutcomesSatisfied, false);
assertAuditOnly(unsatisfied);
assert.equal(
  evaluateGpuHmrCapabilityEvidenceProjectionIntegrity(clone(unsatisfied)).valid,
  true,
);

for (const field of ['verifierSchemaHash', 'verifierId', 'verifierBindingHash']) {
  const malformed = clone(baselineInput);
  malformed.verifierOutcomes[0][field] = 'sha256:ABC';
  assert.throws(() => projectGpuHmrCapabilityEvidence(malformed), /hash|verifier_id/);
}
const crossBindingForgery = clone(baselineInput);
crossBindingForgery.verifierOutcomes[0].verifierId = hash('replacement-verifier');
assert.throws(
  () => projectGpuHmrCapabilityEvidence(crossBindingForgery),
  /verifier_binding_hash_mismatch/,
);

// Identity fields and aliases are rejected at every exact schema boundary.
for (const identityField of FORBIDDEN_IDENTITY_FIELDS) {
  assert.throws(
    () => projectGpuHmrCapabilityEvidence({
      ...clone(baselineInput),
      [identityField]: 'identity-injection',
    }),
    /input_field_set_mismatch/,
  );
  const outcomeInjection = clone(baselineInput);
  outcomeInjection.verifierOutcomes[0][identityField] = 'identity-injection';
  assert.throws(
    () => projectGpuHmrCapabilityEvidence(outcomeInjection),
    /verifier_outcome_field_set_mismatch/,
  );
  const facetInjection = clone(baselineInput);
  facetInjection.capabilityFacet[identityField] = 'identity-injection';
  assert.throws(
    () => projectGpuHmrCapabilityEvidence(facetInjection),
    /capability_facet_integrity_invalid/,
  );
  assertIntegrityRejected({ ...clone(baseline), [identityField]: 'identity-injection' });
}
const aliasOutcome = clone(baselineInput);
aliasOutcome.verifierOutcomes[0].supported = true;
assert.throws(
  () => projectGpuHmrCapabilityEvidence(aliasOutcome),
  /verifier_outcome_field_set_mismatch/,
);
assert.throws(
  () => projectGpuHmrCapabilityEvidence({
    capabilityFacet: clone(baselineFacet),
    outcomes: clone(baselineInput.verifierOutcomes),
  }),
  /input_field_set_mismatch/,
);
const conflictingAuthorityInput = clone(baselineInput);
conflictingAuthorityInput.acceptedForGpuHmr = true;
assert.throws(
  () => projectGpuHmrCapabilityEvidence(conflictingAuthorityInput),
  /input_field_set_mismatch/,
);
const conflictingOutcome = clone(baselineInput);
conflictingOutcome.verifierOutcomes[0].gpuHmrSuccess = true;
assert.throws(
  () => projectGpuHmrCapabilityEvidence(conflictingOutcome),
  /verifier_outcome_field_set_mismatch/,
);

for (const field of [
  'acceptedForGpuHmr',
  'gpuHmrSuccess',
  'canSatisfyRuntimeProof',
  'canSatisfyDispatchProof',
]) {
  const forged = clone(baseline);
  forged[field] = true;
  assertIntegrityRejected(forged);
}
for (const [field, value] of [
  ['schemaVersion', 'forged-schema'],
  ['authority', 'forged-authority'],
  ['capabilityBindingHash', hash('forged-capability-binding')],
  ['outcomesHash', hash('forged-outcomes')],
  ['projectionHash', hash('forged-projection')],
  ['proofId', `capability-evidence-projection:${hash('forged-proof-id')}`],
  ['valid', false],
  ['acceptedAsSupportEvidence', true],
  ['allDeclaredVerifierOutcomesSatisfied', false],
]) {
  const forged = clone(baseline);
  forged[field] = value;
  assertIntegrityRejected(forged);
}
const tamperedObligation = clone(baseline);
tamperedObligation.obligations[0] = 'forged_obligation';
assertIntegrityRejected(tamperedObligation);
const tamperedOutcome = clone(baseline);
tamperedOutcome.verifierOutcomes[0].satisfied = false;
assertIntegrityRejected(tamperedOutcome);
const tamperedFacet = clone(baseline);
tamperedFacet.capabilityFacet.bindingHash = hash('forged-facet-binding');
assertIntegrityRejected(tamperedFacet);
assertIntegrityRejected({ ...clone(baseline), unknownResultField: true });

const retainedInputMutation = clone(baseline);
retainedInputMutation.verifierOutcomes[0].evidenceRefs = ['evidence:replacement'];
retainedInputMutation.verifierOutcomes[0].verifierBindingHash =
  deriveGpuHmrCapabilityVerifierOutcomeBindingHash({
    capabilityBindingHash: retainedInputMutation.capabilityBindingHash,
    obligation: retainedInputMutation.verifierOutcomes[0].obligation,
    satisfied: retainedInputMutation.verifierOutcomes[0].satisfied,
    evidenceRefs: retainedInputMutation.verifierOutcomes[0].evidenceRefs,
    verifierSchemaHash: retainedInputMutation.verifierOutcomes[0].verifierSchemaHash,
    verifierId: retainedInputMutation.verifierOutcomes[0].verifierId,
  });
assertIntegrityRejected(retainedInputMutation);

// Property order does not affect canonical output or hashes.
const reorderedInput = reverseRecord(clone(baselineInput));
reorderedInput.capabilityFacet = reverseRecord(reorderedInput.capabilityFacet);
reorderedInput.verifierOutcomes = reorderedInput.verifierOutcomes.map(reverseRecord);
assert.deepEqual(projectGpuHmrCapabilityEvidence(reorderedInput), baseline);

const changedEvidenceInput = clone(baselineInput);
changedEvidenceInput.verifierOutcomes[0].evidenceRefs = ['evidence:changed'];
changedEvidenceInput.verifierOutcomes[0].verifierBindingHash =
  deriveGpuHmrCapabilityVerifierOutcomeBindingHash({
    capabilityBindingHash: baseline.capabilityBindingHash,
    obligation: changedEvidenceInput.verifierOutcomes[0].obligation,
    satisfied: true,
    evidenceRefs: changedEvidenceInput.verifierOutcomes[0].evidenceRefs,
    verifierSchemaHash: changedEvidenceInput.verifierOutcomes[0].verifierSchemaHash,
    verifierId: changedEvidenceInput.verifierOutcomes[0].verifierId,
  });
const changedEvidence = projectGpuHmrCapabilityEvidence(changedEvidenceInput);
assert.deepEqual(changedEvidence.obligations, baseline.obligations);
assert.equal(changedEvidence.allDeclaredVerifierOutcomesSatisfied, true);
assert.notEqual(changedEvidence.outcomesHash, baseline.outcomesHash);
assert.notEqual(changedEvidence.projectionHash, baseline.projectionHash);

const changedVerifierInput = clone(baselineInput);
changedVerifierInput.verifierOutcomes[0].verifierId = hash('changed-verifier-id');
changedVerifierInput.verifierOutcomes[0].verifierBindingHash =
  deriveGpuHmrCapabilityVerifierOutcomeBindingHash({
    capabilityBindingHash: baseline.capabilityBindingHash,
    obligation: changedVerifierInput.verifierOutcomes[0].obligation,
    satisfied: true,
    evidenceRefs: changedVerifierInput.verifierOutcomes[0].evidenceRefs,
    verifierSchemaHash: changedVerifierInput.verifierOutcomes[0].verifierSchemaHash,
    verifierId: changedVerifierInput.verifierOutcomes[0].verifierId,
  });
const changedVerifier = projectGpuHmrCapabilityEvidence(changedVerifierInput);
assert.deepEqual(changedVerifier.obligations, baseline.obligations);
assert.notEqual(changedVerifier.outcomesHash, baseline.outcomesHash);

let accessorCalled = false;
const accessorInput = clone(baselineInput);
Object.defineProperty(accessorInput, 'capabilityFacet', {
  enumerable: true,
  get() {
    accessorCalled = true;
    return clone(baselineFacet);
  },
});
assert.throws(
  () => projectGpuHmrCapabilityEvidence(accessorInput),
  /accessor_or_hidden_field/,
);
assert.equal(accessorCalled, false);
assert.throws(
  () => projectGpuHmrCapabilityEvidence(new Proxy(clone(baselineInput), {})),
  /proxy_forbidden/,
);
const proxiedOutcome = clone(baselineInput);
proxiedOutcome.verifierOutcomes[0] = new Proxy(proxiedOutcome.verifierOutcomes[0], {});
assert.throws(() => projectGpuHmrCapabilityEvidence(proxiedOutcome), /proxy_forbidden/);
const cyclicInput = clone(baselineInput);
cyclicInput.verifierOutcomes[0].cycle = cyclicInput;
assert.throws(() => projectGpuHmrCapabilityEvidence(cyclicInput), /cycle_forbidden/);
const sparseInput = clone(baselineInput);
delete sparseInput.verifierOutcomes[0];
assert.throws(
  () => projectGpuHmrCapabilityEvidence(sparseInput),
  /array_shape_invalid|sparse_or_accessor_array/,
);
const customPrototypeInput = clone(baselineInput);
Object.setPrototypeOf(customPrototypeInput.verifierOutcomes[0], { custom: true });
assert.throws(
  () => projectGpuHmrCapabilityEvidence(customPrototypeInput),
  /object_prototype_invalid/,
);
const symbolInput = clone(baselineInput);
symbolInput[Symbol('identity')] = 'forbidden';
assert.throws(() => projectGpuHmrCapabilityEvidence(symbolInput), /symbol_key_forbidden/);
const oversizedRefInput = clone(baselineInput);
oversizedRefInput.verifierOutcomes[0].evidenceRefs = [`evidence:${'x'.repeat(1024)}`];
oversizedRefInput.verifierOutcomes[0].verifierBindingHash = hash('placeholder');
assert.throws(() => projectGpuHmrCapabilityEvidence(oversizedRefInput), /evidence_ref_invalid/);
const oversizedStringInput = clone(baselineInput);
oversizedStringInput.unbounded = 'x'.repeat(4097);
assert.throws(() => projectGpuHmrCapabilityEvidence(oversizedStringInput), /string_invalid/);
assert.throws(
  () => projectGpuHmrCapabilityEvidence({
    capabilityFacet: clone(baselineFacet),
    verifierOutcomes: new Array(129).fill(null),
  }),
  /array_shape_invalid/,
);

let resultAccessorCalled = false;
const accessorResult = clone(baseline);
Object.defineProperty(accessorResult, 'projectionHash', {
  enumerable: true,
  get() {
    resultAccessorCalled = true;
    return hash('forged');
  },
});
assertIntegrityRejected(accessorResult);
assert.equal(resultAccessorCalled, false);
assertIntegrityRejected(new Proxy(clone(baseline), {}));
const cyclicResult = clone(baseline);
cyclicResult.verifierOutcomes[0].cycle = cyclicResult;
assertIntegrityRejected(cyclicResult);

const baselineKeys = collectKeys(baseline);
for (const forbiddenField of FORBIDDEN_IDENTITY_FIELDS) {
  assert.equal(baselineKeys.has(forbiddenField), false, forbiddenField);
}
const moduleSource = readFileSync(
  new URL('../lib/gpu-hmr-capability-evidence-projection.mjs', import.meta.url),
  'utf8',
);
assert.doesNotMatch(
  moduleSource,
  /\b(?:project|target|backend|profile|fixture|library|family|scenario)(?:Name)?\b/,
);
assert.doesNotMatch(
  moduleSource,
  /(?:beforeBytes|afterBytes|decodedBytes|artifactBytes|imageBytes)/,
);

console.log(JSON.stringify({
  ok: true,
  combinations: combinationCount,
  obligationsCovered: coveredObligations.size,
  baselineObligations: baseline.obligations.length,
}));
