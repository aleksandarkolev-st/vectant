import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { spawn, execFile } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { promisify } from 'node:util';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const {
  createCodeSiteOverlayWorkspace,
  finalizeCodeSiteQuarantineWorkspace,
  codeSiteRuntimeEnv,
} = require('../backend/collab-server/codesiteFs');
const { codeSiteTerminalLaunchMode } = require('../backend/collab-server/terminalRouting');
const { codeSiteProgramRuntimeLaunchMode } = require('../backend/collab-server/runtimePodTerminal');
const { createRuntimeManager } = require('../backend/collab-server/workspaceRuntimeContainer');
const collabRequire = createRequire(new URL('../backend/collab-server/package.json', import.meta.url));

const repoRoot = path.resolve(new URL('..', import.meta.url).pathname);
const proofDir = path.join(repoRoot, 'tmp', 'codesite-dojo-proof');
const runRoot = path.join('/tmp', 'codesitefs-runtime-boundary-proof', `${Date.now()}-${randomUUID().slice(0, 8)}`);
const runtimeImage = process.env.CODESITEFS_BOUNDARY_DOCKER_IMAGE || process.env.RUNTIME_IMAGE || 'vectant-runtime:local';
const runtimeNetwork = process.env.CODESITEFS_BOUNDARY_DOCKER_NETWORK || process.env.WORKER_NETWORK || 'synthi-ide_default';
const execFileAsync = promisify(execFile);

function sha256(text) {
  return `sha256:${createHash('sha256').update(String(text)).digest('hex')}`;
}

function assertProof(value, message) {
  if (!value) throw new Error(message);
}

async function readText(filePath) {
  return fs.readFile(filePath, 'utf8');
}

async function fileExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function createDockerClient() {
  try {
    const Docker = collabRequire('dockerode');
    return {
      client: new Docker({ socketPath: process.env.DOCKER_SOCKET_PATH || process.env.DOCKER_SOCKET || '/var/run/docker.sock' }),
      driver: 'dockerode',
    };
  } catch (error) {
    if (error?.code !== 'MODULE_NOT_FOUND') throw error;
    return {
      client: createDockerCliClient(),
      driver: 'docker-cli',
    };
  }
}

function createDockerCliClient() {
  async function dockerJson(args) {
    const { stdout } = await execFileAsync('docker', args, { maxBuffer: 20 * 1024 * 1024 });
    return JSON.parse(stdout);
  }

  async function inspect(id) {
    let items;
    try {
      items = await dockerJson(['inspect', id]);
    } catch (error) {
      if (/no such object|no such container/i.test(`${error.stderr || ''}${error.message || ''}`)) {
        const notFound = new Error('no such container');
        notFound.statusCode = 404;
        throw notFound;
      }
      throw error;
    }
    const info = items[0];
    if (!info) {
      const error = new Error('no such container');
      error.statusCode = 404;
      throw error;
    }
    return info;
  }

  function containerHandle(idOrName) {
    return {
      id: idOrName,
      inspect: () => inspect(idOrName),
      start: async () => {
        await execFileAsync('docker', ['start', idOrName]);
      },
      stop: async ({ t = 5 } = {}) => {
        await execFileAsync('docker', ['stop', '-t', String(t), idOrName]).catch((error) => {
          if (!/No such container|is not running/i.test(`${error.stderr || ''}${error.message || ''}`)) throw error;
        });
      },
      remove: async ({ force = false } = {}) => {
        await execFileAsync('docker', ['rm', ...(force ? ['-f'] : []), idOrName]).catch((error) => {
          if (!/No such container/i.test(`${error.stderr || ''}${error.message || ''}`)) throw error;
        });
      },
      exec: async (opts = {}) => createDockerCliExec(idOrName, opts),
    };
  }

  return {
    createContainer: async (opts = {}) => {
      const args = ['create'];
      if (opts.name) args.push('--name', opts.name);
      if (opts.HostConfig?.Privileged) args.push('--privileged');
      if (opts.HostConfig?.NetworkMode) args.push('--network', opts.HostConfig.NetworkMode);
      for (const [key, value] of Object.entries(opts.Labels || {})) {
        args.push('--label', `${key}=${value}`);
      }
      for (const env of opts.Env || []) {
        args.push('-e', env);
      }
      for (const bind of opts.HostConfig?.Binds || []) {
        args.push('-v', bind);
      }
      for (const mount of opts.HostConfig?.Mounts || []) {
        if (mount.Type === 'volume') {
          const parts = [`type=volume`, `source=${mount.Source}`, `target=${mount.Target}`];
          if (mount.ReadOnly) parts.push('readonly');
          if (mount.VolumeOptions?.Subpath) parts.push(`volume-subpath=${mount.VolumeOptions.Subpath}`);
          args.push('--mount', parts.join(','));
        }
      }
      args.push(opts.Image);
      const { stdout } = await execFileAsync('docker', args, { maxBuffer: 20 * 1024 * 1024 });
      return containerHandle(stdout.trim());
    },
    getContainer: (id) => containerHandle(id),
  };
}

