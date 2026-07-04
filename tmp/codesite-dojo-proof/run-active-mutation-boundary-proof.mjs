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
const outBase = path.join(proofRoot, 'codesite-active-mutation-boundary-proof');

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd || repoRoot,
    encoding: 'utf8',
    maxBuffer: 128 * 1024 * 1024,
  });
  const output = `${result.stdout || ''}${result.stderr || ''}`;
  return {
    name: options.name || command,
    command: [command, ...args].join(' '),
    cwd: path.relative(repoRoot, options.cwd || repoRoot) || '.',
    exitCode: typeof result.status === 'number' ? result.status : 1,
    signal: result.signal || null,
    summary: parseTap(output),
    outputTail: output.split(/\r?\n/).filter(Boolean).slice(-20),
  };
}

function parseTap(output) {
  const summary = {};
  for (const key of ['tests', 'suites', 'pass', 'fail', 'cancelled', 'skipped', 'todo']) {
    const match = output.match(new RegExp(`# ${key} (\\d+)`));
    if (match) summary[key] = Number(match[1]);
  }
  if (Object.keys(summary).length) return { ...summary, runner: 'node:test' };
  return {
    tests: output.includes('SyntaxError') || output.includes('Error:') ? 1 : 0,
    pass: output.includes('SyntaxError') || output.includes('Error:') ? 0 : 1,
    fail: output.includes('SyntaxError') || output.includes('Error:') ? 1 : 0,
    runner: 'command',
  };
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
<title>CodeSite Active Mutation Boundary Proof</title>
<style>
:root{font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:#f7f8f5;color:#151a16;color-scheme:light}
body{margin:0;background:#f7f8f5;color:#151a16}
main{width:min(1200px,calc(100vw - 56px));margin:0 auto;padding:38px 0 52px}
header{display:grid;grid-template-columns:1fr auto;gap:30px;align-items:end;border-bottom:1px solid #cfd7ca;padding-bottom:24px}
h1{margin:0;font-size:36px;line-height:1.05;font-weight:790;letter-spacing:0}
.sub{margin:12px 0 0;color:#59645a;max-width:900px;line-height:1.55}
.stamp{border:1px solid #236a4d;background:#e6f4eb;color:#0b5938;padding:12px 34px;font-weight:790}
.cards{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin:24px 0}
.card,section{background:#fcfdfa;border:1px solid #cfd7ca}
.card{padding:16px;min-height:82px}
.label{font-size:11px;text-transform:uppercase;letter-spacing:.08em;color:#626e62}
.value{font-size:27px;font-weight:790;margin-top:10px}
section{padding:20px;margin-top:18px}
h2{font-size:19px;margin:0 0 14px}
table{border-collapse:collapse;width:100%;font-size:13px}
th,td{border-top:1px solid #e1e8de;padding:10px 8px;text-align:left;vertical-align:top}
th{font-size:11px;text-transform:uppercase;letter-spacing:.08em;color:#5d685d}
code{font-family:"SFMono-Regular",Consolas,"Liberation Mono",monospace}
pre{background:#111811;color:#edf4ed;padding:14px;white-space:pre-wrap;overflow:auto;font-size:12px;line-height:1.45}
.cwd{color:#687366;font-size:12px;margin-top:4px}
.ok{color:#0c6840;font-weight:760}
.fail{color:#a93225;font-weight:760}
@media(max-width:900px){main{width:min(100% - 28px,760px);padding-top:26px}.cards{grid-template-columns:1fr 1fr}header{grid-template-columns:1fr}.stamp{width:max-content}h1{font-size:30px}}
</style>
</head>
<body>
<main>
<header>
<div>
<h1>CodeSite Active Mutation Boundary Proof</h1>
<p class="sub">Verified ${escapeHtml(proof.generatedAt)}. Active CodeSite workspaces reject contextless or mismatched real-tree mutations, and managed collab boundaries carry their verified transaction context into nested gitService writes without double-recording CodeSiteFS events.</p>
</div>
<div class="stamp">${proof.ok ? 'PASS' : 'FAIL'}</div>
</header>
<div class="cards">
<div class="card"><div class="label">Boundary Unit</div><div class="value">${escapeHtml(countLabel(proof.commands.find((item) => item.name === 'activeBoundaryTests')))}</div></div>
<div class="card"><div class="label">GitService</div><div class="value">${escapeHtml(countLabel(proof.commands.find((item) => item.name === 'gitServiceBoundaryTests')))}</div></div>
<div class="card"><div class="label">Docker Replay</div><div class="value">${escapeHtml(countLabel(proof.commands.find((item) => item.name === 'dockerReplay')))}</div></div>
<div class="card"><div class="label">Assertions</div><div class="value">${proof.assertions.filter((item) => item.ok).length}/${proof.assertions.length}</div></div>
</div>
<section><h2>Assertions</h2><table><thead><tr><th>Status</th><th>Assertion</th><th>Details</th></tr></thead><tbody>${assertionRows}</tbody></table></section>
<section><h2>Executed Commands</h2><table><thead><tr><th>Status</th><th>Command</th><th>Result</th></tr></thead><tbody>${commandRows}</tbody></table></section>
<section><h2>Git Binding</h2><pre>${escapeHtml(JSON.stringify(proof.git, null, 2))}</pre></section>
<section><h2>Boundary Snapshot</h2><pre>${escapeHtml(JSON.stringify(proof.boundarySnapshot, null, 2))}</pre></section>
</main>
</body>
</html>`;
}

async function screenshot(htmlPath, pngPath) {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1340, height: 980 }, deviceScaleFactor: 1 });
    await page.goto(pathToFileURL(htmlPath).href);
    await page.screenshot({ path: pngPath, fullPage: true });
  } finally {
    await browser.close();
  }
}

async function main() {
  fs.mkdirSync(proofRoot, { recursive: true });
  const assertions = [];
  const activeBoundarySource = read('backend/collab-server/codesiteActiveBoundary.js');
  const serverSource = read('backend/collab-server/server.js');
  const gitServiceSource = read('backend/collab-server/gitService.js');
  const activeBoundaryTestSource = read('backend/collab-server/__tests__/codesiteActiveBoundary.test.js');
  const gitServiceTestSource = read('backend/collab-server/__tests__/gitServiceCodesiteBoundary.test.js');

  assert(activeBoundarySource.includes('codesite_active_workspace_context_required'), 'shared boundary rejects contextless active-workspace mutations', assertions);
  assert(activeBoundarySource.includes('codesite_active_workspace_context_mismatch'), 'shared boundary rejects mismatched transaction contexts', assertions);
  assert(activeBoundarySource.includes('AsyncLocalStorage') && activeBoundarySource.includes('withCodeSiteBoundaryContext'), 'shared boundary exposes async inherited CodeSite context for managed nested writes', assertions);
  assert(serverSource.includes('assertCodeSiteWorkspaceMutationAllowed') && serverSource.includes('enforceCodeSiteProvisioningAllowed'), 'collab server mutation and provisioning helpers use active workspace gate', assertions);
  assert(serverSource.includes('withCodeSiteBoundaryContext') && serverSource.includes('codesiteFs.run(operation, applyFn, options)'), 'collab server publishes verified CodeSite context around the managed apply callback', assertions);
  assert(serverSource.includes('workspaceSlug: slug'), 'Yjs flush paths pass workspace slug into the active boundary', assertions);
  assert(gitServiceSource.includes('currentCodeSiteBoundaryScope') && gitServiceSource.includes('skipNestedBoundary'), 'nested gitService mutations inherit outer boundary context without duplicate event recording', assertions);
  assert(gitServiceSource.includes('assertCodeSiteWorkspaceMutationAllowedAsync(slug') && gitServiceSource.includes('_runCodeSiteMutationBoundary'), 'direct gitService mutations use active workspace gate', assertions);
  assert(activeBoundaryTestSource.includes('rejects contextless real-tree mutations') && activeBoundaryTestSource.includes('allows matching transaction context'), 'unit tests cover required, mismatch, and matching contexts', assertions);
  assert(gitServiceTestSource.includes('denies contextless writes while CodeSite transaction is active') && gitServiceTestSource.includes('legacy direct gitService.writeFile still writes'), 'gitService tests prove active-only denial without breaking ordinary writes', assertions);
  assert(gitServiceTestSource.includes('managed outer CodeSite boundary lets nested gitService.writeFile inherit context once') && gitServiceTestSource.includes('recordBodies.length, 1'), 'managed nested write regression proves success through inherited context with one write record', assertions);

  const commands = [
    run('node', ['--check', 'backend/collab-server/codesiteActiveBoundary.js'], { name: 'syntaxActiveBoundary' }),
    run('node', ['--check', 'backend/collab-server/server.js'], { name: 'syntaxServer' }),
    run('node', ['--check', 'backend/collab-server/gitService.js'], { name: 'syntaxGitService' }),
    run('node', ['--test', 'backend/collab-server/__tests__/codesiteActiveBoundary.test.js'], { name: 'activeBoundaryTests' }),
    run('node', ['--test', 'backend/collab-server/__tests__/gitServiceCodesiteBoundary.test.js'], { name: 'gitServiceBoundaryTests' }),
    run('docker', [
      'run',
      '--rm',
      '-v',
      `${repoRoot}:/repo`,
      '-w',
      '/repo',
      'node:20-bookworm',
      'sh',
      '-lc',
      [
        'node --check backend/collab-server/codesiteActiveBoundary.js',
        'node --check backend/collab-server/server.js',
        'node --check backend/collab-server/gitService.js',
        'node --test backend/collab-server/__tests__/codesiteActiveBoundary.test.js backend/collab-server/__tests__/gitServiceCodesiteBoundary.test.js',
      ].join(' && '),
    ], { name: 'dockerReplay' }),
  ];

  for (const command of commands) {
    assert(command.exitCode === 0, `${command.name} command exited successfully`, assertions, {
      command: command.command,
      summary: command.summary,
      exitCode: command.exitCode,
    });
  }

  const proof = {
    schemaVersion: 'synthi.codesite.activeMutationBoundaryProof.v1',
    generatedAt: new Date().toISOString(),
    ok: assertions.every((item) => item.ok) && commands.every((item) => item.exitCode === 0),
    git: {
      head: gitText(['rev-parse', 'HEAD']),
      branch: gitText(['rev-parse', '--abbrev-ref', 'HEAD']),
      statusShort: gitText(['status', '--short']),
    },
    assertions,
    commands,
    boundarySnapshot: {
      denied: [
        'active workspace + no CodeSite context => CODESITE_WRITE_DENIED before disk write',
        'active workspace + mismatched transaction id => CODESITE_WRITE_DENIED before disk write',
      ],
      allowed: [
        'no active workspace transaction => legacy direct write remains allowed',
        'active workspace + matching transaction id/lease => CodeSiteFS authoritative boundary still runs',
        'active managed collab boundary + nested gitService.writeFile without explicit options => allowed through inherited verified context',
      ],
      surfaces: [
        'collab runCodeSiteMutationBoundary',
        'async managed boundary context',
        'collab provisioning guard',
        'Yjs save/pre-stage flushes',
        'direct gitService mutation wrapper',
      ],
      dockerReplay: 'node:20-bookworm reruns syntax plus active-boundary/gitService behavioral suites against the mounted checkout',
    },
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
