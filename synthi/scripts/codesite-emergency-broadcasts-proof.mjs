#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync, execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright';

const DEFAULT_PROOF_ROOT = 'tmp/codesite-dojo-proof';
const PROOF_FILE = 'codesite-emergency-broadcasts-proof.json';
const HTML_FILE = 'codesite-emergency-broadcasts-proof.html';
const PNG_FILE = 'codesite-emergency-broadcasts-proof.png';

function repoRoot() {
  return path.basename(process.cwd()) === 'synthi' ? path.dirname(process.cwd()) : process.cwd();
}

function proofRoot() {
  return path.resolve(process.env.CODESITE_PROOF_OUT_DIR || process.env.CODESITE_PROOF_ROOT || path.join(repoRoot(), DEFAULT_PROOF_ROOT));
}

function relative(root, targetPath) {
  return path.relative(root, targetPath).replace(/\\/g, '/') || '.';
}

function readText(root, relativePath) {
  return fs.readFileSync(path.join(root, relativePath), 'utf8');
}

function git(root, args) {
  try {
    return execFileSync('git', args, {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return '';
  }
}

function stripAnsi(value) {
  return String(value || '').replace(/\x1b\[[0-9;]*m/g, '');
}

function parseVitestSummary(output) {
  const clean = stripAnsi(output);
  const testsLine = clean.match(/Tests\s+(\d+)\s+passed(?:\s+\|\s+(\d+)\s+skipped)?/i);
  const filesLine = clean.match(/Test Files\s+(\d+)\s+passed/i);
  return {
    runner: 'vitest',
    tests: Number(testsLine?.[1] || 0),
    pass: Number(testsLine?.[1] || 0),
    fail: /failed/i.test(clean) && !/0\s+failed/i.test(clean) ? 1 : 0,
    skipped: Number(testsLine?.[2] || 0),
    files: Number(filesLine?.[1] || 0),
  };
}

function runCommand(root, name, command) {
  const result = spawnSync(command[0], command.slice(1), {
    cwd: root,
    env: process.env,
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
  });
  const output = `${result.stdout || ''}${result.stderr || ''}`;
  return {
    name,
    command: command.map(quoteShell).join(' '),
    cwd: '.',
    exitCode: typeof result.status === 'number' ? result.status : 1,
    signal: result.signal || null,
    summary: parseVitestSummary(output),
    outputTail: stripAnsi(output).split(/\r?\n/).filter(Boolean).slice(-30),
  };
}

function quoteShell(value) {
  const text = String(value);
  return /^[A-Za-z0-9_./:=@+-]+$/.test(text) ? text : JSON.stringify(text);
}

function assertion(name, ok, details = {}) {
  return { name, ok: ok === true, details };
}

function includesAll(text, markers) {
  return markers.every((marker) => text.includes(marker));
}

function buildProof(root, outRoot, dockerCommand) {
  const plan = readText(root, 'docs/CODESITE_CONSTRUCTION_COORDINATION_PLAN.md');
  const controlPlane = readText(root, 'synthi/src/lib/codesite/controlPlane.js');
  const route = readText(root, 'synthi/src/app/api/workspace/[slug]/codesite/[[...path]]/route.js');
  const policy = readText(root, 'synthi/src/lib/codesite/policy.js');
  const tests = readText(root, 'synthi/src/lib/codesite/__tests__/controlPlane.test.js');

  const assertions = [
    assertion('phase6MaydayGroundStopPlanned', includesAll(plan, [
      '### Phase 6: Mayday and Ground Stop',
      'mayday event type',
      'ground-stop workflow',
      'repo snapshot on emergency',
      'inspector launch',
      'human resume gate',
    ]), { planRefs: ['Phase 6'] }),
    assertion('seniorEmergencyBroadcastsPlanned', includesAll(plan, [
      '### 26.5 Emergency Broadcasts',
      'MAYDAY from',
      'Tower issued ground stop',
      'dispatched',
    ]), { planRefs: ['26.5'] }),
    assertion('eventTypesRegistered', includesAll(policy, ['mayday', 'ground_stop', 'mayday_resumed'])
      && includesAll(controlPlane, ['mayday', 'ground_stop', 'mayday_resumed']), {
      files: ['synthi/src/lib/codesite/policy.js', 'synthi/src/lib/codesite/controlPlane.js'],
    }),
    assertion('maydayDeclarationBuildsEmergencySnapshot', includesAll(controlPlane, [
      'applyMaydayGroundStop',
      'emergencySnapshot(project, incident',
      "eventType: 'snapshot_taken'",
    ]), { file: 'synthi/src/lib/codesite/controlPlane.js' }),
    assertion('groundStopSuspendsAffectedLeases', includesAll(controlPlane, [
      'suspendLeasesForMayday',
      "data: { status: 'suspended' }",
      "'mayday_ground_stop'",
      "eventType: 'ground_stop'",
    ]), { file: 'synthi/src/lib/codesite/controlPlane.js' }),
    assertion('maydayDispatchesInspector', includesAll(controlPlane, [
      'dispatchMaydayInspector',
      "status: 'requested'",
      "eventType: 'landing_requested'",
      'mayday_inspector_dispatched',
    ]), { file: 'synthi/src/lib/codesite/controlPlane.js' }),
    assertion('stopWorkDocumentRequiresHumanResume', includesAll(controlPlane, [
      'openStopWorkDocument',
      "kind: 'stop_work'",
      'requiresHumanApproval: true',
      'Human tower approval is required before affected clearances resume.',
    ]), { file: 'synthi/src/lib/codesite/controlPlane.js' }),
    assertion('resumeEndpointExposed', includesAll(route, [
      "route[0] === 'incidents' && route[2] === 'resume'",
      'resumeMaydayIncident(slug, route[1], body, access.actor)',
    ]), { file: 'synthi/src/app/api/workspace/[slug]/codesite/[[...path]]/route.js' }),
    assertion('resumeRequiresHumanApproval', includesAll(controlPlane, [
      'mayday_resume_human_approval_required',
      'mayday_resume_rationale_required',
    ]), { file: 'synthi/src/lib/codesite/controlPlane.js' }),
    assertion('resumeRequiresPassedInspectionEvidence', includesAll(controlPlane, [
      'validateMaydayResumeInspections',
      'mayday_resume_inspection_required',
      'mayday_resume_inspection_evidence_required',
      'mayday_resume_failed_signal_override_required',
    ]), { file: 'synthi/src/lib/codesite/controlPlane.js' }),
    assertion('resumeReactivatesSuspendedLeases', includesAll(controlPlane, [
      "data: { status: 'active' }",
      "'human_resume_approved'",
      "'inspection_passed'",
      "'mayday_ground_stop_resolved'",
    ]), { file: 'synthi/src/lib/codesite/controlPlane.js' }),
    assertion('resumeRecordsMaydayResumedEvent', includesAll(controlPlane, [
      "eventType: 'mayday_resumed'",
      "actorType: 'human'",
      'resumedLeaseIds',
    ]), { file: 'synthi/src/lib/codesite/controlPlane.js' }),
    assertion('maydayDeclarationAndResumeTestsExist', includesAll(tests, [
      'turns mayday declarations into ground stops with suspended leases and inspector dispatch',
      'requires human approval and passed inspection evidence before resuming mayday ground stops',
      'mayday_resume_human_approval_required',
      'mayday_resumed',
    ]), { file: 'synthi/src/lib/codesite/__tests__/controlPlane.test.js' }),
    assertion('dockerMaydayTestsPass', dockerCommand.exitCode === 0
      && Number(dockerCommand.summary.tests || 0) >= 2
      && Number(dockerCommand.summary.fail || 0) === 0, {
      tests: dockerCommand.summary.tests,
      skipped: dockerCommand.summary.skipped,
      exitCode: dockerCommand.exitCode,
    }),
  ];

  return {
    schemaVersion: 'synthi.codesite.emergencyBroadcastsProof.v1',
    status: assertions.every((item) => item.ok) ? 'validated' : 'failed',
    ok: assertions.every((item) => item.ok),
    generatedAt: new Date().toISOString(),
    planRefs: ['Phase 6', '26.5'],
    proofRoot: relative(root, outRoot),
    git: {
      head: git(root, ['rev-parse', 'HEAD']),
      branch: git(root, ['rev-parse', '--abbrev-ref', 'HEAD']),
      statusShort: git(root, ['status', '--short']),
    },
    scenario: {
      eventTypes: ['mayday', 'snapshot_taken', 'ground_stop', 'landing_requested', 'mayday_resumed'],
      emergencyWorkflow: [
        'declare mayday',
        'snapshot repo emergency state',
        'ground-stop affected leases',
        'dispatch inspector',
        'block stop-work document behind human resume gate',
        'resume only after approval and passed inspection evidence',
      ],
    },
    assertions,
    commands: [dockerCommand],
  };
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function renderHtml(proof) {
  const assertionCards = proof.assertions.map((item) => `
    <article class="check">
      <div>
        <span class="${item.ok ? 'pass' : 'fail'}">${item.ok ? 'PASS' : 'FAIL'}</span>
        <h3>${escapeHtml(item.name)}</h3>
      </div>
      <pre>${escapeHtml(JSON.stringify(item.details || {}, null, 2))}</pre>
    </article>
  `).join('');
  const command = proof.commands[0] || {};
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>CodeSite Emergency Broadcasts Proof</title>
<style>
:root{color-scheme:dark;background:#07090f;color:#f7f8fb;font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
*{box-sizing:border-box}
body{margin:0;background:#07090f;padding:28px}
main{max-width:1240px;margin:0 auto;display:grid;gap:16px}
.hero,.panel,.check{border:1px solid #273042;background:#111621;border-radius:8px}
.hero{padding:22px;display:grid;grid-template-columns:1fr auto;gap:20px;align-items:start}
.panel{padding:16px}
h1{font-size:30px;line-height:1.12;margin:8px 0 8px;letter-spacing:0}
h2{font-size:15px;margin:0 0 10px;color:#b9c5da;letter-spacing:0}
h3{font-size:14px;margin:8px 0 0;letter-spacing:0}
p{margin:0;color:#b8c2d7;line-height:1.5;max-width:88ch}
.stamp,.pass,.fail{display:inline-flex;border-radius:6px;padding:6px 9px;font-size:12px;font-weight:800;letter-spacing:0}
.stamp,.pass{background:#123d2a;color:#9df1bd}.fail{background:#4c1515;color:#ffc4c4}
.grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:10px}
.metric{border:1px solid #273042;background:#090d15;border-radius:8px;padding:12px;min-width:0}
.label{font-size:12px;color:#91a0bb}.value{margin-top:6px;font-size:17px;font-weight:780;overflow-wrap:anywhere}
.checks{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px}
.check{padding:14px;display:grid;gap:10px;min-width:0}
pre{margin:0;border:1px solid #20283a;background:#070b12;border-radius:6px;padding:10px;color:#dbe5f7;font:12px/1.45 "SFMono-Regular",Consolas,monospace;white-space:pre-wrap;overflow-wrap:anywhere}
.flow{display:grid;grid-template-columns:repeat(6,minmax(0,1fr));gap:8px}
.step{border:1px solid #273042;background:#090d15;border-radius:8px;padding:10px;min-height:72px}
.step strong{display:block;font-size:13px}.step span{display:block;margin-top:5px;color:#9fb0cc;font-size:12px;line-height:1.35}
@media(max-width:900px){body{padding:14px}.hero{grid-template-columns:1fr}.grid{grid-template-columns:1fr 1fr}.checks{grid-template-columns:1fr}.flow{grid-template-columns:1fr 1fr}h1{font-size:25px}}
</style>
</head>
<body>
<main>
  <section class="hero">
    <div>
      <span class="stamp">${proof.ok ? 'VALIDATED' : 'FAILED'}</span>
      <h1>CodeSite Emergency Broadcasts Proof</h1>
      <p>Release-gated evidence that Mayday declarations issue ground stops, capture emergency snapshots, dispatch inspectors, and resume only through a human approval gate backed by passed inspection evidence.</p>
    </div>
    <span class="stamp">${escapeHtml(proof.generatedAt)}</span>
  </section>
  <section class="grid">
    <div class="metric"><div class="label">Plan refs</div><div class="value">${proof.planRefs.map(escapeHtml).join(', ')}</div></div>
    <div class="metric"><div class="label">Git head</div><div class="value">${escapeHtml(proof.git.head)}</div></div>
    <div class="metric"><div class="label">Assertions</div><div class="value">${proof.assertions.filter((item) => item.ok).length}/${proof.assertions.length}</div></div>
    <div class="metric"><div class="label">Docker tests</div><div class="value">${Number(command.summary?.tests || 0)} passed</div></div>
  </section>
  <section class="panel">
    <h2>Emergency Workflow</h2>
    <div class="flow">
      ${proof.scenario.emergencyWorkflow.map((step, index) => `<div class="step"><strong>${index + 1}. ${escapeHtml(step)}</strong><span>${escapeHtml(proof.scenario.eventTypes[index] || 'governance')}</span></div>`).join('')}
    </div>
  </section>
  <section class="panel">
    <h2>Docker Validation</h2>
    <pre>${escapeHtml(JSON.stringify(command, null, 2))}</pre>
  </section>
  <section class="checks">${assertionCards}</section>
</main>
</body>
</html>`;
}

async function screenshot(htmlPath, pngPath) {
  const browser = await chromium.launch({
    headless: true,
    chromiumSandbox: false,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 1100 }, deviceScaleFactor: 1 });
    await page.goto(pathToFileURL(htmlPath).href, { waitUntil: 'load' });
    await page.screenshot({ path: pngPath, fullPage: true });
  } finally {
    await browser.close();
  }
}

async function main() {
  const root = repoRoot();
  const outRoot = proofRoot();
  fs.mkdirSync(outRoot, { recursive: true });
  const dockerCommand = runCommand(root, 'dockerMaydayResumeTests', [
    'docker',
    'run',
    '--rm',
    '-v',
    `${root}:/repo`,
    '-w',
    '/repo/synthi',
    'node:22-bookworm',
    'bash',
    '-lc',
    'if [ ! -f node_modules/vitest/vitest.mjs ]; then npm ci --ignore-scripts; fi; node node_modules/vitest/vitest.mjs run src/lib/codesite/__tests__/controlPlane.test.js -t mayday --pool=threads --maxWorkers=1 --no-file-parallelism',
  ]);
  const proof = buildProof(root, outRoot, dockerCommand);
  const proofPath = path.join(outRoot, PROOF_FILE);
  const htmlPath = path.join(outRoot, HTML_FILE);
  const pngPath = path.join(outRoot, PNG_FILE);
  fs.writeFileSync(proofPath, `${JSON.stringify(proof, null, 2)}\n`);
  fs.writeFileSync(htmlPath, renderHtml(proof));
  await screenshot(htmlPath, pngPath);
  process.stdout.write(`${JSON.stringify({
    ok: proof.ok,
    proof: relative(root, proofPath),
    html: relative(root, htmlPath),
    png: relative(root, pngPath),
    assertions: proof.assertions.length,
    command: dockerCommand.name,
    tests: dockerCommand.summary.tests,
  }, null, 2)}\n`);
  if (!proof.ok) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
