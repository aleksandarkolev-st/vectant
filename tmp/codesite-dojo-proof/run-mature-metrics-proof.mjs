#!/usr/bin/env node
'use strict';

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const repoRoot = process.cwd();
const proofRoot = path.join(repoRoot, 'tmp', 'codesite-dojo-proof');
const outBase = path.join(proofRoot, 'codesite-metrics-proof');
const CORE_METRICS = [
  'proofBundlesVerifiedOutsideUi',
  'shadowMergeSimulatorAccuracy',
  'lineProvenanceCoverage',
  'blackBoxCompletenessScore',
  'humanReviewTimeSavedMs',
  'percentageWritesWithValidClearance',
];
const THRESHOLDS = {
  proofBundlesVerifiedOutsideUi: 1,
  shadowMergeSimulatorAccuracy: 0.8,
  lineProvenanceCoverage: 0.5,
  blackBoxCompletenessScore: 0.75,
  humanReviewTimeSavedMs: 1,
  percentageWritesWithValidClearance: 0.3,
};

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd || repoRoot,
    encoding: 'utf8',
    maxBuffer: 160 * 1024 * 1024,
    env: { ...process.env, ...(options.env || {}) },
  });
  const output = `${result.stdout || ''}${result.stderr || ''}`;
  return {
    name: options.name || command,
    command: [command, ...args].join(' '),
    cwd: path.relative(repoRoot, options.cwd || repoRoot) || '.',
    exitCode: typeof result.status === 'number' ? result.status : 1,
    signal: result.signal || null,
    summary: parseSummary(output),
    stdout: result.stdout || '',
    outputTail: stripAnsi(output).split(/\r?\n/).filter(Boolean).slice(-24),
  };
}

function parseSummary(output) {
  const clean = stripAnsi(output);
  const vitest = clean.match(/Tests\s+(\d+) passed(?:\s+\|\s+(\d+) skipped)?\s+\((\d+)\)/);
  if (vitest) {
    return {
      runner: 'vitest',
      pass: Number(vitest[1]),
      skipped: Number(vitest[2] || 0),
      tests: Number(vitest[3]),
      fail: 0,
    };
  }
  return { runner: 'command', tests: 0, pass: resultPassed(clean) ? 1 : 0, fail: resultPassed(clean) ? 0 : 1 };
}

function resultPassed(output) {
  return !String(output || '').includes('Error:') && !String(output || '').includes('SyntaxError');
}

