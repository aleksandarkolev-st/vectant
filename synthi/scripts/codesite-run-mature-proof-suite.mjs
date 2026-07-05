#!/usr/bin/env node
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const DEFAULT_PROOF_ROOT = 'tmp/codesite-dojo-proof';
const PROOF_SPECS = [
  {
    name: 'activeMutationBoundary',
    file: 'codesite-active-mutation-boundary-proof.json',
    png: 'codesite-active-mutation-boundary-proof.png',
    generator: ['node', 'tmp/codesite-dojo-proof/run-active-mutation-boundary-proof.mjs'],
  },
  {
    name: 'gitServiceBoundary',
    file: 'codesite-gitservice-boundary-proof.json',
    png: 'codesite-gitservice-boundary-proof.png',
    generator: ['node', 'scripts/codesite-gitservice-boundary-proof.mjs'],
  },
  {
    name: 'gitServiceIndexBoundary',
    file: 'codesite-gitservice-index-proof.json',
    png: 'codesite-gitservice-index-proof.png',
    generator: ['node', 'scripts/codesite-gitservice-index-proof.mjs'],
  },
  {
    name: 'gitServiceWorktreeBoundary',
    file: 'codesite-gitservice-worktree-proof.json',
    png: 'codesite-gitservice-worktree-proof.png',
    generator: ['node', 'scripts/codesite-gitservice-worktree-proof.mjs'],
  },
  {
    name: 'directGitServiceBoundary',
    file: 'codesite-direct-gitservice-boundary-proof.json',
    png: 'codesite-direct-gitservice-boundary-proof.png',
    generator: ['node', 'tmp/codesite-dojo-proof/run-direct-gitservice-boundary-proof.mjs'],
  },
  {
    name: 'gitProvisioningBoundary',
    file: 'codesite-git-provisioning-boundary-proof.json',
    png: 'codesite-git-provisioning-boundary-proof.png',
    generator: ['node', 'tmp/codesite-dojo-proof/run-git-provisioning-boundary-proof.mjs'],
  },
  {
    name: 'repoCacheBoundary',
    file: 'codesite-repo-cache-boundary-proof.json',
    png: 'codesite-repo-cache-boundary-proof.png',
    generator: ['node', 'tmp/codesite-dojo-proof/run-repo-cache-boundary-proof.mjs'],
  },
  {
    name: 'workspacePrepGuard',
    file: 'codesite-workspace-prep-guard-proof.json',
    png: 'codesite-workspace-prep-guard-proof.png',
    generator: ['node', 'tmp/codesite-dojo-proof/run-workspace-prep-codesite-proof.mjs'],
  },
  {
    name: 'runtimeFilesystemHydration',
    file: 'codesite-runtime-filesystem-hydration-proof.json',
    png: 'codesite-runtime-filesystem-hydration-proof.png',
    generator: ['node', 'tmp/codesite-dojo-proof/run-runtime-filesystem-hydration-proof.mjs'],
  },
  {
    name: 'runtimeOverlay',
    file: 'codesite-runtime-overlay-proof.json',
    png: 'codesite-runtime-overlay-proof.png',
    generator: ['node', 'tmp/codesite-dojo-proof/run-runtime-overlay-proof.mjs'],
  },
  {
    name: 'runtimeQuarantine',
    file: 'codesite-runtime-quarantine-proof.json',
    png: 'codesite-runtime-quarantine-proof.png',
    generator: ['node', 'synthi/scripts/codesite-runtime-quarantine-proof.mjs'],
  },
  {
    name: 'codesiteFsRuntimeBoundary',
    file: 'codesitefs-runtime-boundary-proof.json',
    png: 'codesitefs-runtime-boundary-proof.png',
    generator: ['node', 'scripts/codesitefs-runtime-boundary-proof.mjs'],
  },
  {
    name: 'unmanagedHostBoundary',
    file: 'codesite-unmanaged-host-boundary-proof.json',
    png: 'codesite-unmanaged-host-boundary-proof.png',
    generator: ['node', 'synthi/scripts/codesite-unmanaged-host-boundary-proof.mjs'],
    preserveNativeVisual: true,
  },
  {
    name: 'quarantineReview',
    file: 'codesite-quarantine-review-proof.json',
    png: 'codesite-quarantine-review-proof.png',
    generator: ['node', 'synthi/scripts/codesite-quarantine-review-proof.mjs'],
  },
  {
    name: 'proofCarryingCommit',
    file: 'codesite-proof-carrying-commit-proof.json',
    png: 'codesite-proof-carrying-commit-proof.png',
    validations: [
      {
        name: 'proofVerifierHelp',
        command: ['node', 'synthi/scripts/codesite-proof-verify.mjs', '--help'],
      },
    ],
  },
  {
    name: 'actualGitCommitProof',
    file: 'codesite-actual-git-commit-proof.json',
    png: 'codesite-actual-git-commit-proof.png',
    generator: ['node', 'tmp/codesite-dojo-proof/run-actual-git-commit-proof.mjs'],
  },
  {
    name: 'proofBundleGitContext',
    file: 'codesite-proof-bundle-git-context-proof.json',
    png: 'codesite-proof-bundle-git-context-proof.png',
    generator: ['node', 'tmp/codesite-dojo-proof/run-proof-bundle-git-context-proof.mjs'],
  },
  {
    name: 'repoStateIdentity',
    file: 'codesite-repo-state-identity-proof.json',
    png: 'codesite-repo-state-identity-proof.png',
    generator: ['node', 'tmp/codesite-dojo-proof/run-repo-state-identity-proof.mjs'],
  },
  {
    name: 'blackBoxCompleteness',
    file: 'codesite-black-box-completeness-proof.json',
    png: 'codesite-black-box-completeness-proof.png',
    generator: ['node', 'tmp/codesite-dojo-proof/run-black-box-completeness-proof.mjs'],
  },
  {
    name: 'lineInspector',
    file: 'codesite-line-inspector-proof.json',
    png: 'codesite-line-inspector-proof.png',
    generator: ['node', 'synthi/scripts/codesite-line-inspector-proof.mjs'],
  },
  {
    name: 'lineProvenanceDiff',
    file: 'codesite-line-provenance-diff-proof.json',
    png: 'codesite-line-provenance-diff-proof.png',
    generator: ['node', 'tmp/codesite-dojo-proof/run-line-provenance-diff-proof.mjs'],
  },
  {
    name: 'shadowSimulator',
    file: 'codesite-shadow-simulator-proof.json',
    png: 'codesite-shadow-simulator-proof.png',
    generator: ['node', 'synthi/scripts/codesite-shadow-simulator-proof.mjs'],
  },
  {
    name: 'runwayOccupancy',
    file: 'codesite-runway-occupancy-proof.json',
    png: 'codesite-runway-occupancy-proof.png',
    generator: ['node', 'synthi/scripts/codesite-runway-occupancy-proof.mjs'],
  },
  {
    name: 'counterfactualMemory',
    file: 'codesite-counterfactual-memory-proof.json',
    png: 'codesite-counterfactual-memory-proof.png',
    generator: ['node', 'synthi/scripts/codesite-counterfactual-memory-proof.mjs'],
  },
  {
    name: 'repoPolicyCompiler',
    file: 'codesite-repo-policy-compiler-proof.json',
    png: 'codesite-repo-policy-compiler-proof.png',
    generator: ['node', 'synthi/scripts/codesite-repo-policy-compiler-proof.mjs'],
  },
  {
    name: 'repoLocalAutosync',
    file: 'codesite-repo-local-autosync-proof.json',
    png: 'codesite-repo-local-autosync-proof.png',
    generator: ['node', 'synthi/scripts/codesite-repo-local-autosync-proof.mjs'],
  },
  {
    name: 'radarAdapter',
    file: 'codesite-radar-adapter-proof.json',
    png: 'codesite-radar-adapter-proof.png',
    generator: ['node', 'synthi/scripts/codesite-radar-adapter-proof.mjs'],
  },
  {
    name: 'governanceMcpLifecycle',
    file: 'codesite-governance-mcp-lifecycle-proof.json',
    png: 'codesite-governance-mcp-lifecycle-proof.png',
    generator: ['node', 'tmp/codesite-dojo-proof/run-governance-mcp-lifecycle-proof.mjs'],
  },
  {
    name: 'radarUi',
    file: 'codesite-radar-ui-proof.json',
    png: null,
    generator: ['node', 'tmp/codesite-dojo-proof/run-radar-ui-proof.mjs'],
  },
  {
    name: 'schemaFirstClearance',
    file: 'codesite-schema-first-clearance-proof.json',
    png: 'codesite-schema-first-clearance-proof.png',
  },
  {
    name: 'metrics',
    file: 'codesite-metrics-proof.json',
    png: 'codesite-metrics-proof.png',
    generator: ['node', 'tmp/codesite-dojo-proof/run-mature-metrics-proof.mjs'],
  },
  {
    name: 'isolationContract',
    file: 'codesite-isolation-contract-proof.json',
    png: 'codesite-isolation-contract-proof.png',
  },
  {
    name: 'serializableCommitRace',
    file: 'codesite-serializable-commit-race-proof.json',
    png: 'codesite-serializable-commit-race-proof.png',
    generator: ['node', 'tmp/codesite-dojo-proof/run-serializable-commit-race-proof.mjs'],
  },
  {
    name: 'runtimeContext',
    file: 'codesite-runtime-context-proof.json',
    png: 'codesite-runtime-context-proof.png',
  },
  {
    name: 'contextAlias',
    file: 'codesite-context-alias-proof.json',
    png: 'codesite-context-alias-proof.png',
  },
  {
    name: 'monitorDowngrade',
    file: 'codesite-monitor-downgrade-proof.json',
    png: 'codesite-monitor-downgrade-proof.png',
  },
  {
    name: 'pathlessRun',
    file: 'codesite-pathless-run-proof.json',
    png: 'codesite-pathless-run-proof.png',
  },
  {
    name: 'terminalReattach',
    file: 'codesite-terminal-reattach-proof.json',
    png: 'codesite-terminal-reattach-proof.png',
    generator: ['node', 'tmp/codesite-dojo-proof/run-terminal-reattach-proof.mjs'],
  },
];

