#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import {
  analyzeGpuHmrImageEvidence,
  evaluateGpuHmrDeterministicVisualMode,
  screenshotQualifiesAsVisualEvidence,
  visualEvidenceRow,
} from './lib/gpu-hmr-visual-evidence.mjs';
import { visualEvidenceArtifactsFromFiles } from './lib/gpu-hmr-validation-proof-artifact.mjs';
import { externalProjectTimingMetrics } from './lib/gpu-hmr-timing-metrics.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const MCP_ROOT = path.resolve(__dirname, '..');
const REPO_ROOT = process.env.SYNTHI_REPO_ROOT
  ? path.resolve(process.env.SYNTHI_REPO_ROOT)
  : existsSync(path.resolve(MCP_ROOT, '../..', 'mcp/synthi-mcp/scripts'))
    ? path.resolve(MCP_ROOT, '../..')
    : MCP_ROOT;
const ARTIFACT_DIR = path.resolve(MCP_ROOT, '.gpu-hmr-test-artifacts/external-projects');
const LOG_DIR = path.resolve(MCP_ROOT, '.gpu-hmr-test-logs/external-projects');
const PROFILE_DIR = path.resolve(MCP_ROOT, 'scripts/profiles');
const SCHEMA_VERSION = 'synthi.gpu.hmr.external_project_profile.v1';
const PROOF_MODES = new Set(['external_runtime_screenshot', 'mcp_preview']);
const DEFAULT_MCP_TIMEOUT_MS = 1_200_000;

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function nonEmptyString(value, field) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`external project profile ${field} must be a non-empty string`);
  }
  return value.trim();
}

function optionalString(value, field) {
  if (value === undefined || value === null || String(value).trim() === '') return null;
  return nonEmptyString(value, field);
}

function stringList(value, field) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new Error(`external project profile ${field} must be an array`);
  return value.map((item, index) => nonEmptyString(item, `${field}[${index}]`));
}

function stringRecord(value, field) {
  if (value === undefined || value === null) return {};
  if (!isObject(value)) throw new Error(`external project profile ${field} must be an object`);
  return Object.fromEntries(
    Object.entries(value).map(([key, val]) => [key, String(val)]),
  );
}

function jsonObject(value, field) {
  if (value === undefined || value === null) return {};
  if (!isObject(value)) throw new Error(`external project profile ${field} must be an object`);
  return { ...value };
}

function optionalJsonObject(value, field) {
  if (value === undefined || value === null) return null;
  if (!isObject(value)) throw new Error(`external project profile ${field} must be an object`);
  return { ...value };
}

function numberAtLeast(value, field, fallback, min = 0) {
  if (value === undefined || value === null || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < min) {
    throw new Error(`external project profile ${field} must be a number >= ${min}`);
  }
  return parsed;
}

function commandSpec(value, field, { required = false } = {}) {
  if (value === undefined || value === null || value === '') {
    if (required) throw new Error(`external project profile ${field}.command is required`);
    return null;
  }
  const raw = typeof value === 'string' ? { command: value } : value;
  if (!isObject(raw)) throw new Error(`external project profile ${field} must be a command string or object`);
  return {
    command: nonEmptyString(raw.command, `${field}.command`),
    cwd: optionalString(raw.cwd, `${field}.cwd`),
    env: isObject(raw.env) ? Object.fromEntries(
      Object.entries(raw.env).map(([key, val]) => [key, String(val)]),
    ) : {},
    readyRegex: optionalString(raw.readyRegex, `${field}.readyRegex`),
    successRegex: optionalString(raw.successRegex, `${field}.successRegex`),
  };
}

function normalizeProofMode(rawMode, visual) {
  const mode = optionalString(rawMode ?? visual.proofMode, 'proofMode')
    ?? (visual?.screenshot?.command ? 'external_runtime_screenshot' : 'mcp_preview');
  if (!PROOF_MODES.has(mode)) {
    throw new Error(`external project profile proofMode must be one of: ${Array.from(PROOF_MODES).join(', ')}`);
  }
  return mode;
}

function normalizeMcpPreview(rawPreview, field, proofMode) {
  if (rawPreview === undefined || rawPreview === null) {
    if (proofMode === 'mcp_preview') {
      throw new Error(`external project profile ${field} is required when proofMode=mcp_preview`);
    }
    return null;
  }
  if (!isObject(rawPreview)) throw new Error(`external project profile ${field} must be an object`);
  return {
    language: nonEmptyString(rawPreview.language, `${field}.language`),
    entryFile: nonEmptyString(rawPreview.entryFile, `${field}.entryFile`).replace(/\\/g, '/'),
    filename: optionalString(rawPreview.filename, `${field}.filename`)?.replace(/\\/g, '/')
      ?? nonEmptyString(rawPreview.entryFile, `${field}.entryFile`).replace(/\\/g, '/'),
    includeFiles: stringList(rawPreview.includeFiles, `${field}.includeFiles`)
      .map((item) => item.replace(/\\/g, '/')),
    compile: jsonObject(rawPreview.compile, `${field}.compile`),
    hmrTimeoutMs: numberAtLeast(rawPreview.hmrTimeoutMs, `${field}.hmrTimeoutMs`, DEFAULT_MCP_TIMEOUT_MS, 1000),
    screenshotFreshnessMaxMs: numberAtLeast(
      rawPreview.screenshotFreshnessMaxMs,
      `${field}.screenshotFreshnessMaxMs`,
      30_000,
      1000,
    ),
    screenshotAttempts: numberAtLeast(rawPreview.screenshotAttempts, `${field}.screenshotAttempts`, 3, 1),
    screenshotRetryDelayMs: numberAtLeast(
      rawPreview.screenshotRetryDelayMs,
      `${field}.screenshotRetryDelayMs`,
      1500,
      0,
    ),
    hmrModule: optionalString(rawPreview.hmrModule ?? rawPreview.module, `${field}.hmrModule`) ?? 'device',
    requiredGpuProofState: optionalString(
      rawPreview.requiredGpuProofState,
      `${field}.requiredGpuProofState`,
    ),
    requireGpuFullRuntimeProof: rawPreview.requireGpuFullRuntimeProof !== undefined
      ? Boolean(rawPreview.requireGpuFullRuntimeProof)
      : true,
    env: stringRecord(rawPreview.env, `${field}.env`),
  };
}

