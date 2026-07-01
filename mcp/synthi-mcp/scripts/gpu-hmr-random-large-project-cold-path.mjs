import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const MCP_ROOT = path.resolve(SCRIPT_DIR, '..');
const REPO_ROOT = path.resolve(MCP_ROOT, '..', '..');
const LOG_DIR = path.join(MCP_ROOT, '.gpu-hmr-test-logs', 'random-large-project-cold-path');
const SOURCE_INTAKE_DIR = path.join(LOG_DIR, 'source-intake');
const SCHEMA = 'synthi.gpu_hmr.random_large_project_cold_path.v1';
const AUTHORITY = 'random_large_project_cold_path_selection_only_not_gpu_hmr_success';
const SOURCE_INTAKE_SCHEMA = 'synthi.gpu_hmr.unprofiled_cold_source_intake.v1';
const SOURCE_INTAKE_AUTHORITY = 'unprofiled_source_tree_intake_only_not_gpu_hmr_success';
const BUILD_METADATA_DISCOVERY_SCHEMA = 'synthi.gpu_hmr.cold_build_metadata_discovery.v1';
const BUILD_METADATA_DISCOVERY_AUTHORITY = 'build_metadata_discovery_only_not_gpu_hmr_success';
const BUILD_METADATA_CONTENT_SCHEMA = 'synthi.gpu_hmr.cold_build_metadata_content.v1';
const BUILD_METADATA_CONTENT_AUTHORITY = 'build_metadata_content_bytes_only_not_gpu_hmr_success';
const RUNTIME_BOUNDARY_EXPECTATION_SCHEMA = 'synthi.gpu_hmr.cold_runtime_boundary_expectation.v1';
const RUNTIME_BOUNDARY_EXPECTATION_AUTHORITY = 'runtime_boundary_expectation_only_not_gpu_hmr_success';
const RUNTIME_BOUNDARY_EVENT_SCHEMA = 'synthi.gpu_hmr.runtime_boundary_event.v1';
const RUNTIME_BOUNDARY_EVENT_MANIFEST_SCHEMA = 'synthi.gpu_hmr.runtime_boundary_event_manifest.v1';
const RUNTIME_BOUNDARY_EVENT_TEMPLATE_SCHEMA =
  'synthi.gpu_hmr.cold_runtime_boundary_event_manifest_template.v1';
const RUNTIME_BOUNDARY_EVENT_TEMPLATE_AUTHORITY =
  'runtime_boundary_event_manifest_template_only_not_gpu_hmr_success';
const REQUIRED_RUNTIME_BOUNDARY_EVENT_KINDS = Object.freeze([
  'artifact_transport',
  'epoch_publication',
  'dispatch_trace',
  'host_identity',
  'output_oracle',
]);
const BUILD_METADATA_CONTENT_MAX_FILES = 12;
const BUILD_METADATA_CONTENT_MAX_BYTES = 128 * 1024;

const DEFAULT_CANDIDATES = [
  {
    id: 'real-rocm-miopen-activation-large-ml',
    backendFamily: 'real_rocm',
    profilePath: path.join(SCRIPT_DIR, 'profiles', 'real-rocm-miopen-activation-large-ml.json'),
    sourceUrl: 'https://github.com/ROCm/MIOpen.git',
    immutableCommit: '06977176afd94476c18d5290f21cb40745bb73a9',
    sizeSignals: {
      class: 'large_rocm_ml_infrastructure',
      target: 'MIOpenDriver',
      coldPathKind: 'real_upstream_cmake_project',
    },
  },
  {
    id: 'real-rocm-composable-kernel-gemm-large-ml',
    backendFamily: 'real_rocm',
    profilePath: path.join(SCRIPT_DIR, 'profiles', 'real-rocm-composable-kernel-gemm-large-ml.json'),
    sourceUrl: 'https://github.com/ROCm/composable_kernel.git',
    immutableCommit: '713f1fbf46ae73755c06a0b115f01795cea9a4f9',
    sizeSignals: {
      class: 'large_rocm_ml_infrastructure',
      target: 'example_gemm_xdl_fp32_v3',
      coldPathKind: 'real_upstream_cmake_project',
    },
  },
  {
    id: 'real-rocm-hipblaslt-gelu-aux-bias-large-ml',
    backendFamily: 'real_rocm',
    profilePath: path.join(SCRIPT_DIR, 'profiles', 'real-rocm-hipblaslt-gelu-aux-bias-large-ml.json'),
    sourceUrl: 'https://github.com/ROCm/hipBLASLt.git',
    immutableCommit: '3a609b06926c8227e753b62087555e1f435bf2d4',
    sizeSignals: {
      class: 'large_rocm_ml_infrastructure',
      target: 'sample_hipblaslt_gemm_gelu_aux_bias',
      coldPathKind: 'real_upstream_cmake_project',
    },
  },
  {
    id: 'unprofiled-llama-cpp-multibackend',
    backendFamily: 'unknown_gpu_project',
    sourceUrl: 'https://github.com/ggerganov/llama.cpp.git',
    immutableCommit: '4f31eedb0ccf546b7e8d6bb243b170f12522f54d',
    sizeSignals: {
      class: 'large_arbitrary_multibackend_user_project',
      coldPathKind: 'github_source_tree_intake_only',
    },
    buildSystemHints: {
      expectedFiles: ['CMakeLists.txt', 'Makefile'],
    },
    runtimeBoundaryHints: {
      required: [
        'same_process_loader',
        'epoch_publication',
        'dispatch_trace',
        'host_identity',
        'output_oracle',
      ],
    },
    oracleHints: {
      acceptedByDeclaration: false,
      expectedKinds: ['compute_readback', 'visual_oracle'],
    },
  },
  {
    id: 'unprofiled-wgpu-rust-graphics-stack',
    backendFamily: 'unknown_gpu_project',
    sourceUrl: 'https://github.com/gfx-rs/wgpu.git',
    immutableCommit: '22c6cb18d4b73254b0d62511e6a9d68e06dea70f',
    sizeSignals: {
      class: 'large_arbitrary_webgpu_vulkan_metal_user_project',
      coldPathKind: 'github_source_tree_intake_only',
    },
    buildSystemHints: {
      expectedFiles: ['Cargo.toml'],
    },
    runtimeBoundaryHints: {
      required: [
        'runtime_profile_contract',
        'same_process_loader',
        'pipeline_epoch',
        'frame_or_compute_dispatch_trace',
        'output_oracle',
      ],
    },
    oracleHints: {
      acceptedByDeclaration: false,
      expectedKinds: ['mapped_buffer_readback', 'visual_oracle'],
    },
  },
  {
    id: 'unprofiled-dawn-webgpu-stack',
    backendFamily: 'unknown_gpu_project',
    sourceUrl: 'https://github.com/google/dawn.git',
    immutableCommit: 'a25d07794c686b4de8e231e53b7550c3e983e6e6',
    sizeSignals: {
      class: 'large_arbitrary_webgpu_native_stack',
      coldPathKind: 'github_source_tree_intake_only',
    },
    buildSystemHints: {
      expectedFiles: ['CMakeLists.txt'],
    },
    runtimeBoundaryHints: {
      required: [
        'runtime_profile_contract',
        'same_process_loader',
        'shader_or_pipeline_epoch',
        'dispatch_trace',
        'output_oracle',
      ],
    },
    oracleHints: {
      acceptedByDeclaration: false,
      expectedKinds: ['mapped_buffer_readback', 'visual_oracle'],
    },
  },
  {
    id: 'unprofiled-godot-engine-rendering',
    backendFamily: 'unknown_gpu_project',
    sourceUrl: 'https://github.com/godotengine/godot.git',
    immutableCommit: 'f4c57c2824951a5df945392923bdfdc1c4055395',
    sizeSignals: {
      class: 'large_arbitrary_engine_rendering_project',
      coldPathKind: 'github_source_tree_intake_only',
    },
    buildSystemHints: {
      expectedFiles: ['SConstruct'],
    },
    runtimeBoundaryHints: {
      required: [
        'engine_reload_hook',
        'same_process_loader',
        'pipeline_epoch',
        'frame_dispatch_trace',
        'host_identity',
        'visual_oracle',
      ],
    },
    oracleHints: {
      acceptedByDeclaration: false,
      expectedKinds: ['deterministic_visual_oracle'],
    },
  },
];

function parseArgs(argv = process.argv.slice(2)) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--self-check') out.selfCheck = true;
    else if (arg === '--dry-run') out.dryRun = true;
    else if (arg === '--seed') out.seed = argv[++i];
    else if (arg === '--count') out.count = argv[++i];
    else if (arg === '--candidate') out.candidateId = argv[++i];
    else if (arg === '--candidates') out.candidatesPath = argv[++i];
    else if (arg === '--source-url') out.sourceUrl = argv[++i];
    else if (arg === '--repo-path') out.repoPath = argv[++i];
    else if (arg === '--commit' || arg === '--immutable-commit') out.immutableCommit = argv[++i];
    else if (arg === '--source-id') out.sourceId = argv[++i];
    else if (arg === '--backend-family') out.backendFamily = argv[++i];
    else if (arg === '--output-dir') out.outputDir = argv[++i];
    else throw new Error(`unknown argument: ${arg}`);
  }
  return out;
}

function sha256(value) {
  return createHash('sha256').update(String(value)).digest('hex');
}

function contentHash(value) {
  return `sha256:${sha256(value)}`;
}

function safeSlug(value, fallback = 'repo') {
  const slug = String(value ?? '')
    .trim()
    .replace(/\.git$/i, '')
    .split(/[/:\\]+/)
    .filter(Boolean)
    .slice(-2)
    .join('-')
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^[^a-z0-9]+/, '')
    .replace(/[^a-z0-9]+$/, '')
    .slice(0, 48);
  return slug || fallback;
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function uniqueSortedStrings(values) {
  return [...new Set(
    (Array.isArray(values) ? values : [])
      .map((value) => String(value ?? '').trim())
      .filter(Boolean),
  )].sort();
}

function cleanCandidate(raw, index = 0, { candidateSource = 'configured_candidate_pool' } = {}) {
  const candidate = raw && typeof raw === 'object' ? raw : {};
  const id = String(candidate.id ?? '').trim();
  const backendFamily = String(
    candidate.backendFamily
      ?? candidate.backend_family
      ?? candidate.backend
      ?? 'unknown_gpu_project',
  ).trim().toLowerCase();
  const profilePath = String(candidate.profilePath ?? candidate.profile_path ?? '').trim();
  const sourceUrl = String(candidate.sourceUrl ?? candidate.source_url ?? candidate.repo?.url ?? '').trim();
  const localRepoPath = String(
    candidate.localRepoPath
      ?? candidate.local_repo_path
      ?? candidate.repoPath
      ?? candidate.repo_path
      ?? '',
  ).trim();
  const immutableCommit = String(
    candidate.immutableCommit
      ?? candidate.immutable_commit
      ?? candidate.repo?.commit
      ?? '',
  ).trim();
  if (!id) throw new Error(`candidate[${index}] id missing`);
  if (!/^[a-z0-9][a-z0-9._-]*$/i.test(id)) {
    throw new Error(`candidate[${index}] id must be a safe identifier`);
  }
  if (!/^[a-z][a-z0-9_-]*$/i.test(backendFamily)) {
    throw new Error(`candidate[${index}] backendFamily must be a safe identifier`);
  }
  if (!sourceUrl) throw new Error(`candidate[${index}] sourceUrl missing`);
  if (!/^[0-9a-f]{40,64}$/i.test(immutableCommit)) {
    throw new Error(`candidate[${index}] immutableCommit must be a git commit hash`);
  }
  const resolvedProfilePath = profilePath ? path.resolve(profilePath) : null;
  const profileMode = resolvedProfilePath
    ? 'profile_driven_real_rocm_runner'
    : 'unprofiled_arbitrary_project_cold_intake';
  return {
    id,
    backendFamily,
    profilePath: resolvedProfilePath,
    profileMode,
    profile_mode: profileMode,
    candidateSource,
    candidate_source: candidateSource,
    sourceUrl,
    localRepoPath: localRepoPath ? path.resolve(localRepoPath) : null,
    local_repo_path: localRepoPath ? path.resolve(localRepoPath) : null,
    immutableCommit,
    sizeSignals: candidate.sizeSignals ?? candidate.size_signals ?? {},
    buildSystemHints: candidate.buildSystemHints ?? candidate.build_system_hints ?? {},
    build_system_hints: candidate.buildSystemHints ?? candidate.build_system_hints ?? {},
    runtimeBoundaryHints: candidate.runtimeBoundaryHints ?? candidate.runtime_boundary_hints ?? {},
    runtime_boundary_hints: candidate.runtimeBoundaryHints ?? candidate.runtime_boundary_hints ?? {},
    oracleHints: candidate.oracleHints ?? candidate.oracle_hints ?? {},
    oracle_hints: candidate.oracleHints ?? candidate.oracle_hints ?? {},
  };
}

function directCandidateFromInput({
  sourceUrl,
  repoPath,
  immutableCommit,
  sourceId,
  backendFamily,
} = {}) {
  const url = String(sourceUrl ?? '').trim();
  const repo = String(repoPath ?? '').trim();
  const commit = String(immutableCommit ?? '').trim();
  if (!url && !repo && !commit) return null;
  if ((!url && !repo) || !commit) {
    throw new Error('direct cold-path source input requires --source-url or --repo-path plus --commit');
  }
  const resolvedRepo = repo ? path.resolve(repo) : null;
  const effectiveSourceUrl = url || pathToFileURL(resolvedRepo).href;
  const id = String(sourceId ?? '').trim()
    || `direct-${safeSlug(url || resolvedRepo)}-${sha256(`${effectiveSourceUrl}\0${commit}`).slice(0, 12)}`;
  return cleanCandidate(
    {
      id,
      backendFamily: backendFamily || 'unknown_gpu_project',
      sourceUrl: effectiveSourceUrl,
      localRepoPath: resolvedRepo,
      immutableCommit: commit,
      sizeSignals: {
        class: 'large_arbitrary_user_project',
        coldPathKind: resolvedRepo
          ? 'direct_local_git_repo_cold_intake'
          : 'direct_source_url_commit_cold_intake',
        inputMode: 'cli_or_env_direct_source',
      },
      runtimeBoundaryHints: {
        required: [
          'runtime_profile_contract',
          'same_process_loader',
          'epoch_publication',
          'dispatch_trace',
          'host_identity',
          'output_oracle',
        ],
      },
      oracleHints: {
        acceptedByDeclaration: false,
        expectedKinds: ['compute_readback', 'deterministic_visual_oracle'],
      },
    },
    0,
    {
      candidateSource: resolvedRepo ? 'direct_local_git_repo_path' : 'direct_source_url_commit',
    },
  );
}

async function loadCandidates({ candidatesJson, candidatesPath } = {}) {
  let raw = DEFAULT_CANDIDATES;
  if (candidatesJson) {
    raw = JSON.parse(candidatesJson);
  } else if (candidatesPath) {
    raw = JSON.parse(await readFile(path.resolve(candidatesPath), 'utf8'));
  }
  const candidates = Array.isArray(raw) ? raw : raw?.candidates;
  if (!Array.isArray(candidates) || candidates.length === 0) {
    throw new Error('large-project cold-path candidates must be a non-empty array');
  }
  const cleaned = candidates.map((candidate, index) =>
    cleanCandidate(candidate, index, { candidateSource: 'configured_candidate_pool' }));
  const ids = new Set();
  for (const candidate of cleaned) {
    if (ids.has(candidate.id)) throw new Error(`duplicate candidate id: ${candidate.id}`);
    ids.add(candidate.id);
  }
  return cleaned;
}

function selectCandidates({ candidates, seed, count, candidateId }) {
  let pool = candidates;
  if (candidateId) {
    pool = candidates.filter((candidate) => candidate.id === candidateId);
    if (pool.length === 0) throw new Error(`candidate not found: ${candidateId}`);
  }
  const requestedCount = Math.max(1, Math.min(Number(count) || 1, pool.length));
  return pool
    .map((candidate) => ({
      candidate,
      selectionKey: sha256(`${seed}\0${candidate.id}\0${candidate.sourceUrl}\0${candidate.immutableCommit}`),
    }))
    .sort((a, b) => a.selectionKey.localeCompare(b.selectionKey))
    .slice(0, requestedCount)
    .map((entry, rank) => ({
      ...entry.candidate,
      selectionRank: rank + 1,
      selectionKey: entry.selectionKey,
    }));
}

function tail(text, max = 8000) {
  const value = String(text ?? '');
  return value.length > max ? value.slice(-max) : value;
}

function makeStamp(date = new Date()) {
  return date.toISOString().replace(/[-:.]/g, '').replace('T', 'T').slice(0, 18);
}

function killChildTree(child) {
  if (!child?.pid) return false;
  try {
    child.kill('SIGTERM');
  } catch {
    // Timeout cleanup is best-effort and never proof authority.
  }
  if (process.platform === 'win32') {
    try {
      spawnSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], {
        stdio: 'ignore',
        timeout: 3000,
      });
    } catch {
      // child.kill above is the portable fallback.
    }
    try {
      spawnSync('powershell.exe', [
        '-NoProfile',
        '-Command',
        `Stop-Process -Id ${Number(child.pid)} -Force -ErrorAction SilentlyContinue`,
      ], {
        stdio: 'ignore',
        timeout: 3000,
      });
    } catch {
      // taskkill/child.kill may already have handled the child.
    }
  }
  const hardKill = setTimeout(() => {
    try {
      child.kill('SIGKILL');
    } catch {
      // The process may already be gone.
    }
  }, 2000);
  hardKill.unref?.();
  return true;
}

