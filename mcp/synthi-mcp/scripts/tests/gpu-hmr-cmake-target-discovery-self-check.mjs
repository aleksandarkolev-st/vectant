import assert from 'node:assert/strict';

import {
  resolveCmakeTargetFromFileApi,
  verifyCmakeTargetResolutionEvidence,
} from '../lib/gpu-hmr-cmake-target-discovery.mjs';

function file(path, value) {
  return { path, content: `${JSON.stringify(value)}\n` };
}

function fileApiFixture(targets) {
  const targetRefs = targets.map((target, index) => ({
    id: target.id,
    name: target.name,
    jsonFile: `target-${index}.json`,
  }));
  return [
    file('reply/index-current.json', {
      reply: {
        'codemodel-v2': {
          kind: 'codemodel',
          jsonFile: 'codemodel-current.json',
        },
      },
    }),
    file('reply/codemodel-current.json', {
      kind: 'codemodel',
      configurations: [{ name: 'Release', targets: targetRefs }],
    }),
    ...targets.map((target, index) => file(`reply/target-${index}.json`, {
      id: target.id,
      name: target.name,
      type: target.type,
      sources: (target.sources ?? []).map((sourcePath) => ({ path: sourcePath })),
      dependencies: (target.dependencies ?? []).map((id) => ({ id })),
      artifacts: (target.artifacts ?? []).map((artifactPath) => ({ path: artifactPath })),
    })),
  ];
}

const sourceRoots = ['/workspace/source'];
const libraryAndExecutable = fileApiFixture([
  {
    id: 'opaque-library::@1',
    name: 'opaque-library',
    type: 'STATIC_LIBRARY',
    sources: ['/workspace/source/src/kernel.cpp'],
    artifacts: ['build/libopaque.a'],
  },
  {
    id: 'opaque-driver::@2',
    name: 'opaque-driver',
    type: 'EXECUTABLE',
    sources: ['/workspace/source/src/main.cpp'],
    dependencies: ['opaque-library::@1'],
    artifacts: ['build/opaque-driver'],
  },
]);

const unique = resolveCmakeTargetFromFileApi({
  replyFiles: libraryAndExecutable,
  declaredSourcePaths: ['src/kernel.cpp', 'src/kernel.cpp'],
  requestedTargetType: 'EXECUTABLE',
  configuration: 'Release',
  sourceRoots,
});
assert.equal(unique.accepted, true);
assert.equal(unique.resolvedTargetName, 'opaque-driver');
assert.equal(unique.method, 'unique_source_owner');
assert.equal(unique.compileDatabaseStatus, 'absent');
assert.deepEqual(unique.declaredSourcePaths, ['src/kernel.cpp']);
assert.equal(verifyCmakeTargetResolutionEvidence(unique), unique);

const requested = resolveCmakeTargetFromFileApi({
  replyFiles: libraryAndExecutable,
  compileCommands: [{ file: '/workspace/source/src/kernel.cpp' }],
  declaredSourcePaths: ['src/kernel.cpp'],
  requestedTargetName: 'opaque-driver',
  requestedTargetType: 'EXECUTABLE',
  configuration: 'Release',
  sourceRoots,
  requireCompileDatabaseCorroboration: true,
});
assert.equal(requested.accepted, true);
assert.equal(requested.method, 'requested_target_verified_by_codemodel');

const conflict = resolveCmakeTargetFromFileApi({
  replyFiles: libraryAndExecutable,
  declaredSourcePaths: ['src/kernel.cpp'],
  requestedTargetName: 'opaque-library',
  requestedTargetType: 'EXECUTABLE',
  configuration: 'Release',
  sourceRoots,
});
assert.equal(conflict.accepted, false);
assert.deepEqual(conflict.blockingGaps, ['cmake_target_resolution_requested_target_type_conflict']);

const ambiguous = resolveCmakeTargetFromFileApi({
  replyFiles: fileApiFixture([
    { id: 'first::@1', name: 'first', type: 'EXECUTABLE', sources: ['src/kernel.cpp'] },
    { id: 'second::@2', name: 'second', type: 'EXECUTABLE', sources: ['src/kernel.cpp'] },
  ]),
  declaredSourcePaths: ['src/kernel.cpp'],
  requestedTargetType: 'EXECUTABLE',
  configuration: 'Release',
});
assert.equal(ambiguous.accepted, false);
assert.deepEqual(ambiguous.blockingGaps, ['cmake_target_resolution_ambiguous']);

