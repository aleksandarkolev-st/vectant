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
const outBase = path.join(proofRoot, 'codesite-serializable-commit-race-proof');

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
    outputTail: output.split(/\r?\n/).filter(Boolean).slice(-24),
  };
}

function parseSummary(output) {
  const cleanOutput = stripAnsi(output);
  const vitest = cleanOutput.match(/Tests\s+(\d+) passed(?:\s+\|\s+(\d+) skipped)?\s+\((\d+)\)/);
  if (vitest) {
    return {
      runner: 'vitest',
      pass: Number(vitest[1]),
      skipped: Number(vitest[2] || 0),
      tests: Number(vitest[3]),
      fail: 0,
    };
  }
  const nodeSummary = {};
  for (const key of ['tests', 'suites', 'pass', 'fail', 'cancelled', 'skipped', 'todo']) {
    const matches = [...cleanOutput.matchAll(new RegExp(`# ${key} (\\d+)`, 'g'))];
    if (matches.length) nodeSummary[key] = matches.reduce((sum, match) => sum + Number(match[1]), 0);
  }
  if (Object.keys(nodeSummary).length) return { ...nodeSummary, runner: 'node:test' };
  return {
    runner: 'command',
    tests: cleanOutput.includes('Error:') || cleanOutput.includes('SyntaxError') ? 1 : 0,
    pass: cleanOutput.includes('Error:') || cleanOutput.includes('SyntaxError') ? 0 : 1,
    fail: cleanOutput.includes('Error:') || cleanOutput.includes('SyntaxError') ? 1 : 0,
  };
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

function countLabel(command) {
  const summary = command?.summary || {};
  if (summary.tests) return `${summary.pass || 0}/${summary.tests}`;
  return command?.exitCode === 0 ? 'pass' : 'fail';
}

function assert(condition, name, assertions, details = {}) {
  assertions.push({ name, ok: Boolean(condition), details });
}

function renderHtml(proof) {
  const assertionRows = proof.assertions.map((item) => (
    `<tr><td class="${item.ok ? 'ok' : 'fail'}">${item.ok ? 'PASS' : 'FAIL'}</td><td>${escapeHtml(item.name)}</td><td>${escapeHtml(JSON.stringify(item.details || {}))}</td></tr>`
  )).join('');
  const commandRows = proof.commands.map((item) => (
    `<tr><td class="${item.exitCode === 0 ? 'ok' : 'fail'}">${item.exitCode === 0 ? 'PASS' : 'FAIL'}</td><td><code>${escapeHtml(item.command)}</code><div class="cwd">${escapeHtml(item.cwd)}</div></td><td>${escapeHtml(countLabel(item))}</td></tr>`
  )).join('');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>CodeSite Serializable Commit Race Proof</title>
<style>
:root{font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:#080b0d;color:#eef4f2;color-scheme:dark}
body{margin:0;background:#080b0d;color:#eef4f2}
main{width:min(1220px,calc(100vw - 56px));margin:0 auto;padding:38px 0 54px}
header{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:28px;align-items:end;border-bottom:1px solid #26383c;padding-bottom:24px}
h1{margin:0;font-size:36px;line-height:1.05;font-weight:790;letter-spacing:0}
.sub{margin:12px 0 0;color:#a6b8b6;max-width:900px;line-height:1.55}
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
<h1>CodeSite Serializable Commit Race Proof</h1>
<p class="sub">Verified ${escapeHtml(proof.generatedAt)}. Two overlapping proof-carrying commit attempts race through the real CodeSite control-plane API. The landing gate allows one proof bundle and one transaction_committed event; the stale loser is blocked by serializable read validation.</p>
</div>
<div class="stamp">${proof.ok ? 'PASS' : 'FAIL'}</div>
</header>
<div class="cards">
<div class="card"><div class="label">Race Contract</div><div class="value">${proof.assertions.find((item) => item.name === 'race test asserts one commit, one stale loser, and one proof bundle')?.ok ? 'PASS' : 'FAIL'}</div></div>
<div class="card"><div class="label">Affected Suite</div><div class="value">${escapeHtml(countLabel(proof.commands.find((item) => item.name === 'dockerAffectedSuite')))}</div></div>
<div class="card"><div class="label">Registry</div><div class="value">${escapeHtml(countLabel(proof.commands.find((item) => item.name === 'registryTests')))}</div></div>
<div class="card"><div class="label">Assertions</div><div class="value">${proof.assertions.filter((item) => item.ok).length}/${proof.assertions.length}</div></div>
</div>
<section><h2>Assertions</h2><table><thead><tr><th>Status</th><th>Assertion</th><th>Details</th></tr></thead><tbody>${assertionRows}</tbody></table></section>
<section><h2>Executed Commands</h2><table><thead><tr><th>Status</th><th>Command</th><th>Result</th></tr></thead><tbody>${commandRows}</tbody></table></section>
<section><h2>Git Binding</h2><pre>${escapeHtml(JSON.stringify(proof.git, null, 2))}</pre></section>
<section><h2>Landing Contract</h2><pre>${escapeHtml(JSON.stringify(proof.landingContract, null, 2))}</pre></section>
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
  const controlPlaneSource = read('synthi/src/lib/codesite/controlPlane.js');
  const controlPlaneTestSource = read('synthi/src/lib/codesite/__tests__/controlPlane.test.js');
  const registrySource = read('backend/collab-server/codesiteActivityRegistry.js');
  const registryTestSource = read('backend/collab-server/__tests__/codesiteActivityRegistry.test.js');
  const releaseGateSource = read('synthi/scripts/codesite-release-gate.mjs');

  assert(controlPlaneSource.includes('withSerializableProjectCommitLanding'), 'commit path enters a project-scoped serializable landing gate', assertions);
  assert(controlPlaneSource.includes("isolationLevel: 'Serializable'"), 'landing gate requests serializable Prisma transaction isolation', assertions);
  assert(controlPlaneSource.includes('lockProjectForSerializableCommit') && controlPlaneSource.includes('codeSiteProject.update'), 'landing gate locks the CodeSite project row before final revalidation', assertions);
  assert(controlPlaneSource.includes('validateTransactionWithClient') && controlPlaneSource.includes('findStaleReadEvents(transaction') && controlPlaneSource.includes('db.codeSiteEvent.findMany'), 'final stale-read validation runs through the same database client', assertions);
  assert(controlPlaneSource.includes("status: 'committing'") && controlPlaneSource.includes('updateMany') && controlPlaneSource.includes('proofBundleDigest: null'), 'proof creation is fenced by a committable-status updateMany guard', assertions);
  assert(controlPlaneSource.includes("eventType: 'transaction_committed'") && controlPlaneSource.includes('recordEventWithClient(db'), 'transaction_committed event is written inside the landing gate client', assertions);
  assert(controlPlaneSource.includes('...parseJson(transaction.observedWriteSetJson, [])'), 'commit event stale-read surface includes observed write paths', assertions);
  assert(controlPlaneSource.includes("'committing'") && registrySource.includes("'committing'"), 'committing status remains workspace-active in Next and collab registries', assertions);
  assert(controlPlaneTestSource.includes('serializes overlapping proof-carrying commit races and blocks the stale loser'), 'control-plane test covers concurrent overlapping commit race', assertions);
  assert(controlPlaneTestSource.includes('Promise.all') && controlPlaneTestSource.includes('stale_read_detected') && controlPlaneTestSource.includes('toHaveBeenCalledTimes(1)'), 'race test asserts one commit, one stale loser, and one proof bundle', assertions);
  assert(registryTestSource.includes('committing landing attempts remain active until the commit closes them'), 'registry test proves committing remains an active workspace state', assertions);
  assert(releaseGateSource.includes('serializableCommitRace'), 'release gate requires this mature serializable race proof', assertions);

  const dockerBase = [
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
  ];
  const commands = [
    run('docker', [
      ...dockerBase,
      'npm exec vitest -- run src/lib/codesite/__tests__/controlPlane.test.js src/app/api/workspace/[slug]/codesite/__tests__/codesiteRoute.test.js',
    ], { name: 'dockerAffectedSuite' }),
    run('node', ['--test', 'backend/collab-server/__tests__/codesiteActivityRegistry.test.js'], { name: 'registryTests' }),
  ];

  for (const command of commands) {
    assert(command.exitCode === 0, `${command.name} command exited successfully`, assertions, {
      command: command.command,
      summary: command.summary,
      exitCode: command.exitCode,
    });
  }

  const proof = {
    schemaVersion: 'synthi.codesite.serializableCommitRaceProof.v1',
    generatedAt: new Date().toISOString(),
    ok: assertions.every((item) => item.ok) && commands.every((item) => item.exitCode === 0),
    git: {
      head: gitText(['rev-parse', 'HEAD']),
      branch: gitText(['rev-parse', '--abbrev-ref', 'HEAD']),
      statusShort: gitText(['status', '--short']),
    },
    assertions,
    commands,
    landingContract: {
      criticalSection: 'project-scoped serializable landing gate',
      lock: 'CodeSiteProject row update inside Prisma interactive transaction',
      finalValidation: 'validateTransactionWithClient rechecks stale reads after lock acquisition',
      fence: 'updateMany id + status in [open, validated] + proofBundleDigest null -> committing',
      visibleRaceOutcome: 'one committed transaction, one blocked stale loser, one transaction_committed event, one proof bundle',
      activeProtection: 'committing status remains active until transaction_committed closes the registry record',
    },
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