function createDockerCliExec(containerId, opts = {}) {
  let child = null;
  let exitCode = null;
  return {
    start: async () => {
      const args = ['exec'];
      if (opts.Tty) args.push('-t');
      if (opts.AttachStdin) args.push('-i');
      if (opts.WorkingDir) args.push('-w', opts.WorkingDir);
      if (opts.User) args.push('-u', opts.User);
      for (const env of opts.Env || []) args.push('-e', env);
      args.push(containerId, ...opts.Cmd);
      child = spawn('docker', args, { stdio: ['pipe', 'pipe', 'pipe'] });
      const stream = new EventEmitter();
      stream.write = (data) => child.stdin.write(data);
      stream.end = () => {
        try { child.stdin.end(); } catch (_) {}
      };
      child.stdout.on('data', (chunk) => stream.emit('data', chunk));
      child.stderr.on('data', (chunk) => stream.emit('data', chunk));
      child.on('error', (error) => stream.emit('error', error));
      child.on('close', (code) => {
        exitCode = code;
        stream.emit('end');
      });
      return stream;
    },
    inspect: async () => ({ ExitCode: exitCode }),
    resize: async () => {},
  };
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
<p>Product runtime manager created real Docker runtime containers whose /workspace mounts were CodeSite quarantine overlays. Raw writes changed only quarantine copies, preserved the source repo, and finalized as write_quarantined evidence.</p>
</section>
<section class="grid">
<div class="card"><div class="label">Runtime image</div><div class="value">${escapeHtml(proof.runtime.image)}</div></div>
<div class="card"><div class="label">Runtime network</div><div class="value">${escapeHtml(proof.runtime.network)}</div></div>
<div class="card"><div class="label">Transaction</div><div class="value">${escapeHtml(proof.context.transactionId)}</div></div>
<div class="card"><div class="label">Source repo</div><div class="value">${escapeHtml(proof.sourceRoot)}</div></div>
</section>
<section class="card">
<h2>Manager-created runtime containers</h2>
<table><thead><tr><th>Overlay</th><th>Container</th><th>Read-only base</th><th>Writable overlay</th><th>Mode label</th><th>Writable</th></tr></thead><tbody>
${proof.overlays.map((overlay) => `<tr><td>${escapeHtml(overlay.label)}</td><td>${escapeHtml(overlay.runtime.name)}</td><td>${escapeHtml(overlay.mount.baseSource)}</td><td>${escapeHtml(overlay.mount.overlaySource)}</td><td>${escapeHtml(overlay.inspect.labels['vectant/codesite-workspace-mode'])}</td><td>${escapeHtml(overlay.command.workspaceWritable)}</td></tr>`).join('')}
</tbody></table>
</section>
<section class="card">
<h2>Repo preservation</h2>
<table><thead><tr><th>Path</th><th>Source repo after runtime writes</th><th>Quarantine change</th></tr></thead><tbody>
${proof.repoChecks.map((check) => `<tr><td>${escapeHtml(check.path)}</td><td>${escapeHtml(check.realRepoAfter)}</td><td>${escapeHtml(check.quarantineKind)}</td></tr>`).join('')}
</tbody></table>
</section>
<section class="card">
<h2>Recorded boundary events</h2>
<table><thead><tr><th>Overlay</th><th>Path</th><th>Event</th><th>Reason</th><th>Evidence</th></tr></thead><tbody>
${proof.recordedEvents.map((event) => `<tr><td>${escapeHtml(event.overlay)}</td><td>${escapeHtml(event.path)}</td><td>${escapeHtml(event.type)}</td><td>${escapeHtml(event.reasonCodes.join(', '))}</td><td>${escapeHtml(event.evidenceRef)}</td></tr>`).join('')}
</tbody></table>
</section>
<section class="card">
<h2>Runtime-pod gate</h2>
<table><thead><tr><th>Surface</th><th>Launch mode</th></tr></thead><tbody>
<tr><td>Terminal runtime pod without overlay</td><td>${escapeHtml(proof.productPath.sysboxTerminalNoHybridLaunchMode)}</td></tr>
<tr><td>Program runtime pod without overlay</td><td>${escapeHtml(proof.productPath.sysboxProgramNoHybridLaunchMode)}</td></tr>
<tr><td>Terminal runtime pod with overlay</td><td>${escapeHtml(proof.productPath.sysboxTerminalWithHybridLaunchMode)}</td></tr>
<tr><td>Program runtime pod with overlay</td><td>${escapeHtml(proof.productPath.sysboxProgramWithHybridLaunchMode)}</td></tr>
<tr><td>Hybrid container runtime</td><td>${escapeHtml(proof.productPath.hybridProgramLaunchMode)}</td></tr>
</tbody></table>
</section>
<section class="card"><h2>Assertions</h2><pre>${escapeHtml(JSON.stringify(proof.assertions, null, 2))}</pre></section>
<section class="card"><h2>Runtime output</h2><pre>${escapeHtml(proof.overlays.map((overlay) => `${overlay.label}\n${overlay.command.output}`).join('\n\n'))}</pre></section>
</main>
</body>
</html>`, 'utf8');
}

async function screenshot(htmlPath, pngPath) {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 1000 }, deviceScaleFactor: 1 });
  await page.goto(`file://${htmlPath}`, { waitUntil: 'load' });
  await page.screenshot({ path: pngPath, fullPage: true });
  await browser.close();
}

