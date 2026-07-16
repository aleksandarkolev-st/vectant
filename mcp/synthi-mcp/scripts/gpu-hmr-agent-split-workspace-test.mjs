#!/usr/bin/env node
// Synthi agent-split source-first GPU-HMR validation:
//   profile/fixture seed source -> agent GPU split -> generated device edit -> GPU HMR.
//
// This differs from gpu-hmr-dynamic-workspace-test.mjs, which starts from an
// already-adapted project. Here the seeded source intentionally contains no
// Synthi ABI exports such as core_on_update/device_on_load.
//
// Run:
//   cd mcp/synthi-mcp
//   SYNTHI_GPU_HMR=1 SYNTHI_GPU_VENDOR=auto node scripts/gpu-hmr-agent-split-workspace-test.mjs

import { spawn, execFile, execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { createValidationWorkspace } from './lib/validation-workspace.mjs';
import {
  completeAsyncVisualProofJob,
  createAsyncVisualProofJob,
  deterministicVisualModeFromMcpEvidence,
  evaluateGpuHmrDeterministicVisualMode,
  mcpFrameAtOrAfterFrameGate,
  mcpFrameGateSatisfiedByScreenshot,
  mcpScreenshotArgsForFrameGate,
  mcpScreenshotMetadataFromToolResult,
  visualArtifactTransportEvidence,
} from './lib/gpu-hmr-visual-evidence.mjs';
import {
  writeArtifactToCas,
} from './lib/gpu-hmr-artifact-cas.mjs';
import {
  assessGeneratedGpuSplitGranularity,
  assertNoGeneratedSplitFissionOverclaim,
  verifyGeneratedGpuSplitDeterministicFission,
  GPU_HMR_GENERATED_SPLIT_DETERMINISTIC_FISSION_EVIDENCE_SCHEMA_VERSION,
} from './lib/gpu-hmr-generated-split-granularity.mjs';
import {
  bindGpuHmrRunModeCoverageSupport,
  buildGpuHmrRunModeCoverageSupport,
  queryGpuHmrLedgerInvariants,
} from './lib/gpu-hmr-proof-ledger.mjs';
import {
  visualEvidenceArtifactsFromVisualOracleArtifacts,
} from './lib/gpu-hmr-validation-proof-artifact.mjs';
import {
  materializeDirectSourceGitSnapshot,
  verifyDirectSourceGitIdentity,
} from './lib/gpu-hmr-direct-source-git-identity.mjs';
import {
  GPU_HMR_TEST_TIMING_PHASE_KEYS,
  GPU_HMR_TEST_TIMING_SCHEMA,
  GpuHmrTestTimingRecorder,
  assertValidGpuHmrTestTiming,
  isStableGpuHmrTimingReasonCode,
} from './lib/gpu-hmr-test-timing-v2.mjs';

let stdioPipeClosed = false;

function isStdioEpipe(err) {
  return err?.code === 'EPIPE' || /\bEPIPE\b/i.test(String(err?.message ?? err ?? ''));
}

function installStdioEpipeGuard() {
  const onStreamError = (err) => {
    if (isStdioEpipe(err)) {
      stdioPipeClosed = true;
      return;
    }
    process.nextTick(() => {
      throw err;
    });
  };
  process.stdout.on('error', onStreamError);
  process.stderr.on('error', onStreamError);

  const originalLog = console.log.bind(console);
  const originalError = console.error.bind(console);
  console.log = (...args) => {
    if (stdioPipeClosed) return;
    try {
      originalLog(...args);
    } catch (err) {
      if (isStdioEpipe(err)) {
        stdioPipeClosed = true;
        return;
      }
      throw err;
    }
  };
  console.error = (...args) => {
    if (stdioPipeClosed) return;
    try {
      originalError(...args);
    } catch (err) {
      if (isStdioEpipe(err)) {
        stdioPipeClosed = true;
        return;
      }
      throw err;
    }
  };
}

installStdioEpipeGuard();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const CFG = {
  frontendUrl: process.env.FRONTEND_URL ?? 'http://localhost:3000',
  collabUrl: process.env.COLLAB_URL ?? 'http://localhost:1234',
  signalingUrl: process.env.SIGNALING_URL ?? process.env.SYNTHI_SIGNALING_URL ?? null,
  slug: process.env.SLUG ?? `gpu-agent-split-${Date.now()}`,
  hostId: process.env.HOST_ID ?? 'gpu-hmr-agent-split-test',
  vendor: (process.env.SYNTHI_GPU_VENDOR ?? 'auto').toLowerCase(),
  gpuArch: process.env.SYNTHI_GPU_ARCH,
  gpuArchSource: process.env.SYNTHI_GPU_ARCH ? 'env:SYNTHI_GPU_ARCH' : null,
  hmrTimeoutMs: Number(process.env.HMR_TIMEOUT_MS ?? 180000),
  hotSwapTimeoutMs: Number(process.env.SYNTHI_GPU_WAIT_HMR_TIMEOUT_MS ?? 15000),
  httpTimeoutMs: Number(
    process.env.SYNTHI_GPU_AGENT_HTTP_TIMEOUT_MS
      ?? process.env.SYNTHI_GPU_HMR_HTTP_TIMEOUT_MS
      ?? 30000,
  ),
  strictProofRetryEnabled: process.env.SYNTHI_GPU_HMR_STRICT_PROOF_RETRY !== '0',
  strictProofRetryTimeoutMs: Number(process.env.SYNTHI_GPU_HMR_STRICT_PROOF_RETRY_TIMEOUT_MS ?? 45000),
  strictProofRetryDelayMs: Number(process.env.SYNTHI_GPU_HMR_STRICT_PROOF_RETRY_DELAY_MS ?? 250),
  mcpTransport: (process.env.MCP_TRANSPORT ?? 'local').toLowerCase(),
  mcpContainer: process.env.MCP_CONTAINER ?? process.env.SYNTHI_MCP_CONTAINER ?? null,
  mcpContainerEntry: process.env.MCP_CONTAINER_ENTRY ?? process.env.SYNTHI_MCP_CONTAINER_ENTRY ?? null,
  mcpEntry: path.resolve(__dirname, process.env.MCP_ENTRY ?? '../dist/index.js'),
  mcpSignalingUrl: process.env.MCP_SIGNALING_URL ?? process.env.SYNTHI_MCP_SIGNALING_URL ?? null,
  mcpRequestTimeoutMs: Number(process.env.MCP_REQUEST_TIMEOUT_MS ?? 240000),
  mcpAttachTimeoutMs: Number(process.env.MCP_ATTACH_TIMEOUT_MS ?? 30000),
  frameGateTimeoutMs: Number(process.env.SYNTHI_GPU_AGENT_FRAME_GATE_TIMEOUT_MS ?? 1200000),
  workerContainer: process.env.WORKER_CONTAINER ?? process.env.SYNTHI_WORKER_CONTAINER ?? null,
  workerLogPath: process.env.WORKER_LOG_PATH
    ?? path.resolve(__dirname, '../../../backend/synthi-webrtc-compiler/.run/worker.log'),
  workerLogTailTimeoutMs: boundedPositiveInt(
    process.env.SYNTHI_GPU_AGENT_WORKER_LOG_TAIL_TIMEOUT_MS
      ?? process.env.SYNTHI_GPU_HMR_WORKER_LOG_TAIL_TIMEOUT_MS,
    10000,
    { min: 1000, max: 120000 },
  ),
  googleApiKey: process.env.GOOGLE_API_KEY ?? process.env.GEMINI_API_KEY ?? '',
  mcpVisionBackend: process.env.SYNTHI_MCP_VISION_BACKEND
    ?? ((process.env.GOOGLE_API_KEY ?? process.env.GEMINI_API_KEY) ? 'gemini_api' : 'agent_side'),
  geminiModel: process.env.SYNTHI_GEMINI_MODEL ?? process.env.SYNTHI_GPU_SPLIT_MODEL ?? 'gemini-3.5-flash',
  gpuSplitProvider: (
    process.env.SYNTHI_SPLIT_PROVIDER
      ?? process.env.SYNTHI_GPU_SPLIT_PROVIDER
      ?? 'gemini'
  ).trim().toLowerCase(),
  gpuSplitModel: process.env.SYNTHI_GPU_SPLIT_MODEL
    ?? process.env.SYNTHI_SPLIT_MODEL
    ?? process.env.SYNTHI_GEMINI_MODEL
    ?? 'gemini-3.5-flash',
  gpuDeltaModel: process.env.SYNTHI_GPU_DELTA_MODEL
    ?? process.env.SYNTHI_GEMINI_DELTA_MODEL
    ?? 'gemini-3.1-flash-lite',
  profilePath: process.env.SYNTHI_GPU_AGENT_PROFILE_PATH ?? '',
  directSourceManifestPath: process.env.SYNTHI_GPU_AGENT_SOURCE_MANIFEST_PATH
    ?? process.env.SYNTHI_GPU_AGENT_DIRECT_SOURCE_MANIFEST_PATH
    ?? '',
  directSourceRoot: process.env.SYNTHI_GPU_AGENT_SOURCE_ROOT
    ?? process.env.SYNTHI_GPU_AGENT_DIRECT_SOURCE_ROOT
    ?? '',
  directSourceAuthority: process.env.SYNTHI_GPU_AGENT_SOURCE_AUTHORITY
    ?? process.env.SYNTHI_GPU_AGENT_DIRECT_SOURCE_AUTHORITY
    ?? '',
  fixture: (process.env.SYNTHI_GPU_AGENT_FIXTURE ?? '').toLowerCase(),
  allowPackagedDefaultFixture: process.env.SYNTHI_GPU_AGENT_ALLOW_PACKAGED_DEFAULT_FIXTURE === '1',
  mode: (process.env.SYNTHI_GPU_AGENT_MODE ?? 'validate').toLowerCase(),
  captureArtifacts: process.env.SYNTHI_GPU_AGENT_CAPTURE_ARTIFACTS === '1',
  visualDeltaWindowMs: Number(process.env.SYNTHI_GPU_AGENT_VISUAL_DELTA_WINDOW_MS ?? 6000),
  visualDeltaSampleIntervalMs: Number(process.env.SYNTHI_GPU_AGENT_VISUAL_DELTA_SAMPLE_INTERVAL_MS ?? 500),
  visualDeltaMinSamples: Number(process.env.SYNTHI_GPU_AGENT_VISUAL_DELTA_MIN_SAMPLES ?? 8),
  visualWorkerParallelism: boundedPositiveInt(
    process.env.SYNTHI_GPU_HMR_VISUAL_WORKER_PARALLELISM
      ?? process.env.SYNTHI_GPU_AGENT_VISUAL_WORKER_PARALLELISM,
    4,
    { min: 1, max: 16 },
  ),
  syncToGcs: process.env.SYNTHI_SYNC_TO_GCS !== '0',
};

const AGENT_VISUAL_PROFILE_SCHEMA_VERSION = 'synthi.gpu_hmr.agent_split_visual_profile.v1';
const VISUAL_SEMANTIC_PROBE_SCHEMA_VERSION =
  'synthi.gpu_hmr.visual_semantic_probe_binding.v1';
const VISUAL_SEMANTIC_PROBE_AUTHORITY =
  'semantic_visual_probe_binding_only_not_gpu_hmr_success';
let ACTIVE_AGENT_PROFILE = null;

const LOG_DIR = path.resolve(__dirname, '../.gpu-hmr-test-logs');
const RESULTS_BASENAME = CFG.mode === 'seed-only'
  ? 'agent-split-seed-results'
  : CFG.mode === 'cold-ai-split'
    ? 'agent-split-cold-ai-results'
    : 'agent-split-results';
const RESULTS_JSON = path.join(LOG_DIR, `${RESULTS_BASENAME}.json`);
const RESULTS_TXT = path.join(LOG_DIR, `${RESULTS_BASENAME}.txt`);
const TEST_TIMING_JSON = path.join(LOG_DIR, `${RESULTS_BASENAME}-timing-v2.json`);
const ARTIFACT_DIR = path.join(
  LOG_DIR,
  'agent-split-artifacts',
  CFG.slug.replace(/[^a-zA-Z0-9_.-]+/g, '-'),
);
const EXPOSED_SPLIT_DIR = cleanVisibleWorkspaceDir(
  process.env.SYNTHI_GPU_EXPOSED_SPLIT_DIR ?? 'gpu_hmr_demo',
);

const results = [];
const REDACTED_SECRET = '[REDACTED_SECRET]';
const COMPILE_TERMINAL_DIAGNOSTIC_SCHEMA_VERSION =
  'synthi.gpu_hmr.compile_terminal_diagnostic.v1';
const COMPILE_TERMINAL_DIAGNOSTIC_MAX_CHARS = 4000;
const AGENT_SPLIT_TIMING_ERROR = Symbol('agent_split_timing_error');
const TEST_TIMING_VISUAL_NOT_OBSERVED_REASON = 'visual_capture_contract_not_observed';
const TEST_TIMING_VISUAL_CAPTURE_REASON = 'visual_screenshot_capture_not_observed';
const TEST_TIMING_VISUAL_ANALYSIS_REASON = 'visual_analysis_not_observed';
const TEST_TIMING_TRIGGER_REASON = 'first_post_epoch_visible_frame_not_observed';
const TEST_TIMING_TRIGGER_START_REASON = 'post_edit_trigger_boundary_not_observed';
const TEST_TIMING_LOAD_REASON = 'load_boundary_not_observed_in_validator_clock';
const TEST_TIMING_EPOCH_REASON = 'epoch_publication_boundary_not_observed_in_validator_clock';
const TEST_TIMING_DISPATCH_REASON = 'dispatch_boundary_not_observed_in_validator_clock';
const TEST_TIMING_OUTPUT_REASON = 'output_ready_signal_not_observed';
const TEST_TIMING_SPLIT_REASON = 'split_boundary_not_observed_in_validator_clock';
const TEST_TIMING_COMPILE_REASON = 'compile_boundary_not_observed_in_validator_clock';
const TEST_TIMING_RETIREMENT_REASON =
  'runtime_retirement_boundary_not_observed_in_validator_clock';
const TEST_TIMING_SUCCESS_GAP_REASON = 'phase_not_observed_before_success';
const TEST_TIMING_SEED_ONLY_REASON = 'seed_only_terminal_path';
const TEST_TIMING_EMERGENCY_RETIREMENT_REASON = 'emergency_retirement_not_observed';
const TEST_TIMING_PHASE_SET = new Set(GPU_HMR_TEST_TIMING_PHASE_KEYS);
let activeAgentSplitTestTiming = null;
let retainedAgentSplitTestTiming = null;
let retainedAgentSplitTimingTerminal = null;
let writingResultCheckpoint = false;

function timingBoundaryNs() {
  return activeAgentSplitTestTiming?.readBoundary() ?? process.hrtime.bigint();
}

function normalizeTimingBoundary(value) {
  if (typeof value !== 'bigint' || value < 0n) {
    throw new TypeError('agent split timing boundary must be a non-negative bigint');
  }
  return value;
}

function requireAgentSplitTimingPhase(phaseKey) {
  if (!TEST_TIMING_PHASE_SET.has(phaseKey) || phaseKey === 'total_wall') {
    throw new TypeError(`invalid agent split timing phase: ${phaseKey}`);
  }
  return phaseKey;
}

function requireAgentSplitTimingReason(reasonCode) {
  if (!isStableGpuHmrTimingReasonCode(reasonCode)) {
    throw new TypeError(`invalid agent split timing reason code: ${reasonCode}`);
  }
  return reasonCode;
}

export function observedMcpVisualCaptureContract(toolResult) {
  const content = Array.isArray(toolResult?.content) ? toolResult.content : [];
  const image = content.find((block) => (
    block?.type === 'image' && typeof block.data === 'string' && block.data.length > 0
  ));
  if (!image) {
    return Object.freeze({ observed: false, reasonCode: 'visual_capture_image_block_missing' });
  }
  const metadata = mcpScreenshotMetadataFromToolResult(toolResult);
  if (!metadata || typeof metadata !== 'object') {
    return Object.freeze({ observed: false, reasonCode: 'visual_capture_metadata_missing' });
  }
  const width = Number(metadata.w ?? metadata.width ?? 0);
  const height = Number(metadata.h ?? metadata.height ?? 0);
  if (!(width > 0 && height > 0)) {
    return Object.freeze({ observed: false, reasonCode: 'visual_capture_dimensions_missing' });
  }
  return Object.freeze({
    observed: true,
    reasonCode: null,
    width,
    height,
    hasFrameSequence: Number.isFinite(Number(metadata.seq ?? metadata.frame_seq)),
    hasCaptureManifest: Boolean(metadata.capture_manifest ?? metadata.captureManifest),
  });
}

export class AgentSplitTestTimingV2Lifecycle {
  #nowNs;
  #lastObservedNs;
  #totalStartNs;
  #windows;
  #reasoned;
  #active;
  #pendingTriggerStartNs;
  #captureContractObserved;
  #runtimeWaitObserved;
  #record;

  constructor(options = {}) {
    const nowNs = options.nowNs ?? options.clock ?? (() => process.hrtime.bigint());
    if (typeof nowNs !== 'function') {
      throw new TypeError('agent split timing clock must be a function');
    }
    this.#nowNs = nowNs;
    this.#lastObservedNs = null;
    this.#totalStartNs = this.readBoundary();
    this.#windows = new Map();
    this.#reasoned = new Map();
    this.#active = new Map();
    this.#pendingTriggerStartNs = null;
    this.#captureContractObserved = false;
    this.#runtimeWaitObserved = false;
    this.#record = null;
  }

  get isFinalized() {
    return this.#record !== null;
  }

  get record() {
    return this.#record;
  }

  get visualCapable() {
    return this.#captureContractObserved;
  }

  readBoundary() {
    const value = normalizeTimingBoundary(this.#nowNs());
    if (this.#lastObservedNs !== null && value < this.#lastObservedNs) {
      throw new Error('agent_split_timing_clock_regressed');
    }
    this.#lastObservedNs = value;
    return value;
  }

  beginPhase(phaseKey) {
    requireAgentSplitTimingPhase(phaseKey);
    if (this.isFinalized || this.#windows.has(phaseKey) || this.#reasoned.has(phaseKey)) {
      return null;
    }
    if (this.#active.has(phaseKey)) return this.#active.get(phaseKey);
    const token = Object.freeze({ phaseKey, startNs: this.readBoundary() });
    this.#active.set(phaseKey, token);
    return token;
  }

  finishPhase(phaseKey, endNs = this.readBoundary()) {
    requireAgentSplitTimingPhase(phaseKey);
    const token = this.#active.get(phaseKey);
    if (!token) return false;
    this.#active.delete(phaseKey);
    return this.recordWindow(phaseKey, token.startNs, endNs);
  }

  async measurePhase(phaseKey, operation) {
    this.beginPhase(phaseKey);
    try {
      return await operation();
    } finally {
      this.finishPhase(phaseKey);
    }
  }

  recordWindow(phaseKey, startNs, endNs, { replace = false } = {}) {
    requireAgentSplitTimingPhase(phaseKey);
    const normalizedStart = normalizeTimingBoundary(startNs);
    const normalizedEnd = normalizeTimingBoundary(endNs);
    if (normalizedStart < this.#totalStartNs || normalizedEnd < normalizedStart) {
      throw new Error(`agent_split_timing_window_invalid:${phaseKey}`);
    }
    if (this.isFinalized) return false;
    if (replace) {
      this.#windows.delete(phaseKey);
      this.#reasoned.delete(phaseKey);
      this.#active.delete(phaseKey);
    }
    if (this.#windows.has(phaseKey) || this.#reasoned.has(phaseKey)) {
      return false;
    }
    this.#active.delete(phaseKey);
    this.#windows.set(phaseKey, Object.freeze({
      startNs: normalizedStart,
      endNs: normalizedEnd,
    }));
    return true;
  }

  markUnavailable(phaseKey, reasonCode) {
    requireAgentSplitTimingPhase(phaseKey);
    requireAgentSplitTimingReason(reasonCode);
    if (this.isFinalized || this.#windows.has(phaseKey) || this.#reasoned.has(phaseKey)) {
      return false;
    }
    this.#active.delete(phaseKey);
    this.#reasoned.set(phaseKey, Object.freeze({ state: 'unavailable', reasonCode }));
    return true;
  }

  markNotApplicable(phaseKey, reasonCode) {
    requireAgentSplitTimingPhase(phaseKey);
    requireAgentSplitTimingReason(reasonCode);
    if (this.isFinalized || this.#windows.has(phaseKey) || this.#reasoned.has(phaseKey)) {
      return false;
    }
    this.#active.delete(phaseKey);
    this.#reasoned.set(phaseKey, Object.freeze({ state: 'not_applicable', reasonCode }));
    return true;
  }

  closeActivePhases(endNs = this.readBoundary()) {
    for (const phaseKey of [...this.#active.keys()]) {
      this.finishPhase(phaseKey, endNs);
    }
  }

  observeEditTrigger(startNs) {
    const boundary = normalizeTimingBoundary(startNs);
    if (boundary < this.#totalStartNs || this.#windows.has('trigger_to_visible')) return false;
    this.#pendingTriggerStartNs = boundary;
    return true;
  }

  observePostEditVisibleOrOutputReadySignal(signalNs) {
    if (this.#pendingTriggerStartNs === null || this.#windows.has('trigger_to_visible')) {
      return false;
    }
    const boundary = normalizeTimingBoundary(signalNs);
    if (boundary < this.#pendingTriggerStartNs) {
      this.markUnavailable('trigger_to_visible', TEST_TIMING_TRIGGER_REASON);
      return false;
    }
    return this.recordWindow(
      'trigger_to_visible',
      this.#pendingTriggerStartNs,
      boundary,
    );
  }

  observeOpaqueCompileRequest() {
    this.markUnavailable('split', TEST_TIMING_SPLIT_REASON);
    this.markUnavailable('compile', TEST_TIMING_COMPILE_REASON);
  }

  observeRuntimeWait() {
    this.#runtimeWaitObserved = true;
    this.markUnavailable('load', TEST_TIMING_LOAD_REASON);
    this.markUnavailable('epoch_publication', TEST_TIMING_EPOCH_REASON);
    this.markUnavailable('dispatch', TEST_TIMING_DISPATCH_REASON);
    this.markUnavailable('output_ready', TEST_TIMING_OUTPUT_REASON);
  }

  observeCaptureContract(contract, captureStartNs, captureEndNs) {
    if (contract?.observed !== true) return false;
    this.#captureContractObserved = true;
    this.recordWindow('screenshot_capture', captureStartNs, captureEndNs);
    return true;
  }

  observeVisualCapture({
    contract,
    captureStartNs,
    captureEndNs,
    analysisStartNs,
    analysisEndNs,
  }) {
    if (!this.observeCaptureContract(contract, captureStartNs, captureEndNs)) return false;
    this.recordWindow('visual_analysis', analysisStartNs, analysisEndNs);
    return true;
  }

  markSeedOnlyTerminalPath() {
    for (const phaseKey of [
      'split',
      'compile',
      'load',
      'epoch_publication',
      'dispatch',
      'output_ready',
    ]) {
      this.markNotApplicable(phaseKey, TEST_TIMING_SEED_ONLY_REASON);
    }
  }

  finalize({ outcome, terminalReason = null } = {}) {
    if (this.#record) return this.#record;
    const finalReason = terminalReason ?? (
      outcome === 'pass' ? TEST_TIMING_SUCCESS_GAP_REASON : 'agent_split_runtime_failure'
    );
    requireAgentSplitTimingReason(finalReason);
    this.closeActivePhases();

    if (this.#captureContractObserved) {
      if (!this.#windows.has('trigger_to_visible') && !this.#reasoned.has('trigger_to_visible')) {
        this.markUnavailable(
          'trigger_to_visible',
          this.#pendingTriggerStartNs === null
            ? TEST_TIMING_TRIGGER_START_REASON
            : TEST_TIMING_TRIGGER_REASON,
        );
      }
      if (!this.#windows.has('screenshot_capture') && !this.#reasoned.has('screenshot_capture')) {
        this.markUnavailable('screenshot_capture', TEST_TIMING_VISUAL_CAPTURE_REASON);
      }
      if (!this.#windows.has('visual_analysis') && !this.#reasoned.has('visual_analysis')) {
        this.markUnavailable('visual_analysis', TEST_TIMING_VISUAL_ANALYSIS_REASON);
      }
    }
    if (this.#runtimeWaitObserved) {
      this.observeRuntimeWait();
      if (!this.#windows.has('output_ready') && !this.#reasoned.has('output_ready')) {
        this.markUnavailable('output_ready', TEST_TIMING_OUTPUT_REASON);
      }
    }

    const totalEndNs = this.readBoundary();
    const measuredEvents = [];
    for (const [phaseKey, window] of this.#windows) {
      measuredEvents.push({ phaseKey, kind: 'start', ns: window.startNs });
      measuredEvents.push({ phaseKey, kind: 'finish', ns: window.endNs });
    }
    measuredEvents.sort((left, right) => {
      if (left.ns !== right.ns) return left.ns < right.ns ? -1 : 1;
      if (left.kind !== right.kind) return left.kind === 'start' ? -1 : 1;
      return GPU_HMR_TEST_TIMING_PHASE_KEYS.indexOf(left.phaseKey)
        - GPU_HMR_TEST_TIMING_PHASE_KEYS.indexOf(right.phaseKey);
    });
    const readings = [
      this.#totalStartNs,
      ...measuredEvents.map((event) => event.ns),
      totalEndNs,
    ];
    // Replay only captured process.hrtime boundaries; no wall or worker clock is converted.
    let readingIndex = 0;
    const recorder = new GpuHmrTestTimingRecorder({
      clock: () => readings[readingIndex++],
    });
    for (const [phaseKey, reasoned] of this.#reasoned) {
      if (reasoned.state === 'not_applicable') {
        recorder.notApplicable(phaseKey, reasoned.reasonCode);
      } else {
        recorder.unavailable(phaseKey, reasoned.reasonCode);
      }
    }
    for (const event of measuredEvents) {
      if (event.kind === 'start') recorder.startPhase(event.phaseKey);
      else recorder.finishPhase(event.phaseKey);
    }
    this.#record = recorder.finalize({
      outcome,
      visualCapable: this.#captureContractObserved,
      terminalReason: finalReason,
      notApplicableReason: this.#captureContractObserved
        ? null
        : TEST_TIMING_VISUAL_NOT_OBSERVED_REASON,
    });
    if (readingIndex !== readings.length) {
      throw new Error('agent_split_timing_boundary_replay_incomplete');
    }
    assertValidGpuHmrTestTiming(this.#record);
    return this.#record;
  }
}

export function createAgentSplitTestTimingV2Lifecycle(options) {
  return new AgentSplitTestTimingV2Lifecycle(options);
}

function sanitizeProofLogString(value) {
  let text = String(value ?? '');
  const replacements = [
    [/\bapi_key:[A-Za-z0-9._~+/\-=:-]{8,}/gi, 'api_key:[REDACTED]'],
    [/\bAIza[0-9A-Za-z_-]{20,}\b/g, '[REDACTED_GOOGLE_API_KEY]'],
    [/\b(Bearer\s+)[A-Za-z0-9._~+/\-=]{12,}/gi, '$1[REDACTED]'],
    [/\b(Authorization\s*:\s*)(?:Bearer\s+)?[A-Za-z0-9._~+/\-=]{12,}/gi, '$1[REDACTED]'],
    [
      /\b((?:GOOGLE|GEMINI|OPENAI|ANTHROPIC|SYNTHI)?_?(?:API_?KEY|TOKEN|SECRET|PASSWORD))\s*=\s*["']?[^"',\s\\]+/gi,
      '$1=[REDACTED]',
    ],
    [
      /(["'](?:apiKey|api_key|token|secret|password|authorization)["']\s*:\s*["'])[^"']+(["'])/gi,
      `$1${REDACTED_SECRET}$2`,
    ],
  ];
  for (const [pattern, replacement] of replacements) {
    text = text.replace(pattern, replacement);
  }
  return text;
}

function sanitizeProofLogValue(value, depth = 0) {
  if (typeof value === 'string') return sanitizeProofLogString(value);
  if (value === null || value === undefined) return value;
  if (typeof value !== 'object') return value;
  if (depth > 12) return '[REDACTED_DEEP_OBJECT]';
  if (Array.isArray(value)) return value.map((entry) => sanitizeProofLogValue(entry, depth + 1));
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => {
      if (/api[_-]?key|token|secret|password|authorization/i.test(key)) {
        return [key, REDACTED_SECRET];
      }
      return [key, sanitizeProofLogValue(entry, depth + 1)];
    }),
  );
}

function resultTextFromRows(rows) {
  return rows.map((row) =>
    `${row.status.toUpperCase()} ${row.name}${row.detail ? ` - ${row.detail}` : ''}`
  ).join('\n') + '\n';
}

export function attachAgentSplitTestTimingV2(target, testTiming) {
  if (!target || typeof target !== 'object' || Array.isArray(target)) {
    throw new TypeError('agent split timing attachment target must be an object');
  }
  if (testTiming?.schema !== GPU_HMR_TEST_TIMING_SCHEMA) {
    throw new TypeError('agent split timing attachment requires timing v2');
  }
  try {
    assertValidGpuHmrTestTiming(testTiming);
  } catch (error) {
    throw new TypeError(
      `agent split timing attachment requires a valid support-only record: ${error?.message ?? error}`,
      { cause: error },
    );
  }
  if (
    testTiming.authority !== 'timing_only'
    || testTiming.timingOnly !== true
    || testTiming.acceptedForGpuHmr !== false
    || testTiming.gpuHmrSuccess !== false
  ) {
    throw new TypeError('agent split timing attachment cannot carry GPU HMR authority');
  }
  target.testTiming = testTiming;
  target.test_timing = testTiming;
  return target;
}

export function tagAgentSplitTimingError(error, {
  outcome = 'failed',
  category = 'runtime_failure',
  reasonCode = 'agent_split_runtime_failure',
} = {}) {
  if (!error || typeof error !== 'object') return error;
  if (outcome !== 'failed' && outcome !== 'refused') {
    throw new TypeError(`invalid agent split timing terminal outcome: ${outcome}`);
  }
  requireAgentSplitTimingReason(reasonCode);
  Object.defineProperty(error, AGENT_SPLIT_TIMING_ERROR, {
    configurable: true,
    value: Object.freeze({ outcome, category, reasonCode }),
  });
  return error;
}

function observedRefusalStatus(value) {
  const normalized = String(value ?? '').trim().toLowerCase();
  return normalized === 'refused'
    || normalized === 'rejected'
    || normalized === 'unsupported';
}

export function classifyAgentSplitTimingTerminal(error = null) {
  if (!error) {
    return Object.freeze({
      outcome: 'pass',
      category: 'success',
      reasonCode: null,
    });
  }
  const tagged = error?.[AGENT_SPLIT_TIMING_ERROR];
  if (tagged) return tagged;

  const compileStatus = error?.compileResult?.status
    ?? error?.compileResult?.resultState
    ?? error?.compileResult?.result_state;
  const waitStatus = error?.waitSummary?.status ?? error?.wait_summary?.status;
  if (observedRefusalStatus(compileStatus) || observedRefusalStatus(waitStatus)) {
    return Object.freeze({
      outcome: 'refused',
      category: 'observed_refusal',
      reasonCode: 'agent_split_observed_refusal',
    });
  }
  return Object.freeze({
    outcome: 'failed',
    category: 'runtime_failure',
    reasonCode: 'agent_split_runtime_failure',
  });
}

function agentSplitRefusalError(message, reasonCode) {
  return tagAgentSplitTimingError(new Error(message), {
    outcome: 'refused',
    category: 'proof_refusal',
    reasonCode,
  });
}

export function emergencyTimingTerminal(kind) {
  const reasonCode = {
    'signal:SIGINT': 'agent_split_emergency_sigint',
    'signal:SIGTERM': 'agent_split_emergency_sigterm',
    uncaught_exception: 'agent_split_emergency_uncaught_exception',
    unhandled_rejection: 'agent_split_emergency_unhandled_rejection',
  }[kind] ?? 'agent_split_emergency_failure';
  return Object.freeze({
    outcome: 'failed',
    category: 'emergency_failure',
    reasonCode,
  });
}

export function buildAgentSplitResultCheckpoint({
  reason = 'incremental_record',
  rows = [],
  testTiming = null,
  timingTerminal = null,
  slug = CFG.slug,
  updatedAt = new Date().toISOString(),
} = {}) {
  const checkpoint = {
    schemaVersion: 'synthi.gpu_hmr.agent_split_result_checkpoint.v1',
    schema_version: 'synthi.gpu_hmr.agent_split_result_checkpoint.v1',
    proofAuthority: 'agent_split_result_checkpoint_only_not_gpu_hmr_acceptance',
    proof_authority: 'agent_split_result_checkpoint_only_not_gpu_hmr_acceptance',
    acceptedForGpuHmr: false,
    accepted_for_gpu_hmr: false,
    gpuHmrSuccess: false,
    gpu_hmr_success: false,
    canSatisfyRuntimeProof: false,
    can_satisfy_runtime_proof: false,
    status: 'checkpoint_written',
    reason,
    slug,
    resultCount: rows.length,
    result_count: rows.length,
    updatedAt,
    updated_at: updatedAt,
  };
  if (testTiming) attachAgentSplitTestTimingV2(checkpoint, testTiming);
  if (timingTerminal) {
    checkpoint.testTimingTerminal = timingTerminal;
    checkpoint.test_timing_terminal = timingTerminal;
  }
  return checkpoint;
}

function retainAgentSplitTestTiming(testTiming, timingTerminal) {
  retainedAgentSplitTestTiming = testTiming;
  retainedAgentSplitTimingTerminal = timingTerminal;
  return testTiming;
}

function writeResultCheckpointSync(reason = 'incremental_record') {
  if (process.env.SYNTHI_GPU_AGENT_INCREMENTAL_RESULTS === '0') return;
  if (writingResultCheckpoint) return;
  writingResultCheckpoint = true;
  try {
    mkdirSync(LOG_DIR, { recursive: true });
    mkdirSync(ARTIFACT_DIR, { recursive: true });
    const sanitizedResults = sanitizeProofLogValue(results);
    const sanitizedTiming = retainedAgentSplitTestTiming
      ? sanitizeProofLogValue(retainedAgentSplitTestTiming)
      : null;
    const sanitizedTimingTerminal = retainedAgentSplitTimingTerminal
      ? sanitizeProofLogValue(retainedAgentSplitTimingTerminal)
      : null;
    const resultText = resultTextFromRows(sanitizedResults);
    writeFileSync(RESULTS_JSON, `${JSON.stringify(sanitizedResults, null, 2)}\n`);
    writeFileSync(RESULTS_TXT, resultText);
    writeFileSync(
      path.join(ARTIFACT_DIR, `${RESULTS_BASENAME}.json`),
      `${JSON.stringify(sanitizedResults, null, 2)}\n`,
    );
    writeFileSync(path.join(ARTIFACT_DIR, `${RESULTS_BASENAME}.txt`), resultText);
    if (sanitizedTiming) {
      const timingJson = `${JSON.stringify(sanitizedTiming, null, 2)}\n`;
      writeFileSync(TEST_TIMING_JSON, timingJson);
      writeFileSync(
        path.join(ARTIFACT_DIR, `${RESULTS_BASENAME}-timing-v2.json`),
        timingJson,
      );
    }
    writeFileSync(
      path.join(ARTIFACT_DIR, `${RESULTS_BASENAME}-checkpoint.json`),
      `${JSON.stringify(buildAgentSplitResultCheckpoint({
        reason,
        rows: sanitizedResults,
        testTiming: sanitizedTiming,
        timingTerminal: sanitizedTimingTerminal,
      }), null, 2)}\n`,
    );
  } catch {
    // Best-effort transport only. This checkpoint cannot authorize GPU HMR.
  } finally {
    writingResultCheckpoint = false;
  }
}

function record(name, status, detail = '') {
  const sanitizedDetail = sanitizeProofLogValue(detail);
  const row = { name, status, detail: sanitizedDetail, ts: new Date().toISOString() };
  results.push(row);
  const tag = status === 'pass' ? '[ok]' : status === 'fail' ? '[fail]' : '[warn]';
  console.log(`${tag} ${name}${sanitizedDetail ? ` - ${sanitizedDetail}` : ''}`);
  writeResultCheckpointSync('record_update');
}

let emergencyResultHandled = false;

function recordEmergencyResult(kind, detail) {
  if (emergencyResultHandled) return;
  emergencyResultHandled = true;
  const timingTerminal = emergencyTimingTerminal(kind);
  activeAgentSplitTestTiming?.closeActivePhases();
  activeAgentSplitTestTiming?.markUnavailable(
    'retirement',
    TEST_TIMING_EMERGENCY_RETIREMENT_REASON,
  );
  activeAgentSplitTestTiming?.beginPhase('proof_finalization');
  results.push({
    name: 'fatal',
    status: 'fail',
    detail: sanitizeProofLogValue(`${kind}: ${detail}`),
    ts: new Date().toISOString(),
  });
  activeAgentSplitTestTiming?.finishPhase('proof_finalization');
  if (activeAgentSplitTestTiming && !activeAgentSplitTestTiming.isFinalized) {
    retainAgentSplitTestTiming(
      activeAgentSplitTestTiming.finalize({
        outcome: timingTerminal.outcome,
        terminalReason: timingTerminal.reasonCode,
      }),
      timingTerminal,
    );
  }
  writeResultCheckpointSync(kind);
}

function installEmergencyResultHandlers() {
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.once(signal, () => {
      recordEmergencyResult(`signal:${signal}`, 'agent split visual proof terminated before final result');
      process.exit(1);
    });
  }
  process.once('uncaughtException', (err) => {
    recordEmergencyResult(
      'uncaught_exception',
      err?.stack || err?.message || String(err),
    );
    process.exit(1);
  });
  process.once('unhandledRejection', (reason) => {
    recordEmergencyResult(
      'unhandled_rejection',
      reason?.stack || reason?.message || String(reason),
    );
    process.exit(1);
  });
}

function cleanVisibleWorkspaceDir(value) {
  const normalized = String(value || '')
    .replace(/\\/g, '/')
    .replace(/^\/+/, '')
    .replace(/^\.\//, '')
    .replace(/\/+$/, '');
  if (!normalized || normalized.startsWith('.') || normalized.split('/').some((part) => !part || part.startsWith('.'))) {
    return 'gpu_hmr_demo';
  }
  return normalized;
}

function fail(message) {
  record('fatal', 'fail', message);
  throw new Error(message);
}

function boundedPositiveInt(value, fallback, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) {
  const parsed = Number(value);
  const base = Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
  return Math.max(min, Math.min(max, base));
}

function profileString(value, field, { required = false } = {}) {
  if (value === undefined || value === null || String(value).trim() === '') {
    if (required) throw new Error(`invalid agent visual profile ${field}: expected non-empty string`);
    return '';
  }
  if (typeof value !== 'string') {
    throw new Error(`invalid agent visual profile ${field}: expected string`);
  }
  return value.trim();
}

function profileBoolean(value, field, fallback = false) {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'boolean') {
    throw new Error(`invalid agent visual profile ${field}: expected boolean`);
  }
  return value;
}

function profilePositiveInt(value, field, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`invalid agent visual profile ${field}: expected positive integer`);
  }
  return parsed;
}

function profileFiniteNumber(value, field, fallback = null) {
  if (value === undefined || value === null || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`invalid agent visual profile ${field}: expected finite number`);
  }
  return parsed;
}

function profileObject(value, field, fallback = {}) {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`invalid agent visual profile ${field}: expected object`);
  }
  return value;
}

function profileArray(value, field) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    throw new Error(`invalid agent visual profile ${field}: expected array`);
  }
  return value;
}

function resolveProfilePath(profilePath, baseDir = process.cwd()) {
  const text = profileString(profilePath, 'path', { required: true });
  return path.isAbsolute(text) ? text : path.resolve(baseDir, text);
}

function contentAddressedSha256(value) {
  return /^sha256:[a-f0-9]{64}$/i.test(String(value ?? ''));
}

function normalizedProofContentHash(value) {
  const raw = String(value ?? '').trim().toLowerCase();
  const match = raw.match(/^(?:artifact:)?(sha256:[a-f0-9]{64})$/i);
  return match ? match[1].toLowerCase() : null;
}

function sourceContentHash(sourceText) {
  return `sha256:${sha256Hex(sourceText ?? '')}`;
}

function validateDeclaredSourceHash(declared, actual, field) {
  if (!declared) return;
  if (!contentAddressedSha256(declared)) {
    throw new Error(`invalid agent visual profile ${field}: expected sha256 content hash`);
  }
  if (actual && declared.toLowerCase() !== actual.toLowerCase()) {
    throw new Error(`agent visual profile ${field} mismatch: declared ${declared} actual ${actual}`);
  }
}

function normalizeAgentVisualProof(rawValue = {}) {
  const raw = profileObject(rawValue, 'visualProof', {});
  const minChangedRatio = Math.max(0.01, profileFiniteNumber(
    raw.minChangedRatio ?? raw.min_changed_ratio,
    'visualProof.minChangedRatio',
    0.01,
  ));
  const minMeanAbs = Math.max(1.0, profileFiniteNumber(
    raw.minMeanAbs ?? raw.min_mean_abs,
    'visualProof.minMeanAbs',
    1.0,
  ));
  const controlMultiplier = Math.max(3.0, profileFiniteNumber(
    raw.controlMultiplier ?? raw.control_multiplier,
    'visualProof.controlMultiplier',
    3.0,
  ));
  const controlChangedRatioPadding = Math.max(0.0025, profileFiniteNumber(
    raw.controlChangedRatioPadding ?? raw.control_changed_ratio_padding,
    'visualProof.controlChangedRatioPadding',
    0.0025,
  ));
  const controlMeanAbsPadding = Math.max(0.25, profileFiniteNumber(
    raw.controlMeanAbsPadding ?? raw.control_mean_abs_padding,
    'visualProof.controlMeanAbsPadding',
    0.25,
  ));
  const normalized = {
    minChangedRatio,
    min_changed_ratio: minChangedRatio,
    minMeanAbs,
    min_mean_abs: minMeanAbs,
    controlMultiplier,
    control_multiplier: controlMultiplier,
    controlChangedRatioPadding,
    control_changed_ratio_padding: controlChangedRatioPadding,
    controlMeanAbsPadding,
    control_mean_abs_padding: controlMeanAbsPadding,
  };
  if (raw.workerParallelism !== undefined || raw.worker_parallelism !== undefined) {
    const workerParallelism = boundedPositiveInt(
      raw.workerParallelism ?? raw.worker_parallelism,
      CFG.visualWorkerParallelism,
      { min: 1, max: 16 },
    );
    normalized.workerParallelism = workerParallelism;
    normalized.worker_parallelism = workerParallelism;
  }
  const proofHash = `sha256:${sha256Hex(stableJson(normalized))}`;
  return {
    ...normalized,
    proofHash,
    proof_hash: proofHash,
  };
}

function profileJsonValue(value, field) {
  if (value === undefined) return undefined;
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new Error(`invalid agent visual profile ${field}: expected finite JSON number`);
    }
    return value;
  }
  if (Array.isArray(value)) {
    return value
      .map((item, index) => profileJsonValue(item, `${field}[${index}]`))
      .filter((item) => item !== undefined);
  }
  if (typeof value === 'object') {
    const entries = Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right));
    const out = {};
    for (const [key, item] of entries) {
      out[key] = profileJsonValue(item, `${field}.${key}`);
    }
    return out;
  }
  throw new Error(`invalid agent visual profile ${field}: expected JSON value`);
}

function normalizeAgentVisualSceneManifest(rawValue, declaredHash = '') {
  if (rawValue === undefined || rawValue === null) return null;
  const raw = profileObject(rawValue, 'visualSceneManifest');
  if (Object.keys(raw).length === 0) {
    throw new Error('invalid agent visual profile visualSceneManifest: expected non-empty object');
  }
  const manifest = profileJsonValue(raw, 'visualSceneManifest');
  const manifestHash = `sha256:${sha256Hex(stableJson(manifest))}`;
  validateDeclaredSourceHash(declaredHash, manifestHash, 'visualSceneManifestHash');
  const evidenceRef = `evidence:agent-profile-visual-scene-manifest:${manifestHash}`;
  return {
    manifest,
    manifest_hash: manifestHash,
    manifestHash,
    evidence_ref: evidenceRef,
    evidenceRef,
  };
}

function normalizeAgentDeviceEditSpecs(raw, field = 'deviceEdits') {
  return [
    ...profileArray(raw.deviceEdits ?? raw.device_edits, `${field}.deviceEdits`),
    ...profileArray(raw.hotDeltas ?? raw.hot_deltas, `${field}.hotDeltas`),
  ].map((entry, index) => {
    const spec = profileObject(entry, `${field}[${index}]`);
    const runMode = profileString(
      spec.runMode ?? spec.run_mode ?? spec.metricScope ?? spec.metric_scope,
      `${field}[${index}].runMode`,
    );
    const find = profileString(spec.find, `${field}[${index}].find`);
    const regex = profileString(spec.regex, `${field}[${index}].regex`);
    const replace = profileString(spec.replace, `${field}[${index}].replace`, { required: true });
    if (!find && !regex) {
      throw new Error(`invalid agent visual profile ${field}[${index}]: expected find or regex`);
    }
    return {
      runMode,
      run_mode: runMode,
      find,
      regex,
      flags: profileString(spec.flags, `${field}[${index}].flags`),
      replace,
      label: profileString(spec.label, `${field}[${index}].label`) || runMode || `edit-${index + 1}`,
    };
  });
}

function agentProfileSourceForHash(source) {
  return {
    entryPath: source.entryPath,
    entry_path: source.entry_path,
    path: source.path,
    resolvedPath: source.resolvedPath,
    resolved_path: source.resolved_path,
    fixture: source.fixture,
    files: Array.isArray(source.files)
      ? source.files.map((entry) => ({
          path: entry.path,
          contentHash: entry.contentHash,
          content_hash: entry.content_hash,
          byteLength: entry.byteLength,
          byte_length: entry.byte_length,
        }))
      : [],
    manifestHash: source.manifestHash ?? null,
    manifest_hash: source.manifest_hash ?? null,
    immutableSourceIdentityHash:
      source.immutableSourceIdentity?.identityHash
      ?? source.immutable_source_identity?.identity_hash
      ?? null,
    immutable_source_identity_hash:
      source.immutable_source_identity?.identity_hash
      ?? source.immutableSourceIdentity?.identityHash
      ?? null,
    contentHash: source.contentHash ?? null,
    content_hash: source.content_hash ?? null,
    declaredContentHash: source.declaredContentHash ?? null,
    declared_content_hash: source.declared_content_hash ?? null,
  };
}

function sourceFileHashEntry(entry) {
  return {
    path: cleanRel(entry.path),
    contentHash: entry.contentHash,
    content_hash: entry.content_hash,
    byteLength: entry.byteLength,
    byte_length: entry.byte_length,
  };
}

function sourceFilesManifestHash(files) {
  return `sha256:${sha256Hex(stableJson(files.map(sourceFileHashEntry)))}`;
}

function normalizeAgentProfileSourceFiles(source, profileDir) {
  const entries = profileArray(
    source.files
      ?? source.sourceFiles
      ?? source.source_files
      ?? source.initialFiles
      ?? source.initial_files,
    'source.files',
  );
  const normalized = entries.map((entry, index) => {
    const raw = profileObject(entry, `source.files[${index}]`);
    const workspacePath = cleanRel(profileString(
      raw.workspacePath
        ?? raw.workspace_path
        ?? raw.path
        ?? raw.name
        ?? raw.filename,
      `source.files[${index}].path`,
      { required: true },
    ));
    if (!workspacePath) {
      throw new Error(`invalid agent visual profile source.files[${index}].path: expected non-empty relative path`);
    }
    const declaredContentHash = profileString(
      raw.contentHash ?? raw.content_hash ?? raw.sha256,
      `source.files[${index}].contentHash`,
    ).toLowerCase();
    if (!declaredContentHash) {
      throw new Error(`invalid agent visual profile source.files[${index}].contentHash: expected explicit sha256 content hash`);
    }
    const hostPath = profileString(
      raw.sourcePath
        ?? raw.source_path
        ?? raw.hostPath
        ?? raw.host_path
        ?? raw.filePath
        ?? raw.file_path,
      `source.files[${index}].sourcePath`,
    );
    const resolvedSourcePath = hostPath ? resolveProfilePath(hostPath, profileDir) : '';
    const fallbackSourcePath = !resolvedSourcePath
      ? path.resolve(profileDir, workspacePath)
      : '';
    const inlineContent = typeof raw.inline === 'string'
      ? raw.inline
      : typeof raw.content === 'string'
        ? raw.content
        : '';
    const sourcePathToRead = resolvedSourcePath
      || (fallbackSourcePath && existsSync(fallbackSourcePath) ? fallbackSourcePath : '');
    if (!inlineContent && !sourcePathToRead) {
      throw new Error(`invalid agent visual profile source.files[${index}]: expected inline content or readable sourcePath`);
    }
    const content = inlineContent || readFileSync(sourcePathToRead, 'utf8');
    const contentHash = sourceContentHash(content);
    validateDeclaredSourceHash(declaredContentHash, contentHash, `source.files[${index}].contentHash`);
    return {
      path: workspacePath,
      name: workspacePath,
      content,
      sourcePath: hostPath || (sourcePathToRead ? workspacePath : null),
      source_path: hostPath || (sourcePathToRead ? workspacePath : null),
      resolvedPath: sourcePathToRead || null,
      resolved_path: sourcePathToRead || null,
      contentHash,
      content_hash: contentHash,
      declaredContentHash: declaredContentHash || null,
      declared_content_hash: declaredContentHash || null,
      byteLength: Buffer.byteLength(content, 'utf8'),
      byte_length: Buffer.byteLength(content, 'utf8'),
      evidenceRef: `evidence:agent-profile-source-file:${contentHash}`,
      evidence_ref: `evidence:agent-profile-source-file:${contentHash}`,
    };
  }).sort((left, right) => left.path.localeCompare(right.path));
  const seen = new Set();
  for (const entry of normalized) {
    if (seen.has(entry.path)) {
      throw new Error(`invalid agent visual profile source.files: duplicate workspace path ${entry.path}`);
    }
    seen.add(entry.path);
  }
  return normalized;
}

const DIRECT_SOURCE_AUTHORITIES = new Set([
  'direct_source_url_commit',
  'direct_local_git_repo_path',
  'user_source_files',
  'workspace_source_files',
  'cli_or_env_direct_source',
]);
const STRICT_DIRECT_SOURCE_AUTHORITIES = new Set([
  'direct_source_url_commit',
  'direct_local_git_repo_path',
]);
const DIRECT_SOURCE_INPUT_SCHEMA_VERSION =
  'synthi.gpu_hmr.random_cold_path_direct_source_input.v1';
const DIRECT_SOURCE_INPUT_AUTHORITY =
  'runner_cli_env_direct_source_input_only_not_gpu_hmr_success';
const DIRECT_SOURCE_INPUT_IDENTITY_ROLE =
  'source_identity_hash_bound_to_direct_input_not_whitelist';
const DIRECT_SOURCE_RUNTIME_CONTRACT_EXPECTATION_SCHEMA_VERSION =
  'synthi.gpu_hmr.direct_source_runtime_contract_expectation.v1';
const DIRECT_SOURCE_RUNTIME_CONTRACT_EXPECTATION_AUTHORITY =
  'direct_source_runtime_contract_expectation_only_not_gpu_hmr_success';
const DIRECT_SOURCE_RUNTIME_BOUNDARY_STAGES = [
  'artifact_transport',
  'epoch_publication',
  'dispatch_trace',
  'host_identity',
  'output_oracle',
];

function normalizeDirectSourceAuthority(value) {
  const text = profileString(value, 'sourceAuthority').trim();
  if (!text) return 'cli_or_env_direct_source';
  if (!DIRECT_SOURCE_AUTHORITIES.has(text)) {
    throw new Error(
      `invalid direct source authority ${text}: expected one of ${[...DIRECT_SOURCE_AUTHORITIES].join(', ')}`,
    );
  }
  return text;
}

function uniqueSortedStrings(values) {
  return [...new Set(
    (Array.isArray(values) ? values : [])
      .map((value) => String(value ?? '').trim())
      .filter(Boolean),
  )].sort();
}

function runtimeBoundaryStageNames(value) {
  const rawEntries = Array.isArray(value) ? value : [];
  return uniqueSortedStrings(rawEntries.map((entry) => {
    if (typeof entry === 'string') return entry;
    if (!entry || typeof entry !== 'object') return '';
    return entry.stage ?? entry.kind ?? entry.eventKind ?? entry.event_kind ?? '';
  }).map((entry) => String(entry ?? '').trim().toLowerCase()));
}

function realPathForExistingPath(value) {
  return realpathSync(value);
}

function assertPathInsideRoot(filePath, rootPath, label) {
  if (!rootPath) return;
  const rootReal = realPathForExistingPath(rootPath);
  const fileReal = realPathForExistingPath(filePath);
  const rel = path.relative(rootReal, fileReal);
  if (rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))) return;
  throw new Error(`direct source ${label} escapes source root: ${filePath}`);
}

function normalizeDirectSourceFiles(source, {
  manifestDir,
  sourceRoot,
} = {}) {
  const entries = profileArray(
    source.files
      ?? source.sourceFiles
      ?? source.source_files
      ?? source.initialFiles
      ?? source.initial_files,
    'directSource.files',
  );
  if (entries.length === 0) {
    throw new Error('direct source manifest must provide at least one source file');
  }
  const baseDir = sourceRoot || manifestDir || process.cwd();
  const normalized = entries.map((entry, index) => {
    const raw = profileObject(entry, `directSource.files[${index}]`);
    const workspacePath = cleanRel(profileString(
      raw.workspacePath
        ?? raw.workspace_path
        ?? raw.path
        ?? raw.name
        ?? raw.filename,
      `directSource.files[${index}].path`,
      { required: true },
    ));
    if (!workspacePath || workspacePath.startsWith('../') || workspacePath.includes('/../')) {
      throw new Error(`invalid direct source file path: ${workspacePath}`);
    }
    const declaredContentHash = profileString(
      raw.contentHash ?? raw.content_hash ?? raw.sha256,
      `directSource.files[${index}].contentHash`,
    ).toLowerCase();
    const hostPath = profileString(
      raw.sourcePath
        ?? raw.source_path
        ?? raw.hostPath
        ?? raw.host_path
        ?? raw.filePath
        ?? raw.file_path,
      `directSource.files[${index}].sourcePath`,
    );
    const inlineContent = typeof raw.inline === 'string'
      ? raw.inline
      : typeof raw.content === 'string'
        ? raw.content
        : '';
    const resolvedSourcePath = hostPath ? resolveProfilePath(hostPath, baseDir) : '';
    if (resolvedSourcePath && sourceRoot) {
      assertPathInsideRoot(resolvedSourcePath, sourceRoot, `files[${index}]`);
    }
    if (!inlineContent && (!resolvedSourcePath || !existsSync(resolvedSourcePath))) {
      throw new Error(`invalid direct source file ${workspacePath}: expected inline content or readable sourcePath`);
    }
    const content = inlineContent || readFileSync(resolvedSourcePath, 'utf8');
    const contentHash = sourceContentHash(content);
    validateDeclaredSourceHash(declaredContentHash, contentHash, `directSource.files[${index}].contentHash`);
    const evidenceRef = `evidence:agent-direct-source-file:${contentHash}`;
    return {
      path: workspacePath,
      name: workspacePath,
      content,
      sourcePath: hostPath || null,
      source_path: hostPath || null,
      resolvedPath: resolvedSourcePath || null,
      resolved_path: resolvedSourcePath || null,
      contentHash,
      content_hash: contentHash,
      declaredContentHash: declaredContentHash || null,
      declared_content_hash: declaredContentHash || null,
      byteLength: Buffer.byteLength(content, 'utf8'),
      byte_length: Buffer.byteLength(content, 'utf8'),
      evidenceRef,
      evidence_ref: evidenceRef,
    };
  }).sort((left, right) => left.path.localeCompare(right.path));
  const seen = new Set();
  for (const entry of normalized) {
    if (seen.has(entry.path)) {
      throw new Error(`invalid direct source manifest: duplicate workspace path ${entry.path}`);
    }
    seen.add(entry.path);
  }
  return normalized;
}

function normalizeDirectSourceOverride(rawManifest, {
  manifestPath = '',
  sourceRoot = '',
  requestedSourceAuthority = '',
  fallbackEntryPath = 'main.cpp',
} = {}) {
  const raw = profileObject(rawManifest, 'directSourceManifest');
  const manifestAcceptedForGpuHmr = raw.acceptedForGpuHmr ?? raw.accepted_for_gpu_hmr;
  const manifestGpuHmrSuccess = raw.gpuHmrSuccess ?? raw.gpu_hmr_success;
  const manifestCanSatisfyRuntimeProof =
    raw.canSatisfyRuntimeProof ?? raw.can_satisfy_runtime_proof;
  if (
    manifestAcceptedForGpuHmr === true
    || manifestGpuHmrSuccess === true
    || manifestCanSatisfyRuntimeProof === true
  ) {
    throw new Error('direct source manifest must not claim GPU HMR or runtime proof authority');
  }
  const source = profileObject(raw.source ?? raw, 'directSourceManifest.source');
  const manifestDir = manifestPath ? path.dirname(resolveProfilePath(manifestPath)) : process.cwd();
  const rootFromManifest = profileString(
    raw.sourceRoot
      ?? raw.source_root
      ?? source.sourceRoot
      ?? source.source_root,
    'directSourceManifest.sourceRoot',
  );
  const resolvedSourceRoot = sourceRoot
    ? resolveProfilePath(sourceRoot, process.cwd())
    : rootFromManifest
      ? resolveProfilePath(rootFromManifest, manifestDir)
      : manifestDir;
  const sourceAuthority = normalizeDirectSourceAuthority(
    requestedSourceAuthority
      || raw.sourceAuthority
      || raw.source_authority
      || source.sourceAuthority
      || source.source_authority,
  );
  if (sourceAuthority === 'direct_local_git_repo_path' && !resolvedSourceRoot) {
    throw new Error('direct_local_git_repo_path source authority requires a source root');
  }
  const sourceUrl = profileString(
    raw.sourceUrl
      ?? raw.source_url
      ?? source.sourceUrl
      ?? source.source_url,
    'directSourceManifest.sourceUrl',
  );
  const declaredRepoPath = profileString(
    raw.repoPath
      ?? raw.repo_path
      ?? source.repoPath
      ?? source.repo_path,
    'directSourceManifest.repoPath',
  );
  const repoPath = declaredRepoPath || (
    sourceAuthority === 'direct_local_git_repo_path'
      ? resolvedSourceRoot
      : ''
  );
  const declaredImmutableCommit = profileString(
    raw.immutableCommit
      ?? raw.immutable_commit
      ?? raw.commit
      ?? source.immutableCommit
      ?? source.immutable_commit
      ?? source.commit,
    'directSourceManifest.immutableCommit',
  );
  const declaredImmutableSourceIdentity =
    raw.immutableSourceIdentity
    ?? raw.immutable_source_identity
    ?? source.immutableSourceIdentity
    ?? source.immutable_source_identity
    ?? null;
  const sourceKind = profileString(
    raw.sourceKind
      ?? raw.source_kind
      ?? source.sourceKind
      ?? source.source_kind,
    'directSourceManifest.sourceKind',
  ) || (
    sourceAuthority === 'direct_local_git_repo_path'
      ? 'local_repo_path_commit'
      : sourceAuthority === 'direct_source_url_commit'
        ? 'source_url_commit'
        : 'source_tree_files'
  );
  const directSourceInputChannels = uniqueSortedStrings([
    ...(Array.isArray(raw.directSourceInputChannels) ? raw.directSourceInputChannels : []),
    ...(Array.isArray(raw.direct_source_input_channels) ? raw.direct_source_input_channels : []),
    ...(Array.isArray(source.directSourceInputChannels) ? source.directSourceInputChannels : []),
    ...(Array.isArray(source.direct_source_input_channels) ? source.direct_source_input_channels : []),
  ]);
  const entryPath = cleanRel(source.entryPath ?? source.entry_path ?? raw.entryPath ?? raw.entry_path ?? fallbackEntryPath);
  const files = normalizeDirectSourceFiles(source, {
    manifestDir,
    sourceRoot: existsSync(resolvedSourceRoot) ? resolvedSourceRoot : '',
  });
  const entryFile = files.find((entry) => entry.path === entryPath);
  if (!entryFile) {
    throw new Error(`direct source manifest entryPath ${entryPath} is missing from source files`);
  }
  const declaredVisualSceneManifestHash = profileString(
    raw.visualSceneManifestHash
      ?? raw.visual_scene_manifest_hash
      ?? raw.renderSceneManifestHash
      ?? raw.render_scene_manifest_hash
      ?? source.visualSceneManifestHash
      ?? source.visual_scene_manifest_hash
      ?? source.renderSceneManifestHash
      ?? source.render_scene_manifest_hash,
    'directSourceManifest.visualSceneManifestHash',
  ).toLowerCase();
  const visualSceneManifest = normalizeAgentVisualSceneManifest(
    raw.visualSceneManifest
      ?? raw.visual_scene_manifest
      ?? raw.renderSceneManifest
      ?? raw.render_scene_manifest
      ?? source.visualSceneManifest
      ?? source.visual_scene_manifest
      ?? source.renderSceneManifest
      ?? source.render_scene_manifest,
    declaredVisualSceneManifestHash,
  );
  const runtimeContractExpectation = profileObject(
    raw.runtimeContractExpectation
      ?? raw.runtime_contract_expectation
      ?? raw.directSourceRuntimeContractExpectation
      ?? raw.direct_source_runtime_contract_expectation
      ?? source.runtimeContractExpectation
      ?? source.runtime_contract_expectation
      ?? source.directSourceRuntimeContractExpectation
      ?? source.direct_source_runtime_contract_expectation,
    'directSourceManifest.runtimeContractExpectation',
    {},
  );
  const editSpecs = normalizeAgentDeviceEditSpecs(raw, 'directSourceManifest');
  const requireDeclaredEdits = profileBoolean(
    raw.requireDeclaredEdits ?? raw.require_declared_edits,
    'directSourceManifest.requireDeclaredEdits',
    true,
  );
  if (requireDeclaredEdits !== true) {
    throw new Error(
      'direct source manifest must require declared edits; arbitrary source-first visual proof cannot use synthetic fixture edits',
    );
  }
  const manifestHash = sourceFilesManifestHash(files);
  const immutableSourceIdentity = declaredImmutableSourceIdentity
    ? verifyDirectSourceGitIdentity({
        declaredIdentity: declaredImmutableSourceIdentity,
        sourceRoot: resolvedSourceRoot,
        requestedCommit: declaredImmutableCommit,
        sourceManifestHash: manifestHash,
        sourceFilePaths: files.map((entry) => entry.path),
      })
    : sourceAuthority === 'direct_local_git_repo_path'
      ? verifyDirectSourceGitIdentity({
          declaredIdentity: declaredImmutableSourceIdentity,
          sourceRoot: resolvedSourceRoot,
          requestedCommit: declaredImmutableCommit,
          sourceManifestHash: manifestHash,
          sourceFilePaths: files.map((entry) => entry.path),
        })
      : null;
  const immutableCommit = immutableSourceIdentity?.commitOid ?? declaredImmutableCommit;
  const evidenceRef = `evidence:agent-direct-source-manifest:${manifestHash}`;
  return {
    sourceAuthority,
    source_authority: sourceAuthority,
    sourceKind,
    source_kind: sourceKind,
    sourceUrl: sourceUrl || null,
    source_url: sourceUrl || null,
    repoPath: repoPath || null,
    repo_path: repoPath || null,
    immutableCommit: immutableCommit || null,
    immutable_commit: immutableCommit || null,
    immutableSourceIdentity,
    immutable_source_identity: immutableSourceIdentity,
    directSourceInputChannels,
    direct_source_input_channels: directSourceInputChannels,
    entryPath,
    entry_path: entryPath,
    files,
    sourceFiles: files,
    source_files: files,
    fileManifest: files.map(sourceFileHashEntry),
    file_manifest: files.map(sourceFileHashEntry),
    manifestHash,
    manifest_hash: manifestHash,
    contentHash: entryFile.contentHash,
    content_hash: entryFile.contentHash,
    visualSceneManifest: visualSceneManifest?.manifest ?? null,
    visual_scene_manifest: visualSceneManifest?.manifest ?? null,
    visualSceneManifestHash: visualSceneManifest?.manifestHash ?? null,
    visual_scene_manifest_hash: visualSceneManifest?.manifest_hash ?? null,
    visualSceneManifestEvidenceRef: visualSceneManifest?.evidenceRef ?? null,
    visual_scene_manifest_evidence_ref: visualSceneManifest?.evidence_ref ?? null,
    runtimeContractExpectation,
    runtime_contract_expectation: runtimeContractExpectation,
    deviceEdits: editSpecs,
    device_edits: editSpecs,
    requireDeclaredEdits,
    require_declared_edits: requireDeclaredEdits,
    byteLength: entryFile.byteLength,
    byte_length: entryFile.byteLength,
    manifestPath: manifestPath ? resolveProfilePath(manifestPath) : null,
    manifest_path: manifestPath ? resolveProfilePath(manifestPath) : null,
    sourceRoot: resolvedSourceRoot || null,
    source_root: resolvedSourceRoot || null,
    evidenceRef,
    evidence_ref: evidenceRef,
  };
}

function loadDirectSourceOverride() {
  const manifestPath = profileString(CFG.directSourceManifestPath, 'SYNTHI_GPU_AGENT_SOURCE_MANIFEST_PATH');
  if (!manifestPath) return null;
  const resolvedManifestPath = resolveProfilePath(manifestPath);
  if (!existsSync(resolvedManifestPath)) {
    throw new Error(`direct source manifest not found: ${resolvedManifestPath}`);
  }
  const raw = JSON.parse(readFileSync(resolvedManifestPath, 'utf8').replace(/^\uFEFF/, ''));
  return normalizeDirectSourceOverride(raw, {
    manifestPath: resolvedManifestPath,
    sourceRoot: CFG.directSourceRoot,
    requestedSourceAuthority: CFG.directSourceAuthority,
  });
}

function applyDirectSourceOverride(profile, override = loadDirectSourceOverride()) {
  if (!override) return profile;
  profile.source = {
    ...profile.source,
    entryPath: override.entryPath,
    entry_path: override.entry_path,
    path: null,
    resolvedPath: null,
    resolved_path: null,
    inline: '',
    fixture: '',
    files: override.files,
    sourceFiles: override.sourceFiles,
    source_files: override.source_files,
    fileManifest: override.fileManifest,
    file_manifest: override.file_manifest,
    manifestHash: override.manifestHash,
    manifest_hash: override.manifest_hash,
    contentHash: override.contentHash,
    content_hash: override.content_hash,
    declaredContentHash: null,
    declared_content_hash: null,
    directSourceManifestPath: override.manifestPath,
    direct_source_manifest_path: override.manifest_path,
    directSourceRoot: override.sourceRoot,
    direct_source_root: override.source_root,
    sourceKind: override.sourceKind,
    source_kind: override.source_kind,
    sourceUrl: override.sourceUrl,
    source_url: override.source_url,
    repoPath: override.repoPath,
    repo_path: override.repo_path,
    immutableCommit: override.immutableCommit,
    immutable_commit: override.immutable_commit,
    immutableSourceIdentity: override.immutableSourceIdentity,
    immutable_source_identity: override.immutable_source_identity,
    directSourceInputChannels: override.directSourceInputChannels,
    direct_source_input_channels: override.direct_source_input_channels,
    evidenceRef: override.evidenceRef,
    evidence_ref: override.evidence_ref,
    runtimeContractExpectation: override.runtimeContractExpectation,
    runtime_contract_expectation: override.runtime_contract_expectation,
  };
  profile.sourceAuthority = override.sourceAuthority;
  profile.source_authority = override.source_authority;
  const overrideDeviceEdits = Array.isArray(override.deviceEdits)
    ? override.deviceEdits
    : [];
  const overrideRequiresDeclaredEdits = override.requireDeclaredEdits === true;
  profile.deviceEdits = overrideDeviceEdits;
  profile.device_edits = overrideDeviceEdits;
  profile.requireDeclaredEdits = overrideRequiresDeclaredEdits;
  profile.require_declared_edits = overrideRequiresDeclaredEdits;
  if (override.visualSceneManifest) {
    profile.visualSceneManifest = override.visualSceneManifest;
    profile.visual_scene_manifest = override.visual_scene_manifest;
    profile.visualSceneManifestHash = override.visualSceneManifestHash;
    profile.visual_scene_manifest_hash = override.visual_scene_manifest_hash;
    profile.visualSceneManifestEvidenceRef = override.visualSceneManifestEvidenceRef;
    profile.visual_scene_manifest_evidence_ref = override.visual_scene_manifest_evidence_ref;
  } else {
    profile.visualSceneManifest = null;
    profile.visual_scene_manifest = null;
    profile.visualSceneManifestHash = null;
    profile.visual_scene_manifest_hash = null;
    profile.visualSceneManifestEvidenceRef = null;
    profile.visual_scene_manifest_evidence_ref = null;
  }
  refreshAgentProfileHash(profile);
  return profile;
}

function directSourceProfileId(override) {
  const hash = String(override?.manifestHash ?? override?.manifest_hash ?? '')
    .replace(/^sha256:/i, '')
    .slice(0, 16)
    .toLowerCase()
    .replace(/[^a-f0-9]+/g, '');
  return `direct-source-${hash || 'manifest'}`;
}

function createDirectSourceAgentProfile(override = loadDirectSourceOverride()) {
  if (!override) return null;
  const baseProfile = normalizeAgentVisualProfile({
    schemaVersion: AGENT_VISUAL_PROFILE_SCHEMA_VERSION,
    profileId: directSourceProfileId(override),
    profileClass: 'direct_source_visual_gpu_path',
    source: {
      entryPath: override.entryPath,
      files: override.files,
    },
    compile: {
      width: 800,
      height: 600,
    },
    requireDeclaredEdits: true,
  });
  return applyDirectSourceOverride(baseProfile, override);
}

function agentProfileHash(profile) {
  return `sha256:${sha256Hex(stableJson({
    schemaVersion: profile.schemaVersion,
    profileId: profile.profileId,
    profileClass: profile.profileClass,
    source: agentProfileSourceForHash(profile.source),
    compile: profile.compile,
    deviceEdits: profile.deviceEdits,
    deterministicVisualMode: profile.deterministicVisualMode,
    visualProof: profile.visualProof,
    visualSceneManifest: profile.visualSceneManifest ?? null,
    visualSceneManifestHash: profile.visualSceneManifestHash ?? null,
  }))}`;
}

function explicitGpuArch(value) {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text || text.toLowerCase() === 'auto') return null;
  return text;
}

function refreshAgentProfileHash(profile) {
  const profileHash = agentProfileHash(profile);
  profile.profileHash = profileHash;
  profile.profile_hash = profileHash;
  return profileHash;
}

function normalizeAgentVisualProfile(rawProfile, { profilePath = '' } = {}) {
  const raw = profileObject(rawProfile, 'root');
  const schemaVersion = raw.schemaVersion ?? raw.schema_version ?? AGENT_VISUAL_PROFILE_SCHEMA_VERSION;
  if (schemaVersion !== AGENT_VISUAL_PROFILE_SCHEMA_VERSION) {
    throw new Error(`unsupported agent visual profile schemaVersion: ${schemaVersion}`);
  }
  const source = profileObject(raw.source, 'source');
  const compile = profileObject(raw.compile, 'compile');
  const editSpecs = normalizeAgentDeviceEditSpecs(raw);
  const profileDir = profilePath ? path.dirname(resolveProfilePath(profilePath)) : process.cwd();
  const profileId = profileString(raw.profileId ?? raw.profile_id ?? raw.id, 'profileId', { required: true });
  const entryPath = cleanRel(source.entryPath ?? source.entry_path ?? raw.entryPath ?? raw.entry_path ?? 'main.cpp');
  const sourcePath = profileString(source.path ?? source.sourcePath ?? source.source_path, 'source.path');
  const resolvedSourcePath = sourcePath ? resolveProfilePath(sourcePath, profileDir) : '';
  const sourceFiles = normalizeAgentProfileSourceFiles(source, profileDir);
  const entrySourceFile = sourceFiles.find((entry) => entry.path === entryPath);
  const inlineSource = typeof source.inline === 'string'
    ? source.inline
    : typeof source.content === 'string'
      ? source.content
      : '';
  const fixtureSource = profileString(source.fixture, 'source.fixture').toLowerCase();
  const declaredSourceContentHash = profileString(
    source.contentHash ?? source.content_hash ?? source.sha256,
    'source.contentHash',
  ).toLowerCase();
  const actualSourceContentHash = entrySourceFile
    ? entrySourceFile.contentHash
    : inlineSource
      ? sourceContentHash(inlineSource)
      : resolvedSourcePath && existsSync(resolvedSourcePath)
        ? sourceContentHash(readFileSync(resolvedSourcePath, 'utf8'))
        : null;
  if (sourceFiles.length > 0 && !entrySourceFile) {
    throw new Error(`invalid agent visual profile source.files: entryPath ${entryPath} is missing from source tree manifest`);
  }
  validateDeclaredSourceHash(declaredSourceContentHash, actualSourceContentHash, 'source.contentHash');
  const sourceFilesHashEntries = sourceFiles.map(sourceFileHashEntry);
  const sourceFilesHash = sourceFiles.length > 0 ? sourceFilesManifestHash(sourceFiles) : null;
  const visualProof = normalizeAgentVisualProof(raw.visualProof ?? raw.visual_proof);
  const declaredVisualSceneManifestHash = profileString(
    raw.visualSceneManifestHash
      ?? raw.visual_scene_manifest_hash
      ?? raw.renderSceneManifestHash
      ?? raw.render_scene_manifest_hash,
    'visualSceneManifestHash',
  ).toLowerCase();
  const visualSceneManifest = normalizeAgentVisualSceneManifest(
    raw.visualSceneManifest
      ?? raw.visual_scene_manifest
      ?? raw.renderSceneManifest
      ?? raw.render_scene_manifest,
    declaredVisualSceneManifestHash,
  );
  const deterministicVisualMode =
    profileObject(raw.deterministicVisualMode ?? raw.deterministic_visual_mode, 'deterministicVisualMode', {});
  const deterministicVisualModeHash = `sha256:${sha256Hex(stableJson(deterministicVisualMode))}`;
  const normalized = {
    schemaVersion,
    schema_version: schemaVersion,
    profileId,
    profile_id: profileId,
    profileClass:
      profileString(raw.profileClass ?? raw.profile_class, 'profileClass') || profileClassForFixture(profileId),
    profile_class:
      profileString(raw.profileClass ?? raw.profile_class, 'profileClass') || profileClassForFixture(profileId),
    source: {
      entryPath,
      entry_path: entryPath,
      path: sourcePath,
      resolvedPath: resolvedSourcePath,
      resolved_path: resolvedSourcePath,
      inline: inlineSource,
      fixture: fixtureSource,
      files: sourceFiles,
      sourceFiles: sourceFiles,
      source_files: sourceFiles,
      fileManifest: sourceFilesHashEntries,
      file_manifest: sourceFilesHashEntries,
      manifestHash: sourceFilesHash,
      manifest_hash: sourceFilesHash,
      contentHash: actualSourceContentHash,
      content_hash: actualSourceContentHash,
      declaredContentHash: declaredSourceContentHash || null,
      declared_content_hash: declaredSourceContentHash || null,
      evidenceRef: actualSourceContentHash ? `evidence:agent-profile-source:${actualSourceContentHash}` : null,
      evidence_ref: actualSourceContentHash ? `evidence:agent-profile-source:${actualSourceContentHash}` : null,
    },
    compile: {
      width: profilePositiveInt(compile.width, 'compile.width', 800),
      height: profilePositiveInt(compile.height, 'compile.height', 600),
      gpuArch: explicitGpuArch(
        compile.gpuArch
          ?? compile.gpu_arch
          ?? compile.targetArch
          ?? compile.target_arch,
      ),
      gpu_arch: explicitGpuArch(
        compile.gpuArch
          ?? compile.gpu_arch
          ?? compile.targetArch
          ?? compile.target_arch,
      ),
    },
    requireDeclaredEdits: profileBoolean(
      raw.requireDeclaredEdits ?? raw.require_declared_edits,
      'requireDeclaredEdits',
      editSpecs.length > 0,
    ),
    require_declared_edits: profileBoolean(
      raw.requireDeclaredEdits ?? raw.require_declared_edits,
      'requireDeclaredEdits',
      editSpecs.length > 0,
    ),
    sourceAuthority: sourceFiles.length > 0
      ? 'profile_source_files'
      : sourcePath
        ? 'profile_source_file'
        : inlineSource
          ? 'profile_inline_source'
          : fixtureSource
            ? 'profile_declared_builtin_fixture_source'
            : 'missing',
    source_authority: sourceFiles.length > 0
      ? 'profile_source_files'
      : sourcePath
        ? 'profile_source_file'
        : inlineSource
          ? 'profile_inline_source'
          : fixtureSource
            ? 'profile_declared_builtin_fixture_source'
            : 'missing',
    deviceEdits: editSpecs,
    device_edits: editSpecs,
    deterministicVisualMode,
    deterministic_visual_mode: deterministicVisualMode,
    deterministicVisualModeHash,
    deterministic_visual_mode_hash: deterministicVisualModeHash,
    visualProof,
    visual_proof: visualProof,
    visualSceneManifest: visualSceneManifest?.manifest ?? null,
    visual_scene_manifest: visualSceneManifest?.manifest ?? null,
    visualSceneManifestHash: visualSceneManifest?.manifestHash ?? null,
    visual_scene_manifest_hash: visualSceneManifest?.manifest_hash ?? null,
    visualSceneManifestEvidenceRef: visualSceneManifest?.evidenceRef ?? null,
    visual_scene_manifest_evidence_ref: visualSceneManifest?.evidence_ref ?? null,
    profilePath: profilePath || null,
    profile_path: profilePath || null,
  };
  refreshAgentProfileHash(normalized);
  return normalized;
}

function loadAgentVisualProfile(profilePath = CFG.profilePath) {
  const configured = profileString(profilePath, 'SYNTHI_GPU_AGENT_PROFILE_PATH');
  const directSourceOverride = loadDirectSourceOverride();
  if (!configured) return createDirectSourceAgentProfile(directSourceOverride);
  const resolved = resolveProfilePath(configured);
  if (!existsSync(resolved)) {
    throw new Error(`agent visual profile not found: ${resolved}`);
  }
  const raw = JSON.parse(readFileSync(resolved, 'utf8'));
  return applyDirectSourceOverride(
    normalizeAgentVisualProfile(raw, { profilePath: resolved }),
    directSourceOverride,
  );
}

function sourceFromAgentVisualProfile(profile, vendor) {
  if (!profile) return null;
  const sourceFiles = Array.isArray(profile.source.files) ? profile.source.files : [];
  const entryPath = profile.source.entryPath ?? profile.source.entry_path ?? 'main.cpp';
  const entryFile = sourceFiles.find((entry) => entry.path === entryPath);
  const sourceText = entryFile
    ? entryFile.content
    : profile.source.inline
    ? profile.source.inline
    : profile.source.resolvedPath
      ? readFileSync(profile.source.resolvedPath, 'utf8')
      : profile.source.fixture
        ? builtinFixtureSource(vendor, profile.source.fixture)
        : null;
  if (sourceText !== null) {
    const actualHash = sourceContentHash(sourceText);
    validateDeclaredSourceHash(
      profile.source.declaredContentHash ?? profile.source.declared_content_hash,
      actualHash,
      'source.contentHash',
    );
    const sourceAuthority = profile.sourceAuthority ?? profile.source_authority ?? '';
    const directSourceAuthority = DIRECT_SOURCE_AUTHORITIES.has(sourceAuthority);
    profile.source.contentHash = actualHash;
    profile.source.content_hash = actualHash;
    const evidenceRef = directSourceAuthority
      ? (profile.source.evidenceRef ?? profile.source.evidence_ref ?? `evidence:agent-direct-source:${actualHash}`)
      : `evidence:agent-profile-source:${actualHash}`;
    profile.source.evidenceRef = evidenceRef;
    profile.source.evidence_ref = evidenceRef;
    refreshAgentProfileHash(profile);
    return sourceText;
  }
  throw new Error('agent visual profile must provide source.inline, source.path, or source.fixture');
}

function sourceFilesForInitialCompile(entryPath, sourceText) {
  const profileFiles = ACTIVE_AGENT_PROFILE?.source?.files;
  if (Array.isArray(profileFiles) && profileFiles.length > 0) {
    return profileFiles.map((entry) => ({
      path: entry.path,
      name: entry.path,
      content: entry.content,
    }));
  }
  return [{
    path: entryPath,
    name: entryPath,
    content: sourceText,
  }];
}

function validationProfileId() {
  return ACTIVE_AGENT_PROFILE?.profileId ?? selectedPackagedFixture();
}

function validationFixtureId() {
  if (ACTIVE_AGENT_PROFILE) return ACTIVE_AGENT_PROFILE.source?.fixture || '';
  return ACTIVE_AGENT_PROFILE?.source?.fixture || selectedPackagedFixture();
}

function validationProfileClass() {
  return ACTIVE_AGENT_PROFILE?.profileClass ?? profileClassForFixture(validationFixtureId());
}

function validationProfileEvidenceSource() {
  if (!ACTIVE_AGENT_PROFILE) return 'agent_split_fixture_runtime_visual_proof';
  const sourceAuthority = ACTIVE_AGENT_PROFILE.sourceAuthority ?? ACTIVE_AGENT_PROFILE.source_authority ?? '';
  return DIRECT_SOURCE_AUTHORITIES.has(sourceAuthority)
    ? 'agent_split_direct_source_runtime_visual_proof'
    : 'agent_split_profile_runtime_visual_proof';
}

function validationProfileEntryPath() {
  return ACTIVE_AGENT_PROFILE?.source?.entryPath ?? 'main.cpp';
}

function validationProfileWidth() {
  return ACTIVE_AGENT_PROFILE?.compile?.width ?? 800;
}

function validationProfileHeight() {
  return ACTIVE_AGENT_PROFILE?.compile?.height ?? 600;
}

function validationProfileGpuArch() {
  return explicitGpuArch(ACTIVE_AGENT_PROFILE?.compile?.gpuArch)
    ?? explicitGpuArch(ACTIVE_AGENT_PROFILE?.compile?.gpu_arch);
}

function setDetectedGpuArch(arch, source) {
  const normalized = explicitGpuArch(arch);
  if (!normalized) return null;
  CFG.gpuArch = normalized;
  CFG.gpuArchSource = source || CFG.gpuArchSource || 'detected';
  process.env.SYNTHI_GPU_ARCH = normalized;
  process.env.SYNTHI_GPU_ARCH_SOURCE = CFG.gpuArchSource;
  return normalized;
}

function httpFailureMessage(method, url, err, timeoutMs) {
  const cause = err?.cause ?? {};
  const parts = [
    `${method} ${url} failed`,
    `timeout_ms=${timeoutMs}`,
    err?.name ? `error_name=${err.name}` : '',
    err?.code ? `error_code=${err.code}` : '',
    cause?.name ? `cause_name=${cause.name}` : '',
    cause?.code ? `cause_code=${cause.code}` : '',
    err?.message ? `message=${err.message}` : '',
    cause?.message ? `cause_message=${cause.message}` : '',
  ].filter(Boolean);
  return parts.join(' ');
}

async function httpJson(method, url, body, headers = {}, options = {}) {
  const timeoutMs = Number.isFinite(options.timeoutMs) && options.timeoutMs > 0
    ? Math.floor(options.timeoutMs)
    : Number.isFinite(CFG.httpTimeoutMs) && CFG.httpTimeoutMs > 0
      ? Math.floor(CFG.httpTimeoutMs)
      : 30000;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method,
      headers: { 'content-type': 'application/json', ...headers },
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* ignore */ }
    if (!res.ok) throw new Error(`${method} ${url} -> ${res.status}: ${text.slice(0, 500)}`);
    return json ?? {};
  } catch (err) {
    throw new Error(httpFailureMessage(method, url, err, timeoutMs), { cause: err });
  } finally {
    clearTimeout(timeout);
  }
}

function execText(cmd, args, timeoutMs = 10000, rejectOnError = false, options = {}) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: timeoutMs, maxBuffer: 128 * 1024 * 1024 }, (err, stdout, stderr) => {
      const raw = `${stdout ?? ''}${stderr ?? ''}`;
      const text = options.trim === false ? raw : raw.trim();
      if (err && rejectOnError) {
        err.output = text;
        reject(err);
        return;
      }
      if (err) resolve(undefined);
      else resolve(text);
    });
  });
}

async function dockerContainerExists(nameOrId) {
  if (!nameOrId) return false;
  const inspected = await execText('docker', ['container', 'inspect', nameOrId], 5000);
  return typeof inspected === 'string' && inspected.length > 0;
}

async function resolveDockerContainer(configured, service) {
  if (await dockerContainerExists(configured)) return configured;

  const repoRoot = path.resolve(__dirname, '../../..');
  const composeId = await execText(
    'docker',
    ['compose', '--project-directory', repoRoot, 'ps', '-q', service],
    8000,
  );
  const id = String(composeId || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean)[0];
  if (id) return id;

  const labelIds = await execText(
    'docker',
    ['ps', '-q', '--filter', `label=com.docker.compose.service=${service}`],
    8000,
  );
  const labelId = String(labelIds || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean)[0];
  return labelId || configured;
}

async function resolveDockerContainers() {
  CFG.workerContainer = await resolveDockerContainer(CFG.workerContainer, 'worker');
  if (CFG.mcpTransport !== 'docker') return;
  CFG.mcpContainer = await resolveDockerContainer(CFG.mcpContainer, 'mcp');
  if (!CFG.mcpContainer) {
    throw new Error('MCP_TRANSPORT=docker requires an MCP container from MCP_CONTAINER, SYNTHI_MCP_CONTAINER, or docker compose service discovery');
  }
  if (!CFG.workerContainer) {
    throw new Error('MCP_TRANSPORT=docker requires a worker container from WORKER_CONTAINER, SYNTHI_WORKER_CONTAINER, or docker compose service discovery');
  }
  if (!CFG.mcpSignalingUrl) {
    throw new Error('MCP_TRANSPORT=docker requires explicit MCP_SIGNALING_URL or SYNTHI_MCP_SIGNALING_URL');
  }
  if (!CFG.mcpContainerEntry) {
    throw new Error('MCP_TRANSPORT=docker requires explicit MCP_CONTAINER_ENTRY or SYNTHI_MCP_CONTAINER_ENTRY');
  }
}

async function detectVendor() {
  if (CFG.vendor === 'cuda' || CFG.vendor === 'rocm') return CFG.vendor;
  if (CFG.workerContainer) {
    const workerProbe = await execText('docker', [
      'exec',
      CFG.workerContainer,
      'sh',
      '-lc',
      'if command -v nvidia-smi >/dev/null 2>&1 && nvidia-smi >/dev/null 2>&1; then echo cuda; elif [ -e /dev/dxg ] || command -v hipcc >/dev/null 2>&1; then echo rocm; else echo ""; fi',
    ]);
    const detected = String(workerProbe || '').trim().split(/\s+/).find((v) => v === 'cuda' || v === 'rocm');
    if (detected) return detected;
  }
  const nvidiaProbe = await execText('nvidia-smi', ['--query-gpu=compute_cap', '--format=csv,noheader,nounits'], 5000);
  if (typeof nvidiaProbe === 'string' && nvidiaProbe.trim()) return 'cuda';
  const rocmProbe = await execText('rocminfo', [], 5000);
  if (typeof rocmProbe === 'string' && /gfx[0-9][0-9a-z]*/i.test(rocmProbe)) return 'rocm';
  throw new Error('could not auto-detect GPU vendor; set SYNTHI_GPU_VENDOR=cuda or rocm');
}

function archProbeCommand(vendor) {
  if (vendor === 'cuda') {
    return "if command -v nvidia-smi >/dev/null 2>&1; then nvidia-smi --query-gpu=compute_cap --format=csv,noheader,nounits 2>/dev/null | awk 'NF { gsub(/\\./, \"\", $1); print \"sm_\" $1; exit }'; fi";
  }
  return "if command -v rocminfo >/dev/null 2>&1; then rocminfo 2>/dev/null | grep -m1 -o 'gfx[0-9][0-9a-z]*'; elif command -v rocm_agent_enumerator >/dev/null 2>&1; then rocm_agent_enumerator 2>/dev/null | grep -m1 -o 'gfx[0-9][0-9a-z]*'; fi";
}

async function detectArch(vendor) {
  const configured = explicitGpuArch(CFG.gpuArch);
  if (configured) return setDetectedGpuArch(configured, CFG.gpuArchSource || 'env:SYNTHI_GPU_ARCH');
  if (CFG.workerContainer) {
    const out = await execText('docker', [
      'exec',
      CFG.workerContainer,
      'sh',
      '-lc',
      archProbeCommand(vendor),
    ]);
    const detected = String(out || '').trim().split(/\s+/).find((v) => (
      vendor === 'cuda' ? /^sm_\d+$/.test(v) : /^gfx[0-9][0-9a-z]*$/.test(v)
    ));
    if (detected) return setDetectedGpuArch(detected, `worker_container:${CFG.workerContainer}`);
  }
  if (vendor === 'cuda') {
    const out = await execText('nvidia-smi', ['--query-gpu=compute_cap', '--format=csv,noheader,nounits'], 5000);
    const detected = String(out || '').trim().split(/\s+/).find((v) => /^\d+(?:\.\d+)?$/.test(v));
    if (detected) return setDetectedGpuArch(`sm_${detected.replace('.', '')}`, 'host:nvidia-smi');
  } else if (vendor === 'rocm') {
    const out = await execText('rocminfo', [], 5000);
    const detected = String(out || '').match(/gfx[0-9][0-9a-z]*/i)?.[0];
    if (detected) return setDetectedGpuArch(detected, 'host:rocminfo');
    const enumerator = await execText('rocm_agent_enumerator', [], 5000);
    const enumerated = String(enumerator || '').match(/gfx[0-9][0-9a-z]*/i)?.[0];
    if (enumerated) return setDetectedGpuArch(enumerated, 'host:rocm_agent_enumerator');
  }
  const profileArch = validationProfileGpuArch();
  if (profileArch) return setDetectedGpuArch(profileArch, 'agent_visual_profile:compile.gpuArch');
  return undefined;
}

async function createWorkspace({ name, slug }) {
  return createValidationWorkspace({
    frontendUrl: CFG.frontendUrl,
    name,
    slug,
    httpJson,
    record,
  });
}

async function writeFilesBatch({ slug, files }) {
  const res = await httpJson(
    'POST',
    `${CFG.collabUrl}/git/${slug}/write-files-batch`,
    {
      files: files.map((f) => ({ path: f.path, encoding: f.encoding ?? 'utf8', content: f.content })),
      syncToGcs: CFG.syncToGcs,
    },
    { 'x-user-id': CFG.hostId },
  );
  const errors = (res.errors ?? []).filter((e) => e.stage !== 'gcs_upload');
  if (errors.length) throw new Error(`write-files-batch errors: ${JSON.stringify(errors)}`);
  return res;
}

async function stageAndCommit({ slug, message }) {
  await httpJson('POST', `${CFG.collabUrl}/git/${slug}/stage-all`, {}, { 'x-user-id': CFG.hostId });
  await httpJson('POST', `${CFG.collabUrl}/git/${slug}/commit`, { message }, { 'x-user-id': CFG.hostId });
}

async function readWorkerLogTail(maxBytes = 8 * 1024 * 1024, opts = {}) {
  if (opts.since) {
    return new Promise((resolve) => {
      execFile(
        'docker',
        ['logs', '--since', opts.since, CFG.workerContainer],
        { maxBuffer: 128 * 1024 * 1024, timeout: CFG.workerLogTailTimeoutMs },
        (err, stdout, stderr) => {
          if (err) return resolve('');
          resolve(`${stdout ?? ''}${stderr ?? ''}`);
        },
      );
    });
  }
  try {
    const st = await stat(CFG.workerLogPath);
    const fd = await import('node:fs').then((m) => m.promises.open(CFG.workerLogPath, 'r'));
    const start = Math.max(0, st.size - maxBytes);
    const buf = Buffer.alloc(st.size - start);
    await fd.read(buf, 0, buf.length, start);
    await fd.close();
    return buf.toString('utf8');
  } catch {
    return new Promise((resolve) => {
      const args = ['logs', '--tail', '6000'];
      args.push(CFG.workerContainer);
      execFile('docker', args, { maxBuffer: 128 * 1024 * 1024, timeout: CFG.workerLogTailTimeoutMs }, (err, stdout, stderr) => {
        if (err) return resolve('');
        resolve(`${stdout ?? ''}${stderr ?? ''}`);
      });
    });
  }
}

async function workerCheckpoint() {
  return { at: new Date(Date.now() - 2000).toISOString() };
}

async function awaitWorkerLogRegex(regex, timeoutMs, checkpoint) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const tail = await readWorkerLogTail(8 * 1024 * 1024, checkpoint?.at ? { since: checkpoint.at } : {});
    regex.lastIndex = 0;
    const match = tail.match(regex);
    if (match) return { matched: true, snippet: match[0].slice(0, 500), tail };
    await sleep(700);
  }
  const tail = await readWorkerLogTail(8 * 1024 * 1024, checkpoint?.at ? { since: checkpoint.at } : {});
  return { matched: false, snippet: '', tail };
}

function shQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

async function workerWorkspacePath() {
  const logs = await readWorkerLogTail(4 * 1024 * 1024);
  const matches = [...logs.matchAll(/\[WORKER\] workspace tempdir: ([^\r\n]+)/g)];
  const fromLog = matches.at(-1)?.[1]?.trim();
  if (fromLog) return fromLog;
  const latestTmp = await execText('docker', [
    'exec',
    CFG.workerContainer,
    'sh',
    '-lc',
    'ls -td /tmp/.tmp* 2>/dev/null | head -1',
  ]);
  if (latestTmp) return latestTmp.trim();
  throw new Error('could not locate worker temp workspace path');
}

async function readWorkerFile(workspacePath, relPath) {
  const full = `${workspacePath.replace(/\/+$/, '')}/${relPath.replace(/^\/+/, '')}`;
  return execText(
    'docker',
    ['exec', CFG.workerContainer, 'sh', '-lc', `cat ${shQuote(full)}`],
    10000,
    true,
    { trim: false },
  );
}

class McpClient {
  constructor(proc) {
    this.proc = proc;
    this.nextId = 1;
    this.pending = new Map();
    this.buffer = Buffer.alloc(0);
    this.stderrTail = [];
    proc.stdout.on('data', (chunk) => this.onData(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    proc.stderr.on('data', (chunk) => {
      const s = chunk.toString();
      this.stderrTail.push(s);
      if (this.stderrTail.length > 50) this.stderrTail.shift();
      if (process.env.MCP_VERBOSE) process.stderr.write(`[mcp] ${s}`);
    });
    proc.on('exit', (code, sig) => {
      for (const [, pending] of this.pending) {
        pending.reject(new Error(`MCP exited ${code ?? sig} before response`));
      }
      this.pending.clear();
    });
  }

  onData(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    this.drainBuffer();
  }

  drainBuffer() {
    while (this.buffer.length > 0) {
      const header = this.readContentLengthHeader();
      if (header === 'partial') return;
      if (header) {
        const { bodyStart, length } = header;
        const bodyEnd = bodyStart + length;
        if (this.buffer.length < bodyEnd) return;
        const body = this.buffer.subarray(bodyStart, bodyEnd).toString('utf8');
        this.buffer = this.buffer.subarray(bodyEnd);
        this.handleMessageText(body);
        continue;
      }

      const newline = this.buffer.indexOf(0x0a);
      if (newline < 0) return;
      const line = this.buffer.subarray(0, newline).toString('utf8').trim();
      this.buffer = this.buffer.subarray(newline + 1);
      if (line) this.handleMessageText(line);
    }
  }

  readContentLengthHeader() {
    const preview = this.buffer.subarray(0, Math.min(this.buffer.length, 32)).toString('ascii').toLowerCase();
    if (!preview.startsWith('content-length:')) return null;
    const crlfEnd = this.buffer.indexOf('\r\n\r\n');
    const lfEnd = this.buffer.indexOf('\n\n');
    let headerEnd = -1;
    let separatorLength = 0;
    if (crlfEnd >= 0 && (lfEnd < 0 || crlfEnd <= lfEnd)) {
      headerEnd = crlfEnd;
      separatorLength = 4;
    } else if (lfEnd >= 0) {
      headerEnd = lfEnd;
      separatorLength = 2;
    }
    if (headerEnd < 0) return 'partial';
    const headerText = this.buffer.subarray(0, headerEnd).toString('ascii');
    const match = /^content-length:\s*(\d+)\s*$/im.exec(headerText);
    if (!match) {
      this.buffer = this.buffer.subarray(headerEnd + separatorLength);
      return null;
    }
    return {
      bodyStart: headerEnd + separatorLength,
      length: Number(match[1]),
    };
  }

  handleMessageText(text) {
    let msg;
    try { msg = JSON.parse(text); } catch { return; }
    if (msg.id != null && this.pending.has(msg.id)) {
      const pending = this.pending.get(msg.id);
      this.pending.delete(msg.id);
      if (msg.error) pending.reject(new Error(`MCP error: ${JSON.stringify(msg.error)}`));
      else pending.resolve(msg.result);
    }
  }

  request(method, params = {}, timeoutMs = CFG.mcpRequestTimeoutMs) {
    const id = this.nextId++;
    const frame = { jsonrpc: '2.0', id, method, params };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP request ${method} timed out. stderr tail:\n${this.stderrTail.slice(-10).join('')}`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (value) => { clearTimeout(timer); resolve(value); },
        reject: (err) => { clearTimeout(timer); reject(err); },
      });
      this.proc.stdin.write(`${JSON.stringify(frame)}\n`);
    });
  }

  async toolCall(name, args, timeoutMs = CFG.mcpRequestTimeoutMs) {
    const res = await this.request('tools/call', { name, arguments: args }, timeoutMs);
    const content = Array.isArray(res?.content) ? res.content : [];
    const textBlock = content.find((b) => b?.type === 'text');
    if (res.isError) throw new Error(`tool ${name} isError: ${textBlock?.text ?? JSON.stringify(res.content)}`);
    if (!textBlock?.text) return {};
    try { return JSON.parse(textBlock.text); } catch { return { raw: textBlock.text }; }
  }

  async toolCallRaw(name, args, timeoutMs = CFG.mcpRequestTimeoutMs) {
    const res = await this.request('tools/call', { name, arguments: args }, timeoutMs);
    const content = Array.isArray(res?.content) ? res.content : [];
    const textBlock = content.find((b) => b?.type === 'text');
    if (res.isError) throw new Error(`tool ${name} isError: ${textBlock?.text ?? JSON.stringify(res.content)}`);
    let json = {};
    if (textBlock?.text) {
      try { json = JSON.parse(textBlock.text); } catch { json = { raw: textBlock.text }; }
    }
    return { json, content };
  }
}

let mcpState = null;
function disposeMcpProcess(proc) {
  const disposed = {
    stdinEnded: false,
    stdin_ended: false,
    killed: false,
  };
  if (!proc) return disposed;
  try {
    proc.stdin?.end?.();
    disposed.stdinEnded = true;
    disposed.stdin_ended = true;
  } catch {
    // ignore shutdown races
  }
  try {
    proc.kill?.('SIGTERM');
    disposed.killed = true;
  } catch {
    // ignore shutdown races
  }
  return disposed;
}

async function startMcp() {
  if (mcpState?.client) return mcpState;
  let proc;
  if (CFG.mcpTransport === 'docker') {
    proc = spawn('docker', [
      'exec',
      '-i',
      '-e', `SYNTHI_SESSION_ID=${CFG.slug}`,
      '-e', `SYNTHI_SIGNALING_URL=${CFG.mcpSignalingUrl}`,
      '-e', `SYNTHI_VISION_BACKEND=${CFG.mcpVisionBackend}`,
      '-e', `GOOGLE_API_KEY=${CFG.googleApiKey}`,
      '-e', `GEMINI_API_KEY=${CFG.googleApiKey}`,
      '-e', `SYNTHI_GEMINI_MODEL=${CFG.geminiModel}`,
      '-e', `SYNTHI_GPU_SPLIT_MODEL=${CFG.gpuSplitModel}`,
      '-e', `SYNTHI_GPU_DELTA_MODEL=${CFG.gpuDeltaModel}`,
      CFG.mcpContainer,
      'node',
      CFG.mcpContainerEntry,
    ], { stdio: ['pipe', 'pipe', 'pipe'] });
  } else {
    if (!existsSync(CFG.mcpEntry)) throw new Error(`MCP entry not found: ${CFG.mcpEntry}`);
    proc = spawn('node', [CFG.mcpEntry], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        SYNTHI_SESSION_ID: CFG.slug,
        ...(CFG.signalingUrl ? { SYNTHI_SIGNALING_URL: CFG.signalingUrl } : {}),
        SYNTHI_VISION_BACKEND: CFG.mcpVisionBackend,
        GOOGLE_API_KEY: CFG.googleApiKey,
        GEMINI_API_KEY: CFG.googleApiKey,
        SYNTHI_GEMINI_MODEL: CFG.geminiModel,
        SYNTHI_GPU_SPLIT_MODEL: CFG.gpuSplitModel,
        SYNTHI_GPU_DELTA_MODEL: CFG.gpuDeltaModel,
      },
    });
  }
  const client = new McpClient(proc);
  try {
    await client.request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'synthi-gpu-hmr-agent-split-test', version: '0.0.1' },
    }, CFG.mcpRequestTimeoutMs);
    await client.request('notifications/initialized', {}, 5000).catch(() => {});
    const tools = await client.request('tools/list', {}, CFG.mcpRequestTimeoutMs);
    const names = tools.tools?.map((t) => t.name) ?? [];
    record('mcp tools/list', names.includes('synthi_compile') && names.includes('synthi_wait_hmr') ? 'pass' : 'fail', `count=${names.length}`);
    mcpState = { proc, client, attached: false };
    return mcpState;
  } catch (err) {
    const disposed = disposeMcpProcess(proc);
    record(
      'mcp startup cleanup',
      disposed.killed ? 'warn' : 'fail',
      `initialize_failed=${String(err?.message ?? err).slice(0, 200)} killed=${disposed.killed}`,
    );
    throw err;
  }
}

async function ensureMcpAttached() {
  const state = await startMcp();
  if (state.attached) return state;
  const args = { sessionId: CFG.slug, 'i-understand-no-auth': true };
  const attachSignalingUrl = CFG.mcpTransport === 'docker' ? CFG.mcpSignalingUrl : CFG.signalingUrl;
  if (attachSignalingUrl) args.signalingUrl = attachSignalingUrl;
  const attach = await state.client.toolCall('synthi_attach', args, CFG.mcpAttachTimeoutMs);
  if (!attach?.ok) throw new Error(`synthi_attach failed: ${JSON.stringify(attach)}`);
  state.attached = true;
  record('mcp attach', 'pass', attach.resolution ? `${attach.resolution.w}x${attach.resolution.h}` : 'attached');
  return state;
}

async function stopMcp() {
  if (!mcpState) return;
  disposeMcpProcess(mcpState.proc);
  mcpState = null;
}

function runtimeInclude(vendor) {
  return vendor === 'rocm'
    ? '#include <hip/hip_runtime.h>'
    : '#include <cuda_runtime.h>';
}

function runtimeApi(vendor) {
  return vendor === 'rocm'
    ? {
        malloc: 'hipMalloc',
        memcpy: 'hipMemcpy',
        h2d: 'hipMemcpyHostToDevice',
        d2h: 'hipMemcpyDeviceToHost',
        sync: 'hipDeviceSynchronize',
        free: 'hipFree',
        link: '-lamdhip64',
        build: 'hipcc',
      }
    : {
        malloc: 'cudaMalloc',
        memcpy: 'cudaMemcpy',
        h2d: 'cudaMemcpyHostToDevice',
        d2h: 'cudaMemcpyDeviceToHost',
        sync: 'cudaDeviceSynchronize',
        free: 'cudaFree',
        link: '-lcudart -lcuda',
        build: 'nvcc',
      };
}

function monolithicSource(vendor) {
  if (ACTIVE_AGENT_PROFILE) return sourceFromAgentVisualProfile(ACTIVE_AGENT_PROFILE, vendor);
  return builtinFixtureSource(vendor, selectedPackagedFixture());
}

function selectedPackagedFixture() {
  const fixture = String(CFG.fixture || '').trim().toLowerCase();
  if (fixture) return fixture;
  if (CFG.allowPackagedDefaultFixture) return 'flow';
  throw new Error(
    'agent split source-first runner requires an explicit fixture, profile, or direct source manifest; '
    + 'set SYNTHI_GPU_AGENT_ALLOW_PACKAGED_DEFAULT_FIXTURE=1 only for diagnostic packaged-fixture runs',
  );
}

function assertAgentProfileSelectionConfigured() {
  if (
    CFG.profilePath
    || CFG.directSourceManifestPath
    || CFG.directSourceRoot
    || CFG.fixture
    || CFG.allowPackagedDefaultFixture
  ) {
    return;
  }
  selectedPackagedFixture();
}

function builtinFixtureSource(vendor, fixture = selectedPackagedFixture()) {
  const normalizedFixture = String(fixture).toLowerCase();
  if (normalizedFixture === 'complex-flow') return complexFlowSource(vendor);
  if (normalizedFixture === 'ray-light') return rayLightSource(vendor);
  if (normalizedFixture === 'realistic-raytrace') return realisticRaytraceSource(vendor);
  if (normalizedFixture !== 'flow') {
    throw new Error(`unknown packaged GPU visual fixture: ${normalizedFixture || '<empty>'}`);
  }

  const api = runtimeApi(vendor);
  const target = vendor === 'rocm' ? 'rocm' : 'cuda';
  return `// User-authored single-file GPU app.
// No Synthi split/HMR ABI appears in this file.
// GPU_TARGET: ${target}
// LINK: -lSDL2 ${api.link}
// BUILD: ${api.build} main.cpp -lSDL2 ${api.link}
#include <SDL2/SDL.h>
${runtimeInclude(vendor)}
#include <cmath>
#include <cstdio>
#include <cstdlib>

#ifndef FLOW_DIRECTION
#define FLOW_DIRECTION 1.0f
#endif

constexpr int BALLS = 512;
constexpr int WIDTH = 800;
constexpr int HEIGHT = 600;

__global__ void particle_flow(float* x, float* y, int n, float cx, float cy, float speed, unsigned long long frame) {
    int i = blockIdx.x * blockDim.x + threadIdx.x;
    if (i >= n) return;

    const float direction = FLOW_DIRECTION; // SYNTHI_HMR_DIRECTION_TOKEN
    float theta = 2.39996323f * (float)i;
    float radius = 232.0f + (float)((i * 37) % 82);

    if (direction > 0.0f) {
        x[i] = cx + cosf(theta) * radius;
        y[i] = cy + sinf(theta) * radius * 0.72f;
        return;
    }

    int column = i % 32;
    int row = i / 32;
    float u = ((float)column / 31.0f) - 0.5f;
    float v = ((float)row / 15.0f) - 0.5f;
    float wave = sinf(u * 6.2831853f) * 26.0f;
    x[i] = cx + u * 560.0f;
    y[i] = cy + v * 338.0f + wave;
}

static void seed(float* x, float* y) {
    for (int i = 0; i < BALLS; ++i) {
        float theta = 2.39996323f * (float)i;
        float radius = 220.0f + (float)((i * 37) % 100);
        x[i] = WIDTH * 0.5f + cosf(theta) * radius;
        y[i] = HEIGHT * 0.5f + sinf(theta) * radius;
    }
}

int main(int, char**) {
    SDL_Init(SDL_INIT_VIDEO);
    SDL_Window* window = SDL_CreateWindow("Synthi Agent GPU Split", SDL_WINDOWPOS_CENTERED, SDL_WINDOWPOS_CENTERED, WIDTH, HEIGHT, 0);
    SDL_Renderer* renderer = SDL_CreateRenderer(window, -1, SDL_RENDERER_ACCELERATED);

    float hostX[BALLS];
    float hostY[BALLS];
    seed(hostX, hostY);

    float* deviceX = nullptr;
    float* deviceY = nullptr;
    ${api.malloc}(&deviceX, sizeof(float) * BALLS);
    ${api.malloc}(&deviceY, sizeof(float) * BALLS);
    ${api.memcpy}(deviceX, hostX, sizeof(float) * BALLS, ${api.h2d});
    ${api.memcpy}(deviceY, hostY, sizeof(float) * BALLS, ${api.h2d});

    bool running = true;
    unsigned long long frame = 0;
    while (running) {
        SDL_Event event;
        while (SDL_PollEvent(&event)) {
            if (event.type == SDL_QUIT) running = false;
        }

        dim3 block(256);
        dim3 grid((BALLS + block.x - 1) / block.x);
        particle_flow<<<grid, block>>>(deviceX, deviceY, BALLS, WIDTH * 0.5f, HEIGHT * 0.5f, 2.35f, frame++);
        ${api.sync}();
        ${api.memcpy}(hostX, deviceX, sizeof(float) * BALLS, ${api.d2h});
        ${api.memcpy}(hostY, deviceY, sizeof(float) * BALLS, ${api.d2h});

        SDL_SetRenderDrawColor(renderer, 8, 10, 18, 255);
        SDL_RenderClear(renderer);
        SDL_SetRenderDrawColor(renderer, 70, 190, 255, 255);
        for (int i = 0; i < BALLS; ++i) {
            SDL_Rect r{(int)hostX[i], (int)hostY[i], 3, 3};
            SDL_RenderFillRect(renderer, &r);
        }
        SDL_RenderPresent(renderer);
        if ((frame % 120ULL) == 0ULL) {
            std::fprintf(stderr, "[user-gpu-flow] frame=%llu\\n", frame);
        }
    }

    ${api.free}(deviceX);
    ${api.free}(deviceY);
    SDL_DestroyRenderer(renderer);
    SDL_DestroyWindow(window);
    SDL_Quit();
    return 0;
}
`;
}

function complexFlowSource(vendor) {
  const api = runtimeApi(vendor);
  const target = vendor === 'rocm' ? 'rocm' : 'cuda';
  return `// User-authored single-file GPU app.
// More complex fixture: two kernels, persistent velocity/hue buffers, and
// branch-heavy device math. No Synthi split/HMR ABI appears in this file.
// GPU_TARGET: ${target}
// LINK: -lSDL2 ${api.link}
// BUILD: ${api.build} main.cpp -lSDL2 ${api.link}
#include <SDL2/SDL.h>
${runtimeInclude(vendor)}
#include <cmath>
#include <cstdio>
#include <cstdlib>

#ifndef FLOW_DIRECTION
#define FLOW_DIRECTION 1.0f
#endif

constexpr int BALLS = 768;
constexpr int WIDTH = 800;
constexpr int HEIGHT = 600;

__device__ float wrap_unit(float v) {
    while (v < 0.0f) v += 1.0f;
    while (v >= 1.0f) v -= 1.0f;
    return v;
}

extern "C" __global__ void particle_flow(
    float* x,
    float* y,
    float* vx,
    float* vy,
    float* hue,
    int n,
    float cx,
    float cy,
    float baseSpeed,
    float wobble,
    unsigned long long frame) {
    int i = blockIdx.x * blockDim.x + threadIdx.x;
    if (i >= n) return;

    float dx = cx - x[i];
    float dy = cy - y[i];
    float len = sqrtf(dx * dx + dy * dy) + 0.0001f;
    float swirl = sinf((float)i * 0.017f + (float)(frame % 997ULL) * 0.025f);
    const float direction = FLOW_DIRECTION; // SYNTHI_HMR_DIRECTION_TOKEN
    float ax = direction * dx / len * baseSpeed + (-dy / len) * wobble * swirl;
    float ay = direction * dy / len * baseSpeed + ( dx / len) * wobble * swirl;

    vx[i] = vx[i] * 0.84f + ax * 0.16f;
    vy[i] = vy[i] * 0.84f + ay * 0.16f;
    x[i] += vx[i];
    y[i] += vy[i];

    float ox = x[i] - cx;
    float oy = y[i] - cy;
    float radius = sqrtf(ox * ox + oy * oy);
    float theta = 2.39996323f * (float)i + 0.011f * (float)(frame % 389ULL);
    if (direction > 0.0f && radius < 18.0f) {
        float rr = 330.0f + (float)((i * 29) % 70);
        x[i] = cx + cosf(theta) * rr;
        y[i] = cy + sinf(theta) * rr;
        vx[i] *= -0.15f;
        vy[i] *= -0.15f;
    }
    if (direction < 0.0f && radius > 420.0f) {
        float rr = 24.0f + (float)((i * 13) % 38);
        x[i] = cx + cosf(theta) * rr;
        y[i] = cy + sinf(theta) * rr;
        vx[i] = -vx[i] * 0.25f;
        vy[i] = -vy[i] * 0.25f;
    }
    hue[i] = wrap_unit(hue[i] + 0.0015f + 0.0009f * swirl);
}

extern "C" __global__ void cool_hue(float* hue, int n, float amount) {
    int i = blockIdx.x * blockDim.x + threadIdx.x;
    if (i >= n) return;
    hue[i] = wrap_unit(hue[i] - amount + 0.00003f * (float)((i * 17) % 31));
}

static void seed(float* x, float* y, float* vx, float* vy, float* hue) {
    for (int i = 0; i < BALLS; ++i) {
        float theta = 2.39996323f * (float)i;
        float radius = 230.0f + (float)((i * 37) % 130);
        x[i] = WIDTH * 0.5f + cosf(theta) * radius;
        y[i] = HEIGHT * 0.5f + sinf(theta) * radius;
        vx[i] = -sinf(theta) * 0.65f;
        vy[i] =  cosf(theta) * 0.65f;
        hue[i] = (float)((i * 23) % 360) / 360.0f;
    }
}

static void color(float h, unsigned char& r, unsigned char& g, unsigned char& b) {
    h = h - floorf(h);
    float x = 1.0f - fabsf(fmodf(h * 6.0f, 2.0f) - 1.0f);
    float rr = 0.0f, gg = 0.0f, bb = 0.0f;
    if (h < 1.0f / 6.0f) { rr = 1.0f; gg = x; }
    else if (h < 2.0f / 6.0f) { rr = x; gg = 1.0f; }
    else if (h < 3.0f / 6.0f) { gg = 1.0f; bb = x; }
    else if (h < 4.0f / 6.0f) { gg = x; bb = 1.0f; }
    else if (h < 5.0f / 6.0f) { rr = x; bb = 1.0f; }
    else { rr = 1.0f; bb = x; }
    r = (unsigned char)(32.0f + rr * 210.0f);
    g = (unsigned char)(40.0f + gg * 190.0f);
    b = (unsigned char)(48.0f + bb * 180.0f);
}

int main(int, char**) {
    SDL_Init(SDL_INIT_VIDEO);
    SDL_Window* window = SDL_CreateWindow("Synthi Agent Complex GPU Split", SDL_WINDOWPOS_CENTERED, SDL_WINDOWPOS_CENTERED, WIDTH, HEIGHT, 0);
    SDL_Renderer* renderer = SDL_CreateRenderer(window, -1, SDL_RENDERER_ACCELERATED);

    float hostX[BALLS];
    float hostY[BALLS];
    float hostVX[BALLS];
    float hostVY[BALLS];
    float hostHue[BALLS];
    seed(hostX, hostY, hostVX, hostVY, hostHue);

    float* deviceX = nullptr;
    float* deviceY = nullptr;
    float* deviceVX = nullptr;
    float* deviceVY = nullptr;
    float* deviceHue = nullptr;
    ${api.malloc}(&deviceX, sizeof(float) * BALLS);
    ${api.malloc}(&deviceY, sizeof(float) * BALLS);
    ${api.malloc}(&deviceVX, sizeof(float) * BALLS);
    ${api.malloc}(&deviceVY, sizeof(float) * BALLS);
    ${api.malloc}(&deviceHue, sizeof(float) * BALLS);
    ${api.memcpy}(deviceX, hostX, sizeof(float) * BALLS, ${api.h2d});
    ${api.memcpy}(deviceY, hostY, sizeof(float) * BALLS, ${api.h2d});
    ${api.memcpy}(deviceVX, hostVX, sizeof(float) * BALLS, ${api.h2d});
    ${api.memcpy}(deviceVY, hostVY, sizeof(float) * BALLS, ${api.h2d});
    ${api.memcpy}(deviceHue, hostHue, sizeof(float) * BALLS, ${api.h2d});

    bool running = true;
    unsigned long long frame = 0;
    while (running) {
        SDL_Event event;
        while (SDL_PollEvent(&event)) {
            if (event.type == SDL_QUIT) running = false;
        }

        dim3 block(256);
        dim3 grid((BALLS + block.x - 1) / block.x);
        particle_flow<<<grid, block>>>(deviceX, deviceY, deviceVX, deviceVY, deviceHue,
                                       BALLS, WIDTH * 0.5f, HEIGHT * 0.5f,
                                       2.55f, 1.85f, frame++);
        cool_hue<<<grid, block>>>(deviceHue, BALLS, 0.0007f);
        ${api.sync}();
        ${api.memcpy}(hostX, deviceX, sizeof(float) * BALLS, ${api.d2h});
        ${api.memcpy}(hostY, deviceY, sizeof(float) * BALLS, ${api.d2h});
        ${api.memcpy}(hostHue, deviceHue, sizeof(float) * BALLS, ${api.d2h});

        SDL_SetRenderDrawColor(renderer, 6, 8, 16, 255);
        SDL_RenderClear(renderer);
        for (int i = 0; i < BALLS; ++i) {
            unsigned char r = 0, g = 0, b = 0;
            color(hostHue[i], r, g, b);
            SDL_SetRenderDrawColor(renderer, r, g, b, 255);
            SDL_Rect rect{(int)hostX[i], (int)hostY[i], 3, 3};
            SDL_RenderFillRect(renderer, &rect);
        }
        SDL_RenderPresent(renderer);
        if ((frame % 150ULL) == 0ULL) {
            std::fprintf(stderr, "[user-gpu-complex-flow] frame=%llu hue0=%.3f\\n", frame, hostHue[0]);
        }
    }

    ${api.free}(deviceX);
    ${api.free}(deviceY);
    ${api.free}(deviceVX);
    ${api.free}(deviceVY);
    ${api.free}(deviceHue);
    SDL_DestroyRenderer(renderer);
    SDL_DestroyWindow(window);
    SDL_Quit();
    return 0;
}
`;
}

function realisticRaytraceSource(vendor) {
  const api = runtimeApi(vendor);
  const target = vendor === 'rocm' ? 'rocm' : 'cuda';
  return `// User-authored single-file GPU realistic ray-tracing visual app.
// Deterministic validation fixture: fixed camera, fixed scene, fixed lights,
// no temporal accumulation, and GPU-rendered framebuffer pixels.
// GPU_TARGET: ${target}
// LINK: -lSDL2 ${api.link}
// BUILD: ${api.build} main.cpp -lSDL2 ${api.link}
#include <SDL2/SDL.h>
${runtimeInclude(vendor)}
#include <cmath>
#include <cstdio>
#include <cstdlib>

constexpr int WIDTH = 800;
constexpr int HEIGHT = 600;
constexpr int PIXEL_COUNT = WIDTH * HEIGHT;
constexpr float PI = 3.14159265358979323846f;

struct Vec3 {
    float x;
    float y;
    float z;
};

struct Hit {
    float t;
    Vec3 p;
    Vec3 n;
    int material;
    float id;
};

__device__ Vec3 make3(float x, float y, float z) { return Vec3{x, y, z}; }
__device__ Vec3 add3(Vec3 a, Vec3 b) { return make3(a.x + b.x, a.y + b.y, a.z + b.z); }
__device__ Vec3 sub3(Vec3 a, Vec3 b) { return make3(a.x - b.x, a.y - b.y, a.z - b.z); }
__device__ Vec3 mul3(Vec3 a, float s) { return make3(a.x * s, a.y * s, a.z * s); }
__device__ Vec3 hadamard3(Vec3 a, Vec3 b) { return make3(a.x * b.x, a.y * b.y, a.z * b.z); }
__device__ float dot3(Vec3 a, Vec3 b) { return a.x * b.x + a.y * b.y + a.z * b.z; }
__device__ Vec3 cross3(Vec3 a, Vec3 b) {
    return make3(a.y * b.z - a.z * b.y, a.z * b.x - a.x * b.z, a.x * b.y - a.y * b.x);
}
__device__ float clampf(float v, float lo, float hi) { return fminf(hi, fmaxf(lo, v)); }
__device__ float fract1(float v) { return v - floorf(v); }
__device__ float smooth01(float v) {
    v = clampf(v, 0.0f, 1.0f);
    return v * v * (3.0f - 2.0f * v);
}
__device__ Vec3 clamp3(Vec3 v, float lo, float hi) {
    return make3(clampf(v.x, lo, hi), clampf(v.y, lo, hi), clampf(v.z, lo, hi));
}
__device__ Vec3 normalize3(Vec3 v) {
    float inv = rsqrtf(fmaxf(dot3(v, v), 0.0000001f));
    return mul3(v, inv);
}
__device__ Vec3 reflect3(Vec3 i, Vec3 n) { return sub3(i, mul3(n, 2.0f * dot3(i, n))); }
__device__ Vec3 mix3(Vec3 a, Vec3 b, float t) { return add3(mul3(a, 1.0f - t), mul3(b, t)); }

__device__ Vec3 refract3(Vec3 i, Vec3 n, float eta) {
    float cosi = clampf(-dot3(i, n), -1.0f, 1.0f);
    float sint2 = eta * eta * fmaxf(0.0f, 1.0f - cosi * cosi);
    if (sint2 > 1.0f) return reflect3(i, n);
    float cost = sqrtf(fmaxf(0.0f, 1.0f - sint2));
    return normalize3(add3(mul3(i, eta), mul3(n, eta * cosi - cost)));
}

__device__ unsigned int packColor(Vec3 c) {
    c = make3(fmaxf(0.0f, c.x), fmaxf(0.0f, c.y), fmaxf(0.0f, c.z));
    c = make3(
        (c.x * (2.51f * c.x + 0.03f)) / (c.x * (2.43f * c.x + 0.59f) + 0.14f),
        (c.y * (2.51f * c.y + 0.03f)) / (c.y * (2.43f * c.y + 0.59f) + 0.14f),
        (c.z * (2.51f * c.z + 0.03f)) / (c.z * (2.43f * c.z + 0.59f) + 0.14f)
    );
    c = clamp3(c, 0.0f, 1.0f);
    c = make3(powf(c.x, 1.0f / 2.2f), powf(c.y, 1.0f / 2.2f), powf(c.z, 1.0f / 2.2f));
    unsigned int r = (unsigned int)(c.x * 255.0f + 0.5f);
    unsigned int g = (unsigned int)(c.y * 255.0f + 0.5f);
    unsigned int b = (unsigned int)(c.z * 255.0f + 0.5f);
    return 0xff000000u | (r << 16) | (g << 8) | b;
}

__device__ Vec3 environmentColor(Vec3 rd) {
    float up = clampf(rd.y * 0.5f + 0.5f, 0.0f, 1.0f);
    Vec3 sky = mix3(make3(0.54f, 0.61f, 0.67f), make3(0.90f, 0.94f, 1.0f), up);
    float cityBand = smooth01(clampf((0.18f - rd.y) / 0.22f, 0.0f, 1.0f));
    Vec3 city = make3(0.34f + 0.05f * sinf(rd.x * 31.0f), 0.35f, 0.34f);
    float sun = powf(fmaxf(0.0f, dot3(rd, normalize3(make3(-0.35f, 0.62f, -0.28f)))), 180.0f);
    return add3(mix3(sky, city, cityBand * 0.26f), mul3(make3(1.0f, 0.86f, 0.55f), sun * 2.4f));
}

__device__ Vec3 rotateY(Vec3 p, float angle) {
    float c = cosf(angle);
    float s = sinf(angle);
    return make3(p.x * c - p.z * s, p.y, p.x * s + p.z * c);
}

__device__ bool clipDiamondPlane(
    Vec3 ro,
    Vec3 rd,
    Vec3 planeN,
    float planeD,
    float& tEnter,
    float& tExit,
    Vec3& enterNormal,
    Vec3& exitNormal
) {
    float denom = dot3(planeN, rd);
    float dist = planeD - dot3(planeN, ro);
    if (fabsf(denom) < 0.000001f) {
        return dist >= 0.0f;
    }
    float tPlane = dist / denom;
    Vec3 n = normalize3(planeN);
    if (denom < 0.0f) {
        if (tPlane > tEnter) {
            tEnter = tPlane;
            enterNormal = n;
        }
    } else {
        if (tPlane < tExit) {
            tExit = tPlane;
            exitNormal = n;
        }
    }
    return tEnter <= tExit;
}

__device__ bool intersectDiamond(Vec3 ro, Vec3 rd, Vec3 center, float scale, float rotation, float& t, Vec3& normal) {
    Vec3 lo = mul3(rotateY(sub3(ro, center), -rotation), 1.0f / scale);
    Vec3 ld = mul3(rotateY(rd, -rotation), 1.0f / scale);
    float tEnter = -1.0e20f;
    float tExit = 1.0e20f;
    Vec3 enterNormal = make3(0.0f, 1.0f, 0.0f);
    Vec3 exitNormal = make3(0.0f, -1.0f, 0.0f);

    const float tableY = 0.38f;
    const float bottomY = -0.90f;
    const float girdleRadius = 0.86f;
    const float tableRadius = 0.30f;
    const float crownSlope = (tableRadius - girdleRadius) / tableY;
    const float pavilionSlope = girdleRadius / (0.0f - bottomY);

    if (!clipDiamondPlane(lo, ld, make3(0.0f, 1.0f, 0.0f), tableY, tEnter, tExit, enterNormal, exitNormal)) return false;
    for (int i = 0; i < 16; ++i) {
        float a = ((float)i + 0.5f) * (2.0f * PI / 16.0f);
        Vec3 h = make3(cosf(a), 0.0f, sinf(a));
        Vec3 crownN = make3(h.x, -crownSlope, h.z);
        Vec3 pavilionN = make3(h.x, -pavilionSlope, h.z);
        if (!clipDiamondPlane(lo, ld, crownN, girdleRadius, tEnter, tExit, enterNormal, exitNormal)) return false;
        if (!clipDiamondPlane(lo, ld, pavilionN, -pavilionSlope * bottomY, tEnter, tExit, enterNormal, exitNormal)) return false;
    }

    t = tEnter > 0.02f ? tEnter : tExit;
    if (t <= 0.02f || t > 1.0e19f) return false;
    Vec3 n = tEnter > 0.02f ? enterNormal : mul3(exitNormal, -1.0f);
    normal = normalize3(rotateY(n, rotation));
    return true;
}

__device__ bool intersectEllipsoid(Vec3 ro, Vec3 rd, Vec3 center, Vec3 radius, float& t, Vec3& normal) {
    Vec3 oc = sub3(ro, center);
    Vec3 qro = make3(oc.x / radius.x, oc.y / radius.y, oc.z / radius.z);
    Vec3 qrd = make3(rd.x / radius.x, rd.y / radius.y, rd.z / radius.z);
    float a = dot3(qrd, qrd);
    float b = 2.0f * dot3(qro, qrd);
    float c = dot3(qro, qro) - 1.0f;
    float disc = b * b - 4.0f * a * c;
    if (disc < 0.0f) return false;
    float root = sqrtf(disc);
    float invDenom = 0.5f / a;
    float t0 = (-b - root) * invDenom;
    float t1 = (-b + root) * invDenom;
    t = t0 > 0.02f ? t0 : t1;
    if (t <= 0.02f) return false;
    Vec3 p = add3(ro, mul3(rd, t));
    Vec3 lp = sub3(p, center);
    normal = normalize3(make3(
        lp.x / (radius.x * radius.x),
        lp.y / (radius.y * radius.y),
        lp.z / (radius.z * radius.z)
    ));
    return true;
}

__device__ bool clipBoxAxis(
    float origin,
    float dir,
    float mn,
    float mx,
    Vec3 negN,
    Vec3 posN,
    float& tEnter,
    float& tExit,
    Vec3& enterNormal,
    Vec3& exitNormal
) {
    if (fabsf(dir) < 0.000001f) return origin >= mn && origin <= mx;
    float t0 = (mn - origin) / dir;
    float t1 = (mx - origin) / dir;
    Vec3 n0 = negN;
    Vec3 n1 = posN;
    if (t0 > t1) {
        float tmp = t0; t0 = t1; t1 = tmp;
        Vec3 nt = n0; n0 = n1; n1 = nt;
    }
    if (t0 > tEnter) {
        tEnter = t0;
        enterNormal = n0;
    }
    if (t1 < tExit) {
        tExit = t1;
        exitNormal = n1;
    }
    return tEnter <= tExit;
}

__device__ bool intersectBox(Vec3 ro, Vec3 rd, Vec3 bmin, Vec3 bmax, float& t, Vec3& normal) {
    float tEnter = -1.0e20f;
    float tExit = 1.0e20f;
    Vec3 enterNormal = make3(0.0f, 1.0f, 0.0f);
    Vec3 exitNormal = make3(0.0f, -1.0f, 0.0f);
    if (!clipBoxAxis(ro.x, rd.x, bmin.x, bmax.x, make3(-1.0f, 0.0f, 0.0f), make3(1.0f, 0.0f, 0.0f), tEnter, tExit, enterNormal, exitNormal)) return false;
    if (!clipBoxAxis(ro.y, rd.y, bmin.y, bmax.y, make3(0.0f, -1.0f, 0.0f), make3(0.0f, 1.0f, 0.0f), tEnter, tExit, enterNormal, exitNormal)) return false;
    if (!clipBoxAxis(ro.z, rd.z, bmin.z, bmax.z, make3(0.0f, 0.0f, -1.0f), make3(0.0f, 0.0f, 1.0f), tEnter, tExit, enterNormal, exitNormal)) return false;
    t = tEnter > 0.02f ? tEnter : tExit;
    if (t <= 0.02f || t > 1.0e19f) return false;
    normal = normalize3(tEnter > 0.02f ? enterNormal : mul3(exitNormal, -1.0f));
    return true;
}

__device__ void acceptHit(Hit& hit, bool& found, Vec3 ro, Vec3 rd, float t, Vec3 n, int material, float id) {
    if (t > 0.02f && t < hit.t) {
        hit.t = t;
        hit.p = add3(ro, mul3(rd, t));
        hit.n = n;
        hit.material = material;
        hit.id = id;
        found = true;
    }
}

__device__ bool sceneHit(Vec3 ro, Vec3 rd, float sceneLight, Hit& hit, bool includeGround) {
    bool found = false;
    hit.t = 1.0e20f;
    if (includeGround && fabsf(rd.y) > 0.0001f) {
        float t = -ro.y / rd.y;
        if (t > 0.02f && t < hit.t) {
            hit.t = t;
            hit.p = add3(ro, mul3(rd, t));
            hit.n = make3(0.0f, 1.0f, 0.0f);
            hit.material = 0;
            hit.id = 0.0f;
            found = true;
        }
    }

    if (fabsf(rd.z) > 0.0001f) {
        const float wallZ = -3.15f;
        float wallT = (wallZ - ro.z) / rd.z;
        if (wallT > 0.02f && wallT < hit.t) {
            Vec3 wallP = add3(ro, mul3(rd, wallT));
            if (wallP.y >= 0.0f && wallP.y <= 2.45f && fabsf(wallP.x) <= 3.75f) {
                acceptHit(hit, found, ro, rd, wallT, make3(0.0f, 0.0f, 1.0f), 3, 30.0f);
            }
        }
    }

    float boxT = 0.0f;
    Vec3 boxN = make3(0.0f, 1.0f, 0.0f);
    if (intersectBox(ro, rd, make3(-3.10f, 1.34f, -3.06f), make3(-0.18f, 1.60f, -2.50f), boxT, boxN)) {
        acceptHit(hit, found, ro, rd, boxT, boxN, 7, 70.0f);
    }
    if (intersectBox(ro, rd, make3(-3.12f, 0.42f, -2.94f), make3(-2.42f, 0.70f, -2.45f), boxT, boxN)) {
        acceptHit(hit, found, ro, rd, boxT, boxN, 8, 80.0f);
    }
    if (intersectBox(ro, rd, make3(-1.58f, 0.46f, -2.86f), make3(-0.92f, 0.72f, -2.45f), boxT, boxN)) {
        acceptHit(hit, found, ro, rd, boxT, boxN, 8, 81.0f);
    }
    if (intersectBox(ro, rd, make3(-0.88f, 0.05f, -1.82f), make3(-0.36f, 0.11f, -1.30f), boxT, boxN)) {
        acceptHit(hit, found, ro, rd, boxT, boxN, 11, 110.0f);
    }
    if (intersectBox(ro, rd, make3(-1.26f, 0.10f, -1.74f), make3(-1.18f, 0.46f, -1.66f), boxT, boxN)) {
        acceptHit(hit, found, ro, rd, boxT, boxN, 11, 111.0f);
    }
    if (intersectBox(ro, rd, make3(-0.16f, 0.08f, -1.58f), make3(-0.06f, 0.42f, -1.48f), boxT, boxN)) {
        acceptHit(hit, found, ro, rd, boxT, boxN, 11, 112.0f);
    }
    if (intersectBox(ro, rd, make3(0.82f, 0.0f, -2.82f), make3(0.96f, 1.50f, -2.68f), boxT, boxN)) {
        acceptHit(hit, found, ro, rd, boxT, boxN, 10, 100.0f);
    }
    if (intersectBox(ro, rd, make3(0.58f, 1.42f, -2.96f), make3(1.20f, 1.56f, -2.54f), boxT, boxN)) {
        acceptHit(hit, found, ro, rd, boxT, boxN, 10, 101.0f);
    }
    if (intersectBox(ro, rd, make3(0.26f, 0.0f, -0.82f), make3(0.34f, 0.48f, -0.74f), boxT, boxN)) {
        acceptHit(hit, found, ro, rd, boxT, boxN, 10, 102.0f);
    }
    if (intersectBox(ro, rd, make3(-2.38f, 0.0f, -0.92f), make3(-2.30f, 0.48f, -0.84f), boxT, boxN)) {
        acceptHit(hit, found, ro, rd, boxT, boxN, 10, 103.0f);
    }

    for (int bulb = 0; bulb < 11; ++bulb) {
        float bx = -2.96f + (float)bulb * 0.56f;
        float by = 1.70f + 0.08f * sinf((float)bulb * 0.93f);
        float bz = -2.22f + 0.10f * sinf((float)bulb * 1.41f);
        float bulbT = 0.0f;
        Vec3 bulbN = make3(0.0f, 1.0f, 0.0f);
        if (intersectEllipsoid(ro, rd, make3(bx, by, bz), make3(0.035f, 0.035f, 0.035f), bulbT, bulbN) && bulbT < hit.t) {
            hit.t = bulbT;
            hit.p = add3(ro, mul3(rd, bulbT));
            hit.n = bulbN;
            hit.material = 12;
            hit.id = 120.0f + (float)bulb;
            found = true;
        }
    }

    float carT = 0.0f;
    Vec3 carN = make3(0.0f, 1.0f, 0.0f);
    if (intersectEllipsoid(ro, rd, make3(1.84f, 0.28f, -0.86f), make3(0.76f, 0.22f, 0.34f), carT, carN) && carT < hit.t) {
        hit.t = carT;
        hit.p = add3(ro, mul3(rd, carT));
        hit.n = carN;
        hit.material = 4;
        hit.id = 40.0f;
        found = true;
    }
    if (intersectEllipsoid(ro, rd, make3(1.70f, 0.47f, -0.90f), make3(0.36f, 0.13f, 0.23f), carT, carN) && carT < hit.t) {
        hit.t = carT;
        hit.p = add3(ro, mul3(rd, carT));
        hit.n = carN;
        hit.material = 6;
        hit.id = 42.0f;
        found = true;
    }
    for (int wheel = 0; wheel < 2; ++wheel) {
        float wx = wheel == 0 ? 1.38f : 2.28f;
        if (intersectEllipsoid(ro, rd, make3(wx, 0.13f, -0.57f), make3(0.15f, 0.15f, 0.08f), carT, carN) && carT < hit.t) {
            hit.t = carT;
            hit.p = add3(ro, mul3(rd, carT));
            hit.n = carN;
            hit.material = 5;
            hit.id = 41.0f + (float)wheel;
            found = true;
        }
    }

    float t = 0.0f;
    Vec3 n = make3(0.0f, 1.0f, 0.0f);
    Vec3 mainGem = make3(0.0f, 0.78f, -0.16f);
    if (intersectDiamond(ro, rd, mainGem, 1.02f, -0.18f, t, n) && t < hit.t) {
        hit.t = t;
        hit.p = add3(ro, mul3(rd, t));
        hit.n = n;
        hit.material = 1;
        hit.id = 1.0f;
        found = true;
    }

    for (int i = 0; i < 22; ++i) {
        float a = (float)i * 2.39996323f;
        float ring = 1.12f + 0.24f * (float)(i % 3);
        Vec3 center = make3(cosf(a) * ring, 0.105f, -0.18f + sinf(a) * 0.76f);
        float radius = 0.105f + 0.020f * (float)(i % 4);
        if (intersectDiamond(ro, rd, center, radius, a * 0.37f, t, n) && t < hit.t) {
            hit.t = t;
            hit.p = add3(ro, mul3(rd, t));
            hit.n = n;
            hit.material = 2;
            hit.id = (float)i + 2.0f;
            found = true;
        }
    }
    return found;
}

__device__ float shadowFactor(Vec3 p, Vec3 lightDir, float sceneLight) {
    Hit h;
    Vec3 start = add3(p, mul3(lightDir, 0.035f));
    if (!sceneHit(start, lightDir, sceneLight, h, false)) return 1.0f;
    return h.t < 3.5f ? 0.34f : 1.0f;
}

__device__ Vec3 secondarySurfaceTint(Hit hit) {
    if (hit.material == 0) return make3(0.42f, 0.44f, 0.42f);
    if (hit.material == 1 || hit.material == 2) return make3(0.86f, 0.94f, 1.0f);
    if (hit.material == 3) return make3(0.46f, 0.43f, 0.36f);
    if (hit.material == 4) return make3(0.05f, 0.06f, 0.07f);
    if (hit.material == 5) return make3(0.02f, 0.018f, 0.016f);
    if (hit.material == 6) return make3(0.16f, 0.24f, 0.30f);
    if (hit.material == 7) return make3(0.66f, 0.09f, 0.06f);
    if (hit.material == 8) return make3(0.10f, 0.30f, 0.12f);
    if (hit.material == 10) return make3(0.20f, 0.21f, 0.22f);
    if (hit.material == 11) return make3(0.42f, 0.22f, 0.09f);
    if (hit.material == 12) return make3(2.2f, 1.72f, 0.86f);
    return make3(0.40f, 0.40f, 0.40f);
}

__device__ Vec3 tracedSecondaryColor(Vec3 p, Vec3 rd, float sceneLight) {
    Hit h;
    Vec3 start = add3(p, mul3(rd, 0.050f));
    if (!sceneHit(start, rd, sceneLight, h, false)) {
        return environmentColor(rd);
    }
    float falloff = expf(-h.t * 0.16f);
    return mix3(environmentColor(rd), secondarySurfaceTint(h), falloff);
}

__device__ Vec3 shade(Vec3 ro, Vec3 rd, Hit hit, float sceneLight);

__device__ Vec3 cameraRayColor(float px, float py, int width, int height, float sceneLight, float exposure) {
    float aspect = (float)width / (float)height;
    float rigIsWarm = sceneLight >= 0.0f ? 1.0f : 0.0f;
    float rigExposure = sceneLight >= 0.0f ? (0.88f + 0.10f * clampf(sceneLight, 0.0f, 2.5f)) : 0.48f;
    Vec3 rigColorGrade = mix3(make3(0.58f, 0.70f, 1.02f), make3(1.05f, 0.99f, 0.88f), rigIsWarm);

    Vec3 eye = make3(-0.28f, 0.92f, 3.18f);
    Vec3 target = make3(0.04f, 0.52f, -0.30f);
    Vec3 forward = normalize3(sub3(target, eye));
    Vec3 right = normalize3(cross3(forward, make3(0.0f, 1.0f, 0.0f)));
    Vec3 up = normalize3(cross3(right, forward));
    float lens = tanf(25.0f * PI / 180.0f);
    Vec3 rd = normalize3(add3(forward, add3(mul3(right, (px * 2.0f - 1.0f) * aspect * lens), mul3(up, (1.0f - py * 2.0f) * lens))));

    Hit hit;
    Vec3 color = environmentColor(rd);
    if (sceneHit(eye, rd, sceneLight, hit, true)) {
        color = shade(eye, rd, hit, sceneLight);
        float fog = expf(-hit.t * 0.010f);
        color = mix3(make3(0.60f, 0.64f, 0.66f), color, fog);
    }

    float vignette = px * (1.0f - px) * py * (1.0f - py) * 16.0f;
    color = hadamard3(color, rigColorGrade);
    return mul3(color, exposure * rigExposure * (0.72f + 0.28f * clampf(vignette, 0.0f, 1.0f)));
}

__device__ Vec3 shade(Vec3 ro, Vec3 rd, Hit hit, float sceneLight) {
    Vec3 lightDir = normalize3(make3(-0.42f * sceneLight, 0.88f, -0.34f));
    Vec3 viewDir = mul3(rd, -1.0f);
    if (hit.material == 0) {
        float veinA = 0.5f + 0.5f * sinf(hit.p.x * 7.2f + sinf(hit.p.z * 3.6f) * 2.4f);
        float veinB = 0.5f + 0.5f * sinf(hit.p.z * 9.1f + hit.p.x * 1.7f);
        float marble = powf(clampf(veinA * 0.72f + veinB * 0.28f, 0.0f, 1.0f), 5.0f);
        float seamX = fabsf(fract1(hit.p.x * 0.46f) - 0.5f);
        float seamZ = fabsf(fract1((hit.p.z + 0.36f) * 0.46f) - 0.5f);
        float grout = 1.0f - smooth01(clampf((fminf(seamX, seamZ) - 0.018f) / 0.050f, 0.0f, 1.0f));
        Vec3 base = mix3(make3(0.30f, 0.33f, 0.34f), make3(0.62f, 0.65f, 0.64f), 0.18f + marble * 0.48f);
        base = mix3(base, make3(0.12f, 0.13f, 0.14f), grout * 0.46f);
        float leafScatter = smooth01(sinf(hit.p.x * 13.7f + hit.p.z * 19.1f) * 0.5f + 0.5f)
            * smooth01(sinf(hit.p.x * 29.0f - hit.p.z * 7.0f) * 0.5f + 0.5f);
        if (hit.p.x > 0.7f && hit.p.z < -0.42f && leafScatter > 0.74f) {
            base = mix3(base, make3(0.72f, 0.46f, 0.10f), 0.58f);
        }
        float wet = powf(fmaxf(0.0f, dot3(reflect3(mul3(lightDir, -1.0f), hit.n), viewDir)), 80.0f);
        float diffuse = fmaxf(0.0f, dot3(hit.n, lightDir)) * shadowFactor(hit.p, lightDir, sceneLight);
        Vec3 refl = tracedSecondaryColor(hit.p, reflect3(rd, hit.n), sceneLight);
        Vec3 color = add3(mul3(base, 0.22f + diffuse * 0.66f), mul3(refl, 0.24f));
        color = add3(color, mul3(make3(1.0f, 0.92f, 0.72f), wet * 0.85f));
        float caustic = expf(-fabsf(hit.p.x) * 2.4f) * expf(-fabsf(hit.p.z + 0.05f) * 1.3f);
        color = add3(color, mul3(make3(0.60f, 0.82f, 1.0f), caustic * (0.18f + 0.10f * sceneLight)));
        return color;
    }

    if (hit.material == 3) {
        float x = hit.p.x;
        float y = hit.p.y;
        float brickA = 0.5f + 0.5f * sinf(x * 12.0f + floorf(y * 8.0f) * 0.73f);
        float brickB = 0.5f + 0.5f * sinf((x + y) * 21.0f);
        Vec3 wall = mix3(make3(0.36f, 0.35f, 0.31f), make3(0.58f, 0.54f, 0.46f), 0.32f + 0.24f * brickA);
        float mortarX = 1.0f - smooth01(clampf((fabsf(fract1(x * 2.6f) - 0.5f) - 0.43f) / 0.06f, 0.0f, 1.0f));
        float mortarY = 1.0f - smooth01(clampf((fabsf(fract1(y * 8.0f) - 0.5f) - 0.43f) / 0.06f, 0.0f, 1.0f));
        wall = mix3(wall, make3(0.20f, 0.20f, 0.18f), clampf(mortarX + mortarY, 0.0f, 1.0f) * 0.25f);

        if (y > 0.72f && y < 1.46f && x > -2.95f && x < -1.55f) {
            float pane = 0.5f + 0.5f * sinf(x * 38.0f + y * 22.0f);
            wall = mix3(make3(0.05f, 0.09f, 0.09f), make3(0.82f, 0.55f, 0.34f), 0.32f + 0.36f * pane);
        }
        if (y > 0.70f && y < 1.52f && x > -1.08f && x < -0.18f) {
            wall = mix3(make3(0.04f, 0.08f, 0.08f), make3(0.75f, 0.48f, 0.28f), 0.42f + 0.20f * brickB);
        }
        if (y > 1.48f && y < 1.68f && x > -3.15f && x < -0.05f) {
            wall = make3(0.64f, 0.08f, 0.07f);
        }
        if (y > 1.36f && y < 1.47f && x > -1.85f && x < -0.78f) {
            wall = make3(0.12f, 0.22f, 0.16f);
        }
        if (y > 0.95f && y < 2.24f && x > 1.18f && x < 2.92f) {
            float arch = smooth01(1.0f - fabsf(x - 2.05f) / 0.90f);
            float stone = 0.42f + 0.28f * sinf((x * 9.0f + y * 6.0f));
            wall = mix3(wall, make3(0.48f, 0.47f, 0.43f), arch * stone);
        }
        float leaf = (0.5f + 0.5f * sinf(x * 33.0f + y * 47.0f)) * smooth01(clampf((y - 0.52f) / 1.3f, 0.0f, 1.0f));
        if (x < -3.03f && leaf > 0.38f) {
            wall = mix3(wall, make3(0.05f, 0.28f, 0.12f), 0.72f);
        }
        float diffuse = fmaxf(0.0f, dot3(hit.n, lightDir)) * 0.55f + 0.34f;
        return mul3(wall, diffuse);
    }

    if (hit.material == 4 || hit.material == 5 || hit.material == 6) {
        Vec3 reflected = tracedSecondaryColor(hit.p, reflect3(rd, hit.n), sceneLight);
        float spec = powf(fmaxf(0.0f, dot3(reflect3(mul3(lightDir, -1.0f), hit.n), viewDir)), hit.material == 5 ? 32.0f : 110.0f);
        float diffuse = fmaxf(0.0f, dot3(hit.n, lightDir)) * 0.30f + 0.18f;
        if (hit.material == 5) {
            return add3(mul3(make3(0.015f, 0.014f, 0.013f), diffuse + 0.28f), mul3(make3(0.70f, 0.03f, 0.02f), spec * 0.35f));
        }
        if (hit.material == 6) {
            Vec3 glass = mix3(make3(0.07f, 0.12f, 0.16f), reflected, 0.58f);
            return add3(mul3(glass, diffuse + 0.42f), mul3(make3(0.70f, 0.90f, 1.0f), spec * 0.65f));
        }
        Vec3 body = mix3(make3(0.018f, 0.020f, 0.022f), reflected, 0.46f);
        body = add3(mul3(body, diffuse + 0.26f), mul3(make3(1.0f, 0.18f, 0.10f), spec * 0.45f));
        return body;
    }

    if (hit.material == 7) {
        float stripe = fract1(hit.p.x * 3.6f + hit.p.z * 1.4f);
        Vec3 fabric = stripe < 0.52f ? make3(0.54f, 0.035f, 0.025f) : make3(0.78f, 0.18f, 0.14f);
        float diffuse = fmaxf(0.0f, dot3(hit.n, lightDir)) * 0.46f + 0.30f;
        float weave = 0.88f + 0.12f * sinf(hit.p.x * 48.0f + hit.p.y * 19.0f);
        return mul3(fabric, diffuse * weave);
    }

    if (hit.material == 8) {
        float leaf = 0.5f + 0.5f * sinf(hit.p.x * 57.0f + hit.p.y * 83.0f + hit.p.z * 31.0f);
        Vec3 green = mix3(make3(0.03f, 0.17f, 0.07f), make3(0.30f, 0.48f, 0.18f), leaf);
        float diffuse = fmaxf(0.0f, dot3(hit.n, lightDir)) * 0.52f + 0.34f;
        return mul3(green, diffuse);
    }

    if (hit.material == 10) {
        Vec3 reflected = tracedSecondaryColor(hit.p, reflect3(rd, hit.n), sceneLight);
        float spec = powf(fmaxf(0.0f, dot3(reflect3(mul3(lightDir, -1.0f), hit.n), viewDir)), 96.0f);
        Vec3 metal = mix3(make3(0.05f, 0.055f, 0.06f), reflected, 0.38f);
        return add3(metal, mul3(make3(1.0f, 0.92f, 0.75f), spec * 0.70f));
    }

    if (hit.material == 11) {
        float grain = 0.5f + 0.5f * sinf(hit.p.x * 24.0f + hit.p.z * 37.0f);
        Vec3 wood = mix3(make3(0.25f, 0.12f, 0.055f), make3(0.58f, 0.31f, 0.13f), grain);
        float diffuse = fmaxf(0.0f, dot3(hit.n, lightDir)) * 0.58f + 0.28f;
        return mul3(wood, diffuse);
    }

    if (hit.material == 12) {
        float halo = powf(fmaxf(0.0f, dot3(hit.n, viewDir)), 3.0f);
        return add3(make3(1.85f, 1.32f, 0.62f), mul3(make3(1.0f, 0.74f, 0.28f), halo * 2.2f));
    }

    float eta = hit.material == 1 ? 1.0f / (1.47f + sceneLight * 0.035f) : 1.0f / 1.39f;
    Vec3 reflected = tracedSecondaryColor(hit.p, reflect3(rd, hit.n), sceneLight);
    Vec3 refracted = tracedSecondaryColor(hit.p, refract3(rd, hit.n, eta), sceneLight);
    float fresnel = powf(1.0f - fmaxf(0.0f, dot3(hit.n, viewDir)), 5.0f);
    float facetA = fmaxf(0.0f, dot3(hit.n, normalize3(make3(0.18f, 0.91f, 0.36f))));
    float facetB = fmaxf(0.0f, dot3(hit.n, normalize3(make3(-0.74f, 0.42f, 0.52f))));
    float dispersion = sinf((hit.n.x * 41.0f + hit.n.y * 29.0f + hit.n.z * 37.0f + hit.id) * 2.3f);
    Vec3 spectral = make3(0.84f + 0.12f * sinf(dispersion + 0.0f),
                          0.90f + 0.08f * sinf(dispersion + 2.1f),
                          0.98f + 0.08f * sinf(dispersion + 4.2f));
    Vec3 glass = mix3(hadamard3(refracted, spectral), reflected, 0.16f + 0.70f * fresnel);
    glass = add3(glass, mul3(make3(0.92f, 0.98f, 1.0f), facetA * facetA * 0.30f));
    glass = add3(glass, mul3(make3(1.0f, 0.90f, 0.62f), facetB * facetB * 0.16f));
    float sparkle = powf(fmaxf(0.0f, dot3(reflect3(mul3(lightDir, -1.0f), hit.n), viewDir)), 120.0f);
    glass = add3(glass, mul3(make3(1.0f, 0.96f, 0.84f), sparkle * (2.4f + sceneLight)));
    return glass;
}

extern "C" __global__ void render_realistic_raytrace(unsigned int* pixels, int width, int height, float exposure, unsigned long long frame) {
    int x = blockIdx.x * blockDim.x + threadIdx.x;
    int y = blockIdx.y * blockDim.y + threadIdx.y;
    if (x >= width || y >= height) return;

    const float sceneLight = 1.0f; // SYNTHI_HMR_DIRECTION_TOKEN
    Vec3 color = make3(0.0f, 0.0f, 0.0f);
    const float offsets[4][2] = {
        {0.30f, 0.30f},
        {0.70f, 0.30f},
        {0.30f, 0.70f},
        {0.70f, 0.70f}
    };
    for (int sample = 0; sample < 4; ++sample) {
        float px = ((float)x + offsets[sample][0]) / (float)width;
        float py = ((float)y + offsets[sample][1]) / (float)height;
        color = add3(color, cameraRayColor(px, py, width, height, sceneLight, exposure));
    }
    color = mul3(color, 0.25f);
    pixels[y * width + x] = packColor(color);
}

int main(int, char**) {
    SDL_Init(SDL_INIT_VIDEO);
    SDL_Window* window = SDL_CreateWindow("Synthi GPU Realistic Raytrace HMR", SDL_WINDOWPOS_CENTERED, SDL_WINDOWPOS_CENTERED, WIDTH, HEIGHT, 0);
    SDL_Renderer* renderer = SDL_CreateRenderer(window, -1, SDL_RENDERER_ACCELERATED);
    SDL_Texture* texture = SDL_CreateTexture(renderer, SDL_PIXELFORMAT_ARGB8888, SDL_TEXTUREACCESS_STREAMING, WIDTH, HEIGHT);

    static unsigned int hostPixels[PIXEL_COUNT];
    unsigned int* devicePixels = nullptr;
    ${api.malloc}(&devicePixels, sizeof(unsigned int) * PIXEL_COUNT);

    bool running = true;
    unsigned long long frame = 0;
    while (running) {
        SDL_Event event;
        while (SDL_PollEvent(&event)) {
            if (event.type == SDL_QUIT) running = false;
        }

        dim3 block(16, 16);
        dim3 grid((WIDTH + block.x - 1) / block.x, (HEIGHT + block.y - 1) / block.y);
        render_realistic_raytrace<<<grid, block>>>(devicePixels, WIDTH, HEIGHT, 1.04f, frame++);
        ${api.sync}();
        ${api.memcpy}(hostPixels, devicePixels, sizeof(unsigned int) * PIXEL_COUNT, ${api.d2h});

        SDL_UpdateTexture(texture, nullptr, hostPixels, WIDTH * (int)sizeof(unsigned int));
        SDL_RenderClear(renderer);
        SDL_RenderCopy(renderer, texture, nullptr, nullptr);
        SDL_RenderPresent(renderer);
        SDL_Delay(16);

        if ((frame % 120ULL) == 0ULL) {
            std::fprintf(stderr, "[user-gpu-realistic-raytrace] frame=%llu deterministic=1\\n", frame);
        }
    }

    ${api.free}(devicePixels);
    SDL_DestroyTexture(texture);
    SDL_DestroyRenderer(renderer);
    SDL_DestroyWindow(window);
    SDL_Quit();
    return 0;
}
`;
}

function rayLightSource(vendor) {
  const api = runtimeApi(vendor);
  const target = vendor === 'rocm' ? 'rocm' : 'cuda';
  return `// User-authored single-file GPU ray-light visual app.
// Deterministic validation fixture: fixed camera, fixed seed, no temporal
// accumulation, and GPU-authored ray sample positions.
// GPU_TARGET: ${target}
// LINK: -lSDL2 ${api.link}
// BUILD: ${api.build} main.cpp -lSDL2 ${api.link}
#include <SDL2/SDL.h>
${runtimeInclude(vendor)}
#include <cmath>
#include <cstdio>
#include <cstdlib>

constexpr int WIDTH = 800;
constexpr int HEIGHT = 600;
constexpr int BEAMS = 17;
constexpr int LEG_STEPS = 44;
constexpr int STEPS = LEG_STEPS * 3;
constexpr int RAY_SAMPLES = BEAMS * STEPS;

extern "C" __global__ void trace_light_rays(float* sampleX, float* sampleY, float* sampleEnergy, int samples) {
    int idx = blockIdx.x * blockDim.x + threadIdx.x;
    if (idx >= samples) return;

    int beam = idx % BEAMS;
    int step = idx / BEAMS;
    float lane = ((float)beam - (float)(BEAMS - 1) * 0.5f) / ((float)(BEAMS - 1) * 0.5f);

    const float direction = 1.0f; // SYNTHI_HMR_DIRECTION_TOKEN
    float emitterX = 400.0f + direction * 252.0f;
    float emitterY = 74.0f;

    float rayDx = -direction * (0.70f + lane * 0.10f);
    float rayDy = 1.0f;
    float invRayLen = rsqrtf(rayDx * rayDx + rayDy * rayDy);
    rayDx *= invRayLen;
    rayDy *= invRayLen;

    const float mirrorAnchorX = 400.0f;
    const float mirrorMidY = 260.0f;
    const float mirrorSlope = 0.32f;
    float denom = rayDx - mirrorSlope * rayDy;
    float mirrorT = (mirrorAnchorX + (emitterY - mirrorMidY) * mirrorSlope - emitterX) / denom;
    if (mirrorT < 40.0f) mirrorT = 40.0f;
    float hitX = emitterX + rayDx * mirrorT;
    float hitY = emitterY + rayDy * mirrorT;
    hitY += lane * 10.0f;
    hitX = mirrorAnchorX + (hitY - mirrorMidY) * mirrorSlope;

    float normalX = 1.0f;
    float normalY = -mirrorSlope;
    float invNormalLen = rsqrtf(normalX * normalX + normalY * normalY);
    normalX *= invNormalLen;
    normalY *= invNormalLen;
    float dotN = rayDx * normalX + rayDy * normalY;
    float reflectX = rayDx - 2.0f * dotN * normalX;
    float reflectY = rayDy - 2.0f * dotN * normalY;
    if (reflectY < 0.25f) reflectY = 0.72f;
    float invReflectLen = rsqrtf(reflectX * reflectX + reflectY * reflectY);
    reflectX *= invReflectLen;
    reflectY *= invReflectLen;

    float groundY = 504.0f + lane * 7.0f;
    float groundT = (groundY - hitY) / reflectY;
    if (groundT < 90.0f) groundT = 90.0f;
    float groundX = hitX + reflectX * groundT;

    float diffuseX = -reflectX * 0.42f + lane * 0.10f;
    float diffuseY = -0.82f;
    float invDiffuseLen = rsqrtf(diffuseX * diffuseX + diffuseY * diffuseY);
    diffuseX *= invDiffuseLen;
    diffuseY *= invDiffuseLen;
    float diffuseEndX = groundX + diffuseX * (88.0f + 18.0f * fabsf(lane));
    float diffuseEndY = groundY + diffuseY * 108.0f;

    int segment = step / LEG_STEPS;
    int segmentStep = step - segment * LEG_STEPS;
    if (segment > 2) {
        segment = 2;
        segmentStep = LEG_STEPS - 1;
    }
    float u = (float)segmentStep / (float)(LEG_STEPS - 1);
    float x;
    float y;
    float energy;
    if (segment == 0) {
        x = emitterX + (hitX - emitterX) * u;
        y = emitterY + (hitY - emitterY) * u;
        energy = 1.0f - 0.25f * u;
    } else if (segment == 1) {
        x = hitX + (groundX - hitX) * u;
        y = hitY + (groundY - hitY) * u;
        float caustic = expf(-((u - 0.82f) * (u - 0.82f)) / (2.0f * 0.10f * 0.10f));
        energy = 0.68f + caustic * 0.62f;
    } else {
        x = groundX + (diffuseEndX - groundX) * u;
        y = groundY + (diffuseEndY - groundY) * u;
        energy = 0.42f * (1.0f - u);
    }
    sampleX[idx] = x;
    sampleY[idx] = y;
    sampleEnergy[idx] = energy;
}

int main(int, char**) {
    SDL_Init(SDL_INIT_VIDEO);
    SDL_Window* window = SDL_CreateWindow("Synthi GPU Ray Light HMR", SDL_WINDOWPOS_CENTERED, SDL_WINDOWPOS_CENTERED, WIDTH, HEIGHT, 0);
    SDL_Renderer* renderer = SDL_CreateRenderer(window, -1, SDL_RENDERER_ACCELERATED);

    float hostX[RAY_SAMPLES];
    float hostY[RAY_SAMPLES];
    float hostEnergy[RAY_SAMPLES];
    float* deviceX = nullptr;
    float* deviceY = nullptr;
    float* deviceEnergy = nullptr;
    ${api.malloc}(&deviceX, sizeof(float) * RAY_SAMPLES);
    ${api.malloc}(&deviceY, sizeof(float) * RAY_SAMPLES);
    ${api.malloc}(&deviceEnergy, sizeof(float) * RAY_SAMPLES);

    bool running = true;
    unsigned long long frame = 0;
    while (running) {
        SDL_Event event;
        while (SDL_PollEvent(&event)) {
            if (event.type == SDL_QUIT) running = false;
        }

        dim3 block(256);
        dim3 grid((RAY_SAMPLES + block.x - 1) / block.x);
        trace_light_rays<<<grid, block>>>(deviceX, deviceY, deviceEnergy, RAY_SAMPLES);
        ${api.sync}();
        ${api.memcpy}(hostX, deviceX, sizeof(float) * RAY_SAMPLES, ${api.d2h});
        ${api.memcpy}(hostY, deviceY, sizeof(float) * RAY_SAMPLES, ${api.d2h});
        ${api.memcpy}(hostEnergy, deviceEnergy, sizeof(float) * RAY_SAMPLES, ${api.d2h});

        SDL_SetRenderDrawColor(renderer, 5, 8, 18, 255);
        SDL_RenderClear(renderer);

        SDL_SetRenderDrawColor(renderer, 20, 30, 34, 255);
        SDL_Rect ground{0, 340, WIDTH, HEIGHT - 340};
        SDL_RenderFillRect(renderer, &ground);
        SDL_SetRenderDrawColor(renderer, 38, 55, 58, 255);
        for (int gx = 0; gx < WIDTH; gx += 40) {
            SDL_RenderDrawLine(renderer, gx, 340, gx - 90, HEIGHT);
        }
        for (int gy = 360; gy < HEIGHT; gy += 42) {
            SDL_RenderDrawLine(renderer, 0, gy, WIDTH, gy);
        }

        SDL_SetRenderDrawColor(renderer, 92, 176, 210, 255);
        SDL_RenderDrawLine(renderer, 350, 184, 448, 491);
        SDL_RenderDrawLine(renderer, 354, 184, 452, 491);
        SDL_SetRenderDrawColor(renderer, 20, 48, 58, 255);
        SDL_Rect mirrorBack{386, 252, 78, 18};
        SDL_RenderFillRect(renderer, &mirrorBack);
        SDL_SetRenderDrawColor(renderer, 12, 12, 16, 255);
        SDL_Rect occluder{455, 374, 54, 86};
        SDL_RenderFillRect(renderer, &occluder);
        SDL_SetRenderDrawColor(renderer, 78, 86, 92, 255);
        SDL_RenderDrawRect(renderer, &occluder);

        for (int beam = 0; beam < BEAMS; ++beam) {
            for (int step = 1; step < STEPS; ++step) {
                int prev = (step - 1) * BEAMS + beam;
                int cur = step * BEAMS + beam;
                int e = (int)(hostEnergy[cur] * 255.0f);
                if (e < 0) e = 0;
                if (e > 255) e = 255;
                if (step < LEG_STEPS) {
                    SDL_SetRenderDrawColor(renderer, 255, 226, 116 + e / 4, 255);
                } else if (step < LEG_STEPS * 2) {
                    SDL_SetRenderDrawColor(renderer, 128 + e / 3, 218, 255, 255);
                } else {
                    SDL_SetRenderDrawColor(renderer, 255, 160 + e / 5, 80, 255);
                }
                SDL_RenderDrawLine(renderer, (int)hostX[prev], (int)hostY[prev], (int)hostX[cur], (int)hostY[cur]);
                if ((step % 8) == 0) {
                    int size = 1 + e / 128;
                    SDL_Rect sample{(int)hostX[cur], (int)hostY[cur], size, size};
                    SDL_RenderFillRect(renderer, &sample);
                }
            }
            int mirrorHit = LEG_STEPS * BEAMS + beam;
            int groundHit = (LEG_STEPS * 2) * BEAMS + beam;
            SDL_SetRenderDrawColor(renderer, 170, 238, 255, 255);
            SDL_Rect hit{(int)hostX[mirrorHit] - 3, (int)hostY[mirrorHit] - 3, 7, 7};
            SDL_RenderFillRect(renderer, &hit);
            SDL_SetRenderDrawColor(renderer, 255, 212, 104, 255);
            SDL_Rect pool{(int)hostX[groundHit] - 7, (int)hostY[groundHit] - 2, 15, 5};
            SDL_RenderFillRect(renderer, &pool);
        }

        SDL_SetRenderDrawColor(renderer, 255, 236, 154, 255);
        SDL_Rect emitter{(int)hostX[0] - 8, (int)hostY[0] - 8, 16, 16};
        SDL_RenderFillRect(renderer, &emitter);

        SDL_RenderPresent(renderer);
        SDL_Delay(16);

        if ((++frame % 120ULL) == 0ULL) {
            std::fprintf(stderr, "[user-gpu-ray-light] frame=%llu deterministic=1\\n", frame);
        }
    }

    ${api.free}(deviceX);
    ${api.free}(deviceY);
    ${api.free}(deviceEnergy);
    SDL_DestroyRenderer(renderer);
    SDL_DestroyWindow(window);
    SDL_Quit();
    return 0;
}
`;
}

const SOURCE_FIRST_FORBIDDEN_ABI_MARKERS = [
  'core_on_update',
  'gui_on_render',
  'device_on_load',
  'device_descriptor',
  'synthi_gpu_launch',
];

function sourceFirstSeedSourcePurityEvidence({ source, entryPath = '', files = [] } = {}) {
  const normalizedEntryPath = cleanRel(entryPath);
  const sourceText = typeof source === 'string' ? source : '';
  const seedFiles = Array.isArray(files) && files.length > 0
    ? files
    : [{ path: normalizedEntryPath || 'src/main.cpp', content: sourceText }];
  const scannedFiles = seedFiles
    .map((entry) => {
      const filePath = cleanRel(entry?.path ?? entry?.name ?? entry?.filename ?? '');
      const content = typeof entry?.content === 'string' ? entry.content : '';
      const found = SOURCE_FIRST_FORBIDDEN_ABI_MARKERS.filter((needle) => content.includes(needle));
      return {
        path: filePath,
        contentHash: filePath ? `sha256:${sha256Hex(content)}` : null,
        content_hash: filePath ? `sha256:${sha256Hex(content)}` : null,
        byteLength: Buffer.byteLength(content, 'utf8'),
        byte_length: Buffer.byteLength(content, 'utf8'),
        accepted: filePath.length > 0 && found.length === 0,
        forbiddenMarkersFound: found,
        forbidden_markers_found: found,
      };
    })
    .filter((entry) => entry.path);
  const sourceContentHash = `sha256:${sha256Hex(sourceText)}`;
  const entryFileCovered = scannedFiles.some((entry) =>
    entry.path === normalizedEntryPath && entry.contentHash === sourceContentHash && entry.accepted === true
  );
  const forbiddenMarkersFound = [...new Set(scannedFiles.flatMap((entry) => entry.forbiddenMarkersFound))];
  const purityManifestHash = `sha256:${sha256Hex(stableJson(scannedFiles))}`;
  const evidence = {
    schemaVersion: 'synthi.gpu.hmr.agent_split_source_purity.v1',
    accepted: scannedFiles.length > 0 && entryFileCovered && forbiddenMarkersFound.length === 0,
    noSynthiAbiInSeedSource: scannedFiles.length > 0 && entryFileCovered && forbiddenMarkersFound.length === 0,
    no_synthi_abi_in_seed_source: scannedFiles.length > 0 && entryFileCovered && forbiddenMarkersFound.length === 0,
    forbiddenMarkersChecked: SOURCE_FIRST_FORBIDDEN_ABI_MARKERS,
    forbidden_markers_checked: SOURCE_FIRST_FORBIDDEN_ABI_MARKERS,
    forbiddenMarkersFound,
    forbidden_markers_found: forbiddenMarkersFound,
    scannedFiles,
    scanned_files: scannedFiles,
    scannedFilePaths: scannedFiles.map((entry) => entry.path),
    scanned_file_paths: scannedFiles.map((entry) => entry.path),
    scannedFileCount: scannedFiles.length,
    scanned_file_count: scannedFiles.length,
    purityManifestHash,
    purity_manifest_hash: purityManifestHash,
    entryPath: normalizedEntryPath,
    entry_path: normalizedEntryPath,
    entryFileCovered,
    entry_file_covered: entryFileCovered,
    sourceContentHash,
    source_content_hash: sourceContentHash,
    sourceByteLength: Buffer.byteLength(sourceText, 'utf8'),
    source_byte_length: Buffer.byteLength(sourceText, 'utf8'),
  };
  return evidence;
}

function assertNoSynthiAbi(source, options = {}) {
  const evidence = sourceFirstSeedSourcePurityEvidence({ source, ...options });
  if (!evidence.accepted) {
    fail(`seed source files unexpectedly contain Synthi ABI markers: ${evidence.forbiddenMarkersFound.join(', ') || 'coverage_missing'}`);
  }
  record('seed source files have no Synthi ABI', 'pass', `${evidence.sourceContentHash} files=${evidence.scannedFileCount}`);
  return evidence;
}

function waitResultFromWaitHmrToolError(err) {
  const message = String(err?.message ?? err ?? '');
  const match = message.match(/tool synthi_wait_hmr isError:\s*(\{[\s\S]*\})$/);
  if (!match) return null;
  try {
    const parsed = JSON.parse(match[1]);
    if (!parsed || typeof parsed !== 'object') return null;
    if (parsed.error !== 'gpu_hmr_proof_insufficient') return null;
    return {
      ...parsed,
      status: parsed.status ?? 'timeout',
      source: parsed.source ?? 'tool_error',
    };
  } catch {
    return null;
  }
}

function waitProofValidation(wait) {
  return wait?.gpu_proof_validation && typeof wait.gpu_proof_validation === 'object'
    ? wait.gpu_proof_validation
    : wait?.gpuProofValidation && typeof wait.gpuProofValidation === 'object'
      ? wait.gpuProofValidation
      : {};
}

function waitProofReason(wait) {
  const validation = waitProofValidation(wait);
  return String(
    validation.reason
      ?? wait?.reason
      ?? wait?.gpu_proof_wait?.reason
      ?? wait?.gpuProofWait?.reason
      ?? '',
  ).trim();
}

function waitProofWaitStatus(wait) {
  return String(
    wait?.gpu_proof_wait?.status
      ?? wait?.gpuProofWait?.status
      ?? wait?.proof_wait_timeout_intelligence?.status
      ?? wait?.proofWaitTimeoutIntelligence?.status
      ?? '',
  ).trim();
}

function strictProofRequested(waitContract) {
  const waitArgs = waitContract?.waitArgs ?? {};
  return waitArgs.requireGpuFullRuntimeProof === true
    || (typeof waitArgs.requiredGpuProofState === 'string' && waitArgs.requiredGpuProofState.trim());
}

const STRICT_PROOF_PENDING_RETRY_REASONS = new Set([
  'proof_state_missing',
  'gpu_proof_state_missing',
  'proof_ledger_missing',
  'proof_ledger_not_ready',
  'runtime_proof_artifact_missing',
  'runtime_proof_artifact_not_ready',
  'strict_runtime_proof_missing',
  'proof_slice_missing',
  'strict_proof_pending',
  'runtime_proof_pending',
  'proof_pending',
]);

function strictProofWaitRetryReason(wait, waitContract) {
  if (!strictProofRequested(waitContract)) return null;
  if (!wait || wait.status === 'applied') return null;
  if (wait.error !== 'gpu_hmr_proof_insufficient') return null;
  if (!['timeout', 'timeout_or_error'].includes(String(wait.status ?? ''))) return null;
  const proofWaitStatus = waitProofWaitStatus(wait);
  if (proofWaitStatus === 'failed_fast') return null;
  const reason = waitProofReason(wait);
  if (!STRICT_PROOF_PENDING_RETRY_REASONS.has(reason)) return null;
  return reason;
}

function waitAttemptSummary(wait, attemptIndex, sliceTimeoutMs) {
  const validation = waitProofValidation(wait);
  const telemetry = proofTelemetryObject(wait);
  const proofLedgerValidation = validation.proofLedgerValidation
    ?? validation.proof_ledger_validation
    ?? null;
  const runtimeArtifactValidation = validation.runtimeProofArtifactValidation
    ?? validation.runtime_proof_artifact_validation
    ?? null;
  const failedGates = Array.isArray(validation.failedGates)
    ? validation.failedGates
    : Array.isArray(validation.failed_gates)
      ? validation.failed_gates
      : [];
  return {
    attemptIndex,
    attempt_index: attemptIndex,
    sliceTimeoutMs,
    slice_timeout_ms: sliceTimeoutMs,
    status: wait?.status ?? null,
    error: wait?.error ?? null,
    source: wait?.source ?? null,
    reason: waitProofReason(wait) || null,
    resultState: validation.resultState ?? validation.result_state ?? telemetry.resultState ?? telemetry.result_state ?? null,
    result_state: validation.resultState ?? validation.result_state ?? telemetry.resultState ?? telemetry.result_state ?? null,
    effectiveResultRank: validation.effectiveResultRank ?? validation.effective_result_rank ?? null,
    effective_result_rank: validation.effectiveResultRank ?? validation.effective_result_rank ?? null,
    proofId: telemetry.proofId ?? telemetry.proof_id ?? null,
    proof_id: telemetry.proofId ?? telemetry.proof_id ?? null,
    proofArtifactPath: telemetry.proofArtifactPath ?? telemetry.proof_artifact_path ?? null,
    proof_artifact_path: telemetry.proofArtifactPath ?? telemetry.proof_artifact_path ?? null,
    failedGates,
    failed_gates: failedGates,
    proofLedgerAccepted: proofLedgerValidation?.accepted ?? null,
    proof_ledger_accepted: proofLedgerValidation?.accepted ?? null,
    runtimeProofArtifactAccepted: runtimeArtifactValidation?.accepted ?? null,
    runtime_proof_artifact_accepted: runtimeArtifactValidation?.accepted ?? null,
  };
}

function strictProofWaitRetryEvidence({
  attempted,
  initialWait,
  finalWait,
  reason,
  initialTimeoutMs,
  retryTimeoutMs,
  retryDelayMs,
  waitContract,
  elapsedMs,
} = {}) {
  const finalApplied = finalWait?.status === 'applied';
  const binding = waitContract?.binding ?? {};
  const evidence = {
    schemaVersion: 'synthi.gpu_hmr.strict_proof_wait_retry.v1',
    schema_version: 'synthi.gpu_hmr.strict_proof_wait_retry.v1',
    proofAuthority: 'strict_proof_wait_retry_scheduling_only_not_gpu_hmr_acceptance',
    proof_authority: 'strict_proof_wait_retry_scheduling_only_not_gpu_hmr_acceptance',
    acceptedForGpuHmr: false,
    accepted_for_gpu_hmr: false,
    gpuHmrSuccess: false,
    gpu_hmr_success: false,
    canSatisfyRuntimeProof: false,
    can_satisfy_runtime_proof: false,
    attempted: attempted === true,
    decision: attempted === true ? 'retry' : 'stop',
    maxAttempts: 2,
    max_attempts: 2,
    attemptCount: attempted === true ? 2 : 1,
    attempt_count: attempted === true ? 2 : 1,
    reason: reason ?? waitProofReason(initialWait) ?? null,
    stopReason: finalApplied ? 'proof_ready' : 'retry_budget_exhausted',
    stop_reason: finalApplied ? 'proof_ready' : 'retry_budget_exhausted',
    initialStatus: initialWait?.status ?? null,
    initial_status: initialWait?.status ?? null,
    initialError: initialWait?.error ?? null,
    initial_error: initialWait?.error ?? null,
    finalStatus: finalWait?.status ?? null,
    final_status: finalWait?.status ?? null,
    finalReason: finalWait ? waitProofReason(finalWait) || null : null,
    final_reason: finalWait ? waitProofReason(finalWait) || null : null,
    initialTimeoutMs: Number.isFinite(initialTimeoutMs) ? initialTimeoutMs : null,
    initial_timeout_ms: Number.isFinite(initialTimeoutMs) ? initialTimeoutMs : null,
    retryTimeoutMs: Number.isFinite(retryTimeoutMs) ? retryTimeoutMs : null,
    retry_timeout_ms: Number.isFinite(retryTimeoutMs) ? retryTimeoutMs : null,
    retryDelayMs: Number.isFinite(retryDelayMs) ? retryDelayMs : null,
    retry_delay_ms: Number.isFinite(retryDelayMs) ? retryDelayMs : null,
    elapsedMs: Number.isFinite(elapsedMs) ? elapsedMs : null,
    elapsed_ms: Number.isFinite(elapsedMs) ? elapsedMs : null,
    workspaceSlug: binding.workspaceSlug ?? CFG.slug,
    workspace_slug: binding.workspaceSlug ?? CFG.slug,
    compileDispatchedAt: binding.compileDispatchedAt ?? null,
    compile_dispatched_at: binding.compileDispatchedAt ?? null,
    sinceTs: binding.sinceTs ?? waitContract?.waitArgs?.since_ts ?? null,
    since_ts: binding.sinceTs ?? waitContract?.waitArgs?.since_ts ?? null,
    module: waitContract?.waitArgs?.module ?? null,
    selectedPath: binding.selectedPath ?? null,
    selected_path: binding.selectedPath ?? null,
    editId: binding.editId ?? null,
    edit_id: binding.editId ?? null,
    editHash: binding.editHash ?? null,
    edit_hash: binding.editHash ?? null,
    artifactHashAfter: binding.artifactHashAfter ?? null,
    artifact_hash_after: binding.artifactHashAfter ?? null,
    requireGpuFullRuntimeProof: waitContract?.waitArgs?.requireGpuFullRuntimeProof === true,
    require_gpu_full_runtime_proof: waitContract?.waitArgs?.requireGpuFullRuntimeProof === true,
    requiredGpuProofState: waitContract?.waitArgs?.requiredGpuProofState ?? null,
    required_gpu_proof_state: waitContract?.waitArgs?.requiredGpuProofState ?? null,
    attempts: [
      waitAttemptSummary(initialWait, 1, evidenceNumberOrNull(initialTimeoutMs)),
      ...(attempted === true ? [waitAttemptSummary(finalWait, 2, evidenceNumberOrNull(retryTimeoutMs))] : []),
    ],
    blockingGaps: finalApplied ? [] : ['strict_proof_wait_retry_final_status_not_applied'],
    blocking_gaps: finalApplied ? [] : ['strict_proof_wait_retry_final_status_not_applied'],
  };
  evidence.evidenceRefs = [`strict-proof-wait-retry:${sha256Hex(stableJson({
    reason: evidence.reason,
    initialStatus: evidence.initialStatus,
    finalStatus: evidence.finalStatus,
    initialTimeoutMs: evidence.initialTimeoutMs,
    retryTimeoutMs: evidence.retryTimeoutMs,
    requiredGpuProofState: evidence.requiredGpuProofState,
    requireGpuFullRuntimeProof: evidence.requireGpuFullRuntimeProof,
    sinceTs: evidence.sinceTs,
    module: evidence.module,
    selectedPath: evidence.selectedPath,
    editHash: evidence.editHash,
  }))}`];
  evidence.evidence_refs = evidence.evidenceRefs;
  return evidence;
}

function evidenceNumberOrNull(value) {
  return Number.isFinite(value) ? value : null;
}

async function callWaitHmrTool(state, waitArgs, timeoutMs) {
  try {
    return await state.client.toolCall('synthi_wait_hmr', waitArgs, timeoutMs);
  } catch (err) {
    return waitResultFromWaitHmrToolError(err)
      ?? { status: 'timeout_or_error', error: String(err?.message ?? err).slice(0, 4000) };
  }
}

async function waitHmrWithStrictProofRetry(state, waitContract, timeoutMs, options = {}) {
  const retryStartNs = process.hrtime.bigint();
  const wait = await callWaitHmrTool(state, waitContract.waitArgs, timeoutMs + 5000);
  const retryReason = strictProofWaitRetryReason(wait, waitContract);
  const retryTimeoutMs = Number.isFinite(options.strictProofRetryTimeoutMs)
    ? options.strictProofRetryTimeoutMs
    : CFG.strictProofRetryTimeoutMs;
  const retryDelayMs = Number.isFinite(options.strictProofRetryDelayMs)
    ? options.strictProofRetryDelayMs
    : CFG.strictProofRetryDelayMs;
  const retryEnabled = options.strictProofRetryEnabled ?? CFG.strictProofRetryEnabled;
  if (!retryEnabled || !retryReason || !Number.isFinite(retryTimeoutMs) || retryTimeoutMs <= 0) {
    return { wait, retryEvidence: null };
  }
  if (Number.isFinite(retryDelayMs) && retryDelayMs > 0) {
    await sleep(retryDelayMs);
  }
  const retryWaitArgs = {
    ...waitContract.waitArgs,
    timeoutMs: retryTimeoutMs,
  };
  const retryWait = await callWaitHmrTool(state, retryWaitArgs, retryTimeoutMs + 5000);
  const retryEndNs = process.hrtime.bigint();
  const retryEvidence = strictProofWaitRetryEvidence({
    attempted: true,
    initialWait: wait,
    finalWait: retryWait,
    reason: retryReason,
    initialTimeoutMs: timeoutMs,
    retryTimeoutMs,
    retryDelayMs: Number.isFinite(retryDelayMs) ? retryDelayMs : null,
    waitContract,
    elapsedMs: Number(retryEndNs - retryStartNs) / 1_000_000,
  });
  return { wait: retryWait, retryEvidence };
}

async function compileViaMcp(args, timeoutMs, options = {}) {
  const state = await ensureMcpAttached();
  const compileStartNs = timingBoundaryNs();
  const isColdSourceFirstCompile = options.metricScope === 'cold';
  activeAgentSplitTestTiming?.observeEditTrigger(compileStartNs);
  let compile;
  let compileEndNs;
  try {
    compile = await state.client.toolCall('synthi_compile', args, timeoutMs);
    compileEndNs = timingBoundaryNs();
  } catch (error) {
    compileEndNs = timingBoundaryNs();
    if (isColdSourceFirstCompile) {
      activeAgentSplitTestTiming?.observeOpaqueCompileRequest();
    }
    throw error;
  }
  if (isColdSourceFirstCompile) {
    activeAgentSplitTestTiming?.observeOpaqueCompileRequest();
  }
  if (!compile?.ok) {
    const error = new Error(`synthi_compile failed: ${JSON.stringify(sanitizeProofLogValue(compile)).slice(0, 4000)}`);
    error.compileResult = compile;
    if (observedRefusalStatus(
      compile?.status ?? compile?.resultState ?? compile?.result_state,
    )) {
      tagAgentSplitTimingError(error, {
        outcome: 'refused',
        category: 'compile_refusal',
        reasonCode: 'agent_split_compile_refused',
      });
    }
    throw error;
  }
  const waitContract = waitContractForCompile({ args, compile, timeoutMs, options });
  const waitStartNs = timingBoundaryNs();
  if (isColdSourceFirstCompile) activeAgentSplitTestTiming?.observeRuntimeWait();
  const { wait, retryEvidence } = await waitHmrWithStrictProofRetry(state, waitContract, timeoutMs, options);
  const waitEndNs = timingBoundaryNs();
  const timingMetrics = {
    schemaVersion: 'synthi.gpu.hmr.runner_timing_metrics.v1',
    metricClock: 'monotonic_ns',
    metric_clock: 'monotonic_ns',
    metricScope: options.metricScope ?? null,
    metric_scope: options.metricScope ?? null,
    cacheState: options.cacheState ?? null,
    cache_state: options.cacheState ?? null,
    editId: options.editId ?? null,
    edit_id: options.editId ?? null,
    editHash: options.editHash ?? null,
    edit_hash: options.editHash ?? null,
    editKind: options.editKind ?? null,
    edit_kind: options.editKind ?? null,
    differentEdit: options.differentEdit === true,
    different_edit: options.differentEdit === true,
    timings: {
      device_compile_wall_time: Number(compileEndNs - compileStartNs),
      runtime_probe_time: Number(waitEndNs - waitStartNs),
      total_validator_wall_time: Number(waitEndNs - compileStartNs),
    },
  };
  const waitSummary = {
    role: waitContract.role,
    module: waitContract.waitArgs.module ?? null,
    since_ts: waitContract.waitArgs.since_ts ?? null,
    requireGpuFullRuntimeProof: waitContract.waitArgs.requireGpuFullRuntimeProof === true,
    requiredGpuProofState: waitContract.waitArgs.requiredGpuProofState ?? null,
    status: wait?.status ?? null,
    frame_gate: wait?.frame_gate ?? null,
    timingMetrics,
    timing_metrics: timingMetrics,
  };
  const terminalDiagnostic = compileTerminalDiagnosticEvidence(wait);
  if (terminalDiagnostic) {
    waitSummary.terminalDiagnostic = terminalDiagnostic;
    waitSummary.terminal_diagnostic = terminalDiagnostic;
  }
  if (retryEvidence) {
    waitSummary.proofFinalizationRetry = retryEvidence;
    waitSummary.proof_finalization_retry = retryEvidence;
  }
  const requestedProofStateGate = waitContract.waitArgs.requiredGpuProofState
    ? requestedProofStateValidation(wait, waitContract.waitArgs.requiredGpuProofState)
    : null;
  if (requestedProofStateGate) {
    waitSummary.requestedProofStateGate = requestedProofStateGate;
    waitSummary.requested_proof_state_gate = requestedProofStateGate;
  }
  if (wait?.error) waitSummary.error = String(wait.error).slice(0, 4000);
  if (wait?.gpu_proof_validation) waitSummary.gpu_proof_validation = wait.gpu_proof_validation;
  if (wait?.gpu_proof_telemetry) waitSummary.gpu_proof_telemetry = wait.gpu_proof_telemetry;
  const requireAppliedWait = options.requireAppliedWait === true
    || waitContract.isGpuDeviceEdit
    || typeof options.requiredGpuProofState === 'string';
  const waitGateSatisfied = wait?.status === 'applied' || requestedProofStateGate?.accepted === true;
  record(
    options.waitRecordLabel ?? 'mcp wait_hmr proof gate',
    waitGateSatisfied ? 'pass' : requireAppliedWait ? 'fail' : 'warn',
    JSON.stringify(waitSummary),
  );
  if (requireAppliedWait && !waitGateSatisfied) {
    const error = new Error(
      `required synthi_wait_hmr proof gate did not apply: ${JSON.stringify(waitSummary).slice(0, 4000)}`,
    );
    error.waitSummary = waitSummary;
    error.wait_summary = waitSummary;
    if (observedRefusalStatus(waitSummary.status)) {
      tagAgentSplitTimingError(error, {
        outcome: 'refused',
        category: 'runtime_refusal',
        reasonCode: 'agent_split_wait_proof_refused',
      });
    }
    throw error;
  }
  return { compile, wait, waitContract, waitSummary, timingMetrics };
}

function cleanRel(value) {
  return String(value || '').replace(/\\/g, '/').replace(/^\/+/, '').replace(/^\.\//, '');
}

function sha256Hex(value) {
  return createHash('sha256').update(String(value ?? '')).digest('hex');
}

function sha256BufferHex(value) {
  return createHash('sha256').update(value).digest('hex');
}

function stableJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) =>
    `${JSON.stringify(key)}:${stableJson(value[key])}`
  ).join(',')}}`;
}

const GPU_HMR_PROOF_STATE_RANKS = new Map([
  ['gpu-hmr-compile-proven', 1],
  ['gpu-hmr-symbol-bound', 2],
  ['gpu-hmr-abi-proven', 3],
  ['gpu-hmr-epoch-swap-proven', 4],
  ['gpu-hmr-dispatch-observed', 5],
  ['gpu-hmr-dispatch-safe-proven', 6],
  ['gpu-hmr-output-oracle-proven', 7],
  ['gpu-hmr-host-preservation-proven', 8],
  ['gpu-hmr-full-runtime-proven', 9],
]);

function gpuHmrProofStateRank(value) {
  return GPU_HMR_PROOF_STATE_RANKS.get(String(value ?? '')) ?? 0;
}

function proofValidationObject(wait) {
  return wait?.gpu_proof_validation && typeof wait.gpu_proof_validation === 'object'
    ? wait.gpu_proof_validation
    : {};
}

function proofTelemetryObject(wait) {
  return wait?.gpu_proof_telemetry && typeof wait.gpu_proof_telemetry === 'object'
    ? wait.gpu_proof_telemetry
    : {};
}

function proofIdLooksImmutable(value) {
  return typeof value === 'string'
    && /^gpu-(?:runtime-)?proof(?::sha256)?:[a-f0-9]{64}$/i.test(value.trim());
}

function requestedProofStateValidation(wait, requiredState) {
  const normalizedRequiredState = String(requiredState ?? '').trim();
  const requiredRank = gpuHmrProofStateRank(normalizedRequiredState);
  const validation = proofValidationObject(wait);
  const telemetry = proofTelemetryObject(wait);
  const validatedRequiredState = validation.requiredState ?? validation.required_state ?? null;
  const validatedResultState = validation.resultState ?? validation.result_state ?? null;
  const resultState = telemetry.resultState ?? telemetry.result_state ?? validatedResultState ?? null;
  const effectiveResultRank = Number.isFinite(validation.effectiveResultRank)
    ? validation.effectiveResultRank
    : Number.isFinite(validation.effective_result_rank)
      ? validation.effective_result_rank
      : gpuHmrProofStateRank(resultState);
  const resultRank = Math.max(gpuHmrProofStateRank(resultState), gpuHmrProofStateRank(validatedResultState), effectiveResultRank);
  const validatedRequiredRank = gpuHmrProofStateRank(validatedRequiredState);
  const proofId = telemetry.proofId ?? telemetry.proof_id ?? null;
  const proofArtifactPath = telemetry.proofArtifactPath ?? telemetry.proof_artifact_path ?? null;
  const status = String(wait?.status ?? '');
  const rejectedCompileOnlyBoundary = normalizedRequiredState === 'gpu-hmr-compile-proven' && status === 'rejected';
  const rejected_compile_only_boundary = rejectedCompileOnlyBoundary;
  const statusCanCarryValidation = status === 'applied' || rejectedCompileOnlyBoundary;
  const accepted = requiredRank > 0
    && statusCanCarryValidation
    && !wait?.error
    && validation.satisfied === true
    && validatedRequiredRank >= requiredRank
    && resultRank >= requiredRank
    && proofIdLooksImmutable(proofId)
    && typeof proofArtifactPath === 'string'
    && proofArtifactPath.trim().length > 0;
  return {
    schemaVersion: 'synthi.gpu_hmr.requested_proof_state_gate.v1',
    schema_version: 'synthi.gpu_hmr.requested_proof_state_gate.v1',
    proofAuthority: 'structured_requested_proof_state_validation_only_not_gpu_hmr_acceptance',
    proof_authority: 'structured_requested_proof_state_validation_only_not_gpu_hmr_acceptance',
    accepted,
    acceptedForGpuHmr: false,
    accepted_for_gpu_hmr: false,
    gpuHmrSuccess: false,
    gpu_hmr_success: false,
    canSatisfyRuntimeProof: false,
    can_satisfy_runtime_proof: false,
    status: wait?.status ?? null,
    statusCanCarryValidation,
    status_can_carry_validation: statusCanCarryValidation,
    rejectedCompileOnlyBoundary,
    rejected_compile_only_boundary,
    requiredState: normalizedRequiredState || null,
    required_state: normalizedRequiredState || null,
    requiredRank,
    required_rank: requiredRank,
    validatedRequiredState,
    validated_required_state: validatedRequiredState,
    validatedRequiredRank,
    validated_required_rank: validatedRequiredRank,
    resultState,
    result_state: resultState,
    validatedResultState,
    validated_result_state: validatedResultState,
    effectiveResultRank,
    effective_result_rank: effectiveResultRank,
    resultRank,
    result_rank: resultRank,
    validationSatisfied: validation.satisfied === true,
    validation_satisfied: validation.satisfied === true,
    proofId,
    proof_id: proofId,
    proofArtifactPath,
    proof_artifact_path: proofArtifactPath,
    blockingGaps: accepted ? [] : [
      ...(requiredRank > 0 ? [] : ['requested_proof_state_unknown']),
      ...(statusCanCarryValidation ? [] : ['wait_status_cannot_carry_requested_proof_validation']),
      ...(!wait?.error ? [] : ['wait_error_present']),
      ...(validation.satisfied === true ? [] : ['requested_proof_state_validation_not_satisfied']),
      ...(validatedRequiredRank >= requiredRank ? [] : ['validated_required_state_below_requested_state']),
      ...(resultRank >= requiredRank ? [] : ['result_state_below_requested_state']),
      ...(proofIdLooksImmutable(proofId) ? [] : ['requested_proof_state_proof_id_missing_or_mutable']),
      ...(typeof proofArtifactPath === 'string' && proofArtifactPath.trim().length > 0 ? [] : ['requested_proof_state_proof_artifact_path_missing']),
    ],
    blocking_gaps: accepted ? [] : [
      ...(requiredRank > 0 ? [] : ['requested_proof_state_unknown']),
      ...(statusCanCarryValidation ? [] : ['wait_status_cannot_carry_requested_proof_validation']),
      ...(!wait?.error ? [] : ['wait_error_present']),
      ...(validation.satisfied === true ? [] : ['requested_proof_state_validation_not_satisfied']),
      ...(validatedRequiredRank >= requiredRank ? [] : ['validated_required_state_below_requested_state']),
      ...(resultRank >= requiredRank ? [] : ['result_state_below_requested_state']),
      ...(proofIdLooksImmutable(proofId) ? [] : ['requested_proof_state_proof_id_missing_or_mutable']),
      ...(typeof proofArtifactPath === 'string' && proofArtifactPath.trim().length > 0 ? [] : ['requested_proof_state_proof_artifact_path_missing']),
    ],
  };
}

function initialDeviceCompileProofFromResult(result) {
  const wait = result?.wait && typeof result.wait === 'object' ? result.wait : {};
  const validation = proofValidationObject(wait);
  const telemetry = proofTelemetryObject(wait);
  const validatedRequiredState = validation.requiredState ?? validation.required_state ?? null;
  const validatedResultState = validation.resultState ?? validation.result_state ?? null;
  const effectiveResultRank = Number.isFinite(validation.effectiveResultRank)
    ? validation.effectiveResultRank
    : Number.isFinite(validation.effective_result_rank)
      ? validation.effective_result_rank
      : gpuHmrProofStateRank(validatedResultState);
  const resultState = telemetry.resultState ?? telemetry.result_state ?? null;
  const proofId = telemetry.proofId ?? telemetry.proof_id ?? null;
  const proofArtifactPath = telemetry.proofArtifactPath ?? telemetry.proof_artifact_path ?? null;
  const resultRank = Math.max(gpuHmrProofStateRank(resultState), gpuHmrProofStateRank(validatedResultState), effectiveResultRank);
  const requiredRank = gpuHmrProofStateRank('gpu-hmr-compile-proven');
  const requestedProofStateGate = requestedProofStateValidation(wait, 'gpu-hmr-compile-proven');
  const accepted = requestedProofStateGate.accepted === true;
  return {
    accepted,
    waitStatus: wait.status ?? null,
    validationSatisfied: validation.satisfied === true,
    validation_satisfied: validation.satisfied === true,
    proofId,
    proof_id: proofId,
    proofArtifactPath,
    proof_artifact_path: proofArtifactPath,
    resultState: resultState ?? validatedResultState,
    result_state: resultState ?? validatedResultState,
    validatedResultState,
    validated_result_state: validatedResultState,
    resultRank,
    result_rank: resultRank,
    requiredState: validatedRequiredState ?? 'gpu-hmr-compile-proven',
    required_state: validatedRequiredState ?? 'gpu-hmr-compile-proven',
    requiredRank,
    required_rank: requiredRank,
    effectiveResultRank,
    effective_result_rank: effectiveResultRank,
    degradedState: validation.degradedState ?? validation.degraded_state ?? telemetry.degradedState ?? telemetry.degraded_state ?? null,
    degraded_state: validation.degradedState ?? validation.degraded_state ?? telemetry.degradedState ?? telemetry.degraded_state ?? null,
    degradedStateRankCap: validation.degradedStateRankCap ?? validation.degraded_state_rank_cap ?? null,
    degraded_state_rank_cap: validation.degradedStateRankCap ?? validation.degraded_state_rank_cap ?? null,
    degradedReason: telemetry.degradedReason ?? telemetry.degraded_reason ?? null,
    degraded_reason: telemetry.degradedReason ?? telemetry.degraded_reason ?? null,
    source: telemetry.source ?? null,
    observedAt: telemetry.observedAt ?? telemetry.observed_at ?? null,
    observed_at: telemetry.observedAt ?? telemetry.observed_at ?? null,
    requestedProofStateGate,
    requested_proof_state_gate: requestedProofStateGate,
  };
}

function fullRuntimeGpuHmrProofFromResult(result) {
  const wait = result?.wait && typeof result.wait === 'object' ? result.wait : {};
  const validation = proofValidationObject(wait);
  const telemetry = proofTelemetryObject(wait);
  const ledgerValidation = validation.proofLedgerValidation && typeof validation.proofLedgerValidation === 'object'
    ? validation.proofLedgerValidation
    : {};
  const runtimeArtifactValidation = validation.runtimeProofArtifactValidation
    && typeof validation.runtimeProofArtifactValidation === 'object'
    ? validation.runtimeProofArtifactValidation
    : {};
  const resultState = validation.resultState ?? validation.result_state ?? telemetry.resultState ?? telemetry.result_state ?? null;
  const effectiveResultRank = Number.isFinite(validation.effectiveResultRank)
    ? validation.effectiveResultRank
    : Number.isFinite(validation.effective_result_rank)
      ? validation.effective_result_rank
      : gpuHmrProofStateRank(resultState);
  const fullRuntimeRank = gpuHmrProofStateRank('gpu-hmr-full-runtime-proven');
  const failedInvariants = Array.isArray(ledgerValidation.failedInvariants)
    ? ledgerValidation.failedInvariants
    : Array.isArray(ledgerValidation.failed_invariants)
      ? ledgerValidation.failed_invariants
      : [];
  const accepted = wait.status === 'applied'
    && validation.satisfied === true
    && effectiveResultRank >= fullRuntimeRank
    && ledgerValidation.gpuHmrSuccess === true
    && failedInvariants.length === 0
    && runtimeArtifactValidation.accepted === true
    && proofIdLooksImmutable(telemetry.proofId ?? telemetry.proof_id)
    && typeof (ledgerValidation.proofId ?? ledgerValidation.proof_id) === 'string';
  return {
    accepted,
    waitStatus: wait.status ?? null,
    validationSatisfied: validation.satisfied === true,
    validation_satisfied: validation.satisfied === true,
    resultState,
    result_state: resultState,
    effectiveResultRank,
    effective_result_rank: effectiveResultRank,
    requiredState: validation.requiredState ?? validation.required_state ?? 'gpu-hmr-full-runtime-proven',
    required_state: validation.requiredState ?? validation.required_state ?? 'gpu-hmr-full-runtime-proven',
    requiredRank: validation.requiredRank ?? validation.required_rank ?? fullRuntimeRank,
    required_rank: validation.requiredRank ?? validation.required_rank ?? fullRuntimeRank,
    runtimeProofId: telemetry.proofId ?? telemetry.proof_id ?? null,
    runtime_proof_id: telemetry.proofId ?? telemetry.proof_id ?? null,
    ledgerProofId: ledgerValidation.proofId ?? ledgerValidation.proof_id ?? null,
    ledger_proof_id: ledgerValidation.proofId ?? ledgerValidation.proof_id ?? null,
    gpuHmrSuccess: ledgerValidation.gpuHmrSuccess === true,
    gpu_hmr_success: ledgerValidation.gpuHmrSuccess === true,
    failedInvariants,
    failed_invariants: failedInvariants,
    runtimeProofArtifactAccepted: runtimeArtifactValidation.accepted === true,
    runtime_proof_artifact_accepted: runtimeArtifactValidation.accepted === true,
    runtimeProofArtifactSource: runtimeArtifactValidation.source ?? null,
    runtime_proof_artifact_source: runtimeArtifactValidation.source ?? null,
  };
}

function generatedDeviceEditIdentityProof(result, split, expectedEditHash) {
  const selectedPathMatches = cleanRel(result?.selectedPath) === cleanRel(split?.roles?.device);
  const editHashMatches = typeof expectedEditHash === 'string'
    && result?.editHash === expectedEditHash;
  const sourceBaselineAccepted = result?.sourceBaselineProof?.accepted === true;
  const refreshedSourceBaselineAccepted = result?.refreshedSourceBaselineProof?.accepted === true
    || result?.refreshed_source_baseline_proof?.accepted === true;
  const accepted = selectedPathMatches
    && editHashMatches
    && sourceBaselineAccepted
    && refreshedSourceBaselineAccepted;
  return {
    accepted,
    selectedPath: result?.selectedPath ?? null,
    selected_path: result?.selectedPath ?? null,
    expectedPath: split?.roles?.device ?? null,
    expected_path: split?.roles?.device ?? null,
    selectedPathMatches,
    selected_path_matches: selectedPathMatches,
    editHash: result?.editHash ?? null,
    edit_hash: result?.editHash ?? null,
    expectedEditHash,
    expected_edit_hash: expectedEditHash,
    editHashMatches,
    edit_hash_matches: editHashMatches,
    sourceBaselineAccepted,
    source_baseline_accepted: sourceBaselineAccepted,
    refreshedSourceBaselineAccepted,
    refreshed_source_baseline_accepted: refreshedSourceBaselineAccepted,
  };
}

function normalizedObjectStringLookup(root, parentKey, filePath) {
  const normalized = cleanRel(filePath);
  const table = root?.[parentKey];
  if (!normalized || !table || typeof table !== 'object' || Array.isArray(table)) {
    return { found: false, key: null, value: null };
  }
  for (const [key, value] of Object.entries(table)) {
    if (cleanRel(key) === normalized && typeof value === 'string') {
      return { found: true, key, value };
    }
  }
  return { found: false, key: null, value: null };
}

function sourceBaselineProofFromSidecar(sidecarRaw, filePath, source) {
  const root = JSON.parse(sidecarRaw);
  const content = normalizedObjectStringLookup(root, 'sourceBaselineContents', filePath);
  const hash = normalizedObjectStringLookup(root, 'sourceBaselineHashes', filePath);
  const expectedHash = sha256Hex(source);
  const accepted =
    content.found &&
    hash.found &&
    content.value === source &&
    hash.value === expectedHash;
  return {
    accepted,
    filePath: cleanRel(filePath),
    file_path: cleanRel(filePath),
    contentKey: content.key,
    content_key: content.key,
    hashKey: hash.key,
    hash_key: hash.key,
    expectedHash,
    expected_hash: expectedHash,
    observedHash: hash.value,
    observed_hash: hash.value,
    failures: [
      ...(!content.found ? ['source_baseline_contents_missing'] : []),
      ...(!hash.found ? ['source_baseline_hash_missing'] : []),
      ...(content.found && content.value !== source ? ['source_baseline_contents_mismatch'] : []),
      ...(hash.found && hash.value !== expectedHash ? ['source_baseline_hash_mismatch'] : []),
    ],
    provenance: 'compiler_emitted_sidecar',
  };
}

function manifestRoleForPath(manifest, filePath) {
  const moduleFiles = manifest?.module_files && typeof manifest.module_files === 'object'
    ? manifest.module_files
    : {};
  const normalizedPath = cleanRel(filePath);
  for (const [role, rolePath] of Object.entries(moduleFiles)) {
    if (cleanRel(rolePath) === normalizedPath) return role;
  }
  return null;
}

function waitContractForCompile({ args, compile, timeoutMs, options = {} }) {
  const manifest = args?.compile_manifest;
  const filename = cleanRel(args?.filename);
  const role = manifestRoleForPath(manifest, filename);
  const isGpuDeviceEdit = role === 'device' || (
    manifest?.gpu && /\.(hip|cu|cl|wgsl|glsl|spv|spirv)$/i.test(filename)
  );
  const module = process.env.SYNTHI_GPU_HMR_WAIT_MODULE
    ?? (isGpuDeviceEdit ? 'device' : role ?? undefined);
  const waitArgs = {
    timeoutMs,
    ...(Number.isFinite(compile?.dispatched_at)
      ? { since_ts: compile.dispatched_at }
      : {}),
    ...(module ? { module } : {}),
  };
  const requiredState = typeof options.requiredGpuProofState === 'string' && options.requiredGpuProofState.trim()
    ? options.requiredGpuProofState.trim()
    : process.env.SYNTHI_GPU_HMR_REQUIRED_PROOF_STATE;
  if (typeof requiredState === 'string' && requiredState.trim()) {
    waitArgs.requiredGpuProofState = requiredState.trim();
  } else if (isGpuDeviceEdit && process.env.SYNTHI_GPU_HMR_REQUIRE_FULL_RUNTIME_PROOF !== '0') {
    waitArgs.requireGpuFullRuntimeProof = true;
  }
  return {
    waitArgs,
    role,
    isGpuDeviceEdit,
    binding: {
      workspaceSlug: CFG.slug,
      workspace_slug: CFG.slug,
      compileDispatchedAt: Number.isFinite(compile?.dispatched_at) ? compile.dispatched_at : null,
      compile_dispatched_at: Number.isFinite(compile?.dispatched_at) ? compile.dispatched_at : null,
      sinceTs: waitArgs.since_ts ?? null,
      since_ts: waitArgs.since_ts ?? null,
      module: waitArgs.module ?? null,
      selectedPath: filename || null,
      selected_path: filename || null,
      editId: options.editId ?? null,
      edit_id: options.editId ?? null,
      editHash: options.editHash ?? null,
      edit_hash: options.editHash ?? null,
      artifactHashAfter: compile?.artifact_hash_after ?? compile?.artifactHashAfter ?? compile?.artifact_hash ?? compile?.artifactHash ?? null,
      artifact_hash_after: compile?.artifact_hash_after ?? compile?.artifactHashAfter ?? compile?.artifact_hash ?? compile?.artifactHash ?? null,
    },
  };
}

function declaredManifestModuleFiles(manifest) {
  const moduleFiles = manifest?.module_files && typeof manifest.module_files === 'object'
    ? manifest.module_files
    : {};
  return Object.fromEntries(
    Object.entries(moduleFiles)
      .map(([role, filePath]) => [String(role || '').trim(), cleanRel(filePath)])
      .filter(([role, filePath]) => role && filePath),
  );
}

function declaredManifestDeviceRoles(manifest) {
  const roles = Array.isArray(manifest?.gpu?.device_roles)
    ? manifest.gpu.device_roles
    : [];
  return roles
    .filter((role) => role && typeof role === 'object')
    .map((role, index) => ({
      id: String(role.id ?? `device.role.${index}`).trim() || `device.role.${index}`,
      path: cleanRel(role.path),
      compiler: typeof role.compiler === 'string' ? role.compiler : null,
      arch: Array.isArray(role.arch) ? role.arch : [],
    }))
    .filter((role) => role.path);
}

function manifestRolePaths(manifest, vendor) {
  const moduleFiles = declaredManifestModuleFiles(manifest);
  const moduleEntries = Object.entries(moduleFiles);
  if (moduleEntries.length === 0) {
    throw new Error('generated split compile_manifest.module_files missing explicit generated file roles');
  }
  const deviceRoles = declaredManifestDeviceRoles(manifest);
  if (deviceRoles.length === 0) {
    throw new Error('generated split compile_manifest.gpu.device_roles missing explicit device role paths');
  }
  const declaredPathSet = new Set(moduleEntries.map(([, filePath]) => filePath));
  const undeclaredDevicePaths = deviceRoles
    .map((role) => role.path)
    .filter((filePath) => !declaredPathSet.has(filePath));
  if (undeclaredDevicePaths.length > 0) {
    throw new Error(`generated split device role paths are not declared module files: ${undeclaredDevicePaths.join(', ')}`);
  }
  const selectedDeviceRole = deviceRoles.find((role) => role.id === 'device' || role.id === 'device.device')
    ?? deviceRoles[0];
  const allPaths = [...new Set(moduleEntries.map(([, filePath]) => filePath))];
  const deviceRolePaths = [...new Set(deviceRoles.map((role) => role.path))];
  return {
    ...moduleFiles,
    device: selectedDeviceRole.path,
    allPaths,
    all_paths: allPaths,
    moduleFiles,
    module_files: moduleFiles,
    deviceRolePaths,
    device_role_paths: deviceRolePaths,
    deviceRoles,
    device_roles: deviceRoles,
    vendor: String(manifest?.gpu?.vendor ?? vendor ?? '').toLowerCase() || null,
  };
}

function splitRolePaths(split) {
  if (Array.isArray(split?.roles?.allPaths)) return split.roles.allPaths.map(cleanRel).filter(Boolean);
  if (Array.isArray(split?.roles?.all_paths)) return split.roles.all_paths.map(cleanRel).filter(Boolean);
  if (split?.roles?.moduleFiles && typeof split.roles.moduleFiles === 'object') {
    return Object.values(split.roles.moduleFiles).map(cleanRel).filter(Boolean);
  }
  if (split?.roles?.module_files && typeof split.roles.module_files === 'object') {
    return Object.values(split.roles.module_files).map(cleanRel).filter(Boolean);
  }
  return Object.values(split?.roles || {})
    .filter((value) => typeof value === 'string')
    .map(cleanRel)
    .filter(Boolean);
}

function splitDeviceRolePaths(split) {
  if (Array.isArray(split?.roles?.deviceRolePaths)) return split.roles.deviceRolePaths.map(cleanRel).filter(Boolean);
  if (Array.isArray(split?.roles?.device_role_paths)) return split.roles.device_role_paths.map(cleanRel).filter(Boolean);
  return [split?.roles?.device].map(cleanRel).filter(Boolean);
}

function splitHostModulePaths(split) {
  const devicePaths = new Set(splitDeviceRolePaths(split));
  return splitRolePaths(split).filter((filePath) => !devicePaths.has(filePath));
}

async function readGeneratedSplit(vendor) {
  const workspacePath = await workerWorkspacePath();
  const sidecarRaw = await readWorkerFile(workspacePath, '.synthi_split_meta.json');
  const sidecar = JSON.parse(sidecarRaw);
  const manifest = sidecar.compile_manifest;
  if (!manifest?.gpu) throw new Error('generated sidecar missing compile_manifest.gpu');
  const roles = manifestRolePaths(manifest, vendor);
  const files = {};
  for (const rel of splitRolePaths({ roles })) {
    files[rel] = await readWorkerFile(workspacePath, rel);
  }
  return { workspacePath, sidecarRaw, sidecar, manifest, roles, files };
}

async function refreshGeneratedSplitSidecar(split, filePath, source) {
  const sidecarRaw = await readWorkerFile(split.workspacePath, '.synthi_split_meta.json');
  const sidecar = JSON.parse(sidecarRaw);
  const sourceBaselineProof = sourceBaselineProofFromSidecar(sidecarRaw, filePath, source);
  if (!sourceBaselineProof.accepted) {
    throw new Error(`generated split sidecar did not refresh compiler-emitted source baseline proof for ${filePath}: ${sourceBaselineProof.failures.join('|')}`);
  }
  split.sidecarRaw = sidecarRaw;
  split.sidecar = sidecar;
  if (sidecar.compile_manifest?.gpu) {
    split.manifest = sidecar.compile_manifest;
  }
  return sourceBaselineProof;
}

function validateGeneratedSplit(split) {
  const missing = [];
  const rolePaths = splitRolePaths(split);
  const deviceRolePaths = splitDeviceRolePaths(split);
  if (rolePaths.length === 0) missing.push('explicit generated module_files');
  if (deviceRolePaths.length === 0) missing.push('explicit gpu.device_roles');
  for (const filePath of rolePaths) {
    if (!Object.prototype.hasOwnProperty.call(split.files || {}, filePath)) {
      missing.push(`generated file ${filePath}`);
    }
  }
  for (const filePath of deviceRolePaths) {
    if (!rolePaths.includes(filePath)) missing.push(`device role declared module file ${filePath}`);
  }
  const granularity = assessGeneratedGpuSplitGranularity({
    manifest: split.manifest,
    files: split.files,
    vendor: split.manifest?.gpu?.vendor,
  });
  if (granularity.deviceRoleCount <= 0) missing.push('manifest device role topology');
  for (const filePath of granularity.missingDeviceRolePaths ?? []) {
    missing.push(`device role source ${filePath}`);
  }
  if (granularity.kernelCount <= 0) missing.push('device entrypoint symbol');
  if (missing.length) throw new Error(`generated split missing expected generated pieces: ${missing.join(', ')}`);
  record(
    'generated split explicit GPU roles',
    'pass',
    `module_files=${rolePaths.join(', ')} device_roles=${deviceRolePaths.join(', ')}`,
  );
  assertNoGeneratedSplitFissionOverclaim(granularity);
  record(
    'generated split HMR granularity',
    'pass',
    [
      `claim=${granularity.acceptedClaim}`,
      `device_tus=${granularity.deviceTranslationUnitCount}`,
      `device_roles=${granularity.deviceRoleCount}`,
      `kernels=${granularity.kernelCount}`,
      `smallest_safe_fission=${granularity.smallestSafeFissionIslandProven ? 'proven' : 'not_proven'}`,
      `rejected_claims=${granularity.rejectedClaims.join('|')}`,
    ].join(' '),
  );
  return granularity;
}

function proofIdsFromRuntimeWait(wait) {
  const proofValidation = wait?.gpu_proof_validation && typeof wait.gpu_proof_validation === 'object'
    ? wait.gpu_proof_validation
    : {};
  const ledgerValidation = proofValidation.proofLedgerValidation
    && typeof proofValidation.proofLedgerValidation === 'object'
    ? proofValidation.proofLedgerValidation
    : {};
  const telemetry = wait?.gpu_proof_telemetry && typeof wait.gpu_proof_telemetry === 'object'
    ? wait.gpu_proof_telemetry
    : {};
  return [...new Set([
    ledgerValidation.proofId,
    ledgerValidation.proof_id,
    telemetry.proofId,
    telemetry.proof_id,
  ].filter((value) => typeof value === 'string' && value.trim()))];
}

function deterministicVisualOracleContract({ visualDelta, wait, selectedPath }) {
  if (!visualDelta) return {};
  const proofValidation = wait?.gpu_proof_validation && typeof wait.gpu_proof_validation === 'object'
    ? wait.gpu_proof_validation
    : {};
  const ledgerValidation = proofValidation.proofLedgerValidation
    && typeof proofValidation.proofLedgerValidation === 'object'
    ? proofValidation.proofLedgerValidation
    : {};
  const telemetry = wait?.gpu_proof_telemetry && typeof wait.gpu_proof_telemetry === 'object'
    ? wait.gpu_proof_telemetry
    : {};
  const frameGate = wait?.frame_gate && typeof wait.frame_gate === 'object' ? wait.frame_gate : {};
  const oracleSeed = {
    selectedPath,
    proofIds: proofIdsFromRuntimeWait(wait),
    frameGateToken: frameGate.gate_token ?? null,
    changedRatio: visualDelta.changedRatio ?? null,
    meanAbs: visualDelta.meanAbs ?? null,
    diffPath: visualDelta.diffPath ?? null,
    selectedSeq: visualDelta.selectedSeq ?? null,
  };
  return {
    oracleId: `oracle:generated-split-visual:sha256:${sha256Hex(stableJson(oracleSeed))}`,
    kind: 'visual',
    target: 'framebuffer',
    visualRegion: 'full_frame',
    selectedPath,
    diffPath: visualDelta.diffPath ?? null,
    changedPixelRatio: visualDelta.changedRatio ?? null,
    meanAbsDelta8bit: visualDelta.meanAbs ?? null,
    controlChangedPixelRatio: visualDelta.controlChangedRatio ?? null,
    controlMeanAbsDelta8bit: visualDelta.controlMeanAbs ?? null,
    selectedFrameSeq: visualDelta.selectedSeq ?? null,
    selectedDeltaMs: visualDelta.selectedDeltaMs ?? null,
    frameGateToken: frameGate.gate_token ?? null,
    frameGateSeq: frameGate.frame_seq ?? null,
    frameGateTimestampMs: frameGate.ts_ms ?? null,
    frameCaptureAfterEpochDispatch: true,
    runtimeProofId: telemetry.proofId ?? telemetry.proof_id ?? null,
    ledgerProofId: ledgerValidation.proofId ?? ledgerValidation.proof_id ?? null,
  };
}

function roleHashMap(files, rolePaths, selectedPath = null) {
  const out = {};
  for (const rolePath of rolePaths ?? []) {
    const normalized = cleanRel(rolePath);
    if (!normalized || normalized === cleanRel(selectedPath)) continue;
    out[normalized] = `sha256:${sha256Hex(files?.[normalized] ?? '')}`;
  }
  return out;
}

function selectedFissionRole(granularity, selectedPath) {
  const normalized = cleanRel(selectedPath);
  return (granularity?.roleReports ?? [])
    .find((role) => cleanRel(role?.path) === normalized) ?? null;
}

function selectedFissionKernel(granularity, selectedPath) {
  const role = selectedFissionRole(granularity, selectedPath);
  return role?.kernelCount === 1 ? role.kernelSymbols?.[0] ?? null : null;
}

function selectedFissionIslandId(selectedPath, selectedKernel) {
  return selectedKernel
    ? `kernel:${selectedKernel}:${sha256Hex(cleanRel(selectedPath)).slice(0, 16)}`
    : `device-role:${sha256Hex(cleanRel(selectedPath)).slice(0, 16)}`;
}

function generatedFissionEvidenceRecord(category, evidenceType, subject, payload = {}) {
  const contentHash = `sha256:${sha256Hex(stableJson({
    schemaVersion: GPU_HMR_GENERATED_SPLIT_DETERMINISTIC_FISSION_EVIDENCE_SCHEMA_VERSION,
    category,
    evidenceType,
    subject,
    payload,
  }))}`;
  const evidenceHash = sha256Hex(stableJson({
    category,
    evidenceType,
    contentHash,
    subject,
  }));
  return {
    schemaVersion: GPU_HMR_GENERATED_SPLIT_DETERMINISTIC_FISSION_EVIDENCE_SCHEMA_VERSION,
    schema_version: GPU_HMR_GENERATED_SPLIT_DETERMINISTIC_FISSION_EVIDENCE_SCHEMA_VERSION,
    category,
    evidenceType,
    evidence_type: evidenceType,
    evidenceRefs: [`evidence:generated-split-fission:${category}:sha256:${evidenceHash}`],
    evidence_refs: [`evidence:generated-split-fission:${category}:sha256:${evidenceHash}`],
    contentHash,
    content_hash: contentHash,
    subject,
    payload,
  };
}

function deterministicFissionEvidenceForRuntime({
  granularity,
  selectedPath,
  changedPaths,
  selectedArtifact,
  outputOracleContract,
  abiCompatibilityClass,
  includedDependencies,
  unaffectedArtifactHashesBefore,
  unaffectedArtifactHashesAfter,
  compilerArgsHash,
  compileTarget,
  fullDeviceFallback,
  hostRelinked,
  fullRebuildUsed,
  processRestarted,
}) {
  const normalizedSelectedPath = cleanRel(selectedPath);
  const selectedKernel = selectedFissionKernel(granularity, normalizedSelectedPath);
  if (!normalizedSelectedPath || !selectedKernel) return [];
  const selectedIslandId = selectedFissionIslandId(normalizedSelectedPath, selectedKernel);
  const subject = {
    selectedPath: normalizedSelectedPath,
    selected_path: normalizedSelectedPath,
    sourcePaths: [normalizedSelectedPath],
    source_paths: [normalizedSelectedPath],
    selectedIslandId,
    selected_island_id: selectedIslandId,
    targetSymbols: [selectedKernel],
    target_symbols: [selectedKernel],
  };
  const proofIds = selectedArtifact?.proofIds ?? selectedArtifact?.proof_ids ?? [];
  return [
    generatedFissionEvidenceRecord('selected_island_binding', 'selected_island_binding', subject, {
      binding: 'generated_device_kernel',
      sourcePath: normalizedSelectedPath,
      source_path: normalizedSelectedPath,
    }),
    generatedFissionEvidenceRecord('source_mapping', 'source_mapping', subject, {
      mappedSource: normalizedSelectedPath,
      mapped_source: normalizedSelectedPath,
      sourceHashBefore: selectedArtifact?.sourceHashBefore ?? null,
      source_hash_before: selectedArtifact?.sourceHashBefore ?? null,
      sourceHashAfter: selectedArtifact?.sourceHashAfter ?? null,
      source_hash_after: selectedArtifact?.sourceHashAfter ?? null,
    }),
    generatedFissionEvidenceRecord('include_closure', 'include_closure', subject, {
      includedDependencies,
      included_dependencies: includedDependencies,
    }),
    generatedFissionEvidenceRecord('symbol_ownership', 'symbol_ownership', subject, {
      ownedSymbols: [selectedKernel],
      owned_symbols: [selectedKernel],
      roleReports: granularity?.roleReports ?? [],
      role_reports: granularity?.roleReports ?? [],
    }),
    generatedFissionEvidenceRecord('dependency_closure', 'dependency_closure', subject, {
      changedPaths,
      changed_paths: changedPaths,
      unaffectedArtifactHashesBefore,
      unaffected_artifact_hashes_before: unaffectedArtifactHashesBefore,
      unaffectedArtifactHashesAfter,
      unaffected_artifact_hashes_after: unaffectedArtifactHashesAfter,
    }),
    generatedFissionEvidenceRecord('abi_membrane', 'abi_membrane', subject, {
      abiCompatibilityClass,
      abi_compatibility_class: abiCompatibilityClass,
    }),
    generatedFissionEvidenceRecord('compile_recipe', 'compile_proof', subject, {
      compiler: selectedFissionRole(granularity, normalizedSelectedPath)?.compiler ?? null,
      compileTarget,
      compile_target: compileTarget,
      compilerArgsHash,
      compiler_args_hash: compilerArgsHash,
    }),
    generatedFissionEvidenceRecord('loader_capability', 'loader_runtime_proof', subject, {
      runtimeProofAccepted: selectedArtifact?.runtimeProofAccepted === true,
      runtime_proof_accepted: selectedArtifact?.runtimeProofAccepted === true,
      proofIds,
      proof_ids: proofIds,
      fullDeviceFallback,
      full_device_fallback: fullDeviceFallback,
      hostRelinked,
      host_relinked: hostRelinked,
      fullRebuildUsed,
      full_rebuild_used: fullRebuildUsed,
      processRestarted,
      process_restarted: processRestarted,
    }),
    generatedFissionEvidenceRecord('output_oracle', 'output_oracle_proof', subject, {
      outputOracleContract,
      output_oracle_contract: outputOracleContract,
    }),
  ];
}

function verifyGeneratedSplitFissionAfterRuntime({
  split,
  granularity,
  generatedDeviceResult,
  visualDelta,
  selectedPath,
  previousDevice,
  editedDevice,
}) {
  const wait = generatedDeviceResult?.wait ?? {};
  const proofValidation = wait?.gpu_proof_validation && typeof wait.gpu_proof_validation === 'object'
    ? wait.gpu_proof_validation
    : {};
  const ledgerValidation = proofValidation.proofLedgerValidation
    && typeof proofValidation.proofLedgerValidation === 'object'
    ? proofValidation.proofLedgerValidation
    : {};
  const runtimeArtifactValidation = proofValidation.runtimeProofArtifactValidation
    && typeof proofValidation.runtimeProofArtifactValidation === 'object'
    ? proofValidation.runtimeProofArtifactValidation
    : {};
  const proofIds = proofIdsFromRuntimeWait(wait);
  const sourceHashBefore = `sha256:${sha256Hex(previousDevice ?? '')}`;
  const sourceHashAfter = `sha256:${sha256Hex(editedDevice ?? '')}`;
  const runtimeProofAccepted =
    wait?.status === 'applied'
    && proofValidation.satisfied === true
    && ledgerValidation.gpuHmrSuccess === true
    && Array.isArray(ledgerValidation.failedInvariants)
    && ledgerValidation.failedInvariants.length === 0
    && runtimeArtifactValidation.accepted === true;
  const selectedArtifact = {
    sourcePath: selectedPath,
    sourceHashBefore,
    sourceHashAfter,
    proofIds,
    runtimeProofAccepted,
    runtimeProofArtifactValidation: runtimeArtifactValidation,
    proofLedgerValidation: ledgerValidation,
  };
  const rolePaths = granularity.deviceRolePaths ?? [];
  const outputOracleContract = deterministicVisualOracleContract({
    visualDelta,
    wait,
    selectedPath,
  });
  const changedPaths = [selectedPath].map(cleanRel).filter(Boolean);
  const unaffectedArtifactHashesBefore = roleHashMap(split.files, rolePaths, selectedPath);
  const unaffectedArtifactHashesAfter = roleHashMap(split.files, rolePaths, selectedPath);
  const includedDependencies = [];
  const compilerArgsHash = `sha256:${sha256Hex(stableJson({
    compileManifest: split.manifest,
    gpuArch: CFG.gpuArch ?? null,
    selectedPath,
  }))}`;
  const compileTarget = CFG.gpuArch ?? split.manifest?.gpu?.arch?.[0] ?? null;
  const deterministicFissionEvidence = deterministicFissionEvidenceForRuntime({
    granularity,
    selectedPath,
    changedPaths,
    selectedArtifact,
    outputOracleContract,
    abiCompatibilityClass: 'compatible',
    includedDependencies,
    unaffectedArtifactHashesBefore,
    unaffectedArtifactHashesAfter,
    compilerArgsHash,
    compileTarget,
    fullDeviceFallback: false,
    hostRelinked: false,
    fullRebuildUsed: false,
    processRestarted: false,
  });
  const report = verifyGeneratedGpuSplitDeterministicFission({
    assessment: granularity,
    selectedPath,
    changedPaths,
    selectedArtifact,
    verificationEvidence: deterministicFissionEvidence,
    outputOracleContract,
    abiCompatibilityClass: 'compatible',
    unaffectedArtifactHashesBefore,
    unaffectedArtifactHashesAfter,
    excludedHostSources: splitHostModulePaths(split),
    includedDependencies,
    compilerArgsHash,
    compileTarget,
    fullDeviceFallback: false,
    hostRelinked: false,
    fullRebuildUsed: false,
    processRestarted: false,
  });
  assertNoGeneratedSplitFissionOverclaim(report);
  return report;
}

function gpuSplitEndpointEvidenceFromSidecar(split) {
  const sidecar = split?.sidecar && typeof split.sidecar === 'object' ? split.sidecar : {};
  const manifest = split?.manifest && typeof split.manifest === 'object' ? split.manifest : {};
  const rolePaths = splitRolePaths(split);
  const gpuManifestObserved = Boolean(manifest.gpu)
    && rolePaths.some((filePath) => /\.(hip|cu|cl|wgsl|glsl|spv|spirv)$/i.test(filePath));
  const sidecarReports = [
    'agentic_split_report',
    'generated_artifact_purity_report',
    'device_mapping_report',
    'deterministic_source_context_report',
    'launch_indirection_report',
    'model_provenance',
  ].filter((key) => sidecar[key] && typeof sidecar[key] === 'object');
  const generatedFilesObserved = rolePaths.length > 0
    && rolePaths.every((filePath) => split.files && Object.prototype.hasOwnProperty.call(split.files, filePath));
  return {
    observed: gpuManifestObserved && generatedFilesObserved,
    detail: [
      `gpu_manifest=${gpuManifestObserved}`,
      `generated_files=${rolePaths.length}`,
      `sidecar_reports=${sidecarReports.join('|') || 'none'}`,
    ].join(' '),
  };
}

function sourceFirstInitialFileManifest(files) {
  const entries = Array.isArray(files) ? files : [];
  return entries
    .map((entry) => {
      const filePath = cleanRel(entry?.path ?? entry?.name ?? entry?.filename ?? '');
      const content = typeof entry?.content === 'string' ? entry.content : '';
      return {
        path: filePath,
        contentHash: filePath ? `sha256:${sha256Hex(content)}` : null,
        content_hash: filePath ? `sha256:${sha256Hex(content)}` : null,
        byteLength: Buffer.byteLength(content, 'utf8'),
        byte_length: Buffer.byteLength(content, 'utf8'),
      };
    })
    .filter((entry) => entry.path);
}

function sourceFirstPreexistingGeneratedArtifactPath(filePath) {
  const normalized = cleanRel(filePath).toLowerCase();
  if (!normalized) return false;
  return normalized.startsWith('.synthi/')
    || normalized.includes('/.synthi/')
    || normalized === '.synthi_split_meta.json'
    || normalized.endsWith('/.synthi_split_meta.json');
}

function generatedSplitArtifactManifest(split) {
  return Object.entries(split?.files ?? {})
    .map(([filePath, content]) => ({
      path: cleanRel(filePath),
      contentHash: `sha256:${sha256Hex(content)}`,
      content_hash: `sha256:${sha256Hex(content)}`,
      byteLength: Buffer.byteLength(String(content ?? ''), 'utf8'),
      byte_length: Buffer.byteLength(String(content ?? ''), 'utf8'),
    }))
    .sort((left, right) => left.path.localeCompare(right.path));
}

function sourceFirstWorkspaceSourceProvenanceEvidence({
  sourceAuthority,
  sourceContentHash,
  sourceTreeManifestHash,
  initialManifestHash,
  initialFiles,
} = {}) {
  if (!['user_source_files', 'workspace_source_files'].includes(sourceAuthority)) return null;
  const sourceRoot =
    ACTIVE_AGENT_PROFILE?.source?.directSourceRoot
    ?? ACTIVE_AGENT_PROFILE?.source?.direct_source_root
    ?? ACTIVE_AGENT_PROFILE?.source?.sourceRoot
    ?? ACTIVE_AGENT_PROFILE?.source?.source_root
    ?? null;
  const normalizedSourceRoot =
    sourceRoot && existsSync(sourceRoot)
      ? realpathSync(sourceRoot)
      : sourceRoot;
  const fileManifest = Array.isArray(initialFiles)
    ? initialFiles.map((entry) => ({
        path: cleanRel(entry?.path ?? ''),
        contentHash: entry?.contentHash ?? entry?.content_hash ?? null,
        content_hash: entry?.contentHash ?? entry?.content_hash ?? null,
        byteLength: Number.isFinite(Number(entry?.byteLength ?? entry?.byte_length))
          ? Number(entry.byteLength ?? entry.byte_length)
          : null,
        byte_length: Number.isFinite(Number(entry?.byteLength ?? entry?.byte_length))
          ? Number(entry.byteLength ?? entry.byte_length)
          : null,
      })).filter((entry) => entry.path)
    : [];
  const sourceTreeSnapshotHash = sourceTreeManifestHash || (
    fileManifest.length > 0
      ? `sha256:${sha256Hex(stableJson(fileManifest))}`
      : null
  );
  const accepted =
    Boolean(normalizedSourceRoot)
    && /^sha256:[a-f0-9]{64}$/.test(String(sourceTreeSnapshotHash ?? ''))
    && /^sha256:[a-f0-9]{64}$/.test(String(sourceContentHash ?? ''))
    && /^sha256:[a-f0-9]{64}$/.test(String(initialManifestHash ?? ''));
  const provenanceSeed = {
    sourceAuthority,
    sourceRoot: normalizedSourceRoot,
    sourceContentHash,
    sourceTreeSnapshotHash,
    initialManifestHash,
    fileManifest,
  };
  const provenanceHash = `sha256:${sha256Hex(stableJson(provenanceSeed))}`;
  return {
    schemaVersion: 'synthi.gpu_hmr.source_first_workspace_source_provenance.v1',
    schema_version: 'synthi.gpu_hmr.source_first_workspace_source_provenance.v1',
    proofAuthority: 'workspace_source_tree_provenance_only_not_gpu_hmr_success',
    proof_authority: 'workspace_source_tree_provenance_only_not_gpu_hmr_success',
    accepted,
    acceptedAsSourceProvenance: accepted,
    accepted_as_source_provenance: accepted,
    sourceAuthority,
    source_authority: sourceAuthority,
    sourceRoot: normalizedSourceRoot,
    source_root: normalizedSourceRoot,
    workspaceRoot: normalizedSourceRoot,
    workspace_root: normalizedSourceRoot,
    sourceContentHash,
    source_content_hash: sourceContentHash,
    sourceTreeSnapshotHash,
    source_tree_snapshot_hash: sourceTreeSnapshotHash,
    sourceTreeManifestHash,
    source_tree_manifest_hash: sourceTreeManifestHash,
    initialManifestHash,
    initial_manifest_hash: initialManifestHash,
    fileManifest,
    file_manifest: fileManifest,
    targetNameIndependent: true,
    target_name_independent: true,
    projectNameWhitelist: [],
    project_name_whitelist: [],
    specificTargetIdsAllowed: [],
    specific_target_ids_allowed: [],
    provenanceHash,
    provenance_hash: provenanceHash,
    evidenceRef: `workspace-source-provenance:${provenanceHash}`,
    evidence_ref: `workspace-source-provenance:${provenanceHash}`,
    acceptedForGpuHmr: false,
    accepted_for_gpu_hmr: false,
    gpuHmrSuccess: false,
    gpu_hmr_success: false,
    canSatisfyRuntimeProof: false,
    can_satisfy_runtime_proof: false,
    canSatisfyDispatchProof: false,
    can_satisfy_dispatch_proof: false,
  };
}

function directSourceContextFromProfile(profile = ACTIVE_AGENT_PROFILE) {
  const sourceAuthority = profile?.sourceAuthority ?? profile?.source_authority ?? '';
  if (!STRICT_DIRECT_SOURCE_AUTHORITIES.has(sourceAuthority)) return null;
  const source = profile?.source && typeof profile.source === 'object' ? profile.source : {};
  const sourceKind =
    source.sourceKind
    ?? source.source_kind
    ?? (sourceAuthority === 'direct_local_git_repo_path'
      ? 'local_repo_path_commit'
      : 'source_url_commit');
  const sourceUrl = String(source.sourceUrl ?? source.source_url ?? '').trim();
  const repoPath = String(
    source.repoPath
      ?? source.repo_path
      ?? source.directSourceRoot
      ?? source.direct_source_root
      ?? source.sourceRoot
      ?? source.source_root
      ?? '',
  ).trim();
  const immutableCommit = String(
    source.immutableCommit
      ?? source.immutable_commit
      ?? '',
  ).trim();
  const immutableSourceIdentity =
    source.immutableSourceIdentity
    ?? source.immutable_source_identity
    ?? null;
  const immutableSourceIdentityHash = String(
    immutableSourceIdentity?.identityHash
      ?? immutableSourceIdentity?.identity_hash
      ?? '',
  ).trim().toLowerCase();
  const suppliedInputChannels = uniqueSortedStrings([
    ...(Array.isArray(source.directSourceInputChannels) ? source.directSourceInputChannels : []),
    ...(Array.isArray(source.direct_source_input_channels) ? source.direct_source_input_channels : []),
  ]);
  const inputChannels = suppliedInputChannels.length > 0
    ? suppliedInputChannels
    : uniqueSortedStrings([
        CFG.directSourceManifestPath ? 'env:SYNTHI_GPU_AGENT_SOURCE_MANIFEST_PATH' : null,
        CFG.directSourceRoot ? 'env:SYNTHI_GPU_AGENT_SOURCE_ROOT' : null,
        CFG.directSourceAuthority ? 'env:SYNTHI_GPU_AGENT_SOURCE_AUTHORITY' : null,
      ]);
  return {
    sourceAuthority,
    source_authority: sourceAuthority,
    candidateSource: sourceAuthority,
    candidate_source: sourceAuthority,
    sourceKind,
    source_kind: sourceKind,
    sourceUrl: sourceUrl || null,
    source_url: sourceUrl || null,
    repoPath: repoPath || null,
    repo_path: repoPath || null,
    immutableCommit: immutableCommit || null,
    immutable_commit: immutableCommit || null,
    immutableSourceIdentity,
    immutable_source_identity: immutableSourceIdentity,
    immutableSourceIdentityHash: immutableSourceIdentityHash || null,
    immutable_source_identity_hash: immutableSourceIdentityHash || null,
    inputChannels,
    input_channels: inputChannels,
  };
}

function directSourceIdentityHash({
  candidateSource,
  sourceKind,
  sourceUrl,
  repoPath,
  immutableCommit,
  immutableSourceIdentityHash,
  inputChannels,
} = {}) {
  const normalizedSourceUrl = String(sourceUrl ?? '').trim();
  const normalizedRepoPath = String(repoPath ?? '').trim();
  const seed = {
    schemaVersion: DIRECT_SOURCE_INPUT_SCHEMA_VERSION,
    candidateSource: String(candidateSource ?? '').trim(),
    sourceKind: String(sourceKind ?? '').trim(),
    hasSourceUrl: Boolean(normalizedSourceUrl),
    hasRepoPath: Boolean(normalizedRepoPath),
    sourceUrlHash: normalizedSourceUrl ? `sha256:${sha256Hex(normalizedSourceUrl)}` : null,
    repoPathHash: normalizedRepoPath ? `sha256:${sha256Hex(normalizedRepoPath)}` : null,
    immutableCommit: String(immutableCommit ?? '').trim().toLowerCase(),
    immutableSourceIdentityHash: String(immutableSourceIdentityHash ?? '').trim().toLowerCase() || null,
    inputChannels: uniqueSortedStrings(inputChannels),
  };
  return `sha256:${sha256Hex(stableJson(seed))}`;
}

function directSourceInputEvidenceForProfile(profile = ACTIVE_AGENT_PROFILE) {
  const context = directSourceContextFromProfile(profile);
  if (!context) return null;
  const candidateSource = context.candidateSource;
  const sourceKind = context.sourceKind;
  const sourceUrl = context.sourceUrl;
  const repoPath = context.repoPath;
  const immutableCommit = context.immutableCommit;
  const immutableSourceIdentity = context.immutableSourceIdentity;
  const immutableSourceIdentityHash = context.immutableSourceIdentityHash;
  const inputChannels = uniqueSortedStrings(context.inputChannels);
  const sourceIdentityHash = directSourceIdentityHash({
    candidateSource,
    sourceKind,
    sourceUrl,
    repoPath,
    immutableCommit,
    immutableSourceIdentityHash,
    inputChannels,
  });
  const cliOrEnvChannelObserved = inputChannels.some((channel) =>
    /^cli_arg[_:]/.test(channel) || /^env[_:]/.test(channel)
  );
  const blockingGaps = [
    candidateSource === 'direct_source_url_commit' || candidateSource === 'direct_local_git_repo_path'
      ? null
      : 'direct_source_input_candidate_source_not_direct',
    sourceKind === (candidateSource === 'direct_local_git_repo_path' ? 'local_repo_path_commit' : 'source_url_commit')
      ? null
      : 'direct_source_input_source_kind_mismatch',
    cliOrEnvChannelObserved ? null : 'direct_source_input_cli_or_env_channel_missing',
    immutableCommit ? null : 'direct_source_input_commit_missing',
    candidateSource !== 'direct_local_git_repo_path' || immutableSourceIdentityHash
      ? null
      : 'direct_source_input_git_identity_missing',
    sourceUrl || repoPath ? null : 'direct_source_input_source_identity_missing',
  ].filter(Boolean);
  const accepted = blockingGaps.length === 0;
  return {
    schemaVersion: DIRECT_SOURCE_INPUT_SCHEMA_VERSION,
    schema_version: DIRECT_SOURCE_INPUT_SCHEMA_VERSION,
    proofAuthority: DIRECT_SOURCE_INPUT_AUTHORITY,
    proof_authority: DIRECT_SOURCE_INPUT_AUTHORITY,
    accepted,
    acceptedAsDirectInputEvidence: accepted,
    accepted_as_direct_input_evidence: accepted,
    acceptedForGpuHmr: false,
    accepted_for_gpu_hmr: false,
    gpuHmrSuccess: false,
    gpu_hmr_success: false,
    canSatisfyRuntimeProof: false,
    can_satisfy_runtime_proof: false,
    canSatisfyDispatchProof: false,
    can_satisfy_dispatch_proof: false,
    inputMode: 'cli_or_env_direct_source',
    input_mode: 'cli_or_env_direct_source',
    inputChannels,
    input_channels: inputChannels,
    candidateSource,
    candidate_source: candidateSource,
    sourceKind,
    source_kind: sourceKind,
    sourceIdentityRole: DIRECT_SOURCE_INPUT_IDENTITY_ROLE,
    source_identity_role: DIRECT_SOURCE_INPUT_IDENTITY_ROLE,
    targetNameIndependent: true,
    target_name_independent: true,
    projectNameWhitelist: [],
    project_name_whitelist: [],
    specificTargetIdsAllowed: [],
    specific_target_ids_allowed: [],
    sourceIdentityHash,
    source_identity_hash: sourceIdentityHash,
    immutableSourceIdentity,
    immutable_source_identity: immutableSourceIdentity,
    immutableSourceIdentityHash: immutableSourceIdentityHash || null,
    immutable_source_identity_hash: immutableSourceIdentityHash || null,
    evidenceHash: sourceIdentityHash,
    evidence_hash: sourceIdentityHash,
    blockingGaps,
    blocking_gaps: blockingGaps,
  };
}

function directSourceRuntimeContractExpectationForProfile(
  profile = ACTIVE_AGENT_PROFILE,
  directSourceInputEvidence = null,
) {
  const sourceAuthority = profile?.sourceAuthority ?? profile?.source_authority ?? '';
  if (!DIRECT_SOURCE_AUTHORITIES.has(sourceAuthority)) return null;
  const source = profile?.source && typeof profile.source === 'object' ? profile.source : {};
  const declared = profileObject(
    source.runtimeContractExpectation
      ?? source.runtime_contract_expectation
      ?? source.directSourceRuntimeContractExpectation
      ?? source.direct_source_runtime_contract_expectation,
    'directSource.runtimeContractExpectation',
    {},
  );
  const buildMetadata = profileObject(
    declared.buildMetadata
      ?? declared.build_metadata
      ?? source.buildMetadata
      ?? source.build_metadata,
    'directSource.runtimeContractExpectation.buildMetadata',
    {},
  );
  const outputOracle = profileObject(
    declared.outputOracle
      ?? declared.output_oracle
      ?? source.outputOracle
      ?? source.output_oracle,
    'directSource.runtimeContractExpectation.outputOracle',
    {},
  );
  const backend = profileString(
    declared.backend
      ?? declared.backendFamily
      ?? declared.backend_family
      ?? source.backend
      ?? source.backendFamily
      ?? source.backend_family,
    'directSource.runtimeContractExpectation.backend',
  ).toLowerCase();
  const buildSystem = profileString(
    declared.buildSystem
      ?? declared.build_system
      ?? buildMetadata.buildSystem
      ?? buildMetadata.build_system
      ?? source.buildSystem
      ?? source.build_system,
    'directSource.runtimeContractExpectation.buildSystem',
  ).toLowerCase();
  const buildMetadataPaths = uniqueSortedStrings([
    ...(Array.isArray(declared.buildMetadataPaths) ? declared.buildMetadataPaths : []),
    ...(Array.isArray(declared.build_metadata_paths) ? declared.build_metadata_paths : []),
    ...(Array.isArray(buildMetadata.paths) ? buildMetadata.paths : []),
    ...(Array.isArray(buildMetadata.files) ? buildMetadata.files : []),
    ...(Array.isArray(source.buildMetadataPaths) ? source.buildMetadataPaths : []),
    ...(Array.isArray(source.build_metadata_paths) ? source.build_metadata_paths : []),
  ].map(cleanRel));
  const declaredRuntimeStages = uniqueSortedStrings([
    ...runtimeBoundaryStageNames(declared.runtimeBoundaryStages),
    ...runtimeBoundaryStageNames(declared.runtime_boundary_stages),
    ...runtimeBoundaryStageNames(declared.boundaryStages),
    ...runtimeBoundaryStageNames(declared.boundary_stages),
    ...runtimeBoundaryStageNames(source.runtimeBoundaryStages),
    ...runtimeBoundaryStageNames(source.runtime_boundary_stages),
  ]);
  const outputOracleKind = profileString(
    declared.outputOracleKind
      ?? declared.output_oracle_kind
      ?? outputOracle.kind
      ?? outputOracle.oracleKind
      ?? outputOracle.oracle_kind,
    'directSource.runtimeContractExpectation.outputOracleKind',
  ).toLowerCase();
  const declaredDeviceEditCount = Array.isArray(profile?.deviceEdits)
    ? profile.deviceEdits.length
    : 0;
  const missingRuntimeStages = DIRECT_SOURCE_RUNTIME_BOUNDARY_STAGES
    .filter((stage) => !declaredRuntimeStages.includes(stage));
  const declaredClaimsGpuHmr =
    declared.acceptedForGpuHmr === true
    || declared.accepted_for_gpu_hmr === true
    || declared.gpuHmrSuccess === true
    || declared.gpu_hmr_success === true
    || declared.canSatisfyRuntimeProof === true
    || declared.can_satisfy_runtime_proof === true
    || declared.canSatisfyDispatchProof === true
    || declared.can_satisfy_dispatch_proof === true;
  const sourceIdentityHash =
    directSourceInputEvidence?.sourceIdentityHash
    ?? directSourceInputEvidence?.source_identity_hash
    ?? null;
  const blockingGaps = [
    backend ? null : 'direct_source_runtime_contract_backend_missing',
    buildSystem || buildMetadataPaths.length > 0
      ? null
      : 'direct_source_runtime_contract_build_metadata_missing',
    missingRuntimeStages.length === 0
      ? null
      : 'direct_source_runtime_contract_boundary_stages_incomplete',
    outputOracleKind === 'visual_oracle' || outputOracleKind === 'compute_oracle'
      ? null
      : 'direct_source_runtime_contract_output_oracle_missing',
    declaredDeviceEditCount > 0
      ? null
      : 'direct_source_runtime_contract_declared_device_edits_missing',
    sourceIdentityHash || !STRICT_DIRECT_SOURCE_AUTHORITIES.has(sourceAuthority)
      ? null
      : 'direct_source_runtime_contract_source_identity_missing',
    declaredClaimsGpuHmr
      ? 'direct_source_runtime_contract_claimed_authority'
      : null,
  ].filter(Boolean);
  const expectationSeed = {
    schemaVersion: DIRECT_SOURCE_RUNTIME_CONTRACT_EXPECTATION_SCHEMA_VERSION,
    sourceAuthority,
    backend,
    buildSystem,
    buildMetadataPaths,
    runtimeBoundaryStagesRequired: DIRECT_SOURCE_RUNTIME_BOUNDARY_STAGES,
    declaredRuntimeStages,
    outputOracleKind,
    declaredDeviceEditCount,
    sourceIdentityHash,
    blockingGaps,
  };
  const expectationHash = `sha256:${sha256Hex(stableJson(expectationSeed))}`;
  const accepted = blockingGaps.length === 0;
  return {
    schemaVersion: DIRECT_SOURCE_RUNTIME_CONTRACT_EXPECTATION_SCHEMA_VERSION,
    schema_version: DIRECT_SOURCE_RUNTIME_CONTRACT_EXPECTATION_SCHEMA_VERSION,
    proofAuthority: DIRECT_SOURCE_RUNTIME_CONTRACT_EXPECTATION_AUTHORITY,
    proof_authority: DIRECT_SOURCE_RUNTIME_CONTRACT_EXPECTATION_AUTHORITY,
    accepted,
    acceptedAsRuntimeContractExpectation: accepted,
    accepted_as_runtime_contract_expectation: accepted,
    acceptedForGpuHmr: false,
    accepted_for_gpu_hmr: false,
    gpuHmrSuccess: false,
    gpu_hmr_success: false,
    canSatisfyRuntimeProof: false,
    can_satisfy_runtime_proof: false,
    canSatisfyDispatchProof: false,
    can_satisfy_dispatch_proof: false,
    sourceAuthority,
    source_authority: sourceAuthority,
    sourceIdentityHash,
    source_identity_hash: sourceIdentityHash,
    backend: backend || null,
    buildSystem: buildSystem || null,
    build_system: buildSystem || null,
    buildMetadataPaths,
    build_metadata_paths: buildMetadataPaths,
    runtimeBoundaryStagesRequired: DIRECT_SOURCE_RUNTIME_BOUNDARY_STAGES,
    runtime_boundary_stages_required: DIRECT_SOURCE_RUNTIME_BOUNDARY_STAGES,
    declaredRuntimeBoundaryStages: declaredRuntimeStages,
    declared_runtime_boundary_stages: declaredRuntimeStages,
    missingRuntimeBoundaryStages: missingRuntimeStages,
    missing_runtime_boundary_stages: missingRuntimeStages,
    outputOracleKind: outputOracleKind || null,
    output_oracle_kind: outputOracleKind || null,
    declaredDeviceEditCount,
    declared_device_edit_count: declaredDeviceEditCount,
    expectationHash,
    expectation_hash: expectationHash,
    evidenceRef: `direct-source-runtime-contract-expectation:${expectationHash}`,
    evidence_ref: `direct-source-runtime-contract-expectation:${expectationHash}`,
    blockingGaps,
    blocking_gaps: blockingGaps,
  };
}

function sourceFirstIngestionEvidence({
  source,
  entryPath,
  sourcePurityEvidence,
  initialCompileArgs,
  initialCompileResult,
  split,
  sawGpuSplit,
  splitEndpointEvidence,
}) {
  const splitIdentity = splitProofIdentity(split);
  const sourceContentHash = `sha256:${sha256Hex(source)}`;
  const initialFiles = sourceFirstInitialFileManifest(initialCompileArgs?.files);
  const initialFilePaths = initialFiles.map((entry) => entry.path);
  const normalizedEntryPath = cleanRel(entryPath);
  const initialSourceEntry = initialFiles.find((entry) => entry.path === normalizedEntryPath);
  const initialSourceFilePresent = Boolean(initialSourceEntry);
  const initialSourceHashMatches = initialSourceEntry?.contentHash === sourceContentHash;
  const preexistingGeneratedArtifactPaths = initialFilePaths
    .filter(sourceFirstPreexistingGeneratedArtifactPath);
  const generatedArtifacts = generatedSplitArtifactManifest(split);
  const generatedArtifactHashes = generatedArtifacts
    .map((entry) => entry.contentHash)
    .filter(Boolean);
  const sidecarHash = split?.sidecarRaw ? `sha256:${sha256Hex(split.sidecarRaw)}` : null;
  const compileManifestHash = split?.manifest
    ? `sha256:${sha256Hex(stableJson(split.manifest))}`
    : null;
  const generatedBoundaryHashSet = new Set([
    ...generatedArtifactHashes,
    sidecarHash,
    compileManifestHash,
  ]
    .map(normalizedProofContentHash)
    .filter(Boolean));
  const preexistingGeneratedArtifactHashOverlaps = initialFiles
    .map((entry) => {
      const contentHash = normalizedProofContentHash(entry.contentHash ?? entry.content_hash);
      if (!contentHash || !generatedBoundaryHashSet.has(contentHash)) return null;
      return {
        path: entry.path,
        contentHash,
        content_hash: contentHash,
      };
    })
    .filter(Boolean);
  const initialManifestHash = `sha256:${sha256Hex(stableJson(initialFiles))}`;
  const sourcePurityFiles = Array.isArray(sourcePurityEvidence?.scannedFiles)
    ? sourcePurityEvidence.scannedFiles
    : Array.isArray(sourcePurityEvidence?.scanned_files)
      ? sourcePurityEvidence.scanned_files
      : [];
  const normalizedSourcePurityFiles = sourcePurityFiles
    .map((entry) => ({
      path: cleanRel(entry?.path ?? ''),
      contentHash: entry?.contentHash ?? entry?.content_hash ?? null,
      content_hash: entry?.contentHash ?? entry?.content_hash ?? null,
      byteLength: Number.isFinite(Number(entry?.byteLength ?? entry?.byte_length))
        ? Number(entry.byteLength ?? entry.byte_length)
        : null,
      byte_length: Number.isFinite(Number(entry?.byteLength ?? entry?.byte_length))
        ? Number(entry.byteLength ?? entry.byte_length)
        : null,
      accepted: entry?.accepted === true,
      forbiddenMarkersFound: Array.isArray(entry?.forbiddenMarkersFound)
        ? entry.forbiddenMarkersFound
        : Array.isArray(entry?.forbidden_markers_found)
          ? entry.forbidden_markers_found
          : [],
      forbidden_markers_found: Array.isArray(entry?.forbiddenMarkersFound)
        ? entry.forbiddenMarkersFound
        : Array.isArray(entry?.forbidden_markers_found)
          ? entry.forbidden_markers_found
          : [],
    }))
    .filter((entry) => entry.path);
  const sourcePurityManifestHash = sourcePurityEvidence?.purityManifestHash
    ?? sourcePurityEvidence?.purity_manifest_hash
    ?? null;
  const sourcePurityInitialManifestEntries = normalizedSourcePurityFiles
    .map((entry) => ({
      path: entry.path,
      contentHash: entry.contentHash,
      content_hash: entry.content_hash,
      byteLength: entry.byteLength,
      byte_length: entry.byte_length,
    }));
  const sourcePurityInitialManifestHash = sourcePurityInitialManifestEntries.length > 0
    ? `sha256:${sha256Hex(stableJson(sourcePurityInitialManifestEntries))}`
    : null;
  const sourcePurityFileSetMatchesInitialManifest =
    Boolean(sourcePurityInitialManifestHash)
    && sourcePurityInitialManifestHash === initialManifestHash;
  const recomputedSourcePurityManifestHash = normalizedSourcePurityFiles.length > 0
    ? `sha256:${sha256Hex(stableJson(normalizedSourcePurityFiles))}`
    : null;
  const sourcePurityManifestHashMatches =
    Boolean(sourcePurityManifestHash)
    && Boolean(recomputedSourcePurityManifestHash)
    && sourcePurityManifestHash === recomputedSourcePurityManifestHash;
  const sourcePurityCoversInitialManifest =
    sourcePurityFileSetMatchesInitialManifest
    && normalizedSourcePurityFiles.every((purityEntry) => purityEntry.accepted === true);
  const sourceTreeManifestHash =
    ACTIVE_AGENT_PROFILE?.source?.manifestHash
    ?? ACTIVE_AGENT_PROFILE?.source?.manifest_hash
    ?? initialManifestHash;
  const sourceTreeManifestHashMatches = sourceTreeManifestHash === initialManifestHash;
  const sourceAuthority = ACTIVE_AGENT_PROFILE?.sourceAuthority ?? 'builtin_fixture_source';
  const workspaceSourceProvenance = sourceFirstWorkspaceSourceProvenanceEvidence({
    sourceAuthority,
    sourceContentHash,
    sourceTreeManifestHash,
    initialManifestHash,
    initialFiles,
  });
  const directSourceContext = directSourceContextFromProfile(ACTIVE_AGENT_PROFILE);
  const directSourceInputEvidence = directSourceInputEvidenceForProfile(ACTIVE_AGENT_PROFILE);
  const directSourceRuntimeContractExpectation =
    directSourceRuntimeContractExpectationForProfile(
      ACTIVE_AGENT_PROFILE,
      directSourceInputEvidence,
    );
  const gpuSplitLogObserved = sawGpuSplit?.matched === true;
  const gpuSplitEndpointObserved = splitEndpointEvidence?.observed === true;
  const generatedArtifactPathsInGeneratedNamespace =
    generatedArtifacts.length > 0
    && generatedArtifacts.every((entry) => sourceFirstPreexistingGeneratedArtifactPath(entry.path));
  const generatedArtifactBoundaryProven =
    gpuSplitEndpointObserved
    && preexistingGeneratedArtifactPaths.length === 0
    && preexistingGeneratedArtifactHashOverlaps.length === 0
    && generatedArtifactPathsInGeneratedNamespace
    && generatedArtifacts.length > 0;
  const gpuArch = explicitGpuArch(initialCompileArgs?.gpu_arch);
  const gpuArchSource = initialCompileArgs?.gpu_arch_source ?? null;
  const seed = {
    sourceContentHash,
    entryPath: normalizedEntryPath,
    targetId: splitIdentity.targetId,
    initialManifestHash,
    sourcePurityManifestHash,
    sourcePurityInitialManifestHash,
    gpuArch,
    gpuArchSource,
    generatedArtifactHashes,
    sidecarHash,
    compileManifestHash,
  };
  const proofId = `agent-split-source-first-ingestion:sha256:${sha256Hex(stableJson(seed))}`;
  const evidenceRefs = [
    proofId,
    sourceContentHash,
    ACTIVE_AGENT_PROFILE?.profileHash,
    ACTIVE_AGENT_PROFILE?.source?.evidenceRef,
    ACTIVE_AGENT_PROFILE?.source?.evidence_ref,
    ACTIVE_AGENT_PROFILE?.source?.contentHash,
    ACTIVE_AGENT_PROFILE?.source?.content_hash,
    directSourceInputEvidence?.evidenceHash,
    directSourceInputEvidence?.evidence_hash,
    directSourceRuntimeContractExpectation?.evidenceRef,
    directSourceRuntimeContractExpectation?.evidence_ref,
    ...(Array.isArray(ACTIVE_AGENT_PROFILE?.source?.files)
      ? ACTIVE_AGENT_PROFILE.source.files.map((entry) => entry.evidenceRef ?? entry.evidence_ref)
      : []),
    initialManifestHash,
    sourcePurityManifestHash,
    sourcePurityInitialManifestHash,
    sidecarHash,
    compileManifestHash,
    ...generatedArtifactHashes,
    initialCompileResult?.waitSummary?.status ? `evidence:initial-compile-wait-status:${initialCompileResult.waitSummary.status}` : null,
  ].filter(Boolean);
  const useAiSplit = initialCompileArgs?.use_ai_split === true;
  const userRequestedAi = initialCompileArgs?.user_requested_ai === true;
  const preferGpuPipeline = initialCompileArgs?.prefer_gpu_pipeline === true;
  const accepted =
    sourcePurityEvidence?.accepted === true
    && sourcePurityCoversInitialManifest
    && sourcePurityManifestHashMatches
    && sourcePurityFileSetMatchesInitialManifest
    && useAiSplit
    && userRequestedAi
    && preferGpuPipeline
    && Boolean(gpuArch)
    && initialFiles.length > 0
    && sourceTreeManifestHashMatches
    && initialSourceFilePresent
    && initialSourceHashMatches
    && gpuSplitEndpointObserved
    && generatedArtifactBoundaryProven
    && Boolean(sidecarHash)
    && Boolean(compileManifestHash);
  return {
    schemaVersion: 'synthi.gpu.hmr.agent_split_source_first_ingestion.v1',
    accepted,
    proofId,
    proof_id: proofId,
    proofAuthority: 'source_first_ingestion_provenance_only_not_runtime_proof',
    proof_authority: 'source_first_ingestion_provenance_only_not_runtime_proof',
    acceptedForGpuHmr: false,
    accepted_for_gpu_hmr: false,
    gpuHmrSuccess: false,
    gpu_hmr_success: false,
    canSatisfyRuntimeProof: false,
    can_satisfy_runtime_proof: false,
    sourceAuthority,
    source_authority: sourceAuthority,
    sourceKind: directSourceContext?.sourceKind ?? null,
    source_kind: directSourceContext?.source_kind ?? null,
    sourceUrl: directSourceContext?.sourceUrl ?? null,
    source_url: directSourceContext?.source_url ?? null,
    repoPath: directSourceContext?.repoPath ?? null,
    repo_path: directSourceContext?.repo_path ?? null,
    immutableCommit: directSourceContext?.immutableCommit ?? null,
    immutable_commit: directSourceContext?.immutable_commit ?? null,
    directSourceInputEvidence: directSourceInputEvidence ?? {},
    direct_source_input_evidence: directSourceInputEvidence ?? {},
    directSourceRuntimeContractExpectation: directSourceRuntimeContractExpectation ?? {},
    direct_source_runtime_contract_expectation: directSourceRuntimeContractExpectation ?? {},
    workspaceSourceProvenance: workspaceSourceProvenance ?? {},
    workspace_source_provenance: workspaceSourceProvenance ?? {},
    entryPath: normalizedEntryPath,
    entry_path: normalizedEntryPath,
    seededWorkspacePath: normalizedEntryPath,
    seeded_workspace_path: normalizedEntryPath,
    sourceContentHash,
    source_content_hash: sourceContentHash,
    sourceByteLength: Buffer.byteLength(source, 'utf8'),
    source_byte_length: Buffer.byteLength(source, 'utf8'),
    sourcePurityEvidence,
    source_purity_evidence: sourcePurityEvidence,
    noSynthiAbiInSeedSource: sourcePurityEvidence?.accepted === true,
    no_synthi_abi_in_seed_source: sourcePurityEvidence?.accepted === true,
    sourcePurityManifestHash,
    source_purity_manifest_hash: sourcePurityManifestHash,
    sourcePurityInitialManifestHash,
    source_purity_initial_manifest_hash: sourcePurityInitialManifestHash,
    sourcePurityFileSetMatchesInitialManifest,
    source_purity_file_set_matches_initial_manifest: sourcePurityFileSetMatchesInitialManifest,
    recomputedSourcePurityManifestHash,
    recomputed_source_purity_manifest_hash: recomputedSourcePurityManifestHash,
    sourcePurityManifestHashMatches,
    source_purity_manifest_hash_matches: sourcePurityManifestHashMatches,
    sourcePurityCoversInitialManifest,
    source_purity_covers_initial_manifest: sourcePurityCoversInitialManifest,
    sourcePurityScannedFiles: normalizedSourcePurityFiles,
    source_purity_scanned_files: normalizedSourcePurityFiles,
    gpuArch,
    gpu_arch: gpuArch,
    gpuArchSource,
    gpu_arch_source: gpuArchSource,
    initialCompileContract: {
      language: initialCompileArgs?.language ?? null,
      filename: cleanRel(initialCompileArgs?.filename),
      initialFileCount: initialFiles.length,
      initial_file_count: initialFiles.length,
      initialManifestHash,
      initial_manifest_hash: initialManifestHash,
      sourceTreeManifestHash,
      source_tree_manifest_hash: sourceTreeManifestHash,
      initialFiles,
      initial_files: initialFiles,
      sourcePurityManifestHash,
      source_purity_manifest_hash: sourcePurityManifestHash,
      sourcePurityInitialManifestHash,
      source_purity_initial_manifest_hash: sourcePurityInitialManifestHash,
      initialFilePaths,
      initial_file_paths: initialFilePaths,
      useAiSplit,
      use_ai_split: useAiSplit,
      userRequestedAi,
      user_requested_ai: userRequestedAi,
      preferGpuPipeline,
      prefer_gpu_pipeline: preferGpuPipeline,
      gpuMode: initialCompileArgs?.gpu_mode ?? null,
      gpu_mode: initialCompileArgs?.gpu_mode ?? null,
      gpuArch,
      gpu_arch: gpuArch,
      gpuArchSource,
      gpu_arch_source: gpuArchSource,
      sourceUrl: directSourceContext?.sourceUrl ?? null,
      source_url: directSourceContext?.source_url ?? null,
      repoPath: directSourceContext?.repoPath ?? null,
      repo_path: directSourceContext?.repo_path ?? null,
      immutableCommit: directSourceContext?.immutableCommit ?? null,
      immutable_commit: directSourceContext?.immutable_commit ?? null,
      directSourceInputEvidence: directSourceInputEvidence ?? {},
      direct_source_input_evidence: directSourceInputEvidence ?? {},
      directSourceRuntimeContractExpectation: directSourceRuntimeContractExpectation ?? {},
      direct_source_runtime_contract_expectation: directSourceRuntimeContractExpectation ?? {},
    },
    initial_compile_contract: {
      language: initialCompileArgs?.language ?? null,
      filename: cleanRel(initialCompileArgs?.filename),
      initial_file_count: initialFiles.length,
      initial_manifest_hash: initialManifestHash,
      source_tree_manifest_hash: sourceTreeManifestHash,
      initial_files: initialFiles,
      source_purity_manifest_hash: sourcePurityManifestHash,
      source_purity_initial_manifest_hash: sourcePurityInitialManifestHash,
      initial_file_paths: initialFilePaths,
      use_ai_split: useAiSplit,
      user_requested_ai: userRequestedAi,
      prefer_gpu_pipeline: preferGpuPipeline,
      gpu_mode: initialCompileArgs?.gpu_mode ?? null,
      gpu_arch: gpuArch,
      gpu_arch_source: gpuArchSource,
      source_url: directSourceContext?.source_url ?? null,
      repo_path: directSourceContext?.repo_path ?? null,
      immutable_commit: directSourceContext?.immutable_commit ?? null,
      direct_source_input_evidence: directSourceInputEvidence ?? {},
      direct_source_runtime_contract_expectation: directSourceRuntimeContractExpectation ?? {},
    },
    preexistingGeneratedArtifactsPresent: preexistingGeneratedArtifactPaths.length > 0,
    preexisting_generated_artifacts_present: preexistingGeneratedArtifactPaths.length > 0,
    preexistingGeneratedArtifactPaths,
    preexisting_generated_artifact_paths: preexistingGeneratedArtifactPaths,
    preexistingGeneratedArtifactHashOverlaps,
    preexisting_generated_artifact_hash_overlaps: preexistingGeneratedArtifactHashOverlaps,
    initialSourceFilePresent,
    initial_source_file_present: initialSourceFilePresent,
    initialSourceHashMatches,
    initial_source_hash_matches: initialSourceHashMatches,
    initialManifestHash,
    initial_manifest_hash: initialManifestHash,
    sourceTreeManifestHash,
    source_tree_manifest_hash: sourceTreeManifestHash,
    sourceTreeManifestHashMatches,
    source_tree_manifest_hash_matches: sourceTreeManifestHashMatches,
    gpuSplitLogObserved,
    gpu_split_log_observed: gpuSplitLogObserved,
    gpuSplitEndpointObserved,
    gpu_split_endpoint_observed: gpuSplitEndpointObserved,
    gpuSplitEndpointEvidence: splitEndpointEvidence,
    gpu_split_endpoint_evidence: splitEndpointEvidence,
    generatedArtifactCreatedAfterAiSplit: generatedArtifactBoundaryProven,
    generated_artifact_created_after_ai_split: generatedArtifactBoundaryProven,
    generatedArtifactPathsInGeneratedNamespace,
    generated_artifact_paths_in_generated_namespace: generatedArtifactPathsInGeneratedNamespace,
    generatedArtifacts,
    generated_artifacts: generatedArtifacts,
    generatedArtifactPaths: generatedArtifacts.map((entry) => entry.path),
    generated_artifact_paths: generatedArtifacts.map((entry) => entry.path),
    generatedArtifactHashes,
    generated_artifact_hashes: generatedArtifactHashes,
    generatedArtifactCount: generatedArtifacts.length,
    generated_artifact_count: generatedArtifacts.length,
    sidecarHash,
    sidecar_hash: sidecarHash,
    compileManifestHash,
    compile_manifest_hash: compileManifestHash,
    targetId: splitIdentity.targetId,
    target_id: splitIdentity.target_id,
    profileId: validationProfileId(),
    profile_id: validationProfileId(),
    validationProfileId: validationProfileId(),
    validation_profile_id: validationProfileId(),
    evidenceRefs: [...new Set([
      ...evidenceRefs,
      workspaceSourceProvenance?.evidenceRef,
      workspaceSourceProvenance?.evidence_ref,
    ].filter(Boolean))],
    evidence_refs: [...new Set([
      ...evidenceRefs,
      workspaceSourceProvenance?.evidenceRef,
      workspaceSourceProvenance?.evidence_ref,
    ].filter(Boolean))],
    failedGates: accepted ? [] : [
      sourcePurityEvidence?.accepted === true ? null : 'source_first_seed_source_contains_synthi_abi',
      sourcePurityCoversInitialManifest ? null : 'source_first_seed_purity_manifest_incomplete',
      sourcePurityManifestHashMatches ? null : 'source_first_seed_purity_manifest_hash_mismatch',
      sourcePurityFileSetMatchesInitialManifest ? null : 'source_first_seed_purity_file_set_mismatch',
      useAiSplit ? null : 'source_first_compile_use_ai_split_missing',
      userRequestedAi ? null : 'source_first_compile_user_requested_ai_missing',
      preferGpuPipeline ? null : 'source_first_compile_prefer_gpu_pipeline_missing',
      gpuArch ? null : 'source_first_gpu_arch_missing',
      initialFiles.length > 0 ? null : 'source_first_initial_file_manifest_missing',
      sourceTreeManifestHashMatches ? null : 'source_first_source_tree_manifest_mismatch',
      initialSourceFilePresent ? null : 'source_first_initial_source_file_missing',
      initialSourceHashMatches ? null : 'source_first_initial_source_hash_mismatch',
      gpuSplitEndpointObserved ? null : 'source_first_gpu_split_endpoint_not_observed',
      preexistingGeneratedArtifactPaths.length === 0 ? null : 'source_first_precompiled_generated_artifacts_present',
      preexistingGeneratedArtifactHashOverlaps.length === 0
        ? null
        : 'source_first_precompiled_generated_artifact_hash_overlap',
      generatedArtifactBoundaryProven ? null : 'source_first_generated_artifact_boundary_not_proven',
      generatedArtifacts.length > 0 ? null : 'source_first_generated_artifacts_missing',
      generatedArtifactPathsInGeneratedNamespace ? null : 'source_first_generated_artifact_namespace_unproven',
      sidecarHash ? null : 'source_first_sidecar_hash_missing',
      compileManifestHash ? null : 'source_first_compile_manifest_hash_missing',
    ].filter(Boolean),
    failed_gates: accepted ? [] : [
      sourcePurityEvidence?.accepted === true ? null : 'source_first_seed_source_contains_synthi_abi',
      sourcePurityCoversInitialManifest ? null : 'source_first_seed_purity_manifest_incomplete',
      sourcePurityManifestHashMatches ? null : 'source_first_seed_purity_manifest_hash_mismatch',
      sourcePurityFileSetMatchesInitialManifest ? null : 'source_first_seed_purity_file_set_mismatch',
      useAiSplit ? null : 'source_first_compile_use_ai_split_missing',
      userRequestedAi ? null : 'source_first_compile_user_requested_ai_missing',
      preferGpuPipeline ? null : 'source_first_compile_prefer_gpu_pipeline_missing',
      gpuArch ? null : 'source_first_gpu_arch_missing',
      initialFiles.length > 0 ? null : 'source_first_initial_file_manifest_missing',
      sourceTreeManifestHashMatches ? null : 'source_first_source_tree_manifest_mismatch',
      initialSourceFilePresent ? null : 'source_first_initial_source_file_missing',
      initialSourceHashMatches ? null : 'source_first_initial_source_hash_mismatch',
      gpuSplitEndpointObserved ? null : 'source_first_gpu_split_endpoint_not_observed',
      preexistingGeneratedArtifactPaths.length === 0 ? null : 'source_first_precompiled_generated_artifacts_present',
      preexistingGeneratedArtifactHashOverlaps.length === 0
        ? null
        : 'source_first_precompiled_generated_artifact_hash_overlap',
      generatedArtifactBoundaryProven ? null : 'source_first_generated_artifact_boundary_not_proven',
      generatedArtifacts.length > 0 ? null : 'source_first_generated_artifacts_missing',
      generatedArtifactPathsInGeneratedNamespace ? null : 'source_first_generated_artifact_namespace_unproven',
      sidecarHash ? null : 'source_first_sidecar_hash_missing',
      compileManifestHash ? null : 'source_first_compile_manifest_hash_missing',
    ].filter(Boolean),
  };
}

function collectAiProviderReasonCodes(value, seen = new Set()) {
  if (value === null || value === undefined) return [];
  if (typeof value === 'string') {
    const codes = value.match(/\bai_provider_[a-z0-9_]+\b/g) ?? [];
    const lowered = value.toLowerCase();
    const providerContext = (
      codes.length > 0
      || lowered.includes('ai provider')
      || lowered.includes('ai_provider')
      || lowered.includes('provider.ask')
      || lowered.includes('ask_llm')
      || lowered.includes('gemini')
      || lowered.includes('openai')
      || lowered.includes('anthropic')
      || lowered.includes('vertex')
      || lowered.includes('model')
    );
    if (
      lowered.includes('consumer_suspended')
      || lowered.includes('account suspended')
      || lowered.includes('has been suspended')
    ) {
      codes.push('ai_provider_account_suspended');
    } else if (providerContext && (
      lowered.includes('permissiondenied')
      || lowered.includes('permission denied')
      || lowered.includes('unauthenticated')
      || lowered.includes('unauthorized')
      || lowered.includes('auth denied')
      || lowered.includes('invalid api key')
      || lowered.includes('api key not valid')
      || lowered.includes('403')
    )) {
      codes.push('ai_provider_auth_denied');
    } else if (providerContext && lowered.includes('timeout')) {
      codes.push('ai_provider_timeout');
    } else if (providerContext && (lowered.includes('rate limit') || lowered.includes('429'))) {
      codes.push('ai_provider_rate_limited');
    } else if (providerContext && (lowered.includes('unavailable') || lowered.includes('overload') || lowered.includes('503'))) {
      codes.push('ai_provider_unavailable');
    }
    return [...new Set(codes)];
  }
  if (typeof value !== 'object' || seen.has(value)) return [];
  seen.add(value);
  const directCodes = [];
  const rule = value.rule ?? value.code ?? value.reasonCode ?? value.reason_code;
  if (typeof rule === 'string' && rule.startsWith('ai_provider_')) {
    directCodes.push(rule);
  }
  return [...new Set([
    ...directCodes,
    ...Object.values(value).flatMap((entry) => collectAiProviderReasonCodes(entry, seen)),
  ])];
}

function compileTerminalDiagnosticEvidence(wait) {
  const status = String(wait?.status ?? '').trim();
  if (!['compile-error', 'rejected', 'full-reload-required', 'discarded'].includes(status)) {
    return null;
  }
  if (wait?.detail === null || wait?.detail === undefined) return null;

  const sanitizedDetail = sanitizeProofLogValue(wait.detail);
  const serializedDetail = typeof sanitizedDetail === 'string'
    ? sanitizedDetail
    : JSON.stringify(sanitizedDetail);
  const boundedDetail = sanitizeProofLogString(serializedDetail)
    .slice(0, COMPILE_TERMINAL_DIAGNOSTIC_MAX_CHARS);
  const reasonCodes = collectAiProviderReasonCodes(sanitizedDetail);

  return {
    schemaVersion: COMPILE_TERMINAL_DIAGNOSTIC_SCHEMA_VERSION,
    schema_version: COMPILE_TERMINAL_DIAGNOSTIC_SCHEMA_VERSION,
    proofAuthority: 'compile_terminal_diagnostic_only_not_gpu_hmr_acceptance',
    proof_authority: 'compile_terminal_diagnostic_only_not_gpu_hmr_acceptance',
    accepted: false,
    acceptedForGpuHmr: false,
    accepted_for_gpu_hmr: false,
    gpuHmrSuccess: false,
    gpu_hmr_success: false,
    canSatisfyRuntimeProof: false,
    can_satisfy_runtime_proof: false,
    status,
    source: String(wait?.source ?? 'unknown'),
    reasonCodes,
    reason_codes: reasonCodes,
    sanitizedDetail: boundedDetail,
    sanitized_detail: boundedDetail,
    detailTruncated: serializedDetail.length > COMPILE_TERMINAL_DIAGNOSTIC_MAX_CHARS,
    detail_truncated: serializedDetail.length > COMPILE_TERMINAL_DIAGNOSTIC_MAX_CHARS,
  };
}

function sourceFirstProviderDiagnosticEvidence({
  error,
  initialCompileArgs,
  source,
  entryPath,
}) {
  const compileResult = error?.compileResult ?? error?.compile_result ?? null;
  const waitSummary = error?.waitSummary ?? error?.wait_summary ?? null;
  const sanitizedCompileResult = sanitizeProofLogValue(compileResult);
  const sanitizedWaitSummary = sanitizeProofLogValue(waitSummary);
  const sanitizedMessage = sanitizeProofLogString(error?.stack || error?.message || String(error ?? ''));
  const reasonCodes = collectAiProviderReasonCodes({
    message: sanitizedMessage,
    compileResult: sanitizedCompileResult,
    waitSummary: sanitizedWaitSummary,
  });
  const initialFiles = sourceFirstInitialFileManifest(initialCompileArgs?.files);
  const normalizedEntryPath = cleanRel(entryPath);
  const sourceContentHash = `sha256:${sha256Hex(source)}`;
  const providerFailureDetected = reasonCodes.length > 0;
  const gpuArch = explicitGpuArch(initialCompileArgs?.gpu_arch);
  const gpuArchSource = initialCompileArgs?.gpu_arch_source ?? null;
  const proofSeed = {
    sourceContentHash,
    entryPath: normalizedEntryPath,
    reasonCodes,
    useAiSplit: initialCompileArgs?.use_ai_split === true,
    gpuArch,
    gpuArchSource,
  };
  const proofId = `source-first-provider-diagnostic:sha256:${sha256Hex(stableJson(proofSeed))}`;
  return {
    schemaVersion: 'synthi.gpu_hmr.source_first_provider_diagnostic.v1',
    schema_version: 'synthi.gpu_hmr.source_first_provider_diagnostic.v1',
    proofId,
    proof_id: proofId,
    proofAuthority: 'provider_diagnostic_only_not_runtime_proof',
    proof_authority: 'provider_diagnostic_only_not_runtime_proof',
    accepted: false,
    acceptedAsDiagnostic: providerFailureDetected,
    accepted_as_diagnostic: providerFailureDetected,
    acceptedForGpuHmr: false,
    accepted_for_gpu_hmr: false,
    gpuHmrSuccess: false,
    gpu_hmr_success: false,
    canSatisfyRuntimeProof: false,
    can_satisfy_runtime_proof: false,
    providerFailureDetected,
    provider_failure_detected: providerFailureDetected,
    reasonCodes,
    reason_codes: reasonCodes,
    blockingGaps: providerFailureDetected
      ? reasonCodes
      : ['ai_provider_failure_reason_missing'],
    blocking_gaps: providerFailureDetected
      ? reasonCodes
      : ['ai_provider_failure_reason_missing'],
    sourceContentHash,
    source_content_hash: sourceContentHash,
    entryPath: normalizedEntryPath,
    entry_path: normalizedEntryPath,
    initialFileCount: initialFiles.length,
    initial_file_count: initialFiles.length,
    useAiSplit: initialCompileArgs?.use_ai_split === true,
    use_ai_split: initialCompileArgs?.use_ai_split === true,
    userRequestedAi: initialCompileArgs?.user_requested_ai === true,
    user_requested_ai: initialCompileArgs?.user_requested_ai === true,
    preferGpuPipeline: initialCompileArgs?.prefer_gpu_pipeline === true,
    prefer_gpu_pipeline: initialCompileArgs?.prefer_gpu_pipeline === true,
    gpuArch,
    gpu_arch: gpuArch,
    gpuArchSource,
    gpu_arch_source: gpuArchSource,
    sanitizedErrorMessage: sanitizedMessage.slice(0, 4000),
    sanitized_error_message: sanitizedMessage.slice(0, 4000),
    sanitizedCompileResult,
    sanitized_compile_result: sanitizedCompileResult,
    terminalDiagnostic: sanitizedWaitSummary?.terminalDiagnostic ?? null,
    terminal_diagnostic: sanitizedWaitSummary?.terminal_diagnostic ?? null,
  };
}

function findMatchingBrace(source, openIndex) {
  let depth = 0;
  for (let i = openIndex; i < source.length; i += 1) {
    const ch = source[i];
    if (ch === '{') depth += 1;
    if (ch === '}') {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function deviceKernelBodyRanges(source) {
  const ranges = [];
  const kernelRegex = /(?:extern\s+"C"\s+)?__global__\s+void\s+([A-Za-z_]\w*)\s*\([^)]*\)\s*\{/g;
  let match = null;
  while ((match = kernelRegex.exec(source)) !== null) {
    const openIndex = source.indexOf('{', match.index);
    const closeIndex = openIndex >= 0 ? findMatchingBrace(source, openIndex) : -1;
    if (openIndex >= 0 && closeIndex > openIndex) {
      ranges.push({ kernelName: match[1], start: openIndex + 1, end: closeIndex });
      kernelRegex.lastIndex = closeIndex + 1;
    }
  }
  return ranges;
}

function formatFloatLiteral(value, suffix) {
  const normalized = Object.is(value, -0) ? 0 : value;
  const fixed = normalized.toFixed(6).replace(/\.?0+$/, '');
  const withDecimal = fixed.includes('.') ? fixed : `${fixed}.0`;
  return suffix ? `${withDecimal}f` : withDecimal;
}

function mutatedFloatLiteral(raw, attempt) {
  const suffix = /f$/i.test(raw);
  const numeric = Number(raw.replace(/f$/i, ''));
  if (!Number.isFinite(numeric)) return null;
  const magnitude = Math.max(Math.abs(numeric), 0.25);
  const candidates = [
    numeric === 0 ? 0.25 : -numeric,
    numeric <= 0 ? magnitude * 0.35 : -magnitude * 0.35,
    numeric + (numeric >= 0 ? magnitude * 0.5 : -magnitude * 0.5),
    numeric === 0 ? -0.25 : numeric * 1.5,
  ];
  const next = candidates[Math.max(0, attempt) % candidates.length];
  const rendered = formatFloatLiteral(next, suffix || raw.includes('.'));
  return rendered === raw ? null : rendered;
}

function deviceScalarLiteralCandidates(source) {
  const ranges = deviceKernelBodyRanges(source);
  const candidates = [];
  const literalRegex = /(^|[^A-Za-z0-9_])(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?[fF]?)(?![A-Za-z0-9_])/g;
  for (const range of ranges) {
    const body = source.slice(range.start, range.end);
    let match = null;
    while ((match = literalRegex.exec(body)) !== null) {
      const raw = match[2];
      if (!(/[.]/.test(raw) || /f$/i.test(raw))) continue;
      const start = range.start + match.index + match[1].length;
      const end = start + raw.length;
      const lineStart = source.lastIndexOf('\n', start) + 1;
      const lineEndIndex = source.indexOf('\n', end);
      const lineEnd = lineEndIndex >= 0 ? lineEndIndex : source.length;
      const line = source.slice(lineStart, lineEnd);
      const commentIndex = line.indexOf('//');
      if (commentIndex >= 0 && start >= lineStart + commentIndex) continue;
      const value = Number(raw.replace(/f$/i, ''));
      if (!Number.isFinite(value)) continue;
      let score = 0;
      if (/\bconst\s+(?:float|double)\b/.test(line)) score += 100;
      if (/\b(?:float|double)\s+[A-Za-z_]\w*\s*=/.test(line)) score += 50;
      if (/[+\-*/]/.test(line)) score += 20;
      if (Math.abs(value) >= 0.25) score += 10;
      if (value === 0) score -= 40;
      candidates.push({ kernelName: range.kernelName, start, end, raw, line: line.trim(), score });
    }
  }
  return candidates.sort((a, b) => b.score - a.score || a.start - b.start);
}

function deviceScalarEdit(source, attempt = 0) {
  const candidates = deviceScalarLiteralCandidates(source);
  for (const candidate of candidates) {
    const replacement = mutatedFloatLiteral(candidate.raw, attempt);
    if (!replacement) continue;
    const edited = `${source.slice(0, candidate.start)}${replacement}${source.slice(candidate.end)}`;
    if (edited !== source) {
      return {
        edited,
        mutation: {
          kind: 'device_scalar_literal',
          attempt,
          kernelName: candidate.kernelName,
          kernel_name: candidate.kernelName,
          sourceSpan: { start: candidate.start, end: candidate.end },
          source_span: { start: candidate.start, end: candidate.end },
          before: candidate.raw,
          after: replacement,
          line: candidate.line,
        },
      };
    }
  }
  return { edited: source, mutation: null };
}

function profileEditSpecsForRun(runMode, attempt) {
  const specs = ACTIVE_AGENT_PROFILE?.deviceEdits ?? [];
  const normalizedRunMode = String(runMode || '').toLowerCase();
  const matching = specs.filter((spec, index) => {
    const specRunMode = String(spec.runMode ?? spec.run_mode ?? '').toLowerCase();
    return specRunMode
      ? specRunMode === normalizedRunMode
      : index === attempt;
  });
  return matching.length > 0 ? matching : specs[attempt] ? [specs[attempt]] : [];
}

function applyProfileDeclaredEdit(source, spec, attempt) {
  if (!spec) return null;
  if (spec.find) {
    const first = source.indexOf(spec.find);
    const last = source.lastIndexOf(spec.find);
    if (first < 0) {
      return {
        accepted: false,
        reason: 'profile_declared_edit_find_text_missing',
        spec,
      };
    }
    if (first !== last) {
      return {
        accepted: false,
        reason: 'profile_declared_edit_find_text_ambiguous',
        spec,
      };
    }
    const edited = `${source.slice(0, first)}${spec.replace}${source.slice(first + spec.find.length)}`;
    return {
      accepted: edited !== source,
      edited,
      reason: edited === source ? 'profile_declared_edit_noop' : 'profile_declared_edit_applied',
      mutation: {
        kind: 'profile_declared_source_edit',
        attempt,
        profileId: validationProfileId(),
        profile_id: validationProfileId(),
        profileHash: ACTIVE_AGENT_PROFILE?.profileHash ?? null,
        profile_hash: ACTIVE_AGENT_PROFILE?.profileHash ?? null,
        label: spec.label ?? null,
        selector: 'literal',
        sourceSpan: { start: first, end: first + spec.find.length },
        source_span: { start: first, end: first + spec.find.length },
        beforeHash: `sha256:${sha256Hex(spec.find)}`,
        before_hash: `sha256:${sha256Hex(spec.find)}`,
        afterHash: `sha256:${sha256Hex(spec.replace)}`,
        after_hash: `sha256:${sha256Hex(spec.replace)}`,
      },
    };
  }
  const flags = String(spec.flags || '').replace(/g/g, '');
  const regex = new RegExp(spec.regex, flags);
  const matches = [...source.matchAll(new RegExp(spec.regex, `${flags}g`))];
  if (matches.length === 0) {
    return {
      accepted: false,
      reason: 'profile_declared_edit_regex_missing',
      spec,
    };
  }
  if (matches.length !== 1) {
    return {
      accepted: false,
      reason: 'profile_declared_edit_regex_ambiguous',
      spec,
      matchCount: matches.length,
      match_count: matches.length,
    };
  }
  const match = regex.exec(source);
  const start = match.index;
  const end = start + match[0].length;
  const edited = `${source.slice(0, start)}${match[0].replace(regex, spec.replace)}${source.slice(end)}`;
  return {
    accepted: edited !== source,
    edited,
    reason: edited === source ? 'profile_declared_edit_noop' : 'profile_declared_edit_applied',
    mutation: {
      kind: 'profile_declared_source_edit',
      attempt,
      profileId: validationProfileId(),
      profile_id: validationProfileId(),
      profileHash: ACTIVE_AGENT_PROFILE?.profileHash ?? null,
      profile_hash: ACTIVE_AGENT_PROFILE?.profileHash ?? null,
      label: spec.label ?? null,
      selector: 'regex',
      sourceSpan: { start, end },
      source_span: { start, end },
      beforeHash: `sha256:${sha256Hex(match[0])}`,
      before_hash: `sha256:${sha256Hex(match[0])}`,
      afterHash: `sha256:${sha256Hex(match[0].replace(regex, spec.replace))}`,
      after_hash: `sha256:${sha256Hex(match[0].replace(regex, spec.replace))}`,
    },
  };
}

function deviceEditForRun(source, { attempt = 0, runMode = '' } = {}) {
  const profileSpecs = profileEditSpecsForRun(runMode, attempt);
  const failures = [];
  for (const spec of profileSpecs) {
    const result = applyProfileDeclaredEdit(source, spec, attempt);
    if (result?.accepted) return { edited: result.edited, mutation: result.mutation };
    if (result) failures.push(result.reason);
  }
  if (ACTIVE_AGENT_PROFILE?.requireDeclaredEdits === true) {
    throw new Error(
      `agent visual profile declared edit did not apply for ${runMode || `attempt-${attempt}`}: ${
        failures.join(',') || 'profile_declared_edit_missing'
      }`,
    );
  }
  return deviceScalarEdit(source, attempt);
}

function deviceEditHash({ selectedPath, beforeSource, afterSource, editKind }) {
  return `sha256:${sha256Hex(stableJson({
    selectedPath: cleanRel(selectedPath),
    beforeHash: `sha256:${sha256Hex(beforeSource ?? '')}`,
    afterHash: `sha256:${sha256Hex(afterSource ?? '')}`,
    editKind,
  }))}`;
}

function runModeProofId(value) {
  return `agent-split-run-mode-proof:sha256:${sha256Hex(stableJson(value))}`;
}

function negativeEditProofId(value) {
  return `agent-split-negative-edit-refusal:sha256:${sha256Hex(stableJson(value))}`;
}

function selfCheckAgentVisualProfile() {
  const originalProfile = ACTIVE_AGENT_PROFILE;
  const originalFixture = CFG.fixture;
  const originalAllowPackagedDefaultFixture = CFG.allowPackagedDefaultFixture;
  let directLocalSelfCheckRoot = null;
  try {
    let implicitPackagedFixtureRejected = false;
    try {
      ACTIVE_AGENT_PROFILE = null;
      CFG.fixture = '';
      CFG.allowPackagedDefaultFixture = false;
      monolithicSource('rocm');
    } catch (err) {
      implicitPackagedFixtureRejected =
        String(err.message).includes('requires an explicit fixture, profile, or direct source manifest');
    }
    CFG.allowPackagedDefaultFixture = true;
    const diagnosticDefaultFixtureSource = monolithicSource('rocm');
    CFG.allowPackagedDefaultFixture = false;
    CFG.fixture = 'flow';
    const explicitFlowFixtureSource = monolithicSource('rocm');
    let unknownPackagedFixtureRejected = false;
    try {
      CFG.fixture = 'flow-typo-must-not-select-a-fixture';
      monolithicSource('rocm');
    } catch (err) {
      unknownPackagedFixtureRejected = String(err.message).includes(
        'unknown packaged GPU visual fixture',
      );
    }
    if (
      !implicitPackagedFixtureRejected
      || !diagnosticDefaultFixtureSource.includes('particle_flow')
      || !explicitFlowFixtureSource.includes('particle_flow')
      || !unknownPackagedFixtureRejected
    ) {
      throw new Error('agent visual profile self-check failed packaged fixture selection gate');
    }
    CFG.fixture = originalFixture;
    CFG.allowPackagedDefaultFixture = originalAllowPackagedDefaultFixture;
    ACTIVE_AGENT_PROFILE = originalProfile;

    const source = [
      'extern "C" __global__ void render(unsigned int* pixels) {',
      '  const float sceneLight = 1.0f;',
      '  const float exposure = 1.04f;',
      '  pixels[0] = (unsigned int)(sceneLight * exposure);',
      '}',
      '',
    ].join('\n');
    const profile = normalizeAgentVisualProfile({
      schemaVersion: AGENT_VISUAL_PROFILE_SCHEMA_VERSION,
      profileId: 'self-check-visual-profile',
      profileClass: 'self_check_visual_gpu_path',
      source: {
        entryPath: 'src/main.cpp',
        inline: source,
        contentHash: sourceContentHash(source),
      },
      compile: {
        width: 640,
        height: 360,
      },
      visualProof: {
        minChangedRatio: 0.025,
        minMeanAbs: 1.75,
        controlMultiplier: 4,
      },
      visualSceneManifest: {
        schemaVersion: 'synthi.gpu_hmr.visual_scene_manifest.v1',
        sceneId: 'self-check-ray-scene',
        camera: {
          position: [0, 0, 4],
          target: [0, 0, 0],
          fovDegrees: 48,
        },
        rayPolicy: {
          samplesPerPixel: 4,
          maxBounces: 2,
          fixedSeed: 1337,
        },
        objects: [
          { id: 'faceted-gem', kind: 'dielectric_mesh', material: 'glass' },
        ],
        lights: [
          { id: 'key', kind: 'area', intensity: 14.0 },
        ],
        semanticProbes: [
          { id: 'gem-highlight', region: [280, 120, 80, 80], expected: 'brighter_after_hot_delta' },
        ],
      },
      requireDeclaredEdits: true,
      deviceEdits: [
        {
          runMode: 'hot_delta_1',
          find: 'const float sceneLight = 1.0f;',
          replace: 'const float sceneLight = 1.7f;',
        },
        {
          runMode: 'hot_delta_2',
          regex: 'const float exposure = ([0-9.]+)f;',
          replace: 'const float exposure = 0.82f;',
        },
      ],
    });
    ACTIVE_AGENT_PROFILE = profile;
    const resolvedSource = sourceFromAgentVisualProfile(profile, 'rocm');
    const hot1 = deviceEditForRun(source, { attempt: 0, runMode: 'hot_delta_1' });
    const hot2 = deviceEditForRun(hot1.edited, { attempt: 1, runMode: 'hot_delta_2' });
    let sourceHashMismatchRejected = false;
    try {
      normalizeAgentVisualProfile({
        schemaVersion: AGENT_VISUAL_PROFILE_SCHEMA_VERSION,
        profileId: 'self-check-source-hash-mismatch',
        source: {
          inline: source,
          contentHash: `sha256:${'0'.repeat(64)}`,
        },
      });
    } catch (err) {
      sourceHashMismatchRejected = String(err.message).includes('source.contentHash mismatch');
    }
    let sceneManifestHashMismatchRejected = false;
    try {
      normalizeAgentVisualProfile({
        schemaVersion: AGENT_VISUAL_PROFILE_SCHEMA_VERSION,
        profileId: 'self-check-scene-hash-mismatch',
        source: {
          inline: source,
        },
        visualSceneManifest: {
          sceneId: 'self-check-ray-scene',
          camera: { position: [0, 0, 4] },
        },
        visualSceneManifestHash: `sha256:${'1'.repeat(64)}`,
      });
    } catch (err) {
      sceneManifestHashMismatchRejected = String(err.message).includes('visualSceneManifestHash mismatch');
    }
    const ambiguousProfile = normalizeAgentVisualProfile({
      schemaVersion: AGENT_VISUAL_PROFILE_SCHEMA_VERSION,
      profileId: 'self-check-ambiguous-profile',
      source: {
        inline: 'float value = 1.0f;\nfloat value2 = 1.0f;\n',
      },
      requireDeclaredEdits: true,
      deviceEdits: [{
        runMode: 'hot_delta_1',
        find: '1.0f',
        replace: '2.0f',
      }],
    });
    const weakThresholdProfile = normalizeAgentVisualProfile({
      schemaVersion: AGENT_VISUAL_PROFILE_SCHEMA_VERSION,
      profileId: 'self-check-weak-threshold-profile',
      source: {
        inline: source,
      },
      visualProof: {
        minChangedRatio: 0,
        minMeanAbs: 0,
        controlMultiplier: 0,
      },
    });
    const fixtureBackedProfile = normalizeAgentVisualProfile({
      schemaVersion: AGENT_VISUAL_PROFILE_SCHEMA_VERSION,
      profileId: 'self-check-fixture-backed-profile',
      source: {
        fixture: 'ray-light',
      },
    });
    const multiFileEntrySource = [
      '#include "params.hpp"',
      'extern "C" __global__ void render(unsigned int* pixels) {',
      '  pixels[0] = (unsigned int)(kSceneLight * kExposure);',
      '}',
      '',
    ].join('\n');
    const multiFileHeaderSource = [
      '#pragma once',
      'static constexpr float kSceneLight = 1.25f;',
      'static constexpr float kExposure = 1.10f;',
      '',
    ].join('\n');
    const multiFileProfile = normalizeAgentVisualProfile({
      schemaVersion: AGENT_VISUAL_PROFILE_SCHEMA_VERSION,
      profileId: 'self-check-multifile-source-profile',
      profileClass: 'self_check_visual_gpu_path',
      source: {
        entryPath: 'src/main.cpp',
        files: [
          {
            path: 'include/params.hpp',
            inline: multiFileHeaderSource,
            contentHash: sourceContentHash(multiFileHeaderSource),
          },
          {
            path: 'src/main.cpp',
            inline: multiFileEntrySource,
            contentHash: sourceContentHash(multiFileEntrySource),
          },
        ],
      },
      compile: {
        width: 320,
        height: 240,
      },
      visualProof: {
        minChangedRatio: 0.02,
        minMeanAbs: 1.5,
      },
      deviceEdits: [{
        runMode: 'hot_delta_1',
        find: 'kSceneLight * kExposure',
        replace: 'kSceneLight * (kExposure + 0.25f)',
      }],
    });
    let sourceFileHashMissingRejected = false;
    try {
      normalizeAgentVisualProfile({
        schemaVersion: AGENT_VISUAL_PROFILE_SCHEMA_VERSION,
        profileId: 'self-check-source-file-hash-missing',
        source: {
          entryPath: 'src/main.cpp',
          files: [{
            path: 'src/main.cpp',
            inline: multiFileEntrySource,
          }],
        },
      });
    } catch (err) {
      sourceFileHashMissingRejected = String(err.message).includes('source.files[0].contentHash');
    }
    const directSourceProfile = applyDirectSourceOverride(
      normalizeAgentVisualProfile({
        schemaVersion: AGENT_VISUAL_PROFILE_SCHEMA_VERSION,
        profileId: 'self-check-direct-source-profile',
        profileClass: 'self_check_visual_gpu_path',
        source: {
          entryPath: 'src/main.cpp',
          fixture: 'ray-light',
        },
        compile: {
          width: 320,
          height: 240,
        },
        visualProof: {
          minChangedRatio: 0.02,
          minMeanAbs: 1.5,
        },
        visualSceneManifest: {
          schemaVersion: 'synthi.gpu_hmr.visual_scene_manifest.v1',
          sceneId: 'inherited-profile-scene-must-not-survive-direct-source',
          semanticProbes: [
            {
              id: 'inherited-profile-probe',
              probeClass: 'fixture_specific_probe',
              region: [0, 0, 2, 2],
            },
          ],
        },
        deviceEdits: [{
          runMode: 'hot_delta_1',
          find: 'kSceneLight * kExposure',
          replace: 'kSceneLight * (kExposure + 0.25f)',
        }],
      }),
      normalizeDirectSourceOverride({
        sourceAuthority: 'user_source_files',
        entryPath: 'src/main.cpp',
        files: [
          {
            path: 'include/params.hpp',
            inline: multiFileHeaderSource,
          },
          {
            path: 'src/main.cpp',
            inline: multiFileEntrySource,
          },
        ],
      }, {
        manifestPath: path.join(process.cwd(), 'self-check-direct-source-manifest.json'),
      }),
    );
    let directProfileAuthorityRejected = false;
    try {
      normalizeDirectSourceOverride({
        sourceAuthority: 'profile_source_files',
        entryPath: 'src/main.cpp',
        files: [{
          path: 'src/main.cpp',
          inline: multiFileEntrySource,
        }],
      });
    } catch (err) {
      directProfileAuthorityRejected = String(err.message).includes('invalid direct source authority');
    }
    let directSuccessClaimRejected = false;
    try {
      normalizeDirectSourceOverride({
        sourceAuthority: 'user_source_files',
        acceptedForGpuHmr: true,
        entryPath: 'src/main.cpp',
        files: [{
          path: 'src/main.cpp',
          inline: multiFileEntrySource,
        }],
      });
    } catch (err) {
      directSuccessClaimRejected = String(err.message).includes('must not claim GPU HMR');
    }
    let directSourceSyntheticEditFallbackRejected = false;
    try {
      normalizeDirectSourceOverride({
        sourceAuthority: 'user_source_files',
        requireDeclaredEdits: false,
        entryPath: 'src/main.cpp',
        files: [{
          path: 'src/main.cpp',
          inline: multiFileEntrySource,
        }],
      });
    } catch (err) {
      directSourceSyntheticEditFallbackRejected =
        String(err.message).includes('must require declared edits');
    }
    const directBootstrapProfile = createDirectSourceAgentProfile(
      normalizeDirectSourceOverride({
        sourceAuthority: 'user_source_files',
        entryPath: 'src/main.cpp',
        files: [
          {
            path: 'include/params.hpp',
            inline: multiFileHeaderSource,
          },
          {
            path: 'src/main.cpp',
            inline: multiFileEntrySource,
          },
        ],
      }, {
        manifestPath: path.join(process.cwd(), 'self-check-direct-bootstrap-source-manifest.json'),
      }),
    );
    let directSourceUndeclaredHotEditRejected = false;
    try {
      ACTIVE_AGENT_PROFILE = directSourceProfile;
      deviceEditForRun(multiFileEntrySource, { attempt: 0, runMode: 'hot_delta_1' });
    } catch (err) {
      directSourceUndeclaredHotEditRejected =
        String(err.message).includes('profile_declared_edit_missing');
    }
    directLocalSelfCheckRoot = mkdtempSync(path.join(os.tmpdir(), 'synthi-agent-direct-local-source-'));
    mkdirSync(path.join(directLocalSelfCheckRoot, 'include'), { recursive: true });
    mkdirSync(path.join(directLocalSelfCheckRoot, 'src'), { recursive: true });
    writeFileSync(path.join(directLocalSelfCheckRoot, 'include', 'params.hpp'), multiFileHeaderSource);
    writeFileSync(path.join(directLocalSelfCheckRoot, 'src', 'main.cpp'), multiFileEntrySource);
    for (const gitArgs of [
      ['init'],
      ['config', 'user.email', 'gpu-hmr-self-check@example.invalid'],
      ['config', 'user.name', 'GPU HMR Self Check'],
      ['config', 'core.autocrlf', 'false'],
      ['add', '.'],
      ['commit', '-m', 'immutable direct source fixture'],
    ]) {
      execFileSync('git', ['-C', directLocalSelfCheckRoot, ...gitArgs], {
        windowsHide: true,
        stdio: ['ignore', 'ignore', 'pipe'],
      });
    }
    const directLocalCommit = String(execFileSync(
      'git',
      ['-C', directLocalSelfCheckRoot, 'rev-parse', 'HEAD'],
      { encoding: 'utf8', windowsHide: true },
    )).trim();
    const directLocalGitSnapshot = materializeDirectSourceGitSnapshot({
      sourceRoot: directLocalSelfCheckRoot,
      requestedCommit: directLocalCommit,
      sourceFilePaths: ['include/params.hpp', 'src/main.cpp'],
    });
    const directLocalManifestHash = directLocalGitSnapshot.manifestHash;
    const directLocalGitIdentity = directLocalGitSnapshot.identity;
    const directLocalSourceProfile = applyDirectSourceOverride(
      normalizeAgentVisualProfile({
        schemaVersion: AGENT_VISUAL_PROFILE_SCHEMA_VERSION,
        profileId: 'self-check-direct-local-source-profile',
        profileClass: 'self_check_visual_gpu_path',
        source: {
          entryPath: 'src/main.cpp',
          fixture: 'ray-light',
        },
        compile: {
          width: 320,
          height: 240,
        },
      }),
      normalizeDirectSourceOverride({
        sourceAuthority: 'direct_local_git_repo_path',
        directSourceInputChannels: [
          'cli_arg:source-root',
          'cli_arg:source-entry',
          'cli_arg:source-commit',
        ],
        immutableCommit: directLocalCommit,
        immutableSourceIdentity: directLocalGitIdentity,
        entryPath: 'src/main.cpp',
        files: directLocalGitSnapshot.files,
      }, {
        manifestPath: path.join(directLocalSelfCheckRoot, 'self-check-direct-local-source-manifest.json'),
        sourceRoot: directLocalSelfCheckRoot,
      }),
    );
    ACTIVE_AGENT_PROFILE = ambiguousProfile;
    let ambiguousRejected = false;
    try {
      deviceEditForRun(ambiguousProfile.source.inline, { attempt: 0, runMode: 'hot_delta_1' });
    } catch (err) {
      ambiguousRejected = String(err.message).includes('profile_declared_edit_find_text_ambiguous');
    }
    ACTIVE_AGENT_PROFILE = fixtureBackedProfile;
    const fixtureBackedIdentity = validationFixtureId();
    ACTIVE_AGENT_PROFILE = multiFileProfile;
    const multiFileResolvedSource = sourceFromAgentVisualProfile(multiFileProfile, 'rocm');
    const multiFileInitialFiles = sourceFilesForInitialCompile(
      multiFileProfile.source.entryPath,
      multiFileResolvedSource,
    );
    const sourceFirstGeneratedPath = '.synthi/generated/gpu/device.hip';
    const sourceFirstGeneratedDevice = 'extern "C" __global__ void render(unsigned int* pixels) { pixels[0] = 0xff336699u; }\n';
    const sourceFirstSplit = {
      files: {
        [sourceFirstGeneratedPath]: sourceFirstGeneratedDevice,
      },
      roles: {
        device: sourceFirstGeneratedPath,
      },
      sidecar: {
        agentic_split_report: { accepted: true },
        generated_artifact_purity_report: { accepted: true },
        device_mapping_report: { accepted: true },
      },
      manifest: {
        project_id: 'self-check-source-first-target',
        profile_id: 'self-check-source-first-profile',
        module_files: {
          device: sourceFirstGeneratedPath,
        },
        gpu: {
          vendor: 'rocm',
          device_roles: [{
            id: 'device',
            path: sourceFirstGeneratedPath,
            compiler: 'hipcc',
            arch: ['gfx-self-check'],
          }],
        },
      },
    };
    sourceFirstSplit.sidecarRaw = stableJson(sourceFirstSplit.sidecar);
    const sourceFirstInitialCompileArgs = {
      language: 'cpp',
      filename: multiFileProfile.source.entryPath,
      files: multiFileInitialFiles,
      use_ai_split: true,
      user_requested_ai: true,
      prefer_gpu_pipeline: true,
      gpu_mode: 'rocm',
      gpu_arch: 'gfx-self-check',
    };
    const acceptedSourceFirst = sourceFirstIngestionEvidence({
      source: multiFileResolvedSource,
      entryPath: multiFileProfile.source.entryPath,
      sourcePurityEvidence: assertNoSynthiAbi(multiFileResolvedSource, {
        entryPath: multiFileProfile.source.entryPath,
        files: multiFileInitialFiles,
      }),
      initialCompileArgs: sourceFirstInitialCompileArgs,
      initialCompileResult: { waitSummary: { status: 'applied' } },
      split: sourceFirstSplit,
      sawGpuSplit: { matched: false },
      splitEndpointEvidence: gpuSplitEndpointEvidenceFromSidecar(sourceFirstSplit),
    });
    ACTIVE_AGENT_PROFILE = directSourceProfile;
    const directSourceResolvedSource = sourceFromAgentVisualProfile(directSourceProfile, 'rocm');
    const directSourceInitialFiles = sourceFilesForInitialCompile(
      directSourceProfile.source.entryPath,
      directSourceResolvedSource,
    );
    const acceptedDirectSourceFirst = sourceFirstIngestionEvidence({
      source: directSourceResolvedSource,
      entryPath: directSourceProfile.source.entryPath,
      sourcePurityEvidence: assertNoSynthiAbi(directSourceResolvedSource, {
        entryPath: directSourceProfile.source.entryPath,
        files: directSourceInitialFiles,
      }),
      initialCompileArgs: {
        ...sourceFirstInitialCompileArgs,
        filename: directSourceProfile.source.entryPath,
        files: directSourceInitialFiles,
      },
      initialCompileResult: { waitSummary: { status: 'applied' } },
      split: sourceFirstSplit,
      sawGpuSplit: { matched: false },
      splitEndpointEvidence: gpuSplitEndpointEvidenceFromSidecar(sourceFirstSplit),
    });
    ACTIVE_AGENT_PROFILE = directLocalSourceProfile;
    const directLocalResolvedSource = sourceFromAgentVisualProfile(directLocalSourceProfile, 'rocm');
    const directLocalInitialFiles = sourceFilesForInitialCompile(
      directLocalSourceProfile.source.entryPath,
      directLocalResolvedSource,
    );
    const acceptedDirectLocalSourceFirst = sourceFirstIngestionEvidence({
      source: directLocalResolvedSource,
      entryPath: directLocalSourceProfile.source.entryPath,
      sourcePurityEvidence: assertNoSynthiAbi(directLocalResolvedSource, {
        entryPath: directLocalSourceProfile.source.entryPath,
        files: directLocalInitialFiles,
      }),
      initialCompileArgs: {
        ...sourceFirstInitialCompileArgs,
        filename: directLocalSourceProfile.source.entryPath,
        files: directLocalInitialFiles,
      },
      initialCompileResult: { waitSummary: { status: 'applied' } },
      split: sourceFirstSplit,
      sawGpuSplit: { matched: false },
      splitEndpointEvidence: gpuSplitEndpointEvidenceFromSidecar(sourceFirstSplit),
    });
    const directSourceFixtureId = validationFixtureId();
    const directSourceEvidenceSource = validationProfileEvidenceSource();
    ACTIVE_AGENT_PROFILE = multiFileProfile;
    const dirtySecondaryInitialFiles = multiFileInitialFiles.map((entry) =>
      entry.path === 'include/params.hpp'
        ? {
            ...entry,
            content: `${entry.content}\nextern void synthi_gpu_launch();\n`,
          }
        : entry
    );
    const rejectedDirtySecondarySourceFirst = sourceFirstIngestionEvidence({
      source: multiFileResolvedSource,
      entryPath: multiFileProfile.source.entryPath,
      sourcePurityEvidence: sourceFirstSeedSourcePurityEvidence({
        source: multiFileResolvedSource,
        entryPath: multiFileProfile.source.entryPath,
        files: dirtySecondaryInitialFiles,
      }),
      initialCompileArgs: {
        ...sourceFirstInitialCompileArgs,
        files: dirtySecondaryInitialFiles,
      },
      initialCompileResult: { waitSummary: { status: 'applied' } },
      split: sourceFirstSplit,
      sawGpuSplit: { matched: false },
      splitEndpointEvidence: gpuSplitEndpointEvidenceFromSidecar(sourceFirstSplit),
    });
    const forgedSourceFirstPath = 'src/generated-device.hip';
    const forgedSourceFirstSplit = {
      ...sourceFirstSplit,
      files: {
        [forgedSourceFirstPath]: sourceFirstGeneratedDevice,
      },
      roles: {
        device: forgedSourceFirstPath,
      },
      manifest: {
        ...sourceFirstSplit.manifest,
        module_files: {
          device: forgedSourceFirstPath,
        },
        gpu: {
          ...sourceFirstSplit.manifest.gpu,
          device_roles: [{
            ...sourceFirstSplit.manifest.gpu.device_roles[0],
            path: forgedSourceFirstPath,
          }],
        },
      },
    };
    forgedSourceFirstSplit.sidecarRaw = sourceFirstSplit.sidecarRaw;
    const rejectedForgedSourceFirst = sourceFirstIngestionEvidence({
      source: multiFileResolvedSource,
      entryPath: multiFileProfile.source.entryPath,
      sourcePurityEvidence: assertNoSynthiAbi(multiFileResolvedSource, {
        entryPath: multiFileProfile.source.entryPath,
        files: multiFileInitialFiles,
      }),
      initialCompileArgs: sourceFirstInitialCompileArgs,
      initialCompileResult: { waitSummary: { status: 'applied' } },
      split: forgedSourceFirstSplit,
      sawGpuSplit: { matched: false },
      splitEndpointEvidence: gpuSplitEndpointEvidenceFromSidecar(forgedSourceFirstSplit),
    });
    let implicitDefaultSplitRejected = false;
    try {
      const implicitDefaultManifest = { gpu: { vendor: 'rocm' } };
      const implicitDefaultRoles = manifestRolePaths(implicitDefaultManifest, 'rocm');
      validateGeneratedSplit({
        files: {
          'shared.h': '#pragma once\n',
          'core.cpp': 'extern "C" void core_on_update() {}\n',
          'gui.cpp': 'extern "C" void gui_on_render() {}\n',
          'host_runner.cpp': 'int main() { return 0; }\n',
          'device.hip': 'extern "C" __global__ void forged_default_kernel() {}\n',
        },
        roles: implicitDefaultRoles,
        manifest: implicitDefaultManifest,
      });
    } catch (err) {
      implicitDefaultSplitRejected = String(err.message).includes('compile_manifest.module_files')
        || String(err.message).includes('compile_manifest.gpu.device_roles');
    }
    let undeclaredDeviceRoleRejected = false;
    try {
      manifestRolePaths({
        module_files: {
          device: sourceFirstGeneratedPath,
        },
        gpu: {
          vendor: 'rocm',
          device_roles: [{
            id: 'device',
            path: '.synthi/generated/gpu/not-declared.hip',
            compiler: 'hipcc',
          }],
        },
      }, 'rocm');
    } catch (err) {
      undeclaredDeviceRoleRejected = String(err.message).includes('not declared module files');
    }
    const defaultVisualParallelism = visualWorkerParallelismForProof({}, 2);
    const declaredVisualParallelism = visualWorkerParallelismForProof({ workerParallelism: 9 }, 3);
    const schedulingEvidence = visualDeltaSchedulingEvidence({
      workerParallelism: declaredVisualParallelism,
      candidateCount: 3,
      controlComparisonCount: 1,
    });
    const redactionFixtureKey = 'AIzaSyRedactionFixtureKey000000000000';
    const redactedProviderError = sanitizeProofLogString(
      `ai_provider_error: PermissionDenied: Consumer api_key:${redactionFixtureKey} has been suspended. `
      + 'Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.payload.signature '
      + `GOOGLE_API_KEY=${redactionFixtureKey}`,
    );
    const redactedProviderObject = sanitizeProofLogValue({
      apiKey: redactionFixtureKey,
      nested: {
        message: `containerInfo=api_key:${redactionFixtureKey}`,
        bearer: 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.payload.signature',
      },
    });
    const redactionAccepted = !redactedProviderError.includes(redactionFixtureKey)
      && !redactedProviderError.includes('payload.signature')
      && redactedProviderError.includes('api_key:[REDACTED]')
      && redactedProviderObject.apiKey === REDACTED_SECRET
      && !redactedProviderObject.nested.message.includes(redactionFixtureKey)
      && !redactedProviderObject.nested.bearer.includes('payload.signature');
    const terminalProviderDiagnostic = compileTerminalDiagnosticEvidence({
      status: 'compile-error',
      source: 'hmr_status',
      detail: {
        module: 'pipeline',
        errors: [
          `GPU split endpoint failed: ai_provider_account_suspended Consumer api_key:${redactionFixtureKey}`,
        ],
      },
    });
    const terminalProviderDiagnosticSerialized = JSON.stringify(terminalProviderDiagnostic);
    const retainedWaitProviderDiagnostic = sourceFirstProviderDiagnosticEvidence({
      error: Object.assign(new Error('required synthi_wait_hmr proof gate did not apply'), {
        waitSummary: {
          status: 'compile-error',
          terminalDiagnostic: terminalProviderDiagnostic,
          terminal_diagnostic: terminalProviderDiagnostic,
        },
      }),
      initialCompileArgs: sourceFirstInitialCompileArgs,
      source: multiFileResolvedSource,
      entryPath: multiFileProfile.source.entryPath,
    });
    const retainedWaitProviderDiagnosticSerialized = JSON.stringify(retainedWaitProviderDiagnostic);
    const providerDiagnostic = sourceFirstProviderDiagnosticEvidence({
      error: Object.assign(
        new Error(
          `synthi_compile failed: PermissionDenied: Consumer api_key:${redactionFixtureKey} `
          + 'has been suspended. reason=CONSUMER_SUSPENDED '
          + 'Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.payload.signature',
        ),
        {
          compileResult: {
            ok: false,
            error: {
              detail: {
                message: 'GPU split AI provider failed before verification',
                verification: {
                  ok: false,
                  violations: [{
                    rule: 'ai_provider_account_suspended',
                    message: `PermissionDenied: Consumer api_key:${redactionFixtureKey} `
                      + 'has been suspended. reason=CONSUMER_SUSPENDED',
                  }],
                },
              },
            },
          },
        },
      ),
      initialCompileArgs: sourceFirstInitialCompileArgs,
      source: multiFileResolvedSource,
      entryPath: multiFileProfile.source.entryPath,
    });
    const providerDiagnosticSerialized = JSON.stringify(providerDiagnostic);
    const directSourceSceneManifest = {
      schemaVersion: 'synthi.gpu_hmr.visual_scene_manifest.v1',
      sceneId: 'direct-source-semantic-scene',
      semanticProbes: [
        {
          id: 'direct-source-diamond-material',
          probeClass: 'diamond_specular_material',
          region: [0, 0, 4, 4],
        },
        {
          id: 'direct-source-key-light',
          probeClass: 'key_light_shadow_response',
          region: [4, 0, 4, 4],
        },
      ],
    };
    const directSourceSceneManifestHash = `sha256:${sha256Hex(stableJson(directSourceSceneManifest))}`;
    const directSourceSceneOverride = normalizeDirectSourceOverride({
      sourceAuthority: 'user_source_files',
      entryPath: 'src/main.cpp',
      visualSceneManifest: directSourceSceneManifest,
      visualSceneManifestHash: directSourceSceneManifestHash,
      files: [
        {
          path: 'src/main.cpp',
          content: multiFileEntrySource,
        },
      ],
    });
    const directSourceSceneProfile = applyDirectSourceOverride(
      normalizeAgentVisualProfile({
        schemaVersion: AGENT_VISUAL_PROFILE_SCHEMA_VERSION,
        profileId: 'self-check-direct-source-scene-profile',
        profileClass: 'self_check_visual_gpu_path',
        source: {
          entryPath: 'src/main.cpp',
          inline: multiFileEntrySource,
        },
      }),
      directSourceSceneOverride,
    );
    const directSourceOwnEditSource = [
      'extern "C" __global__ void render(unsigned int* pixels) {',
      '  const float ownedGain = 2.0f;',
      '  pixels[0] = (unsigned int)(ownedGain);',
      '}',
      '',
    ].join('\n');
    const directSourceOwnEditProfile = applyDirectSourceOverride(
      normalizeAgentVisualProfile({
        schemaVersion: AGENT_VISUAL_PROFILE_SCHEMA_VERSION,
        profileId: 'self-check-direct-source-own-edit-profile',
        profileClass: 'self_check_visual_gpu_path',
        source: {
          entryPath: 'src/main.cpp',
          inline: directSourceOwnEditSource,
        },
        deviceEdits: [{
          runMode: 'hot_delta_1',
          find: 'ownedGain',
          replace: 'inheritedFixtureToken',
        }],
      }),
      normalizeDirectSourceOverride({
        sourceAuthority: 'user_source_files',
        entryPath: 'src/main.cpp',
        files: [
          {
            path: 'src/main.cpp',
            content: directSourceOwnEditSource,
          },
        ],
        deviceEdits: [{
          runMode: 'hot_delta_1',
          find: 'const float ownedGain = 2.0f;',
          replace: 'const float ownedGain = 3.0f;',
        }],
      }),
    );
    ACTIVE_AGENT_PROFILE = directSourceOwnEditProfile;
    const directSourceOwnEdit = deviceEditForRun(
      directSourceOwnEditSource,
      { attempt: 0, runMode: 'hot_delta_1' },
    );
    let directSourceSceneHashMismatchRejected = false;
    try {
      normalizeDirectSourceOverride({
        sourceAuthority: 'user_source_files',
        entryPath: 'src/main.cpp',
        visualSceneManifest: directSourceSceneManifest,
        visualSceneManifestHash: `sha256:${'2'.repeat(64)}`,
        files: [{
          path: 'src/main.cpp',
          content: multiFileEntrySource,
        }],
      });
    } catch (err) {
      directSourceSceneHashMismatchRejected =
        String(err.message).includes('visualSceneManifestHash mismatch');
    }
    if (
      profile.profileId !== 'self-check-visual-profile'
      || profile.source.entryPath !== 'src/main.cpp'
      || profile.compile.width !== 640
      || profile.compile.height !== 360
      || !profile.profileHash.startsWith('sha256:')
      || resolvedSource !== source
      || profile.source.contentHash !== sourceContentHash(source)
      || !profile.source.evidenceRef.includes(profile.source.contentHash)
      || profile.visualProof.minChangedRatio !== 0.025
      || profile.visualProof.minMeanAbs !== 1.75
      || profile.visualProof.controlMultiplier !== 4
      || !profile.visualProof.proofHash.startsWith('sha256:')
      || !profile.visualSceneManifestHash?.startsWith('sha256:')
      || !profile.visualSceneManifestEvidenceRef?.includes(profile.visualSceneManifestHash)
      || profile.visualSceneManifest?.sceneId !== 'self-check-ray-scene'
      || weakThresholdProfile.visualProof.minChangedRatio !== 0.01
      || weakThresholdProfile.visualProof.minMeanAbs !== 1.0
      || weakThresholdProfile.visualProof.controlMultiplier !== 3.0
      || !hot1.edited.includes('const float sceneLight = 1.7f;')
      || hot1.mutation?.kind !== 'profile_declared_source_edit'
      || !hot2.edited.includes('const float exposure = 0.82f;')
      || hot2.mutation?.selector !== 'regex'
      || !sourceHashMismatchRejected
      || !sourceFileHashMissingRejected
      || !sceneManifestHashMismatchRejected
      || !ambiguousRejected
      || fixtureBackedIdentity !== 'ray-light'
      || multiFileProfile.sourceAuthority !== 'profile_source_files'
      || directSourceProfile.sourceAuthority !== 'user_source_files'
      || directSourceProfile.source.fixture !== ''
      || directSourceProfile.deviceEdits.length !== 0
      || directSourceProfile.requireDeclaredEdits !== true
      || directSourceProfile.visualSceneManifest !== null
      || directSourceProfile.visualSceneManifestHash !== null
      || directBootstrapProfile.sourceAuthority !== 'user_source_files'
      || directBootstrapProfile.source.fixture !== ''
      || directBootstrapProfile.profileId === 'flow'
      || !directBootstrapProfile.profileId.startsWith('direct-source-')
      || directBootstrapProfile.requireDeclaredEdits !== true
      || directLocalSourceProfile.sourceAuthority !== 'direct_local_git_repo_path'
      || directLocalSourceProfile.source.sourceKind !== 'local_repo_path_commit'
      || !directLocalSourceProfile.source.repoPath
      || directLocalSourceProfile.source.immutableCommit !== directLocalCommit
      || directLocalSourceProfile.source.immutableSourceIdentity?.identityHash
        !== directLocalGitIdentity.identityHash
      || directSourceProfile.source.files.length !== 2
      || !directSourceProfile.source.manifestHash?.startsWith('sha256:')
      || !directSourceProfile.source.evidenceRef?.startsWith('evidence:agent-direct-source-manifest:sha256:')
      || directSourceSceneOverride.visualSceneManifestHash !== directSourceSceneManifestHash
      || directSourceSceneOverride.visualSceneManifestEvidenceRef
        !== `evidence:agent-profile-visual-scene-manifest:${directSourceSceneManifestHash}`
      || directSourceSceneProfile.visualSceneManifest?.sceneId !== 'direct-source-semantic-scene'
      || directSourceSceneProfile.visualSceneManifestHash !== directSourceSceneManifestHash
      || !directSourceSceneProfile.visualSceneManifestEvidenceRef?.includes(directSourceSceneManifestHash)
      || directSourceSceneProfile.profileHash === directSourceProfile.profileHash
      || directSourceOwnEditProfile.deviceEdits.length !== 1
      || directSourceOwnEditProfile.requireDeclaredEdits !== true
      || directSourceOwnEdit.mutation?.kind !== 'profile_declared_source_edit'
      || !directSourceOwnEdit.edited.includes('const float ownedGain = 3.0f;')
      || directSourceOwnEdit.edited.includes('inheritedFixtureToken')
      || !directSourceSyntheticEditFallbackRejected
      || !directSourceUndeclaredHotEditRejected
      || !directSourceSceneHashMismatchRejected
      || directSourceResolvedSource !== multiFileEntrySource
      || directSourceInitialFiles.length !== 2
      || directSourceFixtureId !== ''
      || directSourceEvidenceSource !== 'agent_split_direct_source_runtime_visual_proof'
      || acceptedDirectSourceFirst.accepted !== true
      || acceptedDirectSourceFirst.sourceAuthority !== 'user_source_files'
      || acceptedDirectSourceFirst.sourceTreeManifestHashMatches !== true
      || acceptedDirectSourceFirst.workspaceSourceProvenance?.schemaVersion
        !== 'synthi.gpu_hmr.source_first_workspace_source_provenance.v1'
      || acceptedDirectSourceFirst.workspaceSourceProvenance?.proofAuthority
        !== 'workspace_source_tree_provenance_only_not_gpu_hmr_success'
      || acceptedDirectSourceFirst.workspaceSourceProvenance?.accepted !== true
      || acceptedDirectSourceFirst.workspaceSourceProvenance?.targetNameIndependent !== true
      || acceptedDirectSourceFirst.workspaceSourceProvenance?.acceptedForGpuHmr !== false
      || acceptedDirectSourceFirst.workspaceSourceProvenance?.gpuHmrSuccess !== false
      || acceptedDirectSourceFirst.workspaceSourceProvenance?.canSatisfyRuntimeProof !== false
      || acceptedDirectSourceFirst.directSourceRuntimeContractExpectation?.accepted !== false
      || acceptedDirectSourceFirst.directSourceRuntimeContractExpectation?.acceptedForGpuHmr !== false
      || acceptedDirectSourceFirst.directSourceRuntimeContractExpectation?.gpuHmrSuccess !== false
      || acceptedDirectSourceFirst.directSourceRuntimeContractExpectation?.canSatisfyRuntimeProof !== false
      || !acceptedDirectSourceFirst.directSourceRuntimeContractExpectation?.blockingGaps
        ?.includes('direct_source_runtime_contract_backend_missing')
      || !acceptedDirectSourceFirst.evidenceRefs.some((entry) =>
        String(entry).startsWith('workspace-source-provenance:sha256:')
      )
      || !acceptedDirectSourceFirst.evidenceRefs.some((entry) =>
        String(entry).startsWith('direct-source-runtime-contract-expectation:sha256:')
      )
      || !acceptedDirectSourceFirst.evidenceRefs.some((entry) =>
        String(entry).startsWith('evidence:agent-direct-source-file:sha256:')
      )
      || acceptedDirectLocalSourceFirst.accepted !== true
      || acceptedDirectLocalSourceFirst.sourceAuthority !== 'direct_local_git_repo_path'
      || acceptedDirectLocalSourceFirst.repoPath !== directLocalSourceProfile.source.repoPath
      || acceptedDirectLocalSourceFirst.immutableCommit !== directLocalSourceProfile.source.immutableCommit
      || acceptedDirectLocalSourceFirst.directSourceInputEvidence?.accepted !== true
      || acceptedDirectLocalSourceFirst.directSourceInputEvidence?.candidateSource !== 'direct_local_git_repo_path'
      || acceptedDirectLocalSourceFirst.directSourceInputEvidence?.sourceKind !== 'local_repo_path_commit'
      || acceptedDirectLocalSourceFirst.directSourceInputEvidence?.sourceIdentityRole
        !== DIRECT_SOURCE_INPUT_IDENTITY_ROLE
      || !acceptedDirectLocalSourceFirst.directSourceInputEvidence?.sourceIdentityHash?.startsWith('sha256:')
      || acceptedDirectLocalSourceFirst.directSourceInputEvidence?.targetNameIndependent !== true
      || acceptedDirectLocalSourceFirst.directSourceInputEvidence?.projectNameWhitelist?.length !== 0
      || acceptedDirectLocalSourceFirst.directSourceInputEvidence?.specificTargetIdsAllowed?.length !== 0
      || acceptedDirectLocalSourceFirst.directSourceInputEvidence?.acceptedForGpuHmr !== false
      || acceptedDirectLocalSourceFirst.directSourceInputEvidence?.gpuHmrSuccess !== false
      || acceptedDirectLocalSourceFirst.directSourceInputEvidence?.canSatisfyRuntimeProof !== false
      || acceptedDirectLocalSourceFirst.directSourceInputEvidence?.immutableSourceIdentityHash
        !== directLocalGitIdentity.identityHash
      || acceptedDirectLocalSourceFirst.directSourceRuntimeContractExpectation?.accepted !== false
      || acceptedDirectLocalSourceFirst.directSourceRuntimeContractExpectation?.sourceIdentityHash
        !== acceptedDirectLocalSourceFirst.directSourceInputEvidence?.sourceIdentityHash
      || !acceptedDirectLocalSourceFirst.directSourceRuntimeContractExpectation?.blockingGaps
        ?.includes('direct_source_runtime_contract_boundary_stages_incomplete')
      || !directProfileAuthorityRejected
      || !directSuccessClaimRejected
      || multiFileProfile.source.files.length !== 2
      || !multiFileProfile.source.manifestHash?.startsWith('sha256:')
      || multiFileResolvedSource !== multiFileEntrySource
      || multiFileProfile.source.contentHash !== sourceContentHash(multiFileEntrySource)
      || multiFileInitialFiles.length !== 2
      || !multiFileInitialFiles.some((entry) =>
        entry.path === 'include/params.hpp' && entry.content === multiFileHeaderSource
      )
      || !multiFileInitialFiles.some((entry) =>
        entry.path === 'src/main.cpp' && entry.content === multiFileEntrySource
      )
      || acceptedSourceFirst.accepted !== true
      || acceptedSourceFirst.generatedArtifactPathsInGeneratedNamespace !== true
      || acceptedSourceFirst.sourceTreeManifestHashMatches !== true
      || acceptedSourceFirst.acceptedForGpuHmr !== false
      || acceptedSourceFirst.gpuHmrSuccess !== false
      || acceptedSourceFirst.canSatisfyRuntimeProof !== false
      || acceptedSourceFirst.sourcePurityCoversInitialManifest !== true
      || acceptedSourceFirst.sourcePurityManifestHashMatches !== true
      || acceptedSourceFirst.sourcePurityFileSetMatchesInitialManifest !== true
      || rejectedDirtySecondarySourceFirst.accepted !== false
      || !rejectedDirtySecondarySourceFirst.failedGates.includes('source_first_seed_source_contains_synthi_abi')
      || !rejectedDirtySecondarySourceFirst.failedGates.includes('source_first_seed_purity_manifest_incomplete')
      || rejectedForgedSourceFirst.accepted !== false
      || rejectedForgedSourceFirst.generatedArtifactPathsInGeneratedNamespace !== false
      || !rejectedForgedSourceFirst.failedGates.includes('source_first_generated_artifact_namespace_unproven')
      || !implicitDefaultSplitRejected
      || !undeclaredDeviceRoleRejected
      || defaultVisualParallelism !== 2
      || declaredVisualParallelism !== 3
      || schedulingEvidence.acceptedForGpuHmr !== false
      || schedulingEvidence.gpuHmrSuccess !== false
      || schedulingEvidence.proofAuthority !== 'visual_worker_scheduling_support_only'
      || schedulingEvidence.strategy !== 'bounded_concurrent_worker_threads'
      || !redactionAccepted
      || terminalProviderDiagnostic?.schemaVersion !== COMPILE_TERMINAL_DIAGNOSTIC_SCHEMA_VERSION
      || terminalProviderDiagnostic?.acceptedForGpuHmr !== false
      || terminalProviderDiagnostic?.gpuHmrSuccess !== false
      || terminalProviderDiagnostic?.canSatisfyRuntimeProof !== false
      || !terminalProviderDiagnostic?.reasonCodes.includes('ai_provider_account_suspended')
      || terminalProviderDiagnosticSerialized.includes(redactionFixtureKey)
      || retainedWaitProviderDiagnostic.acceptedAsDiagnostic !== true
      || !retainedWaitProviderDiagnostic.reasonCodes.includes('ai_provider_account_suspended')
      || retainedWaitProviderDiagnosticSerialized.includes(redactionFixtureKey)
      || providerDiagnostic.accepted !== false
      || providerDiagnostic.acceptedAsDiagnostic !== true
      || providerDiagnostic.acceptedForGpuHmr !== false
      || providerDiagnostic.gpuHmrSuccess !== false
      || providerDiagnostic.canSatisfyRuntimeProof !== false
      || !providerDiagnostic.reasonCodes.includes('ai_provider_account_suspended')
      || providerDiagnosticSerialized.includes(redactionFixtureKey)
      || providerDiagnosticSerialized.includes('payload.signature')
    ) {
      throw new Error('agent visual profile self-check failed');
    }
    console.log('agent visual profile self-check passed');
  } finally {
    ACTIVE_AGENT_PROFILE = originalProfile;
    CFG.fixture = originalFixture;
    CFG.allowPackagedDefaultFixture = originalAllowPackagedDefaultFixture;
    if (directLocalSelfCheckRoot) {
      rmSync(directLocalSelfCheckRoot, { recursive: true, force: true });
    }
  }
}

async function writeSelfCheckSemanticImage(name, pixelFn) {
  const width = 8;
  const height = 8;
  const channels = 4;
  const raw = Buffer.alloc(width * height * channels);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = (y * width + x) * channels;
      const [r, g, b, a = 255] = pixelFn(x, y);
      raw[index] = r;
      raw[index + 1] = g;
      raw[index + 2] = b;
      raw[index + 3] = a;
    }
  }
  await mkdir(ARTIFACT_DIR, { recursive: true });
  const file = path.join(ARTIFACT_DIR, `${name}.png`);
  await sharp(raw, { raw: { width, height, channels } }).png().toFile(file);
  const bytes = await readFile(file);
  return {
    path: path.relative(process.cwd(), file),
    hash: `sha256:${sha256BufferHex(bytes)}`,
  };
}

async function selfCheckSemanticVisualProbeEvidence() {
  const originalProfile = ACTIVE_AGENT_PROFILE;
  try {
    const sceneManifest = {
      schemaVersion: 'synthi.gpu_hmr.visual_scene_manifest.v1',
      sceneId: 'semantic-probe-self-check-scene',
      semanticProbes: [
        {
          id: 'self-check-material-gem',
          probeClass: 'diamond_specular_material',
          region: [0, 0, 4, 8],
          expected: 'material response changes on gem facets',
        },
        {
          id: 'self-check-light-shadow',
          probeClass: 'caustic_lighting_response',
          region: [4, 0, 4, 8],
          expected: 'lighting response changes on shadow edge',
        },
      ],
    };
    const visualSceneManifestHash = `sha256:${sha256Hex(stableJson(sceneManifest))}`;
    ACTIVE_AGENT_PROFILE = {
      visualSceneManifest: sceneManifest,
      visual_scene_manifest: sceneManifest,
      visualSceneManifestHash,
      visual_scene_manifest_hash: visualSceneManifestHash,
      visualSceneManifestEvidenceRef:
        `evidence:agent-profile-visual-scene-manifest:${visualSceneManifestHash}`,
      visual_scene_manifest_evidence_ref:
        `evidence:agent-profile-visual-scene-manifest:${visualSceneManifestHash}`,
      deterministicVisualModeHash: `sha256:${sha256Hex('semantic-probe-self-check-mode')}`,
      deterministic_visual_mode_hash: `sha256:${sha256Hex('semantic-probe-self-check-mode')}`,
    };
    const before = await writeSelfCheckSemanticImage(
      'semantic-probe-self-check-before',
      () => [20, 22, 24, 255],
    );
    const after = await writeSelfCheckSemanticImage(
      'semantic-probe-self-check-after',
      (x) => (x < 4 ? [70, 76, 82, 255] : [38, 42, 46, 255]),
    );
    const diff = await writeSelfCheckSemanticImage(
      'semantic-probe-self-check-diff',
      (x) => (x < 4 ? [50, 54, 58, 255] : [18, 20, 22, 255]),
    );
    const semantic = await semanticVisualProbeEvidenceFromDelta({
      visualArtifacts: {
        beforeImage: before.path,
        beforeImageHash: before.hash,
        afterImage: after.path,
        afterImageHash: after.hash,
        diffImage: diff.path,
        diffImageHash: diff.hash,
      },
    });
    if (
      semantic?.accepted !== true
      || semantic.acceptedForGpuHmr !== false
      || semantic.gpuHmrSuccess !== false
      || semantic.materialProbeAccepted !== true
      || semantic.lightingProbeAccepted !== true
      || !/^sha256:[a-f0-9]{64}$/.test(semantic.bindingHash ?? '')
      || !Array.isArray(semantic.probes)
      || semantic.probes.length !== 2
      || !semantic.probes.every((probe) =>
        probe.accepted === true
        && probe.acceptedAsSemanticProbe === true
        && probe.accepted_as_semantic_probe === true
      )
    ) {
      throw new Error(`semantic visual probe self-check failed: ${JSON.stringify(semantic)}`);
    }
    console.log('semantic visual probe self-check passed');
  } finally {
    ACTIVE_AGENT_PROFILE = originalProfile;
  }
}

function selfCheckRunModeVisualLedgerClockDomain() {
  const artifactBefore = `sha256:${'a'.repeat(64)}`;
  const artifactAfter = `sha256:${'b'.repeat(64)}`;
  const processId = 'pid:self-check-clock';
  const epoch = 'epoch:self-check-clock';
  const dispatchId = 'dispatch:self-check-clock';
  const dispatchTimestampNs = 1_782_760_141_383_000;
  const outputTimestampNs = dispatchTimestampNs + 1_000_000;
  const selectedFrameTimestampMs = 1_782_760_145_309;
  const timingFields = {
    static_discovery_time: 1,
    ai_contract_synthesis_time: 1,
    model_availability_check_time: 1,
    artifact_hash_time: 1,
    adapter_generation_time: 1,
    device_compile_wall_time: 41_000_000,
    artifact_load_time: 1,
    epoch_publish_time: 1,
    dispatch_trace_time: 1,
    runtime_probe_time: 9_950_000_000,
    oracle_analysis_time: 1,
    trigger_to_visible_time: 3_198_000_000,
    screenshot_capture_time: 1,
    dispatch_to_output_proof_time: 1,
    total_validator_wall_time: 9_991_000_000,
  };
  const modelProvenance = (requestMode, requestedModel) => ({
    provider: 'google_gemini',
    requested_model: requestedModel,
    provider_model_status: 'available',
    provider_model_alias_resolved_to: requestedModel,
    provider_shutdown_or_deprecation_detected: false,
    model_availability_checked_at: '2026-06-29T00:00:00.000Z',
    model_availability_source: 'provider_model_registry',
    model_availability_basis: 'static_registry',
    model_availability_check_time_ms: 1,
    actual_model: requestedModel,
    fallback_model: 'not_used',
    fallback_used: false,
    request_mode: requestMode,
    hard_infra_failure: false,
  });
  const ledger = {
    schemaVersion: 'synthi.gpu.hmr.proof_ledger.v1',
    records: [{
      project_id: 'agent-split-clock-domain-self-check',
      edit_id: 'agent-split-clock-domain-hot1',
      evidence_refs: ['evidence:self-check:clock-domain'],
      metric_clock: 'monotonic_ns',
      metric_scope: 'hot_delta_1',
      cache_state: 'compiler_cache_warm',
      timings: timingFields,
      timing_metrics: timingFields,
      model_provenance: {
        split: modelProvenance('split', 'gemini-3.5-flash'),
        gpu_delta: modelProvenance('gpu_delta', 'gemini-3.1-flash-lite'),
      },
      backend: 'hip',
      classification: {
        project_kind: 'gpu_project',
        edit_kind: 'gpu_artifact_edit',
        route: 'gpu_hmr',
      },
      contract_hash: `sha256:${'c'.repeat(64)}`,
      artifact_before_hash: artifactBefore,
      artifact_after_hash: artifactAfter,
      loader_event: {
        id: 'loader:self-check-clock',
        artifact_hash: artifactAfter,
        epoch,
        timestamp_monotonic_ns: dispatchTimestampNs - 3_000_000,
        process_id: processId,
      },
      epoch_publish_event: {
        id: 'publish:self-check-clock',
        artifact_hash: artifactAfter,
        epoch,
        timestamp_monotonic_ns: dispatchTimestampNs - 2_000_000,
        process_id: processId,
      },
      dispatch_event: {
        id: dispatchId,
        artifact_hash: artifactAfter,
        epoch,
        timestamp_monotonic_ns: dispatchTimestampNs,
        process_id: processId,
      },
      output_event: {
        id: 'output:self-check-clock',
        kind: 'visual_frame',
        passed: true,
        after_dispatch_id: dispatchId,
        artifact_hash: artifactAfter,
        epoch,
        timestamp_monotonic_ns: outputTimestampNs,
        process_id: processId,
      },
      retirement_event: {
        id: 'retire:self-check-clock',
        status: 'frame_boundary_proven',
        timestamp_monotonic_ns: outputTimestampNs + 1_000_000,
        process_id: processId,
      },
      process_identity: { process_id: processId },
      device_identity: { adapter_info: { vendor: 'amd', backend: 'hip' } },
      firewall_evidence: {
        cpu_hmr_used: false,
        full_rebuild_used: false,
        process_restarted: false,
        process_id_before: processId,
        process_id_after: processId,
      },
      cpu_hmr_used: false,
      full_rebuild_used: false,
      process_restarted: false,
      output_oracle_target: { kind: 'visual' },
    }],
  };
  const visualDelta = {
    baselineSeq: 1,
    selectedSeq: 3,
    selectedTs: selectedFrameTimestampMs,
    changedRatio: 0.25,
    meanAbs: 12.5,
    controlChangedRatio: 0,
    controlMeanAbs: 0.01,
    selected_frame_capture_after_epoch_dispatch: true,
    visual_artifacts: {
      before_image: 'self-check-before.png',
      before_image_hash: `sha256:${'1'.repeat(64)}`,
      after_image: 'self-check-after.png',
      after_image_hash: `sha256:${'2'.repeat(64)}`,
      diff_image: 'self-check-diff.png',
      diff_image_hash: `sha256:${'3'.repeat(64)}`,
    },
    visualArtifacts: {
      beforeImage: 'self-check-before.png',
      beforeImageHash: `sha256:${'1'.repeat(64)}`,
      afterImage: 'self-check-after.png',
      afterImageHash: `sha256:${'2'.repeat(64)}`,
      diffImage: 'self-check-diff.png',
      diffImageHash: `sha256:${'3'.repeat(64)}`,
    },
  };
  const beforeShot = {
    first: {
      seq: 1,
      ts: selectedFrameTimestampMs - 10_000,
      width: 2,
      height: 2,
      visiblePixels: 4,
      meta: {
        image_sha256: `sha256:${'4'.repeat(64)}`,
        capture_manifest: {
          schema_version: 'synthi.mcp.capture_manifest.v1',
          session_id: 'runtime-session:self-check-clock',
          capture_event_id: 'screenshot:self-check-clock:1',
          frame_event_id: 1,
          frame_seq: 1,
          frame_ts_ms: selectedFrameTimestampMs - 10_000,
          source_frame_hash: `sha256:${'5'.repeat(64)}`,
          image_sha256: `sha256:${'4'.repeat(64)}`,
          image_byte_length: 128,
        },
      },
    },
  };
  const afterShot = {
    first: {
      seq: 2,
      ts: selectedFrameTimestampMs - 100,
      width: 2,
      height: 2,
      visiblePixels: 4,
      meta: {
        image_sha256: `sha256:${'6'.repeat(64)}`,
        capture_manifest: {
          schema_version: 'synthi.mcp.capture_manifest.v1',
          session_id: 'runtime-session:self-check-clock',
          capture_event_id: 'screenshot:self-check-clock:2',
          frame_event_id: 2,
          frame_seq: 2,
          frame_ts_ms: selectedFrameTimestampMs - 100,
          source_frame_hash: `sha256:${'7'.repeat(64)}`,
          image_sha256: `sha256:${'6'.repeat(64)}`,
          image_byte_length: 128,
          gate_token: 'frame-gate:self-check-clock',
          gate_token_verified: true,
          frame_gate: {
            required_ts_ms: selectedFrameTimestampMs - 3_926,
          },
        },
      },
    },
    second: {
      seq: 3,
      ts: selectedFrameTimestampMs,
      width: 2,
      height: 2,
      visiblePixels: 4,
      meta: {
        image_sha256: `sha256:${'8'.repeat(64)}`,
        capture_manifest: {
          schema_version: 'synthi.mcp.capture_manifest.v1',
          session_id: 'runtime-session:self-check-clock',
          capture_event_id: 'screenshot:self-check-clock:3',
          frame_event_id: 3,
          frame_seq: 3,
          frame_ts_ms: selectedFrameTimestampMs,
          source_frame_hash: `sha256:${'9'.repeat(64)}`,
          image_sha256: `sha256:${'8'.repeat(64)}`,
          image_byte_length: 128,
          gate_token_verified: false,
        },
      },
    },
  };
  const originalProfile = ACTIVE_AGENT_PROFILE;
  let proof;
  try {
    ACTIVE_AGENT_PROFILE = {
      deterministicVisualMode: {
        fixed_seed: true,
        frozen_camera: true,
        temporal_accumulation_not_applicable: true,
        taa_not_applicable: true,
        denoiser_not_applicable: true,
        fixed_swapchain_image_count: true,
        frame_capture_after_epoch_dispatch: true,
        presentation_fence_or_frame_boundary: true,
        profile_only_marker: 'self-check-profile-declaration-retained-only',
      },
    };
    proof = withRunModeVisualLedgerProof({
      proof: {
        proofLedger: ledger,
        proof_ledger: ledger,
        runtimeProofArtifact: {
          proofId: 'gpu-runtime-proof:sha256:self-check-clock-domain',
          proofLedger: ledger,
          proof_ledger: ledger,
        },
        gpuProofValidation: {
          satisfied: true,
          proofLedgerValidation: {
            gpuHmrSuccess: true,
            failedInvariants: [],
          },
        },
      },
      visualDelta,
      beforeShot,
      afterShot,
      wait: {
        frame_gate: {
          status: 'satisfied',
          frame_seq: 2,
          ts_ms: selectedFrameTimestampMs - 3_926,
          session_id: 'runtime-session:self-check-clock',
          gate_token: 'frame-gate:self-check-clock',
        },
        gpu_proof_validation: { satisfied: true },
      },
    });
  } finally {
    ACTIVE_AGENT_PROFILE = originalProfile;
  }
  const recomputed = queryGpuHmrLedgerInvariants(embeddedLedgerFromProof(proof));
  const record = firstLedgerRecord(embeddedLedgerFromProof(proof));
  const artifacts =
    record?.outputEvent?.visualOracleArtifacts
    ?? record?.output_event?.visual_oracle_artifacts
    ?? null;
  const deterministicMode = record?.deterministicVisualMode ?? record?.deterministic_visual_mode ?? null;
  const declaredModeFacet =
    record?.declaredDeterministicVisualMode
    ?? record?.declared_deterministic_visual_mode
    ?? null;
  const failedInvariantCodes = recomputed.failedInvariants?.map((failure) => failure?.code ?? failure) ?? [];
  let acceptedFirewallRejected = false;
  try {
    ledgerFirewallFieldsFromProof(proof);
  } catch {
    acceptedFirewallRejected = true;
  }
  if (
    recomputed.gpuHmrSuccess !== false
    || !Array.isArray(recomputed.failedInvariants)
    || !failedInvariantCodes.includes('visual_camera_state_hash_invalid')
    || !failedInvariantCodes.includes('frozen_camera_unproven')
    || !failedInvariantCodes.includes('seed_policy_unproven')
    || artifacts?.timestamp_after_dispatch !== outputTimestampNs
    || artifacts?.timestamp_after_dispatch_clock !== 'ledger_output_event_monotonic_ns'
    || artifacts?.selected_frame_timestamp_ms !== selectedFrameTimestampMs
    || artifacts?.camera_state_hash !== null
    || deterministicMode?.fixed_resolution !== true
    || deterministicMode?.frame_capture_after_epoch_dispatch !== true
    || deterministicMode?.presentation_fence_or_frame_boundary !== true
    || deterministicMode?.frozen_camera !== null
    || deterministicMode?.seed_policy_fixed !== null
    || deterministicMode?.temporal_accumulation_not_applicable !== null
    || deterministicMode?.taa_not_applicable !== null
    || deterministicMode?.denoiser_not_applicable !== null
    || deterministicMode?.fixed_swapchain_image_count !== null
    || deterministicMode?.profile_only_marker !== undefined
    || declaredModeFacet?.proofAuthority !== 'profile_declaration_only_not_runtime_visual_proof'
    || declaredModeFacet?.acceptedForGpuHmr !== false
    || declaredModeFacet?.gpuHmrSuccess !== false
    || declaredModeFacet?.declaredMode?.profile_only_marker
      !== 'self-check-profile-declaration-retained-only'
    || acceptedFirewallRejected !== true
  ) {
    throw new Error(`run-mode visual ledger clock-domain self-check failed: ${JSON.stringify({
      gpuHmrSuccess: recomputed.gpuHmrSuccess,
      failedInvariants: recomputed.failedInvariants,
      timestampAfterDispatch: artifacts?.timestamp_after_dispatch,
      timestampAfterDispatchClock: artifacts?.timestamp_after_dispatch_clock,
      selectedFrameTimestampMs: artifacts?.selected_frame_timestamp_ms,
      cameraStateHash: artifacts?.camera_state_hash,
      deterministicMode,
      declaredModeFacet,
      acceptedFirewallRejected,
    })}`);
  }
  console.log('run-mode visual ledger clock-domain self-check passed');
}

async function selfCheckProofFinalizationRetry() {
  const selectedPath = '.synthi/generated/gpu/device.hip';
  const waitContract = waitContractForCompile({
    args: {
      filename: selectedPath,
      compile_manifest: {
        module_files: {
          device: selectedPath,
          host: '.synthi/generated/gpu/host_runner.cpp',
        },
        gpu: {
          device_roles: [{
            id: 'device',
            path: selectedPath,
            compiler: 'hipcc',
          }],
        },
      },
    },
    compile: {
      ok: true,
      dispatched_at: 12345,
      artifact_hash_after: `sha256:${'d'.repeat(64)}`,
    },
    timeoutMs: 15000,
    options: {
      editId: 'self-check-proof-retry-edit',
      editHash: `sha256:${'e'.repeat(64)}`,
      requiredGpuProofState: 'gpu-hmr-full-runtime-proven',
    },
  });
  const pendingWaitError = new Error(`tool synthi_wait_hmr isError: ${JSON.stringify({
    error: 'gpu_hmr_proof_insufficient',
    status: 'timeout',
    gpu_proof_validation: {
      reason: 'proof_state_missing',
      resultState: 'gpu-hmr-dispatch-observed',
      effectiveResultRank: 5,
    },
  })}`);
  const parsedPending = waitResultFromWaitHmrToolError(pendingWaitError);
  const proofLedgerMissing = {
    error: 'gpu_hmr_proof_insufficient',
    status: 'timeout',
    gpu_proof_validation: {
      reason: 'proof_ledger_missing',
    },
  };
  const terminalRejected = {
    error: 'gpu_hmr_proof_insufficient',
    status: 'timeout',
    gpu_proof_validation: {
      reason: 'proof_ledger_rejected',
    },
  };
  const failedFast = {
    error: 'gpu_hmr_proof_insufficient',
    status: 'timeout',
    gpu_proof_validation: {
      reason: 'proof_state_missing',
    },
    gpu_proof_wait: {
      status: 'failed_fast',
    },
  };
  const nonStrictContract = {
    waitArgs: {
      timeoutMs: 15000,
    },
  };
  let callCount = 0;
  const fakeState = {
    client: {
      async toolCall(name, args) {
        if (name !== 'synthi_wait_hmr') throw new Error(`unexpected tool ${name}`);
        if (args.module !== 'device' || args.since_ts !== 12345) {
          throw new Error(`wait contract drifted: ${JSON.stringify(args)}`);
        }
        callCount += 1;
        if (callCount === 1) throw pendingWaitError;
        return {
          status: 'applied',
          source: 'self_check',
          gpu_proof_validation: {
            satisfied: true,
            resultState: 'gpu-hmr-full-runtime-proven',
            effectiveResultRank: 9,
          },
          gpu_proof_telemetry: {
            proofId: `gpu-runtime-proof:sha256:${'f'.repeat(64)}`,
            proofArtifactPath: '/tmp/self-check-runtime-proof.json',
          },
        };
      },
    },
  };
  const { wait, retryEvidence } = await waitHmrWithStrictProofRetry(fakeState, waitContract, 15000, {
    strictProofRetryTimeoutMs: 30000,
    strictProofRetryDelayMs: 0,
  });
  if (
    parsedPending?.error !== 'gpu_hmr_proof_insufficient'
    || strictProofWaitRetryReason(parsedPending, waitContract) !== 'proof_state_missing'
    || strictProofWaitRetryReason(proofLedgerMissing, waitContract) !== 'proof_ledger_missing'
    || strictProofWaitRetryReason(terminalRejected, waitContract) !== null
    || strictProofWaitRetryReason(failedFast, waitContract) !== null
    || strictProofWaitRetryReason(parsedPending, nonStrictContract) !== null
    || callCount !== 2
    || wait.status !== 'applied'
    || retryEvidence?.proofAuthority !== 'strict_proof_wait_retry_scheduling_only_not_gpu_hmr_acceptance'
    || retryEvidence.acceptedForGpuHmr !== false
    || retryEvidence.gpuHmrSuccess !== false
    || retryEvidence.canSatisfyRuntimeProof !== false
    || retryEvidence.reason !== 'proof_state_missing'
    || retryEvidence.stopReason !== 'proof_ready'
    || retryEvidence.sinceTs !== 12345
    || retryEvidence.module !== 'device'
    || retryEvidence.selectedPath !== selectedPath
    || retryEvidence.editHash !== `sha256:${'e'.repeat(64)}`
    || retryEvidence.requiredGpuProofState !== 'gpu-hmr-full-runtime-proven'
    || !Array.isArray(retryEvidence.attempts)
    || retryEvidence.attempts.length !== 2
    || retryEvidence.attempts[0].reason !== 'proof_state_missing'
    || retryEvidence.attempts[1].status !== 'applied'
  ) {
    throw new Error(`proof-finalization retry self-check failed: ${JSON.stringify({
      parsedPending,
      retryReason: strictProofWaitRetryReason(parsedPending, waitContract),
      callCount,
      waitStatus: wait.status,
      retryEvidence,
    }).slice(0, 4000)}`);
  }
  console.log('proof-finalization retry self-check passed');
}

function selfCheckRequestedProofStateGate() {
  const compileProvenRejectedWait = {
    status: 'rejected',
    gpu_proof_validation: {
      requiredState: 'gpu-hmr-compile-proven',
      resultState: 'gpu-hmr-compile-proven',
      effectiveResultRank: 1,
      degradedState: 'gpu-hmr-dispatch-unobserved',
      degradedStateRankCap: 4,
      satisfied: true,
    },
    gpu_proof_telemetry: {
      proofId: `gpu-proof:${'a'.repeat(64)}`,
      proofArtifactPath: '.synthi/gpu-hmr/proofs/self-check-compile.json',
      resultState: 'gpu-hmr-compile-proven',
      degradedState: 'gpu-hmr-dispatch-unobserved',
      degradedReason: 'runtime_dispatch_not_observed',
      source: 'gpu-proof-state',
    },
  };
  const compileGate = requestedProofStateValidation(compileProvenRejectedWait, 'gpu-hmr-compile-proven');
  const initialCompileProof = initialDeviceCompileProofFromResult({ wait: compileProvenRejectedWait });
  const fullRuntimeProof = fullRuntimeGpuHmrProofFromResult({ wait: compileProvenRejectedWait });
  const timeoutGate = requestedProofStateValidation({
    ...compileProvenRejectedWait,
    status: 'timeout',
  }, 'gpu-hmr-compile-proven');
  const errorGate = requestedProofStateValidation({
    ...compileProvenRejectedWait,
    error: 'gpu_hmr_proof_insufficient',
  }, 'gpu-hmr-compile-proven');
  const weakRankGate = requestedProofStateValidation({
    ...compileProvenRejectedWait,
    gpu_proof_validation: {
      ...compileProvenRejectedWait.gpu_proof_validation,
      resultState: 'gpu-hmr-compile-proven',
      effectiveResultRank: 1,
      requiredState: 'gpu-hmr-compile-proven',
    },
  }, 'gpu-hmr-dispatch-observed');
  const rejectedFullRuntimeGate = requestedProofStateValidation({
    status: 'rejected',
    gpu_proof_validation: {
      requiredState: 'gpu-hmr-full-runtime-proven',
      resultState: 'gpu-hmr-full-runtime-proven',
      effectiveResultRank: 9,
      satisfied: true,
    },
    gpu_proof_telemetry: {
      proofId: `gpu-runtime-proof:sha256:${'b'.repeat(64)}`,
      proofArtifactPath: '.synthi/gpu-hmr/proofs/self-check-runtime.json',
      resultState: 'gpu-hmr-full-runtime-proven',
    },
  }, 'gpu-hmr-full-runtime-proven');
  const missingArtifactPathGate = requestedProofStateValidation({
    ...compileProvenRejectedWait,
    gpu_proof_telemetry: {
      ...compileProvenRejectedWait.gpu_proof_telemetry,
      proofArtifactPath: '',
    },
  }, 'gpu-hmr-compile-proven');
  if (
    compileGate.accepted !== true
    || compileGate.rejectedCompileOnlyBoundary !== true
    || compileGate.gpuHmrSuccess !== false
    || initialCompileProof.accepted !== true
    || initialCompileProof.waitStatus !== 'rejected'
    || fullRuntimeProof.accepted !== false
    || timeoutGate.accepted !== false
    || !timeoutGate.blockingGaps.includes('wait_status_cannot_carry_requested_proof_validation')
    || errorGate.accepted !== false
    || !errorGate.blockingGaps.includes('wait_error_present')
    || weakRankGate.accepted !== false
    || !weakRankGate.blockingGaps.includes('validated_required_state_below_requested_state')
    || rejectedFullRuntimeGate.accepted !== false
    || !rejectedFullRuntimeGate.blockingGaps.includes('wait_status_cannot_carry_requested_proof_validation')
    || missingArtifactPathGate.accepted !== false
    || !missingArtifactPathGate.blockingGaps.includes('requested_proof_state_proof_artifact_path_missing')
  ) {
    throw new Error(`requested proof-state gate self-check failed: ${JSON.stringify({
      compileGate,
      initialCompileProof,
      fullRuntimeProof,
      timeoutGate,
      errorGate,
      weakRankGate,
      rejectedFullRuntimeGate,
      missingArtifactPathGate,
    }).slice(0, 4000)}`);
  }
  console.log('requested proof-state gate self-check passed');
}

function selfCheckMcpStartupCleanup() {
  const calls = [];
  const fakeProc = {
    stdin: {
      end() {
        calls.push('stdin.end');
      },
    },
    kill(signal) {
      calls.push(`kill:${signal}`);
      return true;
    },
  };
  const disposed = disposeMcpProcess(fakeProc);
  if (
    disposed.stdinEnded !== true
    || disposed.killed !== true
    || calls.join('|') !== 'stdin.end|kill:SIGTERM'
  ) {
    throw new Error(`MCP startup cleanup self-check failed: ${JSON.stringify({ disposed, calls })}`);
  }
  console.log('MCP startup cleanup self-check passed');
}

async function selfCheckHttpWorkspaceTimeoutDiagnostics() {
  const timeoutCause = new Error('headers timeout');
  timeoutCause.name = 'HeadersTimeoutError';
  timeoutCause.code = 'UND_ERR_HEADERS_TIMEOUT';
  const fetchError = new TypeError('fetch failed');
  fetchError.cause = timeoutCause;
  const diagnostic = httpFailureMessage('POST', 'http://127.0.0.1:1234/git/example/write-files-batch', fetchError, 1234);
  if (
    !diagnostic.includes('timeout_ms=1234')
    || !diagnostic.includes('cause_code=UND_ERR_HEADERS_TIMEOUT')
    || !diagnostic.includes('cause_name=HeadersTimeoutError')
  ) {
    throw new Error(`HTTP timeout diagnostic self-check failed: ${diagnostic}`);
  }

  const originalFallback = process.env.SYNTHI_VALIDATION_AUTHLESS_WORKSPACE;
  process.env.SYNTHI_VALIDATION_AUTHLESS_WORKSPACE = '1';
  try {
    const workspace = await createValidationWorkspace({
      frontendUrl: 'http://127.0.0.1:3000',
      name: 'self-check-workspace-timeout',
      slug: 'self-check-workspace-timeout',
      httpJson: async () => {
        throw new Error(diagnostic, { cause: fetchError });
      },
      record: () => {},
    });
    if (
      workspace?.validationOnly !== true
      || workspace?.fallbackReason !== 'workspace_api_unavailable'
      || workspace?.slug !== 'self-check-workspace-timeout'
    ) {
      throw new Error(`workspace timeout fallback self-check failed: ${JSON.stringify(workspace)}`);
    }
  } finally {
    if (originalFallback === undefined) {
      delete process.env.SYNTHI_VALIDATION_AUTHLESS_WORKSPACE;
    } else {
      process.env.SYNTHI_VALIDATION_AUTHLESS_WORKSPACE = originalFallback;
    }
  }
  console.log('HTTP workspace timeout diagnostic self-check passed');
}

function literalOccurrenceCount(source, needle) {
  if (!needle) return 0;
  let count = 0;
  let index = 0;
  while (index <= source.length) {
    const next = source.indexOf(needle, index);
    if (next < 0) break;
    count += 1;
    index = next + Math.max(1, needle.length);
  }
  return count;
}

function exposedSplitPath(filePath) {
  const rel = cleanRel(filePath);
  const prefix = '.synthi/generated/gpu/';
  if (!rel.startsWith(prefix)) return null;
  const suffix = rel.slice(prefix.length).split('/').filter(Boolean).join('/');
  return suffix ? `${EXPOSED_SPLIT_DIR}/${suffix}` : null;
}

function exposedCompileManifest(manifest) {
  const copy = JSON.parse(JSON.stringify(manifest || {}));
  if (copy.module_files && typeof copy.module_files === 'object') {
    for (const [role, filePath] of Object.entries(copy.module_files)) {
      const exposed = exposedSplitPath(filePath);
      if (exposed) copy.module_files[role] = exposed;
    }
  }
  if (copy.gpu?.device_roles && Array.isArray(copy.gpu.device_roles)) {
    copy.gpu.device_roles = copy.gpu.device_roles.map((role) => {
      if (!role || typeof role !== 'object') return role;
      const exposed = exposedSplitPath(role.path);
      return exposed ? { ...role, path: exposed } : role;
    });
  }
  return copy;
}

function visibleGpuSplitFiles(split, granularity = null) {
  const files = [];
  for (const [filePath, content] of Object.entries(split.files || {})) {
    const exposed = exposedSplitPath(filePath);
    if (exposed) files.push({ path: exposed, content });
  }
  if (!files.length) return files;
  const manifest = exposedCompileManifest(split.manifest);
  files.push({ path: 'synthi/build_manifest.json', content: JSON.stringify(manifest, null, 2) + '\n' });
  if (granularity) {
    files.push({
      path: 'synthi/gpu_hmr_granularity.json',
      content: JSON.stringify(granularity, null, 2) + '\n',
    });
  }
  files.push({
    path: `${EXPOSED_SPLIT_DIR}/README.md`,
    content: [
      '# GPU HMR Split Files',
      '',
      'These files are the visible editor surface for the generated GPU split.',
      'Edit the generated device-surface file here; acceptance still requires runtime proof-ledger closure.',
      '',
      'Granularity is manifest-derived. A single device file proves device-translation-unit HMR, not per-kernel or smallest-safe fission.',
      'Smallest-safe fission requires a deterministic fission verifier report.',
      'The internal `.synthi/` files remain implementation metadata.',
      '',
    ].join('\n'),
  });
  return files;
}

async function persistGeneratedSplitToWorkspace(split, granularity = null) {
  const files = Object.entries(split.files).map(([filePath, content]) => ({ path: filePath, content }));
  files.push({ path: '.synthi_split_meta.json', content: split.sidecarRaw });
  files.push({ path: '.synthi/build_manifest.json', content: JSON.stringify(split.manifest, null, 2) + '\n' });
  if (granularity) {
    files.push({
      path: '.synthi/gpu_hmr_granularity.json',
      content: JSON.stringify(granularity, null, 2) + '\n',
    });
  }
  files.push(...visibleGpuSplitFiles(split, granularity));
  await writeFilesBatch({ slug: CFG.slug, files });
  record('persist generated split to workspace', 'pass', `${files.length} files`);
  await stageAndCommit({ slug: CFG.slug, message: 'gpu-hmr-agent-split-test: persist generated split' })
    .then(() => record('workspace commit generated split', 'pass'))
    .catch((e) => record('workspace commit generated split', 'warn', e.message.slice(0, 200)));
}

async function compileGeneratedDevice(split, editedDevice, options = {}) {
  const previousDevice = split.files[split.roles.device];
  const sourceBaselineProof = sourceBaselineProofFromSidecar(
    split.sidecarRaw,
    split.roles.device,
    previousDevice,
  );
  if (!sourceBaselineProof.accepted) {
    throw new Error(`generated split sidecar lacks compiler-emitted source baseline proof for ${split.roles.device}: ${sourceBaselineProof.failures.join('|')}`);
  }
  const sidecarRaw = split.sidecarRaw;
  split.files[split.roles.device] = editedDevice;
  const editKind = options.editKind ?? 'gpu_artifact_edit';
  const editHash = options.editHash ?? deviceEditHash({
    selectedPath: split.roles.device,
    beforeSource: previousDevice,
    afterSource: editedDevice,
    editKind,
  });
  const allFiles = [
    ...Object.entries(split.files).map(([name, content]) => ({ name, content })),
    { name: '.synthi_split_meta.json', content: sidecarRaw },
    { name: '.synthi/build_manifest.json', content: JSON.stringify(split.manifest, null, 2) + '\n' },
  ];
  const additionalFiles = allFiles.filter((f) => cleanRel(f.name) !== cleanRel(split.roles.device));
  await writeFilesBatch({
    slug: CFG.slug,
    files: [{ path: split.roles.device, content: editedDevice }],
  });
  const result = await compileViaMcp({
    language: 'cpp',
    filename: split.roles.device,
    source: editedDevice,
    files: additionalFiles,
    is_gui: true,
    use_ai_split: false,
    user_requested_deterministic: true,
    prefer_gpu_pipeline: true,
    gpu_mode: split.manifest.gpu.vendor,
    gpu_arch: CFG.gpuArch,
    gpu_arch_source: CFG.gpuArchSource,
    compile_manifest: split.manifest,
    slug: CFG.slug,
    width: validationProfileWidth(),
    height: validationProfileHeight(),
  }, CFG.hotSwapTimeoutMs, {
    metricScope: options.metricScope ?? 'hot_delta_1',
    cacheState: options.cacheState ?? 'compiler_cache_warm',
    editId: options.editId ?? `device-edit:${sha256Hex(editHash).slice(0, 16)}`,
    editHash,
    editKind,
    differentEdit: options.differentEdit === true,
    waitRecordLabel: options.waitRecordLabel,
  });
  const refreshedSourceBaselineProof = await refreshGeneratedSplitSidecar(
    split,
    split.roles.device,
    editedDevice,
  );
  return {
    ...result,
    previousDevice,
    editedDevice,
    selectedPath: split.roles.device,
    editHash,
    editId: options.editId ?? `device-edit:${sha256Hex(editHash).slice(0, 16)}`,
    editKind,
    sourceBaselineProof,
    refreshedSourceBaselineProof,
    refreshed_source_baseline_proof: refreshedSourceBaselineProof,
  };
}

async function writeImageArtifact(name, imageData) {
  await mkdir(ARTIFACT_DIR, { recursive: true });
  const file = path.join(ARTIFACT_DIR, `${name}.png`);
  const buffer = Buffer.from(imageData, 'base64');
  await writeFile(file, buffer);
  return {
    path: path.relative(process.cwd(), file),
    hash: `sha256:${sha256BufferHex(buffer)}`,
  };
}

async function writeJsonArtifact(name, value) {
  await mkdir(ARTIFACT_DIR, { recursive: true });
  const file = path.join(ARTIFACT_DIR, `${name}.json`);
  await writeFile(file, JSON.stringify(value, null, 2));
  return path.relative(process.cwd(), file);
}

function withoutImageData(shot) {
  if (!shot || typeof shot !== 'object') return shot;
  const { imageData, ...rest } = shot;
  return rest;
}

function waitProofFields(result) {
  const wait = result?.wait ?? {};
  const proofLedger = wait.proofLedger ?? wait.proof_ledger ?? null;
  const runtimeProofArtifact = wait.runtimeProofArtifact ?? wait.runtime_proof_artifact ?? null;
  return {
    gpuProofValidation: wait.gpu_proof_validation ?? null,
    gpu_proof_validation: wait.gpu_proof_validation ?? null,
    gpuProofTelemetry: wait.gpu_proof_telemetry ?? null,
    gpu_proof_telemetry: wait.gpu_proof_telemetry ?? null,
    proofLedger,
    proof_ledger: proofLedger,
    runtimeProofArtifact,
    runtime_proof_artifact: runtimeProofArtifact,
  };
}

function backendForSplit(split) {
  const value = String(split?.manifest?.gpu?.vendor ?? CFG.gpuVendor ?? '').toLowerCase();
  if (value === 'rocm' || value === 'amd' || value === 'hip') return 'hip';
  if (value === 'cuda' || value === 'opencl' || value === 'vulkan' || value === 'webgpu') return value;
  return 'unknown';
}

function splitProofIdentity(split) {
  const manifest = split?.manifest && typeof split.manifest === 'object' ? split.manifest : {};
  const moduleFiles = manifest.module_files && typeof manifest.module_files === 'object'
    ? Object.fromEntries(
      Object.entries(manifest.module_files)
        .map(([role, filePath]) => [role, cleanRel(filePath)])
        .sort(([left], [right]) => left.localeCompare(right)),
    )
    : {};
  const deviceRoles = Array.isArray(manifest.gpu?.device_roles)
    ? manifest.gpu.device_roles.map((role) => ({
      id: role?.id ?? null,
      path: cleanRel(role?.path),
      compiler: role?.compiler ?? null,
      arch: Array.isArray(role?.arch) ? role.arch : [],
    }))
    : [];
  const explicitTarget = manifest.project_id ?? manifest.projectId ?? manifest.target_id ?? manifest.targetId;
  const topologyHash = sha256Hex(stableJson({
    gpu: manifest.gpu ?? null,
    moduleFiles,
    deviceRoles,
  })).slice(0, 24);
  const targetId = explicitTarget
    ? String(explicitTarget)
    : `generated-gpu-split:${topologyHash}`;
  const profileId = String(
    manifest.profile_id
      ?? manifest.profileId
      ?? manifest.contract_id
      ?? manifest.contractId
      ?? targetId,
  );
  return {
    targetId,
    target_id: targetId,
    profileId,
    profile_id: profileId,
    targetIdentityEvidenceSource: explicitTarget
      ? 'compile_manifest_project_identity'
      : 'compile_manifest_topology_hash',
    target_identity_evidence_source: explicitTarget
      ? 'compile_manifest_project_identity'
      : 'compile_manifest_topology_hash',
  };
}

function runModeProofIdentity(split) {
  const splitIdentity = splitProofIdentity(split);
  const sourceHash = ACTIVE_AGENT_PROFILE?.source?.contentHash ?? ACTIVE_AGENT_PROFILE?.source?.content_hash ?? null;
  const sourceEvidenceRef =
    ACTIVE_AGENT_PROFILE?.source?.evidenceRef ?? ACTIVE_AGENT_PROFILE?.source?.evidence_ref ?? null;
  const visualSceneManifestHash =
    ACTIVE_AGENT_PROFILE?.visualSceneManifestHash
    ?? ACTIVE_AGENT_PROFILE?.visual_scene_manifest_hash
    ?? null;
  const visualSceneManifestEvidenceRef =
    ACTIVE_AGENT_PROFILE?.visualSceneManifestEvidenceRef
    ?? ACTIVE_AGENT_PROFILE?.visual_scene_manifest_evidence_ref
    ?? null;
  return {
    backend: backendForSplit(split),
    ...splitIdentity,
    generatedSplitProfileId: splitIdentity.profileId,
    generated_split_profile_id: splitIdentity.profile_id,
    profileId: validationProfileId(),
    profile_id: validationProfileId(),
    fixtureId: validationFixtureId(),
    fixture_id: validationFixtureId(),
    validationProfileId: validationProfileId(),
    validation_profile_id: validationProfileId(),
    validationProfileSource: validationProfileEvidenceSource(),
    validation_profile_source: validationProfileEvidenceSource(),
    ...(ACTIVE_AGENT_PROFILE ? {
      validationProfileHash: ACTIVE_AGENT_PROFILE.profileHash,
      validation_profile_hash: ACTIVE_AGENT_PROFILE.profileHash,
      validationProfileSourceContentHash: sourceHash,
      validation_profile_source_content_hash: sourceHash,
      validationProfileSourceEvidenceRef: sourceEvidenceRef,
      validation_profile_source_evidence_ref: sourceEvidenceRef,
      validationProfileDeterministicModeHash: ACTIVE_AGENT_PROFILE.deterministicVisualModeHash,
      validation_profile_deterministic_mode_hash: ACTIVE_AGENT_PROFILE.deterministicVisualModeHash,
      validationProfileVisualProofHash: ACTIVE_AGENT_PROFILE.visualProof?.proofHash ?? null,
      validation_profile_visual_proof_hash: ACTIVE_AGENT_PROFILE.visualProof?.proof_hash ?? null,
      validationProfileVisualSceneManifestHash: visualSceneManifestHash,
      validation_profile_visual_scene_manifest_hash: visualSceneManifestHash,
      validationProfileVisualSceneManifestEvidenceRef: visualSceneManifestEvidenceRef,
      validation_profile_visual_scene_manifest_evidence_ref: visualSceneManifestEvidenceRef,
      validationProfilePath: ACTIVE_AGENT_PROFILE.profilePath,
      validation_profile_path: ACTIVE_AGENT_PROFILE.profilePath,
    } : {}),
  };
}

function profileClassForFixture(fixture = CFG.fixture) {
  const normalized = String(fixture || 'unknown')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return `${normalized || 'unknown'}_visual_gpu_path`;
}

function typedValidationProfileEvidence({ proof = null, split = null, visualDelta = null } = {}) {
  const ledger = proof ? embeddedLedgerFromProof(proof) : null;
  const recomputed = ledger ? queryGpuHmrLedgerInvariants(ledger) : null;
  const record = recomputed?.record ?? firstLedgerRecord(ledger);
  const splitIdentity = split ? splitProofIdentity(split) : {};
  const sourceHash = ACTIVE_AGENT_PROFILE?.source?.contentHash ?? ACTIVE_AGENT_PROFILE?.source?.content_hash ?? null;
  const sourceEvidenceRef =
    ACTIVE_AGENT_PROFILE?.source?.evidenceRef ?? ACTIVE_AGENT_PROFILE?.source?.evidence_ref ?? null;
  const deterministicModeHash = ACTIVE_AGENT_PROFILE?.deterministicVisualModeHash
    ?? ACTIVE_AGENT_PROFILE?.deterministic_visual_mode_hash
    ?? null;
  const visualProofHash = ACTIVE_AGENT_PROFILE?.visualProof?.proofHash
    ?? ACTIVE_AGENT_PROFILE?.visual_proof?.proof_hash
    ?? null;
  const visualSceneManifestHash = ACTIVE_AGENT_PROFILE?.visualSceneManifestHash
    ?? ACTIVE_AGENT_PROFILE?.visual_scene_manifest_hash
    ?? null;
  const visualSceneManifestEvidenceRef =
    ACTIVE_AGENT_PROFILE?.visualSceneManifestEvidenceRef
    ?? ACTIVE_AGENT_PROFILE?.visual_scene_manifest_evidence_ref
    ?? null;
  const proofIds = [
    recomputed?.proofId,
    recomputed?.proof_id,
    record?.proofId,
    record?.proof_id,
    proof?.runtimeProofArtifact?.proofId,
    proof?.runtime_proof_artifact?.proofId,
    proof?.runtimeProofArtifact?.proof_id,
    proof?.runtime_proof_artifact?.proof_id,
  ].filter(Boolean);
  const evidenceRefs = [
    `evidence:agent-split-validation-profile:${validationProfileId()}`,
    ACTIVE_AGENT_PROFILE?.profileHash,
    sourceHash,
    sourceEvidenceRef,
    deterministicModeHash,
    visualProofHash,
    visualSceneManifestHash,
    visualSceneManifestEvidenceRef,
    ...proofIds,
    splitIdentity.targetId,
    visualDelta?.diffPath,
  ].filter(Boolean);
  return {
    schemaVersion: 'synthi.gpu.hmr.validation_profile_evidence.v1',
    accepted: true,
    profileId: validationProfileId(),
    profile_id: validationProfileId(),
    profileClass: validationProfileClass(),
    profile_class: validationProfileClass(),
    source: validationProfileEvidenceSource(),
    profileHash: ACTIVE_AGENT_PROFILE?.profileHash ?? null,
    profile_hash: ACTIVE_AGENT_PROFILE?.profileHash ?? null,
    sourceContentHash: sourceHash,
    source_content_hash: sourceHash,
    declaredSourceContentHash:
      ACTIVE_AGENT_PROFILE?.source?.declaredContentHash
      ?? ACTIVE_AGENT_PROFILE?.source?.declared_content_hash
      ?? null,
    declared_source_content_hash:
      ACTIVE_AGENT_PROFILE?.source?.declaredContentHash
      ?? ACTIVE_AGENT_PROFILE?.source?.declared_content_hash
      ?? null,
    deterministicVisualModeHash: deterministicModeHash,
    deterministic_visual_mode_hash: deterministicModeHash,
    visualProofHash,
    visual_proof_hash: visualProofHash,
    visualSceneManifestHash,
    visual_scene_manifest_hash: visualSceneManifestHash,
    visualSceneManifestEvidenceRef,
    visual_scene_manifest_evidence_ref: visualSceneManifestEvidenceRef,
    profilePath: ACTIVE_AGENT_PROFILE?.profilePath ?? null,
    profile_path: ACTIVE_AGENT_PROFILE?.profilePath ?? null,
    proofIds: [...new Set(proofIds)],
    proof_ids: [...new Set(proofIds)],
    evidenceRefs: [...new Set(evidenceRefs)],
    evidence_refs: [...new Set(evidenceRefs)],
  };
}

function runModeCoverageSupportFromProof(proof) {
  const runtimeProofArtifact = isRecord(proof?.runtimeProofArtifact)
    ? proof.runtimeProofArtifact
    : isRecord(proof?.runtime_proof_artifact)
      ? proof.runtime_proof_artifact
      : null;
  return buildGpuHmrRunModeCoverageSupport({
    proofLedger: embeddedLedgerFromProof(proof),
    proofLedgerQuery:
      proof?.proofLedgerQuery
      ?? proof?.proof_ledger_query
      ?? runtimeProofArtifact?.proofLedgerQuery
      ?? runtimeProofArtifact?.proof_ledger_query,
    runtimeProofArtifact,
    parentProofIds: [
      proof?.proofId,
      proof?.proof_id,
      proof?.gpuProofValidation?.proofId,
      proof?.gpu_proof_validation?.proof_id,
      proof?.gpuProofValidation?.proofLedgerValidation?.proofId,
      proof?.gpu_proof_validation?.proofLedgerValidation?.proof_id,
      proof?.gpuProofValidation?.proofLedgerValidation?.proof_id,
      proof?.gpu_proof_validation?.proof_ledger_validation?.proofId,
      proof?.gpu_proof_validation?.proof_ledger_validation?.proof_id,
    ],
  });
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function embeddedLedgerFromProof(proof) {
  if (isRecord(proof?.proofLedger)) return proof.proofLedger;
  if (isRecord(proof?.proof_ledger)) return proof.proof_ledger;
  const runtimeProofArtifact = isRecord(proof?.runtimeProofArtifact)
    ? proof.runtimeProofArtifact
    : isRecord(proof?.runtime_proof_artifact)
      ? proof.runtime_proof_artifact
      : null;
  if (isRecord(runtimeProofArtifact?.proofLedger)) return runtimeProofArtifact.proofLedger;
  if (isRecord(runtimeProofArtifact?.proof_ledger)) return runtimeProofArtifact.proof_ledger;
  return null;
}

function firstLedgerRecord(ledger) {
  if (Array.isArray(ledger?.records)) {
    return ledger.records.find((record) => isRecord(record)) ?? null;
  }
  if (isRecord(ledger?.record)) return ledger.record;
  return isRecord(ledger) ? ledger : null;
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function selectedVisualShot(capture, seq) {
  const samples = [capture?.first, capture?.second, ...(capture?.samples ?? [])]
    .filter((sample) => isRecord(sample));
  return samples.find((sample) => Number(sample.seq) === Number(seq))
    ?? capture?.second
    ?? capture?.first
    ?? null;
}

function firstFiniteNumber(...values) {
  for (const value of values) {
    const numeric = Number(value);
    if (Number.isFinite(numeric)) return numeric;
  }
  return null;
}

function visualLedgerArtifactsFromDelta({
  visualDelta,
  beforeShot,
  afterShot,
  ledgerRecord,
  cameraStateHash = null,
}) {
  const selected = selectedVisualShot(afterShot, visualDelta?.selectedSeq);
  const baseline = selectedVisualShot(beforeShot, visualDelta?.baselineSeq);
  const width = Number(selected?.width ?? baseline?.width ?? 0);
  const height = Number(selected?.height ?? baseline?.height ?? 0);
  const visiblePixelCount = Number(
    selected?.visiblePixels
    ?? afterShot?.second?.visiblePixels
    ?? afterShot?.first?.visiblePixels
    ?? 0,
  );
  const dispatchEvent = isRecord(ledgerRecord?.dispatch_event)
    ? ledgerRecord.dispatch_event
    : isRecord(ledgerRecord?.dispatchEvent)
      ? ledgerRecord.dispatchEvent
      : {};
  const epochPublishEvent = isRecord(ledgerRecord?.epoch_publish_event)
    ? ledgerRecord.epoch_publish_event
    : isRecord(ledgerRecord?.epochPublishEvent)
      ? ledgerRecord.epochPublishEvent
      : {};
  const outputEvent = isRecord(ledgerRecord?.output_event)
    ? ledgerRecord.output_event
    : isRecord(ledgerRecord?.outputEvent)
      ? ledgerRecord.outputEvent
      : {};
  const artifactAfterHash = ledgerRecord?.artifact_after_hash ?? ledgerRecord?.artifactAfterHash;
  const dispatchEpoch = dispatchEvent.epoch ?? epochPublishEvent.epoch ?? null;
  const dispatchId = dispatchEvent.id ?? null;
  const artifactHash = dispatchEvent.artifact_hash
    ?? dispatchEvent.artifactHash
    ?? artifactAfterHash
    ?? null;
  const frameTimestampMs = firstFiniteNumber(
    visualDelta?.selectedTs,
    visualDelta?.selected_ts,
    selected?.ts,
    selected?.meta?.ts,
    selected?.meta?.capture_manifest?.frame_ts_ms,
    selected?.meta?.captureManifest?.frameTsMs,
  );
  const frameGateRequiredTsMs = firstFiniteNumber(
    selected?.meta?.capture_manifest?.frame_gate?.required_ts_ms,
    selected?.meta?.capture_manifest?.required_ts_ms,
    selected?.meta?.captureManifest?.frameGate?.requiredTsMs,
    selected?.meta?.frame_gate?.required_ts_ms,
    selected?.meta?.frameGate?.requiredTsMs,
  );
  const ledgerTimestampAfterDispatch = firstFiniteNumber(
    outputEvent.timestamp_monotonic_ns,
    outputEvent.timestampMonotonicNs,
    outputEvent.timestamp_after_dispatch,
    outputEvent.timestampAfterDispatch,
    outputEvent.readback_timestamp,
    outputEvent.readbackTimestamp,
    outputEvent.output_timestamp,
    outputEvent.outputTimestamp,
  );
  const captureBackend = 'mcp_decoded_frame';
  return {
    before_image: visualDelta.visual_artifacts.before_image,
    beforeImage: visualDelta.visualArtifacts.beforeImage,
    before_image_hash: visualDelta.visual_artifacts.before_image_hash,
    beforeImageHash: visualDelta.visualArtifacts.beforeImageHash,
    before_image_hash_verified: true,
    beforeImageHashVerified: true,
    after_image: visualDelta.visual_artifacts.after_image,
    afterImage: visualDelta.visualArtifacts.afterImage,
    after_image_hash: visualDelta.visual_artifacts.after_image_hash,
    afterImageHash: visualDelta.visualArtifacts.afterImageHash,
    after_image_hash_verified: true,
    afterImageHashVerified: true,
    diff_image: visualDelta.visual_artifacts.diff_image,
    diffImage: visualDelta.visualArtifacts.diffImage,
    diff_image_hash: visualDelta.visual_artifacts.diff_image_hash,
    diffImageHash: visualDelta.visualArtifacts.diffImageHash,
    artifact_cas_locators: visualDelta.artifact_cas_locators ?? visualDelta.visual_artifacts.artifact_cas_locators ?? [],
    artifactCasLocators: visualDelta.artifactCasLocators ?? visualDelta.visualArtifacts.artifactCasLocators ?? [],
    visual_artifact_transport_evidence:
      visualDelta.visual_artifact_transport_evidence
      ?? visualDelta.visual_artifacts.visual_artifact_transport_evidence
      ?? null,
    visualArtifactTransportEvidence:
      visualDelta.visualArtifactTransportEvidence
      ?? visualDelta.visualArtifacts.visualArtifactTransportEvidence
      ?? null,
    artifact_transport_authority: 'transport_integrity_only_not_visual_or_ledger_proof',
    artifactTransportAuthority: 'transport_integrity_only_not_visual_or_ledger_proof',
    diff_image_hash_verified: true,
    diffImageHashVerified: true,
    blank_frame_rejection: visiblePixelCount > 0,
    blankFrameRejection: visiblePixelCount > 0,
    same_frame_rejection: Number(visualDelta.baselineSeq) !== Number(visualDelta.selectedSeq),
    sameFrameRejection: Number(visualDelta.baselineSeq) !== Number(visualDelta.selectedSeq),
    new_epoch_watermark_or_trace:
      `epoch=${dispatchEpoch ?? 'unknown'} dispatch=${dispatchId ?? 'unknown'} artifact=${artifactHash ?? 'unknown'}`,
    newEpochWatermarkOrTrace:
      `epoch=${dispatchEpoch ?? 'unknown'} dispatch=${dispatchId ?? 'unknown'} artifact=${artifactHash ?? 'unknown'}`,
    camera_state_hash: cameraStateHash,
    cameraStateHash: cameraStateHash,
    swapchain_size: [width, height],
    swapchainSize: [width, height],
    capture_backend: captureBackend,
    captureBackend,
    frame_number: Number(visualDelta.selectedSeq ?? selected?.seq ?? 0),
    frameNumber: Number(visualDelta.selectedSeq ?? selected?.seq ?? 0),
    timestamp_after_dispatch: ledgerTimestampAfterDispatch ?? frameTimestampMs ?? 0,
    timestampAfterDispatch: ledgerTimestampAfterDispatch ?? frameTimestampMs ?? 0,
    timestamp_after_dispatch_clock: ledgerTimestampAfterDispatch !== null
      ? 'ledger_output_event_monotonic_ns'
      : 'frame_wall_clock_ms_fallback',
    timestampAfterDispatchClock: ledgerTimestampAfterDispatch !== null
      ? 'ledger_output_event_monotonic_ns'
      : 'frame_wall_clock_ms_fallback',
    selected_frame_timestamp_ms: frameTimestampMs,
    selectedFrameTimestampMs: frameTimestampMs,
    frame_gate_required_ts_ms: frameGateRequiredTsMs,
    frameGateRequiredTsMs: frameGateRequiredTsMs,
    perceptual_diff: Number(visualDelta.meanAbs ?? 0),
    perceptualDiff: Number(visualDelta.meanAbs ?? 0),
    changed_pixel_ratio: Number(visualDelta.changedRatio ?? 0),
    changedPixelRatio: Number(visualDelta.changedRatio ?? 0),
    visible_pixel_count: visiblePixelCount,
    visiblePixelCount,
    pixel_metrics_verified: true,
    pixelMetricsVerified: true,
    verification: {
      producer: 'mcp_visual_delta',
      metrics_verified: true,
      before_image_hash_verified: true,
      after_image_hash_verified: true,
      diff_image_hash_verified: true,
      control_changed_pixel_ratio: Number(visualDelta.controlChangedRatio ?? 0),
      control_mean_abs_delta8bit: Number(visualDelta.controlMeanAbs ?? 0),
      selected_frame_capture_after_epoch_dispatch:
        visualDelta.selected_frame_capture_after_epoch_dispatch === true,
    },
  };
}

function semanticProbeRegion(rawProbe) {
  const raw = rawProbe?.region ?? rawProbe?.roi ?? rawProbe?.bounds ?? rawProbe?.region_bounds;
  if (Array.isArray(raw) && raw.length >= 4) {
    const [x, y, width, height] = raw.map((value) => Number(value));
    return [x, y, width, height].every(Number.isFinite) && width > 0 && height > 0
      ? { x: Math.floor(x), y: Math.floor(y), width: Math.floor(width), height: Math.floor(height) }
      : null;
  }
  if (isRecord(raw)) {
    const x = Number(raw.x);
    const y = Number(raw.y);
    const width = Number(raw.width);
    const height = Number(raw.height);
    return [x, y, width, height].every(Number.isFinite) && width > 0 && height > 0
      ? { x: Math.floor(x), y: Math.floor(y), width: Math.floor(width), height: Math.floor(height) }
      : null;
  }
  return null;
}

function normalizeSemanticProbeClassToken(value) {
  const text = String(value ?? '').trim().toLowerCase().replace(/[\s-]+/g, '_');
  if (!text) return null;
  if ([
    'material_response',
    'lighting_response',
    'geometry_response',
    'color_response',
    'temporal_stability',
  ].includes(text)) {
    return text;
  }
  if (/(material|specular|reflection|reflectance|refraction|roughness|metal|glass|gem|diamond|surface|sparkle|glint|highlight|faceted|facet)/.test(text)) {
    return 'material_response';
  }
  if (/(light|lighting|illumination|shadow|caustic|emissive|exposure|direct_lighting|bounce|contrast|key_light|rim_light|area_light)/.test(text)) {
    return 'lighting_response';
  }
  if (/(geometry|silhouette|edge|normal|depth|parallax|occlusion)/.test(text)) {
    return 'geometry_response';
  }
  if (/(color|tone|albedo|hue|temperature|white_balance)/.test(text)) {
    return 'color_response';
  }
  if (/(temporal|stability|convergence|accumulation)/.test(text)) {
    return 'temporal_stability';
  }
  return null;
}

function semanticProbeClassFromDeclaration(rawProbe, index) {
  const explicit = normalizeSemanticProbeClassToken(
    rawProbe?.probeClass
      ?? rawProbe?.probe_class
      ?? rawProbe?.semanticClass
      ?? rawProbe?.semantic_class
      ?? rawProbe?.kind
      ?? rawProbe?.type,
  );
  if (explicit) return explicit;
  const inferred = normalizeSemanticProbeClassToken([
    rawProbe?.id,
    rawProbe?.probeId,
    rawProbe?.probe_id,
    rawProbe?.expected,
    rawProbe?.description,
  ].map((value) => String(value ?? '').toLowerCase()).join(' '));
  return inferred ?? (index === 0 ? 'material_response' : null);
}

function resolveVisualArtifactPath(filePath) {
  if (!filePath) return null;
  return path.isAbsolute(filePath) ? filePath : path.resolve(process.cwd(), filePath);
}

async function loadRgbaImage(filePath) {
  const resolved = resolveVisualArtifactPath(filePath);
  if (!resolved) return null;
  const { data, info } = await sharp(resolved)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height, channels: info.channels };
}

function clampProbeRegion(region, image) {
  if (!region || !image?.width || !image?.height) return null;
  const x = Math.max(0, Math.min(image.width - 1, region.x));
  const y = Math.max(0, Math.min(image.height - 1, region.y));
  const width = Math.max(1, Math.min(image.width - x, region.width));
  const height = Math.max(1, Math.min(image.height - y, region.height));
  return { x, y, width, height };
}

function semanticRegionBuffer(image, region) {
  const channels = image.channels ?? 4;
  const bytes = Buffer.alloc(region.width * region.height * channels);
  let offset = 0;
  for (let row = 0; row < region.height; row += 1) {
    const start = ((region.y + row) * image.width + region.x) * channels;
    const end = start + region.width * channels;
    image.data.copy(bytes, offset, start, end);
    offset += region.width * channels;
  }
  return bytes;
}

function semanticRegionMetrics(before, after, region) {
  const channels = before.channels ?? 4;
  let changedPixels = 0;
  let meanAbsSum = 0;
  for (let row = 0; row < region.height; row += 1) {
    for (let col = 0; col < region.width; col += 1) {
      const index = ((region.y + row) * before.width + region.x + col) * channels;
      let pixelAbs = 0;
      for (let channel = 0; channel < Math.min(3, channels); channel += 1) {
        pixelAbs += Math.abs(Number(after.data[index + channel]) - Number(before.data[index + channel]));
      }
      if (pixelAbs > 0) changedPixels += 1;
      meanAbsSum += pixelAbs / 3;
    }
  }
  const totalPixels = region.width * region.height;
  return {
    changedPixelRatio: totalPixels > 0 ? changedPixels / totalPixels : 0,
    changed_pixel_ratio: totalPixels > 0 ? changedPixels / totalPixels : 0,
    meanAbsDelta: totalPixels > 0 ? meanAbsSum / totalPixels : 0,
    mean_abs_delta: totalPixels > 0 ? meanAbsSum / totalPixels : 0,
  };
}

function compactSemanticObject(value) {
  return Object.fromEntries(Object.entries(value).filter(([, item]) =>
    item !== undefined
    && item !== null
    && !(Array.isArray(item) && item.length === 0)
  ));
}

function semanticProbeBindingPayload({
  beforeImageHash,
  afterImageHash,
  diffImageHash,
  visualSceneManifestHash,
  deterministicVisualModeHash,
  probes,
}) {
  return compactSemanticObject({
    schemaVersion: VISUAL_SEMANTIC_PROBE_SCHEMA_VERSION,
    schema_version: VISUAL_SEMANTIC_PROBE_SCHEMA_VERSION,
    proofAuthority: VISUAL_SEMANTIC_PROBE_AUTHORITY,
    proof_authority: VISUAL_SEMANTIC_PROBE_AUTHORITY,
    beforeImageHash,
    before_image_hash: beforeImageHash,
    afterImageHash,
    after_image_hash: afterImageHash,
    diffImageHash,
    diff_image_hash: diffImageHash,
    visualSceneManifestHash,
    visual_scene_manifest_hash: visualSceneManifestHash,
    deterministicVisualModeHash,
    deterministic_visual_mode_hash: deterministicVisualModeHash,
    probes: probes.map((probe) => compactSemanticObject({
      probeId: probe.probeId,
      probe_id: probe.probe_id,
      probeClass: probe.probeClass,
      probe_class: probe.probe_class,
      source: probe.source,
      beforeRegionHash: probe.beforeRegionHash,
      before_region_hash: probe.before_region_hash,
      afterRegionHash: probe.afterRegionHash,
      after_region_hash: probe.after_region_hash,
      diffRegionHash: probe.diffRegionHash,
      diff_region_hash: probe.diff_region_hash,
      roiBindingHash: probe.roiBindingHash,
      roi_binding_hash: probe.roi_binding_hash,
      region: probe.region,
      changedPixelRatio: probe.changedPixelRatio,
      changed_pixel_ratio: probe.changed_pixel_ratio,
      meanAbsDelta: probe.meanAbsDelta,
      mean_abs_delta: probe.mean_abs_delta,
      evidenceRefs: probe.evidenceRefs,
      evidence_refs: probe.evidence_refs,
    })),
  });
}

async function semanticVisualProbeEvidenceFromDelta(visualDelta) {
  const sceneManifest = ACTIVE_AGENT_PROFILE?.visualSceneManifest
    ?? ACTIVE_AGENT_PROFILE?.visual_scene_manifest
    ?? null;
  const declaredProbes = Array.isArray(sceneManifest?.semanticProbes)
    ? sceneManifest.semanticProbes
    : Array.isArray(sceneManifest?.semantic_probes)
      ? sceneManifest.semantic_probes
      : [];
  if (declaredProbes.length === 0) return null;
  const visualArtifacts = visualDelta?.visualArtifacts ?? visualDelta?.visual_artifacts ?? {};
  const beforeImageHash = visualArtifacts.beforeImageHash ?? visualArtifacts.before_image_hash ?? null;
  const afterImageHash = visualArtifacts.afterImageHash ?? visualArtifacts.after_image_hash ?? null;
  const diffImageHash = visualArtifacts.diffImageHash ?? visualArtifacts.diff_image_hash ?? null;
  const visualSceneManifestHash =
    ACTIVE_AGENT_PROFILE?.visualSceneManifestHash
    ?? ACTIVE_AGENT_PROFILE?.visual_scene_manifest_hash
    ?? null;
  const deterministicVisualModeHash =
    ACTIVE_AGENT_PROFILE?.deterministicVisualModeHash
    ?? ACTIVE_AGENT_PROFILE?.deterministic_visual_mode_hash
    ?? null;
  if (!beforeImageHash || !afterImageHash || !diffImageHash || !visualSceneManifestHash) {
    return null;
  }
  const before = await loadRgbaImage(visualArtifacts.beforeImage ?? visualArtifacts.before_image);
  const after = await loadRgbaImage(visualArtifacts.afterImage ?? visualArtifacts.after_image);
  const diff = await loadRgbaImage(visualArtifacts.diffImage ?? visualArtifacts.diff_image);
  if (!before || !after || !diff) return null;
  const probes = [];
  for (const [index, rawProbe] of declaredProbes.entries()) {
    const declaredRegion = semanticProbeRegion(rawProbe);
    const region = clampProbeRegion(declaredRegion, before);
    const probeClass = semanticProbeClassFromDeclaration(rawProbe, index);
    if (!region || !probeClass) continue;
    const beforeRegionHash = `sha256:${sha256BufferHex(semanticRegionBuffer(before, region))}`;
    const afterRegionHash = `sha256:${sha256BufferHex(semanticRegionBuffer(after, region))}`;
    if (beforeRegionHash === afterRegionHash) continue;
    const diffRegionHash = `sha256:${sha256BufferHex(semanticRegionBuffer(diff, region))}`;
    const roiBindingHash = `sha256:${sha256Hex(stableJson({
      probeId: rawProbe?.id ?? rawProbe?.probeId ?? rawProbe?.probe_id ?? `semantic-probe:${index}`,
      probeClass,
      beforeRegionHash,
      afterRegionHash,
      diffRegionHash,
      region,
      beforeImageHash,
      afterImageHash,
      diffImageHash,
      visualSceneManifestHash,
      deterministicVisualModeHash,
    }))}`;
    const metrics = semanticRegionMetrics(before, after, region);
    if (!(metrics.changedPixelRatio > 0 && metrics.meanAbsDelta > 0)) continue;
    const probeId = String(rawProbe?.id ?? rawProbe?.probeId ?? rawProbe?.probe_id ?? `semantic-probe:${index}`);
    const evidenceRefs = [...new Set([
      beforeImageHash,
      afterImageHash,
      diffImageHash,
      visualSceneManifestHash,
      deterministicVisualModeHash,
      ACTIVE_AGENT_PROFILE?.visualSceneManifestEvidenceRef
        ?? ACTIVE_AGENT_PROFILE?.visual_scene_manifest_evidence_ref
        ?? null,
    ].filter(Boolean))];
    probes.push({
      probeId,
      probe_id: probeId,
      probeClass,
      probe_class: probeClass,
      source: 'deterministic_oracle_region',
      beforeRegionHash,
      before_region_hash: beforeRegionHash,
      afterRegionHash,
      after_region_hash: afterRegionHash,
      diffRegionHash,
      diff_region_hash: diffRegionHash,
      roiBindingHash,
      roi_binding_hash: roiBindingHash,
      region,
      changedPixelRatio: metrics.changedPixelRatio,
      changed_pixel_ratio: metrics.changedPixelRatio,
      meanAbsDelta: metrics.meanAbsDelta,
      mean_abs_delta: metrics.meanAbsDelta,
      evidenceRefs,
      evidence_refs: evidenceRefs,
      accepted: true,
    });
  }
  const hasMaterial = probes.some((probe) => probe.probeClass === 'material_response');
  const hasLighting = probes.some((probe) => probe.probeClass === 'lighting_response');
  if (!hasMaterial || !hasLighting) return null;
  const bindingPayload = semanticProbeBindingPayload({
    beforeImageHash,
    afterImageHash,
    diffImageHash,
    visualSceneManifestHash,
    deterministicVisualModeHash,
    probes,
  });
  const bindingHash = `sha256:${sha256Hex(stableJson(bindingPayload))}`;
  const emittedProbes = bindingPayload.probes.map((probe) => ({
    ...probe,
    accepted: true,
    acceptedAsSemanticProbe: true,
    accepted_as_semantic_probe: true,
  }));
  const evidenceRefs = [...new Set([
    beforeImageHash,
    afterImageHash,
    diffImageHash,
    visualSceneManifestHash,
    deterministicVisualModeHash,
    ACTIVE_AGENT_PROFILE?.visualSceneManifestEvidenceRef
      ?? ACTIVE_AGENT_PROFILE?.visual_scene_manifest_evidence_ref
      ?? null,
    bindingHash,
    ...probes.flatMap((probe) => probe.evidenceRefs),
  ].filter(Boolean))];
  return {
    ...bindingPayload,
    probes: emittedProbes,
    accepted: true,
    acceptedAsSemanticVisualProbeEvidence: true,
    accepted_as_semantic_visual_probe_evidence: true,
    acceptedForGpuHmr: false,
    accepted_for_gpu_hmr: false,
    gpuHmrSuccess: false,
    gpu_hmr_success: false,
    canSatisfyRuntimeProof: false,
    can_satisfy_runtime_proof: false,
    canSatisfyDispatchProof: false,
    can_satisfy_dispatch_proof: false,
    materialProbeAccepted: true,
    material_probe_accepted: true,
    lightingProbeAccepted: true,
    lighting_probe_accepted: true,
    bindingHash,
    binding_hash: bindingHash,
    evidenceRefs,
    evidence_refs: evidenceRefs,
  };
}

function withoutSuppliedLedgerIdentity(record) {
  if (!isRecord(record)) return record;
  const copy = { ...record };
  delete copy.proofId;
  delete copy.proof_id;
  return copy;
}

function ledgerEvidenceRefs(records) {
  const refs = [];
  for (const record of Array.isArray(records) ? records : []) {
    if (!isRecord(record)) continue;
    for (const value of [record.evidence_refs, record.evidenceRefs]) {
      if (Array.isArray(value)) refs.push(...value);
    }
  }
  return [...new Set(refs
    .map((value) => String(value ?? '').trim())
    .filter(Boolean))]
    .slice(0, 32);
}

function traceEventEvidenceRefs(event, fallbackRefs = []) {
  return [...new Set([
    ...(Array.isArray(event?.evidence_refs) ? event.evidence_refs : []),
    ...(Array.isArray(event?.evidenceRefs) ? event.evidenceRefs : []),
    ...(Array.isArray(fallbackRefs) ? fallbackRefs : []),
  ].map((value) => String(value ?? '').trim()).filter(Boolean))];
}

function runtimeTraceFromLedgerRecord(record) {
  if (!isRecord(record)) return null;
  const loaderEvent = isRecord(record.loader_event)
    ? record.loader_event
    : isRecord(record.loaderEvent)
      ? record.loaderEvent
      : {};
  const dispatchEvent = isRecord(record.dispatch_event)
    ? record.dispatch_event
    : isRecord(record.dispatchEvent)
      ? record.dispatchEvent
      : {};
  const outputEvent = isRecord(record.output_event)
    ? record.output_event
    : isRecord(record.outputEvent)
      ? record.outputEvent
      : {};
  const baseEvidenceRefs = ledgerEvidenceRefs([record]);
  const loaderEvidenceRefs = traceEventEvidenceRefs(loaderEvent, baseEvidenceRefs);
  const dispatchEvidenceRefs = traceEventEvidenceRefs(dispatchEvent, baseEvidenceRefs);
  const outputEvidenceRefs = traceEventEvidenceRefs(outputEvent, baseEvidenceRefs);
  const loaderTraceEvent = {
    source: loaderEvent.loader_api ?? loaderEvent.loaderApi ?? 'runtime_loader_event',
    loaderApi: loaderEvent.loader_api ?? loaderEvent.loaderApi ?? null,
    loader_api: loaderEvent.loader_api ?? loaderEvent.loaderApi ?? null,
    artifactHash: loaderEvent.artifact_hash ?? loaderEvent.artifactHash ?? null,
    artifact_hash: loaderEvent.artifact_hash ?? loaderEvent.artifactHash ?? null,
    epoch: loaderEvent.epoch ?? record.epoch ?? null,
    processId: loaderEvent.process_id ?? loaderEvent.processId ?? null,
    process_id: loaderEvent.process_id ?? loaderEvent.processId ?? null,
    evidenceRefs: loaderEvidenceRefs,
    evidence_refs: loaderEvidenceRefs,
  };
  const dispatchTraceEvent = {
    command: dispatchEvent.launch_api ?? dispatchEvent.launchApi ?? 'hipModuleLaunchKernel',
    dispatchId: dispatchEvent.dispatch_id ?? dispatchEvent.dispatchId ?? dispatchEvent.id ?? null,
    dispatch_id: dispatchEvent.dispatch_id ?? dispatchEvent.dispatchId ?? dispatchEvent.id ?? null,
    epoch: dispatchEvent.epoch ?? null,
    artifactHash: dispatchEvent.artifact_hash ?? dispatchEvent.artifactHash ?? null,
    artifact_hash: dispatchEvent.artifact_hash ?? dispatchEvent.artifactHash ?? null,
    outputTargetId: dispatchEvent.output_target_id ?? dispatchEvent.outputTargetId ?? null,
    output_target_id: dispatchEvent.output_target_id ?? dispatchEvent.outputTargetId ?? null,
    processId: dispatchEvent.process_id ?? dispatchEvent.processId ?? null,
    process_id: dispatchEvent.process_id ?? dispatchEvent.processId ?? null,
    evidenceRefs: dispatchEvidenceRefs,
    evidence_refs: dispatchEvidenceRefs,
  };
  const outputTraceEvent = {
    kind: outputEvent.kind ?? 'visual_frame',
    afterDispatchId:
      outputEvent.after_dispatch_id
      ?? outputEvent.afterDispatchId
      ?? dispatchTraceEvent.dispatchId,
    after_dispatch_id:
      outputEvent.after_dispatch_id
      ?? outputEvent.afterDispatchId
      ?? dispatchTraceEvent.dispatch_id,
    epoch: outputEvent.epoch ?? null,
    artifactHash: outputEvent.artifact_hash ?? outputEvent.artifactHash ?? null,
    artifact_hash: outputEvent.artifact_hash ?? outputEvent.artifactHash ?? null,
    outputTargetId: outputEvent.output_target_id ?? outputEvent.outputTargetId ?? null,
    output_target_id: outputEvent.output_target_id ?? outputEvent.outputTargetId ?? null,
    processId: outputEvent.process_id ?? outputEvent.processId ?? null,
    process_id: outputEvent.process_id ?? outputEvent.processId ?? null,
    evidenceRefs: outputEvidenceRefs,
    evidence_refs: outputEvidenceRefs,
  };
  return {
    schemaVersion: 'synthi.gpu_hmr.runtime_trace.v1',
    schema_version: 'synthi.gpu_hmr.runtime_trace.v1',
    proofAuthority: 'runner_observed_wait_hmr_runtime_boundaries',
    proof_authority: 'runner_observed_wait_hmr_runtime_boundaries',
    acceptedForGpuHmr: false,
    accepted_for_gpu_hmr: false,
    gpuHmrSuccess: false,
    gpu_hmr_success: false,
    loaderEvents: [loaderTraceEvent],
    loader_events: [loaderTraceEvent],
    dispatchEvents: [dispatchTraceEvent],
    dispatch_events: [dispatchTraceEvent],
    outputEvents: [outputTraceEvent],
    output_events: [outputTraceEvent],
    evidenceRefs: [...new Set([
      ...loaderEvidenceRefs,
      ...dispatchEvidenceRefs,
      ...outputEvidenceRefs,
    ])],
    evidence_refs: [...new Set([
      ...loaderEvidenceRefs,
      ...dispatchEvidenceRefs,
      ...outputEvidenceRefs,
    ])],
  };
}

function declaredDeterministicVisualModeEvidence(profile = ACTIVE_AGENT_PROFILE) {
  const mode = profile?.deterministicVisualMode ?? profile?.deterministic_visual_mode;
  if (!isRecord(mode) || Object.keys(mode).length === 0) return null;
  const declaredMode = cloneJson(mode);
  const declaredModeHash = `sha256:${sha256Hex(stableJson(declaredMode))}`;
  const evidenceRefs = [...new Set([
    profile?.profileId ?? profile?.profile_id,
    profile?.profileHash ?? profile?.profile_hash,
    profile?.deterministicVisualModeHash ?? profile?.deterministic_visual_mode_hash,
  ].map((value) => String(value ?? '').trim()).filter(Boolean))];
  const facetCore = {
    schemaVersion: 'synthi.gpu_hmr.declared_deterministic_visual_mode.v1',
    schema_version: 'synthi.gpu_hmr.declared_deterministic_visual_mode.v1',
    proofAuthority: 'profile_declaration_only_not_runtime_visual_proof',
    proof_authority: 'profile_declaration_only_not_runtime_visual_proof',
    profileId: profile?.profileId ?? profile?.profile_id ?? null,
    profile_id: profile?.profile_id ?? profile?.profileId ?? null,
    declaredMode,
    declared_mode: declaredMode,
    declaredModeHash,
    declared_mode_hash: declaredModeHash,
    evidenceRefs,
    evidence_refs: evidenceRefs,
    acceptedForGpuHmr: false,
    accepted_for_gpu_hmr: false,
    gpuHmrSuccess: false,
    gpu_hmr_success: false,
    canSatisfyRuntimeProof: false,
    can_satisfy_runtime_proof: false,
    canSatisfyVisualProof: false,
    can_satisfy_visual_proof: false,
  };
  const facetHash = `sha256:${sha256Hex(stableJson(facetCore))}`;
  return {
    ...facetCore,
    facetHash,
    facet_hash: facetHash,
  };
}

function withRunModeVisualLedgerProof({
  proof,
  visualDelta,
  beforeShot,
  afterShot,
  wait,
}) {
  const ledger = embeddedLedgerFromProof(proof);
  const runtimeProofArtifact = isRecord(proof?.runtimeProofArtifact)
    ? proof.runtimeProofArtifact
    : isRecord(proof?.runtime_proof_artifact)
      ? proof.runtime_proof_artifact
      : null;
  if (!ledger || !runtimeProofArtifact) return proof;

  const proofClone = cloneJson(proof);
  const ledgerClone = cloneJson(ledger);
  const runtimeProofClone = cloneJson(runtimeProofArtifact);
  const records = Array.isArray(ledgerClone.records)
    ? ledgerClone.records
    : [ledgerClone.record ?? ledgerClone];
  const visualSceneManifestHash =
    ACTIVE_AGENT_PROFILE?.visualSceneManifestHash
    ?? ACTIVE_AGENT_PROFILE?.visual_scene_manifest_hash
    ?? null;
  const visualSceneManifestEvidenceRef =
    ACTIVE_AGENT_PROFILE?.visualSceneManifestEvidenceRef
    ?? ACTIVE_AGENT_PROFILE?.visual_scene_manifest_evidence_ref
    ?? null;
  const visualSceneManifest =
    ACTIVE_AGENT_PROFILE?.visualSceneManifest
    ?? ACTIVE_AGENT_PROFILE?.visual_scene_manifest
    ?? null;
  const declaredDeterministicVisualMode = declaredDeterministicVisualModeEvidence();
  const enrichedRecords = records.map((record) => {
    if (!isRecord(record)) return record;
    const outputEvent = isRecord(record.output_event)
      ? record.output_event
      : isRecord(record.outputEvent)
        ? record.outputEvent
        : {};
    const baselineShot = baselineVisualShotForMode(beforeShot, visualDelta);
    const selectedShot = selectedVisualShot(afterShot, visualDelta.selectedSeq);
    const deterministicVisualMode = deterministicVisualModeFromMcpEvidence({
      before: baselineShot,
      gateCapture: afterShot?.first ?? selectedShot,
      after: selectedShot,
      wait,
    });
    const authoritativeDeterministicVisualMode = {
      ...deterministicVisualMode,
      source: 'verified_mcp_capture_observations_only',
    };
    const visualArtifacts = visualLedgerArtifactsFromDelta({
      visualDelta,
      beforeShot,
      afterShot,
      ledgerRecord: record,
      cameraStateHash: authoritativeDeterministicVisualMode.camera_state_hash,
    });
    const declaredFacetEvidenceRefs = declaredDeterministicVisualMode?.evidenceRefs ?? [];
    const declaredFacetHash = declaredDeterministicVisualMode?.facetHash ?? null;
    const mergedEvidenceRefs = [...new Set([
      ...(Array.isArray(record.evidence_refs) ? record.evidence_refs : []),
      ...(Array.isArray(record.evidenceRefs) ? record.evidenceRefs : []),
      visualSceneManifestHash,
      visualSceneManifestEvidenceRef,
      declaredFacetHash,
      ...declaredFacetEvidenceRefs,
    ].map((value) => String(value ?? '').trim()).filter(Boolean))];
    return withoutSuppliedLedgerIdentity({
      ...record,
      evidence_refs: mergedEvidenceRefs,
      evidenceRefs: mergedEvidenceRefs,
      visual_scene_manifest: visualSceneManifest,
      visualSceneManifest,
      visual_scene_manifest_hash: visualSceneManifestHash,
      visualSceneManifestHash: visualSceneManifestHash,
      visual_scene_manifest_evidence_ref: visualSceneManifestEvidenceRef,
      visualSceneManifestEvidenceRef: visualSceneManifestEvidenceRef,
      declared_deterministic_visual_mode: declaredDeterministicVisualMode,
      declaredDeterministicVisualMode,
      oracle_artifacts: {
        ...(isRecord(record.oracle_artifacts) ? record.oracle_artifacts : {}),
        visual_oracle_artifacts: visualArtifacts,
        visual_scene_manifest: visualSceneManifest,
        visual_scene_manifest_hash: visualSceneManifestHash,
      },
      oracleArtifacts: {
        ...(isRecord(record.oracleArtifacts) ? record.oracleArtifacts : {}),
        visualOracleArtifacts: visualArtifacts,
        visualSceneManifest,
        visualSceneManifestHash: visualSceneManifestHash,
      },
      output_event: {
        ...outputEvent,
        visual_oracle_artifacts: visualArtifacts,
        visualOracleArtifacts: visualArtifacts,
      },
      outputEvent: {
        ...outputEvent,
        visual_oracle_artifacts: visualArtifacts,
        visualOracleArtifacts: visualArtifacts,
      },
      deterministic_visual_mode: authoritativeDeterministicVisualMode,
      deterministicVisualMode: authoritativeDeterministicVisualMode,
    });
  });
  const queryableLedger = {
    ...ledgerClone,
    records: enrichedRecords,
  };
  delete queryableLedger.proofId;
  delete queryableLedger.proof_id;
  delete queryableLedger.query;
  delete queryableLedger.gpuHmrSuccess;
  delete queryableLedger.gpu_hmr_success;
  const recomputed = queryGpuHmrLedgerInvariants(queryableLedger);
  const finalLedger = {
    ...queryableLedger,
    proofId: recomputed.proofId,
    proof_id: recomputed.proofId,
    query: recomputed,
    gpuHmrSuccess: recomputed.gpuHmrSuccess,
    gpu_hmr_success: recomputed.gpuHmrSuccess,
  };
  const finalLedgerRecord = firstLedgerRecord(finalLedger);
  const visualOracleArtifacts =
    finalLedgerRecord?.outputEvent?.visualOracleArtifacts
    ?? finalLedgerRecord?.output_event?.visual_oracle_artifacts
    ?? finalLedgerRecord?.oracleArtifacts?.visualOracleArtifacts
    ?? finalLedgerRecord?.oracle_artifacts?.visual_oracle_artifacts
    ?? null;
  const visualEvidenceArtifacts = visualEvidenceArtifactsFromVisualOracleArtifacts(
    visualOracleArtifacts,
    {
      proofLedgerQuery: recomputed,
      proofLedgerRecord: finalLedgerRecord,
      producerSubsystem: 'mcp.agent_split_source_first_visual_runtime',
    },
  );
  const deterministicVisualMode = enrichedRecords
    .map((record) => isRecord(record) ? record.deterministicVisualMode : null)
    .filter(Boolean)
    .at(-1);
  const deterministicVisualModeEvaluation = deterministicVisualMode
    ? evaluateGpuHmrDeterministicVisualMode(deterministicVisualMode)
    : null;
  const runtimeTrace = runtimeTraceFromLedgerRecord(finalLedgerRecord);
  const proofLedgerSourceConsistency = {
    accepted: true,
    mode: 'derived_only',
    source: 'agent_split_run_mode_visual_ledger_recomputed',
    proofLedgerId: recomputed.proofId,
    proof_ledger_id: recomputed.proofId,
    runtimeProofArtifactId: runtimeProofClone.proofId ?? runtimeProofClone.proof_id ?? null,
    runtime_proof_artifact_id: runtimeProofClone.proofId ?? runtimeProofClone.proof_id ?? null,
    evidenceRefs: ledgerEvidenceRefs(enrichedRecords),
    evidence_refs: ledgerEvidenceRefs(enrichedRecords),
    failures: [],
  };
  const finalRuntimeProofArtifact = {
    ...runtimeProofClone,
    proofLedger: finalLedger,
    proof_ledger: finalLedger,
    proofLedgerQuery: recomputed,
    proof_ledger_query: recomputed,
    proofLedgerSourceConsistency,
    proof_ledger_source_consistency: proofLedgerSourceConsistency,
    deterministicVisualMode,
    deterministic_visual_mode: deterministicVisualMode,
    deterministicVisualModeEvaluation,
    deterministic_visual_mode_evaluation: deterministicVisualModeEvaluation,
    declaredDeterministicVisualMode,
    declared_deterministic_visual_mode: declaredDeterministicVisualMode,
    runtimeTrace,
    runtime_trace: runtimeTrace,
    visualOracleArtifacts,
    visual_oracle_artifacts: visualOracleArtifacts,
    visualEvidenceArtifacts,
    visual_evidence_artifacts: visualEvidenceArtifacts,
    gpuHmrSuccess: recomputed.gpuHmrSuccess,
    gpu_hmr_success: recomputed.gpuHmrSuccess,
  };
  const gpuProofValidation = isRecord(proofClone.gpuProofValidation)
    ? { ...proofClone.gpuProofValidation, proofLedgerValidation: recomputed }
    : proofClone.gpuProofValidation;
  const gpuProofValidationSnake = isRecord(proofClone.gpu_proof_validation)
    ? { ...proofClone.gpu_proof_validation, proofLedgerValidation: recomputed }
    : proofClone.gpu_proof_validation;
  return {
    ...proofClone,
    acceptedForGpuHmr: recomputed.gpuHmrSuccess === true,
    accepted_for_gpu_hmr: recomputed.gpuHmrSuccess === true,
    gpuHmrSuccess: recomputed.gpuHmrSuccess === true,
    gpu_hmr_success: recomputed.gpuHmrSuccess === true,
    gpuHmrAcceptanceAuthority: 'recomputed_visual_runtime_proof_ledger',
    gpu_hmr_acceptance_authority: 'recomputed_visual_runtime_proof_ledger',
    gpuProofValidation,
    gpu_proof_validation: gpuProofValidationSnake,
    proofLedger: finalLedger,
    proof_ledger: finalLedger,
    runtimeProofArtifact: finalRuntimeProofArtifact,
    runtime_proof_artifact: finalRuntimeProofArtifact,
    runtimeTrace,
    runtime_trace: runtimeTrace,
    visualOracleArtifacts,
    visual_oracle_artifacts: visualOracleArtifacts,
    visualEvidenceArtifacts,
    visual_evidence_artifacts: visualEvidenceArtifacts,
    declaredDeterministicVisualMode,
    declared_deterministic_visual_mode: declaredDeterministicVisualMode,
  };
}

function baselineVisualShotForMode(beforeShot, visualDelta) {
  return selectedVisualShot(beforeShot, visualDelta?.baselineSeq);
}

function ledgerFirewallFieldsFromProof(proof) {
  const ledger = embeddedLedgerFromProof(proof);
  if (!ledger) {
    throw new Error('accepted run-mode proof requires embedded full proof ledger');
  }
  const recomputedLedger = queryGpuHmrLedgerInvariants(ledger);
  if (
    recomputedLedger.gpuHmrSuccess !== true ||
    !Array.isArray(recomputedLedger.failedInvariants) ||
    recomputedLedger.failedInvariants.length !== 0
  ) {
    const failures = Array.isArray(recomputedLedger.failedInvariants)
      ? recomputedLedger.failedInvariants.map((failure) => failure?.code ?? failure).join(',')
      : 'unknown';
    throw new Error(`accepted run-mode proof requires recomputed full-runtime proof ledger success: ${failures}`);
  }
  const record = firstLedgerRecord(ledger);
  const cpuHmrUsed = record?.cpuHmrUsed ?? record?.cpu_hmr_used;
  const fullRebuildUsed = record?.fullRebuildUsed ?? record?.full_rebuild_used;
  const processRestarted = record?.processRestarted ?? record?.process_restarted;
  if (cpuHmrUsed !== false || fullRebuildUsed !== false || processRestarted !== false) {
    throw new Error('accepted run-mode proof ledger firewall fields must all be explicitly false');
  }
  const proofValidation = proof?.gpuProofValidation ?? proof?.gpu_proof_validation;
  const ledgerValidation = proofValidation?.proofLedgerValidation;
  const failedInvariants = Array.isArray(ledgerValidation?.failedInvariants)
    ? ledgerValidation.failedInvariants
    : null;
  const ledgerAccepted =
    proofValidation?.satisfied === true &&
    ledgerValidation?.gpuHmrSuccess === true &&
    failedInvariants !== null &&
    failedInvariants.length === 0;
  if (!ledgerAccepted) {
    throw new Error('accepted run-mode proof requires full-runtime proof ledger validation with no failed invariants');
  }
  return {
    cpuHmrUsed: false,
    cpu_hmr_used: false,
    fullRebuildUsed: false,
    full_rebuild_used: false,
    processRestarted: false,
    process_restarted: false,
    firewallEvidenceSource: 'recomputed_proof_ledger_invariant_query',
    firewall_evidence_source: 'recomputed_proof_ledger_invariant_query',
    firewallProofLedgerId: recomputedLedger.proofId ?? ledgerValidation.proofId ?? null,
    firewall_proof_ledger_id: recomputedLedger.proofId ?? ledgerValidation.proofId ?? null,
  };
}

async function writeRunModeProofArtifact(name, proof) {
  let seed = {
    schemaVersion: 'synthi.gpu.hmr.agent_split_run_mode_proof.v1',
    ...proof,
  };
  if (seed.runModeCoverageSupport || seed.run_mode_coverage_support) {
    const boundSupport = bindGpuHmrRunModeCoverageSupport(
      seed.runModeCoverageSupport ?? seed.run_mode_coverage_support,
      { runMode: seed.runMode ?? seed.run_mode },
    );
    seed.runModeCoverageSupport = boundSupport;
    seed.run_mode_coverage_support = boundSupport;
  }
  const claimsRuntimeSuccess =
    seed.acceptedForGpuHmr === true ||
    seed.accepted_for_gpu_hmr === true ||
    seed.gpuHmrSuccess === true ||
    seed.gpu_hmr_success === true;
  if (claimsRuntimeSuccess) {
    seed = {
      ...seed,
      ...ledgerFirewallFieldsFromProof(seed),
    };
  }
  const withProofId = {
    ...seed,
    proofId: runModeProofId(seed),
  };
  return writeJsonArtifact(name, withProofId);
}

function coldAiSplitProofFromSeed(coldSplitProofSeed) {
  if (!coldSplitProofSeed) {
    throw new Error('cold AI split proof requires captured visual output artifacts');
  }
  const providerCallEvidence =
    coldSplitProofSeed.coldAiProviderCallEvidence
    ?? coldSplitProofSeed.cold_ai_provider_call_evidence;
  if (providerCallEvidence?.acceptedAsColdAiProviderCallEvidence !== true) {
    throw new Error('cold AI split proof requires an observed AI provider call');
  }
  const visualArtifacts =
    coldSplitProofSeed.visualArtifacts
    ?? coldSplitProofSeed.visual_artifacts;
  const visualMetrics =
    coldSplitProofSeed.visualMetrics
    ?? coldSplitProofSeed.visual_metrics;
  const visualSample =
    coldSplitProofSeed.coldSingleFrameVisual
    ?? coldSplitProofSeed.cold_single_frame_visual;
  const transport =
    visualArtifacts?.visualArtifactTransportEvidence
    ?? visualArtifacts?.visual_artifact_transport_evidence;
  const locators =
    visualArtifacts?.artifactCasLocators
    ?? visualArtifacts?.artifact_cas_locators;
  const afterImageHash =
    visualArtifacts?.afterImageHash
    ?? visualArtifacts?.after_image_hash;
  const locatorBoundToFrame = Array.isArray(locators)
    && locators.some((locator) =>
      (locator?.contentHash ?? locator?.content_hash) === afterImageHash
      && locator?.role === 'after_frame'
      && locator?.mediaType === 'image/png'
    );
  const transportBoundToFrame = Array.isArray(transport?.entries)
    && transport.entries.some((entry) => entry?.contentHash === afterImageHash);
  const visiblePixelCount = Number(
    visualMetrics?.visiblePixelCount
    ?? visualMetrics?.visible_pixel_count
    ?? visualSample?.visiblePixels
    ?? 0,
  );
  const visualBlockingGaps = [
    coldSplitProofSeed.coldSplitProven === true
      || coldSplitProofSeed.cold_split_proven === true
      ? null
      : 'cold_ai_split_not_proven',
    /^sha256:[a-f0-9]{64}$/.test(String(afterImageHash ?? ''))
      ? null
      : 'cold_ai_split_visual_hash_missing',
    Array.isArray(locators) && locators.length > 0
      ? null
      : 'cold_ai_split_visual_cas_locator_missing',
    locatorBoundToFrame && transportBoundToFrame
      ? null
      : 'cold_ai_split_visual_cas_binding_mismatch',
    transport?.accepted === true && transport?.acceptedAsTransportEvidence === true
      ? null
      : 'cold_ai_split_visual_transport_unproven',
    Number(visualSample?.width) >= 320
      && Number(visualSample?.height) >= 240
      && Number(visualSample?.bytes) > 512
      && visiblePixelCount > 500
      ? null
      : 'cold_ai_split_visual_frame_blank_or_invalid',
  ].filter(Boolean);
  if (visualBlockingGaps.length > 0) {
    throw new Error(`cold AI split visual proof rejected: ${visualBlockingGaps.join('|')}`);
  }
  return {
    ...coldSplitProofSeed,
    proofAuthority: 'cold_ai_split_visual_output_only_not_gpu_hmr_acceptance',
    proof_authority: 'cold_ai_split_visual_output_only_not_gpu_hmr_acceptance',
    acceptedAsColdAiSplitEvidence: true,
    accepted_as_cold_ai_split_evidence: true,
    acceptedForGpuHmr: false,
    accepted_for_gpu_hmr: false,
    gpuHmrSuccess: false,
    gpu_hmr_success: false,
    canSatisfyRuntimeProof: false,
    can_satisfy_runtime_proof: false,
    canSatisfyDispatchProof: false,
    can_satisfy_dispatch_proof: false,
  };
}

const PROVIDER_CALL_REQUEST_SCHEMA_VERSION = 'synthi.ai.provider_call_request.v2';
const PROVIDER_CALL_RECEIPT_SCHEMA_VERSION = 'synthi.ai.provider_call_receipt.v1';
const PROVIDER_CALL_CHALLENGE_SCHEMA_VERSION = 'synthi.ai.provider_call_challenge.v1';
const PROVIDER_CALL_RECEIPT_AUTHORITY =
  'request_bound_provider_call_only_not_gpu_hmr_success';

function orderedJsonHash(values) {
  return `sha256:${sha256Hex(JSON.stringify(values))}`;
}

function providerCallRequestHash(binding) {
  return orderedJsonHash([
    binding?.schema_version,
    binding?.nonce,
    binding?.mode,
    binding?.request_mode,
    binding?.language,
    binding?.focus,
    binding?.requested_provider,
    binding?.requested_model,
    binding?.gpu_arch,
    binding?.source_hash,
    binding?.file_manifest_hash,
    binding?.file_count,
    binding?.extra_instructions_hash,
  ]);
}

function providerCallReceiptHash(receipt) {
  return orderedJsonHash([
    PROVIDER_CALL_RECEIPT_SCHEMA_VERSION,
    PROVIDER_CALL_RECEIPT_AUTHORITY,
    receipt?.request_nonce,
    receipt?.request_hash,
    receipt?.response_hash,
    receipt?.challenge_hash,
    receipt?.provider,
    receipt?.requested_model,
    receipt?.actual_model,
    receipt?.request_mode,
    receipt?.provider_model_status,
    String(receipt?.fallback_model ?? ''),
    receipt?.fallback_used,
    String(receipt?.provider_model_alias_resolved_to ?? ''),
    receipt?.provider_shutdown_or_deprecation_detected,
    receipt?.model_availability_checked_at,
    receipt?.started_monotonic_ns,
    receipt?.completed_monotonic_ns,
    receipt?.started_unix_ns,
    receipt?.completed_unix_ns,
  ]);
}

function providerCallNormalizedPath(value) {
  let normalized = String(value ?? '').replace(/\\/g, '/').trim();
  while (normalized.startsWith('./')) normalized = normalized.slice(2);
  return normalized.replace(/^\/+/, '');
}

function providerCallFileManifestFromCompileArgs(initialCompileArgs) {
  const files = new Map();
  const primary = providerCallNormalizedPath(initialCompileArgs?.filename);
  if (primary) files.set(primary, String(initialCompileArgs?.source ?? ''));
  for (const file of initialCompileArgs?.files ?? []) {
    const name = providerCallNormalizedPath(file?.path ?? file?.name ?? file?.filename);
    if (name && typeof file?.content === 'string') files.set(name, file.content);
  }
  const entries = [...files.entries()]
    .sort(([left], [right]) => Buffer.compare(Buffer.from(left), Buffer.from(right)))
    .map(([name, content]) => [name, `sha256:${sha256Hex(content)}`]);
  return {
    count: entries.length,
    hash: orderedJsonHash(['synthi.ai.provider_call_file_manifest.v1', entries]),
  };
}

function validProviderCallInterval(receipt) {
  try {
    return BigInt(receipt?.completed_monotonic_ns) > BigInt(receipt?.started_monotonic_ns)
      && BigInt(receipt?.completed_unix_ns) >= BigInt(receipt?.started_unix_ns);
  } catch {
    return false;
  }
}

function supportEvidenceClaimsAuthority(value) {
  return [
    'accepted_for_gpu_hmr',
    'acceptedForGpuHmr',
    'gpu_hmr_success',
    'gpuHmrSuccess',
    'can_satisfy_runtime_proof',
    'canSatisfyRuntimeProof',
    'can_satisfy_dispatch_proof',
    'canSatisfyDispatchProof',
  ].some((key) => value?.[key] !== undefined && value?.[key] !== false);
}

function coldAiProviderCallEvidenceFromSplit(split, initialCompileArgs) {
  const provenance = split?.sidecar?.model_provenance;
  const receipt = split?.sidecar?.provider_call_receipt;
  const binding = receipt?.request_binding;
  const expectedFileManifest = providerCallFileManifestFromCompileArgs(initialCompileArgs);
  const expectedNonce = String(initialCompileArgs?.ai_provider_call_nonce ?? '');
  const expectedLanguage = String(initialCompileArgs?.language ?? '').trim();
  const expectedFocus = providerCallNormalizedPath(initialCompileArgs?.filename);
  const expectedGpuArch = String(initialCompileArgs?.gpu_arch ?? '').trim();
  const expectedProvider = String(initialCompileArgs?.ai_provider ?? '').trim().toLowerCase();
  const expectedModel = String(initialCompileArgs?.ai_model ?? '').trim();
  const expectedSourceHash = `sha256:${sha256Hex(initialCompileArgs?.source ?? '')}`;
  const providerCallUsed = provenance?.provider_call_used === true
    && receipt?.provider_call_used === true;
  const provider = String(receipt?.provider ?? '').trim().toLowerCase();
  const requestedModel = String(receipt?.requested_model ?? '').trim();
  const actualModel = String(receipt?.actual_model ?? '').trim();
  const providerStatus = String(receipt?.provider_model_status ?? '').trim().toLowerCase();
  const fallbackModel = String(receipt?.fallback_model ?? '').trim();
  const fallbackUsed = receipt?.fallback_used;
  const aliasResolvedTo = String(receipt?.provider_model_alias_resolved_to ?? '').trim();
  const shutdownOrDeprecationDetected = receipt?.provider_shutdown_or_deprecation_detected;
  const hardInfraFailure = receipt?.hard_infra_failure;
  const computedRequestHash = binding ? providerCallRequestHash(binding) : '';
  const computedReceiptHash = receipt ? providerCallReceiptHash(receipt) : '';
  const challenge = receipt?.challenge;
  const computedChallengeHash = challenge
    ? orderedJsonHash([
        PROVIDER_CALL_CHALLENGE_SCHEMA_VERSION,
        challenge?.request_nonce,
        challenge?.request_hash,
        challenge?.prompt_payload_hash,
      ])
    : '';
  const sha256Pattern = /^sha256:[a-f0-9]{64}$/;
  const allowedProviderStatuses = new Set(['available', 'deprecated', 'unknown', 'private_alias']);
  const blockingGaps = [
    receipt ? null : 'cold_ai_split_provider_receipt_missing',
    receipt?.schema_version === PROVIDER_CALL_RECEIPT_SCHEMA_VERSION
      ? null
      : 'cold_ai_split_provider_receipt_schema_invalid',
    receipt?.proof_authority === PROVIDER_CALL_RECEIPT_AUTHORITY
      ? null
      : 'cold_ai_split_provider_receipt_authority_invalid',
    receipt?.accepted === true ? null : 'cold_ai_split_provider_receipt_not_accepted',
    providerCallUsed ? null : 'cold_ai_split_provider_call_not_observed',
    binding?.schema_version === PROVIDER_CALL_REQUEST_SCHEMA_VERSION
      ? null
      : 'cold_ai_split_provider_request_schema_invalid',
    binding?.mode === 'split' && binding?.request_mode === 'split'
      ? null
      : 'cold_ai_split_provider_request_mode_binding_invalid',
    /^provider-call:[a-f0-9]{32}$/.test(String(binding?.nonce ?? ''))
      ? null
      : 'cold_ai_split_provider_request_nonce_invalid',
    expectedNonce && binding?.nonce === expectedNonce
      ? null
      : 'cold_ai_split_provider_request_nonce_not_caller_bound',
    receipt?.request_nonce === binding?.nonce
      ? null
      : 'cold_ai_split_provider_request_nonce_mismatch',
    binding?.language === expectedLanguage
      && binding?.focus === expectedFocus
      && binding?.gpu_arch === expectedGpuArch
      ? null
      : 'cold_ai_split_provider_request_context_mismatch',
    binding?.source_hash === expectedSourceHash
      ? null
      : 'cold_ai_split_provider_request_source_hash_mismatch',
    binding?.file_manifest_hash === expectedFileManifest.hash
      && binding?.file_count === expectedFileManifest.count
      ? null
      : 'cold_ai_split_provider_request_file_manifest_mismatch',
    expectedProvider
      && binding?.requested_provider === expectedProvider
      && provider === expectedProvider
      ? null
      : 'cold_ai_split_provider_request_provider_mismatch',
    expectedModel
      && requestedModel === expectedModel
      && binding?.requested_model === expectedModel
      ? null
      : 'cold_ai_split_provider_request_model_mismatch',
    sha256Pattern.test(String(binding?.source_hash ?? ''))
      && sha256Pattern.test(String(binding?.file_manifest_hash ?? ''))
      && sha256Pattern.test(String(binding?.extra_instructions_hash ?? ''))
      ? null
      : 'cold_ai_split_provider_request_hash_fields_invalid',
    receipt?.request_hash === computedRequestHash && sha256Pattern.test(computedRequestHash)
      ? null
      : 'cold_ai_split_provider_request_hash_mismatch',
    sha256Pattern.test(String(receipt?.response_hash ?? ''))
      ? null
      : 'cold_ai_split_provider_response_hash_invalid',
    challenge?.schema_version === PROVIDER_CALL_CHALLENGE_SCHEMA_VERSION
      && challenge?.request_nonce === binding?.nonce
      && challenge?.request_hash === computedRequestHash
      && sha256Pattern.test(String(challenge?.prompt_payload_hash ?? ''))
      && challenge?.challenge_hash === computedChallengeHash
      && receipt?.challenge_hash === computedChallengeHash
      ? null
      : 'cold_ai_split_provider_challenge_binding_mismatch',
    receipt?.challenge_echo_verified === true
      ? null
      : 'cold_ai_split_provider_challenge_echo_unproven',
    receipt?.receipt_hash === computedReceiptHash
      && receipt?.call_id === `provider-call:${computedReceiptHash}`
      ? null
      : 'cold_ai_split_provider_receipt_hash_mismatch',
    provider ? null : 'cold_ai_split_provider_identity_missing',
    requestedModel ? null : 'cold_ai_split_requested_model_missing',
    actualModel ? null : 'cold_ai_split_actual_model_missing',
    provider.toLowerCase() !== 'deterministic_static_splitter'
      ? null
      : 'cold_ai_split_deterministic_splitter_not_provider_call',
    allowedProviderStatuses.has(providerStatus)
      ? null
      : 'cold_ai_split_provider_model_status_invalid',
    typeof fallbackUsed === 'boolean'
      ? null
      : 'cold_ai_split_provider_fallback_state_missing',
    typeof shutdownOrDeprecationDetected === 'boolean'
      ? null
      : 'cold_ai_split_provider_lifecycle_state_missing',
    hardInfraFailure === false ? null : 'cold_ai_split_provider_hard_infra_failure',
    receipt?.request_mode === 'split' ? null : 'cold_ai_split_provider_request_mode_invalid',
    String(receipt?.model_availability_checked_at ?? '').trim()
      ? null
      : 'cold_ai_split_provider_availability_timestamp_missing',
    validProviderCallInterval(receipt) ? null : 'cold_ai_split_provider_interval_invalid',
    provenance?.provider === provider
      && provenance?.requested_model === requestedModel
      && provenance?.actual_model === actualModel
      && provenance?.request_mode === receipt?.request_mode
      && provenance?.provider_model_status === providerStatus
      && String(provenance?.fallback_model ?? '').trim() === fallbackModel
      && provenance?.fallback_used === fallbackUsed
      && String(provenance?.provider_model_alias_resolved_to ?? '').trim() === aliasResolvedTo
      && provenance?.provider_shutdown_or_deprecation_detected === shutdownOrDeprecationDetected
      && provenance?.model_availability_checked_at === receipt?.model_availability_checked_at
      && provenance?.hard_infra_failure === false
      ? null
      : 'cold_ai_split_provider_provenance_receipt_mismatch',
    receipt?.accepted_for_gpu_hmr === false
      && receipt?.gpu_hmr_success === false
      && receipt?.can_satisfy_runtime_proof === false
      && receipt?.can_satisfy_dispatch_proof === false
      && !supportEvidenceClaimsAuthority(receipt)
      && !supportEvidenceClaimsAuthority(provenance)
      ? null
      : 'cold_ai_split_provider_receipt_claims_gpu_authority',
  ].filter(Boolean);
  const accepted = blockingGaps.length === 0;
  const seed = {
    schemaVersion: 'synthi.gpu_hmr.cold_ai_provider_call.v1',
    proofAuthority: 'observed_ai_split_provider_call_only_not_gpu_hmr_success',
    requiredByCaller: true,
    providerCallUsed: providerCallUsed === true,
    provider,
    requestedProvider: String(binding?.requested_provider ?? '').trim().toLowerCase(),
    requestedModel,
    actualModel,
    providerModelStatus: providerStatus || null,
    fallbackModel: fallbackModel || null,
    fallbackUsed,
    providerModelAliasResolvedTo: aliasResolvedTo || null,
    providerShutdownOrDeprecationDetected: shutdownOrDeprecationDetected,
    hardInfraFailure: hardInfraFailure === true,
    providerCallId: receipt?.call_id ?? null,
    providerCallReceiptHash: receipt?.receipt_hash ?? null,
    providerCallRequestHash: receipt?.request_hash ?? null,
    providerCallResponseHash: receipt?.response_hash ?? null,
    providerCallChallengeHash: receipt?.challenge_hash ?? null,
    providerCallNonce: receipt?.request_nonce ?? null,
    blockingGaps,
  };
  const evidenceHash = `sha256:${sha256Hex(stableJson(seed))}`;
  return {
    ...seed,
    schema_version: seed.schemaVersion,
    proof_authority: seed.proofAuthority,
    required_by_caller: true,
    accepted,
    acceptedAsColdAiProviderCallEvidence: accepted,
    accepted_as_cold_ai_provider_call_evidence: accepted,
    provider_call_used: seed.providerCallUsed,
    requested_provider: seed.requestedProvider,
    requested_model: requestedModel,
    actual_model: actualModel,
    provider_model_status: seed.providerModelStatus,
    fallback_model: seed.fallbackModel,
    fallback_used: seed.fallbackUsed,
    provider_model_alias_resolved_to: seed.providerModelAliasResolvedTo,
    provider_shutdown_or_deprecation_detected: seed.providerShutdownOrDeprecationDetected,
    hard_infra_failure: seed.hardInfraFailure,
    provider_call_id: seed.providerCallId,
    provider_call_receipt_hash: seed.providerCallReceiptHash,
    provider_call_request_hash: seed.providerCallRequestHash,
    provider_call_response_hash: seed.providerCallResponseHash,
    provider_call_challenge_hash: seed.providerCallChallengeHash,
    provider_call_nonce: seed.providerCallNonce,
    blocking_gaps: blockingGaps,
    evidenceHash,
    evidence_hash: evidenceHash,
    evidenceRef: `cold-ai-provider-call:${evidenceHash}`,
    evidence_ref: `cold-ai-provider-call:${evidenceHash}`,
    acceptedForGpuHmr: false,
    accepted_for_gpu_hmr: false,
    gpuHmrSuccess: false,
    gpu_hmr_success: false,
    canSatisfyRuntimeProof: false,
    can_satisfy_runtime_proof: false,
    canSatisfyDispatchProof: false,
    can_satisfy_dispatch_proof: false,
  };
}

function selfCheckProviderCallReceipt(initialCompileArgs) {
  const fileManifest = providerCallFileManifestFromCompileArgs(initialCompileArgs);
  const binding = {
    schema_version: PROVIDER_CALL_REQUEST_SCHEMA_VERSION,
    nonce: initialCompileArgs.ai_provider_call_nonce,
    mode: 'split',
    request_mode: 'split',
    language: initialCompileArgs.language,
    focus: initialCompileArgs.filename,
    requested_provider: initialCompileArgs.ai_provider,
    requested_model: 'self-check-model',
    gpu_arch: initialCompileArgs.gpu_arch,
    source_hash: `sha256:${sha256Hex(initialCompileArgs.source)}`,
    file_manifest_hash: fileManifest.hash,
    file_count: fileManifest.count,
    extra_instructions_hash: `sha256:${'3'.repeat(64)}`,
  };
  const requestHash = providerCallRequestHash(binding);
  const challenge = {
    schema_version: PROVIDER_CALL_CHALLENGE_SCHEMA_VERSION,
    request_nonce: binding.nonce,
    request_hash: requestHash,
    prompt_payload_hash: `sha256:${'5'.repeat(64)}`,
  };
  challenge.challenge_hash = orderedJsonHash([
    challenge.schema_version,
    challenge.request_nonce,
    challenge.request_hash,
    challenge.prompt_payload_hash,
  ]);
  const receipt = {
    schema_version: PROVIDER_CALL_RECEIPT_SCHEMA_VERSION,
    proof_authority: PROVIDER_CALL_RECEIPT_AUTHORITY,
    accepted: true,
    provider_call_used: true,
    request_binding: binding,
    request_nonce: binding.nonce,
    request_hash: requestHash,
    response_hash: `sha256:${'4'.repeat(64)}`,
    challenge,
    challenge_hash: challenge.challenge_hash,
    challenge_echo_verified: true,
    provider: binding.requested_provider,
    requested_model: binding.requested_model,
    actual_model: 'self-check-model',
    request_mode: 'split',
    provider_model_status: 'available',
    fallback_model: null,
    fallback_used: false,
    provider_model_alias_resolved_to: null,
    provider_shutdown_or_deprecation_detected: false,
    model_availability_checked_at: '2026-07-15T00:00:00+00:00',
    hard_infra_failure: false,
    started_monotonic_ns: '100',
    completed_monotonic_ns: '200',
    started_unix_ns: '1700000000000000000',
    completed_unix_ns: '1700000000000000100',
    accepted_for_gpu_hmr: false,
    gpu_hmr_success: false,
    can_satisfy_runtime_proof: false,
    can_satisfy_dispatch_proof: false,
  };
  receipt.receipt_hash = providerCallReceiptHash(receipt);
  receipt.call_id = `provider-call:${receipt.receipt_hash}`;
  return receipt;
}

function selfCheckColdAiSplitProof() {
  const selfCheckSource = '__global__ void self_check(float* out) { out[0] = 1.0f; }';
  const selfCheckInitialCompileArgs = {
    language: 'cpp',
    filename: 'src/main.hip',
    source: selfCheckSource,
    files: [{ path: 'src/main.hip', name: 'src/main.hip', content: selfCheckSource }],
    gpu_arch: 'gfx1201',
    ai_provider_call_nonce: 'provider-call:0123456789abcdef0123456789abcdef',
    ai_provider: 'self_check_provider',
    ai_model: 'self-check-model',
  };
  const providerCallReceipt = selfCheckProviderCallReceipt(selfCheckInitialCompileArgs);
  const selfCheckSplit = {
    sidecar: {
      model_provenance: {
        provider_call_used: true,
        provider: 'self_check_provider',
        requested_model: 'self-check-model',
        actual_model: 'self-check-model',
        provider_model_status: 'available',
        fallback_model: null,
        fallback_used: false,
        provider_model_alias_resolved_to: null,
        provider_shutdown_or_deprecation_detected: false,
        request_mode: 'split',
        model_availability_checked_at: '2026-07-15T00:00:00+00:00',
        hard_infra_failure: false,
      },
      provider_call_receipt: providerCallReceipt,
    },
  };
  const providerEvidence = coldAiProviderCallEvidenceFromSplit(
    selfCheckSplit,
    selfCheckInitialCompileArgs,
  );
  const proof = coldAiSplitProofFromSeed({
    coldSplitProven: true,
    coldSingleFrameVisual: {
      width: 640,
      height: 480,
      bytes: 4096,
      visiblePixels: 1000,
    },
    visualArtifacts: {
      afterImageHash: `sha256:${'6'.repeat(64)}`,
      artifactCasLocators: [{
        schemaVersion: 'synthi.cas.artifact_locator.v1',
        contentHash: `sha256:${'6'.repeat(64)}`,
        role: 'after_frame',
        mediaType: 'image/png',
      }],
      visualArtifactTransportEvidence: {
        accepted: true,
        acceptedAsTransportEvidence: true,
        entries: [{ contentHash: `sha256:${'6'.repeat(64)}` }],
      },
    },
    visualMetrics: { visiblePixelCount: 1000 },
    coldAiProviderCallEvidence: providerEvidence,
  });
  let missingVisualRejected = false;
  try {
    coldAiSplitProofFromSeed(null);
  } catch (error) {
    missingVisualRejected = String(error?.message ?? '').includes('captured visual output');
  }
  let missingProviderRejected = false;
  try {
    coldAiSplitProofFromSeed({
      coldSplitProven: true,
      visualArtifacts: { beforeImage: 'cas:sha256:self-check' },
    });
  } catch (error) {
    missingProviderRejected = String(error?.message ?? '').includes('observed AI provider call');
  }
  let forgedVisualRejected = false;
  try {
    coldAiSplitProofFromSeed({
      coldSplitProven: true,
      coldSingleFrameVisual: {
        width: 640,
        height: 480,
        bytes: 4096,
        visiblePixels: 0,
      },
      visualArtifacts: {
        afterImageHash: `sha256:${'6'.repeat(64)}`,
        artifactCasLocators: [{
          schemaVersion: 'synthi.cas.artifact_locator.v1',
          contentHash: `sha256:${'6'.repeat(64)}`,
          role: 'after_frame',
          mediaType: 'image/png',
        }],
        visualArtifactTransportEvidence: {
          accepted: true,
          acceptedAsTransportEvidence: true,
          entries: [{ contentHash: `sha256:${'6'.repeat(64)}` }],
        },
      },
      visualMetrics: { visiblePixelCount: 0 },
      coldAiProviderCallEvidence: providerEvidence,
    });
  } catch (error) {
    forgedVisualRejected = String(error?.message ?? '').includes('blank_or_invalid');
  }
  const forgedReceiptEvidence = coldAiProviderCallEvidenceFromSplit({
    sidecar: {
      model_provenance: {
        provider_call_used: true,
        provider: 'self_check_provider',
        requested_model: 'self-check-model',
        actual_model: 'self-check-model',
        provider_model_status: 'available',
        request_mode: 'split',
        model_availability_checked_at: '2026-07-15T00:00:00+00:00',
        hard_infra_failure: false,
      },
      provider_call_receipt: {
        ...providerCallReceipt,
        response_hash: `sha256:${'9'.repeat(64)}`,
      },
    },
  }, selfCheckInitialCompileArgs);
  const forgedChallengeEvidence = coldAiProviderCallEvidenceFromSplit({
    sidecar: {
      model_provenance: selfCheckSplit.sidecar.model_provenance,
      provider_call_receipt: {
        ...providerCallReceipt,
        challenge: {
          ...providerCallReceipt.challenge,
          prompt_payload_hash: `sha256:${'8'.repeat(64)}`,
        },
      },
    },
  }, selfCheckInitialCompileArgs);
  const typedAuthorityEvidence = coldAiProviderCallEvidenceFromSplit({
    sidecar: {
      model_provenance: selfCheckSplit.sidecar.model_provenance,
      provider_call_receipt: {
        ...providerCallReceipt,
        gpuHmrSuccess: 'true',
      },
    },
  }, selfCheckInitialCompileArgs);
  const replayedNonceEvidence = coldAiProviderCallEvidenceFromSplit(
    selfCheckSplit,
    {
      ...selfCheckInitialCompileArgs,
      ai_provider_call_nonce: 'provider-call:fedcba9876543210fedcba9876543210',
    },
  );
  const substitutedProviderEvidence = coldAiProviderCallEvidenceFromSplit(
    selfCheckSplit,
    {
      ...selfCheckInitialCompileArgs,
      ai_provider: 'substituted_provider',
    },
  );
  const changedSource = `${selfCheckSource}\n// changed submission`;
  const replayedSourceEvidence = coldAiProviderCallEvidenceFromSplit(
    selfCheckSplit,
    {
      ...selfCheckInitialCompileArgs,
      source: changedSource,
      files: [{ path: 'src/main.hip', name: 'src/main.hip', content: changedSource }],
    },
  );
  if (
    proof.acceptedAsColdAiSplitEvidence !== true
    || proof.acceptedForGpuHmr !== false
    || proof.gpuHmrSuccess !== false
    || proof.canSatisfyRuntimeProof !== false
    || proof.canSatisfyDispatchProof !== false
    || !missingVisualRejected
    || !missingProviderRejected
    || !forgedVisualRejected
    || providerEvidence.accepted !== true
    || providerEvidence.acceptedForGpuHmr !== false
    || providerEvidence.gpuHmrSuccess !== false
    || forgedReceiptEvidence.accepted !== false
    || !forgedReceiptEvidence.blockingGaps.includes('cold_ai_split_provider_receipt_hash_mismatch')
    || forgedChallengeEvidence.accepted !== false
    || !forgedChallengeEvidence.blockingGaps.includes('cold_ai_split_provider_challenge_binding_mismatch')
    || typedAuthorityEvidence.accepted !== false
    || !typedAuthorityEvidence.blockingGaps.includes('cold_ai_split_provider_receipt_claims_gpu_authority')
    || replayedNonceEvidence.accepted !== false
    || substitutedProviderEvidence.accepted !== false
    || !substitutedProviderEvidence.blockingGaps.includes(
      'cold_ai_split_provider_request_provider_mismatch'
    )
    || !replayedNonceEvidence.blockingGaps.includes('cold_ai_split_provider_request_nonce_not_caller_bound')
    || replayedSourceEvidence.accepted !== false
    || !replayedSourceEvidence.blockingGaps.includes('cold_ai_split_provider_request_source_hash_mismatch')
    || !replayedSourceEvidence.blockingGaps.includes('cold_ai_split_provider_request_file_manifest_mismatch')
  ) {
    throw new Error('cold AI split proof authority self-check failed');
  }
  console.log('cold AI split proof authority self-check passed');
}

async function writeNegativeEditRefusalArtifact(name, proof) {
  const seed = {
    schemaVersion: 'synthi.gpu.hmr.agent_split_negative_edit_refusal.v1',
    acceptedForGpuHmr: false,
    accepted_for_gpu_hmr: false,
    gpuHmrSuccess: false,
    gpu_hmr_success: false,
    cpuHmrUsed: false,
    cpu_hmr_used: false,
    fullRebuildUsed: false,
    full_rebuild_used: false,
    processRestarted: false,
    process_restarted: false,
    firewallEvidenceSource: 'static_refusal_before_gpu_load',
    firewall_evidence_source: 'static_refusal_before_gpu_load',
    ...proof,
  };
  if (seed.runModeCoverageSupport || seed.run_mode_coverage_support) {
    const boundSupport = bindGpuHmrRunModeCoverageSupport(
      seed.runModeCoverageSupport ?? seed.run_mode_coverage_support,
      { runMode: seed.runMode ?? seed.run_mode },
    );
    seed.runModeCoverageSupport = boundSupport;
    seed.run_mode_coverage_support = boundSupport;
  }
  const withProofId = {
    ...seed,
    proofId: negativeEditProofId(seed),
  };
  return writeJsonArtifact(name, withProofId);
}

function negativeAbiChangingEdit(source) {
  const kernelSignature = /((?:extern\s+"C"\s+)?__global__\s+void\s+[A-Za-z_]\w*\s*\()([^)]*)(\))/m;
  const match = kernelSignature.exec(source);
  if (!match) {
    return {
      accepted: false,
      reasons: ['negative_edit_kernel_signature_not_found'],
    };
  }
  const acceptedSignature = match[0];
  const kernelName = (acceptedSignature.match(/__global__\s+void\s+([A-Za-z_]\w*)\s*\(/) ?? [])[1] ?? 'unknown';
  const replacementArgs = `${match[2].trim()}${match[2].trim() ? ', ' : ''}int synthi_negative_abi_break`;
  const negativeSignature = `${match[1]}${replacementArgs}${match[3]}`;
  const edited = `${source.slice(0, match.index)}${negativeSignature}${source.slice(match.index + match[0].length)}`;
  const sourceBeforeHash = `sha256:${sha256Hex(source)}`;
  const sourceAfterHash = `sha256:${sha256Hex(edited)}`;
  const acceptedSignatureHash = `sha256:${sha256Hex(acceptedSignature)}`;
  const negativeSignatureHash = `sha256:${sha256Hex(negativeSignature)}`;
  const beforeCount = literalOccurrenceCount(source, acceptedSignature);
  const afterCount = literalOccurrenceCount(edited, negativeSignature);
  const sourceOccurrenceProofId = `source-occurrence-proof:sha256:${sha256Hex(stableJson({
    sourceBeforeHash,
    sourceAfterHash,
    acceptedSignatureHash,
    negativeSignatureHash,
    kernelName,
    beforeCount,
    afterCount,
  }))}`;
  return {
    accepted: true,
    edited,
    reasons: ['abi_compatibility_class_layout_changed', 'kernel_argument_added', 'gpu_hmr_rejected_before_load'],
    executableStaticCheck: {
      accepted: true,
      signatureChanged: true,
      signature_changed: true,
      kernelName,
      kernel_name: kernelName,
      sourceBeforeHash,
      source_before_hash: sourceBeforeHash,
      sourceAfterHash,
      source_after_hash: sourceAfterHash,
      acceptedSignatureHash,
      accepted_signature_hash: acceptedSignatureHash,
      negativeSignatureHash,
      negative_signature_hash: negativeSignatureHash,
      proofId: `executable-static-check:sha256:${sha256Hex(stableJson({
        sourceBeforeHash,
        sourceAfterHash,
        acceptedSignatureHash,
        negativeSignatureHash,
      }))}`,
      proof_id: `executable-static-check:sha256:${sha256Hex(stableJson({
        sourceBeforeHash,
        sourceAfterHash,
        acceptedSignatureHash,
        negativeSignatureHash,
      }))}`,
    },
    sourceOccurrenceProof: {
      accepted: true,
      proofId: sourceOccurrenceProofId,
      proof_id: sourceOccurrenceProofId,
      beforeHash: sourceBeforeHash,
      before_hash: sourceBeforeHash,
      afterHash: sourceAfterHash,
      after_hash: sourceAfterHash,
      beforeCount,
      before_count: beforeCount,
      afterCount,
      after_count: afterCount,
    },
    negativeEditProof: {
      accepted: true,
      editKind: 'negative_edit',
      edit_kind: 'negative_edit',
      sourceProofId: sourceOccurrenceProofId,
      source_proof_id: sourceOccurrenceProofId,
    },
  };
}

async function screenshotDelta(beforeShot, afterShot, diffPath = null) {
  if (!beforeShot?.imageData || !afterShot?.imageData) {
    throw new Error('visual delta requires saved before/after screenshot data');
  }
  const visualProof = ACTIVE_AGENT_PROFILE?.visualProof ?? ACTIVE_AGENT_PROFILE?.visual_proof ?? {};
  const visualProofJob = await createAsyncVisualProofJob({
    beforeBytes: Buffer.from(beforeShot.imageData, 'base64'),
    afterBytes: Buffer.from(afterShot.imageData, 'base64'),
    diffPath,
    artifactDir: ARTIFACT_DIR,
    sessionNamespace: CFG.slug,
    producer: {
      name: 'agent_split_visual_runner',
      kind: 'visual_proof_worker',
    },
    producerSubsystem: 'agent_split_visual_proof',
    visualProof,
  }, {
    allowedOutputRoots: [ARTIFACT_DIR],
    timeoutMs: Number(process.env.SYNTHI_GPU_HMR_VISUAL_WORKER_TIMEOUT_MS ?? 30000),
  });
  const bundle = await completeAsyncVisualProofJob(visualProofJob, {
    casRoot: visualProofJob.casRoot ?? visualProofJob.cas_root,
    allowedRoots: [visualProofJob.casRoot ?? visualProofJob.cas_root],
    allowedOutputRoots: [ARTIFACT_DIR],
    timeoutMs: Number(process.env.SYNTHI_GPU_HMR_VISUAL_WORKER_TIMEOUT_MS ?? 30000),
  });
  const asyncVisualProof = bundle.asyncVisualProof ?? bundle.async_visual_proof ?? {};
  if (asyncVisualProof.accepted !== true) {
    const reasons = Array.isArray(asyncVisualProof.reasons) ? asyncVisualProof.reasons.join(',') : 'unknown';
    throw new Error(`visual proof worker failed: ${reasons}`);
  }
  return {
    changedRatio: bundle.metrics?.changedPixelRatio ?? asyncVisualProof.changedRatio ?? asyncVisualProof.metrics?.changedRatio ?? 0,
    meanAbs: bundle.metrics?.meanAbsDelta8bit ?? asyncVisualProof.meanAbs ?? asyncVisualProof.metrics?.meanAbs ?? 0,
    asyncVisualProofJob: visualProofJob,
    async_visual_proof_job: visualProofJob,
    visualProofBundle: bundle,
    visual_proof_bundle: bundle,
    artifactCasLocators: bundle.artifactCasLocators ?? [],
    artifact_cas_locators: bundle.artifactCasLocators ?? [],
    visualArtifactTransportEvidence: bundle.visualArtifactTransportEvidence ?? null,
    visual_artifact_transport_evidence: bundle.visualArtifactTransportEvidence ?? null,
    asyncVisualProof,
    async_visual_proof: asyncVisualProof,
  };
}

async function singleFrameVisualArtifactsFromShot(shot, artifactName = 'single-frame-visual') {
  const sample = shot?.second?.imageData
    ? shot.second
    : shot?.first?.imageData
      ? shot.first
      : Array.isArray(shot?.samples)
        ? shot.samples.find((entry) => entry?.imageData)
        : null;
  if (!sample?.imageData) {
    throw new Error('single-frame visual proof requires saved screenshot data');
  }
  const image = await writeImageArtifact(artifactName, sample.imageData);
  const bytes = Buffer.from(sample.imageData, 'base64');
  const casRoot = path.join(ARTIFACT_DIR, 'cas');
  const locator = await writeArtifactToCas(bytes, {
    artifactRoot: casRoot,
    mediaType: 'image/png',
    artifactKind: 'visual_frame',
    role: 'after_frame',
    sessionNamespace: CFG.slug,
    producer: {
      name: 'agent_split_visual_runner',
      kind: 'visual_proof_worker',
    },
    producerSubsystem: 'agent_split_visual_proof',
  });
  const transportEvidence = await visualArtifactTransportEvidence({
    artifactCasLocators: [locator],
  }, {
    artifactRoot: casRoot,
    allowedRoots: [casRoot],
    requireReadableBytes: true,
  });
  const visualArtifacts = {
    afterImage: image.path,
    afterImageHash: image.hash,
    artifactCasLocators: [locator],
    visualArtifactTransportEvidence: transportEvidence,
  };
  const visualArtifactsSnake = {
    after_image: image.path,
    after_image_hash: image.hash,
    artifact_cas_locators: [locator],
    visual_artifact_transport_evidence: transportEvidence,
  };
  const visualMetrics = {
    visiblePixelCount: sample.visiblePixels ?? null,
    visible_pixel_count: sample.visiblePixels ?? null,
    meanLuma8bit: sample.meanLuma ?? null,
    mean_luma_8bit: sample.meanLuma ?? null,
  };
  return {
    sample: withoutImageData(sample),
    visualArtifacts,
    visual_artifacts: visualArtifactsSnake,
    visualMetrics,
    visual_metrics: visualMetrics,
  };
}

function visualWorkerParallelismForProof(visualProof = {}, candidateCount = 1) {
  const declared = visualProof.workerParallelism ?? visualProof.worker_parallelism;
  const configured = declared !== undefined && declared !== null
    ? declared
    : CFG.visualWorkerParallelism;
  return boundedPositiveInt(configured, CFG.visualWorkerParallelism, {
    min: 1,
    max: Math.max(1, Math.min(16, candidateCount)),
  });
}

async function mapWithConcurrency(items, limit, mapper) {
  const list = Array.isArray(items) ? items : [];
  if (list.length === 0) return [];
  const concurrency = boundedPositiveInt(limit, 1, { min: 1, max: list.length });
  const results = new Array(list.length);
  let nextIndex = 0;
  const workers = Array.from({ length: concurrency }, async () => {
    while (nextIndex < list.length) {
      const currentIndex = nextIndex;
      nextIndex += 1;
      results[currentIndex] = await mapper(list[currentIndex], currentIndex);
    }
  });
  await Promise.all(workers);
  return results;
}

function visualDeltaSchedulingEvidence({ workerParallelism, candidateCount, controlComparisonCount }) {
  return {
    schemaVersion: 'synthi.gpu_hmr.visual_delta_worker_scheduling.v1',
    schema_version: 'synthi.gpu_hmr.visual_delta_worker_scheduling.v1',
    accepted: true,
    acceptedAsSchedulingEvidence: true,
    accepted_as_scheduling_evidence: true,
    acceptedForGpuHmr: false,
    accepted_for_gpu_hmr: false,
    gpuHmrSuccess: false,
    gpu_hmr_success: false,
    proofAuthority: 'visual_worker_scheduling_support_only',
    proof_authority: 'visual_worker_scheduling_support_only',
    strategy: 'bounded_concurrent_worker_threads',
    workerParallelism,
    worker_parallelism: workerParallelism,
    candidateComparisonCount: candidateCount,
    candidate_comparison_count: candidateCount,
    controlComparisonCount,
    control_comparison_count: controlComparisonCount,
  };
}

async function assertVisualDelta(beforeShot, afterShot, diffArtifactName = 'before-after-diff', recordLabel = 'mcp screenshot visual delta') {
  const beforeSamples = [beforeShot?.first, beforeShot?.second, ...(beforeShot?.samples ?? [])]
    .filter((sample, index, all) => sample?.imageData && all.findIndex((candidate) => candidate?.seq === sample.seq) === index);
  const afterSamples = [afterShot?.first, afterShot?.second, ...(afterShot?.samples ?? [])]
    .filter((sample, index, all) => sample?.imageData && all.findIndex((candidate) => candidate?.seq === sample.seq) === index)
    .filter((sample) => sample.frameCaptureAfterEpochDispatch !== false);
  if (!beforeSamples.length || !afterSamples.length) {
    throw new Error('visual delta requires saved before/after screenshot data');
  }

  const baseline = beforeShot?.second?.imageData ? beforeShot.second : beforeSamples[beforeSamples.length - 1];
  const visualProof = ACTIVE_AGENT_PROFILE?.visualProof ?? ACTIVE_AGENT_PROFILE?.visual_proof ?? {};
  const workerParallelism = visualWorkerParallelismForProof(visualProof, afterSamples.length);
  const controlComparisonCount = beforeSamples.length >= 2 ? 1 : 0;
  const schedulingEvidence = visualDeltaSchedulingEvidence({
    workerParallelism,
    candidateCount: afterSamples.length,
    controlComparisonCount,
  });
  const controlResultPromise = (beforeSamples.length >= 2
    ? screenshotDelta(beforeSamples[0], beforeSamples[beforeSamples.length - 1])
    : Promise.resolve({ changedRatio: 0, meanAbs: 0 })
  ).then(
    (value) => ({ ok: true, value }),
    (error) => ({ ok: false, error }),
  );
  const candidateStats = await mapWithConcurrency(afterSamples, workerParallelism, async (candidate) => ({
    ...(await screenshotDelta(baseline, candidate)),
    shot: candidate,
  }));
  const controlResult = await controlResultPromise;
  if (!controlResult.ok) throw controlResult.error;
  const control = controlResult.value;
  let best = null;
  for (const stats of candidateStats) {
    if (!best || stats.changedRatio > best.changedRatio || (
      stats.changedRatio === best.changedRatio && stats.meanAbs > best.meanAbs
    )) {
      best = stats;
    }
  }
  const controlMultiplier = Number.isFinite(visualProof.controlMultiplier)
    ? visualProof.controlMultiplier
    : Number.isFinite(visualProof.control_multiplier)
      ? visualProof.control_multiplier
      : 3.0;
  const controlChangedRatioPadding = Number.isFinite(visualProof.controlChangedRatioPadding)
    ? visualProof.controlChangedRatioPadding
    : Number.isFinite(visualProof.control_changed_ratio_padding)
      ? visualProof.control_changed_ratio_padding
      : 0.0025;
  const controlMeanAbsPadding = Number.isFinite(visualProof.controlMeanAbsPadding)
    ? visualProof.controlMeanAbsPadding
    : Number.isFinite(visualProof.control_mean_abs_padding)
      ? visualProof.control_mean_abs_padding
      : 0.25;
  const minChangedRatio = Math.max(
    Number.isFinite(visualProof.minChangedRatio)
      ? visualProof.minChangedRatio
      : Number.isFinite(visualProof.min_changed_ratio)
        ? visualProof.min_changed_ratio
        : 0.01,
    control.changedRatio * controlMultiplier + controlChangedRatioPadding,
  );
  const minMeanAbs = Math.max(
    Number.isFinite(visualProof.minMeanAbs)
      ? visualProof.minMeanAbs
      : Number.isFinite(visualProof.min_mean_abs)
        ? visualProof.min_mean_abs
        : 1.0,
    control.meanAbs * controlMultiplier + controlMeanAbsPadding,
  );
  const ok = best && best.changedRatio > minChangedRatio && best.meanAbs > minMeanAbs;
  const diffPath = path.join(ARTIFACT_DIR, `${diffArtifactName}.png`);
  const selectedDiffStats = best ? await screenshotDelta(baseline, best.shot, diffPath) : null;
  if (best && selectedDiffStats?.asyncVisualProof) {
    best.asyncVisualProof = selectedDiffStats.asyncVisualProof;
    best.async_visual_proof = selectedDiffStats.asyncVisualProof;
    best.asyncVisualProofJob = selectedDiffStats.asyncVisualProofJob;
    best.async_visual_proof_job = selectedDiffStats.asyncVisualProofJob;
    best.visualProofBundle = selectedDiffStats.visualProofBundle;
    best.visual_proof_bundle = selectedDiffStats.visualProofBundle;
    best.artifactCasLocators = selectedDiffStats.artifactCasLocators ?? [];
    best.artifact_cas_locators = selectedDiffStats.artifactCasLocators ?? [];
    best.visualArtifactTransportEvidence = selectedDiffStats.visualArtifactTransportEvidence ?? null;
    best.visual_artifact_transport_evidence = selectedDiffStats.visualArtifactTransportEvidence ?? null;
  }
  const firstAfterTs = afterSamples[0]?.ts || 0;
  const selectedDeltaMs = firstAfterTs && best?.shot?.ts ? best.shot.ts - firstAfterTs : null;
  const detail = best
      ? `changed=${(best.changedRatio * 100).toFixed(2)}% mean_abs=${best.meanAbs.toFixed(2)} min_changed=${(minChangedRatio * 100).toFixed(2)}% min_mean_abs=${minMeanAbs.toFixed(2)} control_changed=${(control.changedRatio * 100).toFixed(2)}% control_mean_abs=${control.meanAbs.toFixed(2)} selected_seq=${best.shot.seq} selected_delta_ms=${selectedDeltaMs} diff=${path.relative(process.cwd(), diffPath)}`
    : `no eligible post-HMR visual samples diff=${path.relative(process.cwd(), diffPath)}`;
  record(recordLabel, ok ? 'pass' : 'fail', detail);
  if (!ok) {
    throw agentSplitRefusalError(
      `visual delta too small: ${detail}`,
      'agent_split_visual_delta_refused',
    );
  }
  const baselineArtifact = await writeImageArtifact(`${diffArtifactName}-baseline`, baseline.imageData);
  const selectedAfterArtifact = await writeImageArtifact(`${diffArtifactName}-selected-after`, best.shot.imageData);
  const diffArtifact = {
    path: path.relative(process.cwd(), diffPath),
    hash: `sha256:${sha256BufferHex(await readFile(diffPath))}`,
  };
  const visualArtifacts = {
    beforeImage: baselineArtifact.path,
    beforeImageHash: baselineArtifact.hash,
    afterImage: selectedAfterArtifact.path,
    afterImageHash: selectedAfterArtifact.hash,
    diffImage: diffArtifact.path,
    diffImageHash: diffArtifact.hash,
    artifactCasLocators: best.artifactCasLocators ?? [],
    visualArtifactTransportEvidence: best.visualArtifactTransportEvidence ?? null,
  };
  const visualArtifactsSnake = {
    before_image: baselineArtifact.path,
    before_image_hash: baselineArtifact.hash,
    after_image: selectedAfterArtifact.path,
    after_image_hash: selectedAfterArtifact.hash,
    diff_image: diffArtifact.path,
    diff_image_hash: diffArtifact.hash,
    artifact_cas_locators: best.artifactCasLocators ?? [],
    visual_artifact_transport_evidence: best.visualArtifactTransportEvidence ?? null,
  };
  const semanticVisualProbes = await semanticVisualProbeEvidenceFromDelta({
    visualArtifacts,
    visual_artifacts: visualArtifactsSnake,
  });
  return {
    changedRatio: best.changedRatio,
    meanAbs: best.meanAbs,
    controlChangedRatio: control.changedRatio,
    controlMeanAbs: control.meanAbs,
    baselineSeq: baseline.seq,
    baselineTs: baseline.ts,
    selectedSeq: best.shot.seq,
    selectedTs: best.shot.ts,
    selectedDeltaMs,
    selectedFrameCaptureAfterEpochDispatch: best.shot.frameCaptureAfterEpochDispatch,
    selected_frame_capture_after_epoch_dispatch: best.shot.frameCaptureAfterEpochDispatch,
    visualProofThresholds: {
      minChangedRatio,
      minMeanAbs,
      controlMultiplier,
      controlChangedRatioPadding,
      controlMeanAbsPadding,
    },
    visual_proof_thresholds: {
      min_changed_ratio: minChangedRatio,
      min_mean_abs: minMeanAbs,
      control_multiplier: controlMultiplier,
      control_changed_ratio_padding: controlChangedRatioPadding,
      control_mean_abs_padding: controlMeanAbsPadding,
    },
    diffPath: path.relative(process.cwd(), diffPath),
    visualArtifacts,
    visual_artifacts: visualArtifactsSnake,
    artifactCasLocators: best.artifactCasLocators ?? [],
    artifact_cas_locators: best.artifactCasLocators ?? [],
    visualArtifactTransportEvidence: best.visualArtifactTransportEvidence ?? null,
    visual_artifact_transport_evidence: best.visualArtifactTransportEvidence ?? null,
    visualProofBundle: best.visualProofBundle ?? null,
    visual_proof_bundle: best.visualProofBundle ?? null,
    visualSemanticProbes: semanticVisualProbes,
    visual_semantic_probes: semanticVisualProbes,
    asyncVisualProofJob: best.asyncVisualProofJob ?? null,
    async_visual_proof_job: best.asyncVisualProofJob ?? null,
    asyncVisualProof: best.asyncVisualProof ?? null,
    async_visual_proof: best.asyncVisualProof ?? null,
    controlAsyncVisualProof: control.asyncVisualProof ?? null,
    control_async_visual_proof: control.asyncVisualProof ?? null,
    visualDeltaScheduling: schedulingEvidence,
    visual_delta_scheduling: schedulingEvidence,
  };
}

async function assertMcpScreenshot(
  label = 'mcp screenshot after hmr',
  artifactPrefix = 'after-hmr',
  waitEvidence = null,
  options = {},
) {
  const state = await ensureMcpAttached();
  let gateTokenConsumed = false;
  let verifiedGateCapture = null;
  const analyzeImage = async (data) => {
    if (!data) return { bytes: 0, visiblePixels: 0, meanLuma: 0 };
    const bytes = Math.floor(data.length * 3 / 4);
    const input = Buffer.from(data, 'base64');
    const { data: raw, info } = await sharp(input)
      .removeAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    let visiblePixels = 0;
    let lumaTotal = 0;
    for (let i = 0; i < raw.length; i += info.channels) {
      const r = raw[i] ?? 0;
      const g = raw[i + 1] ?? 0;
      const b = raw[i + 2] ?? 0;
      const luma = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      lumaTotal += luma;
      if (luma > 24 || Math.max(r, g, b) - Math.min(r, g, b) > 30) {
        visiblePixels += 1;
      }
    }
    const pixels = Math.max(1, info.width * info.height);
    return { bytes, visiblePixels, meanLuma: lumaTotal / pixels };
  };
  const isVisibleFrame = (shot) =>
    shot.width >= 320 &&
    shot.height >= 240 &&
    shot.bytes > 512 &&
    shot.visiblePixels > 500;
  const capture = async () => {
    const useFrameGate = waitEvidence && !gateTokenConsumed;
    const screenshotArgs = mcpScreenshotArgsForFrameGate(useFrameGate ? waitEvidence : null, {
      freshnessMaxMs: 15000,
      frameGateTimeoutMs: CFG.frameGateTimeoutMs,
    });
    const captureStartNs = timingBoundaryNs();
    const shot = await state.client.toolCallRaw(
      'synthi_screenshot',
      screenshotArgs,
      Math.max(30000, CFG.frameGateTimeoutMs + 5000),
    );
    const captureEndNs = timingBoundaryNs();
    const captureContract = observedMcpVisualCaptureContract(shot);
    activeAgentSplitTestTiming?.observeCaptureContract(
      captureContract,
      captureStartNs,
      captureEndNs,
    );
    if (screenshotArgs.after_frame_gate) gateTokenConsumed = true;
    const image = shot.content.find((b) => b?.type === 'image' && typeof b.data === 'string');
    const meta = mcpScreenshotMetadataFromToolResult(shot) || {};
    const frameMeta = {
      ...meta,
      seq: Number(meta.seq || 0),
      ts: Number(meta.ts || 0),
    };
    const gateTokenVerified = mcpFrameGateSatisfiedByScreenshot(waitEvidence, frameMeta);
    if (gateTokenVerified) {
      verifiedGateCapture = {
        seq: frameMeta.seq,
        ts: frameMeta.ts,
      };
    }
    const frameAfterGate = !waitEvidence
      ? false
      : gateTokenVerified
        || (verifiedGateCapture !== null
          && mcpFrameAtOrAfterFrameGate(waitEvidence, frameMeta)
          && frameMeta.seq >= verifiedGateCapture.seq
          && frameMeta.ts >= verifiedGateCapture.ts);
    const analysisStartNs = timingBoundaryNs();
    const analysis = await analyzeImage(image?.data);
    const analysisEndNs = timingBoundaryNs();
    const captured = {
      meta,
      imageData: image?.data || '',
      width: Number(meta.w || meta.width || 0),
      height: Number(meta.h || meta.height || 0),
      seq: frameMeta.seq,
      ts: frameMeta.ts,
      frameGateTokenVerified: gateTokenVerified,
      frameCaptureAfterEpochDispatch: frameAfterGate,
      ...analysis,
    };
    activeAgentSplitTestTiming?.observeVisualCapture({
      contract: captureContract,
      captureStartNs,
      captureEndNs,
      analysisStartNs,
      analysisEndNs,
    });
    return captured;
  };
  const minVisibleSamples = Math.max(2, Number(options.minVisibleSamples ?? 2));
  const captureWindowMs = Math.max(1000, Number(options.captureWindowMs ?? 15000));
  const sampleIntervalMs = Math.max(50, Number(options.sampleIntervalMs ?? 500));
  const deadline = Date.now() + captureWindowMs;
  const samples = [];
  while (Date.now() < deadline) {
    const shot = await capture();
    samples.push(shot);
    const eligibleVisible = samples
      .filter(isVisibleFrame)
      .filter((sample) => !waitEvidence || sample.frameCaptureAfterEpochDispatch === true);
    const distinctEligibleSequences = new Set(
      eligibleVisible
        .map((sample) => sample.seq)
        .filter((seq) => Number.isFinite(seq) && seq > 0),
    );
    if (
      eligibleVisible.length >= minVisibleSamples
      && distinctEligibleSequences.size >= Math.min(2, minVisibleSamples)
    ) {
      break;
    }
    await sleep(sampleIntervalMs);
  }
  const visible = samples
    .filter(isVisibleFrame)
    .filter((sample) => !waitEvidence || sample.frameCaptureAfterEpochDispatch === true);
  const first = visible[0] ?? samples[0] ?? { meta: {}, width: 0, height: 0, seq: 0, bytes: 0, visiblePixels: 0, meanLuma: 0 };
  const second = [...visible].reverse().find((shot) => shot.seq > first.seq) ?? visible[1] ?? samples[samples.length - 1] ?? first;
  const frameGateVerified = !waitEvidence || samples.some((sample) => sample.frameGateTokenVerified === true);
  const ok =
    isVisibleFrame(first) &&
    second.width === first.width &&
    second.height === first.height &&
    second.bytes > 512 &&
    second.visiblePixels > 500 &&
    second.seq > first.seq &&
    frameGateVerified &&
    (!waitEvidence || (
      first.frameCaptureAfterEpochDispatch === true &&
      second.frameCaptureAfterEpochDispatch === true
    ));
  let artifactDetail = '';
  if (ok && CFG.captureArtifacts) {
    const firstArtifact = await writeImageArtifact(`${artifactPrefix}-first`, first.imageData);
    const secondArtifact = await writeImageArtifact(`${artifactPrefix}-second`, second.imageData);
    const metaPath = await writeJsonArtifact(`${artifactPrefix}-metadata`, {
      first: withoutImageData(first),
      second: withoutImageData(second),
      firstArtifact,
      first_artifact: firstArtifact,
      secondArtifact,
      second_artifact: secondArtifact,
    });
    artifactDetail = ` images=${firstArtifact.path},${secondArtifact.path} metadata=${metaPath}`;
  }
  record(
    label,
    ok ? 'pass' : 'fail',
    ok
      ? `${first.width}x${first.height} seq=${first.seq}->${second.seq} visible=${first.visiblePixels}/${second.visiblePixels} luma=${first.meanLuma.toFixed(1)}/${second.meanLuma.toFixed(1)} bytes~${first.bytes}/${second.bytes} frame_gate_after=${second.frameCaptureAfterEpochDispatch}${artifactDetail}`
      : `invalid screenshot first=${JSON.stringify(first.meta).slice(0, 120)} second=${JSON.stringify(second.meta).slice(0, 120)} visible=${first.visiblePixels}/${second.visiblePixels} luma=${first.meanLuma.toFixed(1)}/${second.meanLuma.toFixed(1)} bytes~${first.bytes}/${second.bytes} frame_gate_after=${second.frameCaptureAfterEpochDispatch}`,
  );
  if (!ok) {
    throw agentSplitRefusalError(
      `${label} did not return a valid frame`,
      'agent_split_visual_frame_refused',
    );
  }
  return { first, second, samples: visible };
}

async function run() {
  activeAgentSplitTestTiming?.beginPhase('cold_intake');
  await mkdir(LOG_DIR, { recursive: true });
  ACTIVE_AGENT_PROFILE = loadAgentVisualProfile();
  const discoverRuntime = async () => {
    await resolveDockerContainers();
    const vendor = await detectVendor();
    const arch = await detectArch(vendor);
    return { vendor, arch };
  };
  const { vendor, arch } = activeAgentSplitTestTiming
    ? await activeAgentSplitTestTiming.measurePhase('discovery', discoverRuntime)
    : await discoverRuntime();
  if (arch) {
    CFG.gpuArch = arch;
    process.env.SYNTHI_GPU_ARCH = arch;
  }
  record('gpu vendor', 'pass', `${vendor} arch=${arch ?? 'auto'} arch_source=${CFG.gpuArchSource ?? 'missing'}`);
  record('fixture', 'pass', validationFixtureId());
  const source = monolithicSource(vendor);
  if (ACTIVE_AGENT_PROFILE) {
    record(
      'agent visual profile',
      'pass',
      `id=${ACTIVE_AGENT_PROFILE.profileId} source=${ACTIVE_AGENT_PROFILE.sourceAuthority} edits=${ACTIVE_AGENT_PROFILE.deviceEdits.length} hash=${ACTIVE_AGENT_PROFILE.profileHash} source_hash=${ACTIVE_AGENT_PROFILE.source?.contentHash ?? 'missing'}`,
    );
  }

  const entryPath = validationProfileEntryPath();
  const initialSourceFiles = sourceFilesForInitialCompile(entryPath, source);
  const sourcePurityEvidence = assertNoSynthiAbi(source, {
    entryPath,
    files: initialSourceFiles,
  });
  const renderWidth = validationProfileWidth();
  const renderHeight = validationProfileHeight();

  const workspace = await createWorkspace({
    name: `Synthi GPU Agent Split (${vendor})`,
    slug: CFG.slug,
  });
  record('create workspace', 'pass', `id=${workspace.id ?? 'n/a'} slug=${CFG.slug}`);

  await writeFilesBatch({ slug: CFG.slug, files: initialSourceFiles });
  record(
    'seed profile/fixture source',
    'pass',
    `${entryPath} files=${initialSourceFiles.length}${ACTIVE_AGENT_PROFILE?.source?.manifestHash ? ` manifest=${ACTIVE_AGENT_PROFILE.source.manifestHash}` : ''}`,
  );
  await stageAndCommit({ slug: CFG.slug, message: 'gpu-hmr-agent-split-test: seed monolithic source' })
    .then(() => record('workspace commit seed', 'pass'))
    .catch((e) => record('workspace commit seed', 'warn', e.message.slice(0, 200)));
  activeAgentSplitTestTiming?.finishPhase('cold_intake');

  if (CFG.mode === 'seed-only') {
    activeAgentSplitTestTiming?.markSeedOnlyTerminalPath();
    record('seed-only workspace ready', 'pass', 'open the URL and click Run to trigger AI split');
    await writeResults();
    console.log(`url: ${CFG.frontendUrl}/workspace/${CFG.slug}`);
    return;
  }

  const firstStart = await workerCheckpoint();
  const coldProviderCallNonce = CFG.mode === 'cold-ai-split'
    ? `provider-call:${randomBytes(16).toString('hex')}`
    : null;
  const initialCompileArgs = {
    language: 'cpp',
    filename: entryPath,
    source,
    files: initialSourceFiles,
    is_gui: true,
    use_ai_split: true,
    bypass_ai_split_cache: CFG.mode === 'cold-ai-split',
    require_ai_provider_call: CFG.mode === 'cold-ai-split',
    ai_provider_call_nonce: coldProviderCallNonce,
    ai_provider: CFG.gpuSplitProvider,
    ai_model: CFG.gpuSplitModel,
    user_requested_ai: true,
    prefer_gpu_pipeline: true,
    gpu_mode: vendor,
    gpu_arch: CFG.gpuArch,
    gpu_arch_source: CFG.gpuArchSource,
    slug: CFG.slug,
    width: renderWidth,
    height: renderHeight,
  };
  let initialCompileResult = null;
  try {
    initialCompileResult = await compileViaMcp(initialCompileArgs, CFG.hmrTimeoutMs, {
      metricScope: 'cold',
      cacheState: 'clean',
      editId: 'initial-ai-split',
      editHash: `sha256:${sha256Hex(source)}`,
      editKind: 'cold_split',
      requiredGpuProofState: 'gpu-hmr-compile-proven',
    });
  } catch (err) {
    const providerDiagnostic = sourceFirstProviderDiagnosticEvidence({
      error: err,
      initialCompileArgs,
      source,
      entryPath,
    });
    if (providerDiagnostic.providerFailureDetected) {
      tagAgentSplitTimingError(err, {
        outcome: 'failed',
        category: 'provider_failure',
        reasonCode: 'agent_split_ai_provider_failure',
      });
      let diagnosticPath;
      try {
        diagnosticPath = await writeJsonArtifact(
          'source-first-provider-diagnostic',
          providerDiagnostic,
        );
      } catch (retentionError) {
        throw tagAgentSplitTimingError(retentionError, {
          outcome: 'failed',
          category: 'provider_failure',
          reasonCode: 'agent_split_ai_provider_failure',
        });
      }
      record('source-first AI provider diagnostic', 'fail', {
        artifactPath: diagnosticPath,
        proofId: providerDiagnostic.proofId,
        reasonCodes: providerDiagnostic.reasonCodes,
        acceptedForGpuHmr: providerDiagnostic.acceptedForGpuHmr,
        gpuHmrSuccess: providerDiagnostic.gpuHmrSuccess,
        canSatisfyRuntimeProof: providerDiagnostic.canSatisfyRuntimeProof,
      });
    }
    throw err;
  }
  record('first compile via MCP', 'pass', 'use_ai_split=true prefer_gpu_pipeline=true');

  const sawGpuSplit = await awaitWorkerLogRegex(
    /GPU markers detected; calling GPU split endpoint|GPU split endpoint returned a \d+-file split/,
    CFG.hmrTimeoutMs,
    firstStart,
  );

  const structuredInitialCompileProof = initialDeviceCompileProofFromResult(initialCompileResult);
  record(
    'generated device compiled',
    structuredInitialCompileProof.accepted ? 'pass' : 'fail',
    structuredInitialCompileProof.accepted
      ? `structured_proof=${JSON.stringify(structuredInitialCompileProof)}`
      : `structured proof rejected: ${JSON.stringify(structuredInitialCompileProof)}`,
  );
  if (!structuredInitialCompileProof.accepted) {
    throw agentSplitRefusalError(
      'initial GPU compile did not produce a device compile proof',
      'agent_split_cold_compile_proof_refused',
    );
  }

  const initialFrameGateObserved = Boolean(
    mcpScreenshotArgsForFrameGate(initialCompileResult.wait).after_frame_gate,
  );
  const baselineShot = CFG.captureArtifacts
    ? await assertMcpScreenshot(
        'mcp screenshot before hmr',
        'before-hmr',
        initialFrameGateObserved ? initialCompileResult.wait : null,
      )
    : null;

  const split = await readGeneratedSplit(vendor);
  record('read generated split from worker', 'pass', `worker=${split.workspacePath}`);
  const coldAiProviderCallEvidence = CFG.mode === 'cold-ai-split'
    ? coldAiProviderCallEvidenceFromSplit(split, initialCompileArgs)
    : null;
  if (coldAiProviderCallEvidence) {
    const providerEvidencePath = await writeJsonArtifact(
      'cold-ai-provider-call',
      coldAiProviderCallEvidence,
    );
    record(
      'cold AI split provider call evidence',
      coldAiProviderCallEvidence.accepted ? 'pass' : 'fail',
      coldAiProviderCallEvidence.accepted
        ? `${coldAiProviderCallEvidence.evidenceHash} artifact=${providerEvidencePath}`
        : coldAiProviderCallEvidence.blockingGaps.join('|'),
    );
    if (!coldAiProviderCallEvidence.accepted) {
      throw agentSplitRefusalError(
        `cold AI split provider call evidence rejected: ${coldAiProviderCallEvidence.blockingGaps.join('|')}`,
        'agent_split_provider_evidence_refused',
      );
    }
  }
  const splitEndpointEvidence = gpuSplitEndpointEvidenceFromSidecar(split);
  record(
    'worker used GPU split endpoint',
    sawGpuSplit.matched || splitEndpointEvidence.observed ? 'pass' : 'fail',
    sawGpuSplit.snippet || splitEndpointEvidence.detail || 'no GPU split marker or sidecar evidence',
  );
  if (!(sawGpuSplit.matched || splitEndpointEvidence.observed)) {
    throw agentSplitRefusalError(
      'GPU split endpoint evidence missing after initial compile',
      'agent_split_endpoint_evidence_refused',
    );
  }
  const sourceFirstIngestion = sourceFirstIngestionEvidence({
    source,
    entryPath,
    sourcePurityEvidence,
    initialCompileArgs,
    initialCompileResult,
    split,
    sawGpuSplit,
    splitEndpointEvidence,
  });
  record(
    'source-first AI split provenance-only evidence',
    sourceFirstIngestion.accepted ? 'pass' : 'fail',
    sourceFirstIngestion.accepted
      ? sourceFirstIngestion.proofId
      : sourceFirstIngestion.failedGates.join('|'),
  );
  if (!sourceFirstIngestion.accepted) {
    throw agentSplitRefusalError(
      `source-first AI split provenance-only evidence rejected: ${sourceFirstIngestion.failedGates.join('|')}`,
      'agent_split_source_first_provenance_refused',
    );
  }
  const granularity = validateGeneratedSplit(split);
  const granularityPath = await writeJsonArtifact('generated-split-granularity', granularity);
  record('generated split granularity artifact', 'pass', granularityPath);
  await persistGeneratedSplitToWorkspace(split, granularity);

  let coldSplitProofSeed = null;
  let hotDelta1RunModeCoverageSupport = null;
  if (CFG.captureArtifacts && baselineShot) {
    const coldVisual = await singleFrameVisualArtifactsFromShot(baselineShot, 'cold-split-frame');
    coldSplitProofSeed = {
      ...runModeProofIdentity(split),
      coldSplitProven: true,
      cold_split_proven: true,
      acceptedForGpuHmr: false,
      accepted_for_gpu_hmr: false,
      gpuHmrSuccess: false,
      gpu_hmr_success: false,
      cpuHmrUsed: false,
      cpu_hmr_used: false,
      fullRebuildUsed: false,
      full_rebuild_used: false,
      processRestarted: false,
      process_restarted: false,
      runMode: initialCompileResult.timingMetrics,
      run_mode: initialCompileResult.timingMetrics,
      timingMetrics: initialCompileResult.timingMetrics,
      timing_metrics: initialCompileResult.timingMetrics,
      sourceFirstIngestion,
      source_first_ingestion: sourceFirstIngestion,
      coldAiProviderCallEvidence,
      cold_ai_provider_call_evidence: coldAiProviderCallEvidence,
      coldSingleFrameVisual: coldVisual.sample,
      cold_single_frame_visual: coldVisual.sample,
      visualArtifacts: coldVisual.visualArtifacts,
      visual_artifacts: coldVisual.visual_artifacts,
      visualMetrics: coldVisual.visualMetrics,
      visual_metrics: coldVisual.visual_metrics,
    };
  }

  if (CFG.mode === 'cold-ai-split') {
    let coldAiSplitProof;
    try {
      coldAiSplitProof = coldAiSplitProofFromSeed(coldSplitProofSeed);
    } catch (error) {
      throw tagAgentSplitTimingError(error, {
        outcome: 'refused',
        category: 'proof_refusal',
        reasonCode: 'agent_split_cold_visual_proof_refused',
      });
    }
    const coldPath = await writeRunModeProofArtifact(
      'run-mode-cold-ai-split',
      coldAiSplitProof,
    );
    record('cold AI split visual proof artifact', 'pass', coldPath);
    await writeResults();
    console.log(`url: ${CFG.frontendUrl}/workspace/${CFG.slug}`);
    return;
  }

  const hotDelta1Edit = deviceEditForRun(split.files[split.roles.device], {
    attempt: 0,
    runMode: 'hot_delta_1',
  });
  if (hotDelta1Edit.edited === split.files[split.roles.device]) {
    throw new Error('hot delta 1 edit generator did not produce a distinct device source');
  }
  const editedDevice = hotDelta1Edit.edited;
  const secondStart = await workerCheckpoint();
  const hotDelta1EditHash = deviceEditHash({
    selectedPath: split.roles.device,
    beforeSource: split.files[split.roles.device],
    afterSource: editedDevice,
    editKind: 'gpu_artifact_edit',
  });
  const generatedDeviceResult = await compileGeneratedDevice(split, editedDevice, {
    metricScope: 'hot_delta_1',
    cacheState: 'compiler_cache_warm',
    editId: `hot-delta-1:${sha256Hex(hotDelta1EditHash).slice(0, 16)}`,
    editHash: hotDelta1EditHash,
    editKind: 'gpu_artifact_edit',
  });
  record('device edit compile via MCP', 'pass', split.roles.device);

  const deviceEditIdentityProof = generatedDeviceEditIdentityProof(
    generatedDeviceResult,
    split,
    hotDelta1EditHash,
  );
  record(
    'generated device file used for HMR',
    deviceEditIdentityProof.accepted ? 'pass' : 'fail',
    JSON.stringify(deviceEditIdentityProof),
  );
  if (!deviceEditIdentityProof.accepted) {
    throw agentSplitRefusalError(
      'generated device edit identity proof failed for hot delta 1',
      'agent_split_hot_delta_1_identity_refused',
    );
  }

  const hotSwapProof = fullRuntimeGpuHmrProofFromResult(generatedDeviceResult);
  record(
    'device-only GPU HMR observed',
    hotSwapProof.accepted ? 'pass' : 'fail',
    JSON.stringify(hotSwapProof),
  );
  if (!hotSwapProof.accepted) {
    throw agentSplitRefusalError(
      'full-runtime GPU HMR proof failed for hot delta 1',
      'agent_split_hot_delta_1_runtime_refused',
    );
  }

  const afterShot = await assertMcpScreenshot(
    'mcp screenshot after hmr',
    'after-hmr',
    generatedDeviceResult.wait,
    CFG.captureArtifacts && baselineShot
      ? {
          minVisibleSamples: CFG.visualDeltaMinSamples,
          captureWindowMs: CFG.visualDeltaWindowMs,
          sampleIntervalMs: CFG.visualDeltaSampleIntervalMs,
        }
      : {},
  );
  let visualDelta = null;
  if (CFG.captureArtifacts && baselineShot) {
    visualDelta = await assertVisualDelta(baselineShot, afterShot);
    const hotDelta1Proof = withRunModeVisualLedgerProof({
      proof: {
      ...runModeProofIdentity(split),
      ...waitProofFields(generatedDeviceResult),
      acceptedForGpuHmr: false,
      accepted_for_gpu_hmr: false,
      gpuHmrSuccess: false,
      gpu_hmr_success: false,
      gpuHmrAcceptanceAuthority: 'pending_visual_runtime_proof_ledger_recompute',
      gpu_hmr_acceptance_authority: 'pending_visual_runtime_proof_ledger_recompute',
      runMode: generatedDeviceResult.timingMetrics,
      run_mode: generatedDeviceResult.timingMetrics,
      timingMetrics: generatedDeviceResult.timingMetrics,
      timing_metrics: generatedDeviceResult.timingMetrics,
      sourceFirstIngestion,
      source_first_ingestion: sourceFirstIngestion,
      deviceEditMutation: hotDelta1Edit.mutation,
      device_edit_mutation: hotDelta1Edit.mutation,
      sourceBaselineProof: generatedDeviceResult.sourceBaselineProof,
      source_baseline_proof: generatedDeviceResult.sourceBaselineProof,
      refreshedSourceBaselineProof: generatedDeviceResult.refreshedSourceBaselineProof,
      refreshed_source_baseline_proof: generatedDeviceResult.refreshedSourceBaselineProof,
      visualArtifacts: visualDelta.visualArtifacts,
      visual_artifacts: visualDelta.visual_artifacts,
      visualSemanticProbes: visualDelta.visualSemanticProbes,
      visual_semantic_probes: visualDelta.visual_semantic_probes,
      evidenceRefs: visualDelta.visualSemanticProbes?.evidenceRefs ?? [],
      evidence_refs: visualDelta.visual_semantic_probes?.evidence_refs ?? [],
      visualMetrics: {
        changedPixelRatio: visualDelta.changedRatio,
        meanAbsDelta8bit: visualDelta.meanAbs,
        visiblePixelCount: afterShot.second?.visiblePixels ?? afterShot.first?.visiblePixels ?? null,
        baselineSeq: visualDelta.baselineSeq,
        selectedSeq: visualDelta.selectedSeq,
        selectedFrameCaptureAfterEpochDispatch: visualDelta.selectedFrameCaptureAfterEpochDispatch,
      },
      },
      visualDelta,
      beforeShot: baselineShot,
      afterShot,
      wait: generatedDeviceResult.wait,
    });
    hotDelta1RunModeCoverageSupport = runModeCoverageSupportFromProof(hotDelta1Proof);
    const hotDelta1ProfileEvidence = typedValidationProfileEvidence({
      proof: hotDelta1Proof,
      split,
      visualDelta,
    });
    if (coldSplitProofSeed && hotDelta1RunModeCoverageSupport) {
      const coldPath = await writeRunModeProofArtifact('run-mode-cold-split', {
        ...coldSplitProofSeed,
        runModeCoverageSupport: hotDelta1RunModeCoverageSupport,
        run_mode_coverage_support: hotDelta1RunModeCoverageSupport,
      });
      record('run-mode cold split proof artifact', 'pass', coldPath);
    }
    const hotDelta1Path = await writeRunModeProofArtifact('run-mode-hot-delta-1', {
      ...hotDelta1Proof,
      validationProfileEvidence: hotDelta1ProfileEvidence,
      validation_profile_evidence: hotDelta1ProfileEvidence,
    });
    record('run-mode hot delta 1 proof artifact', 'pass', hotDelta1Path);
  }
  const deterministicFission = verifyGeneratedSplitFissionAfterRuntime({
    split,
    granularity,
    generatedDeviceResult,
    visualDelta,
    selectedPath: generatedDeviceResult.selectedPath,
    previousDevice: generatedDeviceResult.previousDevice,
    editedDevice: generatedDeviceResult.editedDevice,
  });
  const deterministicFissionPath = await writeJsonArtifact(
    'generated-split-deterministic-fission',
    deterministicFission,
  );
  record(
    'generated split deterministic fission verifier',
    'pass',
    [
      `accepted=${deterministicFission.deterministicFissionVerifier?.accepted === true}`,
      `claim=${deterministicFission.acceptedClaim}`,
      `selected=${deterministicFission.deterministicFissionVerifier?.selectedPath ?? 'none'}`,
      `kernel=${deterministicFission.deterministicFissionVerifier?.selectedKernel ?? 'none'}`,
      `artifact=${deterministicFissionPath}`,
      `failures=${(deterministicFission.deterministicFissionVerifier?.failures ?? []).join('|')}`,
    ].join(' '),
  );

  const hotDelta2Edit = deviceEditForRun(generatedDeviceResult.editedDevice, {
    attempt: 1,
    runMode: 'hot_delta_2',
  });
  const hotDelta2Device = hotDelta2Edit.edited;
  if (hotDelta2Device === generatedDeviceResult.editedDevice) {
    throw new Error('hot delta 2 edit generator did not produce a distinct device source');
  }
  const hotDelta2BaselineShot = CFG.captureArtifacts
    ? await assertMcpScreenshot(
        'mcp screenshot before hmr hot delta 2',
        'before-hmr-2',
        null,
        {
          minVisibleSamples: CFG.visualDeltaMinSamples,
          captureWindowMs: CFG.visualDeltaWindowMs,
          sampleIntervalMs: CFG.visualDeltaSampleIntervalMs,
        },
      )
    : null;
  const hotDelta2EditHash = deviceEditHash({
    selectedPath: split.roles.device,
    beforeSource: split.files[split.roles.device],
    afterSource: hotDelta2Device,
    editKind: 'different_gpu_edit',
  });
  const hotDelta2Result = await compileGeneratedDevice(split, hotDelta2Device, {
    metricScope: 'hot_delta_2',
    cacheState: 'compiler_cache_warm',
    editId: `hot-delta-2:${sha256Hex(hotDelta2EditHash).slice(0, 16)}`,
    editHash: hotDelta2EditHash,
    editKind: 'different_gpu_edit',
    differentEdit: hotDelta2EditHash !== hotDelta1EditHash,
    waitRecordLabel: 'mcp wait_hmr proof gate hot delta 2',
  });
  record('device edit compile via MCP hot delta 2', 'pass', split.roles.device);
  const hotDelta2IdentityProof = generatedDeviceEditIdentityProof(
    hotDelta2Result,
    split,
    hotDelta2EditHash,
  );
  record(
    'generated device file used for HMR hot delta 2',
    hotDelta2IdentityProof.accepted ? 'pass' : 'fail',
    JSON.stringify(hotDelta2IdentityProof),
  );
  if (!hotDelta2IdentityProof.accepted) {
    throw agentSplitRefusalError(
      'generated device edit identity proof failed for hot delta 2',
      'agent_split_hot_delta_2_identity_refused',
    );
  }
  const hotDelta2ReloadProof = fullRuntimeGpuHmrProofFromResult(hotDelta2Result);
  record(
    'device-only GPU HMR observed hot delta 2',
    hotDelta2ReloadProof.accepted ? 'pass' : 'fail',
    JSON.stringify(hotDelta2ReloadProof),
  );
  if (!hotDelta2ReloadProof.accepted) {
    throw agentSplitRefusalError(
      'full-runtime GPU HMR proof failed for hot delta 2',
      'agent_split_hot_delta_2_runtime_refused',
    );
  }
  const afterHotDelta2Shot = await assertMcpScreenshot(
    'mcp screenshot after hmr hot delta 2',
    'after-hmr-2',
    hotDelta2Result.wait,
    CFG.captureArtifacts && afterShot
      ? {
          minVisibleSamples: CFG.visualDeltaMinSamples,
          captureWindowMs: CFG.visualDeltaWindowMs,
          sampleIntervalMs: CFG.visualDeltaSampleIntervalMs,
        }
      : {},
  );
  if (CFG.captureArtifacts && hotDelta2BaselineShot) {
    const hotDelta2VisualDelta = await assertVisualDelta(
      hotDelta2BaselineShot,
      afterHotDelta2Shot,
      'hot-delta-2-diff',
      'mcp screenshot visual delta hot delta 2',
    );
    const hotDelta2Proof = withRunModeVisualLedgerProof({
      proof: {
      ...runModeProofIdentity(split),
      ...waitProofFields(hotDelta2Result),
      acceptedForGpuHmr: false,
      accepted_for_gpu_hmr: false,
      gpuHmrSuccess: false,
      gpu_hmr_success: false,
      gpuHmrAcceptanceAuthority: 'pending_visual_runtime_proof_ledger_recompute',
      gpu_hmr_acceptance_authority: 'pending_visual_runtime_proof_ledger_recompute',
      runMode: hotDelta2Result.timingMetrics,
      run_mode: hotDelta2Result.timingMetrics,
      timingMetrics: hotDelta2Result.timingMetrics,
      timing_metrics: hotDelta2Result.timingMetrics,
      sourceFirstIngestion,
      source_first_ingestion: sourceFirstIngestion,
      deviceEditMutation: hotDelta2Edit.mutation,
      device_edit_mutation: hotDelta2Edit.mutation,
      sourceBaselineProof: hotDelta2Result.sourceBaselineProof,
      source_baseline_proof: hotDelta2Result.sourceBaselineProof,
      refreshedSourceBaselineProof: hotDelta2Result.refreshedSourceBaselineProof,
      refreshed_source_baseline_proof: hotDelta2Result.refreshedSourceBaselineProof,
      visualArtifacts: hotDelta2VisualDelta.visualArtifacts,
      visual_artifacts: hotDelta2VisualDelta.visual_artifacts,
      visualSemanticProbes: hotDelta2VisualDelta.visualSemanticProbes,
      visual_semantic_probes: hotDelta2VisualDelta.visual_semantic_probes,
      evidenceRefs: hotDelta2VisualDelta.visualSemanticProbes?.evidenceRefs ?? [],
      evidence_refs: hotDelta2VisualDelta.visual_semantic_probes?.evidence_refs ?? [],
      visualMetrics: {
        changedPixelRatio: hotDelta2VisualDelta.changedRatio,
        meanAbsDelta8bit: hotDelta2VisualDelta.meanAbs,
        visiblePixelCount: afterHotDelta2Shot.second?.visiblePixels ?? afterHotDelta2Shot.first?.visiblePixels ?? null,
        baselineSeq: hotDelta2VisualDelta.baselineSeq,
        selectedSeq: hotDelta2VisualDelta.selectedSeq,
        selectedFrameCaptureAfterEpochDispatch: hotDelta2VisualDelta.selectedFrameCaptureAfterEpochDispatch,
      },
      },
      visualDelta: hotDelta2VisualDelta,
      beforeShot: hotDelta2BaselineShot,
      afterShot: afterHotDelta2Shot,
      wait: hotDelta2Result.wait,
    });
    const hotDelta2ProfileEvidence = typedValidationProfileEvidence({
      proof: hotDelta2Proof,
      split,
      visualDelta: hotDelta2VisualDelta,
    });
    const hotDelta2Path = await writeRunModeProofArtifact('run-mode-hot-delta-2', {
      ...hotDelta2Proof,
      validationProfileEvidence: hotDelta2ProfileEvidence,
      validation_profile_evidence: hotDelta2ProfileEvidence,
    });
    record('run-mode hot delta 2 proof artifact', 'pass', hotDelta2Path);
  }

  const negativeEdit = negativeAbiChangingEdit(split.files[split.roles.device]);
  if (negativeEdit.accepted) {
    const negativeEditHash = deviceEditHash({
      selectedPath: split.roles.device,
      beforeSource: split.files[split.roles.device],
      afterSource: negativeEdit.edited,
      editKind: 'negative_edit',
    });
    const negativePath = await writeNegativeEditRefusalArtifact('negative-edit-refusal', {
      ...runModeProofIdentity(split),
      ...(hotDelta1RunModeCoverageSupport ? {
        runModeCoverageSupport: hotDelta1RunModeCoverageSupport,
        run_mode_coverage_support: hotDelta1RunModeCoverageSupport,
      } : {}),
      sourceFirstIngestion,
      source_first_ingestion: sourceFirstIngestion,
      reasons: negativeEdit.reasons,
      unsupportedReasons: negativeEdit.reasons,
      unsupported_reasons: negativeEdit.reasons,
      executableStaticCheck: negativeEdit.executableStaticCheck,
      executable_static_check: negativeEdit.executableStaticCheck,
      sourceOccurrenceProof: negativeEdit.sourceOccurrenceProof,
      source_occurrence_proof: negativeEdit.sourceOccurrenceProof,
      runMode: {
        schemaVersion: 'synthi.gpu.hmr.runner_timing_metrics.v1',
        metricClock: 'monotonic_ns',
        metric_clock: 'monotonic_ns',
        metricScope: 'hot_delta_2',
        metric_scope: 'hot_delta_2',
        cacheState: 'compiler_cache_warm',
        cache_state: 'compiler_cache_warm',
        editId: `negative-edit:${sha256Hex(negativeEditHash).slice(0, 16)}`,
        edit_id: `negative-edit:${sha256Hex(negativeEditHash).slice(0, 16)}`,
        editHash: negativeEditHash,
        edit_hash: negativeEditHash,
        editKind: 'negative_edit',
        edit_kind: 'negative_edit',
        differentEdit: true,
        different_edit: true,
      },
      negativeEditProof: {
        ...negativeEdit.negativeEditProof,
        editHash: negativeEditHash,
        edit_hash: negativeEditHash,
      },
      negative_edit_proof: {
        ...negativeEdit.negativeEditProof,
        editHash: negativeEditHash,
        edit_hash: negativeEditHash,
      },
    });
    record('negative ABI edit refused before GPU HMR', 'pass', negativePath);
  } else {
    record('negative ABI edit refused before GPU HMR', 'warn', negativeEdit.reasons.join('|'));
  }

  await sleep(2000);
  const afterReload = await readWorkerLogTail(4 * 1024 * 1024, secondStart?.at ? { since: secondStart.at } : {});
  const crashMatch = afterReload.match(/Runner process (?:has already )?exited[^\n]*|SIGSEGV|core dumped|module loading could begin|module-load-failed|mismatch rollback|Device reload result .*Failed/);
  record('runner stayed alive after GPU HMR', crashMatch ? 'fail' : 'pass', crashMatch?.[0] || 'no runner crash marker');

  await writeResults();
  console.log(`url: ${CFG.frontendUrl}/workspace/${CFG.slug}`);
  const failures = results.filter((r) => r.status === 'fail');
  if (failures.length) process.exitCode = 1;
}

async function writeResults() {
  await mkdir(LOG_DIR, { recursive: true });
  await mkdir(ARTIFACT_DIR, { recursive: true });
  const sanitizedResults = sanitizeProofLogValue(results);
  await writeFile(RESULTS_JSON, JSON.stringify(sanitizedResults, null, 2));
  const resultText = resultTextFromRows(sanitizedResults);
  await writeFile(RESULTS_TXT, resultText);
  const archivedJson = path.join(ARTIFACT_DIR, `${RESULTS_BASENAME}.json`);
  const archivedTxt = path.join(ARTIFACT_DIR, `${RESULTS_BASENAME}.txt`);
  await writeFile(archivedJson, JSON.stringify(sanitizedResults, null, 2));
  await writeFile(archivedTxt, resultText);
  console.log(`results: ${RESULTS_TXT}`);
  console.log(`archived results: ${archivedTxt}`);
}

async function runAgentSplitTerminal() {
  activeAgentSplitTestTiming = createAgentSplitTestTimingV2Lifecycle({
    nowNs: () => process.hrtime.bigint(),
  });
  let timingTerminal = classifyAgentSplitTimingTerminal();

  try {
    try {
      assertAgentProfileSelectionConfigured();
    } catch (error) {
      throw tagAgentSplitTimingError(error, {
        outcome: 'refused',
        category: 'source_input_refusal',
        reasonCode: 'agent_split_source_input_refused',
      });
    }
    await run();
    if (results.some((row) => row.status === 'fail')) {
      timingTerminal = Object.freeze({
        outcome: 'failed',
        category: 'recorded_failure',
        reasonCode: 'agent_split_recorded_failure',
      });
    }
  } catch (error) {
    activeAgentSplitTestTiming.closeActivePhases();
    timingTerminal = classifyAgentSplitTimingTerminal(error);
    record('fatal', 'fail', error?.stack || error?.message || String(error));
  }

  activeAgentSplitTestTiming.closeActivePhases();
  activeAgentSplitTestTiming.markUnavailable('retirement', TEST_TIMING_RETIREMENT_REASON);
  try {
    await stopMcp();
  } catch (error) {
    if (timingTerminal.outcome === 'pass') {
      timingTerminal = Object.freeze({
        outcome: 'failed',
        category: 'cleanup_failure',
        reasonCode: 'agent_split_mcp_cleanup_failure',
      });
    }
    record('mcp cleanup', 'fail', error?.message || String(error));
  }

  activeAgentSplitTestTiming.beginPhase('proof_finalization');
  try {
    await writeResults();
  } catch (error) {
    if (timingTerminal.outcome === 'pass') {
      timingTerminal = Object.freeze({
        outcome: 'failed',
        category: 'result_persistence_failure',
        reasonCode: 'agent_split_result_persistence_failure',
      });
    }
    record('result persistence', 'fail', error?.message || String(error));
  } finally {
    activeAgentSplitTestTiming.finishPhase('proof_finalization');
  }

  retainAgentSplitTestTiming(
    activeAgentSplitTestTiming.finalize({
      outcome: timingTerminal.outcome,
      terminalReason: timingTerminal.reasonCode,
    }),
    timingTerminal,
  );
  writeResultCheckpointSync('terminal_timing_v2');
  console.log(`test timing: ${TEST_TIMING_JSON}`);
  if (timingTerminal.outcome !== 'pass') process.exitCode = 1;
}

async function main() {
  if (process.argv.includes('--self-check')) {
    try {
      selfCheckAgentVisualProfile();
      await selfCheckSemanticVisualProbeEvidence();
      selfCheckRunModeVisualLedgerClockDomain();
      await selfCheckProofFinalizationRetry();
      selfCheckRequestedProofStateGate();
      selfCheckColdAiSplitProof();
      selfCheckMcpStartupCleanup();
      await selfCheckHttpWorkspaceTimeoutDiagnostics();
    } catch (err) {
      console.error(err.stack || err.message);
      process.exitCode = 1;
    }
    return;
  }

  installEmergencyResultHandlers();
  await runAgentSplitTerminal();
}

if (process.argv[1] && path.resolve(process.argv[1]) === __filename) {
  main().catch((error) => {
    try {
      recordEmergencyResult(
        'unhandled_rejection',
        error?.stack || error?.message || String(error),
      );
    } catch (emergencyError) {
      console.error(emergencyError?.stack || emergencyError?.message || String(emergencyError));
    }
    process.exitCode = 1;
  });
}
