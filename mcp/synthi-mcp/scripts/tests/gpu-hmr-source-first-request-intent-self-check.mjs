#!/usr/bin/env node

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  deriveSourceFirstRequestIntent,
} from '../gpu-hmr-agent-split-workspace-test.mjs';

function hash(value) {
  return `sha256:${createHash('sha256').update(String(value)).digest('hex')}`;
}

function source(path, content) {
  return { kind: 'source', path, content };
}

function build(path, content) {
  return { kind: 'build', path, content };
}

function expectRefusal(run, reasonCode) {
  assert.throws(run, (error) => {
    assert.equal(error.reasonCode, reasonCode);
    assert.deepEqual(error.blockingGaps, [reasonCode]);
    return true;
  });
}

const cppFiles = [
  source('src/entry.cpp', 'int main() { return 0; }\n'),
  source('include/types.h', '#pragma once\nstruct Value { float x; };\n'),
  build('CMakeLists.txt', 'cmake_minimum_required(VERSION 3.24)\n'),
];
const cppIntent = deriveSourceFirstRequestIntent({
  entryPath: 'src/entry.cpp',
  files: cppFiles,
  typedOracleIntent: {
    outputOracleKind: 'compute_oracle',
    runtimeExpectationHash: hash('typed-compute-oracle'),
  },
});
assert.equal(cppIntent.language, 'cpp');
assert.equal(cppIntent.isGui, false);
assert.equal(cppIntent.oracleIntent, 'compute_oracle');
assert.deepEqual(cppIntent.buildMetadataPaths, ['CMakeLists.txt']);
assert.equal(cppIntent.sourceManifestHashVerified, true);
assert.equal(cppIntent.acceptedForGpuHmr, false);
assert.equal(cppIntent.gpuHmrSuccess, false);
assert.equal(cppIntent.canSatisfyRuntimeProof, false);
assert.equal(cppIntent.canSatisfyDispatchProof, false);

const openclIntent = deriveSourceFirstRequestIntent({
  entryPath: 'src/program.cl',
  files: [
    source('src/program.cl', 'typedef float scalar_t;\n'),
    source('include/scalars.h', '#pragma once\n'),
    build('build/config.json', '{"standard":"CL2.0"}\n'),
  ],
});
assert.equal(openclIntent.language, 'opencl');
assert.equal(openclIntent.isGui, false);
assert.equal(openclIntent.oracleIntent, 'non_visual_unspecified');

const visualSceneManifestHash = hash('typed-visual-scene');
const visualIntent = deriveSourceFirstRequestIntent({
  entryPath: 'src/view.cpp',
  files: [source('src/view.cpp', 'int main() { return 0; }\n')],
  typedOracleIntent: {
    outputOracleKind: 'visual_oracle',
    visualIntentDeclared: true,
    visualSceneManifestHash,
    visualSceneManifestEvidenceRef: `evidence:visual-scene:${visualSceneManifestHash}`,
    visualProofHash: hash('typed-visual-thresholds'),
    deterministicVisualModeHash: hash('typed-deterministic-controls'),
  },
});
assert.equal(visualIntent.language, 'cpp');
assert.equal(visualIntent.isGui, true);
assert.equal(visualIntent.uiMode, 'typed_visual_oracle');
assert.equal(visualIntent.oracleIntent, 'visual_oracle');
assert.ok(visualIntent.evidenceRefs.includes(visualSceneManifestHash));

expectRefusal(() => deriveSourceFirstRequestIntent({
  entryPath: 'src/entry.cpp',
  files: [
    source('src/entry.cpp', 'int main() { return 0; }\n'),
    source('src/program.cl', 'typedef float scalar_t;\n'),
  ],
}), 'source_first_request_intent_language_mixed');

expectRefusal(() => deriveSourceFirstRequestIntent({
  entryPath: 'src/entry.source',
  files: [source('src/entry.source', 'opaque source text\n')],
}), 'source_first_request_intent_language_unknown');

expectRefusal(() => deriveSourceFirstRequestIntent({
  entryPath: 'src/entry.cpp',
  files: [source('src/entry.cpp', 'int main() { return 0; }\n')],
  typedOracleIntent: {
    outputOracleKind: 'visual_oracle',
    visualSceneManifestHash,
    acceptedForGpuHmr: true,
  },
}), 'source_first_request_intent_claimed_authority');

const manifestBoundIntent = deriveSourceFirstRequestIntent({
  entryPath: 'src/entry.cpp',
  files: cppFiles,
});
const matchingManifestIntent = deriveSourceFirstRequestIntent({
  entryPath: 'src/entry.cpp',
  files: cppFiles,
  declaredSourceManifestHash: manifestBoundIntent.sourceManifestHash,
});
assert.equal(matchingManifestIntent.sourceManifestHash, manifestBoundIntent.sourceManifestHash);
assert.equal(matchingManifestIntent.intentHash, manifestBoundIntent.intentHash);

const changedFiles = cppFiles.map((entry) => (
  entry.path === 'src/entry.cpp'
    ? { ...entry, content: 'int main() { return 1; }\n' }
    : entry
));
expectRefusal(() => deriveSourceFirstRequestIntent({
  entryPath: 'src/entry.cpp',
  files: changedFiles,
  declaredSourceManifestHash: manifestBoundIntent.sourceManifestHash,
}), 'source_first_request_intent_manifest_hash_mismatch');

const changedManifestIntent = deriveSourceFirstRequestIntent({
  entryPath: 'src/entry.cpp',
  files: changedFiles,
});
assert.notEqual(changedManifestIntent.sourceManifestHash, manifestBoundIntent.sourceManifestHash);
assert.notEqual(changedManifestIntent.intentHash, manifestBoundIntent.intentHash);

console.log('gpu-hmr source-first request intent self-check passed');
