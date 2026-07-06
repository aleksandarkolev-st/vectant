#!/usr/bin/env node
'use strict';

import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

const execFileAsync = promisify(execFile);
const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const {
  codeSiteTerminalReattachDecision,
} = require('../../backend/collab-server/terminalRouting');

const repoRoot = process.cwd();
const proofRoot = path.join(repoRoot, 'tmp', 'codesite-dojo-proof');
const proofJsonPath = path.join(proofRoot, 'codesite-terminal-reattach-proof.json');
const proofHtmlPath = path.join(proofRoot, 'codesite-terminal-reattach-proof.html');
const proofPngPath = path.join(proofRoot, 'codesite-terminal-reattach-proof.png');
const nodeImage = 'node:20-bookworm@sha256:8f693eaa7e0a8e71560c9a82b55fd54c2ae920a2ba5d2cde28bac7d1c01c9ba5';

function parseTap(output) {
  const text = String(output || '');
  const read = (name) => Number(text.match(new RegExp(`# ${name} (\\d+)`))?.[1] || 0);
  return {
    tests: read('tests'),
    suites: read('suites'),
    pass: read('pass'),
    fail: read('fail'),
    cancelled: read('cancelled'),
    skipped: read('skipped'),
    todo: read('todo'),
    ok: read('tests') > 0 && read('fail') === 0 && read('cancelled') === 0 && read('skipped') === 0 && read('todo') === 0,
  };
}

function compact(text, max = 8000) {
  const value = String(text || '');
  return value.length <= max ? value : `${value.slice(0, max)}\n...<truncated ${value.length - max} chars>`;
}

async function run(name, command, args) {
  const startedAt = new Date().toISOString();
  try {
    const result = await execFileAsync(command, args, {
      cwd: repoRoot,
      maxBuffer: 30 * 1024 * 1024,
    });
    const output = `${result.stdout || ''}\n${result.stderr || ''}`;
    return {
      name,
      command: [command, ...args].join(' '),
      exitCode: 0,
      ok: true,
      startedAt,
      completedAt: new Date().toISOString(),
      stdout: compact(result.stdout),
      stderr: compact(result.stderr),
      summary: parseTap(output),
    };
  } catch (error) {
    const output = `${error.stdout || ''}\n${error.stderr || ''}`;
    return {
      name,
      command: [command, ...args].join(' '),
      exitCode: typeof error.code === 'number' ? error.code : 1,
      ok: false,
      startedAt,
      completedAt: new Date().toISOString(),
      stdout: compact(error.stdout),
      stderr: compact(error.stderr || error.message),
      summary: parseTap(output),
    };
  }
}

function decisionCases() {
  const request = {
    active: true,
    workspaceSlug: 'repo',
    transactionId: 'txn-1',
    mutationLeaseId: 'lease-1',
    agentSessionId: 'agent-1',
  };
  const matchingContext = {
    active: true,
    workspaceSlug: 'repo',
    transactionId: 'txn-1',
    mutationLeaseId: 'lease-1',
    agentSessionId: 'agent-1',
  };
  return [
    {
      name: 'legacy request can reattach normally',
      expected: { ok: true },
      input: { codeSiteContext: null, existingSession: { codesiteContext: null } },
    },
    {
      name: 'active request blocks unmanaged existing PTY',
      expected: { ok: false, reason: 'existing_session_unmanaged' },
      input: { codeSiteContext: request, existingSession: { codesiteContext: null } },
    },
    {
      name: 'active request blocks transaction mismatch',
      expected: { ok: false, reason: 'transaction_mismatch' },
      input: {
        codeSiteContext: request,
        existingSession: {
          codesiteContext: { ...matchingContext, transactionId: 'txn-2' },
          runtimeOptions: { codeSiteOverlayId: 'overlay-1' },
        },
      },
    },
    {
      name: 'active request blocks lease mismatch',
      expected: { ok: false, reason: 'lease_mismatch' },
      input: {
        codeSiteContext: request,
        existingSession: {
          codesiteContext: { ...matchingContext, mutationLeaseId: 'lease-2' },
          runtimeOptions: { codeSiteOverlayId: 'overlay-1' },
        },
      },
    },
    {
      name: 'active request blocks agent session mismatch',
      expected: { ok: false, reason: 'agent_session_mismatch' },
      input: {
        codeSiteContext: request,
        existingSession: {
          codesiteContext: { ...matchingContext, agentSessionId: 'agent-2' },
          runtimeOptions: { codeSiteOverlayId: 'overlay-1' },
        },
      },
    },
    {
      name: 'active request blocks workspace mismatch',
      expected: { ok: false, reason: 'workspace_mismatch' },
      input: {
        codeSiteContext: request,
        existingSession: {
          codesiteContext: { ...matchingContext, workspaceSlug: 'other-repo' },
          runtimeOptions: { codeSiteOverlayId: 'overlay-1' },
        },
      },
    },
    {
      name: 'active request blocks non-overlay CodeSite PTY',
      expected: { ok: false, reason: 'overlay_missing' },
      input: {
        codeSiteContext: request,
        existingSession: { codesiteContext: matchingContext },
      },
    },
    {
      name: 'active request permits matching overlay runtime',
      expected: { ok: true },
      input: {
        codeSiteContext: request,
        existingSession: {
          codesiteContext: matchingContext,
          runtimeOptions: { codeSiteOverlayId: 'overlay-1' },
        },
      },
    },
    {
      name: 'active request permits matching quarantine overlay',
      expected: { ok: true },
      input: {
        codeSiteContext: request,
        existingSession: {
          codesiteContext: matchingContext,
          codesiteQuarantine: { mountMode: 'docker-overlay', overlayId: 'overlay-1' },
        },
      },
    },
  ].map((item) => {
    const decision = codeSiteTerminalReattachDecision(item.input);
    const ok = decision.ok === item.expected.ok && (
      item.expected.reason ? decision.reason === item.expected.reason : true
    );
    return {
      name: item.name,
      ok,
      expected: item.expected,
      decision,
    };
  });
}

