#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { collectGpuHmrValidationMatrixLedger } from '../lib/gpu-hmr-validation-matrix-ledger.mjs';

const __filename = fileURLToPath(import.meta.url);
const testsDir = path.dirname(__filename);
const mcpRoot = path.resolve(testsDir, '..', '..');
const repoRoot = path.resolve(mcpRoot, '..', '..');

const DOC_PATHS = [
  path.join(repoRoot, 'docs', 'GPU_HMR_UNIVERSAL_ACCEPTANCE_IMPLEMENTATION_STATUS.md'),
  path.join(repoRoot, 'docs', 'GPU_HMR_INVESTOR_DEMO_STATUS.md'),
];

async function pathExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function readJson(filePath) {
  return JSON.parse(await fs.readFile(filePath, 'utf8'));
}

async function listJsonFiles(root) {
  if (!(await pathExists(root))) return [];
  const entries = await fs.readdir(root, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
    .map((entry) => path.join(root, entry.name));
}

function generatedAtMillis(json, filePath) {
  const parsed = Date.parse(json?.generatedAt ?? '');
  if (Number.isFinite(parsed)) return parsed;
  const match = path.basename(filePath).match(/(\d{8}T\d{6}Z)/);
  if (!match) return 0;
  const stamp = match[1];
  const iso = `${stamp.slice(0, 4)}-${stamp.slice(4, 6)}-${stamp.slice(6, 8)}T${stamp.slice(9, 11)}:${stamp.slice(11, 13)}:${stamp.slice(13, 15)}Z`;
  return Date.parse(iso) || 0;
}

async function latestJsonArtifact(root, predicate) {
  const candidates = [];
  for (const filePath of await listJsonFiles(root)) {
    const json = await readJson(filePath);
    if (predicate(json, filePath)) {
      candidates.push({ filePath, json, generatedAt: generatedAtMillis(json, filePath) });
    }
  }
  candidates.sort((a, b) => b.generatedAt - a.generatedAt || a.filePath.localeCompare(b.filePath));
  assert.ok(candidates.length > 0, `no JSON proof artifacts found in ${root}`);
  return candidates[0];
}

function repoPath(filePath) {
  return path.relative(repoRoot, filePath).split(path.sep).join('/');
}

function matrixSummaryTokens(artifact, includeUnproven) {
  const { summary } = artifact.json;
  const tokens = [
    artifact.json.proofId,
    repoPath(artifact.filePath),
    `${summary.rowCount} rows`,
    `${summary.acceptedFullRuntimeGpuHmrRows} accepted full-runtime GPU HMR`,
    `${summary.broadFullRuntimeGpuHmrRows} broad library-agnostic full-runtime GPU HMR`,
    `${summary.scopedFullRuntimeGpuHmrRows} scoped full-runtime GPU HMR`,
    `${summary.allFullRuntimeGpuHmrRows} all full-runtime`,
    `${summary.refusalProvenRows} refusals`,
    `${summary.byOutcome?.cold_split_proven ?? 0} cold splits`,
    ...Object.entries(summary.fullRuntimeScopeBreakdown ?? {}).map(([scope, count]) => `${scope}: ${count}`),
  ];
  if (includeUnproven) {
    tokens.push(`${summary.byOutcome?.unproven ?? 0} historical unproven rows`);
  } else {
    tokens.push('0 included unproven rows');
    const planCoverageById = new Map((summary.planCoverage ?? []).map((entry) => [entry.id, entry]));
    const runModeCoverage = planCoverageById.get('per_target_run_modes');
    if (runModeCoverage) {
      tokens.push(`per_target_run_modes status=${runModeCoverage.status}`);
      for (const gap of runModeCoverage.openGaps ?? []) {
        tokens.push(`per_target_run_modes open gap: ${gap}`);
      }
    }
  }
  return tokens;
}

function timingTokens(artifact) {
  return [
    repoPath(artifact.filePath),
    `count=${artifact.json.count}`,
    'timing metrics are telemetry only',
    'evidenceAuthority=timing_telemetry_only',
    'proofVerdict=not_evaluated_by_timing_summary',
  ];
}

function sortedRowIds(json) {
  return (Array.isArray(json?.rows) ? json.rows : [])
    .map((row) => row.rowId)
    .sort();
}

function jsonStoredValue(value) {
  return JSON.parse(JSON.stringify(value));
}

function assertSavedMatrixMatchesLive(name, saved, live) {
  assert.equal(live.query?.accepted, true, `${name} live matrix query must accept`);
  assert.equal(saved.json.proofId, live.proofId, `${name} saved proofId must match live aggregation`);
  assert.deepEqual(
    saved.json.summary,
    jsonStoredValue(live.summary),
    `${name} saved summary must match live aggregation`,
  );
  assert.deepEqual(sortedRowIds(saved.json), sortedRowIds(live), `${name} saved row set must match live aggregation`);
}

async function readDocs() {
  const docs = [];
  for (const docPath of DOC_PATHS) {
    docs.push({
      path: docPath,
      text: await fs.readFile(docPath, 'utf8'),
    });
  }
  return docs;
}

function assertTokensPresent(doc, tokens) {
  for (const token of tokens) {
    assert.ok(
      doc.text.includes(token),
      `${repoPath(doc.path)} is missing latest proof token: ${token}`,
    );
  }
}

function assertScopedBoundaryLanguage(doc) {
  const requiredGroups = [
    [
      'not a broad HIP app/library claim',
      'not a blanket HIP application claim',
    ],
    [
      'arbitraryLibraryAccepted=false',
      'arbitrary HIP libraries, frameworks, or apps are accepted',
      'arbitrary HIP libraries/frameworks/apps pass',
    ],
    [
      'compute-card-only proof separation',
      'rendered from raw HIP readback bytes',
      'data-derived proof cards',
    ],
    [
      'not counted in the broad full-runtime headline',
      '0 broad library-agnostic full-runtime GPU HMR',
    ],
  ];
  const missing = requiredGroups.filter((group) => !group.some((token) => doc.text.includes(token)));
  assert.equal(
    missing.length,
    0,
    `${repoPath(doc.path)} is missing scoped HIP boundary language groups: ${missing.map((group) => group.join(' | ')).join(', ')}`,
  );
}

function assertCurrentMatrixRowReferencesResolve(doc, matrixArtifact) {
  const latestRowIds = new Set(sortedRowIds(matrixArtifact.json));
  const latestMatrixPath = repoPath(matrixArtifact.filePath);
  const lines = doc.text.split(/\r?\n/);
  let checkedCount = 0;

  lines.forEach((line, index) => {
    const lower = line.toLowerCase();
    if (!lower.includes('gpu-validation-matrix-row:sha256:') || lower.includes('historical')) return;

    const rowIds = line.match(/gpu-validation-matrix-row:sha256:[a-f0-9]+/gi) ?? [];
    checkedCount += rowIds.length;
    for (const rowId of rowIds) {
      assert.ok(
        latestRowIds.has(rowId),
        `${repoPath(doc.path)}:${index + 1} references row ${rowId}, which is absent from latest matrix ${latestMatrixPath}`,
      );
    }

    const normalizedLine = line.split(path.sep).join('/');
    if (normalizedLine.includes('mcp/synthi-mcp/.gpu-hmr-test-logs/validation-matrix/')) {
      assert.ok(
        normalizedLine.includes(latestMatrixPath),
        `${repoPath(doc.path)}:${index + 1} references stale matrix artifact path; expected ${latestMatrixPath}`,
      );
    }
  });

  assert.ok(
    checkedCount > 0,
    `${repoPath(doc.path)} must include at least one current matrix row id reference to validate`,
  );
}

const validationMatrixDir = path.join(mcpRoot, '.gpu-hmr-test-logs', 'validation-matrix');
const validationHistoryDir = path.join(mcpRoot, '.gpu-hmr-test-logs', 'validation-matrix-unproven-audit');
const timingDir = path.join(mcpRoot, '.gpu-hmr-test-logs', 'timing-metrics');

const matrix = await latestJsonArtifact(
  validationMatrixDir,
  (json) => json?.schemaVersion === 'synthi.gpu.hmr.validation_matrix_ledger.v1' && json?.includeUnproven === false,
);
const history = await latestJsonArtifact(
  validationHistoryDir,
  (json) => json?.schemaVersion === 'synthi.gpu.hmr.validation_matrix_ledger.v1' && json?.includeUnproven === true,
);
const timing = await latestJsonArtifact(
  timingDir,
  (json) => json?.schemaVersion === 'synthi.gpu.hmr.timing_metrics.v1' && json?.latestPerProfile === true,
);

assert.ok(matrix.json.proofId, 'latest matrix must carry proofId');
assert.ok(history.json.proofId, 'latest history matrix must carry proofId');
assert.ok(Number.isInteger(timing.json.count), 'latest timing summary must carry count');

const liveMatrix = await collectGpuHmrValidationMatrixLedger({
  repoRoot,
  mcpRoot,
  latestPerTarget: true,
  includeUnproven: false,
  generatedAt: matrix.json.generatedAt,
});
const liveHistory = await collectGpuHmrValidationMatrixLedger({
  repoRoot,
  mcpRoot,
  latestPerTarget: true,
  includeUnproven: true,
  generatedAt: history.json.generatedAt,
});
assertSavedMatrixMatchesLive('latest validation matrix', matrix, liveMatrix);
assertSavedMatrixMatchesLive('latest history matrix', history, liveHistory);

assert.equal(
  matrix.json.summary.broadFullRuntimeGpuHmrRows + matrix.json.summary.scopedFullRuntimeGpuHmrRows,
  matrix.json.summary.allFullRuntimeGpuHmrRows,
  'matrix broad + scoped full-runtime counts must match all full-runtime count',
);
assert.equal(
  matrix.json.summary.acceptedFullRuntimeGpuHmrRows,
  matrix.json.summary.allFullRuntimeGpuHmrRows,
  'accepted full-runtime count must match all full-runtime count',
);

const docs = await readDocs();
const normalTokens = matrixSummaryTokens(matrix, false);
const historyTokens = matrixSummaryTokens(history, true);
const latestTimingTokens = timingTokens(timing);

for (const doc of docs) {
  assertTokensPresent(doc, normalTokens);
  assertTokensPresent(doc, historyTokens);
  assertTokensPresent(doc, latestTimingTokens);
  assertCurrentMatrixRowReferencesResolve(doc, matrix);
}

for (const doc of docs) {
  assert.ok(
    doc.text.includes('Every arbitrary GPU project is production accepted.'),
    `${repoPath(doc.path)} must retain explicit anti-universal-claim language`,
  );
}

assertScopedBoundaryLanguage(docs.find((doc) => doc.path.endsWith('GPU_HMR_UNIVERSAL_ACCEPTANCE_IMPLEMENTATION_STATUS.md')));
assertScopedBoundaryLanguage(docs.find((doc) => doc.path.endsWith('GPU_HMR_INVESTOR_DEMO_STATUS.md')));

console.log(JSON.stringify({
  ok: true,
  checked: 'gpu-hmr-status-docs-freshness',
  matrix: {
    proofId: matrix.json.proofId,
    path: repoPath(matrix.filePath),
    rowCount: matrix.json.summary.rowCount,
    acceptedFullRuntimeRows: matrix.json.summary.acceptedFullRuntimeGpuHmrRows,
    broadFullRuntimeRows: matrix.json.summary.broadFullRuntimeGpuHmrRows,
    scopedFullRuntimeRows: matrix.json.summary.scopedFullRuntimeGpuHmrRows,
    scopeBreakdown: matrix.json.summary.fullRuntimeScopeBreakdown,
  },
  history: {
    proofId: history.json.proofId,
    path: repoPath(history.filePath),
    rowCount: history.json.summary.rowCount,
    unprovenRows: history.json.summary.byOutcome?.unproven ?? 0,
  },
  timing: {
    path: repoPath(timing.filePath),
    count: timing.json.count,
  },
}, null, 2));