function normalizeProfile(rawProfile) {
  const raw = isObject(rawProfile) ? rawProfile : {};
  const project = isObject(raw.project) ? raw.project : {};
  const runtime = isObject(raw.runtime) ? raw.runtime : {};
  const source = isObject(raw.source) ? raw.source : {};
  const visual = isObject(raw.visualProof) ? raw.visualProof : {};
  const screenshot = isObject(visual.screenshot) ? visual.screenshot : {};
  const proofMode = normalizeProofMode(raw.proofMode, visual);

  const id = nonEmptyString(raw.id, 'id');
  const localPath = optionalString(project.localPath, 'project.localPath')
    ?? `tmp/external-hmr/${id}`;
  const before = nonEmptyString(source.before, 'source.before');
  const after = nonEmptyString(source.after, 'source.after');
  if (before === after) throw new Error('external project profile source.before and source.after must differ');

  const normalized = {
    schemaVersion: raw.schemaVersion ?? SCHEMA_VERSION,
    id,
    project: {
      name: nonEmptyString(project.name ?? id, 'project.name'),
      repoUrl: optionalString(project.repoUrl, 'project.repoUrl'),
      ref: optionalString(project.ref, 'project.ref'),
      license: optionalString(project.license, 'project.license'),
      localPath: localPath.replace(/\\/g, '/'),
      upstreamSources: stringList(project.upstreamSources, 'project.upstreamSources'),
    },
    runtime: {
      env: isObject(runtime.env) ? Object.fromEntries(
        Object.entries(runtime.env).map(([key, val]) => [key, String(val)]),
      ) : {},
      build: commandSpec(runtime.build, 'runtime.build'),
      run: commandSpec(runtime.run, 'runtime.run', { required: proofMode === 'external_runtime_screenshot' }),
      readyDelayMs: numberAtLeast(runtime.readyDelayMs, 'runtime.readyDelayMs', 3000),
      hotReloadDelayMs: numberAtLeast(runtime.hotReloadDelayMs, 'runtime.hotReloadDelayMs', 1500),
      hotReloadRegex: optionalString(runtime.hotReloadRegex, 'runtime.hotReloadRegex'),
      errorRegexes: stringList(runtime.errorRegexes, 'runtime.errorRegexes'),
    },
    source: {
      file: nonEmptyString(source.file, 'source.file').replace(/\\/g, '/'),
      before,
      after,
    },
    proofMode,
    mcpPreview: normalizeMcpPreview(raw.mcpPreview, 'mcpPreview', proofMode),
    visualProof: {
      claim: nonEmptyString(
        visual.claim ?? 'An external GPU/runtime source edit materially changes visible output.',
        'visualProof.claim',
      ),
      deterministicMode: optionalJsonObject(
        visual.deterministicMode ?? visual.deterministic_mode,
        'visualProof.deterministicMode',
      ),
      screenshot: {
        command: proofMode === 'external_runtime_screenshot'
          ? nonEmptyString(screenshot.command, 'visualProof.screenshot.command')
          : optionalString(screenshot.command, 'visualProof.screenshot.command'),
      },
      minChangedPixelRatio: numberAtLeast(
        visual.minChangedPixelRatio,
        'visualProof.minChangedPixelRatio',
        0.01,
      ),
      minMeanAbsDelta8bit: numberAtLeast(
        visual.minMeanAbsDelta8bit,
        'visualProof.minMeanAbsDelta8bit',
        1.0,
      ),
    },
  };
  if (normalized.schemaVersion !== SCHEMA_VERSION) {
    throw new Error(`unsupported external project profile schemaVersion: ${normalized.schemaVersion}`);
  }
  return normalized;
}

function mcpPreviewGpuProofGate(profile) {
  if (profile.proofMode !== 'mcp_preview') {
    return {
      required: false,
      satisfied: true,
      hmrModule: null,
      requireGpuFullRuntimeProof: null,
      requiredGpuProofState: null,
    };
  }
  const preview = profile.mcpPreview;
  const fullRuntimeStateRequested = preview.requiredGpuProofState === 'gpu-hmr-full-runtime-proven';
  const satisfied = (
    preview.hmrModule === 'device'
    && (preview.requireGpuFullRuntimeProof === true || fullRuntimeStateRequested)
  );
  return {
    required: true,
    satisfied,
    hmrModule: preview.hmrModule,
    requireGpuFullRuntimeProof: preview.requireGpuFullRuntimeProof,
    requiredGpuProofState: preview.requiredGpuProofState,
    waitContract: {
      module: preview.hmrModule,
      requireGpuFullRuntimeProof: preview.requireGpuFullRuntimeProof === true,
      ...(preview.requiredGpuProofState ? { requiredGpuProofState: preview.requiredGpuProofState } : {}),
    },
  };
}

function parseArgs(argv) {
  const args = {
    profilePath: '',
    profileJson: '',
    selfCheck: false,
    dryRun: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--self-check') args.selfCheck = true;
    else if (arg === '--dry-run') args.dryRun = true;
    else if (arg === '--profile' || arg === '--profile-path') args.profilePath = argv[++index] ?? '';
    else if (arg === '--profile-json') args.profileJson = argv[++index] ?? '';
    else throw new Error(`unknown argument: ${arg}`);
  }
  return args;
}

function isInsideDirectory(baseDir, targetPath) {
  const relative = path.relative(baseDir, targetPath);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function projectDir(profile) {
  const override = process.env.SYNTHI_GPU_HMR_EXTERNAL_PROJECT_ROOT;
  const resolved = path.resolve(REPO_ROOT, override || profile.project.localPath);
  if (!isInsideDirectory(REPO_ROOT, resolved)) {
    throw new Error(`external project path must stay inside repo workspace by default: ${resolved}`);
  }
  return resolved;
}

function expandEnvMap(map, profile, context = {}) {
  return Object.fromEntries(
    Object.entries(map || {}).map(([key, value]) => [
      key,
      expandTemplate(String(value), profile, context),
    ]),
  );
}

function shellEnv(profile, extra = {}, context = {}) {
  return {
    ...process.env,
    ...expandEnvMap(profile.runtime.env, profile, context),
    ...expandEnvMap(extra, profile, context),
  };
}

function expandTemplate(template, profile, context = {}) {
  const replacements = {
    repoRoot: REPO_ROOT,
    projectDir: context.projectDir,
    output: context.output,
    profileId: profile.id,
    pathListSeparator: process.platform === 'win32' ? ';' : ':',
  };
  return String(template).replace(/\{([A-Za-z0-9_]+)\}/g, (full, key) => {
    if (replacements[key] === undefined || replacements[key] === null) return full;
    return String(replacements[key]);
  }).replace(/\{env:([A-Za-z_][A-Za-z0-9_]*)\}/g, (full, key) => {
    if (process.env[key] === undefined || process.env[key] === null) return full;
    return String(process.env[key]);
  });
}

function runCommand(spec, profile, context = {}) {
  const cwd = path.resolve(context.projectDir, spec.cwd || '.');
  const command = expandTemplate(spec.command, profile, context);
  const started = Date.now();
  return new Promise((resolve, reject) => {
    let output = '';
    const child = spawn(command, {
      cwd,
      env: shellEnv(profile, spec.env, context),
      shell: true,
      windowsHide: true,
    });
    child.stdout.on('data', (chunk) => {
      output += chunk.toString();
      process.stdout.write(chunk);
    });
    child.stderr.on('data', (chunk) => {
      output += chunk.toString();
      process.stderr.write(chunk);
    });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      resolve({
        command,
        cwd,
        code: signal ? 128 : (code ?? 1),
        signal,
        output,
        elapsedMs: Date.now() - started,
      });
    });
  });
}

function startRuntime(spec, profile, context) {
  const cwd = path.resolve(context.projectDir, spec.cwd || '.');
  const command = expandTemplate(spec.command, profile, context);
  const started = Date.now();
  const child = spawn(command, {
    cwd,
    env: shellEnv(profile, spec.env, context),
    shell: true,
    windowsHide: true,
  });
  const chunks = [];
  const push = (chunk) => {
    const text = chunk.toString();
    chunks.push(text);
    process.stdout.write(text);
  };
  child.stdout.on('data', push);
  child.stderr.on('data', push);
  return {
    command,
    cwd,
    child,
    started,
    output() {
      return chunks.join('');
    },
    async stop() {
      if (child.exitCode !== null || child.signalCode !== null) return;
      const exited = new Promise((resolve) => child.once('exit', resolve));
      await stopProcessTree(child);
      if (child.exitCode !== null || child.signalCode !== null) return;
      await exited;
    },
  };
}

