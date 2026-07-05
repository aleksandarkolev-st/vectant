#!/usr/bin/env node
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const require = createRequire(import.meta.url);
const {
  runtimeContainerName,
  volumeSubpathForPath,
} = require('../../backend/collab-server/workspaceRuntimeContainer.js');
const {
  createCodeSiteHostWriteSentinel,
} = require('../../backend/collab-server/codesiteHostWriteSentinel.js');

const execFileAsync = promisify(execFile);
const DEFAULT_IMAGE = 'node:20-bookworm';
const DEFAULT_SCREENSHOT_IMAGE = 'mcr.microsoft.com/playwright:v1.60.0-noble';

function repoRoot() {
  return path.basename(process.cwd()) === 'synthi'
    ? path.dirname(process.cwd())
    : process.cwd();
}

function proofRoot() {
  return path.resolve(process.env.CODESITE_PROOF_OUT_DIR || path.join(repoRoot(), 'tmp', 'codesite-dojo-proof'));
}

function slugNow() {
  return `codesite-unmanaged-host-boundary-${Date.now()}`;
}

function sha256(value) {
  return `sha256:${crypto.createHash('sha256').update(value).digest('hex')}`;
}

async function digestFile(filePath) {
  return sha256(await fs.readFile(filePath));
}

async function exists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function run(command, args, options = {}) {
  try {
    const result = await execFileAsync(command, args, {
      maxBuffer: 32 * 1024 * 1024,
      windowsHide: true,
      ...options,
    });
    return {
      exitCode: 0,
      stdout: String(result.stdout || ''),
      stderr: String(result.stderr || ''),
    };
  } catch (error) {
    return {
      exitCode: typeof error.code === 'number' ? error.code : 1,
      stdout: String(error.stdout || ''),
      stderr: String(error.stderr || error.message || ''),
    };
  }
}

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

async function prepareSourceAndOverlay(root) {
  const sourceRoot = path.join(root, 'source');
  const overlayRoot = path.join(root, 'overlay');
  await fs.rm(root, { recursive: true, force: true });
  await fs.mkdir(path.join(sourceRoot, 'src'), { recursive: true });
  await fs.mkdir(path.join(sourceRoot, 'api', 'auth'), { recursive: true });
  await fs.writeFile(path.join(sourceRoot, 'src', 'app.js'), 'export const base = "unchanged";\n', 'utf8');
  await fs.writeFile(path.join(sourceRoot, 'api', 'auth', 'signup.ts'), 'export const signup = "base";\n', 'utf8');
  await fs.writeFile(path.join(sourceRoot, 'package.json'), `${JSON.stringify({ name: 'codesite-boundary-proof', version: '1.0.0' }, null, 2)}\n`, 'utf8');
  await fs.cp(sourceRoot, overlayRoot, { recursive: true, dereference: false });
  return { sourceRoot, overlayRoot };
}

async function captureDeniedWrite(fn) {
  try {
    await fn();
    return { denied: false, code: null, message: null };
  } catch (error) {
    return {
      denied: ['EACCES', 'EPERM', 'EROFS'].includes(error?.code),
      code: error?.code || null,
      message: error?.message || String(error),
    };
  }
}

