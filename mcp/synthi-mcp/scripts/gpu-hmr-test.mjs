#!/usr/bin/env node
// Synthi GPU-HMR test harness — executes docs/GPU_HMR_ULTRAPLAN.md §9.
//
// Models its plumbing on scripts/live-test.mjs (workspace seeding via
// frontend + collab-server, file batches with syncToGcs, stage/commit,
// MCP JSON-RPC over stdio) and adds GPU-specific phases P0–P3.
//
// Forward-compatible: today's main has no GPU plumbing, so every per-phase
// row will record as WARN/skipped. As Phase 0/1/2/3 of the plan land, rows
// flip to PASS without script changes. The wire/seed checks pass today.
//
// Run:
//   cd mcp/synthi-mcp
//   pnpm build
//   SYNTHI_GPU_HMR=1 node scripts/gpu-hmr-test.mjs
//   SYNTHI_GPU_HMR=1 SYNTHI_GPU_HMR_FIXTURE=flow ONLY_PHASES=FLOW node scripts/gpu-hmr-test.mjs
//
// Env (see docs §12.2 for the full table):
//   FRONTEND_URL                 http://localhost:3000
//   COLLAB_URL                   http://localhost:1234
//   SIGNALING_URL                ws://localhost:9000
//   AI_ENGINE_URL                http://localhost:8000
//   WORKER_LOG_PATH              <repo>/backend/synthi-webrtc-compiler/.run/worker.log
//   SLUG                         gpu-hmr-<ts>
//   SYNTHI_GPU_VENDOR            auto | cuda | rocm | both       (default auto)
//   SYNTHI_GPU_ARCH              optional target arch override (e.g. sm_80, sm_120, gfx1201)
//   SYNTHI_GPU_FAST_SWAP_BUDGET_MS 300
//   SYNTHI_GPU_LAUNCH_WATCHDOG_MS  5000
//   SYNTHI_GPU_DRAIN_TIMEOUT_MS    2000
//   SYNTHI_GPU_HIP_FAKE_RUNTIME  unset (set to ask worker to load HIP-CPU)
//   SYNTHI_GPU_WAIT_HMR_TIMEOUT_MS  5000 (terminal wait cap after MCP compile)
//   SKIP_PHASES                  comma-separated phase ids
//   ONLY_PHASES                  comma-separated phase ids
//   HMR_TIMEOUT_MS               60000
//   MCP_ENTRY                    ../dist/index.js
//   MCP_TRANSPORT                docker | host
//   MCP_CONTAINER                synthi-ide-mcp-1 (auto-detected from compose if absent/stale)
//   MCP_SIGNALING_URL            ws://signaling-server:9000 (docker transport)
//   SYNTHI_GPU_USE_MCP           1 (set 0 to use direct AI endpoint probe only)
//   SYNTHI_GPU_HMR_FIXTURE       vector | flow  (FLOW phase auto-selects flow)
//   GOOGLE_API_KEY               (only needed if MCP attach is exercised)

import { spawn, execFile } from 'node:child_process';
import { readFile, writeFile, mkdir, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { createValidationWorkspace } from './lib/validation-workspace.mjs';
import {
  classifyGpuHmrDispatchProof,
  classifyGpuHmrOutputProof,
  summarizeGpuHmrDispatchProof,
  summarizeGpuHmrOutputProof,
} from './lib/gpu-hmr-runtime-proof.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ───────────────────────── config ─────────────────────────

const CFG = {
  frontendUrl: process.env.FRONTEND_URL ?? 'http://localhost:3000',
  collabUrl: process.env.COLLAB_URL ?? 'http://localhost:1234',
  signalingUrl: process.env.SIGNALING_URL ?? 'ws://localhost:9000',
  aiEngineUrl: process.env.AI_ENGINE_URL ?? 'http://localhost:8000',
  workerLogPath: process.env.WORKER_LOG_PATH
    ?? path.resolve(__dirname, '../../../backend/synthi-webrtc-compiler/.run/worker.log'),
  slug: process.env.SLUG ?? `gpu-hmr-${Date.now()}`,
  hostId: process.env.HOST_ID ?? 'gpu-hmr-test',
  workspaceName: process.env.WORKSPACE_NAME ?? 'Synthi GPU-HMR Test',
  gpuHmr: (process.env.SYNTHI_GPU_HMR ?? '0') === '1',
  vendor: (process.env.SYNTHI_GPU_VENDOR ?? 'auto').toLowerCase(),
  gpuArch: process.env.SYNTHI_GPU_ARCH,
  fastSwapBudgetMs: Number(process.env.SYNTHI_GPU_FAST_SWAP_BUDGET_MS ?? 300),
  watchdogMs: Number(process.env.SYNTHI_GPU_LAUNCH_WATCHDOG_MS ?? 5000),
  drainTimeoutMs: Number(process.env.SYNTHI_GPU_DRAIN_TIMEOUT_MS ?? 2000),
  snapshotBudgetMs: Number(process.env.SYNTHI_GPU_SNAPSHOT_BUDGET_MS ?? 250),
  hipFakeRuntime: process.env.SYNTHI_GPU_HIP_FAKE_RUNTIME === '1',
  hmrTimeoutMs: Number(process.env.HMR_TIMEOUT_MS ?? 60000),
  hmrWaitTimeoutMs: Number(process.env.SYNTHI_GPU_WAIT_HMR_TIMEOUT_MS ?? 5000),
  mcpEntry: path.resolve(__dirname, process.env.MCP_ENTRY ?? '../dist/index.js'),
  mcpTransport: (process.env.MCP_TRANSPORT ?? 'docker').toLowerCase(),
  mcpContainer: process.env.MCP_CONTAINER ?? 'synthi-ide-mcp-1',
  mcpSignalingUrl: process.env.MCP_SIGNALING_URL ?? 'ws://signaling-server:9000',
  mcpRequestTimeoutMs: Number(process.env.MCP_REQUEST_TIMEOUT_MS ?? 90000),
  mcpAttachTimeoutMs: Number(process.env.MCP_ATTACH_TIMEOUT_MS ?? 30000),
  mcpPrometheusPort: process.env.MCP_PROMETHEUS_PORT,
  workerContainer: process.env.WORKER_CONTAINER ?? 'synthi-ide-worker-1',
  googleApiKey: process.env.GOOGLE_API_KEY ?? '',
  geminiModel: process.env.SYNTHI_GEMINI_MODEL ?? 'gemini-3-flash-preview',
  mcpVisionBackend: process.env.SYNTHI_MCP_VISION_BACKEND
    ?? ((process.env.GOOGLE_API_KEY ?? '') ? 'gemini_api' : 'agent_side'),
  useMcpCompile: (process.env.SYNTHI_GPU_USE_MCP ?? '1') !== '0',
  directAiFallback: process.env.SYNTHI_GPU_DIRECT_AI_FALLBACK === '1',
  skipPhases: new Set((process.env.SKIP_PHASES ?? '').split(',').map((s) => s.trim()).filter(Boolean)),
  onlyPhases: new Set((process.env.ONLY_PHASES ?? '').split(',').map((s) => s.trim()).filter(Boolean)),
  fixture: (process.env.SYNTHI_GPU_HMR_FIXTURE ?? 'vector').toLowerCase(),
  syncToGcs: true,
};

const LOG_DIR = path.resolve(__dirname, '../.gpu-hmr-test-logs');
const ARTIFACT_DIR = path.resolve(__dirname, '../.gpu-hmr-test-artifacts');
const MCP_STDERR_LOG = path.join(LOG_DIR, 'mcp.stderr.log');

// ───────────────────────── log + results ─────────────────────────

const color = {
  reset: '\x1b[0m', red: '\x1b[31m', green: '\x1b[32m',
  yellow: '\x1b[33m', blue: '\x1b[36m', dim: '\x1b[2m',
};
function log(kind, msg) {
  const tag = { info: color.blue + '[i]', ok: color.green + '[✓]',
                warn: color.yellow + '[!]', fail: color.red + '[✗]',
                skip: color.dim + '[…]' }[kind];
  console.log(`${tag}${color.reset} ${msg}`);
}

const results = [];
const runtimeDispatchProofs = [];
const runtimeOutputProofs = [];
function record(phase, name, status, detail = '') {
  results.push({ phase, name, status, detail, ts: new Date().toISOString() });
  const l = status === 'pass' ? 'ok' : status === 'fail' ? 'fail' : status === 'skip' ? 'skip' : 'warn';
  log(l, `[${phase}] ${name}${detail ? ' — ' + detail : ''}`);
}
function recordRuntimeOutputProof(phase, name, observation) {
  const proof = classifyGpuHmrOutputProof(observation);
  runtimeOutputProofs.push({
    phase,
    name,
    proof,
    observation: {
      dispatchObserved: observation?.dispatchObserved === true,
      dispatchProofState: observation?.dispatchProof?.resultState ?? null,
      dispatchProofDegradedState: observation?.dispatchProof?.degradedState ?? null,
      deterministicOutputObserved: observation?.deterministicOutputObserved === true,
      deterministicOracleProvided: observation?.deterministicOracleProvided === true,
      deterministicOraclePassed: observation?.deterministicOraclePassed === true,
      outputOracle: proof.outputOracle ?? null,
      evidenceRefs: Array.isArray(proof.evidenceRefs) ? proof.evidenceRefs : [],
      visualEvidenceRefs: Array.isArray(proof.visualEvidenceRefs) ? proof.visualEvidenceRefs : [],
      visualFrameObserved: observation?.visualFrameObserved === true,
    },
    ts: new Date().toISOString(),
  });
  record(phase, name, proof.degradedState ? 'warn' : 'pass', summarizeGpuHmrOutputProof(proof));
  return proof;
}

function recordRuntimeDispatchProof(phase, name, observation) {
  const proof = classifyGpuHmrDispatchProof(observation);
  runtimeDispatchProofs.push({
    phase,
    name,
    proof,
    observation: {
      dispatchObserved: observation?.dispatchObserved === true,
      argProvenanceObserved: observation?.argProvenanceObserved === true,
      argProvenanceComplete: observation?.argProvenanceComplete === true,
      unknownArgCount: Number.isFinite(observation?.unknownArgCount)
        ? Number(observation.unknownArgCount)
        : null,
    },
    ts: new Date().toISOString(),
  });
  record(phase, name, proof.degradedState ? 'warn' : 'pass', summarizeGpuHmrDispatchProof(proof));
  return proof;
}
function shouldRun(phase) {
  if (CFG.onlyPhases.size > 0 && !CFG.onlyPhases.has(phase)) return false;
  if (CFG.skipPhases.has(phase)) return false;
  return true;
}
function activeFixture() {
  if (CFG.fixture === 'flow') return 'flow';
  if (CFG.onlyPhases.has('FLOW')) return 'flow';
  return 'vector';
}
function skipIfNoGpuToolchain(phase, ctx, name) {
  if (ctx.toolchain?.ok) return false;
  record(phase, name, 'skip', ctx.toolchain?.reason ?? 'no_toolchain');
  return true;
}

// ───────────────────────── http + tcp helpers ─────────────────────────

async function httpJson(method, url, body, headers = {}) {
  const res = await fetch(url, {
    method,
    headers: { 'content-type': 'application/json', ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch { json = null; }
  if (!res.ok) {
    const err = new Error(`${method} ${url} -> ${res.status}: ${text.slice(0, 500)}`);
    err.status = res.status;
    err.body = text;
    throw err;
  }
  return json ?? {};
}

function tcpPing(host, port, timeoutMs = 2000) {
  return new Promise((resolve) => {
    const s = net.createConnection({ host, port });
    const t = setTimeout(() => { s.destroy(); resolve(false); }, timeoutMs);
    s.once('connect', () => { clearTimeout(t); s.end(); resolve(true); });
    s.once('error', () => { clearTimeout(t); resolve(false); });
  });
}
function parseUrl(u) {
  const x = new URL(u);
  return { host: x.hostname, port: Number(x.port) || (x.protocol === 'wss:' || x.protocol === 'https:' ? 443 : 80) };
}

function execText(cmd, args, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: timeoutMs }, (err, stdout, stderr) => {
      if (err) {
        err.stderr = stderr;
        reject(err);
        return;
      }
      resolve(String(stdout).trim());
    });
  });
}

async function dockerContainerExists(nameOrId) {
  if (!nameOrId) return false;
  try {
    await execText('docker', ['container', 'inspect', nameOrId], 5000);
    return true;
  } catch {
    return false;
  }
}

async function resolveDockerContainer(configured, service) {
  if (await dockerContainerExists(configured)) return configured;

  const repoRoot = path.resolve(__dirname, '../../..');
  try {
    const ids = await execText(
      'docker',
      ['compose', '--project-directory', repoRoot, 'ps', '-q', service],
      8000,
    );
    const id = ids.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)[0];
    if (id) return id;
  } catch {
    // Fall through to label-based discovery for stacks launched with an
    // explicit compose project name.
  }

  try {
    const ids = await execText(
      'docker',
      ['ps', '-q', '--filter', `label=com.docker.compose.service=${service}`],
      8000,
    );
    const id = ids.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)[0];
    if (id) return id;
  } catch {
    // Keep the configured value so the downstream docker exec error remains
    // visible in the test output.
  }

  return configured;
}

async function resolveDockerContainers() {
  if (CFG.mcpTransport !== 'docker') return;
  CFG.mcpContainer = await resolveDockerContainer(CFG.mcpContainer, 'mcp');
  CFG.workerContainer = await resolveDockerContainer(CFG.workerContainer, 'worker');
}

// ───────────────────────── collab + frontend wire ─────────────────────────

async function createWorkspace({ name, slug }) {
  return createValidationWorkspace({
    frontendUrl: CFG.frontendUrl,
    name,
    slug,
    httpJson,
    record: (name, status, detail) => record('seed', name, status, detail),
  });
}

async function writeFilesBatch({ slug, userId, files, syncToGcs }) {
  const res = await httpJson(
    'POST',
    `${CFG.collabUrl}/git/${slug}/write-files-batch`,
    {
      files: files.map((f) => ({ path: f.path, encoding: f.encoding ?? 'utf8', content: f.content })),
      syncToGcs: syncToGcs === true,
    },
    { 'x-user-id': userId },
  );
  const otherErrs = (res.errors ?? []).filter((e) => e.stage !== 'gcs_upload');
  if (otherErrs.length) throw new Error(`write-files-batch errors: ${JSON.stringify(otherErrs)}`);
  return res;
}

async function stageAndCommit({ slug, userId, message }) {
  await httpJson('POST', `${CFG.collabUrl}/git/${slug}/stage-all`, {}, { 'x-user-id': userId });
  await httpJson('POST', `${CFG.collabUrl}/git/${slug}/commit`, { message }, { 'x-user-id': userId });
}

async function readFileViaCollab({ slug, filePath }) {
  // collab-server exposes /git/:slug/file?path=… — use the same JSON wire
  const url = `${CFG.collabUrl}/git/${slug}/file?path=${encodeURIComponent(filePath)}`;
  const r = await fetch(url, { headers: { 'x-user-id': CFG.hostId } });
  return r.ok ? await r.text() : null;
}

// ───────────────────────── ai-engine wire ─────────────────────────