async function stopProcessTree(child) {
  if (!child?.pid) return;
  if (process.platform === 'win32') {
    const rootPid = Number(child.pid);
    const taskkillExit = await new Promise((resolve) => {
      const killer = spawn('taskkill', ['/PID', String(rootPid), '/T', '/F'], {
        stdio: 'ignore',
        windowsHide: true,
      });
      killer.once('error', () => resolve(1));
      killer.once('exit', (code) => resolve(code ?? 1));
    });
    if (taskkillExit === 0) return;

    await new Promise((resolve) => {
      const script = [
        "$ErrorActionPreference='SilentlyContinue'",
        `$root=${rootPid}`,
        '$all=Get-CimInstance Win32_Process',
        '$children=@{}',
        'foreach($p in $all){',
        '  if(-not $children.ContainsKey($p.ParentProcessId)){ $children[$p.ParentProcessId]=New-Object System.Collections.ArrayList }',
        '  [void]$children[$p.ParentProcessId].Add([int]$p.ProcessId)',
        '}',
        '$stack=New-Object System.Collections.ArrayList',
        '$targets=New-Object System.Collections.ArrayList',
        'if($children.ContainsKey($root)){ foreach($id in $children[$root]){ [void]$stack.Add($id) } }',
        'while($stack.Count -gt 0){',
        '  $id=[int]$stack[$stack.Count-1]',
        '  $stack.RemoveAt($stack.Count-1)',
        '  [void]$targets.Add($id)',
        '  if($children.ContainsKey($id)){ foreach($childId in $children[$id]){ [void]$stack.Add([int]$childId) } }',
        '}',
        'for($i=$targets.Count-1; $i -ge 0; $i--){ Stop-Process -Id ([int]$targets[$i]) -Force }',
        'Stop-Process -Id $root -Force',
      ].join('; ');
      const killer = spawn('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script], {
        stdio: 'ignore',
        windowsHide: true,
      });
      killer.once('error', resolve);
      killer.once('exit', resolve);
    });
    return;
  }
  child.kill('SIGTERM');
}

async function waitForRuntimeReady(runtime, spec, fallbackDelayMs) {
  const readyRegex = spec.readyRegex ? new RegExp(spec.readyRegex, 'i') : null;
  if (!readyRegex) {
    await new Promise((resolve) => setTimeout(resolve, fallbackDelayMs));
    return { matched: false, elapsedMs: Date.now() - runtime.started, mode: 'delay' };
  }
  while (runtime.child.exitCode === null && runtime.child.signalCode === null) {
    if (readyRegex.test(runtime.output())) {
      return { matched: true, elapsedMs: Date.now() - runtime.started, mode: 'regex' };
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`runtime exited before ready regex matched: ${spec.readyRegex}`);
}

async function waitForHotReload(runtime, profile, startedAt) {
  const hotRegex = profile.runtime.hotReloadRegex ? new RegExp(profile.runtime.hotReloadRegex, 'i') : null;
  if (!hotRegex) {
    await new Promise((resolve) => setTimeout(resolve, profile.runtime.hotReloadDelayMs));
    return { matched: false, elapsedMs: Date.now() - startedAt, mode: 'delay' };
  }
  while (runtime.child.exitCode === null && runtime.child.signalCode === null) {
    if (hotRegex.test(runtime.output())) {
      return { matched: true, elapsedMs: Date.now() - startedAt, mode: 'regex' };
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`runtime exited before hot reload regex matched: ${profile.runtime.hotReloadRegex}`);
}

async function ensureProject(profile, dir) {
  await fs.mkdir(path.dirname(dir), { recursive: true });
  const gitDir = path.join(dir, '.git');
  try {
    await fs.stat(gitDir);
  } catch {
    if (!profile.project.repoUrl) {
      throw new Error(`project directory does not exist and project.repoUrl is not configured: ${dir}`);
    }
    const clone = await runCommand(
      { command: `git clone ${JSON.stringify(profile.project.repoUrl)} ${JSON.stringify(dir)}`, env: {} },
      profile,
      { projectDir: REPO_ROOT },
    );
    if (clone.code !== 0) throw new Error(`git clone failed with exit ${clone.code}`);
  }
  if (profile.project.ref) {
    const checkout = await runCommand(
      { command: `git -C ${JSON.stringify(dir)} checkout ${JSON.stringify(profile.project.ref)}`, env: {} },
      profile,
      { projectDir: REPO_ROOT },
    );
    if (checkout.code !== 0) throw new Error(`git checkout failed with exit ${checkout.code}`);
  }
}

async function writeSourceDelta(profile, dir) {
  const sourcePath = path.resolve(dir, profile.source.file);
  if (!isInsideDirectory(dir, sourcePath)) {
    throw new Error(`source.file must stay inside project directory: ${profile.source.file}`);
  }
  const original = await fs.readFile(sourcePath, 'utf8');
  if (!original.includes(profile.source.before)) {
    throw new Error(`source.before did not match ${profile.source.file}`);
  }
  const edited = original.replace(profile.source.before, profile.source.after);
  await fs.writeFile(sourcePath, edited);
  return { sourcePath, original, editedHash: sha256(edited) };
}

async function captureScreenshot(profile, dir, label) {
  await fs.mkdir(ARTIFACT_DIR, { recursive: true });
  const output = path.join(ARTIFACT_DIR, `${profile.id}-${label}-${Date.now()}.png`);
  const command = {
    command: profile.visualProof.screenshot.command,
    env: {},
  };
  const result = await runCommand(command, profile, { projectDir: dir, output });
  if (result.code !== 0) throw new Error(`screenshot command failed with exit ${result.code}`);
  await fs.stat(output);
  return { path: output, elapsedMs: result.elapsedMs, command: result.command };
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
      if (this.stderrTail.length > 60) this.stderrTail.shift();
      if (process.env.MCP_VERBOSE) process.stderr.write(`[external-mcp] ${text}`);
    });
    proc.on('exit', (code, signal) => {
      const err = new Error(`MCP process exited ${code ?? signal ?? 'unknown'}`);
      for (const pending of this.pending.values()) pending.reject(err);
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
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      if (msg.id != null && this.pending.has(msg.id)) {
        const pending = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) pending.reject(new Error(`MCP error: ${JSON.stringify(msg.error)}`));
        else pending.resolve(msg.result);
      }
    }
  }

  request(method, params = {}, timeoutMs = DEFAULT_MCP_TIMEOUT_MS) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(
          `MCP request ${method} timed out after ${timeoutMs}ms. stderr=${this.stderrTail.slice(-10).join('').slice(-4000)}`,
        ));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      this.proc.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
  }

  async toolCall(name, args, timeoutMs = DEFAULT_MCP_TIMEOUT_MS) {
    const res = await this.request('tools/call', { name, arguments: args }, timeoutMs);
    const content = Array.isArray(res?.content) ? res.content : [];
    const textBlock = content.find((block) => block?.type === 'text');
    if (res?.isError) {
      throw new Error(`tool ${name} isError: ${textBlock?.text ?? JSON.stringify(res).slice(0, 2000)}`);
    }
    const imageBlock = content.find((block) => block?.type === 'image' && typeof block.data === 'string');
    let parsed = {};
    if (textBlock?.text) {
      try {
        parsed = JSON.parse(textBlock.text);
      } catch {
        parsed = { raw: textBlock.text };
      }
    }
    if (imageBlock?.data) parsed.data = imageBlock.data;
    return parsed;
  }

  async close() {
    try { this.proc.stdin.end(); } catch {}
    try { this.proc.kill('SIGTERM'); } catch {}
  }
}