async function runHostPrewriteGuardProbe({ root, slug }) {
  const sourceBase = path.resolve(
    process.env.CODESITE_HOST_PREWRITE_GUARD_SOURCE_ROOT ||
    path.join(os.tmpdir(), 'codesite-unmanaged-host-prewrite', slug),
  );
  const sourceRoot = path.join(sourceBase, 'source');
  const sentinelRoot = path.join(root, 'host-prewrite-sentinel');
  const appPath = path.join(sourceRoot, 'src', 'app.js');
  const roguePath = path.join(sourceRoot, 'src', 'rogue.js');
  await fs.rm(sourceBase, { recursive: true, force: true });
  await fs.rm(sentinelRoot, { recursive: true, force: true });
  await fs.mkdir(path.dirname(appPath), { recursive: true });
  await fs.writeFile(appPath, 'export const prewrite = "base";\n', 'utf8');
  const before = {
    app: await digestFile(appPath),
    rogueExists: await exists(roguePath),
  };
  const sentinel = createCodeSiteHostWriteSentinel({
    repoRoot: sourceRoot,
    baseDir: sentinelRoot,
    sentinelId: `prewrite-${slug}`,
    prewriteGuard: true,
    codeSiteContext: {
      active: true,
      workspaceSlug: slug,
      transactionId: 'txn-unmanaged-host-boundary-prewrite',
      mutationLeaseId: 'lease-unmanaged-host-boundary-prewrite',
      agentSessionId: 'agent-unmanaged-host-boundary-prewrite',
      displayCallsign: 'HOST-PREWRITE',
      processAncestry: ['codesite-proof', 'unmanaged-host-boundary'],
    },
    fetch: async () => new Response(JSON.stringify({ ok: true }), { status: 200 }),
  });

  let started = null;
  let scan = null;
  let stopped = null;
  try {
    started = await sentinel.start({ watch: false, reason: 'unmanaged_host_boundary_prewrite_probe' });
    const overwrite = await captureDeniedWrite(() => (
      fs.writeFile(appPath, 'export const prewrite = "rogue";\n', 'utf8')
    ));
    const create = await captureDeniedWrite(() => (
      fs.writeFile(roguePath, 'export const rogue = true;\n', 'utf8')
    ));
    const afterDenied = {
      app: await digestFile(appPath),
      rogueExists: await exists(roguePath),
    };
    scan = await sentinel.scanNow({ reason: 'prewrite_guard_audit' });
    const manifest = JSON.parse(await fs.readFile(scan.manifestPath, 'utf8'));
    stopped = await sentinel.stop();
    const postStopWrite = await captureDeniedWrite(() => (
      fs.writeFile(appPath, 'export const prewrite = "post-stop-write-ok";\n', 'utf8')
    ));
    return {
      sourceRoot,
      sourceBase,
      sentinelRoot,
      started,
      stopped,
      attempts: { overwrite, create, postStopWrite },
      before,
      afterDenied,
      scan: {
        ok: scan.ok,
        quarantinedCount: scan.quarantined.length,
        manifestPath: scan.manifestPath,
      },
      manifest: {
        status: manifest.status,
        reason: manifest.reason,
        prewriteBoundary: manifest.prewriteBoundary,
      },
    };
  } finally {
    if (!stopped) await sentinel.stop();
  }
}

function dockerProbeScript() {
  return `
const fs = require('fs');
const cp = require('child_process');
function mountFlags(target) {
  const mounts = fs.readFileSync('/proc/mounts', 'utf8').split('\\n');
  const row = mounts.find((line) => line.split(' ')[1] === target);
  return row ? row.split(' ')[3] : '';
}
function attempt(name, fn) {
  try {
    fn();
    return { name, ok: true, status: 0 };
  } catch (error) {
    return {
      name,
      ok: false,
      status: typeof error.status === 'number' ? error.status : 1,
      code: error.code || null,
      message: String(error.message || ''),
      stderr: String(error.stderr || ''),
    };
  }
}
const attempts = [
  attempt('node_write_existing_base', () => fs.writeFileSync('/codesite-base/src/app.js', 'rogue node write\\n')),
  attempt('shell_redirect_existing_base', () => cp.execFileSync('bash', ['-lc', 'printf "rogue shell redirect\\\\n" > /codesite-base/api/auth/signup.ts'])),
  attempt('mkdir_base', () => fs.mkdirSync('/codesite-base/generated', { recursive: true })),
  attempt('append_package_base', () => fs.appendFileSync('/codesite-base/package.json', '\\n"rogue": true\\n')),
  attempt('node_write_overlay', () => fs.writeFileSync('/workspace/src/app.js', 'overlay node write\\n')),
  attempt('shell_redirect_overlay', () => cp.execFileSync('bash', ['-lc', 'printf "overlay shell redirect\\\\n" > /workspace/api/auth/signup.ts'])),
  attempt('mkdir_overlay', () => fs.mkdirSync('/workspace/generated', { recursive: true })),
  attempt('append_overlay_package', () => fs.appendFileSync('/workspace/package.json', '\\n{"overlay":true}\\n')),
];
fs.writeFileSync('/workspace/generated/overlay-only.txt', 'overlay-only artifact\\n');
console.log(JSON.stringify({
  mounts: {
    base: mountFlags('/codesite-base'),
    workspace: mountFlags('/workspace'),
  },
  attempts,
}, null, 2));
`;
}

