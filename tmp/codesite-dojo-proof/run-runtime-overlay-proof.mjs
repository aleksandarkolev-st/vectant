import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';

const execFileAsync = promisify(execFile);
const repoRoot = process.cwd();
const require = createRequire(import.meta.url);
const proofRoot = path.join(repoRoot, 'tmp', 'codesite-dojo-proof');
const proofJsonPath = path.join(proofRoot, 'codesite-runtime-overlay-proof.json');
const proofHtmlPath = path.join(proofRoot, 'codesite-runtime-overlay-proof.html');
const proofPngPath = path.join(proofRoot, 'codesite-runtime-overlay-proof.png');
const nodeImage = 'node:20-bookworm@sha256:8f693eaa7e0a8e71560c9a82b55fd54c2ae920a2ba5d2cde28bac7d1c01c9ba5';

function compact(text, max = 6000) {
  const value = String(text || '');
  return value.length <= max ? value : `${value.slice(0, max)}\n...<truncated ${value.length - max} chars>`;
}

function parseTap(output) {
  const text = String(output || '');
  const read = (name) => Number(text.match(new RegExp(`# ${name} (\\d+)`))?.[1] || 0);
  return {
    tests: read('tests'),
    pass: read('pass'),
    fail: read('fail'),
    skipped: read('skipped'),
    ok: read('fail') === 0 && read('pass') > 0,
  };
}

async function run(name, command, args, options = {}) {
  const startedAt = new Date().toISOString();
  try {
    const result = await execFileAsync(command, args, {
      cwd: repoRoot,
      maxBuffer: 30 * 1024 * 1024,
      ...options,
    });
    return {
      name,
      command: [command, ...args].join(' '),
      ok: true,
      startedAt,
      completedAt: new Date().toISOString(),
      stdout: compact(result.stdout),
      stderr: compact(result.stderr),
      tap: parseTap(`${result.stdout}\n${result.stderr}`),
    };
  } catch (error) {
    return {
      name,
      command: [command, ...args].join(' '),
      ok: false,
      startedAt,
      completedAt: new Date().toISOString(),
      stdout: compact(error.stdout),
      stderr: compact(error.stderr || error.message),
      exitCode: error.code,
      tap: parseTap(`${error.stdout || ''}\n${error.stderr || ''}`),
    };
  }
}

async function docker(args, options = {}) {
  return execFileAsync('docker', args, {
    cwd: repoRoot,
    maxBuffer: 30 * 1024 * 1024,
    ...options,
  });
}