function mcpConfig(profile) {
  const previewEnv = expandEnvMap(profile.mcpPreview?.env ?? {}, profile, { projectDir: projectDir(profile) });
  const sessionId = process.env.SYNTHI_GPU_HMR_EXTERNAL_MCP_SESSION_ID
    || previewEnv.SYNTHI_SESSION_ID
    || process.env.SYNTHI_SESSION_ID
    || profile.id;
  return {
    sessionId,
    transport: process.env.SYNTHI_GPU_HMR_EXTERNAL_MCP_TRANSPORT
      || previewEnv.SYNTHI_MCP_TRANSPORT
      || process.env.SYNTHI_MCP_TRANSPORT
      || 'local',
    signalingUrl: process.env.SYNTHI_GPU_HMR_EXTERNAL_SIGNALING_URL
      || previewEnv.SYNTHI_SIGNALING_URL
      || process.env.SYNTHI_SIGNALING_URL
      || 'ws://127.0.0.1:8787',
    mcpEntry: path.resolve(
      REPO_ROOT,
      process.env.SYNTHI_GPU_HMR_EXTERNAL_MCP_ENTRY
        || previewEnv.SYNTHI_MCP_ENTRY
        || 'mcp/synthi-mcp/dist/index.js',
    ),
    mcpContainer: process.env.SYNTHI_GPU_HMR_EXTERNAL_MCP_CONTAINER
      || previewEnv.SYNTHI_MCP_CONTAINER
      || process.env.SYNTHI_MCP_CONTAINER
      || 'vectant-ade-mcp-1',
    googleApiKey: process.env.GOOGLE_API_KEY || process.env.GEMINI_API_KEY || previewEnv.GOOGLE_API_KEY || '',
    splitModel: process.env.SYNTHI_GPU_SPLIT_MODEL || previewEnv.SYNTHI_GPU_SPLIT_MODEL || 'gemini-3.5-flash',
    deltaModel: process.env.SYNTHI_GPU_DELTA_MODEL || previewEnv.SYNTHI_GPU_DELTA_MODEL || 'gemini-3.1-flash-lite',
    requestTimeoutMs: Number(process.env.SYNTHI_GPU_HMR_EXTERNAL_MCP_REQUEST_TIMEOUT_MS) || DEFAULT_MCP_TIMEOUT_MS,
    attachTimeoutMs: Number(process.env.SYNTHI_GPU_HMR_EXTERNAL_MCP_ATTACH_TIMEOUT_MS) || DEFAULT_MCP_TIMEOUT_MS,
  };
}

async function startMcpClient(profile) {
  const cfg = mcpConfig(profile);
  let proc;
  if (cfg.transport === 'docker') {
    const args = [
      'exec',
      '-i',
      '-e', `SYNTHI_SESSION_ID=${cfg.sessionId}`,
      '-e', `SYNTHI_SIGNALING_URL=${cfg.signalingUrl}`,
      '-e', `GOOGLE_API_KEY=${cfg.googleApiKey}`,
      '-e', `GEMINI_API_KEY=${cfg.googleApiKey}`,
      '-e', `SYNTHI_GPU_SPLIT_MODEL=${cfg.splitModel}`,
      '-e', `SYNTHI_GPU_DELTA_MODEL=${cfg.deltaModel}`,
      cfg.mcpContainer,
      'node',
      '/app/dist/index.js',
    ];
    proc = spawn('docker', args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  } else {
    if (!existsSync(cfg.mcpEntry)) {
      throw new Error(`MCP entry not found: ${cfg.mcpEntry}; run npm run build in mcp/synthi-mcp`);
    }
    proc = spawn('node', [cfg.mcpEntry], {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      env: {
        ...process.env,
        SYNTHI_SESSION_ID: cfg.sessionId,
        SYNTHI_SIGNALING_URL: cfg.signalingUrl,
        GOOGLE_API_KEY: cfg.googleApiKey,
        GEMINI_API_KEY: cfg.googleApiKey,
        SYNTHI_GPU_SPLIT_MODEL: cfg.splitModel,
        SYNTHI_GPU_DELTA_MODEL: cfg.deltaModel,
      },
    });
  }
  const client = new McpClient(proc);
  await client.request(
    'initialize',
    { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'synthi-external-project-mcp-preview', version: '0.0.1' } },
    cfg.requestTimeoutMs,
  );
  await client.request('notifications/initialized', {}, cfg.requestTimeoutMs).catch(() => {});
  const tools = await client.request('tools/list', {}, cfg.requestTimeoutMs);
  const names = tools.tools?.map((tool) => tool.name) ?? [];
  for (const requiredTool of ['synthi_attach', 'synthi_compile', 'synthi_wait_hmr', 'synthi_screenshot']) {
    if (!names.includes(requiredTool)) {
      throw new Error(`MCP server is missing required tool ${requiredTool}; available=${names.join(',')}`);
    }
  }
  const attach = await client.toolCall(
    'synthi_attach',
    { sessionId: cfg.sessionId, 'i-understand-no-auth': true, signalingUrl: cfg.signalingUrl },
    cfg.attachTimeoutMs,
  );
  if (!attach?.ok) throw new Error(`synthi_attach failed: ${JSON.stringify(attach).slice(0, 2000)}`);
  return { client, cfg, attach };
}

async function readMcpCompilePayload(profile, dir) {
  const preview = profile.mcpPreview;
  const entryPath = path.resolve(dir, preview.entryFile);
  if (!isInsideDirectory(dir, entryPath)) {
    throw new Error(`mcpPreview.entryFile must stay inside project directory: ${preview.entryFile}`);
  }
  const source = await fs.readFile(entryPath, 'utf8');
  const files = [];
  const seen = new Set([preview.entryFile]);
  for (const file of preview.includeFiles) {
    if (seen.has(file)) continue;
    seen.add(file);
    const filePath = path.resolve(dir, file);
    if (!isInsideDirectory(dir, filePath)) {
      throw new Error(`mcpPreview.includeFiles[] must stay inside project directory: ${file}`);
    }
    files.push({ name: file, content: await fs.readFile(filePath, 'utf8') });
  }
  return {
    language: preview.language,
    filename: preview.filename,
    source,
    files,
    is_gui: true,
    use_ai_split: true,
    ...preview.compile,
    project_root: dir,
  };
}

async function compileViaMcp(client, profile, dir, label) {
  const args = await readMcpCompilePayload(profile, dir);
  const startedAt = Date.now();
  const compile = await client.toolCall('synthi_compile', args, profile.mcpPreview.hmrTimeoutMs);
  if (!compile?.ok) {
    throw new Error(`${label} synthi_compile failed: ${JSON.stringify(compile).slice(0, 2000)}`);
  }
  const waitArgs = {
    timeoutMs: profile.mcpPreview.hmrTimeoutMs,
    since_ts: Number.isFinite(compile.dispatched_at) ? compile.dispatched_at : startedAt,
    module: profile.mcpPreview.hmrModule,
    ...(profile.mcpPreview.requiredGpuProofState
      ? { requiredGpuProofState: profile.mcpPreview.requiredGpuProofState }
      : {}),
    ...(profile.mcpPreview.requireGpuFullRuntimeProof
      ? { requireGpuFullRuntimeProof: true }
      : {}),
  };
  const wait = await client.toolCall(
    'synthi_wait_hmr',
    waitArgs,
    profile.mcpPreview.hmrTimeoutMs,
  );
  return {
    label,
    compile,
    wait,
    waitArgs,
    compileWallMs: Date.now() - startedAt,
    waitStatus: wait?.status ?? null,
  };
}

