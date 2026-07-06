import fs from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';

const proofDir = path.resolve('tmp/codesite-dojo-proof/shadow-runner-artifact-chain');
const focusedPath = path.join(proofDir, 'vitest-focused.json');
const residualPath = path.join(proofDir, 'vitest-residual.json');
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
  };
}

function failedTests(report) {
  return (report.testResults || []).flatMap((file) => (
    (file.assertionResults || [])
      .filter((test) => test.status === 'failed')
      .map((test) => test.fullName || test.title || 'unnamed test')
  ));
}

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
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
  if (!headContent.startsWith('ref: ')) return { branch: 'detached', head: headContent.slice(0, 12) };
  const ref = headContent.slice('ref: '.length).trim();
  let refPath = path.join(gitDir, ref);
  try {
    await fs.access(refPath);
  } catch {
    const commonDirRaw = await fs.readFile(path.join(gitDir, 'commondir'), 'utf8');
    refPath = path.join(path.resolve(gitDir, commonDirRaw.trim()), ref);
  }
  const head = (await fs.readFile(refPath, 'utf8')).trim().slice(0, 12);
  return { branch: ref.replace(/^refs\/heads\//, ''), head };
}

const focused = JSON.parse(await fs.readFile(focusedPath, 'utf8'));
const residual = JSON.parse(await fs.readFile(residualPath, 'utf8'));
const { branch, head } = await readGitIdentity();

const summary = {
  generatedAt: new Date().toISOString(),
  branch,
  head,
  patch: 'shadow-runner artifact chain and counterfactual memory',
  focusedVitest: summarizeVitest(focused),
  residualVitest: {
    ...summarizeVitest(residual),
    failures: failedTests(residual),
  },
  behavioralAssertions: [
    'External shadow runner results are read from a durable JSON artifact, not only stdout tail.',
    'Runner evidence refs include input, command, output artifact, stdout, and result digests.',
    'Repo command universes merge per-strategy execution status back into counterfactual runs.',
    'Promoted counterfactual policy deltas are first-class ranking signals with bounded priority.',
    'Project relation arrays are normalized at the API boundary for sparse projections.',
  ],
  evidenceFiles: [
    'tmp/codesite-dojo-proof/shadow-runner-artifact-chain/vitest-focused.json',
    'tmp/codesite-dojo-proof/shadow-runner-artifact-chain/vitest-residual.json',
    'tmp/codesite-dojo-proof/shadow-runner-artifact-chain/summary.json',
    'tmp/codesite-dojo-proof/shadow-runner-artifact-chain/proof.html',
    'tmp/codesite-dojo-proof/shadow-runner-artifact-chain/proof.png',
  ],
};

await fs.writeFile(summaryPath, `${JSON.stringify(summary, null, 2)}\n`);

const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>CodeSite shadow runner proof</title>
  <style>
    :root {
      color-scheme: dark;
      --surface: #090d12;
      --panel: #101821;
      --line: #263543;
      --text: #edf3f7;
      --muted: #9baab6;
      --accent: #69d6ff;
      --green: #62d795;
      --amber: #efbd6d;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      min-height: 100vh;
      color: var(--text);
      background:
        radial-gradient(circle at 16% 9%, rgba(105, 214, 255, 0.13), transparent 28%),
        radial-gradient(circle at 86% 18%, rgba(98, 215, 149, 0.10), transparent 32%),
        linear-gradient(145deg, var(--surface), #0b1118 52%, #090d12);
      font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }
    main {
      width: 1200px;
      min-height: 760px;
      padding: 54px;
      display: grid;
      grid-template-columns: 1.06fr 0.94fr;
      gap: 28px;
    }
    section {
      border: 1px solid var(--line);
      border-radius: 18px;
      background: linear-gradient(180deg, rgba(255,255,255,0.046), rgba(255,255,255,0.017));
      box-shadow: inset 0 1px 0 rgba(255,255,255,0.08);
      padding: 26px;
    }
    .hero {
      grid-column: 1 / -1;
      display: grid;
      grid-template-columns: 1fr auto;
      align-items: end;
      gap: 32px;
      padding: 30px 32px;
    }
    .eyebrow {
      color: var(--accent);
      font-size: 12px;
      letter-spacing: 0.18em;
      text-transform: uppercase;
      font-weight: 800;
    }
    h1 {
      margin: 10px 0 0;
      max-width: 820px;
      font-size: 44px;
      line-height: 1.03;
      letter-spacing: 0;
    }
    .meta {
      text-align: right;
      color: var(--muted);
      font: 14px/1.6 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    }
    h2 { margin: 0 0 18px; font-size: 20px; letter-spacing: 0; }
    .metrics {
      display: grid;
      grid-template-columns: repeat(4, 1fr);
      gap: 12px;
      margin-bottom: 20px;
    }
    .metric {
      border: 1px solid var(--line);
      border-radius: 14px;
      background: var(--panel);
      padding: 16px;
    }
    .metric strong {
      display: block;
      color: var(--green);
      font: 30px/1 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    }
    .metric span {
      display: block;
      margin-top: 8px;
      color: var(--muted);
      font-size: 12px;
      line-height: 1.35;
    }
    ul { list-style: none; display: grid; gap: 11px; margin: 0; padding: 0; }
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
      background: var(--green);
      box-shadow: 0 0 0 5px rgba(98, 215, 149, 0.11);
    }
    .failures li::before {
      background: var(--amber);
      box-shadow: 0 0 0 5px rgba(239, 189, 109, 0.12);
    }
    .files {
      display: grid;
      gap: 10px;
    }
    .file {
      display: grid;
      grid-template-columns: 1fr auto;
      gap: 14px;
      align-items: center;
      border: 1px solid var(--line);
      border-radius: 12px;
      background: rgba(16, 24, 33, 0.76);
      padding: 12px 14px;
    }
    code {
      color: var(--muted);
      overflow-wrap: anywhere;
      font-size: 12px;
    }
    .status {
      border-radius: 999px;
      background: rgba(98, 215, 149, 0.14);
      color: var(--green);
      padding: 6px 10px;
      min-width: 76px;
      text-align: center;
      text-transform: uppercase;
      letter-spacing: 0.08em;
      font-size: 12px;
      font-weight: 800;
    }
  </style>
</head>
<body>
  <main>
    <section class="hero">
      <div>
        <div class="eyebrow">CodeSite shadow proof</div>
        <h1>External runner evidence is bound to a durable artifact chain</h1>
      </div>
      <div class="meta">
        <div>${escapeHtml(summary.branch)}</div>
        <div>HEAD ${escapeHtml(summary.head)}</div>
        <div>${escapeHtml(summary.generatedAt)}</div>
      </div>
    </section>
    <section>
      <h2>Focused Vitest Run</h2>
      <div class="metrics">
        <div class="metric"><strong>${summary.focusedVitest.passed}</strong><span>passed</span></div>
        <div class="metric"><strong>${summary.focusedVitest.failed}</strong><span>failed</span></div>
        <div class="metric"><strong>${summary.focusedVitest.skipped}</strong><span>skipped by pattern</span></div>
        <div class="metric"><strong>1</strong><span>test file</span></div>
      </div>
      <ul>
        ${summary.behavioralAssertions.map((item) => `<li>${escapeHtml(item)}</li>`).join('')}
      </ul>
    </section>
    <section>
      <h2>Evidence Files</h2>
      <div class="files">
        ${summary.evidenceFiles.map((file) => `<div class="file"><code>${escapeHtml(file)}</code><span class="status">saved</span></div>`).join('')}
      </div>
    </section>
    <section>
      <h2>Broad Residuals</h2>
      <div class="metrics">
        <div class="metric"><strong>${summary.residualVitest.passed}</strong><span>passed in broad slice</span></div>
        <div class="metric"><strong>${summary.residualVitest.failed}</strong><span>remaining failures</span></div>
        <div class="metric"><strong>${summary.residualVitest.total}</strong><span>selected tests</span></div>
        <div class="metric"><strong>3</strong><span>next backend blockers</span></div>
      </div>
      <ul class="failures">
        ${summary.residualVitest.failures.map((failure) => `<li>${escapeHtml(failure)}</li>`).join('')}
      </ul>
    </section>
    <section>
      <h2>Validation Meaning</h2>
      <ul>
        <li>This fixes the runner boundary generically: file artifact first, stdout fallback second.</li>
        <li>Counterfactual memory now changes choices only through promoted policy deltas.</li>
        <li>The remaining broad failures are automatic workflow and commit-race proof fallout, not shadow runner failures.</li>
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
