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
const outBase = path.join(proofRoot, 'codesite-git-provisioning-boundary-proof');

function run(command, args, options = {}) {
  const startedAt = new Date().toISOString();
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    ...options,
  });
  const stdout = result.stdout || '';
  const stderr = result.stderr || '';
  const output = `${stdout}${stderr}`;
  return {
    command: [command, ...args].join(' '),
    startedAt,
    exitCode: typeof result.status === 'number' ? result.status : 1,
    signal: result.signal || null,
    summary: parseTap(output),
    outputTail: output.split(/\r?\n/).filter(Boolean).slice(-18),
  };
}

function parseTap(output) {
  const summary = {};
  for (const key of ['tests', 'suites', 'pass', 'fail', 'cancelled', 'skipped', 'todo']) {
    const match = output.match(new RegExp(`# ${key} (\\d+)`));
    if (match) summary[key] = Number(match[1]);
  }
  if (!Object.keys(summary).length) {
    summary.tests = output.includes('SyntaxError') ? 1 : 0;
    summary.pass = output.includes('SyntaxError') ? 0 : 1;
    summary.fail = output.includes('SyntaxError') ? 1 : 0;
  }
  return summary;
}

function assert(condition, name, assertions, details = {}) {
  assertions.push({ name, ok: Boolean(condition), details });
}