function collectModelFields(value, predicate, pathParts = [], out = new Set()) {
  if (Array.isArray(value)) {
    value.forEach((item, index) => collectModelFields(item, predicate, [...pathParts, String(index)], out));
    return out;
  }
  if (!isObject(value)) return out;
  for (const [key, item] of Object.entries(value)) {
    const nextPath = [...pathParts, key];
    const normalizedPath = nextPath.join('.').toLowerCase().replace(/[^a-z0-9]+/g, '_');
    if (typeof item === 'string' && predicate(normalizedPath, key)) {
      const trimmed = item.trim();
      if (trimmed) out.add(trimmed);
    }
    collectModelFields(item, predicate, nextPath, out);
  }
  return out;
}

function mcpModelProvenance(cfg, ...compileResults) {
  const payloads = compileResults.flatMap((result) => [result?.compile, result?.wait].filter(Boolean));
  const splitModels = new Set();
  const deltaModels = new Set();
  for (const payload of payloads) {
    collectModelFields(
      payload,
      (normalizedPath) => normalizedPath.includes('split') && normalizedPath.includes('model'),
      [],
      splitModels,
    );
    collectModelFields(
      payload,
      (normalizedPath) => (
        normalizedPath.includes('delta') || normalizedPath.includes('diff') || normalizedPath.includes('patch')
      ) && normalizedPath.includes('model'),
      [],
      deltaModels,
    );
  }
  const observedSplitModels = Array.from(splitModels).sort();
  const observedDeltaModels = Array.from(deltaModels).sort();
  return {
    schemaVersion: 'synthi.gpu.hmr.mcp_model_provenance.v1',
    expectedSplitModel: cfg.splitModel,
    expectedDeltaModel: cfg.deltaModel,
    expectedModelsSeparated: Boolean(cfg.splitModel && cfg.deltaModel && cfg.splitModel !== cfg.deltaModel),
    envPinsPropagatedToMcp: true,
    observedSplitModels,
    observedDeltaModels,
    observedSplitModelMatched: observedSplitModels.length === 0 || observedSplitModels.includes(cfg.splitModel),
    observedDeltaModelMatched: observedDeltaModels.length === 0 || observedDeltaModels.includes(cfg.deltaModel),
    observedModelEvidenceComplete: observedSplitModels.length > 0 && observedDeltaModels.length > 0,
    status: observedSplitModels.length > 0 && observedDeltaModels.length > 0
      ? 'observed'
      : 'configured-only',
  };
}

async function captureMcpPreviewScreenshot(client, profile, label) {
  await fs.mkdir(ARTIFACT_DIR, { recursive: true });
  let last = null;
  let lastError = null;
  for (let attempt = 1; attempt <= profile.mcpPreview.screenshotAttempts; attempt += 1) {
    const shot = await client.toolCall(
      'synthi_screenshot',
      { freshness_max_ms: profile.mcpPreview.screenshotFreshnessMaxMs },
      60_000,
    ).catch((error) => {
      lastError = error;
      return null;
    });
    if (typeof shot?.data === 'string' && shot.data.length > 0) {
      const bytes = Buffer.from(shot.data, 'base64');
      const suffix = attempt === 1 ? '' : `-attempt-${attempt}`;
      const outPath = path.join(ARTIFACT_DIR, `${profile.id}-mcp-${label}-${Date.now()}${suffix}.png`);
      await fs.writeFile(outPath, bytes);
      const stats = await analyzeGpuHmrImageEvidence(bytes);
      const row = visualEvidenceRow({
        label,
        path: outPath,
        bytes: bytes.length,
        attempt,
        capture_backend: 'mcp:synthi_screenshot',
        captured_at_ms: Date.now(),
        screenshot_metadata: isObject(shot.meta)
          ? shot.meta
          : isObject(shot.metadata)
            ? shot.metadata
            : null,
        ...stats,
      });
      if (screenshotQualifiesAsVisualEvidence(row)) return row;
      last = row;
    }
    if (attempt < profile.mcpPreview.screenshotAttempts) {
      await new Promise((resolve) => setTimeout(resolve, profile.mcpPreview.screenshotRetryDelayMs));
    }
  }
  if (last) return last;
  const suffix = lastError ? `; last_error=${lastError.message}` : '';
  throw new Error(`synthi_screenshot did not return image data for ${label}${suffix}`);
}

function frameGateSatisfied(wait) {
  const gate = wait?.frame_gate ?? wait?.frameGate;
  return isObject(gate) && gate.status === 'satisfied';
}

function deterministicVisualModeForMcp(profile, before, after, afterCompile) {
  const base = isObject(profile.visualProof.deterministicMode)
    ? profile.visualProof.deterministicMode
    : {};
  const sameResolution = Number(before?.width) > 0
    && Number(before?.height) > 0
    && Number(before?.width) === Number(after?.width)
    && Number(before?.height) === Number(after?.height);
  const frameGate = frameGateSatisfied(afterCompile?.wait);
  return {
    ...base,
    fixed_resolution: sameResolution === true ? true : base.fixed_resolution,
    frame_capture_after_epoch_dispatch: frameGate === true
      ? true
      : base.frame_capture_after_epoch_dispatch,
    presentation_fence_or_frame_boundary: frameGate === true
      ? true
      : base.presentation_fence_or_frame_boundary,
  };
}

function deterministicVisualModeForExternal(profile, before, after) {
  if (!isObject(profile.visualProof.deterministicMode)) return null;
  const base = profile.visualProof.deterministicMode;
  const sameResolution = Number(before?.width) > 0
    && Number(before?.height) > 0
    && Number(before?.width) === Number(after?.width)
    && Number(before?.height) === Number(after?.height);
  return {
    ...base,
    fixed_resolution: sameResolution === true ? true : base.fixed_resolution,
  };
}

