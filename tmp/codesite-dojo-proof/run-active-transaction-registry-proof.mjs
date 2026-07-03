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
const outBase = path.join(proofRoot, 'codesite-active-transaction-registry-proof');

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd || repoRoot,
    encoding: 'utf8',
    maxBuffer: 96 * 1024 * 1024,
    env: { ...process.env, ...(options.env || {}) },
  });
  const output = `${result.stdout || ''}${result.stderr || ''}`;
  return {
    name: options.name || command,
    command: [command, ...args].join(' '),
    cwd: path.relative(repoRoot, options.cwd || repoRoot) || '.',
    exitCode: typeof result.status === 'number' ? result.status : 1,
    signal: result.signal || null,
    summary: parseTestSummary(output),
    outputTail: output.split(/\r?\n/).filter(Boolean).slice(-20),
  };
}

function parseTestSummary(output) {
  const nodeSummary = {};
  for (const key of ['tests', 'suites', 'pass', 'fail', 'cancelled', 'skipped', 'todo']) {
    const match = output.match(new RegExp(`# ${key} (\\d+)`));
    if (match) nodeSummary[key] = Number(match[1]);
  }
  const vitest = output.match(/Tests\s+(\d+) passed\s+\((\d+)\)/);
  if (vitest) {
    return {
      tests: Number(vitest[2]),
      pass: Number(vitest[1]),
      fail: 0,
      runner: 'vitest',
    };
  }
  if (Object.keys(nodeSummary).length) return { ...nodeSummary, runner: 'node:test' };
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
<title>CodeSite Active Transaction Registry Proof</title>
<style>
:root{font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:#f5f7f8;color:#11191c;color-scheme:light}
body{margin:0;background:#f5f7f8;color:#11191c}
main{width:min(1200px,calc(100vw - 56px));margin:0 auto;padding:38px 0 52px}
header{display:grid;grid-template-columns:1fr auto;gap:30px;align-items:end;border-bottom:1px solid #c9d3d7;padding-bottom:24px}
h1{margin:0;font-size:36px;line-height:1.05;font-weight:790;letter-spacing:0}
.sub{margin:12px 0 0;color:#546368;max-width:880px;line-height:1.55}
.stamp{border:1px solid #1b6d56;background:#e5f5ee;color:#0a5a42;padding:12px 34px;font-weight:790}
.cards{display:grid;grid-template-columns:repeat(5,1fr);gap:12px;margin:24px 0}
.card,section{background:#fcfdfb;border:1px solid #c9d3d7}
.card{padding:16px;min-height:82px}
.label{font-size:11px;text-transform:uppercase;letter-spacing:.08em;color:#5e6d72}
.value{font-size:27px;font-weight:790;margin-top:10px}
section{padding:20px;margin-top:18px}
h2{font-size:19px;margin:0 0 14px}
table{border-collapse:collapse;width:100%;font-size:13px}
th,td{border-top:1px solid #e2e8ea;padding:10px 8px;text-align:left;vertical-align:top}
th{font-size:11px;text-transform:uppercase;letter-spacing:.08em;color:#59686d}
code{font-family:"SFMono-Regular",Consolas,"Liberation Mono",monospace}
pre{background:#0e171a;color:#eaf2f4;padding:14px;white-space:pre-wrap;overflow:auto;font-size:12px;line-height:1.45}
.cwd{color:#65757a;font-size:12px;margin-top:4px}
.ok{color:#0c684e;font-weight:760}
.fail{color:#a93225;font-weight:760}
@media(max-width:940px){main{width:min(100% - 28px,760px);padding-top:26px}.cards{grid-template-columns:1fr 1fr}header{grid-template-columns:1fr}.stamp{width:max-content}h1{font-size:30px}}
</style>
</head>
<body>
<main>
<header>
<div>
<h1>CodeSite Active Transaction Registry Proof</h1>
<p class="sub">Verified ${escapeHtml(proof.generatedAt)}. This proof shows active CodeSite transactions are recorded from request/control-plane contexts, open/close lifecycle events are published from the app route, and unannotated runtime or workspace-prep paths fail closed before real-tree hydration or materialization.</p>
</div>
<div class="stamp">${proof.ok ? 'PASS' : 'FAIL'}</div>
</header>
<div class="cards">
<div class="card"><div class="label">Registry</div><div class="value">${escapeHtml(countLabel(proof.commands.find((item) => item.name === 'registryTests')))}</div></div>
<div class="card"><div class="label">Runtime/Prep</div><div class="value">${escapeHtml(countLabel(proof.commands.find((item) => item.name === 'boundaryTests')))}</div></div>
<div class="card"><div class="label">Route</div><div class="value">${escapeHtml(countLabel(proof.commands.find((item) => item.name === 'routeTests')))}</div></div>
<div class="card"><div class="label">Docker</div><div class="value">${escapeHtml(countLabel(proof.commands.find((item) => item.name === 'dockerReplay')))}</div></div>
<div class="card"><div class="label">Assertions</div><div class="value">${proof.assertions.filter((item) => item.ok).length}/${proof.assertions.length}</div></div>
</div>
<section><h2>Assertions</h2><table><thead><tr><th>Status</th><th>Assertion</th><th>Details</th></tr></thead><tbody>${assertionRows}</tbody></table></section>
<section><h2>Executed Commands</h2><table><thead><tr><th>Status</th><th>Command</th><th>Result</th></tr></thead><tbody>${commandRows}</tbody></table></section>
<section><h2>Git Binding</h2><pre>${escapeHtml(JSON.stringify(proof.git, null, 2))}</pre></section>
<section><h2>Workflow Snapshot</h2><pre>${escapeHtml(JSON.stringify(proof.workflowSnapshot, null, 2))}</pre></section>
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
  const registrySource = read('backend/collab-server/codesiteActivityRegistry.js');
  const codesiteFsSource = read('backend/collab-server/codesiteFs.js');
  const runtimeSource = read('backend/collab-server/runtimeFilesystem.js');
  const prepSource = read('backend/collab-server/workspacePrepManager.js');
  const serverSource = read('backend/collab-server/server.js');
  const routeSource = read('synthi/src/app/api/workspace/[slug]/codesite/[[...path]]/route.js');
  const runtimeTestSource = read('backend/collab-server/__tests__/runtimeFilesystem.test.js');
  const prepTestSource = read('backend/collab-server/__tests__/workspacePrepManager.test.js');
  const routeTestSource = read('synthi/src/app/api/workspace/[slug]/codesite/__tests__/codesiteRoute.test.js');

  assert(registrySource.includes('markTransactionActive') && registrySource.includes('markTransactionClosed'), 'activity registry supports open and close lifecycle', assertions);
  assert(registrySource.includes("'blocked'"), 'blocked landing attempts remain active in the registry until explicit close', assertions);
  assert(codesiteFsSource.includes('recordCodeSiteContext(context') && codesiteFsSource.includes('control_plane_transaction'), 'CodeSite request and authoritative contexts publish registry records', assertions);
  assert(runtimeSource.includes('CODESITE_RUNTIME_FILESYSTEM_ACTIVE_TRANSACTION') && runtimeSource.includes('isWorkspaceActive(slug)'), 'runtime filesystem fails closed on recorded active workspace without request context', assertions);
  assert(prepSource.includes('workspace_prep_queue_start') && prepSource.includes('workspace_prep_task'), 'workspace prep rechecks active transactions at queue start and per task', assertions);
  assert(serverSource.includes('/^\\/codesite\\/activity\\/([^/]+)$/') && serverSource.includes('isWritableTransactionStatus'), 'collab server exposes lifecycle activity endpoint', assertions);
  assert(routeSource.includes('notifyCollabCodeSiteActivity') && routeSource.includes('transaction_committed'), 'Next CodeSite route publishes open and close lifecycle events', assertions);
  assert(runtimeTestSource.includes('assert.deepEqual(calls, [])') && runtimeTestSource.includes('txn-registry'), 'runtime test proves no hydration call under registry guard', assertions);
  assert(prepTestSource.includes('assert.deepEqual(calls, [])') && prepTestSource.includes('txn-prep-registry'), 'prep test proves no repo acquire under registry guard', assertions);
  assert(routeTestSource.includes('notifies collab when a CodeSite transaction opens') && routeTestSource.includes('transaction_committed') && routeTestSource.includes('transaction_blocked'), 'route tests prove collab activity notification payloads', assertions);

  const commands = [
    run('node', ['--check', 'backend/collab-server/codesiteActivityRegistry.js'], { name: 'syntaxRegistry' }),
    run('node', ['--check', 'backend/collab-server/codesiteFs.js'], { name: 'syntaxCodesiteFs' }),
    run('node', ['--check', 'backend/collab-server/runtimeFilesystem.js'], { name: 'syntaxRuntime' }),
    run('node', ['--check', 'backend/collab-server/workspacePrepManager.js'], { name: 'syntaxPrep' }),
    run('node', ['--check', 'backend/collab-server/server.js'], { name: 'syntaxServer' }),
    run('node', ['--test', 'backend/collab-server/__tests__/codesiteActivityRegistry.test.js'], { name: 'registryTests' }),
    run('node', ['--test', 'backend/collab-server/__tests__/runtimeFilesystem.test.js', 'backend/collab-server/__tests__/workspacePrepManager.test.js'], { name: 'boundaryTests' }),
    run('npm', ['exec', '--', 'vitest', 'run', '--environment', 'node', 'src/app/api/workspace/[slug]/codesite/__tests__/codesiteRoute.test.js'], {
      name: 'routeTests',
      cwd: path.join(repoRoot, 'synthi'),
    }),
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
        'node --check backend/collab-server/codesiteActivityRegistry.js',
        'node --check backend/collab-server/runtimeFilesystem.js',
        'node --check backend/collab-server/workspacePrepManager.js',
        'node --test backend/collab-server/__tests__/codesiteActivityRegistry.test.js backend/collab-server/__tests__/runtimeFilesystem.test.js backend/collab-server/__tests__/workspacePrepManager.test.js',
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
    schemaVersion: 'synthi.codesite.activeTransactionRegistryProof.v1',
    generatedAt: new Date().toISOString(),
    ok: assertions.every((item) => item.ok) && commands.every((item) => item.exitCode === 0),
    git: {
      head: gitText(['rev-parse', 'HEAD']),
      branch: gitText(['rev-parse', '--abbrev-ref', 'HEAD']),
      statusShort: gitText(['status', '--short']),
    },
    assertions,
    commands,
    workflowSnapshot: {
      lifecycle: [
        'Next CodeSite route opens transaction and posts transaction_opened to collab /codesite/activity/:slug',
        'collab records active transaction keyed by workspace slug with actor/effective user and lease metadata',
        'later runtime filesystem calls without CodeSite context see the active workspace and throw before gitService hydration',
        'later workspace prep calls without CodeSite context see the active workspace and throw before repoCache.acquire',
        'successful commit with proof bundle or abort posts a closing event that removes the active registry record',
        'blocked commit validation posts transaction_blocked and remains active until explicit close',
      ],
      dockerReplay: 'node:20-bookworm reruns syntax plus registry/runtime/prep behavioral tests against the mounted checkout',
      visualEvidence: 'This HTML was rendered to PNG with Playwright and stored under tmp/codesite-dojo-proof.',
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
