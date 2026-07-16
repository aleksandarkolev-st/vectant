#!/usr/bin/env node

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  GPU_HMR_TEST_TIMING_PHASE_KEYS,
  GPU_HMR_TEST_TIMING_VISUAL_PHASE_KEYS,
  validateGpuHmrTestTiming,
} from '../lib/gpu-hmr-test-timing-v2.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const validatorPath = path.resolve(
  __dirname,
  '../gpu-hmr-real-rocm-repo-validation.mjs',
);
const marker = 'REAL_ROCM_TIMING_V2_SELF_CHECK ';
const child = spawnSync(
  process.execPath,
  [validatorPath, '--timing-v2-self-check'],
  {
    cwd: path.dirname(validatorPath),
    encoding: 'utf8',
    env: { ...process.env },
    maxBuffer: 2 * 1024 * 1024,
  },
);

assert.equal(
  child.status,
  0,
  `timing self-check failed\nstdout:\n${child.stdout}\nstderr:\n${child.stderr}`,
);
const payloadLine = child.stdout
  .split(/\r?\n/)
  .find((line) => line.startsWith(marker));
assert.ok(payloadLine, `timing self-check payload missing\nstdout:\n${child.stdout}`);
const payload = JSON.parse(payloadLine.slice(marker.length));

const terminalCases = [
  ['visualPass', payload.visualPass, 'pass'],
  ['nonvisualRefusal', payload.nonvisualRefusal, 'refused'],
  ['exception', payload.exception, 'failed'],
  ['signal', payload.signal, 'failed'],
  ['emergency', payload.emergency, 'refused'],
  ['hotOnly', payload.hotOnly, 'refused'],
  ['visualRetry', payload.visualRetry, 'pass'],
  ['persistencePass', payload.persistencePass, 'pass'],
  ['persistenceFailure', payload.persistenceFailure, 'failed'],
];
for (const [caseName, record, outcome] of terminalCases) {
  const validation = validateGpuHmrTestTiming(record);
  assert.equal(validation.valid, true, `${caseName}: ${validation.blockingGaps.join(',')}`);
  assert.equal(record.outcome, outcome, caseName);
  assert.equal(record.authority, 'timing_only', caseName);
  assert.equal(record.timingOnly, true, caseName);
  assert.equal(record.acceptedForGpuHmr, false, caseName);
  assert.equal(record.gpuHmrSuccess, false, caseName);
  assert.deepEqual(Object.keys(record.phases), GPU_HMR_TEST_TIMING_PHASE_KEYS, caseName);
  assert.equal(record.phases.total_wall.state, 'measured', caseName);
}

assert.equal(payload.visualPass.visualCapable, true);
assert.equal(payload.visualPass.phases.cold_intake.durationNs, '5');
assert.equal(payload.visualPass.phases.discovery.durationNs, '7');
assert.equal(payload.visualPass.phases.compile.durationNs, '11');
assert.equal(payload.visualPass.phases.trigger_to_visible.durationNs, '16');
assert.equal(payload.visualPass.phases.screenshot_capture.durationNs, '13');
assert.equal(payload.visualPass.phases.visual_analysis.durationNs, '17');
assert.equal(payload.visualPass.phases.proof_finalization.durationNs, '19');
assert.equal(
  payload.visualPass.phases.trigger_to_visible.endNs,
  payload.visualPass.phases.screenshot_capture.startNs,
);
for (const phaseKey of [
  'split',
  'load',
  'epoch_publication',
  'dispatch',
  'output_ready',
  'retirement',
]) {
  const phase = payload.visualPass.phases[phaseKey];
  assert.equal(phase.state, 'unavailable', phaseKey);
  assert.match(phase.reasonCode, /^real_rocm_/);
  assert.equal(phase.startNs, null);
  assert.equal(phase.endNs, null);
  assert.equal(phase.durationNs, null);
}

assert.equal(payload.nonvisualRefusal.visualCapable, false);
for (const phaseKey of GPU_HMR_TEST_TIMING_VISUAL_PHASE_KEYS) {
  assert.deepEqual(payload.nonvisualRefusal.phases[phaseKey], {
    state: 'not_applicable',
    startNs: null,
    endNs: null,
    durationNs: null,
    reasonCode: 'real_rocm_visual_presentation_contract_not_declared',
  });
}

assert.deepEqual(payload.exception.phases.trigger_to_visible, {
  state: 'unavailable',
  startNs: null,
  endNs: null,
  durationNs: null,
  reasonCode: 'real_rocm_phase_incomplete_at_terminal:trigger_to_visible',
});
assert.deepEqual(payload.exception.phases.compile, {
  state: 'unavailable',
  startNs: null,
  endNs: null,
  durationNs: null,
  reasonCode: 'real_rocm_phase_incomplete_at_terminal:compile',
});
assert.equal(payload.exception.phases.screenshot_capture.state, 'unavailable');
assert.equal(payload.exception.phases.visual_analysis.state, 'unavailable');