function sha256(value) {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

function stableJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) =>
    `${JSON.stringify(key)}:${stableJson(value[key])}`
  ).join(',')}}`;
}

async function compareImages(beforePath, afterPath, options = {}) {
  const before = sharp(beforePath).ensureAlpha();
  const after = sharp(afterPath).ensureAlpha();
  const beforeMeta = await before.metadata();
  const afterMeta = await after.metadata();
  if (beforeMeta.width !== afterMeta.width || beforeMeta.height !== afterMeta.height) {
    throw new Error(`screenshot sizes differ: ${beforeMeta.width}x${beforeMeta.height} vs ${afterMeta.width}x${afterMeta.height}`);
  }
  const left = await before.raw().toBuffer();
  const right = await after.raw().toBuffer();
  const diff = options.diffPath ? Buffer.alloc(left.length) : null;
  let changed = 0;
  let totalAbs = 0;
  const pixelCount = beforeMeta.width * beforeMeta.height;
  for (let i = 0; i < left.length; i += 4) {
    const dr = Math.abs(left[i] - right[i]);
    const dg = Math.abs(left[i + 1] - right[i + 1]);
    const db = Math.abs(left[i + 2] - right[i + 2]);
    const sum = dr + dg + db;
    if (sum > 8) changed += 1;
    totalAbs += sum / 3;
    if (diff) {
      diff[i] = dr;
      diff[i + 1] = dg;
      diff[i + 2] = db;
      diff[i + 3] = 255;
    }
  }
  if (diff && options.diffPath) {
    await sharp(diff, {
      raw: {
        width: beforeMeta.width,
        height: beforeMeta.height,
        channels: 4,
      },
    }).png().toFile(options.diffPath);
  }
  return {
    width: beforeMeta.width,
    height: beforeMeta.height,
    changedPixelRatio: changed / pixelCount,
    meanAbsDelta8bit: totalAbs / pixelCount,
    diffImagePath: options.diffPath ?? null,
  };
}

function visualOraclePaths(report) {
  return Array.from(new Set([
    report.visualOracleArtifacts?.before_image,
    report.visualOracleArtifacts?.after_image,
    report.visualOracleArtifacts?.diff_image,
    ...((Array.isArray(report.screenshots) ? report.screenshots : []).map((row) => row.path)),
  ].filter((value) => typeof value === 'string' && value.trim())));
}

async function writeExternalVisualProofArtifact(profile, report) {
  await fs.mkdir(LOG_DIR, { recursive: true });
  const paths = visualOraclePaths(report);
  if (paths.length === 0) {
    throw new Error('external visual proof artifact requires persisted before/after/diff image paths');
  }
  const existing = (Array.isArray(report.screenshots) ? report.screenshots : [])
    .filter((row) => row && typeof row === 'object' && typeof row.path === 'string')
    .map((row) => ({
      ...row,
      visualQuality: row.visual_quality ?? row.visualQuality,
      acceptedAsVisualEvidence:
        row.accepted_as_visual_evidence ?? row.acceptedAsVisualEvidence ?? false,
    }));
  const visualEvidenceArtifacts = await visualEvidenceArtifactsFromFiles(paths, existing);
  const acceptedVisualEvidenceArtifacts = visualEvidenceArtifacts
    .filter((artifact) => artifact.acceptedAsVisualEvidence === true);
  const material = {
    schemaVersion: 'synthi.gpu.hmr.external_visual_proof_artifact.v1',
    profileId: profile.id,
    proofMode: report.proofMode,
    status: report.status,
    createdAt: new Date().toISOString(),
    visualOracleArtifacts: report.visualOracleArtifacts ?? null,
    visualDiff: report.visualDiff ?? null,
    deterministicVisualMode: report.deterministicVisualMode ?? null,
    deterministicVisualModeEvaluation: report.deterministicVisualModeEvaluation ?? null,
    mcp: report.mcp ? {
      visualProofGate: report.mcp.visualProofGate ?? null,
      before: report.mcp.before ? {
        waitArgs: report.mcp.before.waitArgs ?? null,
        waitStatus: report.mcp.before.waitStatus ?? null,
        waitFrameGate: report.mcp.before.wait?.frame_gate ?? report.mcp.before.wait?.frameGate ?? null,
        gpuProof: report.mcp.before.wait?.gpu_proof ?? null,
        gpuProofValidation: report.mcp.before.wait?.gpu_proof_validation ?? null,
      } : null,
      after: report.mcp.after ? {
        waitArgs: report.mcp.after.waitArgs ?? null,
        waitStatus: report.mcp.after.waitStatus ?? null,
        waitFrameGate: report.mcp.after.wait?.frame_gate ?? report.mcp.after.wait?.frameGate ?? null,
        gpuProof: report.mcp.after.wait?.gpu_proof ?? null,
        gpuProofValidation: report.mcp.after.wait?.gpu_proof_validation ?? null,
      } : null,
      modelProvenance: report.mcp.modelProvenance ?? null,
    } : null,
    visualEvidenceArtifacts,
    acceptedVisualEvidenceArtifactCount: acceptedVisualEvidenceArtifacts.length,
  };
  const proofId = `external-visual-proof:${sha256(stableJson(material)).replace(/^sha256:/, '')}`;
  const artifact = {
    ...material,
    proofId,
  };
  const outPath = path.join(LOG_DIR, `${profile.id}-${Date.now()}-visual-proof.json`);
  await fs.writeFile(outPath, `${JSON.stringify(artifact, null, 2)}\n`);
  return {
    schemaVersion: artifact.schemaVersion,
    proofId,
    path: outPath,
    visualEvidenceArtifactCount: visualEvidenceArtifacts.length,
    acceptedVisualEvidenceArtifactCount: acceptedVisualEvidenceArtifacts.length,
    contentHashes: visualEvidenceArtifacts
      .map((artifact) => artifact.contentHash)
      .filter(Boolean),
  };
}

async function loadProfile(args) {
  if (args.profileJson) return normalizeProfile(JSON.parse(args.profileJson));
  const envJson = process.env.SYNTHI_GPU_HMR_EXTERNAL_PROJECT_PROFILE_JSON;
  if (envJson?.trim()) return normalizeProfile(JSON.parse(envJson));
  const profilePath = args.profilePath
    || process.env.SYNTHI_GPU_HMR_EXTERNAL_PROJECT_PROFILE_PATH
    || await defaultPackagedProfilePath();
  return normalizeProfile(JSON.parse(await fs.readFile(path.resolve(REPO_ROOT, profilePath), 'utf8')));
}

async function discoverPackagedProfiles() {
  const entries = await fs.readdir(PROFILE_DIR, { withFileTypes: true });
  const profiles = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
    const absolutePath = path.join(PROFILE_DIR, entry.name);
    let parsed;
    try {
      parsed = JSON.parse(await fs.readFile(absolutePath, 'utf8'));
    } catch {
      continue;
    }
    if (parsed?.schemaVersion !== SCHEMA_VERSION) continue;
    profiles.push(path.relative(REPO_ROOT, absolutePath).replace(/\\/g, '/'));
  }
  profiles.sort();
  return profiles;
}

async function defaultPackagedProfilePath() {
  const profiles = await discoverPackagedProfiles();
  const defaultId = process.env.SYNTHI_GPU_HMR_EXTERNAL_PROJECT_DEFAULT_PROFILE_ID?.trim();
  if (defaultId) {
    for (const profilePath of profiles) {
      const profile = normalizeProfile(JSON.parse(await fs.readFile(path.resolve(REPO_ROOT, profilePath), 'utf8')));
      if (profile.id === defaultId) return profilePath;
    }
    throw new Error(`external project default profile id was not found: ${defaultId}`);
  }
  const [first] = profiles;
  if (!first) throw new Error(`no packaged external project profiles found in ${PROFILE_DIR}`);
  return first;
}

async function selfCheckVisualProofArtifact() {
  await fs.mkdir(ARTIFACT_DIR, { recursive: true });
  const stamp = Date.now();
  const beforePath = path.join(ARTIFACT_DIR, `self-check-before-${stamp}.png`);
  const afterPath = path.join(ARTIFACT_DIR, `self-check-after-${stamp}.png`);
  const diffPath = path.join(ARTIFACT_DIR, `self-check-diff-${stamp}.png`);
  const beforeBytes = Buffer.from('external-visual-proof-before');
  const afterBytes = Buffer.from('external-visual-proof-after');
  const diffBytes = Buffer.from('external-visual-proof-diff');
  await fs.writeFile(beforePath, beforeBytes);
  await fs.writeFile(afterPath, afterBytes);
  await fs.writeFile(diffPath, diffBytes);
  const expectedHashes = [beforeBytes, afterBytes, diffBytes]
    .map((bytes) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`)
    .sort();
  const written = await writeExternalVisualProofArtifact({
    id: 'external-visual-proof-self-check',
  }, {
    proofMode: 'mcp_preview',
    status: 'pass',
    screenshots: [
      {
        path: beforePath,
        visual_quality: 'gpu-hmr-visual-varied-frame',
        accepted_as_visual_evidence: true,
      },
      {
        path: afterPath,
        visual_quality: 'gpu-hmr-visual-varied-frame',
        accepted_as_visual_evidence: true,
      },
    ],
    visualOracleArtifacts: {
      before_image: beforePath,
      after_image: afterPath,
      diff_image: diffPath,
      frame_capture_after_epoch_dispatch: true,
    },
    visualDiff: {
      changedPixelRatio: 0.5,
      meanAbsDelta8bit: 16,
    },
    deterministicVisualMode: {
      frozen_camera: true,
      fixed_resolution: true,
      frame_capture_after_epoch_dispatch: true,
      presentation_fence_or_frame_boundary: true,
      seed_policy_fixed: true,
      temporal_accumulation_not_applicable: true,
      taa_not_applicable: true,
      denoiser_not_applicable: true,
    },
    deterministicVisualModeEvaluation: {
      accepted: true,
    },
    mcp: {
      visualProofGate: {
        satisfied: true,
      },
      after: {
        waitArgs: {
          module: 'device',
          requireGpuFullRuntimeProof: true,
        },
        waitStatus: 'applied',
        wait: {
          frame_gate: {
            status: 'satisfied',
          },
          gpu_proof_validation: {
            satisfied: true,
          },
        },
      },
    },
  });
  const artifact = JSON.parse(await fs.readFile(written.path, 'utf8'));
  const observedHashes = (artifact.visualEvidenceArtifacts ?? [])
    .map((row) => row.contentHash)
    .filter(Boolean)
    .sort();
  const hashMatch = expectedHashes.every((hash) => observedHashes.includes(hash));
  return {
    ok:
      written.schemaVersion === 'synthi.gpu.hmr.external_visual_proof_artifact.v1'
      && typeof written.proofId === 'string'
      && written.proofId.startsWith('external-visual-proof:')
      && hashMatch,
    path: written.path,
    proofId: written.proofId,
    expectedHashes,
    observedHashes,
  };
}

