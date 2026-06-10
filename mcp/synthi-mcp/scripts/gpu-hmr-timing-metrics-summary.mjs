#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  GPU_HMR_TIMING_METRICS_SCHEMA_VERSION,
  externalProjectTimingMetrics,
  hiprtWarmTimingMetrics,
  realRocmTimingMetrics,
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

function classifyReport(json, filePath) {
  if (!json || typeof json !== 'object') return null;

  if (json.timingMetrics?.schemaVersion === GPU_HMR_TIMING_METRICS_SCHEMA_VERSION) {
    return {
      kind: json.timingMetrics.source ?? 'precomputed',
      metrics: json.timingMetrics,
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

  if (schemaVersion.includes('external_project_profile.report')) {
    return {
      kind: 'external_project_profile',
      metrics: externalProjectTimingMetrics(json),
    };
  }

  if (
    String(json.proofId ?? '').startsWith('hiprt-warm-runtime-proof:')
    || filePath.includes(`${path.sep}hiprt-light-math-warm-proof${path.sep}`)
    || json.repo?.target === 'HIPRTPathTracer'
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
    profileId: metrics.profileId,
    projectName: metrics.projectName,
    proofMode: metrics.proofMode,
    status: metrics.status,
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
    visualAccepted: metrics.visualEvidence?.accepted ?? null,
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
    'status',
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
    'visualAccepted',
  ];
  const header = `| ${columns.join(' | ')} |`;
  const divider = `| ${columns.map(() => '---').join(' | ')} |`;
  const body = rows.map((row) => `| ${columns.map((column) => value(row[column])).join(' | ')} |`);
  return [
    `# GPU HMR Timing Metrics`,
    '',
    `Schema: \`${GPU_HMR_TIMING_METRICS_SCHEMA_VERSION}\``,
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
  assertSelfCheck(row.durationMonotonicNs === '600000000', 'duration monotonic ns missing');
  assertSelfCheck(row.durationMonotonicMs === 600, 'duration monotonic ms missing');
  assertSelfCheck(row.modelAvailabilityCheckMs === 2, 'model availability timing missing');
  assertSelfCheck(row.normalizedTimings?.totalValidatorWallTimeMs === 600, 'normalized timings missing');
  assertSelfCheck(row.clockEvidence?.durationMonotonicMs === 600, 'clock evidence missing');

  const markdown = markdownTable([row]);
  for (const column of ['metricClock', 'metricScope', 'cacheState', 'durationMonotonicMs', 'modelAvailabilityCheckMs']) {
    assertSelfCheck(markdown.includes(column), `markdown missing ${column}`);
  }

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
