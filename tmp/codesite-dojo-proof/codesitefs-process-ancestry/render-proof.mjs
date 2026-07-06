import fs from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';

const proofDir = path.resolve('tmp/codesite-dojo-proof/codesitefs-process-ancestry');
const tapPath = path.join(proofDir, 'node-test.tap');
const summaryPath = path.join(proofDir, 'summary.json');
const htmlPath = path.join(proofDir, 'proof.html');
const pngPath = path.join(proofDir, 'proof.png');

function parseTapSummary(tap) {
  const get = (name) => Number((tap.match(new RegExp(`# ${name} (\\d+)`)) || [])[1] || 0);
  const tests = [];
  for (const line of tap.split(/\r?\n/)) {
    const match = line.match(/^ok\s+\d+\s+-\s+(.+)$/);
    if (match) tests.push(match[1]);
  }
  return {
    tests: get('tests'),
    pass: get('pass'),
    fail: get('fail'),
    skipped: get('skipped'),
    durationMs: Number((tap.match(/# duration_ms ([\d.]+)/) || [])[1] || 0),
    files: tests,
  };
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
  if (!headContent.startsWith('ref: ')) {
    return { branch: 'detached', head: headContent.slice(0, 12) };
  }
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

const tap = await fs.readFile(tapPath, 'utf8');
const { branch, head } = await readGitIdentity();
const summary = {
  generatedAt: new Date().toISOString(),
  branch,
  head,
  patch: 'CodeSiteFS process ancestry and host-write provenance',
  nodeTest: parseTapSummary(tap),
  behavioralAssertions: [
    'CodeSiteFS records sanitized Linux procfs ancestry without raw command-line leakage.',
    'Managed read and write events include caller-supplied and OS-derived process ancestry sources.',
    'Quarantine evidence now carries before and after file stat metadata.',
    'Host-write sentinel manifests include detector ancestry and explicit writer-attribution limits.',
    'Direct gitService reads and writes preserve their caller ancestry while adding OS process evidence.',
  ],
  evidenceFiles: [
    'tmp/codesite-dojo-proof/codesitefs-process-ancestry/node-test.tap',
    'tmp/codesite-dojo-proof/codesitefs-process-ancestry/summary.json',
    'tmp/codesite-dojo-proof/codesitefs-process-ancestry/proof.html',
    'tmp/codesite-dojo-proof/codesitefs-process-ancestry/proof.png',
  ],
};

await fs.writeFile(summaryPath, `${JSON.stringify(summary, null, 2)}\n`);

const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>CodeSiteFS process ancestry proof</title>
  <style>
    :root {
      color-scheme: dark;
      --surface: #0a0e12;
      --panel: #101720;
      --panel-2: #151f2a;
      --line: #263442;
      --text: #edf2f6;
      --muted: #9ba9b5;
      --accent: #61d394;
      --amber: #eeb868;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      min-height: 100vh;
      background:
        radial-gradient(circle at 76% 8%, rgba(97, 211, 148, 0.16), transparent 30%),
        linear-gradient(140deg, #0a0e12, #0d141a 48%, #0b1016);
      color: var(--text);
      font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }
    main {
      width: 1200px;
      min-height: 760px;
      padding: 54px;
      display: grid;
      grid-template-columns: 0.95fr 1.05fr;
      gap: 28px;
    }
    section {
      border: 1px solid var(--line);
      background: linear-gradient(180deg, rgba(255,255,255,0.046), rgba(255,255,255,0.017));
      border-radius: 18px;
      box-shadow: inset 0 1px 0 rgba(255,255,255,0.08);
      padding: 26px;
    }
    .hero {
      grid-column: 1 / -1;
      display: grid;
      grid-template-columns: 1fr auto;
      align-items: end;
      gap: 34px;
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
      max-width: 800px;
      font-size: 44px;
      line-height: 1.03;
      letter-spacing: 0;
    }
    .meta {
      text-align: right;
      color: var(--muted);
      font: 14px/1.6 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    }
    h2 {
      margin: 0 0 18px;
      font-size: 20px;
      letter-spacing: 0;
    }
    .metrics {
      display: grid;
      grid-template-columns: repeat(4, 1fr);
      gap: 12px;
    }
    .metric {
      border: 1px solid var(--line);
      border-radius: 14px;
      background: var(--panel);
      padding: 16px;
    }
    .metric strong {
      display: block;
      color: var(--accent);
      font: 31px/1 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    }
    .metric span {
      display: block;
      margin-top: 8px;
      color: var(--muted);
      font-size: 12px;
      line-height: 1.35;
    }
    ul {
      list-style: none;
      display: grid;
      gap: 11px;
      margin: 0;
      padding: 0;
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
      box-shadow: 0 0 0 5px rgba(97, 211, 148, 0.11);
    }
    .files {
      display: grid;
      gap: 10px;
    }
    .file {
      display: grid;
      grid-template-columns: 1fr auto;
      gap: 16px;
      align-items: center;
      border: 1px solid var(--line);
      border-radius: 12px;
      background: rgba(16, 23, 32, 0.75);
      padding: 12px 14px;
    }
    code {
      color: var(--muted);
      font-size: 12px;
      overflow-wrap: anywhere;
    }
    .status {
      border-radius: 999px;
      background: rgba(97, 211, 148, 0.14);
      color: var(--accent);
      padding: 6px 10px;
      min-width: 76px;
      text-align: center;
      text-transform: uppercase;
      letter-spacing: 0.08em;
      font-size: 12px;
      font-weight: 800;
    }
    .note {
      color: var(--muted);
      line-height: 1.55;
      font-size: 15px;
    }
    .note strong { color: var(--amber); }
  </style>
</head>
<body>
  <main>
    <section class="hero">
      <div>
        <div class="eyebrow">CodeSiteFS proof evidence</div>
        <h1>Host-write provenance records what it can prove</h1>
      </div>
      <div class="meta">
        <div>${escapeHtml(summary.branch)}</div>
        <div>HEAD ${escapeHtml(summary.head)}</div>
        <div>${escapeHtml(summary.generatedAt)}</div>
      </div>
    </section>
    <section>
      <h2>Node Test Run</h2>
      <div class="metrics">
        <div class="metric"><strong>${summary.nodeTest.pass}</strong><span>passed files</span></div>
        <div class="metric"><strong>${summary.nodeTest.fail}</strong><span>failed files</span></div>
        <div class="metric"><strong>${summary.nodeTest.tests}</strong><span>test files</span></div>
        <div class="metric"><strong>${Math.round(summary.nodeTest.durationMs / 1000)}</strong><span>seconds</span></div>
      </div>
      <ul style="margin-top:20px">
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
      <h2>Runtime Boundary Meaning</h2>
      <p class="note">This patch avoids fake certainty. The polling sentinel explicitly marks <strong>writer attribution unavailable</strong> after a completed host write and names the required pre-write boundary: fanotify, eBPF, FUSE overlay, or equivalent.</p>
      <p class="note">Managed CodeSiteFS paths still bind caller ancestry to live OS process ancestry, and quarantine evidence now includes stat metadata so replay and inspection have durable file-system context.</p>
    </section>
    <section>
      <h2>Covered Files</h2>
      <ul>
        ${summary.nodeTest.files.map((file) => `<li>${escapeHtml(path.relative(process.cwd(), file))}</li>`).join('')}
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
