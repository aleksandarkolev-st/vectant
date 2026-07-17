#!/usr/bin/env node

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  buildSourceFirstInitialCompileRequest,
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

function compileArgsFor(intent, files) {
  const entry = files.find((file) => file.path === intent.entryPath);
  assert.ok(entry, 'intent entry must be present in the exact source manifest');
  return {
    language: intent.language,
    filename: intent.entryPath,
    source: entry.content,
    files: files.map((file) => ({
      path: file.path,
      name: file.path,
      content: file.content,
    })),
    is_gui: intent.isGui,
    source_first_request_intent: intent,
    use_ai_split: true,
    ai_provider_call_nonce: 'provider-call:0123456789abcdef0123456789abcdef',
    ai_provider: 'provider-from-config',
    ai_model: 'model-from-config',
    user_requested_ai: true,
    prefer_gpu_pipeline: true,
    slug: 'source-first-request-self-check',
    width: 640,
    height: 360,
  };
}

const computeFiles = [
  source('src/entry.cpp', 'int main() { return 0; }\n'),
  source('include/value.h', '#pragma once\nstruct Value { float x; };\n'),
  build('CMakeLists.txt', 'cmake_minimum_required(VERSION 3.24)\n'),
];
const computeIntent = deriveSourceFirstRequestIntent({
  entryPath: 'src/entry.cpp',
  files: computeFiles,
  typedOracleIntent: {
    outputOracleKind: 'compute_oracle',
    runtimeExpectationHash: hash('compute-output-contract'),
  },
});
const baseComputeArgs = compileArgsFor(computeIntent, computeFiles);

const cold = buildSourceFirstInitialCompileRequest({
  mode: 'cold-ai-split',
  compileArgs: baseComputeArgs,
});
assert.equal(cold.initialCompileArgs.bypass_ai_split_cache, true);
assert.equal(cold.initialCompileArgs.bypass_device_compile_cache, true);
assert.equal(cold.initialCompileArgs.require_ai_provider_call, true);
assert.equal(cold.requestSupport.cacheBypassRequestsIndependent, true);
assert.notEqual(
  cold.requestSupport.aiSplitCacheBypassRequestField,
  cold.requestSupport.deviceCompileCacheBypassRequestField,
);
assert.equal(cold.requestSupport.bypassAiSplitCacheRequested, true);
assert.equal(cold.requestSupport.bypassDeviceCompileCacheRequested, true);
assert.equal(cold.requestSupport.deviceCompileCacheBypassFieldPresent, true);
assert.equal(cold.requestSupport.forcedFreshDeviceCompileRequested, true);
assert.equal(cold.requestSupport.accepted, true);
assert.equal(cold.requestSupport.acceptedAsRequestSupport, true);
assert.equal(cold.requestSupport.acceptedAsFreshDeviceCompileEvidence, false);
assert.equal(cold.requestSupport.deviceCompileFreshnessProven, false);
assert.equal(cold.requestSupport.acceptedForGpuHmr, false);
assert.equal(cold.requestSupport.gpuHmrSuccess, false);
assert.equal(cold.requestSupport.canSatisfyRuntimeProof, false);
assert.equal(cold.requestSupport.canSatisfyDispatchProof, false);
assert.equal(
  cold.requestSupport.requestBinding.sourceManifestHash,
  computeIntent.sourceManifestHash,
);
assert.equal(
  cold.requestSupport.requestBinding.recomputedSourceManifestHash,
  computeIntent.sourceManifestHash,
);
assert.equal(Object.hasOwn(baseComputeArgs, 'bypass_ai_split_cache'), false);
assert.equal(Object.hasOwn(baseComputeArgs, 'bypass_device_compile_cache'), false);

const normal = buildSourceFirstInitialCompileRequest({
  mode: 'validate',
  compileArgs: {
    ...baseComputeArgs,
    bypass_ai_split_cache: true,
    bypass_device_compile_cache: true,
    require_ai_provider_call: true,
  },
});
assert.equal(normal.initialCompileArgs.bypass_ai_split_cache, false);
assert.equal(normal.initialCompileArgs.require_ai_provider_call, false);
assert.equal(Object.hasOwn(normal.initialCompileArgs, 'bypass_device_compile_cache'), false);
assert.equal(normal.requestSupport.bypassDeviceCompileCacheRequested, false);
assert.equal(normal.requestSupport.deviceCompileCacheBypassFieldPresent, false);
assert.equal(normal.requestSupport.forcedFreshDeviceCompileRequested, false);
assert.equal(normal.requestSupport.accepted, true);
assert.equal(normal.requestSupport.acceptedAsFreshDeviceCompileEvidence, false);