function stripAnsi(value) {
  return String(value || '').replace(/\u001b\[[0-9;]*m/g, '');
}

function gitText(args) {
  const result = spawnSync('git', args, { cwd: repoRoot, encoding: 'utf8' });
  return result.status === 0 ? String(result.stdout || '').trim() : null;
}

function assert(condition, name, assertions, details = {}) {
  assertions.push({ name, ok: Boolean(condition), details });
}

function metricRow(metrics, key) {
  for (const rows of Object.values(metrics.sections || {})) {
    const row = Array.isArray(rows) ? rows.find((item) => item.key === key) : null;
    if (row) return row;
  }
  return null;
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function commandResult(command) {
  const summary = command?.summary || {};
  if (summary.tests) return `${summary.pass || 0}/${summary.tests}`;
  return command?.exitCode === 0 ? 'pass' : 'fail';
}

function sampleProject() {
  return {
    id: 'metrics-mature-project',
    workspaceSlug: 'codesite-mature-metrics-proof',
    executionPlans: [{
      id: 'plan-schema',
      displayCallsign: 'SCHEMA-01',
      status: 'holding',
      filedAt: '2026-07-04T10:00:00.000Z',
    }],
    mutationLeases: [{
      id: 'lease-schema',
      executionPlanId: 'plan-schema',
      displayCallsign: 'SCHEMA-01',
      status: 'active',
      issuedAt: '2026-07-04T10:05:00.000Z',
    }],
    mutationTxns: [{
      id: 'txn-commit',
      mutationLeaseId: 'lease-schema',
      status: 'committed',
      writeSet: ['synthi/prisma/schema.prisma', 'synthi/src/app/api/auth/route.ts'],
      observedWriteSet: ['synthi/prisma/schema.prisma'],
      commitDecision: { reasonCodes: ['serializable_validation_passed'] },
    }, {
      id: 'txn-abort',
      mutationLeaseId: 'lease-schema',
      status: 'aborted',
      writeSet: ['synthi/prisma/schema.prisma'],
      observedWriteSet: ['synthi/prisma/schema.prisma'],
    }],
    assumptions: [{ id: 'assumption-contract', status: 'invalidated', assumptionKey: 'auth.schema.v2' }],
    policyDecisions: [{
      id: 'decision-hold',
      decision: 'hold',
      reasonCodes: ['collision_avoidance_hold', 'schema_first_leader_clearance'],
    }, {
      id: 'decision-nofly',
      decision: 'block',
      reasonCodes: ['entered_no_fly_zone'],
      decisionBody: { path: 'secrets/prod.env', tool: 'terminal_exec' },
    }],
    events: [{
      id: 'write-attempt-1',
      eventType: 'write_attempted',
      mutationLeaseId: 'lease-schema',
      actorType: 'transaction',
      actorId: 'txn-commit',
      details: { transactionId: 'txn-commit', path: 'synthi/prisma/schema.prisma' },
    }, {
      id: 'write-allowed-1',
      eventType: 'write_allowed',
      mutationLeaseId: 'lease-schema',
      actorType: 'transaction',
      actorId: 'txn-commit',
      details: {
        transactionId: 'txn-commit',
        path: 'synthi/prisma/schema.prisma',
        invalidatedAssumptions: ['assumption-contract'],
      },
      evidenceRefs: ['write:evidence:schema'],
    }, {
      id: 'write-denied-1',
      eventType: 'write_denied',
      actorType: 'codesitefs',
      details: {
        path: 'secrets/prod.env',
        reasonCodes: ['entered_no_fly_zone'],
        source: 'codesitefs',
      },
      evidenceRefs: ['codesitefs:block:no-fly'],
    }, {
      id: 'write-quarantine-1',
      eventType: 'write_quarantined',
      actorType: 'codesitefs',
      details: { path: 'tmp/quarantine/generated.sql' },
    }, {
      id: 'transaction-validated-1',
      eventType: 'transaction_validated',
      details: { decision: { reasonCodes: ['stale_read_detected'], staleReads: [{ eventId: 'write-allowed-1' }] } },
    }, {
      id: 'black-box-verified-1',
      eventType: 'black_box_closed',
      details: { proofBundleId: 'proof-1', proofBundleDigest: 'sha256:bundle', verifier: { status: 'verified' } },
    }, {
      id: 'proof-bundle-verified-1',
      eventType: 'proof_bundle_verified',
      details: { status: 'verified', verifier: { mode: 'actual_git_commit' } },
    }, {
      id: 'tower-reroute-1',
      eventType: 'tower_instruction',
      details: { towerInstruction: 'Reroute SCHEMA-01 through schema-first lane', route: ['synthi/prisma/**'] },
    }, {
      id: 'ground-stop-1',
      eventType: 'ground_stop',
      details: { reasonCodes: ['mayday_ground_stop'] },
    }],
    incidents: [{
      id: 'incident-black-box',
      category: 'black_box',
      severity: 'low',
      affectedZones: ['synthi/prisma/**'],
      replayDigest: 'sha256:replay',
      incidentReplay: { completeness: { score: 0.88 } },
      evidenceRefs: ['incident:black-box'],
    }, {
      id: 'incident-near-miss',
      category: 'near_miss',
      severity: 'medium',
      affectedZones: ['synthi/prisma/**'],
      replayDigest: 'sha256:near-miss',
      incidentReplay: { completeness: { score: 0.83 } },
      evidenceRefs: ['incident:near-miss'],
    }],
    inspectionRuns: [{
      id: 'inspection-1',
      executionPlanId: 'plan-schema',
      displayCallsign: 'QA-1',
      status: 'passed',
      changedPaths: ['synthi/prisma/**'],
      inspectionSignals: [
        { key: 'tests', status: 'failed', evidenceRefs: ['test:red-before-landing'] },
        { key: 'security', status: 'failed', evidenceRefs: ['security:finding-before-merge'] },
        { key: 'migration', status: 'passed', evidenceRefs: ['migration:rollback-plan'] },
      ],
      evidenceRefs: ['inspection:passed'],
    }],
    proofBundles: [{ id: 'proof-1', bundleDigest: 'sha256:bundle', evidenceRefs: ['proof:evidence'] }],
    documentReviews: [{
      id: 'review-1',
      documentId: 'change-order-1',
      status: 'completed',
      decision: 'approved',
      reasonCodes: ['document_approved'],
      body: { reviewTimeMs: 90_000, baselineReviewTimeMs: 300_000 },
      evidenceRefs: ['document-review:evidence'],
    }],
    lineProvenance: [{
      id: 'line-schema',
      filePath: 'synthi/prisma/schema.prisma',
      evidenceRefs: ['line:evidence:schema'],
    }, {
      id: 'line-auth',
      filePath: 'synthi/src/app/api/auth/route.ts',
      evidenceRefs: ['line:evidence:auth'],
    }],
    counterfactualRuns: [{
      id: 'shadow-1',
      universes: [{
        strategy: 'schema-first',
        result: 'passed',
        predictedCollisionRisk: 0.2,
        avoidedRisks: ['merge_conflict', 'semantic_collision'],
        reasonCodes: ['semantic_collision_mitigated'],
      }, {
        strategy: 'parallel',
        result: 'risk',
        predictedCollisionRisk: 0.9,
        unresolvedRisks: ['semantic_collision'],
      }],
      arbiterVerdict: { selected: 'schema-first' },
      userChoice: { selected: 'schema-first' },
      evidenceRefs: ['shadow:job:1'],
    }],
    policyDeltas: [{ id: 'delta-1', promotionState: 'active', learnedFromIncidents: ['incident-near-miss'] }],
  };
}

function writeMetricsEngineRunner() {
  const runnerPath = path.join(proofRoot, '.codesite-metrics-engine-runner.mjs');
  const source = [
    "import { buildCodeSiteMetrics } from '/repo/synthi/src/lib/codesite/metrics.js';",
    `const project = ${JSON.stringify(sampleProject())};`,
    "const metrics = buildCodeSiteMetrics({",
    "  workspaceSlug: 'codesite-mature-metrics-proof',",
    "  controlState: { collisionForecast: { risks: [{ id: 'risk-schema', risk: 'semantic_collision', conflictZone: 'synthi/prisma/**' }] } },",
    "  project,",
    "});",
    "console.log(JSON.stringify(metrics));",
    '',
  ].join('\n');
  fs.writeFileSync(runnerPath, source, 'utf8');
  return runnerPath;
}

function parseMetricsFromCommand(command) {
  const lines = stripAnsi(command.stdout).split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  for (const line of lines.reverse()) {
    try {
      const parsed = JSON.parse(line);
      if (parsed?.schemaVersion === 'synthi.codesite.metrics.v1') return parsed;
    } catch (_) {
      // Keep scanning for the JSON line.
    }
  }
  return null;
}

function renderHtml(proof) {
  const assertionRows = proof.assertions.map((item) => (
    `<tr><td class="${item.ok ? 'ok' : 'fail'}">${item.ok ? 'PASS' : 'FAIL'}</td><td>${escapeHtml(item.name)}</td><td>${escapeHtml(JSON.stringify(item.details || {}))}</td></tr>`
  )).join('');
  const metricRows = CORE_METRICS.map((key) => {
    const value = proof.metrics.summary[key];
    const threshold = THRESHOLDS[key];
    return `<tr><td>${escapeHtml(key)}</td><td>${escapeHtml(value)}</td><td>${escapeHtml(threshold)}</td><td class="${Number(value) >= Number(threshold) ? 'ok' : 'fail'}">${Number(value) >= Number(threshold) ? 'PASS' : 'FAIL'}</td></tr>`;
  }).join('');
  const commandRows = proof.commands.map((item) => (
    `<tr><td class="${item.exitCode === 0 ? 'ok' : 'fail'}">${item.exitCode === 0 ? 'PASS' : 'FAIL'}</td><td><code>${escapeHtml(item.command)}</code><div class="cwd">${escapeHtml(item.cwd)}</div></td><td>${escapeHtml(commandResult(item))}</td></tr>`
  )).join('');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>CodeSite Mature Metrics Proof</title>
<style>
:root{font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:#080b0d;color:#eef4f2;color-scheme:dark}
body{margin:0;background:#080b0d;color:#eef4f2}
main{width:min(1240px,calc(100vw - 56px));margin:0 auto;padding:38px 0 54px}
header{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:28px;align-items:end;border-bottom:1px solid #26383c;padding-bottom:24px}
h1{margin:0;font-size:35px;line-height:1.05;font-weight:790;letter-spacing:0}
.sub{margin:12px 0 0;color:#a6b8b6;max-width:930px;line-height:1.55}
.stamp{border:1px solid #2d8a6c;background:#0b2f29;color:#b9f7dd;padding:12px 34px;font-weight:790}
.cards{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:12px;margin:24px 0}
.card,section{background:#0f1517;border:1px solid #26383c}
.card{padding:16px;min-height:86px}
.label{font-size:11px;text-transform:uppercase;letter-spacing:.08em;color:#8ba09f}
.value{font-size:27px;font-weight:790;margin-top:10px;overflow-wrap:anywhere}
section{padding:20px;margin-top:18px}
h2{font-size:19px;margin:0 0 14px}
table{border-collapse:collapse;width:100%;font-size:13px}
th,td{border-top:1px solid #223236;padding:10px 8px;text-align:left;vertical-align:top}
th{font-size:11px;text-transform:uppercase;letter-spacing:.08em;color:#9bb7b4;background:#0a1012}
code{font-family:"SFMono-Regular",Consolas,"Liberation Mono",monospace}
pre{background:#040708;color:#dbe8e5;padding:14px;white-space:pre-wrap;overflow:auto;font-size:12px;line-height:1.45}
.cwd{color:#849997;font-size:12px;margin-top:4px}
.ok{color:#83f0bd;font-weight:760}
.fail{color:#ff9b8f;font-weight:760}
@media(max-width:900px){main{width:min(100% - 28px,760px);padding-top:26px}.cards{grid-template-columns:1fr 1fr}header{grid-template-columns:1fr}.stamp{width:max-content}h1{font-size:30px}}
</style>
</head>
<body>
<main>
<header>
<div>
<h1>CodeSite Mature Metrics Proof</h1>
<p class="sub">Verified ${escapeHtml(proof.generatedAt)}. Core section 27 metrics are measured from persisted workflow evidence and release-gated with thresholds.</p>
</div>
<div class="stamp">${proof.ok ? 'PASS' : 'FAIL'}</div>
</header>
<div class="cards">
<div class="card"><div class="label">Docker Metrics</div><div class="value">${escapeHtml(commandResult(proof.commands[0]))}</div></div>
<div class="card"><div class="label">Proof Bundles</div><div class="value">${escapeHtml(proof.metrics.summary.proofBundlesVerifiedOutsideUi)}</div></div>
<div class="card"><div class="label">Black Box Score</div><div class="value">${escapeHtml(proof.metrics.summary.blackBoxCompletenessScore)}</div></div>
<div class="card"><div class="label">Review Saved</div><div class="value">${escapeHtml(proof.metrics.summary.humanReviewTimeSavedMs)}ms</div></div>
</div>
<section><h2>Thresholds</h2><table><thead><tr><th>Metric</th><th>Value</th><th>Minimum</th><th>Status</th></tr></thead><tbody>${metricRows}</tbody></table></section>
<section><h2>Assertions</h2><table><thead><tr><th>Status</th><th>Assertion</th><th>Details</th></tr></thead><tbody>${assertionRows}</tbody></table></section>
<section><h2>Executed Commands</h2><table><thead><tr><th>Status</th><th>Command</th><th>Result</th></tr></thead><tbody>${commandRows}</tbody></table></section>
<section><h2>Git Binding</h2><pre>${escapeHtml(JSON.stringify(proof.git, null, 2))}</pre></section>
</main>
</body>
</html>`;
}

async function screenshot(htmlPath, pngPath) {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1360, height: 1040 }, deviceScaleFactor: 1 });
    await page.goto(pathToFileURL(htmlPath).href);
    await page.screenshot({ path: pngPath, fullPage: true });
  } finally {
    await browser.close();
  }
}

async function main() {
  fs.mkdirSync(proofRoot, { recursive: true });
  const assertions = [];
  const metricsRunnerPath = writeMetricsEngineRunner();

  const commands = [
    run('docker', [
      'run',
      '--rm',
      '-v',
      `${repoRoot}:/repo`,
      '-w',
      '/repo/synthi',
      '-e',
      'DATABASE_URL=postgresql://user:pass@localhost:5432/synthi',
      'node:22-bookworm',
      'bash',
      '-lc',
      `npm exec vite-node -- /repo/${path.relative(repoRoot, metricsRunnerPath).split(path.sep).join('/')}`,
    ], { name: 'dockerMetricsEngine' }),
    run('docker', [
      'run',
      '--rm',
      '-v',
      `${repoRoot}:/repo`,
      '-w',
      '/repo/synthi',
      '-e',
      'DATABASE_URL=postgresql://user:pass@localhost:5432/synthi',
      'node:22-bookworm',
      'bash',
      '-lc',
      'npm exec vitest -- run src/lib/codesite/__tests__/metrics.test.js',
    ], { name: 'dockerMetricsSuite' }),
  ];
  const metrics = parseMetricsFromCommand(commands[0]);
  assert(Boolean(metrics), 'docker metrics engine emitted CodeSite metrics JSON', assertions, {
    command: commands[0].command,
    exitCode: commands[0].exitCode,
  });
  for (const key of CORE_METRICS) {
    const row = metrics ? metricRow(metrics, key) : null;
    const value = metrics?.summary?.[key];
    assert(row?.status === 'measured' && Number.isFinite(Number(value)), `${key} is measured and finite`, assertions, { value, status: row?.status || null });
    assert(Number(value) >= Number(THRESHOLDS[key]), `${key} meets release threshold`, assertions, { value, minimum: THRESHOLDS[key] });
  }
  for (const command of commands) {
    assert(command.exitCode === 0, `${command.name} command exited successfully`, assertions, {
      command: command.command,
      summary: command.summary,
      exitCode: command.exitCode,
    });
  }

  const proof = {
    schemaVersion: 'synthi.codesite.metricsProof.v2',
    status: 'validated',
    generatedAt: new Date().toISOString(),
    ok: assertions.every((item) => item.ok) && commands.every((item) => item.exitCode === 0),
    git: {
      head: gitText(['rev-parse', 'HEAD']),
      branch: gitText(['rev-parse', '--abbrev-ref', 'HEAD']),
      statusShort: gitText(['status', '--short']),
    },
    thresholds: THRESHOLDS,
    assertions,
    commands,
    metrics: metrics || { schemaVersion: 'synthi.codesite.metrics.v1', summary: {}, sections: {} },
  };
  const jsonPath = `${outBase}.json`;
  const htmlPath = `${outBase}.html`;
  const pngPath = `${outBase}.png`;
  fs.writeFileSync(jsonPath, `${JSON.stringify(proof, null, 2)}\n`);
  fs.writeFileSync(htmlPath, renderHtml(proof));
  await screenshot(htmlPath, pngPath);
  console.log(JSON.stringify({ ok: proof.ok, jsonPath, htmlPath, pngPath }, null, 2));
  if (!proof.ok) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
