#!/usr/bin/env node

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildSourceFirstInitialCompileRequest,
  deriveSourceFirstRequestIntent,
  resolveSourceFirstFreshAiSplitExecutionPolicy,
} from '../gpu-hmr-agent-split-workspace-test.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const launcherPath = path.resolve(__dirname, '../gpu-hmr-source-first-visual-proof.mjs');

function sha256(value) {
  return `sha256:${createHash('sha256').update(String(value)).digest('hex')}`;
}

function launcherPolicy(extraArgs = [], envOverrides = {}) {
  const env = { ...process.env };
  for (const key of [
    'SYNTHI_GPU_AGENT_FIXTURE',
    'SYNTHI_GPU_AGENT_MODE',
    'SYNTHI_GPU_AGENT_PROFILE_PATH',
    'SYNTHI_GPU_AGENT_REQUIRE_FRESH_AI_SPLIT',
    'SYNTHI_GPU_AGENT_SOURCE_MANIFEST_PATH',
    'SYNTHI_GPU_AGENT_DIRECT_SOURCE_MANIFEST_PATH',
    'SYNTHI_GPU_AGENT_SOURCE_ROOT',
    'SYNTHI_GPU_AGENT_DIRECT_SOURCE_ROOT',
  ]) {
    delete env[key];
  }
  Object.assign(env, envOverrides);
  const child = spawnSync(process.execPath, [
    launcherPath,
    '--profile',
    'projects/cold-ai-split-require-fresh-ai/neural-network-profile.json',
    '--prepare-source-manifest-only',
    ...extraArgs,
  ], {
    cwd: path.resolve(__dirname, '..'),
    env,
    encoding: 'utf8',
    windowsHide: true,
  });
  assert.equal(child.status, 0, child.stderr || child.stdout);
  const jsonStart = child.stdout.indexOf('{');
  assert.notEqual(jsonStart, -1, `launcher did not emit JSON: ${child.stdout}`);
  return JSON.parse(child.stdout.slice(jsonStart)).sourceFirstExecutionPolicy;
}

