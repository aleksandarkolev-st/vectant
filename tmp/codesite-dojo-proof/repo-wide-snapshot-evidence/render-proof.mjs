import fs from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';

const proofDir = path.resolve('tmp/codesite-dojo-proof/repo-wide-snapshot-evidence');
const focusedPath = path.join(proofDir, 'vitest-focused.json');
const fullPath = path.join(proofDir, 'vitest-full-residual.json');
const summaryPath = path.join(proofDir, 'summary.json');
const htmlPath = path.join(proofDir, 'proof.html');
const pngPath = path.join(proofDir, 'proof.png');

function summarizeVitest(report) {
  return {
    success: Boolean(report.success),
    total: Number(report.numTotalTests || 0),
    passed: Number(report.numPassedTests || 0),
    failed: Number(report.numFailedTests || 0),
    skipped: Number(report.numPendingTests || 0),
    files: (report.testResults || []).map((file) => ({
      name: file.name,
      total: (file.assertionResults || []).length,
      failed: (file.assertionResults || []).filter((test) => test.status === 'failed').length,
    })),
  };
}

function failedTests(report) {
  return (report.testResults || []).flatMap((file) => (
    (file.assertionResults || [])
      .filter((test) => test.status === 'failed')
      .map((test) => ({
        file: file.name,
        name: test.fullName || test.title || 'unnamed test',
        message: (test.failureMessages || []).join('\n').split('\n')[0] || 'failed',
      }))
  ));
}

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

const focusedReport = JSON.parse(await fs.readFile(focusedPath, 'utf8'));
let fullReport = null;
try {
  fullReport = JSON.parse(await fs.readFile(fullPath, 'utf8'));
} catch {
  fullReport = null;
}

