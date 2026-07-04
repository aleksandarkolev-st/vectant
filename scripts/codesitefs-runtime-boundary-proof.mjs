import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { chromium } from 'playwright';

const require = createRequire(import.meta.url);
const {
  createCodeSiteQuarantineWorkspace,
  finalizeCodeSiteQuarantineWorkspace,
} = require('../backend/collab-server/codesiteFs');
const { codeSiteTerminalLaunchMode } = require('../backend/collab-server/terminalRouting');
const { runtimeContainerName } = require('../backend/collab-server/workspaceRuntimeContainer');

const repoRoot = path.resolve(new URL('..', import.meta.url).pathname);
const proofDir = path.join(repoRoot, 'tmp', 'codesite-dojo-proof');
const runRoot = path.join('/tmp', 'codesitefs-runtime-boundary-proof', `${Date.now()}-${randomUUID().slice(0, 8)}`);
const dockerImage = process.env.CODESITEFS_BOUNDARY_DOCKER_IMAGE || 'node:22-bookworm';

function sha256(text) {
  return `sha256:${createHash('sha256').update(String(text)).digest('hex')}`;
}

function assertProof(value, message) {
  if (!value) throw new Error(message);
}

async function readText(filePath) {
  return fs.readFile(filePath, 'utf8');
}

async function writeProofHtml(proof, htmlPath) {
  await fs.writeFile(htmlPath, `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>CodeSiteFS Runtime Boundary Proof</title>
<style>
:root{color-scheme:dark;font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:#080a0e;color:#f5f7fb}
body{margin:0;padding:28px;background:#080a0e}
main{max-width:1180px;margin:0 auto;display:grid;gap:18px}
.hero,.card{border:1px solid #293246;border-radius:8px;background:#10151f;padding:18px}
.pass{display:inline-block;border-radius:6px;background:#123b27;color:#9df2bd;padding:4px 8px;font-size:12px;font-weight:700}
h1{font-size:25px;margin:8px 0 6px;letter-spacing:0}
h2{font-size:16px;margin:0 0 10px;letter-spacing:0}
p{margin:0;color:#afbad0;line-height:1.5}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(250px,1fr));gap:12px}
.label{font-size:12px;color:#98a2b8}
.value{margin-top:6px;font-size:14px;overflow-wrap:anywhere}
table{width:100%;border-collapse:collapse;font-size:13px}
td,th{border-top:1px solid #293246;padding:8px;text-align:left;vertical-align:top}
th{color:#afbad0;font-weight:600}
pre{white-space:pre-wrap;border:1px solid #293246;border-radius:8px;background:#05060a;padding:14px;color:#cbd3e7;font-size:12px;overflow-wrap:anywhere}
</style>
</head>
<body>
<main>
<section class="hero">
<span class="pass">PASS</span>
<h1>CodeSiteFS Runtime Boundary Proof</h1>
<p>Real Docker container attempted raw workspace writes. CodeSiteFS mounted a writable quarantine overlay, preserved the real repo, and recorded write_quarantined evidence for every changed path.</p>
</section>
<section class="grid">
<div class="card"><div class="label">Docker image</div><div class="value">${escapeHtml(proof.docker.image)}</div></div>
<div class="card"><div class="label">Container</div><div class="value">${escapeHtml(proof.docker.containerName)}</div></div>
<div class="card"><div class="label">Transaction</div><div class="value">${escapeHtml(proof.context.transactionId)}</div></div>
<div class="card"><div class="label">Quarantine root</div><div class="value">${escapeHtml(proof.quarantine.root)}</div></div>
</section>
<section class="card">
<h2>Repo Preservation</h2>
<table><thead><tr><th>Path</th><th>Real repo after raw Docker write</th><th>Quarantine change</th></tr></thead><tbody>
${proof.repoChecks.map((check) => `<tr><td>${escapeHtml(check.path)}</td><td>${escapeHtml(check.realRepoAfter)}</td><td>${escapeHtml(check.quarantineKind)}</td></tr>`).join('')}
</tbody></table>
</section>
<section class="card">
<h2>Recorded Boundary Events</h2>
<table><thead><tr><th>Path</th><th>Event</th><th>Reason</th><th>Evidence</th></tr></thead><tbody>
${proof.recordedEvents.map((event) => `<tr><td>${escapeHtml(event.path)}</td><td>${escapeHtml(event.type)}</td><td>${escapeHtml(event.reasonCodes.join(', '))}</td><td>${escapeHtml(event.evidenceRef)}</td></tr>`).join('')}
</tbody></table>
</section>
<section class="card">
<h2>Product Runtime Contract</h2>
<table><thead><tr><th>Check</th><th>Value</th></tr></thead><tbody>
<tr><td>Container terminal launch mode</td><td>${escapeHtml(proof.productPath.containerLaunchMode)}</td></tr>
<tr><td>Sysbox terminal launch mode</td><td>${escapeHtml(proof.productPath.sysboxLaunchMode)}</td></tr>
<tr><td>Overlay A runtime container</td><td>${escapeHtml(proof.productPath.overlayAContainer)}</td></tr>
<tr><td>Overlay B runtime container</td><td>${escapeHtml(proof.productPath.overlayBContainer)}</td></tr>
</tbody></table>
</section>
<section class="card"><h2>Assertions</h2><pre>${escapeHtml(JSON.stringify(proof.assertions, null, 2))}</pre></section>
<section class="card"><h2>Docker Command</h2><pre>${escapeHtml(proof.docker.command.join(' '))}</pre></section>
</main>
</body>
</html>`);
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

async function screenshot(htmlPath, pngPath) {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 1000 }, deviceScaleFactor: 1 });
  await page.goto(`file://${htmlPath}`, { waitUntil: 'load' });
  await page.screenshot({ path: pngPath, fullPage: true });
  await browser.close();
}