const unmatched = resolveCmakeTargetFromFileApi({
  replyFiles: fileApiFixture([
    { id: 'only::@1', name: 'only', type: 'EXECUTABLE', sources: ['src/other.cpp'] },
  ]),
  declaredSourcePaths: ['src/kernel.cpp'],
  requestedTargetType: 'EXECUTABLE',
  configuration: 'Release',
});
assert.equal(unmatched.accepted, false);
assert.deepEqual(unmatched.blockingGaps, ['cmake_target_resolution_unmatched']);

const split = resolveCmakeTargetFromFileApi({
  replyFiles: fileApiFixture([
    { id: 'first::@1', name: 'first', type: 'EXECUTABLE', sources: ['src/a.cpp'] },
    { id: 'second::@2', name: 'second', type: 'EXECUTABLE', sources: ['src/b.cpp'] },
  ]),
  declaredSourcePaths: ['src/a.cpp', 'src/b.cpp'],
  requestedTargetType: 'EXECUTABLE',
  configuration: 'Release',
});
assert.equal(split.accepted, false);
assert.deepEqual(split.blockingGaps, ['cmake_target_resolution_split_ownership']);

const malformedReference = structuredClone(libraryAndExecutable);
malformedReference.splice(3, 1);
const malformed = resolveCmakeTargetFromFileApi({
  replyFiles: malformedReference,
  declaredSourcePaths: ['src/kernel.cpp'],
  requestedTargetType: 'EXECUTABLE',
  configuration: 'Release',
  sourceRoots,
});
assert.equal(malformed.accepted, false);
assert.deepEqual(malformed.blockingGaps, ['cmake_target_resolution_target_reference_invalid']);

const compileOnly = resolveCmakeTargetFromFileApi({
  replyFiles: [],
  compileCommands: [{ file: 'src/kernel.cpp' }],
  declaredSourcePaths: ['src/kernel.cpp'],
  requestedTargetType: 'EXECUTABLE',
  configuration: 'Release',
});
assert.equal(compileOnly.accepted, false);
assert.deepEqual(compileOnly.blockingGaps, ['cmake_target_resolution_index_missing']);

const compileConflict = resolveCmakeTargetFromFileApi({
  replyFiles: libraryAndExecutable,
  compileCommands: [{ file: '/workspace/source/src/other.cpp' }],
  declaredSourcePaths: ['src/kernel.cpp'],
  requestedTargetType: 'EXECUTABLE',
  configuration: 'Release',
  sourceRoots,
  requireCompileDatabaseCorroboration: true,
});
assert.equal(compileConflict.accepted, false);
assert.deepEqual(
  compileConflict.blockingGaps,
  ['cmake_target_resolution_compile_database_conflict'],
);

const forged = structuredClone(unique);
forged.resolvedTargetName = 'forged-target';
assert.throws(
  () => verifyCmakeTargetResolutionEvidence(forged),
  /cmake_target_resolution_evidence_invalid/,
);
const authorityClaiming = structuredClone(unique);
authorityClaiming.accepted_for_gpu_hmr = true;
assert.throws(
  () => verifyCmakeTargetResolutionEvidence(authorityClaiming),
  /cmake_target_resolution_evidence_invalid/,
);

assert.ok(!JSON.stringify({ unique, requested, conflict, ambiguous, unmatched, split }).match(
  /miopen|composable|hipblas|flow|diamond|hiprt|fixture_name|project_name/i,
));

console.log(JSON.stringify({
  status: 'self_check_passed',
  acceptedEvidenceHash: unique.evidenceHash,
  acceptedTarget: unique.resolvedTargetName,
  ambiguousRefused: ambiguous.accepted === false,
  unmatchedRefused: unmatched.accepted === false,
  splitOwnershipRefused: split.accepted === false,
  compileDatabaseOnlyRefused: compileOnly.accepted === false,
  acceptedForGpuHmr: unique.acceptedForGpuHmr,
  gpuHmrSuccess: unique.gpuHmrSuccess,
}, null, 2));
