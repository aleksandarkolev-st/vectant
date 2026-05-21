#!/usr/bin/env node
// Real public ROCm repository validation for GPU HMR.
//
// Default target:
//   https://github.com/ROCm/rocm-examples
//   HIP-Basic/saxpy/main.hip
//
// This script intentionally separates two claims:
//   1. The upstream ROCm target builds and runs in the current worker.
//   2. Synthi can consume the real repo files and apply GPU split/HMR.

import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '../../..');

const CFG = {
  repoUrl: process.env.SYNTHI_REAL_ROCM_REPO_URL ?? 'https://github.com/ROCm/rocm-examples.git',
  repoPath: path.resolve(REPO_ROOT, process.env.SYNTHI_REAL_ROCM_REPO_PATH ?? 'tmp/real-rocm/rocm-examples'),
  entryFile: process.env.SYNTHI_REAL_ROCM_ENTRY ?? 'HIP-Basic/saxpy/main.hip',
  targetName: process.env.SYNTHI_REAL_ROCM_TARGET ?? 'hip_saxpy',
  buildSubdir: process.env.SYNTHI_REAL_ROCM_BUILD_SUBDIR ?? 'HIP-Basic/saxpy',
  workerRepoPath: process.env.SYNTHI_REAL_ROCM_WORKER_PATH ?? '/tmp/synthi-real-rocm/rocm-examples',
  maxFileBytes: Number(process.env.SYNTHI_REAL_ROCM_MAX_FILE_BYTES ?? 512 * 1024),
  writeBatchSize: Number(process.env.SYNTHI_REAL_ROCM_WRITE_BATCH_SIZE ?? 200),
  slug: process.env.SLUG ?? `gpu-real-rocm-${new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14)}`,
  frontendUrl: process.env.FRONTEND_URL ?? 'http://localhost:3000',
  collabUrl: process.env.COLLAB_URL ?? 'http://localhost:1234',
  signalingUrl: process.env.SIGNALING_URL ?? 'ws://localhost:9000',
  hostId: process.env.HOST_ID ?? 'gpu-hmr-real-rocm-validation',
  mcpContainer: process.env.MCP_CONTAINER ?? 'vectant-ade-mcp-1',
  workerContainer: process.env.WORKER_CONTAINER ?? 'vectant-ade-worker-1',
  aiEngineContainer: process.env.AI_ENGINE_CONTAINER ?? 'vectant-ade-ai-engine-1',
  mcpTransport: (process.env.MCP_TRANSPORT ?? 'docker').toLowerCase(),
  mcpEntry: path.resolve(__dirname, process.env.MCP_ENTRY ?? '../dist/index.js'),
  mcpSignalingUrl: process.env.MCP_SIGNALING_URL ?? 'ws://signaling-server:9000',
  mcpRequestTimeoutMs: Number(process.env.MCP_REQUEST_TIMEOUT_MS ?? 300000),
  mcpAttachTimeoutMs: Number(process.env.MCP_ATTACH_TIMEOUT_MS ?? 30000),
  firstCompileTimeoutMs: Number(process.env.SYNTHI_REAL_ROCM_FIRST_TIMEOUT_MS ?? 300000),
  hmrTimeoutMs: Number(process.env.SYNTHI_REAL_ROCM_HMR_TIMEOUT_MS ?? 90000),
  screenshotAttempts: Number(process.env.SYNTHI_REAL_ROCM_SCREENSHOT_ATTEMPTS ?? 3),
  screenshotFreshnessMaxMs: Number(process.env.SYNTHI_REAL_ROCM_SCREENSHOT_FRESHNESS_MS ?? 5000),
  gpuArch: process.env.SYNTHI_GPU_ARCH ?? 'gfx1201',
  googleApiKey: process.env.GOOGLE_API_KEY ?? process.env.GEMINI_API_KEY ?? '',
  geminiModel: process.env.SYNTHI_GEMINI_MODEL ?? 'gemini-3.1-flash-lite-preview',
  syncToGcs: process.env.SYNTHI_SYNC_TO_GCS === '1',
};

