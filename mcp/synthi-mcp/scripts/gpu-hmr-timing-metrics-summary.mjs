#!/usr/bin/env node
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  GPU_HMR_TIMING_METRICS_SCHEMA_VERSION,
  GPU_HMR_TIMING_TELEMETRY_AUTHORITY,
  externalProjectTimingMetrics,
  hipModuleRuntimeTimingMetrics,
  hiprtWarmTimingMetrics,
  realRocmTimingMetrics,
  webGpuRuntimeComputeTimingMetrics,
  webGpuRuntimeVisualTimingMetrics,
} from './lib/gpu-hmr-timing-metrics.mjs';
import {
  GPU_HMR_TEST_TIMING_PHASE_KEYS,
  GPU_HMR_TEST_TIMING_SCHEMA,
  GpuHmrTestTimingRecorder,
  validateGpuHmrTestTiming,
} from './lib/gpu-hmr-test-timing-v2.mjs';

const __filename = fileURLToPath(import.meta.url);
const scriptsDir = path.dirname(__filename);
const mcpRoot = path.resolve(scriptsDir, '..');
const repoRoot = path.resolve(mcpRoot, '..', '..');
const GPU_HMR_TEST_TIMING_ALIASES = new Set([
  'testTiming',
  'test_timing',
  'timingV2',
  'timing_v2',
]);

function parseArgs(argv) {
  const args = {
    outputDir: path.join(mcpRoot, '.gpu-hmr-test-logs', 'timing-metrics'),
    format: 'both',
    latestPerProfile: true,
    includeInvalidated: false,
    selfCheck: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--all') {
      args.latestPerProfile = false;
    } else if (arg === '--include-invalidated') {
      args.includeInvalidated = true;
    } else if (arg === '--format') {
      args.format = argv[++i] ?? args.format;
    } else if (arg === '--output-dir') {
      args.outputDir = path.resolve(argv[++i] ?? args.outputDir);
    } else if (arg === '--help') {
      args.help = true;
    } else if (arg === '--self-check') {
      args.selfCheck = true;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return args;
}

function usage() {
  return [
    'Usage: node scripts/gpu-hmr-timing-metrics-summary.mjs [--all] [--include-invalidated] [--format json|markdown|both] [--output-dir DIR] [--self-check]',
    '',
    'Collects GPU HMR proof reports and writes a normalized timing schema for apples-to-apples comparison.',
  ].join('\n');
}

async function pathExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function walkJsonFiles(root) {
  if (!(await pathExists(root))) return [];
  const out = [];
  const stack = [root];

  while (stack.length > 0) {
    const current = stack.pop();
    const entries = await fs.readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
      } else if (entry.isFile() && entry.name.endsWith('.json')) {
        out.push(fullPath);
      }
    }
  }

  return out;
}