const sourceFiles = [
  {
    kind: 'source',
    path: 'projects/cold-ai-split-require-fresh-ai/neural_network.cpp',
    content: 'int main() { return 0; }\n',
  },
  {
    kind: 'build',
    path: 'projects/cold-ai-split-require-fresh-ai/CMakeLists.txt',
    content: 'cmake_minimum_required(VERSION 3.24)\n',
  },
];
const intent = deriveSourceFirstRequestIntent({
  entryPath: sourceFiles[0].path,
  files: sourceFiles,
  typedOracleIntent: {
    outputOracleKind: 'compute_oracle',
    runtimeExpectationHash: sha256('generic-output-contract'),
  },
});
const compileArgs = {
  language: intent.language,
  filename: intent.entryPath,
  source: sourceFiles[0].content,
  files: sourceFiles.map((file) => ({
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
  slug: 'ordinary-user-source',
};

const defaultValidate = buildSourceFirstInitialCompileRequest({
  mode: 'validate',
  requireFreshAiSplit: false,
  compileArgs: {
    ...compileArgs,
    bypass_ai_split_cache: true,
    bypass_device_compile_cache: true,
    require_ai_provider_call: true,
  },
});
assert.equal(defaultValidate.requestSupport.accepted, true);
assert.equal(defaultValidate.requestSupport.freshAiSplitRequired, false);
assert.equal(defaultValidate.initialCompileArgs.bypass_ai_split_cache, false);
assert.equal(defaultValidate.initialCompileArgs.require_ai_provider_call, false);
assert.equal(Object.hasOwn(defaultValidate.initialCompileArgs, 'bypass_device_compile_cache'), false);
assert.equal(Object.hasOwn(defaultValidate.initialCompileArgs, 'ai_provider_call_nonce'), false);

const freshValidate = buildSourceFirstInitialCompileRequest({
  mode: 'validate',
  requireFreshAiSplit: true,
  compileArgs,
});
assert.equal(freshValidate.requestSupport.accepted, true);
assert.equal(freshValidate.requestSupport.freshAiSplitRequired, true);
assert.equal(freshValidate.initialCompileArgs.bypass_ai_split_cache, true);
assert.equal(freshValidate.initialCompileArgs.require_ai_provider_call, true);
assert.equal(freshValidate.initialCompileArgs.bypass_device_compile_cache, true);
assert.match(freshValidate.initialCompileArgs.ai_provider_call_nonce, /^provider-call:/);

const missingNonce = { ...compileArgs };
delete missingNonce.ai_provider_call_nonce;
const freshWithoutNonce = buildSourceFirstInitialCompileRequest({
  mode: 'validate',
  requireFreshAiSplit: true,
  compileArgs: missingNonce,
});
assert.equal(freshWithoutNonce.requestSupport.accepted, false);
assert.ok(freshWithoutNonce.requestSupport.blockingGaps.includes(
  'source_first_compile_cache_provider_call_nonce_required',
));

const freshValidatePolicy = resolveSourceFirstFreshAiSplitExecutionPolicy({
  mode: 'validate',
  requireFreshAiSplit: true,
});
assert.equal(freshValidatePolicy.requiresProviderCallEvidence, true);
assert.equal(freshValidatePolicy.requiresFreshDeviceCompileEvidence, true);
assert.equal(freshValidatePolicy.terminalAfterColdSplit, false);
assert.equal(freshValidatePolicy.continuesThroughHotRuntimeProof, true);

const coldOnlyPolicy = resolveSourceFirstFreshAiSplitExecutionPolicy({
  mode: 'cold-ai-split',
  requireFreshAiSplit: true,
});
assert.equal(coldOnlyPolicy.requiresProviderCallEvidence, true);
assert.equal(coldOnlyPolicy.requiresFreshDeviceCompileEvidence, true);
assert.equal(coldOnlyPolicy.terminalAfterColdSplit, true);
assert.equal(coldOnlyPolicy.continuesThroughHotRuntimeProof, false);

const explicitNonFreshColdMode = buildSourceFirstInitialCompileRequest({
  mode: 'cold-ai-split',
  requireFreshAiSplit: false,
  compileArgs,
});
assert.equal(explicitNonFreshColdMode.requestSupport.freshAiSplitRequired, false);
assert.equal(explicitNonFreshColdMode.initialCompileArgs.bypass_ai_split_cache, false);

const defaultLauncher = launcherPolicy();
assert.equal(defaultLauncher.mode, 'validate');
assert.equal(defaultLauncher.requireFreshAiSplit, false);
assert.equal(defaultLauncher.terminalAfterColdSplit, false);

const freshLauncher = launcherPolicy(['--require-fresh-ai-split']);
assert.equal(freshLauncher.mode, 'validate');
assert.equal(freshLauncher.requireFreshAiSplit, true);
assert.equal(freshLauncher.terminalAfterColdSplit, false);

const freshEnvLauncher = launcherPolicy([], {
  SYNTHI_GPU_AGENT_REQUIRE_FRESH_AI_SPLIT: '1',
});
assert.equal(freshEnvLauncher.mode, 'validate');
assert.equal(freshEnvLauncher.requireFreshAiSplit, true);
assert.equal(freshEnvLauncher.terminalAfterColdSplit, false);

const coldOnlyLauncher = launcherPolicy(['--cold-ai-split-only']);
assert.equal(coldOnlyLauncher.mode, 'cold-ai-split');
assert.equal(coldOnlyLauncher.requireFreshAiSplit, true);
assert.equal(coldOnlyLauncher.terminalAfterColdSplit, true);

const legacyColdModeLauncher = launcherPolicy([], {
  SYNTHI_GPU_AGENT_MODE: 'cold-ai-split',
});
assert.equal(legacyColdModeLauncher.mode, 'cold-ai-split');
assert.equal(legacyColdModeLauncher.requireFreshAiSplit, true);
assert.equal(legacyColdModeLauncher.terminalAfterColdSplit, true);

console.log('fresh AI split validate policy self-check passed');
