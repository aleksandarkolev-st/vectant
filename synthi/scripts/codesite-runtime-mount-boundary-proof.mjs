#!/usr/bin/env node
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { promisify } from 'node:util';
import { chromium } from 'playwright';

const require = createRequire(import.meta.url);
const {
  runtimeContainerName,
  volumeSubpathForPath,
} = require('../../backend/collab-server/workspaceRuntimeContainer.js');

const execFileAsync = promisify(execFile);
const DEFAULT_RUNTIME_IMAGE = 'mcr.microsoft.com/playwright:v1.61.1-noble';

function repoRoot() {
  return path.basename(process.cwd()) === 'synthi'
    ? path.dirname(process.cwd())
    : process.cwd();
}

function proofDir() {
  return path.resolve(process.env.CODESITE_PROOF_OUT_DIR || path.join(repoRoot(), 'tmp', 'codesite-dojo-proof'));
}

function slugNow() {
  return `codesite-runtime-mount-boundary-${Date.now()}`;
}

function digest(value) {
  return `sha256:${crypto.createHash('sha256').update(value).digest('hex')}`;
}

async function digestFile(filePath) {
  return digest(await fs.readFile(filePath));
}

async function pathExists(filePath) {
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
      maxBuffer: 16 * 1024 * 1024,
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

function parseTaggedValue(output, tag) {
  const match = String(output || '').match(new RegExp(`^${tag}=(.*)$`, 'm'));
  return match ? match[1].trim() : '';
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

async function prepareWorkspaces(root, slug) {
  const sourceRoot = path.join(root, 'source');
  const overlayRoot = path.join(root, 'overlay');
  await fs.rm(root, { recursive: true, force: true });
  await fs.mkdir(path.join(sourceRoot, 'src'), { recursive: true });
  await fs.mkdir(path.join(sourceRoot, 'docs'), { recursive: true });
  await fs.writeFile(path.join(sourceRoot, 'src', 'schema.prisma'), [
    'model RuntimeBoundary {',
    '  id String @id',
    '  state String @default("base")',
    '}',
    '',
  ].join('\n'), 'utf8');
  await fs.writeFile(path.join(sourceRoot, 'docs', 'plan.md'), 'base runtime boundary plan\n', 'utf8');
  await fs.cp(sourceRoot, overlayRoot, { recursive: true, dereference: false });
  return { sourceRoot, overlayRoot };
}

async function runDockerMountAttempt({ slug, sourceRoot, overlayRoot }) {
  const image = process.env.CODESITE_PROOF_RUNTIME_IMAGE || DEFAULT_RUNTIME_IMAGE;
  const containerName = `codesite-mount-proof-${crypto.createHash('sha256').update(slug).digest('hex').slice(0, 12)}`;
  const shellScript = [
    'set -u',
    'base_flags="$(awk \'$2 == "/codesite-base" { print $4; exit }\' /proc/mounts)"',
    'workspace_flags="$(awk \'$2 == "/workspace" { print $4; exit }\' /proc/mounts)"',
    'set +e',
    '(printf "base mutation from uninstrumented docker shell\\n" > /codesite-base/src/schema.prisma) 2>/tmp/codesite-base-write.err',
    'base_status=$?',
    'set -e',
    'printf "overlay mutation from uninstrumented docker shell\\n" > /workspace/src/schema.prisma',
    'mkdir -p /workspace/docs',
    'printf "overlay-only new file\\n" > /workspace/docs/overlay-only.md',
    'printf "BASE_WRITE_STATUS=%s\\n" "$base_status"',
    'printf "BASE_MOUNT_FLAGS=%s\\n" "$base_flags"',
    'printf "WORKSPACE_MOUNT_FLAGS=%s\\n" "$workspace_flags"',
    'printf "BASE_WRITE_STDERR_BEGIN\\n"',
    'cat /tmp/codesite-base-write.err || true',
    'printf "\\nBASE_WRITE_STDERR_END\\n"',
    'printf "BASE_CONTENT_BEGIN\\n"',
    'cat /codesite-base/src/schema.prisma',
    'printf "BASE_CONTENT_END\\n"',
    'printf "OVERLAY_CONTENT_BEGIN\\n"',
    'cat /workspace/src/schema.prisma',
    'printf "OVERLAY_CONTENT_END\\n"',
  ].join('\n');
  const result = await run('docker', [
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
    'bash',
    '-lc',
    shellScript,
  ], { cwd: repoRoot() });
  return {
    image,
    containerName,
    ...result,
    baseWriteStatus: Number(parseTaggedValue(result.stdout, 'BASE_WRITE_STATUS')),
    baseMountFlags: parseTaggedValue(result.stdout, 'BASE_MOUNT_FLAGS'),
    workspaceMountFlags: parseTaggedValue(result.stdout, 'WORKSPACE_MOUNT_FLAGS'),
  };
}

function proofHtml(proof) {
  const rows = Object.entries(proof.assertions).map(([key, value]) => `
    <tr><td>${escapeHtml(key)}</td><td>${value ? 'pass' : 'fail'}</td></tr>
  `.trim()).join('\n');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>CodeSite Runtime Mount Boundary Proof</title>
<style>
:root { color-scheme: dark; --bg: #07090f; --panel: #111520; --line: #29324a; --text: #f7f9ff; --muted: #a7b2d6; --pass: #2fd17c; --warn: #ffcf5f; }
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--text); font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; letter-spacing: 0; }
main { width: min(1160px, calc(100vw - 56px)); margin: 28px auto 44px; }
.hero, .card { border: 1px solid var(--line); border-radius: 8px; background: var(--panel); }
.hero { padding: 24px; margin-bottom: 16px; }
.badge { display: inline-flex; height: 24px; align-items: center; padding: 0 9px; border-radius: 4px; background: #09351f; color: #bff8d8; font-size: 12px; font-weight: 800; }
h1 { margin: 8px 0 12px; font-size: 29px; line-height: 1.1; }
p { color: var(--muted); max-width: 82ch; line-height: 1.55; margin: 0; font-size: 16px; }
.grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 12px; margin: 16px 0; }
.card { padding: 14px; min-height: 92px; }
.label { color: var(--muted); font-size: 12px; margin-bottom: 8px; }
.value { overflow-wrap: anywhere; font-size: 15px; line-height: 1.35; }
table, pre { width: 100%; border: 1px solid var(--line); border-radius: 8px; background: #05070c; overflow: hidden; }
table { border-collapse: separate; border-spacing: 0; }
td, th { padding: 11px 13px; border-bottom: 1px solid var(--line); text-align: left; }
th { color: var(--muted); font-size: 12px; text-transform: uppercase; }
tr:last-child td { border-bottom: 0; }
pre { padding: 14px; white-space: pre-wrap; overflow-wrap: anywhere; color: #dce5ff; font: 13px/1.45 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
h2 { font-size: 20px; margin: 22px 0 10px; }
@media (max-width: 860px) { main { width: min(100% - 24px, 720px); } .grid { grid-template-columns: 1fr 1fr; } }
</style>
</head>
<body>
<main>
  <section class="hero">
    <span class="badge">PASS</span>
    <h1>CodeSite Runtime Mount Boundary Proof</h1>
    <p>An uninstrumented Docker shell attempted direct writes against a read-only base mount and a writable quarantine overlay. The base mutation was denied by the mount boundary; only the overlay changed.</p>
  </section>
  <section class="grid">
    <div class="card"><div class="label">Docker image</div><div class="value">${escapeHtml(proof.docker.image)}</div></div>
    <div class="card"><div class="label">Base mount</div><div class="value">/codesite-base ${escapeHtml(proof.docker.baseMountFlags)}</div></div>
    <div class="card"><div class="label">Overlay mount</div><div class="value">/workspace ${escapeHtml(proof.docker.workspaceMountFlags)}</div></div>
    <div class="card"><div class="label">Base write status</div><div class="value">${escapeHtml(proof.docker.baseWriteStatus)}</div></div>
  </section>
  <h2>Assertions</h2>
  <table><thead><tr><th>Check</th><th>Result</th></tr></thead><tbody>${rows}</tbody></table>
  <h2>Digest Evidence</h2>
  <pre>${escapeHtml(JSON.stringify(proof.digests, null, 2))}</pre>
  <h2>Docker Output</h2>
  <pre>${escapeHtml(proof.docker.stdout)}</pre>
  <h2>Product Runtime Contract</h2>
  <pre>${escapeHtml(JSON.stringify(proof.productContract, null, 2))}</pre>
</main>
</body>
</html>`;
}

async function writeProof(proof) {
  const dir = proofDir();
  await fs.mkdir(dir, { recursive: true });
  const jsonPath = path.join(dir, 'codesite-runtime-mount-boundary-proof.json');
  const htmlPath = path.join(dir, 'codesite-runtime-mount-boundary-proof.html');
  const pngPath = path.join(dir, 'codesite-runtime-mount-boundary-proof.png');
  await fs.writeFile(jsonPath, `${JSON.stringify(proof, null, 2)}\n`, 'utf8');
  await fs.writeFile(htmlPath, proofHtml(proof), 'utf8');

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 980 }, deviceScaleFactor: 1 });
  await page.goto(`file://${htmlPath}`, { waitUntil: 'networkidle' });
  await page.screenshot({ path: pngPath, fullPage: true });
  await browser.close();
  return { jsonPath, htmlPath, pngPath };
}

async function main() {
  const slug = process.env.CODESITE_PROOF_WORKSPACE_SLUG || slugNow();
  const root = path.join(proofDir(), 'runtime-mount-boundary', slug);
  const { sourceRoot, overlayRoot } = await prepareWorkspaces(root, slug);
  const baseFile = path.join(sourceRoot, 'src', 'schema.prisma');
  const overlayFile = path.join(overlayRoot, 'src', 'schema.prisma');
  const overlayNewFile = path.join(overlayRoot, 'docs', 'overlay-only.md');
  const baseNewFile = path.join(sourceRoot, 'docs', 'overlay-only.md');
  const baseDigestBefore = await digestFile(baseFile);
  const overlayDigestBefore = await digestFile(overlayFile);
  const docker = await runDockerMountAttempt({ slug, sourceRoot, overlayRoot });
  const baseDigestAfter = await digestFile(baseFile);
  const overlayDigestAfter = await digestFile(overlayFile);
  const overlayContent = await fs.readFile(overlayFile, 'utf8');
  const baseContent = await fs.readFile(baseFile, 'utf8');
  const assertions = {
    dockerContainerExecuted: docker.exitCode === 0,
    baseMountAdvertisedReadOnly: docker.baseMountFlags.split(',').includes('ro'),
    overlayMountAdvertisedWritable: docker.workspaceMountFlags.split(',').includes('rw'),
    uninstrumentedBaseWriteDenied: docker.baseWriteStatus !== 0,
    baseDigestUnchanged: baseDigestBefore === baseDigestAfter,
    baseContentUnchanged: baseContent.includes('state String @default("base")'),
    overlayDigestChanged: overlayDigestBefore !== overlayDigestAfter,
    overlayMutationObserved: overlayContent === 'overlay mutation from uninstrumented docker shell\n',
    overlayNewFileCreated: await pathExists(overlayNewFile),
    baseNewFileAbsent: !(await pathExists(baseNewFile)),
  };
  const failed = Object.entries(assertions).filter(([, ok]) => ok !== true);
  const proof = {
    schemaVersion: 'synthi.codesite.runtimeMountBoundaryProof.v1',
    status: failed.length ? 'failed' : 'validated',
    generatedAt: new Date().toISOString(),
    slug,
    workspaces: {
      sourceRoot,
      overlayRoot,
    },
    docker,
    productContract: {
      readonlyRuntimeName: runtimeContainerName(slug, 'proof-user', { codeSiteReadonly: true }),
      quarantineRuntimeName: runtimeContainerName(slug, 'proof-user', {
        codesiteContext: { active: true, transactionId: 'txn-proof' },
        codeSiteQuarantineRoot: overlayRoot,
        codeSiteQuarantineId: overlayRoot,
      }),
      quarantineVolumeSubpath: volumeSubpathForPath(overlayRoot, path.dirname(root)),
      runtimeModes: {
        base: 'read-only mount',
        activeCodeSite: 'writable quarantine overlay mounted at /workspace',
      },
    },
    digests: {
      baseDigestBefore,
      baseDigestAfter,
      overlayDigestBefore,
      overlayDigestAfter,
    },
    assertions,
    failedAssertions: failed.map(([key]) => key),
  };
  const artifacts = await writeProof(proof);
  if (failed.length) {
    throw new Error(`runtime mount boundary proof failed: ${failed.map(([key]) => key).join(', ')}`);
  }
  console.log(JSON.stringify({ ...artifacts, assertions }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