async function aiEngineProbe() {
  const out = { reachable: false, hasGpuEndpoints: false, endpoints: {} };
  try {
    const r = await fetch(`${CFG.aiEngineUrl}/`).catch(() => null);
    out.reachable = !!r;
  } catch { /* ignore */ }
  for (const ep of ['/refactor/split/gpu', '/refactor/diff_patch/gpu', '/refactor/heal/gpu']) {
    try {
      // OPTIONS or a bad POST will 405/422 if route exists, 404 if not.
      const r = await fetch(`${CFG.aiEngineUrl}${ep}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
      out.endpoints[ep] = r.status;
    } catch (e) {
      out.endpoints[ep] = `err:${e.message.slice(0, 30)}`;
    }
  }
  out.hasGpuEndpoints = Object.values(out.endpoints).every((s) => typeof s === 'number' && s !== 404);
  return out;
}

// ───────────────────────── worker log tail ─────────────────────────

async function readWorkerLogTail(maxBytes = 2 * 1024 * 1024, opts = {}) {
  try {
    const st = await stat(CFG.workerLogPath);
    const fd = await import('node:fs').then((m) => m.promises.open(CFG.workerLogPath, 'r'));
    const requestedOffset = Number.isFinite(opts.fromOffset) ? Number(opts.fromOffset) : null;
    const start = requestedOffset != null && requestedOffset <= st.size
      ? requestedOffset
      : Math.max(0, st.size - maxBytes);
    const buf = Buffer.alloc(st.size - start);
    await fd.read(buf, 0, buf.length, start);
    await fd.close();
    const text = buf.toString('utf8');
    return requestedOffset == null ? text.slice(-maxBytes) : text;
  } catch (e) {
    return new Promise((resolve) => {
      const tailLines = String(Math.max(1000, Math.ceil(maxBytes / 128)));
      const args = ['logs'];
      if (opts.since) args.push('--since', opts.since);
      else args.push('--tail', tailLines);
      args.push(CFG.workerContainer);
      const maxBuffer = opts.since ? Math.max(maxBytes * 32, 128 * 1024 * 1024) : maxBytes * 4;
      execFile('docker', args, { maxBuffer }, (err, stdout, stderr) => {
        if (err) return resolve(null);
        const text = `${stdout ?? ''}${stderr ?? ''}`;
        resolve(opts.since ? text : text.slice(-maxBytes));
      });
    });
  }
}

async function workerLogCheckpoint(maxBytes = 2 * 1024 * 1024) {
  const at = new Date(Date.now() - 2000).toISOString();
  let fileSize = null;
  try {
    fileSize = existsSync(CFG.workerLogPath) ? (await stat(CFG.workerLogPath)).size : null;
  } catch {
    fileSize = null;
  }
  return { at, fileSize, tail: await readWorkerLogTail(maxBytes) };
}

function workerLogWindow(tail, afterTail) {
  const anchor = typeof afterTail === 'string' ? afterTail : afterTail?.tail;
  if (!tail || !anchor) return tail;
  const marker = anchor.slice(-Math.min(anchor.length, 8192));
  const idx = marker ? tail.indexOf(marker) : -1;
  return idx >= 0 ? tail.slice(idx + marker.length) : tail;
}

function workerLogSearchWindow(tail, opts = {}) {
  if (opts.after?.fileSize != null && existsSync(CFG.workerLogPath)) return tail;
  // Docker captures stdout/stderr separately, so execFile cannot preserve
  // cross-stream ordering. With a timestamp checkpoint, --since is already the
  // boundary; applying a stderr-derived anchor can discard stdout planner logs.
  if (opts.after?.at && !existsSync(CFG.workerLogPath)) return tail;
  return workerLogWindow(tail, opts.after);
}

async function awaitWorkerLogRegex(regex, timeoutMs, opts = {}) {
  const deadline = Date.now() + timeoutMs;
  const maxBytes = opts.maxBytes ?? 2 * 1024 * 1024;
  const logOpts = opts.after?.fileSize != null
    ? { fromOffset: opts.after.fileSize }
    : opts.after?.at
      ? { since: opts.after.at }
      : {};
  while (Date.now() < deadline) {
    const tail = await readWorkerLogTail(maxBytes, logOpts);
    const window = workerLogSearchWindow(tail, opts);
    regex.lastIndex = 0;
    if (window && regex.test(window)) {
      regex.lastIndex = 0;
      const m = window.match(regex);
      return { matched: true, snippet: m?.[0] ?? '', tail, window };
    }
    await sleep(500);
  }
  const tail = await readWorkerLogTail(maxBytes, logOpts);
  return { matched: false, snippet: '', tail, window: workerLogSearchWindow(tail, opts) };
}

// ───────────────────────── MCP JSON-RPC over stdio ─────────────────────────

class McpClient {
  constructor(proc) {
    this.proc = proc;
    this.nextId = 1;
    this.pending = new Map();
    this.buffer = '';
    this.stderrTail = [];
    proc.stdout.on('data', (chunk) => this.onData(chunk.toString()));
    proc.stderr.on('data', (chunk) => {
      const s = chunk.toString();
      this.stderrTail.push(s);
      if (this.stderrTail.length > 50) this.stderrTail.shift();
      if (process.env.MCP_VERBOSE) process.stderr.write(color.dim + '[mcp] ' + color.reset + s);
    });
    proc.on('exit', (code, sig) => {
      for (const [, p] of this.pending) p.reject(new Error(`MCP exited ${code ?? sig} before response`));
      this.pending.clear();
    });
  }

  onData(text) {
    this.buffer += text;
    let idx;
    while ((idx = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, idx).trim();
      this.buffer = this.buffer.slice(idx + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      if (msg.id != null && this.pending.has(msg.id)) {
        const p = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) p.reject(new Error(`MCP error: ${JSON.stringify(msg.error)}`));
        else p.resolve(msg.result);
      }
    }
  }

  request(method, params = {}, timeoutMs = CFG.mcpRequestTimeoutMs) {
    const id = this.nextId++;
    const frame = { jsonrpc: '2.0', id, method, params };
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP request ${method} timed out after ${timeoutMs}ms. stderr tail:\n${this.stderrTail.slice(-10).join('')}`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (v) => { clearTimeout(t); resolve(v); },
        reject: (e) => { clearTimeout(t); reject(e); },
      });
      this.proc.stdin.write(JSON.stringify(frame) + '\n');
    });
  }

  async toolCall(name, args, timeoutMs = CFG.mcpRequestTimeoutMs) {
    const res = await this.request('tools/call', { name, arguments: args }, timeoutMs);
    const content = Array.isArray(res?.content) ? res.content : [];
    const textBlock = content.find((b) => b?.type === 'text');
    if (res.isError) {
      const errMsg = textBlock?.text || JSON.stringify(res.content);
      throw new Error(`tool ${name} isError: ${errMsg}`);
    }
    const imageBlock = content.find((b) => b?.type === 'image');
    let parsed;
    if (textBlock?.text) {
      try { parsed = JSON.parse(textBlock.text); }
      catch { parsed = { raw: textBlock.text }; }
    } else {
      parsed = {};
    }
    if (imageBlock?.data) parsed.data = imageBlock.data;
    return parsed;
  }
}

let mcpState = null;

async function startMcp() {
  if (!CFG.useMcpCompile) return null;
  if (mcpState?.client) return mcpState;

  let proc;
  if (CFG.mcpTransport === 'docker') {
    const mcpEnv = {
      SYNTHI_SESSION_ID: CFG.slug,
      SYNTHI_SIGNALING_URL: CFG.mcpSignalingUrl,
      SYNTHI_VISION_BACKEND: CFG.mcpVisionBackend,
      GOOGLE_API_KEY: CFG.googleApiKey,
      SYNTHI_GEMINI_MODEL: CFG.geminiModel,
      SYNTHI_PROMETHEUS_HOST: '0.0.0.0',
    };
    if (CFG.mcpPrometheusPort) mcpEnv.SYNTHI_PROMETHEUS_PORT = CFG.mcpPrometheusPort;
    const args = ['exec', '-i'];
    for (const [k, v] of Object.entries(mcpEnv)) args.push('-e', `${k}=${v}`);
    args.push(CFG.mcpContainer, 'node', '/app/dist/index.js');
    proc = spawn('docker', args, { stdio: ['pipe', 'pipe', 'pipe'] });
  } else {
    if (!existsSync(CFG.mcpEntry)) {
      throw new Error(`MCP entry not found: ${CFG.mcpEntry}; run npm run build in mcp/synthi-mcp`);
    }
    const env = {
      ...process.env,
      SYNTHI_SESSION_ID: CFG.slug,
      SYNTHI_SIGNALING_URL: CFG.signalingUrl,
      SYNTHI_VISION_BACKEND: CFG.mcpVisionBackend,
      GOOGLE_API_KEY: CFG.googleApiKey,
      SYNTHI_GEMINI_MODEL: CFG.geminiModel,
      SYNTHI_PROMETHEUS_HOST: '127.0.0.1',
    };
    if (CFG.mcpPrometheusPort) env.SYNTHI_PROMETHEUS_PORT = CFG.mcpPrometheusPort;
    proc = spawn('node', [CFG.mcpEntry], { env, stdio: ['pipe', 'pipe', 'pipe'] });
  }

  const stderrStream = (await import('node:fs')).createWriteStream(MCP_STDERR_LOG, { flags: 'a' });
  proc.stderr.pipe(stderrStream);
  const client = new McpClient(proc);
  await client.request('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'synthi-gpu-hmr-test', version: '0.0.1' },
  }, 20000);
  await client.request('notifications/initialized', {}, 5000).catch(() => {});
  const tools = await client.request('tools/list', {}, 20000);
  const toolNames = tools.tools?.map((t) => t.name) ?? [];
  mcpState = { proc, client, stderrStream, attached: false, toolNames };
  record('preflight', 'MCP tools/list',
    toolNames.includes('synthi_compile') && toolNames.includes('synthi_wait_hmr') ? 'pass' : 'fail',
    `transport=${CFG.mcpTransport} count=${toolNames.length}`);
  return mcpState;
}

async function ensureMcpAttached() {
  const state = await startMcp();
  if (!state) return null;
  if (state.attached) return state;
  const attachArgs = {
    sessionId: CFG.slug,
    'i-understand-no-auth': true,
  };
  if (CFG.mcpTransport !== 'docker') attachArgs.signalingUrl = CFG.signalingUrl;
  const attach = await state.client.toolCall('synthi_attach', attachArgs, CFG.mcpAttachTimeoutMs);
  if (!attach?.ok) throw new Error(`synthi_attach failed: ${JSON.stringify(attach)}`);
  state.attached = true;
  record('preflight', 'MCP synthi_attach', 'pass',
    attach.resolution ? `${attach.resolution.w}x${attach.resolution.h}` : 'attached; no frame yet');
  return state;
}

async function stopMcp() {
  if (!mcpState) return;
  const { proc, stderrStream } = mcpState;
  try { proc.stdin.end(); } catch { /* ignore */ }
  try { proc.kill('SIGTERM'); } catch { /* ignore */ }
  try { stderrStream.end(); } catch { /* ignore */ }
  mcpState = null;
}

// ───────────────────────── toolchain probe ─────────────────────────

function execWhich(cmd) {
  return new Promise((resolve) => {
    const finder = process.platform === 'win32' ? 'where' : 'which';
    execFile(finder, [cmd], (err, stdout) => resolve(err ? null : stdout.trim().split(/\r?\n/)[0]));
  });
}

function dockerExecText(command, timeoutMs = 10000) {
  return new Promise((resolve) => {
    execFile('docker', ['exec', CFG.workerContainer, 'sh', '-lc', command], { timeout: timeoutMs }, (err, stdout) => {
      if (err) return resolve(undefined);
      const text = stdout.trim();
      resolve(text.length > 0 ? text : null);
    });
  });
}

async function detectWorkerGpuArch(vendor) {
  if (CFG.gpuArch && CFG.gpuArch.toLowerCase() !== 'auto') return CFG.gpuArch;
  const command = vendor === 'cuda'
    ? "if command -v nvidia-smi >/dev/null 2>&1; then nvidia-smi --query-gpu=compute_cap --format=csv,noheader,nounits 2>/dev/null | awk 'NF { gsub(/\\./, \"\", $1); print \"sm_\" $1; exit }'; fi"
    : "if command -v rocminfo >/dev/null 2>&1; then rocminfo 2>/dev/null | grep -m1 -o 'gfx[0-9][0-9a-z]*'; elif command -v rocm_agent_enumerator >/dev/null 2>&1; then rocm_agent_enumerator 2>/dev/null | grep -m1 -o 'gfx[0-9][0-9a-z]*'; fi";
  const out = await dockerExecText(command);
  const detected = String(out || '').trim().split(/\s+/).find((v) => (
    vendor === 'cuda' ? /^sm_\d+$/.test(v) : /^gfx[0-9][0-9a-z]*$/.test(v)
  ));
  return detected || null;
}

function archForVendor(vendor, tc = null) {
  if (CFG.gpuArch && CFG.gpuArch.toLowerCase() !== 'auto') return CFG.gpuArch;
  if (vendor === 'cuda' && tc?.worker?.cudaArch) return tc.worker.cudaArch;
  if (vendor === 'rocm' && tc?.worker?.rocmArch) return tc.worker.rocmArch;
  throw new Error(`could not resolve ${vendor} GPU arch; set SYNTHI_GPU_ARCH explicitly`);
}

async function probeToolchain() {
  // We probe both the harness host AND, if MCP_TRANSPORT=docker, the worker
  // container. The worker container is what actually has to have nvcc; the
  // harness host probe is just informational.
  const out = { host: {}, worker: {} };
  out.host.nvcc = await execWhich('nvcc');
  out.host.hipcc = await execWhich('hipcc');

  out.worker.nvcc = await dockerExecText('command -v nvcc || true');
  out.worker.hipcc = await dockerExecText('command -v hipcc || true');
  out.worker.nvidiaGpu = await dockerExecText('nvidia-smi --query-gpu=name --format=csv,noheader 2>/dev/null | head -n 1 || true');
  out.worker.rocmGpu = await dockerExecText(
    'if command -v rocminfo >/dev/null 2>&1; then rocminfo 2>/dev/null | awk \'/Name:/ && $0 !~ /Agent/ { sub(/^[[:space:]]*Name:[[:space:]]*/, ""); print; exit }\'; fi'
  );
  out.worker.cudaArch = await detectWorkerGpuArch('cuda');
  out.worker.rocmArch = await detectWorkerGpuArch('rocm');
  return out;
}

function autoVendorFromToolchain(tc) {
  if (tc.worker.nvidiaGpu && tc.worker.nvcc) return 'cuda';
  if ((tc.worker.rocmGpu || CFG.hipFakeRuntime) && tc.worker.hipcc) return 'rocm';
  if (tc.worker.nvcc && !tc.worker.hipcc) return 'cuda';
  if (tc.worker.hipcc && !tc.worker.nvcc) return 'rocm';
  if (tc.worker.nvcc) return 'cuda';
  if (tc.worker.hipcc) return 'rocm';
  if (tc.host.nvcc && !tc.host.hipcc) return 'cuda';
  if (tc.host.hipcc && !tc.host.nvcc) return 'rocm';
  return null;
}

function vendorsForConfig(tc) {
  if (CFG.vendor === 'both') return ['cuda', 'rocm'];
  if (CFG.vendor === 'auto') {
    const detected = autoVendorFromToolchain(tc);
    if (detected) return [detected];
    record('preflight', 'auto GPU vendor detection', 'skip', 'no CUDA/ROCm worker GPU/toolchain detected');
    return [];
  }
  return [CFG.vendor];
}

function toolchainForVendor(tc, vendor) {
  if (vendor === 'rocm') {
    if (tc.worker.hipcc) return { ok: true, source: 'worker', path: tc.worker.hipcc };
    if (CFG.hipFakeRuntime) return { ok: true, source: 'fake-runtime', path: 'SYNTHI_GPU_HIP_FAKE_RUNTIME=1' };
    if (tc.worker.hipcc === undefined && tc.host.hipcc) return { ok: true, source: 'host', path: tc.host.hipcc };
    return { ok: false, reason: 'no_toolchain: hipcc not found' };
  }
  if (tc.worker.nvcc) return { ok: true, source: 'worker', path: tc.worker.nvcc };
  if (tc.worker.nvcc === undefined && tc.host.nvcc) return { ok: true, source: 'host', path: tc.host.nvcc };
  return { ok: false, reason: 'no_toolchain: nvcc not found' };
}

