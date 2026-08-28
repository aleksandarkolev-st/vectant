#!/usr/bin/env node

import assert from 'node:assert/strict';
import { spawnSync, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  deriveSourceFirstRequestIntent,
} from '../gpu-hmr-agent-split-workspace-test.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const mcpRoot = path.resolve(__dirname, '..', '..');
const launcherPath = path.join(mcpRoot, 'scripts', 'gpu-hmr-source-first-visual-proof.mjs');
const generatedManifestPaths = new Set();

function stableJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) =>
    `${JSON.stringify(key)}:${stableJson(value[key])}`
  ).join(',')}}`;
}

function hashJson(value) {
  return `sha256:${createHash('sha256').update(stableJson(value)).digest('hex')}`;
}

function cleanLauncherEnv(overrides = {}) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (
      key.startsWith('SYNTHI_GPU_AGENT_SOURCE_')
      || key.startsWith('SYNTHI_GPU_AGENT_DIRECT_SOURCE_')
      || [
        'SYNTHI_GPU_AGENT_FIXTURE',
        'SYNTHI_GPU_AGENT_PROFILE_PATH',
        'SYNTHI_GPU_AGENT_OUTPUT_ORACLE_KIND',
      ].includes(key)
    ) {
      delete env[key];
    }
  }
  return { ...env, ...overrides };
}

function parsePreparedManifest(stdout) {
  const start = stdout.search(/\{\r?\n\s+"manifestPath"/);
  assert.notEqual(start, -1, `launcher did not emit its prepared manifest JSON:\n${stdout}`);
  const prepared = JSON.parse(stdout.slice(start));
  if (prepared.manifestPath) generatedManifestPaths.add(prepared.manifestPath);
  assert.ok(prepared.manifest, 'launcher did not synthesize a direct-source manifest');
  return prepared.manifest;
}

function runLauncher(baseArgs, extraArgs = [], env = {}) {
  const result = spawnSync(
    process.execPath,
    [launcherPath, ...baseArgs, ...extraArgs, '--prepare-source-manifest-only'],
    {
      cwd: mcpRoot,
      encoding: 'utf8',
      env: cleanLauncherEnv(env),
      windowsHide: true,
    },
  );
  assert.equal(
    result.status,
    0,
    `launcher failed:\nstdout=${result.stdout}\nstderr=${result.stderr}`,
  );
  return parsePreparedManifest(result.stdout);
}

function expectLauncherRefusal(baseArgs, extraArgs, env, expectedText) {
  const result = spawnSync(
    process.execPath,
    [launcherPath, ...baseArgs, ...extraArgs, '--prepare-source-manifest-only'],
    {
      cwd: mcpRoot,
      encoding: 'utf8',
      env: cleanLauncherEnv(env),
      windowsHide: true,
    },
  );
  assert.notEqual(result.status, 0, 'launcher unexpectedly accepted an invalid oracle request');
  assert.match(`${result.stdout}\n${result.stderr}`, expectedText);
}

function requestIntentFiles(manifest) {
  return manifest.files.map((entry) => ({
    kind: entry.kind,
    path: entry.path,
    content: entry.inline ?? entry.content,
    contentHash: entry.contentHash,
    byteLength: entry.byteLength,
  }));
}

function assertSupportOnly(request) {
  assert.equal(request.accepted, false);
  assert.equal(request.acceptedAsRequestIntent, true);
  assert.equal(request.acceptedForGpuHmr, false);
  assert.equal(request.gpuHmrSuccess, false);
  assert.equal(request.canSatisfyRuntimeProof, false);
  assert.equal(request.canSatisfyDispatchProof, false);
  assert.equal(request.canSatisfyOutputOracleProof, false);
  assert.equal(
    request.proofAuthority,
    'direct_source_output_oracle_request_only_not_gpu_hmr_success',
  );
}

const tmpRoot = mkdtempSync(path.join(os.tmpdir(), 'visual-diamond-neural-profile-fixture-'));
try {
  mkdirSync(path.join(tmpRoot, 'src'), { recursive: true });
  writeFileSync(
    path.join(tmpRoot, 'src', 'visual-diamond-neural-render.cpp'),
    '#include "model_state.h"\nint main() { return model_width; }\n',
  );
  writeFileSync(
    path.join(tmpRoot, 'src', 'model_state.h'),
    '#pragma once\nconstexpr int model_width = 64;\n',
  );
  writeFileSync(
    path.join(tmpRoot, 'CMakeLists.txt'),
    'cmake_minimum_required(VERSION 3.24)\nproject(visual_diamond_neural_fixture)\n',
  );
  for (const gitArgs of [
    ['init'],
    ['config', 'user.email', 'gpu-hmr-oracle-request@example.invalid'],
    ['config', 'user.name', 'GPU HMR Oracle Request Self Check'],
    ['config', 'core.autocrlf', 'false'],
    ['add', '.'],
    ['commit', '-m', 'ordinary direct source input'],
  ]) {
    execFileSync('git', ['-C', tmpRoot, ...gitArgs], {
      windowsHide: true,
      stdio: ['ignore', 'ignore', 'pipe'],
    });
  }
  const commit = String(execFileSync('git', ['-C', tmpRoot, 'rev-parse', 'HEAD'], {
    encoding: 'utf8',
    windowsHide: true,
  })).trim();
  const baseArgs = [
    '--source-root',
    tmpRoot,
    '--source-commit',
    commit,
    '--source-entry',
    'src/visual-diamond-neural-render.cpp',
    '--source-file',
    'src/visual-diamond-neural-render.cpp',
    '--source-file',
    'src/model_state.h',
    '--build-file',
    'CMakeLists.txt',
  ];

  const visualSceneManifest = {
    schemaVersion: 'synthi.gpu_hmr.visual_scene_manifest.v1',
    renderer: { backendClass: 'runtime_discovered' },
    capture: { deterministic: true },
  };
  const visualSceneManifestHash = hashJson(visualSceneManifest);
  const visualProfilePath = path.join(tmpRoot, 'hiprt-diamond-visual-profile.json');
  writeFileSync(visualProfilePath, `${JSON.stringify({
    profileId: 'visual-diamond-neural-profile',
    visualSceneManifest,
    visualSceneManifestHash,
  }, null, 2)}\n`);

  const namesOnlyManifest = runLauncher(
    baseArgs,
    ['--profile', visualProfilePath],
    { SYNTHI_GPU_AGENT_FIXTURE: 'visual-diamond-hiprt-flow-fixture' },
  );
  assert.equal(namesOnlyManifest.outputOracleKind, null);
  assert.equal(namesOnlyManifest.outputOracleRequest, null);
  assert.equal(namesOnlyManifest.visualSceneManifestHash, null);
  assert.ok(
    namesOnlyManifest.runtimeContractExpectation.blockingGaps
      .includes('direct_source_runtime_contract_output_oracle_missing'),
  );
  const namesOnlyIntent = deriveSourceFirstRequestIntent({
    entryPath: namesOnlyManifest.entryPath,
    files: requestIntentFiles(namesOnlyManifest),
    declaredSourceManifestHash: namesOnlyManifest.manifestHash,
  });
  assert.equal(namesOnlyIntent.oracleIntent, 'non_visual_unspecified');
  assert.equal(namesOnlyIntent.isGui, false);

  const computeManifest = runLauncher(
    baseArgs,
    ['--output-oracle-kind', 'compute_oracle'],
  );
  assert.equal(computeManifest.outputOracleKind, 'compute_oracle');
  assert.equal(
    computeManifest.runtimeContractExpectation.outputOracleKind,
    'compute_oracle',
  );
  assert.deepEqual(
    computeManifest.source.outputOracle,
    computeManifest.outputOracleRequest,
  );
  assertSupportOnly(computeManifest.outputOracleRequest);
  assert.ok(computeManifest.outputOracleRequest.requiredProofKinds.includes('raw_readback_bytes'));
  assert.ok(computeManifest.outputOracleRequest.requiredProofKinds.includes('readback_schema'));
  assert.ok(computeManifest.outputOracleRequest.requiredProofKinds.includes('before_after_checksums'));
  assert.ok(computeManifest.outputOracleRequest.requiredProofKinds.includes('dispatch_trace'));
  assert.ok(computeManifest.outputOracleRequest.requiredProofKinds.includes('epoch_publication'));
  assert.ok(
    !computeManifest.runtimeContractExpectation.blockingGaps
      .includes('direct_source_runtime_contract_output_oracle_missing'),
  );
  const computeIntent = deriveSourceFirstRequestIntent({
    entryPath: computeManifest.entryPath,
    files: requestIntentFiles(computeManifest),
    declaredSourceManifestHash: computeManifest.manifestHash,
    typedOracleIntent: {
      ...computeManifest.outputOracleRequest,
      runtimeExpectationHash: hashJson(computeManifest.runtimeContractExpectation),
    },
  });
  assert.equal(computeIntent.oracleIntent, 'compute_oracle');
  assert.equal(computeIntent.isGui, false);

  const computeEnvManifest = runLauncher(
    baseArgs,
    [],
    { SYNTHI_GPU_AGENT_OUTPUT_ORACLE_KIND: 'compute_oracle' },
  );
  assert.equal(computeEnvManifest.outputOracleKind, 'compute_oracle');
  assert.ok(
    computeEnvManifest.directSourceInputChannels
      .includes('env:SYNTHI_GPU_AGENT_OUTPUT_ORACLE_KIND'),
  );

  const visualManifest = runLauncher(
    baseArgs,
    [
      '--profile',
      visualProfilePath,
      '--output-oracle-kind',
      'visual_oracle',
    ],
  );
  assert.equal(visualManifest.outputOracleKind, 'visual_oracle');
  assert.equal(visualManifest.visualSceneManifestHash, visualSceneManifestHash);
  assert.deepEqual(visualManifest.visualSceneManifest, visualSceneManifest);
  assertSupportOnly(visualManifest.outputOracleRequest);
  assert.ok(
    visualManifest.outputOracleRequest.requiredProofKinds
      .includes('content_addressed_before_after_diff_images'),
  );
  assert.ok(
    visualManifest.outputOracleRequest.requiredProofKinds
      .includes('post_dispatch_frame_gate'),
  );
  const visualIntent = deriveSourceFirstRequestIntent({
    entryPath: visualManifest.entryPath,
    files: requestIntentFiles(visualManifest),
    declaredSourceManifestHash: visualManifest.manifestHash,
    typedOracleIntent: {
      ...visualManifest.outputOracleRequest,
      visualSceneManifestHash: visualManifest.visualSceneManifestHash,
      runtimeExpectationHash: hashJson(visualManifest.runtimeContractExpectation),
    },
  });
  assert.equal(visualIntent.oracleIntent, 'visual_oracle');
  assert.equal(visualIntent.isGui, true);
  assert.equal(visualIntent.uiMode, 'typed_visual_oracle');

  expectLauncherRefusal(
    baseArgs,
    ['--output-oracle-kind', 'visual_oracle'],
    {},
    /requires a profile with content-addressed visual evidence/,
  );
  expectLauncherRefusal(
    baseArgs,
    ['--output-oracle-kind', 'screenshot_oracle'],
    {},
    /must be one of compute_oracle, visual_oracle/,
  );
  expectLauncherRefusal(
    baseArgs,
    [],
    { SYNTHI_GPU_AGENT_OUTPUT_ORACLE_KIND: 'profile_name_inference' },
    /must be one of compute_oracle, visual_oracle/,
  );
  expectLauncherRefusal(
    baseArgs,
    ['--output-oracle-kind', 'compute_oracle'],
    { SYNTHI_GPU_AGENT_OUTPUT_ORACLE_KIND: 'visual_oracle' },
    /conflicts with SYNTHI_GPU_AGENT_OUTPUT_ORACLE_KIND/,
  );

  const forgedAuthorityProfilePath = path.join(tmpRoot, 'forged-authority-profile.json');
  writeFileSync(forgedAuthorityProfilePath, `${JSON.stringify({
    profileId: 'forged-authority-profile',
    gpuHmrSuccess: true,
    visualSceneManifest,
    visualSceneManifestHash,
  }, null, 2)}\n`);
  expectLauncherRefusal(
    baseArgs,
    [
      '--profile',
      forgedAuthorityProfilePath,
      '--output-oracle-kind',
      'visual_oracle',
    ],
    {},
    /cannot claim GPU HMR or runtime proof authority/,
  );

  const mismatchedHashProfilePath = path.join(tmpRoot, 'mismatched-hash-profile.json');
  writeFileSync(mismatchedHashProfilePath, `${JSON.stringify({
    profileId: 'mismatched-hash-profile',
    visualSceneManifest,
    visualSceneManifestHash: hashJson({ stale: true }),
  }, null, 2)}\n`);
  expectLauncherRefusal(
    baseArgs,
    [
      '--profile',
      mismatchedHashProfilePath,
      '--output-oracle-kind',
      'visual_oracle',
    ],
    {},
    /visual oracle scene manifest hash mismatch/,
  );

  console.log('gpu-hmr direct-source output-oracle request self-check passed');
} finally {
  for (const manifestPath of generatedManifestPaths) {
    try {
      unlinkSync(manifestPath);
    } catch {
      // Generated manifests are support artifacts; absence during cleanup is harmless.
    }
  }
  rmSync(tmpRoot, { recursive: true, force: true });
}
