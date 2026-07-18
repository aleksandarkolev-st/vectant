import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { chromium } from 'playwright';
import {
  REQUIRED_MATURE_PROOFS,
  validateMatureProofSuiteRun,
} from './codesite-release-gate.mjs';

function git(root, args) {
  return execFileSync('git', ['-C', root, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function commitAll(root, message) {
  git(root, ['add', '-A']);
  git(root, ['commit', '-m', message]);
  return git(root, ['rev-parse', 'HEAD']);
}

function assertProof(condition, message) {
  if (!condition) throw new Error(message);
}

function repoRoot() {
  return path.basename(process.cwd()) === 'synthi'
    ? path.dirname(process.cwd())
    : process.cwd();
}

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

async function writeProofArtifacts(result) {
  const outDir = process.env.CODESITE_PROOF_OUT_DIR
    ? path.resolve(process.env.CODESITE_PROOF_OUT_DIR)
    : null;
  if (!outDir) return {};
  fs.mkdirSync(outDir, { recursive: true });
  const jsonPath = path.join(outDir, 'codesite-release-gate-suite-freshness-proof.json');
  const htmlPath = path.join(outDir, 'codesite-release-gate-suite-freshness-proof.html');
  const pngPath = path.join(outDir, 'codesite-release-gate-suite-freshness-proof.png');
  writeJson(jsonPath, result);
  fs.writeFileSync(htmlPath, `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>CodeSite Release Gate Suite Freshness Proof</title>
  <style>
    body { margin: 0; background: #07080d; color: #f8fafc; font: 14px/1.5 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
    main { padding: 32px; display: grid; gap: 18px; }
    h1 { margin: 0; font: 700 24px/1.1 Inter, ui-sans-serif, system-ui, sans-serif; }
    .grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 12px; }
    .card { border: 1px solid #293042; border-radius: 8px; background: #11131d; padding: 14px; min-height: 110px; }
    .label { color: #a8b3cf; font: 600 11px/1.2 Inter, ui-sans-serif, system-ui, sans-serif; letter-spacing: .04em; text-transform: uppercase; }
    .value { margin-top: 8px; word-break: break-all; }
    .pass { color: #86efac; }
    .fail { color: #fca5a5; }
    pre { margin: 0; white-space: pre-wrap; word-break: break-word; border: 1px solid #293042; border-radius: 8px; background: #0b0d14; padding: 14px; }
  </style>
</head>
<body>
  <main>
    <h1>CodeSite Release Gate Suite Freshness Proof</h1>
    <section class="grid">
      <div class="card"><div class="label">Artifact-only suite commit</div><div class="value pass">accepted</div></div>
      <div class="card"><div class="label">Source commit after proof</div><div class="value fail">rejected</div></div>
      <div class="card"><div class="label">Required mature proofs</div><div class="value">${result.artifactSummary.results}/${result.artifactSummary.required}</div></div>
    </section>
    <section class="grid">
      <div class="card"><div class="label">Proof head</div><div class="value">${escapeHtml(result.proofHead)}</div></div>
      <div class="card"><div class="label">Artifact head</div><div class="value">${escapeHtml(result.artifactHead)}</div></div>
      <div class="card"><div class="label">Source head</div><div class="value">${escapeHtml(result.sourceHead)}</div></div>
    </section>
    <pre>${escapeHtml(JSON.stringify(result, null, 2))}</pre>
  </main>
</body>
</html>
`);
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1200, height: 900 }, deviceScaleFactor: 1 });
  await page.goto(`file://${htmlPath}`, { waitUntil: 'load' });
  await page.screenshot({ path: pngPath, fullPage: true });
  await browser.close();
  const artifacts = {
    jsonPath: path.relative(repoRoot(), jsonPath).split(path.sep).join('/'),
    htmlPath: path.relative(repoRoot(), htmlPath).split(path.sep).join('/'),
    pngPath: path.relative(repoRoot(), pngPath).split(path.sep).join('/'),
  };
  writeJson(jsonPath, { ...result, artifacts });
  return artifacts;
}

function buildSuiteRun({ root, proofRoot, proofHead, statusShort = '' }) {
  return {
    ok: true,
    proofRoot: path.relative(root, proofRoot).split(path.sep).join('/'),
    results: REQUIRED_MATURE_PROOFS.map((spec) => ({
      name: spec.name,
      ok: true,
    })),
    git: {
      head: proofHead,
      statusShort,
    },
  };
}

async function main() {
  const tempRoot = process.env.TMPDIR || '/tmp';
  fs.mkdirSync(tempRoot, { recursive: true });
  const root = fs.mkdtempSync(path.join(tempRoot, 'codesite-suite-freshness-'));
  try {
    git(root, ['init']);
    git(root, ['config', 'user.email', 'codesite-proof@example.invalid']);
    git(root, ['config', 'user.name', 'CodeSite Proof']);
    fs.writeFileSync(path.join(root, 'README.md'), '# proof fixture\n');
    const proofHead = commitAll(root, 'base');
    const proofRoot = path.join(root, 'tmp', 'codesite-dojo-proof');
    const runPath = path.join(proofRoot, 'codesite-mature-proof-suite-run.json');

    writeJson(runPath, buildSuiteRun({ root, proofRoot, proofHead }));
    const artifactHead = commitAll(root, 'artifact-only suite summary');
    const artifactFailures = [];
    const artifactSummary = validateMatureProofSuiteRun({
      root,
      proofRoot,
      failures: artifactFailures,
    });
    assertProof(
      artifactSummary.ok === true && artifactFailures.length === 0,
      `artifact-only suite summary should pass: ${artifactFailures.join('; ')}`,
    );
    assertProof(
      artifactSummary.proofHead === proofHead &&
        artifactSummary.currentHead === artifactHead &&
        artifactSummary.artifactOnlyPostProofChanges === true,
      'artifact-only suite summary must report ancestor proof head and artifact-only changes',
    );

    fs.mkdirSync(path.join(root, 'src'), { recursive: true });
    fs.writeFileSync(path.join(root, 'src', 'change.js'), 'export const changed = true;\n');
    const sourceHead = commitAll(root, 'source change after suite proof');
    const sourceFailures = [];
    const sourceSummary = validateMatureProofSuiteRun({
      root,
      proofRoot,
      failures: sourceFailures,
    });
    assertProof(sourceSummary.ok === false, 'source change after suite proof must fail');
    assertProof(
      sourceSummary.currentHead === sourceHead &&
        sourceSummary.artifactOnlyPostProofChanges === false,
      'source change failure must record non-artifact post-proof changes',
    );
    assertProof(
      sourceFailures.some((failure) => failure.includes('non-artifact changes occurred after suite head')),
      `source change failure should cite non-artifact changes: ${sourceFailures.join('; ')}`,
    );

    const result = {
      ok: true,
      proofHead,
      artifactHead,
      sourceHead,
      artifactSummary,
      sourceFailures,
    };
    result.artifacts = await writeProofArtifacts(result);
    process.stdout.write(JSON.stringify(result, null, 2));
    process.stdout.write('\n');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

await main();