assert.equal(payload.signal.phases.discovery.state, 'unavailable');
assert.equal(
  payload.signal.phases.discovery.reasonCode,
  'real_rocm_phase_incomplete_at_terminal:discovery',
);
assert.equal(payload.signal.phases.total_wall.durationNs, '41');
assert.equal(payload.emergency.phases.total_wall.durationNs, '43');
assert.deepEqual(payload.hotOnly.phases.compile, {
  state: 'unavailable',
  startNs: null,
  endNs: null,
  durationNs: null,
  reasonCode: 'real_rocm_cold_device_compile_command_not_observed',
});
assert.deepEqual(payload.visualTimingSelection, {
  causalWaitAccepted: true,
  weakWaitRejected: true,
  rejectedAttemptRecorded: false,
  acceptedAttemptRecorded: true,
  acceptedCaptureStartedNs: payload.visualRetry.phases.screenshot_capture.startNs,
});
assert.equal(payload.visualRetry.phases.screenshot_capture.durationNs, '17');
assert.equal(payload.visualRetry.phases.visual_analysis.durationNs, '19');
assert.ok(
  BigInt(payload.visualRetry.phases.trigger_to_visible.endNs)
    < BigInt(payload.visualRetry.phases.screenshot_capture.startNs),
);
assert.equal(payload.persistencePass.phases.proof_finalization.durationNs, '53');
assert.ok(
  BigInt(payload.persistencePass.phases.total_wall.endNs)
    >= BigInt(payload.persistenceChecks.persistedThroughNs),
);
assert.equal(payload.persistenceFailure.phases.proof_finalization.durationNs, '59');
assert.deepEqual(payload.persistenceChecks, {
  persistedThroughNs: payload.persistenceChecks.persistedThroughNs,
  persistenceFailureObserved: true,
  persistenceFailureOutcome: 'failed',
  persistenceFailureTerminalReason: 'real_rocm_final_result_write_exception',
  persistenceFailureDetailRetained: false,
});

assert.deepEqual(payload.attachment, {
  aliasesShareRecord: true,
  proofIdPreserved: true,
  acceptedForGpuHmrPreserved: true,
  gpuHmrSuccessPreserved: true,
  timingContainsProfileOrProjectName: false,
});
assert.deepEqual(payload.adversarial, {
  authorityForgeryRejected: true,
  regressedIntervalRejected: true,
});

const bootstrapResultsDir = await mkdtemp(
  path.join(os.tmpdir(), 'synthi-real-rocm-timing-bootstrap-'),
);
try {
  const bootstrapFailure = spawnSync(
    process.execPath,
    [validatorPath],
    {
      cwd: path.dirname(validatorPath),
      encoding: 'utf8',
      env: {
        ...process.env,
        SYNTHI_REAL_ROCM_BOOTSTRAP_RESULTS_DIR: bootstrapResultsDir,
        SYNTHI_REAL_ROCM_PROFILE_JSON: '{}',
      },
      maxBuffer: 2 * 1024 * 1024,
    },
  );
  assert.equal(bootstrapFailure.status, 1, bootstrapFailure.stderr);
  const bootstrapArtifact = JSON.parse(await readFile(
    path.join(bootstrapResultsDir, 'real-rocm-results.json'),
    'utf8',
  ));
  const bootstrapValidation = validateGpuHmrTestTiming(bootstrapArtifact.testTiming);
  assert.equal(bootstrapValidation.valid, true, bootstrapValidation.blockingGaps.join(','));
  assert.equal(bootstrapArtifact.resultState, 'real_rocm_bootstrap_configuration_exception');
  assert.equal(bootstrapArtifact.acceptedForGpuHmr, false);
  assert.equal(bootstrapArtifact.gpuHmrSuccess, false);
  assert.equal(bootstrapArtifact.testTiming.outcome, 'failed');
  assert.equal(bootstrapArtifact.testTiming.authority, 'timing_only');
  assert.equal(bootstrapArtifact.testTiming.acceptedForGpuHmr, false);
  assert.equal(bootstrapArtifact.testTiming.gpuHmrSuccess, false);
  for (const phaseKey of GPU_HMR_TEST_TIMING_VISUAL_PHASE_KEYS) {
    assert.equal(bootstrapArtifact.testTiming.phases[phaseKey].state, 'not_applicable');
  }
  assert.equal('error' in bootstrapArtifact, false);
  assert.equal('stack' in bootstrapArtifact, false);
} finally {
  await rm(bootstrapResultsDir, { recursive: true, force: true });
}

console.log('[ok] real ROCm timing v2 terminal-path self-check passed');
