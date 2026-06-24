#!/usr/bin/env node
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

const __filename = fileURLToPath(import.meta.url);
const scriptsDir = path.dirname(__filename);
const mcpRoot = path.resolve(scriptsDir, '..');
const repoRoot = path.resolve(mcpRoot, '..', '..');

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

function includesPathPart(filePath, part) {
  return filePath.split(path.sep).includes(part);
}

function hasMeaningfulMetrics(metrics) {
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
    const classified = classifyReport(json, filePath);
    if (!classified) continue;
    if (!hasMeaningfulMetrics(classified.metrics)) continue;

    const stat = await fs.stat(filePath);
    rows.push({
      filePath,
      kind: classified.kind,
      updatedAt: stat.mtime.toISOString(),
      metrics: classified.metrics,
    });
  }

  return rows;
}

function latestPerProfile(rows) {
  const byKey = new Map();
  for (const row of rows) {
    const key = [
      row.metrics?.source ?? row.kind ?? 'unknown',
      row.metrics?.profileId ?? row.metrics?.projectName ?? row.filePath,
      row.metrics?.proofMode ?? 'unknown',
      row.metrics?.metricScope ?? row.metrics?.metric_scope ?? 'unknown_scope',
    ].join('|');

    const existing = byKey.get(key);
    if (!existing || existing.updatedAt < row.updatedAt) {
      byKey.set(key, row);
    }
  }

  return [...byKey.values()];
}

function compactRow(row) {
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
  const columns = [
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
  const header = `| ${columns.join(' | ')} |`;
  const divider = `| ${columns.map(() => '---').join(' | ')} |`;
  const body = rows.map((row) => `| ${columns.map((column) => value(row[column])).join(' | ')} |`);
  return [
    `# GPU HMR Timing Metrics`,
    '',
    `Schema: \`${GPU_HMR_TIMING_METRICS_SCHEMA_VERSION}\``,
    '',
    'Timing metrics are telemetry only; validation-matrix proof ledgers are the acceptance authority. Reported status/accepted columns are copied from source artifacts for timing context and must not be treated as GPU HMR acceptance.',
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

  console.log(JSON.stringify({
    ok: true,
    schemaVersion: GPU_HMR_TIMING_METRICS_SCHEMA_VERSION,
    checked: 'gpu-hmr-timing-metrics-summary',
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

await main();