const LOG_DIR = path.resolve(__dirname, '../.gpu-hmr-test-logs');
const ARTIFACT_DIR = path.resolve(__dirname, '../.gpu-hmr-test-artifacts');
const RESULTS_JSON = path.join(LOG_DIR, 'real-rocm-results.json');
const RESULTS_TXT = path.join(LOG_DIR, 'real-rocm-results.txt');

const report = {
  slug: CFG.slug,
  source_url: CFG.repoUrl,
  repo_path: CFG.repoPath,
  repo_commit: null,
  entry_file: CFG.entryFile,
  target_name: CFG.targetName,
  gpu_arch: CFG.gpuArch,
  file_count: 0,
  seeded_file_count: 0,
  skipped_file_count: 0,
  checks: [],
  phases: [],
  screenshots: [],
  logs: {},
  started_at: new Date().toISOString(),
  finished_at: null,
};

function record(name, status, detail = '') {
  const row = { name, status, detail, ts: new Date().toISOString() };
  report.checks.push(row);
  const tag = status === 'pass' ? '[ok]' : status === 'fail' ? '[fail]' : status === 'warn' ? '[warn]' : '[info]';
  console.log(`${tag} ${name}${detail ? ` - ${detail}` : ''}`);
}

function execText(cmd, args, timeoutMs = 30000, rejectOnError = false, opts = {}) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: timeoutMs, maxBuffer: 256 * 1024 * 1024, ...opts }, (err, stdout, stderr) => {
      const text = `${stdout ?? ''}${stderr ?? ''}`.trim();
      if (err && rejectOnError) {
        err.output = text;
        reject(err);
        return;
      }
      resolve(err ? undefined : text);
    });
  });
}