// ───────────────────────── fixtures ─────────────────────────
// Hand-written 5-file projects — the harness skips the Kernel-Splitter LLM
// step so we have exact, deterministic byte-level inputs.

const SHARED_H = `// shared.h — GPU HMR test fixture
#pragma once
#include "synthi_gpu_runtime.h"
#include <cstdint>
#include <cstddef>

constexpr int N_ELEMS = 1 << 20;          // 1 048 576 floats = 4 MiB per buffer

struct CoreState {
    uint32_t magic;                       // CORE_STATE_MAGIC
    uint32_t version;
    float*   d_a;
    float*   d_b;
    float*   d_c;
    int      n;
    uint64_t frame;
    double   accumulator;                 // touched on host every frame
    SynthiGpuRuntime* gpu;                // Synthi runtime boundary for sidecar launches
    std::uintptr_t stream;
};
`;

const CORE_CPP = `// core.cpp — GPU HMR test fixture (Phase 0/1 vector add)
#include "shared.h"
#include <cstdlib>
#include <cstdio>
#include <cstring>
#include <cuda_runtime.h>

#define CORE_STATE_MAGIC 0x47505501u  // 'GPU' v1

static CoreState* g_state = nullptr;

static void log_buffers(const char* prefix) {
    if (!g_state) return;
    std::fprintf(stderr, "[gpu-hmr-fixture] %s buffer a=0x%llx b=0x%llx c=0x%llx\\n",
        prefix,
        (unsigned long long) reinterpret_cast<std::uintptr_t>(g_state->d_a),
        (unsigned long long) reinterpret_cast<std::uintptr_t>(g_state->d_b),
        (unsigned long long) reinterpret_cast<std::uintptr_t>(g_state->d_c));
}

static void record_host_identities(const CoreState* s) {
    if (!s) return;
    synthi_host_identity("core_state", s, ((uint64_t) s->magic << 32) | (uint64_t) s->version);
    synthi_host_identity("device_allocation_a", s->d_a, sizeof(float) * N_ELEMS);
    synthi_host_identity("device_allocation_b", s->d_b, sizeof(float) * N_ELEMS);
    synthi_host_identity("device_allocation_c", s->d_c, sizeof(float) * N_ELEMS);
    synthi_host_identity("stream", reinterpret_cast<const void*>(s->stream), 0);
}

extern "C" void* core_on_load(void* prev, void* /*renderer*/) {
    if (prev) {
        CoreState* p = (CoreState*) prev;
        if (p->magic == CORE_STATE_MAGIC) {
            g_state = p;                  // reuse — buffers must survive HMR
            log_buffers("reused");
            record_host_identities(g_state);
            return p;
        }
    }
    g_state = (CoreState*) std::malloc(sizeof(CoreState));
    std::memset(g_state, 0, sizeof(*g_state));
    g_state->magic = CORE_STATE_MAGIC;
    g_state->version = 1;
    g_state->n = N_ELEMS;
    cudaStream_t stream = nullptr;
    cudaStreamCreate(&stream);
    g_state->stream = reinterpret_cast<std::uintptr_t>(stream);
    cudaMalloc(&g_state->d_a, sizeof(float) * N_ELEMS);
    cudaMalloc(&g_state->d_b, sizeof(float) * N_ELEMS);
    cudaMalloc(&g_state->d_c, sizeof(float) * N_ELEMS);
    log_buffers("allocated");
    synthi_register(g_state->gpu, g_state->d_a, sizeof(float) * N_ELEMS, "a", "persistent");
    synthi_register(g_state->gpu, g_state->d_b, sizeof(float) * N_ELEMS, "b", "persistent");
    synthi_register(g_state->gpu, g_state->d_c, sizeof(float) * N_ELEMS, "c", "persistent");
    // Deterministic seed: a[i]=i, b[i]=2i
    float* host = (float*) std::malloc(sizeof(float) * N_ELEMS);
    for (int i = 0; i < N_ELEMS; ++i) host[i] = (float) i;
    cudaMemcpy(g_state->d_a, host, sizeof(float) * N_ELEMS, cudaMemcpyHostToDevice);
    for (int i = 0; i < N_ELEMS; ++i) host[i] = (float)(2 * i);
    cudaMemcpy(g_state->d_b, host, sizeof(float) * N_ELEMS, cudaMemcpyHostToDevice);
    std::free(host);
    record_host_identities(g_state);
    return g_state;
}

extern "C" void core_tick(void* /*ctx*/) {
    dim3 block(256);
    dim3 grid((g_state->n + block.x - 1) / block.x);
    record_host_identities(g_state);
    synthi_gpu_launch(
        g_state->gpu,
        "vec_add",
        grid,
        block,
        0,
        g_state->stream,
        { &g_state->d_a, &g_state->d_b, &g_state->d_c, &g_state->n }
    );
    g_state->frame += 1;
    g_state->accumulator += 1.0;
}

extern "C" void core_on_update(void* ctx, double /*dt*/) {
    core_tick(ctx);
}

extern "C" const DeviceDescriptor* device_descriptor() {
    static const char* arches[] = { "sm_80" };
    static const char* kernels[] = { "vec_add" };
    static DeviceDescriptor descriptor = {
        "cuda",
        arches,
        kernels,
        1,
        1,
        0,
    };
    return &descriptor;
}

extern "C" void device_on_load(const unsigned char* /*prev_blob*/, std::size_t /*len*/) {
    if (!g_state) return;
    synthi_register(g_state->gpu, g_state->d_a, sizeof(float) * g_state->n, "a", "persistent");
    synthi_register(g_state->gpu, g_state->d_b, sizeof(float) * g_state->n, "b", "persistent");
    synthi_register(g_state->gpu, g_state->d_c, sizeof(float) * g_state->n, "c", "persistent");
    record_host_identities(g_state);
}

extern "C" std::size_t device_save_size() { return 0; }
extern "C" void device_save_write(unsigned char* /*out*/, std::size_t /*cap*/) {}

extern "C" unsigned long long device_kernel_sig_hash(const char* name) {
    return std::strcmp(name, "vec_add") == 0 ? 0x7e5b30b1a64c21d5ULL : 0ULL;
}
`;

const GUI_CPP = `// gui.cpp — GPU HMR test fixture (renders a 256-bin histogram of d_c)
#include "shared.h"
#include <cuda_runtime.h>
#include <cstdio>

extern "C" void* gui_on_load(void* prev, void* /*renderer*/, void* /*core_state*/) {
    return prev;
}

extern "C" void gui_on_render(void* state_void) {
    CoreState* s = (CoreState*) state_void;
    // Pull a tiny sample back to the host so the harness can read it without
    // a full GUI integration. The harness only needs deterministic numbers.
    float sample[8] = {0};
    if (s && s->d_c) {
        cudaMemcpy(sample, s->d_c, sizeof(sample), cudaMemcpyDeviceToHost);
    }
    std::fprintf(stderr, "[gui] frame=%llu c[0..7]=%g %g %g %g %g %g %g %g\\n",
        (unsigned long long) (s ? s->frame : 0),
        sample[0], sample[1], sample[2], sample[3],
        sample[4], sample[5], sample[6], sample[7]);
    std::fflush(stderr);
}
`;

const HOST_RUNNER_CPP = `// host_runner.cpp — minimal runner: tick + render in a loop.
#include "shared.h"
#include <chrono>
#include <thread>
#include <cstdio>

extern "C" void* core_on_load(void*, void*);
extern "C" void core_on_update(void*, double);
extern "C" void* gui_on_load(void*, void*, void*);
extern "C" void gui_on_render(void*);

int main() {
    void* state = core_on_load(nullptr, nullptr);
    gui_on_load(nullptr, nullptr, state);
    for (int i = 0; i < 1000; ++i) {
        core_on_update(state, 0.016);
        gui_on_render(state);
        std::this_thread::sleep_for(std::chrono::milliseconds(16));
    }
    return 0;
}
`;

function sourceSetForVendor(vendor, arch = archForVendor(vendor)) {
  if (vendor !== 'rocm') {
    return { core: CORE_CPP, gui: GUI_CPP };
  }
  const core = CORE_CPP
    .replace('#include <cuda_runtime.h>', '#include <hip/hip_runtime.h>')
    .replaceAll('cudaStream_t', 'hipStream_t')
    .replaceAll('cudaStreamCreate', 'hipStreamCreate')
    .replaceAll('cudaMalloc', 'hipMalloc')
    .replaceAll('cudaMemcpyHostToDevice', 'hipMemcpyHostToDevice')
    .replaceAll('cudaMemcpyDeviceToHost', 'hipMemcpyDeviceToHost')
    .replaceAll('cudaMemcpy', 'hipMemcpy')
    .replace('"sm_80"', `"${arch}"`)
    .replace('"cuda"', '"rocm"');
  const gui = GUI_CPP
    .replace('#include <cuda_runtime.h>', '#include <hip/hip_runtime.h>')
    .replaceAll('cudaMemcpyDeviceToHost', 'hipMemcpyDeviceToHost')
    .replaceAll('cudaMemcpy', 'hipMemcpy');
  return { core, gui };
}

function deviceSourceForPath(filePath, content) {
  if (!filePath.endsWith('.hip')) return content;
  if (content.includes('<hip/hip_runtime.h>')) return content;
  return content.replace(/^/, '#include <hip/hip_runtime.h>\n');
}

const DEVICE_CU_PHASE0 = `// device.cu — vector add baseline (Phase 0/1)
extern "C" __global__ void vec_add(const float* a, const float* b, float* c, int n) {
    int i = blockIdx.x * blockDim.x + threadIdx.x;
    if (i < n) c[i] = a[i] + b[i];
}
`;

// Phase-1 edit: + becomes * — same signature, kernel hash unchanged.
const DEVICE_CU_PHASE1_EDIT = DEVICE_CU_PHASE0.replace(
  'c[i] = a[i] + b[i];',
  'c[i] = a[i] * b[i];',
);

// Phase-2 fast-swap edit: introduce vectorized inner work but keep signature.
const DEVICE_CU_PHASE2_FAST = `// device.cu — vector add (Phase 2 fast-swap edit, vectorized inner)
extern "C" __global__ void vec_add(const float* a, const float* b, float* c, int n) {
    int i = blockIdx.x * blockDim.x + threadIdx.x;
    // Same signature, same semantics, different inner shape — hash unchanged.
    if (i < n) {
        float x = a[i], y = b[i];
        c[i] = x * y;
    }
}
`;

const VECTOR_ADD_READBACK = [0, 3, 6, 9, 12, 15, 18, 21];
const VECTOR_MUL_READBACK = [0, 2, 8, 18, 32, 50, 72, 98];

// Phase-2 abi-breaking edit: extra parameter — signature changes.
const DEVICE_CU_PHASE2_ABI_BREAK = `// device.cu — abi-breaking edit (extra parameter)
extern "C" __global__ void vec_add(const float* a, const float* b, float* c, int n, float scale) {
    int i = blockIdx.x * blockDim.x + threadIdx.x;
    if (i < n) c[i] = (a[i] + b[i]) * scale;
}
`;

// Phase-3 healer drills — pathological inputs the GPU healer must natively fix.
const DEVICE_CU_HEAL_T1 = DEVICE_CU_PHASE0.replace(
  'c[i] = a[i] + b[i];',
  'c[i] = __shfl_down(0xFFFFFFFF, a[i], 16) + b[i];', // missing _sync — nvcc rejects on sm_70+
);
const DEVICE_CU_HEAL_T2 = `// device.cu — Tier 2 (compile-soft / spills)
extern "C" __global__ void vec_add(const float* a, const float* b, float* c, int n) {
    float local[200];                          // force massive register pressure
    int i = blockIdx.x * blockDim.x + threadIdx.x;
    for (int k = 0; k < 200; ++k) local[k] = a[(i + k) % n] * 1.000001f;
    float sum = 0; for (int k = 0; k < 200; ++k) sum += local[k];
    if (i < n) c[i] = sum + b[i];
}
`;
const DEVICE_CU_HEAL_T3 = DEVICE_CU_PHASE0.replace(
  'if (i < n) c[i] = a[i] + b[i];',
  'c[i + 4] = a[i] + b[i];', // last block over-indexes
);

const FLOW_SHARED_H = `// shared.h - GPU HMR user validation fixture
#pragma once
#include "synthi_gpu_runtime.h"
#include <SDL2/SDL.h>
#include <cstdint>
#include <cstddef>

constexpr int FLOW_BALLS = 768;
constexpr int FLOW_W = 800;
constexpr int FLOW_H = 600;

struct CoreState {
    uint32_t magic;
    uint32_t version;
    SDL_Renderer* renderer;
    float* d_x;
    float* d_y;
    float h_x[FLOW_BALLS];
    float h_y[FLOW_BALLS];
    int n;
    float cx;
    float cy;
    float speed;
    float last_avg_radius;
    int flow_trend;
    uint64_t frame;
    double accumulator;
    SynthiGpuRuntime* gpu;
    std::uintptr_t stream;
};
`;

const FLOW_CORE_CPP = `// core.cpp - GPU HMR user validation fixture
#include "shared.h"
#include <cuda_runtime.h>
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <cstring>

#define CORE_STATE_MAGIC 0x464C4F57u  // 'FLOW'

static CoreState* g_state = nullptr;

static void flow_register_buffers() {
    if (!g_state) return;
    synthi_register(g_state->gpu, g_state->d_x, sizeof(float) * FLOW_BALLS, "flow.x", "persistent");
    synthi_register(g_state->gpu, g_state->d_y, sizeof(float) * FLOW_BALLS, "flow.y", "persistent");
}

static void flow_record_host_identities(const CoreState* s) {
    if (!s) return;
    synthi_host_identity("core_state", s, ((uint64_t) s->magic << 32) | (uint64_t) s->version);
    synthi_host_identity("renderer", s->renderer, (uint64_t) s->version);
    synthi_host_identity("device_allocation_x", s->d_x, sizeof(float) * FLOW_BALLS);
    synthi_host_identity("device_allocation_y", s->d_y, sizeof(float) * FLOW_BALLS);
    synthi_host_identity("stream", reinterpret_cast<const void*>(s->stream), 0);
}

static void flow_seed_host() {
    for (int i = 0; i < FLOW_BALLS; ++i) {
        const float theta = 2.39996323f * (float)i;
        const float radius = 220.0f + (float)((i * 37) % 110);
        g_state->h_x[i] = g_state->cx + std::cos(theta) * radius;
        g_state->h_y[i] = g_state->cy + std::sin(theta) * radius;
    }
}

extern "C" void* core_on_load(void* prev, void* renderer) {
    if (prev) {
        CoreState* p = (CoreState*) prev;
        if (p->magic == CORE_STATE_MAGIC && p->version == 1) {
            g_state = p;
            g_state->renderer = (SDL_Renderer*) renderer;
            flow_register_buffers();
            flow_record_host_identities(g_state);
            std::fprintf(stderr, "[gpu-flow-demo] reused state frame=%llu\\n",
                (unsigned long long) g_state->frame);
            return p;
        }
    }

    g_state = (CoreState*) std::malloc(sizeof(CoreState));
    std::memset(g_state, 0, sizeof(*g_state));
    g_state->magic = CORE_STATE_MAGIC;
    g_state->version = 1;
    g_state->renderer = (SDL_Renderer*) renderer;
    g_state->n = FLOW_BALLS;
    g_state->cx = FLOW_W * 0.5f;
    g_state->cy = FLOW_H * 0.5f;
    g_state->speed = 2.35f;

    cudaStream_t stream = nullptr;
    cudaStreamCreate(&stream);
    g_state->stream = reinterpret_cast<std::uintptr_t>(stream);
    cudaMalloc(&g_state->d_x, sizeof(float) * FLOW_BALLS);
    cudaMalloc(&g_state->d_y, sizeof(float) * FLOW_BALLS);

    flow_seed_host();
    cudaMemcpy(g_state->d_x, g_state->h_x, sizeof(float) * FLOW_BALLS, cudaMemcpyHostToDevice);
    cudaMemcpy(g_state->d_y, g_state->h_y, sizeof(float) * FLOW_BALLS, cudaMemcpyHostToDevice);
    flow_register_buffers();

    std::fprintf(stderr, "[gpu-flow-demo] allocated particles=%d x=0x%llx y=0x%llx\\n",
        FLOW_BALLS,
        (unsigned long long) reinterpret_cast<std::uintptr_t>(g_state->d_x),
        (unsigned long long) reinterpret_cast<std::uintptr_t>(g_state->d_y));
    flow_record_host_identities(g_state);
    return g_state;
}

extern "C" void core_on_update(void* ctx, double dt) {
    CoreState* s = (CoreState*) ctx;
    if (!s) return;
    g_state = s;
    dim3 block(256);
    dim3 grid((s->n + block.x - 1) / block.x);
    unsigned long long frame = (unsigned long long) s->frame;
    flow_record_host_identities(s);
    synthi_gpu_launch(
        s->gpu,
        "particle_flow",
        grid,
        block,
        0,
        s->stream,
        { &s->d_x, &s->d_y, &s->n, &s->cx, &s->cy, &s->speed, &frame }
    );
    s->frame += 1;
    s->accumulator += dt;
}

extern "C" const DeviceDescriptor* device_descriptor() {
    static const char* arches[] = { "sm_80" };
    static const char* kernels[] = { "particle_flow" };
    static DeviceDescriptor descriptor = {
        "cuda",
        arches,
        kernels,
        1,
        1,
        0,
    };
    return &descriptor;
}

extern "C" void device_on_load(const unsigned char* /*prev_blob*/, std::size_t /*len*/) {
    flow_register_buffers();
    flow_record_host_identities(g_state);
    std::fprintf(stderr, "[gpu-flow-demo] device_on_load frame=%llu\\n",
        (unsigned long long) (g_state ? g_state->frame : 0));
}

extern "C" std::size_t device_save_size() { return 0; }
extern "C" void device_save_write(unsigned char* /*out*/, std::size_t /*cap*/) {}

extern "C" unsigned long long device_kernel_sig_hash(const char* name) {
    return std::strcmp(name, "particle_flow") == 0 ? 0x41f10beef1257781ULL : 0ULL;
}
`;

