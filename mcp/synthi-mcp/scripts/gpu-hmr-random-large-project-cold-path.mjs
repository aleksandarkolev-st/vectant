import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const MCP_ROOT = path.resolve(SCRIPT_DIR, '..');
const REPO_ROOT = path.resolve(MCP_ROOT, '..', '..');
const LOG_DIR = path.join(MCP_ROOT, '.gpu-hmr-test-logs', 'random-large-project-cold-path');
const SOURCE_INTAKE_DIR = path.join(LOG_DIR, 'source-intake');
const SCHEMA = 'synthi.gpu_hmr.random_large_project_cold_path.v1';
const AUTHORITY = 'random_large_project_cold_path_selection_only_not_gpu_hmr_success';
const SOURCE_INTAKE_SCHEMA = 'synthi.gpu_hmr.unprofiled_cold_source_intake.v1';
const SOURCE_INTAKE_AUTHORITY = 'unprofiled_source_tree_intake_only_not_gpu_hmr_success';

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

function cleanCandidate(raw, index = 0) {
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
    sourceUrl,
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
  const cleaned = candidates.map(cleanCandidate);
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
      const killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
      killer.on('error', () => {});
    } catch {
      // child.kill above is the portable fallback.
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
    const timer = Number(timeoutMs) > 0
      ? setTimeout(() => {
        timedOut = true;
        timeoutKillAttempted = killChildTree(child);
      }, Number(timeoutMs))
      : null;
    timer?.unref?.();
    const finish = (payload) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
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

function parseGitLsTree(text) {
  return String(text ?? '')
    .split(/\r?\n/)
    .map((line) => {
      const match = line.match(/^(\d+)\s+(\w+)\s+([0-9a-f]{40,64})\s+(-|\d+)\t(.+)$/i);
      if (!match) return null;
      return {
        mode: match[1],
        type: match[2],
        object: match[3],
        byteLength: match[4] === '-' ? null : Number(match[4]),
        byte_length: match[4] === '-' ? null : Number(match[4]),
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

function buildAcceptedSourceIntakeFacet({ base, candidate, files, transport, transportEvidence = {} }) {
  const listingIdentity = files.map((file) => ({
    path: file.path,
    object: file.object,
    byteLength: file.byteLength,
  }));
  const totalKnownBytes = files.reduce((sum, file) => sum + (Number.isFinite(file.byteLength) ? file.byteLength : 0), 0);
  const classification = classifySourceListing(files);
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
    immutableCommit: candidate.immutableCommit,
    immutable_commit: candidate.immutableCommit,
    localPath: relativeLocalPath,
    local_path: relativeLocalPath,
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
  await rm(localPath, { recursive: true, force: true });
  const githubTree = await fetchGitHubTreeListing(candidate, { sourceIntakeTimeoutMs });
  let githubTreeFallback = null;
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
      return buildAcceptedSourceIntakeFacet({
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
    return fail('source_intake_fetch_failed', 'source_tree_fetch_failed', {
      fetch,
      fetch_result: fetch,
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
    ['-C', localPath, 'ls-tree', '-r', '-l', '--full-tree', candidate.immutableCommit],
    {
      cwd: REPO_ROOT,
      timeoutMs: Math.min(sourceIntakeTimeoutMs, 120000),
      stdoutMax: 8 * 1024 * 1024,
      stderrMax: 64000,
      streamOutput: false,
    },
  );
  if (lsTree.exitCode !== 0 || lsTree.timedOut || lsTree.error) {
    return fail('source_intake_listing_failed', 'source_tree_listing_failed', {
      listingResult: lsTree,
      listing_result: lsTree,
    });
  }
  const files = parseGitLsTree(lsTree.stdout);
  if (files.length === 0) {
    return fail('source_intake_empty_listing', 'source_tree_listing_empty');
  }
  return buildAcceptedSourceIntakeFacet({
    base,
    candidate,
    files,
    transport: 'git_fetch_depth_1_blobless',
    transportEvidence: {
      githubTreeFallback,
      github_tree_fallback: githubTreeFallback,
      gitInit,
      git_init: gitInit,
      remoteAdd,
      remote_add: remoteAdd,
      fetch,
      fetch_result: fetch,
    },
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
    const blockingGaps = [
      'runtime_profile_contract_missing',
      'build_metadata_unverified',
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
      immutableCommit: candidate.immutableCommit,
      immutable_commit: candidate.immutableCommit,
      sourceTreeIntakeAccepted,
      source_tree_intake_accepted: sourceTreeIntakeAccepted,
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
      sourceUrl: candidate.sourceUrl,
      source_url: candidate.sourceUrl,
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
      sourceUrl: candidate.sourceUrl,
      source_url: candidate.sourceUrl,
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
  const parsedListing = parseGitLsTree([
    '100644 blob aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa 12\tCMakeLists.txt',
    '100644 blob bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb 34\tkernels/example.hip',
    '100644 blob cccccccccccccccccccccccccccccccccccccccc 56\tsrc/vulkan/shader.comp',
  ].join('\n'));
  const listingClassification = classifySourceListing(parsedListing);
  if (
    parsedListing.length !== 3
    || listingClassification.buildSignalCount !== 1
    || !listingClassification.backendCandidates.includes('hip_rocm')
    || !listingClassification.backendCandidates.includes('vulkan')
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
  const candidates = await loadCandidates({
    candidatesJson: process.env.SYNTHI_GPU_HMR_LARGE_PROJECT_COLD_CANDIDATES_JSON,
    candidatesPath: args.candidatesPath ?? process.env.SYNTHI_GPU_HMR_LARGE_PROJECT_COLD_CANDIDATES_PATH,
  });
  const { manifest, written } = await buildManifest({
    seed,
    count,
    candidateId,
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