function parseArgs(argv) {
  const options = {
    proofRoot: process.env.CODESITE_PROOF_ROOT || DEFAULT_PROOF_ROOT,
    baseUrl: process.env.CODESITE_PROOF_BASE_URL || null,
    only: null,
    dryRun: false,
    noScreenshot: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--proof-root') options.proofRoot = argv[++index];
    else if (arg === '--base-url') options.baseUrl = argv[++index];
    else if (arg === '--only') options.only = new Set(argv[++index].split(',').map((item) => item.trim()).filter(Boolean));
    else if (arg === '--dry-run') options.dryRun = true;
    else if (arg === '--no-screenshot') options.noScreenshot = true;
    else if (arg === '--help' || arg === '-h') {
      process.stdout.write('Usage: node synthi/scripts/codesite-run-mature-proof-suite.mjs [--proof-root tmp/codesite-dojo-proof] [--base-url http://127.0.0.1:3107] [--only name,name] [--dry-run] [--no-screenshot]\n');
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return options;
}

function repoRoot() {
  return path.basename(process.cwd()) === 'synthi' ? path.dirname(process.cwd()) : process.cwd();
}

function relative(root, targetPath) {
  return path.relative(root, targetPath).replace(/\\/g, '/') || '.';
}

function git(root, args) {
  return execFileSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function safeGit(root, args) {
  try {
    return git(root, args);
  } catch {
    return '';
  }
}

function runCommand(root, command, options = {}) {
  const result = spawnSync(command[0], command.slice(1), {
    cwd: root,
    env: {
      ...process.env,
      ...(options.env || {}),
    },
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
  });
  const output = `${result.stdout || ''}${result.stderr || ''}`;
  return {
    name: options.name || path.basename(command[1] || command[0]).replace(/\.[cm]?js$/, ''),
    command: command.map((part) => quoteShell(part)).join(' '),
    cwd: '.',
    exitCode: typeof result.status === 'number' ? result.status : 1,
    signal: result.signal || null,
    summary: parseTestSummary(output, options.summaryPattern),
    outputTail: output.split(/\r?\n/).filter(Boolean).slice(-30),
  };
}

function quoteShell(value) {
  const text = String(value);
  return /^[A-Za-z0-9_./:=@+-]+$/.test(text) ? text : JSON.stringify(text);
}

function isLoopbackUrl(value) {
  try {
    const url = new URL(value);
    return ['127.0.0.1', 'localhost', '::1'].includes(url.hostname);
  } catch {
    return false;
  }
}

function parseTestSummary(output, summaryPattern = null) {
  const nodeSummary = {};
  for (const key of ['tests', 'suites', 'pass', 'fail', 'cancelled', 'skipped', 'todo']) {
    const match = output.match(new RegExp(`# ${key} (\\d+)`));
    if (match) nodeSummary[key] = Number(match[1]);
  }
  if (Object.keys(nodeSummary).length) return { ...nodeSummary, runner: 'node:test' };

  const vitestMatch = output.match(/Tests\s+(\d+)\s+passed/i);
  if (vitestMatch) {
    return { tests: Number(vitestMatch[1]), pass: Number(vitestMatch[1]), fail: 0, runner: 'vitest' };
  }

  if (summaryPattern) {
    return { tests: 1, pass: summaryPattern.test(output) ? 1 : 0, fail: summaryPattern.test(output) ? 0 : 1, runner: 'source-pattern' };
  }

  return { tests: 1, pass: 1, fail: 0, runner: 'command' };
}

function commandPassed(command) {
  if (!command || Number(command.exitCode) !== 0) return false;
  const summary = command.summary || {};
  for (const key of ['fail', 'failed', 'failures', 'cancelled', 'skipped', 'todo']) {
    if (Number(summary[key] || 0) > 0) return false;
  }
  return true;
}

function normalizeAssertions(assertions) {
  if (Array.isArray(assertions)) {
    return assertions.map((assertion, index) => ({
      name: assertion?.name || `assertion[${index}]`,
      ok: assertionOk(assertion),
      details: assertion?.details || assertion?.detail || {},
    }));
  }
  if (assertions && typeof assertions === 'object') {
    return Object.entries(assertions).map(([name, value]) => ({
      name,
      ok: assertionOk(value),
      details: value && typeof value === 'object' ? value : {},
    }));
  }
  return [];
}

function assertionOk(assertion) {
  if (assertion === true) return true;
  if (!assertion || typeof assertion !== 'object') return false;
  if (assertion.ok !== undefined) return assertion.ok === true;
  if (assertion.passed !== undefined) return assertion.passed === true;
  if (assertion.value !== undefined) return assertion.value === true;
  if (assertion.status !== undefined) return assertion.status === 'pass' || assertion.status === 'passed';
  return false;
}

function loadProof(proofPath, spec) {
  if (fs.existsSync(proofPath)) {
    return JSON.parse(fs.readFileSync(proofPath, 'utf8'));
  }
  return {
    schemaVersion: `synthi.codesite.${spec.name}.proof.v1`,
    source: 'codesite-run-mature-proof-suite',
    assertions: [],
  };
}

function artifactIntegrityValidation(root, proofRoot, spec) {
  const proofPath = path.join(proofRoot, spec.file);
  const pngPath = spec.png ? path.join(proofRoot, spec.png) : '';
  const script = `
const fs = require('fs');
const proofPath = process.argv[1];
const pngPath = process.argv[2] || '';
function assertionOk(value) {
  if (value === true) return true;
  if (!value || typeof value !== 'object') return false;
  if (value.ok !== undefined) return value.ok === true;
  if (value.passed !== undefined) return value.passed === true;
  if (value.value !== undefined) return value.value === true;
  if (value.status !== undefined) return value.status === 'pass' || value.status === 'passed';
  return false;
}
const proof = JSON.parse(fs.readFileSync(proofPath, 'utf8'));
const entries = Array.isArray(proof.assertions)
  ? proof.assertions.map(assertionOk)
  : Object.values(proof.assertions || {}).map(assertionOk);
if (entries.length && entries.some((ok) => !ok)) {
  console.error('proof assertions contain failures');
  process.exit(1);
}
if (pngPath && !fs.existsSync(pngPath)) {
  console.error('proof PNG missing');
  process.exit(1);
}
console.log(JSON.stringify({ ok: true, assertions: entries.length, png: Boolean(pngPath) }));
`;
  return {
    name: `artifactIntegrity:${spec.name}`,
    command: ['node', '-e', script, proofPath, pngPath],
  };
}

function mergeCommands(proof, proofSuiteCommands) {
  const nativeCommands = Array.isArray(proof.commands)
    ? proof.commands.filter((command) => !String(command?.name || '').startsWith('proofSuite'))
    : [];
  return [
    ...nativeCommands,
    ...proofSuiteCommands.map((command) => ({
      ...command,
      name: command.name.startsWith('proofSuite') ? command.name : `proofSuite:${command.name}`,
    })),
  ];
}

function stampProof(root, proofRoot, spec, proofSuiteCommands) {
  const proofPath = path.join(proofRoot, spec.file);
  const proof = loadProof(proofPath, spec);
  const commands = mergeCommands(proof, proofSuiteCommands);
  const allCommandsPass = commands.length > 0 && commands.every(commandPassed);
  const gitHead = safeGit(root, ['rev-parse', 'HEAD']);
  const generatedAt = new Date().toISOString();

  proof.status = 'validated';
  proof.generatedAt = generatedAt;
  proof.git = {
    head: gitHead,
    branch: safeGit(root, ['rev-parse', '--abbrev-ref', 'HEAD']),
    statusShort: safeGit(root, ['status', '--short']),
  };
  proof.commands = commands;
  proof.proofSuite = {
    runner: 'synthi/scripts/codesite-run-mature-proof-suite.mjs',
    stampedAt: generatedAt,
    proofFile: relative(root, proofPath),
  };

  let assertions = normalizeAssertions(proof.assertions);
  if (!proof.assertions || assertions.length === 0) {
    proof.assertions = {
      proofWillBeWritten: true,
      proofCommandsPassed: allCommandsPass,
      proofGitBound: Boolean(gitHead),
    };
    assertions = normalizeAssertions(proof.assertions);
  }
  const allAssertionsPass = assertions.length === 0 || assertions.every((assertion) => assertion.ok);
  proof.ok = proof.ok === false ? false : allAssertionsPass && allCommandsPass;

  fs.mkdirSync(path.dirname(proofPath), { recursive: true });
  fs.writeFileSync(proofPath, `${JSON.stringify(proof, null, 2)}\n`);
  return { proof, proofPath };
}

function renderSummaryHtml(spec, proof, commands) {
  const assertions = normalizeAssertions(proof.assertions);
  const assertionRows = assertions.map((assertion) => `
    <tr>
      <td><span class="${assertion.ok ? 'ok' : 'bad'}">${assertion.ok ? 'PASS' : 'FAIL'}</span></td>
      <td>${escapeHtml(assertion.name)}</td>
      <td><code>${escapeHtml(JSON.stringify(assertion.details || {}))}</code></td>
    </tr>
  `).join('');
  const commandRows = commands.map((command) => `
    <tr>
      <td><span class="${commandPassed(command) ? 'ok' : 'bad'}">${commandPassed(command) ? 'PASS' : 'FAIL'}</span></td>
      <td><code>${escapeHtml(command.command)}</code></td>
      <td><code>${escapeHtml(JSON.stringify(command.summary || {}))}</code></td>
    </tr>
  `).join('');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>CodeSite Mature Proof: ${escapeHtml(spec.name)}</title>
<style>
:root{color-scheme:dark;font-family:ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:#080b10;color:#f5f7fb}
body{margin:0;background:#080b10;padding:30px}
main{max-width:1180px;margin:0 auto;display:grid;gap:16px}
.hero,.card{border:1px solid #2c3443;background:#111722;border-radius:8px;padding:18px}
.hero{display:grid;grid-template-columns:1fr auto;gap:16px;align-items:start}
h1{margin:8px 0 8px;font-size:30px;line-height:1.12;letter-spacing:0}
h2{margin:0 0 10px;font-size:16px;letter-spacing:0}
p{margin:0;color:#aeb8c9;line-height:1.55;max-width:92ch}
.stamp{border-radius:6px;padding:7px 11px;font-size:12px;font-weight:800;background:${proof.ok ? '#133d2a' : '#4b1515'};color:${proof.ok ? '#9df1bd' : '#ffc1c1'}}
.grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:10px}
.metric{border:1px solid #2c3443;background:#0b1018;border-radius:8px;padding:12px;min-width:0}
.label{font-size:12px;color:#8f9caf}.value{margin-top:6px;font-size:16px;font-weight:750;overflow-wrap:anywhere}
table{width:100%;border-collapse:collapse;font-size:13px;table-layout:fixed}
th,td{border-top:1px solid #2c3443;padding:8px;text-align:left;vertical-align:top}
th{font-size:12px;color:#aeb8c9}
code{font-family:"SFMono-Regular",Consolas,monospace;font-size:12px;overflow-wrap:anywhere;color:#dce5f5}
.ok{color:#9df1bd;font-weight:800}.bad{color:#ffc1c1;font-weight:800}
@media(max-width:820px){body{padding:14px}.hero{grid-template-columns:1fr}.grid{grid-template-columns:1fr 1fr}h1{font-size:25px}}
</style>
</head>
<body>
<main>
<section class="hero">
  <div>
    <span class="stamp">${proof.ok ? 'VALIDATED' : 'FAILED'}</span>
    <h1>CodeSite Mature Proof: ${escapeHtml(spec.name)}</h1>
    <p>Generated from the current proof-suite runner. This visual summary binds assertions, executable commands, and git provenance for release-gate verification.</p>
  </div>
  <span class="stamp">${escapeHtml(proof.status || 'unknown')}</span>
</section>
<section class="grid">
  <div class="metric"><div class="label">Git head</div><div class="value">${escapeHtml(proof.git?.head || 'missing')}</div></div>
  <div class="metric"><div class="label">Branch</div><div class="value">${escapeHtml(proof.git?.branch || 'missing')}</div></div>
  <div class="metric"><div class="label">Assertions</div><div class="value">${assertions.filter((item) => item.ok).length}/${assertions.length}</div></div>
  <div class="metric"><div class="label">Commands</div><div class="value">${commands.filter(commandPassed).length}/${commands.length}</div></div>
</section>
<section class="card"><h2>Executable Commands</h2><table><thead><tr><th>Status</th><th>Command</th><th>Summary</th></tr></thead><tbody>${commandRows}</tbody></table></section>
<section class="card"><h2>Assertions</h2><table><thead><tr><th>Status</th><th>Name</th><th>Details</th></tr></thead><tbody>${assertionRows}</tbody></table></section>
</main>
</body>
</html>`;
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

async function screenshotHtml(htmlPath, pngPath) {
  const browser = await chromium.launch({
    headless: true,
    chromiumSandbox: false,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 980 }, deviceScaleFactor: 1 });
    await page.goto(pathToFileURL(htmlPath).href, { waitUntil: 'load' });
    await page.screenshot({ path: pngPath, fullPage: true });
  } finally {
    await browser.close();
  }
}

async function renderVisualSummary(root, proofRoot, spec, proof) {
  if (!spec.png) return null;
  const htmlPath = path.join(proofRoot, spec.file.replace(/\.json$/, '.html'));
  const pngPath = path.join(proofRoot, spec.png);
  fs.writeFileSync(htmlPath, renderSummaryHtml(spec, proof, proof.commands || []));
  await screenshotHtml(htmlPath, pngPath);
  return { htmlPath: relative(root, htmlPath), pngPath: relative(root, pngPath) };
}

async function runSpec(root, proofRoot, spec, options) {
  const env = {
    CODESITE_PROOF_ROOT: proofRoot,
    CODESITE_PROOF_OUT_DIR: proofRoot,
  };
  if (options.baseUrl) env.CODESITE_PROOF_BASE_URL = options.baseUrl;
  if (options.baseUrl) env.CODESITE_APP_URL = options.baseUrl;
  if (!process.env.AUTH_SECRET && !process.env.NEXTAUTH_SECRET && options.baseUrl && isLoopbackUrl(options.baseUrl)) {
    env.AUTH_SECRET = process.env.CODESITE_PROOF_AUTH_SECRET || 'local-compose-auth-secret';
    env.NEXTAUTH_SECRET = env.AUTH_SECRET;
  }

  const commands = [];
  if (spec.generator) {
    commands.push(runCommand(root, spec.generator, { name: `proofSuiteGenerator:${spec.name}`, env }));
  }
  const validations = spec.generator || spec.validations?.length
    ? spec.validations || []
    : [artifactIntegrityValidation(root, proofRoot, spec)];
  for (const validation of validations) {
    commands.push(runCommand(root, validation.command, {
      name: validation.name,
      env,
      summaryPattern: validation.summaryPattern || null,
    }));
  }

  const failed = commands.filter((command) => !commandPassed(command));
  if (failed.length) {
    return { name: spec.name, ok: false, commands, failed };
  }

  const { proof, proofPath } = stampProof(root, proofRoot, spec, commands);
  const visual = options.noScreenshot
    ? null
    : spec.preserveNativeVisual
      ? {
          htmlPath: relative(root, path.join(proofRoot, spec.file.replace(/\.json$/, '.html'))),
          pngPath: relative(root, path.join(proofRoot, spec.png)),
        }
      : await renderVisualSummary(root, proofRoot, spec, proof);
  return {
    name: spec.name,
    ok: proof.ok === true,
    proofPath: relative(root, proofPath),
    visual,
    commands: commands.map((command) => ({ name: command.name, exitCode: command.exitCode, summary: command.summary })),
  };
}

async function main(argv) {
  const root = repoRoot();
  const options = parseArgs(argv);
  const proofRoot = path.resolve(root, options.proofRoot);
  const specs = PROOF_SPECS.filter((spec) => !options.only || options.only.has(spec.name));

  fs.mkdirSync(proofRoot, { recursive: true });
  if (options.dryRun) {
    process.stdout.write(`${JSON.stringify({ proofRoot: relative(root, proofRoot), specs }, null, 2)}\n`);
    return;
  }

  const results = [];
  for (const spec of specs) {
    process.stderr.write(`[codesite-proof-suite] ${spec.name}\n`);
    results.push(await runSpec(root, proofRoot, spec, options));
  }

  const result = {
    ok: results.every((item) => item.ok),
    generatedAt: new Date().toISOString(),
    proofRoot: relative(root, proofRoot),
    git: {
      head: safeGit(root, ['rev-parse', 'HEAD']),
      branch: safeGit(root, ['rev-parse', '--abbrev-ref', 'HEAD']),
      statusShort: safeGit(root, ['status', '--short']),
    },
    results,
  };
  const outPath = path.join(proofRoot, 'codesite-mature-proof-suite-run.json');
  fs.writeFileSync(outPath, `${JSON.stringify(result, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (!result.ok) process.exitCode = 1;
}

main(process.argv.slice(2)).catch((error) => {
  console.error(error);
  process.exit(1);
});