async function selfCheck() {
  const checks = [];
  const profilePaths = await discoverPackagedProfiles();
  for (const profilePath of profilePaths) {
    const profile = normalizeProfile(JSON.parse(await fs.readFile(path.resolve(REPO_ROOT, profilePath), 'utf8')));
    const screenshotHasOutput = profile.proofMode !== 'external_runtime_screenshot'
      || profile.visualProof.screenshot.command.includes('{output}');
    const mcpPreviewComplete = profile.proofMode !== 'mcp_preview'
      || Boolean(profile.mcpPreview?.language && profile.mcpPreview?.entryFile);
    const mcpPreviewGpuProof = mcpPreviewGpuProofGate(profile);
    const deterministicVisualProfile = evaluateGpuHmrDeterministicVisualMode({
      ...(profile.visualProof.deterministicMode ?? {}),
      fixed_resolution: true,
      frame_capture_after_epoch_dispatch: true,
      presentation_fence_or_frame_boundary: true,
    });
    const runtimeCommandComplete = profile.proofMode === 'mcp_preview'
      || Boolean(profile.runtime.run?.command);
    checks.push({
      name: `packaged-profile:${path.basename(profilePath)}`,
      ok:
        profile.schemaVersion === SCHEMA_VERSION
        && runtimeCommandComplete
        && profile.source.before !== profile.source.after
        && screenshotHasOutput
        && mcpPreviewComplete
        && mcpPreviewGpuProof.satisfied
        && deterministicVisualProfile.accepted,
      id: profile.id,
      project: profile.project.name,
      source: profile.source.file,
      proofMode: profile.proofMode,
      runtimeCommandComplete,
      screenshotHasOutput,
      mcpPreviewComplete,
      mcpPreviewGpuProofGate: mcpPreviewGpuProof,
      deterministicVisualProfile,
    });
  }
  const visualProofArtifact = await selfCheckVisualProofArtifact();
  checks.push({
    name: 'external-visual-proof-artifact-hashes-files',
    ok: visualProofArtifact.ok,
    visualProofArtifact,
  });
  const failed = checks.filter((check) => !check.ok);
  console.log(JSON.stringify({
    schemaVersion: 'synthi.gpu.hmr.external_project_profile.self_check.v1',
    ok: failed.length === 0,
    profileDirectory: path.relative(REPO_ROOT, PROFILE_DIR).replace(/\\/g, '/'),
    discoveredProfileCount: profilePaths.length,
    checks,
  }, null, 2));
  if (failed.length > 0) process.exitCode = 1;
}

async function runProfile(profile) {
  await fs.mkdir(LOG_DIR, { recursive: true });
  const dir = projectDir(profile);
  const report = {
    schemaVersion: 'synthi.gpu.hmr.external_project_profile.report.v1',
    profile,
    proofMode: profile.proofMode,
    startedAt: new Date().toISOString(),
    timings: {},
    screenshots: [],
    visualDiff: null,
    status: 'running',
  };
  let runtime;
  let delta;
  let failure;
  try {
    await ensureProject(profile, dir);
    if (profile.proofMode === 'mcp_preview') {
      await runMcpPreviewProfile(profile, dir, report);
      return;
    }
    if (profile.runtime.build) {
      const build = await runCommand(profile.runtime.build, profile, { projectDir: dir });
      report.timings.buildMs = build.elapsedMs;
      if (build.code !== 0) throw new Error(`build failed with exit ${build.code}`);
    }
    runtime = startRuntime(profile.runtime.run, profile, { projectDir: dir });
    report.runtimeProcess = {
      pid: runtime.child.pid ?? null,
      command: runtime.command,
      cwd: runtime.cwd,
    };
    const ready = await waitForRuntimeReady(runtime, profile.runtime.run, profile.runtime.readyDelayMs);
    report.timings.runtimeReadyMs = ready.elapsedMs;
    const before = await captureScreenshot(profile, dir, 'before');
    report.screenshots.push({ label: 'before', ...before });
    const editStart = Date.now();
    delta = await writeSourceDelta(profile, dir);
    report.timings.sourceWriteMs = Date.now() - editStart;
    const hot = await waitForHotReload(runtime, profile, editStart);
    report.timings.editToRuntimeSignalMs = hot.elapsedMs;
    const after = await captureScreenshot(profile, dir, 'after');
    report.timings.editToScreenshotMs = Date.now() - editStart;
    report.screenshots.push({ label: 'after', ...after });
    const visualDiffStart = Date.now();
    const diffPath = path.join(ARTIFACT_DIR, `${profile.id}-external-diff-${Date.now()}.png`);
    report.visualDiff = await compareImages(before.path, after.path, { diffPath });
    report.timings.visualDiffMs = Date.now() - visualDiffStart;
    report.visualOracleArtifacts = {
      before_image: before.path,
      after_image: after.path,
      diff_image: report.visualDiff.diffImagePath,
      capture_backend: 'external_runtime_screenshot',
    };
    report.deterministicVisualMode = deterministicVisualModeForExternal(profile, before, after);
    report.deterministicVisualModeEvaluation = report.deterministicVisualMode
      ? evaluateGpuHmrDeterministicVisualMode(report.deterministicVisualMode)
      : null;
    const accepted =
      report.visualDiff.changedPixelRatio >= profile.visualProof.minChangedPixelRatio
      && report.visualDiff.meanAbsDelta8bit >= profile.visualProof.minMeanAbsDelta8bit
      && (
        report.deterministicVisualModeEvaluation
          ? report.deterministicVisualModeEvaluation.accepted === true
          : true
      );
    report.status = accepted ? 'pass' : 'fail';
    if (!accepted) {
      throw new Error(`visual diff below threshold: ${JSON.stringify(report.visualDiff)}`);
    }
    report.visualProofArtifact = await writeExternalVisualProofArtifact(profile, report);
    report.proofArtifactPaths = [report.visualProofArtifact.path];
  } catch (error) {
    failure = error;
    if (report.status === 'running') report.status = 'fail';
    report.error = {
      message: error?.message || String(error),
      stack: error?.stack || null,
    };
  } finally {
    if (delta?.sourcePath && delta.original !== undefined) {
      await fs.writeFile(delta.sourcePath, delta.original).catch(() => {});
    }
    if (runtime) {
      const stopStart = Date.now();
      try {
        await runtime.stop();
        report.timings.runtimeStopMs = Date.now() - stopStart;
        report.runtimeTeardownStatus = 'pass';
      } catch (error) {
        report.timings.runtimeStopMs = Date.now() - stopStart;
        report.runtimeTeardownStatus = 'fail';
        report.runtimeTeardownError = {
          message: error?.message || String(error),
          stack: error?.stack || null,
        };
        if (!failure) failure = error;
        report.status = 'fail';
      }
    }
    report.finishedAt = new Date().toISOString();
    report.timings.totalMs = Date.parse(report.finishedAt) - Date.parse(report.startedAt);
    report.timingMetrics = externalProjectTimingMetrics(report);
    const outPath = path.join(LOG_DIR, `${profile.id}-${Date.now()}-report.json`);
    await fs.writeFile(outPath, `${JSON.stringify(report, null, 2)}\n`);
    console.log(`external_project_report=${outPath}`);
  }
  if (failure) throw failure;
}