function releaseChildHandles(child) {
  try {
    child?.stdin?.destroy?.();
  } catch {
    // Best-effort timeout cleanup only.
  }
  try {
    child?.stdout?.destroy?.();
  } catch {
    // Best-effort timeout cleanup only.
  }
  try {
    child?.stderr?.destroy?.();
  } catch {
    // Best-effort timeout cleanup only.
  }
  try {
    child?.unref?.();
  } catch {
    // Best-effort timeout cleanup only.
  }
}

function cleanupSourceIntakeGitProcesses(localPath) {
  if (process.platform !== 'win32') {
    return {
      attempted: false,
      reason: 'source_intake_git_process_cleanup_not_needed_on_non_windows',
    };
  }
  const startedAt = new Date().toISOString();
  const needle = path.resolve(localPath).replace(/'/g, "''");
  const script = [
    `$needle='${needle}'`,
    '$procs=Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like "*$needle*" -and ($_.Name -like "git*.exe" -or $_.Name -eq "ssh.exe") }',
    '$ids=@($procs | ForEach-Object { $_.ProcessId })',
    'if ($ids.Count -gt 0) { Stop-Process -Id $ids -Force -ErrorAction SilentlyContinue }',
    '$ids -join ","',
  ].join('; ');
  try {
    const result = spawnSync('powershell.exe', ['-NoProfile', '-Command', script], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      timeout: 8000,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const cleanedPids = String(result.stdout ?? '')
      .trim()
      .split(',')
      .map((value) => Number(value.trim()))
      .filter((value) => Number.isFinite(value) && value > 0);
    return {
      attempted: true,
      proofAuthority: 'source_intake_timeout_cleanup_only_not_gpu_hmr_success',
      proof_authority: 'source_intake_timeout_cleanup_only_not_gpu_hmr_success',
      acceptedForGpuHmr: false,
      accepted_for_gpu_hmr: false,
      gpuHmrSuccess: false,
      gpu_hmr_success: false,
      localPath: path.relative(REPO_ROOT, path.resolve(localPath)).replace(/\\/g, '/'),
      local_path: path.relative(REPO_ROOT, path.resolve(localPath)).replace(/\\/g, '/'),
      cleanedPids,
      cleaned_pids: cleanedPids,
      exitCode: result.status,
      exit_code: result.status,
      signal: result.signal,
      timedOut: result.error?.code === 'ETIMEDOUT',
      timed_out: result.error?.code === 'ETIMEDOUT',
      stderrTail: tail(result.stderr ?? '', 2000),
      stderr_tail: tail(result.stderr ?? '', 2000),
      startedAt,
      started_at: startedAt,
      finishedAt: new Date().toISOString(),
      finished_at: new Date().toISOString(),
    };
  } catch (error) {
    return {
      attempted: true,
      proofAuthority: 'source_intake_timeout_cleanup_only_not_gpu_hmr_success',
      proof_authority: 'source_intake_timeout_cleanup_only_not_gpu_hmr_success',
      acceptedForGpuHmr: false,
      accepted_for_gpu_hmr: false,
      gpuHmrSuccess: false,
      gpu_hmr_success: false,
      error: error?.message || String(error),
      startedAt,
      started_at: startedAt,
      finishedAt: new Date().toISOString(),
      finished_at: new Date().toISOString(),
    };
  }
}

function runProcess(command, args, options) {
  return new Promise((resolve) => {
    const {
      timeoutMs = 0,
      stdoutMax = 32000,
      stderrMax = 32000,
      streamOutput = true,
      ...spawnOptions
    } = options ?? {};
    const startedAt = new Date().toISOString();
    let child;
    try {
      child = spawn(command, args, spawnOptions);
    } catch (error) {
      resolve({
        exitCode: null,
        signal: null,
        error: error?.message || String(error),
        stdout: '',
        stderr: '',
        timedOut: false,
        timeoutMs: Number(timeoutMs) || 0,
        timeoutKillAttempted: false,
        childPid: null,
        startedAt,
        finishedAt: new Date().toISOString(),
      });
      return;
    }
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let timeoutKillAttempted = false;
    let settled = false;
    let timeoutFinalizeTimer = null;
    const timer = Number(timeoutMs) > 0
      ? setTimeout(() => {
        timedOut = true;
        timeoutKillAttempted = killChildTree(child);
        timeoutFinalizeTimer = setTimeout(() => {
          releaseChildHandles(child);
          finish({
            exitCode: null,
            signal: 'timeout-forced-finalize',
            error: 'process_timeout_forced_finalize',
            stdout,
            stderr,
          });
        }, 5000);
        timeoutFinalizeTimer.unref?.();
      }, Number(timeoutMs))
      : null;
    timer?.unref?.();
    const finish = (payload) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (timeoutFinalizeTimer) clearTimeout(timeoutFinalizeTimer);
      resolve({
        ...payload,
        timedOut,
        timeoutMs: Number(timeoutMs) || 0,
        timeoutKillAttempted,
        childPid: child.pid ?? null,
        startedAt,
        finishedAt: new Date().toISOString(),
      });
    };
    child.stdout?.on('data', (chunk) => {
      const text = String(chunk);
      stdout = tail(stdout + text, stdoutMax);
      if (streamOutput) process.stdout.write(text);
    });
    child.stderr?.on('data', (chunk) => {
      const text = String(chunk);
      stderr = tail(stderr + text, stderrMax);
      if (streamOutput) process.stderr.write(text);
    });
    child.on('error', (error) => {
      finish({ exitCode: null, signal: null, error: error.message, stdout, stderr });
    });
    child.on('close', (exitCode, signal) => {
      finish({ exitCode, signal, error: null, stdout, stderr });
    });
  });
}

function sourceIntakePathForCandidate(candidate) {
  return path.join(
    SOURCE_INTAKE_DIR,
    `${candidate.id}-${candidate.immutableCommit.slice(0, 12)}`,
  );
}

function classifySourceListing(files) {
  const buildFileBasenames = new Set([
    'cmakelists.txt',
    'makefile',
    'meson.build',
    'build.bazel',
    'workspace',
    'cargo.toml',
    'package.json',
    'pyproject.toml',
    'build.gradle',
    'configure.ac',
    'xmake.lua',
    'premake5.lua',
    'sconstruct',
    'sconscript',
    'build.gn',
  ]);
  const buildFileExtensions = new Set(['.sln', '.vcxproj', '.vcxproj.filters', '.csproj']);
  const gpuExtensions = new Set([
    '.hip',
    '.cu',
    '.cuh',
    '.cl',
    '.clh',
    '.wgsl',
    '.glsl',
    '.hlsl',
    '.spv',
    '.metal',
    '.comp',
    '.vert',
    '.frag',
    '.geom',
    '.tesc',
    '.tese',
    '.ll',
    '.mlir',
  ]);
  const backendSignals = new Map();
  const addBackend = (backend, pathName, reason) => {
    if (!backendSignals.has(backend)) backendSignals.set(backend, []);
    const entries = backendSignals.get(backend);
    if (entries.length < 20) entries.push({ path: pathName, reason });
  };
  const buildSignals = [];
  const gpuSourceSignals = [];
  for (const file of files) {
    const pathName = String(file.path ?? '');
    const lower = pathName.toLowerCase();
    const basename = lower.split('/').pop() ?? lower;
    const ext = path.extname(lower);
    if (buildFileBasenames.has(basename) || buildFileExtensions.has(ext)) {
      if (buildSignals.length < 80) buildSignals.push(pathName);
    }
    if (gpuExtensions.has(ext)) {
      if (gpuSourceSignals.length < 80) gpuSourceSignals.push(pathName);
    }
    if (ext === '.hip' || lower.includes('/hip/') || lower.includes('rocm')) addBackend('hip_rocm', pathName, 'path_or_extension');
    if (ext === '.cu' || ext === '.cuh' || lower.includes('cuda')) addBackend('cuda', pathName, 'path_or_extension');
    if (ext === '.cl' || ext === '.clh' || lower.includes('opencl')) addBackend('opencl', pathName, 'path_or_extension');
    if (ext === '.wgsl' || lower.includes('wgpu') || lower.includes('webgpu')) addBackend('webgpu_wgsl', pathName, 'path_or_extension');
    if (
      ['.spv', '.glsl', '.hlsl', '.comp', '.vert', '.frag', '.geom', '.tesc', '.tese'].includes(ext)
      || lower.includes('vulkan')
    ) addBackend('vulkan', pathName, 'path_or_extension');
    if (ext === '.metal' || lower.includes('/metal/')) addBackend('metal', pathName, 'path_or_extension');
    if (lower.includes('sycl') || lower.includes('dpcpp')) addBackend('sycl', pathName, 'path_or_extension');
  }
  const backendCandidates = [...backendSignals.keys()].sort();
  return {
    buildSignals,
    build_signals: buildSignals,
    buildSignalCount: buildSignals.length,
    build_signal_count: buildSignals.length,
    gpuSourceSignals,
    gpu_source_signals: gpuSourceSignals,
    gpuSourceSignalCount: gpuSourceSignals.length,
    gpu_source_signal_count: gpuSourceSignals.length,
    backendCandidates,
    backend_candidates: backendCandidates,
    backendSignals: Object.fromEntries(backendSignals),
    backend_signals: Object.fromEntries(backendSignals),
  };
}

function classifyBuildSystemPath(pathName) {
  const normalized = String(pathName ?? '').replace(/\\/g, '/');
  const lower = normalized.toLowerCase();
  const basename = lower.split('/').pop() ?? lower;
  const ext = path.extname(lower);
  if (basename === 'cmakelists.txt') return 'cmake';
  if (basename === 'cargo.toml') return 'cargo';
  if (basename === 'build.gn') return 'gn';
  if (basename === 'sconstruct' || basename === 'sconscript') return 'scons';
  if (basename === 'makefile') return 'make';
  if (basename === 'meson.build') return 'meson';
  if (basename === 'build.bazel' || basename === 'workspace') return 'bazel';
  if (basename === 'package.json') return 'npm_or_node';
  if (basename === 'pyproject.toml') return 'python_pyproject';
  if (basename === 'build.gradle') return 'gradle';
  if (basename === 'configure.ac') return 'autotools';
  if (basename === 'xmake.lua') return 'xmake';
  if (basename === 'premake5.lua') return 'premake';
  if (['.sln', '.vcxproj', '.vcxproj.filters', '.csproj'].includes(ext)) return 'msbuild';
  return 'unknown_build_file';
}

function summarizeBuildMetadataContent(pathName, text) {
  const family = classifyBuildSystemPath(pathName);
  const lines = String(text ?? '').split(/\r?\n/);
  const summary = {
    family,
    nonEmptyLineCount: lines.filter((line) => line.trim()).length,
    non_empty_line_count: lines.filter((line) => line.trim()).length,
  };
  if (family === 'cmake') {
    const projectMatch = String(text).match(/\bproject\s*\(\s*([A-Za-z0-9_.+-]+)/i);
    summary.projectName = projectMatch?.[1] ?? null;
    summary.project_name = projectMatch?.[1] ?? null;
    summary.addExecutableCount = (String(text).match(/\badd_executable\s*\(/gi) ?? []).length;
    summary.add_executable_count = summary.addExecutableCount;
    summary.addLibraryCount = (String(text).match(/\badd_library\s*\(/gi) ?? []).length;
    summary.add_library_count = summary.addLibraryCount;
  } else if (family === 'cargo') {
    summary.hasPackageSection = /^\s*\[package\]\s*$/mi.test(String(text));
    summary.has_package_section = summary.hasPackageSection;
    summary.hasWorkspaceSection = /^\s*\[workspace\]\s*$/mi.test(String(text));
    summary.has_workspace_section = summary.hasWorkspaceSection;
    summary.dependencySectionCount = (String(text).match(/^\s*\[(?:[\w.-]+\.)?dependencies[.\w-]*\]\s*$/gmi) ?? []).length;
    summary.dependency_section_count = summary.dependencySectionCount;
  } else if (family === 'npm_or_node') {
    try {
      const parsed = JSON.parse(String(text));
      summary.packageName = typeof parsed?.name === 'string' ? parsed.name : null;
      summary.package_name = summary.packageName;
      summary.scriptNames = parsed?.scripts && typeof parsed.scripts === 'object'
        ? Object.keys(parsed.scripts).sort().slice(0, 40)
        : [];
      summary.script_names = summary.scriptNames;
    } catch {
      summary.jsonParseError = true;
      summary.json_parse_error = true;
    }
  } else if (family === 'gn') {
    summary.targetDefinitionCount = (String(text).match(/\b(?:executable|source_set|static_library|shared_library|group)\s*\(/g) ?? []).length;
    summary.target_definition_count = summary.targetDefinitionCount;
  } else if (family === 'scons') {
    summary.programCallCount = (String(text).match(/\bProgram\s*\(/g) ?? []).length;
    summary.program_call_count = summary.programCallCount;
    summary.libraryCallCount = (String(text).match(/\b(?:Library|SharedLibrary|StaticLibrary)\s*\(/g) ?? []).length;
    summary.library_call_count = summary.libraryCallCount;
  }
  return summary;
}

function selectBuildFilesForContent({ files, classification, maxFiles = BUILD_METADATA_CONTENT_MAX_FILES }) {
  const byPath = new Map(files.map((file) => [String(file.path), file]));
  return (classification?.buildSignals ?? [])
    .map((pathName) => byPath.get(String(pathName)))
    .filter(Boolean)
    .slice(0, maxFiles);
}

async function readBuildFileContent({
  candidate,
  file,
  transport,
  transportEvidence,
  sourceIntakeTimeoutMs,
}) {
  const pathName = String(file.path ?? '');
  if (
    transport === 'local_git_ls_tree_clean_worktree'
    || transport === 'local_git_ls_tree_no_size_clean_worktree'
  ) {
    const noSizeLocalTransport = transport === 'local_git_ls_tree_no_size_clean_worktree';
    const lazyBlobFetchAllowed = !noSizeLocalTransport
      || process.env.SYNTHI_GPU_HMR_BLOBLESS_CONTENT_FETCH === '1';
    const repoPath = transportEvidence?.resolvedTopLevel ?? transportEvidence?.resolved_top_level ?? candidate.localRepoPath;
    const show = await runProcess(
      'git',
      ['-C', path.resolve(repoPath), 'show', `${candidate.immutableCommit}:${pathName}`],
      {
        cwd: REPO_ROOT,
        env: lazyBlobFetchAllowed
          ? process.env
          : {
            ...process.env,
            GIT_NO_LAZY_FETCH: '1',
          },
        timeoutMs: Math.min(sourceIntakeTimeoutMs, 60000),
        stdoutMax: BUILD_METADATA_CONTENT_MAX_BYTES + 4096,
        stderrMax: 16000,
        streamOutput: false,
      },
    );
    if (show.exitCode !== 0 || show.timedOut || show.error) {
      return {
        path: pathName,
        accepted: false,
        status: 'local_git_build_file_read_failed',
        reason: 'local_git_build_file_read_failed',
        lazyBlobFetchAllowed,
        lazy_blob_fetch_allowed: lazyBlobFetchAllowed,
        result: show,
      };
    }
    return {
      path: pathName,
      accepted: true,
      transport: noSizeLocalTransport ? 'local_git_no_size_show' : 'local_git_show',
      lazyBlobFetchAllowed,
      lazy_blob_fetch_allowed: lazyBlobFetchAllowed,
      content: show.stdout,
    };
  }
  if (transport === 'git_fetch_depth_1_blobless') {
    const lazyBlobFetchAllowed = process.env.SYNTHI_GPU_HMR_BLOBLESS_CONTENT_FETCH === '1';
    const repoPath = transportEvidence?.resolvedLocalPath
      ?? transportEvidence?.resolved_local_path
      ?? transportEvidence?.localPath
      ?? transportEvidence?.local_path;
    if (!repoPath) {
      return {
        path: pathName,
        accepted: false,
        status: 'git_fetch_build_file_repo_path_missing',
        reason: 'git_fetch_build_file_repo_path_missing',
        transport,
      };
    }
    const resolvedRepoPath = path.isAbsolute(String(repoPath))
      ? path.resolve(String(repoPath))
      : path.resolve(REPO_ROOT, String(repoPath));
    const show = await runProcess(
      'git',
      ['-C', resolvedRepoPath, 'show', `${candidate.immutableCommit}:${pathName}`],
      {
        cwd: REPO_ROOT,
        env: lazyBlobFetchAllowed
          ? process.env
          : {
            ...process.env,
            GIT_NO_LAZY_FETCH: '1',
          },
        timeoutMs: Math.min(sourceIntakeTimeoutMs, 60000),
        stdoutMax: BUILD_METADATA_CONTENT_MAX_BYTES + 4096,
        stderrMax: 16000,
        streamOutput: false,
      },
    );
    if (show.exitCode !== 0 || show.timedOut || show.error) {
      return {
        path: pathName,
        accepted: false,
        status: 'git_fetch_build_file_read_failed',
        reason: 'git_fetch_build_file_read_failed',
        transport,
        lazyBlobFetchAllowed,
        lazy_blob_fetch_allowed: lazyBlobFetchAllowed,
        result: show,
      };
    }
    return {
      path: pathName,
      accepted: true,
      transport: 'git_fetch_blobless_show',
      lazyBlobFetchAllowed,
      lazy_blob_fetch_allowed: lazyBlobFetchAllowed,
      content: show.stdout,
    };
  }
  if (transport === 'github_git_tree_api_recursive') {
    const parsed = parseGitHubRepoUrl(candidate.sourceUrl);
    if (!parsed) {
      return {
        path: pathName,
        accepted: false,
        status: 'github_build_file_blob_repo_unparsed',
        reason: 'github_build_file_blob_repo_unparsed',
      };
    }
    const apiUrl = `https://api.github.com/repos/${parsed.owner}/${parsed.repo}/git/blobs/${file.object}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.min(sourceIntakeTimeoutMs, 60000));
    timer.unref?.();
    try {
      const response = await fetch(apiUrl, {
        headers: {
          Accept: 'application/vnd.github+json',
          'User-Agent': 'synthi-gpu-hmr-random-cold-intake',
        },
        signal: controller.signal,
      });
      const text = await response.text();
      if (!response.ok) {
        return {
          path: pathName,
          accepted: false,
          status: 'github_build_file_blob_fetch_failed',
          reason: 'github_build_file_blob_fetch_failed',
          apiUrl,
          api_url: apiUrl,
          httpStatus: response.status,
          http_status: response.status,
          bodyTail: tail(text, 1000),
          body_tail: tail(text, 1000),
        };
      }
      const payload = JSON.parse(text);
      if (payload?.encoding !== 'base64' || typeof payload?.content !== 'string') {
        return {
          path: pathName,
          accepted: false,
          status: 'github_build_file_blob_encoding_unsupported',
          reason: 'github_build_file_blob_encoding_unsupported',
          apiUrl,
          api_url: apiUrl,
        };
      }
      const bytes = Buffer.from(payload.content.replace(/\s/g, ''), 'base64');
      return {
        path: pathName,
        accepted: true,
        transport: 'github_git_blob_api',
        apiUrl,
        api_url: apiUrl,
        content: bytes.toString('utf8', 0, Math.min(bytes.length, BUILD_METADATA_CONTENT_MAX_BYTES)),
        byteLength: bytes.length,
        byte_length: bytes.length,
        truncated: bytes.length > BUILD_METADATA_CONTENT_MAX_BYTES,
      };
    } catch (error) {
      return {
        path: pathName,
        accepted: false,
        status: error?.name === 'AbortError'
          ? 'github_build_file_blob_timeout'
          : 'github_build_file_blob_error',
        reason: error?.name === 'AbortError'
          ? 'github_build_file_blob_timeout'
          : 'github_build_file_blob_error',
        apiUrl,
        api_url: apiUrl,
        error: error?.message || String(error),
      };
    } finally {
      clearTimeout(timer);
    }
  }
  return {
    path: pathName,
    accepted: false,
    status: 'build_file_content_transport_unsupported',
    reason: 'build_file_content_transport_unsupported',
    transport,
  };
}

async function collectBuildMetadataContentEvidence({
  candidate,
  files,
  classification,
  transport,
  transportEvidence,
  sourceIntakeTimeoutMs,
}) {
  const selectedFiles = selectBuildFilesForContent({ files, classification });
  const startedAt = new Date().toISOString();
  const buildFiles = [];
  const failedFiles = [];
  for (const file of selectedFiles) {
    // Build file content is support evidence; keep it bounded and sequential to avoid
    // turning arbitrary project intake into an uncontrolled crawler.
    const result = await readBuildFileContent({
      candidate,
      file,
      transport,
      transportEvidence,
      sourceIntakeTimeoutMs,
    });
    if (result.accepted === true) {
      const content = String(result.content ?? '');
      buildFiles.push({
        path: file.path,
        family: classifyBuildSystemPath(file.path),
        object: file.object,
        declaredByteLength: file.byteLength,
        declared_byte_length: file.byteLength,
        observedByteLength: Number.isFinite(result.byteLength) ? result.byteLength : Buffer.byteLength(content),
        observed_byte_length: Number.isFinite(result.byteLength) ? result.byteLength : Buffer.byteLength(content),
        contentHash: contentHash(content),
        content_hash: contentHash(content),
        truncated: result.truncated === true || Buffer.byteLength(content) > BUILD_METADATA_CONTENT_MAX_BYTES,
        transport: result.transport,
        lazyBlobFetchAllowed: result.lazyBlobFetchAllowed === true,
        lazy_blob_fetch_allowed: result.lazyBlobFetchAllowed === true,
        semanticSummary: summarizeBuildMetadataContent(file.path, content),
        semantic_summary: summarizeBuildMetadataContent(file.path, content),
      });
    } else {
      failedFiles.push(result);
    }
  }
  const evidence = {
    schemaVersion: BUILD_METADATA_CONTENT_SCHEMA,
    schema_version: BUILD_METADATA_CONTENT_SCHEMA,
    proofAuthority: BUILD_METADATA_CONTENT_AUTHORITY,
    proof_authority: BUILD_METADATA_CONTENT_AUTHORITY,
    acceptedForGpuHmr: false,
    accepted_for_gpu_hmr: false,
    gpuHmrSuccess: false,
    gpu_hmr_success: false,
    canSatisfyRuntimeProof: false,
    can_satisfy_runtime_proof: false,
    acceptedAsBuildMetadataContent: buildFiles.length > 0,
    accepted_as_build_metadata_content: buildFiles.length > 0,
    completeForSelectedBuildFiles: failedFiles.length === 0 && buildFiles.length === selectedFiles.length,
    complete_for_selected_build_files: failedFiles.length === 0 && buildFiles.length === selectedFiles.length,
    selectedBuildFileCount: selectedFiles.length,
    selected_build_file_count: selectedFiles.length,
    acceptedBuildFileCount: buildFiles.length,
    accepted_build_file_count: buildFiles.length,
    failedBuildFileCount: failedFiles.length,
    failed_build_file_count: failedFiles.length,
    maxBuildFiles: BUILD_METADATA_CONTENT_MAX_FILES,
    max_build_files: BUILD_METADATA_CONTENT_MAX_FILES,
    maxBytesPerFile: BUILD_METADATA_CONTENT_MAX_BYTES,
    max_bytes_per_file: BUILD_METADATA_CONTENT_MAX_BYTES,
    buildFiles,
    build_files: buildFiles,
    failedFiles,
    failed_files: failedFiles,
    remainingVerificationGaps: [
      'build_command_execution_not_observed',
      'compile_database_not_verified',
      'runtime_profile_contract_missing',
    ],
    remaining_verification_gaps: [
      'build_command_execution_not_observed',
      'compile_database_not_verified',
      'runtime_profile_contract_missing',
    ],
    startedAt,
    started_at: startedAt,
    finishedAt: new Date().toISOString(),
    finished_at: new Date().toISOString(),
  };
  return {
    ...evidence,
    contentEvidenceHash: contentHash(stableJson(evidence)),
    content_evidence_hash: contentHash(stableJson(evidence)),
  };
}

function discoverBuildMetadata({ candidate, files, classification, contentEvidence = null }) {
  const buildSignals = Array.isArray(classification?.buildSignals)
    ? classification.buildSignals
    : [];
  const families = new Map();
  for (const pathName of buildSignals) {
    const family = classifyBuildSystemPath(pathName);
    if (!families.has(family)) families.set(family, []);
    const paths = families.get(family);
    if (paths.length < 20) paths.push(pathName);
  }
  const detectedFamilies = [...families.keys()].sort();
  const rootBuildFiles = buildSignals.filter((pathName) => !String(pathName).includes('/'));
  const blockingGaps = [];
  if (detectedFamilies.length === 0) blockingGaps.push('build_metadata_not_detected');
  const sourceFilesWithKnownBytes = files.filter((file) => Number.isFinite(file.byteLength)).length;
  const discovery = {
    schemaVersion: BUILD_METADATA_DISCOVERY_SCHEMA,
    schema_version: BUILD_METADATA_DISCOVERY_SCHEMA,
    proofAuthority: BUILD_METADATA_DISCOVERY_AUTHORITY,
    proof_authority: BUILD_METADATA_DISCOVERY_AUTHORITY,
    acceptedForGpuHmr: false,
    accepted_for_gpu_hmr: false,
    gpuHmrSuccess: false,
    gpu_hmr_success: false,
    canSatisfyRuntimeProof: false,
    can_satisfy_runtime_proof: false,
    acceptedAsBuildMetadataDiscovery: detectedFamilies.length > 0,
    accepted_as_build_metadata_discovery: detectedFamilies.length > 0,
    projectId: candidate.id,
    project_id: candidate.id,
    sourceUrl: candidate.sourceUrl,
    source_url: candidate.sourceUrl,
    immutableCommit: candidate.immutableCommit,
    immutable_commit: candidate.immutableCommit,
    detectedBuildSystems: detectedFamilies,
    detected_build_systems: detectedFamilies,
    buildSystemSignals: Object.fromEntries([...families.entries()].map(([family, paths]) => [family, paths])),
    build_system_signals: Object.fromEntries([...families.entries()].map(([family, paths]) => [family, paths])),
    rootBuildFiles,
    root_build_files: rootBuildFiles,
    buildSignalCount: buildSignals.length,
    build_signal_count: buildSignals.length,
    sourceFileCount: files.length,
    source_file_count: files.length,
    sourceFilesWithKnownBytes,
    source_files_with_known_bytes: sourceFilesWithKnownBytes,
    backendCandidates: classification?.backendCandidates ?? [],
    backend_candidates: classification?.backendCandidates ?? [],
    buildMetadataContentEvidence: contentEvidence,
    build_metadata_content_evidence: contentEvidence,
    buildMetadataContentAccepted: contentEvidence?.acceptedAsBuildMetadataContent === true,
    build_metadata_content_accepted: contentEvidence?.acceptedAsBuildMetadataContent === true,
    remainingVerificationGaps: [
      contentEvidence?.acceptedAsBuildMetadataContent === true
        ? 'semantic_build_metadata_execution_missing'
        : 'semantic_build_metadata_verification_missing',
      'build_command_execution_not_observed',
      'compile_database_not_verified',
      'runtime_profile_contract_missing',
    ],
    remaining_verification_gaps: [
      contentEvidence?.acceptedAsBuildMetadataContent === true
        ? 'semantic_build_metadata_execution_missing'
        : 'semantic_build_metadata_verification_missing',
      'build_command_execution_not_observed',
      'compile_database_not_verified',
      'runtime_profile_contract_missing',
    ],
    blockingGaps,
    blocking_gaps: blockingGaps,
  };
  return {
    ...discovery,
    discoveryHash: contentHash(stableJson(discovery)),
    discovery_hash: contentHash(stableJson(discovery)),
  };
}

function runtimeRequirementsForBackend(backend) {
  const commonStages = [
    'runtime_profile_contract',
    'artifact_transport',
    'same_process_loader',
    'epoch_publication',
    'dispatch_trace',
    'host_identity',
    'output_oracle',
    'cpu_full_rebuild_restart_firewall',
    'strict_runtime_ledger',
  ];
  const table = {
    hip_rocm: {
      backend,
      artifactKind: 'hsaco_or_hip_module',
      artifact_kind: 'hsaco_or_hip_module',
      requiredStages: commonStages,
      required_stages: commonStages,
      expectedRuntimeEvents: [
        'hip_module_load_or_code_object_load',
        'epoch_publish',
        'hip_kernel_dispatch',
        'stream_or_queue_identity',
        'readback_or_visual_output_after_dispatch',
      ],
      expected_runtime_events: [
        'hip_module_load_or_code_object_load',
        'epoch_publish',
        'hip_kernel_dispatch',
        'stream_or_queue_identity',
        'readback_or_visual_output_after_dispatch',
      ],
      acceptableOracleKinds: ['compute_readback', 'deterministic_visual_oracle'],
      acceptable_oracle_kinds: ['compute_readback', 'deterministic_visual_oracle'],
    },
    opencl: {
      backend,
      artifactKind: 'opencl_program',
      artifact_kind: 'opencl_program',
      requiredStages: commonStages,
      required_stages: commonStages,
      expectedRuntimeEvents: [
        'program_build_or_load',
        'epoch_publish',
        'cl_enqueue_kernel',
        'command_queue_identity',
        'cl_enqueue_read_buffer_after_event',
      ],
      expected_runtime_events: [
        'program_build_or_load',
        'epoch_publish',
        'cl_enqueue_kernel',
        'command_queue_identity',
        'cl_enqueue_read_buffer_after_event',
      ],
      acceptableOracleKinds: ['compute_readback'],
      acceptable_oracle_kinds: ['compute_readback'],
    },
    vulkan: {
      backend,
      artifactKind: 'spirv_pipeline',
      artifact_kind: 'spirv_pipeline',
      requiredStages: commonStages.concat(['pipeline_layout_binding', 'command_buffer_re_record_or_dynamic_binding']),
      required_stages: commonStages.concat(['pipeline_layout_binding', 'command_buffer_re_record_or_dynamic_binding']),
      expectedRuntimeEvents: [
        'shader_module_or_pipeline_create',
        'pipeline_epoch_publish',
        'command_buffer_or_dispatch_bind',
        'queue_device_identity',
        'readback_or_frame_capture_after_epoch_dispatch',
      ],
      expected_runtime_events: [
        'shader_module_or_pipeline_create',
        'pipeline_epoch_publish',
        'command_buffer_or_dispatch_bind',
        'queue_device_identity',
        'readback_or_frame_capture_after_epoch_dispatch',
      ],
      acceptableOracleKinds: ['deterministic_visual_oracle', 'compute_readback'],
      acceptable_oracle_kinds: ['deterministic_visual_oracle', 'compute_readback'],
    },
    webgpu_wgsl: {
      backend,
      artifactKind: 'wgsl_shader_module_or_pipeline',
      artifact_kind: 'wgsl_shader_module_or_pipeline',
      requiredStages: commonStages.concat(['pipeline_recreate_or_asset_reload']),
      required_stages: commonStages.concat(['pipeline_recreate_or_asset_reload']),
      expectedRuntimeEvents: [
        'shader_module_create',
        'pipeline_epoch_publish',
        'pass_dispatch_or_draw',
        'device_queue_identity',
        'mapped_buffer_or_frame_capture_after_epoch_dispatch',
      ],
      expected_runtime_events: [
        'shader_module_create',
        'pipeline_epoch_publish',
        'pass_dispatch_or_draw',
        'device_queue_identity',
        'mapped_buffer_or_frame_capture_after_epoch_dispatch',
      ],
      acceptableOracleKinds: ['mapped_buffer_readback', 'deterministic_visual_oracle'],
      acceptable_oracle_kinds: ['mapped_buffer_readback', 'deterministic_visual_oracle'],
    },
    metal: {
      backend,
      artifactKind: 'metal_shader_library_or_pipeline',
      artifact_kind: 'metal_shader_library_or_pipeline',
      requiredStages: commonStages.concat(['pipeline_recreate_or_library_reload']),
      required_stages: commonStages.concat(['pipeline_recreate_or_library_reload']),
      expectedRuntimeEvents: [
        'library_or_pipeline_create',
        'pipeline_epoch_publish',
        'command_encoder_dispatch_or_draw',
        'device_queue_identity',
        'buffer_or_frame_capture_after_epoch_dispatch',
      ],
      expected_runtime_events: [
        'library_or_pipeline_create',
        'pipeline_epoch_publish',
        'command_encoder_dispatch_or_draw',
        'device_queue_identity',
        'buffer_or_frame_capture_after_epoch_dispatch',
      ],
      acceptableOracleKinds: ['deterministic_visual_oracle', 'compute_readback'],
      acceptable_oracle_kinds: ['deterministic_visual_oracle', 'compute_readback'],
    },
    cuda: {
      backend,
      artifactKind: 'cuda_cubin_or_ptx',
      artifact_kind: 'cuda_cubin_or_ptx',
      requiredStages: commonStages,
      required_stages: commonStages,
      expectedRuntimeEvents: [
        'cuda_module_load_or_jit',
        'epoch_publish',
        'cuda_kernel_launch',
        'stream_context_identity',
        'readback_or_visual_output_after_dispatch',
      ],
      expected_runtime_events: [
        'cuda_module_load_or_jit',
        'epoch_publish',
        'cuda_kernel_launch',
        'stream_context_identity',
        'readback_or_visual_output_after_dispatch',
      ],
      acceptableOracleKinds: ['compute_readback', 'deterministic_visual_oracle'],
      acceptable_oracle_kinds: ['compute_readback', 'deterministic_visual_oracle'],
    },
    sycl: {
      backend,
      artifactKind: 'sycl_bundle_or_device_image',
      artifact_kind: 'sycl_bundle_or_device_image',
      requiredStages: commonStages,
      required_stages: commonStages,
      expectedRuntimeEvents: [
        'device_image_or_bundle_load',
        'epoch_publish',
        'queue_submit_kernel',
        'queue_device_identity',
        'readback_or_visual_output_after_dispatch',
      ],
      expected_runtime_events: [
        'device_image_or_bundle_load',
        'epoch_publish',
        'queue_submit_kernel',
        'queue_device_identity',
        'readback_or_visual_output_after_dispatch',
      ],
      acceptableOracleKinds: ['compute_readback', 'deterministic_visual_oracle'],
      acceptable_oracle_kinds: ['compute_readback', 'deterministic_visual_oracle'],
    },
  };
  return table[backend] ?? {
    backend,
    artifactKind: 'unknown',
    artifact_kind: 'unknown',
    requiredStages: commonStages,
    required_stages: commonStages,
    expectedRuntimeEvents: [
      'artifact_load',
      'epoch_publish',
      'dispatch_trace',
      'host_identity',
      'output_oracle_after_dispatch',
    ],
    expected_runtime_events: [
      'artifact_load',
      'epoch_publish',
      'dispatch_trace',
      'host_identity',
      'output_oracle_after_dispatch',
    ],
    acceptableOracleKinds: ['compute_readback', 'deterministic_visual_oracle'],
    acceptable_oracle_kinds: ['compute_readback', 'deterministic_visual_oracle'],
  };
}

function deriveRuntimeBoundaryExpectation({ candidate, classification, buildMetadataDiscovery }) {
  const backendCandidates = Array.isArray(classification?.backendCandidates)
    ? classification.backendCandidates
    : [];
  const perBackendRequirements = backendCandidates.map(runtimeRequirementsForBackend);
  const requiredBoundaryStages = [
    ...new Set(perBackendRequirements.flatMap((entry) => entry.requiredStages ?? [])),
  ].sort();
  const expectedRuntimeEvents = [
    ...new Set(perBackendRequirements.flatMap((entry) => entry.expectedRuntimeEvents ?? [])),
  ].sort();
  const acceptableOracleKinds = [
    ...new Set([
      ...perBackendRequirements.flatMap((entry) => entry.acceptableOracleKinds ?? []),
      ...(
        Array.isArray(candidate?.oracleHints?.expectedKinds)
          ? candidate.oracleHints.expectedKinds
          : []
      ),
    ]),
  ].sort();
  const missingRuntimeEvidenceGaps = [
    'runtime_profile_contract_missing',
    'artifact_transport_unproven',
    'same_process_loader_unproven',
    'epoch_publication_unproven',
    'dispatch_trace_unproven',
    'host_identity_unproven',
    'output_oracle_unproven',
    'cpu_full_rebuild_restart_firewall_unproven',
    'strict_runtime_ledger_missing',
  ];
  const blockingGaps = [];
  if (backendCandidates.length === 0) blockingGaps.push('runtime_backend_candidate_missing');
  if (buildMetadataDiscovery?.acceptedAsBuildMetadataDiscovery !== true) {
    blockingGaps.push('build_metadata_discovery_missing');
  }
  const facet = {
    schemaVersion: RUNTIME_BOUNDARY_EXPECTATION_SCHEMA,
    schema_version: RUNTIME_BOUNDARY_EXPECTATION_SCHEMA,
    proofAuthority: RUNTIME_BOUNDARY_EXPECTATION_AUTHORITY,
    proof_authority: RUNTIME_BOUNDARY_EXPECTATION_AUTHORITY,
    acceptedForGpuHmr: false,
    accepted_for_gpu_hmr: false,
    gpuHmrSuccess: false,
    gpu_hmr_success: false,
    canSatisfyRuntimeProof: false,
    can_satisfy_runtime_proof: false,
    acceptedAsRuntimeBoundaryExpectation: blockingGaps.length === 0,
    accepted_as_runtime_boundary_expectation: blockingGaps.length === 0,
    projectId: candidate.id,
    project_id: candidate.id,
    sourceUrl: candidate.sourceUrl,
    source_url: candidate.sourceUrl,
    immutableCommit: candidate.immutableCommit,
    immutable_commit: candidate.immutableCommit,
    backendCandidates,
    backend_candidates: backendCandidates,
    buildSystems: buildMetadataDiscovery?.detectedBuildSystems ?? [],
    build_systems: buildMetadataDiscovery?.detectedBuildSystems ?? [],
    requiredBoundaryStages,
    required_boundary_stages: requiredBoundaryStages,
    expectedRuntimeEvents,
    expected_runtime_events: expectedRuntimeEvents,
    acceptableOracleKinds,
    acceptable_oracle_kinds: acceptableOracleKinds,
    perBackendRequirements,
    per_backend_requirements: perBackendRequirements,
    runtimeBoundaryHints: candidate.runtimeBoundaryHints ?? {},
    runtime_boundary_hints: candidate.runtimeBoundaryHints ?? {},
    oracleHints: candidate.oracleHints ?? {},
    oracle_hints: candidate.oracleHints ?? {},
    missingRuntimeEvidenceGaps,
    missing_runtime_evidence_gaps: missingRuntimeEvidenceGaps,
    blockingGaps,
    blocking_gaps: blockingGaps,
  };
  return {
    ...facet,
    expectationHash: contentHash(stableJson(facet)),
    expectation_hash: contentHash(stableJson(facet)),
  };
}

function runtimeBoundaryLineTokenForKind(kind) {
  const tokens = {
    artifact_transport: 'artifact_transport',
    epoch_publication: 'dispatcher_epoch',
    dispatch_trace: 'synthi_gpu_launch',
    host_identity: 'host_identity',
    output_oracle: 'output_oracle',
  };
  return tokens[kind] ?? kind;
}

function runtimeBoundaryBaseTemplateFields(kind) {
  const fields = {
    artifact_transport: [
      'runtime_session',
      'process_id',
      'artifact_hash',
      'artifact_kind',
      'artifact_locator_or_path',
      'loader_target',
    ],
    epoch_publication: [
      'runtime_session',
      'process_id',
      'epoch',
      'generation',
      'artifact_hash',
      'dispatch_table_entry',
      'publish_timestamp_ns',
    ],
    dispatch_trace: [
      'runtime_session',
      'process_id',
      'dispatch_id',
      'epoch',
      'generation',
      'artifact_hash',
      'dispatch_api',
      'output_target',
      'timestamp_ns',
    ],
    host_identity: [
      'runtime_session',
      'process_id',
      'device_uuid',
      'context_id',
      'queue_or_stream_id',
      'host_identity_previous_generation',
      'host_identity_active_generation',
      'runner_process_identity',
      'runtime_resource_identity',
    ],
    output_oracle: [
      'runtime_session',
      'process_id',
      'after_dispatch_id',
      'epoch',
      'output_target',
      'oracle_kind',
      'oracle_artifact_hash',
      'timestamp_after_dispatch_ns',
    ],
  };
  return fields[kind] ?? ['runtime_session', 'process_id'];
}

function runtimeBoundaryBackendTemplateFields(backend, kind) {
  const fields = {
    hip_rocm: {
      artifact_transport: ['hsaco_hash', 'hip_module_handle'],
      epoch_publication: ['hip_function_handle', 'stream_id'],
      dispatch_trace: ['kernel_name', 'grid_dim', 'block_dim', 'shared_mem_bytes', 'stream_id'],
      host_identity: ['hip_context_id', 'stream_id'],
      output_oracle: ['hip_event_after_dispatch', 'readback_buffer_hash'],
    },
    opencl: {
      artifact_transport: ['program_hash', 'kernel_name'],
      epoch_publication: ['program_epoch', 'kernel_handle'],
      dispatch_trace: ['kernel_name', 'command_queue', 'work_dim', 'global_work_size', 'local_work_size'],
      host_identity: ['platform_id', 'device_id', 'command_queue'],
      output_oracle: ['cl_event_id', 'raw_readback_hash', 'readback_schema_hash'],
    },
    vulkan: {
      artifact_transport: ['spirv_hash', 'shader_module_handle'],
      epoch_publication: ['pipeline_handle', 'pipeline_layout_hash'],
      dispatch_trace: ['command_buffer_id', 'pipeline_handle', 'descriptor_set_layout_hash'],
      host_identity: ['vk_device_id', 'queue_family_index', 'queue_handle'],
      output_oracle: ['fence_id', 'swapchain_size', 'before_image_hash', 'after_image_hash', 'diff_image_hash'],
    },
    webgpu_wgsl: {
      artifact_transport: ['wgsl_hash', 'shader_module_label'],
      epoch_publication: ['shader_module_epoch', 'pipeline_layout_hash'],
      dispatch_trace: ['pass_encoder_id', 'pipeline_label', 'bind_group_layout_hash'],
      host_identity: ['adapter_id', 'device_id', 'queue_id'],
      output_oracle: ['mapped_buffer_hash', 'before_image_hash', 'after_image_hash', 'diff_image_hash'],
    },
    metal: {
      artifact_transport: ['metal_library_hash', 'function_name'],
      epoch_publication: ['pipeline_state_handle', 'library_epoch'],
      dispatch_trace: ['command_buffer_id', 'command_encoder_id', 'pipeline_state_handle'],
      host_identity: ['metal_device_id', 'command_queue_id'],
      output_oracle: ['completed_command_buffer_id', 'buffer_hash', 'drawable_image_hash'],
    },
    cuda: {
      artifact_transport: ['cubin_or_ptx_hash', 'cuda_module_handle'],
      epoch_publication: ['cuda_function_handle', 'stream_id'],
      dispatch_trace: ['kernel_name', 'grid_dim', 'block_dim', 'shared_mem_bytes', 'stream_id'],
      host_identity: ['cuda_context_id', 'stream_id'],
      output_oracle: ['cuda_event_after_dispatch', 'raw_readback_hash', 'readback_schema_hash'],
    },
    sycl: {
      artifact_transport: ['device_image_hash', 'kernel_bundle_hash'],
      epoch_publication: ['kernel_bundle_epoch', 'kernel_id'],
      dispatch_trace: ['queue_submit_id', 'kernel_name', 'nd_range'],
      host_identity: ['sycl_device_id', 'sycl_context_id', 'sycl_queue_id'],
      output_oracle: ['event_after_dispatch', 'raw_readback_hash', 'readback_schema_hash'],
    },
  };
  return fields[backend]?.[kind] ?? [];
}

function runtimeBoundaryOracleAlternatives(acceptableOracleKinds) {
  const kinds = uniqueSortedStrings(acceptableOracleKinds);
  const alternatives = [];
  if (kinds.includes('compute_readback') || kinds.includes('mapped_buffer_readback')) {
    alternatives.push({
      mode: 'compute_readback',
      mode_kind: 'compute_readback',
      requiredFields: ['raw_readback_hash', 'readback_schema_hash', 'checksum_after'],
      required_fields: ['raw_readback_hash', 'readback_schema_hash', 'checksum_after'],
    });
  }
  if (kinds.includes('deterministic_visual_oracle')) {
    alternatives.push({
      mode: 'deterministic_visual_oracle',
      mode_kind: 'deterministic_visual_oracle',
      requiredFields: ['before_image_hash', 'after_image_hash', 'diff_image_hash', 'camera_state_hash'],
      required_fields: ['before_image_hash', 'after_image_hash', 'diff_image_hash', 'camera_state_hash'],
    });
  }
  return alternatives;
}

function runtimeBoundaryEventObjectTemplate({ kind, backendCandidates, acceptableOracleKinds }) {
  const requiredFields = runtimeBoundaryBaseTemplateFields(kind);
  const backendSpecificFields = uniqueSortedStrings(
    backendCandidates.flatMap((backend) => runtimeBoundaryBackendTemplateFields(backend, kind)),
  );
  const fieldPlaceholders = {};
  for (const field of requiredFields) fieldPlaceholders[field] = `required:${field}`;
  const token = runtimeBoundaryLineTokenForKind(kind);
  const exampleFields = requiredFields
    .slice(0, 8)
    .map((field) => `${field}=${field.toUpperCase()}`)
    .join(' ');
  const template = {
    schemaVersion: RUNTIME_BOUNDARY_EVENT_SCHEMA,
    schema_version: RUNTIME_BOUNDARY_EVENT_SCHEMA,
    eventKind: kind,
    event_kind: kind,
    boundaryLineToken: token,
    boundary_line_token: token,
    requiredFields,
    required_fields: requiredFields,
    backendSpecificFields,
    backend_specific_fields: backendSpecificFields,
    fieldPlaceholders,
    field_placeholders: fieldPlaceholders,
    exampleBoundaryLineTemplate: `[gpu-runtime-boundary] ${token} ${exampleFields}`,
    example_boundary_line_template: `[gpu-runtime-boundary] ${token} ${exampleFields}`,
    acceptedForGpuHmr: false,
    accepted_for_gpu_hmr: false,
    gpuHmrSuccess: false,
    gpu_hmr_success: false,
    canSatisfyRuntimeProof: false,
    can_satisfy_runtime_proof: false,
    canSatisfyDispatchProof: false,
    can_satisfy_dispatch_proof: false,
  };
  if (kind === 'output_oracle') {
    template.oracleFieldAlternatives = runtimeBoundaryOracleAlternatives(acceptableOracleKinds);
    template.oracle_field_alternatives = template.oracleFieldAlternatives;
  }
  return {
    ...template,
    templateHash: contentHash(stableJson(template)),
    template_hash: contentHash(stableJson(template)),
  };
}

function deriveRuntimeBoundaryEventManifestTemplate({ candidate, runtimeBoundaryExpectation }) {
  const backendCandidates = uniqueSortedStrings(runtimeBoundaryExpectation?.backendCandidates ?? []);
  const acceptableOracleKinds = uniqueSortedStrings(runtimeBoundaryExpectation?.acceptableOracleKinds ?? []);
  const eventObjectTemplates = REQUIRED_RUNTIME_BOUNDARY_EVENT_KINDS.map((kind) =>
    runtimeBoundaryEventObjectTemplate({ kind, backendCandidates, acceptableOracleKinds }));
  const presentKinds = new Set(eventObjectTemplates.map((entry) => entry.eventKind));
  const missingEventKinds = REQUIRED_RUNTIME_BOUNDARY_EVENT_KINDS.filter((kind) => !presentKinds.has(kind));
  const expectationAccepted =
    runtimeBoundaryExpectation?.acceptedAsRuntimeBoundaryExpectation === true;
  const blockingGaps = uniqueSortedStrings([
    ...(expectationAccepted ? [] : ['runtime_boundary_expectation_not_accepted']),
    ...(Array.isArray(runtimeBoundaryExpectation?.blockingGaps)
      ? runtimeBoundaryExpectation.blockingGaps
      : []),
    ...missingEventKinds.map((kind) => `runtime_boundary_event_template_${kind}_missing`),
  ]);
  const accepted = blockingGaps.length === 0;
  const manifestTemplate = {
    schemaVersion: RUNTIME_BOUNDARY_EVENT_MANIFEST_SCHEMA,
    schema_version: RUNTIME_BOUNDARY_EVENT_MANIFEST_SCHEMA,
    proofAuthority: RUNTIME_BOUNDARY_EVENT_TEMPLATE_AUTHORITY,
    proof_authority: RUNTIME_BOUNDARY_EVENT_TEMPLATE_AUTHORITY,
    acceptedForGpuHmr: false,
    accepted_for_gpu_hmr: false,
    gpuHmrSuccess: false,
    gpu_hmr_success: false,
    canSatisfyRuntimeProof: false,
    can_satisfy_runtime_proof: false,
    requiresObservedRuntimeEvents: true,
    requires_observed_runtime_events: true,
    runtimeBoundaryEventsPlaceholder:
      'populate_runtimeBoundaryEvents_with_observed_target_process_events_only',
    runtime_boundary_events_placeholder:
      'populate_runtimeBoundaryEvents_with_observed_target_process_events_only',
    eventObjectTemplates,
    event_object_templates: eventObjectTemplates,
  };
  const facet = {
    schemaVersion: RUNTIME_BOUNDARY_EVENT_TEMPLATE_SCHEMA,
    schema_version: RUNTIME_BOUNDARY_EVENT_TEMPLATE_SCHEMA,
    proofAuthority: RUNTIME_BOUNDARY_EVENT_TEMPLATE_AUTHORITY,
    proof_authority: RUNTIME_BOUNDARY_EVENT_TEMPLATE_AUTHORITY,
    acceptedForGpuHmr: false,
    accepted_for_gpu_hmr: false,
    gpuHmrSuccess: false,
    gpu_hmr_success: false,
    canSatisfyRuntimeProof: false,
    can_satisfy_runtime_proof: false,
    canSatisfyDispatchProof: false,
    can_satisfy_dispatch_proof: false,
    acceptedAsRuntimeBoundaryEventManifestTemplate: accepted,
    accepted_as_runtime_boundary_event_manifest_template: accepted,
    projectId: candidate.id,
    project_id: candidate.id,
    sourceUrl: candidate.sourceUrl,
    source_url: candidate.sourceUrl,
    immutableCommit: candidate.immutableCommit,
    immutable_commit: candidate.immutableCommit,
    sourceExpectationHash: runtimeBoundaryExpectation?.expectationHash ?? null,
    source_expectation_hash: runtimeBoundaryExpectation?.expectation_hash ?? null,
    runtimeBoundaryEventSchema: RUNTIME_BOUNDARY_EVENT_SCHEMA,
    runtime_boundary_event_schema: RUNTIME_BOUNDARY_EVENT_SCHEMA,
    eventManifestSchema: RUNTIME_BOUNDARY_EVENT_MANIFEST_SCHEMA,
    event_manifest_schema: RUNTIME_BOUNDARY_EVENT_MANIFEST_SCHEMA,
    requiredEventKinds: REQUIRED_RUNTIME_BOUNDARY_EVENT_KINDS,
    required_event_kinds: REQUIRED_RUNTIME_BOUNDARY_EVENT_KINDS,
    backendCandidates,
    backend_candidates: backendCandidates,
    acceptableOracleKinds,
    acceptable_oracle_kinds: acceptableOracleKinds,
    eventObjectTemplates,
    event_object_templates: eventObjectTemplates,
    eventTemplateHashes: eventObjectTemplates.map((entry) => entry.templateHash),
    event_template_hashes: eventObjectTemplates.map((entry) => entry.templateHash),
    manifestTemplate,
    manifest_template: manifestTemplate,
    environmentAliases: [
      'SYNTHI_GPU_HMR_RUNTIME_BOUNDARY_EVENT_MANIFEST_PATH',
      'SYNTHI_REAL_ROCM_RUNTIME_BOUNDARY_EVENT_MANIFEST_PATH',
      'SYNTHI_GPU_HMR_RUNTIME_ADAPTER_EVENT_MANIFEST_PATH',
      'SYNTHI_REAL_ROCM_RUNTIME_ADAPTER_EVENT_MANIFEST_PATH',
    ],
    environment_aliases: [
      'SYNTHI_GPU_HMR_RUNTIME_BOUNDARY_EVENT_MANIFEST_PATH',
      'SYNTHI_REAL_ROCM_RUNTIME_BOUNDARY_EVENT_MANIFEST_PATH',
      'SYNTHI_GPU_HMR_RUNTIME_ADAPTER_EVENT_MANIFEST_PATH',
      'SYNTHI_REAL_ROCM_RUNTIME_ADAPTER_EVENT_MANIFEST_PATH',
    ],
    missingRuntimeEvidenceGaps: runtimeBoundaryExpectation?.missingRuntimeEvidenceGaps ?? [],
    missing_runtime_evidence_gaps: runtimeBoundaryExpectation?.missing_runtime_evidence_gaps ?? [],
    blockingGaps,
    blocking_gaps: blockingGaps,
  };
  return {
    ...facet,
    templateHash: contentHash(stableJson(facet)),
    template_hash: contentHash(stableJson(facet)),
  };
}

function parseGitLsTree(text) {
  return String(text ?? '')
    .split(/\r?\n/)
    .map((line) => {
      const match = line.match(/^(\d+)\s+(\w+)\s+([0-9a-f]{40,64})(?:\s+(-|\d+))?\t(.+)$/i);
      if (!match) return null;
      const declaredSize = match[4];
      return {
        mode: match[1],
        type: match[2],
        object: match[3],
        byteLength: declaredSize == null || declaredSize === '-' ? null : Number(declaredSize),
        byte_length: declaredSize == null || declaredSize === '-' ? null : Number(declaredSize),
        path: match[5],
      };
    })
    .filter(Boolean);
}

function parseGitHubRepoUrl(sourceUrl) {
  let parsed;
  try {
    parsed = new URL(String(sourceUrl));
  } catch {
    return null;
  }
  if (parsed.hostname.toLowerCase() !== 'github.com') return null;
  const [owner, rawRepo] = parsed.pathname.split('/').filter(Boolean);
  if (!owner || !rawRepo) return null;
  const repo = rawRepo.replace(/\.git$/i, '');
  if (!/^[A-Za-z0-9_.-]+$/.test(owner) || !/^[A-Za-z0-9_.-]+$/.test(repo)) return null;
  return { owner, repo };
}

async function fetchGitHubTreeListing(candidate, { sourceIntakeTimeoutMs }) {
  const parsed = parseGitHubRepoUrl(candidate.sourceUrl);
  if (!parsed) return { attempted: false };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), sourceIntakeTimeoutMs);
  timer.unref?.();
  const apiUrl = `https://api.github.com/repos/${parsed.owner}/${parsed.repo}/git/trees/${candidate.immutableCommit}?recursive=1`;
  const startedAt = new Date().toISOString();
  try {
    const response = await fetch(apiUrl, {
      headers: {
        Accept: 'application/vnd.github+json',
        'User-Agent': 'synthi-gpu-hmr-random-cold-intake',
      },
      signal: controller.signal,
    });
    const text = await response.text();
    if (!response.ok) {
      return {
        attempted: true,
        accepted: false,
        status: 'source_intake_github_tree_failed',
        reason: 'source_tree_github_tree_fetch_failed',
        apiUrl,
        api_url: apiUrl,
        httpStatus: response.status,
        http_status: response.status,
        bodyTail: tail(text, 2000),
        body_tail: tail(text, 2000),
        startedAt,
        started_at: startedAt,
        finishedAt: new Date().toISOString(),
        finished_at: new Date().toISOString(),
      };
    }
    const payload = JSON.parse(text);
    if (payload?.truncated === true) {
      return {
        attempted: true,
        accepted: false,
        status: 'source_intake_github_tree_truncated',
        reason: 'source_tree_github_tree_truncated',
        apiUrl,
        api_url: apiUrl,
        startedAt,
        started_at: startedAt,
        finishedAt: new Date().toISOString(),
        finished_at: new Date().toISOString(),
      };
    }
    const files = Array.isArray(payload?.tree)
      ? payload.tree
        .filter((entry) => entry?.type === 'blob' && entry.path && entry.sha)
        .map((entry) => ({
          mode: String(entry.mode ?? ''),
          type: 'blob',
          object: String(entry.sha),
          byteLength: Number.isFinite(entry.size) ? entry.size : null,
          byte_length: Number.isFinite(entry.size) ? entry.size : null,
          path: String(entry.path),
        }))
      : [];
    return {
      attempted: true,
      accepted: true,
      apiUrl,
      api_url: apiUrl,
      transport: 'github_git_tree_api_recursive',
      files,
      startedAt,
      started_at: startedAt,
      finishedAt: new Date().toISOString(),
      finished_at: new Date().toISOString(),
    };
  } catch (error) {
    return {
      attempted: true,
      accepted: false,
      status: error?.name === 'AbortError'
        ? 'source_intake_github_tree_timeout'
        : 'source_intake_github_tree_error',
      reason: error?.name === 'AbortError'
        ? 'source_tree_github_tree_timeout'
        : 'source_tree_github_tree_error',
      apiUrl,
      api_url: apiUrl,
      error: error?.message || String(error),
      startedAt,
      started_at: startedAt,
      finishedAt: new Date().toISOString(),
      finished_at: new Date().toISOString(),
    };
  } finally {
    clearTimeout(timer);
  }
}

async function readLocalGitTreeListing(candidate, { sourceIntakeTimeoutMs }) {
  if (!candidate.localRepoPath) return { attempted: false };
  const repoPath = path.resolve(candidate.localRepoPath);
  const startedAt = new Date().toISOString();
  const noSizeListing = process.env.SYNTHI_GPU_HMR_LOCAL_GIT_NO_SIZE === '1';
  const baseRunOptions = {
    cwd: REPO_ROOT,
    timeoutMs: Math.min(sourceIntakeTimeoutMs, 60000),
    stdoutMax: 8 * 1024 * 1024,
    stderrMax: 64000,
    streamOutput: false,
  };
  const topLevel = await runProcess(
    'git',
    ['-C', repoPath, 'rev-parse', '--show-toplevel'],
    baseRunOptions,
  );
  if (topLevel.exitCode !== 0 || topLevel.timedOut || topLevel.error) {
    return {
      attempted: true,
      accepted: false,
      status: 'source_intake_local_git_top_level_failed',
      reason: 'source_tree_local_git_top_level_failed',
      repoPath,
      repo_path: repoPath,
      topLevel,
      top_level: topLevel,
      startedAt,
      started_at: startedAt,
      finishedAt: new Date().toISOString(),
      finished_at: new Date().toISOString(),
    };
  }
  const resolvedTopLevel = path.resolve(topLevel.stdout.trim());
  const commitCheck = await runProcess(
    'git',
    ['-C', resolvedTopLevel, 'cat-file', '-e', `${candidate.immutableCommit}^{commit}`],
    baseRunOptions,
  );
  if (commitCheck.exitCode !== 0 || commitCheck.timedOut || commitCheck.error) {
    return {
      attempted: true,
      accepted: false,
      status: 'source_intake_local_git_commit_missing',
      reason: 'source_tree_local_git_commit_missing',
      repoPath,
      repo_path: repoPath,
      resolvedTopLevel,
      resolved_top_level: resolvedTopLevel,
      commitCheck,
      commit_check: commitCheck,
      startedAt,
      started_at: startedAt,
      finishedAt: new Date().toISOString(),
      finished_at: new Date().toISOString(),
    };
  }
  const dirtyCheck = await runProcess(
    'git',
    ['-C', resolvedTopLevel, 'status', '--porcelain=v1', '--untracked-files=all'],
    baseRunOptions,
  );
  if (dirtyCheck.exitCode !== 0 || dirtyCheck.timedOut || dirtyCheck.error) {
    return {
      attempted: true,
      accepted: false,
      status: 'source_intake_local_git_status_failed',
      reason: 'source_tree_local_git_status_failed',
      repoPath,
      repo_path: repoPath,
      resolvedTopLevel,
      resolved_top_level: resolvedTopLevel,
      dirtyCheck,
      dirty_check: dirtyCheck,
      startedAt,
      started_at: startedAt,
      finishedAt: new Date().toISOString(),
      finished_at: new Date().toISOString(),
    };
  }
  if (dirtyCheck.stdout.trim()) {
    return {
      attempted: true,
      accepted: false,
      status: 'source_intake_local_git_dirty',
      reason: 'source_tree_local_worktree_dirty',
      repoPath,
      repo_path: repoPath,
      resolvedTopLevel,
      resolved_top_level: resolvedTopLevel,
      dirtyStatusTail: tail(dirtyCheck.stdout, 4000),
      dirty_status_tail: tail(dirtyCheck.stdout, 4000),
      startedAt,
      started_at: startedAt,
      finishedAt: new Date().toISOString(),
      finished_at: new Date().toISOString(),
    };
  }
  const lsTree = await runProcess(
    'git',
    noSizeListing
      ? ['-C', resolvedTopLevel, 'ls-tree', '-r', '--full-tree', candidate.immutableCommit]
      : ['-C', resolvedTopLevel, 'ls-tree', '-r', '-l', '--full-tree', candidate.immutableCommit],
    baseRunOptions,
  );
  if (lsTree.exitCode !== 0 || lsTree.timedOut || lsTree.error) {
    return {
      attempted: true,
      accepted: false,
      status: 'source_intake_local_git_listing_failed',
      reason: 'source_tree_local_git_listing_failed',
      repoPath,
      repo_path: repoPath,
      resolvedTopLevel,
      resolved_top_level: resolvedTopLevel,
      lsTree,
      ls_tree: lsTree,
      startedAt,
      started_at: startedAt,
      finishedAt: new Date().toISOString(),
      finished_at: new Date().toISOString(),
    };
  }
  return {
    attempted: true,
    accepted: true,
    transport: noSizeListing
      ? 'local_git_ls_tree_no_size_clean_worktree'
      : 'local_git_ls_tree_clean_worktree',
    repoPath,
    repo_path: repoPath,
    resolvedTopLevel,
    resolved_top_level: resolvedTopLevel,
    listingMode: noSizeListing ? 'git_ls_tree_no_size' : 'git_ls_tree_with_size',
    listing_mode: noSizeListing ? 'git_ls_tree_no_size' : 'git_ls_tree_with_size',
    byteLengthMode: noSizeListing ? 'unknown_avoids_blob_fetch' : 'declared_from_git_ls_tree_l',
    byte_length_mode: noSizeListing ? 'unknown_avoids_blob_fetch' : 'declared_from_git_ls_tree_l',
    files: parseGitLsTree(lsTree.stdout),
    startedAt,
    started_at: startedAt,
    finishedAt: new Date().toISOString(),
    finished_at: new Date().toISOString(),
  };
}

async function buildAcceptedSourceIntakeFacet({
  base,
  candidate,
  files,
  transport,
  transportEvidence = {},
  sourceIntakeTimeoutMs,
}) {
  const listingIdentity = files.map((file) => ({
    path: file.path,
    object: file.object,
    byteLength: file.byteLength,
  }));
  const totalKnownBytes = files.reduce((sum, file) => sum + (Number.isFinite(file.byteLength) ? file.byteLength : 0), 0);
  const classification = classifySourceListing(files);
  const buildMetadataContentEvidence = await collectBuildMetadataContentEvidence({
    candidate,
    files,
    classification,
    transport,
    transportEvidence,
    sourceIntakeTimeoutMs,
  });
  const buildMetadataDiscovery = discoverBuildMetadata({
    candidate,
    files,
    classification,
    contentEvidence: buildMetadataContentEvidence,
  });
  const runtimeBoundaryExpectation = deriveRuntimeBoundaryExpectation({
    candidate,
    classification,
    buildMetadataDiscovery,
  });
  const runtimeBoundaryEventManifestTemplate = deriveRuntimeBoundaryEventManifestTemplate({
    candidate,
    runtimeBoundaryExpectation,
  });
  const blockingGaps = [];
  if (classification.buildSignalCount === 0) blockingGaps.push('build_system_metadata_not_detected');
  if (classification.backendCandidates.length === 0) blockingGaps.push('gpu_backend_signal_not_detected');
  const facet = {
    ...base,
    status: 'source_intake_listing_accepted',
    acceptedAsIntakeEvidence: true,
    accepted_as_intake_evidence: true,
    transport,
    sourceTransport: transport,
    source_transport: transport,
    transportEvidence,
    transport_evidence: transportEvidence,
    fileCount: files.length,
    file_count: files.length,
    totalKnownBytes,
    total_known_bytes: totalKnownBytes,
    listingHash: contentHash(stableJson(listingIdentity)),
    listing_hash: contentHash(stableJson(listingIdentity)),
    sampleFiles: files.slice(0, 80).map((file) => file.path),
    sample_files: files.slice(0, 80).map((file) => file.path),
    buildSystemHints: candidate.buildSystemHints,
    build_system_hints: candidate.buildSystemHints,
    buildMetadataDiscovery,
    build_metadata_discovery: buildMetadataDiscovery,
    buildMetadataDiscoveryAccepted: buildMetadataDiscovery.acceptedAsBuildMetadataDiscovery === true,
    build_metadata_discovery_accepted: buildMetadataDiscovery.acceptedAsBuildMetadataDiscovery === true,
    buildMetadataContentEvidence,
    build_metadata_content_evidence: buildMetadataContentEvidence,
    buildMetadataContentAccepted: buildMetadataContentEvidence.acceptedAsBuildMetadataContent === true,
    build_metadata_content_accepted: buildMetadataContentEvidence.acceptedAsBuildMetadataContent === true,
    runtimeBoundaryExpectation,
    runtime_boundary_expectation: runtimeBoundaryExpectation,
    runtimeBoundaryExpectationAccepted:
      runtimeBoundaryExpectation.acceptedAsRuntimeBoundaryExpectation === true,
    runtime_boundary_expectation_accepted:
      runtimeBoundaryExpectation.acceptedAsRuntimeBoundaryExpectation === true,
    runtimeBoundaryEventManifestTemplate,
    runtime_boundary_event_manifest_template: runtimeBoundaryEventManifestTemplate,
    runtimeBoundaryEventManifestTemplateAccepted:
      runtimeBoundaryEventManifestTemplate.acceptedAsRuntimeBoundaryEventManifestTemplate === true,
    runtime_boundary_event_manifest_template_accepted:
      runtimeBoundaryEventManifestTemplate.acceptedAsRuntimeBoundaryEventManifestTemplate === true,
    runtimeBoundaryHints: candidate.runtimeBoundaryHints,
    runtime_boundary_hints: candidate.runtimeBoundaryHints,
    oracleHints: candidate.oracleHints,
    oracle_hints: candidate.oracleHints,
    ...classification,
    blockingGaps,
    blocking_gaps: blockingGaps,
    finishedAt: new Date().toISOString(),
    finished_at: new Date().toISOString(),
  };
  return {
    ...facet,
    facetHash: contentHash(stableJson(facet)),
    facet_hash: contentHash(stableJson(facet)),
  };
}

async function runUnprofiledSourceIntake(candidate, { sourceIntakeTimeoutMs }) {
  const startedAt = new Date().toISOString();
  const localPath = sourceIntakePathForCandidate(candidate);
  const relativeLocalPath = path.relative(REPO_ROOT, localPath).replace(/\\/g, '/');
  const liveGitFallbackEnabled = process.env.SYNTHI_GPU_HMR_UNPROFILED_GIT_FALLBACK === '1';
  const forceGitFallbackEnabled = process.env.SYNTHI_GPU_HMR_UNPROFILED_FORCE_GIT_FALLBACK === '1';
  const base = {
    schemaVersion: SOURCE_INTAKE_SCHEMA,
    schema_version: SOURCE_INTAKE_SCHEMA,
    proofAuthority: SOURCE_INTAKE_AUTHORITY,
    proof_authority: SOURCE_INTAKE_AUTHORITY,
    acceptedForGpuHmr: false,
    accepted_for_gpu_hmr: false,
    gpuHmrSuccess: false,
    gpu_hmr_success: false,
    canSatisfyRuntimeProof: false,
    can_satisfy_runtime_proof: false,
    sourceUrl: candidate.sourceUrl,
    source_url: candidate.sourceUrl,
    localRepoPath: candidate.localRepoPath,
    local_repo_path: candidate.localRepoPath,
    immutableCommit: candidate.immutableCommit,
    immutable_commit: candidate.immutableCommit,
    localPath: relativeLocalPath,
    local_path: relativeLocalPath,
    gitFallbackForced: forceGitFallbackEnabled,
    git_fallback_forced: forceGitFallbackEnabled,
    startedAt,
    started_at: startedAt,
  };
  const fail = (status, reason, extra = {}) => {
    const facet = {
      ...base,
      status,
      acceptedAsIntakeEvidence: false,
      accepted_as_intake_evidence: false,
      blockingGaps: [reason],
      blocking_gaps: [reason],
      ...extra,
      finishedAt: new Date().toISOString(),
      finished_at: new Date().toISOString(),
    };
    return {
      ...facet,
      facetHash: contentHash(stableJson(facet)),
      facet_hash: contentHash(stableJson(facet)),
    };
  };
  const localGitListing = await readLocalGitTreeListing(candidate, { sourceIntakeTimeoutMs });
  if (localGitListing.attempted === true) {
    if (localGitListing.accepted !== true) {
      return fail(localGitListing.status, localGitListing.reason, {
        localGitListing,
        local_git_listing: localGitListing,
      });
    }
    if (!Array.isArray(localGitListing.files) || localGitListing.files.length === 0) {
      return fail('source_intake_local_git_empty_listing', 'source_tree_local_git_empty_listing', {
        localGitListing,
        local_git_listing: localGitListing,
      });
    }
    return await buildAcceptedSourceIntakeFacet({
      base,
      candidate,
      files: localGitListing.files,
      transport: localGitListing.transport,
      transportEvidence: {
        repoPath: localGitListing.repoPath,
        repo_path: localGitListing.repo_path,
        resolvedTopLevel: localGitListing.resolvedTopLevel,
        resolved_top_level: localGitListing.resolved_top_level,
        listingMode: localGitListing.listingMode,
        listing_mode: localGitListing.listing_mode,
        byteLengthMode: localGitListing.byteLengthMode,
        byte_length_mode: localGitListing.byte_length_mode,
        startedAt: localGitListing.startedAt,
        started_at: localGitListing.started_at,
        finishedAt: localGitListing.finishedAt,
        finished_at: localGitListing.finished_at,
      },
      sourceIntakeTimeoutMs,
    });
  }
  await rm(localPath, { recursive: true, force: true });
  const githubTree = forceGitFallbackEnabled
    ? { attempted: false, skipped: true, reason: 'forced_git_fallback_for_source_tree_intake' }
    : await fetchGitHubTreeListing(candidate, { sourceIntakeTimeoutMs });
  let githubTreeFallback = forceGitFallbackEnabled
    ? {
      reason: 'forced_git_fallback_for_source_tree_intake',
      forcedByEnv: 'SYNTHI_GPU_HMR_UNPROFILED_FORCE_GIT_FALLBACK=1',
      forced_by_env: 'SYNTHI_GPU_HMR_UNPROFILED_FORCE_GIT_FALLBACK=1',
    }
    : null;
  if (githubTree.attempted === true) {
    if (githubTree.accepted !== true) {
      if (githubTree.status === 'source_intake_github_tree_truncated') {
        if (!liveGitFallbackEnabled) {
          const gitFallbackPlan = {
            available: true,
            available_authority: 'fallback_plan_only_not_source_intake_or_gpu_hmr_success',
            recommendedTransport: 'git_fetch_depth_1_blobless',
            recommended_transport: 'git_fetch_depth_1_blobless',
            requiresExplicitOptIn: true,
            requires_explicit_opt_in: true,
            optInEnv: 'SYNTHI_GPU_HMR_UNPROFILED_GIT_FALLBACK=1',
            opt_in_env: 'SYNTHI_GPU_HMR_UNPROFILED_GIT_FALLBACK=1',
            reason: 'github_recursive_tree_truncated',
          };
          return fail('source_intake_github_tree_truncated_git_fallback_disabled', githubTree.reason, {
            githubTree,
            github_tree: githubTree,
            gitFallbackPlan,
            git_fallback_plan: gitFallbackPlan,
          });
        }
        githubTreeFallback = {
          reason: 'github_recursive_tree_truncated_falling_back_to_blobless_git_tree',
          githubTree,
          github_tree: githubTree,
        };
      } else {
        return fail(githubTree.status, githubTree.reason, {
          githubTree,
          github_tree: githubTree,
        });
      }
    } else {
      if (!Array.isArray(githubTree.files) || githubTree.files.length === 0) {
        return fail('source_intake_empty_listing', 'source_tree_listing_empty', {
          githubTree,
          github_tree: githubTree,
        });
      }
      return await buildAcceptedSourceIntakeFacet({
        base,
        candidate,
        files: githubTree.files,
        transport: githubTree.transport,
        transportEvidence: {
          apiUrl: githubTree.apiUrl,
          api_url: githubTree.api_url,
          startedAt: githubTree.startedAt,
          started_at: githubTree.started_at,
          finishedAt: githubTree.finishedAt,
          finished_at: githubTree.finished_at,
        },
        sourceIntakeTimeoutMs,
      });
    }
  }
  await mkdir(localPath, { recursive: true });
  const gitInit = await runProcess(
    'git',
    ['init', localPath],
    {
      cwd: REPO_ROOT,
      timeoutMs: Math.min(sourceIntakeTimeoutMs, 30000),
      stdoutMax: 64000,
      stderrMax: 64000,
      streamOutput: false,
    },
  );
  if (gitInit.exitCode !== 0 || gitInit.timedOut || gitInit.error) {
    return fail('source_intake_git_init_failed', 'source_tree_git_init_failed', {
      gitInit,
      git_init: gitInit,
    });
  }
  const remoteAdd = await runProcess(
    'git',
    ['-C', localPath, 'remote', 'add', 'origin', candidate.sourceUrl],
    {
      cwd: REPO_ROOT,
      timeoutMs: Math.min(sourceIntakeTimeoutMs, 30000),
      stdoutMax: 64000,
      stderrMax: 64000,
      streamOutput: false,
    },
  );
  if (remoteAdd.exitCode !== 0 || remoteAdd.timedOut || remoteAdd.error) {
    return fail('source_intake_remote_add_failed', 'source_tree_remote_add_failed', {
      remoteAdd,
      remote_add: remoteAdd,
    });
  }
  const fetch = await runProcess(
    'git',
    ['-C', localPath, 'fetch', '--depth=1', '--filter=blob:none', 'origin', candidate.immutableCommit],
    {
      cwd: REPO_ROOT,
      timeoutMs: sourceIntakeTimeoutMs,
      stdoutMax: 64000,
      stderrMax: 64000,
      streamOutput: false,
    },
  );
  if (fetch.exitCode !== 0 || fetch.timedOut || fetch.error) {
    const sourceIntakeProcessCleanup = fetch.timedOut || fetch.error
      ? cleanupSourceIntakeGitProcesses(localPath)
      : null;
    return fail('source_intake_fetch_failed', 'source_tree_fetch_failed', {
      fetch,
      fetch_result: fetch,
      sourceIntakeProcessCleanup,
      source_intake_process_cleanup: sourceIntakeProcessCleanup,
    });
  }
  const commitCheck = await runProcess(
    'git',
    ['-C', localPath, 'cat-file', '-e', `${candidate.immutableCommit}^{commit}`],
    {
      cwd: REPO_ROOT,
      timeoutMs: Math.min(sourceIntakeTimeoutMs, 60000),
      streamOutput: false,
    },
  );
  if (commitCheck.exitCode !== 0 || commitCheck.timedOut || commitCheck.error) {
    return fail('source_intake_commit_missing', 'immutable_commit_not_available', {
      commitCheck,
      commit_check: commitCheck,
    });
  }
  const lsTree = await runProcess(
    'git',
    ['-C', localPath, 'ls-tree', '-r', '--full-tree', candidate.immutableCommit],
    {
      cwd: REPO_ROOT,
      timeoutMs: Math.min(sourceIntakeTimeoutMs, 120000),
      stdoutMax: 8 * 1024 * 1024,
      stderrMax: 64000,
      streamOutput: false,
    },
  );
  if (lsTree.exitCode !== 0 || lsTree.timedOut || lsTree.error) {
    const sourceIntakeProcessCleanup = lsTree.timedOut || lsTree.error
      ? cleanupSourceIntakeGitProcesses(localPath)
      : null;
    return fail('source_intake_listing_failed', 'source_tree_listing_failed', {
      listingResult: lsTree,
      listing_result: lsTree,
      sourceIntakeProcessCleanup,
      source_intake_process_cleanup: sourceIntakeProcessCleanup,
    });
  }
  const files = parseGitLsTree(lsTree.stdout);
  if (files.length === 0) {
    return fail('source_intake_empty_listing', 'source_tree_listing_empty');
  }
  return await buildAcceptedSourceIntakeFacet({
    base,
    candidate,
    files,
    transport: 'git_fetch_depth_1_blobless',
    transportEvidence: {
      githubTreeFallback,
      github_tree_fallback: githubTreeFallback,
      listingMode: 'git_ls_tree_no_size_blobless',
      listing_mode: 'git_ls_tree_no_size_blobless',
      byteLengthMode: 'unknown_avoids_blob_fetch',
      byte_length_mode: 'unknown_avoids_blob_fetch',
      resolvedLocalPath: localPath,
      resolved_local_path: localPath,
      localPath: relativeLocalPath,
      local_path: relativeLocalPath,
      gitInit,
      git_init: gitInit,
      remoteAdd,
      remote_add: remoteAdd,
      fetch,
      fetch_result: fetch,
    },
    sourceIntakeTimeoutMs,
  });
}

async function runSelectedCandidate(
  candidate,
  { dryRun, timeoutMs, runnerTimeoutMs, sourceIntake, sourceIntakeTimeoutMs },
) {
  if (dryRun) {
    return {
      candidateId: candidate.id,
      status: 'selected_not_executed_dry_run',
      acceptedForGpuHmr: false,
      gpuHmrSuccess: false,
      canSatisfyRuntimeProof: false,
    };
  }
  if (!candidate.profilePath || candidate.backendFamily !== 'real_rocm') {
    const sourceIntakeEvidence = sourceIntake === true
      ? await runUnprofiledSourceIntake(candidate, { sourceIntakeTimeoutMs })
      : null;
    const sourceTreeIntakeAccepted = sourceIntakeEvidence?.acceptedAsIntakeEvidence === true;
    const buildMetadataDiscoveryAccepted = sourceIntakeEvidence?.buildMetadataDiscoveryAccepted === true;
    const buildMetadataContentAccepted = sourceIntakeEvidence?.buildMetadataContentAccepted === true;
    const runtimeBoundaryExpectationAccepted =
      sourceIntakeEvidence?.runtimeBoundaryExpectationAccepted === true;
    const runtimeBoundaryEventManifestTemplateAccepted =
      sourceIntakeEvidence?.runtimeBoundaryEventManifestTemplateAccepted === true;
    const buildMetadataGap = buildMetadataContentAccepted
      ? 'semantic_build_metadata_execution_missing'
      : (buildMetadataDiscoveryAccepted
        ? 'semantic_build_metadata_verification_missing'
        : 'build_metadata_unverified');
    const blockingGaps = [
      'runtime_profile_contract_missing',
      buildMetadataGap,
      'same_process_loader_unproven',
      'epoch_publication_unproven',
      'dispatch_trace_unproven',
      'host_identity_unproven',
      'output_oracle_unproven',
      'strict_runtime_ledger_missing',
    ];
    if (!sourceTreeIntakeAccepted) {
      blockingGaps.unshift('source_tree_intake_missing');
    }
    if (candidate.backendFamily !== 'real_rocm') {
      blockingGaps.unshift('local_backend_runner_unavailable');
    }
    return {
      candidateId: candidate.id,
      status: 'unprofiled_arbitrary_project_cold_intake_refused',
      backendFamily: candidate.backendFamily,
      backend_family: candidate.backendFamily,
      profileMode: candidate.profileMode,
      profile_mode: candidate.profileMode,
      runnerAttempted: false,
      runner_attempted: false,
      sourceUrl: candidate.sourceUrl,
      source_url: candidate.sourceUrl,
      localRepoPath: candidate.localRepoPath,
      local_repo_path: candidate.localRepoPath,
      immutableCommit: candidate.immutableCommit,
      immutable_commit: candidate.immutableCommit,
      sourceTreeIntakeAccepted,
      source_tree_intake_accepted: sourceTreeIntakeAccepted,
      buildMetadataDiscoveryAccepted,
      build_metadata_discovery_accepted: buildMetadataDiscoveryAccepted,
      buildMetadataContentAccepted,
      build_metadata_content_accepted: buildMetadataContentAccepted,
      buildMetadataDiscovery: sourceIntakeEvidence?.buildMetadataDiscovery ?? null,
      build_metadata_discovery: sourceIntakeEvidence?.build_metadata_discovery ?? null,
      buildMetadataContentEvidence: sourceIntakeEvidence?.buildMetadataContentEvidence ?? null,
      build_metadata_content_evidence: sourceIntakeEvidence?.build_metadata_content_evidence ?? null,
      runtimeBoundaryExpectationAccepted,
      runtime_boundary_expectation_accepted: runtimeBoundaryExpectationAccepted,
      runtimeBoundaryExpectation: sourceIntakeEvidence?.runtimeBoundaryExpectation ?? null,
      runtime_boundary_expectation: sourceIntakeEvidence?.runtime_boundary_expectation ?? null,
      runtimeBoundaryEventManifestTemplateAccepted,
      runtime_boundary_event_manifest_template_accepted: runtimeBoundaryEventManifestTemplateAccepted,
      runtimeBoundaryEventManifestTemplate:
        sourceIntakeEvidence?.runtimeBoundaryEventManifestTemplate ?? null,
      runtime_boundary_event_manifest_template:
        sourceIntakeEvidence?.runtime_boundary_event_manifest_template ?? null,
      sourceIntakeEvidence,
      source_intake_evidence: sourceIntakeEvidence,
      blockingGaps,
      blocking_gaps: blockingGaps,
      unsupportedReasons: blockingGaps,
      unsupported_reasons: blockingGaps,
      acceptedForGpuHmr: false,
      gpuHmrSuccess: false,
      canSatisfyRuntimeProof: false,
    };
  }
  const env = {
    ...process.env,
    SYNTHI_REAL_ROCM_PROFILE_PATH: candidate.profilePath,
    SYNTHI_VALIDATION_AUTHLESS_WORKSPACE: '1',
    SYNTHI_REAL_ROCM_COMPILE_TRANSPORT: 'workspace-ref',
    SYNTHI_REAL_ROCM_REQUIRE_FULL_RUNTIME_PROOF: '1',
    SYNTHI_REAL_ROCM_REQUIRE_ORIGINAL_HOST_PATH_PROOF: '1',
    SYNTHI_REAL_ROCM_NATIVE_LAUNCH_OBSERVER: '1',
    SYNTHI_REAL_ROCM_REUSE_WORKER_REPO: '0',
    SYNTHI_REAL_ROCM_CLEAN_BUILD: '1',
    SYNTHI_REAL_ROCM_UPSTREAM_TIMEOUT_SOURCE: 'caller_env',
    SYNTHI_REAL_ROCM_UPSTREAM_TIMEOUT_MS: String(timeoutMs),
  };
  const result = await runProcess(
    process.execPath,
    [path.join(SCRIPT_DIR, 'gpu-hmr-real-rocm-repo-validation.mjs')],
    { cwd: REPO_ROOT, env, stdio: ['ignore', 'pipe', 'pipe'], timeoutMs: runnerTimeoutMs },
  );
  return {
    candidateId: candidate.id,
    status: result.timedOut
      ? 'runner_timeout_failed_closed'
      : (result.exitCode === 0 ? 'runner_completed' : 'runner_failed_closed_or_error'),
    exitCode: result.exitCode,
    signal: result.signal,
    error: result.error,
    timedOut: result.timedOut,
    timed_out: result.timedOut,
    runnerTimeoutMs: result.timeoutMs,
    runner_timeout_ms: result.timeoutMs,
    timeoutKillAttempted: result.timeoutKillAttempted,
    timeout_kill_attempted: result.timeoutKillAttempted,
    childPid: result.childPid,
    child_pid: result.childPid,
    startedAt: result.startedAt,
    started_at: result.startedAt,
    finishedAt: result.finishedAt,
    finished_at: result.finishedAt,
    stdoutTail: tail(result.stdout),
    stderrTail: tail(result.stderr),
    acceptedForGpuHmr: false,
    gpuHmrSuccess: false,
    canSatisfyRuntimeProof: false,
  };
}

async function writeManifest(manifest, outputDir = LOG_DIR, { suffix = '', filePath = null } = {}) {
  await mkdir(outputDir, { recursive: true });
  const stamp = manifest.runId ?? manifest.run_id ?? makeStamp();
  const resolvedFilePath = filePath ?? path.join(outputDir, `random-large-project-cold-path-${stamp}${suffix}.json`);
  const body = `${JSON.stringify(manifest, null, 2)}\n`;
  await writeFile(resolvedFilePath, body);
  return { filePath: resolvedFilePath, hash: contentHash(body) };
}

async function buildManifest({
  seed,
  count,
  candidateId,
  dryRun,
  timeoutMs,
  runnerTimeoutMs,
  sourceIntake,
  sourceIntakeTimeoutMs,
  candidates,
  outputDir,
  runCandidate = runSelectedCandidate,
}) {
  const selected = selectCandidates({ candidates, seed, count, candidateId });
  const runId = makeStamp();
  const startedAt = new Date().toISOString();
  let pendingWritten = null;
  if (!dryRun) {
    const pendingManifest = createManifest({
      runId,
      seed,
      count,
      candidateId,
      dryRun,
      timeoutMs,
      runnerTimeoutMs,
      sourceIntake,
      sourceIntakeTimeoutMs,
      candidates,
      selected,
      startedAt,
      finishedAt: null,
      eventType: 'cold_path_pending',
      status: 'pending',
      results: selected.map((candidate) => ({
        candidateId: candidate.id,
        status: 'selected_pending_execution',
        acceptedForGpuHmr: false,
        gpuHmrSuccess: false,
        canSatisfyRuntimeProof: false,
      })),
    });
    pendingWritten = await writeManifest(pendingManifest, outputDir, { suffix: '-pending' });
  }
  const results = [];
  for (const candidate of selected) {
    try {
      results.push(await runCandidate(candidate, {
        dryRun,
        timeoutMs,
        runnerTimeoutMs,
        sourceIntake,
        sourceIntakeTimeoutMs,
      }));
    } catch (error) {
      results.push({
        candidateId: candidate.id,
        status: 'sampler_candidate_error_failed_closed',
        error: error?.message || String(error),
        acceptedForGpuHmr: false,
        gpuHmrSuccess: false,
        canSatisfyRuntimeProof: false,
      });
    }
  }
  const finishedAt = new Date().toISOString();
  const manifest = createManifest({
    runId,
    seed,
    count,
    candidateId,
    dryRun,
    timeoutMs,
    runnerTimeoutMs,
    sourceIntake,
    sourceIntakeTimeoutMs,
    candidates,
    selected,
    startedAt,
    finishedAt,
    eventType: 'cold_path_complete',
    status: 'complete',
    results,
    pendingWritten,
  });
  const written = await writeManifest(manifest, outputDir);
  return { manifest: { ...manifest, manifestPath: written.filePath, manifestHash: written.hash }, written };
}

function createManifest({
  runId,
  seed,
  count,
  candidateId,
  dryRun,
  timeoutMs,
  runnerTimeoutMs,
  sourceIntake,
  sourceIntakeTimeoutMs,
  candidates,
  selected,
  startedAt,
  finishedAt,
  eventType,
  status,
  results,
  pendingWritten = null,
}) {
  return {
    schemaVersion: SCHEMA,
    schema_version: SCHEMA,
    proofAuthority: AUTHORITY,
    proof_authority: AUTHORITY,
    acceptedForGpuHmr: false,
    accepted_for_gpu_hmr: false,
    gpuHmrSuccess: false,
    gpu_hmr_success: false,
    canSatisfyRuntimeProof: false,
    can_satisfy_runtime_proof: false,
    runId,
    run_id: runId,
    eventType,
    event_type: eventType,
    status,
    startedAt,
    started_at: startedAt,
    finishedAt,
    finished_at: finishedAt,
    selection: {
      seed,
      requestedCount: Number(count) || 1,
      requested_count: Number(count) || 1,
      candidateId: candidateId || null,
      candidate_id: candidateId || null,
      candidateCount: candidates.length,
      candidate_count: candidates.length,
      selectedIds: selected.map((candidate) => candidate.id),
      selected_ids: selected.map((candidate) => candidate.id),
      selectionHash: contentHash(stableJson(selected.map((candidate) => ({
        id: candidate.id,
        key: candidate.selectionKey,
      })))),
      selection_hash: contentHash(stableJson(selected.map((candidate) => ({
        id: candidate.id,
        key: candidate.selectionKey,
      })))),
    },
    candidates: candidates.map((candidate) => ({
      id: candidate.id,
      backendFamily: candidate.backendFamily,
      backend_family: candidate.backendFamily,
      profileMode: candidate.profileMode,
      profile_mode: candidate.profileMode,
      candidateSource: candidate.candidateSource,
      candidate_source: candidate.candidateSource,
      sourceUrl: candidate.sourceUrl,
      source_url: candidate.sourceUrl,
      localRepoPath: candidate.localRepoPath,
      local_repo_path: candidate.localRepoPath,
      immutableCommit: candidate.immutableCommit,
      immutable_commit: candidate.immutableCommit,
      sizeSignals: candidate.sizeSignals,
      size_signals: candidate.sizeSignals,
      buildSystemHints: candidate.buildSystemHints,
      build_system_hints: candidate.buildSystemHints,
      runtimeBoundaryHints: candidate.runtimeBoundaryHints,
      runtime_boundary_hints: candidate.runtimeBoundaryHints,
      oracleHints: candidate.oracleHints,
      oracle_hints: candidate.oracleHints,
    })),
    selectedCandidates: selected.map((candidate) => ({
      id: candidate.id,
      backendFamily: candidate.backendFamily,
      backend_family: candidate.backendFamily,
      profilePath: candidate.profilePath,
      profile_path: candidate.profilePath,
      profileMode: candidate.profileMode,
      profile_mode: candidate.profileMode,
      candidateSource: candidate.candidateSource,
      candidate_source: candidate.candidateSource,
      sourceUrl: candidate.sourceUrl,
      source_url: candidate.sourceUrl,
      localRepoPath: candidate.localRepoPath,
      local_repo_path: candidate.localRepoPath,
      immutableCommit: candidate.immutableCommit,
      immutable_commit: candidate.immutableCommit,
      selectionRank: candidate.selectionRank,
      selection_rank: candidate.selectionRank,
      selectionKey: candidate.selectionKey,
      selection_key: candidate.selectionKey,
      sizeSignals: candidate.sizeSignals,
      size_signals: candidate.sizeSignals,
      buildSystemHints: candidate.buildSystemHints,
      build_system_hints: candidate.buildSystemHints,
      runtimeBoundaryHints: candidate.runtimeBoundaryHints,
      runtime_boundary_hints: candidate.runtimeBoundaryHints,
      oracleHints: candidate.oracleHints,
      oracle_hints: candidate.oracleHints,
    })),
    dryRun,
    dry_run: dryRun,
    timeoutMs,
    timeout_ms: timeoutMs,
    runnerTimeoutMs,
    runner_timeout_ms: runnerTimeoutMs,
    sourceIntake,
    source_intake: sourceIntake,
    sourceIntakeTimeoutMs,
    source_intake_timeout_ms: sourceIntakeTimeoutMs,
    pendingManifestPath: pendingWritten?.filePath ?? null,
    pending_manifest_path: pendingWritten?.filePath ?? null,
    pendingManifestHash: pendingWritten?.hash ?? null,
    pending_manifest_hash: pendingWritten?.hash ?? null,
    results,
  };
}

async function selfCheck() {
  const defaultCandidates = await loadCandidates();
  const defaultUnprofiledCandidates = defaultCandidates.filter(
    (candidate) => candidate.profileMode === 'unprofiled_arbitrary_project_cold_intake',
  );
  if (
    defaultCandidates.length < 6
    || defaultUnprofiledCandidates.length < 3
    || !defaultUnprofiledCandidates.every((candidate) => candidate.profilePath === null)
  ) {
    throw new Error('random large-project cold-path default pool must include unprofiled arbitrary project intake candidates');
  }
  const candidates = [
    cleanCandidate({
      id: 'alpha-large',
      backendFamily: 'real_rocm',
      profilePath: path.join(SCRIPT_DIR, 'profiles', 'real-rocm-saxpy.json'),
      sourceUrl: 'https://example.invalid/alpha.git',
      immutableCommit: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    }),
    cleanCandidate({
      id: 'beta-large',
      backendFamily: 'real_rocm',
      profilePath: path.join(SCRIPT_DIR, 'profiles', 'real-rocm-saxpy.json'),
      sourceUrl: 'https://example.invalid/beta.git',
      immutableCommit: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    }),
    cleanCandidate({
      id: 'gamma-large',
      backendFamily: 'real_rocm',
      profilePath: path.join(SCRIPT_DIR, 'profiles', 'real-rocm-saxpy.json'),
      sourceUrl: 'https://example.invalid/gamma.git',
      immutableCommit: 'cccccccccccccccccccccccccccccccccccccccc',
    }),
    cleanCandidate({
      id: 'delta-unprofiled-large',
      sourceUrl: 'https://example.invalid/delta.git',
      immutableCommit: 'dddddddddddddddddddddddddddddddddddddddd',
      sizeSignals: {
        class: 'large_unknown_gpu_project',
        coldPathKind: 'unprofiled_arbitrary_project',
      },
      buildSystemHints: {
        observedFiles: ['CMakeLists.txt'],
      },
    }),
  ];
  const first = selectCandidates({ candidates, seed: 'self-check-seed', count: 2 });
  const second = selectCandidates({ candidates, seed: 'self-check-seed', count: 2 });
  if (stableJson(first) !== stableJson(second) || first.length !== 2) {
    throw new Error('random large-project cold-path selection is not deterministic');
  }
  let rejectedMissingCommit = false;
  try {
    cleanCandidate({
      id: 'bad',
      backendFamily: 'real_rocm',
      profilePath: 'profile.json',
      sourceUrl: 'https://example.invalid/bad.git',
      immutableCommit: '',
    });
  } catch {
    rejectedMissingCommit = true;
  }
  if (!rejectedMissingCommit) {
    throw new Error('random large-project cold-path candidate validation accepted missing commit');
  }
  let rejectedUnsafeBackend = false;
  try {
    cleanCandidate({
      id: 'bad-backend',
      backendFamily: '../real_rocm',
      sourceUrl: 'https://example.invalid/bad-backend.git',
      immutableCommit: 'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
    });
  } catch {
    rejectedUnsafeBackend = true;
  }
  if (!rejectedUnsafeBackend) {
    throw new Error('random large-project cold-path candidate validation accepted unsafe backend');
  }
  const unprofiled = cleanCandidate({
    id: 'plain-arbitrary-large',
    sourceUrl: 'https://example.invalid/plain.git',
    immutableCommit: 'ffffffffffffffffffffffffffffffffffffffff',
  });
  if (
    unprofiled.profilePath !== null
    || unprofiled.backendFamily !== 'unknown_gpu_project'
    || unprofiled.profileMode !== 'unprofiled_arbitrary_project_cold_intake'
  ) {
    throw new Error('random large-project cold-path unprofiled normalization failed');
  }
  const directCandidate = directCandidateFromInput({
    sourceUrl: 'https://example.invalid/user/project.git',
    immutableCommit: '1111111111111111111111111111111111111111',
    sourceId: 'user-supplied-project',
  });
  if (
    directCandidate.id !== 'user-supplied-project'
    || directCandidate.profilePath !== null
    || directCandidate.candidateSource !== 'direct_source_url_commit'
    || directCandidate.sizeSignals?.coldPathKind !== 'direct_source_url_commit_cold_intake'
    || directCandidate.oracleHints?.acceptedByDeclaration !== false
  ) {
    throw new Error('random large-project cold-path direct source input normalization failed');
  }
  const spoofedDirectPool = await loadCandidates({
    candidatesJson: JSON.stringify([
      {
        id: 'spoofed-direct-candidate',
        candidateSource: 'direct_source_url_commit',
        candidate_source: 'direct_source_url_commit',
        sourceUrl: 'https://example.invalid/spoofed-direct.git',
        immutableCommit: '1212121212121212121212121212121212121212',
      },
    ]),
  });
  if (
    spoofedDirectPool[0]?.candidateSource !== 'configured_candidate_pool'
    || spoofedDirectPool[0]?.candidate_source !== 'configured_candidate_pool'
  ) {
    throw new Error('random large-project cold-path candidate JSON was allowed to forge direct source authority');
  }
  const parsedListing = parseGitLsTree([
    '100644 blob aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa 12\tCMakeLists.txt',
    '100644 blob dddddddddddddddddddddddddddddddddddddddd 78\tcrates/gpu/Cargo.toml',
    '100644 blob eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee 90\tengine/BUILD.gn',
    '100644 blob bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb 34\tkernels/example.hip',
    '100644 blob cccccccccccccccccccccccccccccccccccccccc 56\tsrc/vulkan/shader.comp',
  ].join('\n'));
  const listingClassification = classifySourceListing(parsedListing);
  const buildDiscovery = discoverBuildMetadata({
    candidate: candidates[0],
    files: parsedListing,
    classification: listingClassification,
  });
  const runtimeExpectation = deriveRuntimeBoundaryExpectation({
    candidate: candidates[0],
    classification: listingClassification,
    buildMetadataDiscovery: buildDiscovery,
  });
  const runtimeEventTemplate = deriveRuntimeBoundaryEventManifestTemplate({
    candidate: candidates[0],
    runtimeBoundaryExpectation: runtimeExpectation,
  });
  const noBackendRuntimeExpectation = deriveRuntimeBoundaryExpectation({
    candidate: candidates[0],
    classification: { backendCandidates: [] },
    buildMetadataDiscovery: buildDiscovery,
  });
  const noBackendRuntimeEventTemplate = deriveRuntimeBoundaryEventManifestTemplate({
    candidate: candidates[0],
    runtimeBoundaryExpectation: noBackendRuntimeExpectation,
  });
  const outputOracleTemplate = runtimeEventTemplate.eventObjectTemplates
    ?.find((entry) => entry.eventKind === 'output_oracle');
  const parsedNoSizeListing = parseGitLsTree(
    '100644 blob ffffffffffffffffffffffffffffffffffffffff\tpackage.json\n',
  );
  if (
    parsedListing.length !== 5
    || parsedNoSizeListing.length !== 1
    || parsedNoSizeListing[0]?.byteLength !== null
    || parsedNoSizeListing[0]?.path !== 'package.json'
    || listingClassification.buildSignalCount !== 3
    || !listingClassification.backendCandidates.includes('hip_rocm')
    || !listingClassification.backendCandidates.includes('vulkan')
    || buildDiscovery.acceptedAsBuildMetadataDiscovery !== true
    || !buildDiscovery.detectedBuildSystems.includes('cmake')
    || !buildDiscovery.detectedBuildSystems.includes('cargo')
    || !buildDiscovery.detectedBuildSystems.includes('gn')
    || buildDiscovery.buildMetadataContentAccepted !== false
    || runtimeExpectation.acceptedAsRuntimeBoundaryExpectation !== true
    || runtimeExpectation.gpuHmrSuccess !== false
    || !runtimeExpectation.requiredBoundaryStages.includes('output_oracle')
    || !runtimeExpectation.expectedRuntimeEvents.includes('hip_kernel_dispatch')
    || !runtimeExpectation.expectedRuntimeEvents.includes('command_buffer_or_dispatch_bind')
    || runtimeEventTemplate.acceptedAsRuntimeBoundaryEventManifestTemplate !== true
    || runtimeEventTemplate.gpuHmrSuccess !== false
    || runtimeEventTemplate.canSatisfyRuntimeProof !== false
    || runtimeEventTemplate.requiredEventKinds?.length !== 5
    || runtimeEventTemplate.eventObjectTemplates?.length !== 5
    || !runtimeEventTemplate.requiredEventKinds.includes('output_oracle')
    || !outputOracleTemplate?.requiredFields?.includes('after_dispatch_id')
    || !outputOracleTemplate?.oracleFieldAlternatives?.some((entry) => entry.mode === 'compute_readback')
    || runtimeEventTemplate.manifestTemplate?.runtimeBoundaryEvents !== undefined
    || noBackendRuntimeExpectation.acceptedAsRuntimeBoundaryExpectation !== false
    || !noBackendRuntimeExpectation.blockingGaps.includes('runtime_backend_candidate_missing')
    || noBackendRuntimeEventTemplate.acceptedAsRuntimeBoundaryEventManifestTemplate !== false
    || !noBackendRuntimeEventTemplate.blockingGaps.includes('runtime_backend_candidate_missing')
    || buildDiscovery.gpuHmrSuccess !== false
  ) {
    throw new Error('random large-project cold-path source listing classifier self-check failed');
  }
  const { manifest } = await buildManifest({
    seed: 'self-check-seed',
    count: 1,
    dryRun: true,
    timeoutMs: 1000,
    runnerTimeoutMs: 2000,
    candidates,
    outputDir: path.join(LOG_DIR, 'self-check'),
  });
  if (
    manifest.schemaVersion !== SCHEMA
    || manifest.proofAuthority !== AUTHORITY
    || manifest.acceptedForGpuHmr !== false
    || manifest.gpuHmrSuccess !== false
    || manifest.results[0]?.status !== 'selected_not_executed_dry_run'
    || !manifest.selection.selectionHash?.startsWith('sha256:')
  ) {
    throw new Error('random large-project cold-path manifest self-check failed');
  }
  const timeoutProbe = await runProcess(
    process.execPath,
    ['-e', 'setInterval(() => {}, 1000)'],
    { stdio: ['ignore', 'pipe', 'pipe'], timeoutMs: 50 },
  );
  if (timeoutProbe.error && /\bEPERM\b/i.test(timeoutProbe.error)) {
    console.warn('random large-project cold-path timeout self-check skipped child spawn probe: EPERM');
  } else if (!timeoutProbe.timedOut || timeoutProbe.timeoutMs !== 50 || !timeoutProbe.timeoutKillAttempted) {
    throw new Error('random large-project cold-path timeout self-check failed');
  }
  const { manifest: pendingManifest } = await buildManifest({
    seed: 'pending-self-check-seed',
    count: 1,
    dryRun: false,
    timeoutMs: 1000,
    runnerTimeoutMs: 2000,
    candidates,
    outputDir: path.join(LOG_DIR, 'self-check'),
    runCandidate: async (candidate) => ({
      candidateId: candidate.id,
      status: 'synthetic_runner_timeout_failed_closed',
      timedOut: true,
      timed_out: true,
      acceptedForGpuHmr: false,
      gpuHmrSuccess: false,
      canSatisfyRuntimeProof: false,
    }),
  });
  if (
    pendingManifest.eventType !== 'cold_path_complete'
    || !pendingManifest.pendingManifestPath
    || !pendingManifest.pendingManifestHash?.startsWith('sha256:')
    || pendingManifest.results[0]?.status !== 'synthetic_runner_timeout_failed_closed'
  ) {
    throw new Error('random large-project cold-path pending manifest self-check failed');
  }
  const { manifest: unprofiledManifest } = await buildManifest({
    seed: 'unprofiled-self-check-seed',
    count: 1,
    candidateId: 'delta-unprofiled-large',
    dryRun: false,
    timeoutMs: 1000,
    runnerTimeoutMs: 2000,
    candidates,
    outputDir: path.join(LOG_DIR, 'self-check'),
  });
  const unprofiledResult = unprofiledManifest.results[0] ?? {};
  if (
    unprofiledResult.status !== 'unprofiled_arbitrary_project_cold_intake_refused'
    || unprofiledResult.runnerAttempted !== false
    || !unprofiledResult.blockingGaps?.includes('runtime_profile_contract_missing')
    || !unprofiledResult.blockingGaps?.includes('strict_runtime_ledger_missing')
    || unprofiledResult.acceptedForGpuHmr !== false
    || unprofiledResult.gpuHmrSuccess !== false
  ) {
    throw new Error('random large-project cold-path unprofiled refusal self-check failed');
  }
  const { manifest: directManifest } = await buildManifest({
    seed: 'direct-source-self-check-seed',
    count: 1,
    candidateId: directCandidate.id,
    dryRun: false,
    timeoutMs: 1000,
    runnerTimeoutMs: 2000,
    sourceIntake: false,
    candidates: [directCandidate],
    outputDir: path.join(LOG_DIR, 'self-check'),
  });
  const directResult = directManifest.results[0] ?? {};
  if (
    directManifest.candidates[0]?.candidateSource !== 'direct_source_url_commit'
    || directResult.status !== 'unprofiled_arbitrary_project_cold_intake_refused'
    || directResult.sourceTreeIntakeAccepted !== false
    || !directResult.blockingGaps?.includes('source_tree_intake_missing')
    || directResult.acceptedForGpuHmr !== false
    || directResult.gpuHmrSuccess !== false
  ) {
    throw new Error('random large-project cold-path direct source refusal self-check failed');
  }
  const localRepoPath = path.join(LOG_DIR, 'self-check', 'local-user-project');
  await rm(localRepoPath, { recursive: true, force: true });
  await mkdir(path.join(localRepoPath, 'kernels'), { recursive: true });
  await writeFile(path.join(localRepoPath, 'CMakeLists.txt'), 'cmake_minimum_required(VERSION 3.20)\nproject(local_user_project)\n');
  await writeFile(path.join(localRepoPath, 'kernels', 'example.hip'), '__global__ void k(float* out) { out[0] = 1.0f; }\n');
  const localGitInit = await runProcess('git', ['init', localRepoPath], {
    cwd: REPO_ROOT,
    timeoutMs: 30000,
    streamOutput: false,
  });
  const localGitAdd = await runProcess('git', ['-C', localRepoPath, 'add', '.'], {
    cwd: REPO_ROOT,
    timeoutMs: 30000,
    streamOutput: false,
  });
  const localGitCommit = await runProcess(
    'git',
    ['-C', localRepoPath, '-c', 'user.email=synthi@example.invalid', '-c', 'user.name=Synthi Self Check', 'commit', '-m', 'initial'],
    {
      cwd: REPO_ROOT,
      timeoutMs: 30000,
      streamOutput: false,
    },
  );
  if (localGitInit.exitCode !== 0 || localGitAdd.exitCode !== 0 || localGitCommit.exitCode !== 0) {
    throw new Error(
      `random large-project cold-path local git fixture setup failed: `
      + `init=${localGitInit.exitCode}:${tail(localGitInit.stderr || localGitInit.stdout || localGitInit.error || '', 240)} `
      + `add=${localGitAdd.exitCode}:${tail(localGitAdd.stderr || localGitAdd.stdout || localGitAdd.error || '', 240)} `
      + `commit=${localGitCommit.exitCode}:${tail(localGitCommit.stderr || localGitCommit.stdout || localGitCommit.error || '', 240)}`,
    );
  }
  const localGitHead = await runProcess('git', ['-C', localRepoPath, 'rev-parse', 'HEAD'], {
    cwd: REPO_ROOT,
    timeoutMs: 30000,
    streamOutput: false,
  });
  const localCommit = localGitHead.stdout.trim();
  const localCandidate = directCandidateFromInput({
    repoPath: localRepoPath,
    immutableCommit: localCommit,
    sourceId: 'local-user-project',
  });
  const { manifest: localManifest } = await buildManifest({
    seed: 'local-source-self-check-seed',
    count: 1,
    candidateId: localCandidate.id,
    dryRun: false,
    timeoutMs: 1000,
    runnerTimeoutMs: 2000,
    sourceIntake: true,
    sourceIntakeTimeoutMs: 30000,
    candidates: [localCandidate],
    outputDir: path.join(LOG_DIR, 'self-check'),
  });
  const localResult = localManifest.results[0] ?? {};
  const localBuildContentFiles = localResult.sourceIntakeEvidence?.buildMetadataContentEvidence?.buildFiles ?? [];
  if (
    localManifest.candidates[0]?.candidateSource !== 'direct_local_git_repo_path'
    || localResult.status !== 'unprofiled_arbitrary_project_cold_intake_refused'
    || localResult.sourceTreeIntakeAccepted !== true
    || localResult.buildMetadataDiscoveryAccepted !== true
    || localResult.buildMetadataContentAccepted !== true
    || localResult.runtimeBoundaryExpectationAccepted !== true
    || localResult.runtimeBoundaryEventManifestTemplateAccepted !== true
    || localResult.sourceIntakeEvidence?.transport !== 'local_git_ls_tree_clean_worktree'
    || !localResult.sourceIntakeEvidence?.buildMetadataDiscovery?.detectedBuildSystems?.includes('cmake')
    || !localResult.sourceIntakeEvidence?.runtimeBoundaryExpectation?.requiredBoundaryStages?.includes('same_process_loader')
    || localResult.sourceIntakeEvidence?.runtimeBoundaryExpectation?.gpuHmrSuccess !== false
    || localResult.sourceIntakeEvidence?.runtimeBoundaryEventManifestTemplate?.gpuHmrSuccess !== false
    || localResult.sourceIntakeEvidence?.runtimeBoundaryEventManifestTemplate?.canSatisfyRuntimeProof !== false
    || !localResult.sourceIntakeEvidence?.runtimeBoundaryEventManifestTemplate?.requiredEventKinds?.includes('dispatch_trace')
    || !localResult.sourceIntakeEvidence?.runtimeBoundaryEventManifestTemplate?.eventObjectTemplates
      ?.some((entry) => entry.eventKind === 'artifact_transport' && entry.backendSpecificFields?.includes('hsaco_hash'))
    || !localResult.sourceIntakeEvidence?.backendCandidates?.includes('hip_rocm')
    || !(localResult.sourceIntakeEvidence?.buildMetadataContentEvidence?.acceptedBuildFileCount >= 1)
    || !localBuildContentFiles.some((file) => file.family === 'cmake' && file.contentHash?.startsWith('sha256:'))
    || !localResult.blockingGaps?.includes('semantic_build_metadata_execution_missing')
    || localResult.acceptedForGpuHmr !== false
    || localResult.gpuHmrSuccess !== false
  ) {
    throw new Error('random large-project cold-path local git source intake self-check failed');
  }
  const fallbackContentRead = await readBuildFileContent({
    candidate: localCandidate,
    file: { path: 'CMakeLists.txt', object: 'self-check-cmake', byteLength: 64 },
    transport: 'git_fetch_depth_1_blobless',
    transportEvidence: {
      resolvedLocalPath: localRepoPath,
      resolved_local_path: localRepoPath,
    },
    sourceIntakeTimeoutMs: 30000,
  });
  if (
    fallbackContentRead.accepted !== true
    || fallbackContentRead.transport !== 'git_fetch_blobless_show'
    || !String(fallbackContentRead.content ?? '').includes('project(local_user_project)')
  ) {
    throw new Error('random large-project cold-path git fallback build-file content self-check failed');
  }
  const noSizeLsTree = await runProcess('git', ['-C', localRepoPath, 'ls-tree', '-r', '--full-tree', localCommit], {
    cwd: REPO_ROOT,
    timeoutMs: 30000,
    streamOutput: false,
  });
  const noSizeFiles = parseGitLsTree(noSizeLsTree.stdout);
  const noSizeFallbackBase = {
    schemaVersion: SOURCE_INTAKE_SCHEMA,
    schema_version: SOURCE_INTAKE_SCHEMA,
    proofAuthority: SOURCE_INTAKE_AUTHORITY,
    proof_authority: SOURCE_INTAKE_AUTHORITY,
    acceptedForGpuHmr: false,
    accepted_for_gpu_hmr: false,
    gpuHmrSuccess: false,
    gpu_hmr_success: false,
    canSatisfyRuntimeProof: false,
    can_satisfy_runtime_proof: false,
    sourceUrl: localCandidate.sourceUrl,
    source_url: localCandidate.sourceUrl,
    localRepoPath: localCandidate.localRepoPath,
    local_repo_path: localCandidate.localRepoPath,
    immutableCommit: localCandidate.immutableCommit,
    immutable_commit: localCandidate.immutableCommit,
    localPath: path.relative(REPO_ROOT, localRepoPath).replace(/\\/g, '/'),
    local_path: path.relative(REPO_ROOT, localRepoPath).replace(/\\/g, '/'),
    startedAt: new Date().toISOString(),
    started_at: new Date().toISOString(),
  };
  const noSizeFallbackFacet = await buildAcceptedSourceIntakeFacet({
    base: noSizeFallbackBase,
    candidate: localCandidate,
    files: noSizeFiles,
    transport: 'git_fetch_depth_1_blobless',
    transportEvidence: {
      resolvedLocalPath: localRepoPath,
      resolved_local_path: localRepoPath,
      listingMode: 'git_ls_tree_no_size_blobless',
      listing_mode: 'git_ls_tree_no_size_blobless',
      byteLengthMode: 'unknown_avoids_blob_fetch',
      byte_length_mode: 'unknown_avoids_blob_fetch',
    },
    sourceIntakeTimeoutMs: 30000,
  });
  if (
    noSizeLsTree.exitCode !== 0
    || noSizeFallbackFacet.acceptedAsIntakeEvidence !== true
    || noSizeFallbackFacet.transport !== 'git_fetch_depth_1_blobless'
    || noSizeFallbackFacet.totalKnownBytes !== 0
    || noSizeFallbackFacet.buildMetadataDiscoveryAccepted !== true
    || noSizeFallbackFacet.buildMetadataContentAccepted !== true
    || noSizeFallbackFacet.buildMetadataContentEvidence?.buildFiles?.[0]?.transport !== 'git_fetch_blobless_show'
    || noSizeFallbackFacet.buildMetadataContentEvidence?.buildFiles?.[0]?.lazyBlobFetchAllowed !== false
  ) {
    throw new Error('random large-project cold-path no-size git fallback facet self-check failed');
  }
  await writeFile(path.join(localRepoPath, 'untracked-dirty.tmp'), 'dirty\n');
  const { manifest: dirtyManifest } = await buildManifest({
    seed: 'dirty-local-source-self-check-seed',
    count: 1,
    candidateId: localCandidate.id,
    dryRun: false,
    timeoutMs: 1000,
    runnerTimeoutMs: 2000,
    sourceIntake: true,
    sourceIntakeTimeoutMs: 30000,
    candidates: [localCandidate],
    outputDir: path.join(LOG_DIR, 'self-check'),
  });
  const dirtyResult = dirtyManifest.results[0] ?? {};
  if (
    dirtyResult.sourceTreeIntakeAccepted !== false
    || dirtyResult.sourceIntakeEvidence?.status !== 'source_intake_local_git_dirty'
    || !dirtyResult.blockingGaps?.includes('source_tree_intake_missing')
    || dirtyResult.acceptedForGpuHmr !== false
    || dirtyResult.gpuHmrSuccess !== false
  ) {
    throw new Error('random large-project cold-path dirty local git refusal self-check failed');
  }
  console.log('random large-project cold-path self-check passed');
}

async function main() {
  const args = parseArgs();
  if (args.selfCheck) {
    await selfCheck();
    return;
  }
  const seed = String(args.seed ?? process.env.SYNTHI_GPU_HMR_LARGE_PROJECT_COLD_SEED ?? '2026-06-30-random-large-project-cold-path');
  const count = Number(args.count ?? process.env.SYNTHI_GPU_HMR_LARGE_PROJECT_COLD_COUNT ?? 1);
  const dryRun = Boolean(args.dryRun || process.env.SYNTHI_GPU_HMR_LARGE_PROJECT_COLD_DRY_RUN === '1');
  const candidateId = args.candidateId ?? process.env.SYNTHI_GPU_HMR_LARGE_PROJECT_COLD_CANDIDATE_ID ?? '';
  const timeoutMs = Number(process.env.SYNTHI_GPU_HMR_LARGE_PROJECT_COLD_TIMEOUT_MS ?? process.env.SYNTHI_REAL_ROCM_UPSTREAM_TIMEOUT_MS ?? 120000);
  const runnerTimeoutMs = Number(
    process.env.SYNTHI_GPU_HMR_LARGE_PROJECT_COLD_RUN_TIMEOUT_MS
      ?? Math.max(timeoutMs + 120000, timeoutMs),
  );
  const sourceIntake = process.env.SYNTHI_GPU_HMR_UNPROFILED_SOURCE_INTAKE !== '0';
  const sourceIntakeTimeoutMs = Number(
    process.env.SYNTHI_GPU_HMR_UNPROFILED_SOURCE_INTAKE_TIMEOUT_MS
      ?? Math.max(timeoutMs, 120000),
  );
  const directCandidate = directCandidateFromInput({
    sourceUrl: args.sourceUrl ?? process.env.SYNTHI_GPU_HMR_LARGE_PROJECT_COLD_SOURCE_URL,
    repoPath: args.repoPath ?? process.env.SYNTHI_GPU_HMR_LARGE_PROJECT_COLD_REPO_PATH,
    immutableCommit: args.immutableCommit ?? process.env.SYNTHI_GPU_HMR_LARGE_PROJECT_COLD_SOURCE_COMMIT,
    sourceId: args.sourceId ?? process.env.SYNTHI_GPU_HMR_LARGE_PROJECT_COLD_SOURCE_ID,
    backendFamily: args.backendFamily ?? process.env.SYNTHI_GPU_HMR_LARGE_PROJECT_COLD_BACKEND_FAMILY,
  });
  const candidates = directCandidate ? [directCandidate] : await loadCandidates({
    candidatesJson: process.env.SYNTHI_GPU_HMR_LARGE_PROJECT_COLD_CANDIDATES_JSON,
    candidatesPath: args.candidatesPath ?? process.env.SYNTHI_GPU_HMR_LARGE_PROJECT_COLD_CANDIDATES_PATH,
  });
  const effectiveCandidateId = directCandidate ? directCandidate.id : candidateId;
  const effectiveCount = directCandidate ? 1 : count;
  const { manifest, written } = await buildManifest({
    seed,
    count: effectiveCount,
    candidateId: effectiveCandidateId,
    dryRun,
    timeoutMs,
    runnerTimeoutMs,
    sourceIntake,
    sourceIntakeTimeoutMs,
    candidates,
    outputDir: path.resolve(args.outputDir ?? process.env.SYNTHI_GPU_HMR_LARGE_PROJECT_COLD_OUTPUT_DIR ?? LOG_DIR),
  });
  console.log(JSON.stringify({
    ok: true,
    schemaVersion: SCHEMA,
    manifestPath: written.filePath,
    manifestHash: written.hash,
    selectedIds: manifest.selection.selectedIds,
    dryRun,
    resultStatuses: manifest.results.map((result) => result.status),
  }, null, 2));
}

main().catch((error) => {
  console.error(error?.stack || error?.message || String(error));
  process.exit(1);
});
