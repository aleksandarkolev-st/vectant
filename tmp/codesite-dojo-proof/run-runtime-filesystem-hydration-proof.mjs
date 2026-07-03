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
const outBase = path.join(proofRoot, 'codesite-runtime-filesystem-hydration-proof');

function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  const output = `${result.stdout || ''}${result.stderr || ''}`;
  return {
    command: [command, ...args].join(' '),
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
    `<tr><td class="${item.exitCode === 0 ? 'ok' : 'fail'}">${item.exitCode === 0 ? 'PASS' : 'FAIL'}</td><td><code>${escapeHtml(item.command)}</code></td><td>${escapeHtml(countLabel(item))}</td></tr>`
  )).join('');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>CodeSite Runtime Filesystem Hydration Proof</title>
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
<h1>CodeSite Runtime Filesystem Hydration Proof</h1>
<p class="sub">Verified ${escapeHtml(proof.generatedAt)}. Active CodeSite runtime starts reuse an initialized base repo and refuse automatic real-repo provisioning before overlay or quarantine setup.</p>
</div>
<div class="stamp">${proof.ok ? 'PASS' : 'FAIL'}</div>
</header>
<div class="cards">
<div class="card"><div class="label">Runtime FS</div><div class="value">${escapeHtml(countLabel(proof.commands.find((item) => item.name === 'runtimeFs')))}</div></div>
<div class="card"><div class="label">Runtime Surface</div><div class="value">${escapeHtml(countLabel(proof.commands.find((item) => item.name === 'runtimeSurface')))}</div></div>
<div class="card"><div class="label">Docker Runtime FS</div><div class="value">${escapeHtml(countLabel(proof.commands.find((item) => item.name === 'dockerRuntimeFs')))}</div></div>
<div class="card"><div class="label">Assertions</div><div class="value">${proof.assertions.filter((item) => item.ok).length}/${proof.assertions.length}</div></div>
</div>
<section><h2>Assertions</h2><table><thead><tr><th>Status</th><th>Assertion</th><th>Details</th></tr></thead><tbody>${assertionRows}</tbody></table></section>
<section><h2>Executed Commands</h2><table><thead><tr><th>Status</th><th>Command</th><th>Result</th></tr></thead><tbody>${commandRows}</tbody></table></section>
<section><h2>Policy Snapshot</h2><pre>${escapeHtml(JSON.stringify(proof.policySnapshot, null, 2))}</pre></section>
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
  const runtimeSource = read('backend/collab-server/runtimeFilesystem.js');
  const terminalSource = read('backend/collab-server/terminalService.js');
  const serverSource = read('backend/collab-server/server.js');
  const assertions = [];

  assert(runtimeSource.includes('CODESITE_RUNTIME_FILESYSTEM_PROVISIONING_REQUIRED'), 'runtime helper has active CodeSite fail-closed error', assertions);
  assert(runtimeSource.includes('existingCodeSiteRuntimeFilesystem'), 'runtime helper reuses initialized base repo for active CodeSite', assertions);
  assert(/activeCodeSiteContext\?\.active[\s\S]{0,220}existingCodeSiteRuntimeFilesystem/.test(runtimeSource), 'active CodeSite bypasses hydrateWorkspace', assertions);
  assert(terminalSource.includes('codesiteContext: codeSiteContext.active ? codeSiteContext : null'), 'interactive terminals pass CodeSite context into runtime filesystem helper', assertions);
  assert(serverSource.includes('reason: \'program_runtime_hybrid\',\n            codesiteContext,'), 'program runtime overlay passes CodeSite context into runtime filesystem helper', assertions);
  assert(serverSource.includes('codeSiteQuarantineStorageForRequest(slug, effectiveUserId, runtimeScope, \'codesitefs-quarantine-apply\', codeSiteContext)'), 'quarantine apply storage passes CodeSite context into runtime filesystem helper', assertions);

  const commands = [
    { name: 'syntaxRuntimeFs', ...run('node', ['--check', 'backend/collab-server/runtimeFilesystem.js']) },
    { name: 'syntaxTerminal', ...run('node', ['--check', 'backend/collab-server/terminalService.js']) },
    { name: 'syntaxServer', ...run('node', ['--check', 'backend/collab-server/server.js']) },
    { name: 'runtimeFs', ...run('node', ['--test', 'backend/collab-server/__tests__/runtimeFilesystem.test.js']) },
    { name: 'runtimeSurface', ...run('node', ['--test', 'backend/collab-server/__tests__/terminalRouting.test.js', 'backend/collab-server/__tests__/programRuntimeManager.test.js', 'backend/collab-server/__tests__/ensureRuntimeRoute.test.js']) },
    {
      name: 'dockerRuntimeFs',
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
        'node --check backend/collab-server/runtimeFilesystem.js && node --test backend/collab-server/__tests__/runtimeFilesystem.test.js',
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
    schemaVersion: 'synthi.codesite.runtimeFilesystemHydrationProof.v1',
    generatedAt: new Date().toISOString(),
    ok: assertions.every((item) => item.ok) && commands.every((item) => item.exitCode === 0),
    assertions,
    commands,
    policySnapshot: {
      activeCodeSite: {
        uninitialized: 'deny CODESITE_RUNTIME_FILESYSTEM_PROVISIONING_REQUIRED',
        initialized: 'reuse existing base repo without initRepo or ensureUserRepo',
      },
      inactiveRuntime: 'legacy hydrateWorkspace path unchanged',
      guardedSurfaces: ['interactive_terminal', 'program_runtime_hybrid', 'codesitefs_quarantine_storage'],
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