async function runMcpPreviewProfile(profile, dir, report) {
  let mcp;
  let delta;
  try {
    mcp = await startMcpClient(profile);
    report.mcp = {
      sessionId: mcp.cfg.sessionId,
      transport: mcp.cfg.transport,
      signalingUrl: mcp.cfg.signalingUrl,
      attach: mcp.attach,
      splitModel: mcp.cfg.splitModel,
      deltaModel: mcp.cfg.deltaModel,
      visualProofGate: mcpPreviewGpuProofGate(profile),
    };
    if (!report.mcp.visualProofGate.satisfied) {
      throw new Error(`MCP visual proof gate is not GPU-only: ${JSON.stringify(report.mcp.visualProofGate)}`);
    }
    if (profile.runtime.build) {
      const build = await runCommand(profile.runtime.build, profile, { projectDir: dir });
      report.timings.buildMs = build.elapsedMs;
      if (build.code !== 0) throw new Error(`build failed with exit ${build.code}`);
    }
    const beforeCompile = await compileViaMcp(mcp.client, profile, dir, 'before');
    report.timings.beforeCompileWallMs = beforeCompile.compileWallMs;
    report.mcp.before = beforeCompile;
    const before = await captureMcpPreviewScreenshot(mcp.client, profile, 'before');
    report.screenshots.push(before);
    if (beforeCompile.waitStatus !== 'applied') {
      throw new Error(`before wait_hmr status=${beforeCompile.waitStatus}; screenshot=${before.path}`);
    }
    const editStart = Date.now();
    delta = await writeSourceDelta(profile, dir);
    report.timings.sourceWriteMs = Date.now() - editStart;
    const afterCompile = await compileViaMcp(mcp.client, profile, dir, 'after');
    report.timings.editToMcpHmrMs = Date.now() - editStart;
    report.timings.afterCompileWallMs = afterCompile.compileWallMs;
    report.mcp.after = afterCompile;
    report.mcp.modelProvenance = mcpModelProvenance(mcp.cfg, beforeCompile, afterCompile);
    if (!report.mcp.modelProvenance.expectedModelsSeparated) {
      throw new Error(`MCP model pins are not separated: ${JSON.stringify(report.mcp.modelProvenance)}`);
    }
    if (!report.mcp.modelProvenance.observedSplitModelMatched || !report.mcp.modelProvenance.observedDeltaModelMatched) {
      throw new Error(`MCP observed model provenance did not match configured pins: ${JSON.stringify(report.mcp.modelProvenance)}`);
    }
    const after = await captureMcpPreviewScreenshot(mcp.client, profile, 'after');
    report.timings.editToScreenshotMs = Date.now() - editStart;
    report.screenshots.push(after);
    if (afterCompile.waitStatus !== 'applied') {
      throw new Error(`after wait_hmr status=${afterCompile.waitStatus}; screenshot=${after.path}`);
    }
    const visualDiffStart = Date.now();
    const diffPath = path.join(ARTIFACT_DIR, `${profile.id}-mcp-diff-${Date.now()}.png`);
    report.visualDiff = await compareImages(before.path, after.path, { diffPath });
    report.timings.visualDiffMs = Date.now() - visualDiffStart;
    report.visualOracleArtifacts = {
      before_image: before.path,
      after_image: after.path,
      diff_image: report.visualDiff.diffImagePath,
      blank_frame_rejection: report.screenshots.every((row) => row.accepted_as_visual_evidence === true),
      same_frame_rejection: report.visualDiff.changedPixelRatio > 0,
      capture_backend: 'mcp:synthi_screenshot',
      frame_capture_after_epoch_dispatch: frameGateSatisfied(afterCompile.wait),
      wait_frame_gate: afterCompile.wait?.frame_gate ?? afterCompile.wait?.frameGate ?? null,
    };
    report.deterministicVisualMode = deterministicVisualModeForMcp(profile, before, after, afterCompile);
    report.deterministicVisualModeEvaluation =
      evaluateGpuHmrDeterministicVisualMode(report.deterministicVisualMode);
    const accepted =
      report.visualDiff.changedPixelRatio >= profile.visualProof.minChangedPixelRatio
      && report.visualDiff.meanAbsDelta8bit >= profile.visualProof.minMeanAbsDelta8bit
      && report.screenshots.every((row) => row.accepted_as_visual_evidence === true)
      && report.deterministicVisualModeEvaluation.accepted === true;
    report.status = accepted ? 'pass' : 'fail';
    if (!accepted) {
      throw new Error(`MCP visual evidence below threshold: ${JSON.stringify({
        visualDiff: report.visualDiff,
        screenshots: report.screenshots,
        deterministicVisualModeEvaluation: report.deterministicVisualModeEvaluation,
      }).slice(0, 2000)}`);
    }
    report.visualProofArtifact = await writeExternalVisualProofArtifact(profile, report);
    report.proofArtifactPaths = [report.visualProofArtifact.path];
  } finally {
    if (delta?.sourcePath && delta.original !== undefined) {
      await fs.writeFile(delta.sourcePath, delta.original).catch(() => {});
    }
    if (mcp?.client) await mcp.client.close().catch(() => {});
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.selfCheck) {
    await selfCheck();
    return;
  }
  const profile = await loadProfile(args);
  if (args.dryRun) {
    const mcpPreviewGpuProof = mcpPreviewGpuProofGate(profile);
    console.log(JSON.stringify({
      schemaVersion: 'synthi.gpu.hmr.external_project_profile.dry_run.v1',
      profile,
      projectDir: projectDir(profile),
      mcpPreviewGpuProofGate: mcpPreviewGpuProof,
    }, null, 2));
    if (!mcpPreviewGpuProof.satisfied) process.exitCode = 1;
    return;
  }
  await runProfile(profile);
}

main().catch((error) => {
  console.error(error?.stack || error?.message || String(error));
  process.exitCode = 1;
});