async function httpJson(method, url, body, headers = {}) {
  const res = await fetch(url, {
    method,
    headers: { 'content-type': 'application/json', ...headers },
    body: body == null ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* ignore */ }
  if (!res.ok) throw new Error(`${method} ${url} -> ${res.status}: ${text.slice(0, 500)}`);
  return json ?? {};
}

async function ensureRepo() {
  if (!existsSync(CFG.repoPath)) {
    await mkdir(path.dirname(CFG.repoPath), { recursive: true });
    await execText('git', ['clone', '--depth', '1', CFG.repoUrl, CFG.repoPath], 180000, true);
  }
  const commit = await execText('git', ['-C', CFG.repoPath, 'rev-parse', 'HEAD'], 30000, true);
  report.repo_commit = commit.trim();
  const count = await execText('git', ['-C', CFG.repoPath, 'ls-files'], 30000, true);
  report.file_count = count.split(/\r?\n/).filter(Boolean).length;
  record('real ROCm repo', 'pass', `${CFG.repoUrl} @ ${report.repo_commit.slice(0, 12)} files=${report.file_count}`);
}

async function prepareUpstreamBuild() {
  const buildPath = `${CFG.workerRepoPath}/${CFG.buildSubdir}/build`;
  const shell = [
    'set -e',
    `rm -rf ${shQuote(path.posix.dirname(CFG.workerRepoPath))}`,
    `mkdir -p ${shQuote(path.posix.dirname(CFG.workerRepoPath))}`,
  ].join('; ');
  await execText('docker', ['exec', CFG.workerContainer, 'sh', '-lc', shell], 30000, true);
  await execText('docker', ['cp', CFG.repoPath, `${CFG.workerContainer}:${CFG.workerRepoPath}`], 180000, true);

  const command = `
set -e
cd ${shQuote(`${CFG.workerRepoPath}/${CFG.buildSubdir}`)}
rm -rf build
mkdir -p build/.cmake/api/v1/query
touch build/.cmake/api/v1/query/codemodel-v2
start=$(date +%s%3N)
cmake -S . -B build -DCMAKE_BUILD_TYPE=Release -DCMAKE_EXPORT_COMPILE_COMMANDS=ON -DCMAKE_PREFIX_PATH=/opt/rocm -DCMAKE_HIP_ARCHITECTURES=${shQuote(CFG.gpuArch)} > /tmp/synthi-real-rocm-configure.log 2>&1
configured=$(date +%s%3N)
cmake --build build -j2 > /tmp/synthi-real-rocm-build.log 2>&1
built=$(date +%s%3N)
./build/${shQuote(CFG.targetName)} > /tmp/synthi-real-rocm-run.log 2>&1
ran=$(date +%s%3N)
printf 'configure_ms=%s\\nbuild_ms=%s\\nrun_ms=%s\\n' "$((configured-start))" "$((built-configured))" "$((ran-built))"
`;
  const timings = await execText('docker', ['exec', CFG.workerContainer, 'sh', '-lc', command], 240000, true);
  const runLog = await execText('docker', ['exec', CFG.workerContainer, 'sh', '-lc', 'cat /tmp/synthi-real-rocm-run.log'], 30000, true);
  report.logs.upstream_run = runLog;
  const phase = { name: 'upstream_rocm_build_run', timings, output: runLog.slice(0, 1000) };
  report.phases.push(phase);
  record('upstream ROCm target builds and runs', 'pass', `${timings.replace(/\s+/g, ' ')} output=${runLog.split(/\r?\n/).at(-1) ?? ''}`);

  const compileCommands = await execText(
    'docker',
    ['exec', CFG.workerContainer, 'sh', '-lc', `cat ${shQuote(`${buildPath}/compile_commands.json`)}`],
    30000,
    true,
  );
  return normalizeCompileCommands(compileCommands);
}

function normalizeCompileCommands(raw) {
  const entries = JSON.parse(raw);
  const sourceSuffix = `/${CFG.entryFile.replace(/\\/g, '/')}`;
  const selected = entries.find((entry) => String(entry.file || '').replace(/\\/g, '/').endsWith(sourceSuffix));
  if (!selected) throw new Error(`compile_commands.json did not include ${CFG.entryFile}`);
  const workerRoot = CFG.workerRepoPath.replace(/\\/g, '/');
  const workspaceRoot = '/workspace/rocm-examples';
  const normalized = {
    ...selected,
    directory: String(selected.directory || '').replace(workerRoot, workspaceRoot),
    file: String(selected.file || '').replace(workerRoot, workspaceRoot),
  };
  if (normalized.command) normalized.command = String(normalized.command).replaceAll(workerRoot, workspaceRoot);
  if (Array.isArray(normalized.arguments)) {
    normalized.arguments = normalized.arguments.map((arg) => String(arg).replaceAll(workerRoot, workspaceRoot));
  }
  return JSON.stringify([normalized], null, 2) + '\n';
}

function shQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

async function collectRepoFiles(compileCommandsJson) {
  const raw = await execText('git', ['-C', CFG.repoPath, 'ls-files', '-z'], 30000, true);
  const rels = raw.split('\0').filter(Boolean).sort();
  const files = [];
  const skipped = [];
  for (const rel of rels) {
    const full = path.join(CFG.repoPath, rel);
    const st = await stat(full);
    if (st.size > CFG.maxFileBytes) {
      skipped.push({ path: rel.replace(/\\/g, '/'), reason: 'too_large', bytes: st.size });
      continue;
    }
    const buf = await readFile(full);
    if (buf.includes(0)) {
      skipped.push({ path: rel.replace(/\\/g, '/'), reason: 'binary' });
      continue;
    }
    files.push({ path: rel.replace(/\\/g, '/'), content: buf.toString('utf8') });
  }

  files.push({ path: 'compile_commands.json', content: compileCommandsJson });
  files.push({
    path: '.cmake/api/v1/reply/codemodel-v2-release.json',
    content: JSON.stringify({
      kind: 'codemodel',
      configurations: [{ name: 'Release', targets: [{ name: CFG.targetName, id: `${CFG.targetName}::@real-rocm`, jsonFile: `target-${CFG.targetName}-Release.json` }] }],
    }, null, 2) + '\n',
  });
  files.push({
    path: `.cmake/api/v1/reply/target-${CFG.targetName}-Release.json`,
    content: JSON.stringify({
      name: CFG.targetName,
      id: `${CFG.targetName}::@real-rocm`,
      type: 'EXECUTABLE',
      sources: [{ path: CFG.entryFile }],
    }, null, 2) + '\n',
  });

  report.seeded_file_count = files.length;
  report.skipped_file_count = skipped.length;
  report.skipped_files = skipped.slice(0, 50);
  record('collected real repo text files', 'pass', `seeded=${files.length} skipped=${skipped.length}`);
  return files;
}

async function createWorkspace() {
  const workspace = await httpJson('POST', `${CFG.frontendUrl}/api/workspace`, {
    name: 'Synthi Real ROCm Repo Validation',
    slug: CFG.slug,
  });
  record('create workspace', 'pass', `id=${workspace.id ?? 'n/a'} slug=${CFG.slug}`);
}

async function writeFilesBatch(files) {
  for (let i = 0; i < files.length; i += CFG.writeBatchSize) {
    const chunk = files.slice(i, i + CFG.writeBatchSize);
    await httpJson(
      'POST',
      `${CFG.collabUrl}/git/${CFG.slug}/write-files-batch`,
      {
        files: chunk.map((file) => ({ path: file.path, encoding: 'utf8', content: file.content })),
        syncToGcs: CFG.syncToGcs,
      },
      { 'x-user-id': CFG.hostId },
    );
    record('seed workspace batch', 'pass', `${Math.min(i + chunk.length, files.length)}/${files.length}`);
  }
  await httpJson('POST', `${CFG.collabUrl}/git/${CFG.slug}/stage-all`, {}, { 'x-user-id': CFG.hostId });
  await httpJson('POST', `${CFG.collabUrl}/git/${CFG.slug}/commit`, { message: 'real-rocm-validation: seed ROCm examples saxpy target' }, { 'x-user-id': CFG.hostId });
  record('workspace commit seed', 'pass', `${files.length} files`);
}

class McpClient {
  constructor(proc) {
    this.proc = proc;
    this.nextId = 1;
    this.pending = new Map();
    this.buffer = '';
    this.stderrTail = [];
    proc.stdout.on('data', (chunk) => this.onData(chunk.toString()));
    proc.stderr.on('data', (chunk) => {
      const text = chunk.toString();
      this.stderrTail.push(text);
      if (this.stderrTail.length > 40) this.stderrTail.shift();
      if (process.env.MCP_VERBOSE) process.stderr.write(`[mcp] ${text}`);
    });
    proc.on('exit', (code, sig) => {
      for (const pending of this.pending.values()) pending.reject(new Error(`MCP exited ${code ?? sig}`));
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
        const pending = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) pending.reject(new Error(`MCP error: ${JSON.stringify(msg.error)}`));
        else pending.resolve(msg.result);
      }
    }
  }

  request(method, params = {}, timeoutMs = CFG.mcpRequestTimeoutMs) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP ${method} timed out. stderr=${this.stderrTail.slice(-8).join('').slice(-2000)}`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (value) => { clearTimeout(timer); resolve(value); },
        reject: (err) => { clearTimeout(timer); reject(err); },
      });
      this.proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  }

  async toolCall(name, args, timeoutMs = CFG.mcpRequestTimeoutMs) {
    const res = await this.request('tools/call', { name, arguments: args }, timeoutMs);
    const content = Array.isArray(res?.content) ? res.content : [];
    const text = content.find((block) => block?.type === 'text')?.text;
    if (res.isError) throw new Error(`tool ${name} isError: ${text ?? JSON.stringify(res)}`);
    if (!text) return {};
    try { return JSON.parse(text); } catch { return { raw: text }; }
  }
}

let mcpState = null;
async function ensureMcpAttached() {
  if (!mcpState) {
    let proc;
    if (CFG.mcpTransport === 'docker') {
      proc = spawn('docker', [
        'exec',
        '-i',
        '-e', `SYNTHI_SESSION_ID=${CFG.slug}`,
        '-e', `SYNTHI_SIGNALING_URL=${CFG.mcpSignalingUrl}`,
        '-e', `GOOGLE_API_KEY=${CFG.googleApiKey}`,
        '-e', `GEMINI_API_KEY=${CFG.googleApiKey}`,
        '-e', `SYNTHI_GEMINI_MODEL=${CFG.geminiModel}`,
        CFG.mcpContainer,
        'node',
        '/app/dist/index.js',
      ], { stdio: ['pipe', 'pipe', 'pipe'] });
    } else {
      proc = spawn('node', [CFG.mcpEntry], {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, SYNTHI_SESSION_ID: CFG.slug, SYNTHI_SIGNALING_URL: CFG.signalingUrl },
      });
    }
    const client = new McpClient(proc);
    await client.request('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'real-rocm-validation', version: '0.0.1' } }, 20000);
    await client.request('notifications/initialized', {}, 5000).catch(() => {});
    const tools = await client.request('tools/list', {}, 20000);
    const names = tools.tools?.map((tool) => tool.name) ?? [];
    record('mcp tools/list', names.includes('synthi_compile') && names.includes('synthi_wait_hmr') ? 'pass' : 'fail', `count=${names.length}`);
    mcpState = { proc, client, attached: false };
  }
  if (!mcpState.attached) {
    const attach = await mcpState.client.toolCall('synthi_attach', { sessionId: CFG.slug, 'i-understand-no-auth': true }, CFG.mcpAttachTimeoutMs);
    if (!attach?.ok) throw new Error(`synthi_attach failed: ${JSON.stringify(attach)}`);
    mcpState.attached = true;
    record('mcp attach', 'pass', attach.resolution ? `${attach.resolution.w}x${attach.resolution.h}` : 'attached');
  }
  return mcpState;
}

async function compileViaMcp(args, timeoutMs, phaseName) {
  const state = await ensureMcpAttached();
  const start = Date.now();
  const compile = await state.client.toolCall('synthi_compile', args, timeoutMs);
  if (!compile?.ok) throw new Error(`${phaseName} synthi_compile failed: ${JSON.stringify(compile).slice(0, 1000)}`);
  const waitStart = Date.now();
  const wait = await state.client.toolCall('synthi_wait_hmr', { timeoutMs }, timeoutMs + 10000);
  const phase = {
    name: phaseName,
    compile_wall_ms: Date.now() - start,
    wait_hmr_elapsed_ms: wait?.elapsedMs ?? null,
    wait_hmr_terminal_elapsed_ms: wait?.hmrElapsedMs ?? null,
    wait_hmr_status: wait?.status ?? null,
    wait_hmr_source: wait?.source ?? null,
    wait_hmr_detail: wait?.detail ?? null,
    wait_call_wall_ms: Date.now() - waitStart,
  };
  report.phases.push(phase);
  record(phaseName, wait?.status === 'applied' ? 'pass' : 'fail', JSON.stringify(phase).slice(0, 1000));
  if (wait?.status !== 'applied') throw new Error(`${phaseName} wait_hmr status=${wait?.status}`);
  return { compile, wait, phase };
}

async function captureScreenshot(label) {
  if (!mcpState?.client) return null;
  for (let attempt = 1; attempt <= CFG.screenshotAttempts; attempt += 1) {
    const shot = await mcpState.client.toolCall('synthi_screenshot', { freshness_max_ms: CFG.screenshotFreshnessMaxMs }, 30000).catch((e) => ({ error: e.message }));
    if (shot?.data) {
      const outPath = path.join(ARTIFACT_DIR, `${CFG.slug}-${label}.png`);
      const bytes = Buffer.from(shot.data, 'base64');
      await writeFile(outPath, bytes);
      const image = sharp(bytes);
      const meta = await image.metadata();
      const stats = await image.greyscale().raw().toBuffer().then((buf) => {
        let visible = 0;
        let sum = 0;
        for (const value of buf) {
          sum += value;
          if (value > 8) visible += 1;
        }
        return { visible, mean: buf.length ? sum / buf.length : 0 };
      });
      const row = { label, path: outPath, width: meta.width, height: meta.height, visible_pixels: stats.visible, mean_luma: stats.mean, bytes: bytes.length };
      report.screenshots.push(row);
      record(`screenshot ${label}`, stats.visible > 500 ? 'pass' : 'warn', JSON.stringify(row));
      return row;
    }
    record(`screenshot ${label}`, 'warn', `attempt=${attempt} ${shot?.error ?? 'no data'}`);
    await sleep(1000);
  }
  return null;
}

function editSaxpySource(source) {
  const before = 'd_y[global_idx] = a * d_x[global_idx] + d_y[global_idx];';
  const after = 'd_y[global_idx] = (a + 0.25f) * d_x[global_idx] + d_y[global_idx];';
  if (!source.includes(before)) throw new Error('expected saxpy kernel assignment not found');
  return source.replace(before, after);
}

async function writeResults() {
  report.finished_at = new Date().toISOString();
  await mkdir(LOG_DIR, { recursive: true });
  await mkdir(ARTIFACT_DIR, { recursive: true });
  await writeFile(RESULTS_JSON, JSON.stringify(report, null, 2) + '\n');
  const lines = [
    `slug: ${report.slug}`,
    `source_url: ${report.source_url}`,
    `repo_commit: ${report.repo_commit}`,
    `entry_file: ${report.entry_file}`,
    `file_count: ${report.file_count}`,
    `seeded_file_count: ${report.seeded_file_count}`,
    `skipped_file_count: ${report.skipped_file_count}`,
    '',
    ...report.checks.map((check) => `${check.status.toUpperCase()} ${check.name}${check.detail ? ` - ${check.detail}` : ''}`),
    '',
    ...report.phases.map((phase) => `PHASE ${phase.name} ${JSON.stringify(phase)}`),
    '',
    ...report.screenshots.map((shot) => `SCREENSHOT ${shot.label} visible=${shot.visible_pixels} luma=${shot.mean_luma.toFixed(1)} path=${shot.path}`),
  ];
  await writeFile(RESULTS_TXT, lines.join('\n') + '\n');
  console.log(`results: ${RESULTS_TXT}`);
}

async function run() {
  await mkdir(LOG_DIR, { recursive: true });
  await mkdir(ARTIFACT_DIR, { recursive: true });
  await ensureRepo();
  const compileCommandsJson = await prepareUpstreamBuild();
  const files = await collectRepoFiles(compileCommandsJson);
  const primary = files.find((file) => file.path === CFG.entryFile);
  if (!primary) throw new Error(`entry file missing from seeded files: ${CFG.entryFile}`);
  const additionalFiles = files.filter((file) => file.path !== CFG.entryFile).map((file) => ({ name: file.path, content: file.content }));

  await createWorkspace();
  await writeFilesBatch(files);

  await compileViaMcp({
    language: 'cpp',
    filename: CFG.entryFile,
    source: primary.content,
    files: additionalFiles,
    is_gui: true,
    use_ai_split: true,
    user_requested_ai: true,
    prefer_gpu_pipeline: true,
    gpu_mode: 'rocm',
    gpu_arch: CFG.gpuArch,
    slug: CFG.slug,
    width: 800,
    height: 600,
  }, CFG.firstCompileTimeoutMs, 'first_real_repo_ai_split_compile');
  await captureScreenshot('first-compile');

  const edited = editSaxpySource(primary.content);
  await httpJson(
    'POST',
    `${CFG.collabUrl}/git/${CFG.slug}/write-files-batch`,
    { files: [{ path: CFG.entryFile, encoding: 'utf8', content: edited }], syncToGcs: CFG.syncToGcs },
    { 'x-user-id': CFG.hostId },
  );
  await compileViaMcp({
    language: 'cpp',
    filename: CFG.entryFile,
    source: edited,
    files: additionalFiles,
    is_gui: true,
    use_ai_split: true,
    user_requested_ai: true,
    prefer_gpu_pipeline: true,
    gpu_mode: 'rocm',
    gpu_arch: CFG.gpuArch,
    slug: CFG.slug,
    width: 800,
    height: 600,
  }, CFG.hmrTimeoutMs, 'real_repo_user_source_delta_hmr');
  await captureScreenshot('post-hmr');
}

run()
  .catch((err) => {
    record('fatal', 'fail', err.stack || err.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    if (mcpState?.proc) {
      try { mcpState.proc.kill('SIGTERM'); } catch { /* ignore */ }
    }
    await writeResults().catch((err) => console.error(err));
  });
