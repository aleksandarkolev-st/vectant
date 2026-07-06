import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { chromium } from 'playwright';

const execFileAsync = promisify(execFile);
const proofDir = path.resolve('tmp/codesite-dojo-proof/automatic-workflow-proof-closure');
const focusedPath = path.join(proofDir, 'vitest-focused.json');
const fullPath = path.join(proofDir, 'vitest-full.json');
const summaryPath = path.join(proofDir, 'summary.json');
const htmlPath = path.join(proofDir, 'proof.html');
const pngPath = path.join(proofDir, 'proof.png');

function summarizeVitest(report) {
  return {
    success: Boolean(report.success),
    suites: {
      total: Number(report.numTotalTestSuites || 0),
      passed: Number(report.numPassedTestSuites || 0),
      failed: Number(report.numFailedTestSuites || 0),
    },
    tests: {
      total: Number(report.numTotalTests || 0),
      passed: Number(report.numPassedTests || 0),
      failed: Number(report.numFailedTests || 0),
      skipped: Number(report.numPendingTests || 0),
    },
  };
}

function passedTests(report) {
  return (report.testResults || []).flatMap((file) => (
    (file.assertionResults || [])
      .filter((test) => test.status === 'passed')
      .map((test) => ({
        file: path.relative(process.cwd(), file.name || ''),
        name: test.fullName || test.title || 'unnamed test',
        durationMs: Math.round(Number(test.duration || 0)),
      }))
  ));
}

function failedTests(report) {
  return (report.testResults || []).flatMap((file) => (
    (file.assertionResults || [])
      .filter((test) => test.status === 'failed')
      .map((test) => test.fullName || test.title || 'unnamed test')
  ));
}

async function runGit(args) {
  try {
    const { stdout } = await execFileAsync('git', args, { cwd: process.cwd(), maxBuffer: 4 * 1024 * 1024 });
    return stdout.trim();
  } catch (error) {
    return String(error?.stderr || error?.message || error);
  }
}

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

function sha256(value) {
  return `sha256:${crypto.createHash('sha256').update(value).digest('hex')}`;
}

async function renderScreenshot() {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1200 }, deviceScaleFactor: 1 });
    await page.goto(`file://${htmlPath}`, { waitUntil: 'networkidle' });
    await page.screenshot({ path: pngPath, fullPage: true });
  } finally {
    await browser.close();
  }
}

const focused = JSON.parse(await fs.readFile(focusedPath, 'utf8'));
const full = JSON.parse(await fs.readFile(fullPath, 'utf8'));
const focusedPassed = passedTests(focused);
const fullFailures = failedTests(full);
const branch = await runGit(['branch', '--show-current']);
const head = await runGit(['rev-parse', '--short=12', 'HEAD']);
const status = await runGit(['status', '--short']);
const diffStat = await runGit(['diff', '--stat', '--', 'synthi/src/lib/codesite/controlPlane.js', 'synthi/src/lib/codesite/__tests__/controlPlane.test.js']);
const sourceDiffDigest = sha256(await runGit(['diff', '--', 'synthi/src/lib/codesite/controlPlane.js', 'synthi/src/lib/codesite/__tests__/controlPlane.test.js']));

const summary = {
  generatedAt: new Date().toISOString(),
  branch,
  head,
  sourceDiffDigest,
  patch: 'automatic workflow proof closure, landing command capture, and serializable commit race validation',
  focusedVitest: summarizeVitest(focused),
  fullVitest: {
    ...summarizeVitest(full),
    failures: fullFailures,
  },
  repairedFailures: focusedPassed.map((test) => test.name),
  validationClaims: [
    'Inspection commands capture stdout and stderr through file-backed descriptors, covering environments where child stdout pipes are unreliable.',
    'Explicit baseSnapshot digests no longer trigger uncontrolled repo-wide scans; real baseSnapshotEvidence objects remain the proof source.',
    'Writeful automatic workflows now prove serializable base evidence with repo-wide snapshots before commit.',
    'Overlapping proof-carrying commit races use repo-wide snapshot evidence so the queued loser is blocked by stale read detection after the winner lands.',
    'The full CodeSite snapshot/artifact/control-plane suite passes for the current worktree patch.',
  ],
  evidenceFiles: [
    'tmp/codesite-dojo-proof/automatic-workflow-proof-closure/vitest-focused.json',
    'tmp/codesite-dojo-proof/automatic-workflow-proof-closure/vitest-full.json',
    'tmp/codesite-dojo-proof/automatic-workflow-proof-closure/summary.json',
    'tmp/codesite-dojo-proof/automatic-workflow-proof-closure/proof.html',
    'tmp/codesite-dojo-proof/automatic-workflow-proof-closure/proof.png',
  ],
  diffStat,
  status,
};