async function runUnmanagedDockerProbe({ sourceRoot, overlayRoot, slug }) {
  const image = process.env.CODESITE_UNMANAGED_HOST_BOUNDARY_IMAGE || process.env.CODESITE_PROOF_RUNTIME_IMAGE || DEFAULT_IMAGE;
  const containerName = `codesite-unmanaged-boundary-${crypto.createHash('sha256').update(slug).digest('hex').slice(0, 12)}`;
  const args = [
    'run',
    '--rm',
    '--name',
    containerName,
    '-v',
    `${sourceRoot}:/codesite-base:ro`,
    '-v',
    `${overlayRoot}:/workspace`,
    '--workdir',
    '/workspace',
    image,
    'node',
    '-e',
    dockerProbeScript(),
  ];
  const result = await run('docker', args, { cwd: repoRoot() });
  let parsed = null;
  try {
    parsed = JSON.parse(result.stdout);
  } catch (error) {
    parsed = { parseError: error?.message || 'docker_probe_json_parse_failed' };
  }
  return {
    image,
    containerName,
    command: `docker ${args.map((arg) => (/\s/.test(arg) ? JSON.stringify(arg) : arg)).join(' ')}`,
    ...result,
    parsed,
  };
}

function renderHtml(proof) {
  const assertionRows = Object.entries(proof.assertions).map(([name, ok]) => `
    <tr><td><span class="${ok ? 'ok' : 'bad'}">${ok ? 'PASS' : 'FAIL'}</span></td><td>${escapeHtml(name)}</td></tr>
  `).join('');
  const prewriteRows = Object.entries(proof.hostPrewriteGuard?.attempts || {}).map(([name, attempt]) => `
    <tr>
      <td>${escapeHtml(name)}</td>
      <td><span class="${attempt.denied ? 'bad' : 'ok'}">${attempt.denied ? 'denied' : 'allowed'}</span></td>
      <td><code>${escapeHtml(attempt.code || '')}</code></td>
      <td><code>${escapeHtml((attempt.message || '').slice(0, 260))}</code></td>
    </tr>
  `).join('');
  const attemptRows = proof.docker.parsed?.attempts?.map((attempt) => `
    <tr>
      <td>${escapeHtml(attempt.name)}</td>
      <td><span class="${attempt.ok ? 'ok' : 'bad'}">${attempt.ok ? 'allowed' : 'denied'}</span></td>
      <td><code>${escapeHtml(attempt.code || attempt.status || '')}</code></td>
      <td><code>${escapeHtml((attempt.stderr || attempt.message || '').slice(0, 260))}</code></td>
    </tr>
  `).join('') || '';
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>CodeSite Unmanaged Host Boundary Proof</title>
<style>
:root{color-scheme:dark;--bg:#07090f;--panel:#111823;--line:#30384a;--text:#f6f8ff;--muted:#aab5c9;--pass:#9df2bd;--fail:#ffc1c1}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;letter-spacing:0}
main{width:min(1180px,calc(100vw - 48px));margin:28px auto 44px;display:grid;gap:16px}
.hero,.card{border:1px solid var(--line);background:var(--panel);border-radius:8px;padding:18px}.hero{display:grid;grid-template-columns:1fr auto;gap:18px;align-items:start}
.badge{display:inline-flex;align-items:center;height:25px;border-radius:5px;padding:0 10px;background:#113c28;color:var(--pass);font-size:12px;font-weight:850}
h1{font-size:30px;line-height:1.08;margin:8px 0 10px}h2{font-size:16px;margin:0 0 10px}p{margin:0;color:var(--muted);line-height:1.55;max-width:88ch}
.grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:10px}.metric{border:1px solid var(--line);border-radius:8px;background:#0b1018;padding:12px;min-width:0}
.label{font-size:12px;color:var(--muted)}.value{margin-top:7px;font-size:15px;font-weight:750;overflow-wrap:anywhere}
table{width:100%;border-collapse:collapse;table-layout:fixed;font-size:13px}th,td{border-top:1px solid var(--line);padding:9px;text-align:left;vertical-align:top}th{color:var(--muted);font-size:12px}
code{font-family:"SFMono-Regular",Consolas,monospace;font-size:12px;overflow-wrap:anywhere;color:#dce5f8}.ok{color:var(--pass);font-weight:850}.bad{color:var(--fail);font-weight:850}
pre{white-space:pre-wrap;overflow-wrap:anywhere;margin:0;border:1px solid var(--line);border-radius:8px;background:#05070c;padding:12px;color:#dce5f8;font-size:12px}
@media(max-width:860px){main{width:min(100% - 24px,720px)}.hero{grid-template-columns:1fr}.grid{grid-template-columns:1fr 1fr}h1{font-size:25px}}
</style>
</head>
<body>
<main>
  <section class="hero">
    <div>
      <span class="badge">${proof.ok ? 'PASS' : 'FAIL'}</span>
      <h1>CodeSite Unmanaged Host Boundary Proof</h1>
      <p>Unmanaged Node and shell writes were denied before real-tree mutation by the host prewrite guard, then attempted again against a read-only Docker base with a writable transaction overlay. This proves the mature sealed-base boundary without relying on polling restoration.</p>
    </div>
    <span class="badge">${escapeHtml(proof.boundary.mode)}</span>
  </section>
  <section class="grid">
    <div class="metric"><div class="label">Docker image</div><div class="value">${escapeHtml(proof.docker.image)}</div></div>
    <div class="metric"><div class="label">Base flags</div><div class="value">${escapeHtml(proof.docker.parsed?.mounts?.base || '')}</div></div>
    <div class="metric"><div class="label">Overlay flags</div><div class="value">${escapeHtml(proof.docker.parsed?.mounts?.workspace || '')}</div></div>
    <div class="metric"><div class="label">Denied base writes</div><div class="value">${proof.summary.deniedBaseWrites}/${proof.summary.baseWriteAttempts}</div></div>
  </section>
  <section class="card"><h2>Assertions</h2><table><tbody>${assertionRows}</tbody></table></section>
  <section class="card"><h2>Host Prewrite Guard</h2><table><thead><tr><th>Attempt</th><th>Disposition</th><th>Code</th><th>Evidence</th></tr></thead><tbody>${prewriteRows}</tbody></table><pre>${escapeHtml(JSON.stringify(proof.hostPrewriteGuard?.manifest?.prewriteBoundary || {}, null, 2))}</pre></section>
  <section class="card"><h2>Raw Process Attempts</h2><table><thead><tr><th>Attempt</th><th>Disposition</th><th>Code</th><th>Evidence</th></tr></thead><tbody>${attemptRows}</tbody></table></section>
  <section class="card"><h2>Digest Evidence</h2><pre>${escapeHtml(JSON.stringify(proof.digests, null, 2))}</pre></section>
  <section class="card"><h2>Product Runtime Contract</h2><pre>${escapeHtml(JSON.stringify(proof.productRuntimeContract, null, 2))}</pre></section>
</main>
</body>
</html>`;
}

async function writeArtifacts(proof) {
  const root = proofRoot();
  await fs.mkdir(root, { recursive: true });
  const jsonPath = path.join(root, 'codesite-unmanaged-host-boundary-proof.json');
  const htmlPath = path.join(root, 'codesite-unmanaged-host-boundary-proof.html');
  const pngPath = path.join(root, 'codesite-unmanaged-host-boundary-proof.png');
  await fs.writeFile(jsonPath, `${JSON.stringify(proof, null, 2)}\n`, 'utf8');
  await fs.writeFile(htmlPath, renderHtml(proof).replace(/[ \t]+$/gm, ''), 'utf8');
  await screenshotHtmlWithDocker({ htmlPath, pngPath });
  return { jsonPath, htmlPath, pngPath };
}

async function screenshotHtmlWithDocker({ htmlPath, pngPath }) {
  const root = repoRoot();
  const htmlContainerPath = path.posix.join('/workspace', path.relative(root, htmlPath).split(path.sep).join('/'));
  const pngContainerPath = path.posix.join('/workspace', path.relative(root, pngPath).split(path.sep).join('/'));
  const image = process.env.CODESITE_PROOF_SCREENSHOT_IMAGE || DEFAULT_SCREENSHOT_IMAGE;
  const script = `
const { chromium } = require('playwright');
(async () => {
  const htmlPath = process.argv[1];
  const pngPath = process.argv[2];
  const browser = await chromium.launch({
    headless: true,
    chromiumSandbox: false,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 980 }, deviceScaleFactor: 1 });
    await page.goto('file://' + htmlPath, { waitUntil: 'load' });
    await page.screenshot({ path: pngPath, fullPage: true });
  } finally {
    await browser.close();
  }
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
`;
  const result = await run('docker', [
    'run',
    '--rm',
    '-v',
    `${root}:/workspace`,
    '-w',
    '/workspace',
    image,
    'node',
    '-e',
    script,
    htmlContainerPath,
    pngContainerPath,
  ], { cwd: root });
  if (result.exitCode !== 0) {
    throw new Error(`codesite_unmanaged_boundary_screenshot_failed:${result.stderr || result.stdout}`);
  }
}

async function main() {
  const slug = process.env.CODESITE_PROOF_WORKSPACE_SLUG || slugNow();
  const runRoot = path.join(proofRoot(), 'unmanaged-host-boundary', slug);
  const { sourceRoot, overlayRoot } = await prepareSourceAndOverlay(runRoot);
  const hostPrewriteGuard = await runHostPrewriteGuardProbe({ root: runRoot, slug });
  const trackedFiles = [
    'src/app.js',
    'api/auth/signup.ts',
    'package.json',
  ];
  const before = Object.fromEntries(await Promise.all(
    trackedFiles.map(async (file) => [file, await digestFile(path.join(sourceRoot, file))]),
  ));
  const overlayBefore = Object.fromEntries(await Promise.all(
    trackedFiles.map(async (file) => [file, await digestFile(path.join(overlayRoot, file))]),
  ));
  const docker = await runUnmanagedDockerProbe({ sourceRoot, overlayRoot, slug });
  const after = Object.fromEntries(await Promise.all(
    trackedFiles.map(async (file) => [file, await digestFile(path.join(sourceRoot, file))]),
  ));
  const overlayAfter = Object.fromEntries(await Promise.all(
    trackedFiles.map(async (file) => [file, await digestFile(path.join(overlayRoot, file))]),
  ));
  const attempts = docker.parsed?.attempts || [];
  const baseAttempts = attempts.filter((attempt) => attempt.name.endsWith('_base'));
  const overlayAttempts = attempts.filter((attempt) => attempt.name.includes('_overlay'));
  const baseMountFlags = String(docker.parsed?.mounts?.base || '').split(',');
  const overlayMountFlags = String(docker.parsed?.mounts?.workspace || '').split(',');
  const assertions = {
    hostPrewriteGuardArmed: hostPrewriteGuard.started?.prewriteBoundary?.active === true
      && hostPrewriteGuard.started?.prewriteBoundary?.enforcedBeforeMutation === true,
    hostPrewriteExistingWriteDenied: hostPrewriteGuard.attempts.overwrite.denied === true,
    hostPrewriteCreateDenied: hostPrewriteGuard.attempts.create.denied === true,
    hostPrewriteRealTreeUnchanged: hostPrewriteGuard.before.app === hostPrewriteGuard.afterDenied.app
      && hostPrewriteGuard.afterDenied.rogueExists === false,
    hostPrewriteNoPostWriteQuarantineNeeded: hostPrewriteGuard.scan.ok === true
      && hostPrewriteGuard.scan.quarantinedCount === 0,
    hostPrewriteGuardRestoredPermissions: hostPrewriteGuard.stopped?.prewriteBoundary?.active === false
      && hostPrewriteGuard.attempts.postStopWrite.denied === false,
    dockerProcessExecuted: docker.exitCode === 0 && !docker.parsed?.parseError,
    sourceMountedReadOnly: baseMountFlags.includes('ro'),
    overlayMountedWritable: overlayMountFlags.includes('rw'),
    everyBaseAttemptDenied: baseAttempts.length === 4 && baseAttempts.every((attempt) => attempt.ok === false),
    everyOverlayAttemptAllowed: overlayAttempts.length === 4 && overlayAttempts.every((attempt) => attempt.ok === true),
    sourceDigestsUnchanged: trackedFiles.every((file) => before[file] === after[file]),
    overlayDigestsChanged: trackedFiles.every((file) => overlayBefore[file] !== overlayAfter[file]),
    sourceGeneratedDirAbsent: !(await exists(path.join(sourceRoot, 'generated'))),
    overlayGeneratedDirPresent: await exists(path.join(overlayRoot, 'generated')),
    overlayOnlyArtifactPresent: await exists(path.join(overlayRoot, 'generated', 'overlay-only.txt')),
  };
  const failedAssertions = Object.entries(assertions).filter(([, ok]) => ok !== true).map(([name]) => name);
  const proof = {
    schemaVersion: 'synthi.codesite.unmanagedHostBoundaryProof.v1',
    ok: failedAssertions.length === 0,
    status: failedAssertions.length === 0 ? 'validated' : 'failed',
    generatedAt: new Date().toISOString(),
    slug,
    boundary: {
      mode: 'host_prewrite_guard_plus_read_only_real_tree_with_writable_transaction_overlay',
      claim: 'Unmanaged writes are denied before real-tree mutation by a host prewrite guard, and runtime writes target a sealed base mount whose writable changes land only in transaction overlay/quarantine.',
      notSatisfiedBy: 'post_write_polling_restore',
    },
    workspaces: {
      sourceRoot,
      overlayRoot,
    },
    summary: {
      hostPrewriteDeniedWrites: [
        hostPrewriteGuard.attempts.overwrite,
        hostPrewriteGuard.attempts.create,
      ].filter((attempt) => attempt.denied).length,
      baseWriteAttempts: baseAttempts.length,
      deniedBaseWrites: baseAttempts.filter((attempt) => attempt.ok === false).length,
      overlayWriteAttempts: overlayAttempts.length,
      allowedOverlayWrites: overlayAttempts.filter((attempt) => attempt.ok === true).length,
    },
    hostPrewriteGuard,
    docker,
    productRuntimeContract: {
      activeHostShellPolicy: 'deny unmanaged host writes with prewrite guard or block host shell',
      activeRuntimePolicy: 'mount read-only base plus writable overlay/quarantine',
      prewriteBoundary: hostPrewriteGuard.manifest.prewriteBoundary,
      readonlyRuntimeName: runtimeContainerName(slug, 'proof-user', { codeSiteReadonly: true }),
      activeOverlayRuntimeName: runtimeContainerName(slug, 'proof-user', {
        codesiteContext: { active: true, transactionId: 'txn-unmanaged-host-boundary' },
        codeSiteQuarantineRoot: overlayRoot,
        codeSiteQuarantineId: overlayRoot,
      }),
      overlayVolumeSubpath: volumeSubpathForPath(overlayRoot, path.dirname(runRoot)),
    },
    digests: {
      sourceBefore: before,
      sourceAfter: after,
      overlayBefore,
      overlayAfter,
    },
    assertions,
    failedAssertions,
    commands: [{
      name: 'hostPrewriteGuardProbe',
      command: 'node codesite-unmanaged-host-boundary-proof.mjs <prewrite-guard-probe>',
      runner: 'node',
      exitCode: assertions.hostPrewriteExistingWriteDenied && assertions.hostPrewriteCreateDenied ? 0 : 1,
      summary: {
        deniedWritesBeforeMutation: [
          hostPrewriteGuard.attempts.overwrite,
          hostPrewriteGuard.attempts.create,
        ].filter((attempt) => attempt.denied).length,
        quarantinedAfterScan: hostPrewriteGuard.scan.quarantinedCount,
      },
    }, {
      name: 'unmanagedDockerWriteProbe',
      command: `docker run --rm -v <source>:/codesite-base:ro -v <overlay>:/workspace ${docker.image} node <unmanaged-write-probe>`,
      runner: 'docker',
      exitCode: docker.exitCode,
      summary: {
        image: docker.image,
        deniedBaseWrites: baseAttempts.filter((attempt) => attempt.ok === false).length,
        allowedOverlayWrites: overlayAttempts.filter((attempt) => attempt.ok === true).length,
      },
    }],
  };
  const artifacts = await writeArtifacts(proof);
  if (!proof.ok) {
    throw new Error(`codesite_unmanaged_host_boundary_failed:${failedAssertions.join(',')}`);
  }
  console.log(JSON.stringify({
    ok: true,
    artifacts,
    summary: proof.summary,
    assertions: proof.assertions,
  }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
