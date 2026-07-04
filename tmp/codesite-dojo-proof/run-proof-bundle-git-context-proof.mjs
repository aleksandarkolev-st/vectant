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
const outBase = path.join(proofRoot, 'codesite-proof-bundle-git-context-proof');

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd || repoRoot,
    encoding: 'utf8',
    maxBuffer: 180 * 1024 * 1024,
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
    json: parseJsonOutput(result.stdout),
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
  return {
    runner: 'command',
    tests: clean.includes('Error:') || clean.includes('SyntaxError') ? 1 : 0,
    pass: clean.includes('Error:') || clean.includes('SyntaxError') ? 0 : 1,
    fail: clean.includes('Error:') || clean.includes('SyntaxError') ? 1 : 0,
  };
}

function parseJsonOutput(value) {
  try {
    return JSON.parse(value);
  } catch (_) {
    return null;
  }
}

function stripAnsi(value) {
  return String(value || '').replace(/\u001b\[[0-9;]*m/g, '');
}

function read(relativePath) {
  return fs.readFileSync(path.join(repoRoot, relativePath), 'utf8');
}

function gitText(args) {
  const result = spawnSync('git', args, { cwd: repoRoot, encoding: 'utf8' });
  return result.status === 0 ? String(result.stdout || '').trim() : null;
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

function assert(condition, name, assertions, details = {}) {
  assertions.push({ name, ok: Boolean(condition), details });
}

function releaseGateProofBundleCheck(releaseGate) {
  const checks = releaseGate.json?.checks || [];
  return checks.find((check) => check.name === 'proofBundles') || null;
}

function releaseGateFailures(releaseGate) {
  return Array.isArray(releaseGate.json?.failures) ? releaseGate.json.failures : [];
}

function renderHtml(proof) {
  const assertionRows = proof.assertions.map((item) => (
    `<tr><td class="${item.ok ? 'ok' : 'fail'}">${item.ok ? 'PASS' : 'FAIL'}</td><td>${escapeHtml(item.name)}</td><td>${escapeHtml(JSON.stringify(item.details || {}))}</td></tr>`
  )).join('');
  const commandRows = proof.commands.map((item) => (
    `<tr><td class="${item.exitCode === 0 ? 'ok' : 'fail'}">${item.exitCode === 0 ? 'PASS' : 'FAIL'}</td><td><code>${escapeHtml(item.command)}</code><div class="cwd">${escapeHtml(item.cwd)}</div></td><td>${escapeHtml(commandResult(item))}</td></tr>`
  )).join('');
  const negativeRows = proof.negativeChecks.map((item) => (
    `<tr><td class="${item.ok ? 'ok' : 'fail'}">${item.ok ? 'EXPECTED BLOCK' : 'MISSING BLOCK'}</td><td>${escapeHtml(item.name)}</td><td>${escapeHtml(JSON.stringify(item.details || {}))}</td></tr>`
  )).join('');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>CodeSite Proof Bundle Git Context Proof</title>
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
<h1>CodeSite Proof Bundle Git Context Proof</h1>
<p class="sub">Verified ${escapeHtml(proof.generatedAt)}. The release gate now requires exported proof bundles to verify against actual Git commit trailers, not only sidecar trailer files.</p>
</div>
<div class="stamp">${proof.ok ? 'PASS' : 'FAIL'}</div>
</header>
<div class="cards">
<div class="card"><div class="label">Canonical Projection</div><div class="value">${proof.assertions.find((item) => item.name === 'control plane shares canonical portable proof context')?.ok ? 'PASS' : 'FAIL'}</div></div>
<div class="card"><div class="label">Actual Git Gate</div><div class="value">${proof.assertions.find((item) => item.name === 'release gate requires actual git commit verification')?.ok ? 'PASS' : 'FAIL'}</div></div>
<div class="card"><div class="label">Docker Suite</div><div class="value">${escapeHtml(commandResult(proof.commands[0]))}</div></div>
<div class="card"><div class="label">Stale Sidecar</div><div class="value">${proof.negativeChecks[0]?.ok ? 'BLOCKED' : 'OPEN'}</div></div>
</div>
<section><h2>Assertions</h2><table><thead><tr><th>Status</th><th>Assertion</th><th>Details</th></tr></thead><tbody>${assertionRows}</tbody></table></section>
<section><h2>Negative Gate Check</h2><table><thead><tr><th>Status</th><th>Check</th><th>Details</th></tr></thead><tbody>${negativeRows}</tbody></table></section>
<section><h2>Executed Commands</h2><table><thead><tr><th>Status</th><th>Command</th><th>Result</th></tr></thead><tbody>${commandRows}</tbody></table></section>
<section><h2>Git Binding</h2><pre>${escapeHtml(JSON.stringify(proof.git, null, 2))}</pre></section>
<section><h2>Release Gate Proof Bundle Summary</h2><pre>${escapeHtml(JSON.stringify(proof.releaseGateProofBundles, null, 2))}</pre></section>
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
  const negativeChecks = [];
  const controlSource = read('synthi/src/lib/codesite/controlPlane.js');
  const controlTestSource = read('synthi/src/lib/codesite/__tests__/controlPlane.test.js');
  const releaseGateSource = read('synthi/scripts/codesite-release-gate.mjs');

  assert(
    controlSource.includes('function proofBundlePortable(')
      && controlSource.includes('loadProofBundlePortableContext')
      && controlSource.includes('portableProofBundle: closeout?.portableProofBundle')
      && controlSource.includes('proofBundleProjectIdentity'),
    'control plane shares canonical portable proof context',
    assertions,
  );
  assert(
    controlTestSource.includes("trailers['CodeSite-Proof-Digest']).toBe(result.proofBundle.portableDigest")
      && controlTestSource.includes('payloadDigest).toBe(result.proofBundle.portableDigest'),
    'tests bind API trailers to final proof signature payload',
    assertions,
  );
  assert(
    releaseGateSource.includes('requireGitCommit: true')
      && releaseGateSource.includes('proof_git_commit_trailers_match')
      && releaseGateSource.includes('resolveProofBundleGitContext')
      && releaseGateSource.includes('proofBundleCommitSha'),
    'release gate requires actual git commit verification',
    assertions,
  );
  assert(
    releaseGateSource.includes('proofBundleGitContext'),
    'release gate requires this mature proof artifact',
    assertions,
  );

  const commands = [
    run('docker', [
      'run',
      '--rm',
      '-v',
      `${repoRoot}:/repo`,
      '-v',
      'codesite-node-modules-root:/repo/node_modules',
      '-v',
      'codesite-node-modules-synthi:/repo/synthi/node_modules',
      '-w',
      '/repo/synthi',
      '-e',
      'DATABASE_URL=postgresql://user:pass@localhost:5432/synthi',
      'node:22-bookworm',
      'bash',
      '-lc',
      'npm exec vitest -- run src/lib/codesite/__tests__/controlPlane.test.js src/lib/codesite/__tests__/proofVerifierCli.test.js src/app/api/workspace/[slug]/codesite/__tests__/codesiteRoute.test.js',
    ], { name: 'dockerCanonicalProofSuite' }),
  ];

  for (const command of commands) {
    assert(command.exitCode === 0, `${command.name} command exited successfully`, assertions, {
      command: command.command,
      summary: command.summary,
      exitCode: command.exitCode,
    });
  }

  const releaseGate = run(process.execPath, ['synthi/scripts/codesite-release-gate.mjs'], { name: 'freshReleaseGateNegativeCheck' });
  const proofBundles = releaseGateProofBundleCheck(releaseGate);
  const failures = releaseGateFailures(releaseGate);
  const staleSidecarRejected = releaseGate.exitCode !== 0
    && proofBundles?.ok === false
    && failures.some((failure) => String(failure).includes('CodeSite-Proof-Digest mismatch'))
    && failures.some((failure) => String(failure).includes('CodeSite-Proof-Signature mismatch'));
  negativeChecks.push({
    name: 'stale sidecar proof cannot satisfy actual git commit gate',
    ok: staleSidecarRejected,
    details: {
      releaseGateExitCode: releaseGate.exitCode,
      proofBundles,
      matchingFailures: failures
        .filter((failure) => String(failure).includes('CodeSite-Proof-Digest mismatch') || String(failure).includes('CodeSite-Proof-Signature mismatch'))
        .slice(0, 2),
    },
  });

  const proof = {
    schemaVersion: 'synthi.codesite.proofBundleGitContextProof.v1',
    status: 'validated',
    generatedAt: new Date().toISOString(),
    ok: assertions.every((item) => item.ok)
      && negativeChecks.every((item) => item.ok)
      && commands.every((item) => item.exitCode === 0),
    git: {
      head: gitText(['rev-parse', 'HEAD']),
      branch: gitText(['rev-parse', '--abbrev-ref', 'HEAD']),
      statusShort: gitText(['status', '--short']),
    },
    assertions,
    negativeChecks,
    commands,
    releaseGateProofBundles: proofBundles,
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