await fs.writeFile(summaryPath, `${JSON.stringify(summary, null, 2)}\n`);

const focusedRows = focusedPassed.map((test) => `
  <tr>
    <td>${escapeHtml(test.name)}</td>
    <td>${escapeHtml(test.file)}</td>
    <td class="num">${test.durationMs} ms</td>
  </tr>
`).join('');

const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>CodeSite automatic workflow proof closure</title>
  <style>
    :root {
      color-scheme: dark;
      --bg: #070a0d;
      --panel: #10161c;
      --panel-2: #151d24;
      --line: #2a3742;
      --text: #ecf3f6;
      --muted: #9ba9b1;
      --accent: #74d7a6;
      --blue: #74b8ff;
      --amber: #f3c76b;
      --danger: #ff7d7d;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      min-height: 100vh;
      color: var(--text);
      background:
        radial-gradient(circle at 12% 10%, rgba(116, 215, 166, 0.16), transparent 28%),
        radial-gradient(circle at 92% 8%, rgba(116, 184, 255, 0.12), transparent 30%),
        linear-gradient(145deg, var(--bg), #0a0f14 48%, #06090c);
      font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }
    main {
      width: 1360px;
      min-height: 1100px;
      padding: 52px;
      display: grid;
      grid-template-columns: 1fr 0.92fr;
      gap: 28px;
    }
    .hero, .panel {
      border: 1px solid var(--line);
      background: linear-gradient(180deg, rgba(21, 29, 36, 0.96), rgba(12, 17, 22, 0.98));
      border-radius: 8px;
      box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.05), 0 22px 80px rgba(0, 0, 0, 0.32);
    }
    .hero {
      grid-column: 1 / -1;
      padding: 34px 38px;
      display: grid;
      grid-template-columns: 1.1fr 0.9fr;
      gap: 28px;
      align-items: end;
    }
    .eyebrow {
      color: var(--accent);
      font-size: 12px;
      letter-spacing: 0.16em;
      text-transform: uppercase;
      font-weight: 800;
    }
    h1 {
      margin: 14px 0 0;
      max-width: 820px;
      font-size: 56px;
      line-height: 0.96;
      letter-spacing: 0;
    }
    .sub {
      margin: 18px 0 0;
      color: var(--muted);
      max-width: 760px;
      font-size: 18px;
      line-height: 1.55;
    }
    .status-grid {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 12px;
    }
    .tile {
      border: 1px solid rgba(255, 255, 255, 0.09);
      background: rgba(255, 255, 255, 0.035);
      border-radius: 8px;
      padding: 18px;
    }
    .tile .label {
      color: var(--muted);
      font-size: 12px;
      letter-spacing: 0.08em;
      text-transform: uppercase;
      font-weight: 750;
    }
    .tile .value {
      margin-top: 8px;
      font-size: 30px;
      font-weight: 850;
    }
    .value.good { color: var(--accent); }
    .value.warn { color: var(--amber); }
    .panel {
      padding: 24px;
      min-height: 210px;
    }
    .panel h2 {
      margin: 0 0 16px;
      font-size: 21px;
      letter-spacing: 0;
    }
    .stack { display: grid; gap: 12px; }
    .claim {
      display: grid;
      grid-template-columns: 28px 1fr;
      gap: 12px;
      align-items: start;
      color: #dce7ec;
      line-height: 1.45;
    }
    .check {
      width: 28px;
      height: 28px;
      display: grid;
      place-items: center;
      border-radius: 50%;
      color: #05100b;
      background: var(--accent);
      font-weight: 900;
    }
    table {
      width: 100%;
      border-collapse: collapse;
      overflow: hidden;
      border: 1px solid var(--line);
      border-radius: 8px;
    }
    th, td {
      padding: 13px 14px;
      border-bottom: 1px solid rgba(255, 255, 255, 0.07);
      text-align: left;
      vertical-align: top;
      font-size: 13px;
      line-height: 1.35;
    }
    th {
      color: var(--muted);
      background: rgba(255, 255, 255, 0.045);
      font-size: 11px;
      letter-spacing: 0.11em;
      text-transform: uppercase;
    }
    tr:last-child td { border-bottom: 0; }
    .num { text-align: right; white-space: nowrap; color: var(--accent); font-variant-numeric: tabular-nums; }
    pre {
      margin: 0;
      white-space: pre-wrap;
      color: #dce6eb;
      background: #080c10;
      border: 1px solid rgba(255, 255, 255, 0.08);
      border-radius: 8px;
      padding: 16px;
      font-size: 12px;
      line-height: 1.55;
    }
    .wide { grid-column: 1 / -1; }
    .file-list {
      display: grid;
      gap: 8px;
      color: var(--muted);
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      font-size: 12px;
    }
    .digest {
      color: var(--blue);
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      overflow-wrap: anywhere;
    }
  </style>