function waitForRuntimeExit(handle, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    let output = '';
    const timer = setTimeout(() => {
      try { handle?.ptyProcess?.kill?.(); } catch (_) {}
      reject(new Error(`runtime exec timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    handle.ptyProcess.onData((chunk) => {
      output += chunk;
    });
    handle.ptyProcess.onExit(({ exitCode }) => {
      clearTimeout(timer);
      resolve({ output, exitCode });
    });
  });
}

async function runManagerCommand(manager, context, runtimeOptions, label) {
  const command = [
    'set -eu',
    'printf "pwd=%s\\n" "$(pwd)"',
    'printf "whoami=%s\\n" "$(id -un)"',
    'test -w /workspace',
    'printf "workspaceWritable=yes\\n"',
    'mkdir -p src api/auth',
    `printf 'overlay app from manager ${label}\\n' > src/app.js`,
    `printf 'raw auth bypass attempt ${label}\\n' > api/auth/signup.ts`,
    `printf 'runtime wrote only to quarantine ${label}\\n' > runtime.out`,
    'printf "readbackApp="; cat src/app.js',
    'printf "readbackAuth="; cat api/auth/signup.ts',
    'printf "readbackRuntime="; cat runtime.out',
  ].join('\n');
  const handle = await manager.execInRuntime(context.workspaceSlug, context.effectiveUserId, {
    command,
    tty: false,
    env: codeSiteRuntimeEnv(context, ['workspace-runtime-container', 'execInRuntime', label]),
    ...runtimeOptions,
  });
  const result = await waitForRuntimeExit(handle);
  return {
    ...result,
    workspaceWritable: /workspaceWritable=yes/.test(result.output) ? 'yes' : 'no',
  };
}

async function inspectRuntimeContainer(docker, containerId) {
  const info = await docker.getContainer(containerId).inspect();
  const workspaceMount = (info.Mounts || []).find((mount) => mount.Destination === '/workspace' || mount.Target === '/workspace') || null;
  const codeSiteBaseMount = (info.Mounts || []).find((mount) => mount.Destination === '/codesite/base' || mount.Target === '/codesite/base') || null;
  const codeSiteOverlayMount = (info.Mounts || []).find((mount) => mount.Destination === '/codesite/overlay' || mount.Target === '/codesite/overlay') || null;
  return {
    id: info.Id,
    name: String(info.Name || '').replace(/^\//, ''),
    image: info.Config?.Image || '',
    labels: info.Config?.Labels || {},
    env: info.Config?.Env || [],
    hostConfig: {
      binds: info.HostConfig?.Binds || [],
      networkMode: info.HostConfig?.NetworkMode || '',
      privileged: Boolean(info.HostConfig?.Privileged),
    },
    mounts: info.Mounts || [],
    workspaceMount,
    codeSiteBaseMount,
    codeSiteOverlayMount,
  };
}

function mountSource(inspect) {
  return inspect.workspaceMount?.Source
    || inspect.workspaceMount?.Name
    || inspect.hostConfig.binds.find((bind) => bind.includes(':/workspace'))?.split(':/workspace')[0]
    || '';
}

function runtimeOptionsForOverlay(context, overlay) {
  return {
    codesiteContext: context,
    codeSiteBaseRoot: overlay.baseRoot || overlay.originalCwd,
    codeSiteOverlayRoot: overlay.root,
    codeSiteOverlayUpperRoot: overlay.upperRoot,
    codeSiteOverlayWorkRoot: overlay.workRoot,
    codeSiteOverlayId: overlay.overlayId || overlay.quarantineId,
  };
}

async function createProofOverlay({ manager, docker, context, sourceRoot, quarantineBase, label, writesSuffix }) {
  const quarantine = await createCodeSiteOverlayWorkspace(context, sourceRoot, {
    baseDir: quarantineBase,
    operation: `runtime-container-${label}`,
  });
  const runtimeOptions = runtimeOptionsForOverlay(context, quarantine);
  const runtime = await manager.ensureRuntimeContainer(context.workspaceSlug, context.effectiveUserId, runtimeOptions);
  const inspect = await inspectRuntimeContainer(docker, runtime.containerId);
  const command = await runManagerCommand(manager, context, runtimeOptions, writesSuffix);
  assertProof(command.exitCode === 0, `${label} runtime command failed with exit ${command.exitCode}: ${command.output}`);
  const finalized = await finalizeCodeSiteQuarantineWorkspace(context, quarantine, {
    fetch: context.fetch,
    cleanup: false,
    resetBaseline: true,
    tool: 'runtime_container_terminal',
  });
  return {
    label,
    quarantine,
    runtime,
    inspect,
    mount: {
      workspaceSource: mountSource(inspect),
      baseSource: inspect.codeSiteBaseMount?.Source || inspect.codeSiteBaseMount?.Name || '',
      baseReadOnly: inspect.codeSiteBaseMount?.RW === false || inspect.codeSiteBaseMount?.ReadOnly === true,
      overlaySource: inspect.codeSiteOverlayMount?.Source || inspect.codeSiteOverlayMount?.Name || '',
      overlayWritable: inspect.codeSiteOverlayMount?.RW === true || inspect.codeSiteOverlayMount?.ReadOnly === false,
    },
    command,
    finalized,
  };
}

async function main() {
  await fs.mkdir(proofDir, { recursive: true });
  const sourceRoot = path.join(runRoot, 'repo');
  const quarantineBase = path.join(runRoot, 'quarantine');
  await fs.mkdir(path.join(sourceRoot, 'src'), { recursive: true });
  await fs.mkdir(path.join(sourceRoot, 'api', 'auth'), { recursive: true });
  await fs.writeFile(path.join(sourceRoot, 'src', 'app.js'), 'real repo app before\n', 'utf8');
  await fs.writeFile(path.join(sourceRoot, 'api', 'auth', 'signup.ts'), 'real repo auth before\n', 'utf8');

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
    blockedPaths: ['api/auth/**', 'runtime-boundary/**'],
    processAncestry: ['workspace-runtime-container', 'execInRuntime', 'raw-write'],
    evidenceRefs: ['proof:codesitefs-runtime-boundary'],
    controlPlaneUrl: 'http://app.test/api/workspace/codesitefs-runtime-boundary/codesite',
    controlPlaneTrusted: true,
    fetch,
  };
  const dockerRuntime = createDockerClient();
  const docker = dockerRuntime.client;
  const manager = createRuntimeManager({
    docker,
    image: runtimeImage,
    network: runtimeNetwork,
    dataVolume: '',
    logger: console,
  });
  const overlays = [];
  try {
    overlays.push(await createProofOverlay({
      manager,
      docker,
      context,
      sourceRoot,
      quarantineBase,
      label: 'overlay-a',
      writesSuffix: 'overlay-a',
    }));
    overlays.push(await createProofOverlay({
      manager,
      docker,
      context,
      sourceRoot,
      quarantineBase,
      label: 'overlay-b',
      writesSuffix: 'overlay-b',
    }));
  } finally {
    for (const overlay of overlays) {
      await manager.teardown(
        context.workspaceSlug,
        context.effectiveUserId,
        runtimeOptionsForOverlay(context, overlay.quarantine),
      ).catch(() => {});
    }
  }

  const realApp = await readText(path.join(sourceRoot, 'src', 'app.js'));
  const realAuth = await readText(path.join(sourceRoot, 'api', 'auth', 'signup.ts'));
  const runtimeOutExists = await fileExists(path.join(sourceRoot, 'runtime.out'));
  const recordedEvents = recordedBodies.map((body) => ({
    overlay: overlays.find((overlay) => body.codesiteFsEvent?.details?.quarantine_id === overlay.quarantine.quarantineId)?.label || 'unknown',
    path: body.path,
    type: body.codesiteFsEvent?.type,
    reasonCodes: body.codesiteFsEvent?.details?.reason_codes || [],
    evidenceRef: body.codesiteFsEvent?.details?.quarantine_evidence?.evidenceRef || '',
    quarantineRoot: body.codesiteFsEvent?.details?.quarantine_root || '',
    originalCwd: body.codesiteFsEvent?.details?.original_cwd || '',
    processAncestry: body.codesiteFsEvent?.details?.process_ancestry || [],
  })).sort((a, b) => `${a.overlay}:${a.path}`.localeCompare(`${b.overlay}:${b.path}`));
  const productPath = {
    hybridProgramLaunchMode: codeSiteProgramRuntimeLaunchMode({
      codeSiteContext: context,
      runtimeType: 'container',
      sysboxEnabled: false,
      hasHybrid: true,
    }),
    sysboxProgramNoHybridLaunchMode: codeSiteProgramRuntimeLaunchMode({
      codeSiteContext: context,
      runtimeType: 'container',
      sysboxEnabled: true,
      hasHybrid: false,
    }),
    sysboxProgramWithHybridLaunchMode: codeSiteProgramRuntimeLaunchMode({
      codeSiteContext: context,
      runtimeType: 'container',
      sysboxEnabled: true,
      hasHybrid: true,
    }),
    sysboxTerminalNoHybridLaunchMode: codeSiteTerminalLaunchMode({
      codeSiteContext: context,
      usesRuntimePodTerminal: true,
      enableContainerRuntime: false,
      workspaceRuntime: null,
      workspaceSlug: context.workspaceSlug,
    }),
    sysboxTerminalWithHybridLaunchMode: codeSiteTerminalLaunchMode({
      codeSiteContext: context,
      usesRuntimePodTerminal: true,
      enableContainerRuntime: true,
      workspaceRuntime: manager,
      workspaceSlug: context.workspaceSlug,
    }),
  };
  const overlayA = overlays[0];
  const overlayB = overlays[1];
  const repoChecks = [
    {
      path: 'src/app.js',
      realRepoAfter: realApp.trim(),
      quarantineKind: overlayA.finalized.changes.find((change) => change.path === 'src/app.js')?.kind || 'missing',
    },
    {
      path: 'api/auth/signup.ts',
      realRepoAfter: realAuth.trim(),
      quarantineKind: overlayA.finalized.changes.find((change) => change.path === 'api/auth/signup.ts')?.kind || 'missing',
    },
    {
      path: 'runtime.out',
      realRepoAfter: runtimeOutExists ? 'unexpectedly present' : 'missing from real repo',
      quarantineKind: overlayA.finalized.changes.find((change) => change.path === 'runtime.out')?.kind || 'missing',
    },
  ];
  const assertions = {
    managerCreatedTwoRuntimeContainers: overlays.length === 2 && overlays.every((overlay) => overlay.runtime.containerId),
    sameTransactionOverlaysUseDistinctRuntimeContainers: overlayA.runtime.name !== overlayB.runtime.name && overlayA.runtime.containerId !== overlayB.runtime.containerId,
    runtimeMountsReadOnlyBaseAndWritableOverlay: overlays.every((overlay) =>
      overlay.mount.baseSource === overlay.quarantine.baseRoot
      && overlay.mount.baseReadOnly === true
      && overlay.mount.overlaySource === overlay.quarantine.root
      && overlay.mount.overlayWritable === true),
    runtimeContainersDeclareOverlayMode: overlays.every((overlay) =>
      overlay.inspect.labels['vectant/codesite-workspace-mode'] === 'codesite-overlay'
      && overlay.inspect.labels['vectant/codesite-transaction-id'] === context.transactionId
      && overlay.inspect.labels['vectant/codesite-base-readonly'] === 'true'
      && overlay.inspect.env.includes('CODESITE_WORKSPACE_OVERLAY=1')),
    runtimeWorkspaceWritable: overlays.every((overlay) => overlay.command.workspaceWritable === 'yes'),
    realRepoAllowedFileUnchanged: realApp === 'real repo app before\n',
    realRepoBlockedFileUnchanged: realAuth === 'real repo auth before\n',
    runtimeOutNeverCreatedInRealRepo: runtimeOutExists === false,
    runtimeContainerChangedOnlyQuarantine: overlayA.finalized.changes.some((change) => change.path === 'src/app.js')
      && overlayA.finalized.changes.some((change) => change.path === 'api/auth/signup.ts')
      && overlayA.finalized.changes.some((change) => change.path === 'runtime.out'),
    blockedPathRecordedAsQuarantined: recordedEvents.some((event) =>
      event.path === 'api/auth/signup.ts'
      && event.type === 'write_quarantined'
      && event.reasonCodes.includes('raw_terminal_quarantine')),
    processTreeProvenanceRecorded: recordedEvents.every((event) =>
      event.processAncestry.includes('workspace-runtime-container')
      && event.processAncestry.includes('raw-write')),
    durableEvidenceRefsCreated: recordedEvents.every((event) => event.evidenceRef.startsWith('codesitefs:quarantine:sha256:')),
    runtimePodWithoutManagedMountFailsClosed: productPath.sysboxTerminalNoHybridLaunchMode === 'block-runtime'
      && productPath.sysboxProgramNoHybridLaunchMode === 'block-runtime',
    runtimePodWithHybridFallsBackToQuarantineRuntime: productPath.sysboxTerminalWithHybridLaunchMode === 'overlay-runtime'
      && productPath.sysboxProgramWithHybridLaunchMode === 'overlay-runtime',
    hybridContainerRuntimeRoutesToQuarantine: productPath.hybridProgramLaunchMode === 'overlay-runtime',
  };
  for (const [key, value] of Object.entries(assertions)) {
    assertProof(value === true, `assertion failed: ${key}`);
  }

  const proof = {
    generatedAt: new Date().toISOString(),
    sourceRoot,
    runRoot,
    context: {
      ...context,
      fetch: '[proof-local-fetch]',
    },
    runtime: {
      image: runtimeImage,
      network: runtimeNetwork,
      dockerDriver: dockerRuntime.driver,
    },
    overlays: overlays.map((overlay) => ({
      label: overlay.label,
      quarantine: {
        quarantineId: overlay.quarantine.quarantineId,
        overlayId: overlay.quarantine.overlayId,
        root: overlay.quarantine.root,
        baseRoot: overlay.quarantine.baseRoot,
        upperRoot: overlay.quarantine.upperRoot,
        workRoot: overlay.quarantine.workRoot,
        originalCwd: overlay.quarantine.originalCwd,
        manifestPath: overlay.quarantine.manifestPath,
        digest: sha256(overlay.quarantine.root),
      },
      runtime: overlay.runtime,
      inspect: overlay.inspect,
      mount: overlay.mount,
      command: overlay.command,
      finalized: overlay.finalized,
    })),
    recordedEvents,
    productPath,
    repoChecks,
    assertions,
  };

  const jsonPath = path.join(proofDir, 'codesitefs-runtime-boundary-proof.json');
  const htmlPath = path.join(proofDir, 'codesitefs-runtime-boundary-proof.html');
  const pngPath = path.join(proofDir, 'codesitefs-runtime-boundary-proof.png');
  await fs.writeFile(jsonPath, `${JSON.stringify(proof, null, 2)}\n`, 'utf8');
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