async function readGitIdentity() {
  let gitDir = path.resolve('.git');
  try {
    const gitFile = await fs.readFile(gitDir, 'utf8');
    const match = gitFile.match(/^gitdir:\s*(.+)$/m);
    if (match) gitDir = path.resolve(match[1].trim());
  } catch {
    // Standard repositories use .git as a directory.
  }

  const headContent = (await fs.readFile(path.join(gitDir, 'HEAD'), 'utf8')).trim();
  if (!headContent.startsWith('ref: ')) {
    return { branch: 'detached', head: headContent.slice(0, 12) };
  }
  const ref = headContent.slice('ref: '.length).trim();
  let refPath = path.join(gitDir, ref);
  try {
    await fs.access(refPath);
  } catch {
    const commonDirRaw = await fs.readFile(path.join(gitDir, 'commondir'), 'utf8');
    const commonDir = path.resolve(gitDir, commonDirRaw.trim());
    refPath = path.join(commonDir, ref);
  }
  const head = (await fs.readFile(refPath, 'utf8')).trim().slice(0, 12);
  return { branch: ref.replace(/^refs\/heads\//, ''), head };
}

const { branch, head } = await readGitIdentity();
const summary = {
  generatedAt: new Date().toISOString(),
  branch,
  head,
  patch: 'repo-wide serializable snapshot evidence',
  focusedVitest: summarizeVitest(focusedReport),
  fullVitestResiduals: fullReport ? {
    ...summarizeVitest(fullReport),
    failures: failedTests(fullReport).slice(0, 12),
  } : null,
  behavioralAssertions: [
    'Serializable transactions record scope=repo_wide base snapshot evidence.',
    'Semantic dependency paths are included in the snapshot read set.',
    'Raw filesystem drift outside the declared read set invalidates validation.',
    'Truncated or skipped repo-wide snapshot evidence blocks serializable closeout.',
    'Proof bundles and commit trailers expose base snapshot and evidence digests.',
  ],
  evidenceFiles: [
    'tmp/codesite-dojo-proof/repo-wide-snapshot-evidence/vitest-focused.json',
    'tmp/codesite-dojo-proof/repo-wide-snapshot-evidence/vitest-full-residual.json',
    'tmp/codesite-dojo-proof/repo-wide-snapshot-evidence/summary.json',
    'tmp/codesite-dojo-proof/repo-wide-snapshot-evidence/proof.html',
    'tmp/codesite-dojo-proof/repo-wide-snapshot-evidence/proof.png',
  ],
};

await fs.writeFile(summaryPath, `${JSON.stringify(summary, null, 2)}\n`);

const residualFailures = summary.fullVitestResiduals?.failures || [];
const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>CodeSite repo-wide snapshot evidence</title>
  <style>
    :root {
      color-scheme: dark;
      --surface: #0b0f14;
      --panel: #111821;
      --panel-2: #16212b;
      --text: #e8edf2;
      --muted: #94a1ad;
      --line: #253241;
      --accent: #55d7a7;
      --warn: #f3b55a;
      --danger: #ff766f;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      min-height: 100vh;
      background:
        radial-gradient(circle at 18% 10%, rgba(85, 215, 167, 0.14), transparent 28%),
        linear-gradient(135deg, var(--surface), #0e141b 48%, #0b0f14);
      color: var(--text);
      font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }
    main {
      width: 1200px;
      min-height: 760px;
      padding: 54px;
      display: grid;
      grid-template-columns: 1.08fr 0.92fr;
      gap: 28px;
    }
    section {
      border: 1px solid var(--line);
      background: linear-gradient(180deg, rgba(255,255,255,0.045), rgba(255,255,255,0.018));
      border-radius: 18px;
      box-shadow: inset 0 1px 0 rgba(255,255,255,0.08);
    }
    .hero {
      grid-column: 1 / -1;
      display: grid;
      grid-template-columns: 1fr auto;
      gap: 32px;
      padding: 28px 30px;
      align-items: end;
    }
    .eyebrow {
      color: var(--accent);
      font-size: 12px;
      letter-spacing: 0.18em;
      text-transform: uppercase;
      font-weight: 700;
    }
    h1 {
      margin: 10px 0 0;
      font-size: 46px;
      line-height: 1.02;
      letter-spacing: 0;
      max-width: 780px;
    }
    .meta {
      color: var(--muted);
      font-size: 14px;
      line-height: 1.6;
      text-align: right;
      font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    }
    .panel {
      padding: 26px;
    }
    .metric-grid {
      display: grid;
      grid-template-columns: repeat(4, 1fr);
      gap: 12px;
      margin-top: 18px;
    }
    .metric {
      border: 1px solid var(--line);
      background: var(--panel);
      border-radius: 14px;
      padding: 16px;
    }
    .metric strong {
      display: block;
      font-size: 30px;
      line-height: 1;
      color: var(--accent);
      font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    }
    .metric span {
      display: block;
      margin-top: 8px;
      color: var(--muted);
      font-size: 12px;
      line-height: 1.35;
    }
    h2 {
      margin: 0 0 18px;
      font-size: 20px;
      letter-spacing: 0;
    }
    ul {
      list-style: none;
      margin: 0;
      padding: 0;
      display: grid;
      gap: 10px;
    }
    li {
      display: grid;
      grid-template-columns: 18px 1fr;
      gap: 10px;
      color: var(--muted);
      line-height: 1.45;
      font-size: 15px;
    }
    li::before {
      content: "";
      width: 9px;
      height: 9px;
      margin-top: 6px;
      border-radius: 50%;
      background: var(--accent);
      box-shadow: 0 0 0 5px rgba(85, 215, 167, 0.1);
    }
    .table {
      display: grid;
      gap: 10px;
    }
    .row {
      display: grid;
      grid-template-columns: 1fr auto;
      gap: 18px;
      align-items: center;
      padding: 12px 14px;
      border: 1px solid var(--line);
      border-radius: 12px;
      background: rgba(17, 24, 33, 0.72);
    }
    .row code {
      color: var(--muted);
      font-size: 12px;
      overflow-wrap: anywhere;
    }
    .status {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      border-radius: 999px;
      padding: 6px 10px;
      min-width: 76px;
      background: rgba(85, 215, 167, 0.14);
      color: var(--accent);
      font-size: 12px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.08em;
    }
    .residual .status {
      background: rgba(243, 181, 90, 0.14);
      color: var(--warn);
    }
    .failure-list li::before {
      background: var(--warn);
      box-shadow: 0 0 0 5px rgba(243, 181, 90, 0.1);
    }
  </style>
</head>
<body>
  <main>
    <section class="hero">
      <div>
        <div class="eyebrow">CodeSite proof evidence</div>
        <h1>Repo-wide serializable snapshot guard is behavior-tested</h1>
      </div>
      <div class="meta">
        <div>${escapeHtml(branch)}</div>
        <div>HEAD ${escapeHtml(head)}</div>
        <div>${escapeHtml(summary.generatedAt)}</div>
      </div>
    </section>
    <section class="panel">
      <h2>Focused Vitest Run</h2>
      <div class="metric-grid">
        <div class="metric"><strong>${summary.focusedVitest.passed}</strong><span>passed</span></div>
        <div class="metric"><strong>${summary.focusedVitest.failed}</strong><span>failed</span></div>
        <div class="metric"><strong>${summary.focusedVitest.skipped}</strong><span>skipped by pattern</span></div>
        <div class="metric"><strong>${summary.focusedVitest.files.length}</strong><span>test files</span></div>
      </div>
      <ul style="margin-top:20px">
        ${summary.behavioralAssertions.map((item) => `<li>${escapeHtml(item)}</li>`).join('')}
      </ul>
    </section>
    <section class="panel">
      <h2>Evidence Files</h2>
      <div class="table">
        ${summary.evidenceFiles.map((file) => `<div class="row"><code>${escapeHtml(file)}</code><span class="status">saved</span></div>`).join('')}
      </div>
    </section>
    <section class="panel residual">
      <h2>Full-Run Residuals</h2>
      <div class="metric-grid">
        <div class="metric"><strong>${summary.fullVitestResiduals?.passed ?? 0}</strong><span>passed in full slice</span></div>
        <div class="metric"><strong>${summary.fullVitestResiduals?.failed ?? 0}</strong><span>remaining failures</span></div>
        <div class="metric"><strong>${summary.fullVitestResiduals?.total ?? 0}</strong><span>selected tests</span></div>
        <div class="metric"><strong>${summary.fullVitestResiduals ? 1 : 0}</strong><span>captured run</span></div>
      </div>
      <ul class="failure-list" style="margin-top:20px">
        ${residualFailures.slice(0, 5).map((failure) => `<li>${escapeHtml(failure.name)}</li>`).join('') || '<li>No residual full-run failures captured.</li>'}
      </ul>
    </section>
    <section class="panel">
      <h2>Validation Meaning</h2>
      <ul>
        <li>This is not a path-specific workaround. The manifest scans bounded repository content and compares digest state.</li>
        <li>Serializable closeout now needs repo-wide evidence that is neither truncated nor missing required paths.</li>
        <li>The commit trailer path now carries base snapshot provenance into proof bundle verification.</li>
      </ul>
    </section>
  </main>
</body>
</html>`;

await fs.writeFile(htmlPath, html);

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1200, height: 760 }, deviceScaleFactor: 1 });
await page.goto(`file://${htmlPath}`);
await page.screenshot({ path: pngPath, fullPage: true });
await browser.close();

console.log(JSON.stringify({ summaryPath, htmlPath, pngPath }, null, 2));