async function runDockerOverlaySmoke() {
  const suffix = crypto.randomBytes(6).toString('hex');
  const baseVolume = `codesite_overlay_base_${suffix}`;
  const overlayVolume = `codesite_overlay_work_${suffix}`;
  const container = `codesite-overlay-proof-${suffix}`;
  const steps = [];
  const record = async (name, args) => {
    const step = await run(name, 'docker', args);
    steps.push(step);
    if (!step.ok) throw new Error(`${name} failed`);
    return step;
  };

  const setupScript = [
    'set -euo pipefail',
    'mkdir -p /workspace /codesite/overlay/upper /codesite/overlay/work',
    'chown -R rootless:rootless /codesite/overlay/upper /codesite/overlay/work 2>/dev/null || true',
    'if touch /codesite/base/.codesite-write-probe 2>/tmp/base-write.err; then echo BASE_WRITE_UNEXPECTED; exit 73; fi',
    'mount -t overlay overlay -o lowerdir=/codesite/base,upperdir=/codesite/overlay/upper,workdir=/codesite/overlay/work /workspace || fuse-overlayfs -o lowerdir=/codesite/base -o upperdir=/codesite/overlay/upper -o workdir=/codesite/overlay/work /workspace',
    'test "$(cat /workspace/src/app.txt)" = before',
    'test -r /codesite/base',
    'test -w /workspace',
    'probe_dir="$(find /workspace -mindepth 1 -maxdepth 4 -type d 2>/dev/null | head -n 1 || true)"',
    'if [ -n "$probe_dir" ]; then env PROBE_DIR="$probe_dir" su rootless -c \'touch "$PROBE_DIR/.codesite-overlay-rootless-probe" && rm -f "$PROBE_DIR/.codesite-overlay-rootless-probe"\'; fi',
    'grep " /workspace " /proc/mounts',
  ].join('\n');

  const rootlessWriteScript = [
    'set -euo pipefail',
    'ls -la /workspace/src',
    'touch /workspace/src/rootless-proof.txt',
    'printf "%s\\n" after > /workspace/src/app.txt',
    'printf "%s\\n" new > /workspace/src/new.txt',
    'rm /workspace/src/old.txt',
    'test "$(cat /workspace/src/app.txt)" = after',
  ].join('\n');

  const inspectScript = [
    'set -euo pipefail',
    'test "$(cat /codesite/base/src/app.txt)" = before',
    'test -f /codesite/base/src/old.txt',
    'test "$(cat /workspace/src/app.txt)" = after',
    'test -f /workspace/src/new.txt',
    'test ! -e /workspace/src/old.txt',
    'grep " /workspace " /proc/mounts',
    'printf "MERGED_APP=%s\\n" "$(cat /workspace/src/app.txt)"',
    'printf "BASE_APP=%s\\n" "$(cat /codesite/base/src/app.txt)"',
    'ls -la /codesite/overlay/upper /codesite/overlay/upper/src',
  ].join('\n');

  try {
    await record('docker-volume-create-base', ['volume', 'create', baseVolume]);
    await record('docker-volume-create-overlay', ['volume', 'create', overlayVolume]);
    await record('docker-seed-base', [
      'run', '--rm', '--user', 'root',
      '-v', `${baseVolume}:/base`,
      'vectant-runtime:local',
      '/bin/bash', '-lc',
      'mkdir -p /base/src && printf "before\\n" > /base/src/app.txt && printf "old\\n" > /base/src/old.txt && chown -R rootless:rootless /base',
    ]);
    await record('docker-start-runtime', [
      'run', '-d', '--name', container, '--privileged',
      '-v', `${baseVolume}:/codesite/base:ro`,
      '-v', `${overlayVolume}:/codesite/overlay`,
      'vectant-runtime:local',
      'sleep', '600',
    ]);
    const setup = await record('docker-overlay-setup-as-root', ['exec', '--user', 'root', container, '/bin/bash', '-lc', setupScript]);
    const write = await record('docker-rootless-workspace-write', ['exec', '--user', 'rootless', container, '/bin/bash', '-lc', rootlessWriteScript]);
    const inspect = await record('docker-overlay-inspect', ['exec', '--user', 'root', container, '/bin/bash', '-lc', inspectScript]);
    return {
      ok: true,
      image: 'vectant-runtime:local',
      container,
      baseVolume,
      overlayVolume,
      mountLine: setup.stdout.match(/^.* \/workspace .*$/m)?.[0] || inspect.stdout.match(/^.* \/workspace .*$/m)?.[0] || '',
      rootlessWriteObserved: /after/.test(inspect.stdout),
      baseRemainedBefore: /BASE_APP=before/.test(inspect.stdout),
      mergedChangedAfter: /MERGED_APP=after/.test(inspect.stdout),
      overlayUpperListed: /rootless-proof\.txt/.test(inspect.stdout) && /new\.txt/.test(inspect.stdout),
      steps,
    };
  } finally {
    await docker(['rm', '-f', container]).catch(() => {});
    await docker(['volume', 'rm', baseVolume, overlayVolume]).catch(() => {});
  }
}

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