const FLOW_GUI_CPP = `// gui.cpp - renders the live GPU particle flow
#include "shared.h"
#include <cuda_runtime.h>
#include <cmath>
#include <cstdio>

static void fill_circle(SDL_Renderer* ren, int cx, int cy, int radius) {
    for (int y = -radius; y <= radius; ++y) {
        for (int x = -radius; x <= radius; ++x) {
            if (x * x + y * y <= radius * radius) {
                SDL_RenderDrawPoint(ren, cx + x, cy + y);
            }
        }
    }
}

extern "C" void* gui_on_load(void* prev, void* /*renderer*/, void* /*core_api*/) {
    return prev;
}

extern "C" void gui_on_render(void* state_void) {
    CoreState* s = (CoreState*) state_void;
    if (!s || !s->renderer) return;
    SDL_Renderer* ren = s->renderer;

    SDL_SetRenderDrawBlendMode(ren, SDL_BLENDMODE_BLEND);
    SDL_SetRenderDrawColor(ren, 6, 10, 18, 255);
    SDL_RenderClear(ren);

    if (s->d_x && s->d_y) {
        cudaMemcpy(s->h_x, s->d_x, sizeof(float) * FLOW_BALLS, cudaMemcpyDeviceToHost);
        cudaMemcpy(s->h_y, s->d_y, sizeof(float) * FLOW_BALLS, cudaMemcpyDeviceToHost);
    }

    float avg_radius = 0.0f;
    for (int i = 0; i < FLOW_BALLS; ++i) {
        const float dx = s->h_x[i] - s->cx;
        const float dy = s->h_y[i] - s->cy;
        avg_radius += std::sqrt(dx * dx + dy * dy);
    }
    avg_radius /= (float) FLOW_BALLS;
    const float delta = avg_radius - s->last_avg_radius;
    if (s->last_avg_radius > 1.0f) {
        if (delta > 0.08f) s->flow_trend = 1;
        if (delta < -0.08f) s->flow_trend = -1;
    }
    s->last_avg_radius = avg_radius;

    SDL_SetRenderDrawColor(ren, 22, 34, 54, 255);
    for (int r = 80; r <= 320; r += 80) {
        for (int a = 0; a < 360; a += 6) {
            float t = (float)a * 0.01745329252f;
            SDL_RenderDrawPoint(ren, (int)(s->cx + std::cos(t) * r), (int)(s->cy + std::sin(t) * r));
        }
    }

    if (s->flow_trend > 0) {
        SDL_SetRenderDrawColor(ren, 255, 142, 64, 255);
    } else {
        SDL_SetRenderDrawColor(ren, 64, 224, 208, 255);
    }
    fill_circle(ren, (int)s->cx, (int)s->cy, 18);

    for (int i = 0; i < FLOW_BALLS; ++i) {
        const float dx = s->h_x[i] - s->cx;
        const float dy = s->h_y[i] - s->cy;
        const float radius = std::sqrt(dx * dx + dy * dy);
        const unsigned char alpha = (unsigned char)(110 + ((i * 17) % 120));
        if (s->flow_trend > 0) {
            SDL_SetRenderDrawColor(ren, 255, (unsigned char)(106 + (i % 90)), 44, alpha);
        } else {
            SDL_SetRenderDrawColor(ren, 44, (unsigned char)(170 + (i % 70)), 255, alpha);
        }
        int dot = radius < 64.0f ? 3 : 2;
        fill_circle(ren, (int)s->h_x[i], (int)s->h_y[i], dot);
    }

    if ((s->frame % 60) == 0) {
        std::fprintf(stderr, "[gpu-flow-demo] frame=%llu avg_radius=%.2f trend=%s\\n",
            (unsigned long long) s->frame,
            avg_radius,
            s->flow_trend > 0 ? "outward" : "inward");
    }
}
`;

const FLOW_DEVICE_INWARD = `// device.cu - GPU HMR flow validation, inward baseline
#ifndef FLOW_DIRECTION
#define FLOW_DIRECTION 1.0f
#endif

extern "C" __global__ void particle_flow(float* x, float* y, int n, float cx, float cy, float speed, unsigned long long frame) {
    int i = blockIdx.x * blockDim.x + threadIdx.x;
    if (i >= n) return;

    float dx = cx - x[i];
    float dy = cy - y[i];
    float len = sqrtf(dx * dx + dy * dy) + 0.0001f;
    x[i] += FLOW_DIRECTION * dx / len * speed;
    y[i] += FLOW_DIRECTION * dy / len * speed;

    float ox = x[i] - cx;
    float oy = y[i] - cy;
    float radius = sqrtf(ox * ox + oy * oy);
    float theta = 2.39996323f * (float)i + 0.015f * (float)(frame % 251ULL);
    if (FLOW_DIRECTION > 0.0f && radius < 16.0f) {
        float rr = 310.0f + (float)((i * 19) % 58);
        x[i] = cx + cosf(theta) * rr;
        y[i] = cy + sinf(theta) * rr;
    }
    if (FLOW_DIRECTION < 0.0f && radius > 388.0f) {
        float rr = 14.0f + (float)((i * 11) % 24);
        x[i] = cx + cosf(theta) * rr;
        y[i] = cy + sinf(theta) * rr;
    }
}
`;

const FLOW_DEVICE_OUTWARD = FLOW_DEVICE_INWARD
  .replace('inward baseline', 'outward hot-swap edit')
  .replace('#define FLOW_DIRECTION 1.0f', '#define FLOW_DIRECTION -1.0f');

function flowSourceSetForVendor(vendor, arch = archForVendor(vendor)) {
  if (vendor !== 'rocm') {
    return { shared: FLOW_SHARED_H, core: FLOW_CORE_CPP, gui: FLOW_GUI_CPP };
  }
  const core = FLOW_CORE_CPP
    .replace('#include <cuda_runtime.h>', '#include <hip/hip_runtime.h>')
    .replaceAll('cudaStream_t', 'hipStream_t')
    .replaceAll('cudaStreamCreate', 'hipStreamCreate')
    .replaceAll('cudaMalloc', 'hipMalloc')
    .replaceAll('cudaMemcpyHostToDevice', 'hipMemcpyHostToDevice')
    .replaceAll('cudaMemcpyDeviceToHost', 'hipMemcpyDeviceToHost')
    .replaceAll('cudaMemcpy', 'hipMemcpy')
    .replace('"sm_80"', `"${arch}"`)
    .replace('"cuda"', '"rocm"');
  const gui = FLOW_GUI_CPP
    .replace('#include <cuda_runtime.h>', '#include <hip/hip_runtime.h>')
    .replaceAll('cudaMemcpyDeviceToHost', 'hipMemcpyDeviceToHost')
    .replaceAll('cudaMemcpy', 'hipMemcpy');
  return { shared: FLOW_SHARED_H, core, gui };
}

function manifestFor(vendor, fixture = activeFixture(), arch = archForVendor(vendor)) {
  const flow = fixture === 'flow';
  const sdlLinkFlags = flow ? ['-lSDL2', '-lm'] : [];
  const commonFlags = [
    '-shared',
    '-fPIC',
    '-O0',
    '-fno-merge-constants',
    '-D_POSIX_C_SOURCE=199309L',
    '-g',
    '-gdwarf-4',
    '-fno-omit-frame-pointer',
    '-fdiagnostics-format=json',
  ];
  const confidence = {
    overall: 'high',
    runner_synthesis: 'high',
    link_flags: 'high',
    notes: flow ? `${vendor} GPU HMR particle-flow user validation` : `${vendor} GPU HMR fixture`,
  };
  if (vendor === 'rocm') {
    return {
      compiler: 'g++',
      std: 'c++17',
      common_flags: [
        ...commonFlags,
        '-D__HIP_PLATFORM_AMD__',
        '-I/opt/rocm/include',
      ],
      core_link_flags: ['-L/opt/rocm/lib', '-lamdhip64'],
      gui_link_flags: ['-L/opt/rocm/lib', '-lamdhip64', ...sdlLinkFlags],
      shared_link_flags: [],
      runner_link_flags: ['-L/opt/rocm/lib', '-lamdhip64', '-ldl', ...sdlLinkFlags],
      system_packages: [],
      hot_reload_mode: 'swap',
      confidence,
      files: ['shared.h', 'core.cpp', 'gui.cpp', 'host_runner.cpp', 'device.hip'],
      gpu: {
        vendor: 'rocm',
        device_compiler: 'hipcc',
        arch: [arch],
        device_flags: ['-O3', '-g'],
        runtime_libs: ['amdhip64'],
        snapshot_mode: 'auto',
        fatbin_strategy: 'sidecar_module',
        ...(CFG.hipFakeRuntime ? { fake_runtime: 'hip-cpu' } : {}),
      },
    };
  }
  const cudaIncludeFlags = ['-I/usr/local/cuda/include'];
  const cudaLinkFlags = ['-L/usr/local/cuda/lib64', '-L/usr/local/cuda/lib64/stubs'];
  return {
    compiler: 'g++',
    std: 'c++17',
    common_flags: [...commonFlags, ...cudaIncludeFlags],
    core_link_flags: [...cudaLinkFlags, '-lcudart', '-lcuda'],
    gui_link_flags: [...cudaLinkFlags, '-lcudart', '-lcuda', ...sdlLinkFlags],
    shared_link_flags: [],
    runner_link_flags: [...cudaLinkFlags, '-lcudart', '-lcuda', '-ldl', ...sdlLinkFlags],
    system_packages: [],
    hot_reload_mode: 'swap',
    confidence,
    files: ['shared.h', 'core.cpp', 'gui.cpp', 'host_runner.cpp', 'device.cu'],
    gpu: {
      vendor: 'cuda',
      device_compiler: 'nvcc',
      arch: [arch],
      device_flags: ['-O3', '-lineinfo', '--use_fast_math'],
      runtime_libs: ['cudart', 'cuda'],
      snapshot_mode: 'auto',
      fatbin_strategy: 'sidecar_module',
    },
  };
}