async function readJson(filePath) {
  try {
    return JSON.parse(await fs.readFile(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function finiteNumber(value) {
  if (value === undefined || value === null || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function objectOrEmpty(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function isGpuHmrTestTimingV2Record(value) {
  return value !== null
    && typeof value === 'object'
    && !Array.isArray(value)
    && (
      value.schema === GPU_HMR_TEST_TIMING_SCHEMA
      || value.schemaVersion === GPU_HMR_TEST_TIMING_SCHEMA
    );
}

function canonicalTimingRecordValue(value, ancestors = new Set()) {
  if (value === null) return 'null';
  if (typeof value === 'string') return `string:${JSON.stringify(value)}`;
  if (typeof value === 'boolean') return `boolean:${value}`;
  if (typeof value === 'number') {
    if (Number.isNaN(value)) return 'number:NaN';
    if (value === Number.POSITIVE_INFINITY) return 'number:+Infinity';
    if (value === Number.NEGATIVE_INFINITY) return 'number:-Infinity';
    if (Object.is(value, -0)) return 'number:-0';
    return `number:${value}`;
  }
  if (typeof value === 'bigint') return `bigint:${value}`;
  if (typeof value === 'undefined') return 'undefined';

  if (typeof value !== 'object') {
    return `${typeof value}:${JSON.stringify(String(value))}`;
  }
  if (ancestors.has(value)) {
    throw new TypeError('gpu_hmr_test_timing_record_must_be_acyclic');
  }

  ancestors.add(value);
  let canonical;
  if (Array.isArray(value)) {
    canonical = `array:[${value
      .map((entry) => canonicalTimingRecordValue(entry, ancestors))
      .join(',')}]`;
  } else {
    canonical = `object:{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalTimingRecordValue(value[key], ancestors)}`)
      .join(',')}}`;
  }
  ancestors.delete(value);
  return canonical;
}

function gpuHmrTestTimingV2RecordIdentity(record) {
  const canonicalRecord = canonicalTimingRecordValue(record);
  return `sha256:${createHash('sha256').update(canonicalRecord).digest('hex')}`;
}

function phaseDurationMs(phase) {
  if (phase?.durationNs === undefined || phase?.durationNs === null) return null;
  try {
    const durationNs = BigInt(String(phase.durationNs));
    if (durationNs < 0n) return null;
    const durationMs = Number(durationNs) / 1_000_000;
    return Number.isFinite(durationMs) ? durationMs : null;
  } catch {
    return null;
  }
}

export function discoverGpuHmrTestTimingV2Records(json) {
  if (isGpuHmrTestTimingV2Record(json)) {
    return [{
      record: json,
      recordPath: '$',
      alias: null,
      recordIdentity: gpuHmrTestTimingV2RecordIdentity(json),
    }];
  }

  const candidates = [];
  const discoveredIdentities = new Set();
  const retainCandidate = (record, recordPath, alias) => {
    const recordIdentity = gpuHmrTestTimingV2RecordIdentity(record);
    if (discoveredIdentities.has(recordIdentity)) return;
    discoveredIdentities.add(recordIdentity);
    candidates.push({ record, recordPath, alias, recordIdentity });
  };
  const visit = (value, location) => {
    if (value === null || typeof value !== 'object') return;

    if (Array.isArray(value)) {
      value.forEach((entry, index) => visit(entry, `${location}[${index}]`));
      return;
    }

    for (const [key, nested] of Object.entries(value)) {
      const nestedLocation = `${location}.${key}`;
      if (GPU_HMR_TEST_TIMING_ALIASES.has(key)) {
        retainCandidate(nested, nestedLocation, key);
      } else {
        visit(nested, nestedLocation);
      }
    }
  };

  visit(json, '$');
  return candidates;
}

function gpuHmrTestTimingV2Metrics(record) {
  const timing = objectOrEmpty(record);
  return {
    source: 'gpu_hmr_test_timing_v2',
    schemaVersion: timing.schemaVersion ?? timing.schema ?? null,
    metricClock: timing.clock ?? null,
    metricUnit: 'ms',
    metricScope: 'generic_test_timing_v2',
    proofMode: 'generic_test_timing_v2',
    totalWallMs: phaseDurationMs(timing.phases?.total_wall),
  };
}

function classifyGpuHmrTestTimingV2(record, recordPath, alias, recordIdentity) {
  return {
    kind: 'gpu_hmr_test_timing_v2',
    metrics: gpuHmrTestTimingV2Metrics(record),
    testTimingRecord: record,
    timingValidation: validateGpuHmrTestTiming(record),
    recordPath,
    recordAlias: alias,
    recordIdentity: recordIdentity ?? gpuHmrTestTimingV2RecordIdentity(record),
  };
}

function eventsByEpoch(events, epoch) {
  return Array.isArray(events)
    ? objectOrEmpty(events.find((event) => Number(event?.epoch) === Number(epoch)))
    : {};
}

function eventTimestampNs(event) {
  return finiteNumber(
    event.timestamp_monotonic_ns
    ?? event.timestampMonotonicNs
    ?? event.timestamp_ns
    ?? event.timestampNs
    ?? event.timestamp,
  );
}

function hardenedHipModuleProofAccepted(json) {
  const claimBoundary = objectOrEmpty(json?.claimBoundary ?? json?.claim_boundary);
  const negativeEditRefusal = objectOrEmpty(json?.negativeEditRefusal ?? json?.negative_edit_refusal);
  const executableStaticCheck = objectOrEmpty(
    negativeEditRefusal.executableStaticCheck ?? negativeEditRefusal.executable_static_check,
  );
  const timingVisual = objectOrEmpty(
    json?.timingMetrics?.visualEvidence
    ?? json?.timing_metrics?.visual_evidence,
  );
  const runtimeTrace = objectOrEmpty(json?.runtimeTrace ?? json?.runtime_trace);
  const loader = eventsByEpoch(runtimeTrace.loaderEvents ?? runtimeTrace.loader_events, 2);
  const publish = eventsByEpoch(runtimeTrace.epochEvents ?? runtimeTrace.epoch_events, 2);
  const dispatch = eventsByEpoch(runtimeTrace.dispatchEvents ?? runtimeTrace.dispatch_events, 2);
  const output = eventsByEpoch(runtimeTrace.outputEvents ?? runtimeTrace.output_events, 2);
  const retirement = objectOrEmpty(runtimeTrace.retirementEvent ?? runtimeTrace.retirement_event);
  const timestamps = [
    eventTimestampNs(loader),
    eventTimestampNs(publish),
    eventTimestampNs(dispatch),
    eventTimestampNs(output),
    eventTimestampNs(retirement),
  ];
  return claimBoundary.proofAuthority === 'scoped_native_hip_module_runtime_trace'
    && claimBoundary.executionBoundary === 'standalone_hip_module_probe'
    && claimBoundary.arbitraryTargetRuntimeAccepted === false
    && claimBoundary.arbitraryLibraryAccepted === false
    && claimBoundary.broadHipApplicationAcceptance === false
    && negativeEditRefusal.refusalProven === true
    && negativeEditRefusal.gpuHmrSuccess === false
    && executableStaticCheck.accepted === true
    && executableStaticCheck.signatureChanged === true
    && executableStaticCheck.negativeKernelFound === true
    && finiteNumber(timingVisual.screenshotCount ?? timingVisual.screenshot_count) === 0
    && timingVisual.accepted === false
    && timestamps.every((timestamp) => timestamp !== null);
}

function withProofContext(metrics, json) {
  return {
    ...metrics,
    proofId: json?.proofId ?? json?.proof_id ?? metrics?.proofId ?? null,
    profileTargetId: json?.profile?.targetId ?? json?.profile?.target_id ?? metrics?.profileTargetId ?? null,
  };
}

function classifyReport(json, filePath) {
  if (!json || typeof json !== 'object') return null;

  if (isGpuHmrTestTimingV2Record(json)) {
    return classifyGpuHmrTestTimingV2(json, '$', null);
  }

  if (json.timingMetrics?.schemaVersion === GPU_HMR_TIMING_METRICS_SCHEMA_VERSION) {
    if (json.timingMetrics.source === 'webgpu_runtime_compute') {
      return {
        kind: 'webgpu_runtime_compute',
        metrics: withProofContext(webGpuRuntimeComputeTimingMetrics(json), json),
      };
    }
    if (
      json.timingMetrics.source === 'hip_module_runtime'
      && hardenedHipModuleProofAccepted(json) !== true
    ) {
      return null;
    }
    if (json.timingMetrics.source === 'hip_module_runtime') {
      return {
        kind: 'hip_module_runtime',
        metrics: withProofContext(hipModuleRuntimeTimingMetrics(json), json),
      };
    }
    return {
      kind: json.timingMetrics.source ?? 'precomputed',
      metrics: withProofContext(json.timingMetrics, json),
    };
  }

  const schemaVersion = String(json.schemaVersion ?? '');
  if (
    String(json.schema ?? '').includes('webgpu_runtime_visual_proof')
    || String(json.proofId ?? '').startsWith('webgpu-runtime-visual-proof:')
  ) {
    return {
      kind: 'webgpu_runtime_visual',
      metrics: webGpuRuntimeVisualTimingMetrics(json),
    };
  }

  if (
    String(json.schema ?? '').includes('webgpu_runtime_compute_proof')
    || String(json.proofId ?? '').startsWith('webgpu-runtime-compute-proof:')
  ) {
    return {
      kind: 'webgpu_runtime_compute',
      metrics: webGpuRuntimeComputeTimingMetrics(json),
    };
  }

  if (
    String(json.schema ?? '').includes('hip_module_runtime_proof')
    || String(json.proofId ?? '').startsWith('hip-module-runtime-proof:')
  ) {
    if (hardenedHipModuleProofAccepted(json) !== true) return null;
    return {
      kind: 'hip_module_runtime',
      metrics: withProofContext(hipModuleRuntimeTimingMetrics(json), json),
    };
  }

  if (schemaVersion.includes('external_project_profile.report')) {
    return {
      kind: 'external_project_profile',
      metrics: externalProjectTimingMetrics(json),
    };
  }

  if (
    schemaVersion === 'synthi.hiprt.warm_visual_proof.v2'
    || String(json.schema ?? '').includes('hiprt.warm_visual_proof')
    || String(json.proofId ?? '').startsWith('hiprt-warm-runtime-proof:')
  ) {
    return {
      kind: 'hiprt_warm_runtime',
      metrics: hiprtWarmTimingMetrics(json),
    };
  }

  if (
    schemaVersion.includes('real_rocm')
    || Array.isArray(json.phases) && json.phases.some((phase) => String(phase?.name ?? '').includes('split/HMR'))
    || json.hiprt_runtime_probe
  ) {
    return {
      kind: 'real_rocm_validation',
      metrics: realRocmTimingMetrics(json),
    };
  }

  return null;
}

export function classifyReports(json, filePath) {
  const timingCandidates = discoverGpuHmrTestTimingV2Records(json);
  if (timingCandidates.some((candidate) => candidate.recordPath === '$')) {
    return timingCandidates.map((candidate) => classifyGpuHmrTestTimingV2(
      candidate.record,
      candidate.recordPath,
      candidate.alias,
      candidate.recordIdentity,
    ));
  }

  const classified = [];
  const legacy = classifyReport(json, filePath);
  if (legacy) classified.push(legacy);
  for (const candidate of timingCandidates) {
    classified.push(classifyGpuHmrTestTimingV2(
      candidate.record,
      candidate.recordPath,
      candidate.alias,
      candidate.recordIdentity,
    ));
  }
  return classified;
}

function includesPathPart(filePath, part) {
  return filePath.split(path.sep).includes(part);
}

export function hasMeaningfulMetrics(metrics, kind = null) {
  if (kind === 'gpu_hmr_test_timing_v2') return true;

  const timingKeys = [
    'totalWallMs',
    'setupBuildMs',
    'adapterBuildMs',
    'runtimeReadyMs',
    'initialCompileWallMs',
    'sourceWriteMs',
    'aiDeltaWallMs',
    'hotHmrCompileWallMs',
    'sameProcessLiveRecompileMs',
    'sameProcessTriggerWaitMs',
    'hotReloadSignalMs',
    'editToFirstVisualMs',
    'beforeCaptureMs',
    'afterCaptureMs',
    'visualDiffMs',
    'teardownMs',
  ];

  return timingKeys.some((key) => Number.isFinite(metrics?.[key]))
    || metrics?.visualEvidence?.screenshotCount > 0
    || metrics?.visualEvidence?.changedPixelRatio > 0
    || metrics?.visualEvidence?.meanAbsDelta8bit > 0;
}

async function collectCandidates(options) {
  const roots = [
    path.join(mcpRoot, '.gpu-hmr-test-logs'),
    path.join(mcpRoot, '.gpu-hmr-test-artifacts'),
    path.join(repoRoot, 'tmp', 'validation-runs'),
    path.join(repoRoot, 'tmp', 'real-rocm'),
  ];

  const files = [];
  for (const root of roots) {
    files.push(...await walkJsonFiles(root));
  }

  const rows = [];
  for (const filePath of files) {
    if (!options.includeInvalidated && includesPathPart(filePath, 'invalidated')) continue;
    const json = await readJson(filePath);
    const classifiedReports = classifyReports(json, filePath)
      .filter((classified) => hasMeaningfulMetrics(classified.metrics, classified.kind));
    if (classifiedReports.length === 0) continue;

    const stat = await fs.stat(filePath);
    for (const classified of classifiedReports) {
      rows.push({
        ...classified,
        filePath,
        updatedAt: stat.mtime.toISOString(),
      });
    }
  }

  return deduplicateGpuHmrTestTimingV2Rows(rows);
}

export function deduplicateGpuHmrTestTimingV2Rows(rows) {
  const retainedIdentities = new Set();
  return rows.filter((row) => {
    if (!Object.hasOwn(row, 'testTimingRecord')) return true;
    const recordIdentity = row.recordIdentity
      ?? gpuHmrTestTimingV2RecordIdentity(row.testTimingRecord);
    if (retainedIdentities.has(recordIdentity)) return false;
    retainedIdentities.add(recordIdentity);
    return true;
  });
}

function latestPerProfile(rows) {
  const byKey = new Map();
  for (const row of rows) {
    const isTestTimingRecord = Object.hasOwn(row, 'testTimingRecord');
    const recordIdentity = isTestTimingRecord
      ? row.recordIdentity ?? gpuHmrTestTimingV2RecordIdentity(row.testTimingRecord)
      : null;
    const fallbackProfile = isTestTimingRecord ? recordIdentity : row.filePath;
    const keyParts = [
      row.metrics?.source ?? row.kind ?? 'unknown',
      row.metrics?.profileId ?? row.metrics?.projectName ?? fallbackProfile,
      row.metrics?.proofMode ?? 'unknown',
      row.metrics?.metricScope ?? row.metrics?.metric_scope ?? 'unknown_scope',
    ];
    const key = keyParts.join('|');

    const existing = byKey.get(key);
    if (!existing || existing.updatedAt < row.updatedAt) {
      byKey.set(key, row);
    }
  }

  return [...byKey.values()];
}

function compactTestTimingPhase(phase) {
  const timingPhase = objectOrEmpty(phase);
  return {
    state: timingPhase.state ?? null,
    durationNs: timingPhase.durationNs ?? null,
    durationMs: phaseDurationMs(timingPhase),
    reasonCode: timingPhase.reasonCode ?? null,
  };
}

function compactGpuHmrTestTimingV2Row(row) {
  const record = objectOrEmpty(row.testTimingRecord);
  const validation = row.timingValidation ?? validateGpuHmrTestTiming(row.testTimingRecord);
  const phases = Object.fromEntries(GPU_HMR_TEST_TIMING_PHASE_KEYS.map((phaseKey) => [
    phaseKey,
    compactTestTimingPhase(record.phases?.[phaseKey]),
  ]));
  const totalWall = objectOrEmpty(record.phases?.total_wall);

  return {
    source: 'gpu_hmr_test_timing_v2',
    schemaVersion: record.schemaVersion ?? record.schema ?? null,
    metricClock: record.clock ?? null,
    metricUnit: 'ms',
    metricScope: 'generic_test_timing_v2',
    cacheState: null,
    startedMonotonicNs: totalWall.startNs ?? null,
    finishedMonotonicNs: totalWall.endNs ?? null,
    durationMonotonicNs: totalWall.durationNs ?? null,
    durationMonotonicMs: phases.total_wall.durationMs,
    proofId: null,
    profileId: null,
    profileTargetId: null,
    projectName: null,
    proofMode: 'generic_test_timing_v2',
    telemetryOnly: true,
    timingOnly: true,
    evidenceAuthority: GPU_HMR_TIMING_TELEMETRY_AUTHORITY,
    proofVerdict: 'not_evaluated_by_timing_summary',
    acceptedForGpuHmr: false,
    gpuHmrSuccess: false,
    reportedStatus: null,
    outcome: record.outcome ?? null,
    visualCapable: record.visualCapable ?? null,
    valid: validation.valid,
    complete: validation.complete,
    validationGaps: [...validation.validationGaps],
    completenessGaps: [...validation.completenessGaps],
    blockingGaps: [...validation.blockingGaps],
    totalWallMs: phases.total_wall.durationMs,
    triggerToVisibleMs: phases.trigger_to_visible.durationMs,
    screenshotCaptureMs: phases.screenshot_capture.durationMs,
    visualAnalysisMs: phases.visual_analysis.durationMs,
    proofFinalizationMs: phases.proof_finalization.durationMs,
    phases,
    recordAlias: row.recordAlias ?? null,
    recordPath: row.recordPath ?? '$',
    recordIdentity: row.recordIdentity ?? gpuHmrTestTimingV2RecordIdentity(record),
    updatedAt: row.updatedAt,
    filePath: path.relative(repoRoot, row.filePath),
  };
}

export function compactRow(row) {
  if (Object.hasOwn(row, 'testTimingRecord')) {
    return compactGpuHmrTestTimingV2Row(row);
  }

  const metrics = row.metrics ?? {};
  return {
    source: metrics.source ?? row.kind,
    schemaVersion: metrics.schemaVersion,
    metricClock: metrics.metricClock,
    metricUnit: metrics.metricUnit,
    metricScope: metrics.metricScope,
    cacheState: metrics.cacheState,
    startedMonotonicNs: metrics.clockEvidence?.startedMonotonicNs ?? metrics.startedMonotonicNs ?? null,
    finishedMonotonicNs: metrics.clockEvidence?.finishedMonotonicNs ?? metrics.finishedMonotonicNs ?? null,
    durationMonotonicNs: metrics.clockEvidence?.durationMonotonicNs ?? metrics.durationMonotonicNs ?? null,
    durationMonotonicMs: metrics.clockEvidence?.durationMonotonicMs ?? metrics.durationMonotonicMs ?? null,
    proofId: metrics.proofId ?? null,
    profileId: metrics.profileId,
    profileTargetId: metrics.profileTargetId ?? null,
    projectName: metrics.projectName,
    proofMode: metrics.proofMode,
    telemetryOnly: true,
    evidenceAuthority: metrics.evidenceAuthority ?? GPU_HMR_TIMING_TELEMETRY_AUTHORITY,
    proofVerdict: metrics.proofVerdict ?? 'not_evaluated_by_timing_summary',
    reportedStatus: metrics.reportedStatus ?? metrics.status ?? null,
    totalWallMs: metrics.totalWallMs,
    setupBuildMs: metrics.setupBuildMs,
    adapterBuildMs: metrics.adapterBuildMs,
    runtimeReadyMs: metrics.runtimeReadyMs,
    initialCompileWallMs: metrics.initialCompileWallMs,
    sourceWriteMs: metrics.sourceWriteMs,
    modelAvailabilityCheckMs: metrics.modelAvailabilityCheckMs,
    aiDeltaWallMs: metrics.aiDeltaWallMs,
    hotHmrCompileWallMs: metrics.hotHmrCompileWallMs,
    sameProcessLiveRecompileMs: metrics.sameProcessLiveRecompileMs,
    sameProcessTriggerWaitMs: metrics.sameProcessTriggerWaitMs,
    hotReloadSignalMs: metrics.hotReloadSignalMs,
    editToFirstVisualMs: metrics.editToFirstVisualMs,
    beforeCaptureMs: metrics.beforeCaptureMs,
    afterCaptureMs: metrics.afterCaptureMs,
    visualDiffMs: metrics.visualDiffMs,
    teardownMs: metrics.teardownMs,
    screenshotCount: metrics.visualEvidence?.screenshotCount ?? null,
    changedPixelRatio: metrics.visualEvidence?.changedPixelRatio ?? null,
    meanAbsDelta8bit: metrics.visualEvidence?.meanAbsDelta8bit ?? null,
    reportedVisualAccepted:
      metrics.visualEvidence?.reportedAccepted
      ?? metrics.visualEvidence?.accepted
      ?? null,
    reportedComputeCardAccepted:
      metrics.computeEvidence?.computeCardReportedAccepted
      ?? metrics.computeEvidence?.computeCardAccepted
      ?? null,
    renderedCardPng: metrics.computeEvidence?.renderedCardPng ?? null,
    rawReadbackHash: metrics.computeEvidence?.rawReadbackHash ?? null,
    rawReadbackByteLength: metrics.computeEvidence?.rawReadbackByteLength ?? null,
    normalizedTimings: metrics.normalizedTimings ?? null,
    clockEvidence: metrics.clockEvidence ?? null,
    updatedAt: row.updatedAt,
    filePath: path.relative(repoRoot, row.filePath),
  };
}

function value(value) {
  if (value === null || value === undefined || value === '') return '';
  return String(value);
}

function markdownTable(rows) {
  const legacyColumns = [
    'source',
    'profileId',
    'metricClock',
    'metricScope',
    'cacheState',
    'reportedStatus',
    'proofVerdict',
    'totalWallMs',
    'durationMonotonicMs',
    'setupBuildMs',
    'adapterBuildMs',
    'initialCompileWallMs',
    'modelAvailabilityCheckMs',
    'aiDeltaWallMs',
    'hotHmrCompileWallMs',
    'sameProcessLiveRecompileMs',
    'hotReloadSignalMs',
    'editToFirstVisualMs',
    'changedPixelRatio',
    'meanAbsDelta8bit',
    'reportedVisualAccepted',
    'reportedComputeCardAccepted',
  ];
  const includesTestTimingV2 = rows.some((row) => row.source === 'gpu_hmr_test_timing_v2');
  const columns = includesTestTimingV2
    ? [
      ...legacyColumns.slice(0, 6),
      'outcome',
      'valid',
      'complete',
      'blockingGaps',
      ...legacyColumns.slice(6, 8),
      'triggerToVisibleMs',
      'screenshotCaptureMs',
      'visualAnalysisMs',
      'proofFinalizationMs',
      ...legacyColumns.slice(8),
    ]
    : legacyColumns;
  const header = `| ${columns.join(' | ')} |`;
  const divider = `| ${columns.map(() => '---').join(' | ')} |`;
  const body = rows.map((row) => `| ${columns.map((column) => value(row[column])).join(' | ')} |`);
  return [
    `# GPU HMR Timing Metrics`,
    '',
    `Schema: \`${GPU_HMR_TIMING_METRICS_SCHEMA_VERSION}\``,
    ...(includesTestTimingV2
      ? [`Generic test timing records: \`${GPU_HMR_TEST_TIMING_SCHEMA}\``]
      : []),
    '',
    includesTestTimingV2
      ? 'Timing metrics are telemetry only; validation-matrix proof ledgers are the acceptance authority. Reported status/accepted columns and v2 outcomes are copied from source artifacts for timing context and must not be treated as GPU HMR acceptance.'
      : 'Timing metrics are telemetry only; validation-matrix proof ledgers are the acceptance authority. Reported status/accepted columns are copied from source artifacts for timing context and must not be treated as GPU HMR acceptance.',
    '',
    header,
    divider,
    ...body,
    '',
  ].join('\n');
}

function assertSelfCheck(condition, message) {
  if (!condition) throw new Error(`Timing metrics summary self-check failed: ${message}`);
}

function controlledSelfCheckClock(initialNs) {
  let currentNs = initialNs;
  return {
    now: () => currentNs,
    tick: (durationNs) => {
      currentNs += durationNs;
    },
  };
}

function measureSelfCheckPhase(recorder, clock, phaseKey, durationNs) {
  recorder.startPhase(phaseKey);
  clock.tick(durationNs);
  recorder.finishPhase(phaseKey);
}

function compactSelfCheckReport(report, name) {
  const filePath = path.join(repoRoot, 'tmp', `${name}.json`);
  const classified = classifyReports(report, filePath);
  return {
    classified,
    rows: classified.map((entry) => compactRow({
      ...entry,
      filePath,
      updatedAt: '2026-07-16T00:00:00.000Z',
    })),
  };
}

function runSelfCheck() {
  const row = compactRow({
    kind: 'synthetic',
    updatedAt: '2026-06-07T00:00:00.000Z',
    filePath: path.join(repoRoot, 'tmp', 'synthetic-gpu-hmr-timing.json'),
    metrics: {
      schemaVersion: GPU_HMR_TIMING_METRICS_SCHEMA_VERSION,
      source: 'external_project_profile',
      telemetryOnly: true,
      evidenceAuthority: GPU_HMR_TIMING_TELEMETRY_AUTHORITY,
      proofVerdict: 'not_evaluated_by_timing_summary',
      reportedStatus: 'pass',
      metricClock: 'monotonic_ns',
      metricUnit: 'ms',
      metricScope: 'hot_delta_1',
      cacheState: 'compiler_cache_warm',
      profileId: 'synthetic-gpu-profile',
      status: 'pass',
      totalWallMs: 600,
      modelAvailabilityCheckMs: 2,
      aiDeltaWallMs: 40,
      hotHmrCompileWallMs: 40,
      clockEvidence: {
        metricClock: 'monotonic_ns',
        metricUnit: 'ms',
        startedMonotonicNs: '1000000000',
        finishedMonotonicNs: '1600000000',
        durationMonotonicNs: '600000000',
        durationMonotonicMs: 600,
      },
      normalizedTimings: {
        modelAvailabilityCheckTimeMs: 2,
        deviceCompileWallTimeMs: 40,
        totalValidatorWallTimeMs: 600,
      },
      visualEvidence: {
        screenshotCount: 2,
        changedPixelRatio: 0.25,
        meanAbsDelta8bit: 12,
        accepted: true,
      },
    },
  });

  assertSelfCheck(row.schemaVersion === GPU_HMR_TIMING_METRICS_SCHEMA_VERSION, 'schema version missing');
  assertSelfCheck(row.metricClock === 'monotonic_ns', 'metric clock missing');
  assertSelfCheck(row.metricUnit === 'ms', 'metric unit missing');
  assertSelfCheck(row.metricScope === 'hot_delta_1', 'metric scope missing');
  assertSelfCheck(row.cacheState === 'compiler_cache_warm', 'cache state missing');
  assertSelfCheck(row.telemetryOnly === true, 'telemetry-only marker missing');
  assertSelfCheck(row.evidenceAuthority === GPU_HMR_TIMING_TELEMETRY_AUTHORITY, 'telemetry authority missing');
  assertSelfCheck(row.proofVerdict === 'not_evaluated_by_timing_summary', 'proof verdict boundary missing');
  assertSelfCheck(row.reportedStatus === 'pass', 'reported status missing');
  assertSelfCheck(!('status' in row), 'compact timing row must not expose status as proof authority');
  assertSelfCheck(!('visualAccepted' in row), 'compact timing row must not expose visualAccepted as proof authority');
  assertSelfCheck(!('computeCardAccepted' in row), 'compact timing row must not expose computeCardAccepted as proof authority');
  assertSelfCheck(row.durationMonotonicNs === '600000000', 'duration monotonic ns missing');
  assertSelfCheck(row.durationMonotonicMs === 600, 'duration monotonic ms missing');
  assertSelfCheck(row.modelAvailabilityCheckMs === 2, 'model availability timing missing');
  assertSelfCheck(row.normalizedTimings?.totalValidatorWallTimeMs === 600, 'normalized timings missing');
  assertSelfCheck(row.clockEvidence?.durationMonotonicMs === 600, 'clock evidence missing');

  const markdown = markdownTable([row]);
  assertSelfCheck(markdown.includes('Timing metrics are telemetry only'), 'markdown missing telemetry-only notice');
  for (const column of ['metricClock', 'metricScope', 'cacheState', 'reportedStatus', 'proofVerdict', 'durationMonotonicMs', 'modelAvailabilityCheckMs']) {
    assertSelfCheck(markdown.includes(column), `markdown missing ${column}`);
  }
  assertSelfCheck(
    !markdown.includes('Generic test timing records:'),
    'v1-only markdown changed its schema header',
  );

  const pathFallbackOnly = classifyReport(
    { repo: { target: 'HIPRTPathTracer' }, timings: { totalWallMs: 1 } },
    path.join(repoRoot, 'tmp', 'hiprt-light-math-warm-proof', 'path-only.json'),
  );
  assertSelfCheck(pathFallbackOnly === null, 'HIPRT timing classification must not use path or repo target fallbacks');

  const schemaBackedHiprt = classifyReport(
    {
      schemaVersion: 'synthi.hiprt.warm_visual_proof.v2',
      proofId: 'hiprt-warm-runtime-proof:sha256:selfcheck',
      accepted: true,
      timings: { totalWallMs: 1 },
      runtime: { baseline: {}, changed: {} },
    },
    path.join(repoRoot, 'tmp', 'schema-backed-hiprt.json'),
  );
  assertSelfCheck(schemaBackedHiprt?.kind === 'hiprt_warm_runtime', 'HIPRT timing proof schema must classify');

  const staleEmbeddedWebGpuCompute = classifyReport(
    {
      schema: 'synthi.gpu_hmr.webgpu_runtime_compute_proof.v1',
      proofId: 'webgpu-runtime-compute-proof:sha256:selfcheck',
      gpuHmrSuccess: true,
      profile: { id: 'webgpu-compute-selfcheck' },
      timingMetrics: {
        schemaVersion: GPU_HMR_TIMING_METRICS_SCHEMA_VERSION,
        source: 'webgpu_runtime_compute',
        visualEvidence: { screenshotCount: 1, accepted: true },
      },
      computeOracleArtifacts: {
        raw_readback_hash: 'sha256:selfcheck',
        raw_readback_byte_length: 32,
        deterministic_slice_hash: 'sha256:selfcheck-slice',
        rendered_card_png: 'proof-card.png',
      },
      timings: { total_validator_wall_time: 1_000_000 },
      proofLedger: { records: [{ metricScope: 'hot_delta_1', cacheState: 'pipeline_cache_warm' }] },
    },
    path.join(repoRoot, 'tmp', 'webgpu-compute-selfcheck.json'),
  );
  assertSelfCheck(
    staleEmbeddedWebGpuCompute?.metrics?.visualEvidence?.accepted === false,
    'WebGPU compute timing must recompute stale embedded visual evidence',
  );
  assertSelfCheck(
    staleEmbeddedWebGpuCompute?.metrics?.computeEvidence?.computeCardAccepted === true,
    'WebGPU compute timing must preserve compute-card evidence separately',
  );

  const visualClock = controlledSelfCheckClock(1_000_000n);
  const visualRecorder = new GpuHmrTestTimingRecorder({ clock: visualClock.now });
  visualClock.tick(5_000_000n);
  const visualPass = visualRecorder.finalize({
    outcome: 'pass',
    visualCapable: true,
    terminalReason: 'summary_self_check_unavailable',
  });
  const visualResult = compactSelfCheckReport(visualPass, 'v2-visual-pass');
  const visualRow = visualResult.rows[0];
  assertSelfCheck(visualResult.classified.length === 1, 'direct v2 visual pass not discovered');
  assertSelfCheck(
    hasMeaningfulMetrics(
      visualResult.classified[0].metrics,
      visualResult.classified[0].kind,
    ),
    'total-wall-only v2 visual pass was dropped as meaningless',
  );
  assertSelfCheck(visualRow.outcome === 'pass', 'v2 visual outcome missing');
  assertSelfCheck(visualRow.valid === true, 'v2 visual pass must remain valid');
  assertSelfCheck(visualRow.complete === false, 'total-wall-only visual pass must be incomplete');
  assertSelfCheck(visualRow.totalWallMs === 5, 'v2 visual total wall duration missing');
  assertSelfCheck(
    visualRow.phases.trigger_to_visible.state === 'unavailable',
    'v2 visual phase state missing',
  );
  const visualMarkdown = markdownTable([visualRow]);
  assertSelfCheck(
    visualMarkdown.includes(`Generic test timing records: \`${GPU_HMR_TEST_TIMING_SCHEMA}\``),
    'v2 markdown schema header missing',
  );
  for (const column of [
    'outcome',
    'valid',
    'complete',
    'blockingGaps',
    'triggerToVisibleMs',
    'screenshotCaptureMs',
    'visualAnalysisMs',
    'proofFinalizationMs',
  ]) {
    assertSelfCheck(visualMarkdown.includes(column), `v2 markdown missing ${column}`);
  }

  const computeClock = controlledSelfCheckClock(10_000_000n);
  const computeRecorder = new GpuHmrTestTimingRecorder({ clock: computeClock.now });
  computeClock.tick(7_000_000n);
  const computePass = computeRecorder.finalize({
    outcome: 'pass',
    visualCapable: false,
    terminalReason: 'summary_self_check_unavailable',
    notApplicableReason: 'summary_self_check_not_applicable',
  });
  const computeResult = compactSelfCheckReport(computePass, 'v2-compute-pass');
  const computeRow = computeResult.rows[0];
  assertSelfCheck(computeRow.valid === true, 'v2 compute pass must remain valid');
  assertSelfCheck(computeRow.complete === false, 'total-wall-only compute pass must be incomplete');
  assertSelfCheck(
    computeRow.phases.trigger_to_visible.state === 'not_applicable',
    'v2 compute visual phase must remain typed not_applicable',
  );

  const refusalClock = controlledSelfCheckClock(20_000_000n);
  const refusalRecorder = new GpuHmrTestTimingRecorder({ clock: refusalClock.now });
  measureSelfCheckPhase(refusalRecorder, refusalClock, 'cold_intake', 1_000_000n);
  measureSelfCheckPhase(refusalRecorder, refusalClock, 'discovery', 2_000_000n);
  const refusal = refusalRecorder.finalize({
    outcome: 'refused',
    visualCapable: false,
    terminalReason: 'summary_self_check_refused',
    notApplicableReason: 'summary_self_check_not_applicable',
  });
  const refusalRow = compactSelfCheckReport(refusal, 'v2-refusal').rows[0];
  assertSelfCheck(refusalRow.outcome === 'refused', 'v2 refusal outcome missing');
  assertSelfCheck(refusalRow.valid === true, 'v2 refusal must remain valid');
  assertSelfCheck(refusalRow.phases.compile.state === 'unavailable', 'v2 refusal compile state missing');

  const failureClock = controlledSelfCheckClock(30_000_000n);
  const failureRecorder = new GpuHmrTestTimingRecorder({ clock: failureClock.now });
  failureRecorder.startPhase('compile');
  failureClock.tick(3_000_000n);
  const thrownFailure = failureRecorder.finalize({
    outcome: 'failed',
    visualCapable: true,
    terminalReason: 'summary_self_check_exception',
  });
  const failureRow = compactSelfCheckReport(thrownFailure, 'v2-thrown-failure').rows[0];
  assertSelfCheck(failureRow.outcome === 'failed', 'v2 failure outcome missing');
  assertSelfCheck(failureRow.valid === true, 'v2 failure must remain valid');
  assertSelfCheck(failureRow.phases.compile.state === 'measured', 'partial measured failure phase missing');
  assertSelfCheck(failureRow.phases.compile.durationMs === 3, 'partial measured failure duration missing');

  for (const alias of GPU_HMR_TEST_TIMING_ALIASES) {
    const aliasResult = compactSelfCheckReport(
      { generic: { nested: { [alias]: computePass } } },
      `v2-alias-${alias}`,
    );
    assertSelfCheck(aliasResult.classified.length === 1, `nested alias ${alias} not discovered`);
    assertSelfCheck(aliasResult.classified[0].recordAlias === alias, `nested alias ${alias} not retained`);
    assertSelfCheck(
      aliasResult.rows[0].recordPath === `$.generic.nested.${alias}`,
      `nested alias ${alias} path missing`,
    );
  }

  const repeatedLogicalRecord = compactSelfCheckReport({
    testTiming: computePass,
    test_timing: JSON.parse(JSON.stringify(computePass)),
    runtimeProofArtifact: {
      testTiming: Object.fromEntries(Object.entries(computePass).reverse()),
      test_timing: JSON.parse(JSON.stringify(computePass)),
    },
  }, 'v2-repeated-logical-record');
  assertSelfCheck(
    repeatedLogicalRecord.classified.length === 1,
    'repeated aliases and nested copies were not deduplicated',
  );
  assertSelfCheck(
    /^sha256:[a-f0-9]{64}$/.test(repeatedLogicalRecord.rows[0].recordIdentity),
    'canonical timing record identity missing',
  );

  const sameSummaryClock = controlledSelfCheckClock(100_000_000n);
  const sameSummaryRecorder = new GpuHmrTestTimingRecorder({ clock: sameSummaryClock.now });
  sameSummaryClock.tick(7_000_000n);
  const sameSummaryDistinctRecord = sameSummaryRecorder.finalize({
    outcome: 'pass',
    visualCapable: false,
    terminalReason: 'summary_self_check_unavailable',
    notApplicableReason: 'summary_self_check_not_applicable',
  });
  const sameLookingDistinctRecords = compactSelfCheckReport({
    testTiming: computePass,
    nested: { test_timing: sameSummaryDistinctRecord },
  }, 'v2-same-looking-distinct-records');
  assertSelfCheck(
    sameLookingDistinctRecords.classified.length === 2,
    'distinct records with equal summary durations were merged',
  );
  assertSelfCheck(
    sameLookingDistinctRecords.rows.every((timingRow) => timingRow.totalWallMs === 7),
    'same-looking distinct record fixture did not preserve equal summaries',
  );
  assertSelfCheck(
    new Set(sameLookingDistinctRecords.rows.map((timingRow) => timingRow.recordIdentity)).size === 2,
    'distinct timing record identities collapsed',
  );

  const authorityForgery = JSON.parse(JSON.stringify(visualPass));
  authorityForgery.authority = 'gpu_hmr_success_authority';
  authorityForgery.acceptedForGpuHmr = true;
  authorityForgery.gpuHmrSuccess = true;
  authorityForgery.success = true;
  authorityForgery.hiprt_runtime_probe = {};
  const forgedResult = compactSelfCheckReport(authorityForgery, 'v2-forged-authority');
  const forgedRow = forgedResult.rows[0];
  assertSelfCheck(forgedResult.classified.length === 1, 'forged direct v2 record fell through');
  assertSelfCheck(
    forgedResult.classified[0].kind === 'gpu_hmr_test_timing_v2',
    'forged direct v2 record was treated as v1',
  );
  assertSelfCheck(forgedRow.valid === false, 'forged v2 authority was accepted');
  assertSelfCheck(
    forgedRow.validationGaps.includes('timing_authority_invalid'),
    'forged v2 authority gap missing',
  );
  assertSelfCheck(forgedRow.acceptedForGpuHmr === false, 'v2 row claimed GPU HMR acceptance');
  assertSelfCheck(forgedRow.gpuHmrSuccess === false, 'v2 row claimed GPU HMR success');
  assertSelfCheck(
    forgedRow.evidenceAuthority === GPU_HMR_TIMING_TELEMETRY_AUTHORITY,
    'v2 row escaped telemetry-only authority',
  );
  assertSelfCheck(!('status' in forgedRow), 'v2 row exposed status as success authority');

  for (const phaseKey of GPU_HMR_TEST_TIMING_PHASE_KEYS) {
    assertSelfCheck(Object.hasOwn(failureRow.phases, phaseKey), `compact v2 phase ${phaseKey} missing`);
    assertSelfCheck(
      Object.hasOwn(failureRow.phases[phaseKey], 'state')
      && Object.hasOwn(failureRow.phases[phaseKey], 'durationNs')
      && Object.hasOwn(failureRow.phases[phaseKey], 'durationMs'),
      `compact v2 phase ${phaseKey} state/duration missing`,
    );
  }
  assertSelfCheck(
    failureRow.triggerToVisibleMs === failureRow.phases.trigger_to_visible.durationMs
    && failureRow.screenshotCaptureMs === failureRow.phases.screenshot_capture.durationMs
    && failureRow.visualAnalysisMs === failureRow.phases.visual_analysis.durationMs
    && failureRow.proofFinalizationMs === failureRow.phases.proof_finalization.durationMs
    && failureRow.totalWallMs === failureRow.phases.total_wall.durationMs,
    'compact v2 named phase durations missing',
  );

  console.log(JSON.stringify({
    ok: true,
    schemaVersion: GPU_HMR_TIMING_METRICS_SCHEMA_VERSION,
    checked: 'gpu-hmr-timing-metrics-summary',
    v2Cases: [
      'visual_pass',
      'compute_pass',
      'refusal_before_compile',
      'thrown_failure_partial_phase',
      'nested_aliases',
      'logical_record_deduplication',
      'same_summary_distinct_records',
      'forged_authority',
    ],
  }, null, 2));
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(usage());
    return;
  }
  if (args.selfCheck) {
    runSelfCheck();
    return;
  }
  if (!['json', 'markdown', 'both'].includes(args.format)) {
    throw new Error(`Unsupported format: ${args.format}`);
  }

  const candidates = await collectCandidates(args);
  const selected = args.latestPerProfile ? latestPerProfile(candidates) : candidates;
  selected.sort((a, b) => {
    const sourceCompare = String(a.metrics?.source ?? '').localeCompare(String(b.metrics?.source ?? ''));
    if (sourceCompare !== 0) return sourceCompare;
    return String(a.metrics?.profileId ?? '').localeCompare(String(b.metrics?.profileId ?? ''));
  });

  const rows = selected.map(compactRow);
  const summary = {
    schemaVersion: GPU_HMR_TIMING_METRICS_SCHEMA_VERSION,
    telemetryOnly: true,
    evidenceAuthority: GPU_HMR_TIMING_TELEMETRY_AUTHORITY,
    proofVerdict: 'not_evaluated_by_timing_summary',
    generatedAt: new Date().toISOString(),
    latestPerProfile: args.latestPerProfile,
    count: rows.length,
    rows,
  };

  await fs.mkdir(args.outputDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  const jsonPath = path.join(args.outputDir, `gpu-hmr-timing-metrics-${stamp}.json`);
  const markdownPath = path.join(args.outputDir, `gpu-hmr-timing-metrics-${stamp}.md`);

  if (args.format === 'json' || args.format === 'both') {
    await fs.writeFile(jsonPath, `${JSON.stringify(summary, null, 2)}\n`);
  }
  if (args.format === 'markdown' || args.format === 'both') {
    await fs.writeFile(markdownPath, markdownTable(rows));
  }

  console.log(JSON.stringify({
    ok: true,
    schemaVersion: GPU_HMR_TIMING_METRICS_SCHEMA_VERSION,
    count: rows.length,
    jsonPath: args.format === 'markdown' ? null : jsonPath,
    markdownPath: args.format === 'json' ? null : markdownPath,
  }, null, 2));
}

const directInvocation = process.argv[1]
  && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (directInvocation) await main();