function renderHtml(proof) {
  const assertions = proof.assertions;
  const passCount = assertions.filter((item) => item.ok).length;
  const cards = [
    ['Host Tests', `${proof.hostTests.filter((test) => test.ok).length}/${proof.hostTests.length}`],
    ['Docker Node Tests', `${proof.dockerNodeTests.filter((test) => test.ok).length}/${proof.dockerNodeTests.length}`],
    ['Live Runtime', proof.dockerOverlaySmoke.ok ? 'PASS' : 'FAIL'],
    ['Assertions', `${passCount}/${assertions.length}`],
  ];
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <title>CodeSite Runtime Overlay Proof</title>
  <style>
    :root { color-scheme: light; font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    body { margin: 0; background: #f5f7f6; color: #17211d; }
    main { width: min(1180px, calc(100vw - 64px)); margin: 0 auto; padding: 42px 0 56px; }
    header { display: grid; grid-template-columns: 1fr auto; gap: 28px; align-items: end; border-bottom: 1px solid #cfd8d3; padding-bottom: 24px; }
    h1 { margin: 0; font-size: 42px; line-height: 1.02; font-weight: 760; letter-spacing: 0; }
    .subtitle { margin: 14px 0 0; max-width: 760px; color: #4c5c55; font-size: 16px; line-height: 1.55; }
    .stamp { border: 1px solid #1f7a4a; color: #0f5f35; background: #e6f7ed; padding: 12px 16px; font-weight: 760; min-width: 118px; text-align: center; }
    .grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; margin: 24px 0; }
    .card { border: 1px solid #ccd6d1; background: #ffffff; padding: 16px; min-height: 86px; }
    .label { color: #5f6d67; font-size: 12px; text-transform: uppercase; letter-spacing: 0.08em; }
    .value { margin-top: 12px; font-size: 28px; line-height: 1; font-weight: 760; }
    section { margin-top: 24px; border: 1px solid #ccd6d1; background: #fff; padding: 20px; }
    h2 { margin: 0 0 14px; font-size: 19px; }
    table { border-collapse: collapse; width: 100%; font-size: 13px; }
    th, td { border-top: 1px solid #e2e8e5; padding: 10px 8px; text-align: left; vertical-align: top; }
    th { color: #53615b; font-size: 11px; text-transform: uppercase; letter-spacing: 0.08em; }
    .ok { color: #0f6b3f; font-weight: 720; }
    .fail { color: #a32d20; font-weight: 720; }
    pre { overflow: auto; white-space: pre-wrap; background: #101815; color: #e9f4ef; padding: 14px; font-size: 12px; line-height: 1.45; }
  </style>
</head>
<body>
  <main>
    <header>
      <div>
        <h1>CodeSite Docker Overlay Runtime Proof</h1>
        <p class="subtitle">Verified ${escapeHtml(proof.generatedAt)}. Active CodeSite runtime sessions require explicit overlay roots, mount a read-only base plus writable overlay, run rootless writes through /workspace, preserve the base repo, and address overlay sessions by explicit runtime identity.</p>
      </div>
      <div class="stamp">${proof.ok ? 'PASS' : 'FAIL'}</div>
    </header>
    <div class="grid">${cards.map(([label, value]) => `<div class="card"><div class="label">${escapeHtml(label)}</div><div class="value">${escapeHtml(value)}</div></div>`).join('')}</div>
    <section>
      <h2>Assertions</h2>
      <table><thead><tr><th>Status</th><th>Assertion</th></tr></thead><tbody>
        ${assertions.map((item) => `<tr><td class="${item.ok ? 'ok' : 'fail'}">${item.ok ? 'PASS' : 'FAIL'}</td><td>${escapeHtml(item.name)}</td></tr>`).join('')}
      </tbody></table>
    </section>
    <section>
      <h2>Focused Tests</h2>
      <table><thead><tr><th>Surface</th><th>Status</th><th>Pass</th><th>Fail</th><th>Command</th></tr></thead><tbody>
        ${[...proof.hostTests, ...proof.dockerNodeTests].map((test) => `<tr><td>${escapeHtml(test.name)}</td><td class="${test.ok ? 'ok' : 'fail'}">${test.ok ? 'PASS' : 'FAIL'}</td><td>${test.tap?.pass || 0}</td><td>${test.tap?.fail || 0}</td><td>${escapeHtml(test.command)}</td></tr>`).join('')}
      </tbody></table>
    </section>
    <section>
      <h2>Live Docker Runtime Boundary</h2>
      <table><tbody>
        <tr><th>Image</th><td>${escapeHtml(proof.dockerOverlaySmoke.image)}</td></tr>
        <tr><th>Mount</th><td>${escapeHtml(proof.dockerOverlaySmoke.mountLine)}</td></tr>
        <tr><th>Rootless Write</th><td class="${proof.dockerOverlaySmoke.rootlessWriteObserved ? 'ok' : 'fail'}">${proof.dockerOverlaySmoke.rootlessWriteObserved ? 'Observed' : 'Missing'}</td></tr>
        <tr><th>Base Preservation</th><td class="${proof.dockerOverlaySmoke.baseRemainedBefore ? 'ok' : 'fail'}">${proof.dockerOverlaySmoke.baseRemainedBefore ? 'Preserved' : 'Changed'}</td></tr>
      </tbody></table>
      <pre>${escapeHtml(proof.dockerOverlaySmoke.steps.map((step) => `# ${step.name}\\n${step.stdout || step.stderr}`).join('\\n\\n'))}</pre>
    </section>
  </main>
</body>
</html>`;
}

async function screenshot(htmlPath, pngPath) {
  const { chromium } = require('@playwright/test');
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1600 }, deviceScaleFactor: 1 });
  await page.goto(pathToFileURL(htmlPath).href);
  await page.screenshot({ path: pngPath, fullPage: true });
  await browser.close();
}

await fs.mkdir(proofRoot, { recursive: true });

const hostTests = [];
for (const file of [
  'backend/collab-server/__tests__/workspaceRuntimeContainer.test.js',
  'backend/collab-server/__tests__/containerPortMonitor.test.js',
  'backend/collab-server/__tests__/codesiteFs.test.js',
  'backend/collab-server/__tests__/terminalRouting.test.js',
]) {
  hostTests.push(await run(`host:${path.basename(file)}`, 'node', ['--test', file]));
}

const dockerNodeTests = [];
for (const file of [
  'backend/collab-server/__tests__/workspaceRuntimeContainer.test.js',
  'backend/collab-server/__tests__/containerPortMonitor.test.js',
]) {
  dockerNodeTests.push(await run(`docker-node:${path.basename(file)}`, 'docker', [
    'run', '--rm',
    '-v', `${repoRoot}:/repo`,
    '-w', '/repo',
    nodeImage,
    'node', '--test', file,
  ]));
}

let dockerOverlaySmoke;
try {
  dockerOverlaySmoke = await runDockerOverlaySmoke();
} catch (error) {
  dockerOverlaySmoke = {
    ok: false,
    image: 'vectant-runtime:local',
    error: error?.message || String(error),
    steps: [],
  };
}

const assertions = [
  { name: 'All host focused tests passed', ok: hostTests.every((test) => test.ok) },
  { name: 'Dockerized Node runtime tests passed', ok: dockerNodeTests.every((test) => test.ok) },
  { name: 'Live Docker overlay smoke passed', ok: Boolean(dockerOverlaySmoke.ok) },
  { name: 'Overlay mount is visible at /workspace', ok: /\/workspace/.test(dockerOverlaySmoke.mountLine || '') },
  { name: 'Rootless user wrote through /workspace', ok: Boolean(dockerOverlaySmoke.rootlessWriteObserved) },
  { name: 'Read-only base repo stayed unchanged', ok: Boolean(dockerOverlaySmoke.baseRemainedBefore) },
  { name: 'Merged view changed after overlay write', ok: Boolean(dockerOverlaySmoke.mergedChangedAfter) },
  { name: 'Overlay upperdir captured rootless changes', ok: Boolean(dockerOverlaySmoke.overlayUpperListed) },
];

const proof = {
  schemaVersion: 'synthi.codesite.runtimeOverlayProof.v1',
  generatedAt: new Date().toISOString(),
  repoRoot,
  nodeImage,
  ok: assertions.every((item) => item.ok),
  assertions,
  hostTests,
  dockerNodeTests,
  dockerOverlaySmoke,
};

await fs.writeFile(proofJsonPath, `${JSON.stringify(proof, null, 2)}\n`);
await fs.writeFile(proofHtmlPath, renderHtml(proof));
await screenshot(proofHtmlPath, proofPngPath);

if (!proof.ok) {
  console.error(JSON.stringify({ ok: false, proofJsonPath, proofHtmlPath, proofPngPath, assertions }, null, 2));
  process.exit(1);
}

console.log(JSON.stringify({ ok: true, proofJsonPath, proofHtmlPath, proofPngPath, assertions }, null, 2));