function verifySeedFixtureContract(files) {
  const byPath = new Map(files.map((f) => [f.path, f.content]));
  const hostText = ['shared.h', 'core.cpp', 'gui.cpp', 'host_runner.cpp']
    .map((p) => byPath.get(p) ?? '')
    .join('\n');
  const deviceText = byPath.get('device.cu') ?? byPath.get('device.hip') ?? '';
  const findings = [];
  if (!(byPath.get('shared.h') ?? '').includes('#include "synthi_gpu_runtime.h"')) {
    findings.push('shared.h_missing_synthi_gpu_runtime_header');
  }
  if (!/\bsynthi_gpu_launch\s*\(/.test(hostText)) {
    findings.push('host_missing_synthi_gpu_launch_boundary');
  }
  if (!/\bsynthi_host_identity\s*\(/.test(hostText)) {
    findings.push('host_missing_identity_snapshot_boundary');
  }
  if (/\w+\s*<<<[\s\S]*?>>>/.test(hostText)) {
    findings.push('host_contains_raw_triple_chevron_launch');
  }
  if (/\bvec_add_launch\b/.test(hostText) || /\bvec_add_launch\b/.test(deviceText)) {
    findings.push('private_vec_add_launch_wrapper_present');
  }
  if (!/\bdevice_descriptor\s*\(/.test(hostText)) {
    findings.push('missing_device_descriptor_export');
  }
  if (!/\bdevice_on_load\s*\(/.test(hostText)) {
    findings.push('missing_device_on_load_export');
  }
  if (!/\bdevice_save_size\s*\(/.test(hostText) || !/\bdevice_save_write\s*\(/.test(hostText)) {
    findings.push('missing_device_save_exports');
  }
  if (!/\bdevice_kernel_sig_hash\s*\(/.test(hostText)) {
    findings.push('missing_device_kernel_sig_hash_export');
  }
  if (!/\b__global__\s+void\s+(vec_add|particle_flow)\s*\(/.test(deviceText)) {
    findings.push('device_missing_gpu_kernel');
  }
  return { ok: findings.length === 0, findings };
}

// ───────────────────────── compile + HMR over MCP ─────────────────────────

async function postCompileViaMcp({ ctx, files }) {
  const state = await ensureMcpAttached();
  const primaryPath = files[0]?.path ?? ctx.deviceFilename;
  const primarySource = ctx.sourceFiles.get(primaryPath);
  if (typeof primarySource !== 'string') {
    return { ok: false, reason: `missing_primary_source:${primaryPath}` };
  }
  const additionalFiles = [...ctx.sourceFiles.entries()]
    .filter(([name]) => name !== primaryPath)
    .map(([name, content]) => ({ name, content }));

  const compileRes = await state.client.toolCall('synthi_compile', {
    language: 'cpp',
    filename: primaryPath,
    source: primarySource,
    files: additionalFiles,
    is_gui: true,
    use_ai_split: false,
    user_requested_deterministic: true,
    prefer_gpu_pipeline: true,
    gpu_mode: 'auto',
    compile_manifest: ctx.manifest,
    slug: CFG.slug,
    ...(ctx.fixture === 'flow' ? { width: 800, height: 600 } : {}),
  });
  if (!compileRes?.ok) {
    return { ok: false, reason: `mcp_compile_failed:${JSON.stringify(compileRes).slice(0, 240)}` };
  }

  let hmr = null;
  try {
    // GPU reload success is asserted from worker telemetry below. Keep this
    // terminal-event wait short so high-volume runner logs do not age out the
    // reload markers before phase assertions read them.
    const waitTimeoutMs = Number.isFinite(CFG.hmrWaitTimeoutMs) && CFG.hmrWaitTimeoutMs > 0
      ? Math.min(CFG.hmrTimeoutMs, CFG.hmrWaitTimeoutMs)
      : CFG.hmrTimeoutMs;
    hmr = await state.client.toolCall('synthi_wait_hmr', { timeoutMs: waitTimeoutMs }, waitTimeoutMs + 5000);
  } catch (e) {
    return { ok: true, body: { compile: compileRes }, hmr: { status: 'timeout_or_error', error: e.message } };
  }
  return { ok: true, body: { compile: compileRes }, hmr };
}

async function postCompileViaAiEngine({ slug, files, manifest }) {
  // The AI engine endpoint surface we want here is /refactor/diff_patch/gpu
  // (or /refactor/split/gpu for first compile). This is only a fallback for
  // legacy CI lanes where MCP/WebRTC is unavailable.
  try {
    const body = {
      slug,
      files,
      manifest,
      prefer_gpu_pipeline: true,
    };
    const r = await fetch(`${CFG.aiEngineUrl}/refactor/diff_patch/gpu`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (r.status === 404) return { ok: false, reason: 'endpoint_not_implemented' };
    if (!r.ok) return { ok: false, reason: `status_${r.status}`, body: (await r.text()).slice(0, 500) };
    return { ok: true, body: await r.json() };
  } catch (e) {
    return { ok: false, reason: 'unreachable', error: e.message };
  }
}

async function postCompile({ ctx, slug, files, manifest }) {
  files = files.map((f) => ({ ...f, content: deviceSourceForPath(f.path, f.content) }));
  for (const f of files) ctx.sourceFiles.set(f.path, f.content);

  try {
    await writeFilesBatch({ slug, userId: CFG.hostId, files, syncToGcs: CFG.syncToGcs });
  } catch (e) {
    return { ok: false, reason: `collab_write_failed:${e.message.slice(0, 180)}` };
  }

  if (CFG.useMcpCompile) {
    try {
      const viaMcp = await postCompileViaMcp({ ctx, files });
      if (viaMcp.ok || !CFG.directAiFallback) return viaMcp;
      record('mcp', 'compile fallback to AI endpoint', 'warn', viaMcp.reason ?? 'mcp compile failed');
    } catch (e) {
      if (!CFG.directAiFallback) return { ok: false, reason: `mcp_compile_failed:${e.message.slice(0, 220)}` };
      record('mcp', 'compile fallback to AI endpoint', 'warn', e.message.slice(0, 220));
    }
  }

  return postCompileViaAiEngine({ slug, files, manifest });
}

async function captureMcpScreenshot(label) {
  if (!CFG.useMcpCompile) {
    record('FLOW', `${label} screenshot`, 'skip', 'MCP compile disabled');
    return null;
  }
  try {
    const state = await ensureMcpAttached();
    let lastShot = null;
    for (let attempt = 1; attempt <= 8; ++attempt) {
      await sleep(attempt === 1 ? 900 : 650);
      const shot = await state.client.toolCall(
        'synthi_screenshot',
        { max_dim: 640, freshness_max_ms: 5000 },
        20000,
      );
      lastShot = shot;
      if (shot?.data && (await screenshotLooksNonBlank(shot.data))) {
        const out = path.join(ARTIFACT_DIR, `${CFG.slug}-${label}.png`);
        await writeFile(out, Buffer.from(shot.data, 'base64'));
        record('FLOW', `${label} screenshot`, 'pass', attempt > 1 ? `${out} retry=${attempt}` : out);
        return out;
      }
    }
    if (lastShot?.data) {
      const out = path.join(ARTIFACT_DIR, `${CFG.slug}-${label}.png`);
      await writeFile(out, Buffer.from(lastShot.data, 'base64'));
      record('FLOW', `${label} screenshot`, 'warn', `saved final retry but frame looked blank: ${out}`);
      return out;
    }
    record('FLOW', `${label} screenshot`, 'warn', JSON.stringify(lastShot).slice(0, 180));
  } catch (e) {
    record('FLOW', `${label} screenshot`, 'warn', e.message.slice(0, 180));
  }
  return null;
}

async function screenshotLooksNonBlank(base64) {
  try {
    const sharp = (await import('sharp')).default;
    const stats = await sharp(Buffer.from(base64, 'base64')).stats();
    return stats.channels.some((c) => c.max >= 40 && c.mean >= 1.0);
  } catch {
    return true;
  }
}

async function postHeal({ slug, tier, error, manifest }) {
  try {
    const body = { slug, tier, error, manifest_gpu: manifest.gpu };
    const r = await fetch(`${CFG.aiEngineUrl}/refactor/heal/gpu`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
    if (r.status === 404) return { ok: false, reason: 'endpoint_not_implemented' };
    if (!r.ok) return { ok: false, reason: `status_${r.status}` };
    return { ok: true, body: await r.json() };
  } catch (e) {
    return { ok: false, reason: 'unreachable', error: e.message };
  }
}

// ───────────────────────── no-shim verifier (mirrors §11.4) ─────────────────────────

function levenshtein(a, b) {
  const dp = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0));
  for (let i = 0; i <= a.length; ++i) dp[i][0] = i;
  for (let j = 0; j <= b.length; ++j) dp[0][j] = j;
  for (let i = 1; i <= a.length; ++i) {
    for (let j = 1; j <= b.length; ++j) {
      dp[i][j] = a[i - 1] === b[j - 1] ? dp[i - 1][j - 1]
        : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
    }
  }
  return dp[a.length][b.length];
}

function canonicalManifestModule(moduleName, manifestFiles) {
  if (typeof moduleName !== 'string' || moduleName.trim() === '') return null;
  if (manifestFiles.includes(moduleName)) return moduleName;

  const normalized = moduleName.replaceAll('\\', '/');
  if (manifestFiles.includes(normalized)) return normalized;

  const extension = path.extname(normalized);
  if (extension) return null;

  const matches = manifestFiles.filter((file) => {
    const base = path.basename(file);
    return base.slice(0, base.length - path.extname(base).length) === normalized;
  });
  return matches.length === 1 ? matches[0] : null;
}

function verifyHealOutput(edits, manifestFiles, existingKernels) {
  const findings = [];
  for (const e of edits ?? []) {
    const canonicalModule = canonicalManifestModule(e.module, manifestFiles);
    if (!canonicalModule) {
      findings.push({ rule: 'no_new_files', detail: `module ${e.module} not in manifest` });
    }
    // Detect __global__ declarations in `content`
    const m = (e.content ?? '').match(/__global__\s+\w[\w<>,\s\*&]*\s+(\w+)\s*\(/);
    if (m) {
      const newSym = m[1];
      for (const k of existingKernels) {
        const suffixed = /^(.+)_(safe|v2|fallback|fixed|patched)$/.test(newSym);
        const dist = levenshtein(newSym, k);
        const nearMiss = dist > 0 && dist <= 3;
        if (suffixed || nearMiss || newSym.startsWith(`safe_${k}`) || newSym === `${k}_safe`) {
          findings.push({ rule: 'no_wrapper_kernel', detail: `${newSym} resembles ${k}` });
        }
      }
    }
    const targetModule = canonicalModule ?? e.module;
    if (!canonicalModule && /^[^.]+\.(cu|hip)$/.test(targetModule) && e.operation === 'create') {
      findings.push({ rule: 'no_new_device_file', detail: e.module });
    }
  }
  return { ok: findings.length === 0, findings };
}

function extractBufferPointers(logText) {
  const out = new Set();
  for (const m of (logText ?? '').matchAll(/(?:allocated|reused)\s+buffer\s+([A-Za-z0-9_]+)=0x([0-9a-fA-F]+)/g)) {
    out.add(`${m[1]}=0x${m[2]}`);
  }
  for (const m of (logText ?? '').matchAll(/registered buffer name=([A-Za-z0-9_]+)\s+ptr=0x([0-9a-fA-F]+)/g)) {
    out.add(`${m[1]}=0x${m[2]}`);
  }
  return [...out];
}

function latestNumber(logText, regex) {
  let latest = null;
  for (const m of (logText ?? '').matchAll(regex)) {
    latest = Number(m[1]);
  }
  return Number.isFinite(latest) ? latest : null;
}

function hasStatePreserved(logText) {
  return /state_preserved:\s*true/.test(logText ?? '');
}

function firstMatchingLine(logText, regex) {
  for (const line of String(logText ?? '').split(/\r?\n/)) {
    regex.lastIndex = 0;
    if (regex.test(line)) return line.trim();
  }
  return null;
}

function matchingLines(logText, regex) {
  const lines = [];
  for (const line of String(logText ?? '').split(/\r?\n/)) {
    regex.lastIndex = 0;
    if (regex.test(line)) lines.push(line.trim());
  }
  return lines;
}

function lastMatchingLine(logText, regex) {
  let latest = null;
  for (const line of String(logText ?? '').split(/\r?\n/)) {
    regex.lastIndex = 0;
    if (regex.test(line)) latest = line.trim();
  }
  return latest;
}

function launchArgProvenanceEvidence(logText, expectedKernels = []) {
  const kernelPattern = expectedKernels.length
    ? `(?:${expectedKernels.map(escapeRegex).join('|')})`
    : String.raw`\S+`;
  const lines = matchingLines(
    logText,
    new RegExp(String.raw`\[gpu-runtime-boundary\]\s+launch_arg_provenance\s+kernel=${kernelPattern}\b`),
  );
  let incompleteCount = 0;
  let unknownArgCount = 0;
  for (const line of lines) {
    const complete = /\bcomplete=true\b/.test(line);
    const unknown = Number(line.match(/\bunknown_args=(\d+)/)?.[1] ?? 0);
    unknownArgCount += Number.isFinite(unknown) ? unknown : 0;
    if (!complete || unknown > 0) incompleteCount += 1;
  }
  return {
    totalCount: lines.length,
    incompleteCount,
    unknownArgCount,
    complete: lines.length > 0 && incompleteCount === 0 && unknownArgCount === 0,
    lines,
  };
}

function summarizeLogLine(line) {
  return String(line ?? '').replace(/\s+/g, ' ').slice(0, 240);
}

function escapeRegex(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function kernelNamesFromSource(source) {
  const masked = String(source ?? '').replace(/\/\/[^\n\r]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
  const names = new Set();
  const kernelRe = /(?:extern\s+"C"\s+)?(?:__global__\s+(?:void\s+)?|GLOBAL_KERNEL_SIGNATURE\s*\([^)]*\)\s+(?:__launch_bounds__\s*\([^)]*\)\s*)?)([A-Za-z_][A-Za-z0-9_]*)\s*\(/g;
  for (const match of masked.matchAll(kernelRe)) {
    names.add(match[1]);
  }
  return [...names].sort();
}

function gpuHmrFallbackTelemetry(logText) {
  const label = lastMatchingLine(
    logText,
    /\bgpu-hmr-(partial|degraded-full-device|rejected|full-device)\b/,
  );
  const fallbackTrue = lastMatchingLine(logText, /\bfallbackUsed=true\b/);
  const fallbackFalse = lastMatchingLine(logText, /\bfallbackUsed=false\b/);
  const selected = lastMatchingLine(logText, /\bselectedArtifactKind=[^\s]+/);
  const latestPartial = label && /\bgpu-hmr-partial\b/.test(label);
  return {
    degraded: label && /\bgpu-hmr-degraded-full-device\b/.test(label)
      ? label
      : latestPartial
        ? null
        : fallbackTrue,
    rejected: label && /\bgpu-hmr-rejected\b/.test(label) ? label : null,
    label,
    fallbackTrue,
    fallbackFalse,
    selected,
  };
}

function summarizeGpuProof(proof) {
  if (!proof?.resultState) return 'gpu_proof=missing';
  const degraded = proof.degradedState ? ` degraded=${proof.degradedState}` : '';
  const reason = proof.degradedReason ? ` reason=${proof.degradedReason}` : '';
  const label = proof.label ? ` label=${proof.label}` : '';
  const proofId = proof.proofId ? ` proof_id=${proof.proofId}` : '';
  const proofPath = proof.proofArtifactPath ? ` proof_path=${proof.proofArtifactPath}` : '';
  return `gpu_proof=${proof.resultState}${degraded}${label}${reason}${proofId}${proofPath}`;
}

function recordGpuProof(phase, name, hmr) {
  const proof = hmr?.gpu_proof ?? null;
  const ok = typeof proof?.resultState === 'string' && proof.resultState.startsWith('gpu-hmr-');
  record(phase, name, ok ? 'pass' : 'fail', summarizeGpuProof(proof));
  return proof;
}

async function assertNoGpuHmrFallback(phase, name, checkpoint, maxBytes = 8 * 1024 * 1024) {
  const logOpts = checkpoint?.fileSize != null
    ? { fromOffset: checkpoint.fileSize }
    : checkpoint?.at
      ? { since: checkpoint.at }
      : {};
  const tail = await readWorkerLogTail(maxBytes, logOpts);
  const window = workerLogSearchWindow(tail, { after: checkpoint });
  const telemetry = gpuHmrFallbackTelemetry(window);
  if (telemetry.degraded) {
    record(phase, name, 'fail', `degraded fallback observed: ${summarizeLogLine(telemetry.degraded)}`);
    return telemetry;
  }
  if (telemetry.rejected) {
    record(phase, name, 'fail', `HMR rejection observed: ${summarizeLogLine(telemetry.rejected)}`);
    return telemetry;
  }
  if (telemetry.label && /\bgpu-hmr-full-device\b/.test(telemetry.label)) {
    record(phase, name, 'fail', `full-device compile observed after edit: ${summarizeLogLine(telemetry.label)}`);
    return telemetry;
  }
  if (telemetry.label || telemetry.fallbackFalse) {
    record(
      phase,
      name,
      'pass',
      summarizeLogLine(telemetry.label || telemetry.fallbackFalse || telemetry.selected),
    );
    return telemetry;
  }
  record(phase, name, 'fail', 'no gpu-hmr label or fallbackUsed telemetry found after edit');
  return telemetry;
}

async function awaitGpuDispatchOk(phase, name, checkpoint, expectedKernels = [], timeoutMs = 12000) {
  const maxBytes = 8 * 1024 * 1024;
  const kernelPattern = expectedKernels.length
    ? `(?:${expectedKernels.map(escapeRegex).join('|')})`
    : String.raw`\S+`;
  const dispatchRe = new RegExp(
    String.raw`\[gpu-runtime-boundary\]\s+synthi_gpu_launch\s+kernel=${kernelPattern}\b.*dispatch=(ok|failed|stale-pointer|missing-dispatcher)`,
  );
  const failureRe = new RegExp(
    String.raw`\[gpu-runtime-boundary\]\s+synthi_gpu_launch\s+kernel=${kernelPattern}\b.*dispatch=(failed|stale-pointer|missing-dispatcher)\b`,
  );
  const successRe = new RegExp(
    String.raw`\[gpu-runtime-boundary\]\s+synthi_gpu_launch\s+kernel=${kernelPattern}\b.*dispatch=ok\b`,
  );
  const dispatch = await awaitWorkerLogRegex(
    dispatchRe,
    timeoutMs,
    { after: checkpoint, maxBytes },
  );
  const window = dispatch.window ?? dispatch.tail ?? '';
  const failure = firstMatchingLine(window, failureRe);
  if (failure) {
    record(phase, name, 'fail', summarizeLogLine(failure));
    return false;
  }
  const success = firstMatchingLine(window, successRe);
  if (success) {
    record(phase, name, 'pass', summarizeLogLine(success));
    return true;
  }
  record(phase, name, 'fail', 'no successful GPU runtime dispatch observed after edit');
  return false;
}

async function awaitRuntimeDispatchProof(
  phase,
  name,
  checkpoint,
  expectedKernels = [],
  dispatchObserved = false,
  timeoutMs = 12000,
) {
  const maxBytes = 8 * 1024 * 1024;
  if (dispatchObserved) {
    const kernelPattern = expectedKernels.length
      ? `(?:${expectedKernels.map(escapeRegex).join('|')})`
      : String.raw`\S+`;
    await awaitWorkerLogRegex(
      new RegExp(String.raw`\[gpu-runtime-boundary\]\s+launch_arg_provenance\s+kernel=${kernelPattern}\b`),
      timeoutMs,
      { after: checkpoint, maxBytes },
    );
  }
  const logOpts = checkpoint?.fileSize != null
    ? { fromOffset: checkpoint.fileSize }
    : checkpoint?.at
      ? { since: checkpoint.at }
      : {};
  const tail = await readWorkerLogTail(maxBytes, logOpts);
  const window = workerLogSearchWindow(tail, { after: checkpoint });
  const provenance = launchArgProvenanceEvidence(window, expectedKernels);
  return recordRuntimeDispatchProof(phase, name, {
    dispatchObserved,
    sessionScoped: true,
    argProvenanceObserved: provenance.totalCount > 0,
    argProvenanceComplete: provenance.complete,
    unknownArgCount: provenance.unknownArgCount,
  });
}

function parseGuiReadbacks(logText) {
  const samples = [];
  const re = /\[gui\]\s+frame=(\d+)\s+c\[0\.\.7\]=([^\n\r]+)/g;
  for (const m of (logText ?? '').matchAll(re)) {
    const values = m[2].trim().split(/\s+/).map(Number);
    if (values.length < 8 || values.slice(0, 8).some((v) => !Number.isFinite(v))) continue;
    samples.push({
      frame: Number(m[1]),
      values: values.slice(0, 8),
      raw: m[0],
    });
  }
  return samples;
}

function readbackMatches(values, expected) {
  if (!Array.isArray(values) || values.length < expected.length) return false;
  return expected.every((want, i) => Math.abs(values[i] - want) <= 0.001);
}

function formatReadback(values) {
  return `[${(values ?? []).map((v) => Number.isFinite(v) ? Number(v).toFixed(3) : String(v)).join(', ')}]`;
}

async function awaitGuiReadback(phase, name, expected, checkpoint, timeoutMs = 12000) {
  const deadline = Date.now() + timeoutMs;
  const maxBytes = 8 * 1024 * 1024;
  const logOpts = checkpoint?.fileSize != null
    ? { fromOffset: checkpoint.fileSize }
    : checkpoint?.at
      ? { since: checkpoint.at }
      : {};
  let latest = null;
  while (Date.now() < deadline) {
    const tail = await readWorkerLogTail(maxBytes, logOpts);
    const window = workerLogSearchWindow(tail, { after: checkpoint });
    const samples = parseGuiReadbacks(window);
    for (let i = samples.length - 1; i >= 0; --i) {
      if (readbackMatches(samples[i].values, expected)) {
        record(
          phase,
          name,
          'pass',
          `frame=${samples[i].frame} values=${formatReadback(samples[i].values)}`,
        );
        return samples[i];
      }
    }
    if (samples.length) latest = samples[samples.length - 1];
    await sleep(500);
  }
  const detail = latest
    ? `latest frame=${latest.frame} values=${formatReadback(latest.values)} expected=${formatReadback(expected)}`
    : `no [gui] readback observed expected=${formatReadback(expected)}`;
  record(phase, name, 'fail', detail);
  throw new Error(`${phase} ${name}: ${detail}`);
}

// ───────────────────────── phases ─────────────────────────

async function preflight() {
  log('info', '── Preflight ──');
  const fe = parseUrl(CFG.frontendUrl);
  const col = parseUrl(CFG.collabUrl);
  const sig = parseUrl(CFG.signalingUrl);
  const ai = parseUrl(CFG.aiEngineUrl);
  const [feOk, colOk, sigOk, aiOk] = await Promise.all([
    tcpPing(fe.host, fe.port), tcpPing(col.host, col.port),
    tcpPing(sig.host, sig.port), tcpPing(ai.host, ai.port),
  ]);
  record('preflight', 'frontend reachable', feOk ? 'pass' : 'fail', CFG.frontendUrl);
  record('preflight', 'collab-server reachable', colOk ? 'pass' : 'fail', CFG.collabUrl);
  record('preflight', 'signaling reachable', sigOk ? 'pass' : 'warn', CFG.signalingUrl);
  record('preflight', 'ai-engine reachable', aiOk ? 'pass' : 'warn', CFG.aiEngineUrl);

  const ep = await aiEngineProbe();
  record('preflight', 'GPU endpoints present',
    ep.hasGpuEndpoints ? 'pass' : 'warn',
    JSON.stringify(ep.endpoints));

  const tc = await probeToolchain();
  record('preflight', 'nvcc on host', tc.host.nvcc ? 'pass' : 'skip', tc.host.nvcc ?? 'not found');
  record('preflight', 'hipcc on host', tc.host.hipcc ? 'pass' : 'skip', tc.host.hipcc ?? 'not found');
  if (tc.worker.nvcc !== undefined) {
    record('preflight', 'nvcc in worker', tc.worker.nvcc ? 'pass' : 'skip', tc.worker.nvcc ?? 'not found');
    record('preflight', 'hipcc in worker', tc.worker.hipcc ? 'pass' : 'skip', tc.worker.hipcc ?? 'not found');
    record('preflight', 'NVIDIA GPU visible in worker', tc.worker.nvidiaGpu ? 'pass' : 'skip', tc.worker.nvidiaGpu ?? 'not found');
    record('preflight', 'ROCm GPU visible in worker', tc.worker.rocmGpu ? 'pass' : 'skip', tc.worker.rocmGpu ?? 'not found');
    record('preflight', 'CUDA arch detected in worker', tc.worker.cudaArch ? 'pass' : 'skip', tc.worker.cudaArch ?? 'not found');
    record('preflight', 'ROCm arch detected in worker', tc.worker.rocmArch ? 'pass' : 'skip', tc.worker.rocmArch ?? 'not found');
    if (CFG.vendor === 'auto') {
      const detectedVendor = autoVendorFromToolchain(tc);
      record('preflight', 'auto GPU vendor detection',
        detectedVendor ? 'pass' : 'warn',
        detectedVendor ?? 'no vendor detected');
    }
  }

  record('preflight', 'SYNTHI_GPU_HMR flag', CFG.gpuHmr ? 'pass' : 'warn',
    CFG.gpuHmr ? 'enabled' : 'unset/0 — phases will be skipped or downgraded');

  return { feOk, colOk, sigOk, aiOk, ep, tc };
}

async function seedWorkspace(vendor, tc = null) {
  const fixture = activeFixture();
  const arch = archForVendor(vendor, tc);
  const m = manifestFor(vendor, fixture, arch);
  const deviceFilename = vendor === 'rocm' ? 'device.hip' : 'device.cu';
  const vectorSources = sourceSetForVendor(vendor, arch);
  const flowSources = flowSourceSetForVendor(vendor, arch);
  const sources = fixture === 'flow' ? flowSources : { shared: SHARED_H, ...vectorSources };
  const deviceContent = fixture === 'flow' ? FLOW_DEVICE_INWARD : DEVICE_CU_PHASE0;
  log('info', `Seeding workspace slug=${CFG.slug} vendor=${vendor} arch=${arch} fixture=${fixture}`);

  let ws;
  try {
    const suffix = fixture === 'flow' ? 'particle flow' : vendor;
    ws = await createWorkspace({ name: `${CFG.workspaceName} (${suffix})`, slug: CFG.slug });
  } catch (e) {
    record('seed', 'create workspace', 'fail', e.message.slice(0, 200));
    return null;
  }
  record('seed', 'create workspace', 'pass', `id=${ws.id} slug=${ws.slug}`);

  const files = [
    { path: 'shared.h', content: sources.shared },
    { path: 'core.cpp', content: sources.core },
    { path: 'gui.cpp', content: sources.gui },
    { path: 'host_runner.cpp', content: HOST_RUNNER_CPP },
    { path: deviceFilename, content: deviceSourceForPath(deviceFilename, deviceContent) },
    { path: '.synthi/build_manifest.json', content: JSON.stringify(m, null, 2) },
  ];

  const contract = verifySeedFixtureContract(files);
  record('seed', 'fixture uses Synthi GPU runtime contract',
    contract.ok ? 'pass' : 'fail',
    contract.ok ? 'synthi_gpu_launch + host identity + lifecycle exports' : contract.findings.join(', '));

  try {
    await writeFilesBatch({ slug: CFG.slug, userId: CFG.hostId, files, syncToGcs: CFG.syncToGcs });
    record('seed', 'write-files-batch (5 src + manifest)', 'pass', `${files.length} files`);
  } catch (e) {
    record('seed', 'write-files-batch (5 src + manifest)', 'fail', e.message.slice(0, 200));
    return null;
  }

  try {
    await stageAndCommit({ slug: CFG.slug, userId: CFG.hostId, message: 'gpu-hmr-test: seed' });
    record('seed', 'stage + commit', 'pass');
  } catch (e) {
    record('seed', 'stage + commit', 'warn', e.message.slice(0, 200));
  }

  // Read back the device file as a content-hash check.
  const got = await readFileViaCollab({ slug: CFG.slug, filePath: deviceFilename });
  const seedNeedle = fixture === 'flow' ? 'particle_flow' : 'vec_add';
  const seedOk = got != null && got.includes(seedNeedle);
  record('seed', `${deviceFilename} present in collab`, seedOk ? 'pass' : 'fail',
    got ? `${got.length} bytes` : 'not found');

  return {
    workspace: ws,
    manifest: m,
    deviceFilename,
    fixture,
    sourceFiles: new Map(files.map((f) => [f.path, f.content])),
  };
}

async function phaseFlow(ctx) {
  if (!shouldRun('FLOW')) return record('FLOW', 'phase skipped', 'skip', 'filter');
  if (ctx.fixture !== 'flow') {
    return record('FLOW', 'particle-flow fixture', 'skip',
      'set SYNTHI_GPU_HMR_FIXTURE=flow or ONLY_PHASES=FLOW');
  }
  if (!CFG.gpuHmr) return record('FLOW', 'particle-flow GPU HMR', 'skip', 'feature_flag_off');
  if (skipIfNoGpuToolchain('FLOW', ctx, 'particle-flow GPU HMR')) return;

  log('info', '── FLOW: live particle-flow GPU HMR validation ──');

  const baselineStart = await workerLogCheckpoint(8 * 1024 * 1024);
  const baseline = await postCompile({
    ctx,
    slug: CFG.slug,
    files: [{ path: ctx.deviceFilename, content: FLOW_DEVICE_INWARD }],
    manifest: ctx.manifest,
  });
  if (!baseline.ok) {
    return record('FLOW', 'inward compile dispatch', 'warn', baseline.reason);
  }
  record('FLOW', 'inward compile dispatch', 'pass');
  recordGpuProof('FLOW', 'inward truthful proof state', baseline.hmr);

  const baselineLaunch = await awaitWorkerLogRegex(
    /synthi_gpu_launch kernel=particle_flow|Device sidecar reload vendor=.*result=Success/,
    CFG.hmrTimeoutMs,
    { after: baselineStart, maxBytes: 8 * 1024 * 1024 },
  );
  record('FLOW', 'inward GPU launch observed',
    baselineLaunch.matched ? 'pass' : 'warn',
    baselineLaunch.snippet || 'no particle_flow launch marker');
  const inwardDispatchObserved = await awaitGpuDispatchOk(
    'FLOW',
    'inward GPU dispatch ok',
    baselineStart,
    kernelNamesFromSource(FLOW_DEVICE_INWARD),
  );
  const inwardDispatchProof = await awaitRuntimeDispatchProof(
    'FLOW',
    'inward dispatch provenance proof',
    baselineStart,
    kernelNamesFromSource(FLOW_DEVICE_INWARD),
    inwardDispatchObserved,
  );
  const inwardTrend = await awaitWorkerLogRegex(
    /\[gpu-flow-demo\].*trend=inward/,
    12000,
    { after: baselineStart, maxBytes: 8 * 1024 * 1024 },
  );
  record('FLOW', 'render loop reports inward flow',
    inwardTrend.matched ? 'pass' : 'warn',
    inwardTrend.snippet || 'inward trend not observed before timeout');

  const inwardScreenshot = await captureMcpScreenshot('flow-inward');
  recordRuntimeOutputProof('FLOW', 'inward output proof', {
    dispatchProof: inwardDispatchProof,
    deterministicOutputObserved: inwardTrend.matched,
    deterministicOracleProvided: true,
    deterministicOraclePassed: inwardTrend.matched,
    outputOracle: {
      kind: 'runtime_readback_trend',
      expected: 'inward',
      actual: inwardTrend.matched ? 'inward' : null,
      evidenceRefs: inwardTrend.snippet ? [inwardTrend.snippet] : [],
    },
    visualFrameObserved: Boolean(inwardScreenshot),
    visualEvidenceRefs: inwardScreenshot ? [inwardScreenshot] : [],
  });

  const flipStart = await workerLogCheckpoint(8 * 1024 * 1024);
  const flip = await postCompile({
    ctx,
    slug: CFG.slug,
    files: [{ path: ctx.deviceFilename, content: FLOW_DEVICE_OUTWARD }],
    manifest: ctx.manifest,
  });
  if (!flip.ok) {
    return record('FLOW', 'outward edit dispatch', 'warn', flip.reason);
  }
  record('FLOW', 'outward edit dispatch', 'pass');
  recordGpuProof('FLOW', 'outward truthful proof state', flip.hmr);

  const fastSwap = await awaitWorkerLogRegex(
    /\[gpu-reload\].*plan=device_only|state_preserved:\s*true|Device sidecar reload vendor=.*result=Success/,
    CFG.hmrTimeoutMs,
    { after: flipStart, maxBytes: 8 * 1024 * 1024 },
  );
  record('FLOW', 'outward device edit hot-swapped',
    fastSwap.matched ? 'pass' : 'warn',
    fastSwap.snippet || 'no device-only HMR marker');
  await assertNoGpuHmrFallback(
    'FLOW',
    'outward HMR has no full-device fallback',
    flipStart,
  );
  const outwardDispatchObserved = await awaitGpuDispatchOk(
    'FLOW',
    'outward GPU dispatch ok',
    flipStart,
    kernelNamesFromSource(FLOW_DEVICE_OUTWARD),
  );
  const outwardDispatchProof = await awaitRuntimeDispatchProof(
    'FLOW',
    'outward dispatch provenance proof',
    flipStart,
    kernelNamesFromSource(FLOW_DEVICE_OUTWARD),
    outwardDispatchObserved,
  );

  const trend = await awaitWorkerLogRegex(
    /\[gpu-flow-demo\].*trend=outward/,
    12000,
    { after: flipStart, maxBytes: 8 * 1024 * 1024 },
  );
  record('FLOW', 'render loop reports outward flow',
    trend.matched ? 'pass' : 'warn',
    trend.snippet || 'outward trend not observed before timeout');

  const outwardScreenshot = await captureMcpScreenshot('flow-outward');
  recordRuntimeOutputProof('FLOW', 'outward output proof', {
    dispatchProof: outwardDispatchProof,
    deterministicOutputObserved: trend.matched,
    deterministicOracleProvided: true,
    deterministicOraclePassed: trend.matched,
    outputOracle: {
      kind: 'runtime_readback_trend',
      expected: 'outward',
      actual: trend.matched ? 'outward' : null,
      evidenceRefs: trend.snippet ? [trend.snippet] : [],
    },
    visualFrameObserved: Boolean(outwardScreenshot),
    visualEvidenceRefs: outwardScreenshot ? [outwardScreenshot] : [],
  });
}

async function phaseP0(ctx) {
  if (!shouldRun('P0')) return record('P0', 'phase skipped', 'skip', 'SKIP_PHASES/ONLY_PHASES filter');
  if (!CFG.gpuHmr) return record('P0', 'toolchain smoke', 'skip', 'feature_flag_off');
  if (skipIfNoGpuToolchain('P0', ctx, 'toolchain smoke')) return;

  log('info', '── Phase P0: toolchain smoke ──');
  const p0LogStart = await workerLogCheckpoint(8 * 1024 * 1024);
  const compile = await postCompile({
    ctx,
    slug: CFG.slug,
    files: [{ path: ctx.deviceFilename, content: DEVICE_CU_PHASE0 }],
    manifest: ctx.manifest,
  });
  if (!compile.ok) {
    return record('P0', 'compile dispatch', 'warn',
      `${compile.reason}${compile.body ? ' body=' + compile.body.slice(0, 120) : ''}`);
  }
  record('P0', 'compile dispatch', 'pass');

  // Worker log assertions for §9.3.
  const sawNvcc = await awaitWorkerLogRegex(/compile-device.*(nvcc|hipcc)/i, 30000);
  record('P0', 'worker invokes device compiler', sawNvcc.matched ? 'pass' : 'warn',
    sawNvcc.snippet || 'no log marker (was worker.log path set?)');

  const sawCubin = await awaitWorkerLogRegex(
    /cuModuleLoadData ok|hipModuleLoad ok|kernels=\[|Device sidecar reload vendor=.*result=Success/,
    15000,
  );
  record('P0', 'gpu adapter loaded cubin/hsaco', sawCubin.matched ? 'pass' : 'warn',
    sawCubin.snippet || 'no marker');
  await awaitGpuDispatchOk(
    'P0',
    'baseline GPU dispatch ok',
    p0LogStart,
    kernelNamesFromSource(DEVICE_CU_PHASE0),
  );

  if (ctx.fixture === 'vector') {
    await awaitGuiReadback(
      'P0',
      'baseline numeric GPU readback',
      VECTOR_ADD_READBACK,
      p0LogStart,
    );
  }

  // ccache must NOT wrap nvcc/hipcc (§5.3 regression check).
  const tail = await readWorkerLogTail();
  const ccacheLeak = tail && /ccache\s+(nvcc|hipcc)/.test(tail);
  record('P0', 'device compiler not wrapped by ccache', !ccacheLeak ? 'pass' : 'fail',
    ccacheLeak ? 'ccache nvcc/hipcc found in worker.log' : 'clean');
}

async function phaseP1(ctx) {
  if (!shouldRun('P1')) return record('P1', 'phase skipped', 'skip', 'filter');
  if (!CFG.gpuHmr) return record('P1', 'cold reload buffer survival', 'skip', 'feature_flag_off');
  if (skipIfNoGpuToolchain('P1', ctx, 'cold reload buffer survival')) return;

  log('info', '── Phase P1: cold reload + buffer survival ──');
  // Record pre-edit buffer pointers from worker.log (P0 should have logged them).
  const preTail = await workerLogCheckpoint(8 * 1024 * 1024);
  const prePtrs = extractBufferPointers(preTail.tail);

  const compile = await postCompile({
    ctx,
    slug: CFG.slug,
    files: [{ path: ctx.deviceFilename, content: DEVICE_CU_PHASE1_EDIT }],
    manifest: ctx.manifest,
  });
  if (!compile.ok) {
    return record('P1', 'edit dispatch', 'warn', compile.reason);
  }
  record('P1', 'edit dispatch', 'pass');

  const reload = await awaitWorkerLogRegex(
    /\[gpu-reload\]\s+plan=(device_only|cold|host_only|mixed|abi_breaking)/,
    CFG.hmrTimeoutMs,
    { after: preTail, maxBytes: 8 * 1024 * 1024 });
  await assertNoGpuHmrFallback(
    'P1',
    'edit HMR has no full-device fallback',
    preTail,
  );
  await awaitGpuDispatchOk(
    'P1',
    'post-edit GPU dispatch ok',
    preTail,
    kernelNamesFromSource(DEVICE_CU_PHASE1_EDIT),
  );
  record('P1', 'reload plan emitted', reload.matched ? 'pass' : 'warn',
    reload.snippet || 'no plan marker — orchestrator not wired yet');

  if (ctx.fixture === 'vector') {
    await awaitGuiReadback(
      'P1',
      'post-edit numeric GPU readback',
      VECTOR_MUL_READBACK,
      preTail,
    );
  }

  const reused = await awaitWorkerLogRegex(
    /reused buffer\s+[A-Za-z0-9_]+=0x|state_preserved:\s*true/,
    10000,
    { after: preTail, maxBytes: 8 * 1024 * 1024 });
  const statePreserved = hasStatePreserved(reused.window) || hasStatePreserved(reused.tail);
  record('P1', 'buffer pointers reused across swap', reused.matched ? 'pass' : 'warn',
    reused.snippet || (statePreserved ? 'state_preserved=true' : 'no reuse marker'));

  // If we saw both pre and post pointer lines, assert at least one match.
  if (prePtrs.length > 0) {
    const postTail = await readWorkerLogTail(
      8 * 1024 * 1024,
      preTail.fileSize != null
        ? { fromOffset: preTail.fileSize }
        : preTail.at
          ? { since: preTail.at }
          : {},
    );
    const postPtrs = extractBufferPointers(workerLogSearchWindow(postTail, { after: preTail }));
    const overlap = prePtrs.filter((p) => postPtrs.includes(p));
    record('P1', 'pre/post pointer overlap',
      overlap.length >= 1 || statePreserved ? 'pass' : 'warn',
      overlap.length >= 1
        ? `pre=${prePtrs.length} post=${postPtrs.length} overlap=${overlap.length}`
        : `pre=${prePtrs.length} post=${postPtrs.length} overlap=${overlap.length} state_preserved=${statePreserved}`);
  } else {
    record('P1', 'pre/post pointer overlap',
      statePreserved ? 'pass' : 'skip',
      statePreserved ? 'state_preserved=true; no pre-edit pointer marker retained' : 'no pre-edit pointers in worker.log');
  }

  // §6.1 latency assertion — first edit may pay the full PCIe round trip,
  // but the second-edit-onward must stay inside SYNTHI_GPU_SNAPSHOT_BUDGET_MS*2
  // because dirty-bit accounting should have flagged most buffers clean.
  const snapTelemetry = await awaitWorkerLogRegex(
    /gpu_snapshot_telemetry.*snapshot_ms=(\d+).*snapshot_bytes=(\d+)/,
    10000,
    { after: preTail, maxBytes: 8 * 1024 * 1024 });
  if (snapTelemetry.matched) {
    const ms = Number((snapTelemetry.snippet.match(/snapshot_ms=(\d+)/) ?? [])[1]);
    const bytes = Number((snapTelemetry.snippet.match(/snapshot_bytes=(\d+)/) ?? [])[1]);
    const budget = CFG.snapshotBudgetMs * 2; // first-edit allowance
    record('P1', `snapshot latency within ${budget}ms`,
      ms <= budget ? 'pass' : 'fail',
      `snapshot_ms=${ms}  bytes=${(bytes / (1<<20)).toFixed(1)}MiB`);

    // Tier reporting — we want Tier B telemetry to surface the tier in use
    const tierMatch = (await readWorkerLogTail() ?? '').match(/snapshot_tier=([AB])/);
    if (tierMatch) {
      record('P1', 'snapshot tier reported', 'pass', `tier=${tierMatch[1]}`);
    }
  } else {
    record('P1', 'snapshot latency telemetry', 'warn',
      'no gpu_snapshot_telemetry log line — §6.1 mitigations not wired yet');
  }

  // Second-edit pass: tighter budget. Apply the same edit twice (identity);
  // dirty-bit accounting should mark every buffer clean → near-zero snapshot.
  const secondLogStart = await workerLogCheckpoint(8 * 1024 * 1024);
  const second = await postCompile({
    ctx,
    slug: CFG.slug,
    files: [{ path: ctx.deviceFilename, content: DEVICE_CU_PHASE1_EDIT }],
    manifest: ctx.manifest,
  });
  if (second.ok) {
    const second2 = await awaitWorkerLogRegex(
      /gpu_snapshot_telemetry.*snapshot_ms=(\d+).*snapshot_bytes=(\d+)/,
      10000,
      { after: secondLogStart, maxBytes: 8 * 1024 * 1024 });
    if (second2.matched) {
      // Walk back to find the LAST telemetry line (the second-edit one).
      const all = [...(second2.window ?? '').matchAll(/snapshot_ms=(\d+).*?snapshot_bytes=(\d+)/g)];
      const last = all[all.length - 1];
      if (last) {
        const ms = Number(last[1]);
        const budget = CFG.snapshotBudgetMs;
        record('P1', `2nd-edit snapshot within tight budget (${budget}ms)`,
          ms <= budget ? 'pass' : 'fail',
          `snapshot_ms=${ms}  (dirty-bit accounting should skip clean buffers — §6.1.2)`);
      }
    }
  }
}

async function phaseP2(ctx) {
  if (!shouldRun('P2')) return record('P2', 'phase skipped', 'skip', 'filter');
  if (!CFG.gpuHmr) return record('P2', 'fast device swap', 'skip', 'feature_flag_off');
  if (skipIfNoGpuToolchain('P2', ctx, 'fast device swap')) return;

  log('info', '── Phase P2: fast device-only swap + ABI-breaking classifier ──');

  // Fast path
  const fastLogStart = await workerLogCheckpoint(8 * 1024 * 1024);
  const tFast0 = Date.now();
  const fast = await postCompile({
    ctx,
    slug: CFG.slug,
    files: [{ path: ctx.deviceFilename, content: DEVICE_CU_PHASE2_FAST }],
    manifest: ctx.manifest,
  });
  if (!fast.ok) {
    record('P2', 'fast-swap dispatch', 'warn', fast.reason);
  } else {
    record('P2', 'fast-swap dispatch', 'pass');
    const fastDone = await awaitWorkerLogRegex(
      /\[gpu-reload\].*plan=device_only/,
      CFG.hmrTimeoutMs,
      { after: fastLogStart, maxBytes: 8 * 1024 * 1024 });
    if (fastDone.matched) {
      const metricWindow = fastDone.window ?? fastDone.tail ?? '';
      const totalMs = latestNumber(metricWindow, /total_ms=(\d+)/g);
      const reloadMs = latestNumber(metricWindow, /reload_ms[:=]\s*(\d+)/g);
      const snapshotMs = latestNumber(metricWindow, /snapshot_ms=(\d+)/g);
      const ms = totalMs ?? reloadMs ?? snapshotMs ?? (Date.now() - tFast0);
      const within = ms <= CFG.fastSwapBudgetMs;
      record('P2', `fast swap within budget (${CFG.fastSwapBudgetMs}ms)`,
        within ? 'pass' : 'warn',
        `${totalMs !== null ? 'total_ms' : reloadMs !== null ? 'reload_ms' : snapshotMs !== null ? 'snapshot_ms' : 'wall_ms'}=${ms}`);
    } else {
      record('P2', `fast swap within budget (${CFG.fastSwapBudgetMs}ms)`, 'warn',
        `no plan=device_only marker (wall=${Date.now() - tFast0}ms)`);
    }
    await assertNoGpuHmrFallback(
      'P2',
      'fast-swap HMR has no full-device fallback',
      fastLogStart,
    );
    await awaitGpuDispatchOk(
      'P2',
      'fast-swap GPU dispatch ok',
      fastLogStart,
      kernelNamesFromSource(DEVICE_CU_PHASE2_FAST),
    );
    if (ctx.fixture === 'vector') {
      await awaitGuiReadback(
        'P2',
        'fast-swap numeric GPU readback',
        VECTOR_MUL_READBACK,
        fastLogStart,
      );
    }
  }

  // ABI-shaped edit. A kernel parameter-list change must be classified before
  // the sidecar fast-swap path so the runtime cold-loads and calls device_on_load.
  const abiLogStart = await workerLogCheckpoint(8 * 1024 * 1024);
  const abi = await postCompile({
    ctx,
    slug: CFG.slug,
    files: [{ path: ctx.deviceFilename, content: DEVICE_CU_PHASE2_ABI_BREAK }],
    manifest: ctx.manifest,
  });
  if (!abi.ok) {
    record('P2', 'abi-break dispatch', 'warn', abi.reason);
  } else {
    record('P2', 'abi-break dispatch', 'pass');
    const abiReload = await awaitWorkerLogRegex(
      /plan=abi_breaking|cold_reload reason=abi_breaking|device_on_load invoked/i,
      CFG.hmrTimeoutMs,
      { after: abiLogStart, maxBytes: 8 * 1024 * 1024 });
    record('P2', 'ABI edit emits abi_breaking cold reload',
      abiReload.matched ? 'pass' : 'fail',
      abiReload.snippet || 'no abi_breaking marker');
  }
}

async function phaseP3Heal(ctx) {
  if (!shouldRun('P3-heal')) return record('P3-heal', 'phase skipped', 'skip', 'filter');
  if (!CFG.gpuHmr) return record('P3-heal', 'healer drills', 'skip', 'feature_flag_off');
  if (skipIfNoGpuToolchain('P3-heal', ctx, 'healer drills')) return;

  log('info', '── Phase P3-heal: three-tier healer drills ──');

  const drills = [
    { tier: 'compile_hard', name: 'Tier 1 (compile hard, missing __shfl_down_sync)', body: DEVICE_CU_HEAL_T1 },
    { tier: 'compile_soft', name: 'Tier 2 (register pressure / spills)',              body: DEVICE_CU_HEAL_T2 },
    { tier: 'runtime',      name: 'Tier 3 (illegal address: out-of-bounds index)',    body: DEVICE_CU_HEAL_T3 },
  ];

  for (const d of drills) {
    log('info', `─ drill: ${d.name}`);
    // 1. inject pathological code
    const inject = await postCompile({
      ctx,
      slug: CFG.slug,
      files: [{ path: ctx.deviceFilename, content: d.body }],
      manifest: ctx.manifest,
    });
    if (!inject.ok) {
      record('P3-heal', `${d.name}: inject`, 'warn', inject.reason);
      continue;
    }
    record('P3-heal', `${d.name}: inject`, 'pass');

    // 2. ask heal endpoint to patch
    const heal = await postHeal({
      slug: CFG.slug,
      tier: d.tier,
      error: { kind: d.tier === 'compile_hard' ? 'nvcc_undefined_identifier'
                   : d.tier === 'compile_soft' ? 'ptxas_register_pressure'
                   : 'cudaErrorIllegalAddress' },
      manifest: ctx.manifest,
    });
    if (!heal.ok) {
      record('P3-heal', `${d.name}: heal endpoint`, 'warn', heal.reason);
      continue;
    }
    record('P3-heal', `${d.name}: heal endpoint`, 'pass',
      `edits=${heal.body?.edits?.length ?? 0}`);

    // 3. apply no-shim verifier rules locally
    const verify = verifyHealOutput(
      heal.body?.edits ?? [],
      ctx.manifest.files,
      ['vec_add'],
    );
    record('P3-heal', `${d.name}: no-shim verifier`,
      verify.ok ? 'pass' : 'fail',
      verify.ok ? 'clean' : verify.findings.map((f) => `${f.rule}:${f.detail}`).join('; '));

    // 4. assert no new device file
    const hasNewDeviceFile = (heal.body?.edits ?? []).some((e) =>
      /\.(cu|hip)$/.test(e.module) && e.module !== ctx.deviceFilename && e.operation === 'create');
    record('P3-heal', `${d.name}: no new device files`,
      !hasNewDeviceFile ? 'pass' : 'fail',
      hasNewDeviceFile ? 'create operation on new .cu/.hip' : 'clean');
  }
}

async function phaseP3Mixed(ctx) {
  if (!shouldRun('P3-mixed')) return record('P3-mixed', 'phase skipped', 'skip', 'filter');
  if (!CFG.gpuHmr) return record('P3-mixed', 'mixed reload', 'skip', 'feature_flag_off');
  if (skipIfNoGpuToolchain('P3-mixed', ctx, 'mixed reload')) return;

  log('info', '── Phase P3-mixed: host + device edit in one batch ──');
  // Edit both core.cpp (touch host launch) and device.cu (touch kernel) together.
  const editedCore = (ctx.sourceFiles.get('core.cpp') ?? CORE_CPP).replace(
    'g_state->accumulator += 1.0;',
    'g_state->accumulator += 2.5;   // P3-mixed: accumulator must survive',
  );
  const compile = await postCompile({
    ctx,
    slug: CFG.slug,
    files: [
      { path: 'core.cpp',           content: editedCore },
      { path: ctx.deviceFilename,   content: DEVICE_CU_PHASE2_FAST },
    ],
    manifest: ctx.manifest,
  });
  if (!compile.ok) return record('P3-mixed', 'dispatch', 'warn', compile.reason);
  record('P3-mixed', 'dispatch', 'pass');

  const seq = await awaitWorkerLogRegex(
    /device_save[\s\S]{0,200}host_swap[\s\S]{0,200}device_swap[\s\S]{0,200}device_restore/,
    CFG.hmrTimeoutMs);
  record('P3-mixed', 'orchestrator step sequence',
    seq.matched ? 'pass' : 'warn',
    seq.matched ? 'save→host_swap→device_swap→restore observed' : 'sequence not found');

  const onLoad = await awaitWorkerLogRegex(/device_on_load\s+(called|invoked|ok)/, 5000);
  record('P3-mixed', 'device_on_load invoked exactly once',
    onLoad.matched ? 'pass' : 'warn', onLoad.snippet);
}

async function phaseP3StreamHang(ctx) {
  if (!shouldRun('P3-stream-hang')) return record('P3-stream-hang', 'phase skipped', 'skip', 'filter');
  if (!CFG.gpuHmr) return record('P3-stream-hang', 'stream hang watchdog', 'skip', 'feature_flag_off');
  if (skipIfNoGpuToolchain('P3-stream-hang', ctx, 'stream hang watchdog')) return;

  log('info', '── Phase P3-stream-hang: watchdog + drain timeout ──');
  // Inject a kernel guaranteed to spin.
  const hangBody = `
extern "C" __global__ void vec_add(const float* a, const float* b, float* c, int n) {
    volatile int x = 0;
    while (x == 0) { /* spin until something the compiler can't prove changes */ }
    int i = blockIdx.x * blockDim.x + threadIdx.x;
    if (i < n) c[i] = a[i] + b[i];
}
`;
  const compile = await postCompile({
    ctx,
    slug: CFG.slug,
    files: [{ path: ctx.deviceFilename, content: hangBody }],
    manifest: ctx.manifest,
  });
  if (!compile.ok) return record('P3-stream-hang', 'inject hang dispatch', 'warn', compile.reason);
  record('P3-stream-hang', 'inject hang dispatch', 'pass');

  const watchTimeout = CFG.watchdogMs + 3000;
  const hangEvt = await awaitWorkerLogRegex(/STREAM_HANG|stream_hang/, watchTimeout);
  record('P3-stream-hang', `watchdog synthesizes STREAM_HANG within ${CFG.watchdogMs}ms (+slack)`,
    hangEvt.matched ? 'pass' : 'warn', hangEvt.snippet);

  const drainTimeout = CFG.drainTimeoutMs + 2000;
  const drain = await awaitWorkerLogRegex(/drain timeout|drain_timeout|cold[- ]restart/, drainTimeout);
  record('P3-stream-hang', 'drain timeout → cold restart fallback',
    drain.matched ? 'pass' : 'warn', drain.snippet);
}

// ───────────────────────── main ─────────────────────────

async function main() {
  await resolveDockerContainers();

  console.log(color.blue + '\n━━━ Synthi GPU-HMR live test ━━━' + color.reset);
  console.log(`  slug         ${CFG.slug}`);
  console.log(`  vendor       ${CFG.vendor}`);
  console.log(`  fixture      ${activeFixture()}`);
  console.log(`  gpu-hmr flag ${CFG.gpuHmr}`);
  console.log(`  mcp compile  ${CFG.useMcpCompile ? `${CFG.mcpTransport}:${CFG.mcpContainer}` : 'disabled'}`);
  console.log(`  worker log   ${CFG.workerLogPath}`);
  console.log('');

  await mkdir(LOG_DIR, { recursive: true });
  await mkdir(ARTIFACT_DIR, { recursive: true });

  const pre = await preflight();
  if (CFG.useMcpCompile) {
    try {
      await startMcp();
    } catch (e) {
      record('preflight', 'MCP initialize/tools-list', 'warn', e.message.slice(0, 220));
    }
  }
  // Hard-blockers: workspace + collab must be reachable to do anything useful.
  if (!pre.feOk || !pre.colOk) {
    log('fail', 'frontend or collab unreachable — cannot seed workspace; exiting with FAIL summary');
    await writeSummary();
    await stopMcp();
    process.exit(1);
  }

  const vendors = vendorsForConfig(pre.tc);
  for (const vendor of vendors) {
    log('info', `── Vendor: ${vendor} ──`);
    const ctx = await seedWorkspace(vendor, pre.tc);
    if (!ctx) {
      record(`seed:${vendor}`, 'seed failed; skipping phases', 'fail');
      continue;
    }
    ctx.vendor = vendor;
    ctx.toolchain = toolchainForVendor(pre.tc, vendor);
    record(`vendor:${vendor}`, 'GPU toolchain gate',
      ctx.toolchain.ok ? 'pass' : 'skip',
      ctx.toolchain.ok ? `${ctx.toolchain.source}:${ctx.toolchain.path}` : ctx.toolchain.reason);
    // Phases run sequentially because they share the same workspace state.
    if (ctx.fixture === 'flow') {
      try { await phaseFlow(ctx); }          catch (e) { record('FLOW',          'unexpected throw', 'fail', e.message.slice(0, 200)); }
    } else {
      try { await phaseP0(ctx); }            catch (e) { record('P0',            'unexpected throw', 'fail', e.message.slice(0, 200)); }
      try { await phaseP1(ctx); }            catch (e) { record('P1',            'unexpected throw', 'fail', e.message.slice(0, 200)); }
      try { await phaseP2(ctx); }            catch (e) { record('P2',            'unexpected throw', 'fail', e.message.slice(0, 200)); }
      try { await phaseP3Mixed(ctx); }       catch (e) { record('P3-mixed',      'unexpected throw', 'fail', e.message.slice(0, 200)); }
      try { await phaseP3Heal(ctx); }        catch (e) { record('P3-heal',       'unexpected throw', 'fail', e.message.slice(0, 200)); }
      try { await phaseP3StreamHang(ctx); }  catch (e) { record('P3-stream-hang','unexpected throw', 'fail', e.message.slice(0, 200)); }
    }
  }

  await writeSummary();
  await stopMcp();
}

async function writeSummary() {
  console.log('');
  console.log(color.blue + '━━━ GPU HMR test summary ━━━' + color.reset);
  const passed = results.filter((r) => r.status === 'pass').length;
  const warned = results.filter((r) => r.status === 'warn').length;
  const failed = results.filter((r) => r.status === 'fail').length;
  const skipped = results.filter((r) => r.status === 'skip').length;
  console.log(`  Checked ${results.length}: ${color.green}${passed} PASS${color.reset}  ${color.yellow}${warned} WARN${color.reset}  ${color.red}${failed} FAIL${color.reset}  ${color.dim}${skipped} SKIP${color.reset}`);

  // Phase headline
  const phases = ['FLOW', 'P0', 'P1', 'P2', 'P3-mixed', 'P3-heal', 'P3-stream-hang'];
  const headline = phases.map((p) => {
    const rows = results.filter((r) => r.phase === p);
    if (rows.length === 0) return `${p} -`;
    if (rows.some((r) => r.status === 'fail')) return `${p} ✗`;
    if (rows.every((r) => r.status === 'skip')) return `${p} ⊝`;
    if (rows.every((r) => r.status === 'pass')) return `${p} ✓`;
    return `${p} ~`;
  }).join('  ');
  console.log(`  Phases: ${headline}`);

  if (failed + warned > 0) {
    console.log('');
    for (const r of results.filter((r) => r.status === 'fail' || r.status === 'warn')) {
      const tag = r.status === 'fail' ? color.red + 'FAIL' : color.yellow + 'WARN';
      console.log(`  ${tag}${color.reset}  [${r.phase}] ${r.name}${r.detail ? ' — ' + r.detail : ''}`);
    }
  }

  const summary = {
    slug: CFG.slug,
    vendor: CFG.vendor,
    fixture: activeFixture(),
    gpu_hmr_flag: CFG.gpuHmr,
    run_at: new Date().toISOString(),
    config: {
      fastSwapBudgetMs: CFG.fastSwapBudgetMs,
      watchdogMs: CFG.watchdogMs,
      drainTimeoutMs: CFG.drainTimeoutMs,
    },
    summary: { total: results.length, passed, warned, failed, skipped },
    runtime_dispatch_proofs: runtimeDispatchProofs,
    runtime_output_proofs: runtimeOutputProofs,
    results,
  };
  await writeFile(path.join(LOG_DIR, 'results.json'), JSON.stringify(summary, null, 2));
  const txt = results.map((r) =>
    `${r.status.toUpperCase().padEnd(5)}  [${r.phase}] ${r.name}${r.detail ? '  — ' + r.detail : ''}`
  ).join('\n') + '\n';
  await writeFile(path.join(LOG_DIR, 'results.txt'), txt);

  console.log('');
  console.log(`  Artifacts: ${ARTIFACT_DIR}`);
  console.log(`  Logs:      ${LOG_DIR}`);
  console.log(`  Results:   ${path.join(LOG_DIR, 'results.json')}`);

  process.exitCode = failed > 0 ? 1 : 0;
}

async function selfCheck() {
  const vectorFiles = [
    { path: 'shared.h', content: SHARED_H },
    { path: 'core.cpp', content: CORE_CPP },
    { path: 'gui.cpp', content: GUI_CPP },
    { path: 'host_runner.cpp', content: HOST_RUNNER_CPP },
    { path: 'device.cu', content: DEVICE_CU_PHASE0 },
    { path: '.synthi/build_manifest.json', content: JSON.stringify(manifestFor('cuda', 'vector', 'sm_80'), null, 2) },
  ];
  const flowFiles = [
    { path: 'shared.h', content: FLOW_SHARED_H },
    { path: 'core.cpp', content: FLOW_CORE_CPP },
    { path: 'gui.cpp', content: FLOW_GUI_CPP },
    { path: 'host_runner.cpp', content: HOST_RUNNER_CPP },
    { path: 'device.cu', content: FLOW_DEVICE_INWARD },
    { path: '.synthi/build_manifest.json', content: JSON.stringify(manifestFor('cuda', 'flow', 'sm_80'), null, 2) },
  ];
  const vectorContract = verifySeedFixtureContract(vectorFiles);
  const flowContract = verifySeedFixtureContract(flowFiles);
  if (!vectorContract.ok || !flowContract.ok) {
    const findings = [
      ...vectorContract.findings.map((f) => `vector:${f}`),
      ...flowContract.findings.map((f) => `flow:${f}`),
    ];
    console.error(`gpu-hmr-test self-check failed: ${findings.join(', ')}`);
    process.exitCode = 1;
    return;
  }
  const sampleReadback = parseGuiReadbacks('[gui] frame=7 c[0..7]=0 3 6 9 12 15 18 21\n');
  if (!readbackMatches(sampleReadback[0]?.values, VECTOR_ADD_READBACK)) {
    console.error('gpu-hmr-test self-check failed: readback parser did not match vector baseline');
    process.exitCode = 1;
    return;
  }
  const partialTelemetry = gpuHmrFallbackTelemetry(
    '[compile-device] reload package label=gpu-hmr-partial fallbackUsed=false selectedArtifactKind=source_include_bridge\n',
  );
  const proofSummary = summarizeGpuProof({
    resultState: 'gpu-hmr-symbol-bound',
    degradedState: 'gpu-hmr-dispatch-unobserved',
    degradedReason: 'runtime_dispatch_not_observed',
    label: 'gpu-hmr-partial',
  });
  const degradedTelemetry = gpuHmrFallbackTelemetry(
    '[compile-device] reload package label=gpu-hmr-degraded-full-device fallbackUsed=true fallbackReason=partial_compile_failed selectedArtifactKind=full_device\n',
  );
  if (
    !partialTelemetry.label ||
    partialTelemetry.degraded ||
    !degradedTelemetry.degraded ||
    !proofSummary.includes('gpu-hmr-symbol-bound') ||
    !proofSummary.includes('gpu-hmr-dispatch-unobserved')
  ) {
    console.error('gpu-hmr-test self-check failed: fallback telemetry parser did not classify labels');
    process.exitCode = 1;
    return;
  }
  const dispatchOk = firstMatchingLine(
    '[gpu-runtime-boundary] synthi_gpu_launch kernel=any grid=(1, 1, 1) block=(1, 1, 1) args=1 stream=0 shared_bytes=0 dispatch=ok\n',
    /\[gpu-runtime-boundary\]\s+synthi_gpu_launch\s+kernel=\S+.*dispatch=ok\b/,
  );
  const dispatchFailed = firstMatchingLine(
    '[gpu-runtime-boundary] synthi_gpu_launch kernel=any grid=(1, 1, 1) block=(1, 1, 1) args=1 stream=0 shared_bytes=0 dispatch=failed error=cuLaunchKernel returned 1\n',
    /\[gpu-runtime-boundary\]\s+synthi_gpu_launch\s+kernel=\S+.*dispatch=(failed|stale-pointer|missing-dispatcher)\b/,
  );
  const vectorKernels = kernelNamesFromSource(DEVICE_CU_PHASE0);
  const flowKernels = kernelNamesFromSource(FLOW_DEVICE_INWARD);
  if (
    !dispatchOk
    || !dispatchFailed
    || vectorKernels.join(',') !== 'vec_add'
    || flowKernels.join(',') !== 'particle_flow'
  ) {
    console.error('gpu-hmr-test self-check failed: dispatch telemetry parser did not classify launch status');
    process.exitCode = 1;
    return;
  }
  const outputProof = classifyGpuHmrOutputProof({
    dispatchSafeProven: true,
    visualFrameObserved: true,
  });
  const dispatchProof = classifyGpuHmrDispatchProof({
    dispatchObserved: true,
    sessionScoped: true,
    argProvenanceObserved: true,
    argProvenanceComplete: true,
    abiProven: true,
    epochSwapProven: true,
    streamOrderingProven: true,
    replacementScopeProven: true,
  });
  const unknownArgDispatchProof = classifyGpuHmrDispatchProof({
    dispatchObserved: true,
    sessionScoped: true,
    argProvenanceObserved: true,
    argProvenanceComplete: false,
    unknownArgCount: 1,
  });
  if (
    outputProof.resultState !== 'gpu-hmr-dispatch-safe-proven'
    || outputProof.degradedState !== 'gpu-hmr-visual-only'
    || dispatchProof.degradedState !== null
    || unknownArgDispatchProof.degradedState !== 'gpu-hmr-unknown-arg-provenance'
  ) {
    console.error('gpu-hmr-test self-check failed: dispatch/output proof classifier failed');
    process.exitCode = 1;
    return;
  }
  console.log('gpu-hmr-test self-check passed: fixtures use Synthi GPU runtime contract');
}

const entry = process.argv.includes('--self-check') ? selfCheck : main;
entry().catch((e) => {
  console.error(color.red + '\nFATAL: ' + color.reset + (e.stack ?? e.message));
  process.exit(1);
});