async function main() {
  await fs.mkdir(proofDir, { recursive: true });
  const sourceRoot = path.join(runRoot, 'repo');
  const quarantineBase = path.join(runRoot, 'quarantine');
  await fs.mkdir(quarantineBase, { recursive: true });
  await fs.mkdir(path.join(sourceRoot, 'src'), { recursive: true });
  await fs.mkdir(path.join(sourceRoot, 'api', 'auth'), { recursive: true });
  await fs.writeFile(path.join(sourceRoot, 'src', 'app.js'), 'real repo app before\n');
  await fs.writeFile(path.join(sourceRoot, 'api', 'auth', 'signup.ts'), 'real repo auth before\n');

  const recordedBodies = [];
  const fetch = async (_url, options) => {
    const body = JSON.parse(options.body);
    recordedBodies.push(body);
    return new Response(JSON.stringify({
      ok: false,
      quarantined: true,
      policyDecision: { reasonCodes: ['raw_terminal_quarantine'] },
    }), { status: 200 });
  };
  const context = {
    active: true,
    workspaceSlug: 'codesitefs-runtime-boundary',
    transactionId: `txn-${Date.now()}`,
    mutationLeaseId: 'lease-runtime-boundary',
    displayCallsign: 'RUNTIME-RAW-01',
    actorUserId: 'agent-user',
    effectiveUserId: 'workspace-user',
    allowedPaths: ['src/**'],
    blockedPaths: ['api/auth/**'],
    processAncestry: ['docker-container', 'sh', 'raw-write'],
    evidenceRefs: ['proof:codesitefs-runtime-boundary'],
    controlPlaneUrl: 'http://app.test/api/workspace/codesitefs-runtime-boundary/codesite',
  };

  const quarantine = await createCodeSiteQuarantineWorkspace(context, sourceRoot, {
    baseDir: quarantineBase,
    operation: 'runtime-container-terminal',
  });
  const containerName = `codesitefs-boundary-${Date.now()}`;
  const dockerScript = [
    'set -eu',
    'mkdir -p src api/auth',
    "printf 'overlay app from raw docker\\n' > src/app.js",
    "printf 'raw auth bypass attempt\\n' > api/auth/signup.ts",
    "printf 'runtime wrote only to quarantine\\n' > runtime.out",
  ].join('\n');
  const dockerCommand = [
    'docker', 'run', '--rm',
    '--name', containerName,
    '-v', `${quarantine.root}:/workspace`,
    '-w', '/workspace',
    dockerImage,
    'sh', '-lc', dockerScript,
  ];
  execFileSync(dockerCommand[0], dockerCommand.slice(1), { stdio: 'pipe' });

  const result = await finalizeCodeSiteQuarantineWorkspace(context, quarantine, {
    fetch,
    cleanup: false,
    tool: 'runtime_container_terminal',
  });

  const realApp = await readText(path.join(sourceRoot, 'src', 'app.js'));
  const realAuth = await readText(path.join(sourceRoot, 'api', 'auth', 'signup.ts'));
  const changedPaths = result.changes.map((change) => change.path).sort();
  const recordedEvents = recordedBodies.map((body) => ({
    path: body.path,
    type: body.codesiteFsEvent?.type,
    reasonCodes: body.codesiteFsEvent?.details?.reason_codes || [],
    evidenceRef: body.codesiteFsEvent?.details?.quarantine_evidence?.evidenceRef || '',
    processAncestry: body.codesiteFsEvent?.details?.process_ancestry || [],
  })).sort((a, b) => a.path.localeCompare(b.path));
  const productPath = {
    containerLaunchMode: codeSiteTerminalLaunchMode({
      codeSiteContext: context,
      enableContainerRuntime: true,
      workspaceRuntime: {},
      workspaceSlug: context.workspaceSlug,
    }),
    sysboxLaunchMode: codeSiteTerminalLaunchMode({
      codeSiteContext: context,
      usesRuntimePodTerminal: true,
      enableContainerRuntime: true,
      workspaceRuntime: {},
      workspaceSlug: context.workspaceSlug,
    }),
    overlayAContainer: runtimeContainerName(context.workspaceSlug, 'workspace-user', {
      codesiteContext: context,
      codeSiteQuarantineRoot: '/tmp/codesitefs-runtime-boundary-proof/overlay-a',
      codeSiteQuarantineId: '/tmp/codesitefs-runtime-boundary-proof/overlay-a',
    }),
    overlayBContainer: runtimeContainerName(context.workspaceSlug, 'workspace-user', {
      codesiteContext: context,
      codeSiteQuarantineRoot: '/tmp/codesitefs-runtime-boundary-proof/overlay-b',
      codeSiteQuarantineId: '/tmp/codesitefs-runtime-boundary-proof/overlay-b',
    }),
  };

  const assertions = {
    containerTerminalRoutesToQuarantineRuntime: productPath.containerLaunchMode === 'quarantine-runtime',
    sysboxTerminalStillBlocksWithoutMountStrategy: productPath.sysboxLaunchMode === 'block-runtime',
    sameTransactionOverlaysUseDistinctRuntimeContainers: productPath.overlayAContainer !== productPath.overlayBContainer,
    realRepoAllowedFileUnchanged: realApp === 'real repo app before\n',
    realRepoBlockedFileUnchanged: realAuth === 'real repo auth before\n',
    runtimeContainerChangedOnlyQuarantine: changedPaths.includes('src/app.js')
      && changedPaths.includes('api/auth/signup.ts')
      && changedPaths.includes('runtime.out'),
    blockedPathRecordedAsQuarantined: recordedEvents.some((event) =>
      event.path === 'api/auth/signup.ts'
      && event.type === 'write_quarantined'
      && event.reasonCodes.includes('raw_terminal_quarantine')),
    processTreeProvenanceRecorded: recordedEvents.every((event) =>
      event.processAncestry.includes('docker-container')
      && event.processAncestry.includes('raw-write')),
    durableEvidenceRefsCreated: recordedEvents.every((event) => event.evidenceRef.startsWith('codesitefs:quarantine:sha256:')),
  };
  for (const [key, value] of Object.entries(assertions)) {
    assertProof(value === true, `assertion failed: ${key}`);
  }

  const proof = {
    generatedAt: new Date().toISOString(),
    context,
    docker: {
      image: dockerImage,
      containerName,
      command: dockerCommand,
    },
    quarantine: {
      root: quarantine.root,
      originalCwd: quarantine.originalCwd,
      digest: sha256(quarantine.root),
    },
    changes: result.changes,
    recordedEvents,
    productPath,
    repoChecks: [
      {
        path: 'src/app.js',
        realRepoAfter: realApp.trim(),
        quarantineKind: result.changes.find((change) => change.path === 'src/app.js')?.kind || 'missing',
      },
      {
        path: 'api/auth/signup.ts',
        realRepoAfter: realAuth.trim(),
        quarantineKind: result.changes.find((change) => change.path === 'api/auth/signup.ts')?.kind || 'missing',
      },
      {
        path: 'runtime.out',
        realRepoAfter: 'missing from real repo',
        quarantineKind: result.changes.find((change) => change.path === 'runtime.out')?.kind || 'missing',
      },
    ],
    assertions,
  };

  const jsonPath = path.join(proofDir, 'codesitefs-runtime-boundary-proof.json');
  const htmlPath = path.join(proofDir, 'codesitefs-runtime-boundary-proof.html');
  const pngPath = path.join(proofDir, 'codesitefs-runtime-boundary-proof.png');
  await fs.writeFile(jsonPath, `${JSON.stringify(proof, null, 2)}\n`);
  await writeProofHtml(proof, htmlPath);
  await screenshot(htmlPath, pngPath);

  console.log(JSON.stringify({
    ok: true,
    jsonPath: path.relative(repoRoot, jsonPath),
    htmlPath: path.relative(repoRoot, htmlPath),
    pngPath: path.relative(repoRoot, pngPath),
    assertions,
  }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
