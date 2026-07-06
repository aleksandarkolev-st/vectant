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
const outBase = path.join(proofRoot, 'codesite-direct-gitservice-boundary-proof');

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
  const nodeSummary = {};
  for (const key of ['tests', 'suites', 'pass', 'fail', 'cancelled', 'skipped', 'todo']) {
    const match = output.match(new RegExp(`# ${key} (\\d+)`));
    if (match) nodeSummary[key] = Number(match[1]);
  }
  if (Object.keys(nodeSummary).length) return { ...nodeSummary, runner: 'node:test' };
  const failed = output.includes('SyntaxError') || output.includes('not ok') || output.includes('ERR_');
  return {
    tests: failed ? 1 : 0,
    pass: failed ? 0 : 1,
    fail: failed ? 1 : 0,
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

function assert(condition, name, assertions, details = {}) {
  assertions.push({ name, ok: Boolean(condition), details });
}

function countLabel(command) {
  const summary = command?.summary || {};
  if (summary.tests) return `${summary.pass || 0}/${summary.tests}`;
  return command?.exitCode === 0 ? 'pass' : 'fail';
}

function methodSource(source, name) {
  const start = source.indexOf(`async ${name}(`);
  if (start === -1) return '';
  const next = source.indexOf('\n    async ', start + 1);
  return source.slice(start, next === -1 ? source.length : next);
}

function boundaryWrapsBeforeLock(source, methodName, boundaryName) {
  const body = methodSource(source, methodName);
  const boundaryIndex = body.indexOf(boundaryName);
  const lockIndex = body.indexOf('this.withLock');
  return boundaryIndex !== -1 && lockIndex !== -1 && boundaryIndex < lockIndex;
}

function boundaryContainsMutation(source, methodName, mutationMarkers) {
  const body = methodSource(source, methodName);
  const boundaryIndex = body.indexOf('_runCodeSiteGit');
  if (boundaryIndex === -1) return false;
  const boundaryBody = body.slice(boundaryIndex);
  return mutationMarkers.some((marker) => boundaryBody.includes(marker));
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
<title>CodeSite Direct GitService Boundary Proof</title>
<style>
:root{font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:#f6f7f4;color:#151713;color-scheme:light}
body{margin:0;background:#f6f7f4;color:#151713}
main{width:min(1220px,calc(100vw - 56px));margin:0 auto;padding:38px 0 54px}
header{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:32px;align-items:end;border-bottom:1px solid #cdd3c5;padding-bottom:24px}
h1{margin:0;font-size:35px;line-height:1.08;font-weight:790;letter-spacing:0}
.sub{margin:12px 0 0;color:#596156;max-width:900px;line-height:1.55}
.stamp{border:1px solid #285d45;background:#e4f1e9;color:#0b5137;padding:12px 34px;font-weight:790}
.cards{display:grid;grid-template-columns:repeat(5,1fr);gap:12px;margin:24px 0}
.card,section{background:#fdfefb;border:1px solid #cdd3c5}
.card{padding:16px;min-height:82px}
.label{font-size:11px;text-transform:uppercase;letter-spacing:.08em;color:#5f675c}
.value{font-size:27px;font-weight:790;margin-top:10px}
section{padding:20px;margin-top:18px}
h2{font-size:19px;margin:0 0 14px}
table{border-collapse:collapse;width:100%;font-size:13px}
th,td{border-top:1px solid #e1e5dc;padding:10px 8px;text-align:left;vertical-align:top}
th{font-size:11px;text-transform:uppercase;letter-spacing:.08em;color:#5a6356}
code{font-family:"SFMono-Regular",Consolas,"Liberation Mono",monospace}
pre{background:#111610;color:#eef3ec;padding:14px;white-space:pre-wrap;overflow:auto;font-size:12px;line-height:1.45}
.cwd{color:#687064;font-size:12px;margin-top:4px}
.ok{color:#0d6541;font-weight:760}
.fail{color:#a93225;font-weight:760}
@media(max-width:940px){main{width:min(100% - 28px,780px);padding-top:26px}.cards{grid-template-columns:1fr 1fr}header{grid-template-columns:1fr}.stamp{width:max-content}h1{font-size:30px}}
</style>
</head>
<body>
<main>
<header>
<div>
<h1>CodeSite Direct GitService Boundary Proof</h1>
<p class="sub">Verified ${escapeHtml(proof.generatedAt)}. Direct gitService refs and config mutations enter the CodeSite boundary before repo materialization, keep the real git mutation inside the boundary callback, and preserve matching active CodeSite workflows through HTTP route context propagation.</p>
</div>
<div class="stamp">${proof.ok ? 'PASS' : 'FAIL'}</div>
</header>
<div class="cards">
<div class="card"><div class="label">GitService Tests</div><div class="value">${escapeHtml(countLabel(proof.commands.find((item) => item.name === 'gitServiceBoundaryTests')))}</div></div>
<div class="card"><div class="label">Active Boundary</div><div class="value">${escapeHtml(countLabel(proof.commands.find((item) => item.name === 'activeBoundaryTests')))}</div></div>
<div class="card"><div class="label">Docker Replay</div><div class="value">${escapeHtml(countLabel(proof.commands.find((item) => item.name === 'dockerReplay')))}</div></div>
<div class="card"><div class="label">Assertions</div><div class="value">${proof.assertions.filter((item) => item.ok).length}/${proof.assertions.length}</div></div>
<div class="card"><div class="label">Branch</div><div class="value">${escapeHtml(proof.git.branch || 'unknown')}</div></div>
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
  const gitServiceSource = read('backend/collab-server/gitService.js');
  const serverSource = read('backend/collab-server/server.js');
  const testSource = read('backend/collab-server/__tests__/gitServiceCodesiteBoundary.test.js');

  const refsMethods = ['push', 'createTag', 'deleteTag', 'pushTag', 'stashDrop'];
  const configMethods = ['addRemote', 'removeRemote', 'setRemoteUrl'];
  for (const method of refsMethods) {
    assert(
      boundaryWrapsBeforeLock(gitServiceSource, method, '_runCodeSiteGitRefsBoundary'),
      `${method} enters git_refs boundary before repo lock/materialization`,
      assertions,
    );
  }
  for (const method of configMethods) {
    assert(
      boundaryWrapsBeforeLock(gitServiceSource, method, '_runCodeSiteGitConfigBoundary'),
      `${method} enters git_config boundary before repo lock/materialization`,
      assertions,
    );
  }
  assert(boundaryContainsMutation(gitServiceSource, 'createTag', ['git.tag([']), 'createTag mutates inside git_refs boundary', assertions);
  assert(boundaryContainsMutation(gitServiceSource, 'deleteTag', ["git.tag(['-d'"]), 'deleteTag mutates inside git_refs boundary', assertions);
  assert(boundaryContainsMutation(gitServiceSource, 'pushTag', ["git.raw(['push'", 'git.push(']), 'pushTag mutates inside git_refs boundary', assertions);
  assert(boundaryContainsMutation(gitServiceSource, 'push', ["git.raw(pushArgs)", 'await git.push(']), 'push mutates inside git_refs boundary', assertions);
  assert(boundaryContainsMutation(gitServiceSource, 'stashDrop', ["git.stash(['drop'"]), 'stashDrop mutates inside git_refs boundary', assertions);
  assert(boundaryContainsMutation(gitServiceSource, 'addRemote', ['git.addRemote(']), 'addRemote mutates inside git_config boundary', assertions);
  assert(boundaryContainsMutation(gitServiceSource, 'removeRemote', ['git.removeRemote(']), 'removeRemote mutates inside git_config boundary', assertions);
  assert(boundaryContainsMutation(gitServiceSource, 'setRemoteUrl', ["git.remote(['set-url'", 'git.addRemote(']), 'setRemoteUrl mutates inside git_config boundary', assertions);
  assert(gitServiceSource.includes("_runCodeSiteGitConfigBoundary(slug, userId, options, 'push-add-remote'"), 'push auto-remote bootstrap requires nested git_config boundary', assertions);
  assert(serverSource.includes('function codeSiteGitServiceOptions') && serverSource.includes('codeSiteGitServiceOptions(codeSiteContext, \'push\')'), 'HTTP git routes propagate CodeSite context into direct gitService methods', assertions);
  assert(testSource.includes('git config mutations deny contextless active workspaces') && testSource.includes('git refs mutations accept matching CodeSite context'), 'tests cover contextless denial and matching active git refs/config workflows', assertions);
  assert(testSource.includes('remaining refs and config mutators deny contextless active workspaces before repo materialization'), 'tests behaviorally cover contextless denial for every patched direct mutator', assertions);
  assert(testSource.includes('refs mutators record git_refs boundaries while active') && testSource.includes('remote update and removal record git_config boundaries while active'), 'tests behaviorally cover matching active refs and config mutator workflows', assertions);
  assert(testSource.includes('push requires git_config clearance before auto-adding workspace remote'), 'tests prove push cannot smuggle a config write through refs-only clearance', assertions);

  const commands = [
    run('node', ['--check', 'backend/collab-server/gitService.js'], { name: 'syntaxGitService' }),
    run('node', ['--check', 'backend/collab-server/server.js'], { name: 'syntaxServer' }),
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
        'node --check backend/collab-server/gitService.js',
        'node --check backend/collab-server/server.js',
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
    schemaVersion: 'synthi.codesite.directGitServiceBoundaryProof.v1',
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
      denied: [
        'active transaction + direct addRemote without CodeSite context rejects before remote config changes',
        'active transaction + direct createTag without CodeSite context rejects before tag creation',
        'active transaction + remaining direct refs/config mutators without CodeSite context reject before repo materialization',
        'refs-only active transaction + push auto-remote bootstrap rejects the git_config write before adding origin',
      ],
      allowed: [
        'active transaction + matching git_config context records CodeSiteFS evidence and adds remote',
        'active transaction + matching git_refs context records CodeSiteFS evidence and creates tag',
        'active transaction + matching git_config context updates and removes a real git remote',
        'active transaction + matching git_refs context deletes a tag, pushes a tag, drops a stash, and pushes a branch to a bare remote',
      ],
      surfaces: [...refsMethods, ...configMethods],
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
    assertions: `${proof.assertions.filter((item) => item.ok).length}/${proof.assertions.length}`,
  }, null, 2));
  if (!proof.ok) process.exit(1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
