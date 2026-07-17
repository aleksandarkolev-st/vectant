#!/usr/bin/env node

import assert from 'node:assert/strict';
import {
  GPU_HMR_SOURCE_EXTENSION_REGISTRY,
  gpuHmrSourceExtensionMetadata,
  isGpuHmrAutomaticEntryCandidate,
  isGpuHmrSourcePath,
  normalizeGpuHmrSourceExtension,
} from '../lib/gpu-hmr-source-extension-registry.mjs';
import {
  deriveSourceFirstRequestIntent,
} from '../gpu-hmr-agent-split-workspace-test.mjs';

function source(path, content = `${path}\n`) {
  return { kind: 'source', path, content };
}

function build(path, content = `${path}\n`) {
  return { kind: 'build', path, content };
}

function expectRefusal(run, reasonCode) {
  assert.throws(run, (error) => {
    assert.equal(error.reasonCode, reasonCode);
    assert.deepEqual(error.blockingGaps, [reasonCode]);
    return true;
  });
}

const extensions = GPU_HMR_SOURCE_EXTENSION_REGISTRY.map((entry) => entry.extension);
assert.equal(new Set(extensions).size, extensions.length);
assert.deepEqual(extensions, [...extensions].sort());
assert.ok(GPU_HMR_SOURCE_EXTENSION_REGISTRY.every(
  (entry) => entry.canEstablishGpuCapability === false,
));

const formerlyScannerOnly = new Map([
  ['.hlsl', 'hlsl'],
  ['.metal', 'metal'],
  ['.slang', 'slang'],
]);
const formerlyIntentOnly = new Map([
  ['.c++', 'cpp'],
  ['.h++', 'cpp'],
  ['.opencl', 'opencl'],
  ['.geom', 'glsl'],
  ['.tesc', 'glsl'],
  ['.tese', 'glsl'],
  ['.zig', 'zig'],
]);
const neutralContextExtensions = ['.ipp', '.tpp'];

for (const [extension, language] of [...formerlyScannerOnly, ...formerlyIntentOnly]) {
  const upperPath = `src/entry${extension.toUpperCase()}`;
  const metadata = gpuHmrSourceExtensionMetadata(upperPath);
  assert.equal(normalizeGpuHmrSourceExtension(upperPath), extension);
  assert.equal(metadata?.requestLanguage, language);
  assert.equal(isGpuHmrSourcePath(upperPath), true);

  const intent = deriveSourceFirstRequestIntent({
    entryPath: upperPath,
    files: [source(upperPath)],
  });
  assert.equal(intent.language, language);
  assert.deepEqual(intent.sourceLanguageEvidence, [
    { path: upperPath, extension, language },
  ]);
  assert.equal(intent.acceptedForGpuHmr, false);
  assert.equal(intent.gpuHmrSuccess, false);
}

assert.equal(isGpuHmrAutomaticEntryCandidate('src/context.H++'), false);
for (const extension of neutralContextExtensions) {
  const contextPath = `include/context${extension.toUpperCase()}`;
  const metadata = gpuHmrSourceExtensionMetadata(contextPath);
  assert.equal(metadata?.role, 'neutral_context');
  assert.equal(metadata?.requestLanguage, null);
  assert.equal(isGpuHmrSourcePath(contextPath), true);
  assert.equal(isGpuHmrAutomaticEntryCandidate(contextPath), false);

  const intent = deriveSourceFirstRequestIntent({
    entryPath: 'src/entry.cpp',
    files: [source(contextPath), source('src/entry.cpp')],
  });
  assert.deepEqual(intent.languageNeutralSourcePaths, [contextPath]);
}

expectRefusal(() => deriveSourceFirstRequestIntent({
  entryPath: 'include/entry.IPP',
  files: [source('include/entry.IPP'), source('src/fallback.cpp')],
}), 'source_first_request_intent_entry_language_ambiguous');

expectRefusal(() => deriveSourceFirstRequestIntent({
  entryPath: 'src/entry.opaque',
  files: [source('src/entry.opaque')],
}), 'source_first_request_intent_language_unknown');
assert.equal(gpuHmrSourceExtensionMetadata('src/entry.opaque'), null);
assert.equal(isGpuHmrSourcePath('src/entry.opaque'), false);

const mixedFiles = [
  source('src/view.HLSL'),
  source('src/kernel.OPENCL'),
  source('include/context.IPP'),
  source('src/entry.C++'),
  build('build/tool.METAL'),
  build('CMakeLists.txt'),
];
const mixedIntent = deriveSourceFirstRequestIntent({
  entryPath: 'src/entry.C++',
  files: mixedFiles,
});
const reorderedIntent = deriveSourceFirstRequestIntent({
  entryPath: 'src/entry.C++',
  files: [...mixedFiles].reverse(),
});
assert.equal(mixedIntent.language, 'cpp');
assert.deepEqual(mixedIntent.sourceLanguageEvidence, [
  { path: 'src/entry.C++', extension: '.c++', language: 'cpp' },
  { path: 'src/kernel.OPENCL', extension: '.opencl', language: 'opencl' },
  { path: 'src/view.HLSL', extension: '.hlsl', language: 'hlsl' },
]);
assert.deepEqual(mixedIntent.languageNeutralSourcePaths, ['include/context.IPP']);
assert.deepEqual(mixedIntent.buildMetadataPaths, ['build/tool.METAL', 'CMakeLists.txt']);
assert.equal(mixedIntent.sourceLanguageEvidence.some(
  (entry) => entry.path === 'build/tool.METAL',
), false);
assert.equal(reorderedIntent.sourceManifestHash, mixedIntent.sourceManifestHash);
assert.equal(reorderedIntent.intentHash, mixedIntent.intentHash);
assert.deepEqual(reorderedIntent.sourceLanguageEvidence, mixedIntent.sourceLanguageEvidence);

console.log('gpu-hmr source extension registry self-check passed');