function assertion(name, ok, details = {}) {
  return { name, ok: Boolean(ok), details };
}

function commandAssertions(commands) {
  return commands.flatMap((command) => [
    assertion(`${command.name} exited successfully`, command.exitCode === 0, {
      command: command.command,
      summary: command.summary,
      exitCode: command.exitCode,
    }),
    assertion(`${command.name} completed with zero skipped/todo/cancelled tests`, (
      command.summary?.skipped === 0 &&
      command.summary?.todo === 0 &&
      command.summary?.cancelled === 0
    ), { summary: command.summary }),
  ]);
}

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

function renderHtml(proof) {
  const passCount = proof.assertions.filter((item) => item.ok).length;
  const commandRows = proof.commands.map((command) => (
    `<tr><td class="${command.ok ? 'ok' : 'fail'}">${command.ok ? 'PASS' : 'FAIL'}</td><td>${escapeHtml(command.name)}</td><td>${escapeHtml(`${command.summary.pass}/${command.summary.tests}`)}</td><td>${escapeHtml(String(command.summary.skipped))}</td><td><code>${escapeHtml(command.command)}</code></td></tr>`
  )).join('');
  const assertionRows = proof.assertions.map((item) => (
    `<tr><td class="${item.ok ? 'ok' : 'fail'}">${item.ok ? 'PASS' : 'FAIL'}</td><td>${escapeHtml(item.name)}</td><td>${escapeHtml(JSON.stringify(item.details || {}))}</td></tr>`
  )).join('');
  const decisionRows = proof.decisions.map((item) => (
    `<tr><td class="${item.ok ? 'ok' : 'fail'}">${item.ok ? 'PASS' : 'FAIL'}</td><td>${escapeHtml(item.name)}</td><td><code>${escapeHtml(JSON.stringify(item.decision))}</code></td></tr>`
  )).join('');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>CodeSite Terminal Reattach Proof</title>
<style>
:root{color-scheme:light;--bg:oklch(0.972 0.006 155);--surface:oklch(0.995 0.003 155);--ink:oklch(0.195 0.022 158);--muted:oklch(0.44 0.028 158);--line:oklch(0.86 0.013 158);--pass:oklch(0.42 0.13 151);--pass-bg:oklch(0.94 0.04 151);--fail:oklch(0.47 0.15 33);font-family:ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
body{margin:0;background:var(--bg);color:var(--ink)}
main{width:min(1160px,calc(100vw - 56px));margin:0 auto;padding:42px 0 54px}
header{display:grid;grid-template-columns:1fr auto;gap:28px;align-items:end;border-bottom:1px solid var(--line);padding-bottom:24px}
h1{margin:0;font-size:38px;line-height:1.04;font-weight:780;letter-spacing:0}
.sub{margin:12px 0 0;color:var(--muted);max-width:820px;line-height:1.55}
.stamp{border:1px solid var(--pass);background:var(--pass-bg);color:var(--pass);padding:12px 34px;font-weight:780}
.cards{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin:24px 0}
.card,section{background:var(--surface);border:1px solid var(--line)}
.card{padding:16px;min-height:78px}
.label{font-size:11px;text-transform:uppercase;letter-spacing:.08em;color:var(--muted)}
.value{font-size:28px;font-weight:780;margin-top:10px}
section{padding:20px;margin-top:18px}
h2{font-size:19px;margin:0 0 14px}
table{border-collapse:collapse;width:100%;font-size:13px}
th,td{border-top:1px solid var(--line);padding:10px 8px;text-align:left;vertical-align:top}
th{font-size:11px;text-transform:uppercase;letter-spacing:.08em;color:var(--muted)}
code{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12px;white-space:normal}
.ok{color:var(--pass);font-weight:760}.fail{color:var(--fail);font-weight:760}
@media(max-width:860px){main{width:min(100% - 28px,760px);padding-top:26px}.cards{grid-template-columns:1fr 1fr}header{grid-template-columns:1fr}.stamp{width:max-content}h1{font-size:30px}}
</style>
</head>
<body>
<main>
<header>
<div>
<h1>CodeSite Terminal Reattach Proof</h1>
<p class="sub">Verified ${escapeHtml(proof.generatedAt)}. Active CodeSite terminal requests can only resume a matching Docker-overlay-backed session; unmanaged, mismatched, or non-overlay PTYs are denied.</p>
</div>
<div class="stamp">${proof.ok ? 'PASS' : 'FAIL'}</div>
</header>
<div class="cards">
<div class="card"><div class="label">Host Routing</div><div class="value">${escapeHtml(`${proof.commands[0].summary.pass}/${proof.commands[0].summary.tests}`)}</div></div>
<div class="card"><div class="label">Docker Routing</div><div class="value">${escapeHtml(`${proof.commands[1].summary.pass}/${proof.commands[1].summary.tests}`)}</div></div>
<div class="card"><div class="label">Skipped</div><div class="value">${escapeHtml(String(proof.totalSkipped))}</div></div>
<div class="card"><div class="label">Assertions</div><div class="value">${passCount}/${proof.assertions.length}</div></div>
</div>
<section><h2>Reattach Decisions</h2><table><thead><tr><th>Status</th><th>Case</th><th>Decision</th></tr></thead><tbody>${decisionRows}</tbody></table></section>
<section><h2>Executed Commands</h2><table><thead><tr><th>Status</th><th>Surface</th><th>Pass</th><th>Skipped</th><th>Command</th></tr></thead><tbody>${commandRows}</tbody></table></section>
<section><h2>Assertions</h2><table><thead><tr><th>Status</th><th>Assertion</th><th>Details</th></tr></thead><tbody>${assertionRows}</tbody></table></section>
</main>
</body>
</html>`;
}

async function screenshot(htmlPath, pngPath) {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 1050 }, deviceScaleFactor: 1 });
    await page.goto(pathToFileURL(htmlPath).href);
    await page.screenshot({ path: pngPath, fullPage: true });
  } finally {
    await browser.close();
  }
}

await fs.mkdir(proofRoot, { recursive: true });
const decisions = decisionCases();
const commands = [
  await run('hostTerminalRouting', 'node', ['--test', 'backend/collab-server/__tests__/terminalRouting.test.js']),
  await run('dockerTerminalRouting', 'docker', [
    'run',
    '--rm',
    '-v',
    `${repoRoot}:/repo`,
    '-w',
    '/repo',
    nodeImage,
    'node',
    '--test',
    'backend/collab-server/__tests__/terminalRouting.test.js',
  ]),
];
const totalSkipped = commands.reduce((sum, command) => sum + Number(command.summary?.skipped || 0), 0);
const assertions = [
  ...decisions.map((item) => assertion(item.name, item.ok, { expected: item.expected, decision: item.decision })),
  ...commandAssertions(commands),
  assertion('all executed terminal routing tests passed without skipped cases', commands.every((command) => command.summary?.ok === true), {
    summaries: commands.map((command) => command.summary),
  }),
  assertion('terminal reattach proof is based on live routing decisions', decisions.length >= 9 && decisions.every((item) => item.decision && typeof item.decision.ok === 'boolean'), {
    decisions: decisions.length,
  }),
];
const proof = {
  schemaVersion: 'synthi.codesite.terminalReattachProof.v1',
  generatedAt: new Date().toISOString(),
  repoRoot,
  nodeImage,
  ok: assertions.every((item) => item.ok) && commands.every((command) => command.exitCode === 0),
  decisions,
  commands,
  totalSkipped,
  testSummary: {
    tests: commands.reduce((sum, command) => sum + Number(command.summary?.tests || 0), 0),
    pass: commands.reduce((sum, command) => sum + Number(command.summary?.pass || 0), 0),
    fail: commands.reduce((sum, command) => sum + Number(command.summary?.fail || 0), 0),
    cancelled: commands.reduce((sum, command) => sum + Number(command.summary?.cancelled || 0), 0),
    skipped: totalSkipped,
    todo: commands.reduce((sum, command) => sum + Number(command.summary?.todo || 0), 0),
  },
  assertions,
};

await fs.writeFile(proofJsonPath, `${JSON.stringify(proof, null, 2)}\n`);
await fs.writeFile(proofHtmlPath, renderHtml(proof));
await screenshot(proofHtmlPath, proofPngPath);

console.log(JSON.stringify({
  ok: proof.ok,
  jsonPath: path.relative(repoRoot, proofJsonPath),
  htmlPath: path.relative(repoRoot, proofHtmlPath),
  pngPath: path.relative(repoRoot, proofPngPath),
  testSummary: proof.testSummary,
  assertions: proof.assertions.length,
}, null, 2));

if (!proof.ok) process.exit(1);