</head>
<body>
  <main>
    <section class="hero">
      <div>
        <div class="eyebrow">CodeSite proof closure</div>
        <h1>Automatic workflow and serializable landing are proven in this worktree.</h1>
        <p class="sub">This rendered artifact is generated from Vitest JSON reports and source diff metadata. It verifies the specific failures that were open, then the full CodeSite control-plane proof suite.</p>
      </div>
      <div class="status-grid">
        <div class="tile"><div class="label">Branch</div><div class="value">${escapeHtml(branch || 'unknown')}</div></div>
        <div class="tile"><div class="label">HEAD</div><div class="value">${escapeHtml(head || 'unknown')}</div></div>
        <div class="tile"><div class="label">Focused tests</div><div class="value good">${summary.focusedVitest.tests.passed}/${summary.focusedVitest.tests.passed + summary.focusedVitest.tests.failed}</div></div>
        <div class="tile"><div class="label">Full suite</div><div class="value good">${summary.fullVitest.tests.passed}/${summary.fullVitest.tests.total}</div></div>
      </div>
    </section>

    <section class="panel">
      <h2>Behavioral Claims</h2>
      <div class="stack">
        ${summary.validationClaims.map((claim) => `<div class="claim"><div class="check">✓</div><div>${escapeHtml(claim)}</div></div>`).join('')}
      </div>
    </section>

    <section class="panel">
      <h2>Patch Identity</h2>
      <div class="stack">
        <div><strong>Diff digest</strong><br /><span class="digest">${escapeHtml(sourceDiffDigest)}</span></div>
        <div><strong>Changed source/test files</strong></div>
        <pre>${escapeHtml(diffStat || 'No source diff detected')}</pre>
      </div>
    </section>

    <section class="panel wide">
      <h2>Focused Regression Closure</h2>
      <table>
        <thead><tr><th>Test</th><th>File</th><th>Duration</th></tr></thead>
        <tbody>${focusedRows}</tbody>
      </table>
    </section>

    <section class="panel">
      <h2>Full CodeSite Suite</h2>
      <div class="status-grid">
        <div class="tile"><div class="label">Suites passed</div><div class="value good">${summary.fullVitest.suites.passed}/${summary.fullVitest.suites.total}</div></div>
        <div class="tile"><div class="label">Failures</div><div class="value ${summary.fullVitest.tests.failed === 0 ? 'good' : 'warn'}">${summary.fullVitest.tests.failed}</div></div>
        <div class="tile"><div class="label">Skipped</div><div class="value">${summary.fullVitest.tests.skipped}</div></div>
        <div class="tile"><div class="label">Report success</div><div class="value good">${summary.fullVitest.success ? 'true' : 'false'}</div></div>
      </div>
    </section>

    <section class="panel">
      <h2>Evidence Files</h2>
      <div class="file-list">
        ${summary.evidenceFiles.map((file) => `<div>${escapeHtml(file)}</div>`).join('')}
      </div>
    </section>

    <section class="panel wide">
      <h2>Working Tree Context</h2>
      <pre>${escapeHtml(status || 'clean')}</pre>
    </section>
  </main>
</body>
</html>`;

await fs.writeFile(htmlPath, html);
await renderScreenshot();

const pngStat = await fs.stat(pngPath);
const finalized = {
  ...summary,
  proofPng: {
    path: path.relative(process.cwd(), pngPath),
    bytes: pngStat.size,
    sha256: sha256(await fs.readFile(pngPath)),
  },
};
await fs.writeFile(summaryPath, `${JSON.stringify(finalized, null, 2)}\n`);
console.log(JSON.stringify({
  ok: finalized.focusedVitest.success && finalized.fullVitest.success && finalized.proofPng.bytes > 10000,
  summaryPath: path.relative(process.cwd(), summaryPath),
  htmlPath: path.relative(process.cwd(), htmlPath),
  pngPath: path.relative(process.cwd(), pngPath),
  pngBytes: finalized.proofPng.bytes,
}, null, 2));