const visualSceneHash = hash('typed-visual-scene');
const visualFiles = [source('src/view.cpp', 'int main() { return 0; }\n')];
const visualIntent = deriveSourceFirstRequestIntent({
  entryPath: 'src/view.cpp',
  files: visualFiles,
  typedOracleIntent: {
    outputOracleKind: 'visual_oracle',
    visualIntentDeclared: true,
    visualSceneManifestHash: visualSceneHash,
    visualProofHash: hash('visual-thresholds'),
    deterministicVisualModeHash: hash('deterministic-visual-mode'),
  },
});
const visual = buildSourceFirstInitialCompileRequest({
  mode: 'validate',
  compileArgs: compileArgsFor(visualIntent, visualFiles),
});
assert.equal(visual.initialCompileArgs.is_gui, true);
assert.equal(visual.initialCompileArgs.bypass_ai_split_cache, false);
assert.equal(Object.hasOwn(visual.initialCompileArgs, 'bypass_device_compile_cache'), false);
assert.equal(visual.requestSupport.forcedFreshDeviceCompileRequested, false);
assert.equal(visual.requestSupport.acceptedAsFreshDeviceCompileEvidence, false);

const forgedResult = buildSourceFirstInitialCompileRequest({
  mode: 'cold-ai-split',
  compileArgs: baseComputeArgs,
  observedResult: {
    bypass_ai_split_cache: true,
    bypass_device_compile_cache: 'true',
    acceptedAsFreshDeviceCompileEvidence: true,
    gpuHmrSuccess: true,
    timingMetrics: {
      device_compile_wall_time: 1,
      total_validator_wall_time: 2,
    },
  },
});
assert.equal(forgedResult.requestSupport.acceptedAsRequestSupport, true);
assert.equal(forgedResult.requestSupport.accepted, false);
assert.equal(forgedResult.requestSupport.resultDiagnostics.accepted, false);
assert.equal(forgedResult.requestSupport.resultFieldsAuthoritative, false);
assert.equal(forgedResult.requestSupport.acceptedAsFreshDeviceCompileEvidence, false);
assert.equal(forgedResult.requestSupport.deviceCompileFreshnessProven, false);
assert.equal(forgedResult.requestSupport.acceptedForGpuHmr, false);
assert.equal(forgedResult.requestSupport.gpuHmrSuccess, false);
assert.ok(forgedResult.requestSupport.blockingGaps.includes(
  'source_first_compile_cache_result_bypass_type_invalid',
));
assert.ok(forgedResult.requestSupport.blockingGaps.includes(
  'source_first_compile_cache_result_freshness_claim_not_authoritative',
));
assert.ok(forgedResult.requestSupport.blockingGaps.includes(
  'source_first_compile_cache_result_claimed_gpu_authority',
));

const timedEchoA = buildSourceFirstInitialCompileRequest({
  mode: 'cold-ai-split',
  compileArgs: baseComputeArgs,
  observedResult: {
    bypass_ai_split_cache: true,
    bypass_device_compile_cache: true,
    timingMetrics: {
      device_compile_wall_time: 10,
      total_validator_wall_time: 20,
    },
  },
});
const timedEchoB = buildSourceFirstInitialCompileRequest({
  mode: 'cold-ai-split',
  compileArgs: baseComputeArgs,
  observedResult: {
    bypass_ai_split_cache: true,
    bypass_device_compile_cache: true,
    timingMetrics: {
      device_compile_wall_time: 1000,
      total_validator_wall_time: 2000,
    },
  },
});
assert.equal(timedEchoA.requestSupport.accepted, true);
assert.equal(timedEchoB.requestSupport.accepted, true);
assert.equal(timedEchoA.requestSupport.requestIdentity, cold.requestSupport.requestIdentity);
assert.equal(timedEchoA.requestSupport.requestIdentity, timedEchoB.requestSupport.requestIdentity);
assert.equal(timedEchoA.requestSupport.evidenceHash, timedEchoB.requestSupport.evidenceHash);
assert.equal(timedEchoA.requestSupport.timingFieldsIncludedInRequestIdentity, false);
assert.deepEqual(timedEchoA.initialCompileArgs, timedEchoB.initialCompileArgs);

const changedFiles = computeFiles.map((file) => (
  file.path === 'src/entry.cpp'
    ? { ...file, content: 'int main() { return 1; }\n' }
    : file
));
const staleIntentRequest = buildSourceFirstInitialCompileRequest({
  mode: 'cold-ai-split',
  compileArgs: compileArgsFor(computeIntent, changedFiles),
});
assert.equal(staleIntentRequest.requestSupport.accepted, false);
assert.ok(staleIntentRequest.requestSupport.blockingGaps.includes(
  'source_first_compile_cache_source_manifest_hash_mismatch',
));
assert.notEqual(
  staleIntentRequest.requestSupport.requestIdentity,
  cold.requestSupport.requestIdentity,
);

const changedIntent = deriveSourceFirstRequestIntent({
  entryPath: 'src/entry.cpp',
  files: changedFiles,
  typedOracleIntent: {
    outputOracleKind: 'compute_oracle',
    runtimeExpectationHash: hash('compute-output-contract'),
  },
});
const changedRequest = buildSourceFirstInitialCompileRequest({
  mode: 'cold-ai-split',
  compileArgs: compileArgsFor(changedIntent, changedFiles),
});
assert.equal(changedRequest.requestSupport.accepted, true);
assert.notEqual(changedRequest.requestSupport.requestIdentity, cold.requestSupport.requestIdentity);

console.log('gpu-hmr source-first cold compile cache request self-check passed');