function read(relativePath) {
  return fs.readFileSync(path.join(repoRoot, relativePath), 'utf8');
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function testCountLabel(command) {
  const summary = command.summary || {};
  if (summary.tests) return `${summary.pass || 0}/${summary.tests}`;
  return command.exitCode === 0 ? 'pass' : 'fail';
}

function renderHtml(proof) {
  const assertionRows = proof.assertions.map((item) => (
    `<tr><td class="${item.ok ? 'ok' : 'fail'}">${item.ok ? 'PASS' : 'FAIL'}</td><td>${escapeHtml(item.name)}</td><td>${escapeHtml(JSON.stringify(item.details || {}))}</td></tr>`
  )).join('');
  const commandRows = proof.commands.map((item) => (
    `<tr><td class="${item.exitCode === 0 ? 'ok' : 'fail'}">${item.exitCode === 0 ? 'PASS' : 'FAIL'}</td><td><code>${escapeHtml(item.command)}</code></td><td>${escapeHtml(testCountLabel(item))}</td></tr>`
  )).join('');
  const policyPreview = {
    init: proof.policy.init,
    clone: proof.policy.clone,
    boundaryActions: proof.policy.boundaryActions,
  };
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>CodeSite Git Provisioning Boundary Proof</title>
<style>
:root{font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:#f7f8f5;color:#16201b;color-scheme:light}
body{margin:0;background:#f7f8f5;color:#16201b}
main{width:min(1160px,calc(100vw - 56px));margin:0 auto;padding:42px 0 52px}
header{display:grid;grid-template-columns:1fr auto;gap:28px;align-items:end;border-bottom:1px solid #ced7ce;padding-bottom:24px}
h1{margin:0;font-size:39px;line-height:1.04;font-weight:780;letter-spacing:0}
.sub{margin:12px 0 0;color:#53625a;max-width:820px;line-height:1.55}
.stamp{border:1px solid #22744a;background:#e7f6ec;color:#0b6034;padding:12px 34px;font-weight:780}
.cards{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin:24px 0}
.card,section{background:#fbfcf8;border:1px solid #ced7ce}
.card{padding:16px;min-height:78px}
.label{font-size:11px;text-transform:uppercase;letter-spacing:.08em;color:#64726a}
.value{font-size:28px;font-weight:780;margin-top:10px}
section{padding:20px;margin-top:18px}
h2{font-size:19px;margin:0 0 14px}
table{border-collapse:collapse;width:100%;font-size:13px}
th,td{border-top:1px solid #e2e8e3;padding:10px 8px;text-align:left;vertical-align:top}
th{font-size:11px;text-transform:uppercase;letter-spacing:.08em;color:#59675f}
code{font-family:"SFMono-Regular",Consolas,"Liberation Mono",monospace}
pre{background:#101812;color:#e9f2ed;padding:14px;white-space:pre-wrap;overflow:auto;font-size:12px;line-height:1.45}
.ok{color:#0d6b3e;font-weight:760}
.fail{color:#aa2f20;font-weight:760}
@media(max-width:860px){main{width:min(100% - 28px,760px);padding-top:26px}.cards{grid-template-columns:1fr 1fr}header{grid-template-columns:1fr}.stamp{width:max-content}h1{font-size:30px}}
</style>
</head>
<body>
<main>
<header>
<div>
<h1>CodeSite Git Provisioning Boundary Proof</h1>
<p class="sub">Verified ${escapeHtml(proof.generatedAt)}. Git init and clone are treated as provisioning mutations and run through the CodeSiteFS boundary lifecycle before the route mutates repository state.</p>
</div>
<div class="stamp">${proof.ok ? 'PASS' : 'FAIL'}</div>
</header>
<div class="cards">
<div class="card"><div class="label">Policy Tests</div><div class="value">${escapeHtml(testCountLabel(proof.commands.find((item) => item.name === 'policy')))}</div></div>
<div class="card"><div class="label">Git Boundary</div><div class="value">${escapeHtml(testCountLabel(proof.commands.find((item) => item.name === 'gitService')))}</div></div>
<div class="card"><div class="label">CodeSiteFS</div><div class="value">${escapeHtml(testCountLabel(proof.commands.find((item) => item.name === 'codesiteFs')))}</div></div>
<div class="card"><div class="label">Docker CodeSiteFS</div><div class="value">${escapeHtml(testCountLabel(proof.commands.find((item) => item.name === 'dockerCodeSiteFs')))}</div></div>
</div>
<section><h2>Assertions</h2><table><thead><tr><th>Status</th><th>Assertion</th><th>Details</th></tr></thead><tbody>${assertionRows}</tbody></table></section>
<section><h2>Executed Commands</h2><table><thead><tr><th>Status</th><th>Command</th><th>Result</th></tr></thead><tbody>${commandRows}</tbody></table></section>
<section><h2>Policy Snapshot</h2><pre>${escapeHtml(JSON.stringify(policyPreview, null, 2))}</pre></section>
</main>
</body>
</html>`;
}

async function screenshot(htmlPath, pngPath) {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1290, height: 960 }, deviceScaleFactor: 1 });
    await page.goto(pathToFileURL(htmlPath).href);
    await page.screenshot({ path: pngPath, fullPage: true });
  } finally {
    await browser.close();
  }
}

async function main() {
  fs.mkdirSync(proofRoot, { recursive: true });

  const { codeSiteGitActionAttempts, shouldRunCodeSiteGitBoundary } = require(path.join(repoRoot, 'backend', 'collab-server', 'codeSiteGitPolicy.js'));
  const { evaluateCodeSiteWrite } = require(path.join(repoRoot, 'backend', 'collab-server', 'codesiteFs.js'));
  const serverSource = read('backend/collab-server/server.js');
  const policySource = read('backend/collab-server/codeSiteGitPolicy.js');
  const initAttempt = codeSiteGitActionAttempts('init')[0] || null;
  const cloneAttempt = codeSiteGitActionAttempts('clone')[0] || null;
  const narrowProvisioning = evaluateCodeSiteWrite({
    active: true,
    mutationLeaseId: 'lease-proof',
    transactionId: 'txn-proof',
    allowedPaths: ['synthi/src/components/**'],
    allowedTools: ['git_provisioning'],
  }, { path: '**', kind: 'init', tool: 'git_provisioning' });
  const repoWideProvisioning = evaluateCodeSiteWrite({
    active: true,
    mutationLeaseId: 'lease-proof',
    transactionId: 'txn-proof',
    allowedPaths: ['**'],
    allowedTools: ['git_provisioning'],
  }, { path: '**', kind: 'init', tool: 'git_provisioning' });
  const assertions = [];

  assert(initAttempt?.tool === 'git_provisioning' && initAttempt?.path === '**', 'init maps to git_provisioning repo-scoped attempt', assertions, initAttempt);
  assert(cloneAttempt?.tool === 'git_provisioning' && cloneAttempt?.path === '**', 'clone maps to git_provisioning repo-scoped attempt', assertions, cloneAttempt);
  assert(shouldRunCodeSiteGitBoundary('init') === true, 'init callback runs through CodeSiteFS boundary', assertions);
  assert(shouldRunCodeSiteGitBoundary('clone') === true, 'clone callback runs through CodeSiteFS boundary', assertions);
  assert(/case 'init':[\s\S]{0,360}runGitBoundary[\s\S]{0,220}gitService\.initRepo/.test(serverSource), 'server init branch wraps gitService.initRepo in runGitBoundary', assertions);
  assert(/case 'clone':[\s\S]{0,360}runGitBoundary[\s\S]{0,220}gitService\.cloneRepo/.test(serverSource), 'server clone branch wraps gitService.cloneRepo in runGitBoundary', assertions);
  assert(/'init'/.test(policySource) && /'clone'/.test(policySource), 'policy action set includes provisioning actions', assertions);
  assert(narrowProvisioning.ok === false
    && narrowProvisioning.event?.details?.reason_codes?.includes('repo_provisioning_clearance_required'),
  'narrow write set cannot authorize repo provisioning', assertions, narrowProvisioning.event?.details);
  assert(repoWideProvisioning.ok === true, 'repo-wide write set authorizes repo provisioning', assertions, repoWideProvisioning.event?.details);

  const commands = [
    { name: 'syntax', ...run('node', ['--check', 'backend/collab-server/server.js']) },
    { name: 'policySyntax', ...run('node', ['--check', 'backend/collab-server/codeSiteGitPolicy.js']) },
    { name: 'policy', ...run('node', ['--test', 'backend/collab-server/__tests__/codesiteGitPolicy.test.js']) },
    { name: 'gitService', ...run('node', ['--test', 'backend/collab-server/__tests__/gitServiceCodesiteBoundary.test.js']) },
    { name: 'codesiteFs', ...run('node', ['--test', 'backend/collab-server/__tests__/codesiteFs.test.js']) },
    {
      name: 'dockerCodeSiteFs',
      ...run('docker', [
        'run',
        '--rm',
        '-v',
        `${repoRoot}:/repo`,
        '-w',
        '/repo',
        'node:20-bookworm',
        'sh',
        '-lc',
        'node --check backend/collab-server/codeSiteGitPolicy.js && node --check backend/collab-server/codesiteFs.js && node --test backend/collab-server/__tests__/codesiteGitPolicy.test.js backend/collab-server/__tests__/codesiteFs.test.js',
      ]),
    },
  ];

  for (const command of commands) {
    assert(command.exitCode === 0, `${command.name} command exited successfully`, assertions, {
      command: command.command,
      summary: command.summary,
      exitCode: command.exitCode,
    });
  }

  const proof = {
    schemaVersion: 'synthi.codesite.gitProvisioningBoundaryProof.v1',
    generatedAt: new Date().toISOString(),
    ok: assertions.every((item) => item.ok) && commands.every((item) => item.exitCode === 0),
    assertions,
    policy: {
      init: initAttempt,
      clone: cloneAttempt,
      boundaryActions: {
        init: shouldRunCodeSiteGitBoundary('init'),
        clone: shouldRunCodeSiteGitBoundary('clone'),
        status: shouldRunCodeSiteGitBoundary('status'),
      },
      provisioningClearance: {
        narrow: {
          ok: narrowProvisioning.ok,
          reasonCodes: narrowProvisioning.event?.details?.reason_codes || [],
        },
        repoWide: {
          ok: repoWideProvisioning.ok,
          reasonCodes: repoWideProvisioning.event?.details?.reason_codes || [],
        },
      },
    },
    commands,
  };

  const jsonPath = `${outBase}.json`;
  const htmlPath = `${outBase}.html`;
  const pngPath = `${outBase}.png`;
  fs.writeFileSync(jsonPath, `${JSON.stringify(proof, null, 2)}\n`);
  fs.writeFileSync(htmlPath, renderHtml(proof));
  await screenshot(htmlPath, pngPath);

  console.log(JSON.stringify({
    ok: proof.ok,
    jsonPath: path.relative(repoRoot, jsonPath),
    htmlPath: path.relative(repoRoot, htmlPath),
    pngPath: path.relative(repoRoot, pngPath),
    commands: commands.map((item) => ({ name: item.name, exitCode: item.exitCode, summary: item.summary })),
  }, null, 2));

  if (!proof.ok) process.exit(1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
